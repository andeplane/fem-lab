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
/// `h` and `q` are a mesh size and the quantity of interest at it, in any order; the three
/// smallest `h` are used, coarse to fine. The rate follows from the two differences and the
/// refinement ratio, and the extrapolated value is the finest result plus the remaining error
/// that rate implies. `NaN` when there are fewer than three meshes or the differences do not
/// point the same way — a sequence that is not yet converging has nothing to extrapolate from.
pub fn richardson(h: &[f64], q: &[f64]) -> (f64, f64) {
    let mut idx: Vec<usize> = (0..h.len().min(q.len())).collect();
    idx.sort_by(|&a, &b| h[b].total_cmp(&h[a]));
    if idx.len() < 3 {
        return (f64::NAN, f64::NAN);
    }
    let [i1, i2, i3] = [idx[idx.len() - 3], idx[idx.len() - 2], idx[idx.len() - 1]];
    let (d1, d2) = (q[i1] - q[i2], q[i2] - q[i3]);
    let ratio = h[i1] / h[i2];
    if d1 * d2 <= 0.0 || ratio <= 1.0 {
        return (f64::NAN, f64::NAN);
    }
    let rate = libm::log(d1 / d2) / libm::log(ratio);
    let extrapolated = q[i3] - d2 / (libm::pow(h[i2] / h[i3], rate) - 1.0);
    (extrapolated, rate)
}
