//! Linear solvers behind one trait, and the cost estimate a host asks for before solving.
//!
//! `LinearSolve` is the Extension Point: give it a right-hand side, get a solution and what it
//! took. The sparse direct factorisation ([`direct`]) verifies its residual; the f64 Jacobi-PCG ([`pcg`]) is
//! approximate and is driven by the f64 refinement loop in [`refine`], which is also what wraps
//! the GPU's f32 conjugate gradient (ADR 0002, plan A §5.2–§5.4).

pub mod direct;
pub mod pcg;
pub mod refine;

use femlab_geometry::Mesh;

use crate::command::Solver;
use crate::engine::{OnProgress, Progress};
use crate::error::{Error, ErrorCode};
use crate::fem::assembly::Csr;
use crate::par::Pool;
use crate::query::CostEstimate;

/// What a Command asked of the solver. `rel_tol` is the accuracy the *answer* must have, which
/// the f64 refinement loop is measured against; `inner_tol` and `max_iterations` are the
/// approximate inner solver's own, much looser, budget. The direct path verifies and reports
/// its residual against the same f64 acceptance floor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SolveOptions {
    pub solver: Solver,
    pub rel_tol: f64,
    pub max_iterations: usize,
    /// Refinement steps the outer f64 loop may take before it reports `solve.stalled`.
    pub max_outer: usize,
    /// The residual reduction one inner solve aims for; f32 cannot do much better than 1e-5.
    pub inner_tol: f64,
    /// Tests only: force the GPU CSR into chunks of this many rows, so the multi-chunk path
    /// runs on a matrix small enough for any adapter (plan A §5.4).
    pub gpu_chunk_rows: Option<usize>,
}

impl Default for SolveOptions {
    fn default() -> SolveOptions {
        SolveOptions {
            solver: Solver::Auto,
            rel_tol: 1e-10,
            max_iterations: 5000,
            max_outer: 8,
            inner_tol: 1e-5,
            gpu_chunk_rows: None,
        }
    }
}

/// What the solve cost and achieved. `time_ms` is filled by the host's clock in `dispatch`;
/// the engine has none of its own.
#[derive(Debug, Clone, PartialEq)]
pub struct SolveInfo {
    pub solver: &'static str,
    pub iterations: usize,
    pub rel_residual: f64,
    pub time_ms: f64,
}

/// One linear solver. A factorisation is reused across right-hand sides, which is what modal
/// and transient procedures need later.
pub trait LinearSolve {
    /// Solve `K x = b`; an iterative implementation may return an approximation within its
    /// tolerance, and says so in [`SolveInfo::rel_residual`].
    fn solve(&mut self, b: &[f64], x: &mut [f64]) -> Result<SolveInfo, Error>;
}

/// The largest system `Auto` hands to the direct solver. faer's supernodal factor for a 3D hex
/// pattern this size is a gigabyte or two, which a browser tab does not have — so wasm takes
/// half (plan A §5, Q2). A calibration Query replaces both constants later.
#[cfg(not(target_arch = "wasm32"))]
pub const DIRECT_MAX_DOFS: usize = 200_000;
#[cfg(target_arch = "wasm32")]
pub const DIRECT_MAX_DOFS: usize = 100_000;

/// What `Auto` means for a system of `n` equations with or without a device: the direct
/// factorisation while it fits in memory, then the GPU conjugate gradient if there is a GPU and
/// the CPU one if there is not.
pub fn resolve_solver(solver: Solver, n: usize, gpu: bool) -> Solver {
    match solver {
        Solver::Auto if n <= DIRECT_MAX_DOFS => Solver::CpuDirect,
        Solver::Auto if gpu => Solver::GpuPcg,
        Solver::Auto => Solver::CpuPcg,
        chosen => chosen,
    }
}

/// The wire name of a solver, from the one place it is defined: serde's `kebab-case` rename.
pub fn solver_name(solver: Solver) -> String {
    serde_json::to_string(&solver).unwrap_or_default().trim_matches('"').to_string()
}

/// Solve `k x = b` with the requested solver.
///
/// The factorisation runs inside `pool`, which is the engine's own, so the thread count a host
/// asked for is the one faer sees. `gpu` is the host's device; only the GPU conjugate gradient
/// looks at it, and it is the one that reports `unsupported` when there is none.
pub async fn solve(
    k: &Csr,
    b: &[f64],
    opts: &SolveOptions,
    pool: &Pool,
    gpu: Option<&crate::gpu::Gpu>,
    progress: OnProgress<'_>,
) -> Result<(Vec<f64>, SolveInfo), Error> {
    solve_reusable(k, b, opts, pool, gpu, progress).await.map(|(x, info, _)| (x, info))
}

