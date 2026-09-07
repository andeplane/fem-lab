//! The Model: the complete, serialisable description of one analysis, in SI.
//! Only `Engine::dispatch` changes it. No mesh, no results: those are derived.

use std::collections::{BTreeMap, BTreeSet};

use femlab_geometry::{FacePredicate, QuadBlock, RefineBox, RegionPredicate, Shape};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::command::{Axis, CoupleKind, Dof, Field, Formulation, ObjectKind, Procedure, SweepSpacing};
use crate::fem::section::Section;
use crate::units::UnitSet;

/// Idealisation in SI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Idealisation {
    Solid3d,
    PlaneStress {
        thickness: f64,
    },
    PlaneStrain,
    Axisymmetric {
        /// Adds a third degree of freedom, the circumferential displacement u_theta, so the
        /// section can carry torsion. With twist, the third component of a vector Command is
        /// the circumferential direction. Defaults to false, so every Journal and saved Model
        /// written before this field existed still loads, and an untwisted axisymmetric Model
        /// serialises byte-identically to before (`MeshSettings::simplices`'s convention).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        twist: bool,
    },
}

impl Idealisation {
    pub fn dim(&self) -> usize {
        match self {
            Idealisation::Solid3d => 3,
            _ => 2,
        }
    }

    /// Unknowns per node for a structural (non-heat) Step: 3 with axisymmetric twist, else the
    /// spatial dimension. `Problem::dofs_per_node` delegates here so the stride generalises in
    /// one place for every element kernel, assembly and post-processing path.
    pub fn dofs_per_node(&self) -> usize {
        match self {
            Idealisation::Axisymmetric { twist: true } => 3,
            _ => self.dim(),
        }
    }
}

/// A Body: one named shape with a material, and a Section when it is made of line members.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Body {
    pub name: String,
    pub shape: Shape,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<String>,
    /// The cross-section of its line members; unused by a solid or sheet Body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
}

/// A named cross-section, resolved to SI properties by the section library.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NamedSection {
    pub name: String,
    pub section: Section,
}

/// A cut out of a Body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Cut {
    pub name: String,
    pub from: String,
    pub shape: Shape,
}

/// How a named Set is defined.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SetSource {
    Face {
        of: String,
        #[serde(rename = "where")]
        where_: FacePredicate,
    },
    Region {
        #[serde(rename = "where")]
        where_: RegionPredicate,
    },
}

/// A lumped mass at a point: a node of its own with no element around it, and a node Set of its
/// own name so Constraints, Loads and Queries can target it by that name. `at` is in metres and
/// `mass` in kilograms.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PointMass {
    pub name: String,
    pub at: [f64; 3],
    pub mass: f64,
}

/// A named Set from a predicate (auto face Sets are not stored: they follow the shapes).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NamedSet {
    pub name: String,
    pub source: SetSource,
}

/// Orthotropic stiffness in the material axes, SI, major Poisson convention.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Orthotropic {
    #[serde(rename = "E1")]
    pub e1: f64,
    #[serde(rename = "E2")]
    pub e2: f64,
    #[serde(rename = "E3")]
    pub e3: f64,
    #[serde(rename = "G12")]
    pub g12: f64,
    #[serde(rename = "G13")]
    pub g13: f64,
    #[serde(rename = "G23")]
    pub g23: f64,
    pub nu12: f64,
    pub nu13: f64,
    pub nu23: f64,
}

impl Orthotropic {
    /// The nine values in [`ORTHOTROPIC_PROPS`](crate::fem::material::ORTHOTROPIC_PROPS) order.
    pub fn props(&self) -> Vec<f64> {
        vec![self.e1, self.e2, self.e3, self.g12, self.g13, self.g23, self.nu12, self.nu13, self.nu23]
    }
}

/// Where a Material's axes point: `angle` radians about the unit `axis`, SI.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Orientation {
    pub axis: [f64; 3],
    pub angle: f64,
}

impl Orientation {
    /// The rotation whose rows are the material axes in global coordinates.
    pub fn rows(&self) -> [[f64; 3]; 3] {
        crate::fem::material::axis_angle_rotation(self.axis, self.angle)
    }
}

