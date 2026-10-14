//! Strict, bounded Abaqus mesh-deck conversion. No paths, includes, model mutation or solve.
//! Syntax follows the vendor's 2025 Input Syntax / NODE / ELEMENT / NSET / ELSET / SURFACE
//! documentation; the deliberately narrower subset is recorded in docs/plans/500-abaqus-import.md.

use std::collections::{BTreeMap, BTreeSet};

use crate::command::{
    Command, Formulation, IdealisationSpec, ImportedElement, ImportedElementKind, ImportedFace, ImportedMeshSpec,
    ImportedNodeSpec, ImportedProvenance, MesherSpec,
};
use crate::error::{Error, ErrorCode};
use crate::imported::SourceLabels;
use crate::query::{AbaqusConversion, AbaqusConversionReport, AbaqusImportMode, AbaqusSetKind, AbaqusSetMapping};
use crate::units::{Length, Q};

pub const MAX_INPUT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_ENTITIES: usize = 250_000;
const MAX_MEMBERSHIPS: usize = 1_000_000;
pub const CONVERSION_VERSION: &str = "abaqus-mesh/1";
const SUGGESTION: &str = "query.convertAbaqus with a supported deck and explicit unitLength";

/// Parsed source plus presentation metadata. Coordinates and Commands use explicit SI units.
#[derive(Debug)]
pub struct MeshDeck {
    pub source: ImportedMeshSpec,
    pub headings: Vec<String>,
    pub preprint: Vec<BTreeMap<String, bool>>,
    pub source_labels: SourceLabels,
    pub bbox: [Q<Length>; 6],
    pub unit_length: Q<Length>,
}

pub(crate) fn malformed(line: usize, keyword: &str, field: &str, cause: impl Into<String>) -> Error {
    Error::schema(cause).at(format!("line {line} *{keyword} {field}")).suggest(SUGGESTION)
}

pub(crate) fn unsupported(line: usize, keyword: &str, field: &str, cause: impl Into<String>) -> Error {
    Error::new(ErrorCode::Unsupported, cause).at(format!("line {line} *{keyword} {field}")).suggest(SUGGESTION)
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Record<'a> {
    pub(crate) line: usize,
    pub(crate) text: &'a str,
}

/// Reads incrementally: an unsupported first keyword never allocates the remaining records.
pub(crate) struct Records<'a> {
    lines: std::iter::Enumerate<std::str::SplitTerminator<'a, char>>,
}

impl<'a> Records<'a> {
    pub(crate) fn new(text: &'a str) -> Self {
        Self { lines: text.split_terminator('\n').enumerate() }
    }

    pub(crate) fn next(&mut self) -> Result<Option<Record<'a>>, Error> {
        for (index, raw) in self.lines.by_ref() {
            let line = index + 1;
            let text = raw.strip_suffix('\r').unwrap_or(raw);
            // Abaqus comments occupy columns 1–2 and may occur between continuation records.
            if text.starts_with("**") || text.bytes().all(|c| c == b' ' || c == b'\t') {
                continue;
            }
            if text.len() > 256 {
                return Err(malformed(
                    line,
                    "INPUT",
                    "physical line",
                    "keyword/data lines must be at most 256 characters",
                ));
            }
            if !text.is_ascii() || text.bytes().any(|c| c.is_ascii_control() && c != b'\t') {
                return Err(malformed(
                    line,
                    "INPUT",
                    "physical line",
                    "keyword/data records require printable ASCII or tabs",
                ));
            }
            return Ok(Some(Record { line, text }));
        }
        Ok(None)
    }

    pub(crate) fn keyword(&mut self, first: Record<'a>) -> Result<Keyword, Error> {
        let mut joined = first.text.trim().to_string();
        while joined.trim_end().ends_with(',') {
            let continuation = self.next()?.ok_or_else(|| {
                malformed(first.line, "INPUT", "keyword continuation", "a trailing keyword comma needs another record")
            })?;
            if continuation.text.trim_start().starts_with('*') {
                return Err(malformed(
                    continuation.line,
                    "INPUT",
                    "keyword continuation",
                    "a new keyword cannot continue the previous keyword",
                ));
            }
            joined.push_str(continuation.text.trim());
        }
        // Blanks on keyword records are ignored by Abaqus. Full spellings remain mandatory.
        let compact: String = joined.chars().filter(|c| !c.is_ascii_whitespace()).collect();
        let mut fields = compact[1..].split(',');
        let name = fields.next().unwrap_or_default().to_ascii_uppercase();
        if name.is_empty() || name.contains('=') {
            return Err(malformed(first.line, "INPUT", "keyword", "a keyword needs its full name after '*'"));
        }
        let mut parameters = BTreeMap::new();
        for field in fields {
            let (key, value) = match field.split_once('=') {
                Some((key, value)) => {
                    if value.is_empty() || value.contains('=') {
                        return Err(malformed(
                            first.line,
                            &name,
                            "parameter",
                            "a parameter needs exactly one nonempty value",
                        ));
                    }
                    (key, Some(value.to_ascii_uppercase()))
                }
                None => (field, None),
            };
            let key = key.to_ascii_uppercase();
            if key.is_empty() || parameters.contains_key(&key) {
                return Err(malformed(
                    first.line,
                    &name,
                    "parameter",
                    "empty or duplicate keyword parameters are rejected",
                ));
            }
            parameters.insert(key, value);
        }
        Ok(Keyword { line: first.line, name, parameters })
    }
}

