//! One-sided random-response spectra and modal covariance, integrated in Hz.
//!
//! All Loads define one spatial load pattern multiplied by one zero-mean stationary process.
//! Its PSD is in 1/Hz: the physical force units belong to the Loads. Thus all participating
//! modes are correlated. Integrating each mode separately and combining RMS values would
//! discard the cross terms, including the cancellation between modes.

use crate::error::Error;
use crate::fem::quadrature::gauss_legendre;

/// Piecewise-linear one-sided PSD of the dimensionless load multiplier: [Hz, 1/Hz].
/// There is no excitation outside the table's finite frequency band.
#[derive(Debug, Clone)]
pub struct Spectrum {
    pub table: Vec<[f64; 2]>,
}

impl Spectrum {
    pub fn check(&self) -> Result<(), Error> {
        if self.table.len() < 2
            || self.table.iter().any(|p| !p[0].is_finite() || p[0] < 0.0 || !p[1].is_finite() || p[1] < 0.0)
            || self.table.windows(2).any(|p| p[0][0] >= p[1][0])
        {
            return Err(Error::schema(
                "PSD needs at least two strictly increasing nonnegative frequencies and finite nonnegative densities",
            )
            .at("psd")
            .suggest("step.add with psd [[\"0 Hz\", \"1 s\"], [\"100 Hz\", \"1 s\"]]"));
        }
        Ok(())
    }
}

/// Complex modal transfer coefficients at one frequency, including load participation.
/// Inputs are validated by `covariance` before quadrature evaluates them.
pub fn transfer(frequency: f64, frequencies: &[f64], zeta: &[f64], participation: &[f64]) -> Vec<[f64; 2]> {
    let w = 2.0 * std::f64::consts::PI * frequency;
    frequencies
        .iter()
        .zip(zeta)
        .zip(participation)
        .map(|((&f, &z), &p)| {
            let wn = 2.0 * std::f64::consts::PI * f;
            let a = wn * wn - w * w;
            let b = 2.0 * z * wn * w;
            let scale = libm::hypot(a, b);
            [p * (a / scale) / scale, -p * (b / scale) / scale]
        })
        .collect()
}

