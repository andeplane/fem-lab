//! Immutable solve instances. Records own the context needed to interpret their fields.

use std::sync::Arc;

use crate::engine::Engine;
use crate::error::{Error, ErrorCode};
use crate::mesh::BuiltMesh;
use crate::model::Model;
use crate::procedure::StepResult;

struct DifferenceInput<'a> {
    record: &'a ResultRecord,
    field: &'a crate::post::FieldData,
    which: crate::command::Field,
    component: Option<u8>,
    name: &'a str,
}

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
            Error::new(ErrorCode::Unsupported, format!("Step '{}' has no retained frames", self.step))
                .at("step")
                .suggest("solve.run on a heat-transient, explicit or amplitude-driven static Step")
        })
    }

    pub(crate) fn field_bytes(&self) -> u64 {
        let r = &self.result;
        let values = r.fields.values().map(|f| f.data.len()).sum::<usize>()
            + r.modes.iter().map(|f| f.data.len()).sum::<usize>()
            + r.frequencies.len()
            + r.history.as_ref().map_or(0, |h| h.times.len() + h.values.iter().map(Vec::len).sum::<usize>())
            + r.sweep.as_ref().map_or(0, |s| {
                s.frequencies.len() + s.amplitude.iter().chain(&s.phase).map(|f| f.data.len()).sum::<usize>()
            });
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

fn difference_input<'a>(
    record: &'a ResultRecord,
    operand: &'a crate::query::DifferenceOperand,
    path: &str,
) -> Result<DifferenceInput<'a>, Error> {
    let (field, which) = record.named_field(&operand.field).map_err(|mut error| {
        error.where_ = Some(format!("{path}.field"));
        if error.suggestion.is_none() {
            error.suggestion = Some("query.result lists fields retained by this solve".into());
        }
        error
    })?;
    if field.per != crate::post::Per::Node || field.data.len() != record.built.mesh.n_nodes() * field.comps {
        return Err(Error::new(ErrorCode::Unsupported, format!("'{}' is not a supported nodal field", operand.field))
            .at(format!("{path}.field"))
            .suggest("query.field reports the field's entity layout"));
    }
    if operand.component.is_some_and(|component| component as usize >= field.comps) {
        return Err(Error::schema(format!(
            "component {} is outside '{}' field layout 0..{}",
            operand.component.unwrap_or(0),
            operand.field,
            field.comps
        ))
        .at(format!("{path}.component"))
        .suggest("omit component for the complete field, or select an index within sourceComponents"));
    }
    Ok(DifferenceInput { record, field, which, component: operand.component, name: &operand.field })
}

fn same_field_topology(left: &femlab_geometry::Mesh, right: &femlab_geometry::Mesh) -> bool {
    left.dim == right.dim
        && left.coords.len() == right.coords.len()
        && left.coords.iter().zip(&right.coords).all(|(a, b)| a.to_bits() == b.to_bits())
        && left.blocks == right.blocks
}

fn selected_at(field: &crate::post::FieldData, node: usize, component: Option<u8>) -> Vec<f64> {
    let row = &field.data[node * field.comps..(node + 1) * field.comps];
    match component {
        Some(component) => vec![row[component as usize]],
        None => row.to_vec(),
    }
}

fn finite_difference(left: f64, right: f64, node: usize, component: usize) -> Result<f64, Error> {
    let value = left - right;
    if value.is_finite() {
        Ok(value)
    } else {
        Err(Error::new(
            ErrorCode::Unsupported,
            format!("left minus right is nonfinite at comparison node {node}, component {component}"),
        )
        .at(format!("values[{node}][{component}]"))
        .suggest("compare Results whose SI difference remains within the finite f64 range"))
    }
}

fn resolved_operand(input: &DifferenceInput<'_>) -> crate::query::ResolvedDifferenceOperand {
    crate::query::ResolvedDifferenceOperand {
        result_id: input.record.id.clone(),
        step: input.record.step.clone(),
        field: input.name.into(),
        component: input.component,
        source_components: input.field.comps,
    }
}