/// [`solve`], plus the factorisation when the direct path produced one.
///
/// A procedure that needs many more right-hand sides against the same operator — linear
/// buckling's subspace iteration — takes it from here rather than factorising a second time.
/// The iterative paths answer `None`: they never build one.
pub async fn solve_reusable(
    k: &Csr,
    b: &[f64],
    opts: &SolveOptions,
    pool: &Pool,
    gpu: Option<&crate::gpu::Gpu>,
    progress: OnProgress<'_>,
) -> Result<(Vec<f64>, SolveInfo, Option<direct::Direct>), Error> {
    let chosen = resolve_solver(opts.solver, k.n, gpu.is_some());
    if !progress(Progress {
        phase: "solve",
        fraction: 0.5,
        message: format!("{} on {} equations", solver_name(chosen), k.n),
    }) {
        return Err(Error::cancelled());
    }
    match chosen {
        Solver::CpuDirect => pool.install(|| {
            let mut factored = direct::Direct::factor(k)?;
            let mut x = vec![0.0; k.n];
            factored.solve_with_tolerance(b, &mut x, opts.rel_tol).map(|info| (x, info, Some(factored)))
        }),
        // The iterative paths run on rayon's global pool rather than the engine's: `progress` is
        // a `&mut dyn FnMut` and cannot cross into `Pool::install`, which needs `Send`. Every
        // reduction they use is bit-identical at any thread count anyway (`par.rs`), so the
        // answer does not depend on which pool ran it.
        Solver::CpuPcg => {
            let mut inner = crate::gpu::cg::Inner::Cpu(pcg::CpuPcg::new(k, opts.inner_tol, opts.max_iterations));
            refine::refine(k, b, &mut inner, "cpu-pcg", opts.rel_tol, opts.max_outer, progress).await.map(no_factor)
        }
        // `Auto` is already resolved, so what is left is the GPU. Its whole body — including
        // the "no adapter" error — lives under `src/gpu/`, so nothing here needs a device.
        _ => crate::gpu::cg::solve_refined(gpu, k, b, opts, progress).await.map(no_factor),
    }
}

/// An iterative answer, with the `None` that says it built no factorisation.
///
/// A named function rather than a closure per arm: a host without a GPU never runs the GPU
/// arm's success path, and a closure there would be a function no test could enter.
fn no_factor((x, info): (Vec<f64>, SolveInfo)) -> (Vec<f64>, SolveInfo, Option<direct::Direct>) {
    (x, info, None)
}

/// Counting scratch is bounded independently of the requested matrix size. The adjacency
/// builder temporarily holds two offsets arrays; afterwards a node marker replaces one.
const COST_SCRATCH_BYTES: u64 = 16 << 20;
/// A planning budget, not a measurement of free host memory (also applies on native hosts).
const PLANNING_BUDGET: u64 = 1_610_612_736;

/// Count node couplings with adjacency and one reusable marker array, never matrix entries
/// or element slots. If the adjacency would exceed the scratch budget, bound the graph by
/// its largest observed element clique and the sum of element cliques (capped by dense).
/// Work is linear in connectivity times the bounded element node count, not node-count².
fn coupling_bounds(mesh: &Mesh) -> (u64, u64) {
    let nodes = mesh.n_nodes() as u64;
    let incidences: u64 = mesh.blocks.iter().map(|b| b.conn.len() as u64).sum();
    let scratch = incidences.saturating_mul(4).saturating_add((nodes + 1).saturating_mul(8));
    if scratch <= COST_SCRATCH_BYTES {
        let adj = mesh.node_to_elems();
        let mut marked = vec![0; mesh.n_nodes()];
        let mut count = 0;
        for node in 0..mesh.n_nodes() {
            let tag = node as u32 + 1;
            // Every node owns its diagonal whether or not an element touches it, exactly as
            // `assembly::pattern` seeds it; marking it first also keeps it counted once.
            marked[node] = tag;
            count += 1;
            for &elem in adj.of(node) {
                for &other in mesh.elem_nodes(elem) {
                    if marked[other as usize] != tag {
                        marked[other as usize] = tag;
                        count += 1;
                    }
                }
            }
        }
        (count, count)
    } else {
        let mut lower = 0;
        let mut upper: u64 = 0;
        for block in &mesh.blocks {
            let nn = block.kind.n_nodes() as u64;
            upper = upper.saturating_add((block.n_elems() as u64).saturating_mul(nn * nn));
            // One clique per block suffices for a lower bound. Repeated node IDs are legal
            // topology here, so count distinct nodes without allocating a scratch set.
            let first = &block.conn[..block.conn.len().min(nn as usize)];
            let unique = first.iter().enumerate().filter(|(i, n)| !first[..*i].contains(n)).count() as u64;
            lower = lower.max(unique * unique);
        }
        // Plus one diagonal per node, which the element cliques do not cover for a node no
        // element touches.
        (lower, upper.saturating_add(nodes).min(nodes.saturating_mul(nodes)))
    }
}

