//! `Problem`: the Model resolved to numbers on one Mesh, which is all the numerics ever see.
//!
//! `model.rs` holds the serialisable Model (named materials, Constraints with `Q<Length>`
//! values, Sets as predicates); everything here is SI `f64` with Sets already resolved to node
//! and face lists. `Engine::apply` builds one of these before it calls a procedure, so
//! assembly, the checks and the solvers never touch a name, a unit or a `Command` (plan A §6).

use std::collections::BTreeMap;

use femlab_geometry::mesh::ElementKind;
use femlab_geometry::Mesh;

use crate::command::{CoupleKind, Formulation};
use crate::error::{Error, ErrorCode};
use crate::fem::element::{ElementCtx, Material};
use crate::fem::heat::HeatLoad;
use crate::fem::loads::Load;
use crate::fem::section::Section;
use crate::mesh::ResolvedSet;
use crate::model::Idealisation;

/// One resolved Constraint: which Set, which components, and the value they take.
///
/// A `Fix` is every listed component at zero, a `Prescribe` one component at its value, a
/// `Symmetry` the normal component at zero — the three collapse to the same thing here, and
/// `name` survives so reactions can be reported per Constraint.
#[derive(Debug, Clone, PartialEq)]
pub struct Constraint {
    pub name: String,
    /// Name of the Set whose nodes are constrained.
    pub nodes: String,
    /// Which of `ux, uy, uz, rx, ry, rz` this Constraint holds (heat would use `dofs[0]`). The
    /// three rotations only ever reach a node a beam element touches; on every other node
    /// they are inert and [`crate::fem::assembly::resolve`] skips them.
    pub dofs: [bool; NODE_DOFS_MAX],
    pub value: f64,
}

/// The most unknowns any node carries: three displacements and three rotations.
pub const NODE_DOFS_MAX: usize = 6;

/// One resolved connection between parts: a linear relation between DOFs rather than a
/// prescribed value, turned into eliminated rows by [`crate::fem::mpc::build`].
///
/// Kept apart from [`Constraint`] because nothing about it resolves to `(dof, value)` pairs:
/// it has no value, it names two Sets, and it changes the operator instead of the right-hand
/// side. The Model stores both in `model.constraints`, so `constraint.remove`, `model.rename`
/// and a Step's constraint list work on it unchanged.
#[derive(Debug, Clone, PartialEq)]
pub enum Coupling {
    /// A bonded contact: every node of `slave` follows the point it projects onto in the face
    /// Set `master`, in every component. `tol` is the largest gap that still pairs, in metres.
    Bonded { name: String, master: String, slave: String, tol: f64 },
    /// A cyclic symmetry tie: every node of `to` is tied to the node it rotates onto in `from`,
    /// `angle` (radians) about the coordinate axis `axis` (0 = x, 1 = y, 2 = z) through
    /// `through`. The zero-harmonic condition (plan B §4): a structural DOF mixes its
    /// components under the rotation, a heat DOF (one per node) does not.
    Cyclic { name: String, from: String, to: String, axis: usize, through: [f64; 3], angle: f64, tol: f64 },
    /// A point mass attached to the face Set `faces`: `distributed` eliminates the point onto
    /// the face's weighted mean, `rigid` eliminates every face node onto the point. `node` is
    /// the point's own mesh node, resolved with the Mesh so the numerics never look a name up.
    Couple { name: String, point: String, node: u32, faces: String, kind: CoupleKind },
}

impl Coupling {
    /// The name the Command gave it, which every error and warning quotes.
    pub fn name(&self) -> &str {
        match self {
            Coupling::Bonded { name, .. } | Coupling::Cyclic { name, .. } | Coupling::Couple { name, .. } => name,
        }
    }

