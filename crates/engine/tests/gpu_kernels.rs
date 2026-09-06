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
use femlab_engine::fem::problem::{Constraint, Problem};
use femlab_engine::gpu::cg::CgContext;
use femlab_engine::gpu::{Gpu, MAX_WORKGROUPS, WORKGROUP};
use femlab_engine::model::Idealisation;
use femlab_engine::par::Pool;
use femlab_engine::solve::{solve, SolveOptions};
use femlab_engine::{Engine, ErrorCode, NoClock, Progress, Query, QueryResult, ResolvedSet, SetKind};
use femlab_geometry::mesh::ElementKind;
use femlab_geometry::{Mesh, Structured};

fn gpu() -> Gpu {
    pollster::block_on(Gpu::request(Gpu::default_backends())).expect("a GPU adapter is required for gpu-tests")
}

fn nop(_p: Progress) -> bool {
    true
}

/// The engine has no clock of its own (its `Instant` is a disallowed type, ADR 0011), but a
/// Benchmark that prints a wall time needs one — and only prints it, never asserts on it.
#[allow(clippy::disallowed_types)]
fn started() -> std::time::Instant {
    std::time::Instant::now()
}

/// The reduced stiffness and load of the `[nx, ny, nz]` steel cantilever under a tip shear —
/// Benchmark B1's system, which is what every solver here is measured on.
fn cantilever(n: [usize; 3]) -> (Csr, Vec<f64>) {
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
        mesh: &mesh,
        sets: &sets,
        body_of_block: &bodies,
        material_of_block: vec![Some(0); mesh.blocks.len()],
        materials: vec![Material {
            law: builtin_law("linear-elastic").expect("built in"),
            props: vec![210e9, 0.3],
            rho: 7800.0,
            alpha: 0.0,
            k: 0.0,
            cp: 0.0,
        }],
        idealisation: Idealisation::Solid3d,
        formulation: Formulation::IncompatibleModes,
        constraints: vec![Constraint {
            name: "root".into(),
            nodes: "xmin".into(),
            dofs: [true, true, true],
            value: 0.0,
        }],
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
    let red = reduce(&a.k, &f, &rc);
    (red.k_ff, red.f_f)
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

/// D5's CI sibling: 66k degrees of freedom solved on the GPU inside the f64 refinement loop,
/// against the direct factorisation of the same matrix. The wall time is printed, never
/// asserted — software adapters are for correctness, not for timing (AGENTS.md).
///
/// Ignored by default and run in release by the `gpu` CI job
/// (`cargo test --release --features gpu-tests --test gpu_kernels -- --ignored sixty_six`):
/// instrumented debug code on a software adapter takes ten minutes here, and coverage measured
/// in release attributes inlined functions wrongly, so the coverage run stays in debug and
/// this test stays out of it. The kernels it exercises are covered by the smaller tests above.
#[test]
#[ignore]
fn the_sixty_six_thousand_dof_cantilever_matches_the_direct_solver() {
    let g = gpu();
    let (k, f) = cantilever([50, 20, 20]);
    let pool = Pool::new(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2));
    let direct = SolveOptions { solver: Solver::CpuDirect, ..SolveOptions::default() };
    let t0 = started();
    let (want, _) = pollster::block_on(solve(&k, &f, &direct, &pool, None, &mut nop)).expect("direct");
    let cpu_ms = t0.elapsed().as_secs_f64() * 1e3;
    let opts = SolveOptions { solver: Solver::GpuPcg, ..SolveOptions::default() };
    let t1 = started();
    let (got, info) = pollster::block_on(solve(&k, &f, &opts, &pool, Some(&g), &mut nop)).expect("gpu-pcg");
    let gpu_ms = t1.elapsed().as_secs_f64() * 1e3;
    assert_eq!(info.solver, "gpu-pcg");
    let norm = |v: &[f64]| v.iter().map(|x| x * x).sum::<f64>().sqrt();
    let diff: Vec<f64> = got.iter().zip(&want).map(|(a, b)| a - b).collect();
    assert!(norm(&diff) <= 1e-8 * norm(&want), "‖u_gpu − u_direct‖ = {:e}, ‖u‖ = {:e}", norm(&diff), norm(&want));
    println!(
        "D5 CI sibling: {} equations, {} refinement steps, residual {:e}; gpu {gpu_ms:.0} ms vs direct {cpu_ms:.0} ms on {}",
        k.n, info.iterations, info.rel_residual, g.adapter
    );

    // the same solve twice on one adapter is the same bits (plan A §5.4, R5)
    let (again, _) = pollster::block_on(solve(&k, &f, &opts, &pool, Some(&g), &mut nop)).expect("gpu-pcg again");
    let differing = got.iter().zip(&again).filter(|(a, b)| a.to_bits() != b.to_bits()).count();
    assert_eq!(differing, 0, "{differing} of {} components differ between two identical solves", k.n);
}

