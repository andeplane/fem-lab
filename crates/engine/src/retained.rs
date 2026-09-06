//! Immutable solve instances. Records own the context needed to interpret their fields.

use std::sync::Arc;

use crate::engine::Engine;
use crate::error::{Error, ErrorCode};
use crate::mesh::BuiltMesh;
use crate::model::Model;
use crate::procedure::StepResult;

/// Insertion-ordered lifetime; reads never pin a record or extend its lifetime.
pub const RESULT_RETENTION_LIMIT: usize = 8;

pub(crate) struct ResultRecord {
    pub id: String,
    pub step: String,
    pub revision: u32,
    pub model_hash: String,
    pub input_hash: String,
    pub model: Model,
    pub built: BuiltMesh,
    pub result: StepResult,
}

// Decimal digits avoid a finite counter wrapping or making a successful solve fail.
fn next_sequence(sequence: &str) -> String {
    let mut digits = sequence.as_bytes().to_vec();
    for digit in digits.iter_mut().rev() {
        if *digit < b'9' {
            *digit += 1;
            return String::from_utf8(digits).expect("decimal digits remain ASCII");
        }
        *digit = b'0';
    }
    digits.insert(0, b'1');
    String::from_utf8(digits).expect("decimal digits remain ASCII")
}

fn field_location(per: crate::post::Per) -> &'static str {
    match per {
        crate::post::Per::Node => "node",
        crate::post::Per::ElemGp => "elementGaussPoint",
        crate::post::Per::ElemNode => "elementNode",
    }
}

impl Engine {
    /// Only called after a successful solve, with its exact Mesh still installed.
    pub(crate) fn retain_result(&mut self, step: String, result: StepResult) {
        let sequence = next_sequence(&self.next_result);
        let record = Arc::new(ResultRecord {
            id: format!("result-{sequence}"),
            step: step.clone(),
            revision: self.revision() + 1,
            model_hash: self.model_hash(),
            input_hash: crate::hash::result_hash(&self.model),
            model: self.model.clone(),
            built: self.mesh.as_ref().expect("the successful solve built its Mesh").clone(),
            result,
        });
        self.next_result = sequence;
        self.results.insert(step, Arc::clone(&record));
        self.retained.push_back(record);
        if self.retained.len() > RESULT_RETENTION_LIMIT {
            let old = self.retained.pop_front().expect("the retention limit was exceeded");
            if self.results[&old.step].id == old.id {
                self.results.remove(&old.step);
            }
        }
    }

    pub(crate) fn resident_result_bytes(&self) -> u64 {
        self.retained.iter().map(|r| r.field_bytes() + mesh_bytes(&r.built)).sum()
    }

    /// Resets drop records but never recycle their identities within this Engine.
    pub(crate) fn clear_results(&mut self) {
        self.results.clear();
        self.retained.clear();
    }

    pub(crate) fn result_record(&self, step: Option<&str>, id: Option<&str>) -> Result<&ResultRecord, Error> {
        if let Some(id) = id {
            let record = self.retained.iter().find(|record| record.id == id).ok_or_else(|| {
                Error::new(ErrorCode::NotFound, format!("Result '{id}' is not retained by this Engine"))
                    .at("resultId")
                    .suggest("query.results lists retained solve instances")
            })?;
            if step.is_some_and(|step| step != record.step) {
                return Err(Error::schema(format!("Result '{id}' belongs to Step '{}'", record.step))
                    .at("step")
                    .suggest("omit step or use the Step reported by query.results"));
            }
            return Ok(record);
        }
        let step = step
            .or_else(|| self.last_solved())
            .ok_or_else(|| Error::new(ErrorCode::NotFound, "no Step has a retained Result").suggest("solve.run"))?;
        self.results.get(step).map(Arc::as_ref).ok_or_else(|| {
            let known: Vec<&str> = self.results.keys().map(String::as_str).collect();
            Error::not_found("result", step, &known).suggest("solve.run on that Step first")
        })
    }
}

impl ResultRecord {
    pub(crate) fn history(&self) -> Result<&crate::procedure::History, Error> {
        self.result.history.as_ref().ok_or_else(|| {
            Error::new(ErrorCode::Unsupported, format!("Step '{}' has no retained transient frames", self.step))
                .at("step")
                .suggest("solve.run on a heat-transient or explicit Step")
        })
    }

    pub(crate) fn field_bytes(&self) -> u64 {
        let r = &self.result;
        let values = r.fields.values().map(|f| f.data.len()).sum::<usize>()
            + r.modes.iter().map(|f| f.data.len()).sum::<usize>()
            + r.frequencies.len()
            + r.history.as_ref().map_or(0, |h| h.times.len() + h.values.iter().map(Vec::len).sum::<usize>());
        (values * 8) as u64
    }

