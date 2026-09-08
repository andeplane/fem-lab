//! The derived Mesh: one lattice per Body merged into one `Mesh`, with every Set resolved.
//!
//! Nothing here is stored in the Model — the Mesh follows from the geometry and the mesh
//! settings, and `Engine` rebuilds it lazily whenever either changes (plan B §2.1).

use std::collections::BTreeMap;

use femlab_geometry::GeomError;
use femlab_geometry::{
    extrude, face_centroid_normal, free_sheet, lattice, line, mapped, merge_coincident, nearest_boundary_face,
    resolve_face_set, resolve_region, revolve, split_to_simplices, tet, Curve, ElementBlock, ElementKind, Face, Mesh,
    QuadBlock, RefineBox, Shape, Solid,
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
    /// Analytic shell directors per element; empty for other meshers.
    pub directors: Vec<[[f64; 3]; 4]>,
    pub mesh: Mesh,
    /// The Body each element block came from; blocks are one per Body.
    pub body_of_block: Vec<String>,
    /// Auto face Sets (`beam.xmin`, `hole.side`) and named Sets alike.
    pub sets: BTreeMap<String, ResolvedSet>,
    /// The node each of the Model's point masses was given, in Model order.
    pub points: Vec<u32>,
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
    let mut directors = Vec::new();
    let (mut mesh, body_of_block, mut body_faces) = match &settings.mesher {
        MesherSettings::Surface { body, patches } => {
            if quadratic || settings.simplices {
                return Err(Error::new(
                    ErrorCode::Unsupported,
                    "MITC4 surface meshing needs order 1 and no simplex split",
                )
                .at("mesher")
                .suggest("mesh.set with order 1 and simplices false"));
            }
            let built = femlab_geometry::surface(patches).map_err(|e| {
                Error::new(ErrorCode::MeshFailed, e.0)
                    .at("mesher.patches")
                    .suggest("mesh.set with regular patches and matching edge divisions")
            })?;
            directors = built.directors;
            one_body(body, built.mesh, dim, "surface")?
        }
        MesherSettings::Lattice { size, counts, sizes } => {
            validate_body_sizes(model, sizes)?;
            bodies(model, solids, dim, settings.simplices, &|solid, body| {
                let (size, counts) = sizes.get(body).map_or((*size, *counts), |&s| (Some(s), None));
                lattice(solid, size, counts, quadratic)
            })?
        }
        // A tet mesh is already simplices, so `simplices` is a no-op here rather than a second
        // split of elements that have no quads or hexes to split.
        MesherSettings::Tet { size, max_elements } => {
            bodies(model, solids, dim, false, &|solid, _| tet(solid, *size, quadratic, *max_elements as usize))?
        }
        m => {
            let (body, part, mesher) = planar_or_swept(model, m, quadratic)?;
            let part = if settings.simplices { split_to_simplices(&part) } else { part };
            one_body(&body, part, dim, mesher)?
        }
    };
    if let Some(refinement) = &settings.refinement {
        // Carry each Body's boundary through the same face ancestry as named Sets,
        // including interfaces that are not part of the assembly's exterior skin.
        for (body, faces) in &body_faces {
            mesh.face_sets.insert(format!("\0{body}"), faces.clone());
        }
        mesh = femlab_geometry::refine(&mesh, &refinement.boxes, refinement.max_elements as usize).map_err(|e| {
            Error::new(ErrorCode::MeshFailed, e.0)
                .at("refinement")
                .suggest("mesh.set with a larger local size or element budget")
        })?;
        for (body, faces) in &mut body_faces {
            *faces = mesh.face_sets.remove(&format!("\0{body}")).expect("refinement preserves every face Set");
        }
    }
    mesh.elem_sets.insert("all".into(), (0..mesh.n_elems() as u32).collect());

    let mut sets: BTreeMap<String, ResolvedSet> = BTreeMap::new();
    for (name, faces) in &mesh.face_sets {
        sets.insert(name.clone(), face_set(&mesh, faces.clone()));
    }
    // A mesher may name nodes rather than faces — the line mesher names every joint — and those
    // are Sets a Constraint or a Load can target like any other. Inert for the others, which
    // produce no node sets at all.
    for (name, nodes) in &mesh.node_sets {
        // A surface mesher can name both a face Set and its nodes. Keep the face
        // membership so pressure and traction still have an integration surface.
        sets.entry(name.clone()).or_insert_with(|| ResolvedSet {
            kind: SetKind::Node,
            faces: Vec::new(),
            nodes: nodes.clone(),
            elems: Vec::new(),
        });
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
    // Points come last, after every predicate has been resolved, so a point mass never joins a
    // region Set it merely happens to sit inside: it is only ever in the Set of its own name.
    let mut points = Vec::with_capacity(model.points.len());
    for pt in &model.points {
        let node = mesh.n_nodes() as u32;
        mesh.coords.extend_from_slice(&pt.at);
        mesh.node_sets.insert(pt.name.clone(), vec![node]);
        sets.insert(
            pt.name.clone(),
            ResolvedSet { kind: SetKind::Node, faces: Vec::new(), nodes: vec![node], elems: Vec::new() },
        );
        points.push(node);
    }
    Ok(BuiltMesh { mesh, body_of_block, sets, points, directors })
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
        MesherSettings::Surface { .. } | MesherSettings::Lattice { .. } | MesherSettings::Tet { .. } => {
            Err(Error::new(
                ErrorCode::MeshFailed,
                "a sweep needs a 2D base mesher; lattice and tet mesh whole Bodies, and surface meshes 3D shells",
            )
            .at("mesher.base")
            .suggest("mesh.set with a mapped base"))
        }
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
    mesh.node_sets = mesh.node_sets.iter().map(|(tag, n)| (format!("{body}.{tag}"), n.clone())).collect();
    let faces = mesh.boundary_faces();
    let blocks = mesh.blocks.len();
    Ok((mesh, vec![body.to_string(); blocks], BTreeMap::from([(body.to_string(), faces)])))
}

/// One mesh per Body of the Model, merged into one Mesh.
///
/// `part` is the whole-Body mesher — the lattice or the free tet mesher — given the Solid and
/// the Body's name (the lattice reads its per-Body size override by name), and everything after
/// it (the node and element offsets, the `simplices` split, the `<body>.<tag>` face Set naming)
/// is the same either way, which is why there is one copy of it.
fn bodies(
    model: &Model,
    solids: &BTreeMap<String, Solid>,
    dim: usize,
    simplices: bool,
    part: &dyn Fn(&Solid, &str) -> Result<Mesh, GeomError>,
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
    let mut has_lines = false;
    for body in &model.bodies {
        // A line Body is its own geometry: no Solid, no faces, and its node sets carry the
        // Body's name so `truss.p0` is the joint a Constraint targets.
        if let Shape::Polyline { points, members, divisions, beam } = &body.shape {
            if dim != 3 {
                return Err(Error::new(
                    ErrorCode::ModelIllPosed,
                    format!("body '{}' is made of line members, which need the 3D idealisation", body.name),
                )
                .at(format!("body '{}'", body.name))
                .suggest("model.setIdealisation with solid3d"));
            }
            has_lines = true;
            let kind = if *beam { ElementKind::Beam2 } else { ElementKind::Truss2 };
            let part = line(points, members, *divisions, kind).map_err(|e| {
                Error::new(ErrorCode::MeshFailed, e.0)
                    .at(format!("body '{}'", body.name))
                    .suggest("geometry.addLine with joints that do not coincide")
            })?;
            append(&mut mesh, &part, &body.name, &mut body_of_block);
            body_faces.insert(body.name.clone(), Vec::new());
            continue;
        }
        let solid = &solids[&body.name];
        if solid.dim() != dim {
            return Err(Error::new(
                ErrorCode::ModelIllPosed,
                format!("body '{}' is {}D but the idealisation is {dim}D", body.name, solid.dim()),
            )
            .at(format!("body '{}'", body.name))
            .suggest("model.setIdealisation, or give the Body a shape of the right dimension"));
        }
        let part = part(solid, &body.name).map_err(|e| {
            Error::new(ErrorCode::MeshFailed, e.0)
                .at(format!("body '{}'", body.name))
                .suggest("mesh.set with a smaller element size")
        })?;
        // Convert before offsets and boundary rules are resolved, so every Body and face
        // still points at the corresponding child elements.
        let part = if simplices { split_to_simplices(&part) } else { part };
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
    // Only line Bodies arrive with joints meant to be shared; welding solids that merely touch
    // would silently bond them, which is a modelling decision nobody made.
    if has_lines {
        let (lo, hi) = mesh.bbox();
        let diagonal = libm::sqrt((0..3).map(|k| (hi[k] - lo[k]) * (hi[k] - lo[k])).sum::<f64>());
        merge_coincident(&mut mesh, JOINT_TOL * diagonal);
    }
    Ok((mesh, body_of_block, body_faces))
}

/// Two joints this close together, relative to the model's own size, are one joint.
const JOINT_TOL: f64 = 1e-9;

/// Concatenate one Body's mesh into the whole, renaming its node sets `<body>.<tag>`.
fn append(mesh: &mut Mesh, part: &Mesh, body: &str, body_of_block: &mut Vec<String>) {
    let node_offset = (mesh.coords.len() / 3) as u32;
    let elem_offset = mesh.n_elems() as u32;
    mesh.coords.extend_from_slice(&part.coords);
    for blk in &part.blocks {
        mesh.blocks.push(ElementBlock {
            kind: blk.kind,
            conn: blk.conn.iter().map(|n| n + node_offset).collect(),
            first_elem: blk.first_elem + elem_offset,
        });
        body_of_block.push(body.to_string());
    }
    for (tag, nodes) in &part.node_sets {
        mesh.node_sets.insert(format!("{body}.{tag}"), nodes.iter().map(|n| n + node_offset).collect());
    }
}

/// Validate explicit size targets both at dispatch and after later geometry replacements.
pub fn validate_body_sizes(model: &Model, sizes: &BTreeMap<String, f64>) -> Result<(), Error> {
    for name in sizes.keys() {
        let at = format!("mesher.sizes.{name}");
        let body =
            model.body(name).ok_or_else(|| Error::not_found("body", name, &model.names(ObjectKind::Body)).at(&at))?;
        if let Shape::Polyline { .. } = body.shape {
            return Err(Error::new(ErrorCode::Unsupported, "line Bodies use member divisions, not element sizes")
                .at(at)
                .suggest("mesh.set without the line override, then geometry.addLine with divisions"));
        }
    }
    Ok(())
}

fn positive_size(q: &Q<Length>, at: &str) -> Result<f64, Error> {
    let size = q.si().map_err(|e| e.at(at))?;
    if size <= 0.0 {
        return Err(Error::schema("element size must be positive").at(at).suggest("mesh.set with a positive length"));
    }
    Ok(size)
}

/// A `mesh.set` mesher spec with unit strings, converted to the Model's SI settings.
pub fn mesher_settings(spec: &MesherSpec) -> Result<MesherSettings, Error> {
    match spec {
        MesherSpec::Surface { body, patches } => Ok(MesherSettings::Surface {
            body: body.clone().unwrap_or_else(|| "shell".into()),
            patches: patches.iter().enumerate().map(|(i, p)| surface_patch(p, i)).collect::<Result<_, _>>()?,
        }),
        MesherSpec::Lattice { size, sizes } => {
            let (size, counts) = match size {
                LatticeSize::Size(q) => (Some(positive_size(q, "mesher.size")?), None),
                LatticeSize::Counts { nx, ny, nz } => {
                    if *nx == 0 || *ny == 0 || *nz == 0 {
                        return Err(Error::schema("element counts must be at least 1").at("mesher.size"));
                    }
                    (None, Some([*nx, *ny, *nz]))
                }
            };
            let sizes = sizes
                .iter()
                .map(|(body, q)| Ok((body.clone(), positive_size(q, &format!("mesher.sizes.{body}"))?)))
                .collect::<Result<_, Error>>()?;
            Ok(MesherSettings::Lattice { size, counts, sizes })
        }
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
        MesherSpec::Tet(crate::command::TetSpec { size, max_elements }) => {
            let s = size.si().map_err(|e| e.at("mesher.size"))?;
            if s <= 0.0 {
                return Err(Error::schema("element size must be positive").at("mesher.size"));
            }
            let max = max_elements.unwrap_or(DEFAULT_MAX_ELEMENTS);
            if max == 0 {
                return Err(Error::schema("maxElements must be at least 1").at("mesher.maxElements"));
            }
            Ok(MesherSettings::Tet { size: s, max_elements: max })
        }
    }
}

/// Background tetrahedra the free tet mesher builds before it refuses, when `maxElements` is not
/// given: about a minute of meshing, and a model a browser tab can still solve.
const DEFAULT_MAX_ELEMENTS: u32 = 500_000;

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
        MesherSettings::Surface { body, patches } => MesherSettings::Surface {
            body: body.clone(),
            patches: patches.iter().map(|p| femlab_geometry::SurfacePatch { n: p.n.map(k), ..p.clone() }).collect(),
        },
        MesherSettings::Lattice { size: Some(original), sizes, .. } => MesherSettings::Lattice {
            size: Some(h),
            counts: None,
            sizes: sizes.iter().map(|(body, size)| (body.clone(), size * h / original)).collect(),
        },
        MesherSettings::Lattice { counts, sizes, .. } => MesherSettings::Lattice {
            size: None,
            counts: counts.map(|c| c.map(|n| k(n as usize) as u32)),
            sizes: sizes.iter().map(|(body, size)| (body.clone(), size * h / h0)).collect(),
        },
        MesherSettings::Free { of, refine, .. } => {
            MesherSettings::Free { of: of.clone(), size: h, refine: refine.clone() }
        }
        MesherSettings::Tet { max_elements, .. } => MesherSettings::Tet { size: h, max_elements: *max_elements },
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

fn surface_patch(p: &crate::command::SurfacePatchSpec, i: usize) -> Result<femlab_geometry::SurfacePatch, Error> {
    use crate::command::SurfaceProjectionSpec;
    use femlab_geometry::Projection;
    let at = format!("mesher.patches[{i}]");
    if p.n.contains(&0) {
        return Err(Error::schema("surface divisions must be positive").at(format!("{at}.n")));
    }
    let mut corners = [[0.0; 3]; 4];
    for (j, point) in p.corners.iter().enumerate() {
        corners[j] = surface_point(point, &format!("{at}.corners[{j}]"))?;
    }
    let projection = match &p.projection {
        None => None,
        Some(SurfaceProjectionSpec::Sphere { center, radius }) => Some(Projection::Sphere {
            center: surface_point(center, &format!("{at}.projection.center"))?,
            radius: positive_size(radius, &format!("{at}.projection.radius"))?,
        }),
        Some(SurfaceProjectionSpec::Cylinder { center, axis, radius }) => {
            let norm = axis.iter().map(|v| v * v).sum::<f64>().sqrt();
            if !norm.is_finite() || norm <= 0.0 {
                return Err(
                    Error::schema("cylinder axis must be finite and nonzero").at(format!("{at}.projection.axis"))
                );
            }
            Some(Projection::Cylinder {
                center: surface_point(center, &format!("{at}.projection.center"))?,
                axis: axis.map(|v| v / norm),
                radius: positive_size(radius, &format!("{at}.projection.radius"))?,
            })
        }
    };
    Ok(femlab_geometry::SurfacePatch {
        corners,
        n: p.n.map(|n| n as usize),
        tags: p.tags.clone().unwrap_or_default(),
        projection,
    })
}

fn surface_point(p: &[Q<Length>; 3], at: &str) -> Result<[f64; 3], Error> {
    let mut out = [0.0; 3];
    for (i, q) in p.iter().enumerate() {
        out[i] = q.si().map_err(|e| e.at(format!("{at}[{i}]")))?;
    }
    Ok(out)
}

/// Scale element lengths for a uniform convergence study, including local sizing.
pub(crate) fn scale_settings(settings: &crate::model::MeshSettings, from: f64, to: f64) -> crate::model::MeshSettings {
    let mut scaled = settings.clone();
    scaled.mesher = scale_mesher(&settings.mesher, from, to);
    if let Some(field) = &mut scaled.refinement {
        for region in &mut field.boxes {
            region.size *= to / from;
        }
    }
    scaled
}

/// Validate unit-bearing local sizing before it enters the Model.
pub(crate) fn local_refinement(
    spec: &crate::command::LocalRefinementSpec,
) -> Result<crate::model::LocalRefinement, Error> {
    if spec.max_elements == 0 {
        return Err(Error::schema("maxElements must be positive").at("refinement.maxElements"));
    }
    let boxes = spec
        .boxes
        .iter()
        .enumerate()
        .map(|(i, b)| {
            let box_ = femlab_geometry::SizeBox {
                min: crate::queries::si3(&b.min)?,
                max: crate::queries::si3(&b.max)?,
                size: b.size.si()?,
            };
            box_.check().map_err(|e| Error::schema(e.0).at(format!("refinement.boxes[{i}]")))?;
            Ok(box_)
        })
        .collect::<Result<Vec<_>, Error>>()?;
    Ok(crate::model::LocalRefinement { boxes, max_elements: spec.max_elements })
}
