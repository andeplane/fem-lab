//! Host-independent retained simulation artifacts. No I/O and no numerical re-solving.
use crate::post::{FieldData, Per};
use crate::procedure::StepResult;
use crate::retained::{ResultRecord, RESULT_RETENTION_LIMIT};
use crate::{BuiltMesh, Engine, Error, Model, ModelFile};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, sync::Arc};

pub const MAX_PORTABLE_PROJECT_BYTES: usize = 64 * 1024 * 1024;
pub const PORTABLE_PROJECT_FORMAT: &str = "femlab-project/1";

/// Full input document and the bounded insertion-ordered retained solve cache. All numerical
/// arrays are scientific f64 SI values, never renderer buffers. Host files are stored separately.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableProject {
    pub format: String,
    pub engine_version: String,
    pub file: ModelFile,
    pub results: Vec<PortableResult>,
    /// Decimal insertion sequence, retained even when the result cache is empty.
    pub next_result: String,
    /// Retained convergence and adaptation report tables, keyed by Step.
    pub studies: std::collections::BTreeMap<String, crate::query::StudyReport>,
    pub adaptations: std::collections::BTreeMap<String, crate::query::AdaptReport>,
}

/// Immutable solve identity and complete solved context. Hashes identify input provenance;
/// they are integrity checks, not a signature or a certification of numerical correctness.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableResult {
    pub id: String,
    pub step: String,
    pub revision: u32,
    pub model_hash: String,
    pub input_hash: String,
    pub model: Model,
    pub built: BuiltMesh,
    pub result: StepResult,
}

fn invalid(cause: impl Into<String>) -> Error {
    Error::schema(cause).at("portable").suggest("open an intact portable project exported by this engine version")
}
fn sequence(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value.bytes().all(|b| b.is_ascii_digit())
        && (value.len() == 1 || !value.starts_with('0'))
}
fn sequence_le(left: &str, right: &str) -> bool {
    left.len() < right.len() || (left.len() == right.len() && left <= right)
}

impl PortableProject {
    /// Reject oversized UTF-8 input before allocating a deserialized archive.
    pub fn from_json(text: &str) -> Result<Self, Error> {
        if text.len() > MAX_PORTABLE_PROJECT_BYTES {
            return Err(invalid("portable project exceeds the 64 MiB UTF-8 limit"));
        }
        serde_json::from_str(text).map_err(Error::from)
    }
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if self.format != PORTABLE_PROJECT_FORMAT || self.engine_version != crate::version() {
            return Err(invalid("unsupported portable format or engine version"));
        }
        if self.results.len() > RESULT_RETENTION_LIMIT || !sequence(&self.next_result) {
            return Err(invalid("invalid result retention count or sequence"));
        }
        if serde_json::to_vec(self).expect("a typed portable project serializes").len() > MAX_PORTABLE_PROJECT_BYTES {
            return Err(invalid("portable project exceeds the 64 MiB UTF-8 limit"));
        }
        let reports = (&self.studies, &self.adaptations);
        let normalized: (
            std::collections::BTreeMap<String, crate::query::StudyReport>,
            std::collections::BTreeMap<String, crate::query::AdaptReport>,
        ) = serde_json::from_slice(&serde_json::to_vec(&reports).expect("typed retained report tables serialize"))?;
        // Study optional scalars could deserialize a nonfinite typed value as None. All
        // adaptation scalars are required, so their nonfinite values fail deserialization.
        if normalized.0 != self.studies {
            return Err(invalid("nonfinite retained report metadata"));
        }
        let mut previous = "0";
        for record in &self.results {
            let ordinal = record.id.strip_prefix("result-").unwrap_or("");
            if !sequence(ordinal) || !sequence_le(ordinal, &self.next_result) || sequence_le(ordinal, previous) {
                return Err(invalid("duplicate, unordered or invalid retained result identity"));
            }
            previous = ordinal;
            record.validate()?;
        }
        Ok(())
    }
}

