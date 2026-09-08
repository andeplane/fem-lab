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
use crate::fem::mpc::{self, Mpc};
use crate::fem::problem::{empty_set, no_material, no_section, Coupling, Problem};
use crate::model::Idealisation;

/// A restricted rigid mode this small is not constrained at all.
const RIGID_TOL: f64 = 1e-10;

/// Every failing check, in the order a user should read them.
pub fn all(p: &Problem<'_>) -> Vec<Error> {
    let mut out = Vec::new();
    out.extend(missing_materials(p));
    out.extend(misoriented_materials(p));
    out.extend(missing_sections(p));
    out.extend(empty_sets(p));
    out.extend(uncoupled_points(p));
    out.extend(inverted(p.mesh));
    out.extend(resolve(p).err());
    out.extend(unknown_thermal_contacts(p));
    if p.heat {
        out.extend(no_frictionless(p, "heat").err());
    }
    // The couplings are checked whatever the physics: a tie a heat Step cannot pair is as
    // broken as one a static Step cannot. Without a valid `Mpc` the rigid-body test would be
    // answering a different question, so it waits for the next run.
    match mpc::build(p) {
        Err(e) => out.push(e),
        Ok(m) => {
            out.extend(tied_and_held(p, &m));
            out.extend(if p.heat { unheld_temperature(p) } else { rigid_modes(p, &m) });
        }
    }
    out
}

/// A frictionless contact in a Step whose procedure has no active set to move it with, refused
/// by name. Heat has no gap to open; a modal, buckling or harmonic Step linearises about one
/// state and cannot say which nodes touch; explicit and implicit dynamics refuse every
/// multipoint constraint already.
pub fn no_frictionless(p: &Problem<'_>, procedure: &str) -> Result<(), Error> {
    match p.couplings.iter().find(|c| c.is_frictionless()) {
        None => Ok(()),
        Some(c) => Err(Error::unsupported(&format!(
            "frictionless contact '{}' in a {procedure} Step (the active set moves only in a static or static-nonlinear Step)",
            c.name()
        ))
        .at(format!("contact '{}'", c.name()))
        .suggest("step.add with procedure 'static', or contact.add with kind bonded")),
    }
}

/// A DOF that a Constraint prescribes and a coupling also eliminates: the two ask for different
/// things and the elimination would silently win.
fn tied_and_held(p: &Problem<'_>, mpc: &Mpc) -> Option<Error> {
    let rc = resolve(p).ok()?;
    let dpn = p.dofs_per_node();
    let (&(dof, _), &owner) =
        rc.fixed.iter().zip(&rc.owner).find(|(&(d, _), _)| mpc.slaves.binary_search(&d).is_ok())?;
    let row = &mpc.rows[mpc.slaves.binary_search(&dof).expect("the row that matched")];
    let comp = p.dof_labels()[dof as usize % dpn];
    let (c, tie) = (&p.constraints[owner].name, p.couplings[row.owner].name());
    Some(
        Error::new(
            ErrorCode::ConstraintConflict,
            format!(
                "'{c}' prescribes {comp} of node {} while contact '{tie}' ties it to another part",
                dof as usize / dpn
            ),
        )
        .at(format!("contact '{tie}'"))
        .suggest("constraint.remove one of them, or make the other face of the pair the slave"),
    )
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
        // A contact resistance ties two temperatures to each other, not either one to a fixed
        // level: two Bodies joined only by one still float together, exactly as an ordinary
        // bonded tie (which is not a heat load at all) already does.
        HeatLoad::Flux { .. } | HeatLoad::Source { .. } | HeatLoad::Contact { .. } => false,
    }
}

/// A `contact.thermal` names a contact this Step's Constraints do not include. Without this,
/// `heat::assemble` would have no Coupling to look the pairing up in and no lumped area to
/// weight it by; catching it here keeps that lookup total.
fn unknown_thermal_contacts(p: &Problem<'_>) -> Vec<Error> {
    p.heat_loads
        .iter()
        .filter_map(|l| match l {
            HeatLoad::Contact { of, .. } => Some(of.as_str()),
            HeatLoad::Convection { .. }
            | HeatLoad::Flux { .. }
            | HeatLoad::Source { .. }
            | HeatLoad::Radiation { .. } => None,
        })
        .filter(|of| !p.couplings.iter().any(|c| c.name() == *of))
        .map(|of| {
            Error::new(
                ErrorCode::ModelIllPosed,
                format!("contact.thermal names '{of}', which this Step's constraints do not list as a bonded contact"),
            )
            .at(format!("contact '{of}'"))
            .suggest("step.add listing the contact.add Constraint that contact.thermal names")
        })
        .collect()
}

