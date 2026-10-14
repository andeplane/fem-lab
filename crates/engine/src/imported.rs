//! Persistent authored finite-element sources, separate from the derived Mesh (ADR 0026).
//! Validation and dense mapping happen without coordinate welding or host I/O.

use std::collections::{BTreeMap, BTreeSet};

use femlab_geometry::{ElementBlock, Face, Mesh};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::command::{ImportedElement, ImportedFace, ImportedMeshSpec, ImportedProvenance};
use crate::error::{Error, ErrorCode};

pub const MAX_SOURCE_ENTITIES: usize = 250_000;
pub const MAX_SOURCE_MEMBERSHIPS: usize = 1_000_000;

/// Coordinates are SI; labels remain the immutable identity of the authored mesh.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ImportedNode {
    pub label: u32,
    pub at: [f64; 3],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedMesh {
    pub body: String,
    pub nodes: Vec<ImportedNode>,
    pub elements: Vec<ImportedElement>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub node_sets: BTreeMap<String, Vec<u32>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub element_sets: BTreeMap<String, Vec<u32>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub surfaces: BTreeMap<String, Vec<ImportedFace>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub node_targets: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<ImportedProvenance>,
}

/// Dense arrays' source labels, in dense node/element order. No label is inferred from position.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SourceLabels {
    /// Participating authored labels in dense FE node order, forming the derived node
    /// prefix. Ordinary auxiliary nodes may follow without authored source labels.
    pub nodes: Vec<u32>,
    pub elements: Vec<u32>,
    /// Retained in the Model source, with no FE DOF or fabricated Result value.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unused_nodes: Vec<u32>,
}

fn invalid(cause: impl Into<String>, at: impl Into<String>) -> Error {
    Error::schema(cause).at(at).suggest("mesh.set with a complete, valid imported source")
}

fn label(value: u32, at: &str) -> Result<(), Error> {
    if !(1..=999_999_999).contains(&value) {
        return Err(invalid("source labels must be in 1..=999999999", at));
    }
    Ok(())
}

fn bounds(nodes: usize, elements: usize, memberships: usize) -> Result<(), Error> {
    if nodes == 0 || elements == 0 {
        return Err(invalid("an imported source needs nodes and elements", "mesher"));
    }
    if nodes > MAX_SOURCE_ENTITIES || elements > MAX_SOURCE_ENTITIES || memberships > MAX_SOURCE_MEMBERSHIPS {
        return Err(invalid("imported source exceeds 250000 nodes/elements or 1000000 memberships", "mesher"));
    }
    Ok(())
}

fn memberships<T, U>(
    nodes: &BTreeMap<String, Vec<T>>,
    elements: &BTreeMap<String, Vec<T>>,
    faces: &BTreeMap<String, Vec<U>>,
    targets: usize,
) -> usize {
    nodes
        .values()
        .chain(elements.values())
        .map(Vec::len)
        .chain(faces.values().map(Vec::len))
        .fold(targets, usize::saturating_add)
}

fn canonical_members<T: Ord>(maps: &mut BTreeMap<String, Vec<T>>) {
    for members in maps.values_mut() {
        members.sort_unstable();
        members.dedup();
    }
}

pub fn source(spec: &ImportedMeshSpec) -> Result<ImportedMesh, Error> {
    bounds(
        spec.nodes.len(),
        spec.elements.len(),
        memberships(&spec.node_sets, &spec.element_sets, &spec.surfaces, spec.node_targets.len()),
    )?;
    let mut nodes = Vec::with_capacity(spec.nodes.len());
    for node in &spec.nodes {
        let mut at = [0.0; 3];
        for (k, q) in node.at.iter().enumerate() {
            at[k] = q.si().map_err(|e| e.at(format!("mesher.nodes[{}].at[{k}]", node.label)))?;
        }
        nodes.push(ImportedNode { label: node.label, at });
    }
    nodes.sort_by_key(|n| n.label);
    let mut source = ImportedMesh {
        body: spec.body.clone(),
        nodes,
        elements: spec.elements.clone(),
        node_sets: spec.node_sets.clone(),
        element_sets: spec.element_sets.clone(),
        surfaces: spec.surfaces.clone(),
        node_targets: spec.node_targets.clone(),
        provenance: spec.provenance.clone(),
    };
    source.elements.sort_by_key(|e| e.label);
    canonical_members(&mut source.node_sets);
    canonical_members(&mut source.element_sets);
    canonical_members(&mut source.surfaces);
    source.node_targets.sort_unstable();
    source.node_targets.dedup();
    build(&source)?;
    Ok(source)
}

impl ImportedMesh {
    /// Exact, separate namespaces; qualified names are stable across save/open and replay.
    pub fn participating_labels(&self) -> BTreeSet<u32> {
        self.elements.iter().flat_map(|element| element.nodes.iter().copied()).collect()
    }