#[derive(Debug)]
pub(crate) struct Keyword {
    pub(crate) line: usize,
    pub(crate) name: String,
    pub(crate) parameters: BTreeMap<String, Option<String>>,
}

impl Keyword {
    pub(crate) fn only(&self, allowed: &[&str]) -> Result<(), Error> {
        for key in self.parameters.keys() {
            if !allowed.contains(&key.as_str()) {
                return Err(unsupported(
                    self.line,
                    &self.name,
                    key,
                    format!("parameter {key} is outside the supported mesh subset"),
                ));
            }
        }
        Ok(())
    }

    pub(crate) fn value(&self, key: &str) -> Result<Option<&str>, Error> {
        match self.parameters.get(key) {
            Some(Some(value)) => Ok(Some(value)),
            Some(None) => Err(malformed(self.line, &self.name, key, format!("{key} requires a value"))),
            None => Ok(None),
        }
    }

    pub(crate) fn required(&self, key: &str) -> Result<&str, Error> {
        self.value(key)?.ok_or_else(|| malformed(self.line, &self.name, key, format!("{key} is required")))
    }

    pub(crate) fn flag(&self, key: &str) -> Result<bool, Error> {
        match self.parameters.get(key) {
            Some(Some(_)) => Err(malformed(self.line, &self.name, key, format!("{key} takes no value"))),
            Some(None) => Ok(true),
            None => Ok(false),
        }
    }
}

pub(crate) fn name(text: &str, line: usize, keyword: &str, field: &str) -> Result<String, Error> {
    let mut chars = text.bytes();
    let first = chars.next();
    if text.len() > 80
        || !first.is_some_and(|c| c.is_ascii_alphabetic())
        || !chars.all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(unsupported(
            line,
            keyword,
            field,
            "names require unquoted [A-Za-z][A-Za-z0-9_-]*, at most 80 characters",
        ));
    }
    Ok(text.to_ascii_uppercase())
}

pub(crate) fn label(text: &str, line: usize, keyword: &str, field: &str) -> Result<u32, Error> {
    let digits = text.strip_prefix('+').unwrap_or(text);
    let value = if digits.len() <= 9 && digits.bytes().all(|c| c.is_ascii_digit()) {
        text.parse::<u32>().ok().filter(|value| (1..=999_999_999).contains(value))
    } else {
        None
    };
    value.ok_or_else(|| malformed(line, keyword, field, format!("'{text}' must be an integer label in 1..=999999999")))
}

pub(crate) fn scalar(text: &str, line: usize, keyword: &str, field: &str, scale: f64) -> Result<f64, Error> {
    let value = text
        .replace(['D', 'd'], "E")
        .parse::<f64>()
        .ok()
        // Numeric zero has one portable Command representation. JavaScript JSON erases its
        // sign, while Rust serde preserves it; the original text digest is kept independently.
        .map(|n| n * scale + 0.0)
        .filter(|n| n.is_finite());
    value.ok_or_else(|| malformed(line, keyword, field, format!("'{text}' must convert to a finite numeric value")))
}

pub(crate) fn fields<'a>(record: Record<'a>, keyword: &str, min: usize, max: usize) -> Result<Vec<&'a str>, Error> {
    let fields: Vec<_> = record.text.split(',').map(str::trim).collect();
    if fields.len() < min || fields.len() > max {
        return Err(malformed(
            record.line,
            keyword,
            "record",
            format!("expected {min}..={max} fields, got {}", fields.len()),
        ));
    }
    Ok(fields)
}

struct NamedSet {
    members: BTreeMap<u32, usize>,
}

enum Section {
    Heading,
    Preprint,
    Nodes { set: Option<String> },
    Elements { kind: ImportedElementKind, set: Option<String> },
    Set { nodes: bool, name: String, generate: bool },
    SetFromElements,
    Surface { name: String },
}

pub(crate) struct Active {
    keyword: Keyword,
    section: Section,
    records: usize,
}

