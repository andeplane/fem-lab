//! The free tet mesher: isosurface stuffing of an arbitrary CSG `Solid` (Labelle & Shewchuk,
//! *Isosurface Stuffing: Fast Tetrahedral Meshes with Good Dihedral Angles*, SIGGRAPH 2007).
//!
//! Unstructured, and unlike the lattice mesher not stair-stepped: a body-centred cubic lattice
//! of background tetrahedra is cut against the exact solid, so every boundary node lies on the
//! true surface and a cylinder comes out round rather than blocky. Two things the crate already
//! owns do the expensive work. [`Solid::contains`] is an exact analytic inside/outside oracle on
//! the shape tree, so no distance field or octree is needed; [`Solid::triangles`] is a
//! watertight, per-triangle *tagged* boundary, so the named CSG faces become face Sets through
//! [`crate::mesher::tag::Tagger`], exactly as they do for the lattice.
//!
//! ## What it guarantees, and what it does not
//!
//! Every emitted tetrahedron is positively oriented, and the warping pass keeps every cut point
//! at least `α · |edge|` away from the lattice vertex it was cut from, which is what stops the
//! stencils emitting slivers. The dihedral-angle bound is a *measured* gate on a box, a
//! cylinder, a sphere and a box minus a cylinder in `crates/geometry/tests/mesh.rs`, not a claim
//! made here.
//!
//! A sharp CSG edge falling between two lattice crossings is **chamfered by up to one element
//! size**: the mesher learns the surface only where a lattice edge crosses it. Prismatic
//! geometry belongs in the mapped or sweep mesher, which are exact. ADR 0020 has the reasoning.
//!
//! ponytail: one single-threaded sweep. The sign pass and the cut pass are embarrassingly
//! parallel — route them through `crates/engine/src/par.rs` if a profile ever shows them.

use std::collections::BTreeMap;

use crate::mesh::{ElementBlock, ElementKind, Face, Mesh};
use crate::mesher::tag::{distance2, Tagger};
use crate::predicate::face_centroid_normal;
use crate::solid::Solid;
use crate::GeomError;

/// Warp threshold on a lattice axis edge, of length `h` (Labelle & Shewchuk, Table 1).
const ALPHA_LONG: f64 = 0.24999;
/// Warp threshold on a lattice diagonal edge, of length `h·√3/2` (the same table).
const ALPHA_SHORT: f64 = 0.40173;
/// Length of a lattice diagonal in units of `h`.
const DIAGONAL: f64 = 0.866_025_403_784_438_6;
/// Bisections placing a cut on a lattice edge; `2⁻⁵⁰` of an element is below any tolerance.
const BISECTIONS: usize = 50;
/// A tetrahedron below this fraction of `h³` is a remnant of a warp and is dropped.
const DEGENERATE: f64 = 1e-12;
/// Meshed volume this far from the Solid's own means the lattice cannot see the body.
const VOLUME_DRIFT: f64 = 0.2;
/// A tet10 mid-edge node moves at most this fraction of its edge onto a curved face.
const MAX_MID_MOVE: f64 = 0.25;

/// Where a lattice vertex sits relative to the Solid.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Sign {
    /// Outside the body.
    Out,
    /// Warped onto the surface, so it bounds the body without being strictly inside.
    On,
    /// Strictly inside the body.
    In,
}

