//! The lattice mesher: an axis-aligned grid over a Solid's bounding box, keeping every cell
//! whose centre is inside the Solid (C §2.7 "Lattice").
//!
//! Exact for lattice-aligned boxes — the kept cells tile the body with no gap and no overhang —
//! and stair-stepped for anything curved, which is what a lattice is for. A boundary cell face
//! that lies on a bounding-box plane is tagged `xmin … zmax`; any other boundary face inherits
//! the tag of the nearest Solid face (C §2.4), so a cut's walls keep the cut's names.

use std::collections::BTreeMap;

use crate::mesh::{ElementBlock, ElementKind, Face, Mesh};
use crate::mesher::structured::{CORNERS, FACE_LOCAL_2D, FACE_LOCAL_3D, SET_NAMES};
use crate::predicate::face_centroid_normal;
use crate::solid::Solid;
use crate::GeomError;

/// A boundary face inherits a Solid face's tag only if their normals agree within 45°.
const TAG_COS: f64 = std::f64::consts::FRAC_1_SQRT_2;

/// Mesh a Solid with an axis-aligned lattice of `counts` cells (or of `ceil(extent / size)`
/// cells, at least one) per axis, keeping the cells whose centre is inside.
///
/// 3D Solids give hex8, or hex20 with edge-midpoint nodes when `quadratic`; 2D sheets give
/// quad4 / quad8 in the xy plane. Nodes are shared between cells and numbered contiguously in
/// grid order. Face sets are the auto Sets of C §2.4; the element set `all` holds every element.
pub fn lattice(solid: &Solid, size: Option<f64>, counts: Option<[u32; 3]>, quadratic: bool) -> Result<Mesh, GeomError> {
    let dim = solid.dim();
    let (lo, hi) = solid.bbox();
    let cells = cell_counts(lo, hi, size, counts, dim)?;
    let kind = match (dim, quadratic) {
        (3, false) => ElementKind::Hex8,
        (3, true) => ElementKind::Hex20,
        (_, false) => ElementKind::Quad4,
        (_, true) => ElementKind::Quad8,
    };
    // Grid points per axis: one per cell boundary, plus the half steps of a quadratic kind.
    let s = if quadratic { 2 } else { 1 };
    let g = [s * cells[0] + 1, s * cells[1] + 1, if dim == 3 { s * cells[2] + 1 } else { 1 }];
    let gid = |p: [usize; 3]| (p[2] * g[1] + p[1]) * g[0] + p[0];
    let cid = |c: [usize; 3]| (c[2] * cells[1] + c[1]) * cells[0] + c[0];
    let point = |p: [usize; 3]| {
        let mut x = [0.0; 3];
        for a in 0..dim {
            x[a] = lo[a] + (hi[a] - lo[a]) * p[a] as f64 / (s * cells[a]) as f64;
        }
        x
    };

    let mut kept = vec![false; cells[0] * cells[1] * cells[2]];
    for c in grid(cells) {
        let mut centre = [0.0; 3];
        for a in 0..dim {
            centre[a] = lo[a] + (hi[a] - lo[a]) * (c[a] as f64 + 0.5) / cells[a] as f64;
        }
        kept[cid(c)] = solid.contains(centre);
    }
    if !kept.iter().any(|&k| k) {
        return Err(GeomError(format!(
            "the lattice of {}×{}×{} cells has no cell whose centre is inside the body; use a smaller element size",
            cells[0], cells[1], cells[2]
        )));
    }

    // Grid offset of local node `l` of a cell: a corner, or the midpoint of edge `l - n_corners`.
    let n_corners = kind.n_corners();
    let offset = |l: usize| -> [usize; 3] {
        if l < n_corners {
            let c = CORNERS[l];
            [s * c[0], s * c[1], s * c[2]]
        } else {
            let [a, b] = kind.edges()[l - n_corners];
            let (ca, cb) = (CORNERS[a as usize], CORNERS[b as usize]);
            [ca[0] + cb[0], ca[1] + cb[1], ca[2] + cb[2]]
        }
    };
    let node_of = |c: [usize; 3], l: usize| {
        let o = offset(l);
        gid([s * c[0] + o[0], s * c[1] + o[1], s * c[2] + o[2]])
    };

    let mut used = vec![false; g[0] * g[1] * g[2]];
    for c in grid(cells).filter(|&c| kept[cid(c)]) {
        for l in 0..kind.n_nodes() {
            used[node_of(c, l)] = true;
        }
    }
    let mut ids = vec![0u32; used.len()];
    let mut coords = Vec::new();
    for p in grid(g).filter(|&p| used[gid(p)]) {
        ids[gid(p)] = (coords.len() / 3) as u32;
        coords.extend_from_slice(&point(p));
    }

    let face_local: &[[u8; 2]] = if dim == 3 { &FACE_LOCAL_3D } else { &FACE_LOCAL_2D };
    let mut conn = Vec::new();
    // Boundary faces, each with the bbox-plane set it lies on (`None`: inside the box).
    let mut boundary: Vec<(Face, Option<usize>)> = Vec::new();
    let mut elem = 0u32;
    for c in grid(cells).filter(|&c| kept[cid(c)]) {
        conn.extend((0..kind.n_nodes()).map(|l| ids[node_of(c, l)]));
        for (a, locals) in face_local.iter().enumerate() {
            for (side, &local) in locals.iter().enumerate() {
                let face = Face { elem, local };
                match neighbour(c, a, side, cells) {
                    None => boundary.push((face, Some(2 * a + side))),
                    Some(n) if !kept[cid(n)] => boundary.push((face, None)),
                    Some(_) => {}
                }
            }
        }
        elem += 1;
    }

    let mut mesh = Mesh {
        dim,
        coords,
        blocks: vec![ElementBlock { kind, conn, first_elem: 0 }],
        node_sets: BTreeMap::new(),
        elem_sets: BTreeMap::from([("all".to_string(), (0..elem).collect())]),
        face_sets: BTreeMap::new(),
    };
    let tagger = Tagger::new(solid);
    let mut face_sets: BTreeMap<String, Vec<Face>> = BTreeMap::new();
    for (face, on_bbox) in boundary {
        let (centroid, normal) = face_centroid_normal(&mesh, face);
        // A boundary face the Solid has no face for (nothing within 45°) joins no auto Set.
        let tag = match on_bbox {
            Some(k) => Some(SET_NAMES[k]),
            None => tagger.nearest(centroid, normal),
        };
        tag.into_iter().for_each(|name| face_sets.entry(name.to_string()).or_default().push(face));
    }
    for set in face_sets.values_mut() {
        set.sort_unstable();
    }
    mesh.face_sets = face_sets;
    Ok(mesh)
}

