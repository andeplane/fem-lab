//! Typed Abaqus deck normalization. Source scope and identity survive instancing; no I/O,
//! coordinate welding, synthetic input text, model publication, or numerical solve occurs.

use super::abaqus::{self, malformed, unsupported, Builder, Keyword, MeshDeck, NamedSet, Record, Records};
use crate::command::{ImportedEntityIdentity, ImportedFace};
use crate::error::Error;
use crate::units::{Length, Q};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum DeckScope {
    Model,
    Assembly,
    Instance(String),
}

#[derive(Debug, Clone)]
pub(crate) struct DeckRecord {
    pub line: usize,
    pub fields: Vec<String>,
    pub raw: String,
    pub source: Option<Arc<str>>,
}

#[derive(Debug, Clone)]
pub(crate) struct DeckBlock {
    pub keyword: Keyword,
    pub records: Vec<DeckRecord>,
    pub scope: DeckScope,
}

pub(crate) struct NormalizedDeck {
    pub mesh: MeshDeck,
    pub analysis: Vec<DeckBlock>,
    assembly: Option<String>,
    node_ids: BTreeMap<(DeckScope, u32), u32>,
    element_ids: BTreeMap<(DeckScope, u32), u32>,
    node_sets: BTreeMap<(DeckScope, String), String>,
    element_sets: BTreeMap<(DeckScope, String), String>,
    surfaces: BTreeMap<(DeckScope, String), String>,
}

/// A qualified reference is a sequence of labels, with dots inside quotes left untouched.
fn components(text: &str, line: usize, keyword: &str) -> Result<Vec<String>, Error> {
    let mut quoted = false;
    let mut start = 0;
    let mut parts = Vec::new();
    for (index, ch) in text.char_indices() {
        if ch == '"' {
            quoted = !quoted;
        }
        if ch == '.' && !quoted {
            parts.push(component(&text[start..index], line, keyword)?);
            start = index + 1;
        }
    }
    if quoted {
        return Err(malformed(line, keyword, "target", "unterminated quoted reference"));
    }
    parts.push(component(&text[start..], line, keyword)?);
    Ok(parts)
}

fn component(text: &str, line: usize, keyword: &str) -> Result<String, Error> {
    let text = text.trim();
    if text.as_bytes().first().is_some_and(u8::is_ascii_digit) || text.starts_with('+') {
        return Ok(abaqus::label(text, line, keyword, "source label")?.to_string());
    }
    abaqus::name(text, line, keyword, "reference")
}

fn numeric_reference(text: &str) -> bool {
    let mut quoted = false;
    let mut start = 0;
    for (index, ch) in text.char_indices() {
        if ch == '"' {
            quoted = !quoted;
        }
        if ch == '.' && !quoted {
            start = index + 1;
        }
    }
    let last = text[start..].trim();
    last.starts_with('+') || last.as_bytes().first().is_some_and(u8::is_ascii_digit)
}

fn scoped_name(scope: &DeckScope, name: &str) -> String {
    match scope {
        DeckScope::Instance(instance) => format!("\"{instance}\".\"{name}\""),
        DeckScope::Model | DeckScope::Assembly => name.to_string(),
    }
}

impl NormalizedDeck {
    fn reference(
        &self,
        scope: &DeckScope,
        text: &str,
        line: usize,
        keyword: &str,
    ) -> Result<(DeckScope, String), Error> {
        let mut path = components(text, line, keyword)?;
        if self.assembly.as_ref().is_some_and(|a| path.len() > 1 && path[0] == *a) {
            path.remove(0);
        }
        match path.as_slice() {
            [item] => Ok((
                match scope {
                    DeckScope::Model if self.assembly.is_some() => DeckScope::Assembly,
                    other => other.clone(),
                },
                item.clone(),
            )),
            [instance, item] if !matches!(scope, DeckScope::Instance(_)) => {
                Ok((DeckScope::Instance(instance.clone()), item.clone()))
            }
            _ => Err(malformed(
                line,
                keyword,
                "target",
                "reference must name an item in the current scope or an instance-qualified item",
            )),
        }
    }

    pub(crate) fn node_set_target(
        &self,
        scope: &DeckScope,
        text: &str,
        line: usize,
        keyword: &str,
    ) -> Result<Option<String>, Error> {
        let reference = self.reference(scope, text, line, keyword)?;
        if numeric_reference(text) {
            return Ok(None);
        }
        self.node_sets
            .get(&reference)
            .cloned()
            .map(Some)
            .ok_or_else(|| malformed(line, keyword, "target", format!("node set {text} is not defined in this scope")))
    }

    pub(crate) fn node_target(
        &self,
        scope: &DeckScope,
        text: &str,
        line: usize,
        keyword: &str,
    ) -> Result<Vec<u32>, Error> {
        self.target(scope, text, line, keyword, true)
    }

    pub(crate) fn element_target(
        &self,
        scope: &DeckScope,
        text: &str,
        line: usize,
        keyword: &str,
    ) -> Result<Vec<u32>, Error> {
        self.target(scope, text, line, keyword, false)
    }

    fn target(
        &self,
        scope: &DeckScope,
        text: &str,
        line: usize,
        keyword: &str,
        nodes: bool,
    ) -> Result<Vec<u32>, Error> {
        let reference = self.reference(scope, text, line, keyword)?;
        if numeric_reference(text) {
            let id = abaqus::label(&reference.1, line, keyword, "target")?;
            let map = if nodes { &self.node_ids } else { &self.element_ids };
            return map.get(&(reference.0, id)).copied().map(|id| vec![id]).ok_or_else(|| {
                malformed(line, keyword, "target", format!("source label {text} is not defined in this scope"))
            });
        }
        let (names, sets) = if nodes {
            (&self.node_sets, &self.mesh.source.node_sets)
        } else {
            (&self.element_sets, &self.mesh.source.element_sets)
        };
        let mapped = names
            .get(&reference)
            .ok_or_else(|| malformed(line, keyword, "target", format!("set {text} is not defined in this scope")))?;
        Ok(sets[mapped].clone())
    }

    pub(crate) fn surface_target(
        &self,
        scope: &DeckScope,
        text: &str,
        line: usize,
        keyword: &str,
    ) -> Result<String, Error> {
        let reference = self.reference(scope, text, line, keyword)?;
        self.surfaces
            .get(&reference)
            .cloned()
            .ok_or_else(|| malformed(line, keyword, "surface", format!("surface {text} is not defined in this scope")))
    }
}

/// Admission is checked before allocating an owned typed record. Source entity totals
/// bound authored definitions as well as the later expanded, participating assembly.
struct CollectionBudget {
    keywords: usize,
    records: usize,
    nodes: usize,
    elements: usize,
    record_limit: usize,
    entity_limit: usize,
}
impl Default for CollectionBudget {
    fn default() -> Self {
        Self { keywords: 0, records: 0, nodes: 0, elements: 0, record_limit: 1_000_000, entity_limit: 250_000 }
    }
}
impl CollectionBudget {
    fn keyword(&mut self, line: usize) -> Result<(), Error> {
        if self.keywords == self.entity_limit {
            return Err(malformed(
                line,
                "INPUT",
                "keywords",
                format!("source exceeds {} keyword records", self.entity_limit),
            ));
        }
        self.keywords += 1;
        Ok(())
    }
    fn record(&mut self, line: usize) -> Result<(), Error> {
        if self.records == self.record_limit {
            return Err(malformed(
                line,
                "INPUT",
                "records",
                format!("source exceeds {} data records", self.record_limit),
            ));
        }
        self.records += 1;
        Ok(())
    }
    fn entity(&mut self, nodes: bool, label: u32, labels: &mut BTreeSet<u32>, line: usize) -> Result<(), Error> {
        let key = if nodes { "NODE" } else { "ELEMENT" };
        if labels.contains(&label) {
            return Err(malformed(
                line,
                key,
                "label",
                format!("source label {label} is already defined in this block"),
            ));
        }
        let count = if nodes { &mut self.nodes } else { &mut self.elements };
        if *count == self.entity_limit {
            return Err(malformed(
                line,
                key,
                "count",
                format!("source exceeds {} {}", self.entity_limit, if nodes { "nodes" } else { "elements" }),
            ));
        }
        *count += 1;
        labels.insert(label);
        Ok(())
    }
}

#[derive(Default)]
struct RecordCollector {
    labels: BTreeSet<u32>,
    pending_element_fields: usize,
}
impl RecordCollector {
    fn push(
        &mut self,
        block: &mut DeckBlock,
        record: Record<'_>,
        budget: &mut CollectionBudget,
        collect_data: bool,
    ) -> Result<(), Error> {
        // Alternate INPUT data and inline data must never compete for one owning option.
        if matches!(block.keyword.name.as_str(), "NODE" | "ELEMENT") && block.keyword.parameters.contains_key("INPUT") {
            return Err(located(
                malformed(
                    record.line,
                    &block.keyword.name,
                    "INPUT",
                    "an alternate INPUT option cannot also contain inline data records",
                ),
                record.source.map(Arc::as_ref),
            ));
        }
        let arity = if collect_data && block.keyword.name == "ELEMENT" {
            Some(
                abaqus::element_kind(&block.keyword)
                    .map_err(|error| located(error, block.keyword.source.as_deref()))?
                    .geometry()
                    .n_nodes()
                    + 1,
            )
        } else {
            None
        };
        let collected = (|| {
            budget.record(record.line)?;
            if !collect_data && block.keyword.name != "INCLUDE" {
                return Ok(());
            }
            let fields: Vec<String> = if block.keyword.name == "HEADING" {
                vec![record.text.to_string()]
            } else {
                abaqus::split_fields(record.text, record.line, &block.keyword.name)?
                    .into_iter()
                    .map(str::to_string)
                    .collect()
            };
            if collect_data
                && (block.keyword.name == "NODE"
                    || (block.keyword.name == "ELEMENT" && self.pending_element_fields == 0))
            {
                let id = abaqus::label(&fields[0], record.line, &block.keyword.name, "label")?;
                budget.entity(block.keyword.name == "NODE", id, &mut self.labels, record.line)?;
            }
            if let Some(arity) = arity {
                self.pending_element_fields += fields.len() - usize::from(fields.last().is_some_and(String::is_empty));
                if self.pending_element_fields >= arity {
                    self.pending_element_fields = 0;
                }
            }
            block.records.push(DeckRecord {
                line: record.line,
                fields,
                raw: record.text.to_string(),
                source: record.source.cloned(),
            });
            Ok(())
        })();
        collected.map_err(|error| located(error, record.source.map(Arc::as_ref)))
    }
}

