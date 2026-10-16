//! GPU kernel tests: run on a real adapter (Metal locally, Mesa lavapipe in CI). Compiled only
//! with `--features gpu-tests`; a missing adapter is a hard failure, never a skip, so coverage
//! of `src/gpu/` cannot silently drop.
#![cfg(feature = "gpu-tests")]

use std::collections::BTreeMap;

use femlab_engine::command::{Formulation, Solver};
use femlab_engine::fem::assembly::{assemble_stiffness, pattern, reduce, resolve, Csr};
use femlab_engine::fem::element::Material;
use femlab_engine::fem::loads::{assemble_loads, Load};
use femlab_engine::fem::material::builtin_law;
use femlab_engine::fem::mpc;
use femlab_engine::fem::problem::{Constraint, Coupling, Problem};
use femlab_engine::gpu::cg::{CgContext, CgStopReason, GpuCg};
use femlab_engine::gpu::{Gpu, MAX_WORKGROUPS, WORKGROUP};
use femlab_engine::model::Idealisation;
use femlab_engine::par::Pool;
use femlab_engine::solve::{solve, SolveOptions};
use femlab_engine::{Engine, ErrorCode, NoClock, Progress, Query, QueryResult, ResolvedSet, SetKind};
use femlab_geometry::mesh::{ElementBlock, ElementKind, Face};
use femlab_geometry::{Mesh, Structured};

fn gpu() -> Gpu {
    pollster::block_on(Gpu::request(Gpu::default_backends())).expect("a GPU adapter is required for gpu-tests")
}

fn nop(_p: Progress) -> bool {
    true
}

/// The reduced stiffness and load of the `[nx, ny, nz]` steel cantilever under a tip shear —
/// Benchmark B1's system, which is what every solver here is measured on.
fn cantilever(n: [usize; 3]) -> (Csr, Vec<f64>) {
    let red = cantilever_reduced(n);
    (red.k_ff, red.f_f)
}

fn cantilever_reduced(n: [usize; 3]) -> femlab_engine::fem::assembly::Reduced {
    let mesh: Mesh = Structured { kind: ElementKind::Hex8, n }.box_([1.0, 0.1, 0.1]);
    let mut sets = BTreeMap::new();
    for (name, faces) in &mesh.face_sets {
        let mut nodes: Vec<u32> = faces.iter().flat_map(|&f| mesh.face_nodes(f)).collect();
        nodes.sort_unstable();
        nodes.dedup();
        sets.insert(name.clone(), ResolvedSet { kind: SetKind::Face, faces: faces.clone(), nodes, elems: Vec::new() });
    }
    let bodies = vec!["beam".to_string()];
    let p = Problem {
        plies: Vec::new(),
        directors: &[],
        mesh: &mesh,
        sets: &sets,
        body_of_block: &bodies,
        material_of_block: vec![Some(0); mesh.blocks.len()],
        section_of_block: vec![None; mesh.blocks.len()],
        orientation_of_block: vec![None; mesh.blocks.len()],
        sections: Vec::new(),
        points: Vec::new(),
        materials: vec![Material {
            law: builtin_law("linear-elastic").expect("built in"),
            props: vec![210e9, 0.3],
            rho: 7800.0,
            alpha: [0.0; 3],
            k: [0.0; 3],
            cp: 0.0,
            axes: None,
        }],
        idealisation: Idealisation::Solid3d,
        formulation: Formulation::IncompatibleModes,
        constraints: vec![Constraint {
            name: "root".into(),
            nodes: "xmin".into(),
            dofs: [true, true, true, false, false, false],
            value: 0.0,
        }],
        couplings: Vec::new(),
        loads: vec![Load::Traction { faces: "xmax".into(), t: [0.0, 0.0, -1e5] }],
        temperature: None,
        heat: false,
        heat_loads: Vec::new(),
    };
    let pat = pattern(&mesh, 3);
    let a = assemble_stiffness(&p, &pat).expect("steel on a box assembles");
    let mut f = a.f_thermal.clone();
    assemble_loads(&p, &mut f).expect("a traction on a real face");
    let rc = resolve(&p).expect("no conflict");
    reduce(&a.k, &f, &rc, &[])
}

/// A pseudo-random f32 vector; the same numbers on every adapter.
fn lcg_f32(n: usize, seed: u64) -> Vec<f32> {
    let mut s = seed;
    (0..n)
        .map(|_| {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((s >> 33) as f64 / (1u64 << 31) as f64 - 1.0) as f32
        })
        .collect()
}

/// `y = A x` summed in f64 over the very same f32 numbers the device was given: the oracle is
/// the arithmetic, not another implementation of the kernel (ADR 0007).
fn spmv_f64(k: &Csr, vals: &[f32], x: &[f32]) -> Vec<f64> {
    (0..k.n)
        .map(|r| {
            let mut s = 0.0;
            for e in k.row_ptr[r] as usize..k.row_ptr[r + 1] as usize {
                s += vals[e] as f64 * x[k.col_idx[e] as usize] as f64;
            }
            s
        })
        .collect()
}

fn data(n: usize, seed: f64) -> (Vec<f32>, Vec<f32>) {
    let a: Vec<f32> = (0..n).map(|i| (libm::sin(i as f64 * 0.37 + seed) * 10.0) as f32).collect();
    let b: Vec<f32> = (0..n).map(|i| (libm::cos(i as f64 * 0.11 - seed) + 0.5) as f32).collect();
    (a, b)
}

fn dot_f64(a: &[f32], b: &[f32]) -> (f64, f64) {
    let mut s = 0.0;
    let mut abs = 0.0;
    for i in 0..a.len() {
        let p = a[i] as f64 * b[i] as f64;
        s += p;
        abs += p.abs();
    }
    (s, abs)
}

#[test]
fn dot_matches_f64_within_f32_rounding_and_is_bit_identical() {
    let mut g = gpu();
    assert!(!g.adapter.is_empty());
    assert!(format!("{g:?}").starts_with("Gpu("));
    for n in [1usize, 7, 255, 256, 257, 4096, 100_000, (MAX_WORKGROUPS as usize + 3) * WORKGROUP as usize] {
        let (a, b) = data(n, 0.3);
        let got = pollster::block_on(g.dot(&a, &b)).unwrap();
        let (exact, abs) = dot_f64(&a, &b);
        let bound = 32.0 * f32::EPSILON as f64 * abs + 1e-30;
        assert!((got as f64 - exact).abs() <= bound, "n = {n}: gpu {got} vs f64 {exact} (bound {bound:e})");
        let again = pollster::block_on(g.dot(&a, &b)).unwrap();
        assert_eq!(got.to_bits(), again.to_bits(), "n = {n}: not deterministic");
    }
    assert_eq!(pollster::block_on(g.dot(&[], &[])).unwrap(), 0.0);
    let e = pollster::block_on(g.dot(&[1.0], &[1.0, 2.0])).unwrap_err();
    assert_eq!(e.code, ErrorCode::Internal);
}

#[test]
fn grid_is_always_2d_and_capped() {
    assert_eq!(Gpu::grid(1), (1, [1, 1]));
    assert_eq!(Gpu::grid(256 * 10), (10, [10, 1]));
    assert_eq!(Gpu::grid(256 * 100_000), (MAX_WORKGROUPS, [MAX_WORKGROUPS, 1]));
}