/// A property given once (isotropic: every material axis the same) or once per material axis.
/// It is stored as it was given, so an isotropic Material serialises the single number it always
/// had and saved files, Journal hashes and the tree editor see no change from orthotropic support.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Axial {
    Isotropic(f64),
    Axes([f64; 3]),
}

impl Axial {
    /// The value along each of the three material axes.
    pub fn axes(self) -> [f64; 3] {
        match self {
            Axial::Isotropic(v) => [v; 3],
            Axial::Axes(a) => a,
        }
    }
}

/// A material, SI: isotropic or orthotropic, with optional axes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Material {
    pub name: String,
    /// Isotropic stiffness; `None` exactly when `orthotropic` is given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub e: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nu: Option<f64>,
    /// Orthotropic stiffness in the material axes; `None` exactly when `e`/`nu` are given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orthotropic: Option<Orthotropic>,
    /// Where the material axes point; `None` means they are the global axes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orientation: Option<Orientation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rho: Option<f64>,
    /// Thermal expansion, one value or one per material axis.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpha: Option<Axial>,
    /// Conductivity, one value or one per material axis.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub k: Option<Axial>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cp: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yield_: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// Constraint kinds, SI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConstraintKind {
    Fix {
        dofs: Vec<Dof>,
    },
    Prescribe {
        dof: Dof,
        value: f64,
    },
    Symmetry {
        normal: Axis,
    },
    /// A held temperature, in kelvin: the Dirichlet boundary of a heat Step.
    Temperature {
        value: f64,
    },
    /// A bonded contact: the Constraint's own Set is the slave, `master` names the face Set it
    /// is tied to, and `tol` is the largest pairing gap in metres (`None` scales with the Mesh).
    Bonded {
        master: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tol: Option<f64>,
    },
    /// A point mass attached to the Constraint's own face Set: `distributed` makes the point
    /// follow the face's weighted mean displacement, `rigid` makes every node of the face
    /// follow the point. `point` names a [`PointMass`]; the field is not called `kind` because
    /// that tag already names the Constraint kind itself.
    Couple {
        point: String,
        coupling: CoupleKind,
    },
}

/// A Constraint on a Set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Constraint {
    pub name: String,
    pub on: String,
    #[serde(flatten)]
    pub kind: ConstraintKind,
}

impl Constraint {
    /// Every Set this Constraint names: the one it holds, and a bonded tie's master face. One
    /// accessor, so a rename or an in-use check can never miss the second one.
    pub fn sets(&self) -> Vec<&str> {
        let mut out = vec![self.on.as_str()];
        match &self.kind {
            ConstraintKind::Bonded { master, .. } => out.push(master),
            ConstraintKind::Couple { point, .. } => out.push(point),
            ConstraintKind::Fix { .. }
            | ConstraintKind::Prescribe { .. }
            | ConstraintKind::Symmetry { .. }
            | ConstraintKind::Temperature { .. } => {}
        }
        out
    }

    /// The same Sets, for a rename to rewrite in place.
    pub fn sets_mut(&mut self) -> Vec<&mut String> {
        let mut out = vec![&mut self.on];
        match &mut self.kind {
            ConstraintKind::Bonded { master, .. } => out.push(master),
            ConstraintKind::Couple { point, .. } => out.push(point),
            ConstraintKind::Fix { .. }
            | ConstraintKind::Prescribe { .. }
            | ConstraintKind::Symmetry { .. }
            | ConstraintKind::Temperature { .. } => {}
        }
        out
    }
}

/// Load kinds, SI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LoadKind {
    Pressure {
        on: String,
        value: f64,
    },
    Traction {
        on: String,
        total: [f64; 3],
    },
    Force {
        on: String,
        total: [f64; 3],
    },
    Gravity {
        g: [f64; 3],
    },
    Temperature {
        bodies: Vec<String>,
        value: f64,
        reference: f64,
    },
    Convection {
        on: String,
        h: f64,
        t_inf: f64,
    },
    Radiation {
        on: String,
        emissivity: f64,
        t_inf: f64,
    },
    HeatFlux {
        on: String,
        q: f64,
    },
    HeatSource {
        bodies: Vec<String>,
        q: f64,
    },
    /// Torsional traction on a face Set of an axisymmetric-with-twist Model, `total` newton
    /// metres delivered exactly via `t_theta = c r` (see `face_set_polar_moment`).
    Torque {
        on: String,
        total: f64,
    },
    /// A finite conductance across the bonded contact `of`, replacing its perfect thermal tie.
    ThermalContact {
        of: String,
        h: f64,
    },
}