impl Active {
    pub(crate) fn finish(&self) -> Result<(), Error> {
        let requires_data = match self.section {
            Section::Heading | Section::Preprint | Section::SetFromElements => false,
            Section::Nodes { .. } | Section::Elements { .. } | Section::Set { .. } | Section::Surface { .. } => true,
        };
        if requires_data && self.records == 0 {
            return Err(malformed(
                self.keyword.line,
                &self.keyword.name,
                "data",
                "this keyword requires at least one data record",
            ));
        }
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct Builder {
    nodes: BTreeMap<u32, (ImportedNodeSpec, usize)>,
    elements: BTreeMap<u32, (ImportedElement, usize)>,
    node_sets: BTreeMap<String, NamedSet>,
    element_sets: BTreeMap<String, NamedSet>,
    surfaces: BTreeMap<String, (usize, BTreeMap<ImportedFace, usize>)>,
    headings: Vec<String>,
    preprint: Vec<BTreeMap<String, bool>>,
    memberships: usize,
}

impl Builder {
    fn room_for(&self, count: usize, line: usize, keyword: &str) -> Result<(), Error> {
        if self.memberships.saturating_add(count) > MAX_MEMBERSHIPS {
            return Err(malformed(
                line,
                keyword,
                "memberships",
                "expanded Set declarations exceed 1000000 memberships",
            ));
        }
        Ok(())
    }

    fn reserve_members(&mut self, count: usize, line: usize, keyword: &str) -> Result<(), Error> {
        self.room_for(count, line, keyword)?;
        self.memberships += count;
        Ok(())
    }

    /// Insert members after their declaration count was checked and reserved.
    fn append_members(&mut self, nodes: bool, set: &str, members: Vec<u32>, line: usize) {
        let sets = if nodes { &mut self.node_sets } else { &mut self.element_sets };
        let entry = sets.entry(set.to_string()).or_insert_with(|| NamedSet { members: BTreeMap::new() });
        for member in members {
            entry.members.entry(member).or_insert(line);
        }
    }

    pub(crate) fn start(&mut self, keyword: Keyword) -> Result<Active, Error> {
        let section = match keyword.name.as_str() {
            "HEADING" => {
                keyword.only(&[])?;
                Section::Heading
            }
            "PREPRINT" => {
                keyword.only(&["ECHO", "MODEL", "HISTORY", "CONTACT"])?;
                let mut settings = BTreeMap::new();
                for key in keyword.parameters.keys() {
                    let value = keyword.required(key)?;
                    let enabled = match value {
                        "YES" => true,
                        "NO" => false,
                        _ => {
                            return Err(unsupported(keyword.line, "PREPRINT", key, "PREPRINT values must be YES or NO"))
                        }
                    };
                    settings.insert(key.clone(), enabled);
                }
                self.preprint.push(settings);
                Section::Preprint
            }
            "NODE" => {
                keyword.only(&["NSET", "SYSTEM"])?;
                if keyword.value("SYSTEM")?.is_some_and(|system| system != "R") {
                    return Err(unsupported(
                        keyword.line,
                        "NODE",
                        "SYSTEM",
                        "only global rectangular coordinates (SYSTEM=R) are supported",
                    ));
                }
                let set = keyword.value("NSET")?.map(|s| name(s, keyword.line, "NODE", "NSET")).transpose()?;
                Section::Nodes { set }
            }
            "ELEMENT" => {
                keyword.only(&["TYPE", "ELSET"])?;
                let kind = match keyword.required("TYPE")? {
                    "C3D4" => ImportedElementKind::Tet4,
                    "C3D8" => ImportedElementKind::Hex8,
                    other => {
                        return Err(unsupported(
                            keyword.line,
                            "ELEMENT",
                            "TYPE",
                            format!("element type {other} is unsupported; choose standard C3D4 or C3D8"),
                        ))
                    }
                };
                let set = keyword.value("ELSET")?.map(|s| name(s, keyword.line, "ELEMENT", "ELSET")).transpose()?;
                Section::Elements { kind, set }
            }
            "NSET" | "ELSET" => self.start_set(&keyword)?,
            "SURFACE" => {
                keyword.only(&["NAME", "TYPE"])?;
                if keyword.required("TYPE")? != "ELEMENT" {
                    return Err(unsupported(
                        keyword.line,
                        "SURFACE",
                        "TYPE",
                        "only explicit TYPE=ELEMENT surfaces are supported",
                    ));
                }
                let set = name(keyword.required("NAME")?, keyword.line, "SURFACE", "NAME")?;
                if self.surfaces.contains_key(&set) {
                    return Err(unsupported(
                        keyword.line,
                        "SURFACE",
                        "NAME",
                        "repeated surface definitions are outside the first mesh subset",
                    ));
                }
                self.surfaces.insert(set.clone(), (keyword.line, BTreeMap::new()));
                Section::Surface { name: set }
            }
            _ => {
                return Err(unsupported(
                    keyword.line,
                    &keyword.name,
                    "keyword",
                    format!("*{} is outside the supported mesh subset; no analysis data is discarded", keyword.name),
                ))
            }
        };
        Ok(Active { keyword, section, records: 0 })
    }

    fn start_set(&mut self, keyword: &Keyword) -> Result<Section, Error> {
        let nodes = keyword.name == "NSET";
        if nodes {
            keyword.only(&["NSET", "ELSET", "GENERATE"])?;
        } else {
            keyword.only(&["ELSET", "GENERATE"])?;
        }
        let set = name(keyword.required(&keyword.name)?, keyword.line, &keyword.name, &keyword.name)?;
        let generate = keyword.flag("GENERATE")?;
        let from = if nodes { keyword.value("ELSET")? } else { None };
        if let Some(from) = from {
            if generate {
                return Err(malformed(
                    keyword.line,
                    "NSET",
                    "ELSET/GENERATE",
                    "ELSET and GENERATE are mutually exclusive",
                ));
            }
            let from = name(from, keyword.line, "NSET", "ELSET")?;
            let elements = self.element_sets.get(&from).filter(|set| !set.members.is_empty()).ok_or_else(|| {
                malformed(keyword.line, "NSET", "ELSET", format!("ELSET {from} must already exist and be nonempty"))
            })?;
            let mut count = 0usize;
            for &id in elements.members.keys() {
                let (element, _) = self.elements.get(&id).ok_or_else(|| {
                    malformed(
                        keyword.line,
                        "NSET",
                        "ELSET",
                        format!("source element {id} must exist before deriving its node Set"),
                    )
                })?;
                count = count.saturating_add(element.nodes.len());
            }
            self.room_for(count, keyword.line, "NSET")?;
            self.memberships += count;
            let mut members = Vec::with_capacity(count);
            for &id in elements.members.keys() {
                // Every element reference was checked before allocation above.
                let (element, _) = self.elements.get(&id).expect("element references validated above");
                members.extend_from_slice(&element.nodes);
            }
            self.append_members(true, &set, members, keyword.line);
            return Ok(Section::SetFromElements);
        }
        Ok(Section::Set { nodes, name: set, generate })
    }

    pub(crate) fn record(&mut self, active: &mut Active, record: Record<'_>, scale: f64) -> Result<(), Error> {
        let keyword = active.keyword.name.as_str();
        match &active.section {
            Section::Heading => self.headings.push(record.text.to_string()),
            Section::Preprint | Section::SetFromElements => {
                return Err(malformed(record.line, keyword, "data", "this keyword accepts no data records"));
            }
            Section::Nodes { set } => {
                let values = fields(record, "NODE", 2, 4)?;
                let id = label(values[0], record.line, "NODE", "label")?;
                if self.nodes.contains_key(&id) {
                    return Err(malformed(
                        record.line,
                        "NODE",
                        "label",
                        format!("source node {id} is already defined"),
                    ));
                }
                if self.nodes.len() == MAX_ENTITIES {
                    return Err(malformed(record.line, "NODE", "count", "source exceeds 250000 nodes"));
                }
                let mut at = [Q::new(0.0, "m"), Q::new(0.0, "m"), Q::new(0.0, "m")];
                for (axis, text) in values.iter().skip(1).enumerate() {
                    if axis > 0 && text.is_empty() {
                        continue;
                    }
                    at[axis] = Q::new(
                        scalar(text, record.line, "NODE", &format!("node {id} coordinate {}", axis + 1), scale)?,
                        "m",
                    );
                }
                self.nodes.insert(id, (ImportedNodeSpec { label: id, at }, record.line));
                if let Some(set) = set {
                    self.reserve_members(1, record.line, "NODE")?;
                    self.append_members(true, set, vec![id], record.line);
                }
            }
            Section::Elements { kind, set } => {
                let arity = match kind {
                    ImportedElementKind::Tet4 => 4,
                    ImportedElementKind::Hex8 => 8,
                };
                let values = fields(record, "ELEMENT", arity + 1, arity + 1)?;
                let id = label(values[0], record.line, "ELEMENT", "label")?;
                if self.elements.contains_key(&id) {
                    return Err(malformed(
                        record.line,
                        "ELEMENT",
                        "label",
                        format!("source element {id} is already defined"),
                    ));
                }
                if self.elements.len() == MAX_ENTITIES {
                    return Err(malformed(record.line, "ELEMENT", "count", "source exceeds 250000 elements"));
                }
                let mut nodes = Vec::with_capacity(arity);
                for (index, value) in values.iter().skip(1).enumerate() {
                    let node = label(value, record.line, "ELEMENT", &format!("element {id} node {}", index + 1))?;
                    if nodes.contains(&node) {
                        return Err(malformed(
                            record.line,
                            "ELEMENT",
                            "connectivity",
                            format!("source element {id} repeats node {node}"),
                        ));
                    }
                    nodes.push(node);
                }
                self.elements.insert(id, (ImportedElement { label: id, kind: *kind, nodes }, record.line));
                if let Some(set) = set {
                    self.reserve_members(1, record.line, "ELEMENT")?;
                    self.append_members(false, set, vec![id], record.line);
                }
            }
            Section::Set { nodes, name: set, generate } => {
                let members = if *generate {
                    let values = fields(record, keyword, 2, 3)?;
                    let first = label(values[0], record.line, keyword, "first label")?;
                    let last = label(values[1], record.line, keyword, "last label")?;
                    let increment = match values.get(2).copied() {
                        Some("") | None => 1,
                        Some(value) => label(value, record.line, keyword, "increment")?,
                    };
                    if last < first || (last - first) % increment != 0 {
                        return Err(malformed(
                            record.line,
                            keyword,
                            "GENERATE range",
                            "last must be at least first and the range must be divisible by the positive increment",
                        ));
                    }
                    let count = ((last - first) / increment + 1) as usize;
                    self.reserve_members(count, record.line, keyword)?;
                    (0..count).map(|index| first + index as u32 * increment).collect()
                } else {
                    let values = fields(record, keyword, 1, 16)?;
                    let sets = if *nodes { &self.node_sets } else { &self.element_sets };
                    let mut members = Vec::new();
                    for value in values {
                        if value.starts_with(|c: char| c.is_ascii_digit() || c == '+' || c == '-') {
                            self.room_for(members.len() + 1, record.line, keyword)?;
                            members.push(label(value, record.line, keyword, "member label")?);
                        } else {
                            let reference = name(value, record.line, keyword, "referenced Set")?;
                            let captured =
                                sets.get(&reference).filter(|set| !set.members.is_empty()).ok_or_else(|| {
                                    malformed(
                                        record.line,
                                        keyword,
                                        "referenced Set",
                                        format!("{reference} must already exist as a nonempty {keyword}"),
                                    )
                                })?;
                            self.room_for(members.len().saturating_add(captured.members.len()), record.line, keyword)?;
                            members.extend(captured.members.keys().copied());
                        }
                    }
                    // Every push/extension checked the cumulative count before allocation.
                    // Consume it once; repeating a fallible reservation here cannot fail.
                    self.memberships += members.len();
                    members
                };
                self.append_members(*nodes, set, members, record.line);
            }
            Section::Surface { name: set } => {
                let values = fields(record, "SURFACE", 2, 2)?;
                let face = match values[1].to_ascii_uppercase().as_str() {
                    "S1" => 1,
                    "S2" => 2,
                    "S3" => 3,
                    "S4" => 4,
                    "S5" => 5,
                    "S6" => 6,
                    _ => {
                        return Err(unsupported(
                            record.line,
                            "SURFACE",
                            "face",
                            "an explicit face identifier S1..S6 is required",
                        ))
                    }
                };
                let elements = if values[0].starts_with(|c: char| c.is_ascii_digit() || c == '+' || c == '-') {
                    let element = label(values[0], record.line, "SURFACE", "source element")?;
                    self.reserve_members(1, record.line, "SURFACE")?;
                    vec![element]
                } else {
                    let reference = name(values[0], record.line, "SURFACE", "ELSET")?;
                    let captured =
                        self.element_sets.get(&reference).filter(|set| !set.members.is_empty()).ok_or_else(|| {
                            malformed(
                                record.line,
                                "SURFACE",
                                "ELSET",
                                format!("ELSET {reference} must already exist and be nonempty"),
                            )
                        })?;
                    self.room_for(captured.members.len(), record.line, "SURFACE")?;
                    let elements = captured.members.keys().copied().collect();
                    self.memberships += captured.members.len();
                    elements
                };
                let (_, surface) = self.surfaces.get_mut(set).expect("surface created by its keyword");
                for element in elements {
                    surface.entry(ImportedFace { element, face }).or_insert(record.line);
                }
            }
        }
        active.records += 1;
        Ok(())
    }
}

fn source_location(
    error: Error,
    nodes: &BTreeMap<u32, usize>,
    elements: &BTreeMap<u32, usize>,
    first_element: usize,
) -> Error {
    let original = error.where_.as_deref().unwrap_or("mesher");
    let mut line = first_element;
    let mut keyword = "ELEMENT";
    let mut record = "mesh-wide validation".to_string();
    // Imported source validation documents bracketed *source labels*, never dense FE indices.
    for (prefix, locations, source_keyword) in
        [("mesher.nodes[", nodes, "NODE"), ("mesher.elements[", elements, "ELEMENT")]
    {
        if let Some(rest) = original.strip_prefix(prefix) {
            if let Some((id, _)) = rest.split_once(']') {
                if let Ok(id) = id.parse::<u32>() {
                    if let Some(source_line) = locations.get(&id) {
                        line = *source_line;
                        keyword = source_keyword;
                        record = format!("source label {id}");
                    }
                }
            }
        }
    }
    let where_ = format!("line {line} *{keyword} {record}; {original}");
    error.at(where_).suggest(SUGGESTION)
}

impl Builder {
    pub(crate) fn finish(self, body: &str, digest: &str, scale: f64) -> Result<MeshDeck, Error> {
        if self.nodes.is_empty() || self.elements.is_empty() {
            return Err(malformed(1, "INPUT", "mesh", "a mesh deck requires nodes and elements"));
        }
        for (element, line) in self.elements.values() {
            for (index, node) in element.nodes.iter().enumerate() {
                if !self.nodes.contains_key(node) {
                    return Err(malformed(
                        *line,
                        "ELEMENT",
                        &format!("element {} node {}", element.label, index + 1),
                        format!("source node {node} is not defined"),
                    ));
                }
            }
        }
        for (keyword, sets, nodes) in [("NSET", &self.node_sets, true), ("ELSET", &self.element_sets, false)] {
            for (set, members) in sets {
                for (&member, &line) in &members.members {
                    let exists =
                        if nodes { self.nodes.contains_key(&member) } else { self.elements.contains_key(&member) };
                    if !exists {
                        return Err(malformed(
                            line,
                            keyword,
                            &format!("Set {set} member"),
                            format!("source label {member} is not defined"),
                        ));
                    }
                }
            }
        }
        for (set, (_, members)) in &self.surfaces {
            for (member, line) in members {
                let (element, _) = self.elements.get(&member.element).ok_or_else(|| {
                    malformed(
                        *line,
                        "SURFACE",
                        &format!("surface {set}"),
                        format!("source element {} is not defined", member.element),
                    )
                })?;
                let maximum = match element.kind {
                    ImportedElementKind::Tet4 => 4,
                    ImportedElementKind::Hex8 => 6,
                };
                if member.face > maximum {
                    return Err(malformed(
                        *line,
                        "SURFACE",
                        &format!("element {} face", member.element),
                        format!("S{} is invalid on this element type", member.face),
                    ));
                }
            }
        }
        let node_lines: BTreeMap<_, _> = self.nodes.iter().map(|(&id, (_, line))| (id, *line)).collect();
        let element_lines: BTreeMap<_, _> = self.elements.iter().map(|(&id, (_, line))| (id, *line)).collect();
        let first_element = element_lines.values().copied().min().expect("nonempty elements checked above");
        let source = ImportedMeshSpec {
            body: body.to_string(),
            nodes: self.nodes.into_values().map(|(node, _)| node).collect(),
            elements: self.elements.into_values().map(|(element, _)| element).collect(),
            node_sets: self
                .node_sets
                .into_iter()
                .map(|(name, set)| (name, set.members.into_keys().collect()))
                .collect(),
            element_sets: self
                .element_sets
                .into_iter()
                .map(|(name, set)| (name, set.members.into_keys().collect()))
                .collect(),
            surfaces: self.surfaces.into_iter().map(|(name, (_, faces))| (name, faces.into_keys().collect())).collect(),
            node_targets: Vec::new(),
            provenance: Some(ImportedProvenance {
                sha256: digest.to_string(),
                conversion_version: CONVERSION_VERSION.to_string(),
            }),
        };
        let checked = crate::imported::source(&source)
            .map_err(|error| source_location(error, &node_lines, &element_lines, first_element))?;
        let participating: BTreeSet<_> = checked.participating_labels();
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        let mut labels = SourceLabels::default();
        for node in &checked.nodes {
            if participating.contains(&node.label) {
                labels.nodes.push(node.label);
                for k in 0..3 {
                    lo[k] = lo[k].min(node.at[k]);
                    hi[k] = hi[k].max(node.at[k]);
                }
            } else {
                labels.unused_nodes.push(node.label);
            }
        }
        labels.elements = checked.elements.iter().map(|element| element.label).collect();
        let bbox = [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]].map(|value| Q::new(value, "m"));
        Ok(MeshDeck {
            source,
            headings: self.headings,
            preprint: self.preprint,
            source_labels: labels,
            bbox,
            unit_length: Q::new(scale, "m"),
        })
    }
}

/// Verify the byte bound, full raw-input digest, names/length scale and complete record endings
/// before either converter starts lexing. No file I/O or active Model mutation occurs here.
pub(crate) fn check_input(text: &str, body: &str, unit_length: &Q<Length>, digest: &str) -> Result<f64, Error> {
    if text.len() > MAX_INPUT_BYTES {
        return Err(Error::schema("Abaqus text exceeds the 16 MiB input bound").at("text").suggest(SUGGESTION));
    }
    if digest.len() != 64 || !digest.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        return Err(Error::schema("sha256 must be 64 lowercase hex characters").at("sha256").suggest(SUGGESTION));
    }
    let actual = crate::hash::sha256_hex(text.as_bytes());
    if actual != digest {
        return Err(Error::schema(format!("input hashes to {actual}, not the supplied {digest}"))
            .at("sha256")
            .suggest(SUGGESTION));
    }
    name(body, 0, "INPUT", "body").map_err(|error| error.at("body"))?;
    let scale = unit_length.si().map_err(|error| error.at("unitLength"))?;
    if scale <= 0.0 {
        return Err(Error::schema("unitLength must be positive").at("unitLength").suggest(SUGGESTION));
    }
    if !text.is_empty() && !text.ends_with('\n') {
        return Err(malformed(
            text.lines().count(),
            "INPUT",
            "line ending",
            "every Abaqus input record must end in LF or CRLF",
        ));
    }
    Ok(scale)
}

