//! Procedures: what a Step *does*. One `run` for every one of them (plan A §6).
//!
//! `Step::Static` is the linear static procedure and is implemented in [`static_`]. The other
//! variants are the shape the later procedures take — modal by subspace iteration, steady and
//! transient heat, explicit dynamics — and answer `unsupported` until their commit lands, so
//! `solve.run` names the procedure it cannot run instead of failing at the schema.

pub mod static_;

use std::collections::BTreeMap;

use crate::command::Field;
use crate::engine::{OnProgress, Progress};
use crate::error::{Error, Warning};
use crate::fem::problem::Problem;
use crate::post::{Extremum, FieldData};
use crate::solve::{SolveInfo, SolveOptions};

/// One analysis step.
pub enum Step {
    /// Linear static equilibrium: `K u = f`.
    Static { solver: SolveOptions },
    /// Natural frequencies and mode shapes by subspace iteration (plan A §6).
    Modal,
    /// Steady conduction with convection and flux boundaries (plan A §6).
    HeatSteady,
    /// Transient conduction by the θ-method (plan A §6).
    HeatTransient,
    /// Explicit dynamics by central differences on a lumped mass (plan A §6).
    Explicit,
}

impl Step {
    /// The Command's name for this procedure.
    pub fn name(&self) -> &'static str {
        match self {
            Step::Static { .. } => "static",
            Step::Modal => "modal",
            Step::HeatSteady => "heat-steady",
            Step::HeatTransient => "heat-transient",
            Step::Explicit => "explicit",
        }
    }
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
    pub fields: BTreeMap<Field, FieldData>,
    pub scalars: BTreeMap<String, f64>,
    /// Per-component extremes of every nodal field, in `Field` order.
    pub extremes: Vec<(Field, Extremum)>,
    /// The total force each Constraint carries, in Model order.
    pub reactions: Vec<(String, [f64; 3])>,
    pub solver: SolveInfo,
    pub warnings: Vec<Warning>,
}

/// Run one Step.
///
/// `_prev` is the previous Step's Result, which the thermal-to-structural chain reads a
/// temperature field from (plan A §6); the linear static procedure takes its temperature from
/// the Model's `load.temperature` instead.
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
        other => Err(Error::unsupported(&format!("the '{}' procedure", other.name()))
            .suggest("step.add { procedure: \"static\" }")),
    }
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
