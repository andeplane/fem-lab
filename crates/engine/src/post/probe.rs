//! Sampling a nodal or element field where the user points: one value at a point, or a line of them
//! (plan A §8).
//!
//! Point location is a bounding-box scan followed by a Newton inversion of the isoparametric
//! map, which is exact for a curved element and cheap enough at the rate a person clicks.
//! `// ponytail: linear scan; a kd-tree if probes ever get hot.`

use femlab_geometry::{ElementKind, Mesh};

use crate::fem::element::{element_for, InverseMap};
use crate::post::{FieldData, Per};

/// How far outside its own bounding box an element is still considered, relative to the box.
const BBOX_SLACK: f64 = 1e-9;

/// The element containing `x` and the nodal field interpolated there, or `None` when the point
/// is outside the mesh. Element fields return the containing element’s constant value.
/// Ties (a point on a shared face) go to the lowest element id.
pub fn probe(mesh: &Mesh, f: &FieldData, x: [f64; 3]) -> Option<(u32, Vec<f64>)> {
    probe_checked(mesh, f, x).ok().flatten()
}

/// Point location that preserves the distinction between a positively outside point and a
/// numerical inversion failure. The failing element id makes the Query error actionable.
pub fn probe_checked(mesh: &Mesh, f: &FieldData, x: [f64; 3]) -> Result<Option<(u32, Vec<f64>)>, u32> {
    let mut coords = Vec::new();
    let mut shape = Vec::new();
    let mut failed = None;
    for elem in 0..mesh.n_elems() as u32 {
        let kind = mesh.kind_of(elem);
        coords.resize(kind.n_nodes() * 3, 0.0);
        mesh.elem_coords(elem, &mut coords);
        if !in_bbox(kind, &coords, x) {
            continue;
        }
        let element = element_for(kind);
        let xi = match element.inverse_map_status(&coords, x) {
            InverseMap::Inside(xi) => xi,
            InverseMap::Outside => continue,
            InverseMap::Failed => {
                failed = Some(elem);
                continue;
            }
        };
        if f.per == Per::Element {
            let start = elem as usize * f.comps;
            return Ok(Some((elem, f.data[start..start + f.comps].to_vec())));
        }
        shape.resize(kind.n_nodes(), 0.0);
        element.shape_at(xi, &mut shape);
        let mut out = vec![0.0; f.comps];
        for (a, &node) in mesh.elem_nodes(elem).iter().enumerate() {
            for (c, o) in out.iter_mut().enumerate() {
                *o += shape[a] * f.data[node as usize * f.comps + c];
            }
        }
        return Ok(Some((elem, out)));
    }
    match failed {
        Some(elem) => Err(elem),
        None => Ok(None),
    }
}

fn bounds(points: impl IntoIterator<Item = [f64; 3]>) -> ([f64; 3], [f64; 3]) {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for point in points {
        for k in 0..3 {
            lo[k] = lo[k].min(point[k]);
            hi[k] = hi[k].max(point[k]);
        }
    }
    (lo, hi)
}

fn nodal_bounds(coords: &[f64]) -> ([f64; 3], [f64; 3]) {
    bounds(coords.chunks_exact(3).map(|point| [point[0], point[1], point[2]]))
}

/// Convex-hull bounds of a quadratic simplex in its degree-two Bernstein basis. The corner
/// controls equal the corner nodes; an edge control is `2 midpoint - (corner0 + corner1)/2`.
fn simplex_control_bounds(kind: ElementKind, coords: &[f64]) -> ([f64; 3], [f64; 3]) {
    let corners = kind.n_corners();
    let mut controls: Vec<[f64; 3]> =
        coords[..3 * corners].chunks_exact(3).map(|point| [point[0], point[1], point[2]]).collect();
    for (edge, &[a, b]) in kind.edges().iter().enumerate() {
        controls.push(std::array::from_fn(|k| {
            2.0 * coords[3 * (corners + edge) + k] - 0.5 * (coords[3 * a as usize + k] + coords[3 * b as usize + k])
        }));
    }
    bounds(controls)
}

/// Convex-hull bounds of a square/cube map after converting its values on the 3^dim quadratic
/// Lagrange grid to tensor-product Bernstein controls. This contains curved extrema that can
/// extend beyond every nodal coordinate.
fn tensor_control_bounds(kind: ElementKind, coords: &[f64]) -> ([f64; 3], [f64; 3]) {
    let dim = kind.dim();
    let count = 3usize.pow(dim as u32);
    let element = element_for(kind);
    let mut shape = vec![0.0; kind.n_nodes()];
    let mut controls = Vec::with_capacity(count);
    for index in 0..count {
        let mut digits = index;
        let mut xi = [0.0; 3];
        for value in xi.iter_mut().take(dim) {
            *value = [-1.0, 0.0, 1.0][digits % 3];
            digits /= 3;
        }
        element.shape_at(xi, &mut shape);
        controls.push(std::array::from_fn(|k| {
            shape.iter().enumerate().map(|(node, value)| value * coords[3 * node + k]).sum()
        }));
    }
    for axis in 0..dim {
        let stride = 3usize.pow(axis as u32);
        for base in 0..count {
            if (base / stride).is_multiple_of(3) {
                let (low, middle, high) = (controls[base], controls[base + stride], controls[base + 2 * stride]);
                controls[base + stride] = std::array::from_fn(|k| 2.0 * middle[k] - 0.5 * (low[k] + high[k]));
            }
        }
    }
    bounds(controls)
}

/// Is `x` inside a conservative physical box for the element, up to relative slack? Linear
/// elements use their nodal hull. Quadratic elements use Bernstein controls because a curved
/// map can extend beyond every nodal coordinate while its Jacobian stays positive.
fn in_bbox(kind: ElementKind, coords: &[f64], x: [f64; 3]) -> bool {
    if coords.iter().any(|value| !value.is_finite()) || x.iter().any(|value| !value.is_finite()) {
        return true;
    }
    let (lo, hi) = match kind {
        ElementKind::Hex8
        | ElementKind::Tet4
        | ElementKind::Quad4
        | ElementKind::Tri3
        | ElementKind::Truss2
        | ElementKind::Beam2 => nodal_bounds(coords),
        ElementKind::Tet10 | ElementKind::Tri6 => simplex_control_bounds(kind, coords),
        ElementKind::Hex20 | ElementKind::Quad8 => tensor_control_bounds(kind, coords),
    };
    (0..3).all(|k| {
        let slack = BBOX_SLACK * (hi[k] - lo[k]).max(1.0);
        x[k] >= lo[k] - slack && x[k] <= hi[k] + slack
    })
}

/// `n` samples of a nodal field along the segment from `from` to `to`, as
/// `(s, value)` with `s` from 0 to 1; a sample outside the mesh has no value.
pub fn path(mesh: &Mesh, f: &FieldData, from: [f64; 3], to: [f64; 3], n: usize) -> Vec<(f64, Option<Vec<f64>>)> {
    let last = (n.max(2) - 1) as f64;
    (0..n.max(2))
        .map(|i| {
            let s = i as f64 / last;
            let x = [from[0] + s * (to[0] - from[0]), from[1] + s * (to[1] - from[1]), from[2] + s * (to[2] - from[2])];
            (s, probe(mesh, f, x).map(|(_, v)| v))
        })
        .collect()
}
