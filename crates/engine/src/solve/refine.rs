//! f64 correction around an approximate inner solver (ADR0002 and ADR0045).
//!
//! CPU solves use stationary `refine`; GPU solves use bounded flexible `refine_fgmres`.
//! The stationary loop below requires contraction; FGMRES minimizes over retained directions.
//!
//! `x = 0; loop { r = b − K x in f64; if ‖r‖/‖b‖ < rel_tol, done; d = inner.solve(r); x += d }`.
//! In the stationary CPU loop, the residual, norms and correction are f64, so a
//! lower-precision inner solve can reach a double-precision answer if it contracts the
//! residual by a fixed factor each time (Göddeke–Strzodka–Turek 2007). The GPU path
//! instead uses flexible GMRES below, since its approximate inner inverse need not contract.
//!
//! The stationary CPU loop stops after `max_outer` steps or three that fail to halve
//! the residual — and then says which of the two things happened: it reached the arithmetic
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
pub(super) const FLOOR_GRACE: f64 = 100.0;

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

/// Fixed correction history; extra outer iterations reuse its arrays after a restart.
const CORRECTION_HISTORY: usize = 8;
const MAX_CORRECTION_BYTES: usize = 256 << 20;

/// Admit all requested f64 arrays and metadata before the GPU setup/upload starts.
pub(crate) fn correction_bytes(n: usize, max_outer: usize, available: usize) -> Result<usize, Error> {
    let width = max_outer.min(CORRECTION_HISTORY);
    let bytes = (n as u128) * (4 + 2 * width as u128) * 8 + 4096;
    if bytes > available.min(MAX_CORRECTION_BYTES) as u128 {
        return Err(Error::new(
            ErrorCode::SolveTooLarge,
            "the f64 correction workspace exceeds its admitted storage bound",
        )
        .at("solve/refinement")
        .suggest("mesh.generate with a coarser size, or solve.run { solver: 'cpu-direct' }"));
    }
    Ok(bytes as usize)
}

/// Match `par::dot`'s fixed reduction order without its length-dependent Vec.
/// The 512 stack bytes, eight (Vec, Vec, f64) headers and history Vec header
/// and the bounded Hessenberg/Givens metadata fit within the 4096-byte allowance.
fn correction_dot(a: &[f64], b: &[f64]) -> f64 {
    let mut partials = [0.0; 64];
    let chunks = a.len().div_ceil(par::DOT_CHUNK);
    let mut total = 0.0;
    for base in (0..chunks).step_by(partials.len()) {
        let count = (chunks - base).min(partials.len());
        par::for_each_chunk_mut(&mut partials[..count], 1, |offset, out| {
            let lo = (base + offset) * par::DOT_CHUNK;
            let hi = (lo + par::DOT_CHUNK).min(a.len());
            let mut sum = 0.0;
            for i in lo..hi {
                sum += a[i] * b[i];
            }
            out[0] = sum;
        });
        for partial in &partials[..count] {
            total += partial;
        }
    }
    total
}

