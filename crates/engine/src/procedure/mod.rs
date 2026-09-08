//! Procedures: what a Step *does*. One `run` for every one of them (plan A §6).
//!
//! `Step::Static` is the linear static procedure ([`static_`]); [`nonlinear`] is its
//! finite-deformation counterpart; [`modal`] finds natural frequencies by subspace iteration,
//! [`buckling`] the load factors that make the static stress state cancel the stiffness,
//! [`harmonic`] superposes those modes into a frequency response,
//! [`heat`] solves steady and transient conduction, [`explicit`] integrates the equations of
//! motion by central differences and [`implicit`] by the HHT-α method. Each one takes the same
//! resolved [`Problem`] and answers the same [`StepResult`], so `solve.run` and every host read
//! one shape whatever the physics.

pub mod buckling;
pub mod explicit;
pub mod harmonic;
pub mod heat;
pub mod implicit;
pub mod modal;
pub mod nonlinear;
pub mod random_vibration;
pub mod static_;

use std::collections::BTreeMap;

use crate::command::Field;
use crate::engine::{OnProgress, Progress};
use crate::error::{Error, ErrorCode, Warning};
use crate::fem::problem::Problem;
use crate::post::{Extremum, FieldData};
use crate::query::ResultAssumption;
use crate::solve::{SolveInfo, SolveOptions};

/// A scalar `g(t)` multiplying the driven part of a Step: every prescribed temperature of a
/// transient heat Step, and every Load and prescribed displacement of a static Step.
///
/// Commands carry no closures (they are serialised into the Journal and replayed byte for
/// byte), so a time-varying boundary is one of these two shapes and nothing else.
#[derive(Debug, Clone, PartialEq)]
pub enum Amplitude {
    /// `amplitude · sin(2π t / period)`; NAFEMS T3's `100 sin(π t / 40)` is amplitude 1 on a
    /// prescribed 100 K with a period of 80 s.
    Sine { amplitude: f64, period: f64 },
    /// Piecewise-linear through `(t[i], value[i])`, held flat outside the table.
    Table { t: Vec<f64>, value: Vec<f64> },
}

impl Amplitude {
    /// `g(t)`. A table is held flat outside its own range, so its first and last values are
    /// what happens before and after it.
    pub fn at(&self, time: f64) -> f64 {
        match self {
            Amplitude::Sine { amplitude, period } => amplitude * libm::sin(2.0 * std::f64::consts::PI * time / period),
            // The table is non-empty and the two arrays are the same length: `step.add`
            // refuses anything else, so this indexes rather than branching on emptiness.
            Amplitude::Table { t, value } => match t.iter().position(|&x| x >= time) {
                None => value[value.len() - 1],
                Some(0) => value[0],
                Some(i) => {
                    let s = (time - t[i - 1]) / (t[i] - t[i - 1]);
                    value[i - 1] + s * (value[i] - value[i - 1])
                }
            },
        }
    }
}

/// Convergence control for a Step whose system depends on its own answer.
///
/// Radiation, a temperature-dependent conductivity and a geometrically nonlinear stiffness are
/// all the same shape: assemble at the current state, solve, repeat. One control governs them
/// all, so a Step that has several of them still has one tolerance and one iteration budget.
#[derive(Debug, Clone, PartialEq)]
pub struct NonlinearControl {
    /// Converged when the relative sup-norm change of the state falls to or below this.
    pub tol: f64,
    /// Give up after this many passes and report `solve.diverged`.
    pub max_iterations: usize,
}

impl Default for NonlinearControl {
    fn default() -> NonlinearControl {
        NonlinearControl { tol: 1e-6, max_iterations: 50 }
    }
}

/// Relative sup-norm change between two states, or `NaN` when the new state is not finite.
///
/// The scale floor is [`f64::MIN_POSITIVE`] rather than a branch on zero, so a state that is
/// identically zero reports no change instead of `0/0`.
fn relative_change(previous: &[f64], next: &[f64]) -> f64 {
    let mut change = 0.0f64;
    let mut scale = f64::MIN_POSITIVE;
    let mut finite = true;
    for (p, n) in previous.iter().zip(next) {
        finite &= n.is_finite();
        change = change.max(libm::fabs(n - p));
        scale = scale.max(libm::fabs(*n));
    }
    if finite {
        change / scale
    } else {
        f64::NAN
    }
}

