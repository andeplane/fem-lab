//! `Problem`: the Model resolved to numbers on one Mesh, which is all the numerics ever see.
//!
//! `model.rs` holds the serialisable Model (named materials, Constraints with `Q<Length>`
//! values, Sets as predicates); everything here is SI `f64` with Sets already resolved to node
//! and face lists. `Engine::apply` builds one of these before it calls a procedure, so
//! assembly, the checks and the solvers never touch a name, a unit or a `Command` (plan A §6).

use std::collections::BTreeMap;

use femlab_geometry::Mesh;

use crate::command::Formulation;
use crate::error::{Error, ErrorCode};
use crate::fem::element::{ElementCtx, Material};
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
    pub loads: Vec<Load>,
    /// Nodal temperature and the reference temperature; `None` is no thermal strain.
    pub temperature: Option<(Vec<f64>, f64)>,
}

impl Problem<'_> {
    /// Displacement components per node: 3 in 3D, 2 in every 2D idealisation.
    pub fn dofs_per_node(&self) -> usize {
        self.mesh.dim
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
