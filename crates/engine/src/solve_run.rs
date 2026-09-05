//! `solve.run`: the Model, the Mesh and a Step turned into a `Problem`, solved, and reported.
//!
//! This is the seam between the registry and the numerics. Everything above it speaks names,
//! Sets and `Quantity`; everything below it speaks SI `f64` on a Mesh (plan A §6, plan B §2.1).
//! Results are kept per Step with the Model hash they were solved at, so an edit does not throw
//! them away — it makes them *stale*, which `query.result` says out loud.

use crate::command::{Field, ObjectKind, Procedure, Solver};
use crate::engine::{display, Engine, OnProgress};
use crate::error::{Error, ErrorCode};
use crate::fem::element::Material;
use crate::fem::loads::{face_set_area, Load};
use crate::fem::problem::{Constraint, Problem};
use crate::mesh::BuiltMesh;
use crate::model::{ConstraintKind, LoadKind, Model, Step};
use crate::post::Extremum;
use crate::procedure::{self, StepResult};
use crate::query::{Extreme, Output, ReactionRow, ResultSummary, Valued};
use crate::solve::SolveOptions;
use crate::units::{Dim, Dimension, Force, Length, Stress, Temperature};

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
            let name = model.body(body).and_then(|b| b.material.as_deref())?;
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
    };
    let mut loads = Vec::with_capacity(step.loads.len());
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
        }
    }
    p.loads = loads;
    Ok(p)
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
        };
        let procedure_step = match step.procedure {
            Procedure::Static => procedure::Step::Static { solver: opts },
        };
        self.mesh()?;
        let started = self.host.now_ms();
        let mut result = {
            let built = self.mesh.as_ref().expect("built above");
            let p = build_problem(&self.model, built, &step)?;
            procedure::run(&p, &procedure_step, &self.pool, self.gpu.as_ref(), None, on_progress).await?
        };
        result.solver.time_ms = self.host.now_ms() - started;
        let hash = self.model_hash();
        self.results.insert(step.name.clone(), (hash, result));
        Ok(Output::Solve { summary: self.result_summary(&step.name) })
    }

    /// The Step a Result Query means by default: the last solved Step in Model order.
    pub(crate) fn last_solved(&self) -> Option<&str> {
        self.model.steps.iter().rev().map(|s| s.name.as_str()).find(|n| self.results.contains_key(*n))
    }

    /// The stored Result of a Step, or `not-found` naming the Steps that have one.
    pub(crate) fn stored<'e>(&'e self, step: Option<&str>) -> Result<(&'e str, &'e String, &'e StepResult), Error> {
        let name: &'e str = match step {
            Some(n) => self.results.get_key_value(n).map(|(k, _)| k.as_str()).unwrap_or(""),
            None => self
                .last_solved()
                .ok_or_else(|| Error::new(ErrorCode::NotFound, "no Step has been solved yet").suggest("solve.run"))?,
        };
        let known: Vec<&str> = self.results.keys().map(String::as_str).collect();
        let (hash, res) = self.results.get(name).ok_or_else(|| {
            Error::not_found("result", step.unwrap_or(name), &known).suggest("solve.run on that Step first")
        })?;
        Ok((name, hash, res))
    }

    /// One Result field, for a host that wants the raw array.
    pub fn field(&self, step: Option<&str>, field: Field) -> Result<&crate::post::FieldData, Error> {
        let (name, _, res) = self.stored(step)?;
        res.fields.get(&field).ok_or_else(|| {
            Error::new(ErrorCode::NotFound, format!("step '{name}' has no {} field", field_name(field)))
                .suggest("query.result lists the fields that were computed")
        })
    }

    /// `query.result`: what the Step produced, in the Model's display units. The Step must
    /// have a Result: every caller has just stored one or resolved it through [`Engine::stored`].
    pub(crate) fn result_summary(&self, step: &str) -> ResultSummary {
        let (name, hash, res) = self.stored(Some(step)).expect("the caller resolved this Step");
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
            revision: self.revision(),
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
