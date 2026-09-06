//! `solve.run`: the Model, the Mesh and a Step turned into a `Problem`, solved, and reported.
//!
//! This is the seam between the registry and the numerics. Everything above it speaks names,
//! Sets and `Quantity`; everything below it speaks SI `f64` on a Mesh (plan A §6, plan B §2.1).
//! Results are kept per Step with their Result-validity fingerprint (ADR 0017), so an edit does not throw
//! them away — it makes them *stale*, which `query.result` says out loud.

use femlab_geometry::Mesh;

use crate::command::{Field, ObjectKind, Procedure, QuantityOfInterest, Solver};
use crate::engine::{display, Engine, OnProgress};
use crate::error::{Error, ErrorCode};
use crate::fem::element::Material;
use crate::fem::heat::HeatLoad;
use crate::fem::loads::{face_set_area, Load};
use crate::fem::problem::{Constraint, Problem};
use crate::mesh::{scale_mesher, BuiltMesh};
use crate::model::{ConstraintKind, LoadKind, MeshSettings, Model, Step};
use crate::post::convergence::{observed_rate, richardson};
use crate::post::{Extremum, FieldData};
use crate::procedure::{self, report, StepResult};
use crate::query::{
    AssumedMaterialProperty, Extreme, HistoryRow, Output, ReactionRow, ResultAssumption, ResultSummary, StudyReport,
    StudyRow, Valued,
};
use crate::solve::SolveOptions;
use crate::units::{Dim, Dimension, Force, Frequency, Length, Power, ReactionQuantity, Stress, Temperature, Time, Q};

/// The material law every Model material resolves to for now; plugins add their own later.
const LAW: &str = "linear-elastic";

/// The dimension a Result field carries, so a summary reports it in the Model's own units.
pub fn field_dimension(field: Field, reaction: ReactionQuantity) -> Dimension {
    match field {
        Field::Displacement => Length::DIM,
        Field::Reaction => match reaction {
            ReactionQuantity::Force => Force::DIM,
            ReactionQuantity::Power => Power::DIM,
        },
        Field::Temperature => Temperature::DIM,
        Field::Strain => Dimension::NONE,
        Field::Stress | Field::StressUnaveraged | Field::VonMises | Field::Principal => Stress::DIM,
    }
}

/// The wire name of a Result field, from serde's rename.
pub fn field_name(field: Field) -> String {
    serde_json::to_string(&field).unwrap_or_default().trim_matches('"').to_string()
}

/// The Model resolved to numbers on the built Mesh for one Step.
///
/// Loads reach the numerics per unit: the Model's "10 kN on this face" is divided by the face
/// Set's own integrated area, and its "10 kN on this Set of nodes" by the node count, so what
/// is assembled sums back to what was asked for.
pub fn build_problem<'a>(model: &Model, built: &'a BuiltMesh, step: &Step) -> Result<Problem<'a>, Error> {
    build_problem_with_temperature(model, built, step, None)
}