    pub fn node_members(&self, name: &str) -> Option<Vec<u32>> {
        let suffix = name.strip_prefix(&format!("{}.", self.body))?;
        if let Some(name) = suffix.strip_prefix("nset_") {
            return self.node_sets.get(name).cloned();
        }
        self.node_targets.iter().find(|id| suffix == format!("node_{id}")).map(|id| vec![*id])
    }

    pub fn nonempty_set_names(&self) -> BTreeSet<String> {
        let participating = self.participating_labels();
        self.node_sets
            .iter()
            .filter(|(_, members)| !members.is_empty() && members.iter().all(|label| participating.contains(label)))
            .map(|(name, _)| format!("{}.nset_{name}", self.body))
            .chain(
                self.element_sets
                    .iter()
                    .filter(|(_, members)| !members.is_empty())
                    .map(|(name, _)| format!("{}.elset_{name}", self.body)),
            )
            .chain(
                self.surfaces
                    .iter()
                    .filter(|(_, members)| !members.is_empty())
                    .map(|(name, _)| format!("{}.surface_{name}", self.body)),
            )
            .chain(
                self.node_targets
                    .iter()
                    .filter(|id| participating.contains(id))
                    .map(|id| format!("{}.node_{id}", self.body)),
            )
            .collect()
    }

    pub fn set_names(&self) -> BTreeSet<String> {
        self.node_sets
            .keys()
            .map(|name| format!("{}.nset_{name}", self.body))
            .chain(self.element_sets.keys().map(|name| format!("{}.elset_{name}", self.body)))
            .chain(self.surfaces.keys().map(|name| format!("{}.surface_{name}", self.body)))
            .chain(self.node_targets.iter().map(|id| format!("{}.node_{id}", self.body)))
            .collect()
    }
}

/// A lossless mesh.set payload for query.definition; text SI values round-trip exactly.
pub fn spec(source: &ImportedMesh) -> ImportedMeshSpec {
    ImportedMeshSpec {
        body: source.body.clone(),
        nodes: source
            .nodes
            .iter()
            .map(|node| crate::command::ImportedNodeSpec {
                label: node.label,
                at: node.at.map(|v| crate::units::Q::text(&format!("{v} m"))),
            })
            .collect(),
        elements: source.elements.clone(),
        node_sets: source.node_sets.clone(),
        element_sets: source.element_sets.clone(),
        surfaces: source.surfaces.clone(),
        node_targets: source.node_targets.clone(),
        provenance: source.provenance.clone(),
    }
}

fn source_name(name: &str, at: &str) -> Result<(), Error> {
    if name.is_empty()
        || name.len() > 80
        || !name.as_bytes()[0].is_ascii_uppercase()
        || !name.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
    {
        return Err(invalid("source Set names must be uppercase [A-Z][A-Z0-9_-]*, at most 80 characters", at));
    }
    Ok(())
}

fn indices(labels: &[u32], lookup: &BTreeMap<u32, u32>, at: &str) -> Result<Vec<u32>, Error> {
    labels
        .iter()
        .map(|label| lookup.get(label).copied().ok_or_else(|| invalid(format!("unknown source label {label}"), at)))
        .collect()
}