    /// What an error calls it: a tie between Bodies is a contact, a point attachment a coupling.
    pub fn label(&self) -> &'static str {
        match self {
            Coupling::Bonded { .. } => "contact",
            Coupling::Cyclic { .. } => "cyclic",
            Coupling::Couple { .. } => "coupling",
        }
    }

    /// The Sets it names, so `checks::all` can report an empty one before the pairing runs.
    pub fn sets(&self) -> [&str; 2] {
        match self {
            Coupling::Bonded { master, slave, .. } => [master, slave],
            Coupling::Cyclic { from, to, .. } => [from, to],
            Coupling::Couple { point, faces, .. } => [faces, point],
        }
    }

    /// The point mass it attaches, if it attaches one.
    pub fn point(&self) -> Option<&str> {
        match self {
            Coupling::Bonded { .. } | Coupling::Cyclic { .. } => None,
            Coupling::Couple { point, .. } => Some(point),
        }
    }
}

/// One resolved point mass: the Set name it owns, the node the Mesh builder gave it, and its
/// mass in kilograms. It has no element, so it reaches the numerics only through the mass
/// matrix, gravity, and whatever [`Coupling::Couple`] attaches it to.
#[derive(Debug, Clone, PartialEq)]
pub struct PointMass {
    pub name: String,
    pub node: u32,
    pub mass: f64,
}

/// Everything a procedure needs about one analysis: the Mesh, its Sets, the material of every
/// block, and the resolved Constraints and Loads.
pub struct Problem<'a> {
    /// Analytic directors per shell element; empty uses the element's own corner normals.
    pub directors: &'a [[[f64; 3]; 4]],
    pub mesh: &'a Mesh,
    /// Every Set of the built Mesh, by name.
    pub sets: &'a BTreeMap<String, ResolvedSet>,
    /// The Body each element block came from, for error messages.
    pub body_of_block: &'a [String],
    /// Per block: index into `materials`, or `None` — which `checks::all` reports.
    pub material_of_block: Vec<Option<usize>>,
    pub materials: Vec<Material>,
    /// Per block: index into `sections`, or `None`. A line block without one is reported by
    /// `checks::missing_sections`; a solid block never needs one.
    pub section_of_block: Vec<Option<usize>>,
    pub sections: Vec<Section>,
    /// Per block: the unit vector of the global axis its beams take their local z-axis from,
    /// or `None` for the default rule (`section.assign`'s `orientation`). Ignored by every
    /// other element.
    pub orientation_of_block: Vec<Option<[f64; 3]>>,
    pub idealisation: Idealisation,
    pub formulation: Formulation,
    pub constraints: Vec<Constraint>,
    /// Bonded contacts and the other multipoint constraints, in Step order.
    pub couplings: Vec<Coupling>,
    /// Lumped point masses, one node each, in Model order.
    pub points: Vec<PointMass>,
    pub loads: Vec<Load>,
    /// Nodal temperature and the reference temperature; `None` is no thermal strain.
    /// Registry Loads with different Body references use increments with a zero reference.
    pub temperature: Option<(Vec<f64>, f64)>,
    /// True when the unknown is temperature rather than displacement: one DOF per node, the
    /// heat kernels instead of the elastic ones, and `constraints[i].dofs[0]` the only
    /// component a Constraint can hold (plan A §6).
    pub heat: bool,
    /// Convection, flux and source loads; empty for a structural Step.
    pub heat_loads: Vec<HeatLoad>,
}