fn build_problem_with_temperature<'a>(
    model: &Model,
    built: &'a BuiltMesh,
    step: &Step,
    previous: Option<&FieldData>,
) -> Result<Problem<'a>, Error> {
    let heat = matches!(step.procedure, Procedure::HeatSteady | Procedure::HeatTransient);
    let materials: Vec<Material> = model
        .materials
        .iter()
        .map(|m| Material {
            law: crate::fem::material::builtin_law(LAW).expect("the built-in law"),
            props: vec![m.e, m.nu],
            rho: m.rho.unwrap_or(0.0),
            alpha: m.alpha.unwrap_or(0.0),
            k: m.k.unwrap_or(0.0),
            cp: m.cp.unwrap_or(0.0),
        })
        .collect();
    let material_of_block = built
        .body_of_block
        .iter()
        .map(|body| {
            let name = model.material_of_body(body)?;
            model.materials.iter().position(|m| m.name == name)
        })
        .collect();
    let mut constraints = Vec::with_capacity(step.constraints.len());
    for name in &step.constraints {
        let c = model.constraint(name).expect("step.add validated the Constraint names");
        let (dofs, value) = match &c.kind {
            ConstraintKind::Fix { dofs } => {
                let mut on = [false; 3];
                for d in dofs {
                    on[d.index()] = true;
                }
                (on, 0.0)
            }
            ConstraintKind::Prescribe { dof, value } => {
                let mut on = [false; 3];
                on[dof.index()] = true;
                (on, *value)
            }
            ConstraintKind::Symmetry { normal } => {
                let mut on = [false; 3];
                on[normal.index()] = true;
                (on, 0.0)
            }
            // The heat DOF is component 0; a temperature Constraint in a structural Step holds
            // nothing, which is what an all-false `dofs` means, so it is inert there.
            ConstraintKind::Temperature { value } => ([heat, false, false], *value),
        };
        constraints.push(Constraint { name: c.name.clone(), nodes: c.on.clone(), dofs, value });
    }
    let mut p = Problem {
        mesh: &built.mesh,
        sets: &built.sets,
        body_of_block: &built.body_of_block,
        material_of_block,
        materials,
        idealisation: model.idealisation.clone(),
        formulation: model.mesh.as_ref().map_or_else(Default::default, |m| m.formulation),
        constraints,
        loads: Vec::new(),
        temperature: None,
        heat,
        heat_loads: Vec::new(),
    };
    let mut loads = Vec::with_capacity(step.loads.len());
    let mut heat_loads = Vec::new();
    for name in &step.loads {
        let l = model.load(name).expect("step.add validated the Load names");
        match &l.kind {
            LoadKind::Pressure { on, value } => loads.push(Load::Pressure { faces: on.clone(), p: *value }),
            LoadKind::Traction { on, total } => {
                let area = face_set_area(&p, on)?;
                loads.push(Load::Traction { faces: on.clone(), t: total.map(|x| x / area) });
            }
            LoadKind::Force { on, total } => {
                let n = p.set(on)?.nodes.len() as f64;
                loads.push(Load::NodalForce { nodes: on.clone(), f: total.map(|x| x / n) });
            }
            LoadKind::Gravity { g } => loads.push(Load::Gravity { g: *g }),
            // Composed once below, including references for an inherited heat field.
            LoadKind::Temperature { .. } => {}
            LoadKind::Convection { on, h, t_inf } => {
                heat_loads.push(HeatLoad::Convection { faces: on.clone(), h: *h, t_inf: *t_inf });
            }
            LoadKind::Radiation { on, emissivity, t_inf } => {
                heat_loads.push(HeatLoad::Radiation { faces: on.clone(), emissivity: *emissivity, t_inf: *t_inf });
            }
            LoadKind::HeatFlux { on, q } => heat_loads.push(HeatLoad::Flux { faces: on.clone(), q: *q }),
            LoadKind::HeatSource { bodies, q } => {
                heat_loads.push(HeatLoad::Source { bodies: bodies.clone(), q: *q });
            }
        }
    }
    p.loads = loads;
    p.heat_loads = heat_loads;
    p.temperature = thermal_field(model, built, step, previous)?;
    Ok(p)
}

/// Compose temperature increments, so each Body can use its own absolute reference. A
/// temperature is a field, not an additive force: equal assignments overlap, unequal ones
/// are ill-posed. Repeated connectivity must never add the same increment more than once.
fn thermal_field(
    model: &Model,
    built: &BuiltMesh,
    step: &Step,
    previous: Option<&FieldData>,
) -> Result<Option<(Vec<f64>, f64)>, Error> {
    let mut assigned: Option<Vec<Option<(f64, &str)>>> = None;
    for name in &step.loads {
        let load = model.load(name).expect("step.add validated the Load names");
        if let LoadKind::Temperature { bodies, value, reference } = &load.kind {
            let nodal = assigned.get_or_insert_with(|| vec![None; built.mesh.n_nodes()]);
            for (b, body) in built.body_of_block.iter().enumerate().filter(|(_, body)| bodies.contains(body)) {
                for &node in &built.mesh.blocks[b].conn {
                    let node = node as usize;
                    let delta = previous.map_or(*value, |t| t.data[node * t.comps]) - reference;
                    if let Some((old, owner)) = nodal[node] {
                        if old != delta {
                            return Err(Error::new(ErrorCode::ModelIllPosed,
                                format!("temperature loads '{owner}' and '{name}' assign different increments to body '{body}' at node {node}"))
                                .at(format!("step '{}'", step.name))
                                .suggest("load.temperature: use one temperature increment per overlapping Body"));
                        }
                    }
                    nodal[node] = Some((delta, name));
                }
            }
        }
    }
    // A prior heat Step heats every node; unassigned Bodies retain the default 293.15 K
    // reference. Without a heat Result, unassigned Bodies have zero thermal strain.
    if assigned.is_none() && previous.is_none() {
        return Ok(None);
    }
    let nodal = (0..built.mesh.n_nodes())
        .map(|node| {
            assigned
                .as_ref()
                .and_then(|a| a[node])
                .map_or_else(|| previous.map_or(0.0, |t| t.data[node * t.comps] - 293.15), |(delta, _)| delta)
        })
        .collect();
    Ok(Some((nodal, 0.0)))
}