/// The iteration ran out of budget, or left the finite numbers behind.
fn diverged(where_: &str, iterations: usize, change: f64) -> Error {
    Error::new(
        ErrorCode::SolveDiverged,
        format!("the nonlinear iteration did not converge: {iterations} passes reached a relative change of {change}"),
    )
    .at(where_)
    .suggest("step.add with a larger nonlinearMaxIterations, a smaller dt, or a milder nonlinearity")
}

/// One pass of a nonlinear iteration: read the current state, write the next one, and report
/// the linear solve it took to get there.
pub(crate) type Advance<'a> = &'a mut dyn FnMut(&[f64], &mut Vec<f64>) -> Result<SolveInfo, Error>;

/// Repeat `advance(current, next)` until the relative sup-norm change of the state is at or
/// below `control.tol`, and answer the last linear solve plus the number of passes it took.
///
/// `advance` re-assembles *everything* that depends on the state and solves once, so a Step
/// with both a radiating face and a temperature-dependent conductivity is one loop with two
/// contributions rather than two nested loops. A problem that is already linear converges on
/// the first pass and pays one extra assembly for the proof.
///
/// `where_` is what the divergence Error points at — the Step, so the user knows which one to
/// give a larger budget. A state that stops being finite ends the loop immediately rather than
/// burning the whole budget on numbers that cannot recover.
pub(crate) fn iterate(
    control: &NonlinearControl,
    state: &mut Vec<f64>,
    where_: &str,
    advance: Advance<'_>,
) -> Result<(SolveInfo, usize), Error> {
    let mut next = vec![0.0; state.len()];
    let mut change = f64::INFINITY;
    for pass in 1..=control.max_iterations {
        let info = advance(state, &mut next)?;
        change = relative_change(state, &next);
        std::mem::swap(state, &mut next);
        if change <= control.tol {
            return Ok((info, pass));
        }
        if !change.is_finite() {
            return Err(diverged(where_, pass, change));
        }
    }
    Err(diverged(where_, control.max_iterations, change))
}