fn blocks(
    text: &str,
    source: Option<&str>,
    budget: &mut CollectionBudget,
    collect_data: bool,
) -> Result<Vec<DeckBlock>, Error> {
    let source = source.map(Arc::<str>::from);
    let mut reader = Records::new(text);
    let mut blocks: Vec<DeckBlock> = Vec::new();
    let mut collector = RecordCollector::default();
    while let Some(record) = reader.next()? {
        let record = Record { source: source.as_ref(), ..record };
        if record.text.trim_start().starts_with('*') {
            budget.keyword(record.line)?;
            collector = RecordCollector::default();
            let mut keyword = reader.keyword(record)?;
            keyword.source = source.clone();
            blocks.push(DeckBlock { keyword, records: Vec::new(), scope: DeckScope::Model });
        } else {
            let block = blocks
                .last_mut()
                .ok_or_else(|| malformed(record.line, "INPUT", "data", "data must follow a keyword"))?;
            collector.push(block, record, budget, collect_data)?;
        }
    }
    Ok(blocks)
}

fn mesh_keyword(key: &str) -> bool {
    ["NODE", "ELEMENT", "NSET", "ELSET", "SURFACE", "HEADING", "PREPRINT"].contains(&key)
}

fn local_mesh(blocks: &[DeckBlock], scale: f64) -> Result<Builder, Error> {
    let mut mesh = Builder::default();
    for block in blocks.iter().filter(|b| mesh_keyword(&b.keyword.name)) {
        let mut active = mesh.start(block.keyword.clone()).map_err(|e| located(e, block.keyword.source.as_deref()))?;
        for record in &block.records {
            mesh.record(
                &mut active,
                Record { line: record.line, text: &record.raw, source: record.source.as_ref() },
                scale,
            )
            .map_err(|e| located(e, record.source.as_deref()))?;
        }
        active.finish()?;
    }
    Ok(mesh)
}

#[derive(Clone, Copy, Default)]
struct ExpansionCount {
    nodes: usize,
    elements: usize,
    memberships: usize,
}
impl ExpansionCount {
    const LIMIT: Self = Self { nodes: 250_000, elements: 250_000, memberships: 1_000_000 };
}
/// Presentation metadata may be inherited repeatedly without adding mesh entities.
/// Bound both owned UTF-8 and empty metadata records before retaining another copy.
struct PresentationBudget {
    bytes: usize,
    records: usize,
    byte_limit: usize,
    record_limit: usize,
}
impl Default for PresentationBudget {
    fn default() -> Self {
        Self { bytes: 0, records: 0, byte_limit: 64 * 1024 * 1024, record_limit: 1_000_000 }
    }
}
impl PresentationBudget {
    fn append(
        &mut self,
        global: &mut Builder,
        headings: Vec<String>,
        preprint: Vec<BTreeMap<String, bool>>,
        line: usize,
    ) -> Result<(), Error> {
        let records = headings.len().saturating_add(preprint.len());
        let bytes = headings
            .iter()
            .map(String::len)
            .chain(preprint.iter().flat_map(|settings| settings.keys().map(|key| key.len() + 1)))
            .fold(0usize, usize::saturating_add);
        if records > self.record_limit.saturating_sub(self.records) {
            return Err(malformed(
                line,
                "INSTANCE",
                "metadata",
                format!("expanded presentation exceeds {} records", self.record_limit),
            ));
        }
        if bytes > self.byte_limit.saturating_sub(self.bytes) {
            return Err(malformed(
                line,
                "INSTANCE",
                "metadata",
                format!("expanded presentation exceeds {} UTF-8 bytes", self.byte_limit),
            ));
        }
        self.records += records;
        self.bytes += bytes;
        global.headings.extend(headings);
        global.preprint.extend(preprint);
        Ok(())
    }
}
fn check_expansion(
    current: ExpansionCount,
    additional: ExpansionCount,
    limit: ExpansionCount,
    line: usize,
) -> Result<(), Error> {
    for (field, used, added, max) in [
        ("nodes", current.nodes, additional.nodes, limit.nodes),
        ("elements", current.elements, additional.elements, limit.elements),
        ("memberships", current.memberships, additional.memberships, limit.memberships),
    ] {
        if added > max.saturating_sub(used) {
            return Err(malformed(line, "INSTANCE", field, format!("expanded assembly exceeds {max} {field}")));
        }
    }
    Ok(())
}

#[derive(Default)]
struct Instance {
    part: String,
    blocks: Vec<DeckBlock>,
    position: Vec<DeckRecord>,
    line: usize,
    source: Option<Arc<str>>,
}

fn no_data(block: &DeckBlock) -> Result<(), Error> {
    if let Some(record) = block.records.first() {
        return Err(malformed(record.line, &block.keyword.name, "data", "this keyword accepts no data records"));
    }
    Ok(())
}

fn transform(point: [f64; 3], records: &[DeckRecord], line: usize, source: Option<&str>) -> Result<[f64; 3], Error> {
    let mut origin = source;
    let transformed = (|| {
        if records.len() > 2 {
            return Err(malformed(
                line,
                "INSTANCE",
                "position",
                "at most translation and rotation records are allowed",
            ));
        }
        let mut point = point;
        if let Some(translation) = records.first() {
            origin = translation.source.as_deref().or(source);
            if translation.fields.len() != 3 {
                return Err(malformed(
                    translation.line,
                    "INSTANCE",
                    "translation",
                    "translation requires three coordinates",
                ));
            }
            for (k, coordinate) in point.iter_mut().enumerate() {
                *coordinate +=
                    abaqus::scalar(&translation.fields[k], translation.line, "INSTANCE", "translation", 1.0)?;
            }
        }
        if let Some(rotation) = records.get(1) {
            origin = rotation.source.as_deref().or(source);
            if rotation.fields.len() != 7 {
                return Err(malformed(
                    rotation.line,
                    "INSTANCE",
                    "rotation",
                    "rotation requires two axis points and an angle",
                ));
            }
            let mut values = [0.0; 7];
            for (k, value) in values.iter_mut().enumerate() {
                *value = abaqus::scalar(&rotation.fields[k], rotation.line, "INSTANCE", "rotation", 1.0)?;
            }
            let axis = [values[3] - values[0], values[4] - values[1], values[5] - values[2]];
            let length = axis[0].hypot(axis[1]).hypot(axis[2]);
            if !length.is_finite() || length == 0.0 {
                return Err(malformed(
                    rotation.line,
                    "INSTANCE",
                    "axis",
                    "rotation axis must have distinct finite points",
                ));
            }
            let axis = axis.map(|v| v / length);
            let p = [point[0] - values[0], point[1] - values[1], point[2] - values[2]];
            let (s, c) = values[6].to_radians().sin_cos();
            let cross =
                [axis[1] * p[2] - axis[2] * p[1], axis[2] * p[0] - axis[0] * p[2], axis[0] * p[1] - axis[1] * p[0]];
            let dot = axis[0] * p[0] + axis[1] * p[1] + axis[2] * p[2];
            point = std::array::from_fn(|k| values[k] + p[k] * c + cross[k] * s + axis[k] * dot * (1.0 - c));
        }
        origin = source;
        if !point.iter().all(|p| p.is_finite()) {
            return Err(malformed(line, "INSTANCE", "position", "instance transform overflows finite coordinates"));
        }
        Ok(point.map(|p| p + 0.0))
    })();
    transformed.map_err(|e| located(e, origin))
}

/// Normalize flat or CAE assembly decks into one typed, labelled source and scoped analysis.
/// Data records retain their original line and text; only typed entities are remapped.
pub(crate) fn normalize(
    text: &str,
    body: &str,
    unit_length: &Q<Length>,
    digest: &str,
) -> Result<NormalizedDeck, Error> {
    normalize_mesh_sources(text, body, unit_length, digest, None, &BTreeMap::new())
}

pub(crate) fn normalize_sources(
    text: &str,
    body: &str,
    unit_length: &Q<Length>,
    digest: &str,
    source_name: Option<&str>,
    source_files: &BTreeMap<String, String>,
) -> Result<NormalizedDeck, Error> {
    normalize_deck(
        text,
        body,
        unit_length,
        digest,
        source_name,
        source_files,
        NormalizationPolicy { allow_analysis: true, expansion_limit: ExpansionCount::LIMIT },
    )
}

pub(crate) fn normalize_mesh_sources(
    text: &str,
    body: &str,
    unit_length: &Q<Length>,
    digest: &str,
    source_name: Option<&str>,
    source_files: &BTreeMap<String, String>,
) -> Result<NormalizedDeck, Error> {
    normalize_deck(
        text,
        body,
        unit_length,
        digest,
        source_name,
        source_files,
        NormalizationPolicy { allow_analysis: false, expansion_limit: ExpansionCount::LIMIT },
    )
}

struct NormalizationPolicy {
    allow_analysis: bool,
    expansion_limit: ExpansionCount,
}

struct AnalysisBudget {
    records: CollectionBudget,
    bytes: usize,
    byte_limit: usize,
}
impl Default for AnalysisBudget {
    fn default() -> Self {
        Self { records: CollectionBudget::default(), bytes: 0, byte_limit: 64 * 1024 * 1024 }
    }
}
impl AnalysisBudget {
    fn payload(&mut self, block: &DeckBlock, scope: Option<&DeckScope>) -> Result<(), Error> {
        let scope_bytes = match scope.unwrap_or(&block.scope) {
            DeckScope::Instance(name) => name.len(),
            DeckScope::Model | DeckScope::Assembly => 0,
        };
        let parameter_bytes: usize =
            block.keyword.parameters.iter().map(|(key, value)| key.len() + value.as_ref().map_or(0, String::len)).sum();
        let record_bytes: usize = block
            .records
            .iter()
            .map(|record| record.raw.len() + record.fields.iter().map(String::len).sum::<usize>())
            .sum();
        let bytes = scope_bytes + block.keyword.name.len() + parameter_bytes + record_bytes;
        if bytes > self.byte_limit.saturating_sub(self.bytes) {
            return Err(malformed(
                block.keyword.line,
                "INPUT",
                "analysis bytes",
                format!("expanded analysis exceeds {} bytes of retained text", self.byte_limit),
            ));
        }
        self.bytes += bytes;
        Ok(())
    }
}