/// Fill a 3D `Solid` with unstructured tetrahedra of about `size`, tet10 when `quadratic`.
///
/// `max_elements` caps the background lattice, checked before anything is allocated. Refuses,
/// rather than panicking or shipping a bad mesh, when the size is not a positive finite length,
/// the Solid is a 2D sheet, the lattice would exceed that cap, no lattice vertex lands inside
/// the body, or the meshed volume drifts from the Solid's own by more than 20 %.
pub fn tet(solid: &Solid, size: f64, quadratic: bool, max_elements: usize) -> Result<Mesh, GeomError> {
    if !(size > 0.0 && size.is_finite()) {
        return Err(GeomError(format!("the tet mesher needs a positive, finite element size, got {size}")));
    }
    if solid.dim() != 3 {
        return Err(GeomError("the tet mesher meshes 3D solids; use the free mesher for a sheet".into()));
    }
    let (lo, hi) = solid.bbox();
    // One cell of padding on every side, so the background tetrahedra the mesher cannot build
    // (those missing a body centre) lie strictly outside the body. Counting in f64 first keeps
    // a body that is enormous against its element size an error rather than an overflow.
    let mut counts = [0.0f64; 3];
    let mut estimate = 12.0f64;
    for a in 0..3 {
        counts[a] = libm::ceil((hi[a] - lo[a]) / size).max(1.0) + 2.0;
        estimate *= counts[a];
    }
    if estimate > max_elements as f64 {
        return Err(GeomError(format!(
            "an element size of {size} needs about {} background tetrahedra, above the limit of {max_elements}; \
             use a larger element size or raise maxElements",
            estimate as u64
        )));
    }
    let cells = [counts[0] as usize, counts[1] as usize, counts[2] as usize];
    let mut stuff = Stuffing::new(solid, lo, size, cells);
    stuff.sign_lattice()?;
    stuff.cut_edges();
    stuff.warp();
    stuff.fill();
    stuff.finish(quadratic)
}

/// The background lattice, its signs and cuts, and the tetrahedra being emitted.
struct Stuffing<'a> {
    solid: &'a Solid,
    h: f64,
    /// Cells per axis; primal points are one more per axis, body centres exactly `cells`.
    cells: [usize; 3],
    /// Primal points, then body centres, then the cut points appended as they are found.
    coords: Vec<[f64; 3]>,
    sign: Vec<Sign>,
    /// Primal points plus body centres: the ids below this are the lattice's own.
    n_lattice: usize,
    /// The four vertices of every background tetrahedron.
    background: Vec<[u32; 4]>,
    /// Cut point per crossed lattice edge, keyed by its two vertices in ascending order.
    cuts: BTreeMap<(u32, u32), u32>,
    /// Emitted tetrahedra, four node ids each, positively oriented.
    conn: Vec<u32>,
    volume: f64,
}