/// One analysis step.
#[derive(Debug, Clone)]
pub enum Step {
    /// Linear static equilibrium: `K u = f`.
    ///
    /// With an `amplitude` the Step is stepped instead: the Loads and the prescribed
    /// displacements are scaled by `g(t)` over the grid `dt`/`t_end` and every
    /// `output_every`-th increment is retained. Without one the other three fields mean
    /// nothing and the Step is the single solve it has always been.
    Static { solver: SolveOptions, dt: f64, t_end: f64, amplitude: Option<Amplitude>, output_every: usize },
    /// Static equilibrium with geometric nonlinearity: total Lagrangian, Newton–Raphson,
    /// load stepping ([`nonlinear`]).
    StaticNonlinear(nonlinear::Options),
    /// Natural frequencies and mode shapes by subspace iteration (plan A §6), optionally
    /// stiffened by the stress state of the static Step this one continues (#344).
    Modal {
        n_modes: usize,
        shift: Option<f64>,
        solver: SolveOptions,
        /// The preload displacement per DOF whose stress stiffens `K`; `None` is the ordinary
        /// unprestressed analysis. `solve.run` fills it in from the Result of the static Step
        /// named by `after`, exactly as it fills in an `initial_velocity`.
        prestress: Option<Vec<f64>>,
    },
    /// Linear buckling: the static state, then the load factors of `K φ = λ(−K_σ)φ`.
    Buckling { n_modes: usize, solver: SolveOptions },
    /// Steady conduction with convection, flux and radiation boundaries: `(K + H) T = f`,
    /// iterated when a radiating face makes `H` depend on `T`.
    HeatSteady { solver: SolveOptions, control: NonlinearControl },
    /// Transient conduction by the θ-method, one factorisation reused for every time step.
    HeatTransient {
        /// Maximum increment; a uniform increment no larger than this reaches `t_end` exactly.
        dt: f64,
        t_end: f64,
        /// 1.0 backward Euler, 0.5 Crank–Nicolson; below 0.5 is only conditionally stable.
        theta: f64,
        /// Uniform initial temperature.
        initial: f64,
        /// Keep one history row every this many steps.
        output_every: usize,
        amplitude: Option<Amplitude>,
        solver: SolveOptions,
        control: NonlinearControl,
    },
    /// Steady-state harmonic response over a frequency sweep, by superposing the modes of the
    /// `modal` Step this one continues (ADR 0020). It solves nothing.
    Harmonic {
        f_start: f64,
        f_stop: f64,
        /// Frequencies evaluated, endpoints included; at least 2.
        points: usize,
        spacing: crate::command::SweepSpacing,
        /// Constant modal damping ratio added to every mode. Mutually exclusive with
        /// `damping_ratios`.
        damping_ratio: Option<f64>,
        /// Per-mode modal damping ratios `[ζ₁, ζ₂, …]`, added to the Rayleigh contribution
        /// exactly like `damping_ratio`; a mode past the end of the list holds the last value.
        /// Mutually exclusive with `damping_ratio`.
        damping_ratios: Option<Vec<f64>>,
        /// `(alpha, beta)` of Rayleigh damping `C = alpha M + beta K`.
        rayleigh: (f64, f64),
        /// Keep one retained frequency every this many grid points.
        output_every: usize,
    },
    /// Stationary random response on a retained modal basis.
    RandomVibration { spectrum: random_vibration::Spectrum, damping: Vec<f64>, rayleigh: (f64, f64) },
    /// Explicit dynamics by central differences on a lumped mass (plan A §6).
    Explicit {
        t_end: f64,
        /// Maximum fraction of the Irons critical step; reduced uniformly to reach `t_end`.
        /// 0.9 is the usual margin.
        dt_factor: f64,
        /// Initial velocity per DOF; `None` starts from rest.
        initial_velocity: Option<Vec<f64>>,
        output_every: usize,
    },
    /// Implicit dynamics by the HHT-α method on the consistent mass, one factorisation reused
    /// for every time step ([`implicit`]).
    Implicit {
        dt: f64,
        t_end: f64,
        /// `α ∈ [−1/3, 0]`; 0 is Newmark average acceleration, below it HHT numerical damping.
        alpha: f64,
        /// Rayleigh damping `C = rayleigh_alpha·M + rayleigh_beta·K`.
        rayleigh_alpha: f64,
        rayleigh_beta: f64,
        /// Initial velocity per DOF; `None` starts from rest.
        initial_velocity: Option<Vec<f64>>,
        output_every: usize,
        /// Scales the Loads; prescribed displacements never move.
        amplitude: Option<Amplitude>,
    },
}

impl Step {
    /// The Command's name for this procedure.
    pub fn name(&self) -> &'static str {
        match self {
            Step::Static { .. } => "static",
            Step::StaticNonlinear(..) => "static-nonlinear",
            Step::Modal { .. } => "modal",
            Step::Buckling { .. } => "buckling",
            Step::HeatSteady { .. } => "heat-steady",
            Step::HeatTransient { .. } => "heat-transient",
            Step::Harmonic { .. } => "harmonic",
            Step::RandomVibration { .. } => "randomVibration",
            Step::Explicit { .. } => "explicit",
            Step::Implicit { .. } => "implicit",
        }
    }
}

/// A harmonic Step's frequency response: the frequencies it retained, and the nodal
/// displacement amplitude and phase lag at each of them.
///
/// `amplitude[i]` and `phase[i]` are three-component nodal fields like any other, parallel to
/// `frequencies[i]` in Hz. The phase is in radians and is the lag behind the driving load, so
/// `u(t) = amplitude · cos(2π f t − phase)`.
#[derive(Debug, Clone, PartialEq)]
pub struct Sweep {
    pub frequencies: Vec<f64>,
    pub amplitude: Vec<FieldData>,
    pub phase: Vec<FieldData>,
}