/// Integrate Re(H_i conj(H_j)) S(f) df over the supplied band, retaining cross-modal terms.
///
/// Every table knot and natural frequency is an integration boundary. Boundaries at geometric
/// multiples of each modal half-width resolve arbitrarily narrow resonances without a uniform
/// grid spanning the whole band at that resolution. Sixteen three-point Gauss panels per
/// interval then resolve both the pole and its tails. The summation order is fixed.
pub fn covariance(
    spectrum: &Spectrum,
    frequencies: &[f64],
    zeta: &[f64],
    participation: &[f64],
) -> Result<Vec<f64>, Error> {
    spectrum.check()?;
    if frequencies.is_empty()
        || frequencies.len() != zeta.len()
        || frequencies.len() != participation.len()
        || frequencies.iter().any(|f| !f.is_finite() || *f <= 0.0)
        || zeta.iter().any(|z| !z.is_finite() || *z <= 0.0)
        || participation.iter().any(|p| !p.is_finite())
    {
        return Err(Error::schema("random vibration needs positive natural frequencies and damping for every mode, and finite load participation")
            .at("dampingRatio").suggest("solve.run a constrained modal Step and use step.add with dampingRatio 0.02"));
    }
    let n = frequencies.len();
    let mut covariance = vec![0.0; n * n];
    for pair in spectrum.table.windows(2) {
        let (lo, hi) = (pair[0][0], pair[1][0]);
        let mut grid = vec![lo, hi];
        for (&f, &z) in frequencies.iter().zip(zeta) {
            if lo < f && f < hi {
                grid.push(f);
            }
            let mut width = (z * f).max(f64::EPSILON * f);
            let reach = (hi - f).abs().max((lo - f).abs());
            while width < 2.0 * reach {
                for point in [f - width, f + width] {
                    if lo < point && point < hi {
                        grid.push(point);
                    }
                }
                width *= 2.0;
            }
        }
        grid.sort_by(f64::total_cmp);
        grid.dedup();
        for bounds in grid.windows(2) {
            let h = (bounds[1] - bounds[0]) / 16.0;
            for panel in 0..16 {
                let mid = bounds[0] + (panel as f64 + 0.5) * h;
                for &(x, weight) in gauss_legendre(3) {
                    let f = mid + 0.5 * h * x;
                    let s = pair[0][1] + (pair[1][1] - pair[0][1]) * ((f - lo) / (hi - lo));
                    let weight = weight * h * 0.5 * s;
                    let t = transfer(f, frequencies, zeta, participation);
                    for i in 0..n {
                        for j in 0..=i {
                            covariance[i * n + j] += weight * (t[i][0] * t[j][0] + t[i][1] * t[j][1]);
                        }
                    }
                }
            }
        }
    }
    for i in 0..n {
        for j in 0..i {
            covariance[j * n + i] = covariance[i * n + j];
        }
    }
    if covariance.iter().any(|v| !v.is_finite()) {
        return Err(Error::schema("random-response covariance exceeded finite arithmetic")
            .at("psd")
            .suggest("step.add with smaller PSD densities or larger damping"));
    }
    Ok(covariance)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn white_noise_sdof_variance_matches_the_stationary_energy_balance() {
        // m=1: stationary energy balance gives E[u²] = S/(8 ζ ω_n³).
        // The finite upper limit omits less than 1e-10 of this infinite-band answer.
        for z in [0.2, 0.02, 0.00001] {
            let f = 7.0;
            let s = Spectrum { table: vec![[0.0, 3.0], [f * 10000.0, 3.0]] };
            let got = covariance(&s, &[f], &[z], &[2.0]).unwrap()[0];
            let exact = 3.0 * 4.0 / (8.0 * z * (2.0 * std::f64::consts::PI * f).powi(3));
            assert!((got / exact - 1.0).abs() < 1e-8, "zeta {z}: {got} vs {exact}");
        }
    }

    #[test]
    fn correlated_equal_modes_cancel_and_table_partition_does_not_change_variance() {
        let s = Spectrum { table: vec![[0.0, 0.0], [20.0, 4.0]] };
        let split = Spectrum { table: vec![[0.0, 0.0], [10.0, 2.0], [20.0, 4.0]] };
        let c = covariance(&s, &[7.0, 7.0], &[0.02, 0.02], &[1.0, -1.0]).unwrap();
        assert_eq!(c[0] + c[1] + c[2] + c[3], 0.0);
        assert!(c[0] > 0.0);
        let d = covariance(&split, &[7.0], &[0.02], &[1.0]).unwrap();
        assert!((c[0] / d[0] - 1.0).abs() < 1e-8);
        let zero = Spectrum { table: vec![[0.0, 0.0], [20.0, 0.0]] };
        assert_eq!(covariance(&zero, &[7.0], &[0.02], &[1.0]).unwrap(), vec![0.0]);
    }

    #[test]
    fn invalid_spectra_and_modes_are_structured_errors() {
        for table in [
            vec![],
            vec![[0.0, 1.0]],
            vec![[1.0, 1.0], [0.0, 1.0]],
            vec![[0.0, -1.0], [1.0, 1.0]],
            vec![[0.0, 1.0], [f64::INFINITY, 1.0]],
        ] {
            let e = Spectrum { table }.check().unwrap_err();
            assert_eq!(e.where_.as_deref(), Some("psd"));
            assert!(e.suggestion.is_some());
        }
        let s = Spectrum { table: vec![[0.0, 1.0], [20.0, 1.0]] };
        for (f, z, p) in [
            (vec![], vec![], vec![]),
            (vec![1.0], vec![], vec![1.0]),
            (vec![0.0], vec![0.02], vec![1.0]),
            (vec![1.0], vec![0.0], vec![1.0]),
            (vec![1.0], vec![0.02], vec![f64::INFINITY]),
        ] {
            assert_eq!(covariance(&s, &f, &z, &p).unwrap_err().where_.as_deref(), Some("dampingRatio"));
        }
    }
}
