//! Well-posedness: everything that makes a solve meaningless, checked before it starts and
//! reported as an Error that names the fix (plan A §7).
//!
//! [`all`] runs every check and returns every failure, because `query.model.warnings` lists
//! them all while `solve.run` refuses with the first. None of them factorises anything: the
//! rigid-body test is a rank test on six vectors restricted to the constrained DOFs, which is
//! exact for a linear problem — a rigid mode survives exactly when it vanishes on every
//! constrained DOF.

use femlab_geometry::Mesh;

use crate::error::{Error, ErrorCode};
use crate::fem::assembly::resolve;
use crate::fem::element::min_det_j;
use crate::fem::problem::{empty_set, no_material, Problem};

/// A restricted rigid mode this small is not constrained at all.
const RIGID_TOL: f64 = 1e-10;

/// Every failing check, in the order a user should read them.
pub fn all(p: &Problem<'_>) -> Vec<Error> {
    let mut out = Vec::new();
    out.extend(missing_materials(p));
    out.extend(empty_sets(p));
    out.extend(inverted(p.mesh));
    out.extend(resolve(p).err());
    out.extend(rigid_modes(p));
    out
}

/// A Body whose blocks have no material: nothing can be integrated over it.
fn missing_materials(p: &Problem<'_>) -> Vec<Error> {
    let mut bodies: Vec<&str> = p
        .material_of_block
        .iter()
        .enumerate()
        .filter(|(_, m)| m.is_none())
        .map(|(b, _)| p.body_of_block[b].as_str())
        .collect();
    bodies.dedup();
    bodies.into_iter().map(no_material).collect()
}

/// A Constraint on a Set that resolved to nothing does nothing, silently.
fn empty_sets(p: &Problem<'_>) -> Vec<Error> {
    p.constraints
        .iter()
        .filter(|c| p.sets.get(&c.nodes).is_none_or(|s| s.nodes.is_empty()))
        .map(|c| empty_set(&c.nodes))
        .collect()
}

/// A folded or degenerate element: the same Gauss-point `det J` the integrals use, so a mesh
/// that passes this check assembles. The first bad element in mesh order is the one reported.
fn inverted(mesh: &Mesh) -> Option<Error> {
    let dets = crate::par::map_collect(mesh.n_elems(), |e| {
        let kind = mesh.kind_of(e as u32);
        let mut coords = vec![0.0; kind.n_nodes() * 3];
        mesh.elem_coords(e as u32, &mut coords);
        min_det_j(kind, &coords)
    });
    let elem = dets.iter().position(Option::is_none)?;
    Some(
        Error::new(ErrorCode::MeshInverted, format!("element {elem} is folded: det J is not positive"))
            .at(format!("element {elem}"))
            .suggest("mesh.set with a smaller element size, or move the geometry off itself"),
    )
}

/// The rigid modes of the mesh, unit-normalised over every DOF so translations and rotations
/// are comparable: the `dim` translations, then the rotations about the mesh centroid (three
/// in 3D, the one about z in 2D). Names are in the same order.
fn rigid_basis(mesh: &Mesh, dpn: usize) -> Vec<(&'static str, Vec<f64>)> {
    const NAMES_3D: [&str; 6] =
        ["translation x", "translation y", "translation z", "rotation about x", "rotation about y", "rotation about z"];
    const NAMES_2D: [&str; 3] = ["translation x", "translation y", "rotation about z"];
    let (lo, hi) = mesh.bbox();
    let centre = [0.5 * (lo[0] + hi[0]), 0.5 * (lo[1] + hi[1]), 0.5 * (lo[2] + hi[2])];
    let n_nodes = mesh.n_nodes();
    // Axis `k` of the rotation each mode is; translations come first.
    let axes: Vec<usize> = if dpn == 3 { vec![0, 1, 2] } else { vec![2] };
    let names: &[&'static str] = if dpn == 3 { &NAMES_3D } else { &NAMES_2D };
    let mut modes: Vec<(&'static str, Vec<f64>)> = Vec::with_capacity(names.len());
    for (c, name) in names.iter().enumerate().take(dpn) {
        let mut v = vec![0.0; n_nodes * dpn];
        for node in 0..n_nodes {
            v[node * dpn + c] = 1.0;
        }
        modes.push((name, v));
    }
    for (i, &k) in axes.iter().enumerate() {
        let mut v = vec![0.0; n_nodes * dpn];
        for node in 0..n_nodes {
            let x = mesh.node(node as u32);
            let r = [x[0] - centre[0], x[1] - centre[1], x[2] - centre[2]];
            // ω × r for the unit ω along axis k
            let w = [
                if k == 1 { r[2] } else { 0.0 } - if k == 2 { r[1] } else { 0.0 },
                if k == 2 { r[0] } else { 0.0 } - if k == 0 { r[2] } else { 0.0 },
                if k == 0 { r[1] } else { 0.0 } - if k == 1 { r[0] } else { 0.0 },
            ];
            for c in 0..dpn {
                v[node * dpn + c] = w[c];
            }
        }
        modes.push((names[dpn + i], v));
    }
    for (_, v) in modes.iter_mut() {
        let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt();
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
    modes
}

/// Rigid modes the Constraints do not remove.
///
/// Restrict every rigid mode to the constrained DOFs and Gram–Schmidt the resulting columns: a
/// column whose remaining norm vanishes adds no new restriction, so some combination of the
/// modes leaves every constrained DOF at zero and the body can still move.
fn rigid_modes(p: &Problem<'_>) -> Option<Error> {
    let dpn = p.dofs_per_node();
    let rc = resolve(p).ok()?;
    let held: Vec<usize> = rc.fixed.iter().map(|&(d, _)| d as usize).collect();
    let mut basis: Vec<Vec<f64>> = Vec::new();
    let mut free: Vec<&str> = Vec::new();
    for (name, mode) in rigid_basis(p.mesh, dpn) {
        let mut col: Vec<f64> = held.iter().map(|&d| mode[d]).collect();
        for b in &basis {
            let dot: f64 = col.iter().zip(b).map(|(x, y)| x * y).sum();
            for (x, y) in col.iter_mut().zip(b) {
                *x -= dot * y;
            }
        }
        let norm = col.iter().map(|x| x * x).sum::<f64>().sqrt();
        if norm < RIGID_TOL {
            free.push(name);
        } else {
            for x in col.iter_mut() {
                *x /= norm;
            }
            basis.push(col);
        }
    }
    if free.is_empty() {
        return None;
    }
    Some(
        Error::new(
            ErrorCode::ConstraintRigidModes,
            format!("the model can still move as a rigid body: {}", free.join(", ")),
        )
        .at("constraints")
        .suggest("constraint.fix on a Set that removes it"),
    )
}
