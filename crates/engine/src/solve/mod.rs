//! Linear solvers behind one trait, and the cost estimate a host asks for before solving.
//!
//! `LinearSolve` is the Extension Point: give it a right-hand side, get a solution and what it
//! took. The sparse direct factorisation ([`direct`]) is the only implementation so far; the
//! CPU conjugate gradient and the GPU one land with `solve/pcg.rs` and `gpu/cg.rs` (plan A
//! §5.2–§5.4) and answer `unsupported` until then.

pub mod direct;

use femlab_geometry::Mesh;

use crate::command::Solver;
use crate::engine::{OnProgress, Progress};
use crate::error::Error;
use crate::fem::assembly::{pattern, Csr};
use crate::par::Pool;
use crate::query::CostEstimate;

/// What a Command asked of the solver. `rel_tol` and `max_iterations` are the iterative
/// solvers' budget; the direct path is exact and reports the residual it achieved.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SolveOptions {
    pub solver: Solver,
    pub rel_tol: f64,
    pub max_iterations: usize,
}

impl Default for SolveOptions {
    fn default() -> SolveOptions {
        SolveOptions { solver: Solver::Auto, rel_tol: 1e-10, max_iterations: 5000 }
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

/// The solver `Auto` means here. Direct is the only one implemented; the threshold that sends
/// large systems to the GPU arrives with `gpu/cg.rs` (plan A §5).
pub fn resolve_solver(solver: Solver) -> Solver {
    match solver {
        Solver::Auto => Solver::CpuDirect,
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
/// asked for is the one faer sees. `_gpu` is the host's device, which the GPU conjugate
/// gradient will take (plan A §5.4); the direct path never touches it.
pub async fn solve(
    k: &Csr,
    b: &[f64],
    opts: &SolveOptions,
    pool: &Pool,
    _gpu: Option<&crate::gpu::Gpu>,
    progress: OnProgress<'_>,
) -> Result<(Vec<f64>, SolveInfo), Error> {
    let chosen = resolve_solver(opts.solver);
    if chosen != Solver::CpuDirect {
        return Err(Error::unsupported(&format!("solver '{}'", solver_name(chosen)))
            .suggest("solve.run { solver: \"cpu-direct\" }"));
    }
    if !progress(Progress { phase: "solve", fraction: 0.5, message: format!("factorising {} equations", k.n) }) {
        return Err(Error::cancelled());
    }
    pool.install(|| {
        let mut factored = direct::Direct::factor(k)?;
        let mut x = vec![0.0; k.n];
        factored.solve(b, &mut x).map(|info| (x, info))
    })
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
    let chosen = solver_name(resolve_solver(solver));
    CostEstimate {
        dofs,
        nnz,
        bytes,
        feasible: feasible(bytes),
        note: format!("{chosen} on {dofs} equations with {nnz} matrix non-zeros"),
    }
}
