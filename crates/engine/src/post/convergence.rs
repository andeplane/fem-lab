//! Convergence arithmetic: the rate a mesh study actually achieved, and the value it is
//! heading for (plan A §8).
//!
//! Library code, not test code: `study.converge` reports the same two numbers a Benchmark
//! asserts, so there is one implementation and the Command and the test cannot drift.

/// The observed convergence rate: the least-squares slope of `log err` against `log h`.
///
/// Needs at least two meshes; with fewer, or with a non-positive error, the rate is not
/// defined and comes back as `NaN`, which a caller reports as "not available" rather than as
/// a number nobody should trust.
pub fn observed_rate(h: &[f64], err: &[f64]) -> f64 {
    let pairs: Vec<(f64, f64)> = h
        .iter()
        .zip(err)
        .filter(|(a, b)| **a > 0.0 && **b > 0.0)
        .map(|(a, b)| (libm::log(*a), libm::log(*b)))
        .collect();
    let n = pairs.len() as f64;
    if pairs.len() < 2 {
        return f64::NAN;
    }
    let mean_x = pairs.iter().map(|p| p.0).sum::<f64>() / n;
    let mean_y = pairs.iter().map(|p| p.1).sum::<f64>() / n;
    let sxy: f64 = pairs.iter().map(|p| (p.0 - mean_x) * (p.1 - mean_y)).sum();
    let sxx: f64 = pairs.iter().map(|p| (p.0 - mean_x).powi(2)).sum();
    sxy / sxx
}

/// Richardson extrapolation from the three finest meshes: `(extrapolated value, rate)`.
///
/// Fits `q(h) = q* + C h^p` with `p > 0`. Mesh sizes may arrive in any order and need not
/// have equal refinement ratios. The three finest sizes must be distinct and positive;
/// all inputs must be finite and paired. Returns `(NaN, NaN)` when no unique convergent
/// power law or representable finite limit exists, including constant/oscillating data.
pub fn richardson(h: &[f64], q: &[f64]) -> (f64, f64) {
    if h.len() != q.len() || h.len() < 3 || !h.iter().chain(q).all(|x| x.is_finite()) {
        return (f64::NAN, f64::NAN);
    }
    let mut idx: Vec<usize> = (0..h.len()).collect();
    idx.sort_by(|&a, &b| h[b].total_cmp(&h[a]));
    let [i1, i2, i3] = [idx[idx.len() - 3], idx[idx.len() - 2], idx[idx.len() - 1]];
    if h[i3] <= 0.0 || h[i1] <= h[i2] || h[i2] <= h[i3] {
        return (f64::NAN, f64::NAN);
    }
    let (d1, d2) = (q[i1] - q[i2], q[i2] - q[i3]);
    if !d1.is_finite() || !d2.is_finite() || d1 == 0.0 || d2 == 0.0 || d1.is_sign_positive() != d2.is_sign_positive() {
        return (f64::NAN, f64::NAN);
    }
    let (a, b) = (log_ratio(h[i1], h[i2]), log_ratio(h[i2], h[i3]));
    let log_r = libm::log(d1.abs()) - libm::log(d2.abs());
    let log_r_zero = libm::log(a / b);
    // R(p) = (exp(a*p)-1)/(1-exp(-b*p)) is strictly increasing for p > 0,
    // and R(0+) = a/b. Smaller difference ratios imply a nonconvergent power law.
    if log_r <= log_r_zero {
        return (f64::NAN, f64::NAN);
    }
    // Solve in t = a*p. Since (1-exp(-t))/(1-exp(-b*t/a)) >= min(1,a/b),
    // log(R) >= t + min(0,log(a/b)); this gives a finite upper bracket directly.
    let (mut lo, mut hi) = (0.0, log_r - log_r_zero.min(0.0));
    for _ in 0..128 {
        let t = 0.5 * (lo + hi);
        let predicted = t + libm::log(-libm::expm1(-t)) - libm::log(-libm::expm1(-b / a * t));
        if predicted < log_r {
            lo = t;
        } else {
            hi = t;
        }
    }
    let rate = 0.5 * (lo + hi) / a;
    let extrapolated = q[i3] - d2 / libm::expm1(b * rate);
    if !extrapolated.is_finite() {
        return (f64::NAN, f64::NAN);
    }
    (extrapolated, rate)
}

/// Division retains precision for neighbouring sizes; logarithm subtraction also handles
/// finite sizes so far apart that their quotient would overflow.
fn log_ratio(coarse: f64, fine: f64) -> f64 {
    let ratio = coarse / fine;
    if ratio.is_finite() {
        libm::log(ratio)
    } else {
        libm::log(coarse) - libm::log(fine)
    }
}
