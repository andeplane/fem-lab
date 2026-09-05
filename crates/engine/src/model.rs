//! The Model: the complete, serialisable description of one analysis, in SI.
//! Only `Engine::dispatch` changes it. No mesh, no results: those are derived.

use std::collections::BTreeSet;

use femlab_geometry::{FacePredicate, QuadBlock, RefineBox, RegionPredicate, Shape};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::command::{Axis, Dof, Field, Formulation, ObjectKind, Procedure};
use crate::units::UnitSet;

/// Idealisation in SI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Idealisation {
    Solid3d,
    PlaneStress { thickness: f64 },
    PlaneStrain,
    Axisymmetric,
}

impl Idealisation {
    pub fn dim(&self) -> usize {
        match self {
            Idealisation::Solid3d => 3,
            _ => 2,
        }
    }
}

/// A Body: one named shape with a material.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Body {
    pub name: String,
    pub shape: Shape,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<String>,
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

/// A named Set from a predicate (auto face Sets are not stored: they follow the shapes).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NamedSet {
    pub name: String,
    pub source: SetSource,
}

/// An isotropic linear-elastic material, SI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Material {
    pub name: String,
    pub e: f64,
    pub nu: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rho: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpha: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub k: Option<f64>,
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
    Fix { dofs: Vec<Dof> },
    Prescribe { dof: Dof, value: f64 },
    Symmetry { normal: Axis },
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

/// Load kinds, SI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LoadKind {
    Pressure { on: String, value: f64 },
    Traction { on: String, total: [f64; 3] },
    Force { on: String, total: [f64; 3] },
    Gravity { g: [f64; 3] },
    Temperature { bodies: Vec<String>, value: f64, reference: f64 },
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
    /// The Set this load acts on, if any.
    pub fn set(&self) -> Option<&str> {
        match self {
            LoadKind::Pressure { on, .. } | LoadKind::Traction { on, .. } | LoadKind::Force { on, .. } => Some(on),
            LoadKind::Gravity { .. } | LoadKind::Temperature { .. } => None,
        }
    }
}

/// A Step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub name: String,
    pub procedure: Procedure,
    pub constraints: Vec<String>,
    pub loads: Vec<String>,
    pub output: Vec<Field>,
}

/// Mesher settings, SI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MesherSettings {
    Lattice {
        size: Option<f64>,
        counts: Option<[u32; 3]>,
    },
    /// Mapped blocks, which are their own geometry: `body` is the implicit Body they make.
    Mapped {
        body: String,
        blocks: Vec<QuadBlock>,
    },
    /// Free triangles inside the sketch of the Body `of`.
    Free {
        of: String,
        size: f64,
        refine: Vec<RefineBox>,
    },
    /// A 2D mesher swept into 3D.
    Sweep {
        base: Box<MesherSettings>,
        sweep: Sweep,
    },
}

/// How a swept mesher turns its 2D base into a 3D mesh; SI, but the angle stays in degrees.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Sweep {
    Extrude { layers: usize, height: f64 },
    Revolve { segments: usize, angle_deg: f64 },
}

impl MesherSettings {
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
    #[serde(default)]
    pub sets: Vec<NamedSet>,
    #[serde(default)]
    pub materials: Vec<Material>,
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
            sets: vec![],
            materials: vec![],
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
    pub fn material(&self, name: &str) -> Option<&Material> {
        self.materials.iter().find(|m| m.name == name)
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
            ObjectKind::Body => self.bodies.iter().map(|b| b.name.as_str()).collect(),
            ObjectKind::Material => self.materials.iter().map(|m| m.name.as_str()).collect(),
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
        if self.sets.iter().any(|s| s.name == set) {
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
        assert_eq!(Idealisation::Axisymmetric.dim(), 2);
        m.bodies.push(Body { name: "beam".into(), shape: Shape::Box { size: [1.0; 3] }, material: None });
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
        m.bodies.push(Body { name: "plain".into(), shape: Shape::Box { size: [1.0; 3] }, material: Some("s".into()) });
        let s = m.body_shape(m.body("plain").unwrap());
        assert_eq!(s, Shape::Named { name: "plain".into(), shape: Box::new(Shape::Box { size: [1.0; 3] }) });
        assert!(m.body("nope").is_none());
        assert!(m.material("x").is_none());
        assert!(m.constraint("x").is_none());
        assert!(m.load("x").is_none());
        assert!(m.step("x").is_none());
        m.materials.push(Material {
            name: "s".into(),
            e: 1.0,
            nu: 0.3,
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
    }
}
