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
use crate::fem::heat::HeatLoad;
use crate::fem::loads::Load;
use crate::fem::problem::{empty_set, no_material, Problem};
use crate::model::Idealisation;

/// A restricted rigid mode this small is not constrained at all.
const RIGID_TOL: f64 = 1e-10;

/// Every failing check, in the order a user should read them.
pub fn all(p: &Problem<'_>) -> Vec<Error> {
    let mut out = Vec::new();
    out.extend(missing_materials(p));
    out.extend(empty_sets(p));
    out.extend(inverted(p.mesh));
    out.extend(resolve(p).err());
    out.extend(if p.heat { unheld_temperature(p) } else { rigid_modes(p) });
    out
}

/// A heat Problem with no fixed temperature and no boundary that carries heat away in
/// proportion to the temperature: `(K + H) T = f` is singular, because adding a constant to `T`
/// changes nothing. This is the heat analogue of the rigid-body check (plan A §7). A radiating
/// face holds the temperature exactly as a convecting one does — its film is
/// `sigma eps (T + Tinf)(T^2 + Tinf^2)`, which is a film like any other.
fn unheld_temperature(p: &Problem<'_>) -> Option<Error> {
    let held = p.constraints.iter().any(|c| c.dofs[0]);
    let filmed = p.heat_loads.iter().any(holds_temperature);
    if held || filmed {
        return None;
    }
    Some(
        Error::new(
            ErrorCode::ConstraintRigidModes,
            "the temperature is not held anywhere: the Step has no fixed temperature and no convection or radiation boundary",
        )
        .at("constraints")
        .suggest("constraint.temperature on a Set, or load.convection or load.radiation on a face"),
    )
}

/// A load whose flux grows with the surface temperature, so it pins the temperature level.
fn holds_temperature(load: &HeatLoad) -> bool {
    match load {
        HeatLoad::Convection { .. } | HeatLoad::Radiation { .. } => true,
        HeatLoad::Flux { .. } | HeatLoad::Source { .. } => false,
    }
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

/// A Constraint or Load on a Set that resolved to nothing does nothing, silently.
fn empty_sets(p: &Problem<'_>) -> Vec<Error> {
    let named = p
        .constraints
        .iter()
        .map(|c| c.nodes.as_str())
        .chain(p.loads.iter().filter_map(Load::set))
        .chain(p.heat_loads.iter().filter_map(HeatLoad::set));
    named.filter(|n| p.sets.get(*n).is_none_or(|s| s.nodes.is_empty())).map(empty_set).collect()
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

/// A rigid motion: a translation along an axis, or an infinitesimal rotation about one.
enum Rigid {
    Translate(usize),
    Rotate(usize),
}

/// The rigid motions an idealisation actually has.
///
/// A plane body has two translations and the rotation in its plane. An axisymmetric body has
/// only the axial translation: moving it radially stretches every hoop, so a radial motion is
/// not free and demanding a constraint against it would be a false alarm.
fn rigid_list(id: &Idealisation) -> Vec<(&'static str, Rigid)> {
    match id {
        Idealisation::Axisymmetric => vec![("translation y", Rigid::Translate(1))],
        Idealisation::Solid3d => vec![
            ("translation x", Rigid::Translate(0)),
            ("translation y", Rigid::Translate(1)),
            ("translation z", Rigid::Translate(2)),
            ("rotation about x", Rigid::Rotate(0)),
            ("rotation about y", Rigid::Rotate(1)),
            ("rotation about z", Rigid::Rotate(2)),
        ],
        _ => vec![
            ("translation x", Rigid::Translate(0)),
            ("translation y", Rigid::Translate(1)),
            ("rotation about z", Rigid::Rotate(2)),
        ],
    }
}

/// The rigid modes of the mesh as DOF vectors, each unit-normalised over *every* DOF so that a
/// rotation (which scales with the model) and a translation (which does not) are comparable.
fn rigid_basis(mesh: &Mesh, id: &Idealisation) -> Vec<(&'static str, Vec<f64>)> {
    let dpn = mesh.dim;
    let (lo, hi) = mesh.bbox();
    let centre = [0.5 * (lo[0] + hi[0]), 0.5 * (lo[1] + hi[1]), 0.5 * (lo[2] + hi[2])];
    let n_nodes = mesh.n_nodes();
    let mut modes = Vec::new();
    for (name, motion) in rigid_list(id) {
        let mut v = vec![0.0; n_nodes * dpn];
        for node in 0..n_nodes {
            let x = mesh.node(node as u32);
            let r = [x[0] - centre[0], x[1] - centre[1], x[2] - centre[2]];
            let w = match motion {
                Rigid::Translate(a) => {
                    let mut t = [0.0; 3];
                    t[a] = 1.0;
                    t
                }
                // ω × r for the unit ω along axis `a`
                Rigid::Rotate(a) => [
                    if a == 1 { r[2] } else { 0.0 } - if a == 2 { r[1] } else { 0.0 },
                    if a == 2 { r[0] } else { 0.0 } - if a == 0 { r[2] } else { 0.0 },
                    if a == 0 { r[1] } else { 0.0 } - if a == 1 { r[0] } else { 0.0 },
                ],
            };
            for c in 0..dpn {
                v[node * dpn + c] = w[c];
            }
        }
        let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt();
        for x in v.iter_mut() {
            *x /= norm;
        }
        modes.push((name, v));
    }
    modes
}

/// Rigid modes the Constraints do not remove.
///
/// Restrict every rigid mode to the constrained DOFs and Gram–Schmidt the resulting columns: a
/// column whose remaining norm vanishes adds no new restriction, so some combination of the
/// modes leaves every constrained DOF at zero and the body can still move.
fn rigid_modes(p: &Problem<'_>) -> Option<Error> {
    let rc = resolve(p).ok()?;
    let held: Vec<usize> = rc.fixed.iter().map(|&(d, _)| d as usize).collect();
    let mut basis: Vec<Vec<f64>> = Vec::new();
    let mut free: Vec<&str> = Vec::new();
    for (name, mode) in rigid_basis(p.mesh, &p.idealisation) {
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
