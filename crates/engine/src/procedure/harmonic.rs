//! Harmonic response over a frequency sweep, by mode superposition (ADR 0020).
//!
//! A harmonic Step does no solver work at all. It requires `after` to name a Step whose
//! `modal` Result is current — `solve.run` hash-checks that and hands the Result in — and
//! superposes the M-orthonormal shapes it already computed:
//!
//! ```text
//! u(ω) = Σ_k φ_k (φ_kᵀ f) / ((ω_k² − ω²) + 2 i ζ_k ω_k ω)
//! ```
//!
//! The only complex arithmetic is that scalar denominator, a two-float reciprocal per mode per
//! frequency, written inline below. No complex matrix, no new solver, no WGSL. The load `f` is
//! this Step's own Loads with the held DOFs zeroed; the stiffness and mass matrices are never
//! assembled, because the modal Step already reduced them to `ω_k` and `φ_k`.
//!
//! Accuracy is bounded by the modal basis: what `nModes` left out is missing from the answer.
//! The Benchmarks gate both ends — F12 is one degree of freedom, where the basis is complete
//! and superposition is exact, and F13 puts a cantilever's peak on an independent beam
//! frequency.

use crate::command::{Field, SweepSpacing};
use crate::engine::OnProgress;
use crate::error::{Error, ErrorCode};
use crate::fem::assembly::resolve;
use crate::fem::loads;
use crate::fem::problem::Problem;
use crate::par::Pool;
use crate::post::{extremes, Per};
use crate::procedure::modal::damping_ratios;
use crate::procedure::{blank, report, vector_field, StepResult, Sweep};
use crate::solve::SolveInfo;

/// The frequencies a sweep evaluates, in Hz, ascending, with both endpoints exact.
///
/// Linear spacing is `f0 + (f1 − f0) i/(n − 1)`; logarithmic is `f0 (f1/f0)^(i/(n−1))`, which
/// needs `f0 > 0`. Both write the endpoints in directly rather than trusting the last
/// multiplication to land on them, because a Benchmark that sweeps to 3 f_n wants 3 f_n.
pub(crate) fn sweep_grid(f_start: f64, f_stop: f64, points: usize, spacing: SweepSpacing) -> Result<Vec<f64>, Error> {
    if points < 2 {
        return Err(Error::schema(format!("a harmonic sweep needs at least 2 points, got {points}"))
            .at("points")
            .suggest("step.add with points 200"));
    }
    if !(f_start.is_finite() && f_stop.is_finite() && f_start >= 0.0 && f_stop > f_start) {
        return Err(Error::schema(format!(
            "a harmonic sweep needs finite frequencies with 0 <= fStart < fStop, got fStart = {f_start}, fStop = {f_stop}"
        ))
        .at("fStart")
        .suggest("step.add with fStart \"1 Hz\" and fStop \"200 Hz\""));
    }
    if spacing == SweepSpacing::Log && f_start <= 0.0 {
        return Err(Error::schema("a logarithmic sweep needs fStart above zero")
            .at("fStart")
            .suggest("step.add with fStart \"1 Hz\", or sweep \"linear\""));
    }
    let last = points - 1;
    let ratio = libm::log(f_stop / f_start);
    let mut grid: Vec<f64> = (0..points)
        .map(|i| {
            let s = i as f64 / last as f64;
            match spacing {
                SweepSpacing::Linear => f_start + s * (f_stop - f_start),
                SweepSpacing::Log => f_start * libm::exp(s * ratio),
            }
        })
        .collect();
    grid[0] = f_start;
    grid[last] = f_stop;
    Ok(grid)
}

/// Retained frequencies stride the grid exactly as retained time frames stride a transient:
/// the first point, every `output_every`-th one after it, and the last whatever happens. It
/// answers exactly [`retained_frame_count(points - 1, output_every)`] entries, which is what
/// the cost estimate charges for.
pub(crate) fn retained_indices(points: usize, output_every: usize) -> Vec<usize> {
    let every = output_every.max(1);
    // `sweep_grid` has already refused fewer than two points; saturating keeps a hypothetical
    // third caller on the one-entry answer rather than on an underflow.
    let last = points.saturating_sub(1);
    let mut out = vec![0];
    out.extend((1..=last).filter(|i| i.is_multiple_of(every) || *i == last));
    out
}

/// The modal Step this one continues has no Result, or the Step it names was not modal.
fn needs_modes(step_has_after: bool) -> Error {
    Error::new(
        ErrorCode::NotFound,
        "a harmonic Step superposes the shapes of a solved modal Step, and 'after' does not name one",
    )
    .at(if step_has_after { "after" } else { "step.procedure" })
    .suggest("step.add with procedure 'modal' and nModes, solve.run it, then step.add with after naming it")
}