/// Right flexible GMRES around the approximate GPU solve. The inner solver acts on
/// successive orthogonal Arnoldi inputs rather than a nearly stationary residual.
/// Raw basis vectors avoid a normalization/unscaling roundtrip for an exact inner
/// correction; row-weighted Hessenberg least squares accounts for their norms.
pub async fn refine_fgmres(
    k: &Csr,
    b: &[f64],
    inner: &mut Inner<'_>,
    name: &'static str,
    rel_tol: f64,
    max_outer: usize,
    progress: OnProgress<'_>,
) -> Result<(Vec<f64>, SolveInfo), Error> {
    correction_bytes(k.n, max_outer, MAX_CORRECTION_BYTES)?;
    let n = k.n;
    let width = max_outer.min(CORRECTION_HISTORY);
    let norm_b = correction_dot(b, b).sqrt().max(f64::MIN_POSITIVE);
    // Keep the cycle base separate from the latest physical candidate, including at breakdown.
    let mut base = vec![0.0; n];
    let mut x = vec![0.0; n];
    let mut q = vec![0.0; n];
    let mut z = vec![0.0; n];
    let mut pairs = Vec::with_capacity(width);
    for _ in 0..width {
        // Arnoldi vector, its preconditioned direction, and squared Arnoldi norm.
        pairs.push((vec![0.0; n], vec![0.0; n], 0.0));
    }
    let mut h = [[0.0; CORRECTION_HISTORY + 1]; CORRECTION_HISTORY];
    let mut cosine = [0.0; CORRECTION_HISTORY];
    let mut sine = [0.0; CORRECTION_HISTORY];
    let mut rhs = [0.0; CORRECTION_HISTORY + 1];
    let mut coefficients = [0.0; CORRECTION_HISTORY];
    let mut used = 0;
    let mut outer = 0;
    let mut rel_residual = f64::INFINITY;
    loop {
        if used == 0 {
            k.spmv(&base, &mut q);
            for i in 0..n {
                q[i] = b[i] - q[i];
            }
            let squared = correction_dot(&q, &q);
            rel_residual = squared.sqrt() / norm_b;
            if rel_residual < rel_tol {
                return Ok((x, SolveInfo { solver: name, iterations: outer, rel_residual, time_ms: 0.0 }));
            }
            if !rel_residual.is_finite() || outer == max_outer {
                return finish(x, name, rel_residual, outer, rel_tol, "the bounded correction budget ended");
            }
            pairs[0].0.copy_from_slice(&q);
            pairs[0].2 = squared;
            h.fill([0.0; CORRECTION_HISTORY + 1]);
            rhs.fill(0.0);
            rhs[0] = squared.sqrt();
        }
        if !progress(Progress {
            phase: "solve",
            fraction: 0.5,
            message: format!("f64 FGMRES correction {}: relative residual {rel_residual:e}", outer + 1),
        }) {
            return Err(Error::cancelled());
        }
        inner.solve(&pairs[used].0, &mut z, &mut *progress).await?;
        k.spmv(&z, &mut q);
        let raw_squared = correction_dot(&q, &q);
        if raw_squared == 0.0 || !raw_squared.is_finite() {
            return finish(
                x,
                name,
                rel_residual,
                outer,
                rel_tol,
                "the correction directions lost finite independent rank",
            );
        }
        let first_alpha = if used == 0 { correction_dot(&pairs[0].0, &q) / raw_squared } else { 0.0 };
        for _ in 0..2 {
            for (i, (v, _, squared)) in pairs[..=used].iter().enumerate() {
                let projection = correction_dot(&q, v) / squared;
                h[used][i] += projection;
                for j in 0..n {
                    q[j] -= projection * v[j];
                }
            }
        }
        let next_squared = correction_dot(&q, &q);
        if !next_squared.is_finite() {
            return finish(
                x,
                name,
                rel_residual,
                outer,
                rel_tol,
                "the Arnoldi directions lost finite independent rank",
            );
        }
        pairs[used].1.copy_from_slice(&z);
        for (i, pair) in pairs[..=used].iter().enumerate() {
            h[used][i] *= pair.2.sqrt();
        }
        h[used][used + 1] = next_squared.sqrt();
        if next_squared > 0.0 && used + 1 < width {
            pairs[used + 1].0.copy_from_slice(&q);
            pairs[used + 1].2 = next_squared;
        }
        for i in 0..used {
            let (a, b) = (h[used][i], h[used][i + 1]);
            h[used][i] = cosine[i] * a + sine[i] * b;
            h[used][i + 1] = -sine[i] * a + cosine[i] * b;
        }
        let radius = libm::hypot(h[used][used], h[used][used + 1]);
        if radius == 0.0 || !radius.is_finite() {
            return finish(
                x,
                name,
                rel_residual,
                outer,
                rel_tol,
                "the projected correction lost finite independent rank",
            );
        }
        cosine[used] = h[used][used] / radius;
        sine[used] = h[used][used + 1] / radius;
        h[used][used] = radius;
        rhs[used + 1] = -sine[used] * rhs[used];
        rhs[used] *= cosine[used];
        for i in (0..=used).rev() {
            let mut value = rhs[i];
            for j in i + 1..=used {
                value -= h[j][i] * coefficients[j];
            }
            coefficients[i] = value / h[i][i];
        }
        // A one-column least-squares problem needs no norm/unscaling roundtrip.
        if used == 0 {
            coefficients[0] = first_alpha;
        }
        x.copy_from_slice(&base);
        for j in 0..=used {
            for (value, direction) in x.iter_mut().zip(&pairs[j].1) {
                *value += coefficients[j] * *direction;
            }
        }
        k.spmv(&x, &mut q);
        for i in 0..n {
            q[i] = b[i] - q[i];
        }
        rel_residual = correction_dot(&q, &q).sqrt() / norm_b;
        outer += 1;
        if rel_residual < rel_tol {
            return Ok((x, SolveInfo { solver: name, iterations: outer, rel_residual, time_ms: 0.0 }));
        }
        if !rel_residual.is_finite() || outer == max_outer {
            return finish(x, name, rel_residual, outer, rel_tol, "the bounded correction budget ended");
        }
        if next_squared == 0.0 {
            return finish(
                x,
                name,
                rel_residual,
                outer,
                rel_tol,
                "the Arnoldi correction exhausted its independent rank",
            );
        }
        used += 1;
        if used == width {
            base.copy_from_slice(&x);
            used = 0;
        }
    }
}

