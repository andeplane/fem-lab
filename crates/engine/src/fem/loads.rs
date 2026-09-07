//! Loads resolved to numbers, and the consistent nodal force vector they assemble into
//! (plan A §3.4).
//!
//! Everything here is per unit: a pressure in Pa, a traction in Pa, a nodal force in N *per
//! node*, gravity in m/s². The Model speaks in totals ("10 kN on this face"), and
//! `Engine::apply` divides by the Set's area or node count with [`face_set_area`] before it
//! builds the Problem, so the assembled forces really do sum to the total the user asked for:
//! the area is measured by the very quadrature the face load is integrated with.
//!
//! A temperature is not a Load here. It is a field on the Problem
//! ([`Problem::temperature`](crate::fem::problem::Problem::temperature)) because the element
//! subtracts `α ΔT` from the total strain before the material law sees it, so it enters
//! through the stiffness integral, not through the load vector.

use crate::error::Error;
use crate::fem::element::{element_for, FaceLoad};
use crate::fem::problem::Problem;
use crate::par;

/// Elements per parallel chunk of a body load; a constant, like the assembly's, so the
/// summation order never depends on the thread count.
const CHUNK: usize = 2048;

/// One resolved Load.
#[derive(Debug, Clone, PartialEq)]
pub enum Load {
    /// Uniform pressure on a face Set, positive into the surface.
    Pressure { faces: String, p: f64 },
    /// Uniform traction (force per unit area) on a face Set.
    Traction { faces: String, t: [f64; 3] },
    /// A force on *each* node of a Set.
    NodalForce { nodes: String, f: [f64; 3] },
    /// Gravity: `ρ g` over every element whose material has a density.
    Gravity { g: [f64; 3] },
    /// Circumferential traction `t_theta = c r` on a face Set, `c` chosen so the total torque
    /// delivered is exactly what `load.torque` asked for.
    Torque { faces: String, c: f64 },
}

impl Load {
    /// The Set this Load acts on, if any.
    pub fn set(&self) -> Option<&str> {
        match self {
            Load::Pressure { faces, .. } | Load::Traction { faces, .. } | Load::Torque { faces, .. } => Some(faces),
            Load::NodalForce { nodes, .. } => Some(nodes),
            Load::Gravity { .. } => None,
        }
    }
}

/// The applied force a Step carries, for the reaction balance and `query.result`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoadTotals {
    pub force: [f64; 3],
}

/// The measure a face Set integrates to: area in 3D, length times the idealisation's scale in
/// 2D (thickness for plane stress, `2π r` for an axisymmetric ring).
///
/// It is `∫ 1 dS` through the element's own face quadrature, so dividing a total force by it
/// and assembling the result back reproduces the total exactly, curved faces included.
pub fn face_set_area(p: &Problem<'_>, faces: &str) -> Result<f64, Error> {
    let set = p.set(faces)?;
    let dpn = p.dofs_per_node();
    let mut area = 0.0;
    let mut coords = Vec::new();
    let mut out = Vec::new();
    let mut t = Vec::new();
    for &face in &set.faces {
        let kind = p.mesh.kind_of(face.elem);
        coords.resize(kind.n_nodes() * 3, 0.0);
        out.clear();
        out.resize(kind.n_nodes() * dpn, 0.0);
        t.resize(kind.n_nodes(), 0.0);
        p.mesh.elem_coords(face.elem, &mut coords);
        p.gather_temperature(face.elem, &mut t);
        // One `?`: a face integral is pure geometry, so it fails only where the context does.
        p.ctx(face.elem, &coords, &t)
            .and_then(|c| element_for(kind).face_load(&c, face.local, FaceLoad::Traction([1.0, 0.0, 0.0]), &mut out))?;
        area += out.iter().step_by(dpn).sum::<f64>();
    }
    Ok(area)
}

/// `∫ r² dS` over a face Set, the sibling of [`face_set_area`] a `load.torque` divides its
/// requested total by: `T = ∫ r t_theta dS = c ∫ r² dS`, so `c = T / face_set_polar_moment`
/// delivers exactly the torque asked for, curved faces included.
pub fn face_set_polar_moment(p: &Problem<'_>, faces: &str) -> Result<f64, Error> {
    let set = p.set(faces)?;
    let mut moment = 0.0;
    for &face in &set.faces {
        moment += crate::fem::element::face_polar_moment(p.mesh, face, &p.idealisation);
    }
    Ok(moment)
}

/// Add every Load's consistent nodal forces into `f` and report the total applied force.
pub fn assemble_loads(p: &Problem<'_>, f: &mut [f64]) -> Result<LoadTotals, Error> {
    assemble(p, f, None)
}