/// Reserve repeated scoped analysis records and their owned text before cloning them,
/// independently of mesh admission. Continued keywords must not multiply unbounded payloads.
fn append_analysis(
    out: &mut Vec<DeckBlock>,
    budget: &mut AnalysisBudget,
    blocks: &[DeckBlock],
    scope: Option<&DeckScope>,
) -> Result<(), Error> {
    for block in blocks.iter().filter(|block| !mesh_keyword(&block.keyword.name)) {
        budget.payload(block, scope).map_err(|error| located(error, block.keyword.source.as_deref()))?;
        budget.records.keyword(block.keyword.line).map_err(|error| located(error, block.keyword.source.as_deref()))?;
        for record in &block.records {
            budget.records.record(record.line).map_err(|error| located(error, record.source.as_deref()))?;
        }
        let mut copy = block.clone();
        if let Some(scope) = scope {
            copy.scope = scope.clone();
        }
        out.push(copy);
    }
    Ok(())
}

fn normalize_deck(
    text: &str,
    body: &str,
    unit_length: &Q<Length>,
    digest: &str,
    source_name: Option<&str>,
    source_files: &BTreeMap<String, String>,
    policy: NormalizationPolicy,
) -> Result<NormalizedDeck, Error> {
    let NormalizationPolicy { allow_analysis, expansion_limit } = policy;
    let scale = abaqus::check_input(text, body, unit_length, digest)?;
    let expanded = expand_sources(text, source_name, source_files)?;
    let mut parts: BTreeMap<String, Vec<DeckBlock>> = BTreeMap::new();
    let mut instances: Vec<(String, Instance)> = Vec::new();
    let mut model_blocks = Vec::new();
    let mut assembly_blocks = Vec::new();
    let mut assembly = None;
    let mut in_assembly = false;
    let mut part: Option<String> = None;
    let mut instance: Option<usize> = None;
    let mut assembly_closed = false;
    let mut history_started = false;
    for mut block in expanded {
        let line = block.keyword.line;
        let source = block.keyword.source.clone();
        let handled = (|| {
            let key = block.keyword.name.as_str();
            if history_started
                && (mesh_keyword(key)
                    || ["PART", "ENDPART", "ASSEMBLY", "ENDASSEMBLY", "INSTANCE", "ENDINSTANCE"].contains(&key))
            {
                return Err(malformed(line, key, "scope", "mesh and assembly definitions must precede all Steps"));
            }
            if key == "STEP" {
                if part.is_some() || in_assembly || instance.is_some() {
                    return Err(malformed(
                        line,
                        key,
                        "scope",
                        "STEP must be outside part, instance and assembly definitions",
                    ));
                }
                history_started = true;
            }
            match key {
                "PART" => {
                    block.keyword.only(&["NAME"])?;
                    no_data(&block)?;
                    if part.is_some() || in_assembly || instance.is_some() || assembly_closed {
                        return Err(malformed(
                            line,
                            "PART",
                            "scope",
                            "parts must be defined outside and before the assembly",
                        ));
                    }
                    let name = abaqus::name(block.keyword.required("NAME")?, line, "PART", "NAME")?;
                    if parts.insert(name.clone(), Vec::new()).is_some() {
                        return Err(malformed(line, "PART", "NAME", "part name is already defined"));
                    }
                    part = Some(name);
                }
                "ENDPART" => {
                    block.keyword.only(&[])?;
                    no_data(&block)?;
                    if part.take().is_none() {
                        return Err(malformed(line, "END PART", "scope", "END PART needs an open PART"));
                    }
                }
                "ASSEMBLY" => {
                    block.keyword.only(&["NAME"])?;
                    no_data(&block)?;
                    if part.is_some() || assembly.is_some() {
                        return Err(malformed(line, "ASSEMBLY", "scope", "only one assembly outside parts is allowed"));
                    }
                    assembly = Some(abaqus::name(block.keyword.required("NAME")?, line, "ASSEMBLY", "NAME")?);
                    in_assembly = true;
                }
                "ENDASSEMBLY" => {
                    block.keyword.only(&[])?;
                    no_data(&block)?;
                    if !in_assembly || instance.is_some() {
                        return Err(malformed(
                            line,
                            "END ASSEMBLY",
                            "scope",
                            "END ASSEMBLY needs an open assembly with closed instances",
                        ));
                    }
                    in_assembly = false;
                    assembly_closed = true;
                }
                "INSTANCE" => {
                    block.keyword.only(&["NAME", "PART"])?;
                    if !in_assembly || instance.is_some() {
                        return Err(malformed(
                            line,
                            "INSTANCE",
                            "scope",
                            "instances must occur inside the assembly without nesting",
                        ));
                    }
                    let name = abaqus::name(block.keyword.required("NAME")?, line, "INSTANCE", "NAME")?;
                    if name == "ASSEMBLY" || instances.iter().any(|(n, _)| *n == name) {
                        return Err(malformed(
                            line,
                            "INSTANCE",
                            "NAME",
                            "instance name is reserved or already defined",
                        ));
                    }
                    let part_name = abaqus::name(block.keyword.required("PART")?, line, "INSTANCE", "PART")?;
                    if !parts.contains_key(&part_name) {
                        return Err(malformed(line, "INSTANCE", "PART", format!("part {part_name} is not defined")));
                    }
                    instance = Some(instances.len());
                    instances.push((
                        name,
                        Instance {
                            part: part_name,
                            blocks: Vec::new(),
                            position: block.records,
                            line,
                            source: block.keyword.source,
                        },
                    ));
                }
                "ENDINSTANCE" => {
                    block.keyword.only(&[])?;
                    no_data(&block)?;
                    if instance.take().is_none() {
                        return Err(malformed(line, "END INSTANCE", "scope", "END INSTANCE needs an open instance"));
                    }
                }
                _ => {
                    if !allow_analysis && !mesh_keyword(&block.keyword.name) {
                        return Err(unsupported(
                            line,
                            &block.keyword.name,
                            "analysis",
                            "analysis data is present; import in static mode to preserve its meaning",
                        ));
                    }
                    if let Some(index) = instance {
                        block.scope = DeckScope::Instance(instances[index].0.clone());
                        instances[index].1.blocks.push(block);
                    } else if let Some(name) = &part {
                        parts.get_mut(name).expect("open part exists").push(block);
                    } else if in_assembly {
                        block.scope = DeckScope::Assembly;
                        assembly_blocks.push(block);
                    } else {
                        model_blocks.push(block);
                    }
                }
            }
            Ok(())
        })();
        handled.map_err(|e| located(e, source.as_deref()))?;
    }
    if part.is_some() || in_assembly || instance.is_some() {
        return Err(malformed(1, "INPUT", "scope", "unterminated PART, ASSEMBLY, or INSTANCE"));
    }
    if !parts.is_empty() && assembly.is_none() {
        return Err(malformed(1, "INPUT", "assembly", "part definitions require an assembly of instances"));
    }
    if assembly.is_some() && instances.is_empty() {
        return Err(malformed(1, "ASSEMBLY", "instances", "assembly must contain at least one instance"));
    }
    if assembly.is_some()
        && model_blocks
            .iter()
            .any(|b| matches!(b.keyword.name.as_str(), "NODE" | "ELEMENT" | "NSET" | "ELSET" | "SURFACE"))
    {
        return Err(malformed(1, "INPUT", "scope", "assembly models cannot also contain a flat model-level mesh"));
    }

    for blocks in parts.values() {
        for block in blocks {
            if !mesh_keyword(&block.keyword.name) && block.keyword.name != "SOLIDSECTION" {
                return Err(located(
                    unsupported(
                        block.keyword.line,
                        &block.keyword.name,
                        "part",
                        "this part-level capability cannot be imported",
                    ),
                    block.keyword.source.as_deref(),
                ));
            }
        }
    }

    let mut global = Builder::default();
    let mut presentation_budget = PresentationBudget::default();
    let mut node_ids = BTreeMap::new();
    let mut element_ids = BTreeMap::new();
    let mut node_sets = BTreeMap::new();
    let mut element_sets = BTreeMap::new();
    let mut surfaces = BTreeMap::new();
    let mut node_identities = BTreeMap::new();
    let mut element_identities = BTreeMap::new();
    let mut regions = BTreeMap::new();
    let mut analysis = Vec::new();
    let mut analysis_budget = AnalysisBudget::default();
    let mut history = &[][..];
    let mut part_counts = BTreeMap::new();
    for (name, blocks) in &parts {
        let local = local_mesh(blocks, scale)?;
        part_counts.insert(
            name.clone(),
            ExpansionCount { nodes: local.nodes.len(), elements: local.elements.len(), memberships: local.memberships },
        );
    }
    let mut local_plans = Vec::new();
    if assembly.is_none() {
        append_analysis(&mut analysis, &mut analysis_budget, &model_blocks, None)?;
        local_plans.push((
            DeckScope::Model,
            None,
            model_blocks.as_slice(),
            &[][..],
            &[][..],
            1,
            ExpansionCount::default(),
            None,
        ));
    } else {
        let presentation: Vec<_> = model_blocks
            .iter()
            .filter(|b| matches!(b.keyword.name.as_str(), "HEADING" | "PREPRINT"))
            .cloned()
            .collect();
        let presentation = local_mesh(&presentation, scale)?;
        presentation_budget
            .append(&mut global, presentation.headings, presentation.preprint, 1)
            .map_err(|e| located(e, source_name))?;
        let history_start =
            model_blocks.iter().position(|block| block.keyword.name == "STEP").unwrap_or(model_blocks.len());
        append_analysis(&mut analysis, &mut analysis_budget, &model_blocks[..history_start], None)?;
        history = &model_blocks[history_start..];
        for (instance_name, instance) in &instances {
            transform([0.0; 3], &instance.position, instance.line, instance.source.as_deref())?;
            let inherited = &parts[&instance.part];
            let part_has_mesh = inherited.iter().any(|b| matches!(b.keyword.name.as_str(), "NODE" | "ELEMENT"));
            if let Some(block) = instance
                .blocks
                .iter()
                .find(|b| part_has_mesh && matches!(b.keyword.name.as_str(), "NODE" | "ELEMENT" | "SOLIDSECTION"))
            {
                return Err(located(
                    malformed(
                        block.keyword.line,
                        "INSTANCE",
                        "mesh",
                        "an inherited part mesh or section cannot be overridden in an instance",
                    ),
                    block.keyword.source.as_deref(),
                ));
            }
            for block in &instance.blocks {
                if matches!(block.keyword.name.as_str(), "NSET" | "ELSET" | "SURFACE") {
                    let key = if block.keyword.name == "SURFACE" { "NAME" } else { block.keyword.name.as_str() };
                    let name =
                        (|| abaqus::name(block.keyword.required(key)?, block.keyword.line, &block.keyword.name, key))()
                            .map_err(|e| located(e, block.keyword.source.as_deref()))?;
                    for previous in inherited.iter().filter(|b| b.keyword.name == block.keyword.name) {
                        let previous_name = (|| {
                            abaqus::name(
                                previous.keyword.required(key)?,
                                previous.keyword.line,
                                &previous.keyword.name,
                                key,
                            )
                        })()
                        .map_err(|e| located(e, previous.keyword.source.as_deref()))?;
                        if previous_name == name {
                            return Err(located(
                                malformed(
                                    block.keyword.line,
                                    &block.keyword.name,
                                    key,
                                    "instance definitions cannot override inherited part sets or surfaces",
                                ),
                                block.keyword.source.as_deref(),
                            ));
                        }
                    }
                }
            }
            local_plans.push((
                DeckScope::Instance(instance_name.clone()),
                Some(instance.part.clone()),
                inherited.as_slice(),
                instance.blocks.as_slice(),
                instance.position.as_slice(),
                instance.line,
                part_counts[&instance.part],
                instance.source.clone(),
            ));
        }
    }

    for (ordinal, (scope, source_part, inherited, additions, position, line, minimum, source)) in
        local_plans.into_iter().enumerate()
    {
        let current = ExpansionCount {
            nodes: global.nodes.len(),
            elements: global.elements.len(),
            memberships: global.memberships,
        };
        check_expansion(current, minimum, expansion_limit, line).map_err(|e| located(e, source.as_deref()))?;
        if matches!(scope, DeckScope::Instance(_)) {
            append_analysis(&mut analysis, &mut analysis_budget, inherited, Some(&scope))?;
            append_analysis(&mut analysis, &mut analysis_budget, additions, Some(&scope))?;
        }
        // Only the current instance is parsed; previous instances have already been flattened.
        let mut combined = inherited.to_vec();
        combined.extend_from_slice(additions);
        let local = local_mesh(&combined, scale)?;
        check_expansion(
            current,
            ExpansionCount { nodes: local.nodes.len(), elements: local.elements.len(), memberships: local.memberships },
            expansion_limit,
            line,
        )
        .map_err(|e| located(e, source.as_deref()))?;
        global.reserve_members(local.memberships, line, "INSTANCE").map_err(|e| located(e, source.as_deref()))?;
        let mut region_members = Vec::new();
        let instanced = matches!(scope, DeckScope::Instance(_));
        for (id, (mut node, source_line)) in local.nodes {
            let mapped = if instanced { global.nodes.len() as u32 + 1 } else { id };
            if instanced {
                let point = node.at.clone().map(|v| v.si()).into_iter().collect::<Result<Vec<_>, _>>()?;
                let point = transform(
                    [point[0] / scale, point[1] / scale, point[2] / scale],
                    position,
                    line,
                    source.as_deref(),
                )?;
                node.at = point.map(|v| Q::new(v * scale, "m"));
                let instance = match &scope {
                    DeckScope::Instance(name) => Some(name.clone()),
                    _ => None,
                };
                node_identities
                    .insert(mapped, ImportedEntityIdentity { source_label: id, instance, part: source_part.clone() });
            }
            if let Some(source) = local.node_sources.get(&id) {
                global.node_sources.insert(mapped, source.clone());
            }
            node.label = mapped;
            node_ids.insert((scope.clone(), id), mapped);
            global.nodes.insert(mapped, (node, source_line));
        }
        for (id, (mut element, source_line)) in local.elements {
            let mapped = if instanced { global.elements.len() as u32 + 1 } else { id };
            for node in &mut element.nodes {
                *node = *node_ids.get(&(scope.clone(), *node)).ok_or_else(|| {
                    located(
                        malformed(
                            source_line,
                            "ELEMENT",
                            "connectivity",
                            format!("source node {node} is not defined in this instance"),
                        ),
                        local.element_sources.get(&id).map(Arc::as_ref),
                    )
                })?;
            }
            if let DeckScope::Instance(instance) = &scope {
                element_identities.insert(
                    mapped,
                    ImportedEntityIdentity {
                        source_label: id,
                        instance: Some(instance.clone()),
                        part: source_part.clone(),
                    },
                );
                region_members.push(mapped);
            }
            if let Some(source) = local.element_sources.get(&id) {
                global.element_sources.insert(mapped, source.clone());
            }
            element.label = mapped;
            element_ids.insert((scope.clone(), id), mapped);
            global.elements.insert(mapped, (element, source_line));
        }
        for (nodes, maps) in [(true, local.node_sets), (false, local.element_sets)] {
            for (name, set) in maps {
                let mapped_name = scoped_name(&scope, &name);
                let ids = if nodes { &node_ids } else { &element_ids };
                let members: BTreeMap<u32, usize> = set
                    .members
                    .into_iter()
                    .map(|(id, source_line)| {
                        let origin = local.set_sources.get(&(nodes, name.clone())).and_then(|m| m.get(&id));
                        ids.get(&(scope.clone(), id))
                            .copied()
                            .map(|id| {
                                if let Some(source) = origin {
                                    global
                                        .set_sources
                                        .entry((nodes, mapped_name.clone()))
                                        .or_default()
                                        .entry(id)
                                        .or_insert_with(|| source.clone());
                                }
                                (id, source_line)
                            })
                            .ok_or_else(|| {
                                located(
                                    malformed(
                                        source_line,
                                        if nodes { "NSET" } else { "ELSET" },
                                        "member",
                                        "source label is not defined in this instance",
                                    ),
                                    origin.map(Arc::as_ref),
                                )
                            })
                    })
                    .collect::<Result<BTreeMap<_, _>, _>>()?;
                let (lookup, sets) = if nodes {
                    (&mut node_sets, &mut global.node_sets)
                } else {
                    (&mut element_sets, &mut global.element_sets)
                };
                lookup.insert((scope.clone(), name), mapped_name.clone());
                sets.insert(mapped_name, NamedSet { members });
            }
        }
        for (name, (source_line, faces)) in local.surfaces {
            let mapped_name = scoped_name(&scope, &name);
            let faces = faces
                .into_iter()
                .map(|(face, line)| {
                    element_ids
                        .get(&(scope.clone(), face.element))
                        .copied()
                        .map(|element| {
                            let mapped = ImportedFace { element, face: face.face };
                            if let Some(source) = local.surface_sources.get(&name).and_then(|m| m.get(&face)) {
                                global
                                    .surface_sources
                                    .entry(mapped_name.clone())
                                    .or_default()
                                    .insert(mapped, source.clone());
                            }
                            (mapped, line)
                        })
                        .ok_or_else(|| {
                            located(
                                malformed(
                                    line,
                                    "SURFACE",
                                    "element",
                                    "surface element is not defined in this instance",
                                ),
                                local.surface_sources.get(&name).and_then(|m| m.get(&face)).map(Arc::as_ref),
                            )
                        })
                })
                .collect::<Result<BTreeMap<_, _>, _>>()?;
            surfaces.insert((scope.clone(), name), mapped_name.clone());
            global.surfaces.insert(mapped_name, (source_line, faces));
        }
        if matches!(scope, DeckScope::Instance(_)) {
            regions.insert(format!("{body}_instance_{}", ordinal + 1), region_members);
        }
        presentation_budget
            .append(&mut global, local.headings, local.preprint, line)
            .map_err(|e| located(e, source.as_deref()))?;
    }
    // Assembly nodes and sets are handled against the complete instance identity map below.
    let assembly_mesh: Vec<_> =
        assembly_blocks.iter().filter(|block| mesh_keyword(&block.keyword.name)).cloned().collect();
    add_assembly(
        &assembly_mesh,
        &assembly,
        &mut global,
        &mut node_ids,
        &mut element_ids,
        &mut node_sets,
        &mut element_sets,
        &mut surfaces,
        scale,
    )?;
    if global.memberships > 1_000_000 {
        return Err(malformed(1, "INPUT", "memberships", "expanded assembly exceeds 1000000 memberships"));
    }
    for ((scope, label), mapped) in &node_ids {
        if *scope == DeckScope::Assembly {
            node_identities
                .insert(*mapped, ImportedEntityIdentity { source_label: *label, instance: None, part: None });
        }
    }
    let provenance = crate::command::ImportedProvenance {
        sha256: digest.to_string(),
        conversion_version: abaqus::CONVERSION_VERSION.to_string(),
        node_identities,
        element_identities,
        source_name: source_name.map(str::to_string),
        source_files: source_files
            .iter()
            .map(|(path, text)| (path.clone(), crate::hash::sha256_hex(text.as_bytes())))
            .collect(),
    };
    let mesh = global.finish_source(body, digest, scale, regions, Some(Box::new(provenance)))?;
    append_analysis(&mut analysis, &mut analysis_budget, &assembly_blocks, None)?;
    append_analysis(&mut analysis, &mut analysis_budget, history, None)?;
    Ok(NormalizedDeck { mesh, analysis, assembly, node_ids, element_ids, node_sets, element_sets, surfaces })
}