/// A transient Step's output: the times it kept and the nodal field at each of them.
#[derive(Debug, Clone, PartialEq)]
pub struct History {
    pub field: Field,
    pub times: Vec<f64>,
    /// One nodal vector per time, parallel to `times`.
    pub values: Vec<Vec<f64>>,
}

impl History {
    /// Allocate exactly the number of outer frame slots the schedule will retain. The inner
    /// value vectors remain the sole copy of the raw primary history.
    fn with_initial(field: Field, values: Vec<f64>, frames: usize) -> History {
        let mut times = Vec::with_capacity(frames);
        times.push(0.0);
        let mut retained = Vec::with_capacity(frames);
        retained.push(values);
        History { field, times, values: retained }
    }
}

/// Initial state + each output stride + the final step when it was not already a stride.
pub(crate) fn retained_frame_count(steps: usize, output_every: usize) -> Result<usize, Error> {
    let every = output_every.max(1);
    1usize.checked_add(steps / every).and_then(|n| n.checked_add(usize::from(!steps.is_multiple_of(every)))).ok_or_else(
        || {
            Error::new(ErrorCode::SolveTooLarge, "the retained-frame count cannot be represented")
                .at("outputEvery")
                .suggest("step.add with a larger outputEvery")
        },
    )
}

/// Logical payload bytes used by `History`: one f64 time and `values_per_frame` f64 values
/// for every retained frame. Vec headers, spare capacity and allocator overhead are separate.
pub(crate) fn retained_payload_bytes(frames: usize, values_per_frame: usize) -> Result<u64, Error> {
    let frames = frames as u64;
    let values = values_per_frame as u64;
    frames
        .checked_mul(values.checked_add(1).ok_or_else(|| {
            Error::new(ErrorCode::SolveTooLarge, "the retained field size overflows byte accounting")
                .at("mesh")
                .suggest("mesh.generate with a coarser size")
        })?)
        .and_then(|n| n.checked_mul(std::mem::size_of::<f64>() as u64))
        .ok_or_else(|| {
            Error::new(ErrorCode::SolveTooLarge, "the retained history overflows byte accounting")
                .at("outputEvery")
                .suggest("step.add with a larger outputEvery")
        })
}

/// Everything one Step produced. Fields cross to hosts as `f64`; the host casts to `f32` for
/// rendering. `scalars` carries the numbers a Result summary reports without a field: the
/// applied totals, the worst Jacobian, the residual the solver reached.
///
/// `extremes` and `reactions` are computed here and kept, not recomputed on demand: a Result
/// outlives the Mesh it was solved on (the Model can be edited under it), and a summary must
/// stay readable — and honest about being stale — after that.
#[derive(Debug, Clone, PartialEq)]
pub struct StepResult {
    /// Kept with the solved Result, so later model edits cannot change its reaction units.
    pub reaction_quantity: crate::units::ReactionQuantity,
    pub fields: BTreeMap<Field, FieldData>,
    pub scalars: BTreeMap<String, f64>,
    /// Per-component extremes of every nodal field, in `Field` order.
    pub extremes: Vec<(Field, Extremum)>,
    /// Total force (N) or removed thermal power (W) per Constraint, in Model order.
    /// Thermal power occupies component 0; components 1 and 2 are zero. Transient powers
    /// use the last θ-method stage, including the stored-energy rate.
    pub reactions: Vec<(String, [f64; 3])>,
    /// Natural frequencies in Hz, ascending; empty unless the Step was modal.
    pub frequencies: Vec<f64>,
    /// Buckling load factors, `|λ|` ascending; empty unless the Step was a buckling one. The
    /// Step's Loads times `λ` is the critical load, and a negative factor means the *reversed*
    /// load buckles the structure. Shape `k` is `modes[k - 1]`, as for a modal Step.
    pub buckling_factors: Vec<f64>,
    /// Mode shapes as three-component nodal displacements, parallel to `frequencies` (modal) or
    /// `buckling_factors` (buckling). A modal shape is normalised so `φᵀ M φ = 1`, a buckling
    /// shape to unit peak. Mode `k` is `modes[k - 1]`, which hosts reach as the field name
    /// `mode:k`.
    pub modes: Vec<FieldData>,
    /// Complete M-normalised modal vectors, including beam rotations, in Problem DOF order.
    /// Post-modal procedures use these; `modes` remains the three-component display field.
    pub modal_dofs: Vec<Vec<f64>>,
    /// Times and fields a transient Step kept.
    pub history: Option<History>,
    /// Frequencies and response fields a harmonic Step kept; `None` for every other procedure.
    pub sweep: Option<Sweep>,
    /// The Step whose stress state stiffened this one, kept with the Result so a later Model
    /// edit cannot rewrite what these frequencies were actually solved against. `None` for
    /// every procedure but a prestressed modal Step (#344).
    pub prestress_from: Option<String>,
    pub solver: SolveInfo,
    pub warnings: Vec<Warning>,
    /// Solver-used optional material defaults, captured by the Model-to-Problem boundary only
    /// after this procedure succeeds.
    pub assumptions: Vec<ResultAssumption>,
    /// One entry per frictionless contact the Step listed, in Step order; empty otherwise.
    pub contacts: Vec<ContactSummary>,
}