impl Engine {
    pub fn export_project(&self) -> Result<PortableProject, Error> {
        let project = PortableProject {
            format: PORTABLE_PROJECT_FORMAT.into(),
            engine_version: crate::version().into(),
            file: self.export_file(),
            next_result: self.next_result.clone(),
            studies: self.studies.clone(),
            adaptations: self.adaptations.clone(),
            results: self
                .retained
                .iter()
                .map(|r| PortableResult {
                    id: r.id.clone(),
                    step: r.step.clone(),
                    revision: r.revision,
                    model_hash: r.model_hash.clone(),
                    input_hash: r.input_hash.clone(),
                    model: r.model.clone(),
                    built: r.built.clone(),
                    result: r.result.clone(),
                })
                .collect(),
        };
        if serde_json::to_vec(&project).expect("a typed portable project serializes").len() > MAX_PORTABLE_PROJECT_BYTES
        {
            return Err(invalid("portable project exceeds the 64 MiB UTF-8 limit"));
        }
        Ok(project)
    }
    /// Called only inside an unpublished Candidate, after every record has been checked.
    pub(crate) fn install_portable_results(&mut self, project: PortableProject) -> Result<(), Error> {
        let mut retained = std::collections::VecDeque::new();
        let mut results = std::collections::BTreeMap::new();
        for r in project.results {
            let record = Arc::new(ResultRecord {
                id: r.id,
                step: r.step,
                revision: r.revision,
                model_hash: r.model_hash,
                input_hash: r.input_hash,
                model: r.model,
                built: r.built,
                result: r.result,
            });
            let summary = self.summarize_record(&record, &record.model)?;
            let _: crate::query::ResultSummary =
                serde_json::from_slice(&serde_json::to_vec(&summary).expect("a typed Result summary serializes"))?;
            results.insert(record.step.clone(), Arc::clone(&record));
            retained.push_back(record);
        }
        self.results = results;
        self.retained = retained;
        self.next_result = project.next_result;
        self.studies = project.studies;
        self.adaptations = project.adaptations;
        Ok(())
    }
}