#[cfg(test)]
mod correction_admission_tests {
    use super::*;

    #[test]
    fn bounded_dot_preserves_fixed_order_across_stack_blocks_and_threads() {
        let n = 65 * par::DOT_CHUNK + 17;
        let a: Vec<f64> = (0..n).map(|i| (i % 7) as f64 - 3.0).collect();
        let b = vec![1.0; n];
        // Every complete seven-entry group sums to zero.
        let expected: f64 = (0..n % 7).map(|i| i as f64 - 3.0).sum();
        for threads in [1, 4] {
            let value = par::Pool::new(threads).install(|| correction_dot(&a, &b));
            assert_eq!(value, expected);
            assert_eq!(value.to_bits(), par::dot(&a, &b).to_bits());
        }
        assert_eq!(correction_dot(&[], &[]), 0.0);
    }

    #[test]
    fn correction_arrays_are_bounded_before_allocation_and_restarts_do_not_grow_storage() {
        let pair_header = std::mem::size_of::<(Vec<f64>, Vec<f64>, f64)>();
        let history_header = std::mem::size_of::<Vec<(Vec<f64>, Vec<f64>, f64)>>();
        let dot_stack = std::mem::size_of::<[f64; 64]>();
        let projected = std::mem::size_of::<[[f64; 9]; 8]>()
            + std::mem::size_of::<[f64; 9]>()
            + 3 * std::mem::size_of::<[f64; 8]>();
        assert!(8 * pair_header + history_header + dot_stack + projected <= 4096);
        #[cfg(target_pointer_width = "64")]
        assert_eq!((pair_header, history_header, dot_stack), (56, 24, 512));
        let exact = (4 + 2 * 8) * 11 * 8 + 4096;
        assert_eq!(correction_bytes(11, 8, exact).unwrap(), exact);
        assert_eq!(correction_bytes(11, usize::MAX, exact).unwrap(), exact);
        assert_eq!(correction_bytes(11, 8, exact - 1).unwrap_err().code, ErrorCode::SolveTooLarge);
        assert_eq!(correction_bytes(usize::MAX, 8, usize::MAX).unwrap_err().code, ErrorCode::SolveTooLarge);
        assert_eq!(correction_bytes(0, 0, 4096).unwrap(), 4096);
    }
}
