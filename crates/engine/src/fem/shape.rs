//! Reference elements and their face parents: shape functions, their parametric derivatives,
//! the quadrature rule each kind is integrated with, and the reference coordinates of the nodes.
//!
//! Node order is `ElementKind`'s Abaqus order: corners first, then the mid-edge node of
//! `edges()[i]` at position `n_corners() + i`. Reference domains are the cube `[-1,1]³` for
//! hexahedra, the square `[-1,1]²` for quadrilaterals, the line `[-1,1]` for edges, and the
//! unit simplex for tetrahedra and triangles. Face parents use the same families in their own
//! `(s, t)` coordinates.
//!
//! The shape functions themselves are four family routines driven by the corner and edge
//! tables of `femlab_geometry::mesh`, so there is one formula per family and no per-kind table
//! to drift: `shape_of`/`dshape_of` dispatch on the enum and `RefElement` is the typed view of
//! the same functions. Slice lengths are the caller's contract (`n.len() == kind.n_nodes()`);
//! a short slice panics on the index.

use femlab_geometry::mesh::{ElementKind, FaceKind};

use crate::fem::quadrature::{
    Rule, HEX_2X2X2, HEX_3X3X3, QUAD_2X2, QUAD_3X3, TET_1, TET_125, TET_4, TRI_1, TRI_25, TRI_3, TRI_9,
};

/// 1/√3, the 2-point Gauss–Legendre abscissa (the tests check it against `gauss_legendre(2)`).
const G2: f64 = 0.577_350_269_189_625_8;
/// √(3/5), the outer 3-point Gauss–Legendre abscissa.
const G3: f64 = 0.774_596_669_241_483_4;

/// 1-point Gauss–Legendre on `[-1, 1]` (degree 1): the truss's rule. A member is straight and
/// prismatic, so one point at its midpoint integrates its constant strain exactly.
pub const LINE_1: Rule = Rule { points: &[[0.0, 0.0, 0.0]], weights: &[2.0] };

/// 2-point Gauss–Legendre on `[-1, 1]` (degree 3): the line2 face parent.
pub const LINE_2: Rule = Rule { points: &[[-G2, 0.0, 0.0], [G2, 0.0, 0.0]], weights: &[1.0, 1.0] };

/// 3-point Gauss–Legendre on `[-1, 1]` (degree 5): the line3 face parent.
pub const LINE_3: Rule =
    Rule { points: &[[-G3, 0.0, 0.0], [0.0, 0.0, 0.0], [G3, 0.0, 0.0]], weights: &[5.0 / 9.0, 8.0 / 9.0, 5.0 / 9.0] };

const HEX_CORNERS: [[f64; 3]; 8] = [
    [-1.0, -1.0, -1.0],
    [1.0, -1.0, -1.0],
    [1.0, 1.0, -1.0],
    [-1.0, 1.0, -1.0],
    [-1.0, -1.0, 1.0],
    [1.0, -1.0, 1.0],
    [1.0, 1.0, 1.0],
    [-1.0, 1.0, 1.0],
];
const QUAD_CORNERS: [[f64; 3]; 4] = [[-1.0, -1.0, 0.0], [1.0, -1.0, 0.0], [1.0, 1.0, 0.0], [-1.0, 1.0, 0.0]];
const LINE_CORNERS: [[f64; 3]; 2] = [[-1.0, 0.0, 0.0], [1.0, 0.0, 0.0]];
const TET_CORNERS: [[f64; 3]; 4] = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
const TRI_CORNERS: [[f64; 3]; 3] = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
/// The one edge of a line3, so the serendipity routine can build it like a quad8.
const LINE_EDGES: [[u8; 2]; 1] = [[0, 1]];

// ------------------------------------------------------------------ families

/// `N_a = 2^-d Π_k (1 + ξ_k c_k)`: hex8, quad4, line2.
fn tensor_shape(dim: usize, corners: &[[f64; 3]], xi: [f64; 3], n: &mut [f64]) {
    for (a, c) in corners.iter().enumerate() {
        n[a] = (0..dim).map(|k| 0.5 * (1.0 + xi[k] * c[k])).product();
    }
}

