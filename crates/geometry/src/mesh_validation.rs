//! Exact geometric conformity of linear tetrahedra, without coordinate welding.
//!
//! This does not certify Hex8 or mixed Tet4/Hex8 pairs: a warped Hex8 has bilinear
//! faces, not the triangular faces checked here.

use manifold_rust::linalg::Vec3;
use manifold_rust::robust::exact::predicates::{orient3d_r, point_on_segment_r};
use manifold_rust::robust::exact::rational::R3;
use manifold_rust::robust::exact::Sign;
use manifold_rust::robust::tri_tri::{tri_tri_intersect, TriTriIsect};

use crate::{ElementKind, GeomError, Mesh};

const FACES: [[usize; 3]; 4] = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]];

struct Tet {
    element: u32,
    nodes: [u32; 4],
    points: [Vec3; 4],
    exact: [R3; 4],
    lo: [f64; 3],
    hi: [f64; 3],
}

impl Tet {
    fn new(mesh: &Mesh, element: u32) -> Self {
        let conn = mesh.elem_nodes(element);
        let nodes = [conn[0], conn[1], conn[2], conn[3]];
        let coordinates = nodes.map(|node| mesh.node(node));
        let points = coordinates.map(|p| Vec3::new(p[0], p[1], p[2]));
        let exact = points.map(R3::from_vec3);
        let lo = std::array::from_fn(|k| coordinates.iter().map(|p| p[k]).fold(f64::INFINITY, f64::min));
        let hi = std::array::from_fn(|k| coordinates.iter().map(|p| p[k]).fold(f64::NEG_INFINITY, f64::max));
        Self { element, nodes, points, exact, lo, hi }
    }

    fn contains(&self, point: &R3) -> bool {
        // manifold-rust uses cross(b-a,c-a) dot (point-a), not det(a-point,
        // b-point,c-point). For the outward base [0,2,1] of the reference
        // tet this is -point.z, so the closed interior has Neg/Zero signs.
        FACES.iter().all(|&[a, b, c]| orient3d_r(&self.exact[a], &self.exact[b], &self.exact[c], point) != Sign::Pos)
    }
}

/// Check every Tet4/Tet4 contact, including adjacent elements, against the shared
/// labelled vertex/edge/face. Connectivity, finite coordinates and strictly positive
/// tetrahedron Jacobians must already have been checked by the caller.
///
/// A tetrahedron is convex. Its intersection with another tetrahedron is determined
/// by contained vertices and face intersections, so checking both accounts for
/// containment as well as crossings and partial coplanar contacts. Exact predicates
/// operate on the supplied f64 coordinates; no distance tolerance merges identities.
/// Unused nodes are untouched. Hex8 and mixed pairs are deliberately not checked.
///
/// The deterministic closed-box sweep uses O(n) auxiliary memory and never allocates
/// all candidate pairs. Its worst-case running time is quadratic when boxes overlap.
pub fn validate_tet_pairs(mesh: &Mesh) -> Result<(), GeomError> {
    let mut tets: Vec<_> = (0..mesh.n_elems() as u32)
        .filter(|&element| mesh.kind_of(element) == ElementKind::Tet4)
        .map(|element| Tet::new(mesh, element))
        .collect();
    tets.sort_by(|a, b| a.lo[0].total_cmp(&b.lo[0]).then(a.element.cmp(&b.element)));
    let mut active: Vec<usize> = Vec::new();
    for (index, tet) in tets.iter().enumerate() {
        active.retain(|&other| tets[other].hi[0] >= tet.lo[0]);
        for &other in &active {
            let previous = &tets[other];
            if (1..3).all(|k| previous.hi[k] >= tet.lo[k] && tet.hi[k] >= previous.lo[k])
                && !conforming_pair(previous, tet)
            {
                return Err(GeomError(format!(
                    "tetrahedra {} and {} overlap or meet outside their shared labelled vertex, edge or face",
                    previous.element.min(tet.element),
                    previous.element.max(tet.element)
                )));
            }
        }
        active.push(index);
    }
    Ok(())
}

fn conforming_pair(a: &Tet, b: &Tet) -> bool {
    let common: Vec<_> =
        a.nodes.iter().enumerate().filter(|(_, node)| b.nodes.contains(node)).map(|(i, _)| &a.exact[i]).collect();
    for (owner, other) in [(a, b), (b, a)] {
        for (i, node) in owner.nodes.iter().enumerate() {
            if !other.nodes.contains(node) && other.contains(&owner.exact[i]) {
                return false;
            }
        }
    }
    for face_a in FACES {
        for face_b in FACES {
            let allowed = match tri_tri_intersect(face_a.map(|i| a.points[i]), face_b.map(|i| b.points[i])) {
                TriTriIsect::None => true,
                TriTriIsect::Point(point) => shared_contains(&common, &point),
                TriTriIsect::Segment(start, end) => shared_contains(&common, &start) && shared_contains(&common, &end),
                TriTriIsect::Coplanar { polygon, .. } => polygon.iter().all(|point| shared_contains(&common, point)),
            };
            if !allowed {
                return false;
            }
        }
    }
    true
}

/// The all-kind imported certificate shares this narrow phase while retaining
/// the original mesh's dense element IDs for its structured diagnostics.
pub(crate) fn tet_pair_is_conforming(mesh: &Mesh, a: u32, b: u32) -> bool {
    conforming_pair(&Tet::new(mesh, a), &Tet::new(mesh, b))
}

fn shared_contains(common: &[&R3], point: &R3) -> bool {
    match common {
        [] => false,
        [a] => point == *a,
        [a, b] => point_on_segment_r(point, a, b),
        // This point already belongs to both tetrahedron boundaries. A nondegenerate
        // tetrahedron's intersection with one face's plane is exactly that triangle.
        [a, b, c] => orient3d_r(a, b, c, point) == Sign::Zero,
        // Four common nodes describe a duplicate cell, not an admissible interface.
        _ => false,
    }
}