/// What one frictionless contact ended the Step with (`query.result` reports it).
#[derive(Debug, Clone, PartialEq)]
pub struct ContactSummary {
    pub name: String,
    /// Slave nodes held on the master surface.
    pub active: usize,
    /// Slave nodes the search paired, active or not.
    pub paired: usize,
    /// The resultant of the normal forces on the slave side, N.
    pub force: [f64; 3],
}

/// Run one Step.
///
/// `prev` is the previous Step's Result, which `solve.run` passes when the Step names another
/// with `after`; the thermal-to-structural chain reads its temperature field before the
/// Problem reaches here, and the harmonic procedure reads its frequencies and mode shapes.
pub async fn run(
    p: &Problem<'_>,
    step: &Step,
    pool: &crate::par::Pool,
    gpu: Option<&crate::gpu::Gpu>,
    prev: Option<&StepResult>,
    progress: OnProgress<'_>,
) -> Result<StepResult, Error> {
    match step {
        Step::Static { solver, dt, t_end, amplitude, output_every } => {
            static_::run(p, solver, *dt, *t_end, amplitude.as_ref(), *output_every, pool, gpu, progress).await
        }
        Step::RandomVibration { spectrum, damping, rayleigh } => {
            random_vibration::run(p, prev, spectrum, damping, *rayleigh, pool, progress)
        }
        Step::StaticNonlinear(options) => nonlinear::run(p, options, pool, gpu, progress).await,
        Step::Modal { n_modes, shift, solver, prestress } => {
            modal::run(p, *n_modes, *shift, prestress.as_deref(), solver, pool, progress)
        }
        Step::Buckling { n_modes, solver } => buckling::run(p, *n_modes, solver, pool, gpu, progress).await,
        Step::HeatSteady { solver, control } => heat::steady(p, solver, control, pool, gpu, progress).await,
        Step::HeatTransient { dt, t_end, theta, initial, output_every, amplitude, solver, control } => heat::transient(
            p,
            *dt,
            *t_end,
            *theta,
            *initial,
            *output_every,
            amplitude.as_ref(),
            solver,
            control,
            pool,
            progress,
        ),
        Step::Harmonic { f_start, f_stop, points, spacing, damping_ratio, damping_ratios, rayleigh, output_every } => {
            // The scalar is the length-one case of the per-mode list: every mode reads the
            // same ratio, which `damping_ratios` (crate::procedure::modal) already implements
            // by holding the last entry for modes past the end.
            let ratio: Vec<f64> = damping_ratios.clone().or_else(|| damping_ratio.map(|z| vec![z])).unwrap_or_default();
            harmonic::run(
                p,
                prev,
                *f_start,
                *f_stop,
                *points,
                *spacing,
                &ratio,
                *rayleigh,
                *output_every,
                pool,
                progress,
            )
        }
        Step::Explicit { t_end, dt_factor, initial_velocity, output_every } => {
            explicit::run(p, *t_end, *dt_factor, initial_velocity.as_deref(), *output_every, pool, progress)
        }
        Step::Implicit {
            dt,
            t_end,
            alpha,
            rayleigh_alpha,
            rayleigh_beta,
            initial_velocity,
            output_every,
            amplitude,
        } => implicit::run(
            p,
            *dt,
            *t_end,
            *alpha,
            (*rayleigh_alpha, *rayleigh_beta),
            initial_velocity.as_deref(),
            *output_every,
            amplitude.as_ref(),
            pool,
            progress,
        ),
    }
}