fn tensor_dshape(dim: usize, corners: &[[f64; 3]], xi: [f64; 3], dn: &mut [[f64; 3]]) {
    for (a, c) in corners.iter().enumerate() {
        let mut g = [0.0; 3];
        for (j, gj) in g.iter_mut().enumerate().take(dim) {
            *gj = (0..dim).map(|k| if k == j { 0.5 * c[k] } else { 0.5 * (1.0 + xi[k] * c[k]) }).product::<f64>();
        }
        dn[a] = g;
    }
}

/// Reference coordinates of the mid-edge node of `e`.
fn mid(corners: &[[f64; 3]], e: &[u8; 2]) -> [f64; 3] {
    let (a, b) = (corners[e[0] as usize], corners[e[1] as usize]);
    [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5]
}

/// The serendipity mid-edge factor: `1 − ξ²` along the edge, `1 + ξ m` across it.
fn edge_factor(m: f64, x: f64) -> f64 {
    if m == 0.0 {
        1.0 - x * x
    } else {
        1.0 + x * m
    }
}

fn d_edge_factor(m: f64, x: f64) -> f64 {
    if m == 0.0 {
        -2.0 * x
    } else {
        m
    }
}

/// Serendipity: corners `2^-d Π(1 + ξ_k c_k) (Σ ξ_k c_k − (d − 1))`, mid-edge nodes
/// `2^(1-d) Π_k f_k` with `f` the edge factor. hex20, quad8, line3.
fn serendipity_shape(dim: usize, corners: &[[f64; 3]], edges: &[[u8; 2]], xi: [f64; 3], n: &mut [f64]) {
    let s = 0.5f64.powi(dim as i32);
    let nc = corners.len();
    for (a, c) in corners.iter().enumerate() {
        let p: f64 = (0..dim).map(|k| 1.0 + xi[k] * c[k]).product();
        let q: f64 = (0..dim).map(|k| xi[k] * c[k]).sum::<f64>() - (dim as f64 - 1.0);
        n[a] = s * p * q;
    }
    for (i, e) in edges.iter().enumerate() {
        let m = mid(corners, e);
        n[nc + i] = 2.0 * s * (0..dim).map(|k| edge_factor(m[k], xi[k])).product::<f64>();
    }
}

fn serendipity_dshape(dim: usize, corners: &[[f64; 3]], edges: &[[u8; 2]], xi: [f64; 3], dn: &mut [[f64; 3]]) {
    let s = 0.5f64.powi(dim as i32);
    let nc = corners.len();
    for (a, c) in corners.iter().enumerate() {
        let p: f64 = (0..dim).map(|k| 1.0 + xi[k] * c[k]).product();
        let q: f64 = (0..dim).map(|k| xi[k] * c[k]).sum::<f64>() - (dim as f64 - 1.0);
        let mut g = [0.0; 3];
        for (j, gj) in g.iter_mut().enumerate().take(dim) {
            let dp: f64 = (0..dim).map(|k| if k == j { c[k] } else { 1.0 + xi[k] * c[k] }).product();
            *gj = s * (dp * q + p * c[j]);
        }
        dn[a] = g;
    }
    for (i, e) in edges.iter().enumerate() {
        let m = mid(corners, e);
        let mut g = [0.0; 3];
        for (j, gj) in g.iter_mut().enumerate().take(dim) {
            *gj = 2.0
                * s
                * (0..dim)
                    .map(|k| if k == j { d_edge_factor(m[k], xi[k]) } else { edge_factor(m[k], xi[k]) })
                    .product::<f64>();
        }
        dn[nc + i] = g;
    }
}

/// Barycentrics `L₀ = 1 − Σ ξ`, `L_{i+1} = ξ_i`, and their constant gradients.
fn bary(dim: usize, xi: [f64; 3]) -> ([f64; 4], [[f64; 3]; 4]) {
    let mut l = [0.0; 4];
    let mut dl = [[0.0; 3]; 4];
    l[0] = 1.0 - (0..dim).map(|k| xi[k]).sum::<f64>();
    for k in 0..dim {
        dl[0][k] = -1.0;
        l[k + 1] = xi[k];
        dl[k + 1][k] = 1.0;
    }
    (l, dl)
}

/// Simplex: linear `N_a = L_a`, quadratic `L_a(2L_a − 1)` and `4 L_i L_j`. tet4/10, tri3/6.
fn simplex_shape(dim: usize, nc: usize, edges: &[[u8; 2]], xi: [f64; 3], n: &mut [f64]) {
    let (l, _) = bary(dim, xi);
    let quadratic = !edges.is_empty();
    for (a, out) in n.iter_mut().take(nc).enumerate() {
        *out = if quadratic { l[a] * (2.0 * l[a] - 1.0) } else { l[a] };
    }
    for (i, e) in edges.iter().enumerate() {
        n[nc + i] = 4.0 * l[e[0] as usize] * l[e[1] as usize];
    }
}

