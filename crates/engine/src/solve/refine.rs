//! f64 iterative refinement around an approximate inner solver (ADR 0002, plan A §5.3).
//!
//! `x = 0; loop { r = b − K x in f64; if ‖r‖/‖b‖ < rel_tol, done; d = inner.solve(r); x += d }`.
//! The residual, the norms and the correction are f64 whatever the inner solver works in, so a
//! single-precision inner solve — the GPU's — still lands on a double-precision answer as long
//! as it reduces the residual by some fixed factor each time (Göddeke–Strzodka–Turek 2007).
//!
//! When it does not, saying so is the whole point: three outer iterations that fail to halve
//! the residual is a stall, and the error names the Command that solves the problem instead of
//! grinding at it.

use crate::engine::{OnProgress, Progress};
use crate::error::{Error, ErrorCode};
use crate::fem::assembly::Csr;
use crate::par;
use crate::solve::{LinearSolve, SolveInfo};

/// Outer iterations without halving the residual that count as a stall.
const STAGNANT_LIMIT: usize = 3;

/// Drive `inner` until the f64 residual of `K x = b` is below `rel_tol`.
///
/// `name` is what the Result calls the solver; `iterations` in the returned [`SolveInfo`] is
/// the number of outer iterations and `rel_residual` the f64 residual actually achieved.
/// Cancellation is checked between outer iterations, which is where the loop is cheap to leave.
pub fn refine(
    k: &Csr,
    b: &[f64],
    inner: &mut dyn LinearSolve,
    name: &'static str,
    rel_tol: f64,
    max_outer: usize,
    progress: OnProgress<'_>,
) -> Result<(Vec<f64>, SolveInfo), Error> {
    let n = k.n;
    let norm_b = par::dot(b, b).sqrt().max(f64::MIN_POSITIVE);
    let mut x = vec![0.0; n];
    let mut kx = vec![0.0; n];
    let mut r = vec![0.0; n];
    let mut d = vec![0.0; n];
    let mut best = f64::INFINITY;
    let mut stagnant = 0;
    let mut outer = 0;
    loop {
        k.spmv(&x, &mut kx);
        for i in 0..n {
            r[i] = b[i] - kx[i];
        }
        let rel_residual = par::dot(&r, &r).sqrt() / norm_b;
        if rel_residual < rel_tol {
            return Ok((x, SolveInfo { solver: name, iterations: outer, rel_residual, time_ms: 0.0 }));
        }
        if outer == max_outer {
            return Err(stalled(rel_residual, outer, "the refinement budget ran out"));
        }
        if rel_residual <= 0.5 * best {
            best = rel_residual;
            stagnant = 0;
        } else {
            stagnant += 1;
            if stagnant >= STAGNANT_LIMIT {
                return Err(stalled(rel_residual, outer, "the residual stopped halving"));
            }
        }
        if !progress(Progress {
            phase: "solve",
            fraction: 0.5,
            message: format!("refinement {}: relative residual {rel_residual:e}", outer + 1),
        }) {
            return Err(Error::cancelled());
        }
        inner.solve(&r, &mut d)?;
        for i in 0..n {
            x[i] += d[i];
        }
        outer += 1;
    }
}

/// The one `solve.stalled`: what it reached, after how many outer iterations, and the way out.
fn stalled(rel_residual: f64, outer: usize, why: &str) -> Error {
    Error::new(
        ErrorCode::SolveStalled,
        format!("{why} after {outer} refinement steps at a relative residual of {rel_residual:e}"),
    )
    .at("solve")
    .suggest("solve.run { solver: 'cpu-direct' }")
}