fn assembly_reference(
    assembly: &Option<String>,
    text: &str,
    instance: Option<&str>,
    line: usize,
    keyword: &str,
) -> Result<(DeckScope, String), Error> {
    let mut path = components(text, line, keyword)?;
    if assembly.as_ref().is_some_and(|a| path.len() > 1 && path[0] == *a) {
        path.remove(0);
    }
    match path.as_slice() {
        [item] => {
            Ok((instance.map(|s| DeckScope::Instance(s.to_string())).unwrap_or(DeckScope::Assembly), item.clone()))
        }
        [scope, item] if instance.is_none() => Ok((DeckScope::Instance(scope.clone()), item.clone())),
        _ => Err(malformed(line, keyword, "target", "invalid assembly-qualified reference")),
    }
}

#[allow(clippy::too_many_arguments)]
fn add_assembly(
    blocks: &[DeckBlock],
    assembly: &Option<String>,
    global: &mut Builder,
    node_ids: &mut BTreeMap<(DeckScope, u32), u32>,
    element_ids: &mut BTreeMap<(DeckScope, u32), u32>,
    node_sets: &mut BTreeMap<(DeckScope, String), String>,
    element_sets: &mut BTreeMap<(DeckScope, String), String>,
    surfaces: &mut BTreeMap<(DeckScope, String), String>,
    scale: f64,
) -> Result<(), Error> {
    for block in blocks.iter().filter(|b| mesh_keyword(&b.keyword.name)) {
        let key = &block.keyword.name;
        let line = block.keyword.line;
        let handled = (|| {
            match key.as_str() {
                "NODE" => {
                    let local = local_mesh(std::slice::from_ref(block), scale)?;
                    global.reserve_members(local.memberships, line, "NODE")?;
                    for (id, (mut node, source_line)) in local.nodes {
                        if node_ids.contains_key(&(DeckScope::Assembly, id)) {
                            return Err(malformed(
                                source_line,
                                "NODE",
                                "label",
                                "assembly node label is already defined",
                            ));
                        }
                        let mapped = global.nodes.last_key_value().map(|(id, _)| id + 1).unwrap_or(1);
                        node.label = mapped;
                        if let Some(source) = local.node_sources.get(&id) {
                            global.node_sources.insert(mapped, source.clone());
                        }
                        node_ids.insert((DeckScope::Assembly, id), mapped);
                        if global.nodes.len() == 250_000 {
                            return Err(malformed(
                                source_line,
                                "NODE",
                                "count",
                                "expanded assembly exceeds 250000 nodes",
                            ));
                        }
                        global.nodes.insert(mapped, (node, source_line));
                    }
                    for (name, set) in local.node_sets {
                        let members: BTreeMap<u32, usize> = set
                            .members
                            .into_iter()
                            .map(|(id, line)| (node_ids[&(DeckScope::Assembly, id)], line))
                            .collect();
                        node_sets.insert((DeckScope::Assembly, name.clone()), name.clone());
                        global
                            .node_sets
                            .entry(name)
                            .or_insert_with(|| NamedSet { members: BTreeMap::new() })
                            .members
                            .extend(members);
                    }
                }
                "NSET" | "ELSET" => {
                    let nodes = key == "NSET";
                    block.keyword.only(if nodes {
                        &["NSET", "ELSET", "GENERATE", "INSTANCE", "INTERNAL", "UNSORTED"]
                    } else {
                        &["ELSET", "GENERATE", "INSTANCE", "INTERNAL", "UNSORTED"]
                    })?;
                    let name = abaqus::name(block.keyword.required(key)?, line, key, key)?;
                    let instance =
                        block.keyword.value("INSTANCE")?.map(|s| abaqus::name(s, line, key, "INSTANCE")).transpose()?;
                    let generate = block.keyword.flag("GENERATE")?;
                    let mut members = BTreeMap::new();
                    if let Some(from) = if nodes { block.keyword.value("ELSET")? } else { None } {
                        if generate || !block.records.is_empty() {
                            return Err(malformed(line, key, "ELSET", "NSET from ELSET accepts no data or GENERATE"));
                        }
                        let reference = assembly_reference(assembly, from, instance.as_deref(), line, key)?;
                        let source = element_sets
                            .get(&reference)
                            .ok_or_else(|| malformed(line, key, "ELSET", "element set must already exist"))?;
                        let declared = global.element_sets[source]
                            .members
                            .keys()
                            .map(|id| global.elements[id].0.nodes.len())
                            .sum();
                        global.reserve_members(declared, line, key)?;
                        for id in global.element_sets[source].members.keys() {
                            for node in &global.elements[id].0.nodes {
                                members.insert(*node, line);
                            }
                        }
                    } else {
                        if block.records.is_empty() {
                            return Err(malformed(line, key, "data", "set requires member records"));
                        }
                        for record in &block.records {
                            let mut values = record.fields.clone();
                            if values.last().is_some_and(String::is_empty) {
                                values.pop();
                            }
                            let refs = if generate {
                                if !(2..=3).contains(&values.len()) {
                                    return Err(malformed(
                                        record.line,
                                        key,
                                        "GENERATE",
                                        "range needs first, last, and optional increment",
                                    ));
                                }
                                let first = abaqus::label(&values[0], record.line, key, "first")?;
                                let last = abaqus::label(&values[1], record.line, key, "last")?;
                                let increment = match values.get(2) {
                                    Some(v) if !v.is_empty() => abaqus::label(v, record.line, key, "increment")?,
                                    _ => 1,
                                };
                                if last < first || (last - first) % increment != 0 {
                                    return Err(malformed(
                                        record.line,
                                        key,
                                        "GENERATE",
                                        "range must increase by a positive integer increment",
                                    ));
                                }
                                let count = ((last - first) / increment + 1) as usize;
                                if count > 1_000_000 {
                                    return Err(malformed(
                                        record.line,
                                        key,
                                        "memberships",
                                        "expanded set exceeds 1000000 memberships",
                                    ));
                                }
                                (0..count).map(|i| (first + i as u32 * increment).to_string()).collect::<Vec<_>>()
                            } else {
                                values
                            };
                            for value in refs {
                                let reference =
                                    assembly_reference(assembly, &value, instance.as_deref(), record.line, key)?;
                                let ids = if nodes { &*node_ids } else { &*element_ids };
                                if numeric_reference(&value) {
                                    let id = abaqus::label(&reference.1, record.line, key, "member")?;
                                    let mapped = ids.get(&(reference.0, id)).ok_or_else(|| {
                                        malformed(record.line, key, "member", format!("source {value} does not exist"))
                                    })?;
                                    global.reserve_members(1, record.line, key)?;
                                    members.insert(*mapped, record.line);
                                } else {
                                    let (lookup, sets) = if nodes {
                                        (&*node_sets, &global.node_sets)
                                    } else {
                                        (&*element_sets, &global.element_sets)
                                    };
                                    let source = lookup.get(&reference).ok_or_else(|| {
                                        malformed(
                                            record.line,
                                            key,
                                            "referenced set",
                                            format!("set {value} must already exist"),
                                        )
                                    })?;
                                    let captured = sets[source].members.keys().copied().collect::<Vec<_>>();
                                    global.reserve_members(captured.len(), record.line, key)?;
                                    members.extend(captured.into_iter().map(|id| (id, record.line)));
                                }
                                if members.len() > 1_000_000 {
                                    return Err(malformed(
                                        record.line,
                                        key,
                                        "memberships",
                                        "expanded set exceeds 1000000 memberships",
                                    ));
                                }
                            }
                        }
                    }
                    let (lookup, sets) = if nodes {
                        (&mut *node_sets, &mut global.node_sets)
                    } else {
                        (&mut *element_sets, &mut global.element_sets)
                    };
                    lookup.insert((DeckScope::Assembly, name.clone()), name.clone());
                    sets.entry(name).or_insert_with(|| NamedSet { members: BTreeMap::new() }).members.extend(members);
                }
                "SURFACE" => {
                    block.keyword.only(&["NAME", "TYPE", "INTERNAL"])?;
                    if block.keyword.value("TYPE")?.is_some_and(|s| s != "ELEMENT") {
                        return Err(unsupported(line, key, "TYPE", "only element surfaces are supported"));
                    }
                    let name = abaqus::name(block.keyword.required("NAME")?, line, key, "NAME")?;
                    if global.surfaces.contains_key(&name) {
                        return Err(malformed(line, key, "NAME", "surface is already defined in this scope"));
                    }
                    let mut members = BTreeMap::new();
                    for record in &block.records {
                        if record.fields.len() != 2 {
                            return Err(malformed(
                                record.line,
                                key,
                                "data",
                                "element surface requires element target and S1..S6 face",
                            ));
                        }
                        let face = record.fields[1]
                            .strip_prefix('S')
                            .or_else(|| record.fields[1].strip_prefix('s'))
                            .and_then(|s| s.parse::<u8>().ok())
                            .filter(|v| (1..=6).contains(v))
                            .ok_or_else(|| malformed(record.line, key, "face", "face must be S1..S6"))?;
                        let reference = assembly_reference(assembly, &record.fields[0], None, record.line, key)?;
                        let elements = if numeric_reference(&record.fields[0]) {
                            let id = abaqus::label(&reference.1, record.line, key, "element")?;
                            vec![*element_ids
                                .get(&(reference.0, id))
                                .ok_or_else(|| malformed(record.line, key, "element", "element does not exist"))?]
                        } else {
                            let source = element_sets
                                .get(&reference)
                                .ok_or_else(|| malformed(record.line, key, "ELSET", "element set does not exist"))?;
                            global.element_sets[source].members.keys().copied().collect()
                        };
                        global.reserve_members(elements.len(), record.line, key)?;
                        for element in elements {
                            let face = ImportedFace { element, face };
                            if let Some(source) = record.source.as_ref() {
                                global.surface_sources.entry(name.clone()).or_default().insert(face, source.clone());
                            }
                            members.insert(face, record.line);
                        }
                    }
                    if members.is_empty() {
                        return Err(malformed(line, key, "data", "surface requires at least one face"));
                    }
                    surfaces.insert((DeckScope::Assembly, name.clone()), name.clone());
                    global.surfaces.insert(name, (line, members));
                }
                _ => return Err(unsupported(line, key, "scope", "this mesh keyword is not valid at assembly level")),
            }
            if global.nodes.len() > 250_000 || global.elements.len() > 250_000 {
                return Err(malformed(line, key, "count", "expanded assembly exceeds 250000 nodes/elements"));
            }
            Ok(())
        })();
        handled.map_err(|e| located(e, block.keyword.source.as_deref()))?;
    }
    Ok(())
}

