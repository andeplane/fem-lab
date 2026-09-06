//! `solve.run`: the Model, the Mesh and a Step turned into a `Problem`, solved, and reported.
//!
//! This is the seam between the registry and the numerics. Everything above it speaks names,
//! Sets and `Quantity`; everything below it speaks SI `f64` on a Mesh (plan A §6, plan B §2.1).
//! Results are kept per Step with the Model hash they were solved at, so an edit does not throw
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
use crate::post::Extremum;
use crate::procedure::{self, report, StepResult};
use crate::query::{Extreme, HistoryRow, Output, ReactionRow, ResultSummary, StudyReport, StudyRow, Valued};
use crate::solve::SolveOptions;
use crate::units::{Dim, Dimension, Force, Frequency, Length, Stress, Temperature, Time, Q};

/// The material law every Model material resolves to for now; plugins add their own later.
const LAW: &str = "linear-elastic";

/// The dimension a Result field carries, so a summary reports it in the Model's own units.
pub fn field_dimension(field: Field) -> Dimension {
    match field {
        Field::Displacement => Length::DIM,
        Field::Reaction => Force::DIM,
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
            LoadKind::Temperature { bodies, value, reference } => {
                let mut nodal = vec![*reference; built.mesh.n_nodes()];
                let heated = built.body_of_block.iter().enumerate().filter(|(_, body)| bodies.contains(body));
                for (b, _) in heated {
                    for &node in &built.mesh.blocks[b].conn {
                        nodal[node as usize] = *value;
                    }
                }
                p.temperature = Some((nodal, *reference));
            }
            LoadKind::Convection { on, h, t_inf } => {
                heat_loads.push(HeatLoad::Convection { faces: on.clone(), h: *h, t_inf: *t_inf });
            }
            LoadKind::HeatFlux { on, q } => heat_loads.push(HeatLoad::Flux { faces: on.clone(), q: *q }),
            LoadKind::HeatSource { bodies, q } => {
                heat_loads.push(HeatLoad::Source { bodies: bodies.clone(), q: *q });
            }
        }
    }
    p.loads = loads;
    p.heat_loads = heat_loads;
    Ok(p)
}

/// The wire name of a procedure, from serde's rename.
pub fn procedure_name(p: Procedure) -> String {
    serde_json::to_string(&p).unwrap_or_default().trim_matches('"').to_string()
}