/// Explain which mass-bearing path read an omitted density.
fn rho_assumption_cause(procedure: Procedure, has_gravity: bool) -> Option<&'static str> {
    match procedure {
        Procedure::Static if has_gravity => Some("gravity read the omitted density as zero"),
        Procedure::Modal => Some("modal mass assembly read the omitted density as zero"),
        Procedure::Explicit => Some("explicit mass assembly read the omitted density as zero"),
        _ => None,
    }
}

/// Optional material values this exact procedure read after the Model-to-Problem boundary
/// resolved an omission to zero. Callers attach these only after the procedure succeeds.
fn result_assumptions(
    model: &Model,
    built: &BuiltMesh,
    step: &str,
    procedure: Procedure,
    p: &Problem<'_>,
) -> Vec<ResultAssumption> {
    let rho_cause = rho_assumption_cause(procedure, p.loads.iter().any(|load| matches!(load, Load::Gravity { .. })));
    // Static and explicit assembly both form the thermal force. Modal forms stiffness too, but
    // discards that load vector, so alpha is not solver-used there.
    let reads_alpha = matches!(procedure, Procedure::Static | Procedure::Explicit) && p.temperature.is_some();
    // A BuiltMesh block always has elements. Collecting by Body and material also collapses a
    // mapped Body made from several blocks into one assumption row per property.
    let assigned: std::collections::BTreeMap<(&str, usize), ()> = built
        .body_of_block
        .iter()
        .zip(&p.material_of_block)
        .filter_map(|(body, material)| material.map(|index| ((body.as_str(), index), ())))
        .collect();
    let mut out = Vec::new();
    for ((body, material_index), ()) in assigned {
        let material = &model.materials[material_index];
        let mut push = |property, unit: &str, cause: &str| {
            out.push(ResultAssumption {
                step: step.to_string(),
                body: body.to_string(),
                material: material.name.clone(),
                property,
                value: Valued { value: 0.0, unit: unit.to_string() },
                source: material.source.clone(),
                cause: cause.to_string(),
            });
        };
        if let (Some(cause), None) = (rho_cause, material.rho) {
            push(AssumedMaterialProperty::Rho, "kg/m^3", cause);
        }
        if reads_alpha && material.alpha.is_none() {
            push(
                AssumedMaterialProperty::Alpha,
                "1/K",
                "the resolved temperature field read the omitted thermal expansion coefficient as zero",
            );
        }
    }
    out
}

/// The wire name of a procedure, from serde's rename.
pub fn procedure_name(p: Procedure) -> String {
    serde_json::to_string(&p).unwrap_or_default().trim_matches('"').to_string()
}

/// The `procedure::Step` a Model Step means: the fields that procedure reads, and the defaults
/// plan A names for the ones the Command left out. A missing `dt` or `tEnd` is a schema error
/// naming the field, because a transient with no clock is not a Step anybody meant.
/// The convergence control a Step carries, with the defaults an old Journal replays under.
fn control(step: &Step) -> procedure::NonlinearControl {
    let d = procedure::NonlinearControl::default();
    procedure::NonlinearControl {
        tol: step.nonlinear_tolerance.unwrap_or(d.tol),
        max_iterations: step.nonlinear_max_iterations.map_or(d.max_iterations, |n| n as usize),
    }
}

pub(crate) fn procedure_step(step: &Step, opts: SolveOptions) -> Result<procedure::Step, Error> {
    let want = |v: Option<f64>, field: &'static str| {
        v.ok_or_else(|| {
            let name = procedure_name(step.procedure);
            Error::schema(format!("the '{name}' procedure needs {field}"))
                .at(field)
                .suggest(format!("step.add with procedure {name} and a {field}"))
        })
    };
    Ok(match step.procedure {
        Procedure::Static => procedure::Step::Static { solver: opts },
        Procedure::Modal => {
            procedure::Step::Modal { n_modes: step.n_modes.unwrap_or(6) as usize, shift: step.shift, solver: opts }
        }
        Procedure::HeatSteady => procedure::Step::HeatSteady { solver: opts, control: control(step) },
        Procedure::HeatTransient => procedure::Step::HeatTransient {
            control: control(step),
            dt: want(step.dt, "dt")?,
            t_end: want(step.t_end, "tEnd")?,
            theta: step.theta.unwrap_or(0.5),
            initial: step.initial.unwrap_or(293.15),
            output_every: step.output_every.unwrap_or(1) as usize,
            amplitude: step.amplitude.as_ref().map(amplitude),
            solver: opts,
        },
        Procedure::Explicit => procedure::Step::Explicit {
            t_end: want(step.t_end, "tEnd")?,
            dt_factor: step.dt_factor.unwrap_or(0.9),
            initial_velocity: None,
            output_every: step.output_every.unwrap_or(1) as usize,
        },
    })
}

