//! Linear solvers behind one trait, and the cost estimate a host asks for before solving.
//!
//! `LinearSolve` is the Extension Point: give it a right-hand side, get a solution and what it
//! took. The sparse direct factorisation ([`direct`]) is exact; the f64 Jacobi-PCG ([`pcg`]) is
//! approximate and is driven by the f64 refinement loop in [`refine`], which is also what wraps
//! the GPU's f32 conjugate gradient (ADR 0002, plan A §5.2–§5.4).

pub mod direct;
pub mod pcg;
pub mod refine;

use femlab_geometry::Mesh;

use crate::command::Solver;
use crate::engine::{OnProgress, Progress};
use crate::error::Error;
use crate::fem::assembly::{pattern, Csr};
use crate::par::Pool;
use crate::query::CostEstimate;

/// What a Command asked of the solver. `rel_tol` is the accuracy the *answer* must have, which
/// the f64 refinement loop is measured against; `inner_tol` and `max_iterations` are the
/// approximate inner solver's own, much looser, budget. The direct path is exact and reports
/// the residual it achieved.
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
            factored.solve(b, &mut x).map(|info| (x, info))
        }),
        // The iterative paths run on rayon's global pool rather than the engine's: `progress` is
        // a `&mut dyn FnMut` and cannot cross into `Pool::install`, which needs `Send`. Every
        // reduction they use is bit-identical at any thread count anyway (`par.rs`), so the
        // answer does not depend on which pool ran it.
        Solver::CpuPcg => {
            let mut inner = pcg::CpuPcg::new(k, opts.inner_tol, opts.max_iterations);
            refine::refine(k, b, &mut inner, "cpu-pcg", opts.rel_tol, opts.max_outer, progress)
        }
        // `Auto` is already resolved, so what is left is the GPU conjugate gradient, which
        // lands with `gpu/cg.rs` (plan A §5.4).
        _ => Err(Error::unsupported(&format!("solver '{}'", solver_name(chosen)))
            .suggest("solve.run { solver: \"cpu-pcg\" }")),
    }
}

/// Bytes per stored non-zero: an `f64` value and a `u32` column index.
const BYTES_PER_NNZ: u64 = 12;
/// Solution, right-hand side, residual and one scratch vector.
const VECTORS: u64 = 4;
/// The wasm heap a browser tab can be relied on for (plan A §5, Q2).
#[cfg(target_arch = "wasm32")]
const WASM_BUDGET: u64 = 1_610_612_736;

#[cfg(target_arch = "wasm32")]
fn feasible(bytes: u64) -> bool {
    bytes < WASM_BUDGET
}

#[cfg(not(target_arch = "wasm32"))]
fn feasible(_bytes: u64) -> bool {
    true
}

/// What solving this Mesh would cost, from the sparsity alone and before any assembly: this is
/// `query.cost`, so it must be cheap and must never allocate the matrix values.
pub fn cost_estimate(mesh: &Mesh, dofs_per_node: usize, solver: Solver) -> CostEstimate {
    let pat = pattern(mesh, dofs_per_node);
    let (dofs, nnz) = (pat.csr.n as u64, pat.csr.nnz() as u64);
    let bytes = nnz * BYTES_PER_NNZ + dofs * 8 * VECTORS;
    // `query.cost` knows the pattern, not the device, so it reports what `Auto` would pick
    // without one; a host with a GPU sees `gpu-pcg` in the Result the solve itself returns.
    let chosen = solver_name(resolve_solver(solver, pat.csr.n, false));
    CostEstimate {
        dofs,
        nnz,
        bytes,
        feasible: feasible(bytes),
        note: format!("{chosen} on {dofs} equations with {nnz} matrix non-zeros"),
    }
}