/// A mode shape comes back as three components per node; the load vector is `dofs_per_node`
/// per node. This is the inverse of [`crate::procedure::vector_field`].
fn dof_vector(shape: &crate::post::FieldData, dpn: usize) -> Vec<f64> {
    let nodes = shape.data.len() / 3;
    let mut out = vec![0.0; nodes * dpn];
    for node in 0..nodes {
        for c in 0..dpn {
            out[node * dpn + c] = shape.data[node * 3 + c];
        }
    }
    out
}

/// Solve one harmonic Step against the modal Result it continues.
#[allow(clippy::too_many_arguments)]
pub fn run(
    p: &Problem<'_>,
    previous: Option<&StepResult>,
    f_start: f64,
    f_stop: f64,
    points: usize,
    spacing: SweepSpacing,
    damping_ratio: Option<f64>,
    rayleigh: (f64, f64),
    output_every: usize,
    pool: &Pool,
    mut progress: OnProgress<'_>,
) -> Result<StepResult, Error> {
    // The Step this continues assembled the stiffness and the mass on this Mesh and passed
    // every well-posedness check to produce its frequencies, and `solve.run` refuses a stale
    // predecessor. So the checks are not repeated here: what is new in this Step is its own
    // Loads and Constraints, and those two report their own failures below.
    let modal = previous.filter(|r| !r.frequencies.is_empty()).ok_or_else(|| needs_modes(previous.is_some()))?;
    let grid = sweep_grid(f_start, f_stop, points, spacing)?;
    let keep = retained_indices(points, output_every);
    report(&mut progress, "assemble", 0.1, "building the harmonic load vector")?;

    let dpn = p.dofs_per_node();
    let mut f = vec![0.0; p.n_dofs()];
    let applied = pool.install(|| loads::assemble_loads(p, &mut f))?;
    let rc = resolve(p)?;
    for &(dof, value) in &rc.fixed {
        if value != 0.0 {
            return Err(Error::unsupported(&format!(
                "a harmonic Step with a prescribed displacement of {value} m (base excitation)"
            ))
            .at("step.constraints")
            .suggest("constraint.fix on that Set, or apply the excitation as a load.force"));
        }
        // A held DOF carries a reaction, never an applied force: the modal shapes are zero
        // there, so leaving a load on one would silently do nothing.
        f[dof as usize] = 0.0;
    }

    let omega: Vec<f64> = modal.frequencies.iter().map(|hz| 2.0 * std::f64::consts::PI * hz).collect();
    let zeta = damping_ratios(&modal.frequencies, damping_ratio, rayleigh);
    // `φ_kᵀ f` once per mode, not once per mode per frequency.
    let shapes: Vec<Vec<f64>> = modal.modes.iter().map(|m| dof_vector(m, dpn)).collect();
    let participation: Vec<f64> =
        shapes.iter().map(|phi| phi.iter().zip(&f).map(|(a, b)| a * b).sum::<f64>()).collect();

    let mut sweep = Sweep {
        frequencies: Vec::with_capacity(keep.len()),
        amplitude: Vec::with_capacity(keep.len()),
        phase: Vec::with_capacity(keep.len()),
    };
    let mut peak = (0usize, f64::NEG_INFINITY);
    for (row, &i) in keep.iter().enumerate() {
        let w = 2.0 * std::f64::consts::PI * grid[i];
        let (mut re, mut im) = (vec![0.0; p.n_dofs()], vec![0.0; p.n_dofs()]);
        for (k, phi) in shapes.iter().enumerate() {
            // 1 / ((ω_k² − ω²) + i 2 ζ_k ω_k ω), by the conjugate. Undamped and exactly on a
            // natural frequency this is a divide by zero, and an infinite response is the
            // honest answer to driving an undamped resonance.
            let (a, b) = (omega[k] * omega[k] - w * w, 2.0 * zeta[k] * omega[k] * w);
            let d = a * a + b * b;
            let (cr, ci) = (participation[k] * a / d, -participation[k] * b / d);
            for (j, &v) in phi.iter().enumerate() {
                re[j] += v * cr;
                im[j] += v * ci;
            }
        }
        // `u(t) = A cos(ωt − φ)`, so the reported phase is the lag behind the load: positive
        // just above a resonance, π well above it.
        let amplitude: Vec<f64> = re.iter().zip(&im).map(|(x, y)| libm::hypot(*x, *y)).collect();
        let phase: Vec<f64> = re.iter().zip(&im).map(|(x, y)| libm::atan2(-*y, *x)).collect();
        let largest = amplitude.iter().fold(0.0f64, |acc, v| acc.max(*v));
        if largest > peak.1 {
            peak = (row, largest);
        }
        sweep.frequencies.push(grid[i]);
        sweep.amplitude.push(vector_field(&amplitude, dpn));
        sweep.phase.push(vector_field(&phase, dpn));
        report(&mut progress, "solve", 0.1 + 0.8 * (row + 1) as f64 / keep.len() as f64, "superposing modes")?;
    }

    let mut res =
        blank(SolveInfo { solver: "cpu-modal-superposition", iterations: keep.len(), rel_residual: 0.0, time_ms: 0.0 });
    // The displacement field is the amplitude where the structure responded hardest, so
    // contours, extremes, VTU export and `query.probe` need no harmonic-specific plumbing.
    res.fields.insert(Field::Displacement, sweep.amplitude[peak.0].clone());
    res.scalars.insert("peak_frequency".to_string(), sweep.frequencies[peak.0]);
    res.scalars.insert("peak_amplitude".to_string(), peak.1);
    res.scalars.insert("sweep_points".to_string(), points as f64);
    res.scalars.insert("retained_frequencies".to_string(), keep.len() as f64);
    res.scalars.insert("load_magnitude".to_string(), libm::sqrt(applied.force.iter().map(|v| v * v).sum::<f64>()));
    for (k, z) in zeta.iter().enumerate() {
        res.scalars.insert(format!("zeta_{}", k + 1), *z);
    }
    // A harmonic amplitude is not a force in equilibrium with anything at one instant: every
    // DOF has its own phase. Like a modal Step, this one reports no applied total and no
    // reaction, so the summary's force balance stays honest instead of inventing a residual.
    for axis in ["x", "y", "z"] {
        res.scalars.insert(format!("applied_total_{axis}"), 0.0);
    }
    res.scalars.insert("rel_residual".to_string(), 0.0);
    res.extremes = res
        .fields
        .iter()
        .filter(|(_, fd)| fd.per == Per::Node)
        .flat_map(|(name, fd)| extremes(fd, p.mesh).into_iter().map(|e| (*name, e)))
        .collect();
    res.frequencies = modal.frequencies.clone();
    res.sweep = Some(sweep);
    report(&mut progress, "post", 0.9, "collecting the frequency response")?;
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::{retained_indices, sweep_grid};
    use crate::command::SweepSpacing;
    use crate::ErrorCode;

    #[test]
    fn a_linear_grid_hits_both_endpoints_and_steps_evenly() {
        let g = sweep_grid(10.0, 30.0, 5, SweepSpacing::Linear).expect("a valid linear sweep");
        assert_eq!(g, vec![10.0, 15.0, 20.0, 25.0, 30.0]);
        // Two points is the minimum, and it is exactly the endpoints.
        assert_eq!(sweep_grid(1.0, 2.0, 2, SweepSpacing::Linear).expect("two points"), vec![1.0, 2.0]);
    }

    #[test]
    fn a_log_grid_has_a_constant_ratio_and_exact_endpoints() {
        let g = sweep_grid(1.0, 1000.0, 4, SweepSpacing::Log).expect("a valid log sweep");
        assert_eq!((g[0], g[3]), (1.0, 1000.0));
        for i in 0..3 {
            assert!(libm::fabs(g[i + 1] / g[i] - 10.0) < 1e-12, "{g:?}");
        }
    }

    #[test]
    fn an_unusable_sweep_is_a_schema_error_naming_its_field() {
        for (start, stop, points, spacing, field) in [
            (1.0, 2.0, 1, SweepSpacing::Linear, "points"),
            (2.0, 1.0, 5, SweepSpacing::Linear, "fStart"),
            (1.0, f64::INFINITY, 5, SweepSpacing::Linear, "fStart"),
            (-1.0, 2.0, 5, SweepSpacing::Linear, "fStart"),
            (0.0, 2.0, 5, SweepSpacing::Log, "fStart"),
        ] {
            let e = sweep_grid(start, stop, points, spacing).expect_err("an unusable sweep");
            assert_eq!(e.code, ErrorCode::Schema);
            assert_eq!(e.where_.as_deref(), Some(field));
            assert!(e.suggestion.is_some());
        }
    }

    #[test]
    fn retained_frequencies_stride_like_retained_time_frames() {
        for (points, every, want) in [
            (7usize, 2usize, vec![0, 2, 4, 6]),
            (6, 2, vec![0, 2, 4, 5]),
            (5, 0, vec![0, 1, 2, 3, 4]),
            (5, 100, vec![0, 4]),
            (1, 1, vec![0]),
        ] {
            let got = retained_indices(points, every);
            // The cost estimate charges for exactly this many frames, through the same helper
            // a transient uses, so the two can never drift apart.
            assert_eq!(
                got.len(),
                crate::procedure::retained_frame_count(points - 1, every).expect("a small grid"),
                "{points} points every {every}"
            );
            assert_eq!(got, want);
        }
    }
}