pub(crate) struct PlannedCost {
    pub estimate: crate::query::CostEstimate,
    transient: Option<(usize, usize, &'static str)>,
}

/// The cost Query and solve preflight share one schedule and byte calculation. Explicit Steps
/// derive their step count from the same element-frequency bound as the integrator.
pub(crate) fn planned_cost(
    mesh: &femlab_geometry::Mesh,
    explicit_problem: Option<&Problem<'_>>,
    step: &procedure::Step,
) -> Result<PlannedCost, Error> {
    let mut estimate = match step {
        procedure::Step::Static { solver } | procedure::Step::Modal { solver, .. } => {
            crate::solve::cost_estimate(mesh, mesh.dim, solver.solver)
        }
        procedure::Step::HeatSteady { solver, .. } => crate::solve::cost_estimate(mesh, 1, solver.solver),
        procedure::Step::HeatTransient { dt, t_end, output_every, solver, .. } => {
            let (steps, _) = procedure::time_grid(*dt, *t_end)?;
            let base = crate::solve::cost_estimate(mesh, 1, solver.solver);
            return crate::solve::add_transient_cost(base, mesh.n_nodes(), 1, steps, *output_every, 5)
                .map(|estimate| PlannedCost { estimate, transient: Some((steps, *output_every, "heat-transient")) });
        }
        procedure::Step::Explicit { t_end, dt_factor, output_every, .. } => {
            let p = explicit_problem.expect("an explicit cost plan needs its resolved Problem");
            let (steps, _) = procedure::explicit::retention_grid(p, *t_end, *dt_factor)?;
            let components = p.dofs_per_node();
            let base = crate::solve::cost_estimate(mesh, components, Solver::Auto);
            return crate::solve::add_transient_cost(base, mesh.n_nodes(), components, steps, *output_every, 6)
                .map(|estimate| PlannedCost { estimate, transient: Some((steps, *output_every, "explicit")) });
        }
    };
    estimate.note.push_str(" Retained transient frames: none.");
    Ok(PlannedCost { estimate, transient: None })
}

impl PlannedCost {
    pub(crate) fn with_records(mut self, resident: u64, mesh: u64) -> Self {
        self.estimate.resident_result_bytes = resident;
        self.estimate.result_mesh_bytes = mesh;
        self.estimate.bytes = self.estimate.bytes.saturating_add(resident).saturating_add(mesh);
        self.estimate.feasible = if self.estimate.bytes > self.estimate.budget_bytes { Some(false) } else { None };
        self.estimate.note.push_str(&format!(" Existing retained Result numeric payload: {resident} bytes; new Result Mesh snapshot: {mesh} bytes; these remain resident through preparation. Model/allocator overhead is additional. Total counted peak: {} bytes.", self.estimate.bytes));
        self
    }

