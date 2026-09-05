//! The derived Mesh: one lattice per Body merged into one `Mesh`, with every Set resolved.
//!
//! Nothing here is stored in the Model — the Mesh follows from the geometry and the mesh
//! settings, and `Engine` rebuilds it lazily whenever either changes (plan B §2.1).

use std::collections::BTreeMap;

use femlab_geometry::{
    face_centroid_normal, lattice, nearest_boundary_face, resolve_face_set, resolve_region, ElementBlock, Face, Mesh,
    Solid,
};

use crate::engine::display;
use crate::error::{Error, ErrorCode};
use crate::model::{MesherSettings, Model, SetSource};
use crate::units::{Dim, Length};

/// What a Set selects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetKind {
    Face,
    Node,
    Element,
}

impl SetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SetKind::Face => "face",
            SetKind::Node => "node",
            SetKind::Element => "element",
        }
    }
}

/// One Set resolved against the current Mesh. A face Set also carries the nodes of its faces;
/// a region Set carries both the nodes and the elements it covers.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedSet {
    pub kind: SetKind,
    pub faces: Vec<Face>,
    pub nodes: Vec<u32>,
    pub elems: Vec<u32>,
}

impl ResolvedSet {
    /// How many entities the Set's own kind holds.
    pub fn count(&self) -> usize {
        match self.kind {
            SetKind::Face => self.faces.len(),
            SetKind::Node => self.nodes.len(),
            SetKind::Element => self.elems.len(),
        }
    }
    fn is_empty(&self) -> bool {
        self.faces.is_empty() && self.nodes.is_empty() && self.elems.is_empty()
    }
}

/// The Mesh plus everything derived with it.
#[derive(Debug, Clone, PartialEq)]
pub struct BuiltMesh {
    pub mesh: Mesh,
    /// The Body each element block came from; blocks are one per Body.
    pub body_of_block: Vec<String>,
    /// Auto face Sets (`beam.xmin`, `hole.side`) and named Sets alike.
    pub sets: BTreeMap<String, ResolvedSet>,
}

impl BuiltMesh {
    /// The Body an element belongs to.
    pub fn body_of_elem(&self, elem: u32) -> &str {
        &self.body_of_block[self.mesh.block_of(elem).0]
    }
}

