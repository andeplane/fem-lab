//! Mapped (transfinite) quad blocks: the v1 workhorse mesher (C §2.7).
//!
//! A [`QuadBlock`] is four corners, four edge [`Curve`]s, a division count and a geometric
//! grading ratio per direction, and an optional face-set tag per edge. Its unit square is
//! mapped by a Coons patch and handed to [`Structured::build`], so mid-edge nodes of a
//! quadratic kind land on the curve rather than on its chord. Several blocks merge into one
//! Mesh by coordinate quantisation; a shared edge that the two blocks divide differently is an
//! error naming both blocks, never a silently non-conforming mesh.

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::mesh::{ElementBlock, ElementKind, Face, Mesh};
use crate::mesher::structured::Structured;
use crate::sketch::arc_sweep;
use crate::GeomError;

/// The shape of one block edge between its two corners.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Curve {
    /// The straight segment between the corners.
    Line,
    /// The circular arc about `center`, counter-clockwise when `ccw`. Both corners must lie at
    /// the same distance from `center`.
    Arc { center: [f64; 2], ccw: bool },
    /// The arc of the axis-aligned ellipse `((x - cx)/a)² + ((y - cy)/b)² = 1` between the
    /// corners' parametric angles, the short way round. Both corners must lie on the ellipse.
    Ellipse { center: [f64; 2], semi_axes: [f64; 2] },
}

/// One mapped block: a curvilinear quadrilateral meshed as a structured grid.
///
/// `corners` are `c0..c3` counter-clockwise; the block's `(u, v)` unit square maps `c0 → c1`
/// along u and `c0 → c3` along v. Edge `k` joins `c_k → c_{k+1}` (edges 0 and 2 run along u,
/// 1 and 3 along v). `n` is the division count along u and v, `grading` the geometric ratio
/// between successive spacings along each (1.0 uniform; > 1 packs nodes toward the u = 0 /
/// v = 0 side). `tags` names the face set each edge contributes to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuadBlock {
    pub corners: [[f64; 2]; 4],
    pub edges: [Curve; 4],
    pub n: [usize; 2],
    pub grading: [f64; 2],
    pub tags: [Option<String>; 4],
}

/// The face set `Structured::build` gives each of the four block edges.
const EDGE_SETS: [&str; 4] = ["ymin", "xmax", "ymax", "xmin"];

/// Nodes closer than this fraction of the bounding-box diagonal are the same node.
const MERGE_TOL: f64 = 1e-9;

/// A curve ready to evaluate: `point(t)` is the position at fraction `t` from `c_k` to `c_{k+1}`.
enum EdgeMap {
    Line { a: [f64; 2], b: [f64; 2] },
    Angular { c: [f64; 2], ab: [f64; 2], a0: f64, sweep: f64 },
}

impl EdgeMap {
    fn point(&self, t: f64) -> [f64; 2] {
        match *self {
            EdgeMap::Line { a, b } => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
            EdgeMap::Angular { c, ab, a0, sweep } => {
                let a = a0 + t * sweep;
                [c[0] + ab[0] * libm::cos(a), c[1] + ab[1] * libm::sin(a)]
            }
        }
    }
}

/// The parametric angle of `p` on the ellipse about `c` with semi-axes `ab`.
fn ellipse_angle(p: [f64; 2], c: [f64; 2], ab: [f64; 2]) -> f64 {
    libm::atan2((p[1] - c[1]) / ab[1], (p[0] - c[0]) / ab[0])
}

