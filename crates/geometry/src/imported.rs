//! Imported triangle-mesh geometry: welding a triangle soup into a solid, splitting its
//! surface into face patches at sharp edges, and point containment for the lattice mesher.
//!
//! A tessellated import is the deliverable half of CAD import (#350): `manifold-rust` is
//! already the geometry kernel here, so a welded mesh gets booleans, volume, area and genus
//! for free, and the only things it cannot give back are the exact surfaces a B-rep would
//! carry. Faces are therefore *patches*: connected runs of triangles that meet smoothly.

use std::collections::btree_map::Entry;
use std::collections::BTreeMap;
use std::sync::Arc;

use manifold_rust::linalg::Vec3;
use manifold_rust::manifold::Manifold;
use manifold_rust::types::MeshGL64;

use crate::solid::tri_normal;
use crate::GeomError;

/// Dihedral angle in degrees above which an edge separates two face patches.
pub const DEFAULT_FEATURE_ANGLE: f64 = 30.0;

/// Ceiling on an imported mesh: past this a Model stops being a document and a Journal stops
/// being replayable in a browser tab.
pub const MAX_TRIANGLES: usize = 500_000;

/// Weld a triangle soup into a solid with the kernel's robust mesh constructor, then
/// optionally collapse features below `simplify_below` metres.
pub(crate) fn to_manifold(
    positions: &[[f64; 3]],
    triangles: &[[u32; 3]],
    simplify_below: Option<f64>,
) -> Result<Manifold, GeomError> {
    let gl = MeshGL64 {
        num_prop: 3,
        vert_properties: positions.iter().flat_map(|p| *p).collect(),
        tri_verts: triangles.iter().flat_map(|t| t.map(u64::from)).collect(),
        ..Default::default()
    };
    // The robust constructor keeps a closed, orientable but non-manifold soup rather than
    // rejecting it, and a soup-backed manifold answers `simplify`, `genus` and every paired
    // query with an empty result. Refuse it here instead, with the status that explains why.
    let m = Manifold::from_mesh_gl64_robust(&gl);
    if m.status() != manifold_rust::types::Error::NoError || m.as_impl().is_soup {
        return Err(GeomError(format!(
            "the imported mesh is not a closed, orientable, manifold surface ({}); repair it in the tool that wrote it",
            m.status()
        )));
    }
    let m = match simplify_below {
        Some(t) if t > 0.0 => m.simplify(t),
        _ => m,
    };
    if m.is_empty() {
        return Err(GeomError("the imported mesh simplifies away to nothing; use a smaller simplifyBelow".into()));
    }
    Ok(m)
}

/// -0.0 and 0.0 are the same vertex.
fn bits(x: f64) -> u64 {
    (if x == 0.0 { 0.0 } else { x }).to_bits()
}