fn projected_at(
    mesh: &femlab_geometry::Mesh,
    field: &crate::post::FieldData,
    component: Option<u8>,
    point: [f64; 3],
) -> Result<Option<Vec<f64>>, Error> {
    crate::post::probe::probe_checked(mesh, field, point)
        .map_err(|element| {
            Error::new(
                ErrorCode::Unsupported,
                format!("isoparametric point location failed in source element {element}"),
            )
            .at("onto")
            .suggest("inspect the retained source Mesh for a degenerate or unsupported element")
        })
        .map(|sample| {
            sample.map(|(_, value)| match component {
                Some(component) => vec![value[component as usize]],
                None => value,
            })
        })
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
        let unit = crate::units::UnitSet::default()
            .resolve()
            .fmt(0.0, crate::solve_run::field_dimension(which, record.result.reaction_quantity))
            .1;
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

    pub(crate) fn query_difference(
        &self,
        left_spec: &crate::query::DifferenceOperand,
        right_spec: &crate::query::DifferenceOperand,
        onto: crate::query::DifferenceOnto,
    ) -> Result<crate::query::DifferenceField, Error> {
        let left_record = self.selected_record(None, Some(&left_spec.result_id)).map_err(|mut error| {
            error.where_ = Some("left.resultId".into());
            error
        })?;
        let right_record = self.selected_record(None, Some(&right_spec.result_id)).map_err(|mut error| {
            error.where_ = Some("right.resultId".into());
            error
        })?;
        let left = difference_input(left_record, left_spec, "left")?;
        let right = difference_input(right_record, right_spec, "right")?;
        if left.component.is_some() != right.component.is_some() {
            let path = if left.component.is_none() { "left.component" } else { "right.component" };
            return Err(Error::schema("component must be supplied for both operands or omitted for both")
                .at(path)
                .suggest("select one scalar component on each side, or compare both complete layouts"));
        }
        if left.component.is_none() && left.field.comps != right.field.comps {
            return Err(Error::new(
                ErrorCode::Unsupported,
                format!("complete field layouts differ: {} and {} components", left.field.comps, right.field.comps),
            )
            .at("right.field")
            .suggest("select one explicit component from each field"));
        }
        let dimension = crate::solve_run::field_dimension(left.which, left.record.result.reaction_quantity);
        if crate::solve_run::field_dimension(right.which, right.record.result.reaction_quantity) != dimension {
            return Err(Error::new(
                ErrorCode::UnitDimension,
                format!("'{}' and '{}' carry different physical dimensions", left.name, right.name),
            )
            .at("right.field")
            .suggest("select fields with the same physical dimension"));
        }
        let left_mesh = &left.record.built.mesh;
        let right_mesh = &right.record.built.mesh;
        if left_mesh.dim != right_mesh.dim {
            return Err(Error::new(
                ErrorCode::Unsupported,
                format!("cannot compare a {}D Mesh with a {}D Mesh", left_mesh.dim, right_mesh.dim),
            )
            .at("onto")
            .suggest("compare Results with the same Model idealisation"));
        }
        let direct = same_field_topology(left_mesh, right_mesh);
        let (target, source, target_is_left) = match onto {
            crate::query::DifferenceOnto::Left => (&left, &right, true),
            crate::query::DifferenceOnto::Right => (&right, &left, false),
        };
        let components = if left.component.is_some() { 1 } else { left.field.comps };
        let total_nodes = target.record.built.mesh.n_nodes();
        let mut values = Vec::with_capacity(total_nodes * components);
        let mut outside_nodes = Vec::new();
        let sampled = (0..total_nodes).try_for_each(|node| {
            let target_value = selected_at(target.field, node, target.component);
            let source_value = if direct {
                Ok(Some(selected_at(source.field, node, source.component)))
            } else {
                let point = target.record.built.mesh.node(node as u32);
                projected_at(&source.record.built.mesh, source.field, source.component, point)
            };
            source_value.and_then(|source_value| {
                if let Some(source_value) = source_value {
                    for (component, (target, source)) in target_value.iter().zip(source_value).enumerate() {
                        let (left_value, right_value) =
                            if target_is_left { (*target, source) } else { (source, *target) };
                        values.push(Some(finite_difference(left_value, right_value, node, component)?));
                    }
                } else {
                    outside_nodes.push(node as u32);
                    values.extend((0..components).map(|_| None));
                }
                Ok(())
            })
        });
        sampled.map(|()| {
            let warnings = if left.name.starts_with("mode:") || right.name.starts_with("mode:") {
                vec![crate::error::Warning {
                    code: "result.mode-uncorrelated".into(),
                    text: "Modal signs and ordering are not correlated; values are raw left minus right without sign alignment"
                        .into(),
                    where_: Some("left.field/right.field".into()),
                }]
            } else {
                Vec::new()
            };
            let inside_nodes = total_nodes - outside_nodes.len();
            crate::query::DifferenceField {
                left: resolved_operand(&left),
                right: resolved_operand(&right),
                comparison_result_id: target.record.id.clone(),
                components,
                node_count: total_nodes,
                unit: crate::units::UnitSet::default().resolve().fmt(0.0, dimension).1,
                values,
                interpolated: !direct,
                coverage: crate::query::DifferenceCoverage { inside_nodes, total_nodes, outside_nodes },
                warnings,
            }
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
    use femlab_geometry::{split_to_simplices, ElementKind, Structured};

    fn retain_test_temperature(engine: &mut Engine, step: &str, mesh: femlab_geometry::Mesh, value: f64) {
        let nodes = mesh.n_nodes();
        engine.mesh =
            Some(BuiltMesh { mesh, body_of_block: vec!["body".into()], sets: Default::default(), points: Vec::new() });
        let mut result = crate::procedure::blank(crate::solve::SolveInfo {
            solver: "test",
            iterations: 0,
            rel_residual: 0.0,
            time_ms: 0.0,
        });
        result.fields.insert(
            crate::command::Field::Temperature,
            crate::post::FieldData::new(crate::post::Per::Node, 1, vec![value; nodes]),
        );
        engine.retain_result(step.into(), result);
    }

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

    #[test]
    fn topology_identity_includes_connectivity_and_projection_reports_locator_failure() {
        let hex = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0, 1.0, 1.0]);
        let tetrahedra = split_to_simplices(&hex);
        assert_eq!(hex.coords, tetrahedra.coords);
        assert!(!same_field_topology(&hex, &tetrahedra));

        let mut degenerate = hex.clone();
        degenerate.coords.fill(0.0);
        let mut engine = Engine::new(None, Box::new(crate::engine::NoClock), 1);
        retain_test_temperature(&mut engine, "degenerate", degenerate, 0.0);
        retain_test_temperature(&mut engine, "valid", hex, 0.0);
        let error = engine
            .query_difference(
                &crate::query::DifferenceOperand {
                    result_id: "result-1".into(),
                    field: "temperature".into(),
                    component: None,
                },
                &crate::query::DifferenceOperand {
                    result_id: "result-2".into(),
                    field: "temperature".into(),
                    component: None,
                },
                crate::query::DifferenceOnto::Right,
            )
            .expect_err("a singular source map cannot be reported as outside coverage");
        assert_eq!((error.code, error.where_.as_deref()), (ErrorCode::Unsupported, Some("onto")));
        assert!(error.cause.contains("element 0"));
    }

    #[test]
    fn difference_overflow_is_a_structured_error_instead_of_a_null_inside_value() {
        assert_eq!(finite_difference(3.0, 1.0, 0, 0).unwrap(), 2.0);
        let mesh = Structured { kind: ElementKind::Hex8, n: [1, 1, 1] }.box_([1.0; 3]);
        let mut engine = Engine::new(None, Box::new(crate::engine::NoClock), 1);
        for (step, value) in [("left", f64::MAX), ("right", -f64::MAX)] {
            retain_test_temperature(&mut engine, step, mesh.clone(), value);
        }
        let error = engine
            .query_difference(
                &crate::query::DifferenceOperand {
                    result_id: "result-1".into(),
                    field: "temperature".into(),
                    component: None,
                },
                &crate::query::DifferenceOperand {
                    result_id: "result-2".into(),
                    field: "temperature".into(),
                    component: None,
                },
                crate::query::DifferenceOnto::Left,
            )
            .expect_err("finite retained operands can overflow");
        assert_eq!((error.code, error.where_.as_deref()), (ErrorCode::Unsupported, Some("values[0][0]")));
        assert!(error.cause.contains("nonfinite"));
        assert!(error.suggestion.is_some());
    }
}