fn edge_map(curve: &Curve, from: [f64; 2], to: [f64; 2], k: usize) -> Result<EdgeMap, GeomError> {
    match curve {
        Curve::Line => Ok(EdgeMap::Line { a: from, b: to }),
        Curve::Arc { center, ccw } => {
            let r0 = libm::hypot(from[0] - center[0], from[1] - center[1]);
            let r1 = libm::hypot(to[0] - center[0], to[1] - center[1]);
            if r0 <= 0.0 || (r0 - r1).abs() > 1e-9 * r0 {
                return Err(GeomError(format!(
                    "edge {k} is an arc about ({}, {}) but its corners are at radius {r0} and {r1}; \
                     they must be equal",
                    center[0], center[1]
                )));
            }
            let a0 = libm::atan2(from[1] - center[1], from[0] - center[0]);
            Ok(EdgeMap::Angular { c: *center, ab: [r0, r0], a0, sweep: arc_sweep(from, *center, to, *ccw) })
        }
        Curve::Ellipse { center, semi_axes } => {
            if semi_axes[0] <= 0.0 || semi_axes[1] <= 0.0 {
                return Err(GeomError(format!(
                    "edge {k} is an ellipse with semi-axes ({}, {}); both must be positive",
                    semi_axes[0], semi_axes[1]
                )));
            }
            for p in [from, to] {
                let e = ((p[0] - center[0]) / semi_axes[0]).powi(2) + ((p[1] - center[1]) / semi_axes[1]).powi(2);
                if (e - 1.0).abs() > 1e-9 {
                    return Err(GeomError(format!(
                        "edge {k} is an ellipse with semi-axes ({}, {}) about ({}, {}) but its corner \
                         ({}, {}) is not on it",
                        semi_axes[0], semi_axes[1], center[0], center[1], p[0], p[1]
                    )));
                }
            }
            let a0 = ellipse_angle(from, *center, *semi_axes);
            let a1 = ellipse_angle(to, *center, *semi_axes);
            // the short way round: the difference wrapped into (-pi, pi]
            let mut d = a1 - a0;
            let tau = std::f64::consts::TAU;
            while d <= -std::f64::consts::PI {
                d += tau;
            }
            while d > std::f64::consts::PI {
                d -= tau;
            }
            Ok(EdgeMap::Angular { c: *center, ab: *semi_axes, a0, sweep: d })
        }
    }
}

/// Node parameters on the half grid of `n` cells with geometric ratio `r`.
///
/// The integer nodes are `u_i = (1 − r^i)/(1 − r^n)` (`i/n` when `r = 1`); a quadratic kind's
/// half nodes (`s = 2`) sit at the mean of their neighbours, so a mid-edge node is halfway
/// along the edge curve between its corners.
fn params(n: usize, r: f64, s: usize) -> Vec<f64> {
    let u: Vec<f64> = if (r - 1.0).abs() < 1e-12 {
        (0..=n).map(|i| i as f64 / n as f64).collect()
    } else {
        let d = 1.0 - libm::pow(r, n as f64);
        (0..=n).map(|i| (1.0 - libm::pow(r, i as f64)) / d).collect()
    };
    let mut out = Vec::with_capacity(s * n + 1);
    for i in 0..n {
        out.push(u[i]);
        if s == 2 {
            out.push(0.5 * (u[i] + u[i + 1]));
        }
    }
    out.push(u[n]);
    out
}