/// Revalidate persisted source data before building: an untrusted snapshot never reaches Mesh
/// indexing unchecked. Returned labels and blocks follow source label order, including runs of
/// different kinds; the authoritative source is never welded, reordered locally or pruned.
pub fn build(source: &ImportedMesh) -> Result<(Mesh, SourceLabels), Error> {
    bounds(
        source.nodes.len(),
        source.elements.len(),
        memberships(&source.node_sets, &source.element_sets, &source.surfaces, source.node_targets.len()),
    )?;
    if let Some(provenance) = &source.provenance {
        if provenance.sha256.len() != 64
            || !provenance.sha256.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || provenance.conversion_version.trim().is_empty()
        {
            return Err(invalid(
                "provenance needs a lowercase SHA-256 and nonempty conversionVersion",
                "mesher.provenance",
            ));
        }
    }
    let mut node_ids = BTreeMap::new();
    let mut coords = Vec::with_capacity(source.nodes.len() * 3);
    let mut previous = 0;
    for node in &source.nodes {
        label(node.label, &format!("mesher.nodes[{}].label", node.label))?;
        if node.label <= previous || !node.at.iter().all(|x| x.is_finite()) {
            return Err(invalid(
                "source nodes must have unique ascending labels and finite coordinates",
                format!("mesher.nodes[{}]", node.label),
            ));
        }
        previous = node.label;
        node_ids.insert(node.label, node_ids.len() as u32);
        coords.extend(node.at);
    }
    let mut element_ids = BTreeMap::new();
    let mut blocks: Vec<ElementBlock> = Vec::new();
    let mut seen = BTreeSet::new();
    previous = 0;
    for element in &source.elements {
        label(element.label, &format!("mesher.elements[{}].label", element.label))?;
        let kind = element.kind.geometry();
        let at = format!("mesher.elements[{}]", element.label);
        if element.label <= previous || element.nodes.len() != kind.n_nodes() {
            return Err(invalid("source elements need unique ascending labels and exact connectivity arity", at));
        }
        previous = element.label;
        let conn = indices(&element.nodes, &node_ids, &format!("{at}.nodes"))?;
        let mut key = conn.clone();
        key.sort_unstable();
        if key.windows(2).any(|w| w[0] == w[1]) || !seen.insert(key) {
            return Err(invalid("element connectivity repeats a node or duplicates another element", at));
        }
        let id = element_ids.len() as u32;
        element_ids.insert(element.label, id);
        if blocks.last().is_none_or(|b| b.kind != kind) {
            blocks.push(ElementBlock { kind, conn: Vec::new(), first_elem: id });
        }
        blocks.last_mut().expect("inserted above").conn.extend(conn);
    }
    let mut mesh = Mesh {
        dim: 3,
        coords,
        blocks,
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::new(),
        face_sets: BTreeMap::new(),
    };
    validate_elements(&mesh, source)?;
    for (name, members) in &source.node_sets {
        source_name(name, "mesher.nodeSets")?;
        mesh.node_sets.insert(
            format!("{}.nset_{name}", source.body),
            indices(members, &node_ids, &format!("mesher.nodeSets.{name}"))?,
        );
    }
    for (name, members) in &source.element_sets {
        source_name(name, "mesher.elementSets")?;
        mesh.elem_sets.insert(
            format!("{}.elset_{name}", source.body),
            indices(members, &element_ids, &format!("mesher.elementSets.{name}"))?,
        );
    }
    for (name, members) in &source.surfaces {
        source_name(name, "mesher.surfaces")?;
        let mut faces = Vec::with_capacity(members.len());
        for member in members {
            let at = format!("mesher.surfaces.{name}");
            let elem = element_ids
                .get(&member.element)
                .copied()
                .ok_or_else(|| invalid(format!("unknown source element {}", member.element), &at))?;
            if member.face == 0 || member.face as usize > mesh.kind_of(elem).n_faces() {
                return Err(invalid(format!("invalid local face S{} on element {}", member.face, member.element), at));
            }
            faces.push(Face { elem, local: member.face - 1 });
        }
        mesh.face_sets.insert(format!("{}.surface_{name}", source.body), faces);
    }
    for &id in &source.node_targets {
        mesh.node_sets.insert(format!("{}.node_{id}", source.body), indices(&[id], &node_ids, "mesher.nodeTargets")?);
    }
    // Retain unused authored nodes in the Model, but never allocate unassembled FE DOFs
    // or imply a solved displacement at them. Explicit source Queries report their labels
    // and exact memberships; loads/supports on them are unsupported.
    let participating: BTreeSet<u32> = mesh.blocks.iter().flat_map(|block| block.conn.iter().copied()).collect();
    let mut remap = BTreeMap::new();
    let mut labels = SourceLabels {
        nodes: Vec::with_capacity(participating.len()),
        elements: source.elements.iter().map(|e| e.label).collect(),
        unused_nodes: Vec::new(),
    };
    let mut active_coords = Vec::with_capacity(participating.len() * 3);
    for (i, node) in source.nodes.iter().enumerate() {
        if participating.contains(&(i as u32)) {
            remap.insert(i as u32, labels.nodes.len() as u32);
            labels.nodes.push(node.label);
            active_coords.extend(node.at);
        } else {
            labels.unused_nodes.push(node.label);
        }
    }
    for block in &mut mesh.blocks {
        for id in &mut block.conn {
            *id = remap[id];
        }
    }
    for members in mesh.node_sets.values_mut() {
        *members = members.iter().filter_map(|id| remap.get(id).copied()).collect();
    }
    mesh.coords = active_coords;
    Ok((mesh, labels))
}