#[test]
fn broken_shaders_and_tiny_limits_are_structured_errors() {
    let mut g = gpu();
    let e = pollster::block_on(g.compile("broken", "fn nope( {", "nope")).unwrap_err();
    assert_eq!(e.code, ErrorCode::GpuShader);
    assert!(e.where_.as_deref().unwrap().contains("broken"));
    let e = pollster::block_on(g.pipeline("missing.wgsl", "x")).unwrap_err();
    assert_eq!(e.code, ErrorCode::Internal);
    // a real shader with an entry point it does not have
    let e = pollster::block_on(g.pipeline("dot.wgsl", "nope")).unwrap_err();
    assert_eq!(e.code, ErrorCode::GpuShader);
    // the pipeline cache returns the same pipeline twice
    let p1 = pollster::block_on(g.pipeline("dot.wgsl", "dot_final")).unwrap().clone();
    let p2 = pollster::block_on(g.pipeline("dot.wgsl", "dot_final")).unwrap().clone();
    assert_eq!(p1, p2);
    g.limits.max_buffer_size = 1024;
    g.limits.max_storage_buffer_binding_size = 1024;
    assert_eq!(g.max_buffer_bytes(), 1024);
    let (a, b) = data(10_000, 0.1);
    let e = pollster::block_on(g.dot(&a, &b)).unwrap_err();
    assert_eq!(e.code, ErrorCode::GpuTooLarge);
    assert!(e.cause.contains("40000 bytes"));
    assert!(g.check_size("x", 1024).is_ok());
    // reading past the end of a buffer is a validation error, caught by the scope, never a panic
    let small = g.buffer_f32("small", &[1.0, 2.0], wgpu::BufferUsages::COPY_SRC);
    let e = pollster::block_on(g.read_back(&small, 64)).unwrap_err();
    assert_eq!(e.code, ErrorCode::Internal);
    assert!(e.cause.contains("64 bytes"));
    assert!(e.cause.contains("validation=Some"), "{e:?}");
    assert!(e.cause.contains("poll="), "{e:?}");
    assert!(e.cause.contains("mapping="), "{e:?}");
    assert!(e.cause.contains("device_loss=None"), "{e:?}");
    assert_eq!(pollster::block_on(g.read_back(&small, 8)).unwrap(), bytemuck::cast_slice::<f32, u8>(&[1.0, 2.0]));
    // an adapter below WebGPU's guaranteed workgroup size cannot run the kernels
    g.limits.max_compute_invocations_per_workgroup = WORKGROUP - 1;
    let e = pollster::block_on(g.dot(&[1.0], &[1.0])).unwrap_err();
    assert_eq!(e.code, ErrorCode::GpuTooLarge);
    assert!(e.cause.contains("255"));
}

#[test]
fn engine_reports_the_adapter_in_capabilities() {
    let g = gpu();
    let name = g.adapter.clone();
    let mut e = Engine::new(Some(g), Box::new(NoClock), 1);
    let QueryResult::Capabilities(c) = e.query(Query::Capabilities {}).unwrap() else { panic!() };
    assert!(c.gpu);
    assert_eq!(c.adapter.as_deref(), Some(name.as_str()));
    assert!(e.gpu().is_some());
    assert!(e.gpu_mut().is_some());
    let mut e2 = Engine::new(None, Box::new(NoClock), 1);
    let QueryResult::Capabilities(c) = e2.query(Query::Capabilities {}).unwrap() else { panic!() };
    assert!(!c.gpu && c.adapter.is_none());
}

/// #64: the mixed-precision GPU solve must retain a shell's constant-curvature
/// solution as the mesh is refined, including its rotational degrees of freedom.
#[test]
fn shell_moment_strip_matches_plate_theory_through_gpu_pcg() {
    let mut e = Engine::new(Some(gpu()), Box::new(NoClock), 2);
    for n in [2, 4, 8] {
        let mesh = serde_json::json!({
            "cmd": "mesh.set", "mesher": {"kind": "surface", "body": "skin", "patches": [{
                "corners": [["0 m", "0 m", "0 m"], ["1 m", "0 m", "0 m"],
                    ["1 m", "1 m", "0 m"], ["0 m", "1 m", "0 m"]],
                "n": [n, 1], "tags": [null, "tip", null, "root"]
            }]}
        })
        .to_string();
        for command in [
            r#"{"cmd":"model.new","name":"GPU shell strip"}"#,
            &mesh,
            r#"{"cmd":"material.add","name":"elastic","E":"200 GPa","nu":0}"#,
            r#"{"cmd":"material.assign","material":"elastic","bodies":["skin"]}"#,
            r#"{"cmd":"section.add","name":"thin","shape":{"kind":"shell","thickness":"10 mm"}}"#,
            r#"{"cmd":"section.assign","section":"thin","bodies":["skin"]}"#,
            r#"{"cmd":"constraint.fix","name":"root","on":"skin.root"}"#,
            r#"{"cmd":"load.moment","name":"bend","on":"skin.tip","total":["0 N m","1 N m","0 N m"]}"#,
            r#"{"cmd":"step.add","name":"s","procedure":"static","constraints":["root"],"loads":["bend"]}"#,
            r#"{"cmd":"solve.run","step":"s","solver":"gpu-pcg"}"#,
        ] {
            pollster::block_on(e.dispatch(serde_json::from_str(command).unwrap(), &mut nop)).unwrap();
        }
        let QueryResult::Result(result) = e.query(Query::Result { step: None, result_id: None }).unwrap() else {
            panic!("result")
        };
        assert_eq!(result.solver, "gpu-pcg");
        for (field, component, expected) in [("displacement", 2, -0.00003), ("rotation", 1, 0.00006)] {
            let query = serde_json::from_value(serde_json::json!({
                "query": "query.probe", "step": "s", "field": field, "component": component,
                "at": ["1 m", "0.5 m", "0 m"]
            }))
            .unwrap();
            let QueryResult::Probe(probe) = e.query(query).unwrap() else { panic!("probe") };
            assert!((probe.value.value / expected - 1.0).abs() < 1e-6, "n={n}, {field}: {:?}", probe.value);
        }
        for (field, expected) in [("stressTop", 60000.0), ("stressBottom", -60000.0), ("shellMoment", 1.0)] {
            let QueryResult::Field(values) =
                e.query(Query::Field { step: None, result_id: None, field: field.into() }).unwrap()
            else {
                panic!("field")
            };
            assert_eq!((values.per.as_str(), values.components), ("elementNode", 6));
            for value in values.values.chunks_exact(6) {
                assert!((value[0] / expected - 1.0).abs() < 1e-6, "n={n}, {field}: {value:?}");
            }
        }
    }
}

/// A4 on the device: the CSR SpMV against an f64 sum of the same f32 values, per component,
/// within the rounding a single-precision row sum can accumulate.
#[test]
fn the_csr_spmv_matches_an_f64_sum_of_the_same_f32_numbers() {
    let g = gpu();
    let (k, _) = cantilever([8, 2, 2]);
    let vals: Vec<f32> = k.vals.iter().map(|v| *v as f32).collect();
    let x = lcg_f32(k.n, 7);
    let ctx = pollster::block_on(CgContext::new(&g, &k, &vals, None)).expect("the kernels compile");
    let mut y = vec![0.0f32; k.n];
    pollster::block_on(ctx.spmv(&g, &x, &mut y)).expect("one spmv");
    let want = spmv_f64(&k, &vals, &x);
    // ‖K‖∞ · ‖x‖∞ bounds one exact row sum; the f32 accumulation over the row's non-zeros is
    // worth a small multiple of eps times that.
    let norm_k = (0..k.n)
        .map(|r| (k.row_ptr[r] as usize..k.row_ptr[r + 1] as usize).map(|e| vals[e].abs() as f64).sum::<f64>())
        .fold(0.0f64, f64::max);
    let norm_x = x.iter().fold(0.0f64, |m, v| m.max(v.abs() as f64));
    let bound = 4.0 * f32::EPSILON as f64 * norm_k * norm_x;
    let worst = y.iter().zip(&want).map(|(a, b)| (*a as f64 - b).abs()).fold(0.0f64, f64::max);
    assert!(worst <= bound, "worst component error {worst:e} exceeds {bound:e}");
    println!("A4 gpu spmv on {} rows: worst {worst:e}, bound {bound:e}", k.n);

    // and the same answer, bit for bit, when the matrix is forced into chunks of three rows
    let chunked = pollster::block_on(CgContext::new(&g, &k, &vals, Some(3))).expect("chunked");
    let mut z = vec![0.0f32; k.n];
    pollster::block_on(chunked.spmv(&g, &x, &mut z)).expect("one chunked spmv");
    let differing = y.iter().zip(&z).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
    assert_eq!(differing, 0, "{differing} of {} components differ across the chunk split", k.n);
}

