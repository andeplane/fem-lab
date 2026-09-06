//! Procedures: what a Step *does*. One `run` for every one of them (plan A §6).
//!
//! `Step::Static` is the linear static procedure ([`static_`]); [`modal`] finds natural
//! frequencies by subspace iteration, [`heat`] solves steady and transient conduction, and
//! [`explicit`] integrates the equations of motion by central differences. Each one takes the
//! same resolved [`Problem`] and answers the same [`StepResult`], so `solve.run` and every
//! host read one shape whatever the physics.

pub mod explicit;
pub mod heat;
pub mod modal;
pub mod static_;

use std::collections::BTreeMap;

use crate::command::Field;
use crate::engine::{OnProgress, Progress};
use crate::error::{Error, ErrorCode, Warning};
use crate::fem::problem::Problem;
use crate::post::{Extremum, FieldData};
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

/// One analysis step.
pub enum Step {
    /// Linear static equilibrium: `K u = f`.
    ///
    /// With an `amplitude` the Step is stepped instead: the Loads and the prescribed
    /// displacements are scaled by `g(t)` over the grid `dt`/`t_end` and every
    /// `output_every`-th increment is retained. Without one the other three fields mean
    /// nothing and the Step is the single solve it has always been.
    Static { solver: SolveOptions, dt: f64, t_end: f64, amplitude: Option<Amplitude>, output_every: usize },
    /// Natural frequencies and mode shapes by subspace iteration (plan A §6).
    Modal { n_modes: usize, shift: Option<f64>, solver: SolveOptions },
    /// Steady conduction with convection and flux boundaries: `(K + H) T = f`.
    HeatSteady { solver: SolveOptions },
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
    },
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
}

impl Step {
    /// The Command's name for this procedure.
    pub fn name(&self) -> &'static str {
        match self {
            Step::Static { .. } => "static",
            Step::Modal { .. } => "modal",
            Step::HeatSteady { .. } => "heat-steady",
            Step::HeatTransient { .. } => "heat-transient",
            Step::Explicit { .. } => "explicit",
        }
    }
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
    /// Thermal power occupies component 0; components 1 and 2 are zero.
    pub reactions: Vec<(String, [f64; 3])>,
    /// Natural frequencies in Hz, ascending; empty unless the Step was modal.
    pub frequencies: Vec<f64>,
    /// Mode shapes as three-component nodal displacements, parallel to `frequencies` and
    /// normalised so `φᵀ M φ = 1`. Mode `k` is `modes[k - 1]`, which hosts reach as the field
    /// name `mode:k`; `Field::Displacement` is mode 1, so a VTU export shows the first mode.
    pub modes: Vec<FieldData>,
    /// Times and fields a transient Step kept.
    pub history: Option<History>,
    pub solver: SolveInfo,
    pub warnings: Vec<Warning>,
}

/// Run one Step.
///
/// `prev` is the previous Step's Result, which `solve.run` passes when the Step names another
/// with `after`; the thermal-to-structural chain reads its temperature field before the
/// Problem reaches here, so the procedures themselves only need it for the modal and explicit
/// restarts a later phase adds.
pub async fn run(
    p: &Problem<'_>,
    step: &Step,
    pool: &crate::par::Pool,
    gpu: Option<&crate::gpu::Gpu>,
    _prev: Option<&StepResult>,
    progress: OnProgress<'_>,
) -> Result<StepResult, Error> {
    match step {
        Step::Static { solver, dt, t_end, amplitude, output_every } => {
            static_::run(p, solver, *dt, *t_end, amplitude.as_ref(), *output_every, pool, gpu, progress).await
        }
        Step::Modal { n_modes, shift, solver } => modal::run(p, *n_modes, *shift, solver, pool, progress),
        Step::HeatSteady { solver } => heat::steady(p, solver, pool, gpu, progress).await,
        Step::HeatTransient { dt, t_end, theta, initial, output_every, amplitude, solver } => {
            heat::transient(p, *dt, *t_end, *theta, *initial, *output_every, amplitude.as_ref(), solver, pool, progress)
        }
        Step::Explicit { t_end, dt_factor, initial_velocity, output_every } => {
            explicit::run(p, *t_end, *dt_factor, initial_velocity.as_deref(), *output_every, pool, progress)
        }
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
        modes: Vec::new(),
        history: None,
        solver,
        warnings: Vec::new(),
    }
}

/// A per-node vector as three components, so a 2D Result reaches a host and a VTU writer with
/// the same shape as a 3D one (the z component is zero, and a one-DOF heat field fills only x).
pub(crate) fn vector_field(v: &[f64], dofs_per_node: usize) -> FieldData {
    let n = v.len() / dofs_per_node;
    let mut data = vec![0.0; n * 3];
    for node in 0..n {
        for c in 0..dofs_per_node {
            data[node * 3 + c] = v[node * dofs_per_node + c];
        }
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
    use super::{retained_frame_count, retained_payload_bytes, time_grid};
    use crate::ErrorCode;

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
}