/// A Load.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Load {
    pub name: String,
    #[serde(flatten)]
    pub kind: LoadKind,
}

impl LoadKind {
    /// Explicit Body targets, independent of the Set targeted by a surface or nodal load.
    pub fn bodies(&self) -> &[String] {
        match self {
            LoadKind::Temperature { bodies, .. } | LoadKind::HeatSource { bodies, .. } => bodies,
            LoadKind::Pressure { .. }
            | LoadKind::Traction { .. }
            | LoadKind::Force { .. }
            | LoadKind::Gravity { .. }
            | LoadKind::Convection { .. }
            | LoadKind::Radiation { .. }
            | LoadKind::HeatFlux { .. }
            | LoadKind::Torque { .. }
            | LoadKind::ThermalContact { .. } => &[],
        }
    }

    /// The Set this load acts on, if any. A thermal contact names a Constraint instead — see
    /// [`LoadKind::constraint`] — so it answers `None` here like Gravity or a Body-targeted load.
    pub fn set(&self) -> Option<&str> {
        match self {
            LoadKind::Pressure { on, .. }
            | LoadKind::Traction { on, .. }
            | LoadKind::Force { on, .. }
            | LoadKind::Convection { on, .. }
            | LoadKind::Radiation { on, .. }
            | LoadKind::HeatFlux { on, .. }
            | LoadKind::Torque { on, .. } => Some(on),
            LoadKind::Gravity { .. }
            | LoadKind::Temperature { .. }
            | LoadKind::HeatSource { .. }
            | LoadKind::ThermalContact { .. } => None,
        }
    }

    /// The Constraint a thermal contact overrides, for `model.rename` and the in-use check
    /// `constraint.remove` runs — the one reference a Load makes to a Constraint rather than a
    /// Set or a Body.
    pub fn constraint(&self) -> Option<&str> {
        match self {
            LoadKind::ThermalContact { of, .. } => Some(of),
            LoadKind::Pressure { .. }
            | LoadKind::Traction { .. }
            | LoadKind::Force { .. }
            | LoadKind::Gravity { .. }
            | LoadKind::Temperature { .. }
            | LoadKind::Convection { .. }
            | LoadKind::Radiation { .. }
            | LoadKind::HeatFlux { .. }
            | LoadKind::HeatSource { .. }
            | LoadKind::Torque { .. } => None,
        }
    }
}

/// A time function scaling the prescribed temperatures of a transient Step, SI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Amplitude {
    Sine { amplitude: f64, period: f64 },
    Table { t: Vec<f64>, value: Vec<f64> },
}

/// A uniform initial velocity on a Set of nodes, SI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InitialVelocity {
    pub on: String,
    pub value: [f64; 3],
}

/// A Step. Everything after `output` belongs to one procedure each and is `None` for the rest;
/// `after` names the Step whose Result this one continues (plan B §2.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub name: String,
    pub procedure: Procedure,
    pub constraints: Vec<String>,
    pub loads: Vec<String>,
    pub output: Vec<Field>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub n_modes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shift: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dt: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub t_end: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theta: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_every: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dt_factor: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amplitude: Option<Amplitude>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub increments: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_cutbacks: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonlinear_tolerance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonlinear_max_iterations: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub f_start: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub f_stop: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub points: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sweep: Option<SweepSpacing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub damping_ratio: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpha: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rayleigh_alpha: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rayleigh_beta: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_velocity: Option<Vec<InitialVelocity>>,
}

/// Mesher settings, SI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MesherSettings {
    Lattice {
        size: Option<f64>,
        counts: Option<[u32; 3]>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        sizes: BTreeMap<String, f64>,
    },
    /// Mapped blocks, which are their own geometry: `body` is the implicit Body they make.
    Mapped { body: String, blocks: Vec<QuadBlock> },
    /// Free triangles inside the sketch of the Body `of`.
    Free { of: String, size: f64, refine: Vec<RefineBox> },
    /// A 2D mesher swept into 3D.
    Sweep { base: Box<MesherSettings>, sweep: Sweep },
}