/// A9: an identity system converges in one iteration, before the rest of the GPU batch.
/// Reuse each context with a zero RHS and then another load to check per-solve state resets.
#[test]
fn gpu_cg_preserves_exact_convergence_through_the_rest_of_a_batch() {
    let g = gpu();
    for n in [1, 7, 257] {
        let k = Csr { n, row_ptr: (0..=n as u32).collect(), col_idx: (0..n as u32).collect(), vals: vec![1.0; n] };
        let ctx = pollster::block_on(CgContext::new(&g, &k, &vec![1.0; n], Some(3))).unwrap();
        for budget in [2, 25, 50] {
            for load in [1.0, 0.0, -2.0] {
                let b = vec![load; n];
                let mut x = vec![f32::NAN; n];
                let done = pollster::block_on(ctx.solve(&g, &b, 1e-5, budget, &mut x, &mut nop)).unwrap();
                assert_eq!(done, budget.min(25));
                assert_eq!(x, b, "identity, n={n}, budget={budget}, load={load}");
            }
        }
    }
}

/// Actual device loss at each public solve readback boundary must be a structured
/// failure. The outer scope owns validation from commands sent after destruction;
/// the readback owns its separate scope and mapping failure. No numeric oracle is
/// replaced by a device-loss fixture.
#[test]
fn gpu_cg_reports_device_loss_before_initial_batch_and_correction_readbacks() {
    for budget in [0, 25, 50] {
        let g = gpu();
        let k = poisson(127);
        let vals: Vec<f32> = k.vals.iter().map(|&v| v as f32).collect();
        let ctx = pollster::block_on(CgContext::new(&g, &k, &vals, None)).unwrap();
        let load = data(k.n, 0.31).0;
        let scope = g.device.push_error_scope(wgpu::ErrorFilter::Validation);
        if budget == 0 {
            g.device.destroy();
        }
        let mut destroyed_between_submissions = 0;
        let mut destroy = |progress: Progress| {
            assert!(progress.message.starts_with("gpu cg "));
            g.device.destroy();
            destroyed_between_submissions += 1;
            true
        };
        let error = pollster::block_on(ctx.solve_report(&g, &load, 0.0, budget, &mut vec![0.0; k.n], &mut destroy))
            .unwrap_err();
        // Lost devices need not also emit Validation: consume the typed scope in
        // either case; the solve's own structured readback failure is mandatory.
        let _ = pollster::block_on(scope.pop());
        assert_eq!(error.code, ErrorCode::Internal);
        assert_eq!(error.where_.as_deref(), Some("solve/readback"));
        let bytes = if budget == 25 { 4 * k.n } else { 36 };
        assert!(error.cause.contains(&format!("gpu readback of {bytes} bytes failed")), "{error:?}");
        assert!(error.cause.contains("device_loss=Some((Destroyed,"), "{error:?}");
        assert!(error.cause.contains("poll="), "{error:?}");
        assert!(error.cause.contains("mapping="), "{error:?}");
        assert_eq!(destroyed_between_submissions, usize::from(budget > 0));
    }
}

/// The public refined solver preserves the actual readback failure, including when
/// its admitted hierarchy was already uploaded successfully before device loss.
#[test]
fn gpu_prepared_solver_preserves_device_loss_instead_of_returning_a_correction() {
    let g = gpu();
    let k = poisson(127);
    let mut solver = pollster::block_on(GpuCg::new(&g, &k, &SolveOptions::default())).unwrap();
    let scope = g.device.push_error_scope(wgpu::ErrorFilter::Validation);
    g.device.destroy();
    let error = pollster::block_on(solver.solve(&vec![1.0; k.n], &mut vec![0.0; k.n], &mut nop)).unwrap_err();
    let _ = pollster::block_on(scope.pop());
    assert_eq!(error.code, ErrorCode::Internal);
    assert_eq!(error.where_.as_deref(), Some("solve/readback"));
    assert!(error.cause.contains("gpu readback of 36 bytes failed"), "{error:?}");
    assert!(error.cause.contains("device_loss=Some((Destroyed,"), "{error:?}");
    assert_eq!(solver.iterations, 0);
}

/// A9: Jacobi scaling turns every positive diagonal into an identity. The oracle is b_i/d_i,
/// including the whole f64 refinement path and both CPU thread counts, never another solver.
#[test]
fn gpu_refinement_solves_positive_diagonals_without_a_spurious_stall() {
    let g = gpu();
    for n in [1, 7, 257] {
        let k = Csr {
            n,
            row_ptr: (0..=n as u32).collect(),
            col_idx: (0..n as u32).collect(),
            vals: (0..n).map(|i| 4.0f64.powi((i % 4) as i32)).collect(),
        };
        for threads in [1, 2] {
            let pool = Pool::new(threads);
            for load in [1.0, 0.0] {
                let opts = SolveOptions { solver: Solver::GpuPcg, max_iterations: 50, ..SolveOptions::default() };
                let b = vec![load; n];
                let (x, info) = pollster::block_on(solve(&k, &b, &opts, &pool, Some(&g), &mut nop)).unwrap();
                assert_eq!(info.rel_residual, 0.0);
                for (i, xi) in x.iter().enumerate() {
                    assert_eq!(*xi, load / k.vals[i], "diagonal row {i}, n={n}, threads={threads}");
                }
            }
        }
    }
}

#[test]
fn gpu_cg_handles_a_nonzero_beta_and_freezes_on_nonpositive_curvature() {
    let g = gpu();
    // [[1, 1/2], [1/2, 1]]^-1 [1, 0] = [4/3, -2/3]. CG needs two steps.
    let k = Csr { n: 2, row_ptr: vec![0, 2, 4], col_idx: vec![0, 1, 0, 1], vals: vec![1.0, 0.5, 0.5, 1.0] };
    let ctx = pollster::block_on(CgContext::new(&g, &k, &[1.0, 0.5, 0.5, 1.0], None)).unwrap();
    let mut x = [0.0; 2];
    pollster::block_on(ctx.solve(&g, &[1.0, 0.0], 1e-5, 50, &mut x, &mut nop)).unwrap();
    assert!((x[0] - 4.0 / 3.0).abs() < 1e-6);
    assert!((x[1] + 2.0 / 3.0).abs() < 1e-6);

    for diagonal in [0.0, -1.0] {
        let k = Csr { n: 1, row_ptr: vec![0, 1], col_idx: vec![0], vals: vec![diagonal as f64] };
        let ctx = pollster::block_on(CgContext::new(&g, &k, &[diagonal], None)).unwrap();
        let mut x = [f32::NAN];
        pollster::block_on(ctx.solve(&g, &[1.0], 1e-5, 50, &mut x, &mut nop)).unwrap();
        assert_eq!(x, [0.0], "no valid step exists for curvature {diagonal}");
    }
}

