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
use crate::error::{Error, Warning};
use crate::fem::problem::Problem;
use crate::post::{Extremum, FieldData};
use crate::solve::{SolveInfo, SolveOptions};

/// A scalar `g(t)` multiplying every prescribed temperature of a transient Step.
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
    Static { solver: SolveOptions },
    /// Natural frequencies and mode shapes by subspace iteration (plan A §6).
    Modal { n_modes: usize, shift: Option<f64>, solver: SolveOptions },
    /// Steady conduction with convection and flux boundaries: `(K + H) T = f`.
    HeatSteady { solver: SolveOptions },
    /// Transient conduction by the θ-method, one factorisation reused for every time step.
    HeatTransient {
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
        /// Fraction of the Irons critical step to take; 0.9 is the usual margin.
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
        Step::Static { solver } => static_::run(p, solver, pool, gpu, progress).await,
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