/// A tag per triangle of `gl`: connected patches of triangles that meet across edges whose
/// dihedral angle is below `feature_angle_deg`, named `face0`, `face1`, … largest total area
/// first with ties broken by the lowest triangle index, so the names are deterministic.
pub(crate) fn face_patches(gl: &MeshGL64, feature_angle_deg: f64) -> Vec<String> {
    let n = gl.num_tri();
    let pos: Vec<[f64; 3]> = (0..gl.num_vert()).map(|v| gl.get_vert_pos(v)).collect();
    // MeshGL splits a vertex whose properties differ between triangles; weld by exact
    // position so a patch never stops at such a seam.
    let mut canon: BTreeMap<[u64; 3], u32> = BTreeMap::new();
    let vid: Vec<u32> = pos
        .iter()
        .map(|p| {
            let next = canon.len() as u32;
            *canon.entry([bits(p[0]), bits(p[1]), bits(p[2])]).or_insert(next)
        })
        .collect();

    let mut tris: Vec<[u32; 3]> = Vec::with_capacity(n);
    let mut normals: Vec<[f64; 3]> = Vec::with_capacity(n);
    let mut areas: Vec<f64> = Vec::with_capacity(n);
    for t in 0..n {
        let v = gl.get_tri_verts(t);
        let (a, b, c) = (pos[v[0] as usize], pos[v[1] as usize], pos[v[2] as usize]);
        tris.push([vid[v[0] as usize], vid[v[1] as usize], vid[v[2] as usize]]);
        normals.push(tri_normal(a, b, c));
        areas.push(triangle_area(a, b, c));
    }

    let cos_lim = libm::cos(feature_angle_deg * std::f64::consts::PI / 180.0);
    let mut first: BTreeMap<(u32, u32), u32> = BTreeMap::new();
    let mut adj: Vec<Vec<u32>> = vec![Vec::new(); n];
    for t in 0..n {
        for k in 0..3 {
            let (a, b) = (tris[t][k], tris[t][(k + 1) % 3]);
            let key = if a < b { (a, b) } else { (b, a) };
            match first.entry(key) {
                Entry::Vacant(slot) => {
                    slot.insert(t as u32);
                }
                Entry::Occupied(slot) => {
                    let u = *slot.get() as usize;
                    let (p, q) = (normals[t], normals[u]);
                    if p[0] * q[0] + p[1] * q[1] + p[2] * q[2] >= cos_lim {
                        adj[t].push(u as u32);
                        adj[u].push(t as u32);
                    }
                }
            }
        }
    }

    // Flood fill in triangle order, so both the component ids and the summation order of
    // their areas are fixed by the input alone.
    let mut comp = vec![u32::MAX; n];
    let mut found: Vec<(f64, usize)> = Vec::new();
    for seed in 0..n {
        if comp[seed] != u32::MAX {
            continue;
        }
        let id = found.len() as u32;
        comp[seed] = id;
        let mut queue = vec![seed];
        let mut cursor = 0;
        let mut area = 0.0;
        while cursor < queue.len() {
            let t = queue[cursor];
            cursor += 1;
            area += areas[t];
            for &v in &adj[t] {
                if comp[v as usize] == u32::MAX {
                    comp[v as usize] = id;
                    queue.push(v as usize);
                }
            }
        }
        found.push((area, seed));
    }
    let mut order: Vec<u32> = (0..found.len() as u32).collect();
    order.sort_by(|a, b| {
        let (x, y) = (found[*a as usize], found[*b as usize]);
        y.0.total_cmp(&x.0).then(x.1.cmp(&y.1))
    });
    let mut name = vec![String::new(); found.len()];
    for (rank, id) in order.iter().enumerate() {
        name[*id as usize] = format!("face{rank}");
    }
    (0..n).map(|t| name[comp[t] as usize].clone()).collect()
}

fn triangle_area(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> f64 {
    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    0.5 * libm::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2])
}

/// Point containment for a solid with no analytic form: a ray cast against the evaluated
/// manifold, whose crossings the kernel counts with the same exact predicates its booleans
/// use, so a ray that grazes an edge is still counted once.
#[derive(Clone)]
pub struct MeshIndex {
    m: Arc<Manifold>,
    reach: f64,
}

impl std::fmt::Debug for MeshIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MeshIndex({} triangles)", self.m.num_tri())
    }
}

impl MeshIndex {
    pub(crate) fn new(m: Manifold) -> MeshIndex {
        let b = m.bounding_box();
        // Long enough to leave the body from any point inside it. An empty manifold gives
        // -inf here and answers every ray with no hits, which is the right answer for a
        // 2D sheet: its containment is analytic and never reaches this.
        let reach = (b.max.x - b.min.x) + (b.max.y - b.min.y) + (b.max.z - b.min.z) + 1.0;
        MeshIndex { m: Arc::new(m), reach }
    }

    /// True when an odd number of surface crossings lies between `p` and a point outside the
    /// body. The direction is deliberately not axis aligned, so a ray rarely runs along a
    /// facet of an axis-aligned import.
    // ponytail: one BVH ray cast per point, no batching and no caching, and a point exactly
    // on the surface is undefined either way. Batch the queries if a fine lattice over a
    // large import ever becomes the slow part.
    pub fn contains(&self, p: [f64; 3]) -> bool {
        // (1, 2, 3) / sqrt(14)
        const DIR: [f64; 3] = [0.2672612419124244, 0.5345224838248488, 0.8017837257372732];
        let end = Vec3::new(p[0] + self.reach * DIR[0], p[1] + self.reach * DIR[1], p[2] + self.reach * DIR[2]);
        self.m.ray_cast(Vec3::new(p[0], p[1], p[2]), end).len() % 2 == 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_and_negative_zero_are_one_vertex_and_areas_are_euclidean() {
        assert_eq!(bits(-0.0), bits(0.0));
        assert_ne!(bits(1.0), bits(-1.0));
        assert_eq!(triangle_area([0.0; 3], [2.0, 0.0, 0.0], [0.0, 3.0, 0.0]), 3.0);
    }
}