    fn enforce(&self, step: &str) -> Result<(), Error> {
        let (steps, every, procedure) = self.transient.expect("solve_run calls this only for transient Steps");
        crate::solve::enforce_transient_budget(&self.estimate, step, procedure, steps, every)
    }
}

/// The Model's amplitude as the procedure's; the two are the same shape in different modules
/// because one is serialised into the Journal and the other is not.
fn amplitude(a: &crate::model::Amplitude) -> procedure::Amplitude {
    match a {
        crate::model::Amplitude::Sine { amplitude, period } => {
            procedure::Amplitude::Sine { amplitude: *amplitude, period: *period }
        }
        crate::model::Amplitude::Table { t, value } => {
            procedure::Amplitude::Table { t: t.clone(), value: value.clone() }
        }
    }
}

impl Engine {
    /// Run one Step and keep its Result under the Model hash it was solved at.
    pub(crate) async fn solve_run(
        &mut self,
        step_name: &str,
        solver: Option<Solver>,
        tolerance: Option<f64>,
        max_iterations: Option<u32>,
        on_progress: OnProgress<'_>,
    ) -> Result<Output, Error> {
        let step = self
            .model
            .step(step_name)
            .ok_or_else(|| Error::not_found("step", step_name, &self.model.names(ObjectKind::Step)))?
            .clone();
        let opts = SolveOptions {
            solver: solver.unwrap_or_default(),
            rel_tol: tolerance.unwrap_or(SolveOptions::default().rel_tol),
            max_iterations: max_iterations.map_or(SolveOptions::default().max_iterations, |n| n as usize),
            ..SolveOptions::default()
        };
        let proc_step = procedure_step(&step, opts)?;
        // A chained Step reads the Result of the Step it names; without a current one it
        // cannot run. The hash check also catches edits whose Mesh happens to keep the same
        // node count, which a field-length check cannot distinguish from a compatible Result.
        let prev = match &step.after {
            Some(name) => {
                let current_hash = crate::hash::result_hash(&self.model);
                let record = self.results.get(name).ok_or_else(|| {
                    Error::new(ErrorCode::NotFound, format!("step '{name}' has no Result to continue from"))
                        .at(format!("step '{}'", step.name))
                        .suggest(format!("solve.run on step '{name}' first"))
                })?;
                if record.input_hash != current_hash {
                    return Err(Error::new(
                        ErrorCode::ResultStale,
                        format!("step '{name}' has a Result that does not match the current Model state"),
                    )
                    .at(format!("step '{}'", step.name))
                    .suggest(format!("solve.run on step '{name}' again")));
                }
                Some(std::sync::Arc::clone(record))
            }
            None => None,
        };
        self.mesh()?;
        let started = self.host.now_ms();
        let mut result = {
            let built = self.mesh.as_ref().expect("built above");
            let p = build_problem_with_temperature(
                &self.model,
                built,
                &step,
                prev.as_ref().and_then(|r| r.result.fields.get(&Field::Temperature)),
            )?;
            if matches!(&proc_step, procedure::Step::HeatTransient { .. } | procedure::Step::Explicit { .. }) {
                planned_cost(p.mesh, Some(&p), &proc_step)?
                    .with_records(self.resident_result_bytes(), crate::retained::mesh_bytes(built))
                    .enforce(&step.name)?;
            }
            let assumptions = result_assumptions(&self.model, built, &step.name, step.procedure, &p);
            let mut result = procedure::run(
                &p,
                &proc_step,
                &self.pool,
                self.gpu.as_ref(),
                prev.as_ref().map(|record| &record.result),
                on_progress,
            )
            .await?;
            result.assumptions = assumptions;
            result
        };
        result.solver.time_ms = self.host.now_ms() - started;
        self.retain_result(step.name.clone(), result);
        Ok(Output::Solve { summary: Box::new(self.result_summary(&step.name)) })
    }

    /// `study.converge`: re-mesh at every size, re-solve the Step, and report the trend
    /// (plan B §2.2).
    ///
    /// The sizes are handed to the mesher by [`crate::mesh::scale_mesher`], whose doc string
    /// says what a size means to each one; the first size names the mesh as it already stands
    /// for the meshers that count divisions rather than measure elements. The rate is the
    /// least-squares slope of the error against `h`, with the Richardson limit over the three
    /// finest meshes standing in for the exact answer, so the two numbers a Benchmark asserts
    /// and the two this Command reports come from one implementation (`post::convergence`).
    ///
    /// The previous mesh settings come back afterwards unless `restore` is false, and with them
    /// whatever Result the Step already had: a study reports a table, it does not silently
    /// replace the Result you were looking at. With `restore: false` the finest run's Result
    /// stays, on the mesh that produced it.
    pub(crate) async fn study_converge(
        &mut self,
        step_name: &str,
        sizes: &[Q<Length>],
        quantity: &QuantityOfInterest,
        restore: Option<bool>,
        on_progress: OnProgress<'_>,
    ) -> Result<Output, Error> {
        let step = self
            .model
            .step(step_name)
            .ok_or_else(|| Error::not_found("step", step_name, &self.model.names(ObjectKind::Step)))?
            .clone();
        if step.procedure == Procedure::Modal {
            return Err(Error::new(
                ErrorCode::Unsupported,
                format!(
                    "step '{}' is modal; a nodal mode amplitude is not a mesh-independent convergence quantity",
                    step.name
                ),
            )
            .at("step.procedure")
            .suggest("solve.run at each mesh and compare the same frequency with query.result"));
        }
        if let Some(previous) = &step.after {
            return Err(Error::new(
                ErrorCode::Unsupported,
                format!(
                    "step '{}' continues '{previous}'; a convergence study must recompute its dependency on each mesh",
                    step.name
                ),
            )
            .at("step.after")
            .suggest("mesh.set, then solve.run on each dependency and the target Step for every refinement"));
        }
        let proc_step = procedure_step(&step, SolveOptions::default())?;
        let (settings, h) = self.study_mesh(sizes)?;
        let mut progress = on_progress;
        let mut rows = Vec::with_capacity(h.len());
        let mut values = Vec::with_capacity(h.len());
        let mut unit = String::new();
        let mut last = None;
        for (i, &size) in h.iter().enumerate() {
            let where_ = display(&self.model, size, Length::DIM);
            report(
                &mut progress,
                "study",
                i as f64 / h.len() as f64,
                &format!("size {} {} ({} of {})", crate::units::fmt_sig(where_.value, 4), where_.unit, i + 1, h.len()),
            )?;
            self.model.mesh = Some(MeshSettings { mesher: scale_mesher(&settings.mesher, h[0], size), ..settings });
            self.mesh = None;
            self.mesh()?;
            let started = self.host.now_ms();
            let (mut result, dofs) = {
                let built = self.mesh.as_ref().expect("built above");
                let p = build_problem(&self.model, built, &step)?;
                let dofs = p.n_dofs() as u64;
                let assumptions = result_assumptions(&self.model, built, &step.name, step.procedure, &p);
                let mut result =
                    procedure::run(&p, &proc_step, &self.pool, self.gpu.as_ref(), None, &mut progress).await?;
                result.assumptions = assumptions;
                (result, dofs)
            };
            result.solver.time_ms = self.host.now_ms() - started;
            let built = self.mesh.as_ref().expect("built above");
            let (value, u) = self.quantity_of(&result, &built.mesh, quantity)?;
            rows.push(StudyRow { size: where_, dofs, value, time_ms: result.solver.time_ms });
            values.push(value);
            unit = u;
            last = Some(result);
        }
        let (extrapolated, _) = richardson(&h, &values);
        let err: Vec<f64> = values.iter().map(|v| (v - extrapolated).abs()).collect();
        let rate = observed_rate(&h, &err);
        if restore == Some(false) {
            self.retain_result(step.name, last.expect("at least two sizes ran"));
        } else {
            self.model.mesh = Some(settings);
            self.mesh = None;
        }
        let report = StudyReport {
            rows,
            observed_rate: Some(rate).filter(|r| r.is_finite()),
            extrapolated: Some(extrapolated).filter(|x| x.is_finite()),
            unit,
        };
        // Kept so `query.report` can append the table to the Step it measured; a study is a
        // measurement of the Model, never part of it, so it is not hashed and not journaled.
        self.studies.insert(step_name.to_string(), report.clone());
        Ok(Output::Study { report })
    }