fn source_path(path: &str) -> Result<(), Error> {
    if path.is_empty()
        || path.len() > 1024
        || path.starts_with('/')
        || path.contains(['\\', '\0', ':'])
        || path.chars().any(char::is_control)
        || path.split('/').any(|s| s.is_empty() || s == "." || s == "..")
    {
        return Err(Error::schema(
            "source paths must be relative submission-directory paths without empty, dot, or parent segments",
        )
        .at("sourceFiles"));
    }
    Ok(())
}

fn located(error: Error, source: Option<&str>) -> Error {
    abaqus::with_source(error, source)
}

fn expand_sources(
    text: &str,
    source_name: Option<&str>,
    sources: &BTreeMap<String, String>,
) -> Result<Vec<DeckBlock>, Error> {
    validate_sources(text, source_name, sources)?;
    let mut stack = vec![source_name.unwrap_or("").to_string()];
    let mut expanded_bytes = 0;
    let mut budget = CollectionBudget::default();
    expand_one(text, source_name, sources, &mut stack, &mut expanded_bytes, &mut budget)
}

fn expand_one(
    text: &str,
    source: Option<&str>,
    sources: &BTreeMap<String, String>,
    stack: &mut Vec<String>,
    expanded_bytes: &mut usize,
    budget: &mut CollectionBudget,
) -> Result<Vec<DeckBlock>, Error> {
    *expanded_bytes = expanded_bytes.saturating_add(text.len());
    if *expanded_bytes > abaqus::MAX_INPUT_BYTES {
        return Err(located(Error::schema("expanded includes exceed the 16 MiB input bound").at("INCLUDE"), source));
    }
    let mut expanded = Vec::new();
    for mut block in blocks(text, source, budget, true).map_err(|e| located(e, source))? {
        let Some(path) = source_reference(&block, stack).map_err(|e| located(e, source))? else {
            expanded.push(block);
            continue;
        };
        let included = sources.get(&path).ok_or_else(|| {
            located(
                malformed(
                    block.keyword.line,
                    &block.keyword.name,
                    "INPUT",
                    format!("source file {path} was not supplied; provide the complete source bundle"),
                ),
                source,
            )
        })?;
        if block.keyword.name == "INCLUDE" {
            stack.push(path.to_string());
            let records = expand_one(included, Some(&path), sources, stack, expanded_bytes, budget)?;
            stack.pop();
            expanded.extend(records);
        } else {
            alternate_records(included, &path, &mut block, budget, expanded_bytes, true)?;
            expanded.push(block);
        }
    }
    Ok(expanded)
}