/// Estimate before assembly with at most 16 MiB of counting scratch, plus the returned note.
/// `nnz` is an upper bound, exact when equal to `nnz_lower`. `bytes` is a lower bound on
/// simultaneously live assembly storage: the pattern CSR, element slots and their offsets,
/// an assembled CSR and one RHS. It excludes the resident mesh/model, local element buffers,
/// reduction, solver vectors, direct-factor fill/workspace and procedure-specific history.
/// Therefore fitting this lower bound never establishes feasibility, on any host.
///
/// It reads the element pattern and nothing else, so it does **not** see the fill-in a
/// multipoint constraint adds: a `contact.add` couples nodes of two Bodies that share no
/// element, and `mpc::transform` builds those entries outside `pattern`. A tied model's `nnz`
/// and `bytes` are therefore under-reported by the size of the interface coupling.
pub fn cost_estimate(mesh: &Mesh, dofs_per_node: usize, solver: Solver) -> CostEstimate {
    let dofs = (mesh.n_nodes() as u64).saturating_mul(dofs_per_node as u64);
    let block_size = (dofs_per_node as u64).saturating_mul(dofs_per_node as u64);
    let (lower, upper) = coupling_bounds(mesh);
    let nnz_lower = lower.saturating_mul(block_size);
    let nnz = upper.saturating_mul(block_size);
    let mut slots: u64 = 0;
    for block in &mesh.blocks {
        let nd = (block.kind.n_nodes() as u64).saturating_mul(dofs_per_node as u64);
        slots = slots.saturating_add((block.n_elems() as u64).saturating_mul(nd.saturating_mul(nd)));
    }
    let assembly_bytes = nnz_lower
        .saturating_mul(24)
        .saturating_add(dofs.saturating_add(1).saturating_mul(8))
        .saturating_add(slots.saturating_mul(4))
        .saturating_add((mesh.n_elems() as u64).saturating_add(1).saturating_mul(4))
        .saturating_add(dofs.saturating_mul(8));
    let bytes = assembly_bytes;
    let feasible = if bytes > PLANNING_BUDGET { Some(false) } else { None };
    let status =
        if feasible.is_some() { "mandatory storage exceeds planning budget" } else { "feasibility not established" };
    // Device availability and constraints are not known here; Auto reports its CPU choice.
    let chosen = solver_name(resolve_solver(solver, usize::try_from(dofs).unwrap_or(usize::MAX), false));
    CostEstimate {
        dofs, nnz, nnz_lower, bytes, assembly_bytes, resident_result_bytes: 0, result_mesh_bytes: 0, retained_frames: 0,
        retained_bytes: 0, transient_work_bytes: 0, transport_staging_bytes: 0,
        wasm_transport_staging_bytes: 0, wasm_transport_staging_complete: true,
        budget_bytes: PLANNING_BUDGET, feasible,
        note: format!("{chosen} on {dofs} equations; matrix non-zeros {nnz_lower}..{nnz}; {status}. Memory is an assembly lower bound; excludes mesh/model, element buffers, reduction, solver vectors, direct-factor fill/workspace and time history."),
    }
}

fn memory_overflow(where_: &str, suggestion: &str) -> Error {
    Error::new(ErrorCode::SolveTooLarge, "the transient memory estimate overflows byte accounting")
        .at(where_)
        .suggest(suggestion)
}

fn mesh_memory_overflow() -> Error {
    memory_overflow("mesh", "mesh.generate with a coarser size")
}

fn history_memory_overflow() -> Error {
    memory_overflow("outputEvery", "step.add with a larger outputEvery")
}