    /// Mesh inputs shared by a running study and replay that omits its numerical work.
    pub(crate) fn study_mesh(&self, sizes: &[Q<Length>]) -> Result<(MeshSettings, Vec<f64>), Error> {
        let settings = self.model.mesh.clone().ok_or_else(|| {
            Error::new(ErrorCode::ModelIllPosed, "no mesh settings; call mesh.set")
                .suggest("mesh.set { mesher: { kind: \"lattice\", size: \"25 mm\" } }")
        })?;
        if sizes.len() < 2 {
            return Err(
                Error::schema(format!("a convergence study needs at least two sizes, got {}", sizes.len())).at("sizes")
            );
        }
        let mut h = Vec::with_capacity(sizes.len());
        for (i, q) in sizes.iter().enumerate() {
            let s = q.si().map_err(|e| e.at(format!("sizes[{i}]")))?;
            if !(s.is_finite() && s > 0.0) {
                return Err(Error::schema(format!("size {s} must be finite and positive")).at(format!("sizes[{i}]")));
            }
            h.push(s);
        }
        Ok((settings, h))
    }

    /// One [`QuantityOfInterest`] read off a Result, in the Model's display units.
    fn quantity_of(&self, res: &StepResult, mesh: &Mesh, q: &QuantityOfInterest) -> Result<(f64, String), Error> {
        let (field, component) = match q {
            QuantityOfInterest::Max { field, component }
            | QuantityOfInterest::Min { field, component }
            | QuantityOfInterest::Probe { field, component, .. } => (*field, *component),
        };
        let f = res.fields.get(&field).ok_or_else(|| {
            Error::new(ErrorCode::NotFound, format!("the Step produced no {} field", field_name(field)))
                .at("quantity.field")
                .suggest("query.result lists the fields that were computed")
        })?;
        if f.per != crate::post::Per::Node {
            return Err(Error::new(ErrorCode::Unsupported, format!("{} is not a nodal field", field_name(field)))
                .at("quantity.field")
                .suggest("a quantity of interest over displacement, stress, vonMises, principal, strain or reaction"));
        }
        let at = |i: usize| Engine::pick(&f.data[i * f.comps..(i + 1) * f.comps], component);
        let raw = match q {
            QuantityOfInterest::Max { .. } => (0..f.len()).map(at).fold(f64::NEG_INFINITY, f64::max),
            QuantityOfInterest::Min { .. } => (0..f.len()).map(at).fold(f64::INFINITY, f64::min),
            QuantityOfInterest::Probe { at: x, .. } => {
                let point = crate::queries::si3(x).map_err(|e| e.at("quantity.at"))?;
                let (_, v) = crate::post::probe::probe(mesh, f, point).ok_or_else(|| {
                    Error::new(ErrorCode::NotFound, "the point is outside the mesh")
                        .at("quantity.at")
                        .suggest("query.mesh reports bbox")
                })?;
                Engine::pick(&v, component)
            }
        };
        let d = display(&self.model, raw, field_dimension(field, res.reaction_quantity));
        Ok((d.value, d.unit))
    }

