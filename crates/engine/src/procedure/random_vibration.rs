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
            .suggest("step.add with psd [{frequency: \"0 Hz\", density: \"1 s\"}, {frequency: \"100 Hz\", density: \"1 s\"}]"));
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
    mut progress: OnProgress<'_>,
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
    for (band, pair) in spectrum.table.windows(2).enumerate() {
        let (lo, hi) = (pair[0][0], pair[1][0]);
        let mut grid = vec![lo, hi];
        for (&f, &z) in frequencies.iter().zip(zeta) {
            if lo < f && f < hi {
                grid.push(f);
            }
            let mut width = (z * f).max(f64::EPSILON * f).max(f64::MIN_POSITIVE);
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
        for (part, bounds) in grid.windows(2).enumerate() {
            let fraction = (band as f64 + part as f64 / (grid.len() - 1) as f64) / (spectrum.table.len() - 1) as f64;
            report(&mut progress, "solve", 0.1 + 0.35 * fraction, "integrating modal covariance")?;
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

use super::{blank, report, rotation_field, vector_field, StepResult};
use crate::command::Field;
use crate::engine::OnProgress;
use crate::fem::problem::Problem;
use crate::par::Pool;
use crate::post::stress;
use crate::post::{extremes, FieldData, Per};
use std::collections::BTreeMap;

/// Linear response channels. A beam's four extreme fibres remain separate until variance
/// has been integrated; taking absolute modal bending moments would lose their correlation.
fn channels(p: &Problem<'_>, u: &[f64]) -> Result<BTreeMap<Field, Vec<FieldData>>, Error> {
    let mut fields = BTreeMap::new();
    fields.insert(Field::Displacement, vec![vector_field(u, p.dofs_per_node())]);
    let (gp, _) = stress::stress_gp(p, u)?;
    let unaveraged = stress::gp_to_nodes(p.mesh, &gp);
    let mut fibres = vec![unaveraged; 4];
    if p.has_beams() {
        fields.insert(Field::Rotation, vec![rotation_field(u)]);
        let (force, moment) = stress::section_fields(p, u)?;
        let mut node_offset = 0;
        for (block, blk) in p.mesh.blocks.iter().enumerate() {
            let count = blk.n_elems() * blk.kind.n_nodes();
            if blk.kind == femlab_geometry::ElementKind::Beam2 {
                let section = &p.sections[p.section_of_block[block].expect("stress recovery validated the section")];
                for (corner, &(y, z)) in [(-1.0, -1.0), (-1.0, 1.0), (1.0, -1.0), (1.0, 1.0)].iter().enumerate() {
                    for node in node_offset..node_offset + count {
                        fibres[corner].data[node * 6] = force.data[node * 3] / section.a
                            + y * moment.data[node * 3 + 2] * section.c_y / section.i_z
                            + z * moment.data[node * 3 + 1] * section.c_z / section.i_y;
                    }
                }
            }
            node_offset += count;
        }
        fields.insert(Field::SectionForce, vec![force]);
        fields.insert(Field::SectionMoment, vec![moment]);
    }
    fields.insert(Field::Stress, fibres.iter().map(|f| stress::average_at_nodes(p, f)).collect());
    fields.insert(Field::StressUnaveraged, fibres);
    Ok(fields)
}

/// Count the modal recovery channels, covariance, integration grid and retained RMS fields.
/// This is a conservative numeric-payload estimate; allocator and Model storage are additional.
pub(crate) fn cost(mesh: &femlab_geometry::Mesh, dpn: usize, modes: usize) -> crate::query::CostEstimate {
    let mut cost = crate::solve::cost_estimate(mesh, dpn, crate::command::Solver::Auto);
    let nodes = mesh.n_nodes() as u64;
    let element_nodes: u64 = mesh.blocks.iter().map(|b| b.conn.len() as u64).sum();
    let modes = modes as u64;
    // Four fibre channels (six components each), translations and rotations, and member
    // forces/moments. Charge beam-sized channels even for solids and allow three scratch copies.
    let channels = nodes.saturating_add(element_nodes).saturating_mul(30);
    let work = channels
        .saturating_mul(modes.saturating_add(4))
        .saturating_add(modes.saturating_mul(modes))
        .saturating_add(modes.saturating_mul(2200))
        .saturating_add(nodes.saturating_mul(dpn as u64).saturating_mul(2))
        .saturating_mul(8);
    cost.assembly_bytes = 0;
    cost.nnz = 0;
    cost.nnz_lower = 0;
    let beams = mesh.blocks.iter().any(|b| b.kind == femlab_geometry::ElementKind::Beam2);
    cost.retained_bytes = nodes
        .saturating_mul(if beams { 12 } else { 9 })
        .saturating_add(element_nodes.saturating_mul(if beams { 12 } else { 6 }))
        .saturating_mul(8);
    cost.transient_work_bytes = work;
    cost.bytes = work.saturating_add(cost.retained_bytes);
    cost.feasible = if cost.bytes > cost.budget_bytes { Some(false) } else { None };
    cost.note = format!("Post-modal covariance over {modes} modes; no matrix assembly or factorisation. Conservative numeric storage for modal stress channels, covariance, integration grid and RMS fields; excludes Model, allocator and transport overhead. Fitting this estimate does not establish feasibility.");
    cost
}

/// Post-modal stationary response; no stiffness assembly or factorisation.
#[allow(clippy::too_many_arguments)]
pub fn run(
    p: &Problem<'_>,
    previous: Option<&StepResult>,
    spectrum: &Spectrum,
    damping: &[f64],
    rayleigh: (f64, f64),
    pool: &Pool,
    mut progress: OnProgress<'_>,
) -> Result<StepResult, Error> {
    let modal = previous.filter(|r| !r.modal_dofs.is_empty() && r.modal_dofs.len() == r.frequencies.len()).ok_or_else(
        || {
            Error::schema("randomVibration needs a solved modal Result")
                .at("after")
                .suggest("solve.run the modal Step named by after")
        },
    )?;
    if modal.modal_dofs.iter().any(|u| u.len() != p.n_dofs()) {
        return Err(Error::schema("modal vectors do not match this mesh")
            .at("after")
            .suggest("solve.run the modal Step again"));
    }
    report(&mut progress, "assemble", 0.05, "projecting the random load pattern")?;
    let mut load = vec![0.0; p.n_dofs()];
    pool.install(|| crate::fem::loads::assemble_loads(p, &mut load))?;
    let rc = crate::fem::assembly::resolve(p)?;
    for &(dof, value) in &rc.fixed {
        if value != 0.0 {
            return Err(Error::schema("randomVibration requires homogeneous constraints")
                .at("constraints")
                .suggest("constraint.fix or constraint.pin on the modal supports"));
        }
        load[dof as usize] = 0.0;
    }
    let participation: Vec<f64> =
        modal.modal_dofs.iter().map(|u| u.iter().zip(&load).map(|(u, f)| u * f).sum()).collect();
    let zeta = super::modal::damping_ratios(&modal.frequencies, damping, rayleigh);
    let c = covariance(spectrum, &modal.frequencies, &zeta, &participation, &mut progress)?;
    report(&mut progress, "solve", 0.5, "integrated the correlated modal covariance")?;
    // A thermal preload contributes a mean stress, never random stress. Modal stress recovery
    // uses only the perturbation displacement on the same materials and sections.
    let mean = pool.install(|| channels(p, &vec![0.0; p.n_dofs()]))?;
    let basis = modal
        .modal_dofs
        .iter()
        .map(|u| {
            let mut response = pool.install(|| channels(p, u))?;
            for (field, variants) in &mut response {
                for (values, baseline) in variants.iter_mut().zip(&mean[field]) {
                    for (value, zero) in values.data.iter_mut().zip(&baseline.data) {
                        *value -= zero;
                    }
                }
            }
            Ok(response)
        })
        .collect::<Result<Vec<_>, Error>>()?;
    let n = basis.len();
    let mut result = blank(crate::solve::SolveInfo {
        solver: "cpu-modal-covariance",
        iterations: 0,
        rel_residual: 0.0,
        time_ms: 0.0,
    });
    for (&field, variants) in &basis[0] {
        let mut output = variants[0].clone();
        // Components are independent; each retains the same ordered modal sum on every
        // thread count. Propagate non-finite variance instead of hiding it through f64::max.
        let values = pool.install(|| {
            crate::par::map_collect(output.data.len(), |component| {
                let mut maximum = 0.0f64;
                for (corner, _) in variants.iter().enumerate() {
                    let mut variance = 0.0;
                    for i in 0..n {
                        for j in 0..n {
                            variance += basis[i][&field][corner].data[component]
                                * c[i * n + j]
                                * basis[j][&field][corner].data[component];
                        }
                    }
                    if !variance.is_finite() {
                        return Err(Error::schema("random-response field variance exceeded finite arithmetic")
                            .at("psd")
                            .suggest("step.add with smaller PSD densities or smaller load amplitudes"));
                    }
                    maximum = maximum.max(variance.max(0.0).sqrt());
                }
                Ok(maximum)
            })
        });
        output.data = values.into_iter().collect::<Result<Vec<_>, Error>>()?;
        result.fields.insert(field, output);
    }
    for axis in ["x", "y", "z"] {
        result.scalars.insert(format!("applied_total_{axis}"), 0.0);
    }
    result.scalars.insert("rel_residual".into(), 0.0);
    result.scalars.insert("sigma_level".into(), 1.0);
    result.scalars.insert("modal_count".into(), n as f64);
    result.scalars.insert("psd_frequency_min".into(), spectrum.table[0][0]);
    result.scalars.insert("psd_frequency_max".into(), spectrum.table[spectrum.table.len() - 1][0]);
    result.extremes = result
        .fields
        .iter()
        .filter(|(_, f)| f.per == Per::Node)
        .flat_map(|(name, f)| extremes(f, p.mesh).into_iter().map(|e| (*name, e)))
        .collect();
    report(&mut progress, "post", 0.9, "recovered one-sigma displacement and stress")?;
    Ok(result)
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
            let got = covariance(&s, &[f], &[z], &[2.0], &mut |_| true).unwrap()[0];
            let exact = 3.0 * 4.0 / (8.0 * z * (2.0 * std::f64::consts::PI * f).powi(3));
            assert!((got / exact - 1.0).abs() < 1e-8, "zeta {z}: {got} vs {exact}");
        }
    }

    #[test]
    fn correlated_equal_modes_cancel_and_table_partition_does_not_change_variance() {
        let s = Spectrum { table: vec![[0.0, 0.0], [20.0, 4.0]] };
        let split = Spectrum { table: vec![[0.0, 0.0], [10.0, 2.0], [20.0, 4.0]] };
        let c = covariance(&s, &[7.0, 7.0], &[0.02, 0.02], &[1.0, -1.0], &mut |_| true).unwrap();
        assert_eq!(c[0] + c[1] + c[2] + c[3], 0.0);
        assert!(c[0] > 0.0);
        let d = covariance(&split, &[7.0], &[0.02], &[1.0], &mut |_| true).unwrap();
        assert!((c[0] / d[0] - 1.0).abs() < 1e-8);
        let zero = Spectrum { table: vec![[0.0, 0.0], [20.0, 0.0]] };
        assert_eq!(covariance(&zero, &[7.0], &[0.02], &[1.0], &mut |_| true).unwrap(), vec![0.0]);
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
            assert_eq!(covariance(&s, &f, &z, &p, &mut |_| true).unwrap_err().where_.as_deref(), Some("dampingRatio"));
        }
    }
    #[test]
    fn overflowing_covariance_is_a_structured_error() {
        let spectrum = Spectrum { table: vec![[0.0, 1.0], [20.0, 1.0]] };
        let error = covariance(&spectrum, &[1.0], &[0.02], &[f64::MAX], &mut |_| true).unwrap_err();
        assert_eq!(error.where_.as_deref(), Some("psd"));
        assert!(error.cause.contains("covariance exceeded"));
    }
}