impl Problem<'_> {
    /// Unknowns per node — the **global** DOF stride: one temperature for a heat Step, six
    /// (three displacements and three rotations) as soon as the Mesh holds a beam block, else
    /// whatever the idealisation carries (3 displacements in 3D, 2 in a plane idealisation, 3
    /// under axisymmetric twist). Every assembly and post-processing path takes its stride
    /// from here; an element's own matrices use [`Problem::node_dofs`] of its kind, and the
    /// gather/scatter in `assembly` maps between the two, so a solid next to a beam still
    /// integrates its `3 × n_nodes` matrix and never sees the rotations.
    pub fn dofs_per_node(&self) -> usize {
        if self.heat {
            1
        } else {
            mesh_dofs_per_node(self.mesh, &self.idealisation)
        }
    }

    /// The unknowns per node an element of `kind` carries in its own matrices: six for a beam,
    /// the idealisation's count for everything else (a truss is a solid's three).
    pub fn node_dofs(&self, kind: ElementKind) -> usize {
        local_dofs(kind, self.dofs_per_node())
    }

    /// Does the Mesh hold a beam block, which is what widens the stride to six.
    pub fn has_beams(&self) -> bool {
        self.mesh.blocks.iter().any(|b| b.kind == ElementKind::Beam2)
    }

    /// Per node: does a beam or shell element reach it, so its three rotations are real unknowns. On
    /// every other node of a six-DOF Problem the rotations are inert: no element gives them
    /// stiffness or mass, so [`crate::fem::assembly::resolve`] lists them as `inert` and the
    /// reduction drops them exactly like a DOF fixed at zero.
    pub fn rotational_nodes(&self) -> Vec<bool> {
        let mut out = vec![false; self.mesh.n_nodes()];
        for blk in self.mesh.blocks.iter().filter(|b| b.kind == ElementKind::Beam2 || b.kind == ElementKind::Shell4) {
            for &n in &blk.conn {
                out[n as usize] = true;
            }
        }
        out
    }

    /// The inert rotational DOFs of a six-DOF Problem, ascending: rotations of nodes no beam or shell
    /// reaches. Empty unless the stride is six.
    pub fn inert_dofs(&self) -> Vec<u32> {
        if self.dofs_per_node() != NODE_DOFS_MAX {
            return Vec::new();
        }
        let rot = self.rotational_nodes();
        let mut out = Vec::new();
        for (node, &has) in rot.iter().enumerate() {
            if !has {
                out.extend((3..NODE_DOFS_MAX).map(|c| (node * NODE_DOFS_MAX + c) as u32));
            }
        }
        out
    }

    pub fn n_dofs(&self) -> usize {
        self.mesh.n_nodes() * self.dofs_per_node()
    }

    /// The component names an error names a DOF by, indexed the same way `dofs_per_node`
    /// counts them: `ur`/`uz`/`utheta` under axisymmetric (the third only ever reached with
    /// twist), `ux`/`uy`/`uz` and the rotations `rx`/`ry`/`rz` everywhere else.
    pub fn dof_labels(&self) -> [&'static str; NODE_DOFS_MAX] {
        dof_labels(&self.idealisation)
    }

    /// The material of an element, or the `model.no-material` error naming its Body.
    pub fn material_of(&self, elem: u32) -> Result<&Material, Error> {
        let block = self.mesh.block_of(elem).0;
        match self.material_of_block[block] {
            Some(i) => Ok(&self.materials[i]),
            None => Err(no_material(&self.body_of_block[block])),
        }
    }

    /// The element context for one element: its gathered coordinates, its material, the
    /// idealisation and formulation of the Model, and the nodal temperature if there is one.
    /// `temperature` is the element's gathered nodal temperature, ignored when the Problem
    /// has no temperature field.
    pub fn ctx<'b>(&'b self, elem: u32, coords: &'b [f64], temperature: &'b [f64]) -> Result<ElementCtx<'b>, Error> {
        let block = self.mesh.block_of(elem).0;
        Ok(ElementCtx {
            directors: self.directors.get(elem as usize).copied(),
            coords,
            material: self.material_of(elem)?,
            section: self.section_of_block[block].map(|i| &self.sections[i]),
            orientation: self.orientation_of_block[block],
            gravity: self.gravity(),
            idealisation: self.idealisation.clone(),
            formulation: self.formulation,
            temperature: self.temperature.as_ref().map(|_| temperature),
            t_ref: self.temperature.as_ref().map_or(0.0, |(_, t)| *t),
        })
    }

    /// The sum of every gravity Load's acceleration: the body force per unit density a beam
    /// subtracts its fixed-end forces for when it recovers section forces.
    pub fn gravity(&self) -> [f64; 3] {
        let mut g = [0.0; 3];
        for l in &self.loads {
            if let Load::Gravity { g: gl } = l {
                for k in 0..3 {
                    g[k] += gl[k];
                }
            }
        }
        g
    }

    /// The nodal temperature of one element gathered into `out`; a no-op when the Problem has
    /// no temperature field.
    pub fn gather_temperature(&self, elem: u32, out: &mut [f64]) {
        if let Some((t, _)) = &self.temperature {
            for (i, &n) in self.mesh.elem_nodes(elem).iter().enumerate() {
                out[i] = t[n as usize];
            }
        }
    }

    /// A Set by name, or `set.empty` naming it. An unknown Set cannot reach here through a
    /// Command — `constraint.*` and `load.*` validate the name against the Model — so this is
    /// the same error an empty Set gets.
    pub fn set(&self, name: &str) -> Result<&ResolvedSet, Error> {
        self.sets.get(name).ok_or_else(|| empty_set(name))
    }
}