/// Parse a strict mesh deck; analysis-bearing converters use the same checked streaming records
/// and Builder directly, preserving original lines and the full input digest.
pub fn read_mesh(text: &str, body: &str, unit_length: &Q<Length>, digest: &str) -> Result<MeshDeck, Error> {
    let scale = check_input(text, body, unit_length, digest)?;
    let mut records = Records::new(text);
    let mut builder = Builder::default();
    let mut active: Option<Active> = None;
    while let Some(record) = records.next()? {
        if record.text.trim_start().starts_with('*') {
            if let Some(previous) = &active {
                previous.finish()?;
            }
            active = Some(builder.start(records.keyword(record)?)?);
        } else {
            let section = active
                .as_mut()
                .ok_or_else(|| malformed(record.line, "INPUT", "data", "data must follow an accepted keyword"))?;
            builder.record(section, record, scale)?;
        }
    }
    if let Some(previous) = &active {
        previous.finish()?;
    }
    builder.finish(body, digest, scale)
}

/// Count the bytes that serde would return without allocating another copy of the response.
/// This checks the response only; Candidate owns the exact Model-file/publication check.
struct BoundedCount {
    bytes: usize,
    limit: usize,
}

impl std::io::Write for BoundedCount {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let next = self.bytes.saturating_add(buf.len());
        if next > self.limit {
            return Err(std::io::Error::other("serialized Abaqus response bound exceeded"));
        }
        self.bytes = next;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn response_size(response: &AbaqusConversion, limit: usize) -> Result<usize, Error> {
    let mut writer = BoundedCount { bytes: 0, limit };
    serde_json::to_writer(&mut writer, response).map_err(|error| {
        Error::schema(format!("serialized Abaqus conversion response exceeds {limit} bytes: {error}"))
            .at("text")
            .suggest("query.convertAbaqus with a smaller mesh deck; publication still requires Candidate")
    })?;
    Ok(writer.bytes)
}

/// Apply the same exact serialized-response limit after each converter has finished its Commands.
pub(crate) fn check_response(response: &AbaqusConversion) -> Result<(), Error> {
    response_size(response, MAX_RESPONSE_BYTES).map(|_| ())
}

pub(crate) fn check_model_name(model_name: &str) -> Result<(), Error> {
    if model_name.trim().is_empty() || model_name.len() > 1024 {
        return Err(Error::schema("name must be nonblank and at most 1024 UTF-8 bytes").at("name").suggest(SUGGESTION));
    }
    Ok(())
}

/// Convert a checked mesh deck into portable Commands. No Engine or Candidate is constructed:
/// current-document conflicts, exact serialized Model-file size and publication stay host-owned.
pub fn convert_mesh(
    text: &str,
    model_name: &str,
    body: &str,
    unit_length: &Q<Length>,
    digest: &str,
) -> Result<AbaqusConversion, Error> {
    check_model_name(model_name)?;
    let parsed = read_mesh(text, body, unit_length, digest)?;
    let response = conversion_from_mesh(parsed, model_name, text.len(), digest);
    check_response(&response)?;
    Ok(response)
}

/// Base report/source Commands for an already checked MeshDeck. The analysis converter extends
/// this portable response and must call check_response after adding its final Commands/metadata.
pub(crate) fn conversion_from_mesh(
    parsed: MeshDeck,
    model_name: &str,
    input_bytes: usize,
    digest: &str,
) -> AbaqusConversion {
    let body = &parsed.source.body;
    let mut sets = Vec::new();
    for (kind, prefix, maps) in [
        (AbaqusSetKind::Node, "nset", &parsed.source.node_sets),
        (AbaqusSetKind::Element, "elset", &parsed.source.element_sets),
    ] {
        for (name, members) in maps {
            sets.push(AbaqusSetMapping {
                kind,
                source: name.clone(),
                target: format!("{body}.{prefix}_{name}"),
                count: members.len() as u32,
            });
        }
    }
    for (name, members) in &parsed.source.surfaces {
        sets.push(AbaqusSetMapping {
            kind: AbaqusSetKind::Face,
            source: name.clone(),
            target: format!("{body}.surface_{name}"),
            count: members.len() as u32,
        });
    }
    let report = AbaqusConversionReport {
        mode: AbaqusImportMode::Mesh,
        sha256: digest.to_string(),
        conversion_version: CONVERSION_VERSION.to_string(),
        input_bytes: input_bytes as u32,
        body: body.to_string(),
        unit_length: parsed.unit_length,
        source_nodes: parsed.source.nodes.len() as u32,
        active_nodes: parsed.source_labels.nodes.len() as u32,
        source_elements: parsed.source.elements.len() as u32,
        element_kind: parsed.source.elements.first().expect("read_mesh requires nonempty elements").kind,
        analysis_configured: false,
        bbox: parsed.bbox,
        source_labels: parsed.source_labels,
        sets,
        headings: parsed.headings,
        preprint: parsed.preprint,
    };
    AbaqusConversion {
        report,
        commands: vec![
            Command::ModelNew { name: model_name.to_string(), description: None },
            Command::ModelSetIdealisation { idealisation: IdealisationSpec::Solid3d },
            Command::MeshSet {
                mesher: MesherSpec::Imported(parsed.source),
                order: Some(1),
                formulation: Some(Formulation::Full),
                simplices: None,
                refinement: None,
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn keyword(text: &str) -> Result<Keyword, Error> {
        let mut records = Records { lines: text.split_terminator('\n').enumerate() };
        let first = records.next()?.unwrap();
        records.keyword(first)
    }

    #[test]
    fn serialized_byte_counter_enforces_exact_bound_without_copying_data() {
        let mut counter = BoundedCount { bytes: 0, limit: 4 };
        assert_eq!(counter.write(b"ab").unwrap(), 2);
        assert_eq!(counter.write(b"cd").unwrap(), 2);
        assert_eq!(counter.bytes, 4);
        assert!(counter.write(b"e").is_err());
        assert_eq!(counter.bytes, 4);
        counter.flush().unwrap();
    }

    #[test]
    fn model_name_budget_counts_utf8_bytes_and_rejects_blank_names() {
        check_model_name("Abaqus mesh").unwrap();
        check_model_name(&"é".repeat(512)).unwrap();
        for invalid in [String::from(" \t\n"), "é".repeat(513)] {
            let error = check_model_name(&invalid).unwrap_err();
            assert_eq!(error.code, ErrorCode::Schema);
            assert_eq!(error.where_.as_deref(), Some("name"));
        }
    }

    #[test]
    fn physical_records_keep_lines_and_skip_only_comments_or_ascii_blanks() {
        let mut records = Records {
            lines: "** comment: Unicode is allowed here →\r\n\t \r\n*NODE\r\n1,0\r\n"
                .split_terminator('\n')
                .enumerate(),
        };
        let first = records.next().unwrap().unwrap();
        assert_eq!((first.line, first.text), (3, "*NODE"));
        let second = records.next().unwrap().unwrap();
        assert_eq!((second.line, second.text), (4, "1,0"));
        assert!(records.next().unwrap().is_none());
        let exact = "x".repeat(256);
        let mut maximum = Records { lines: exact.split_terminator('\n').enumerate() };
        assert_eq!(maximum.next().unwrap().unwrap().text.len(), 256);
        for text in ["x".repeat(257), "1,∞".into(), "1,\0".into(), "1,\r0".into(), "\u{2003}".into(), "\x7f".into()] {
            let mut invalid = Records { lines: text.split_terminator('\n').enumerate() };
            assert_eq!(invalid.next().unwrap_err().code, ErrorCode::Schema);
        }
    }

    #[test]
    fn keyword_continuation_and_parameters_are_case_insensitive_but_exact() {
        let k = keyword("  *ElEmeNt , TYPE = c3d8 ,\n** comment\n ELSET = box \n").unwrap();
        assert_eq!(k.name, "ELEMENT");
        assert_eq!(k.line, 1);
        assert_eq!(k.required("TYPE").unwrap(), "C3D8");
        assert_eq!(k.value("ELSET").unwrap(), Some("BOX"));
        assert_eq!(k.value("ABSENT").unwrap(), None);
        k.only(&["TYPE", "ELSET"]).unwrap();
        assert_eq!(k.only(&["TYPE"]).unwrap_err().code, ErrorCode::Unsupported);
        assert_eq!(k.required("ABSENT").unwrap_err().code, ErrorCode::Schema);
        let flag = keyword("*NSET,NSET=A,GENERATE\n").unwrap();
        assert!(flag.flag("GENERATE").unwrap());
        assert!(!flag.flag("ABSENT").unwrap());
        assert_eq!(flag.value("GENERATE").unwrap_err().code, ErrorCode::Schema);
        assert_eq!(flag.flag("NSET").unwrap_err().code, ErrorCode::Schema);
        for text in [
            "*\n",
            "*=NODE\n",
            "*NODE,NSET=\n",
            "*NODE,NSET=A=B\n",
            "*NODE,,NSET=A\n",
            "*NODE,NSET=A,nset=B\n",
            "*NODE,∞\n",
            "*NODE,\n",
            "*NODE,\n*ELEMENT,TYPE=C3D4\n",
        ] {
            assert_eq!(keyword(text).unwrap_err().code, ErrorCode::Schema);
        }
    }

    #[test]
    fn names_and_labels_have_explicit_bounds_without_guessing() {
        assert_eq!(name("aBc_9-x", 4, "NSET", "NSET").unwrap(), "ABC_9-X");
        assert_eq!(name(&"a".repeat(80), 4, "NSET", "NSET").unwrap().len(), 80);
        for text in ["", "1A", "_A", "a.b", "a b", "\"a\"", "a'", "å", &"a".repeat(81)] {
            let error = name(text, 4, "NSET", "NSET").unwrap_err();
            assert_eq!(error.code, ErrorCode::Unsupported);
            assert_eq!(error.where_.as_deref(), Some("line 4 *NSET NSET"));
        }
        for (text, expected) in [("1", 1), ("+1", 1), ("000000001", 1), ("999999999", 999_999_999)] {
            assert_eq!(label(text, 9, "NODE", "label").unwrap(), expected);
        }
        for text in ["", "+", "0", "-1", "1000000000", "0000000001", "1.0", "1E0", "A"] {
            assert_eq!(label(text, 9, "NODE", "label").unwrap_err().code, ErrorCode::Schema);
        }
    }

    #[test]
    fn numeric_records_keep_defaults_separate_from_required_fields() {
        for (text, scale, expected) in
            [("1d3", 0.001, 1.0), ("-1.25D+2", 0.01, -1.25), ("+.5", 1.0, 0.5), ("3e-2", 1.0, 0.03)]
        {
            assert_eq!(scalar(text, 5, "NODE", "x", scale).unwrap(), expected);
        }
        for text in ["", "NaN", "inf", "-inf", "1E309", "1 E2", "1.0.0"] {
            assert_eq!(scalar(text, 5, "NODE", "x", 1.0).unwrap_err().code, ErrorCode::Schema);
        }
        for text in ["-0", "-0.0", "+0", "0D0"] {
            assert_eq!(scalar(text, 5, "NODE", "x", 0.001).unwrap().to_bits(), 0.0f64.to_bits());
        }
        assert_eq!(scalar("1E308", 5, "NODE", "x", 10.0).unwrap_err().code, ErrorCode::Schema);
        assert_eq!(fields(Record { line: 2, text: "1,0,," }, "NODE", 2, 4).unwrap(), ["1", "0", "", ""]);
        for text in ["1", "1,0,0,0,0"] {
            assert_eq!(
                fields(Record { line: 2, text }, "NODE", 2, 4).unwrap_err().where_.as_deref(),
                Some("line 2 *NODE record")
            );
        }
    }

    #[test]
    fn source_diagnostics_use_documented_label_paths_instead_of_prose() {
        let nodes = BTreeMap::from([(99, 7)]);
        let elements = BTreeMap::from([(900, 13)]);
        let cause = "display prose mentions unrelated source element 1";
        for (path, expected) in [
            ("mesher.nodes[99].at[2]", "line 7 *NODE source label 99; mesher.nodes[99].at[2]"),
            ("mesher.elements[900].nodes", "line 13 *ELEMENT source label 900; mesher.elements[900].nodes"),
            ("mesher.elements", "line 11 *ELEMENT mesh-wide validation; mesher.elements"),
            ("mesher.nodes[88]", "line 11 *ELEMENT mesh-wide validation; mesher.nodes[88]"),
            ("mesher.nodes[x]", "line 11 *ELEMENT mesh-wide validation; mesher.nodes[x]"),
            ("mesher.nodes[99", "line 11 *ELEMENT mesh-wide validation; mesher.nodes[99"),
        ] {
            let error = source_location(Error::schema(cause).at(path), &nodes, &elements, 11);
            assert_eq!(error.cause, cause);
            assert_eq!(error.where_.as_deref(), Some(expected));
            assert_eq!(error.suggestion.as_deref(), Some(SUGGESTION));
        }
        assert_eq!(
            source_location(Error::schema(cause), &nodes, &elements, 11).where_.as_deref(),
            Some("line 11 *ELEMENT mesh-wide validation; mesher")
        );
    }

    #[test]
    fn membership_budget_is_checked_before_range_or_reference_allocation() {
        let mut builder = Builder { memberships: MAX_MEMBERSHIPS - 2, ..Builder::default() };
        builder.room_for(2, 4, "NSET").unwrap();
        assert_eq!(builder.memberships, MAX_MEMBERSHIPS - 2);
        builder.reserve_members(2, 4, "NSET").unwrap();
        assert_eq!(builder.memberships, MAX_MEMBERSHIPS);
        assert_eq!(builder.reserve_members(1, 5, "NSET").unwrap_err().code, ErrorCode::Schema);
        assert_eq!(builder.room_for(usize::MAX, 6, "NSET").unwrap_err().code, ErrorCode::Schema);
    }
}