fn simplex_dshape(dim: usize, nc: usize, edges: &[[u8; 2]], xi: [f64; 3], dn: &mut [[f64; 3]]) {
    let (l, dl) = bary(dim, xi);
    let quadratic = !edges.is_empty();
    for (a, out) in dn.iter_mut().take(nc).enumerate() {
        let f = if quadratic { 4.0 * l[a] - 1.0 } else { 1.0 };
        *out = [f * dl[a][0], f * dl[a][1], f * dl[a][2]];
    }
    for (i, e) in edges.iter().enumerate() {
        let (p, q) = (e[0] as usize, e[1] as usize);
        dn[nc + i] = [0.0; 3];
        for k in 0..dim {
            dn[nc + i][k] = 4.0 * (l[p] * dl[q][k] + l[q] * dl[p][k]);
        }
    }
}

// ------------------------------------------------------------------ dispatch

/// A `Rule` is only two static slices; this is its copy constructor.
fn copy_rule(r: &'static Rule) -> Rule {
    Rule { points: r.points, weights: r.weights }
}

/// The stiffness/recovery quadrature rule: hex8 2×2×2, hex20 3×3×3, tet4 1, tet10 4,
/// quad4 2×2, quad8 3×3, tri3 1, tri6 3, truss2 1.
pub fn rule_of(kind: ElementKind) -> Rule {
    copy_rule(match kind {
        ElementKind::Hex8 => &HEX_2X2X2,
        ElementKind::Hex20 => &HEX_3X3X3,
        ElementKind::Tet4 => &TET_1,
        ElementKind::Tet10 => &TET_4,
        ElementKind::Quad4 => &QUAD_2X2,
        ElementKind::Quad8 => &QUAD_3X3,
        ElementKind::Tri3 => &TRI_1,
        ElementKind::Tri6 => &TRI_3,
        ElementKind::Truss2 => &LINE_1,
    })
}

/// Quadrature for `NᵀN` volume integrals (mass and capacity), independent of the
/// stiffness/recovery rule. Linear simplex products have degree 2; quadratic ones
/// degree 4. A quadratic isoparametric Jacobian adds up to degree `dim`, and an
/// axisymmetric radius adds up to degree 2. These positive rules therefore cover
/// degree 3/8 for linear/quadratic triangles and degree 2/7 for tetrahedra, including
/// curved geometry and the physical scale. Tensor elements retain their full rule.
pub fn product_rule_of(kind: ElementKind) -> Rule {
    match kind {
        ElementKind::Tri3 => copy_rule(&TRI_9),
        ElementKind::Tri6 => copy_rule(&TRI_25),
        ElementKind::Tet4 => copy_rule(&TET_4),
        ElementKind::Tet10 => copy_rule(&TET_125),
        _ => rule_of(kind),
    }
}

/// Shape functions at `xi`; `n.len() == kind.n_nodes()`.
pub fn shape_of(kind: ElementKind, xi: [f64; 3], n: &mut [f64]) {
    match kind {
        ElementKind::Hex8 => tensor_shape(3, &HEX_CORNERS, xi, n),
        ElementKind::Quad4 => tensor_shape(2, &QUAD_CORNERS, xi, n),
        ElementKind::Hex20 => serendipity_shape(3, &HEX_CORNERS, kind.edges(), xi, n),
        ElementKind::Quad8 => serendipity_shape(2, &QUAD_CORNERS, kind.edges(), xi, n),
        ElementKind::Tet4 => simplex_shape(3, 4, &[], xi, n),
        ElementKind::Tet10 => simplex_shape(3, 4, kind.edges(), xi, n),
        ElementKind::Tri3 => simplex_shape(2, 3, &[], xi, n),
        ElementKind::Tri6 => simplex_shape(2, 3, kind.edges(), xi, n),
        ElementKind::Truss2 => tensor_shape(1, &LINE_CORNERS, xi, n),
    }
}