fn finite(values: &[f64]) -> Result<(), Error> {
    if values.iter().all(|v| v.is_finite()) {
        Ok(())
    } else {
        Err(invalid("nonfinite retained numerical value"))
    }
}
impl PortableResult {
    fn validate(&self) -> Result<(), Error> {
        if self.model_hash != crate::hash::model_hash(&self.model)
            || self.input_hash != crate::hash::result_hash(&self.model)
            || !self.model.steps.iter().any(|s| s.name == self.step)
        {
            return Err(invalid("retained solved model provenance does not match"));
        }
        let b = &self.built;
        let m = &b.mesh;
        m.validate().map_err(|e| invalid(e.to_string()))?;
        finite(&m.coords)?;
        let (nodes, elements) = (m.n_nodes(), m.n_elems());
        let owners: BTreeSet<_> =
            self.model.bodies.iter().map(|b| b.name.as_str()).chain(self.model.meshed_body_names()).collect();
        if nodes == 0
            || elements == 0
            || nodes > 1_000_000
            || elements > 1_000_000
            || b.body_of_block.len() != m.blocks.len()
            || m.dim != self.model.idealisation.dim()
            || b.body_of_block.iter().any(|s| !owners.contains(s.as_str()))
            || b.points.len() != self.model.points.len()
            || b.points.iter().any(|&n| n as usize >= nodes)
            || (!b.directors.is_empty() && b.directors.len() != elements)
            || b.source_labels.nodes.len() > nodes
            || (!b.source_labels.elements.is_empty() && b.source_labels.elements.len() != elements)
        {
            return Err(invalid("retained mesh ownership or layout is invalid"));
        }
        for directors in &b.directors {
            for director in directors {
                finite(director)?;
            }
        }
        for set in b.sets.values() {
            if set.nodes.iter().any(|&n| n as usize >= nodes)
                || set.elems.iter().any(|&e| e as usize >= elements)
                || !set.nodes.is_sorted_by(|a, b| a < b)
                || !set.elems.is_sorted_by(|a, b| a < b)
                || !set.faces.is_sorted_by(|a, b| a < b)
                || set
                    .faces
                    .iter()
                    .any(|f| f.elem as usize >= elements || f.local as usize >= m.kind_of(f.elem).n_faces())
            {
                return Err(invalid("retained resolved Set contains invalid indices"));
            }
        }
        let r = &self.result;
        for name in ["applied_total_x", "applied_total_y", "applied_total_z"] {
            if !r.scalars.contains_key(name) {
                return Err(invalid("missing retained applied total"));
            }
        }
        if r.scalars.contains_key("storage_power") && !r.scalars.contains_key("power_balance_scale") {
            return Err(invalid("missing retained power balance scale"));
        }
        // Reject nonfinite Model parameters even for a directly constructed typed archive.
        let normalized: Model =
            serde_json::from_slice(&serde_json::to_vec(&self.model).expect("a typed Model serializes"))?;
        if normalized != self.model {
            return Err(invalid("nonfinite retained Model parameter"));
        }
        for assumption in &r.assumptions {
            finite(&[assumption.value.value])?;
        }
        let element_nodes: usize = m.blocks.iter().map(|b| b.conn.len()).sum();
        let field = |f: &FieldData| -> Result<(), Error> {
            // Callers first check each named field's fixed location/component contract.
            let entities = if f.per == Per::Node {
                nodes
            } else if f.per == Per::Element {
                elements
            } else {
                element_nodes
            };
            if f.data.len() != entities * f.comps {
                return Err(invalid("retained field components or length do not match the solved Mesh"));
            }
            finite(&f.data)
        };
        use crate::command::Field;
        for (name, f) in &r.fields {
            let (per, comps) = match name {
                Field::Stress | Field::Strain => (Per::Node, 6),
                Field::StressUnaveraged | Field::StressTop | Field::StressBottom | Field::ShellMoment => {
                    (Per::ElemNode, 6)
                }
                Field::SectionForce | Field::SectionMoment => (Per::ElemNode, 3),
                Field::ErrorEstimate => (Per::Element, 1),
                Field::VonMises | Field::PlasticStrain | Field::ContactPressure => (Per::Node, 1),
                _ => (Per::Node, 3),
            };
            if f.per != per || f.comps != comps {
                return Err(invalid("retained named field has an incompatible layout"));
            }
            field(f)?;
        }
        for f in &r.modes {
            if f.per != Per::Node || f.comps != 3 {
                return Err(invalid("invalid retained mode field layout"));
            }
            field(f)?;
        }
        for f in r.ply_stresses.iter().flat_map(|p| &p.faces) {
            if f.per != Per::ElemNode || f.comps != 6 {
                return Err(invalid("invalid retained ply stress layout"));
            }
            field(f)?;
        }
        for (_, x) in &r.extremes {
            finite(&[x.min, x.max])?;
            finite(&x.min_at)?;
            finite(&x.max_at)?;
        }
        for p in &r.ply_stresses {
            for xs in &p.extremes {
                for x in xs {
                    finite(&[x.min, x.max])?;
                    finite(&x.min_at)?;
                    finite(&x.max_at)?;
                }
            }
        }
        for value in r.scalars.values() {
            finite(&[*value])?;
        }
        finite(&r.frequencies)?;
        finite(&r.buckling_factors)?;
        use crate::command::Procedure;
        let procedure = self.model.step(&self.step).expect("validated retained Step").procedure;
        let expected_modes = match procedure {
            Procedure::Modal => r.frequencies.len(),
            Procedure::Buckling => r.buckling_factors.len(),
            _ => 0,
        };
        let expected_dofs = if procedure == Procedure::Modal { r.frequencies.len() } else { 0 };
        if r.modes.len() != expected_modes
            || r.modal_dofs.len() != expected_dofs
            || (procedure != Procedure::Modal
                && procedure != Procedure::Harmonic
                && procedure != Procedure::RandomVibration
                && !r.frequencies.is_empty())
            || (procedure != Procedure::Buckling && !r.buckling_factors.is_empty())
        {
            return Err(invalid("retained modal arrays have inconsistent lengths"));
        }
        let structural_values = nodes * crate::fem::problem::mesh_dofs_per_node(m, &self.model.idealisation);
        for v in &r.modal_dofs {
            if v.len() != structural_values {
                return Err(invalid("invalid modal DOF layout"));
            }
            finite(v)?;
        }
        for (_, v) in &r.reactions {
            finite(v)?;
        }
        for c in &r.contacts {
            finite(&c.force)?;
            if c.nodes.iter().any(|&n| n as usize >= nodes) {
                return Err(invalid("invalid retained contact node"));
            }
        }
        if let Some(h) = &r.history {
            finite(&h.times)?;
            if h.times.is_empty() || h.times.len() != h.values.len() || !h.times.is_sorted_by(|a, b| a < b) {
                return Err(invalid("invalid retained frame schedule"));
            }
            let size = match h.field {
                Field::Temperature | Field::VonMises => nodes,
                Field::Displacement => structural_values,
                _ => return Err(invalid("unsupported retained history primary field")),
            };
            for row in &h.values {
                if row.len() != size {
                    return Err(invalid("invalid retained frame layout"));
                }
                finite(row)?;
            }
        }
        if let Some(s) = &r.sweep {
            finite(&s.frequencies)?;
            if s.frequencies.is_empty()
                || s.frequencies.len() != s.amplitude.len()
                || s.frequencies.len() != s.phase.len()
                || !s.frequencies.is_sorted_by(|a, b| a < b)
            {
                return Err(invalid("invalid retained frequency sweep"));
            }
            for f in s.amplitude.iter().chain(&s.phase) {
                if f.per != Per::Node || f.comps != 3 {
                    return Err(invalid("invalid retained sweep field layout"));
                }
                field(f)?;
            }
        }
        finite(&[r.solver.rel_residual, r.solver.time_ms])?;
        if let Some(e) = &r.static_equilibrium {
            finite(&e.reference)?;
            finite(&e.force_residual)?;
            finite(&e.applied_moment)?;
            finite(&e.moment_residual)?;
            finite(&[e.characteristic_length, e.force_scale, e.moment_scale])?;
            for (_, v) in &e.reaction_moments {
                finite(v)?;
            }
        }
        Ok(())
    }
}
