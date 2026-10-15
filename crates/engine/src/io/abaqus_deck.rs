//! Typed Abaqus deck normalization. Source scope and identity survive instancing; no I/O,
//! coordinate welding, synthetic input text, model publication, or numerical solve occurs.

use super::abaqus::{self, malformed, unsupported, Builder, Keyword, MeshDeck, NamedSet, Record, Records};
use crate::command::{ImportedEntityIdentity, ImportedFace};
use crate::error::Error;
use crate::units::{Length, Q};
use std::collections::BTreeMap;

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
    pub source: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct DeckBlock {
    pub keyword: Keyword,
    pub records: Vec<DeckRecord>,
    pub scope: DeckScope,
}

pub(crate) struct NormalizedDeck {
    pub mesh: MeshDeck,
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

fn blocks(text: &str, source: Option<&str>) -> Result<Vec<DeckBlock>, Error> {
    let mut reader = Records::new(text);
    let mut blocks: Vec<DeckBlock> = Vec::new();
    while let Some(record) = reader.next()? {
        if record.text.trim_start().starts_with('*') {
            let mut keyword = reader.keyword(record)?;
            keyword.source = source.map(str::to_string);
            blocks.push(DeckBlock { keyword, records: Vec::new(), scope: DeckScope::Model });
        } else {
            let block = blocks
                .last_mut()
                .ok_or_else(|| malformed(record.line, "INPUT", "data", "data must follow a keyword"))?;
            block.records.push(DeckRecord {
                line: record.line,
                fields: if block.keyword.name == "HEADING" {
                    vec![record.text.to_string()]
                } else {
                    abaqus::split_fields(record.text, record.line, &block.keyword.name)?
                        .into_iter()
                        .map(str::to_string)
                        .collect()
                },
                raw: record.text.to_string(),
                source: source.map(str::to_string),
            });
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
            mesh.record(&mut active, Record { line: record.line, text: &record.raw }, scale)
                .map_err(|e| located(e, record.source.as_deref()))?;
        }
        active.finish().map_err(|e| located(e, block.keyword.source.as_deref()))?;
    }
    Ok(mesh)
}

#[derive(Default)]
struct Instance {
    part: String,
    blocks: Vec<DeckBlock>,
    position: Vec<DeckRecord>,
    line: usize,
}

fn no_data(block: &DeckBlock) -> Result<(), Error> {
    if let Some(record) = block.records.first() {
        return Err(malformed(record.line, &block.keyword.name, "data", "this keyword accepts no data records"));
    }
    Ok(())
}

fn transform(point: [f64; 3], records: &[DeckRecord], line: usize) -> Result<[f64; 3], Error> {
    if records.len() > 2 {
        return Err(malformed(line, "INSTANCE", "position", "at most translation and rotation records are allowed"));
    }
    let mut point = point;
    if let Some(translation) = records.first() {
        if translation.fields.len() != 3 {
            return Err(malformed(
                translation.line,
                "INSTANCE",
                "translation",
                "translation requires three coordinates",
            ));
        }
        for (k, coordinate) in point.iter_mut().enumerate() {
            *coordinate += abaqus::scalar(&translation.fields[k], translation.line, "INSTANCE", "translation", 1.0)?;
        }
    }
    if let Some(rotation) = records.get(1) {
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
            return Err(malformed(rotation.line, "INSTANCE", "axis", "rotation axis must have distinct finite points"));
        }
        let axis = axis.map(|v| v / length);
        let p = [point[0] - values[0], point[1] - values[1], point[2] - values[2]];
        let (s, c) = values[6].to_radians().sin_cos();
        let cross = [axis[1] * p[2] - axis[2] * p[1], axis[2] * p[0] - axis[0] * p[2], axis[0] * p[1] - axis[1] * p[0]];
        let dot = axis[0] * p[0] + axis[1] * p[1] + axis[2] * p[2];
        point = std::array::from_fn(|k| values[k] + p[k] * c + cross[k] * s + axis[k] * dot * (1.0 - c));
    }
    if !point.iter().all(|p| p.is_finite()) {
        return Err(malformed(line, "INSTANCE", "position", "instance transform overflows finite coordinates"));
    }
    Ok(point.map(|p| p + 0.0))
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

pub(crate) fn normalize_mesh_sources(
    text: &str,
    body: &str,
    unit_length: &Q<Length>,
    digest: &str,
    source_name: Option<&str>,
    source_files: &BTreeMap<String, String>,
) -> Result<NormalizedDeck, Error> {
    normalize_deck(text, body, unit_length, digest, source_name, source_files)
}

fn normalize_deck(
    text: &str,
    body: &str,
    unit_length: &Q<Length>,
    digest: &str,
    source_name: Option<&str>,
    source_files: &BTreeMap<String, String>,
) -> Result<NormalizedDeck, Error> {
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
    for mut block in expanded {
        let line = block.keyword.line;
        let source = block.keyword.source.clone();
        let handled = (|| {
            let key = block.keyword.name.as_str();
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
                    instances
                        .push((name, Instance { part: part_name, blocks: Vec::new(), position: block.records, line }));
                }
                "ENDINSTANCE" => {
                    block.keyword.only(&[])?;
                    no_data(&block)?;
                    if instance.take().is_none() {
                        return Err(malformed(line, "END INSTANCE", "scope", "END INSTANCE needs an open instance"));
                    }
                }
                _ => {
                    if !mesh_keyword(&block.keyword.name) {
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

    let mut global = Builder::default();
    let mut node_ids = BTreeMap::new();
    let mut element_ids = BTreeMap::new();
    let mut node_sets = BTreeMap::new();
    let mut element_sets = BTreeMap::new();
    let mut surfaces = BTreeMap::new();
    let mut node_identities = BTreeMap::new();
    let mut element_identities = BTreeMap::new();
    let mut regions = BTreeMap::new();
    let mut instance_regions = BTreeMap::new();
    let mut local_meshes = Vec::new();
    if assembly.is_none() {
        local_meshes.push((DeckScope::Model, None, local_mesh(&model_blocks, scale)?, Vec::new(), 1));
    } else {
        let presentation: Vec<_> = model_blocks
            .iter()
            .filter(|b| matches!(b.keyword.name.as_str(), "HEADING" | "PREPRINT"))
            .cloned()
            .collect();
        let presentation = local_mesh(&presentation, scale)?;
        global.headings = presentation.headings;
        global.preprint = presentation.preprint;
        for (index, (instance_name, instance)) in instances.iter().enumerate() {
            transform([0.0; 3], &instance.position, instance.line)?;
            let inherited = &parts[&instance.part];
            let part_has_mesh = inherited.iter().any(|b| matches!(b.keyword.name.as_str(), "NODE" | "ELEMENT"));
            if part_has_mesh
                && instance
                    .blocks
                    .iter()
                    .any(|b| matches!(b.keyword.name.as_str(), "NODE" | "ELEMENT" | "SOLIDSECTION"))
            {
                return Err(malformed(
                    instance.line,
                    "INSTANCE",
                    "mesh",
                    "an inherited part mesh or section cannot be overridden in an instance",
                ));
            }
            for block in &instance.blocks {
                if matches!(block.keyword.name.as_str(), "NSET" | "ELSET" | "SURFACE") {
                    let key = if block.keyword.name == "SURFACE" { "NAME" } else { block.keyword.name.as_str() };
                    let name =
                        abaqus::name(block.keyword.required(key)?, block.keyword.line, &block.keyword.name, key)?;
                    for previous in inherited.iter().filter(|b| b.keyword.name == block.keyword.name) {
                        if abaqus::name(
                            previous.keyword.required(key)?,
                            previous.keyword.line,
                            &previous.keyword.name,
                            key,
                        )? == name
                        {
                            return Err(malformed(
                                block.keyword.line,
                                &block.keyword.name,
                                key,
                                "instance definitions cannot override inherited part sets or surfaces",
                            ));
                        }
                    }
                }
            }
            let mut combined = inherited.clone();
            combined.extend(instance.blocks.clone());
            let region = format!("{body}_instance_{}", index + 1);
            instance_regions.insert(instance_name.clone(), region.clone());
            regions.insert(region, Vec::new());
            local_meshes.push((
                DeckScope::Instance(instance_name.clone()),
                Some(instance.part.clone()),
                local_mesh(&combined, scale)?,
                instance.position.clone(),
                instance.line,
            ));
        }
    }

    for (scope, source_part, local, position, line) in local_meshes {
        global.reserve_members(local.memberships, line, "INSTANCE")?;
        let instanced = matches!(scope, DeckScope::Instance(_));
        for (id, (mut node, source_line)) in local.nodes {
            let mapped = if instanced {
                u32::try_from(global.nodes.len() + 1)
                    .map_err(|_| malformed(line, "NODE", "count", "node labels overflow"))?
            } else {
                id
            };
            if instanced {
                let point = node.at.clone().map(|v| v.si()).into_iter().collect::<Result<Vec<_>, _>>()?;
                let point = transform([point[0] / scale, point[1] / scale, point[2] / scale], &position, line)?;
                node.at = point.map(|v| Q::new(v * scale, "m"));
                let instance = match &scope {
                    DeckScope::Instance(name) => Some(name.clone()),
                    _ => None,
                };
                node_identities
                    .insert(mapped, ImportedEntityIdentity { source_label: id, instance, part: source_part.clone() });
            }
            node.label = mapped;
            node_ids.insert((scope.clone(), id), mapped);
            if global.nodes.len() == 250_000 {
                return Err(malformed(source_line, "NODE", "count", "expanded assembly exceeds 250000 nodes"));
            }
            global.nodes.insert(mapped, (node, source_line));
        }
        for (id, (mut element, source_line)) in local.elements {
            let mapped = if instanced {
                u32::try_from(global.elements.len() + 1)
                    .map_err(|_| malformed(line, "ELEMENT", "count", "element labels overflow"))?
            } else {
                id
            };
            for node in &mut element.nodes {
                *node = *node_ids.get(&(scope.clone(), *node)).ok_or_else(|| {
                    malformed(
                        source_line,
                        "ELEMENT",
                        "connectivity",
                        format!("source node {node} is not defined in this instance"),
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
                regions.get_mut(&instance_regions[instance]).expect("instance region exists").push(mapped);
            }
            element.label = mapped;
            element_ids.insert((scope.clone(), id), mapped);
            if global.elements.len() == 250_000 {
                return Err(malformed(source_line, "ELEMENT", "count", "expanded assembly exceeds 250000 elements"));
            }
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
                        ids.get(&(scope.clone(), id)).copied().map(|id| (id, source_line)).ok_or_else(|| {
                            malformed(
                                source_line,
                                if nodes { "NSET" } else { "ELSET" },
                                "member",
                                "source label is not defined in this instance",
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
                        .map(|element| (ImportedFace { element, face: face.face }, line))
                        .ok_or_else(|| {
                            malformed(line, "SURFACE", "element", "surface element is not defined in this instance")
                        })
                })
                .collect::<Result<BTreeMap<_, _>, _>>()?;
            surfaces.insert((scope.clone(), name), mapped_name.clone());
            global.surfaces.insert(mapped_name, (source_line, faces));
        }
        global.headings.extend(local.headings);
        global.preprint.extend(local.preprint);
    }
    // Assembly nodes and sets are handled against the complete instance identity map below.
    add_assembly(
        &assembly_blocks,
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
    Ok(NormalizedDeck { mesh })
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
        match key.as_str() {
            "NODE" => {
                let local = local_mesh(std::slice::from_ref(block), scale)?;
                global.reserve_members(local.memberships, line, "NODE")?;
                for (id, (mut node, source_line)) in local.nodes {
                    if node_ids.contains_key(&(DeckScope::Assembly, id)) {
                        return Err(malformed(source_line, "NODE", "label", "assembly node label is already defined"));
                    }
                    let mapped = global.nodes.last_key_value().map(|(id, _)| id + 1).unwrap_or(1);
                    node.label = mapped;
                    node_ids.insert((DeckScope::Assembly, id), mapped);
                    if global.nodes.len() == 250_000 {
                        return Err(malformed(source_line, "NODE", "count", "expanded assembly exceeds 250000 nodes"));
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
                    let declared =
                        global.element_sets[source].members.keys().map(|id| global.elements[id].0.nodes.len()).sum();
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
                        members.insert(ImportedFace { element, face }, record.line);
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
    if let Some(source) = source {
        let at = error.where_.as_deref().unwrap_or("input").to_string();
        error.at(format!("{source}: {at}"))
    } else {
        error
    }
}

fn expand_sources(
    text: &str,
    source_name: Option<&str>,
    sources: &BTreeMap<String, String>,
) -> Result<Vec<DeckBlock>, Error> {
    validate_sources(text, source_name, sources)?;
    let mut stack = vec![source_name.unwrap_or("").to_string()];
    let mut expanded_bytes = 0;
    expand_one(text, source_name, sources, &mut stack, &mut expanded_bytes)
}

fn expand_one(
    text: &str,
    source: Option<&str>,
    sources: &BTreeMap<String, String>,
    stack: &mut Vec<String>,
    expanded_bytes: &mut usize,
) -> Result<Vec<DeckBlock>, Error> {
    *expanded_bytes = expanded_bytes.saturating_add(text.len());
    if *expanded_bytes > abaqus::MAX_INPUT_BYTES {
        return Err(located(Error::schema("expanded includes exceed the 16 MiB input bound").at("INCLUDE"), source));
    }
    let mut expanded = Vec::new();
    for block in blocks(text, source).map_err(|e| located(e, source))? {
        if block.keyword.name != "INCLUDE" {
            expanded.push(block);
            continue;
        }
        let line = block.keyword.line;
        let path = include_path(&block).map_err(|e| located(e, source))?;
        if stack.len() >= 16 {
            return Err(located(malformed(line, "INCLUDE", "depth", "include nesting exceeds 16 files"), source));
        }
        if stack.iter().any(|p| p == &path) {
            return Err(located(malformed(line, "INCLUDE", "cycle", format!("include cycle through {path}")), source));
        }
        let included = sources.get(&path).ok_or_else(|| {
            located(
                malformed(
                    line,
                    "INCLUDE",
                    "INPUT",
                    format!("source file {path} was not supplied; provide the complete source bundle"),
                ),
                source,
            )
        })?;
        stack.push(path.to_string());
        let records = expand_one(included, Some(&path), sources, stack, expanded_bytes)?;
        stack.pop();
        expanded.extend(records);
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
    dependencies_one(text, source_name, sources, &mut stack, &mut bytes, &mut missing)?;
    Ok(missing.into_iter().collect())
}

fn dependencies_one(
    text: &str,
    source: Option<&str>,
    sources: &BTreeMap<String, String>,
    stack: &mut Vec<String>,
    bytes: &mut usize,
    missing: &mut std::collections::BTreeSet<String>,
) -> Result<(), Error> {
    *bytes = bytes.saturating_add(text.len());
    if *bytes > abaqus::MAX_INPUT_BYTES {
        return Err(located(Error::schema("expanded includes exceed the 16 MiB input bound").at("INCLUDE"), source));
    }
    for block in blocks(text, source).map_err(|e| located(e, source))? {
        if block.keyword.name != "INCLUDE" {
            continue;
        }
        let path = include_path(&block).map_err(|e| located(e, source))?;
        if stack.len() >= 16 {
            return Err(located(
                malformed(block.keyword.line, "INCLUDE", "depth", "include nesting exceeds 16 files"),
                source,
            ));
        }
        if stack.iter().any(|p| p == &path) {
            return Err(located(
                malformed(block.keyword.line, "INCLUDE", "cycle", format!("include cycle through {path}")),
                source,
            ));
        }
        if let Some(included) = sources.get(&path) {
            stack.push(path.clone());
            dependencies_one(included, Some(&path), sources, stack, bytes, missing)?;
            stack.pop();
        } else {
            missing.insert(path);
        }
    }
    Ok(())
}

fn include_path(block: &DeckBlock) -> Result<String, Error> {
    block.keyword.only(&["INPUT"])?;
    no_data(block)?;
    let raw = block.keyword.required("INPUT")?;
    let path = if raw.starts_with('"') {
        raw.strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'))
            .ok_or_else(|| malformed(block.keyword.line, "INCLUDE", "INPUT", "quoted filename needs matching quotes"))?
    } else {
        raw
    };
    source_path(path)?;
    Ok(path.to_string())
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
        let actual = transform([1.0, 0.0, 0.0], &records, 4).unwrap();
        assert!(actual[0].abs() < 1e-14);
        assert!((actual[1] - 3.0).abs() < 1e-14);
        assert_eq!(actual[2], 0.0);
        assert_eq!(transform([1.0, 2.0, 3.0], &[], 1).unwrap(), [1.0, 2.0, 3.0]);
        let about_offset = [record(&["0", "0", "0"]), record(&["1", "0", "0", "1", "0", "1", "180"])];
        let actual = transform([2.0, 0.0, 0.0], &about_offset, 1).unwrap();
        assert!(actual[0].abs() < 1e-14);
        for records in [
            vec![record(&["0", "0"])],
            vec![record(&["0", "0", "0"]), record(&["0", "0", "0", "0", "0", "0", "0"])],
            vec![record(&["0", "0", "0"]), record(&["0"])],
            vec![record(&["0", "0", "0"]); 3],
            vec![record(&["NaN", "0", "0"])],
            vec![record(&["1e308", "0", "0"])],
        ] {
            assert!(transform([1e308, 0.0, 0.0], &records, 3).is_err());
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
}