/// Benchmark B1's `[8,2,2]` cantilever through `solve.run { solver: 'gpu-pcg' }`: the whole
/// scale → upload → f32 CG → f64 refinement path on a solve that finishes in well under a second
/// on any adapter, so the coverage job sees the converged branch without the 66k-DOF sibling.
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

/// The 800k-DOF run of Benchmark D5, by hand: `cargo test --release --features gpu-tests -- --ignored`.
///
/// It prints what happened and asserts nothing, because what happens is the open question: at
/// this conditioning (κ ≈ 1e8) the unpreconditioned f32 CG does not converge inside the inner
/// budget, and plan A's R3 says the refinement then reports `solve.stalled` and names
/// `cpu-direct`. The number this prints is what an aggregation preconditioner has to beat.
#[test]
#[ignore]
fn the_million_dof_cantilever_prints_its_time() {
    let g = gpu();
    let (k, f) = cantilever([100, 50, 50]);
    let pool = Pool::new(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2));
    let opts = SolveOptions { solver: Solver::GpuPcg, ..SolveOptions::default() };
    let t = started();
    let outcome = pollster::block_on(solve(&k, &f, &opts, &pool, Some(&g), &mut nop))
        .map(|(_, info)| format!("{} refinement steps, residual {:e}", info.iterations, info.rel_residual));
    println!(
        "D5: {} equations, {} in {:.1} s on {}",
        k.n,
        outcome.unwrap_or_else(|e| e.cause),
        t.elapsed().as_secs_f64(),
        g.adapter
    );
}

/// The device paths that fail: a matrix no adapter could hold, and a host that says stop while
/// the conjugate gradient is between submissions.
#[test]
fn the_gpu_solver_reports_a_matrix_too_big_for_the_device_and_obeys_a_cancel() {
    let mut g = gpu();
    let (k, f) = cantilever([16, 4, 4]);
    let pool = Pool::new(2);
    // an inner tolerance f32 cannot reach, so the cancel lands between submissions and not at
    // the end of a converged inner solve
    let opts = SolveOptions { solver: Solver::GpuPcg, inner_tol: 1e-9, ..SolveOptions::default() };

    // `solve` asks once, `refine` asks once, and the third asker is the conjugate gradient
    let mut calls = 0;
    let mut stop = |_p: Progress| {
        calls += 1;
        calls <= 2
    };
    let e = pollster::block_on(solve(&k, &f, &opts, &pool, Some(&g), &mut stop)).expect_err("cancelled");
    assert_eq!(e.code, ErrorCode::Cancelled);

    g.limits.max_buffer_size = 1024;
    g.limits.max_storage_buffer_binding_size = 1024;
    let e = pollster::block_on(solve(&k, &f, &opts, &pool, Some(&g), &mut nop)).expect_err("vectors beyond 1 KiB");
    assert_eq!(e.code, ErrorCode::GpuTooLarge);
    assert!(e.cause.contains("gpu conjugate gradient"), "{}", e.cause);

    // and an adapter that cannot run a 256-thread workgroup fails at the kernels, before any buffer
    let mut small = gpu();
    small.limits.max_compute_invocations_per_workgroup = WORKGROUP - 1;
    let e = pollster::block_on(solve(&k, &f, &opts, &pool, Some(&small), &mut nop)).expect_err("no such workgroup");
    assert_eq!(e.code, ErrorCode::GpuTooLarge);
    assert!(e.cause.contains("threads per workgroup"), "{}", e.cause);
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
