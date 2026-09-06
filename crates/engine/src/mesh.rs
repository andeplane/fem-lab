//! The derived Mesh: one lattice per Body merged into one `Mesh`, with every Set resolved.
//!
//! Nothing here is stored in the Model — the Mesh follows from the geometry and the mesh
//! settings, and `Engine` rebuilds it lazily whenever either changes (plan B §2.1).

use std::collections::BTreeMap;

use femlab_geometry::{
    extrude, face_centroid_normal, free_sheet, lattice, mapped, nearest_boundary_face, resolve_face_set,
    resolve_region, revolve, Curve, ElementBlock, ElementKind, Face, Mesh, QuadBlock, RefineBox, Shape, Solid,
};

use crate::command::ObjectKind;
use crate::command::{CurveSpec, LatticeSize, MesherSpec, QuadBlockSpec, SweepSpec};
use crate::engine::display;
use crate::error::{Error, ErrorCode};
use crate::model::{MesherSettings, Model, SetSource, Sweep};
use crate::units::{Dim, Length, Q};

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
    let dim = model.idealisation.dim();
    let quadratic = settings.order == 2;
    let (mut mesh, body_of_block, body_faces) = match &settings.mesher {
        MesherSettings::Lattice { size, counts } => lattice_bodies(model, solids, dim, quadratic, *size, *counts)?,
        m => {
            let (body, part, mesher) = planar_or_swept(model, m, quadratic)?;
            one_body(&body, part, dim, mesher)?
        }
    };
    mesh.elem_sets.insert("all".into(), (0..mesh.n_elems() as u32).collect());

    let mut sets: BTreeMap<String, ResolvedSet> = BTreeMap::new();
    for (name, faces) in &mesh.face_sets {
        sets.insert(name.clone(), face_set(&mesh, faces.clone()));
    }
    for named in &model.sets {
        let (resolved, probe) = match &named.source {
            SetSource::Face { of, where_ } => {
                let of_body = body_faces.get(of).ok_or_else(|| {
                    Error::new(
                        ErrorCode::ModelIllPosed,
                        format!("set '{}' is named on body '{of}', which the current mesher does not mesh", named.name),
                    )
                    .at(format!("set '{}'", named.name))
                    .suggest("mesh.set with a mesher that meshes that Body, or geometry.nameFace on the meshed one")
                })?;
                (face_set(&mesh, resolve_face_set(&mesh, where_, Some(of_body))), where_.reference_point())
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
        // Keep the format-specific Mesh maps in step with the richer resolved Set. Face Sets
        // carry their nodes; element regions carry both their elements and their nodes; a
        // region that catches no element is a node-only Set.
        if !resolved.faces.is_empty() {
            mesh.face_sets.insert(named.name.clone(), resolved.faces.clone());
        }
        if !resolved.nodes.is_empty() {
            mesh.node_sets.insert(named.name.clone(), resolved.nodes.clone());
        }
        if !resolved.elems.is_empty() {
            mesh.elem_sets.insert(named.name.clone(), resolved.elems.clone());
        }
        sets.insert(named.name.clone(), resolved);
    }
    Ok(BuiltMesh { mesh, body_of_block, sets })
}

/// What a mesher produced: the Mesh, the Body of every element block, and the boundary faces
/// of each Body, which is what a `geometry.nameFace` predicate is resolved against.
type Meshed = (Mesh, Vec<String>, BTreeMap<String, Vec<Face>>);

/// The Mesh of a mesher that is its own geometry, with the Body it makes and the mesher's name.
///
/// A sweep meshes its base the same way and then extrudes or revolves it, so the Body of a
/// swept mesh is the base's.
fn planar_or_swept(model: &Model, m: &MesherSettings, quadratic: bool) -> Result<(String, Mesh, &'static str), Error> {
    match m {
        MesherSettings::Lattice { .. } => Err(Error::new(
            ErrorCode::MeshFailed,
            "a sweep needs a 2D base mesher, and the lattice mesher meshes whole Bodies",
        )
        .at("mesher.base")
        .suggest("mesh.set with a mapped base")),
        MesherSettings::Mapped { body, blocks } => {
            let kind = if quadratic { ElementKind::Quad8 } else { ElementKind::Quad4 };
            let part = mapped(blocks, kind).map_err(|e| {
                Error::new(ErrorCode::MeshFailed, e.0)
                    .at("mesher.blocks")
                    .suggest("mesh.set with the same divisions and grading on the block edges that meet")
            })?;
            Ok((body.clone(), part, "mapped"))
        }
        MesherSettings::Free { of, size, refine } => {
            let shape = model
                .body(of)
                .map(|body| &body.shape)
                .ok_or_else(|| Error::not_found("body", of, &model.names(ObjectKind::Body)).at("mesher.of"))?;
            // Unwrap the Sheet before checking its sketch so transformed geometry retains
            // located diagnostics, while non-Sheet Bodies keep the existing structured error.
            let mut leaf = shape;
            while let Shape::Named { shape, .. } | Shape::Transform { shape, .. } = leaf {
                leaf = shape;
            }
            let sketch = match leaf {
                Shape::Sheet { sketch } => sketch,
                _ => {
                    return Err(Error::new(
                        ErrorCode::ModelIllPosed,
                        format!("body '{of}' is not a sheet, and the free mesher meshes a 2D sketch"),
                    )
                    .at("mesher.of")
                    .suggest("geometry.add with a sheet shape, or mesh.set with the lattice mesher"));
                }
            };
            sketch.check().map_err(|e| {
                Error::new(ErrorCode::MeshFailed, e.cause)
                    .at(format!("shape.sketch.{}", e.where_))
                    .suggest(e.suggestion)
            })?;
            let part = free_sheet(shape, *size, quadratic, refine).map_err(|e| {
                Error::new(ErrorCode::MeshFailed, e.0)
                    .at("mesher.size")
                    .suggest("mesh.set with a different element size, or a sketch whose holes lie inside it")
            })?;
            Ok((of.clone(), part, "free"))
        }
        MesherSettings::Sweep { base, sweep } => {
            let (body, section, _) = planar_or_swept(model, base, quadratic)?;
            let swept = match *sweep {
                Sweep::Extrude { layers, height } => extrude(&section, layers, height),
                Sweep::Revolve { segments, angle_deg } => revolve(&section, segments, angle_deg),
            }
            .map_err(|e| {
                Error::new(ErrorCode::MeshFailed, e.0)
                    .at("mesher.sweep")
                    .suggest("mesh.set with a 2D base whose section stays clear of the axis")
            })?;
            Ok((body, swept, "sweep"))
        }
    }
}

/// A mesher that is its own geometry: one Mesh, one Body, face sets renamed `<body>.<tag>`.
fn one_body(body: &str, part: Mesh, dim: usize, mesher: &str) -> Result<Meshed, Error> {
    if part.dim != dim {
        return Err(Error::new(
            ErrorCode::ModelIllPosed,
            format!("the {mesher} mesher makes a {}D mesh but the idealisation is {dim}D", part.dim),
        )
        .at("mesher")
        .suggest("model.setIdealisation"));
    }
    let mut mesh = part;
    mesh.face_sets = mesh.face_sets.iter().map(|(tag, f)| (format!("{body}.{tag}"), f.clone())).collect();
    let faces = mesh.boundary_faces();
    let blocks = mesh.blocks.len();
    Ok((mesh, vec![body.to_string(); blocks], BTreeMap::from([(body.to_string(), faces)])))
}

/// One lattice per Body of the Model, merged into one Mesh.
fn lattice_bodies(
    model: &Model,
    solids: &BTreeMap<String, Solid>,
    dim: usize,
    quadratic: bool,
    size: Option<f64>,
    counts: Option<[u32; 3]>,
) -> Result<Meshed, Error> {
    if model.bodies.is_empty() {
        return Err(Error::new(ErrorCode::ModelIllPosed, "the Model has no Body to mesh").suggest("geometry.add"));
    }
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
    Ok((mesh, body_of_block, body_faces))
}

/// A `mesh.set` mesher spec with unit strings, converted to the Model's SI settings.
pub fn mesher_settings(spec: &MesherSpec) -> Result<MesherSettings, Error> {
    match spec {
        MesherSpec::Lattice { size } => match size {
            LatticeSize::Size(q) => {
                let s = q.si().map_err(|e| e.at("mesher.size"))?;
                if s <= 0.0 {
                    return Err(Error::schema("element size must be positive").at("mesher.size"));
                }
                Ok(MesherSettings::Lattice { size: Some(s), counts: None })
            }
            LatticeSize::Counts { nx, ny, nz } => {
                if *nx == 0 || *ny == 0 || *nz == 0 {
                    return Err(Error::schema("element counts must be at least 1").at("mesher.size"));
                }
                Ok(MesherSettings::Lattice { size: None, counts: Some([*nx, *ny, *nz]) })
            }
        },
        MesherSpec::Mapped { body, blocks } => {
            if blocks.is_empty() {
                return Err(Error::schema("a mapped mesh needs at least one block").at("mesher.blocks"));
            }
            let mut out = Vec::with_capacity(blocks.len());
            for (i, b) in blocks.iter().enumerate() {
                out.push(quad_block(b, i)?);
            }
            Ok(MesherSettings::Mapped { body: body.clone().unwrap_or_else(|| "sheet".to_string()), blocks: out })
        }
        MesherSpec::Free { of, size, refine } => {
            let s = size.si().map_err(|e| e.at("mesher.size"))?;
            if s <= 0.0 {
                return Err(Error::schema("element size must be positive").at("mesher.size"));
            }
            let mut boxes = Vec::new();
            for (i, b) in refine.iter().flatten().enumerate() {
                let at = |field: &str| format!("mesher.refine[{i}].{field}");
                let r = RefineBox {
                    min: xy(&b.min, &at("min"))?,
                    max: xy(&b.max, &at("max"))?,
                    size: b.size.si().map_err(|e| e.at(at("size")))?,
                };
                if r.size <= 0.0 {
                    return Err(Error::schema("a refine box needs a positive element size").at(at("size")));
                }
                if r.min[0] >= r.max[0] || r.min[1] >= r.max[1] {
                    return Err(Error::schema("a refine box needs min below max in both directions").at(at("min")));
                }
                boxes.push(r);
            }
            Ok(MesherSettings::Free { of: of.clone(), size: s, refine: boxes })
        }
        MesherSpec::Sweep { base, sweep } => {
            Ok(MesherSettings::Sweep { base: Box::new(mesher_settings(base)?), sweep: sweep_settings(sweep)? })
        }
    }
}

/// The same mesher asked for element size `h`, for one row of a `study.converge` (plan B §2.2).
///
/// A size means what it means to the mesher in hand. The lattice mesher given a size, and the
/// free mesher, take an element size, so `h` is set on them directly. Divisions are counts, so
/// a lattice's explicit counts, a mapped block's `n`, an extrusion's layers and a revolution's
/// segments scale by `h0 / h` (rounded, at least 1) with `h0` the study's *first* size, which
/// therefore names the mesh as it already stands. Either way, halving the size doubles the
/// divisions.
pub fn scale_mesher(m: &MesherSettings, h0: f64, h: f64) -> MesherSettings {
    let k = |n: usize| ((n as f64 * h0 / h).round() as usize).max(1);
    match m {
        MesherSettings::Lattice { size: Some(_), .. } => MesherSettings::Lattice { size: Some(h), counts: None },
        MesherSettings::Lattice { counts, .. } => {
            MesherSettings::Lattice { size: None, counts: counts.map(|c| c.map(|n| k(n as usize) as u32)) }
        }
        MesherSettings::Free { of, refine, .. } => {
            MesherSettings::Free { of: of.clone(), size: h, refine: refine.clone() }
        }
        MesherSettings::Mapped { body, blocks } => MesherSettings::Mapped {
            body: body.clone(),
            blocks: blocks.iter().map(|b| QuadBlock { n: [k(b.n[0]), k(b.n[1])], ..b.clone() }).collect(),
        },
        MesherSettings::Sweep { base, sweep } => MesherSettings::Sweep {
            base: Box::new(scale_mesher(base, h0, h)),
            sweep: match *sweep {
                Sweep::Extrude { layers, height } => Sweep::Extrude { layers: k(layers), height },
                Sweep::Revolve { segments, angle_deg } => Sweep::Revolve { segments: k(segments), angle_deg },
            },
        },
    }
}

/// How far and in how many steps a sweep goes, in SI.
fn sweep_settings(spec: &SweepSpec) -> Result<Sweep, Error> {
    match spec {
        SweepSpec::Extrude { layers, height } => {
            if *layers == 0 {
                return Err(Error::schema("an extrusion needs at least one layer").at("mesher.sweep.layers"));
            }
            let h = height.si().map_err(|e| e.at("mesher.sweep.height"))?;
            if h <= 0.0 {
                return Err(Error::schema("the extrusion height must be positive").at("mesher.sweep.height"));
            }
            Ok(Sweep::Extrude { layers: *layers as usize, height: h })
        }
        SweepSpec::Revolve { segments, angle_deg } => {
            if *segments == 0 {
                return Err(Error::schema("a revolution needs at least one segment").at("mesher.sweep.segments"));
            }
            if !(angle_deg.is_finite() && *angle_deg > 0.0 && *angle_deg <= 360.0) {
                return Err(Error::schema(format!(
                    "the revolution angle is {angle_deg} degrees; it must be above 0 and at most 360"
                ))
                .at("mesher.sweep.angleDeg"));
            }
            Ok(Sweep::Revolve { segments: *segments as usize, angle_deg: *angle_deg })
        }
    }
}

/// Two lengths in SI, each reporting its own index if the unit is wrong.
fn xy(v: &[Q<Length>; 2], at: &str) -> Result<[f64; 2], Error> {
    let mut out = [0.0; 2];
    for (a, q) in v.iter().enumerate() {
        out[a] = q.si().map_err(|e| e.at(format!("{at}[{a}]")))?;
    }
    Ok(out)
}

/// One block of a mapped mesh in SI, with `mesher.blocks[i].<field>` on every failure.
fn quad_block(b: &QuadBlockSpec, i: usize) -> Result<QuadBlock, Error> {
    let at = |field: &str| format!("mesher.blocks[{i}].{field}");
    let mut corners = [[0.0; 2]; 4];
    for (k, c) in b.corners.iter().enumerate() {
        corners[k] = xy(c, &at(&format!("corners[{k}]")))?;
    }
    if b.n[0] == 0 || b.n[1] == 0 {
        return Err(Error::schema("a block needs at least one element along each direction").at(at("n")));
    }
    let grading = b.grading.unwrap_or([1.0, 1.0]);
    for (a, &r) in grading.iter().enumerate() {
        if !(r.is_finite() && r > 0.0) {
            return Err(Error::schema(format!("grading[{a}] is {r}; it must be finite and positive (1.0 is uniform)"))
                .at(at("grading")));
        }
    }
    let mut edges = [Curve::Line, Curve::Line, Curve::Line, Curve::Line];
    if let Some(spec) = &b.edges {
        for (k, e) in spec.iter().enumerate() {
            edges[k] = match e {
                CurveSpec::Line => Curve::Line,
                CurveSpec::Arc { center, ccw } => {
                    Curve::Arc { center: xy(center, &at(&format!("edges[{k}].center")))?, ccw: *ccw }
                }
                CurveSpec::Ellipse { center, semi_axes } => Curve::Ellipse {
                    center: xy(center, &at(&format!("edges[{k}].center")))?,
                    semi_axes: xy(semi_axes, &at(&format!("edges[{k}].semiAxes")))?,
                },
            };
        }
    }
    let mut tags: [Option<String>; 4] = [None, None, None, None];
    if let Some(spec) = &b.tags {
        for (k, t) in spec.iter().enumerate() {
            if let Some(name) = t {
                if name.is_empty() || name.contains('.') {
                    return Err(Error::schema(format!("tag '{name}' must be a non-empty name without a dot"))
                        .at(at(&format!("tags[{k}]"))));
                }
                tags[k] = Some(name.clone());
            }
        }
    }
    Ok(QuadBlock { corners, edges, n: [b.n[0] as usize, b.n[1] as usize], grading, tags })
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
