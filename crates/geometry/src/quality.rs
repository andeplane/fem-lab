//! Mesh quality from corner geometry alone (C §2.8): the Jacobian ratio, the aspect ratio, the
//! smallest corner angle and the dihedral angles, plus the worst elements by Jacobian ratio.
//!
//! Cheap on purpose. The element integration repeats the det J check at every Gauss point and
//! is the authoritative one; this is the number a Query reports and the UI colours by.

use crate::mesh::{ElementKind, Mesh};

/// Quality of a whole mesh. `min_det_j_ratio` and `min_angle_deg` are worst-case, `max_aspect`
/// is the largest longest-over-shortest edge ratio, and `worst` lists the poorest elements by
/// Jacobian ratio, ascending.
#[derive(Debug, Clone, PartialEq)]
pub struct Quality {
    /// Smallest corner `det J` divided by the largest absolute corner `det J`; 1 is perfect, a
    /// negative value means an inverted element and 0 a degenerate one. Using the absolute
    /// denominator keeps reflected elements negative and bounds the ratio to `[-1, 1]`.
    pub min_det_j_ratio: f64,
    /// Largest longest-edge / shortest-edge ratio; 1 is a cube, `f64::MAX` a collapsed edge.
    pub max_aspect: f64,
    /// Smallest angle at any corner of any element face, in degrees; 90 is a cube.
    pub min_angle_deg: f64,
    /// Smallest interior angle between two faces meeting at an element edge, in degrees, over
    /// the 3D elements; `None` for a 2D mesh, which has no dihedral angle. This is the number
    /// a tetrahedral mesh is judged by: `min_det_j_ratio` is identically 1 for a simplex and
    /// says nothing at all about one.
    pub min_dihedral_deg: Option<f64>,
    /// Largest interior angle between two faces meeting at an element edge, in degrees; `None`
    /// for a 2D mesh. 180 is a flat sliver.
    pub max_dihedral_deg: Option<f64>,
    /// The `worst_n` elements with the smallest Jacobian ratio, as `(element, ratio)`.
    pub worst: Vec<(u32, f64)>,
}

/// Corner Jacobian, edge-length, corner-angle and dihedral-angle quality of every element.
pub fn quality(mesh: &Mesh, worst_n: usize) -> Quality {
    let mut per_elem: Vec<(u32, f64)> = Vec::with_capacity(mesh.n_elems());
    let mut max_aspect = 0.0f64;
    let mut min_angle = 180.0f64;
    let mut dihedral: Option<(f64, f64)> = None;
    for e in 0..mesh.n_elems() as u32 {
        let kind = mesh.kind_of(e);
        let x: Vec<[f64; 3]> = mesh.elem_nodes(e).iter().take(kind.n_corners()).map(|&n| mesh.node(n)).collect();
        let dets = corner_dets(kind, &x);
        let lo = dets.iter().copied().fold(f64::INFINITY, f64::min);
        let scale = dets.iter().copied().map(f64::abs).fold(0.0f64, f64::max);
        per_elem.push((e, if scale == 0.0 { 0.0 } else { lo / scale }));
        let mut short = f64::INFINITY;
        let mut long = 0.0f64;
        for &[a, b] in kind.edges() {
            let l = norm(sub(x[a as usize], x[b as usize]));
            short = short.min(l);
            long = long.max(l);
        }
        max_aspect = max_aspect.max(if short > 0.0 { long / short } else { f64::MAX });
        min_angle = min_angle.min(min_corner_angle(kind, &x));
        if kind.dim() == 3 {
            let (lo, hi) = dihedral.unwrap_or((180.0, 0.0));
            let (a, b) = dihedral_range(kind, &x);
            dihedral = Some((lo.min(a), hi.max(b)));
        }
    }
    let min_det_j_ratio = per_elem.iter().map(|&(_, v)| v).fold(1.0f64, f64::min);
    let mut worst = per_elem;
    worst.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
    worst.truncate(worst_n);
    Quality {
        min_det_j_ratio,
        max_aspect,
        min_angle_deg: min_angle,
        min_dihedral_deg: dihedral.map(|(lo, _)| lo),
        max_dihedral_deg: dihedral.map(|(_, hi)| hi),
        worst,
    }
}