    fn info(&self, current_hash: &str) -> crate::query::RetainedResult {
        let mesh = &self.built.mesh;
        crate::query::RetainedResult {
            id: self.id.clone(),
            step: self.step.clone(),
            solved_revision: self.revision,
            model_name: self.model.name.clone(),
            model_hash: self.model_hash.clone(),
            input_hash: self.input_hash.clone(),
            stale: self.input_hash != current_hash,
            nodes: mesh.n_nodes(),
            elements: mesh.n_elems(),
            field_bytes: self.field_bytes(),
            mesh_bytes: mesh_bytes(&self.built),
            model_json_bytes: serde_json::to_vec(&self.model).expect("a Model serializes").len() as u64,
        }
    }

    pub(crate) fn named_field(&self, name: &str) -> Result<(&crate::post::FieldData, crate::command::Field), Error> {
        use crate::command::Field;
        if let Some(mode) = name.strip_prefix("mode:") {
            let index: usize = mode.parse().unwrap_or(0);
            return self.result.modes.get(index.wrapping_sub(1)).map(|f| (f, Field::Displacement)).ok_or_else(|| {
                Error::new(ErrorCode::NotFound, format!("Result '{}' has no mode '{name}'", self.id))
                    .at("field")
                    .suggest("query.result lists retained modal frequencies")
            });
        }
        let which: Field = serde_json::from_value(serde_json::Value::String(name.into()))
            .map_err(|_| Error::schema(format!("'{name}' is not a Result field")).at("field"))?;
        self.result.fields.get(&which).map(|f| (f, which)).ok_or_else(|| {
            Error::new(ErrorCode::NotFound, format!("Result '{}' has no {name} field", self.id))
                .at("field")
                .suggest("query.result lists computed fields")
        })
    }
}

impl Engine {
    pub(crate) fn query_results(&self) -> crate::query::RetainedResults {
        let hash = crate::hash::result_hash(&self.model);
        crate::query::RetainedResults {
            limit: RESULT_RETENTION_LIMIT,
            records: self.retained.iter().map(|r| r.info(&hash)).collect(),
        }
    }

    pub(crate) fn selected_record(&self, step: Option<&str>, id: Option<&str>) -> Result<&ResultRecord, Error> {
        if id.is_none() {
            self.current_result(step)?;
        }
        self.result_record(step, id)
    }

    pub(crate) fn query_field(
        &self,
        step: Option<&str>,
        id: Option<&str>,
        name: &str,
    ) -> Result<crate::query::ResultField, Error> {
        let record = self.selected_record(step, id)?;
        let (field, which) = record.named_field(name)?;
        let unit = crate::units::UnitSet::default().resolve().fmt(0.0, crate::solve_run::field_dimension(which)).1;
        Ok(crate::query::ResultField {
            result_id: record.id.clone(),
            step: record.step.clone(),
            field: name.into(),
            components: field.comps,
            node_count: record.built.mesh.n_nodes(),
            per: field_location(field.per).into(),
            entity_count: field.len(),
            unit,
            values: field.data.clone(),
        })
    }
}

/// Logical numeric snapshot payload, excluding allocator and Model metadata overhead.
pub(crate) fn mesh_bytes(built: &BuiltMesh) -> u64 {
    let mesh = &built.mesh;
    let mesh_bytes = mesh.coords.len() * 8
        + mesh.blocks.iter().map(|b| b.conn.len() * 4).sum::<usize>()
        + mesh.node_sets.values().chain(mesh.elem_sets.values()).map(|s| s.len() * 4).sum::<usize>()
        + mesh.face_sets.values().map(|s| std::mem::size_of_val(s.as_slice())).sum::<usize>()
        + built
            .sets
            .values()
            .map(|s| (s.nodes.len() + s.elems.len()) * 4 + std::mem::size_of_val(s.faces.as_slice()))
            .sum::<usize>();
    mesh_bytes as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_advance_without_a_numeric_wrap_boundary() {
        assert_eq!(next_sequence("0"), "1");
        assert_eq!(next_sequence("19"), "20");
        assert_eq!(next_sequence("99"), "100");
        assert_eq!(next_sequence("18446744073709551615"), "18446744073709551616");
    }

    #[test]
    fn field_entity_layout_is_explicit_for_each_storage_location() {
        assert_eq!(field_location(crate::post::Per::Node), "node");
        assert_eq!(field_location(crate::post::Per::ElemGp), "elementGaussPoint");
        assert_eq!(field_location(crate::post::Per::ElemNode), "elementNode");
    }
}