fn validate_elements(mesh: &Mesh, source: &ImportedMesh) -> Result<(), Error> {
    use crate::fem::shape::{dshape_of, rule_of};
    let mut faces: BTreeMap<Vec<u32>, Vec<Face>> = BTreeMap::new();
    for e in 0..mesh.n_elems() as u32 {
        let kind = mesh.kind_of(e);
        let mut coords = vec![0.0; kind.n_nodes() * 3];
        mesh.elem_coords(e, &mut coords);
        let mut dn = vec![[0.0; 3]; kind.n_nodes()];
        for &xi in rule_of(kind).points {
            dshape_of(kind, xi, &mut dn);
            if crate::fem::element::jac_inv(3, &coords, &dn).is_none() {
                return Err(Error::new(
                    ErrorCode::MeshFailed,
                    format!(
                        "source element {} has an inverted, degenerate or nonfinite Jacobian",
                        source.elements[e as usize].label
                    ),
                )
                .at(format!("mesher.elements[{}]", source.elements[e as usize].label))
                .suggest("mesh.set with positively oriented valid elements"));
            }
        }
        for f in 0..kind.n_faces() as u8 {
            let mut nodes: Vec<_> = mesh.face_nodes(Face { elem: e, local: f }).collect();
            nodes.sort_unstable();
            faces.entry(nodes).or_default().push(Face { elem: e, local: f });
        }
    }
    let quality = femlab_geometry::quality(mesh, 1);
    if quality.min_det_j_ratio.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
        return Err(Error::new(
            ErrorCode::MeshFailed,
            "imported element has an inverted or degenerate corner Jacobian",
        )
        .at(format!("mesher.elements[{}]", source.elements[quality.worst[0].0 as usize].label))
        .suggest("mesh.set with regular, positively oriented elements"));
    }
    let mut adjacency = vec![Vec::new(); mesh.n_elems()];
    for elements in faces.values() {
        if elements.len() > 2 {
            return Err(invalid(
                "imported source has a nonmanifold face shared by more than two elements",
                "mesher.elements",
            ));
        }
        if elements.len() == 2 {
            let a: Vec<_> = mesh.face_nodes(elements[0]).collect();
            let b: Vec<_> = mesh.face_nodes(elements[1]).collect();
            let start = b.iter().position(|id| *id == a[0]).expect("matching face membership");
            if !a.iter().enumerate().all(|(i, id)| *id == b[(start + b.len() - i) % b.len()]) {
                return Err(invalid(
                    "shared faces need opposite cyclic connectivity; same-side or crossing face ordering is invalid",
                    "mesher.elements",
                ));
            }
            adjacency[elements[0].elem as usize].push(elements[1].elem);
            adjacency[elements[1].elem as usize].push(elements[0].elem);
        }
    }
    femlab_geometry::imported_certificate::certify_imported_geometry(mesh).map_err(|error| {
        use femlab_geometry::imported_certificate::ImportedCertificateError;
        let (code, elements, cause) = match error {
            ImportedCertificateError::Invalid { elements, cause } => (ErrorCode::MeshFailed, elements, cause),
            ImportedCertificateError::Inconclusive { elements, cause } => (ErrorCode::Unsupported, elements, cause),
        };
        let labels: Vec<_> =
            elements.iter().map(|&element| source.elements[element as usize].label.to_string()).collect();
        Error::new(code, format!("source elements [{}]: {cause}", labels.join(", ")))
            .at(format!("mesher.elements[{}]", labels[0]))
            .suggest("mesh.set with source geometry whose original cell map and labelled contacts can be certified")
    })?;
    let mut reached = vec![false; mesh.n_elems()];
    let mut pending = vec![0];
    reached[0] = true;
    while let Some(e) = pending.pop() {
        for &next in &adjacency[e] {
            if !reached[next as usize] {
                reached[next as usize] = true;
                pending.push(next as usize);
            }
        }
    }
    if reached.iter().any(|r| !r) {
        return Err(invalid(
            "imported source elements must form one face-connected mesh with matching labelled faces",
            "mesher.elements",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod input_policy_tests {
    use super::*;

    #[test]
    fn authored_input_limits_accept_the_boundary_and_reject_the_next_entity() {
        // Literal policy boundaries from the public schema doc, independent of
        // allocation or the particular malformed geometry that follows them.
        bounds(250_000, 250_000, 1_000_000).unwrap();
        for (nodes, elements, memberships) in
            [(0, 1, 0), (1, 0, 0), (250_001, 1, 0), (1, 250_001, 0), (1, 1, 1_000_001)]
        {
            assert_eq!(bounds(nodes, elements, memberships).unwrap_err().code, ErrorCode::Schema);
        }
    }

    #[test]
    fn source_label_and_set_name_boundaries_follow_the_declared_grammar() {
        for value in [1, 999_999_999] {
            label(value, "label").unwrap();
        }
        for value in [0, 1_000_000_000] {
            assert_eq!(label(value, "label").unwrap_err().code, ErrorCode::Schema);
        }
        for value in ["ROOT", "NODES_1-A", &"A".repeat(80)] {
            source_name(value, "name").unwrap();
        }
        for value in ["", "1ROOT", "root", "A.B", "A+B", "Ä", &"A".repeat(81)] {
            assert_eq!(source_name(value, "name").unwrap_err().code, ErrorCode::Schema);
        }
    }
}