/// A uniform time grid reaching the requested endpoint without exceeding the nominal step.
/// One increment keeps the heat factorisation reusable and the explicit leapfrog centred.
pub(crate) fn time_grid(max_dt: f64, t_end: f64) -> Result<(usize, f64), Error> {
    if !max_dt.is_finite() || max_dt <= 0.0 || !t_end.is_finite() || t_end <= 0.0 {
        return Err(Error::schema("a transient Step needs finite dt > 0 and tEnd > 0")
            .at("dt")
            .suggest("step.add with positive finite dt and tEnd"));
    }
    let steps = (t_end / max_dt).ceil().max(1.0);
    // Every integer step index must fit both usize and the f64 time calculation. This
    // also rejects overflow of the ratio instead of saturating a cast into a huge loop.
    if steps >= (usize::MAX as f64).min(9_007_199_254_740_992.0) {
        return Err(Error::schema("the requested time grid has too many steps to represent")
            .at("dt")
            .suggest("step.add with a larger dt or shorter tEnd"));
    }
    let mut steps = steps as usize;
    // Division may round an almost-integral ratio down to an integer. Recheck the actual
    // increment so rounding can never increase an explicit stability bound, even by one ulp.
    steps += usize::from(t_end / steps as f64 > max_dt);
    Ok((steps, t_end / steps as f64))
}

/// An empty Result of the right shape: the procedures fill in what they produce and leave the
/// rest alone, so adding a field to `StepResult` does not touch five constructors.
pub(crate) fn blank(solver: SolveInfo) -> StepResult {
    StepResult {
        reaction_quantity: crate::units::ReactionQuantity::Force,
        fields: BTreeMap::new(),
        scalars: BTreeMap::new(),
        extremes: Vec::new(),
        reactions: Vec::new(),
        frequencies: Vec::new(),
        buckling_factors: Vec::new(),
        modes: Vec::new(),
        modal_dofs: Vec::new(),
        history: None,
        sweep: None,
        prestress_from: None,
        solver,
        warnings: Vec::new(),
        assumptions: Vec::new(),
        contacts: Vec::new(),
    }
}

/// A per-node vector as three components, so a 2D Result reaches a host and a VTU writer with
/// the same shape as a 3D one (the z component is zero, and a one-DOF heat field fills only x).
/// Under axisymmetric twist the third slot is `u_theta`, not a spatial z, exactly filling the
/// three components this shape provides.
// ponytail: the `node * 3` output stride is `dofs_per_node`'s ceiling (3, today's largest);
// a future idealisation with more DOFs per node needs a wider Per::Node shape here, not a
// literal 3.
pub(crate) fn vector_field(v: &[f64], dofs_per_node: usize) -> FieldData {
    let n = v.len() / dofs_per_node;
    let mut data = vec![0.0; n * 3];
    for node in 0..n {
        for c in 0..dofs_per_node.min(3) {
            data[node * 3 + c] = v[node * dofs_per_node + c];
        }
    }
    FieldData::new(crate::post::Per::Node, 3, data)
}

/// The rotations of a six-DOF vector as a three-component nodal field: components 3, 4 and 5
/// of every node, which only a Problem with beams has.
pub(crate) fn rotation_field(v: &[f64]) -> FieldData {
    let dpn = crate::fem::problem::NODE_DOFS_MAX;
    let n = v.len() / dpn;
    let mut data = vec![0.0; n * 3];
    for node in 0..n {
        data[node * 3..node * 3 + 3].copy_from_slice(&v[node * dpn + 3..node * dpn + 6]);
    }
    FieldData::new(crate::post::Per::Node, 3, data)
}