/// How a swept mesher turns its 2D base into a 3D mesh; SI, but the angle stays in degrees.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Sweep {
    Extrude { layers: usize, height: f64 },
    Revolve { segments: usize, angle_deg: f64 },
}

impl MesherSettings {
    /// Rename the Body identity owned or referenced by this mesher, including sweep bases.
    pub fn rename_body(&mut self, from: &str, to: &str) {
        match self {
            Self::Mapped { body, .. } | Self::Free { of: body, .. } => {
                if body == from {
                    *body = to.into();
                }
            }
            Self::Sweep { base, .. } => base.rename_body(from, to),
            Self::Lattice { sizes, .. } => {
                if let Some(size) = sizes.remove(from) {
                    sizes.insert(to.into(), size);
                }
            }
        }
    }

    /// Whether removing a Body would leave a dangling mesher reference.
    pub fn references_body(&self, name: &str) -> bool {
        match self {
            Self::Lattice { sizes, .. } => sizes.contains_key(name),
            Self::Sweep { base, .. } => base.references_body(name),
            _ => self.source_body() == Some(name),
        }
    }

    /// An explicit Body used as geometry, rather than the implicit Body a mesher owns.
    pub fn source_body(&self) -> Option<&str> {
        match self {
            Self::Free { of, .. } => Some(of),
            Self::Sweep { base, .. } => base.source_body(),
            Self::Mapped { .. } | Self::Lattice { .. } => None,
        }
    }

    /// The Body a mesher makes on its own, without a `geometry.add`: the mapped mesher's.
    pub fn implicit_body(&self) -> Option<&str> {
        match self {
            MesherSettings::Lattice { .. } => None,
            MesherSettings::Mapped { body, .. } => Some(body),
            MesherSettings::Free { .. } => None,
            MesherSettings::Sweep { base, .. } => base.implicit_body(),
        }
    }
}

/// Mesh settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeshSettings {
    pub mesher: MesherSettings,
    pub order: u8,
    pub formulation: Formulation,
    /// Split the chosen mesher's quads/hexes into triangles/tetrahedra.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub simplices: bool,
}

/// A Plugin used by the Model (phase P).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecord {
    pub name: String,
    pub sha256: String,
}

/// The Model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub units: UnitSet,
    pub idealisation: Idealisation,
    #[serde(default)]
    pub bodies: Vec<Body>,
    #[serde(default)]
    pub cuts: Vec<Cut>,
    /// Lumped point masses, each also a node Set of its own name. Omitted when empty, so a
    /// Model without one hashes exactly as it did before point masses existed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<PointMass>,
    #[serde(default)]
    pub sets: Vec<NamedSet>,
    #[serde(default)]
    pub materials: Vec<Material>,
    /// Skipped when empty, so a Model with no line members hashes exactly as it did before
    /// Sections existed and every committed Journal hash still holds.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sections: Vec<NamedSection>,
    #[serde(default)]
    pub constraints: Vec<Constraint>,
    #[serde(default)]
    pub loads: Vec<Load>,
    #[serde(default)]
    pub steps: Vec<Step>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh: Option<MeshSettings>,
    /// The material of the mesher's implicit Body. The mapped mesher *is* its own geometry, so
    /// there is no [`Body`] record to carry the assignment; `material.assign` names that Body
    /// like any other and the name lands here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesher_material: Option<String>,
    #[serde(default)]
    pub plugins: Vec<PluginRecord>,
}

impl Model {
    pub fn new(name: &str) -> Model {
        Model {
            name: name.to_string(),
            description: None,
            units: UnitSet::default(),
            idealisation: Idealisation::Solid3d,
            bodies: vec![],
            cuts: vec![],
            points: vec![],
            sets: vec![],
            materials: vec![],
            sections: vec![],
            constraints: vec![],
            loads: vec![],
            steps: vec![],
            mesh: None,
            mesher_material: None,
            plugins: vec![],
        }
    }