    /// The Step a Result Query means by default: the last solved Step in Model order.
    pub(crate) fn last_solved(&self) -> Option<&str> {
        self.model.steps.iter().rev().map(|s| s.name.as_str()).find(|n| self.results.contains_key(*n))
    }

    /// The stored Result of a Step, or `not-found` naming the Steps that have one.
    pub(crate) fn stored<'e>(&'e self, step: Option<&str>) -> Result<(&'e str, &'e String, u32, &'e StepResult), Error> {
        let record = self.result_record(step, None)?;
        Ok((&record.step, &record.input_hash, record.revision, &record.result))
    }

    /// A Result safe to combine with the current Mesh. Node counts alone cannot detect
    /// changed coordinates or connectivity; the Result-validity fingerprint covers every
    /// physics and mesh input while deliberately excluding the display name (ADR 0017).
    pub(crate) fn current_result(&self, step: Option<&str>) -> Result<&StepResult, Error> {
        let (name, hash, _, result) = self.stored(step)?;
        if *hash != crate::hash::result_hash(&self.model) {
            return Err(Error::new(
                ErrorCode::ResultStale,
                format!("step '{name}' has a Result that does not match the current Model state"),
            )
            .at(format!("step '{name}'"))
            .suggest(format!("solve.run on step '{name}' again")));
        }
        Ok(result)
    }

    /// One Result field by its wire name, which is what a host passes through: a `Field`
    /// spelling (`displacement`, `vonMises`, …) or `mode:k` for the k-th mode shape of a modal
    /// Step, counting from 1.
    pub fn field_named(&self, step: Option<&str>, name: &str) -> Result<&crate::post::FieldData, Error> {
        if let Some(k) = name.strip_prefix("mode:") {
            let (step_name, _, _, res) = self.stored(step)?;
            let i: usize = k.parse().unwrap_or(0);
            return res.modes.get(i.wrapping_sub(1)).ok_or_else(|| {
                Error::new(
                    ErrorCode::NotFound,
                    format!("step '{step_name}' has {} mode shapes, not one called '{name}'", res.modes.len()),
                )
                .suggest("query.result lists the frequencies that were computed")
            });
        }
        let which: Field = serde_json::from_str(&format!("\"{name}\""))
            .map_err(|_| Error::schema(format!("'{name}' is not a Result field")).at("field"))?;
        self.field(step, which)
    }

    /// One Result field, for a host that wants the raw array.
    pub fn field(&self, step: Option<&str>, field: Field) -> Result<&crate::post::FieldData, Error> {
        let (name, _, _, res) = self.stored(step)?;
        res.fields.get(&field).ok_or_else(|| {
            Error::new(ErrorCode::NotFound, format!("step '{name}' has no {} field", field_name(field)))
                .suggest("query.result lists the fields that were computed")
        })
    }

    /// `query.result`: what the Step produced, in the Model's display units. The Step must
    /// have a Result: every caller has just stored one or resolved it through [`Engine::stored`].
    pub(crate) fn result_summary(&self, step: &str) -> ResultSummary {
        self.selected_summary(Some(step), None).expect("the caller resolved this Step")
    }