/// `dN/dξ`, `dN/dη`, `dN/dζ` at `xi` (the unused third entry is zero in 2D);
/// `dn.len() == kind.n_nodes()`.
pub fn dshape_of(kind: ElementKind, xi: [f64; 3], dn: &mut [[f64; 3]]) {
    match kind {
        ElementKind::Hex8 => tensor_dshape(3, &HEX_CORNERS, xi, dn),
        ElementKind::Quad4 => tensor_dshape(2, &QUAD_CORNERS, xi, dn),
        ElementKind::Hex20 => serendipity_dshape(3, &HEX_CORNERS, kind.edges(), xi, dn),
        ElementKind::Quad8 => serendipity_dshape(2, &QUAD_CORNERS, kind.edges(), xi, dn),
        ElementKind::Tet4 => simplex_dshape(3, 4, &[], xi, dn),
        ElementKind::Tet10 => simplex_dshape(3, 4, kind.edges(), xi, dn),
        ElementKind::Tri3 => simplex_dshape(2, 3, &[], xi, dn),
        ElementKind::Tri6 => simplex_dshape(2, 3, kind.edges(), xi, dn),
        ElementKind::Truss2 => tensor_dshape(1, &LINE_CORNERS, xi, dn),
    }
}

/// Corner reference coordinates of a kind's family.
fn corners_of(kind: ElementKind) -> &'static [[f64; 3]] {
    match kind {
        ElementKind::Hex8 | ElementKind::Hex20 => &HEX_CORNERS,
        ElementKind::Tet4 | ElementKind::Tet10 => &TET_CORNERS,
        ElementKind::Quad4 | ElementKind::Quad8 => &QUAD_CORNERS,
        ElementKind::Tri3 | ElementKind::Tri6 => &TRI_CORNERS,
        ElementKind::Truss2 => &LINE_CORNERS,
    }
}

/// Reference coordinates of every node, in Abaqus order: the corners, then the midpoint of
/// `edges()[i]` for each mid-edge node. `shape_of` is the Kronecker delta on these points.
pub fn node_xi(kind: ElementKind) -> Vec<[f64; 3]> {
    let corners = corners_of(kind);
    let mut v = corners.to_vec();
    for e in &kind.edges()[..kind.n_nodes() - kind.n_corners()] {
        v.push(mid(corners, e));
    }
    v
}

/// The centre of the reference domain: the origin for hexahedra and quadrilaterals, the
/// centroid for simplices.
pub fn centre_xi(kind: ElementKind) -> [f64; 3] {
    let c = corners_of(kind);
    let f = 1.0 / c.len() as f64;
    let mut m = [0.0; 3];
    for p in c {
        for (k, x) in p.iter().enumerate() {
            m[k] += f * x;
        }
    }
    m
}

/// Is `xi` inside the reference domain, within `tol`? `|ξ_k| ≤ 1 + tol` on the cube and
/// square, `ξ_k ≥ −tol` with `Σ ξ ≤ 1 + tol` on the simplices.
pub fn in_reference(kind: ElementKind, xi: [f64; 3], tol: f64) -> bool {
    let dim = kind.dim();
    match kind {
        ElementKind::Hex8 | ElementKind::Hex20 | ElementKind::Quad4 | ElementKind::Quad8 | ElementKind::Truss2 => {
            (0..dim).all(|k| xi[k].abs() <= 1.0 + tol)
        }
        _ => (0..dim).all(|k| xi[k] >= -tol) && (0..dim).map(|k| xi[k]).sum::<f64>() <= 1.0 + tol,
    }
}

/// The quadrature rule of a face parent: quad4 2×2, quad8 3×3, tri3 1, tri6 3, line2 2, line3 3.
pub fn face_rule_of(kind: FaceKind) -> Rule {
    copy_rule(match kind {
        FaceKind::Quad4 => &QUAD_2X2,
        FaceKind::Quad8 => &QUAD_3X3,
        FaceKind::Tri3 => &TRI_1,
        FaceKind::Tri6 => &TRI_3,
        FaceKind::Line2 => &LINE_2,
        FaceKind::Line3 => &LINE_3,
    })
}