/// The `procedure::Step` a Model Step means: the fields that procedure reads, and the defaults
/// plan A names for the ones the Command left out. A missing `dt` or `tEnd` is a schema error
/// naming the field, because a transient with no clock is not a Step anybody meant.
fn procedure_step(step: &Step, opts: SolveOptions) -> Result<procedure::Step, Error> {
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
        Procedure::HeatSteady => procedure::Step::HeatSteady { solver: opts },
        Procedure::HeatTransient => procedure::Step::HeatTransient {
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
        // A chained Step reads the Result of the Step it names; without one it cannot run.
        let prev = match &step.after {
            Some(name) => Some(self.results.get(name).map(|(_, _, r)| r.clone()).ok_or_else(|| {
                Error::new(ErrorCode::NotFound, format!("step '{name}' has no Result to continue from"))
                    .at(format!("step '{}'", step.name))
                    .suggest(format!("solve.run on step '{name}' first"))
            })?),
            None => None,
        };
        self.mesh()?;
        let started = self.host.now_ms();
        let mut result = {
            let built = self.mesh.as_ref().expect("built above");
            let mut p = build_problem(&self.model, built, &step)?;
            // Thermal → structural: the previous Step's temperature becomes this one's field,
            // keeping the reference a `load.temperature` in this Step set (plan A §6).
            if let Some(t) = prev.as_ref().and_then(|r| r.fields.get(&Field::Temperature)) {
                let t_ref = p.temperature.as_ref().map_or(293.15, |(_, r)| *r);
                p.temperature = Some((t.component(0), t_ref));
            }
            procedure::run(&p, &proc_step, &self.pool, self.gpu.as_ref(), prev.as_ref(), on_progress).await?
        };
        result.solver.time_ms = self.host.now_ms() - started;
        let hash = self.model_hash();
        self.results.insert(step.name.clone(), (hash, self.revision(), result));
        Ok(Output::Solve { summary: self.result_summary(&step.name) })
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
            let mut result = {
                let built = self.mesh.as_ref().expect("built above");
                let p = build_problem(&self.model, built, &step)?;
                let procedure_step = procedure::Step::Static { solver: SolveOptions::default() };
                procedure::run(&p, &procedure_step, &self.pool, self.gpu.as_ref(), None, &mut progress).await?
            };
            result.solver.time_ms = self.host.now_ms() - started;
            let built = self.mesh.as_ref().expect("built above");
            let (value, u) = self.quantity_of(&result, &built.mesh, quantity)?;
            rows.push(StudyRow {
                size: where_,
                dofs: (built.mesh.n_nodes() * built.mesh.dim) as u64,
                value,
                time_ms: result.solver.time_ms,
            });
            values.push(value);
            unit = u;
            last = Some(result);
        }
        let (extrapolated, _) = richardson(&h, &values);
        let err: Vec<f64> = values.iter().map(|v| (v - extrapolated).abs()).collect();
        let rate = observed_rate(&h, &err);
        if restore == Some(false) {
            let hash = self.model_hash();
            self.results.insert(step.name, (hash, self.revision(), last.expect("at least two sizes ran")));
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
        let d = display(&self.model, raw, field_dimension(field));
        Ok((d.value, d.unit))
    }

    /// The Step a Result Query means by default: the last solved Step in Model order.
    pub(crate) fn last_solved(&self) -> Option<&str> {
        self.model.steps.iter().rev().map(|s| s.name.as_str()).find(|n| self.results.contains_key(*n))
    }

    /// The stored Result of a Step, or `not-found` naming the Steps that have one.
    pub(crate) fn stored<'e>(
        &'e self,
        step: Option<&str>,
    ) -> Result<(&'e str, &'e String, u32, &'e StepResult), Error> {
        let name: &'e str = match step {
            Some(n) => self.results.get_key_value(n).map(|(k, _)| k.as_str()).unwrap_or(""),
            None => self
                .last_solved()
                .ok_or_else(|| Error::new(ErrorCode::NotFound, "no Step has been solved yet").suggest("solve.run"))?,
        };
        let known: Vec<&str> = self.results.keys().map(String::as_str).collect();
        let (hash, revision, res) = self.results.get(name).ok_or_else(|| {
            Error::not_found("result", step.unwrap_or(name), &known).suggest("solve.run on that Step first")
        })?;
        Ok((name, hash, *revision, res))
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
        let (name, hash, revision, res) = self.stored(Some(step)).expect("the caller resolved this Step");
        let m = &self.model;
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
        ResultSummary {
            step: name.to_string(),
            revision,
            stale: *hash != self.model_hash(),
            solver: res.solver.solver.to_string(),
            iterations: res.solver.iterations as u32,
            residual: res.solver.rel_residual,
            time_ms: res.solver.time_ms,
            extremes: res.extremes.iter().map(|(f, e)| extreme(m, *f, e)).collect(),
            reactions: res
                .reactions
                .iter()
                .map(|(n, r)| ReactionRow { constraint: n.clone(), total: vec3(m, *r, Force::DIM) })
                .collect(),
            applied_total: vec3(m, applied, Force::DIM),
            frequencies: res.frequencies.iter().map(|f| display(m, *f, Frequency::DIM)).collect(),
            history: res
                .history
                .iter()
                .flat_map(crate::procedure::heat::history_extremes)
                .map(|(t, lo, hi)| {
                    let dim = field_dimension(res.history.as_ref().map_or(Field::Temperature, |h| h.field));
                    HistoryRow { time: display(m, t, Time::DIM), min: display(m, lo, dim), max: display(m, hi, dim) }
                })
                .collect(),
            balance: residual / biggest,
        }
    }
}

fn vec3(model: &Model, v: [f64; 3], dim: Dimension) -> [Valued; 3] {
    [display(model, v[0], dim), display(model, v[1], dim), display(model, v[2], dim)]
}

fn extreme(model: &Model, field: Field, e: &Extremum) -> Extreme {
    let dim = field_dimension(field);
    Extreme {
        field: field_name(field),
        component: e.component as u8,
        min: display(model, e.min, dim),
        min_at: vec3(model, e.min_at, Length::DIM),
        max: display(model, e.max, dim),
        max_at: vec3(model, e.max_at, Length::DIM),
    }
}

/// The point fields `mesh.export` writes for a Step: what ParaView colours by.
pub fn export_fields(res: &StepResult) -> Vec<(&'static str, usize, Vec<f64>)> {
    [
        ("Displacement", Field::Displacement),
        ("Reaction", Field::Reaction),
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
            assert_eq!(field_dimension(field), dim);
        }
    }
}