/// Issue #3: report the uploaded operator's actual outcome rather than draining the
/// entire budget after a device halt. Every oracle below follows from a 1x1 or 2x2 system.
#[test]
fn gpu_cg_reports_updates_budget_and_rounded_operator_breakdown() {
    let g = gpu();
    let identity = Csr { n: 1, row_ptr: vec![0, 1], col_idx: vec![0], vals: vec![1.0] };
    let ctx = pollster::block_on(CgContext::new(&g, &identity, &[1.0], None)).unwrap();
    for (load, budget, updates, submitted, stop, residual) in [
        (1.0, 50, 1, 25, CgStopReason::Converged, 0.0),
        (0.0, 50, 0, 25, CgStopReason::Converged, 0.0),
        (1.0, 0, 0, 0, CgStopReason::IterationLimit, 1.0),
        (0.0, 0, 0, 0, CgStopReason::Converged, 0.0),
    ] {
        let mut x = [f32::NAN];
        let report = pollster::block_on(ctx.solve_report(&g, &[load], 1e-5, budget, &mut x, &mut nop)).unwrap();
        assert_eq!(report.stop, stop);
        assert_eq!(report.iterations, updates);
        assert_eq!(report.submitted_iterations, submitted);
        assert_eq!(report.relative_residual, residual);
        assert_eq!(x[0], if updates == 1 { load } else { 0.0 });
    }

    // One step from zero: alpha=1, x=(1,0), r=(0,-1/2), ||r||/||b||=1/2.
    let k = Csr { n: 2, row_ptr: vec![0, 2, 4], col_idx: vec![0, 1, 0, 1], vals: vec![1.0, 0.5, 0.5, 1.0] };
    let ctx = pollster::block_on(CgContext::new(&g, &k, &[1.0, 0.5, 0.5, 1.0], None)).unwrap();
    let mut x = [f32::NAN; 2];
    let report = pollster::block_on(ctx.solve_report(&g, &[1.0, 0.0], 1e-5, 1, &mut x, &mut nop)).unwrap();
    assert_eq!(report.stop, CgStopReason::IterationLimit);
    assert_eq!(report.iterations, 1);
    assert_eq!(report.relative_residual, 0.5);
    assert_eq!(x, [1.0, 0.0]);

    // The first update reaches the requested residual before a subsequent batch
    // iteration sees the small negative eigenspace. Keep that usable correction:
    // the physical f64 outer residual, rather than the rounded curvature, decides
    // whether it solves the original problem.
    let indefinite = Csr { n: 2, row_ptr: vec![0, 1, 2], col_idx: vec![0, 1], vals: vec![1.0, -1.0] };
    let ctx = pollster::block_on(CgContext::new(&g, &indefinite, &[1.0, -1.0], None)).unwrap();
    let report = pollster::block_on(ctx.solve_report(&g, &[1.0, 1e-4], 1e-3, 50, &mut x, &mut nop)).unwrap();
    assert_eq!(report.stop, CgStopReason::Converged);
    assert_eq!(report.iterations, 1);
    assert!((report.relative_residual - 2e-4).abs() < 1e-7);
    assert_eq!(x, [1.0, 1e-4]);

    // Above the inner target, a finite partial correction still belongs to f64
    // refinement. Preserve it, expose its actual stop, and honor cancellation.
    let report = pollster::block_on(ctx.solve_report(&g, &[1.0, 1e-4], 1e-6, 50, &mut x, &mut nop)).unwrap();
    assert_eq!(report.stop, CgStopReason::NonPositiveCurvature);
    let mut message = String::new();
    let mut progress = |p: Progress| {
        message = p.message;
        true
    };
    report.check_correction(&mut progress).unwrap();
    assert!(message.contains("checking the partial correction in f64"));
    assert_eq!(x, [1.0, 1e-4]);
    assert_eq!(report.iterations, 1);
    let error = report.check_correction(&mut |_p| false).unwrap_err();
    assert_eq!(error.code, ErrorCode::Cancelled);

    // Exact eigenvalues are delta and 2-delta, both positive. Rounding to f32 turns
    // every entry into 1; the eigenvector (1,-1) then has zero uploaded curvature.
    let delta = 2.0f64.powi(-26);
    let k =
        Csr { n: 2, row_ptr: vec![0, 2, 4], col_idx: vec![0, 1, 0, 1], vals: vec![1.0, 1.0 - delta, 1.0 - delta, 1.0] };
    let vals: Vec<f32> = k.vals.iter().map(|&v| v as f32).collect();
    assert_eq!(vals, vec![1.0; 4]);
    let ctx = pollster::block_on(CgContext::new(&g, &k, &vals, None)).unwrap();
    let report = pollster::block_on(ctx.solve_report(&g, &[1.0, -1.0], 1e-5, 5000, &mut x, &mut nop)).unwrap();
    assert_eq!(report.stop, CgStopReason::NonPositiveCurvature);
    assert_eq!(report.iterations, 0);
    assert_eq!(report.submitted_iterations, 25);
    assert_eq!(report.relative_residual, 1.0);
    assert_eq!(x, [0.0, 0.0]);
    // The public solver applies C then CT. Allowed fused arithmetic can perturb
    // (1,-1) out of the rounded operator's null space, so that fixture cannot
    // independently require its preconditioned inner solve to make zero updates.
    // The true f64 outer acceptance must still refuse this rank-lost calculation.
    let error = pollster::block_on(femlab_engine::gpu::cg::solve_refined(
        Some(&g),
        &k,
        &[1.0, -1.0],
        &SolveOptions::default(),
        &mut nop,
    ))
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::SolveStalled);
    assert_eq!(error.where_.as_deref(), Some("solve"));
    assert_eq!(error.suggestion.as_deref(), Some("solve.run { solver: 'cpu-direct' }"));

    // Exact negative curvature is invariant here: Jacobi uses scale1 for d=-1,
    // the diagonal specialization is identity, p=1 and p*A*p=-1. No preconditioned
    // cancellation or backend contraction can turn this into a usable first step.
    let negative = Csr { n: 1, row_ptr: vec![0, 1], col_idx: vec![0], vals: vec![-1.0] };
    let mut inner = pollster::block_on(GpuCg::new(&g, &negative, &SolveOptions::default())).unwrap();
    let error = pollster::block_on(inner.solve(&[1.0], &mut [0.0], &mut nop)).unwrap_err();
    assert_eq!(error.code, ErrorCode::SolveStalled);
    assert!(error.cause.contains("nonpositive curvature in the uploaded f32 operator"));
    assert_eq!(error.where_.as_deref(), Some("solve"));
    assert_eq!(error.suggestion.as_deref(), Some("solve.run { solver: 'cpu-direct' }"));
    assert_eq!(inner.iterations, 0);

    // Finite f64 data can exceed the f32 residual range. This is an explicit GPU
    // failure, without misclassifying the original identity as indefinite.
    for max_iterations in [0, 50] {
        let opts = SolveOptions { max_iterations, ..SolveOptions::default() };
        let mut inner = pollster::block_on(GpuCg::new(&g, &identity, &opts)).unwrap();
        let error = pollster::block_on(inner.solve(&[1e100], &mut [0.0], &mut nop)).unwrap_err();
        assert_eq!(error.code, ErrorCode::SolveStalled);
        assert!(error.cause.contains("nonfinite scalar in the uploaded f32 solve"));
        assert_eq!(inner.iterations, 0);
    }
}

/// The Dirichlet one-dimensional Laplacian has exact sine eigenvectors and positive
/// energy. These sizes exercise a dense coarse solve, transfer, and multiple levels;
/// no second implementation of the aggregation algorithm supplies an oracle.
fn poisson(n: usize) -> Csr {
    let mut row_ptr = vec![0];
    let mut col_idx = Vec::new();
    let mut vals = Vec::new();
    for row in 0..n {
        if row > 0 {
            col_idx.push((row - 1) as u32);
            vals.push(-1.0);
        }
        col_idx.push(row as u32);
        vals.push(2.0);
        if row + 1 < n {
            col_idx.push((row + 1) as u32);
            vals.push(-1.0);
        }
        row_ptr.push(vals.len() as u32);
    }
    Csr { n, row_ptr, col_idx, vals }
}