/// A point mass nothing attaches to the model. It carries mass and no stiffness at all, so its
/// own rows of `K` are empty and the factorisation has nothing to work with there.
fn uncoupled_points(p: &Problem<'_>) -> Vec<Error> {
    p.points
        .iter()
        .filter(|pm| !p.couplings.iter().any(|c| c.point() == Some(pm.name.as_str())))
        .map(|pm| {
            Error::new(
                ErrorCode::ModelIllPosed,
                format!("point mass '{}' is attached to nothing: on its own it has no stiffness", pm.name),
            )
            .at(format!("point mass '{}'", pm.name))
            .suggest("constraint.couple it to a face Set, and list that Constraint in the Step")
        })
        .collect()
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

/// A material whose axes a 2D idealisation cannot carry.
///
/// `material.add` refuses the same thing outright, but `model.setIdealisation` can come after
/// the Material, so the pairing has to be checked again where the two meet. The Body is named
/// rather than the Material because that is the level at which the idealisation applies, and it
/// matches the heat-property checks.
fn misoriented_materials(p: &Problem<'_>) -> Vec<Error> {
    if p.idealisation.dim() == 3 {
        return Vec::new();
    }
    let mut bodies: Vec<&str> = p
        .material_of_block
        .iter()
        .enumerate()
        .filter(|(_, m)| {
            m.and_then(|m| p.materials[m].axes).is_some_and(|axes| !crate::fem::material::axes_are_planar(&axes))
        })
        .map(|(b, _)| p.body_of_block[b].as_str())
        .collect();
    bodies.dedup();
    bodies
        .into_iter()
        .map(|body| {
            Error::new(
                ErrorCode::ModelIllPosed,
                format!(
                    "Body '{body}' has a material whose axes are turned out of the plane: a 2D idealisation only \
                     allows a material orientation about the out-of-plane axis [0, 0, 1]"
                ),
            )
            .at(format!("body '{body}'"))
            .suggest("material.add with orientation.axis [0, 0, 1], or model.setIdealisation solid3d")
        })
        .collect()
}

/// A Body of line members with no Section: a member is a curve, so nothing else says how much
/// cross-sectional area carries the force.
fn missing_sections(p: &Problem<'_>) -> Vec<Error> {
    let mut bodies: Vec<&str> = p
        .mesh
        .blocks
        .iter()
        .enumerate()
        .filter(|(b, blk)| {
            (blk.kind.dim() == 1 || blk.kind == femlab_geometry::mesh::ElementKind::Shell4)
                && p.section_of_block[*b].is_none()
        })
        .map(|(b, _)| p.body_of_block[b].as_str())
        .collect();
    bodies.dedup();
    bodies.into_iter().map(no_section).collect()
}

/// A Constraint or Load on a Set that resolved to nothing does nothing, silently.
fn empty_sets(p: &Problem<'_>) -> Vec<Error> {
    let named = p
        .constraints
        .iter()
        .map(|c| c.nodes.as_str())
        .chain(p.couplings.iter().flat_map(Coupling::sets))
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

/// A rigid motion: a translation along an axis, an infinitesimal rotation about one, or the
/// axisymmetric twist idealisation's rigid rotation about its axis.
enum Rigid {
    Translate(usize),
    Rotate(usize),
    /// `u_theta = r`, measured from the axis (`x = 0`), not the bounding-box centre: the only
    /// zero-energy motion the twist DOF adds.
    AxisTwist,
}

/// The rigid motions an idealisation actually has.
///
/// A plane body has two translations and the rotation in its plane. An axisymmetric body has
/// only the axial translation: moving it radially stretches every hoop, so a radial motion is
/// not free and demanding a constraint against it would be a false alarm.
fn rigid_list(id: &Idealisation) -> Vec<(&'static str, Rigid)> {
    match id {
        Idealisation::Axisymmetric { twist: false } => vec![("translation y", Rigid::Translate(1))],
        // Every zero-energy motion twist adds is the same rotation about the axis, u_theta = r:
        // a rigid axial translation still strains nothing, and this is the only additional one
        // that strains nothing either.
        Idealisation::Axisymmetric { twist: true } => {
            vec![("translation y", Rigid::Translate(1)), ("rotation about the axis", Rigid::AxisTwist)]
        }
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
fn rigid_basis(mesh: &Mesh, id: &Idealisation, dpn: usize) -> Vec<(&'static str, Vec<f64>)> {
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
                Rigid::AxisTwist => [0.0, 0.0, x[0]],
            };
            for c in 0..dpn.min(3) {
                v[node * dpn + c] = w[c];
            }
            // A rigid rotation turns every beam joint by the same unit angle about the axis;
            // the inert rotations of the other nodes get it too and restrict nothing, because
            // `resolve` never lists them as held.
            if let (Rigid::Rotate(a), true) = (&motion, dpn > 3) {
                v[node * dpn + 3 + a] = 1.0;
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
///
/// A multipoint constraint restricts a mode too — the residual `mode[slave] − Σ a·mode[master]`
/// of every row is one more entry in the same column — which is what keeps a part held only
/// through a tie from being reported as floating.
fn rigid_modes(p: &Problem<'_>, mpc: &Mpc) -> Option<Error> {
    let rc = resolve(p).ok()?;
    let held: Vec<usize> = rc.fixed.iter().map(|&(d, _)| d as usize).collect();
    let mut basis: Vec<Vec<f64>> = Vec::new();
    let mut free: Vec<&str> = Vec::new();
    for (name, mode) in rigid_basis(p.mesh, &p.idealisation, p.dofs_per_node()) {
        let mut col: Vec<f64> =
            held.iter()
                .map(|&d| mode[d])
                .chain(mpc.rows.iter().map(|r| {
                    mode[r.slave as usize] - r.masters.iter().map(|&(m, a)| a * mode[m as usize]).sum::<f64>()
                }))
                .collect();
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