impl QuadBlock {
    /// The block's own structured mesh, before any multi-block merge.
    fn build(&self, kind: ElementKind, s: usize) -> Result<Mesh, GeomError> {
        if self.n[0] == 0 || self.n[1] == 0 {
            return Err(GeomError(format!("divisions are [{}, {}]; both must be at least 1", self.n[0], self.n[1])));
        }
        for (a, &r) in self.grading.iter().enumerate() {
            if !(r.is_finite() && r > 0.0) {
                return Err(GeomError(format!(
                    "grading[{a}] is {r}; the geometric ratio must be finite and positive (1.0 is uniform)"
                )));
            }
        }
        let scale = self.corners.iter().fold(0.0f64, |m, p| m.max(libm::hypot(p[0], p[1]))).max(1.0);
        let mut maps = Vec::with_capacity(4);
        for k in 0..4 {
            let (from, to) = (self.corners[k], self.corners[(k + 1) % 4]);
            if libm::hypot(to[0] - from[0], to[1] - from[1]) < 1e-12 * scale {
                return Err(GeomError(format!(
                    "corners {k} and {} are both at ({}, {}); a block needs four distinct corners",
                    (k + 1) % 4,
                    from[0],
                    from[1]
                )));
            }
            maps.push(edge_map(&self.edges[k], from, to, k)?);
        }
        let pu = params(self.n[0], self.grading[0], s);
        let pv = params(self.n[1], self.grading[1], s);
        let c = &self.corners;
        Ok(Structured { kind, n: [self.n[0], self.n[1], 1] }.build(|p| {
            let u = pu[(p[0] * (s * self.n[0]) as f64).round() as usize];
            let v = pv[(p[1] * (s * self.n[1]) as f64).round() as usize];
            let (e0, e1) = (maps[0].point(u), maps[1].point(v));
            let (e2, e3) = (maps[2].point(1.0 - u), maps[3].point(1.0 - v));
            let mut x = [0.0; 3];
            for a in 0..2 {
                x[a] = (1.0 - v) * e0[a] + u * e1[a] + v * e2[a] + (1.0 - u) * e3[a]
                    - ((1.0 - u) * (1.0 - v) * c[0][a]
                        + u * (1.0 - v) * c[1][a]
                        + u * v * c[2][a]
                        + (1.0 - u) * v * c[3][a]);
            }
            x
        }))
    }
}

/// Merges nodes that land in the same (or an adjacent) cell of a grid of side `q`.
///
/// ponytail: one node per cell and a 3×3 probe, so two blocks that compute a shared point with
/// different rounding still merge whichever side of a cell wall they fall on. The price is
/// that distinct nodes closer than 3q — three parts in a billion of the model — also merge.
struct Merger {
    q: f64,
    index: BTreeMap<[i64; 2], u32>,
    coords: Vec<f64>,
}

impl Merger {
    fn insert(&mut self, p: [f64; 2]) -> u32 {
        let k = [libm::round(p[0] / self.q) as i64, libm::round(p[1] / self.q) as i64];
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(&id) = self.index.get(&[k[0] + dx, k[1] + dy]) {
                    return id;
                }
            }
        }
        let id = (self.coords.len() / 3) as u32;
        self.coords.extend_from_slice(&[p[0], p[1], 0.0]);
        self.index.insert(k, id);
        id
    }
}