#[test]
fn aggregation_gpu_cycle_is_linear_symmetric_positive_and_solves_sine_modes() {
    let g = gpu();
    let opts = SolveOptions { solver: Solver::GpuPcg, ..SolveOptions::default() };
    // One constant candidate gives 1537 -> 97 -> 7 with sixteen-row aggregates.
    // Keep a true two-fine-level public GPU witness as well as the smaller cases.
    for n in [31, 127, 1023, 1537] {
        let k = poisson(n);
        let inner = pollster::block_on(GpuCg::new(&g, &k, &opts)).unwrap();
        let (a, b) = data(n, 0.73);
        let sum: Vec<f32> = a.iter().zip(&b).map(|(&x, &y)| x + y).collect();
        let mut ma = vec![0.0; n];
        let mut mb = vec![0.0; n];
        let mut ms = vec![0.0; n];
        pollster::block_on(inner.apply_preconditioner(&a, &mut ma)).unwrap();
        pollster::block_on(inner.apply_preconditioner(&b, &mut mb)).unwrap();
        pollster::block_on(inner.apply_preconditioner(&sum, &mut ms)).unwrap();
        let aa = dot_f64(&a, &ma).0;
        let bb = dot_f64(&b, &mb).0;
        assert!(aa > 0.0 && bb > 0.0, "n={n}: nonpositive cycle energy {aa}, {bb}");
        let asymmetry = (dot_f64(&a, &mb).0 - dot_f64(&b, &ma).0).abs();
        assert!(asymmetry <= 2e-4 * (aa * bb).sqrt(), "n={n}: cycle asymmetry {asymmetry:e}");
        let linear_error = ms
            .iter()
            .zip(&ma)
            .zip(&mb)
            .map(|((&s, &x), &y)| (s as f64 - x as f64 - y as f64).powi(2))
            .sum::<f64>()
            .sqrt();
        let output_norm = ms.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
        assert!(linear_error <= 2e-4 * output_norm, "n={n}: nonlinear cycle {linear_error:e}");
        let mut again = vec![0.0; n];
        pollster::block_on(inner.apply_preconditioner(&a, &mut again)).unwrap();
        assert_eq!(ma, again, "n={n}: repeated cycle changed bits");
        assert_eq!(
            pollster::block_on(inner.apply_preconditioner(&a[..n - 1], &mut again)).unwrap_err().code,
            ErrorCode::Schema
        );
        assert_eq!(
            pollster::block_on(inner.apply_preconditioner(&a, &mut again[..n - 1])).unwrap_err().code,
            ErrorCode::Schema
        );

        let angle = std::f64::consts::PI / (n + 1) as f64;
        let eigenvalue = 4.0 * libm::sin(0.5 * angle).powi(2);
        let exact: Vec<f64> = (1..=n).map(|i| libm::sin(angle * i as f64)).collect();
        let rhs: Vec<f64> = exact.iter().map(|x| eigenvalue * x).collect();
        let mut solutions = Vec::new();
        for threads in [1, 4] {
            let pool = Pool::new(threads);
            let (got, info) = pollster::block_on(solve(&k, &rhs, &opts, &pool, Some(&g), &mut nop)).unwrap();
            assert_eq!(info.solver, "gpu-pcg");
            assert!(info.rel_residual < 100.0 * opts.rel_tol, "n={n}: {:?}", info);
            let error = got.iter().zip(&exact).map(|(a, b)| (a - b).powi(2)).sum::<f64>().sqrt();
            let norm = exact.iter().map(|x| x * x).sum::<f64>().sqrt();
            assert!(error < 1e-6 * norm, "n={n}: sine solution error {error:e}");
            solutions.push(got);
        }
        assert_eq!(solutions[0], solutions[1], "n={n}: thread count changed GPU solution bits");
    }
    // Exact diagonal specialization remains an identity map, including stored zeros.
    let diagonal = Csr { n: 2, row_ptr: vec![0, 2, 4], col_idx: vec![0, 1, 0, 1], vals: vec![4.0, 0.0, 0.0, 16.0] };
    let inner = pollster::block_on(GpuCg::new(&g, &diagonal, &opts)).unwrap();
    let mut out = [0.0; 2];
    pollster::block_on(inner.apply_preconditioner(&[0.25, -0.5], &mut out)).unwrap();
    assert_eq!(out, [0.25, -0.5]);
    // The public matrix-only refinement wrapper has the same independent exact oracle.
    let (got, info) =
        pollster::block_on(femlab_engine::gpu::cg::solve_refined(Some(&g), &diagonal, &[1.0, -8.0], &opts, &mut nop))
            .unwrap();
    assert_eq!(got, [0.25, -0.5]);
    assert_eq!(info.solver, "gpu-pcg");
}

/// A valid smoothed interpolation row may cancel exactly. Tight injected device
/// limits put this final row in a separate chunk: zero gathers still require a
/// nonempty storage binding for the unused value/index arrays.
#[test]
fn gpu_aggregation_zero_interpolation_chunk_keeps_the_exact_spd_solution() {
    let mut g = gpu();
    g.limits.max_buffer_size = 508;
    g.limits.max_storage_buffer_binding_size = 508;
    let n = 127;
    let diagonal = f64::from_bits((49.0 / 16.0f64).to_bits() + 8);
    // Identity plus the exact SPD2x2 block[[d,.875],[.875,1]], determinantd-.875²>0.
    assert!(diagonal - 0.875f64.powi(2) > 0.0);
    let mut k = Csr { n, row_ptr: vec![0], col_idx: Vec::new(), vals: Vec::new() };
    for row in 0..n {
        if row == n - 1 {
            k.col_idx.push((n - 2) as u32);
            k.vals.push(0.875);
        }
        k.col_idx.push(row as u32);
        k.vals.push(if row == n - 2 { diagonal } else { 1.0 });
        if row == n - 2 {
            k.col_idx.push((n - 1) as u32);
            k.vals.push(0.875);
        }
        k.row_ptr.push(k.vals.len() as u32);
    }
    let mut rhs = vec![1.0; n];
    rhs[n - 2] = diagonal + 0.875;
    rhs[n - 1] = 1.875;
    let opts = SolveOptions { solver: Solver::GpuPcg, ..SolveOptions::default() };
    let (answer, info) = pollster::block_on(solve(&k, &rhs, &opts, &Pool::new(2), Some(&g), &mut nop)).unwrap();
    assert_eq!(info.solver, "gpu-pcg");
    assert!(info.rel_residual < 100.0 * opts.rel_tol);
    for x in answer {
        assert!((x - 1.0).abs() < 1e-8, "exact SPD solution1, got{x}");
    }
}

fn log_solver_diagnostics(progress: Progress) -> bool {
    if progress.phase == "solve" {
        println!("{}", progress.message);
    }
    true
}

/// Exercise the public procedure, including its physical reduced near-space handoff.
/// Matrix-only tests above deliberately have no geometry metadata.
fn solve_cantilever_model(e: &mut Engine, n: [usize; 3]) -> femlab_engine::query::ResultSummary {
    let mesh = serde_json::json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":n[0],"ny":n[1],"nz":n[2]}},"formulation":"incompatible-modes"}).to_string();
    for command in [
        r#"{"cmd":"model.new","name":"GPU aggregation B1 cantilever"}"#,
        r#"{"cmd":"geometry.addBox","name":"beam","size":["1 m","0.1 m","0.1 m"]}"#,
        &mesh,
        r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3}"#,
        r#"{"cmd":"material.assign","material":"steel","bodies":["beam"]}"#,
        r#"{"cmd":"constraint.fix","name":"root","on":"beam.xmin","dofs":["ux","uy","uz"]}"#,
        r#"{"cmd":"load.traction","name":"tip","on":"beam.xmax","total":["0 N","0 N","-1 kN"]}"#,
        r#"{"cmd":"step.add","name":"s","procedure":"static","constraints":["root"],"loads":["tip"]}"#,
        r#"{"cmd":"solve.run","step":"s","solver":"gpu-pcg"}"#,
    ] {
        pollster::block_on(e.dispatch(serde_json::from_str(command).unwrap(), &mut log_solver_diagnostics)).unwrap();
    }
    serde_json::from_value(
        serde_json::to_value(e.query(Query::Result { step: None, result_id: None }).unwrap()).unwrap(),
    )
    .unwrap()
}