/// Face shape functions at `(s, t)`; `n.len() == kind.n_nodes()`. Node order matches
/// `ElementKind::face_nodes`: corners counter-clockwise seen from outside, then mid-edge nodes.
pub fn face_shape_of(kind: FaceKind, s: [f64; 2], n: &mut [f64]) {
    let xi = [s[0], s[1], 0.0];
    match kind {
        FaceKind::Quad4 => tensor_shape(2, &QUAD_CORNERS, xi, n),
        FaceKind::Quad8 => serendipity_shape(2, &QUAD_CORNERS, ElementKind::Quad8.edges(), xi, n),
        FaceKind::Tri3 => simplex_shape(2, 3, &[], xi, n),
        FaceKind::Tri6 => simplex_shape(2, 3, ElementKind::Tri6.edges(), xi, n),
        FaceKind::Line2 => tensor_shape(1, &LINE_CORNERS, xi, n),
        FaceKind::Line3 => serendipity_shape(1, &LINE_CORNERS, &LINE_EDGES, xi, n),
    }
}

/// `dN/ds`, `dN/dt` at `(s, t)` (the second entry is zero for the line parents);
/// `dn.len() == kind.n_nodes()`.
pub fn face_dshape_of(kind: FaceKind, s: [f64; 2], dn: &mut [[f64; 2]]) {
    let xi = [s[0], s[1], 0.0];
    let mut t = [[0.0; 3]; 8];
    let d = &mut t[..dn.len()];
    match kind {
        FaceKind::Quad4 => tensor_dshape(2, &QUAD_CORNERS, xi, d),
        FaceKind::Quad8 => serendipity_dshape(2, &QUAD_CORNERS, ElementKind::Quad8.edges(), xi, d),
        FaceKind::Tri3 => simplex_dshape(2, 3, &[], xi, d),
        FaceKind::Tri6 => simplex_dshape(2, 3, ElementKind::Tri6.edges(), xi, d),
        FaceKind::Line2 => tensor_dshape(1, &LINE_CORNERS, xi, d),
        FaceKind::Line3 => serendipity_dshape(1, &LINE_CORNERS, &LINE_EDGES, xi, d),
    }
    for (out, g) in dn.iter_mut().zip(d.iter()) {
        *out = [g[0], g[1]];
    }
}

// ------------------------------------------------------------------ traits

/// One reference element: the typed view of `shape_of` and friends, so `Iso<R>` names its
/// kind at compile time. Everything a plugin element would need is on the free functions,
/// which take the enum and are therefore dyn-friendly. `Send + Sync` so `Iso<R>` is.
pub trait RefElement: Send + Sync {
    const KIND: ElementKind;
    const N: usize = Self::KIND.n_nodes();
    const DIM: usize = Self::KIND.dim();
    fn rule() -> Rule {
        rule_of(Self::KIND)
    }
    /// `n.len() == Self::N`.
    fn shape(xi: [f64; 3], n: &mut [f64]) {
        shape_of(Self::KIND, xi, n)
    }
    /// `dn.len() == Self::N`.
    fn dshape(xi: [f64; 3], dn: &mut [[f64; 3]]) {
        dshape_of(Self::KIND, xi, dn)
    }
}

/// One face parent, in the face's own `(s, t)` coordinates.
pub trait RefFace {
    const KIND: FaceKind;
    const N: usize = Self::KIND.n_nodes();
    fn rule() -> Rule {
        face_rule_of(Self::KIND)
    }
    /// `n.len() == Self::N`.
    fn shape(s: [f64; 2], n: &mut [f64]) {
        face_shape_of(Self::KIND, s, n)
    }
    /// `dn.len() == Self::N`.
    fn dshape(s: [f64; 2], dn: &mut [[f64; 2]]) {
        face_dshape_of(Self::KIND, s, dn)
    }
}

macro_rules! ref_elements {
    ($($t:ident),* $(,)?) => {$(
        /// Zero-sized reference element; see [`RefElement`].
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub struct $t;
        impl RefElement for $t {
            const KIND: ElementKind = ElementKind::$t;
        }
    )*};
}

ref_elements!(Hex8, Hex20, Tet4, Tet10, Quad4, Quad8, Tri3, Tri6);

macro_rules! ref_faces {
    ($($t:ident => $k:ident),* $(,)?) => {$(
        /// Zero-sized face parent; see [`RefFace`].
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub struct $t;
        impl RefFace for $t {
            const KIND: FaceKind = FaceKind::$k;
        }
    )*};
}

ref_faces!(Quad4F => Quad4, Quad8F => Quad8, Tri3F => Tri3, Tri6F => Tri6, Line2 => Line2, Line3 => Line3);