/// The `model.no-material` error for one Body.
pub fn no_material(body: &str) -> Error {
    Error::new(ErrorCode::ModelNoMaterial, format!("body '{body}' has no material"))
        .at(format!("body '{body}'"))
        .suggest("material.assign")
}

/// The `model.no-section` error for a Body whose elements require a Section.
pub fn no_section(body: &str) -> Error {
    Error::new(ErrorCode::ModelNoSection, format!("body '{body}' needs a section but has none"))
        .at(format!("body '{body}'"))
        .suggest("section.add, then section.assign")
}

/// The `set.empty` error for a Set a Constraint or Load names.
pub fn empty_set(name: &str) -> Error {
    Error::new(ErrorCode::SetEmpty, format!("set '{name}' resolves to nothing on this mesh"))
        .at(format!("set '{name}'"))
        .suggest("geometry.nameFace")
}

/// The DOF component names an error message quotes, indexed `dof % dofs_per_node`: `ur`/`uz`
/// (and, with twist, `utheta`) under axisymmetric, `ux`/`uy`/`uz` and the rotations
/// `rx`/`ry`/`rz` everywhere else.
pub fn dof_labels(id: &Idealisation) -> [&'static str; NODE_DOFS_MAX] {
    match id {
        Idealisation::Axisymmetric { .. } => ["ur", "uz", "utheta", "rx", "ry", "rz"],
        _ => ["ux", "uy", "uz", "rx", "ry", "rz"],
    }
}

/// The structural unknowns per node of a Mesh under an idealisation: six once it holds a beam
/// or shell block, else the idealisation's own count. [`Problem::dofs_per_node`] for a structural Step,
/// and what `query.mesh` and `query.cost` count with before any Problem exists.
pub fn mesh_dofs_per_node(mesh: &Mesh, id: &Idealisation) -> usize {
    if mesh.blocks.iter().any(|b| b.kind == ElementKind::Beam2 || b.kind == ElementKind::Shell4) {
        NODE_DOFS_MAX
    } else {
        id.dofs_per_node()
    }
}

/// The unknowns per node an element of `kind` carries in its own matrices, given the global
/// stride `dofs_per_node`. The only stride an element narrows is six: a solid or a truss next
/// to a beam still integrates three displacements per node, and the assembler's gather and
/// scatter leave the rotational slots of its nodes untouched.
pub fn local_dofs(kind: ElementKind, dofs_per_node: usize) -> usize {
    if dofs_per_node == NODE_DOFS_MAX && kind != ElementKind::Beam2 && kind != ElementKind::Shell4 {
        3
    } else {
        dofs_per_node
    }
}
