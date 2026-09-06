//! Sampling a nodal field where the user points: one value at a point, or a line of them
//! (plan A §8).
//!
//! Point location is a bounding-box scan followed by a Newton inversion of the isoparametric
//! map, which is exact for a curved element and cheap enough at the rate a person clicks.
//! `// ponytail: linear scan; a kd-tree if probes ever get hot.`

use femlab_geometry::Mesh;

use crate::fem::element::{element_for, InverseMap};
use crate::post::FieldData;

/// How far outside its own bounding box an element is still considered, relative to the box.
const BBOX_SLACK: f64 = 1e-9;

/// The element containing `x` and the nodal field interpolated there, or `None` when the point
/// is outside the mesh. Ties (a point on a shared face) go to the lowest element id.
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
        if !in_bbox(&coords, x) {
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

/// Is `x` inside the box the element's nodes span, up to a relative slack?
fn in_bbox(coords: &[f64], x: [f64; 3]) -> bool {
    (0..3).all(|k| {
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        for p in coords.chunks_exact(3) {
            lo = lo.min(p[k]);
            hi = hi.max(p[k]);
        }
        let slack = BBOX_SLACK * (hi - lo).max(1.0);
        x[k] >= lo - slack && x[k] <= hi + slack
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