/// Add the two phases unique to retained transient output. During integration the assembly,
/// working vectors and growing History coexist. During a frame read the History and one
/// normalized three-component f64 response coexist. These are separate phases, so the budgeted
/// peak is their maximum rather than their sum.
pub(crate) fn add_transient_cost(
    mut cost: CostEstimate,
    nodes: usize,
    stored_components: usize,
    steps: usize,
    output_every: usize,
    work_vectors: u64,
) -> Result<CostEstimate, Error> {
    let frames = crate::procedure::retained_frame_count(steps, output_every)?;
    let values = nodes.checked_mul(stored_components).ok_or_else(mesh_memory_overflow)?;
    let retained = crate::procedure::retained_payload_bytes(frames, values)?;
    let values = values as u64;
    let nodes = nodes as u64;
    let work = values
        .checked_mul(work_vectors)
        .and_then(|n| n.checked_mul(std::mem::size_of::<f64>() as u64))
        .ok_or_else(mesh_memory_overflow)?;
    let staging = nodes
        .checked_mul(3)
        .and_then(|n| n.checked_mul(std::mem::size_of::<f64>() as u64))
        .ok_or_else(mesh_memory_overflow)?;
    // The generic JSON route currently has a parsed source and its structured clone alive at
    // once. The planned typed-bulk route has its transferred Float64Array and final number[]
    // alive at once. Either route therefore has at least two three-component f64-equivalent
    // numeric payloads; JSON strings and engine-dependent array/object storage are not portable.
    let wasm_staging = staging.checked_mul(2).ok_or_else(mesh_memory_overflow)?;
    let solve_peak = cost
        .assembly_bytes
        .checked_add(work)
        .and_then(|n| n.checked_add(retained))
        .ok_or_else(history_memory_overflow)?;
    let transport_peak = retained.checked_add(wasm_staging).ok_or_else(history_memory_overflow)?;
    cost.retained_frames = frames as u64;
    cost.retained_bytes = retained;
    cost.transient_work_bytes = work;
    cost.transport_staging_bytes = staging;
    cost.wasm_transport_staging_bytes = wasm_staging;
    cost.wasm_transport_staging_complete = false;
    cost.bytes = solve_peak.max(transport_peak);
    cost.feasible = if cost.bytes > cost.budget_bytes { Some(false) } else { None };
    let status =
        if cost.feasible.is_some() { "counted peak exceeds planning budget" } else { "feasibility not established" };
    cost.note = format!(
        "{} Retains {frames} frames ({retained} bytes); conservative full-field transient f64 working allowance {work} bytes; native frame staging {staging} bytes; known WASM/Worker numeric staging {wasm_staging} bytes with JSON/JavaScript heap overhead unknown; counted peak estimate {} bytes; {status}.",
        cost.note, cost.bytes
    );
    Ok(cost)
}

/// Refuse the Command before History preallocation. The suggested stride is the smallest one
/// whose retained payload fits both counted phases when increasing outputEvery can help.
pub(crate) fn enforce_transient_budget(
    cost: &CostEstimate,
    step: &str,
    procedure: &str,
    steps: usize,
    output_every: usize,
) -> Result<(), Error> {
    if cost.feasible != Some(false) {
        return Ok(());
    }
    let frame_bytes = cost.retained_bytes / cost.retained_frames;
    let resident = cost.resident_result_bytes.saturating_add(cost.result_mesh_bytes);
    let solve_fixed = cost.assembly_bytes.saturating_add(cost.transient_work_bytes).saturating_add(resident);
    let max_solve = cost.budget_bytes.saturating_sub(solve_fixed) / frame_bytes;
    let max_transport =
        cost.budget_bytes.saturating_sub(cost.wasm_transport_staging_bytes.saturating_add(resident)) / frame_bytes;
    let max_frames = max_solve.min(max_transport);
    let suggestion = if max_frames >= 2 {
        let intervals = (max_frames - 1) as usize;
        let stride = steps.div_ceil(intervals).max(output_every.max(1).saturating_add(1));
        if u32::try_from(stride).is_ok() {
            format!("step.add for '{step}' with procedure '{procedure}' and outputEvery at least {stride}")
        } else {
            format!(
                "step.add for '{step}' with procedure '{procedure}' and a shorter tEnd or larger dt; the required outputEvery exceeds {}",
                u32::MAX
            )
        }
    } else {
        "mesh.generate with a coarser size, then query.cost before solve.run".into()
    };
    Err(Error::new(
        ErrorCode::SolveTooLarge,
        format!(
            "step '{step}' would retain {} frames ({} bytes) and reach a counted peak estimate of {} bytes, above the {} byte planning budget",
            cost.retained_frames, cost.retained_bytes, cost.bytes, cost.budget_bytes
        ),
    )
    .at(format!("step '{step}'.outputEvery"))
    .suggest(suggestion))
}