/// Cells per axis: `counts` as given, else `ceil(extent / size)`, always at least one.
fn cell_counts(
    lo: [f64; 3],
    hi: [f64; 3],
    size: Option<f64>,
    counts: Option<[u32; 3]>,
    dim: usize,
) -> Result<[usize; 3], GeomError> {
    let mut n = match (counts, size) {
        (Some(c), _) => [c[0] as usize, c[1] as usize, c[2] as usize],
        (_, Some(s)) if s > 0.0 => {
            let mut n = [0usize; 3];
            for a in 0..3 {
                n[a] = libm::ceil((hi[a] - lo[a]) / s) as usize;
            }
            n
        }
        _ => return Err(GeomError("the lattice needs a positive element size or element counts".into())),
    };
    for c in &mut n {
        *c = (*c).max(1);
    }
    if dim == 2 {
        n[2] = 1;
    }
    Ok(n)
}

/// Every index of a `[nx, ny, nz]` grid, x fastest.
fn grid(n: [usize; 3]) -> impl Iterator<Item = [usize; 3]> {
    (0..n[2]).flat_map(move |k| (0..n[1]).flat_map(move |j| (0..n[0]).map(move |i| [i, j, k])))
}

/// The cell across face `side` (0 low, 1 high) of axis `a`, or `None` outside the lattice.
fn neighbour(c: [usize; 3], a: usize, side: usize, cells: [usize; 3]) -> Option<[usize; 3]> {
    let mut n = c;
    if side == 0 {
        n[a] = c[a].checked_sub(1)?;
    } else {
        n[a] = c[a] + 1;
        if n[a] >= cells[a] {
            return None;
        }
    }
    Some(n)
}

/// The Solid's tagged faces, ready to name a mesh boundary face by proximity.
struct Tagger<'a> {
    solid: &'a Solid,
    /// 3D only: per Solid triangle its centroid, unit normal and tag.
    tris: Vec<([f64; 3], [f64; 3], &'a str)>,
}

impl<'a> Tagger<'a> {
    fn new(solid: &'a Solid) -> Tagger<'a> {
        let tri = solid.triangles();
        let tris = tri
            .triangles
            .iter()
            .enumerate()
            .map(|(t, v)| {
                let p = [tri.positions[v[0] as usize], tri.positions[v[1] as usize], tri.positions[v[2] as usize]];
                let c = [
                    (p[0][0] + p[1][0] + p[2][0]) / 3.0,
                    (p[0][1] + p[1][1] + p[2][1]) / 3.0,
                    (p[0][2] + p[1][2] + p[2][2]) / 3.0,
                ];
                (c, unit_normal(p), tri.tag_of(t))
            })
            .collect();
        Tagger { solid, tris }
    }

    /// The tag of the Solid face nearest `centroid` whose normal is within 45° of `normal`
    /// (3D), or of the nearest outline edge (2D).
    ///
    /// ponytail: a linear scan over the Solid's triangles per boundary face. Index them if a
    /// body ever has enough triangles for this to show up in a profile.
    fn nearest(&self, centroid: [f64; 3], normal: [f64; 3]) -> Option<&'a str> {
        if self.solid.dim() == 2 {
            let p = [centroid[0], centroid[1]];
            return self
                .solid
                .outline()
                .iter()
                .map(|l| {
                    let (edge, d) = l.nearest_edge(p);
                    (d, l.tags[edge].as_str())
                })
                .min_by(|a, b| a.0.total_cmp(&b.0))
                .map(|(_, tag)| tag);
        }
        self.tris
            .iter()
            .filter(|(_, n, _)| dot(*n, normal) >= TAG_COS)
            .map(|(c, _, tag)| (distance2(*c, centroid), *tag))
            .min_by(|a, b| a.0.total_cmp(&b.0))
            .map(|(_, tag)| tag)
    }
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn distance2(a: [f64; 3], b: [f64; 3]) -> f64 {
    let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    dot(d, d)
}

fn unit_normal(p: [[f64; 3]; 3]) -> [f64; 3] {
    let u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    let v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    let len = libm::sqrt(dot(n, n)).max(f64::MIN_POSITIVE);
    [n[0] / len, n[1] / len, n[2] / len]
}
