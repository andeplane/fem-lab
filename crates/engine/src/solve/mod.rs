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
use crate::error::Error;
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
            factored.solve_with_tolerance(b, &mut x, opts.rel_tol).map(|info| (x, info))
        }),
        // The iterative paths run on rayon's global pool rather than the engine's: `progress` is
        // a `&mut dyn FnMut` and cannot cross into `Pool::install`, which needs `Send`. Every
        // reduction they use is bit-identical at any thread count anyway (`par.rs`), so the
        // answer does not depend on which pool ran it.
        Solver::CpuPcg => {
            let mut inner = crate::gpu::cg::Inner::Cpu(pcg::CpuPcg::new(k, opts.inner_tol, opts.max_iterations));
            refine::refine(k, b, &mut inner, "cpu-pcg", opts.rel_tol, opts.max_outer, progress).await
        }
        // `Auto` is already resolved, so what is left is the GPU. Its whole body — including
        // the "no adapter" error — lives under `src/gpu/`, so nothing here needs a device.
        _ => crate::gpu::cg::solve_refined(gpu, k, b, opts, progress).await,
    }
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
        (lower, upper.min(nodes.saturating_mul(nodes)))
    }
}

/// Estimate before assembly with at most 16 MiB of counting scratch, plus the returned note.
/// `nnz` is an upper bound, exact when equal to `nnz_lower`. `bytes` is a lower bound on
/// simultaneously live assembly storage: the pattern CSR, element slots and their offsets,
/// an assembled CSR and one RHS. It excludes the resident mesh/model, local element buffers,
/// reduction, solver vectors, direct-factor fill/workspace and procedure-specific history.
/// Therefore fitting this lower bound never establishes feasibility, on any host.
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
    let bytes = nnz_lower
        .saturating_mul(24)
        .saturating_add(dofs.saturating_add(1).saturating_mul(8))
        .saturating_add(slots.saturating_mul(4))
        .saturating_add((mesh.n_elems() as u64).saturating_add(1).saturating_mul(4))
        .saturating_add(dofs.saturating_mul(8));
    let feasible = if bytes > PLANNING_BUDGET { Some(false) } else { None };
    let status =
        if feasible.is_some() { "mandatory storage exceeds planning budget" } else { "feasibility not established" };
    // Device availability and constraints are not known here; Auto reports its CPU choice.
    let chosen = solver_name(resolve_solver(solver, usize::try_from(dofs).unwrap_or(usize::MAX), false));
    CostEstimate {
        dofs, nnz, nnz_lower, bytes, budget_bytes: PLANNING_BUDGET, feasible,
        note: format!("{chosen} on {dofs} equations; matrix non-zeros {nnz_lower}..{nnz}; {status}. Memory is an assembly lower bound; excludes mesh/model, element buffers, reduction, solver vectors, direct-factor fill/workspace and time history."),
    }
}