fn cantilever_displacement(e: &mut Engine) -> Vec<f64> {
    let field: femlab_engine::query::ResultField = serde_json::from_value(
        serde_json::to_value(
            e.query(Query::Field { step: None, result_id: None, field: "displacement".into() }).unwrap(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(field.components, 3);
    assert!(field.values.iter().all(|x| x.is_finite()));
    field.values
}

/// Independent B1 Timoshenko tip displacement and unaggregated global equilibrium.
/// The historical 2% bending tolerance and unchanged f64 residual policy are retained.
fn check_cantilever_reference(e: &mut Engine, result: &femlab_engine::query::ResultSummary) {
    assert_eq!(result.solver, "gpu-pcg");
    assert!(result.residual < 1e-8, "true f64 residual {}", result.residual);
    let query=serde_json::from_value(serde_json::json!({"query":"query.probe","step":"s","field":"displacement","component":2,"at":["1 m","0.05 m","0.05 m"]})).unwrap();
    let probe: femlab_engine::query::ProbeResult =
        serde_json::from_value(serde_json::to_value(e.query(query).unwrap()).unwrap()).unwrap();
    let ei = 210e9 * 0.1 * 0.1f64.powi(3) / 12.0;
    let shear = (5.0 / 6.0) * (210e9 / (2.0 * (1.0 + 0.3))) * 0.1 * 0.1;
    let reference = -1000.0 / (3.0 * ei) - 1000.0 / shear;
    assert!((probe.value.value / reference - 1.0).abs() < 0.02, "B1 tip {} vs {reference}", probe.value.value);
    let equilibrium = result.static_equilibrium.as_ref().unwrap();
    // One part per million of the 1 kN action is an independent force/moment gate;
    // the solver's residual remains stricter and is never inferred from this ledger.
    for component in &equilibrium.force_residual {
        assert!(component.value.abs() < 0.001, "force residual {:?}", equilibrium.force_residual);
    }
    for component in &equilibrium.moment_residual {
        assert!(component.value.abs() < 0.001, "moment residual {:?}", equilibrium.moment_residual);
    }
}

#[test]
fn production_gpu_aggregation_cantilever_matches_b1_and_thread_counts() {
    let mut answers = Vec::new();
    for threads in [1, 4] {
        let mut e = Engine::new(Some(gpu()), Box::new(NoClock), threads);
        let result = solve_cantilever_model(&mut e, [16, 4, 4]);
        check_cantilever_reference(&mut e, &result);
        answers.push(cantilever_displacement(&mut e));
    }
    assert_eq!(answers[0], answers[1], "physical near-space setup changed with thread count");
}

/// D5's CI sibling: 66k degrees of freedom solved on the GPU inside the f64 refinement loop,
/// against the direct factorisation of the same matrix. Software adapters establish
/// correctness only; this harness does not measure or compare elapsed times.
///
/// Ignored by default and run in release by the `gpu` CI job
/// (`cargo test --release --features gpu-tests --test gpu_kernels -- --ignored sixty_six`):
/// instrumentation increases the large case's working set, and coverage measured in release
/// attributes inlined functions wrongly, so the coverage run stays in debug and
/// this test stays out of it. The kernels it exercises are covered by the smaller tests above.
#[test]
#[ignore]
fn the_sixty_six_thousand_dof_cantilever_matches_the_direct_solver() {
    let g = gpu();
    let adapter = g.adapter.clone();
    let red = cantilever_reduced([50, 20, 20]);
    let pool = Pool::new(4);
    let direct = SolveOptions { solver: Solver::CpuDirect, ..SolveOptions::default() };
    let (want, _) = pollster::block_on(solve(&red.k_ff, &red.f_f, &direct, &pool, None, &mut nop)).expect("direct");
    let mut e = Engine::new(Some(g), Box::new(NoClock), 1);
    let result = solve_cantilever_model(&mut e, [50, 20, 20]);
    check_cantilever_reference(&mut e, &result);
    let full = cantilever_displacement(&mut e);
    let got: Vec<f64> = red.free.iter().map(|&row| full[row as usize]).collect();
    let norm = |v: &[f64]| v.iter().map(|x| x * x).sum::<f64>().sqrt();
    let diff: Vec<f64> = got.iter().zip(&want).map(|(a, b)| a - b).collect();
    assert!(norm(&diff) <= 1e-8 * norm(&want), "‖u_gpu − u_direct‖ = {:e}, ‖u‖ = {:e}", norm(&diff), norm(&want));
    println!(
        "D5 CI sibling: {} equations, {} refinement steps, residual {:e} on {adapter}",
        red.k_ff.n, result.iterations, result.residual
    );
    // Rebuild via the same public procedure at a second CPU pool size. Setup and
    // same-adapter device arithmetic must retain the complete displacement bits.
    drop(e);
    let same_adapter = gpu();
    assert_eq!(same_adapter.adapter, adapter);
    let mut again = Engine::new(Some(same_adapter), Box::new(NoClock), 4);
    let repeated = solve_cantilever_model(&mut again, [50, 20, 20]);
    check_cantilever_reference(&mut again, &repeated);
    assert_eq!(full, cantilever_displacement(&mut again));
}

/// Benchmark B1's `[8,2,2]` cantilever through `solve.run { solver: 'gpu-pcg' }`: the whole
/// scale → upload → f32 CG → f64 refinement path on a bounded model, so the coverage job
/// sees the converged branch without the 66k-DOF sibling.
#[test]
fn the_small_cantilever_solves_on_the_gpu_and_matches_the_direct_solver() {
    let g = gpu();
    let (k, f) = cantilever([8, 2, 2]);
    let pool = Pool::new(2);
    let direct = SolveOptions { solver: Solver::CpuDirect, ..SolveOptions::default() };
    let (want, _) = pollster::block_on(solve(&k, &f, &direct, &pool, None, &mut nop)).expect("direct");
    let opts = SolveOptions { solver: Solver::GpuPcg, ..SolveOptions::default() };
    let (got, info) = pollster::block_on(solve(&k, &f, &opts, &pool, Some(&g), &mut nop)).expect("gpu-pcg");
    assert_eq!(info.solver, "gpu-pcg");
    assert!(info.iterations >= 1);
    let norm = |v: &[f64]| v.iter().map(|x| x * x).sum::<f64>().sqrt();
    let diff: Vec<f64> = got.iter().zip(&want).map(|(a, b)| a - b).collect();
    assert!(norm(&diff) <= 1e-8 * norm(&want), "‖u_gpu − u_direct‖ = {:e}, ‖u‖ = {:e}", norm(&diff), norm(&want));
}

/// D5: 780,300 reduced equations, run explicitly on a real device only after host
/// and device capacity admission. No giant direct factorisation supplies the oracle.
/// Software adapters exercise the identical cycle in the smaller active cases above.
#[test]
#[ignore]
fn the_million_dof_cantilever_meets_b1_and_the_f64_residual() {
    let g = gpu();
    let adapter = g.adapter.clone();
    let mut e = Engine::new(Some(g), Box::new(NoClock), 4);
    let result = solve_cantilever_model(&mut e, [100, 50, 50]);
    check_cantilever_reference(&mut e, &result);
    let displacement = cantilever_displacement(&mut e);
    assert_eq!(displacement.len(), 101 * 51 * 51 * 3);
    assert_eq!(displacement.len() - 51 * 51 * 3, 780_300);
    println!(
        "D5: 780300 equations, {} refinement steps, f64 residual {:e} on {adapter}",
        result.iterations, result.residual
    );
}

/// The device paths that fail: a matrix no adapter could hold, and a host that says stop while
/// the conjugate gradient is between submissions.
#[test]
fn the_gpu_solver_reports_a_matrix_too_big_for_the_device_and_obeys_a_cancel() {
    let mut g = gpu();
    {
        // A valid sparse identity costs only 27 MB here. Its requested f64 history is
        // over the fixed bound and must refuse before any solver buffer is uploaded.
        let n = 1_700_000;
        let identity =
            Csr { n, row_ptr: (0..=n as u32).collect(), col_idx: (0..n as u32).collect(), vals: vec![1.0; n] };
        let error = pollster::block_on(femlab_engine::gpu::cg::solve_refined(
            Some(&g),
            &identity,
            &vec![1.0; n],
            &SolveOptions::default(),
            &mut nop,
        ))
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::SolveTooLarge);
        assert_eq!(error.where_.as_deref(), Some("solve/refinement"));
    }

    let (k, f) = cantilever([16, 4, 4]);
    let pool = Pool::new(2);
    // Both actual hierarchy construction and a completed inner correction are cancellable.
    let opts = SolveOptions { solver: Solver::GpuPcg, inner_tol: 1e-9, ..SolveOptions::default() };

    // Cancellation is defined by actual phases, not by an incidental callback count.
    for phase in ["GPU preconditioner:", "GPU correction:"] {
        let mut reached = false;
        let mut stop = |progress: Progress| {
            if progress.message.starts_with(phase) {
                reached = true;
                false
            } else {
                true
            }
        };
        let error = pollster::block_on(solve(&k, &f, &opts, &pool, Some(&g), &mut stop)).unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert!(reached, "never reached {phase}");
    }
    // Plain CG on a generic Laplacian load cannot finish in its first 25 iterations:
    // exercise cancellation at the actual submission boundary independently of AMG.
    let plain = poisson(127);
    let vals: Vec<f32> = plain.vals.iter().map(|&v| v as f32).collect();
    let ctx = pollster::block_on(CgContext::new(&g, &plain, &vals, None)).unwrap();
    let load = data(plain.n, 0.31).0;
    let mut reached = false;
    let mut stop = |progress: Progress| {
        reached = progress.message.starts_with("gpu cg ");
        false
    };
    let error =
        pollster::block_on(ctx.solve_report(&g, &load, 0.0, 500, &mut vec![0.0; plain.n], &mut stop)).unwrap_err();
    assert_eq!(error.code, ErrorCode::Cancelled);
    assert!(reached);

    g.limits.max_buffer_size = 1024;
    g.limits.max_storage_buffer_binding_size = 1024;
    let e = pollster::block_on(solve(&k, &f, &opts, &pool, Some(&g), &mut nop)).expect_err("vectors beyond 1 KiB");
    assert_eq!(e.code, ErrorCode::GpuTooLarge);
    assert!(e.cause.contains("gpu conjugate gradient"), "{}", e.cause);

    // A tiny matrix still needs the complete scalar scratch. Both independent
    // device limits must refuse it before buffer construction, not wgpu validation.
    let tiny = poisson(2);
    let vals: Vec<f32> = tiny.vals.iter().map(|&v| v as f32).collect();
    for storage_limit in [false, true] {
        g.limits.max_buffer_size = 1024;
        g.limits.max_storage_buffer_binding_size = 1024;
        if storage_limit {
            g.limits.max_storage_buffer_binding_size = 16;
        } else {
            g.limits.max_buffer_size = 16;
        }
        let error = pollster::block_on(CgContext::new(&g, &tiny, &vals, None)).err().unwrap();
        assert_eq!(error.code, ErrorCode::GpuTooLarge);
        assert!(error.cause.contains("36 bytes"));
        assert!(error.suggestion.unwrap().contains("coarser"));
    }

    // and an adapter that cannot run a 256-thread workgroup fails at the kernels, before any buffer
    let mut small = gpu();
    small.limits.max_compute_invocations_per_workgroup = WORKGROUP - 1;
    let e = pollster::block_on(solve(&k, &f, &opts, &pool, Some(&small), &mut nop)).expect_err("no such workgroup");
    assert_eq!(e.code, ErrorCode::GpuTooLarge);
    assert!(e.cause.contains("threads per workgroup"), "{}", e.cause);
    // The public raw context has the same typed compiler/capability boundary.
    let error = pollster::block_on(CgContext::new(&small, &tiny, &vals, None)).err().unwrap();
    assert_eq!(error.code, ErrorCode::GpuTooLarge);
    assert!(error.cause.contains("threads per workgroup"));
}

#[test]
fn requesting_a_backend_nobody_has_is_an_error() {
    let e = pollster::block_on(Gpu::request(wgpu::Backends::empty())).unwrap_err();
    assert_eq!(e.code, ErrorCode::Unsupported);
    assert!(e.cause.contains("no GPU adapter"));
    let e = pollster::block_on(Gpu::request_with(Gpu::default_backends(), wgpu::Features::all())).unwrap_err();
    assert_eq!(e.code, ErrorCode::Unsupported);
    assert!(e.cause.contains("device request failed"));
}

/// The reduced system of the same cantilever cut in two at mid-span and tied back together.
///
/// This is what proves the GPU needs no change for a bonded contact: `mpc::transform` runs
/// *before* `assembly::reduce`, so what reaches a solver is still a plain `k_ff`. A later change
/// that moved the GPU up to the un-reduced operator would fail here rather than silently.
fn tied_cantilever() -> (Csr, Vec<f64>) {
    let half: Mesh = Structured { kind: ElementKind::Hex8, n: [4, 2, 2] }.box_([0.5, 0.1, 0.1]);
    let node_offset = half.n_nodes() as u32;
    let elem_offset = half.n_elems() as u32;
    let mut mesh = half.clone();
    let moved: Vec<f64> = half.coords.iter().enumerate().map(|(i, x)| if i % 3 == 0 { x + 0.5 } else { *x }).collect();
    mesh.coords.extend(moved);
    for blk in &half.blocks {
        mesh.blocks.push(ElementBlock {
            kind: blk.kind,
            conn: blk.conn.iter().map(|n| n + node_offset).collect(),
            first_elem: blk.first_elem + elem_offset,
        });
    }
    mesh.face_sets = half
        .face_sets
        .iter()
        .map(|(name, faces)| (format!("a.{name}"), faces.clone()))
        .chain(half.face_sets.iter().map(|(name, faces)| {
            let shifted = faces.iter().map(|f| Face { elem: f.elem + elem_offset, local: f.local }).collect();
            (format!("b.{name}"), shifted)
        }))
        .collect();
    let mut sets = BTreeMap::new();
    for (name, faces) in &mesh.face_sets {
        let mut nodes: Vec<u32> = faces.iter().flat_map(|&f| mesh.face_nodes(f)).collect();
        nodes.sort_unstable();
        nodes.dedup();
        sets.insert(name.clone(), ResolvedSet { kind: SetKind::Face, faces: faces.clone(), nodes, elems: Vec::new() });
    }
    let bodies = vec!["a".to_string(), "b".to_string()];
    let p = Problem {
        plies: Vec::new(),
        directors: &[],
        mesh: &mesh,
        sets: &sets,
        body_of_block: &bodies,
        material_of_block: vec![Some(0); mesh.blocks.len()],
        section_of_block: vec![None; mesh.blocks.len()],
        orientation_of_block: vec![None; mesh.blocks.len()],
        sections: Vec::new(),
        points: Vec::new(),
        materials: vec![Material {
            law: builtin_law("linear-elastic").expect("built in"),
            props: vec![210e9, 0.3],
            rho: 7800.0,
            alpha: [0.0; 3],
            k: [0.0; 3],
            cp: 0.0,
            axes: None,
        }],
        idealisation: Idealisation::Solid3d,
        formulation: Formulation::IncompatibleModes,
        constraints: vec![Constraint {
            name: "root".into(),
            nodes: "a.xmin".into(),
            dofs: [true, true, true, false, false, false],
            value: 0.0,
        }],
        couplings: vec![Coupling::Bonded {
            name: "weld".into(),
            master: "a.xmax".into(),
            slave: "b.xmin".into(),
            tol: 1e-9,
        }],
        loads: vec![Load::Traction { faces: "b.xmax".into(), t: [0.0, 0.0, -1e5] }],
        temperature: None,
        heat: false,
        heat_loads: Vec::new(),
    };
    let pat = pattern(&mesh, 3);
    let a = assemble_stiffness(&p, &pat).expect("steel on a box assembles");
    let mut f = a.f_thermal.clone();
    assemble_loads(&p, &mut f).expect("a traction on a real face");
    let rc = resolve(&p).expect("no conflict");
    let m = mpc::build(&p).expect("matched faces pair");
    let (kt, ft) = mpc::transform(&a.k, &f, &m);
    let red = reduce(&kt, &ft, &rc, &m.slaves);
    (red.k_ff, red.f_f)
}

/// A bonded contact reaches the GPU as an ordinary reduced system, and the f32 CG inside the
/// f64 refinement loop lands on the answer the direct solver gives.
#[test]
fn a_tied_assembly_solves_on_the_gpu_and_matches_the_direct_solver() {
    let g = gpu();
    let (k, f) = tied_cantilever();
    let pool = Pool::new(2);
    let direct = SolveOptions { solver: Solver::CpuDirect, ..SolveOptions::default() };
    let (want, _) = pollster::block_on(solve(&k, &f, &direct, &pool, None, &mut nop)).expect("direct");
    let opts = SolveOptions { solver: Solver::GpuPcg, ..SolveOptions::default() };
    let (got, info) = pollster::block_on(solve(&k, &f, &opts, &pool, Some(&g), &mut nop)).expect("gpu-pcg");
    assert_eq!(info.solver, "gpu-pcg");
    let norm = |v: &[f64]| v.iter().map(|x| x * x).sum::<f64>().sqrt();
    let diff: Vec<f64> = got.iter().zip(&want).map(|(a, b)| a - b).collect();
    assert!(norm(&diff) <= 1e-8 * norm(&want), "‖u_gpu − u_direct‖ = {:e}, ‖u‖ = {:e}", norm(&diff), norm(&want));
    // The slave rows left the free set before the solver saw the matrix: no empty row reaches it.
    assert!((0..k.n).all(|r| k.row_ptr[r] < k.row_ptr[r + 1]), "every reduced row has entries");
}

/// #673: exercise the actual assembled B-bar operator, GPU aggregation preconditioner and
/// refinement against uniaxial elasticity, including Poisson contraction and recovered stress.
#[test]
fn mean_dilatation_hex8_gpu_patch_matches_uniaxial_elasticity() {
    let mut e = Engine::new(Some(gpu()), Box::new(NoClock), 2);
    for n in [2, 4, 8] {
        let mesh=serde_json::json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":n,"ny":2,"nz":2}},"formulation":"mean-dilatation"}).to_string();
        for command in [
            r#"{"cmd":"model.new","name":"GPU B-bar patch"}"#,
            r#"{"cmd":"geometry.addBox","name":"bar","size":["1 m","1 m","1 m"]}"#,
            &mesh,
            r#"{"cmd":"material.add","name":"elastic","E":"200 GPa","nu":0.25}"#,
            r#"{"cmd":"material.assign","material":"elastic","bodies":["bar"]}"#,
            r#"{"cmd":"constraint.fix","name":"x","on":"bar.xmin","dofs":["ux"]}"#,
            r#"{"cmd":"constraint.fix","name":"y","on":"bar.ymin","dofs":["uy"]}"#,
            r#"{"cmd":"constraint.fix","name":"z","on":"bar.zmin","dofs":["uz"]}"#,
            r#"{"cmd":"load.traction","name":"pull","on":"bar.xmax","total":["200 MN","0 N","0 N"]}"#,
            r#"{"cmd":"step.add","name":"s","procedure":"static","constraints":["x","y","z"],"loads":["pull"]}"#,
            r#"{"cmd":"solve.run","step":"s","solver":"gpu-pcg"}"#,
        ] {
            pollster::block_on(e.dispatch(serde_json::from_str(command).unwrap(), &mut nop)).unwrap();
        }
        let result: serde_json::Value =
            serde_json::to_value(e.query(Query::Result { step: None, result_id: None }).unwrap()).unwrap();
        assert_eq!(result["solver"], "gpu-pcg");
        for (component, want) in [(0, 0.001), (1, -0.00025), (2, -0.00025)] {
            let query=serde_json::from_value(serde_json::json!({"query":"query.probe","step":"s","field":"displacement","component":component,"at":["1 m","1 m","1 m"]})).unwrap();
            let value: serde_json::Value = serde_json::to_value(e.query(query).unwrap()).unwrap();
            let got = value["value"]["value"].as_f64().unwrap();
            assert!((got / want - 1.0).abs() < 1e-7, "n={n},component={component}: {got} vs {want}");
        }
        let value: serde_json::Value = serde_json::to_value(
            e.query(Query::Field { step: None, result_id: None, field: "stress".into() }).unwrap(),
        )
        .unwrap();
        for stress in value["values"].as_array().unwrap().chunks_exact(6) {
            assert!((stress[0].as_f64().unwrap() / 200e6 - 1.0).abs() < 1e-7);
            for other in &stress[1..] {
                assert!(other.as_f64().unwrap().abs() < 20.0);
            }
        }
    }
}

/// #740: the empty reduced system has an exact solution without GPU buffer bindings.
#[test]
fn all_prescribed_affine_cube_gpu_preserves_recovery_and_journal() {
    let mut e = Engine::new(Some(gpu()), Box::new(NoClock), 2);
    for command in [
        r#"{"cmd":"model.new","name":"all prescribed GPU witness"}"#,
        r#"{"cmd":"geometry.addBox","name":"cube","size":["1 m","1 m","1 m"]}"#,
        r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":1,"ny":1,"nz":1}},"formulation":"full"}"#,
        r#"{"cmd":"material.add","name":"elastic","E":"200 GPa","nu":0.25}"#,
        r#"{"cmd":"material.assign","material":"elastic","bodies":["cube"]}"#,
        r#"{"cmd":"constraint.fix","name":"x0","on":"cube.xmin","dofs":["ux"]}"#,
        r#"{"cmd":"constraint.fix","name":"y0","on":"cube.ymin","dofs":["uy"]}"#,
        r#"{"cmd":"constraint.fix","name":"z0","on":"cube.zmin","dofs":["uz"]}"#,
        r#"{"cmd":"constraint.prescribe","name":"x1","on":"cube.xmax","dof":"ux","value":"0.001 m"}"#,
        r#"{"cmd":"constraint.prescribe","name":"y1","on":"cube.ymax","dof":"uy","value":"-0.00025 m"}"#,
        r#"{"cmd":"constraint.prescribe","name":"z1","on":"cube.zmax","dof":"uz","value":"-0.00025 m"}"#,
        r#"{"cmd":"step.add","name":"s","procedure":"static","constraints":["x0","y0","z0","x1","y1","z1"],"loads":[]}"#,
        r#"{"cmd":"solve.run","step":"s","solver":"gpu-pcg"}"#,
    ] {
        pollster::block_on(e.dispatch(serde_json::from_str(command).unwrap(), &mut nop)).unwrap();
    }
    let result: femlab_engine::query::ResultSummary = serde_json::from_value(
        serde_json::to_value(e.query(Query::Result { step: None, result_id: None }).unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(result.solver, "gpu-pcg");
    assert_eq!(result.iterations, 0);
    assert_eq!(result.residual, 0.0);
    for (component, want) in [(0, 0.001), (1, -0.00025), (2, -0.00025)] {
        let q=serde_json::from_value(serde_json::json!({"query":"query.probe","field":"displacement","component":component,"at":["1 m","1 m","1 m"]})).unwrap();
        let probe: femlab_engine::query::ProbeResult =
            serde_json::from_value(serde_json::to_value(e.query(q).unwrap()).unwrap()).unwrap();
        assert!((probe.value.value / want - 1.0).abs() < 1e-12);
    }
    let stress: femlab_engine::query::ResultField = serde_json::from_value(
        serde_json::to_value(e.query(Query::Field { step: None, result_id: None, field: "stress".into() }).unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(stress.components, 6);
    assert_eq!(stress.values.len(), 48);
    for v in stress.values.chunks_exact(6) {
        assert!((v[0] / 200e6 - 1.0).abs() < 1e-7);
        for x in &v[1..] {
            assert!(x.abs() < 20.0);
        }
    }
    assert_eq!(result.reactions.len(), 6);
    for row in result.reactions {
        let expected = if row.constraint == "x0" {
            -200e6
        } else if row.constraint == "x1" {
            200e6
        } else {
            0.0
        };
        assert!((row.total[0].value - expected).abs() < 20.0);
        assert!(row.total[1].value.abs() < 20.0);
        assert!(row.total[2].value.abs() < 20.0);
    }
    let journal = e.journal().clone();
    assert_eq!(journal.len(), 13);
    let mut replayed = Engine::new(Some(gpu()), Box::new(NoClock), 1);
    pollster::block_on(replayed.replay(&journal.entries, false, true)).unwrap();
    assert_eq!(replayed.journal(), &journal);
    for query in [
        Query::Result { step: None, result_id: None },
        Query::Field { step: None, result_id: None, field: "displacement".into() },
        Query::Field { step: None, result_id: None, field: "stress".into() },
    ] {
        assert_eq!(
            serde_json::to_value(e.query(query.clone()).unwrap()).unwrap(),
            serde_json::to_value(replayed.query(query).unwrap()).unwrap()
        );
    }
}
