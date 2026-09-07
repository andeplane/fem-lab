//! `Problem`: the Model resolved to numbers on one Mesh, which is all the numerics ever see.
//!
//! `model.rs` holds the serialisable Model (named materials, Constraints with `Q<Length>`
//! values, Sets as predicates); everything here is SI `f64` with Sets already resolved to node
//! and face lists. `Engine::apply` builds one of these before it calls a procedure, so
//! assembly, the checks and the solvers never touch a name, a unit or a `Command` (plan A §6).

use std::collections::BTreeMap;

use femlab_geometry::Mesh;

use crate::command::{CoupleKind, Formulation};
use crate::error::{Error, ErrorCode};
use crate::fem::element::{ElementCtx, Material};
use crate::fem::heat::HeatLoad;
use crate::fem::loads::Load;
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
    /// Which of `ux, uy, uz` this Constraint holds (heat would use `dofs[0]`).
    pub dofs: [bool; 3],
    pub value: f64,
}

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
    /// A point mass attached to the face Set `faces`: `distributed` eliminates the point onto
    /// the face's weighted mean, `rigid` eliminates every face node onto the point. `node` is
    /// the point's own mesh node, resolved with the Mesh so the numerics never look a name up.
    Couple { name: String, point: String, node: u32, faces: String, kind: CoupleKind },
}

impl Coupling {
    /// The name the Command gave it, which every error and warning quotes.
    pub fn name(&self) -> &str {
        match self {
            Coupling::Bonded { name, .. } | Coupling::Couple { name, .. } => name,
        }
    }

    /// What an error calls it: a tie between Bodies is a contact, a point attachment a coupling.
    pub fn label(&self) -> &'static str {
        match self {
            Coupling::Bonded { .. } => "contact",
            Coupling::Couple { .. } => "coupling",
        }
    }

    /// The Sets it names, so `checks::all` can report an empty one before the pairing runs.
    pub fn sets(&self) -> [&str; 2] {
        match self {
            Coupling::Bonded { master, slave, .. } => [master, slave],
            Coupling::Couple { point, faces, .. } => [faces, point],
        }
    }

    /// The point mass it attaches, if it attaches one.
    pub fn point(&self) -> Option<&str> {
        match self {
            Coupling::Bonded { .. } => None,
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
    pub mesh: &'a Mesh,
    /// Every Set of the built Mesh, by name.
    pub sets: &'a BTreeMap<String, ResolvedSet>,
    /// The Body each element block came from, for error messages.
    pub body_of_block: &'a [String],
    /// Per block: index into `materials`, or `None` — which `checks::all` reports.
    pub material_of_block: Vec<Option<usize>>,
    pub materials: Vec<Material>,
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
    /// Unknowns per node: one temperature for a heat Step, else 3 displacements in 3D and 2 in
    /// every 2D idealisation.
    pub fn dofs_per_node(&self) -> usize {
        if self.heat {
            1
        } else {
            self.mesh.dim
        }
    }

    pub fn n_dofs(&self) -> usize {
        self.mesh.n_nodes() * self.dofs_per_node()
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
        Ok(ElementCtx {
            coords,
            material: self.material_of(elem)?,
            idealisation: self.idealisation.clone(),
            formulation: self.formulation,
            temperature: self.temperature.as_ref().map(|_| temperature),
            t_ref: self.temperature.as_ref().map_or(0.0, |(_, t)| *t),
        })
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

/// The `set.empty` error for a Set a Constraint or Load names.
pub fn empty_set(name: &str) -> Error {
    Error::new(ErrorCode::SetEmpty, format!("set '{name}' resolves to nothing on this mesh"))
        .at(format!("set '{name}'"))
        .suggest("geometry.nameFace")
}
