//! f64 iterative refinement around an approximate inner solver (ADR 0002, plan A §5.3).
//!
//! `x = 0; loop { r = b − K x in f64; if ‖r‖/‖b‖ < rel_tol, done; d = inner.solve(r); x += d }`.
//! The residual, the norms and the correction are f64 whatever the inner solver works in, so a
//! single-precision inner solve — the GPU's — still lands on a double-precision answer as long
//! as it reduces the residual by some fixed factor each time (Göddeke–Strzodka–Turek 2007).
//!
//! The loop stops when the residual stops falling — after `max_outer` steps or three that fail
//! to halve it — and then says which of the two things happened: it reached the arithmetic
//! floor and the answer stands, or it never got near the tolerance, which is `solve.stalled`
//! naming the Command that solves the problem instead of grinding at it.

use crate::engine::{OnProgress, Progress};
use crate::error::{Error, ErrorCode};
use crate::fem::assembly::Csr;
use crate::gpu::cg::Inner;
use crate::par;
use crate::solve::SolveInfo;

/// Outer iterations without halving the residual that count as a stall.
const STAGNANT_LIMIT: usize = 3;
/// How far past `rel_tol` a residual that has stopped falling still counts as converged.
///
/// `‖b − K x‖` is itself computed in f64, so it has a floor of roughly `ε · κ(K) · ‖b‖` that no
/// amount of refinement gets under — 5e-10 on the 66k-DOF hex8 cantilever, against a requested
/// 1e-10. A run that lands within this factor of what was asked has hit that floor and is as
/// accurate as the direct factorisation; one that stops further away has genuinely failed, and
/// the error names `cpu-direct`.
const FLOOR_GRACE: f64 = 100.0;

/// Drive `inner` until the f64 residual of `K x = b` is below `rel_tol`.
///
/// `name` is what the Result calls the solver; `iterations` in the returned [`SolveInfo`] is
/// the number of outer iterations and `rel_residual` the f64 residual actually achieved.
/// Cancellation is checked between outer iterations, which is where the loop is cheap to leave.
pub async fn refine(
    k: &Csr,
    b: &[f64],
    inner: &mut Inner<'_>,
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
            return finish(x, name, rel_residual, outer, rel_tol, "the refinement budget ran out");
        }
        if rel_residual <= 0.5 * best {
            best = rel_residual;
            stagnant = 0;
        } else {
            stagnant += 1;
            if stagnant >= STAGNANT_LIMIT {
                return finish(x, name, rel_residual, outer, rel_tol, "the residual stopped halving");
            }
        }
        if !progress(Progress {
            phase: "solve",
            fraction: 0.5,
            message: format!("refinement {}: relative residual {rel_residual:e}", outer + 1),
        }) {
            return Err(Error::cancelled());
        }
        inner.solve(&r, &mut d, &mut *progress).await?;
        for i in 0..n {
            x[i] += d[i];
        }
        outer += 1;
    }
}

/// The loop has stopped making progress: either it is at the arithmetic floor ([`FLOOR_GRACE`])
/// and the answer stands, or it never got near the tolerance and `solve.stalled` says so.
fn finish(
    x: Vec<f64>,
    name: &'static str,
    rel_residual: f64,
    outer: usize,
    rel_tol: f64,
    why: &str,
) -> Result<(Vec<f64>, SolveInfo), Error> {
    if rel_residual < FLOOR_GRACE * rel_tol {
        return Ok((x, SolveInfo { solver: name, iterations: outer, rel_residual, time_ms: 0.0 }));
    }
    Err(Error::new(
        ErrorCode::SolveStalled,
        format!("{why} after {outer} refinement steps at a relative residual of {rel_residual:e}"),
    )
    .at("solve")
    .suggest("solve.run { solver: 'cpu-direct' }"))
}
