//! The line mesher: joints and the straight members between them into two-node line elements.
//!
//! A line Body is its own mesh — there is no `Solid` to lattice, because a member has no
//! volume. `points` are the joints, `members` the index pairs between them, and each member is
//! divided into `divisions` elements of equal length. Node numbering is the joints first, in
//! the order given, then each member's interior nodes in member order, so the mesh is a pure
//! function of the input and replays identically.
//!
//! Every joint gets its own node set `p0 … pN`, which is what a Constraint or a nodal Load
//! targets. Interior nodes get no set: they are subdivision, not geometry.

use std::collections::BTreeMap;

use crate::mesh::{ElementBlock, ElementKind, Mesh};
use crate::GeomError;

/// Is this a line mesher input? Fewer than two joints, an out-of-range or self-referential
/// member, a zero-length or non-finite member, or zero divisions are all rejected here, so the
/// Shape and the mesher report the same cause.
pub fn check(points: &[[f64; 3]], members: &[[u32; 2]], divisions: u32) -> Result<(), GeomError> {
    if points.len() < 2 {
        return Err(GeomError(format!("a line body needs at least 2 points, got {}", points.len())));
    }
    if points.iter().flatten().any(|x| !x.is_finite()) {
        return Err(GeomError("a line body has a non-finite point".into()));
    }
    if members.is_empty() {
        return Err(GeomError("a line body needs at least one member".into()));
    }
    if divisions == 0 {
        return Err(GeomError("divisions must be at least 1".into()));
    }
    let n = points.len() as u32;
    for (i, m) in members.iter().enumerate() {
        if m[0] >= n || m[1] >= n {
            return Err(GeomError(format!("member {i} references point {} but there are {n} points", m[0].max(m[1]))));
        }
        if m[0] == m[1] {
            return Err(GeomError(format!("member {i} joins point {} to itself", m[0])));
        }
        if sq_length(points[m[0] as usize], points[m[1] as usize]) == 0.0 {
            return Err(GeomError(format!("member {i} has zero length: its two points coincide")));
        }
    }
    Ok(())
}

fn sq_length(a: [f64; 3], b: [f64; 3]) -> f64 {
    (0..3).map(|k| (a[k] - b[k]) * (a[k] - b[k])).sum()
}

/// One block of `kind` line elements over `members`, in a 3D mesh, with a node set per joint.
pub fn line(points: &[[f64; 3]], members: &[[u32; 2]], divisions: u32, kind: ElementKind) -> Result<Mesh, GeomError> {
    check(points, members, divisions)?;
    let mut coords: Vec<f64> = points.iter().flatten().copied().collect();
    let mut conn: Vec<u32> = Vec::with_capacity(members.len() * divisions as usize * 2);
    for m in members {
        let (a, b) = (points[m[0] as usize], points[m[1] as usize]);
        let mut left = m[0];
        for d in 1..=divisions {
            let right = if d == divisions {
                m[1]
            } else {
                let t = f64::from(d) / f64::from(divisions);
                coords.extend((0..3).map(|k| a[k] + t * (b[k] - a[k])));
                (coords.len() / 3 - 1) as u32
            };
            conn.push(left);
            conn.push(right);
            left = right;
        }
    }
    let node_sets: BTreeMap<String, Vec<u32>> = (0..points.len() as u32).map(|i| (format!("p{i}"), vec![i])).collect();
    Ok(Mesh {
        dim: 3,
        coords,
        blocks: vec![ElementBlock { kind, conn, first_elem: 0 }],
        node_sets,
        elem_sets: BTreeMap::new(),
        face_sets: BTreeMap::new(),
    })
}