/// Discover provided-graph dependencies before a host acquires files. This is the same lexer
/// and graph policy used for conversion; neither path performs filesystem or network I/O.
pub(crate) fn source_dependencies(
    text: &str,
    source_name: Option<&str>,
    sources: &BTreeMap<String, String>,
) -> Result<Vec<String>, Error> {
    validate_sources(text, source_name, sources)?;
    let mut missing = std::collections::BTreeSet::new();
    let mut stack = vec![source_name.unwrap_or("").to_string()];
    let mut bytes = 0;
    let mut budget = CollectionBudget::default();
    dependencies_one(text, source_name, sources, &mut stack, &mut bytes, &mut missing, &mut budget)?;
    Ok(missing.into_iter().collect())
}

fn dependencies_one(
    text: &str,
    source: Option<&str>,
    sources: &BTreeMap<String, String>,
    stack: &mut Vec<String>,
    bytes: &mut usize,
    missing: &mut std::collections::BTreeSet<String>,
    budget: &mut CollectionBudget,
) -> Result<(), Error> {
    *bytes = bytes.saturating_add(text.len());
    if *bytes > abaqus::MAX_INPUT_BYTES {
        return Err(located(Error::schema("expanded includes exceed the 16 MiB input bound").at("INCLUDE"), source));
    }
    for mut block in blocks(text, source, budget, false).map_err(|e| located(e, source))? {
        let Some(path) = source_reference(&block, stack).map_err(|e| located(e, source))? else {
            continue;
        };
        if let Some(included) = sources.get(&path) {
            if block.keyword.name == "INCLUDE" {
                stack.push(path.clone());
                dependencies_one(included, Some(&path), sources, stack, bytes, missing, budget)?;
                stack.pop();
            } else {
                alternate_records(included, &path, &mut block, budget, bytes, false)?;
            }
        } else {
            missing.insert(path);
        }
    }
    Ok(())
}

/// Both discovery and conversion traverse only the documented owning-keyword references.
fn source_reference(block: &DeckBlock, stack: &[String]) -> Result<Option<String>, Error> {
    let keyword = &block.keyword;
    if keyword.name == "INCLUDE" {
        keyword.only(&["INPUT"])?;
    } else if !matches!(keyword.name.as_str(), "NODE" | "ELEMENT") || !keyword.parameters.contains_key("INPUT") {
        return Ok(None);
    }
    no_data(block)?;
    let path = input_path(keyword)?;
    if stack.len() >= 16 {
        return Err(malformed(keyword.line, &keyword.name, "depth", "source reference nesting exceeds 16 files"));
    }
    if stack.iter().any(|previous| previous == &path) {
        return Err(malformed(keyword.line, &keyword.name, "cycle", format!("source reference cycle through {path}")));
    }
    Ok(Some(path))
}

fn input_path(keyword: &Keyword) -> Result<String, Error> {
    let raw = keyword.required("INPUT")?;
    let path = if raw.starts_with('"') {
        raw.strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'))
            .ok_or_else(|| malformed(keyword.line, &keyword.name, "INPUT", "quoted filename needs matching quotes"))?
    } else {
        raw
    };
    source_path(path)?;
    Ok(path.to_string())
}

/// An alternate file contains records for its existing owner, never keyword declarations.
fn alternate_records(
    text: &str,
    path: &str,
    block: &mut DeckBlock,
    budget: &mut CollectionBudget,
    bytes: &mut usize,
    collect_data: bool,
) -> Result<(), Error> {
    *bytes = bytes.saturating_add(text.len());
    if *bytes > abaqus::MAX_INPUT_BYTES {
        return Err(located(
            Error::schema("expanded source files exceed the 16 MiB input bound").at("INPUT"),
            Some(path),
        ));
    }
    block.keyword.parameters.remove("INPUT");
    let source = Arc::<str>::from(path);
    let mut reader = Records::new(text);
    let mut collector = RecordCollector::default();
    let mut records = 0;
    while let Some(record) = reader.next().map_err(|error| located(error, Some(path)))? {
        if record.text.trim_start().starts_with('*') {
            return Err(located(
                malformed(
                    record.line,
                    &block.keyword.name,
                    "INPUT",
                    "an alternate data file must contain data records only; keywords are not allowed",
                ),
                Some(path),
            ));
        }
        collector.push(block, Record { source: Some(&source), ..record }, budget, collect_data)?;
        records += 1;
    }
    if records == 0 {
        return Err(located(
            malformed(1, &block.keyword.name, "INPUT", "an alternate data file must contain at least one data record"),
            Some(path),
        ));
    }
    Ok(())
}

