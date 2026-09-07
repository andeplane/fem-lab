//! Evaluation of a `Shape` tree into a `Solid`: a manifold triangle surface whose every
//! triangle knows the tagged source face it came from, plus exact-ish properties.
//!
//! Face identity: every primitive leaf is tagged by classifying its own triangles
//! geometrically *before* any boolean and the tagged triangles are kept (moved along with any
//! transform). manifold-rust's `run_original_id` per result triangle survives booleans and
//! says which leaf a triangle came from; booleans only split faces, never move them, so the
//! result triangle is matched to the leaf triangle it lies on. (`face_id` is *not* used: it
//! is renumbered by disjoint unions.)

use std::collections::BTreeMap;

use manifold_rust::linalg::{Vec2, Vec3};
use manifold_rust::manifold::Manifold;
use manifold_rust::types::{MeshGL64, OpType, Polygons};

use crate::imported::{face_patches, to_manifold, MeshIndex, DEFAULT_FEATURE_ANGLE};
use crate::shape::{Affine3, Shape, DEFAULT_SEGMENTS};
use crate::sketch::{Loop, Sketch};
use crate::GeomError;

/// Triangulated boundary of a solid with a tag per triangle.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TriMesh {
    pub positions: Vec<[f64; 3]>,
    pub triangles: Vec<[u32; 3]>,
    /// Index into `tag_names` per triangle.
    pub tags: Vec<u32>,
    pub tag_names: Vec<String>,
}

impl TriMesh {
    pub fn tag_of(&self, tri: usize) -> &str {
        &self.tag_names[self.tags[tri] as usize]
    }
}

/// An evaluated shape.
#[derive(Debug, Clone)]
pub struct Solid {
    shape: Shape,
    dim: usize,
    volume: f64,
    area: f64,
    bbox: ([f64; 3], [f64; 3]),
    tri: TriMesh,
    /// For 2D sheets: the sampled boundary loops (outer ccw, holes cw) with edge tags.
    outline: Vec<Loop>,
    genus: i32,
    /// The evaluated manifold, for the containment a shape tree cannot answer analytically.
    index: MeshIndex,
}

/// The tagged triangles of one primitive leaf, in world coordinates.
#[derive(Debug, Clone, Default)]
struct LeafFaces {
    tris: Vec<[[f64; 3]; 3]>,
    normals: Vec<[f64; 3]>,
    tags: Vec<String>,
}

impl LeafFaces {
    fn transform(&mut self, at: &Affine3) {
        for t in &mut self.tris {
            for p in t.iter_mut() {
                *p = at.apply(*p);
            }
        }
        self.normals = self.tris.iter().map(|t| tri_normal(t[0], t[1], t[2])).collect();
    }
    /// Tag of the leaf triangle closest to `c` among those (anti)parallel to `n`; when none is
    /// parallel (a degenerate sliver), the closest triangle of any orientation.
    fn tag_at(&self, c: [f64; 3], n: [f64; 3]) -> &str {
        let mut best = (f64::INFINITY, 0usize);
        let mut best_any = (f64::INFINITY, 0usize);
        for (i, t) in self.tris.iter().enumerate() {
            let ln = self.normals[i];
            let dist = point_triangle_distance(c, t);
            if dist < best_any.0 {
                best_any = (dist, i);
            }
            let parallel = (ln[0] * n[0] + ln[1] * n[1] + ln[2] * n[2]).abs() >= 0.99;
            if parallel && dist < best.0 {
                best = (dist, i);
            }
        }
        let i = if best.0.is_finite() { best.1 } else { best_any.1 };
        &self.tags[i]
    }
}