    pub(crate) fn selected_summary(&self, step: Option<&str>, id: Option<&str>) -> Result<ResultSummary, Error> {
        let record = self.result_record(step, id)?;
        let (name, hash, res) = (&record.step, &record.input_hash, &record.result);
        let m = if id.is_some() { &record.model } else { &self.model };
        let applied = ["x", "y", "z"].map(|a| res.scalars[&format!("applied_total_{a}")]);
        let mut sum = applied;
        for (_, r) in &res.reactions {
            for (c, s) in sum.iter_mut().enumerate() {
                *s += r[c];
            }
        }
        let residual = sum.iter().map(|x| x * x).sum::<f64>().sqrt();
        let biggest = res
            .reactions
            .iter()
            .flat_map(|(_, r)| r.iter())
            .chain(applied.iter())
            .fold(f64::MIN_POSITIVE, |acc, x| acc.max(x.abs()));
        Ok(ResultSummary {
            result_id: record.id.clone(),
            step: name.to_string(),
            reaction_quantity: res.reaction_quantity,
            revision: record.revision,
            stale: *hash != crate::hash::result_hash(&self.model),
            solver: res.solver.solver.to_string(),
            iterations: res.solver.iterations as u32,
            residual: res.solver.rel_residual,
            time_ms: res.solver.time_ms,
            extremes: res.extremes.iter().map(|(f, e)| extreme(m, *f, e, res.reaction_quantity)).collect(),
            reactions: res
                .reactions
                .iter()
                .map(|(n, r)| ReactionRow {
                    constraint: n.clone(),
                    total: vec3(m, *r, field_dimension(Field::Reaction, res.reaction_quantity)),
                })
                .collect(),
            applied_total: vec3(m, applied, field_dimension(Field::Reaction, res.reaction_quantity)),
            assumptions: res.assumptions.clone(),
            frequencies: res.frequencies.iter().map(|f| display(m, *f, Frequency::DIM)).collect(),
            history: res
                .history
                .iter()
                .flat_map(crate::procedure::heat::history_extremes)
                .map(|(t, lo, hi)| {
                    let dim = field_dimension(
                        res.history.as_ref().map_or(Field::Temperature, |h| h.field),
                        res.reaction_quantity,
                    );
                    HistoryRow { time: display(m, t, Time::DIM), min: display(m, lo, dim), max: display(m, hi, dim) }
                })
                .collect(),
            balance: residual / biggest,
        })
    }
}

fn vec3(model: &Model, v: [f64; 3], dim: Dimension) -> [Valued; 3] {
    [display(model, v[0], dim), display(model, v[1], dim), display(model, v[2], dim)]
}

fn extreme(model: &Model, field: Field, e: &Extremum, reaction: ReactionQuantity) -> Extreme {
    let dim = field_dimension(field, reaction);
    Extreme {
        field: field_name(field),
        component: e.component as u8,
        min: display(model, e.min, dim),
        min_at: vec3(model, e.min_at, Length::DIM),
        max: display(model, e.max, dim),
        max_at: vec3(model, e.max_at, Length::DIM),
    }
}

/// The point fields `mesh.export` writes in SI. Thermal reactions are `ReactionPower_W`,
/// with removed power in component 0; mechanical `Reaction` remains a force vector in N.
pub fn export_fields(res: &StepResult) -> Vec<(&'static str, usize, Vec<f64>)> {
    [
        ("Displacement", Field::Displacement),
        (
            if res.reaction_quantity == ReactionQuantity::Power { "ReactionPower_W" } else { "Reaction" },
            Field::Reaction,
        ),
        ("Stress", Field::Stress),
        ("VonMises", Field::VonMises),
        ("Temperature", Field::Temperature),
    ]
    .iter()
    .filter_map(|&(label, field)| res.fields.get(&field).map(|f| (label, f.comps, f.data.clone())))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn density_assumption_causes_name_the_procedure_reading_it() {
        assert_eq!(rho_assumption_cause(Procedure::Static, true), Some("gravity read the omitted density as zero"));
        assert_eq!(
            rho_assumption_cause(Procedure::Modal, false),
            Some("modal mass assembly read the omitted density as zero")
        );
        assert_eq!(
            rho_assumption_cause(Procedure::Explicit, false),
            Some("explicit mass assembly read the omitted density as zero")
        );
        for procedure in [Procedure::Static, Procedure::HeatSteady, Procedure::HeatTransient] {
            assert_eq!(rho_assumption_cause(procedure, false), None);
        }
    }

    /// Every Result field reaches a summary in the Model's own units, so every one of them
    /// needs a dimension and a name — including the ones only a later procedure produces.
    #[test]
    fn every_field_has_a_dimension_and_a_wire_name() {
        let all = [
            (Field::Displacement, "displacement", Length::DIM),
            (Field::Reaction, "reaction", Force::DIM),
            (Field::Temperature, "temperature", Temperature::DIM),
            (Field::Strain, "strain", Dimension::NONE),
            (Field::Stress, "stress", Stress::DIM),
            (Field::StressUnaveraged, "stressUnaveraged", Stress::DIM),
            (Field::VonMises, "vonMises", Stress::DIM),
            (Field::Principal, "principal", Stress::DIM),
        ];
        for (field, name, dim) in all {
            assert_eq!(field_name(field), name);
            assert_eq!(field_dimension(field, ReactionQuantity::Force), dim);
        }
    }
}