/// Mesh one or more [`QuadBlock`]s into a single 2D Mesh of `kind` (quad4, quad8, tri3, tri6).
///
/// Blocks are meshed independently and merged: nodes within `1e-9` of the model's bounding-box
/// diagonal are one node, so blocks that share an edge share its nodes. Two blocks that share
/// an edge but divide or grade it differently are an error naming both. Every tagged edge that
/// is still on the boundary after the merge becomes the face set of its tag; the element set
/// `all` holds every element.
pub fn mapped(blocks: &[QuadBlock], kind: ElementKind) -> Result<Mesh, GeomError> {
    if kind.dim() != 2 || kind == ElementKind::Shell4 {
        return Err(GeomError(format!("the mapped mesher makes 2D elements, not {kind:?}")));
    }
    if blocks.is_empty() {
        return Err(GeomError("a mapped mesh needs at least one block".into()));
    }
    let s = if kind.n_nodes() > kind.n_corners() { 2 } else { 1 };
    let mut parts = Vec::with_capacity(blocks.len());
    for (b, block) in blocks.iter().enumerate() {
        parts.push(block.build(kind, s).map_err(|e| GeomError(format!("block {b}: {}", e.0)))?);
    }

    let mut lo = [f64::INFINITY; 2];
    let mut hi = [f64::NEG_INFINITY; 2];
    for p in parts.iter().flat_map(|m| m.coords.chunks_exact(3)) {
        for a in 0..2 {
            lo[a] = lo[a].min(p[a]);
            hi[a] = hi[a].max(p[a]);
        }
    }
    let diag = libm::hypot(hi[0] - lo[0], hi[1] - lo[1]);
    let mut merger = Merger { q: MERGE_TOL * diag, index: BTreeMap::new(), coords: Vec::new() };

    let mut conn = Vec::new();
    let mut tagged: BTreeMap<String, Vec<Face>> = BTreeMap::new();
    // Per block, per edge: the merged ids of its end points and of every node along it.
    let mut edges: Vec<[([u32; 2], Vec<u32>); 4]> = Vec::new();
    let mut elem_offset = 0u32;
    for (b, part) in parts.iter().enumerate() {
        let ids: Vec<u32> = part.coords.chunks_exact(3).map(|p| merger.insert([p[0], p[1]])).collect();
        for blk in &part.blocks {
            conn.extend(blk.conn.iter().map(|&n| ids[n as usize]));
        }
        for (k, tag) in blocks[b].tags.iter().enumerate() {
            if let Some(name) = tag {
                let faces = tagged.entry(name.clone()).or_default();
                faces.extend(
                    part.face_sets[EDGE_SETS[k]].iter().map(|f| Face { elem: f.elem + elem_offset, local: f.local }),
                );
            }
        }
        let node_set =
            |name: &str| -> BTreeSet<u32> { part.node_sets[name].iter().map(|&n| ids[n as usize]).collect() };
        let (xmin, xmax, ymin, ymax) = (node_set("xmin"), node_set("xmax"), node_set("ymin"), node_set("ymax"));
        let along = [&ymin, &xmax, &ymax, &xmin];
        let corner = |a: &BTreeSet<u32>, b: &BTreeSet<u32>| *a.intersection(b).next().expect("a block has corners");
        let cs = [corner(&xmin, &ymin), corner(&xmax, &ymin), corner(&xmax, &ymax), corner(&xmin, &ymax)];
        edges.push(std::array::from_fn(|k| {
            let (p, q) = (cs[k], cs[(k + 1) % 4]);
            ([p.min(q), p.max(q)], along[k].iter().copied().collect())
        }));
        elem_offset += part.n_elems() as u32;
    }

    let mut seen: BTreeMap<[u32; 2], (usize, usize, Vec<u32>)> = BTreeMap::new();
    for (b, block_edges) in edges.iter().enumerate() {
        for (k, (ends, nodes)) in block_edges.iter().enumerate() {
            match seen.get(ends) {
                Some((ob, ok, other)) if other != nodes => {
                    let at = |n: u32| &merger.coords[3 * n as usize..3 * n as usize + 2];
                    let (p, q) = (at(ends[0]), at(ends[1]));
                    let (na, nb) = (other.len(), nodes.len());
                    let why = if na == nb {
                        "their node spacings differ; give the two edges the same grading"
                    } else {
                        "they divide it differently; give the two edges the same division count"
                    };
                    return Err(GeomError(format!(
                        "block {ob} edge {ok} and block {b} edge {k} share the edge from ({}, {}) to ({}, {}) \
                         with {na} and {nb} nodes: {why}",
                        p[0], p[1], q[0], q[1]
                    )));
                }
                Some(_) => {}
                None => {
                    seen.insert(*ends, (b, k, nodes.clone()));
                }
            }
        }
    }

    let mut mesh = Mesh {
        dim: 2,
        coords: merger.coords,
        blocks: vec![ElementBlock { kind, conn, first_elem: 0 }],
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::from([("all".to_string(), (0..elem_offset).collect())]),
        face_sets: BTreeMap::new(),
    };
    let boundary: BTreeSet<Face> = mesh.boundary_faces().into_iter().collect();
    for (name, mut faces) in tagged {
        faces.retain(|f| boundary.contains(f));
        faces.sort_unstable();
        if !faces.is_empty() {
            mesh.face_sets.insert(name, faces);
        }
    }
    Ok(mesh)
}
