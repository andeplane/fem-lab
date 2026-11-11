//! Endpoint thermal recovery. Keep each element's values separate at material interfaces.

use crate::error::Error;
use crate::fem::problem::Problem;
use crate::post::{stress::gp_to_nodes, FieldData, Per};

/// Recover at the same Gauss points as conduction, then fit the element's corner shapes
/// by least squares. This is extrapolation of its own solution, never nodal averaging.
pub fn fields(p: &Problem<'_>, temperature: &[f64]) -> Result<(FieldData, FieldData), Error> {
    let mut gradient = Vec::new();
    let mut flux = Vec::new();
    for blk in &p.mesh.blocks {
        for lo in (0..blk.n_elems()).step_by(2048) {
            let hi = (lo + 2048).min(blk.n_elems());
            let parts = crate::par::map_collect(hi - lo, |i| {
                let elem = blk.first_elem + (lo + i) as u32;
                let mut coords = vec![0.0; blk.kind.n_nodes() * 3];
                p.mesh.elem_coords(elem, &mut coords);
                let t: Vec<f64> = p.mesh.elem_nodes(elem).iter().map(|&n| temperature[n as usize]).collect();
                p.ctx(elem, &coords, &t).and_then(|c| crate::fem::heat::recover(blk.kind, &c, &t))
            });
            for part in parts {
                let (g, q) = part?;
                gradient.extend(g);
                flux.extend(q);
            }
        }
    }
    Ok((
        gp_to_nodes(p.mesh, &FieldData::new(Per::ElemGp, 3, gradient)),
        gp_to_nodes(p.mesh, &FieldData::new(Per::ElemGp, 3, flux)),
    ))
}