    pub fn body(&self, name: &str) -> Option<&Body> {
        self.bodies.iter().find(|b| b.name == name)
    }
    pub fn point(&self, name: &str) -> Option<&PointMass> {
        self.points.iter().find(|p| p.name == name)
    }
    pub fn material(&self, name: &str) -> Option<&Material> {
        self.materials.iter().find(|m| m.name == name)
    }
    pub fn section(&self, name: &str) -> Option<&NamedSection> {
        self.sections.iter().find(|s| s.name == name)
    }
    pub fn constraint(&self, name: &str) -> Option<&Constraint> {
        self.constraints.iter().find(|c| c.name == name)
    }
    pub fn load(&self, name: &str) -> Option<&Load> {
        self.loads.iter().find(|l| l.name == name)
    }
    pub fn step(&self, name: &str) -> Option<&Step> {
        self.steps.iter().find(|s| s.name == name)
    }

    /// The Body the current mesher invents, if it is one that is its own geometry.
    pub fn implicit_body(&self) -> Option<&str> {
        self.mesh.as_ref().and_then(|m| m.mesher.implicit_body())
    }

    /// The material assigned to a Body, whether that is a [`Body`] record or the mesher's
    /// implicit Body, whose assignment lives in [`Model::mesher_material`].
    pub fn material_of_body(&self, body: &str) -> Option<&str> {
        match self.body(body) {
            Some(b) => b.material.as_deref(),
            None => self.mesher_material.as_deref().filter(|_| self.implicit_body() == Some(body)),
        }
    }

    /// The effective shape of a Body: its shape minus its cuts, with names for auto face tags.
    pub fn body_shape(&self, body: &Body) -> Shape {
        let cuts: Vec<Shape> = self
            .cuts
            .iter()
            .filter(|c| c.from == body.name)
            .map(|c| Shape::Named { name: c.name.clone(), shape: Box::new(c.shape.clone()) })
            .collect();
        let inner = if cuts.is_empty() {
            body.shape.clone()
        } else {
            Shape::Subtract { from: Box::new(body.shape.clone()), cut: cuts }
        };
        Shape::Named { name: body.name.clone(), shape: Box::new(inner) }
    }

    /// Names of every object of a kind, in Model order.
    pub fn names(&self, kind: ObjectKind) -> Vec<&str> {
        match kind {
            ObjectKind::Body => self.bodies.iter().map(|b| b.name.as_str()).chain(self.implicit_body()).collect(),
            ObjectKind::Material => self.materials.iter().map(|m| m.name.as_str()).collect(),
            ObjectKind::Section => self.sections.iter().map(|s| s.name.as_str()).collect(),
            ObjectKind::Set => self.sets.iter().map(|s| s.name.as_str()).collect(),
            ObjectKind::Constraint => self.constraints.iter().map(|c| c.name.as_str()).collect(),
            ObjectKind::Load => self.loads.iter().map(|l| l.name.as_str()).collect(),
            ObjectKind::Step => self.steps.iter().map(|s| s.name.as_str()).collect(),
        }
    }

    /// Every Set name a Constraint or Load may refer to *without* meshing: named Sets plus the
    /// bodies' and cuts' names as prefixes (auto faces are `<prefix>.<tag>`; the tag part is
    /// checked when the mesh is built).
    pub fn set_prefixes(&self) -> BTreeSet<String> {
        self.bodies
            .iter()
            .map(|b| b.name.clone())
            .chain(self.cuts.iter().map(|c| c.name.clone()))
            .chain(self.mesh.iter().filter_map(|m| m.mesher.implicit_body().map(str::to_string)))
            .collect()
    }