/// Mesh every Body and resolve every Set. `solids` must hold the evaluated Solid of every Body
/// (`Engine::mesh` builds them first).
pub fn build(model: &Model, solids: &BTreeMap<String, Solid>) -> Result<BuiltMesh, Error> {
    let settings = model.mesh.as_ref().ok_or_else(|| {
        Error::new(ErrorCode::ModelIllPosed, "no mesh settings; call mesh.set")
            .suggest("mesh.set { mesher: { kind: \"lattice\", size: \"25 mm\" } }")
    })?;
    if model.bodies.is_empty() {
        return Err(Error::new(ErrorCode::ModelIllPosed, "the Model has no Body to mesh").suggest("geometry.add"));
    }
    let dim = model.idealisation.dim();
    let quadratic = settings.order == 2;
    let MesherSettings::Lattice { size, counts } = settings.mesher;

    let mut mesh = Mesh {
        dim,
        coords: Vec::new(),
        blocks: Vec::new(),
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::new(),
        face_sets: BTreeMap::new(),
    };
    let mut body_of_block: Vec<String> = Vec::new();
    let mut body_faces: BTreeMap<String, Vec<Face>> = BTreeMap::new();
    for body in &model.bodies {
        let solid = &solids[&body.name];
        if solid.dim() != dim {
            return Err(Error::new(
                ErrorCode::ModelIllPosed,
                format!("body '{}' is {}D but the idealisation is {dim}D", body.name, solid.dim()),
            )
            .at(format!("body '{}'", body.name))
            .suggest("model.setIdealisation, or give the Body a shape of the right dimension"));
        }
        let part = lattice(solid, size, counts, quadratic).map_err(|e| {
            Error::new(ErrorCode::MeshFailed, e.0)
                .at(format!("body '{}'", body.name))
                .suggest("mesh.set with a smaller element size")
        })?;
        let node_offset = (mesh.coords.len() / 3) as u32;
        let elem_offset = mesh.n_elems() as u32;
        let shift = |f: &Face| Face { elem: f.elem + elem_offset, local: f.local };
        mesh.coords.extend_from_slice(&part.coords);
        for blk in &part.blocks {
            mesh.blocks.push(ElementBlock {
                kind: blk.kind,
                conn: blk.conn.iter().map(|n| n + node_offset).collect(),
                first_elem: blk.first_elem + elem_offset,
            });
            body_of_block.push(body.name.clone());
        }
        // A lattice names bbox-plane faces `xmin … zmax`; faces that inherited a Solid tag are
        // already qualified (`hole.xmin`), so only the bare ones take the Body's name.
        for (tag, faces) in &part.face_sets {
            let name = if tag.contains('.') { tag.clone() } else { format!("{}.{tag}", body.name) };
            mesh.face_sets.insert(name, faces.iter().map(shift).collect());
        }
        body_faces.insert(body.name.clone(), part.boundary_faces().iter().map(shift).collect());
    }
    mesh.elem_sets.insert("all".into(), (0..mesh.n_elems() as u32).collect());

    let mut sets: BTreeMap<String, ResolvedSet> = BTreeMap::new();
    for (name, faces) in &mesh.face_sets {
        sets.insert(name.clone(), face_set(&mesh, faces.clone()));
    }
    for named in &model.sets {
        let (resolved, probe) = match &named.source {
            SetSource::Face { of, where_ } => {
                (face_set(&mesh, resolve_face_set(&mesh, where_, Some(&body_faces[of]))), where_.reference_point())
            }
            SetSource::Region { where_ } => {
                let body_of = |e: u32| body_of_block[mesh.block_of(e).0].as_str();
                let (nodes, elems) = resolve_region(&mesh, where_, &body_of);
                // A region that catches no whole element is a node Set: what a nodal load wants.
                let kind = if elems.is_empty() { SetKind::Node } else { SetKind::Element };
                (ResolvedSet { kind, faces: Vec::new(), nodes, elems }, where_.reference_point())
            }
        };
        if resolved.is_empty() {
            return Err(set_empty(model, &mesh, &named.name, probe));
        }
        sets.insert(named.name.clone(), resolved);
    }
    Ok(BuiltMesh { mesh, body_of_block, sets })
}

/// A face Set plus the nodes its faces touch, sorted and unique.
fn face_set(mesh: &Mesh, faces: Vec<Face>) -> ResolvedSet {
    let mut nodes: Vec<u32> = faces.iter().flat_map(|&f| mesh.face_nodes(f)).collect();
    nodes.sort_unstable();
    nodes.dedup();
    ResolvedSet { kind: SetKind::Face, faces, nodes, elems: Vec::new() }
}

/// The `set.empty` error: what was empty, and where the nearest boundary face actually is.
fn set_empty(model: &Model, mesh: &Mesh, name: &str, probe: Option<[f64; 3]>) -> Error {
    let (lo, hi) = mesh.bbox();
    let centre = [0.5 * (lo[0] + hi[0]), 0.5 * (lo[1] + hi[1]), 0.5 * (lo[2] + hi[2])];
    let point = probe.unwrap_or(centre);
    let near = nearest_boundary_face(mesh, point).map_or("the mesh has no boundary face".to_string(), |(f, _)| {
        let (c, _) = face_centroid_normal(mesh, f);
        let v: Vec<String> =
            c.iter().map(|&x| crate::units::fmt_sig(display(model, x, Length::DIM).value, 4)).collect();
        format!("the nearest boundary face is centred at [{}] {}", v.join(", "), display(model, 0.0, Length::DIM).unit)
    });
    Error::new(ErrorCode::SetEmpty, format!("set '{name}' matched no face, node or element on the mesh; {near}"))
        .at(format!("set '{name}'"))
        .suggest("geometry.nameFace with a plane through that point, or a larger tol")
}