fn validate_sources(text: &str, source_name: Option<&str>, sources: &BTreeMap<String, String>) -> Result<(), Error> {
    if sources.len() > 128 {
        return Err(Error::schema("source bundle exceeds 128 include files").at("sourceFiles"));
    }
    let size = sources
        .values()
        .try_fold(text.len(), |sum, text| sum.checked_add(text.len()))
        .ok_or_else(|| Error::schema("source bundle size overflows").at("sourceFiles"))?;
    if size > abaqus::MAX_INPUT_BYTES {
        return Err(Error::schema("source bundle exceeds the aggregate 16 MiB input bound").at("sourceFiles"));
    }
    if let Some(name) = source_name {
        source_path(name)?;
    }
    for (path, text) in sources {
        source_path(path)?;
        if !text.is_empty() && !text.ends_with('\n') {
            return Err(
                Error::schema("every included input record must end in LF or CRLF").at(format!("sourceFiles.{path}"))
            );
        }
    }
    if !text.is_empty() && !text.ends_with('\n') {
        return Err(Error::schema("every input record must end in LF or CRLF").at("text"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(fields: &[&str]) -> DeckRecord {
        DeckRecord {
            line: 7,
            fields: fields.iter().map(|s| s.to_string()).collect(),
            raw: fields.join(","),
            source: None,
        }
    }

    #[test]
    fn qualified_names_split_only_unquoted_dots_and_preserve_quoted_case() {
        assert_eq!(components("assembly.instance.12", 3, "NSET").unwrap(), ["ASSEMBLY", "INSTANCE", "12"]);
        assert_eq!(
            components("\"Assembly A\".\"Case.Name\".\"Set, = 1\"", 3, "NSET").unwrap(),
            ["Assembly A", "Case.Name", "Set, = 1"]
        );
        assert!(components("A.\"unterminated", 3, "NSET").is_err());
        assert!(components("A..B", 3, "NSET").is_err());
        assert!(components("A.0", 3, "NSET").is_err());
        assert_eq!(scoped_name(&DeckScope::Instance("a".into()), "b"), "\"a\".\"b\"");
    }

    #[test]
    fn instance_position_uses_translation_before_right_handed_axis_rotation() {
        let records = [record(&["2", "0", "0"]), record(&["0", "0", "0", "0", "0", "1", "90"])];
        let actual = transform([1.0, 0.0, 0.0], &records, 4, None).unwrap();
        assert!(actual[0].abs() < 1e-14);
        assert!((actual[1] - 3.0).abs() < 1e-14);
        assert_eq!(actual[2], 0.0);
        assert_eq!(transform([1.0, 2.0, 3.0], &[], 1, None).unwrap(), [1.0, 2.0, 3.0]);
        let about_offset = [record(&["0", "0", "0"]), record(&["1", "0", "0", "1", "0", "1", "180"])];
        let actual = transform([2.0, 0.0, 0.0], &about_offset, 1, None).unwrap();
        assert!(actual[0].abs() < 1e-14);
        for records in [
            vec![record(&["0", "0"])],
            vec![record(&["0", "0", "0"]), record(&["0", "0", "0", "0", "0", "0", "0"])],
            vec![record(&["0", "0", "0"]), record(&["0"])],
            vec![record(&["0", "0", "0"]); 3],
            vec![record(&["NaN", "0", "0"])],
            vec![record(&["1e308", "0", "0"])],
        ] {
            assert!(transform([1e308, 0.0, 0.0], &records, 3, None).is_err());
        }
    }

    #[test]
    fn include_discovery_preserves_case_uses_submission_root_and_lists_all_missing_paths() {
        let root = "*INCLUDE, INPUT=\"Mesh Files/Nodes.inp\"\n*INCLUDE, INPUT=loads.inp\n";
        assert_eq!(
            source_dependencies(root, Some("Main.inp"), &BTreeMap::new()).unwrap(),
            ["Mesh Files/Nodes.inp", "loads.inp"]
        );
        let sources = BTreeMap::from([("Mesh Files/Nodes.inp".into(), "*INCLUDE, INPUT=Material.inp\n".into())]);
        assert_eq!(source_dependencies(root, Some("Main.inp"), &sources).unwrap(), ["Material.inp", "loads.inp"]);
        let sources = BTreeMap::from([
            ("a.inp".into(), "*INCLUDE, INPUT=Main.inp\n".into()),
            ("Main.inp".into(), "*INCLUDE, INPUT=a.inp\n".into()),
        ]);
        assert!(source_dependencies("*INCLUDE, INPUT=a.inp\n", Some("Main.inp"), &sources)
            .unwrap_err()
            .cause
            .contains("cycle"));
        assert!(expand_sources(root, Some("Main.inp"), &BTreeMap::new()).unwrap_err().cause.contains("not supplied"));
        let sources = BTreeMap::from([
            ("Mesh Files/Nodes.inp".into(), "*NODE\n1,0,0,0\n".into()),
            ("loads.inp".into(), "*CLOAD\n1,1,10\n".into()),
        ]);
        let expanded = expand_sources(root, Some("Main.inp"), &sources).unwrap();
        assert_eq!(expanded[0].keyword.source.as_deref(), Some("Mesh Files/Nodes.inp"));
        assert_eq!(expanded[0].records[0].source.as_deref(), Some("Mesh Files/Nodes.inp"));
        assert_eq!(expanded[0].records[0].line, 2);
        assert_eq!(expanded[1].keyword.source.as_deref(), Some("loads.inp"));
    }

    #[test]
    fn include_graph_rejects_traversal_malformed_records_and_bounded_expansion() {
        for name in [
            "",
            "/absolute.inp",
            "../secret.inp",
            "a/../b.inp",
            "a//b.inp",
            "a/./b.inp",
            "C:secret.inp",
            "a\\b.inp",
            "a\0b.inp",
            "a\nb.inp",
        ] {
            assert!(source_path(name).is_err());
        }
        for text in [
            "*INCLUDE\n",
            "*INCLUDE, INPUT=a.inp, PASSWORD=x\n",
            "*INCLUDE, INPUT=a.inp\n1,2\n",
            "*INCLUDE, INPUT=\"unterminated\n",
            "*NODE\n1,∞\n",
        ] {
            assert!(source_dependencies(text, None, &BTreeMap::new()).is_err());
        }
        assert!(source_dependencies("*NODE", None, &BTreeMap::new()).is_err());
        assert!(source_dependencies("", Some("../bad"), &BTreeMap::new()).is_err());
        let missing_lf = BTreeMap::from([("a.inp".into(), "*NODE".into())]);
        assert!(source_dependencies("", None, &missing_lf).is_err());
        let too_many = (0..129).map(|n| (format!("f{n}.inp"), String::new())).collect();
        assert!(source_dependencies("", None, &too_many).is_err());
        let excessive = BTreeMap::from([("a.inp".into(), " ".repeat(abaqus::MAX_INPUT_BYTES) + "\n")]);
        assert!(source_dependencies("", None, &excessive).is_err());
        let chain = (0..17).map(|n| (format!("f{n}.inp"), format!("*INCLUDE, INPUT=f{}.inp\n", n + 1))).collect();
        assert!(source_dependencies("*INCLUDE, INPUT=f0.inp\n", None, &chain).unwrap_err().cause.contains("nesting"));
        let payload = "** comment\n".repeat(100_000);
        let sources = BTreeMap::from([("a.inp".into(), payload)]);
        let root = "*INCLUDE, INPUT=a.inp\n".repeat(20);
        assert!(source_dependencies(&root, None, &sources).unwrap_err().cause.contains("expanded"));
    }
    #[test]
    fn presentation_admission_bounds_repeated_text_and_empty_records_before_append() {
        let mut global = Builder::default();
        let mut budget = PresentationBudget { byte_limit: 7, record_limit: 10, ..PresentationBudget::default() };
        budget.append(&mut global, vec!["1234".into()], vec![], 1).unwrap();
        let error = budget.append(&mut global, vec!["5678".into()], vec![], 2).unwrap_err();
        assert_eq!(error.cause, "expanded presentation exceeds 7 UTF-8 bytes");
        assert_eq!(global.headings, ["1234"]);
        assert_eq!(budget.bytes, 4);
        assert_eq!(budget.records, 1);
        let mut budget = PresentationBudget { byte_limit: 5, record_limit: 10, ..PresentationBudget::default() };
        let flags = BTreeMap::from([("ECHO".into(), true)]);
        budget.append(&mut global, vec![], vec![flags.clone()], 1).unwrap();
        assert_eq!(budget.bytes, 5);
        assert!(budget.append(&mut global, vec![], vec![flags], 2).is_err());
        assert_eq!(global.preprint.len(), 1);
        let mut budget = PresentationBudget { record_limit: 1, ..PresentationBudget::default() };
        budget.append(&mut global, vec![String::new()], vec![], 1).unwrap();
        let error = budget.append(&mut global, vec![], vec![BTreeMap::new()], 2).unwrap_err();
        assert_eq!(error.cause, "expanded presentation exceeds 1 records");
        assert_eq!(global.preprint.len(), 1);
        assert_eq!(budget.bytes, 0);
        assert_eq!(budget.records, 1);
    }

    #[test]
    fn expansion_is_reserved_before_a_later_instance_is_parsed_or_copied() {
        let text = include_str!("../../tests/fixtures/abaqus/assembly-two-instances.inp");
        let poisoned = text.replace("*NSET, NSET=TIP\n40\n", "*NSET,NSET=TIP\nUNDEFINED\n");
        let root = "*INCLUDE,INPUT=Parts/assembly.inc\n";
        let digest = crate::hash::sha256_hex(root.as_bytes());
        let sources = BTreeMap::from([("Parts/assembly.inc".into(), poisoned)]);
        let error = normalize_deck(
            root,
            "mesh",
            &Q::text("1 m"),
            &digest,
            Some("Main.inp"),
            &sources,
            NormalizationPolicy {
                allow_analysis: false,
                expansion_limit: ExpansionCount { nodes: 7, elements: 2, memberships: 100 },
            },
        )
        .err()
        .unwrap();
        assert_eq!(error.cause, "expanded assembly exceeds 7 nodes");
        assert_eq!(error.where_.as_deref(), Some("Parts/assembly.inc: line 20 *INSTANCE nodes"));
        let current = ExpansionCount { nodes: 4, elements: 1, memberships: 4 };
        for additional in [
            ExpansionCount { nodes: 4, elements: 0, memberships: 0 },
            ExpansionCount { nodes: 0, elements: 2, memberships: 0 },
            ExpansionCount { nodes: 0, elements: 0, memberships: 5 },
        ] {
            assert!(check_expansion(current, additional, ExpansionCount { nodes: 7, elements: 2, memberships: 8 }, 1)
                .is_err());
        }
    }

    #[test]
    fn typed_record_admission_stops_before_copying_oversized_or_duplicate_tails() {
        let mut budget = CollectionBudget { record_limit: 2, entity_limit: 2, ..CollectionBudget::default() };
        let error = blocks("*NODE\n1,0\n1,0\n∞\n", None, &mut budget, true).unwrap_err();
        assert!(error.cause.contains("already defined"));
        assert_eq!(budget.records, 2);
        assert_eq!(budget.nodes, 1);
        let mut budget = CollectionBudget { record_limit: 2, entity_limit: 2, ..CollectionBudget::default() };
        assert!(blocks("*NODE\n1,0\n2,0\n3,0\n", None, &mut budget, true).unwrap_err().cause.contains("data records"));
        assert_eq!(budget.records, 2);
        let mut budget = CollectionBudget { record_limit: 10, entity_limit: 2, ..CollectionBudget::default() };
        assert!(blocks("*NODE\n1,0\n2,0\n3,0\n", None, &mut budget, true).unwrap_err().cause.contains("2 nodes"));
        let mut budget = CollectionBudget { record_limit: 10, entity_limit: 2, ..CollectionBudget::default() };
        assert!(blocks("*HEADING\n*PREPRINT\n*NODE\n", None, &mut budget, true)
            .unwrap_err()
            .cause
            .contains("keyword records"));
        let query = "*ELEMENT,TYPE=UNSUPPORTED\nnot connectivity\n*INCLUDE,INPUT=nodes.inc\n";
        assert_eq!(source_dependencies(query, None, &BTreeMap::new()).unwrap(), ["nodes.inc"]);
    }
    #[test]
    fn typed_scoped_resolvers_distinguish_sets_labels_and_quoted_numeric_names() {
        let text = include_str!("../../tests/fixtures/abaqus/assembly-two-instances.inp");
        let digest = crate::hash::sha256_hex(text.as_bytes());
        let deck = normalize_sources(text, "mesh", &Q::text("1 m"), &digest, None, &BTreeMap::new()).unwrap();
        assert_eq!(
            deck.node_target(&DeckScope::Model, "\"Assembly A\".\"second instance\".\"Root, = Face\"", 1, "BOUNDARY")
                .unwrap(),
            [5, 6, 7]
        );
        assert_eq!(deck.node_target(&DeckScope::Assembly, "\"second instance\".20", 1, "CLOAD").unwrap(), [6]);
        assert_eq!(deck.node_set_target(&DeckScope::Model, "\"second instance\".20", 1, "CLOAD").unwrap(), None);
        assert!(deck
            .node_set_target(&DeckScope::Instance("second instance".into()), "TIP", 1, "BOUNDARY")
            .unwrap()
            .is_some());
        assert_eq!(deck.element_target(&DeckScope::Model, "BOTH", 1, "DLOAD").unwrap(), [1, 2]);
        assert_eq!(deck.surface_target(&DeckScope::Model, "BOTTOMS", 1, "DSLOAD").unwrap(), "BOTTOMS");
        for target in ["UNKNOWN", "\"second instance\".999", "A.B.C.D"] {
            assert!(deck.node_target(&DeckScope::Model, target, 1, "BOUNDARY").is_err());
        }
        assert!(deck.surface_target(&DeckScope::Model, "UNKNOWN", 1, "DSLOAD").is_err());
        assert!(deck.node_set_target(&DeckScope::Model, "UNKNOWN", 1, "BOUNDARY").is_err());
        assert!(deck.element_target(&DeckScope::Model, "UNKNOWN", 1, "DLOAD").is_err());
        let quoted = text.replace("NSET=TIP", "NSET=\"12\"");
        let deck = normalize_sources(
            &quoted,
            "mesh",
            &Q::text("1 m"),
            &crate::hash::sha256_hex(quoted.as_bytes()),
            None,
            &BTreeMap::new(),
        )
        .unwrap();
        assert_eq!(deck.node_target(&DeckScope::Model, "\"second instance\".\"12\"", 1, "CLOAD").unwrap(), [8]);
        assert!(deck.node_set_target(&DeckScope::Model, "\"second instance\".\"12\"", 1, "CLOAD").unwrap().is_some());
    }

    #[test]
    fn malformed_structural_scopes_and_mesh_after_history_are_never_normalized_away() {
        for text in [
            "*END PART\n",
            "*END INSTANCE\n",
            "*END ASSEMBLY\n",
            "*PART, NAME=P\n",
            "*PART,NAME=P\n*END PART\n",
            "*ASSEMBLY,NAME=A\n*END ASSEMBLY\n",
            "*INSTANCE,NAME=I,PART=P\n",
            "*PART,NAME=P\n*END PART\n*PART,NAME=P\n",
            "*PART,NAME=P\n*STEP\n",
            "*ASSEMBLY,NAME=A\n*ASSEMBLY,NAME=B\n",
            "*PART,NAME=P\n*END PART\n*ASSEMBLY,NAME=A\n*INSTANCE,NAME=I,PART=UNKNOWN\n",
        ] {
            assert!(
                normalize_sources(
                    text,
                    "mesh",
                    &Q::text("1 m"),
                    &crate::hash::sha256_hex(text.as_bytes()),
                    None,
                    &BTreeMap::new()
                )
                .is_err(),
                "{text}"
            );
        }
        let fixture = include_str!("../../tests/fixtures/abaqus/assembly-two-instances.inp");
        for suffix in [
            "*STEP,NAME=S\n*STATIC\n*END STEP\n*NODE\n1,0,0,0\n",
            "*STEP,NAME=S\n*STATIC\n*END STEP\n*PART,NAME=LATE\n",
        ] {
            let text = format!("{fixture}{suffix}");
            let error = normalize_sources(
                &text,
                "mesh",
                &Q::text("1 m"),
                &crate::hash::sha256_hex(text.as_bytes()),
                None,
                &BTreeMap::new(),
            )
            .err()
            .unwrap();
            assert!(error.cause.contains("must precede"));
        }
    }
    #[test]
    fn static_normalization_rejects_mesh_history_and_nested_steps_at_the_authored_source() {
        let fixture = include_str!("../../tests/fixtures/abaqus/assembly-two-instances.inp");
        for suffix in [
            "*NODE\n999,0,0,0\n",
            "*ELEMENT,TYPE=C3D4\n999,1,2,3,4\n",
            "*NSET,NSET=LATE\n1\n",
            "*ELSET,ELSET=LATE\n1\n",
            "*SURFACE,NAME=LATE\n1,S1\n",
            "*HEADING\nlate\n",
            "*PREPRINT\n",
            "*PART,NAME=LATE\n",
            "*ASSEMBLY,NAME=LATE\n",
            "*INSTANCE,NAME=LATE,PART=P\n",
            "*ENDPART\n",
            "*ENDASSEMBLY\n",
            "*ENDINSTANCE\n",
        ] {
            let text = format!("{fixture}*STEP,NAME=S\n*STATIC\n*END STEP\n{suffix}");
            let error = normalize_sources(
                &text,
                "mesh",
                &Q::text("1 m"),
                &crate::hash::sha256_hex(text.as_bytes()),
                Some("authored.inp"),
                &BTreeMap::new(),
            )
            .err()
            .unwrap();
            assert!(error.cause.contains("must precede all Steps"), "{suffix}: {error:?}");
            assert!(error.where_.as_deref().unwrap().starts_with("authored.inp: line "), "{error:?}");
        }
        for scope in [
            "*PART,NAME=P\n",
            "*ASSEMBLY,NAME=A\n",
            "*PART,NAME=P\n*ENDPART\n*ASSEMBLY,NAME=A\n*INSTANCE,NAME=I,PART=P\n",
        ] {
            let text = format!("{scope}*STEP\n*STATIC\n");
            let error = normalize_sources(
                &text,
                "mesh",
                &Q::text("1 m"),
                &crate::hash::sha256_hex(text.as_bytes()),
                Some("authored.inp"),
                &BTreeMap::new(),
            )
            .err()
            .unwrap();
            assert!(error.cause.contains("STEP must be outside"), "{scope}: {error:?}");
            assert!(error.where_.as_deref().unwrap().contains("*STEP scope"));
        }
    }

    #[test]
    fn scoped_analysis_is_admitted_before_copying_repeated_keywords_or_records() {
        let blocks =
            blocks("*MATERIAL,NAME=A\n*ELASTIC\n1,.3\n", None, &mut CollectionBudget::default(), true).unwrap();
        let mut out = Vec::new();
        let mut budget = AnalysisBudget {
            records: CollectionBudget { entity_limit: 1, ..CollectionBudget::default() },
            ..AnalysisBudget::default()
        };
        assert!(append_analysis(&mut out, &mut budget, &blocks, None).unwrap_err().cause.contains("keyword records"));
        assert_eq!(out.len(), 1);
        let mut out = Vec::new();
        let mut budget = AnalysisBudget {
            records: CollectionBudget { record_limit: 0, ..CollectionBudget::default() },
            ..AnalysisBudget::default()
        };
        assert!(append_analysis(&mut out, &mut budget, &blocks[1..], None).unwrap_err().cause.contains("data records"));
        assert!(out.is_empty());
        let scope = DeckScope::Instance("retained instance".into());
        append_analysis(&mut out, &mut AnalysisBudget::default(), &blocks, Some(&scope)).unwrap();
        assert_eq!(out.len(), 2);
        assert!(out.iter().all(|block| block.scope == scope));
    }

    #[test]
    fn scoped_analysis_admits_owned_payload_before_cloning_repeated_blocks() {
        let source_blocks =
            blocks("*MATERIAL,NAME=LongMaterialLabel\n", None, &mut CollectionBudget::default(), true).unwrap();
        let scope = DeckScope::Instance("long instance label".into());
        let mut budget = AnalysisBudget { byte_limit: 1, ..AnalysisBudget::default() };
        let mut out = Vec::new();
        assert!(append_analysis(&mut out, &mut budget, &source_blocks, Some(&scope))
            .unwrap_err()
            .cause
            .contains("retained text"));
        assert!(out.is_empty());
        let mut budget = AnalysisBudget::default();
        append_analysis(&mut out, &mut budget, &source_blocks, Some(&scope)).unwrap();
        assert_eq!(
            budget.bytes,
            "MATERIAL".len() + "NAME".len() + "LongMaterialLabel".len() + "long instance label".len()
        );
        budget.byte_limit = budget.bytes;
        assert!(append_analysis(&mut out, &mut budget, &source_blocks, Some(&scope)).is_err());
        assert_eq!(out.len(), 1);
        let blocks = blocks("*ELASTIC\n1,.3\n", None, &mut CollectionBudget::default(), true).unwrap();
        let mut budget = AnalysisBudget::default();
        let mut out = Vec::new();
        append_analysis(&mut out, &mut budget, &blocks, None).unwrap();
        assert_eq!(budget.bytes, "ELASTIC".len() + "1,.3".len() + "1".len() + ".3".len());
    }

    #[test]
    fn alternate_data_admission_stops_before_oversized_record_entity_and_byte_copies() {
        for (budget, cause, expected) in [
            (
                CollectionBudget { record_limit: 1, ..CollectionBudget::default() },
                "data records",
                "Nodes.inp: line 2 *INPUT records",
            ),
            (
                CollectionBudget { entity_limit: 1, ..CollectionBudget::default() },
                "nodes",
                "Nodes.inp: line 2 *NODE count",
            ),
        ] {
            let mut budget = budget;
            let mut owner =
                blocks("*NODE,INPUT=Nodes.inp\n", Some("Owner.inp"), &mut CollectionBudget::default(), true)
                    .unwrap()
                    .remove(0);
            let mut bytes = 0;
            let error =
                alternate_records("1,0,0,0\n2,1,0,0\n∞\n", "Nodes.inp", &mut owner, &mut budget, &mut bytes, true)
                    .unwrap_err();
            assert!(error.cause.contains(cause), "{error:?}");
            assert_eq!(error.where_.as_deref(), Some(expected));
            assert_eq!(owner.records.len(), 1);
        }
        let mut owner = blocks(
            "*ELEMENT,TYPE=C3D4,INPUT=Elements.inp\n",
            Some("Owner.inp"),
            &mut CollectionBudget::default(),
            true,
        )
        .unwrap()
        .remove(0);
        let mut bytes = abaqus::MAX_INPUT_BYTES;
        let error = alternate_records(
            "1,1,2,3,4\n",
            "Elements.inp",
            &mut owner,
            &mut CollectionBudget::default(),
            &mut bytes,
            true,
        )
        .unwrap_err();
        assert!(error.cause.contains("16 MiB"));
        assert!(owner.records.is_empty());
    }

    #[test]
    fn alternate_data_discovery_checks_file_limits_escaping_cycles_and_raw_keywords() {
        assert_eq!(
            source_dependencies(
                "*NODE,INPUT=\"Data/Nodes.inp\"\n*ELEMENT,TYPE=UNKNOWN,INPUT=Data/Elements.inp\n",
                Some("Main.inp"),
                &BTreeMap::new()
            )
            .unwrap(),
            ["Data/Elements.inp", "Data/Nodes.inp"]
        );
        for text in ["*NODE,INPUT=../Nodes.inp\n", "*ELEMENT,TYPE=C3D4,INPUT=/Elements.inp\n", "*NODE,INPUT=Main.inp\n"]
        {
            assert!(source_dependencies(text, Some("Main.inp"), &BTreeMap::new()).is_err());
        }
        let sources = BTreeMap::from([("Parts/Beam.inp".into(), "*NODE,INPUT=Main.inp\n".into())]);
        assert!(source_dependencies("*INCLUDE,INPUT=Parts/Beam.inp\n", Some("Main.inp"), &sources)
            .unwrap_err()
            .cause
            .contains("cycle"));
        let sources = BTreeMap::from([("Nodes.inp".into(), "*INCLUDE,INPUT=Main.inp\n".into())]);
        let error = source_dependencies("*NODE,INPUT=Nodes.inp\n", Some("Main.inp"), &sources).unwrap_err();
        assert_eq!(error.where_.as_deref(), Some("Nodes.inp: line 1 *NODE INPUT"));
        let sources = (0..129).map(|index| (format!("Nodes{index}.inp"), String::new())).collect();
        assert!(source_dependencies("*NODE,INPUT=Nodes0.inp\n", Some("Main.inp"), &sources)
            .unwrap_err()
            .cause
            .contains("128"));
        let sources = BTreeMap::from([("Nodes.inp".into(), format!("**{}\n", "x".repeat(abaqus::MAX_INPUT_BYTES)))]);
        assert!(source_dependencies("*NODE,INPUT=Nodes.inp\n", Some("Main.inp"), &sources)
            .unwrap_err()
            .cause
            .contains("aggregate"));
    }
}