    /// Does a Set reference resolve to something the Model knows (a named Set, or an auto face
    /// `<body-or-cut>.<tag>`)? Tags are validated against the shape when meshing.
    pub fn knows_set(&self, set: &str) -> bool {
        if self.sets.iter().any(|s| s.name == set) || self.points.iter().any(|p| p.name == set) {
            return true;
        }
        match set.rsplit_once('.') {
            Some((prefix, tag)) => !tag.is_empty() && self.set_prefixes().contains(prefix),
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookups_and_shapes() {
        let mut m = Model::new("t");
        assert_eq!(m.idealisation.dim(), 3);
        assert_eq!(Idealisation::PlaneStrain.dim(), 2);
        assert_eq!(Idealisation::PlaneStress { thickness: 0.1 }.dim(), 2);
        assert_eq!(Idealisation::Axisymmetric { twist: false }.dim(), 2);
        assert_eq!(Idealisation::Axisymmetric { twist: true }.dim(), 2);
        assert_eq!(m.idealisation.dofs_per_node(), 3);
        assert_eq!(Idealisation::PlaneStrain.dofs_per_node(), 2);
        assert_eq!(Idealisation::Axisymmetric { twist: false }.dofs_per_node(), 2);
        assert_eq!(Idealisation::Axisymmetric { twist: true }.dofs_per_node(), 3);
        m.bodies.push(Body {
            name: "beam".into(),
            shape: Shape::Box { size: [1.0; 3] },
            material: None,
            section: None,
        });
        m.cuts.push(Cut { name: "hole".into(), from: "beam".into(), shape: Shape::Box { size: [0.1; 3] } });
        m.cuts.push(Cut { name: "other".into(), from: "plate".into(), shape: Shape::Box { size: [0.1; 3] } });
        let s = m.body_shape(m.body("beam").unwrap());
        assert_eq!(
            s,
            Shape::Named {
                name: "beam".into(),
                shape: Box::new(Shape::Subtract {
                    from: Box::new(Shape::Box { size: [1.0; 3] }),
                    cut: vec![Shape::Named { name: "hole".into(), shape: Box::new(Shape::Box { size: [0.1; 3] }) }],
                }),
            }
        );
        m.bodies.push(Body {
            name: "plain".into(),
            shape: Shape::Box { size: [1.0; 3] },
            material: Some("s".into()),
            section: None,
        });
        let s = m.body_shape(m.body("plain").unwrap());
        assert_eq!(s, Shape::Named { name: "plain".into(), shape: Box::new(Shape::Box { size: [1.0; 3] }) });
        assert!(m.body("nope").is_none());
        assert!(m.material("x").is_none());
        assert!(m.constraint("x").is_none());
        assert!(m.load("x").is_none());
        assert!(m.step("x").is_none());
        m.materials.push(Material {
            name: "s".into(),
            e: Some(1.0),
            nu: Some(0.3),
            orthotropic: None,
            orientation: None,
            rho: None,
            alpha: None,
            k: None,
            cp: None,
            yield_: None,
            source: None,
        });
        m.constraints.push(Constraint {
            name: "fix".into(),
            on: "beam.xmin".into(),
            kind: ConstraintKind::Fix { dofs: vec![Dof::Ux] },
        });
        m.loads.push(Load { name: "p".into(), kind: LoadKind::Pressure { on: "beam.xmax".into(), value: 1.0 } });
        m.loads.push(Load { name: "g".into(), kind: LoadKind::Gravity { g: [0.0, 0.0, -9.81] } });
        m.steps.push(Step {
            name: "st".into(),
            procedure: Procedure::Static,
            constraints: vec![],
            loads: vec![],
            output: vec![],
            after: None,
            n_modes: None,
            shift: None,
            dt: None,
            t_end: None,
            theta: None,
            output_every: None,
            dt_factor: None,
            amplitude: None,
            initial: None,
            increments: None,
            max_cutbacks: None,
            nonlinear_tolerance: None,
            nonlinear_max_iterations: None,
            f_start: None,
            f_stop: None,
            points: None,
            sweep: None,
            damping_ratio: None,
            alpha: None,
            rayleigh_alpha: None,
            rayleigh_beta: None,
            initial_velocity: None,
        });
        m.sets.push(NamedSet {
            name: "top".into(),
            source: SetSource::Region { where_: RegionPredicate::Body { name: "beam".into() } },
        });
        assert!(
            m.material("s").is_some()
                && m.constraint("fix").is_some()
                && m.load("p").is_some()
                && m.step("st").is_some()
        );
        assert_eq!(m.names(ObjectKind::Body), ["beam", "plain"]);
        assert_eq!(m.names(ObjectKind::Material), ["s"]);
        assert_eq!(m.names(ObjectKind::Set), ["top"]);
        assert_eq!(m.names(ObjectKind::Constraint), ["fix"]);
        assert_eq!(m.names(ObjectKind::Load), ["p", "g"]);
        assert_eq!(m.names(ObjectKind::Step), ["st"]);
        assert_eq!(m.loads[0].kind.set(), Some("beam.xmax"));
        assert_eq!(m.loads[1].kind.set(), None);
        assert_eq!(LoadKind::Traction { on: "a".into(), total: [0.0; 3] }.set(), Some("a"));
        assert_eq!(LoadKind::Force { on: "a".into(), total: [0.0; 3] }.set(), Some("a"));
        assert_eq!(LoadKind::Temperature { bodies: vec![], value: 300.0, reference: 293.15 }.set(), None);
        assert_eq!(LoadKind::Torque { on: "a".into(), total: 100.0 }.set(), Some("a"));
        for kind in [
            LoadKind::Pressure { on: "a".into(), value: 1.0 },
            LoadKind::Traction { on: "a".into(), total: [0.0; 3] },
            LoadKind::Force { on: "a".into(), total: [0.0; 3] },
            LoadKind::Gravity { g: [0.0; 3] },
            LoadKind::Convection { on: "a".into(), h: 1.0, t_inf: 300.0 },
            LoadKind::Radiation { on: "a".into(), emissivity: 0.8, t_inf: 300.0 },
            LoadKind::HeatFlux { on: "a".into(), q: 1.0 },
            LoadKind::Torque { on: "a".into(), total: 100.0 },
            LoadKind::ThermalContact { of: "weld".into(), h: 500.0 },
        ] {
            assert!(kind.bodies().is_empty());
        }
        for kind in [
            LoadKind::Temperature { bodies: vec!["beam".into(), "plain".into()], value: 300.0, reference: 293.15 },
            LoadKind::HeatSource { bodies: vec!["beam".into(), "plain".into()], q: 1.0 },
        ] {
            assert_eq!(kind.bodies(), &["beam", "plain"]);
        }
        // A thermal contact names a Constraint, not a Set or a Body: the odd one out among the
        // three cross-reference accessors.
        let contact = LoadKind::ThermalContact { of: "weld".into(), h: 500.0 };
        assert_eq!(contact.set(), None);
        assert_eq!(contact.constraint(), Some("weld"));
        for kind in [
            LoadKind::Pressure { on: "a".into(), value: 1.0 },
            LoadKind::Traction { on: "a".into(), total: [0.0; 3] },
            LoadKind::Force { on: "a".into(), total: [0.0; 3] },
            LoadKind::Gravity { g: [0.0; 3] },
            LoadKind::Temperature { bodies: vec![], value: 300.0, reference: 293.15 },
            LoadKind::Convection { on: "a".into(), h: 1.0, t_inf: 300.0 },
            LoadKind::Radiation { on: "a".into(), emissivity: 0.8, t_inf: 300.0 },
            LoadKind::HeatFlux { on: "a".into(), q: 1.0 },
            LoadKind::HeatSource { bodies: vec![], q: 1.0 },
        ] {
            assert_eq!(kind.constraint(), None);
        }
        assert!(m.knows_set("top"));
        assert!(m.knows_set("beam.xmin"));
        assert!(m.knows_set("hole.side"));
        assert!(!m.knows_set("nope.xmin"));
        assert!(!m.knows_set("beam."));
        assert!(!m.knows_set("beam"));
        let j = serde_json::to_string(&m).unwrap();
        let back: Model = serde_json::from_str(&j).unwrap();
        assert_eq!(back, m);
        assert!(j.contains(r#""kind":"fix""#) && j.contains(r#""kind":"pressure""#));
        let minimal: Model = serde_json::from_str(r#"{"name":"x","idealisation":{"kind":"solid3d"}}"#).unwrap();
        assert!(minimal.bodies.is_empty());
        // A Model saved before `twist` existed has no such field in its JSON; the serde
        // default must still load it, at twist: false.
        let old: Model = serde_json::from_str(r#"{"name":"x","idealisation":{"kind":"axisymmetric"}}"#).unwrap();
        assert_eq!(old.idealisation, Idealisation::Axisymmetric { twist: false });
        let twisted: Model =
            serde_json::from_str(r#"{"name":"x","idealisation":{"kind":"axisymmetric","twist":true}}"#).unwrap();
        assert_eq!(twisted.idealisation, Idealisation::Axisymmetric { twist: true });
    }
}