#[cfg(test)]
mod transient_cost_tests {
    use super::*;

    fn base(assembly_bytes: u64, budget_bytes: u64) -> CostEstimate {
        CostEstimate {
            dofs: 0,
            nnz: 0,
            nnz_lower: 0,
            bytes: assembly_bytes,
            assembly_bytes,
            resident_result_bytes: 0,
            result_mesh_bytes: 0,
            retained_frames: 0,
            retained_bytes: 0,
            transient_work_bytes: 0,
            transport_staging_bytes: 0,
            wasm_transport_staging_bytes: 0,
            wasm_transport_staging_complete: true,
            budget_bytes,
            feasible: None,
            note: "assembly".into(),
        }
    }

    #[test]
    fn transient_peak_uses_separate_solve_and_transport_phases() {
        let cost = add_transient_cost(base(10, 1000), 2, 3, 5, 2, 6).unwrap();
        assert_eq!((cost.retained_frames, cost.retained_bytes), (4, 224));
        assert_eq!((cost.transient_work_bytes, cost.transport_staging_bytes), (288, 48));
        assert_eq!(cost.wasm_transport_staging_bytes, 96);
        assert!(!cost.wasm_transport_staging_complete);
        assert_eq!(cost.bytes, 522, "solve phase is larger than retained + browser staging");
        assert_eq!(cost.feasible, None);
        enforce_transient_budget(&cost, "warm", "heat-transient", 5, 2).unwrap();

        let fixed = add_transient_cost(base(0, 1), 2, 3, 5, 2, 6).unwrap();
        assert_eq!(fixed.feasible, Some(false));
        let error = enforce_transient_budget(&fixed, "warm", "heat-transient", 5, 2).unwrap_err();
        assert!(error.suggestion.as_deref().unwrap().starts_with("mesh.generate"));

        let mut limited = base(0, 2);
        limited.feasible = Some(false);
        limited.retained_frames = 3;
        limited.retained_bytes = 3;
        let error = enforce_transient_budget(&limited, "warm", "heat-transient", 5, 1).unwrap_err();
        assert!(error.suggestion.as_deref().unwrap().contains("outputEvery at least 5"));
        let error = enforce_transient_budget(&limited, "warm", "heat-transient", usize::MAX, 1).unwrap_err();
        assert!(error.suggestion.as_deref().unwrap().contains("shorter tEnd or larger dt"));
    }

    #[test]
    fn retained_records_reduce_the_available_stride_budget() {
        let mut cost = base(100, 1000);
        cost.retained_frames = 101;
        cost.retained_bytes = 808;
        cost.transient_work_bytes = 100;
        cost.wasm_transport_staging_bytes = 100;
        cost.resident_result_bytes = 400;
        cost.result_mesh_bytes = 100;
        cost.feasible = Some(false);
        // 700 fixed solve bytes leave room for 37 eight-byte frames. Over 100
        // intervals, stride 2 needs 51 frames; stride 3 needs 35 and is the first fit.
        let error = enforce_transient_budget(&cost, "warm", "heat-transient", 100, 1).unwrap_err();
        assert!(error.suggestion.as_deref().unwrap().contains("outputEvery at least 3"));
        cost.resident_result_bytes = 800;
        let error = enforce_transient_budget(&cost, "warm", "heat-transient", 100, 1).unwrap_err();
        assert!(error.suggestion.as_deref().unwrap().contains("coarser size"));
    }

    #[test]
    fn every_transient_byte_calculation_is_checked() {
        let cases = [
            (1, 1, usize::MAX, 1, 0, 0),
            (usize::MAX, 2, 1, 1, 0, 0),
            (usize::MAX, 1, 1, 1, 0, 0),
            (usize::MAX / 32, 1, 1, 1, 64, 0),
            (usize::MAX / 20, 1, 1, 1, 0, 0),
            (usize::MAX / 40, 1, 1, 1, 0, 0),
            (usize::MAX / 56, 1, 1, 1, 0, 0),
            (1, 1, 1, 1, 0, u64::MAX),
        ];
        for (nodes, components, steps, every, work, assembly) in cases {
            let error = add_transient_cost(base(assembly, u64::MAX), nodes, components, steps, every, work)
                .expect_err("overflow must be a structured error");
            assert_eq!(error.code, ErrorCode::SolveTooLarge);
            assert!(error.suggestion.is_some());
        }
    }
}