/// Explicit dynamics uses its own lumped inertia for gravity: f_i = m_i g. Mixing the
/// consistent gravity vector with HRZ inertia accelerates higher-order nodes differently.
/// All other Loads keep the same assembly as a static Step. Mass is one value per DOF.
pub(crate) fn assemble_lumped_loads(p: &Problem<'_>, f: &mut [f64], mass: &[f64]) -> Result<LoadTotals, Error> {
    assemble(p, f, Some(mass))
}

fn assemble(p: &Problem<'_>, f: &mut [f64], mass: Option<&[f64]>) -> Result<LoadTotals, Error> {
    let dpn = p.dofs_per_node();
    let mut totals = [0.0; 3];
    for load in &p.loads {
        match load {
            Load::Pressure { faces, p: value } => face_load(p, faces, FaceLoad::Pressure(*value), f, &mut totals)?,
            Load::Traction { faces, t } => face_load(p, faces, FaceLoad::Traction(*t), f, &mut totals)?,
            Load::Torque { faces, c } => face_load(p, faces, FaceLoad::Torque(*c), f, &mut totals)?,
            Load::NodalForce { nodes, f: force } => {
                for &node in &p.set(nodes)?.nodes {
                    for c in 0..dpn {
                        f[node as usize * dpn + c] += force[c];
                        totals[c] += force[c];
                    }
                }
            }
            Load::Gravity { g } => match mass {
                Some(mass) => {
                    for (i, (force, m)) in f.iter_mut().zip(mass).enumerate() {
                        let value = m * g[i % dpn];
                        *force += value;
                        totals[i % dpn] += value;
                    }
                }
                None => body_load(p, *g, f, &mut totals)?,
            },
        }
    }
    Ok(LoadTotals { force: totals })
}

/// Consistent nodal forces of a pressure or traction over a face Set, face by face in the
/// Set's sorted order.
fn face_load(p: &Problem<'_>, faces: &str, load: FaceLoad, f: &mut [f64], totals: &mut [f64; 3]) -> Result<(), Error> {
    let dpn = p.dofs_per_node();
    let set = p.set(faces)?;
    let mut coords = Vec::new();
    let mut out = Vec::new();
    let mut t = Vec::new();
    for &face in &set.faces {
        let kind = p.mesh.kind_of(face.elem);
        coords.resize(kind.n_nodes() * 3, 0.0);
        out.clear();
        out.resize(kind.n_nodes() * dpn, 0.0);
        t.resize(kind.n_nodes(), 0.0);
        p.mesh.elem_coords(face.elem, &mut coords);
        p.gather_temperature(face.elem, &mut t);
        p.ctx(face.elem, &coords, &t).and_then(|c| element_for(kind).face_load(&c, face.local, load, &mut out))?;
        scatter(p, face.elem, &out, dpn, f, totals);
    }
    Ok(())
}

/// `∫ Nᵀ ρ g dV` over every element, in chunks: parallel inside a chunk, added in element
/// order, exactly like the stiffness assembly and for the same reason.
fn body_load(p: &Problem<'_>, g: [f64; 3], f: &mut [f64], totals: &mut [f64; 3]) -> Result<(), Error> {
    let dpn = p.dofs_per_node();
    for blk in &p.mesh.blocks {
        let element = element_for(blk.kind);
        let (nn, nd) = (blk.kind.n_nodes(), blk.kind.n_nodes() * dpn);
        for lo in (0..blk.n_elems()).step_by(CHUNK) {
            let hi = (lo + CHUNK).min(blk.n_elems());
            let parts = par::map_collect(hi - lo, |i| {
                let elem = blk.first_elem + (lo + i) as u32;
                let mut coords = vec![0.0; nn * 3];
                p.mesh.elem_coords(elem, &mut coords);
                let mut t = vec![0.0; nn];
                p.gather_temperature(elem, &mut t);
                let mut fe = vec![0.0; nd];
                p.ctx(elem, &coords, &t).and_then(|c| {
                    let rho = c.material.rho;
                    element.body_load(&c, &|_x| [rho * g[0], rho * g[1], rho * g[2]], &mut fe)
                })?;
                Ok::<_, Error>(fe)
            });
            for (i, part) in parts.into_iter().enumerate() {
                scatter(p, blk.first_elem + (lo + i) as u32, &part?, dpn, f, totals);
            }
        }
    }
    Ok(())
}

/// Add one element's nodal forces into the global vector and into the applied total.
fn scatter(p: &Problem<'_>, elem: u32, fe: &[f64], dpn: usize, f: &mut [f64], totals: &mut [f64; 3]) {
    for (a, &node) in p.mesh.elem_nodes(elem).iter().enumerate() {
        for c in 0..dpn {
            f[node as usize * dpn + c] += fe[a * dpn + c];
            totals[c] += fe[a * dpn + c];
        }
    }
}