/// Smallest and largest interior dihedral angle of one 3D element, in degrees.
///
/// Two faces meeting at an edge share exactly two corners, and each face's corners are listed
/// counter-clockwise seen from outside, so the outward normals `n1` and `n2` of the pair give
/// the interior angle as `180° − ∠(n1, n2)`.
fn dihedral_range(kind: ElementKind, x: &[[f64; 3]]) -> (f64, f64) {
    let n_faces = kind.n_faces();
    let corners = |f: usize| &kind.face_nodes(f)[..kind.face_kind().n_corners()];
    let normal = |f: usize| {
        let c = corners(f);
        let p = |i: usize| x[c[i] as usize];
        cross(sub(p(1), p(0)), sub(p(2), p(0)))
    };
    let mut lo = 180.0f64;
    let mut hi = 0.0f64;
    for f in 0..n_faces {
        for g in f + 1..n_faces {
            if corners(f).iter().filter(|l| corners(g).contains(l)).count() != 2 {
                continue;
            }
            let a = 180.0 - angle_deg(normal(f), normal(g));
            lo = lo.min(a);
            hi = hi.max(a);
        }
    }
    (lo, hi)
}

fn cross(u: [f64; 3], v: [f64; 3]) -> [f64; 3] {
    [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
}

/// The two corners of the element edge along each parametric axis at each corner of a hex; the
/// trilinear `∂x/∂ξ_a` there is half the vector between them.
const HEX_CORNER_AXES: [[[u8; 2]; 3]; 8] = [
    [[0, 1], [0, 3], [0, 4]],
    [[0, 1], [1, 2], [1, 5]],
    [[3, 2], [1, 2], [2, 6]],
    [[3, 2], [0, 3], [3, 7]],
    [[4, 5], [4, 7], [0, 4]],
    [[4, 5], [5, 6], [1, 5]],
    [[7, 6], [5, 6], [2, 6]],
    [[7, 6], [4, 7], [3, 7]],
];
/// The same for a quad; the first four hex corners are the quad's.
const QUAD_CORNER_AXES: [[[u8; 2]; 2]; 4] = [[[0, 1], [0, 3]], [[0, 1], [1, 2]], [[3, 2], [1, 2]], [[3, 2], [0, 3]]];

/// `det J` at every corner, up to the constant `2^-dim` that cancels out of the ratio.
/// Simplices are affine, so one value describes the whole element.
fn corner_dets(kind: ElementKind, x: &[[f64; 3]]) -> Vec<f64> {
    let edge = |e: [u8; 2]| sub(x[e[1] as usize], x[e[0] as usize]);
    match (kind.n_corners(), kind.dim()) {
        (8, _) => HEX_CORNER_AXES.iter().map(|a| det3(edge(a[0]), edge(a[1]), edge(a[2]))).collect(),
        (4, 3) => vec![det3(sub(x[1], x[0]), sub(x[2], x[0]), sub(x[3], x[0]))],
        (4, _) => QUAD_CORNER_AXES.iter().map(|a| det2(edge(a[0]), edge(a[1]))).collect(),
        _ => vec![det2(sub(x[1], x[0]), sub(x[2], x[0]))],
    }
}

/// The smallest angle at a corner of any face (3D) or of the element polygon (2D), in degrees.
fn min_corner_angle(kind: ElementKind, x: &[[f64; 3]]) -> f64 {
    let corners: Vec<Vec<usize>> = if kind.dim() == 3 {
        (0..kind.n_faces())
            .map(|f| kind.face_nodes(f).iter().take(kind.face_kind().n_corners()).map(|&l| l as usize).collect())
            .collect()
    } else {
        vec![(0..kind.n_corners()).collect()]
    };
    let mut min = 180.0f64;
    for poly in &corners {
        let n = poly.len();
        for (i, &c) in poly.iter().enumerate() {
            let prev = x[poly[(i + n - 1) % n]];
            let next = x[poly[(i + 1) % n]];
            min = min.min(angle_deg(sub(prev, x[c]), sub(next, x[c])));
        }
    }
    min
}

fn angle_deg(u: [f64; 3], v: [f64; 3]) -> f64 {
    let d = (norm(u) * norm(v)).max(f64::MIN_POSITIVE);
    libm::acos((dot(u, v) / d).clamp(-1.0, 1.0)).to_degrees()
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(v: [f64; 3]) -> f64 {
    libm::sqrt(dot(v, v))
}

fn det2(u: [f64; 3], v: [f64; 3]) -> f64 {
    u[0] * v[1] - u[1] * v[0]
}

fn det3(u: [f64; 3], v: [f64; 3], w: [f64; 3]) -> f64 {
    u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0])
}