/// Report progress and turn a `false` from the host into `Cancelled`.
pub(crate) fn report(
    progress: &mut OnProgress<'_>,
    phase: &'static str,
    fraction: f64,
    message: &str,
) -> Result<(), Error> {
    if progress(Progress { phase, fraction, message: message.to_string() }) {
        Ok(())
    } else {
        Err(Error::cancelled())
    }
}

#[cfg(test)]
mod tests {
    use super::{iterate, relative_change, retained_frame_count, retained_payload_bytes, time_grid, NonlinearControl};
    use crate::solve::SolveInfo;
    use crate::ErrorCode;

    fn info() -> SolveInfo {
        SolveInfo { solver: "test", iterations: 3, rel_residual: 0.0, time_ms: 0.0 }
    }

    #[test]
    fn a_linear_problem_converges_on_the_first_pass() {
        let control = NonlinearControl::default();
        assert_eq!((control.tol, control.max_iterations), (1e-6, 50));
        let mut state = vec![1.0, -2.0];
        let mut calls = 0usize;
        let (solver, passes) = iterate(&control, &mut state, "step 'heat'", &mut |current, next| {
            calls += 1;
            next.copy_from_slice(current);
            Ok(info())
        })
        .expect("a state that does not move is converged");
        assert_eq!((calls, passes, solver.iterations), (1, 1, 3));
        assert_eq!(state, vec![1.0, -2.0]);
    }

    #[test]
    fn a_contraction_reaches_its_fixed_point() {
        // x <- (x + 4/x)/2 is Newton on sqrt(4), so the fixed point is 2 and the sup-norm
        // change falls below 1e-12 after four passes from 1.
        let control = NonlinearControl { tol: 1e-12, max_iterations: 50 };
        let mut state = vec![1.0];
        let (_, passes) = iterate(&control, &mut state, "step 'heat'", &mut |current, next| {
            next[0] = 0.5 * (current[0] + 4.0 / current[0]);
            Ok(info())
        })
        .expect("Newton on sqrt(4) converges");
        assert_eq!(passes, 6);
        assert!(libm::fabs(state[0] - 2.0) < 1e-15, "{state:?}");
    }

    #[test]
    fn a_closure_that_never_settles_is_solve_diverged() {
        let control = NonlinearControl { tol: 1e-6, max_iterations: 7 };
        let mut state = vec![1.0];
        let mut calls = 0usize;
        let error = iterate(&control, &mut state, "step 'heat'", &mut |current, next| {
            calls += 1;
            next[0] = -current[0];
            Ok(info())
        })
        .expect_err("a sign flip never converges");
        assert_eq!(calls, 7);
        assert_eq!(error.code, ErrorCode::SolveDiverged);
        assert_eq!(error.where_.as_deref(), Some("step 'heat'"));
        assert!(error.cause.contains("7 passes"), "{}", error.cause);
        assert!(error.suggestion.expect("a budget suggestion").contains("nonlinearMaxIterations"));
    }

    #[test]
    fn a_non_finite_state_stops_at_once() {
        let control = NonlinearControl { tol: 1e-6, max_iterations: 50 };
        let mut state = vec![1.0, 1.0];
        let mut calls = 0usize;
        let error = iterate(&control, &mut state, "step 'heat'", &mut |_, next| {
            calls += 1;
            next[1] = f64::NAN;
            Ok(info())
        })
        .expect_err("a NaN state cannot converge");
        assert_eq!(calls, 1);
        assert_eq!(error.code, ErrorCode::SolveDiverged);
        assert!(error.cause.contains("1 passes"), "{}", error.cause);
        assert!(state[1].is_nan(), "the failing state is kept for inspection");
    }

    #[test]
    fn a_failing_advance_reports_its_own_error() {
        let control = NonlinearControl { tol: 1e-6, max_iterations: 50 };
        let mut state = vec![1.0];
        let error = iterate(&control, &mut state, "step 'heat'", &mut |_, _| {
            Err(crate::error::Error::new(ErrorCode::SolveNotPositiveDefinite, "singular"))
        })
        .expect_err("the advance failure is not swallowed");
        assert_eq!(error.code, ErrorCode::SolveNotPositiveDefinite);
    }