impl<'a> Stuffing<'a> {
    /// Lay out the padded body-centred cubic lattice and its background tetrahedra.
    ///
    /// Each axis-aligned primal edge is ringed by four body centres; consecutive pairs of that
    /// ring close a tetrahedron with the edge, giving four per edge and twelve of volume `h³/12`
    /// per cell, which is exactly one cell, so the background tiles space.
    fn new(solid: &'a Solid, lo: [f64; 3], h: f64, cells: [usize; 3]) -> Stuffing<'a> {
        let origin = [lo[0] - h, lo[1] - h, lo[2] - h];
        let at = |c: [f64; 3]| [origin[0] + h * c[0], origin[1] + h * c[1], origin[2] + h * c[2]];
        let mut coords = Vec::new();
        for k in 0..=cells[2] {
            for j in 0..=cells[1] {
                for i in 0..=cells[0] {
                    coords.push(at([i as f64, j as f64, k as f64]));
                }
            }
        }
        for k in 0..cells[2] {
            for j in 0..cells[1] {
                for i in 0..cells[0] {
                    coords.push(at([i as f64 + 0.5, j as f64 + 0.5, k as f64 + 0.5]));
                }
            }
        }
        let n_lattice = coords.len();
        let mut s = Stuffing {
            solid,
            h,
            cells,
            coords,
            sign: Vec::new(),
            n_lattice,
            background: Vec::new(),
            cuts: BTreeMap::new(),
            conn: Vec::new(),
            volume: 0.0,
        };
        for a in 0..3 {
            let (u, v) = ((a + 1) % 3, (a + 2) % 3);
            for k in 0..=cells[2] {
                for j in 0..=cells[1] {
                    for i in 0..=cells[0] {
                        let p = [i, j, k];
                        if p[a] >= cells[a] {
                            continue;
                        }
                        let mut q = p;
                        q[a] += 1;
                        for r in 0..4 {
                            let (Some(c0), Some(c1)) = (s.ring(p, a, u, v, r), s.ring(p, a, u, v, (r + 1) % 4)) else {
                                continue;
                            };
                            s.background.push([s.primal(p), s.primal(q), c0, c1]);
                        }
                    }
                }
            }
        }
        s
    }

    fn primal(&self, p: [usize; 3]) -> u32 {
        ((p[2] * (self.cells[1] + 1) + p[1]) * (self.cells[0] + 1) + p[0]) as u32
    }

    fn centre(&self, c: [usize; 3]) -> u32 {
        let base = (self.cells[0] + 1) * (self.cells[1] + 1) * (self.cells[2] + 1);
        (base + (c[2] * self.cells[1] + c[1]) * self.cells[0] + c[0]) as u32
    }

    /// Body centre `r` of the four ringing the axis-`a` edge that leaves `p`, counted round the
    /// edge in the (u, v) plane; `None` when it falls outside the lattice.
    fn ring(&self, p: [usize; 3], a: usize, u: usize, v: usize, r: usize) -> Option<u32> {
        let step = [(1usize, 1usize), (0, 1), (0, 0), (1, 0)][r];
        let mut c = [0usize; 3];
        c[a] = p[a];
        c[u] = p[u].checked_sub(step.0)?;
        c[v] = p[v].checked_sub(step.1)?;
        if c[u] >= self.cells[u] || c[v] >= self.cells[v] {
            return None;
        }
        Some(self.centre(c))
    }

    /// Inside or outside at every lattice vertex. A body no lattice vertex lands inside is a
    /// body the mesher cannot see at this element size.
    fn sign_lattice(&mut self) -> Result<(), GeomError> {
        let solid = self.solid;
        let sign: Vec<Sign> =
            self.coords.iter().map(|&p| if solid.contains(p) { Sign::In } else { Sign::Out }).collect();
        self.sign = sign;
        if !self.sign.contains(&Sign::In) {
            return Err(GeomError(format!(
                "no lattice vertex of the {}×{}×{} background lattice is inside the body; use a smaller element size",
                self.cells[0], self.cells[1], self.cells[2]
            )));
        }
        Ok(())
    }

    /// Bisect `contains` on every background edge that changes sign. The cut is keyed by the
    /// edge, so every background tetrahedron on that edge sees one point and the output
    /// conforms.
    fn cut_edges(&mut self) {
        for i in 0..self.background.len() {
            let t = self.background[i];
            for &[a, b] in ElementKind::Tet4.edges() {
                let (a, b) = (t[a as usize], t[b as usize]);
                let key = (a.min(b), a.max(b));
                if (self.sign[a as usize] == Sign::In) == (self.sign[b as usize] == Sign::In)
                    || self.cuts.contains_key(&key)
                {
                    continue;
                }
                let (mut inside, mut outside) = if self.sign[a as usize] == Sign::In {
                    (self.coords[a as usize], self.coords[b as usize])
                } else {
                    (self.coords[b as usize], self.coords[a as usize])
                };
                for _ in 0..BISECTIONS {
                    let mid = midpoint(inside, outside);
                    if self.solid.contains(mid) {
                        inside = mid;
                    } else {
                        outside = mid;
                    }
                }
                let id = self.coords.len() as u32;
                self.coords.push(midpoint(inside, outside));
                self.sign.push(Sign::On);
                self.cuts.insert(key, id);
            }
        }
    }

    /// Move every lattice vertex that all but touches the surface onto it, and forget the cuts
    /// on its edges.
    ///
    /// This is the pass the angle bound comes from: afterwards no cut point is nearer a lattice
    /// vertex than `α · |edge|`, so no stencil can produce an arbitrarily thin sliver. Because
    /// both thresholds are below one half, the two ends of an edge can never warp to the same
    /// cut and collapse it.
    fn warp(&mut self) {
        let mut best: Vec<Option<(f64, u32)>> = vec![None; self.n_lattice];
        let mut incident: Vec<Vec<(u32, u32)>> = vec![Vec::new(); self.n_lattice];
        for (&(a, b), &cut) in &self.cuts {
            // Exactly one primal end means a lattice diagonal, of length h·√3/2; both ends
            // primal, or both body centres, is an axis edge of length h.
            let diagonal = ((a as usize) < self.n_primal()) != ((b as usize) < self.n_primal());
            let limit = if diagonal { ALPHA_SHORT * self.h * DIAGONAL } else { ALPHA_LONG * self.h };
            for v in [a, b] {
                incident[v as usize].push((a, b));
                let d = libm::sqrt(distance2(self.coords[v as usize], self.coords[cut as usize]));
                if d <= limit && best[v as usize].is_none_or(|(near, _)| d < near) {
                    best[v as usize] = Some((d, cut));
                }
            }
        }
        let mut warped: Vec<u32> = Vec::new();
        for (v, b) in best.iter().enumerate().take(self.n_lattice) {
            if let Some((_, cut)) = *b {
                self.coords[v] = self.coords[cut as usize];
                self.sign[v] = Sign::On;
                warped.push(v as u32);
            }
        }
        for v in warped {
            for key in std::mem::take(&mut incident[v as usize]) {
                self.cuts.remove(&key);
            }
        }
    }

    fn n_primal(&self) -> usize {
        (self.cells[0] + 1) * (self.cells[1] + 1) * (self.cells[2] + 1)
    }

    /// Emit the part of every background tetrahedron that is inside the body.
    fn fill(&mut self) {
        for i in 0..self.background.len() {
            self.stencil(self.background[i]);
        }
    }

    /// The part of one background tetrahedron that is inside the body.
    ///
    /// A vertex on the surface counts as kept, so the region is the hull of the kept vertices
    /// and the cuts on the edges leaving them. A tetrahedron with no vertex strictly inside
    /// contributes nothing: it lies outside, or on a skin thinner than one element, which is
    /// the feature size this mesher cannot resolve.
    fn stencil(&mut self, t: [u32; 4]) {
        if !t.iter().any(|&v| self.sign[v as usize] == Sign::In) {
            return;
        }
        let kept: Vec<u32> = t.iter().copied().filter(|&v| self.sign[v as usize] != Sign::Out).collect();
        let out: Vec<u32> = t.iter().copied().filter(|&v| self.sign[v as usize] == Sign::Out).collect();
        match out.len() {
            0 => self.emit([t[0], t[1], t[2], t[3]]),
            1 => {
                let d = out[0];
                let bot = [self.crossing(kept[0], d), self.crossing(kept[1], d), self.crossing(kept[2], d)];
                self.prism([kept[0], kept[1], kept[2]], bot);
            }
            2 => {
                let (a, b) = (kept[0], kept[1]);
                let top = [a, self.crossing(a, out[0]), self.crossing(a, out[1])];
                let bot = [b, self.crossing(b, out[0]), self.crossing(b, out[1])];
                self.prism(top, bot);
            }
            _ => {
                let a = kept[0];
                let (x, y, z) = (self.crossing(a, out[0]), self.crossing(a, out[1]), self.crossing(a, out[2]));
                self.emit([a, x, y, z]);
            }
        }
    }

    /// Where the surface crosses the edge from a kept vertex to an outside one: the stored cut,
    /// or the kept vertex itself when it was warped onto the surface and its cut forgotten.
    fn crossing(&self, kept: u32, out: u32) -> u32 {
        self.cuts.get(&(kept.min(out), kept.max(out))).copied().unwrap_or(kept)
    }

    /// A triangular prism, as its two triangles and three quadrilaterals, coned from its
    /// lowest-numbered vertex.
    ///
    /// Both the apex and every quadrilateral's diagonal come from global node ids alone, so the
    /// background tetrahedron on the far side of a shared face splits that face identically and
    /// the mesh conforms. A prism whose two triangles share a vertex — what a warp leaves
    /// behind — degenerates to a tetrahedron or to nothing, which is exactly right.
    fn prism(&mut self, top: [u32; 3], bot: [u32; 3]) {
        let apex = top.iter().chain(bot.iter()).copied().fold(u32::MAX, u32::min);
        let faces: [Vec<u32>; 5] = [
            vec![top[0], top[1], top[2]],
            vec![bot[0], bot[1], bot[2]],
            vec![top[0], top[1], bot[1], bot[0]],
            vec![top[1], top[2], bot[2], bot[1]],
            vec![top[2], top[0], bot[0], bot[2]],
        ];
        for face in faces {
            let poly = dedup_cycle(&face);
            if poly.contains(&apex) {
                continue;
            }
            for tri in triangulate(&poly) {
                self.emit([apex, tri[0], tri[1], tri[2]]);
            }
        }
    }

    /// Emit one tetrahedron, ordered so `det J > 0`, unless a warp collapsed it to nothing.
    fn emit(&mut self, n: [u32; 4]) {
        let x = n.map(|i| self.coords[i as usize]);
        let det = det3(sub(x[1], x[0]), sub(x[2], x[0]), sub(x[3], x[0]));
        if det.abs() < DEGENERATE * self.h * self.h * self.h {
            return;
        }
        self.volume += det.abs() / 6.0;
        if det > 0.0 {
            self.conn.extend_from_slice(&n);
        } else {
            self.conn.extend_from_slice(&[n[0], n[2], n[1], n[3]]);
        }
    }

    /// Check the meshed volume against the Solid's own, drop the unused lattice vertices,
    /// renumber, and name the boundary faces after the Solid's faces.
    fn finish(self, quadratic: bool) -> Result<Mesh, GeomError> {
        let reference = self.solid.volume();
        if (self.volume - reference).abs() > VOLUME_DRIFT * reference {
            return Err(GeomError(format!(
                "the meshed volume {:e} m³ differs from the body's own {:e} m³ by more than {} %; \
                 the element size cannot resolve this body",
                self.volume,
                reference,
                VOLUME_DRIFT * 100.0
            )));
        }
        let mut ids = vec![u32::MAX; self.coords.len()];
        let mut coords = Vec::new();
        for &n in &self.conn {
            if ids[n as usize] == u32::MAX {
                ids[n as usize] = (coords.len() / 3) as u32;
                coords.extend_from_slice(&self.coords[n as usize]);
            }
        }
        let conn: Vec<u32> = self.conn.iter().map(|&n| ids[n as usize]).collect();
        let n_elems = (conn.len() / 4) as u32;
        let mut mesh = Mesh {
            dim: 3,
            coords,
            blocks: vec![ElementBlock { kind: ElementKind::Tet4, conn, first_elem: 0 }],
            node_sets: BTreeMap::new(),
            elem_sets: BTreeMap::from([("all".to_string(), (0..n_elems).collect())]),
            face_sets: BTreeMap::new(),
        };
        if quadratic {
            mesh = to_tet10(mesh, self.solid);
        }
        let tagger = Tagger::new(self.solid);
        let mut face_sets: BTreeMap<String, Vec<Face>> = BTreeMap::new();
        for face in mesh.boundary_faces() {
            let (centroid, normal) = face_centroid_normal(&mesh, face);
            // A boundary face the Solid has no face for (nothing within 45°) joins no auto Set.
            if let Some(tag) = tagger.nearest(centroid, normal) {
                face_sets.entry(tag.to_string()).or_default().push(face);
            }
        }
        for set in face_sets.values_mut() {
            set.sort_unstable();
        }
        mesh.face_sets = face_sets;
        Ok(mesh)
    }
}

/// Raise a tet4 mesh to tet10, projecting the mid-edge node of every boundary edge onto the
/// Solid so a curved face is second order rather than a chord.
///
/// The corner nodes of a boundary face already lie on the surface — they are cut points or
/// warped lattice vertices — so the straight midpoint is off it by the sagitta and no more. The
/// search marches along the averaged boundary normal and refuses to move a node more than a
/// quarter of its edge, which is what keeps the element from folding.
fn to_tet10(m: Mesh, solid: &Solid) -> Mesh {
    let mut normals: BTreeMap<(u32, u32), [f64; 3]> = BTreeMap::new();
    for face in m.boundary_faces() {
        let (_, n) = face_centroid_normal(&m, face);
        let c: Vec<u32> = m.face_nodes(face).take(3).collect();
        for k in 0..3 {
            let (a, b) = (c[k], c[(k + 1) % 3]);
            let e = normals.entry((a.min(b), a.max(b))).or_insert([0.0; 3]);
            for (t, x) in e.iter_mut().enumerate() {
                *x += n[t];
            }
        }
    }
    let mut coords = m.coords.clone();
    let mut mid: BTreeMap<(u32, u32), u32> = BTreeMap::new();
    let mut conn = Vec::new();
    for e in m.blocks[0].conn.chunks_exact(4) {
        conn.extend_from_slice(e);
        for &[a, b] in ElementKind::Tet4.edges() {
            let (p, q) = (e[a as usize], e[b as usize]);
            let key = (p.min(q), p.max(q));
            let id = match mid.get(&key) {
                Some(&id) => id,
                None => {
                    let straight = midpoint(m.node(p), m.node(q));
                    let x = match normals.get(&key) {
                        Some(&n) => project(solid, straight, n, libm::sqrt(distance2(m.node(p), m.node(q)))),
                        None => straight,
                    };
                    let id = (coords.len() / 3) as u32;
                    coords.extend_from_slice(&x);
                    mid.insert(key, id);
                    id
                }
            };
            conn.push(id);
        }
    }
    Mesh {
        dim: 3,
        coords,
        blocks: vec![ElementBlock { kind: ElementKind::Tet10, conn, first_elem: 0 }],
        node_sets: m.node_sets,
        elem_sets: m.elem_sets,
        face_sets: m.face_sets,
    }
}

/// Slide `x` along `±n` onto the surface, by at most `MAX_MID_MOVE · length`. `x` is returned
/// unchanged when no crossing lies in that window: the guard against folding an element over a
/// feature sharper than the element, and what a face whose normals cancel falls back on.
fn project(solid: &Solid, x: [f64; 3], n: [f64; 3], length: f64) -> [f64; 3] {
    let len = libm::sqrt(distance2(n, [0.0; 3])).max(f64::MIN_POSITIVE);
    let dir = [n[0] / len, n[1] / len, n[2] / len];
    let here = solid.contains(x);
    // Outward when the midpoint sank inside a convex face, inward when it bulged out of a
    // concave one. Either way the surface is the first sign change.
    let sense = if here { 1.0 } else { -1.0 };
    let step = sense * MAX_MID_MOVE * length / 8.0;
    let mut lo = 0.0;
    let mut hi = 0.0;
    for i in 1..=8 {
        let t = step * i as f64;
        if solid.contains(along(x, dir, t)) != here {
            hi = t;
            break;
        }
        lo = t;
    }
    if hi == 0.0 {
        return x;
    }
    for _ in 0..BISECTIONS {
        let m = 0.5 * (lo + hi);
        if solid.contains(along(x, dir, m)) == here {
            lo = m;
        } else {
            hi = m;
        }
    }
    along(x, dir, 0.5 * (lo + hi))
}

fn along(x: [f64; 3], dir: [f64; 3], t: f64) -> [f64; 3] {
    [x[0] + t * dir[0], x[1] + t * dir[1], x[2] + t * dir[2]]
}

/// The cycle with consecutive repeats removed: a quadrilateral one corner of which was warped
/// onto its own cut point is a triangle, and one with two is nothing at all.
fn dedup_cycle(face: &[u32]) -> Vec<u32> {
    let n = face.len();
    face.iter().enumerate().filter(|&(i, &v)| face[(i + n - 1) % n] != v).map(|(_, &v)| v).collect()
}

/// Triangles of a polygon of three or four corners; the quadrilateral's diagonal runs from its
/// lowest-numbered corner, which both sides of a shared face compute alike.
fn triangulate(poly: &[u32]) -> Vec<[u32; 3]> {
    match poly.len() {
        3 => vec![[poly[0], poly[1], poly[2]]],
        4 => {
            let m = (0..4).fold(0usize, |best, i| if poly[i] < poly[best] { i } else { best });
            vec![[poly[m], poly[(m + 1) % 4], poly[(m + 2) % 4]], [poly[m], poly[(m + 2) % 4], poly[(m + 3) % 4]]]
        }
        _ => Vec::new(),
    }
}

fn midpoint(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1]), 0.5 * (a[2] + b[2])]
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn det3(u: [f64; 3], v: [f64; 3], w: [f64; 3]) -> f64 {
    u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0])
}