type Leaves = BTreeMap<u32, LeafFaces>;

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn point_segment_distance3(p: [f64; 3], a: [f64; 3], b: [f64; 3]) -> f64 {
    let ab = sub(b, a);
    let l2 = dot3(ab, ab);
    let t = if l2 == 0.0 { 0.0 } else { (dot3(sub(p, a), ab) / l2).clamp(0.0, 1.0) };
    let c = [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
    let d = sub(p, c);
    libm::sqrt(dot3(d, d))
}

/// Distance from a point to a triangle: the plane distance when the projection falls inside,
/// else the distance to the nearest edge.
fn point_triangle_distance(p: [f64; 3], t: &[[f64; 3]; 3]) -> f64 {
    let n = tri_normal(t[0], t[1], t[2]);
    let h = dot3(sub(p, t[0]), n);
    let q = [p[0] - h * n[0], p[1] - h * n[1], p[2] - h * n[2]];
    let mut inside = true;
    for k in 0..3 {
        let a = t[k];
        let b = t[(k + 1) % 3];
        let e = sub(b, a);
        let cross = [e[1] * n[2] - e[2] * n[1], e[2] * n[0] - e[0] * n[2], e[0] * n[1] - e[1] * n[0]];
        if dot3(sub(q, a), cross) > 1e-12 {
            inside = false;
            break;
        }
    }
    if inside {
        return h.abs();
    }
    (0..3).map(|k| point_segment_distance3(p, t[k], t[(k + 1) % 3])).fold(f64::INFINITY, f64::min)
}

fn v3(p: [f64; 3]) -> Vec3 {
    Vec3::new(p[0], p[1], p[2])
}

pub(crate) fn tri_normal(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> [f64; 3] {
    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    let l = libm::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
    if l == 0.0 {
        return [0.0, 0.0, 0.0];
    }
    [n[0] / l, n[1] / l, n[2] / l]
}

fn positions(gl: &MeshGL64) -> Vec<[f64; 3]> {
    (0..gl.num_vert()).map(|v| gl.get_vert_pos(v)).collect()
}

fn tri_centroid_normal(gl: &MeshGL64, pos: &[[f64; 3]], t: usize) -> ([f64; 3], [f64; 3]) {
    let v = gl.get_tri_verts(t);
    let (a, b, c) = (pos[v[0] as usize], pos[v[1] as usize], pos[v[2] as usize]);
    let cen = [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0, (a[2] + b[2] + c[2]) / 3.0];
    (cen, tri_normal(a, b, c))
}

fn box_tag(n: [f64; 3]) -> String {
    let ax = [n[0].abs(), n[1].abs(), n[2].abs()];
    let i = if ax[0] >= ax[1] && ax[0] >= ax[2] {
        0
    } else if ax[1] >= ax[2] {
        1
    } else {
        2
    };
    let axis = ["x", "y", "z"][i];
    format!("{axis}{}", if n[i] > 0.0 { "max" } else { "min" })
}

fn cylinder_tag(n: [f64; 3]) -> String {
    if n[2] > 0.9 {
        "top".into()
    } else if n[2] < -0.9 {
        "bottom".into()
    } else {
        "side".into()
    }
}

fn extrude_tag(loops: &[Loop], cen: [f64; 3], n: [f64; 3]) -> String {
    if n[2] > 0.9 {
        return "top".into();
    }
    if n[2] < -0.9 {
        return "bottom".into();
    }
    nearest_loop_tag(loops, [cen[0], cen[1]])
}

fn nearest_loop_tag(loops: &[Loop], p: [f64; 2]) -> String {
    let mut best: (f64, &str) = (f64::INFINITY, "");
    for l in loops {
        let (j, d) = l.nearest_edge(p);
        if d < best.0 {
            best = (d, &l.tags[j]);
        }
    }
    best.1.to_string()
}

fn revolve_tag(loops: &[Loop], angle: f64, cen: [f64; 3], n: [f64; 3]) -> String {
    let r = libm::hypot(cen[0], cen[1]);
    if angle < 360.0 {
        let mut th = libm::atan2(cen[1], cen[0]);
        if th < -1e-9 {
            th += std::f64::consts::TAU;
        }
        // tangential direction at the centroid; a cap's normal is tangential
        let t = if r > 0.0 { [-cen[1] / r, cen[0] / r, 0.0] } else { [0.0, 1.0, 0.0] };
        if (n[0] * t[0] + n[1] * t[1]).abs() > 0.99 {
            return if th < angle.to_radians() / 2.0 { "theta0".into() } else { "theta1".into() };
        }
    }
    nearest_loop_tag(loops, [r, cen[2]])
}

fn polygons(loops: &[Loop]) -> Polygons {
    loops.iter().map(|l| l.pts.iter().map(|p| Vec2::new(p[0], p[1])).collect()).collect()
}

/// Chord tolerance for a curved sketch edge: a fraction of the sketch's size (from the chord
/// polygon of its outer loop), so that the facet count follows `segments` roughly as it does
/// for cylinders.
fn sketch_chord_tol(sketch: &Sketch, segments: u32) -> f64 {
    let mut lo = [f64::INFINITY; 2];
    let mut hi = [f64::NEG_INFINITY; 2];
    for seg in &sketch.outer {
        let p = seg.to();
        for k in 0..2 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    let r = 0.5 * libm::hypot(hi[0] - lo[0], hi[1] - lo[1]).clamp(1e-300, f64::MAX);
    // a circle of radius r sampled with `segments` chords has sagitta r(1 - cos(π/segments))
    r * (1.0 - libm::cos(std::f64::consts::PI / segments as f64))
}

fn join(prefix: &str, tag: &str) -> String {
    if prefix.is_empty() {
        tag.to_string()
    } else {
        format!("{prefix}.{tag}")
    }
}

fn tag_leaf(
    m: &Manifold,
    prefix: &str,
    leaves: &mut Leaves,
    classify: &dyn Fn(usize, [f64; 3], [f64; 3]) -> String,
) -> Vec<u32> {
    let gl = m.get_mesh_gl64(-1);
    // a primitive is exactly one run
    let id = gl.run_original_id[0];
    let pos = positions(&gl);
    let mut leaf = LeafFaces::default();
    for t in 0..gl.num_tri() {
        let (cen, n) = tri_centroid_normal(&gl, &pos, t);
        let v = gl.get_tri_verts(t);
        leaf.tris.push([pos[v[0] as usize], pos[v[1] as usize], pos[v[2] as usize]]);
        leaf.normals.push(n);
        leaf.tags.push(join(prefix, &classify(t, cen, n)));
    }
    leaves.insert(id, leaf);
    vec![id]
}

fn eval_all(shapes: &[Shape], prefix: &str, leaves: &mut Leaves) -> Result<(Vec<Manifold>, Vec<u32>), GeomError> {
    let mut parts = Vec::with_capacity(shapes.len());
    let mut ids = Vec::new();
    for s in shapes {
        let (m, i) = eval(s, prefix, leaves)?;
        parts.push(m);
        ids.extend(i);
    }
    Ok((parts, ids))
}

/// Evaluate a subtree; returns the manifold and the run ids of the leaves beneath it.
fn eval(shape: &Shape, prefix: &str, leaves: &mut Leaves) -> Result<(Manifold, Vec<u32>), GeomError> {
    let (m, ids) = match shape {
        Shape::Box { size } => {
            let m = Manifold::cube(v3(*size), false);
            let ids = tag_leaf(&m, prefix, leaves, &|_, _, n| box_tag(n));
            (m, ids)
        }
        Shape::Cylinder { radius, height, segments } => {
            let m = Manifold::cylinder(*height, *radius, *radius, segments.unwrap_or(DEFAULT_SEGMENTS) as i32);
            let ids = tag_leaf(&m, prefix, leaves, &|_, _, n| cylinder_tag(n));
            (m, ids)
        }
        Shape::Sphere { radius, segments } => {
            let m = Manifold::sphere(*radius, segments.unwrap_or(DEFAULT_SEGMENTS) as i32);
            let ids = tag_leaf(&m, prefix, leaves, &|_, _, _| "surface".to_string());
            (m, ids)
        }
        Shape::Sheet { .. } => return Err(GeomError("a 2D sheet cannot be evaluated as a solid".into())),
        Shape::Extrude { sketch, height } => {
            let loops = sketch.loops(sketch_chord_tol(sketch, DEFAULT_SEGMENTS))?;
            let m = Manifold::extrude(&polygons(&loops), *height, 0, 0.0, Vec2::new(1.0, 1.0));
            let ids = tag_leaf(&m, prefix, leaves, &|_, c, n| extrude_tag(&loops, c, n));
            (m, ids)
        }
        Shape::Revolve { sketch, angle, segments } => {
            let segs = segments.unwrap_or(DEFAULT_SEGMENTS);
            let loops = sketch.loops(sketch_chord_tol(sketch, segs))?;
            let m = Manifold::revolve(&polygons(&loops), segs as i32, *angle);
            let ids = tag_leaf(&m, prefix, leaves, &|_, c, n| revolve_tag(&loops, *angle, c, n));
            (m, ids)
        }
        Shape::Union { shapes } => {
            let (parts, ids) = eval_all(shapes, prefix, leaves)?;
            (Manifold::batch_boolean(&parts, OpType::Add), ids)
        }
        Shape::Intersect { shapes } => {
            let (parts, ids) = eval_all(shapes, prefix, leaves)?;
            (Manifold::batch_boolean(&parts, OpType::Intersect), ids)
        }
        Shape::Subtract { from, cut } => {
            let (base, mut ids) = eval(from, prefix, leaves)?;
            if cut.is_empty() {
                (base, ids)
            } else {
                let (cuts, cut_ids) = eval_all(cut, prefix, leaves)?;
                ids.extend(cut_ids);
                (base.difference(&Manifold::batch_boolean(&cuts, OpType::Add)), ids)
            }
        }
        Shape::Transform { shape, at } => {
            let (m, ids) = eval(shape, prefix, leaves)?;
            for id in &ids {
                leaves.entry(*id).and_modify(|l| l.transform(at));
            }
            (apply_affine(&m, at), ids)
        }
        Shape::Named { name, shape } => eval(shape, name, leaves)?,
        Shape::Mesh { positions, triangles, feature_angle, simplify_below } => {
            let m = to_manifold(positions, triangles, *simplify_below)?;
            let tags = face_patches(&m.get_mesh_gl64(-1), feature_angle.unwrap_or(DEFAULT_FEATURE_ANGLE));
            let ids = tag_leaf(&m, prefix, leaves, &|t, _, _| tags[t].clone());
            (m, ids)
        }
    };
    Ok((m, ids))
}

fn apply_affine(m: &Manifold, at: &Affine3) -> Manifold {
    m.scale(v3(at.scale)).rotate(at.rotate[0], at.rotate[1], at.rotate[2]).translate(v3(at.translate))
}

impl Solid {
    /// Evaluate a shape (validated first).
    pub fn evaluate(shape: &Shape) -> Result<Solid, GeomError> {
        shape.validate()?;
        if shape.dim() == 2 {
            Solid::evaluate_sheet(shape)
        } else {
            Solid::evaluate_solid(shape)
        }
    }

    fn evaluate_solid(shape: &Shape) -> Result<Solid, GeomError> {
        let mut leaves = Leaves::new();
        let (m, _) = eval(shape, "", &mut leaves)?;
        if m.is_empty() {
            return Err(GeomError("the shape evaluates to nothing (an empty solid)".into()));
        }
        let gl = m.get_mesh_gl64(-1);
        let pos = positions(&gl);
        let mut tag_names: Vec<String> = Vec::new();
        let mut tag_index: BTreeMap<String, u32> = BTreeMap::new();
        let mut tri_tags = Vec::with_capacity(gl.num_tri());
        let mut triangles = Vec::with_capacity(gl.num_tri());
        for run in 0..gl.run_original_id.len() {
            let orig = gl.run_original_id[run];
            let leaf = &leaves[&orig]; // every run id in the result is a leaf we tagged
            let t0 = gl.run_index[run] as usize / 3;
            let t1 = gl.run_index[run + 1] as usize / 3;
            for t in t0..t1 {
                let (cen, n) = tri_centroid_normal(&gl, &pos, t);
                let tag = leaf.tag_at(cen, n).to_string();
                let idx = *tag_index.entry(tag.clone()).or_insert_with(|| {
                    tag_names.push(tag.clone());
                    (tag_names.len() - 1) as u32
                });
                tri_tags.push(idx);
                let v = gl.get_tri_verts(t);
                triangles.push([v[0] as u32, v[1] as u32, v[2] as u32]);
            }
        }
        let bb = m.bounding_box();
        Ok(Solid {
            shape: shape.clone(),
            dim: 3,
            volume: m.volume(),
            area: m.surface_area(),
            bbox: ([bb.min.x, bb.min.y, bb.min.z], [bb.max.x, bb.max.y, bb.max.z]),
            tri: TriMesh { positions: pos, triangles, tags: tri_tags, tag_names },
            outline: vec![],
            genus: m.genus(),
            index: MeshIndex::new(m),
        })
    }

    fn evaluate_sheet(shape: &Shape) -> Result<Solid, GeomError> {
        // 2D booleans are not evaluated (no 2D boolean kernel); a plain sheet, possibly
        // named or translated in-plane, is what the meshers consume.
        let (sketch, at, prefix) = sheet_leaf(shape, &Affine3::default(), "")?;
        let area = sketch.area()? * at.scale[0] * at.scale[1];
        let loops = transformed_sheet_loops(&sketch, &at, &prefix, sketch_chord_tol(&sketch, DEFAULT_SEGMENTS))?;
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for p in &loops[0].pts {
            for k in 0..2 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
        lo[2] = 0.0;
        hi[2] = 0.0;
        Ok(Solid {
            shape: shape.clone(),
            dim: 2,
            volume: 0.0,
            area,
            bbox: (lo, hi),
            tri: TriMesh::default(),
            outline: loops,
            genus: 0,
            index: MeshIndex::new(Manifold::new()),
        })
    }

    pub fn dim(&self) -> usize {
        self.dim
    }
    pub fn shape(&self) -> &Shape {
        &self.shape
    }
    /// Volume of a 3D solid (exact for polyhedra; faceted for curved primitives). 0 for a sheet.
    pub fn volume(&self) -> f64 {
        self.volume
    }
    /// Surface area of a 3D solid, or the area of a 2D sheet.
    pub fn area(&self) -> f64 {
        self.area
    }
    pub fn bbox(&self) -> ([f64; 3], [f64; 3]) {
        self.bbox
    }
    pub fn triangles(&self) -> &TriMesh {
        &self.tri
    }
    /// Boundary loops of a 2D sheet (empty for solids).
    pub fn outline(&self) -> &[Loop] {
        &self.outline
    }
    /// All distinct face tags.
    pub fn tags(&self) -> Vec<String> {
        if self.dim == 2 {
            let mut v: Vec<String> = self.outline.iter().flat_map(|l| l.tags.iter().cloned()).collect();
            v.sort();
            v.dedup();
            v
        } else {
            let mut v = self.tri.tag_names.clone();
            v.sort();
            v
        }
    }
    /// Topological genus: 0 for a ball or a box, 1 for a torus, one per through-hole. A
    /// sheet reports 0.
    pub fn genus(&self) -> i32 {
        self.genus
    }
    /// Containment, analytic on the shape tree (curved primitives are exact circles there).
    /// An imported mesh has no analytic form and is ray-cast against the evaluated manifold.
    pub fn contains(&self, p: [f64; 3]) -> bool {
        self.shape.contains(p).unwrap_or_else(|_| self.index.contains(p))
    }
    /// Centroid of the triangle mesh (3D) or of the outline (2D).
    pub fn centroid(&self) -> [f64; 3] {
        if self.dim == 2 {
            let l = &self.outline[0];
            let mut c = [0.0; 3];
            let a = l.signed_area();
            let n = l.pts.len();
            for i in 0..n {
                let p = l.pts[i];
                let q = l.pts[(i + 1) % n];
                let cross = p[0] * q[1] - q[0] * p[1];
                c[0] += (p[0] + q[0]) * cross;
                c[1] += (p[1] + q[1]) * cross;
            }
            return [c[0] / (6.0 * a), c[1] / (6.0 * a), 0.0];
        }
        // volume-weighted centroid via signed tetrahedra to the origin
        let mut c = [0.0; 3];
        let mut vol = 0.0;
        for t in &self.tri.triangles {
            let (a, b, d) = (
                self.tri.positions[t[0] as usize],
                self.tri.positions[t[1] as usize],
                self.tri.positions[t[2] as usize],
            );
            let v6 = a[0] * (b[1] * d[2] - b[2] * d[1]) - a[1] * (b[0] * d[2] - b[2] * d[0])
                + a[2] * (b[0] * d[1] - b[1] * d[0]);
            vol += v6;
            for k in 0..3 {
                c[k] += v6 * (a[k] + b[k] + d[k]) / 4.0;
            }
        }
        [c[0] / vol, c[1] / vol, c[2] / vol]
    }
}

/// Sample in local coordinates, then apply the shared world-coordinate/tag transformation.
/// Callers choose the tolerance: preview resolution or the mesher's world-space error bound.
pub(crate) fn transformed_sheet_loops(
    sketch: &Sketch,
    at: &Affine3,
    prefix: &str,
    local_chord_tol: f64,
) -> Result<Vec<Loop>, GeomError> {
    let mut loops = sketch.loops(local_chord_tol)?;
    for l in &mut loops {
        for p in &mut l.pts {
            let q = at.apply([p[0], p[1], 0.0]);
            if q.iter().any(|coordinate| !coordinate.is_finite()) {
                return Err(GeomError(
                    "the Sheet transform produces non-finite coordinates; reduce its scale or translation".into(),
                ));
            }
            *p = [q[0], q[1]];
        }
        for t in &mut l.tags {
            *t = join(prefix, t);
        }
    }
    Ok(loops)
}

pub(crate) fn sheet_leaf(shape: &Shape, at: &Affine3, prefix: &str) -> Result<(Sketch, Affine3, String), GeomError> {
    match shape {
        Shape::Sheet { sketch } => Ok((sketch.clone(), at.clone(), prefix.to_string())),
        Shape::Named { name, shape } => sheet_leaf(shape, at, name),
        Shape::Transform { shape, at: t } => {
            if at != &Affine3::default() {
                return Err(GeomError("nested transforms of a sheet are not supported".into()));
            }
            if t.rotate[0] != 0.0 || t.rotate[1] != 0.0 || t.translate[2] != 0.0 {
                return Err(GeomError("a sheet can only be moved within the xy plane".into()));
            }
            sheet_leaf(shape, t, prefix)
        }
        _ => Err(GeomError("booleans of 2D sheets are not supported; use a sketch with holes".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sketch::Segment;
    use std::collections::BTreeSet;
    use std::f64::consts::PI;

    fn tag_set(s: &Solid) -> BTreeSet<String> {
        s.tags().into_iter().collect()
    }

    fn area_of_tag(s: &Solid, tag: &str) -> f64 {
        let m = s.triangles();
        let mut a = 0.0;
        for (t, tri) in m.triangles.iter().enumerate() {
            if m.tag_of(t) == tag {
                let (p, q, r) =
                    (m.positions[tri[0] as usize], m.positions[tri[1] as usize], m.positions[tri[2] as usize]);
                let u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
                let w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
                let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
                a += 0.5 * libm::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
            }
        }
        a
    }

    #[test]
    fn box_is_exact_with_six_tags() {
        let s = Solid::evaluate(&Shape::Box { size: [1.0, 2.0, 3.0] }).unwrap();
        assert_eq!(s.dim(), 3);
        assert!((s.volume() - 6.0).abs() < 1e-12);
        assert!((s.area() - 22.0).abs() < 1e-12);
        assert_eq!(s.bbox(), ([0.0, 0.0, 0.0], [1.0, 2.0, 3.0]));
        assert_eq!(
            tag_set(&s),
            ["xmin", "xmax", "ymin", "ymax", "zmin", "zmax"].iter().map(|s| s.to_string()).collect()
        );
        assert!((area_of_tag(&s, "zmax") - 2.0).abs() < 1e-12);
        assert!((area_of_tag(&s, "xmin") - 6.0).abs() < 1e-12);
        assert_eq!(s.triangles().triangles.len(), 12);
        let c = s.centroid();
        assert!((c[0] - 0.5).abs() < 1e-12 && (c[1] - 1.0).abs() < 1e-12 && (c[2] - 1.5).abs() < 1e-12);
        assert!(s.contains([0.5, 0.5, 0.5]) && !s.contains([2.0, 0.0, 0.0]));
        assert_eq!(s.shape(), &Shape::Box { size: [1.0, 2.0, 3.0] });
        assert!(s.outline().is_empty());
    }

    #[test]
    fn plate_minus_cylinder_keeps_every_face_identity() {
        let hole = Shape::Transform {
            shape: Box::new(Shape::Cylinder { radius: 1.0, height: 20.0, segments: Some(64) }),
            at: Affine3::translation([5.0, 5.0, -5.0]),
        };
        let shape = Shape::Named {
            name: "plate".into(),
            shape: Box::new(Shape::Subtract {
                from: Box::new(Shape::Box { size: [10.0; 3] }),
                cut: vec![Shape::Named { name: "hole".into(), shape: Box::new(hole) }],
            }),
        };
        let s = Solid::evaluate(&shape).unwrap();
        let tags = tag_set(&s);
        for f in ["plate.xmin", "plate.xmax", "plate.ymin", "plate.ymax", "plate.zmin", "plate.zmax", "hole.side"] {
            assert!(tags.contains(f), "{f} missing from {tags:?}");
        }
        assert_eq!(tags.len(), 7, "through-hole caps vanish: {tags:?}");
        let poly_area = 64.0 * 0.5 * libm::sin(2.0 * PI / 64.0);
        assert!((s.volume() - (1000.0 - poly_area * 10.0)).abs() < 1e-9);
        assert!((area_of_tag(&s, "plate.zmax") - (100.0 - poly_area)).abs() < 1e-9);
        assert!((area_of_tag(&s, "hole.side") - 64.0 * 2.0 * libm::sin(PI / 64.0) * 10.0).abs() < 1e-9);
        assert!(!s.contains([5.0, 5.0, 5.0]) && s.contains([1.0, 1.0, 5.0]));
    }

    #[test]
    fn union_intersect_and_transforms() {
        let a = Shape::Box { size: [1.0; 3] };
        let b = Shape::Transform { shape: Box::new(a.clone()), at: Affine3::translation([0.5, 0.0, 0.0]) };
        let u = Solid::evaluate(&Shape::Union { shapes: vec![a.clone(), b.clone()] }).unwrap();
        assert!((u.volume() - 1.5).abs() < 1e-12);
        let i = Solid::evaluate(&Shape::Intersect { shapes: vec![a.clone(), b.clone()] }).unwrap();
        assert!((i.volume() - 0.5).abs() < 1e-12);
        let rotated = Solid::evaluate(&Shape::Transform {
            shape: Box::new(a.clone()),
            at: Affine3 { rotate: [0.0, 0.0, 90.0], scale: [2.0, 1.0, 1.0], ..Default::default() },
        })
        .unwrap();
        assert!((rotated.volume() - 2.0).abs() < 1e-12);
        let (lo, hi) = rotated.bbox();
        assert!((lo[1] - 0.0).abs() < 1e-9 && (hi[1] - 2.0).abs() < 1e-9 && (lo[0] + 1.0).abs() < 1e-9);
        // the face that was xmax (x = 2 after scale) now faces +y and keeps its name
        let m = rotated.triangles();
        let t = (0..m.triangles.len()).find(|&t| m.tag_of(t) == "xmax").unwrap();
        let tri = m.triangles[t];
        assert!((m.positions[tri[0] as usize][1] - 2.0).abs() < 1e-9);
        let sub_nothing = Solid::evaluate(&Shape::Subtract { from: Box::new(a.clone()), cut: vec![] }).unwrap();
        assert!((sub_nothing.volume() - 1.0).abs() < 1e-12);
        let sphere = Solid::evaluate(&Shape::Sphere { radius: 1.0, segments: Some(64) }).unwrap();
        assert!((sphere.volume() - 4.0 / 3.0 * PI).abs() < 0.03);
        assert_eq!(sphere.tags(), vec!["surface".to_string()]);
        let cyl = Solid::evaluate(&Shape::Cylinder { radius: 1.0, height: 2.0, segments: Some(128) }).unwrap();
        assert!((cyl.volume() - 2.0 * PI).abs() < 1e-2);
        assert_eq!(tag_set(&cyl), ["bottom", "side", "top"].iter().map(|s| s.to_string()).collect());
        assert!((area_of_tag(&cyl, "top") - PI).abs() < 1e-2);
        let c = cyl.centroid();
        assert!(c[0].abs() < 1e-9 && (c[2] - 1.0).abs() < 1e-9);
    }

    #[test]
    fn extrude_and_revolve_tag_by_sketch_segment() {
        let sk = Sketch { outer: Sketch::rect(2.0, 1.0).outer, holes: vec![Sketch::circle([1.0, 0.5], 0.25, "bore")] };
        let ex = Solid::evaluate(&Shape::Extrude { sketch: sk.clone(), height: 3.0 }).unwrap();
        let tags = tag_set(&ex);
        assert_eq!(
            tags,
            ["bore", "bottom", "top", "xmax", "xmin", "ymax", "ymin"].iter().map(|s| s.to_string()).collect()
        );
        assert!((area_of_tag(&ex, "xmax") - 3.0).abs() < 1e-9);
        assert!((ex.volume() - (2.0 - PI * 0.0625) * 3.0).abs() < 0.03);
        // default tags without user names
        let plain = Sketch {
            outer: vec![
                Segment::Line { to: [1.0, 0.0], tag: None },
                Segment::Line { to: [1.0, 1.0], tag: None },
                Segment::Line { to: [0.0, 1.0], tag: None },
                Segment::Line { to: [0.0, 0.0], tag: None },
            ],
            holes: vec![],
        };
        let ex2 = Solid::evaluate(&Shape::Extrude { sketch: plain, height: 1.0 }).unwrap();
        assert_eq!(
            tag_set(&ex2),
            ["bottom", "edge0", "edge1", "edge2", "edge3", "top"].iter().map(|s| s.to_string()).collect()
        );
        // tube: rectangle r ∈ [1, 2], z ∈ [0, 1], revolved 90°
        let rect = Sketch {
            outer: vec![
                Segment::Line { to: [2.0, 0.0], tag: Some("bottom".into()) },
                Segment::Line { to: [2.0, 1.0], tag: Some("outer".into()) },
                Segment::Line { to: [1.0, 1.0], tag: Some("top".into()) },
                Segment::Line { to: [1.0, 0.0], tag: Some("inner".into()) },
            ],
            holes: vec![],
        };
        let rv = Solid::evaluate(&Shape::Revolve { sketch: rect.clone(), angle: 90.0, segments: Some(64) }).unwrap();
        assert_eq!(
            tag_set(&rv),
            ["bottom", "inner", "outer", "theta0", "theta1", "top"].iter().map(|s| s.to_string()).collect()
        );
        assert!((rv.volume() - 0.25 * PI * 3.0).abs() < 0.01);
        assert!((area_of_tag(&rv, "theta0") - 1.0).abs() < 1e-9);
        assert!((area_of_tag(&rv, "theta1") - 1.0).abs() < 1e-9);
        assert!((area_of_tag(&rv, "top") - 0.25 * PI * 3.0).abs() < 0.01);
        let full = Solid::evaluate(&Shape::Revolve { sketch: rect, angle: 360.0, segments: Some(64) }).unwrap();
        assert_eq!(tag_set(&full), ["bottom", "inner", "outer", "top"].iter().map(|s| s.to_string()).collect());
        assert!((full.volume() - PI * 3.0).abs() < 0.02);
        // a solid cylinder by revolving a rectangle touching the axis
        let disc =
            Solid::evaluate(&Shape::Revolve { sketch: Sketch::rect(1.0, 2.0), angle: 360.0, segments: Some(64) })
                .unwrap();
        assert!((disc.volume() - 2.0 * PI).abs() < 0.02);
    }

    #[test]
    fn sheet_loop_transform_refuses_overflow() {
        let at = Affine3 { scale: [1e308, 1.0, 1.0], ..Default::default() };
        let error = transformed_sheet_loops(&Sketch::rect(2.0, 1.0), &at, "", 0.1).unwrap_err();
        assert!(error.0.contains("non-finite coordinates"));
    }

    #[test]
    fn sheets_have_area_outline_and_tags() {
        let sk = Sketch { outer: Sketch::rect(2.0, 1.0).outer, holes: vec![Sketch::circle([1.0, 0.5], 0.25, "bore")] };
        let s = Solid::evaluate(&Shape::Named { name: "plate".into(), shape: Box::new(Shape::Sheet { sketch: sk }) })
            .unwrap();
        assert_eq!(s.dim(), 2);
        assert_eq!(s.volume(), 0.0);
        assert!((s.area() - (2.0 - PI * 0.0625)).abs() < 1e-12);
        assert_eq!(s.bbox(), ([0.0, 0.0, 0.0], [2.0, 1.0, 0.0]));
        assert_eq!(s.tags(), ["plate.bore", "plate.xmax", "plate.xmin", "plate.ymax", "plate.ymin"]);
        assert_eq!(s.outline().len(), 2);
        assert!(s.triangles().triangles.is_empty());
        assert!(s.contains([0.1, 0.1, 0.0]) && !s.contains([1.0, 0.5, 0.0]));
        let c = s.centroid();
        assert!((c[0] - 1.0).abs() < 1e-12 && (c[1] - 0.5).abs() < 1e-12);
        let moved = Solid::evaluate(&Shape::Transform {
            shape: Box::new(Shape::Sheet { sketch: Sketch::rect(1.0, 1.0) }),
            at: Affine3 { translate: [3.0, 0.0, 0.0], rotate: [0.0, 0.0, 90.0], scale: [2.0, 1.0, 1.0] },
        })
        .unwrap();
        assert!((moved.area() - 2.0).abs() < 1e-12);
        let (lo, hi) = moved.bbox();
        assert!((lo[0] - 2.0).abs() < 1e-9 && (hi[0] - 3.0).abs() < 1e-9 && (hi[1] - 2.0).abs() < 1e-9);
        assert!(
            Solid::evaluate(&Shape::Union { shapes: vec![Shape::Sheet { sketch: Sketch::rect(1.0, 1.0) }] }).is_err()
        );
        let out_of_plane = Shape::Transform {
            shape: Box::new(Shape::Sheet { sketch: Sketch::rect(1.0, 1.0) }),
            at: Affine3 { rotate: [90.0, 0.0, 0.0], ..Default::default() },
        };
        assert!(Solid::evaluate(&out_of_plane).unwrap_err().0.contains("xy plane"));
        let nested = Shape::Transform {
            shape: Box::new(Shape::Transform {
                shape: Box::new(Shape::Sheet { sketch: Sketch::rect(1.0, 1.0) }),
                at: Affine3::translation([1.0, 0.0, 0.0]),
            }),
            at: Affine3::translation([1.0, 0.0, 0.0]),
        };
        assert!(Solid::evaluate(&nested).unwrap_err().0.contains("nested"));
    }

    #[test]
    fn an_imported_mesh_evaluates_to_a_solid_with_patch_faces() {
        let positions = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [1.0, 1.0, 1.0],
            [0.0, 1.0, 1.0],
        ];
        let quads: [[u32; 4]; 6] = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
        let triangles: Vec<[u32; 3]> = quads.iter().flat_map(|q| [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]).collect();
        let shape = Shape::Mesh {
            positions: positions.clone(),
            triangles: triangles.clone(),
            feature_angle: None,
            simplify_below: None,
        };
        let s = Solid::evaluate(&shape).unwrap();
        assert!((s.volume() - 1.0).abs() < 1e-12);
        assert!((s.area() - 6.0).abs() < 1e-12);
        assert_eq!(s.genus(), 0);
        assert_eq!(s.tags(), ["face0", "face1", "face2", "face3", "face4", "face5"]);
        // containment falls through the shape tree's error to the ray cast
        assert!(s.contains([0.5; 3]) && !s.contains([2.0, 0.5, 0.5]));
        assert!(format!("{s:?}").contains("MeshIndex(12 triangles)"));
        // a feature angle wide enough to weld the whole cube into one patch
        let welded = Solid::evaluate(&Shape::Mesh {
            positions: positions.clone(),
            triangles: triangles.clone(),
            feature_angle: Some(91.0),
            simplify_below: None,
        })
        .unwrap();
        assert_eq!(welded.tags(), ["face0"]);
        // and one that swallows the body entirely
        let gone = Solid::evaluate(&Shape::Mesh {
            positions: positions.clone(),
            triangles: triangles.clone(),
            feature_angle: None,
            simplify_below: Some(100.0),
        });
        assert!(gone.unwrap_err().0.contains("simplifies away to nothing"));
        // an open surface is not a solid
        let open: Vec<[u32; 3]> = triangles.iter().copied().filter(|t| !t.contains(&6)).collect();
        let err =
            Solid::evaluate(&Shape::Mesh { positions, triangles: open, feature_angle: None, simplify_below: None });
        assert!(err.unwrap_err().0.contains("Not Closed"));
        // a sheet keeps the analytic answer and never reaches the ray cast
        let sheet = Solid::evaluate(&Shape::Sheet { sketch: Sketch::rect(1.0, 1.0) }).unwrap();
        assert_eq!(sheet.genus(), 0);
        assert!(sheet.contains([0.5, 0.5, 0.0]));
    }

    #[test]
    fn errors_and_edge_cases() {
        assert!(Solid::evaluate(&Shape::Box { size: [0.0; 3] }).is_err());
        let gone =
            Shape::Subtract { from: Box::new(Shape::Box { size: [1.0; 3] }), cut: vec![Shape::Box { size: [2.0; 3] }] };
        assert!(Solid::evaluate(&gone).unwrap_err().0.contains("empty"));
        let disjoint = Shape::Intersect {
            shapes: vec![
                Shape::Box { size: [1.0; 3] },
                Shape::Transform {
                    shape: Box::new(Shape::Box { size: [1.0; 3] }),
                    at: Affine3::translation([5.0, 0.0, 0.0]),
                },
            ],
        };
        assert!(Solid::evaluate(&disjoint).is_err());
        let s = Solid::evaluate(&Shape::Box { size: [1.0; 3] }).unwrap();
        assert!(!s.triangles().tag_of(0).is_empty());
        assert_eq!(tri_normal([0.0; 3], [0.0; 3], [0.0; 3]), [0.0; 3]);
        assert_eq!(box_tag([0.0, -1.0, 0.0]), "ymin");
        assert_eq!(box_tag([0.0, 0.0, -1.0]), "zmin");
        assert_eq!(cylinder_tag([0.0, 0.0, -1.0]), "bottom");
        assert_eq!(join("", "t"), "t");
        assert_eq!(join("p", "t"), "p.t");
        let tri = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        assert!((point_triangle_distance([0.2, 0.2, 0.5], &tri) - 0.5).abs() < 1e-12);
        assert!((point_triangle_distance([2.0, 0.0, 0.0], &tri) - 1.0).abs() < 1e-12);
        assert!((point_triangle_distance([-1.0, -1.0, 0.0], &tri) - libm::sqrt(2.0)).abs() < 1e-12);
        assert_eq!(point_segment_distance3([0.0, 1.0, 0.0], [0.0; 3], [0.0; 3]), 1.0);
        let mut leaf = LeafFaces::default();
        leaf.tris.push(tri);
        leaf.normals.push([0.0, 0.0, 1.0]);
        leaf.tags.push("t".into());
        leaf.tris.push([[5.0, 0.0, 0.0], [5.0, 1.0, 0.0], [5.0, 0.0, 1.0]]);
        leaf.normals.push([1.0, 0.0, 0.0]);
        leaf.tags.push("side".into());
        assert_eq!(leaf.tag_at([0.1, 0.1, 0.0], [0.0, 0.0, -1.0]), "t");
        assert_eq!(leaf.tag_at([5.0, 0.2, 0.2], [1.0, 0.0, 0.0]), "side");
        // no parallel triangle: nearest of any orientation
        assert_eq!(leaf.tag_at([5.0, 0.2, 0.2], [0.0, 1.0, 0.0]), "side");
        assert_eq!(leaf.tag_at([0.1, 0.1, 0.0], [0.0, 1.0, 0.0]), "t");
        // error propagation through every composite node of eval
        let bad = Shape::Sheet { sketch: Sketch::rect(1.0, 1.0) };
        let mut lv = Leaves::new();
        assert!(eval(&Shape::Union { shapes: vec![bad.clone()] }, "", &mut lv).is_err());
        assert!(eval(&Shape::Intersect { shapes: vec![bad.clone()] }, "", &mut lv).is_err());
        assert!(eval(&Shape::Subtract { from: Box::new(bad.clone()), cut: vec![] }, "", &mut lv).is_err());
        assert!(eval(
            &Shape::Subtract { from: Box::new(Shape::Box { size: [1.0; 3] }), cut: vec![bad.clone()] },
            "",
            &mut lv
        )
        .is_err());
        assert!(eval(&Shape::Transform { shape: Box::new(bad.clone()), at: Affine3::default() }, "", &mut lv).is_err());
        assert!(eval(&Shape::Named { name: "n".into(), shape: Box::new(bad.clone()) }, "", &mut lv).is_err());
        let two_lines = Sketch {
            outer: vec![Segment::Line { to: [1.0, 0.0], tag: None }, Segment::Line { to: [0.0, 0.0], tag: None }],
            holes: vec![],
        };
        assert!(eval(&Shape::Extrude { sketch: two_lines.clone(), height: 1.0 }, "", &mut lv).is_err());
        assert!(eval(&Shape::Revolve { sketch: two_lines.clone(), angle: 90.0, segments: None }, "", &mut lv).is_err());
        assert!(Solid::evaluate_solid(&Shape::Union { shapes: vec![bad.clone()] }).is_err());
        assert!(Solid::evaluate_sheet(&Shape::Sheet { sketch: two_lines }).unwrap_err().0.contains("three distinct"));
        let bad_arc = Sketch {
            outer: vec![
                Segment::Line { to: [2.0, 0.0], tag: None },
                Segment::Arc { center: [0.0, 0.0], to: [0.0, 1.0], ccw: true, tag: None },
                Segment::Line { to: [0.0, 0.0], tag: None },
            ],
            holes: vec![],
        };
        assert!(Solid::evaluate_sheet(&Shape::Sheet { sketch: bad_arc }).unwrap_err().0.contains("must be equal"));
        assert!(sketch_chord_tol(&Sketch::rect(2.0, 2.0), 4) > 0.0);
        // a mixed tree: named cut inside an unnamed union
        let tree = Shape::Union {
            shapes: vec![
                Shape::Box { size: [1.0; 3] },
                Shape::Named {
                    name: "b2".into(),
                    shape: Box::new(Shape::Transform {
                        shape: Box::new(Shape::Box { size: [1.0; 3] }),
                        at: Affine3::translation([2.0, 0.0, 0.0]),
                    }),
                },
            ],
        };
        let t = Solid::evaluate(&tree).unwrap();
        assert!(tag_set(&t).contains("b2.xmin") && tag_set(&t).contains("xmin"));
        assert!((t.volume() - 2.0).abs() < 1e-12);
        // revolve_tag falls back to the nearest edge for a centroid on the axis
        let l = Sketch::rect(1.0, 1.0).loops(0.01).unwrap();
        assert_eq!(revolve_tag(&l, 90.0, [0.0, 0.0, 0.5], [0.0, 1.0, 0.0]), "theta0");
        assert_eq!(revolve_tag(&l, 90.0, [0.0, 0.0, 0.5], [0.0, 0.0, 1.0]), "xmin");
        // a cap centroid at negative angle wraps to 315° → theta1
        let c = [1.0, -1.0, 0.5];
        let t = [1.0 / libm::sqrt(2.0), 1.0 / libm::sqrt(2.0), 0.0];
        assert_eq!(revolve_tag(&l, 90.0, c, t), "theta1");
        assert!(eval(&Shape::Sheet { sketch: Sketch::rect(1.0, 1.0) }, "", &mut Leaves::new()).is_err());
    }
}