    #[test]
    fn the_relative_change_is_scaled_and_never_divides_by_zero() {
        assert_eq!(relative_change(&[0.0, 0.0], &[0.0, 0.0]), 0.0);
        assert_eq!(relative_change(&[2.0, 0.0], &[4.0, 0.0]), 0.5);
        assert!(relative_change(&[1.0], &[f64::INFINITY]).is_nan());
    }

    #[test]
    fn time_grid_reaches_the_endpoint_without_rounding_above_the_step_bound() {
        for (max_dt, t_end, count) in [(0.6, 1.0, 2), (0.4, 0.9, 3), (2.0, 0.25, 1), (0.5, 2.0, 4)] {
            let (steps, dt) = time_grid(max_dt, t_end).unwrap();
            assert_eq!(steps, count);
            assert!(dt <= max_dt);
            assert_eq!(dt, t_end / steps as f64);
        }
        // The raw ceil is 23, but dividing the endpoint by 23 is one ulp above max_dt.
        let bound = 0.8750405597410305;
        let (steps, dt) = time_grid(bound, 20.125932874043702).unwrap();
        assert_eq!(steps, 24);
        assert!(dt <= bound);
    }

    #[test]
    fn unrepresentable_time_grids_are_structured_errors() {
        for (dt, end) in [(0.0, 1.0), (1.0, 0.0), (f64::INFINITY, 1.0), (1.0, f64::NAN), (f64::MIN_POSITIVE, 1.0)] {
            let error = time_grid(dt, end).unwrap_err();
            assert_eq!(error.code, ErrorCode::Schema);
            assert_eq!(error.where_.as_deref(), Some("dt"));
            assert!(error.suggestion.is_some());
        }
    }

    #[test]
    fn retained_count_is_initial_stride_and_one_final_endpoint() {
        assert_eq!(retained_frame_count(6, 2).unwrap(), 4);
        assert_eq!(retained_frame_count(5, 2).unwrap(), 4);
        assert_eq!(retained_frame_count(3, 10).unwrap(), 2);
        assert_eq!(retained_frame_count(3, 0).unwrap(), 4);
        assert_eq!(retained_payload_bytes(4, 6).unwrap(), 224);
        let error = retained_frame_count(usize::MAX, 1).expect_err("initial + every usize step overflows");
        assert_eq!(error.code, ErrorCode::SolveTooLarge);
        for (frames, values) in [(1, usize::MAX), (usize::MAX, 1)] {
            let error = retained_payload_bytes(frames, values).expect_err("payload bytes overflow");
            assert_eq!(error.code, ErrorCode::SolveTooLarge);
        }
        let history = super::History::with_initial(crate::command::Field::Temperature, vec![1.0, 2.0], 4);
        assert_eq!((history.times.capacity(), history.values.capacity()), (4, 4));
    }

    /// #82: every real `dofs_per_node` today is at most 3, so `node * 3` never overruns; a
    /// future stride above 3 (a beam's 6, say) would otherwise write into the next node's
    /// slot. Called directly with such a stride, `vector_field` must drop the extra components
    /// rather than corrupt data belonging to a different node.
    #[test]
    fn vector_field_never_writes_past_its_own_node() {
        use super::vector_field;
        // dofs_per_node = 2: a plain 2D field, unaffected.
        let plane = vector_field(&[1.0, 2.0, 3.0, 4.0], 2);
        assert_eq!(plane.data, vec![1.0, 2.0, 0.0, 3.0, 4.0, 0.0]);
        // dofs_per_node = 3: axisymmetric twist, filling every one of the three slots.
        let twist = vector_field(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0], 3);
        assert_eq!(twist.data, vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
        // dofs_per_node = 4 (hypothetical, no real Idealisation reaches this yet): components
        // beyond the third are dropped, never scattered into node 1's own three slots.
        let wide = vector_field(&[1.0, 2.0, 3.0, 4.0, 10.0, 20.0, 30.0, 40.0], 4);
        assert_eq!(wide.data, vec![1.0, 2.0, 3.0, 10.0, 20.0, 30.0]);
    }
}
