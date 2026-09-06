//! The Command enum: every way to change a Model (ADR 0003). Doc comments are the AI's tool
//! descriptions, so they say what, when, the effect on names and Sets, and the common mistake.
//! Physical values are `Q<D>` (unit strings); lengths inside shapes too.

use femlab_geometry::{
    Affine3, FacePredicate as GeoFacePredicate, RegionPredicate as GeoRegionPredicate, Segment, Shape, Sketch,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::error::Error;
use crate::units::{
    Acceleration, Conductivity, Density, Force, HeatFlux, HeatSource, HeatTransfer, Length, SpecificHeat, Stress,
    Temperature, ThermalExpansion, Time, UnitSet, Q,
};

/// A named Set: an auto face name (`beam.xmin`), a `geometry.nameFace` or `geometry.nameRegion` name.
pub type SetRef = String;

/// A displacement component.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Dof {
    Ux,
    Uy,
    Uz,
}

impl Dof {
    pub fn index(self) -> usize {
        match self {
            Dof::Ux => 0,
            Dof::Uy => 1,
            Dof::Uz => 2,
        }
    }
}

/// A coordinate axis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    X,
    Y,
    Z,
}

impl Axis {
    pub fn index(self) -> usize {
        match self {
            Axis::X => 0,
            Axis::Y => 1,
            Axis::Z => 2,
        }
    }
}

/// Kinds of nameable objects in a Model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ObjectKind {
    Body,
    Material,
    Set,
    Constraint,
    Load,
    Step,
}

impl ObjectKind {
    pub fn label(self) -> &'static str {
        match self {
            ObjectKind::Body => "body",
            ObjectKind::Material => "material",
            ObjectKind::Set => "set",
            ObjectKind::Constraint => "constraint",
            ObjectKind::Load => "load",
            ObjectKind::Step => "step",
        }
    }
}

/// Analysis procedures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Procedure {
    /// Linear static equilibrium.
    Static,
    /// Natural frequencies and mode shapes; needs `rho` on every Material and `nModes`.
    Modal,
    /// Steady heat conduction with convection, flux and source boundaries; needs `k`.
    HeatSteady,
    /// Transient heat conduction by the θ-method; needs `k`, `rho`, `cp`, `dt` and `tEnd`.
    HeatTransient,
    /// Explicit dynamics by central differences; needs `rho`, `tEnd` and a `dtFactor` below 1.
    Explicit,
}

/// A scalar `g(t)` that scales every prescribed temperature of a transient Step.
///
/// Commands are replayed from the Journal, so a time function is data, never a closure: it is
/// either a sine or a piecewise-linear table, and nothing else.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AmplitudeSpec {
    /// `amplitude · sin(2π t / period)`. NAFEMS T3's `100 sin(π t / 40)` is a prescribed
    /// temperature of "100 K" with `amplitude: 1` and `period: "80 s"`.
    Sine { amplitude: f64, period: Q<Time> },
    /// Piecewise-linear through the points `(t[i], value[i])`, held flat outside the table.
    /// `t` must be ascending and the two arrays the same length.
    Table { t: Vec<Q<Time>>, value: Vec<f64> },
}

/// Linear solver choice. `auto` picks the sparse direct factorisation up to 200 000 equations
/// (100 000 in the browser, where the heap is smaller) and above that a conjugate gradient
/// inside an f64 iterative-refinement loop — on the GPU when the host granted one, on the CPU
/// otherwise. `cpu-direct` is exact and is what to fall back to when a solve reports
/// `solve.stalled`; `cpu-pcg` and `gpu-pcg` force the iterative paths at any size.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Solver {
    #[default]
    Auto,
    CpuDirect,
    CpuPcg,
    GpuPcg,
}

/// Result fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Field {
    Displacement,
    Stress,
    StressUnaveraged,
    VonMises,
    Principal,
    Strain,
    Reaction,
    Temperature,
}

/// Element formulation for linear hexahedra and quadrilaterals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Formulation {
    /// Wilson–Taylor incompatible modes: a linear element that bends (default).
    #[default]
    IncompatibleModes,
    /// Full integration: the textbook linear element, which locks in bending.
    Full,
}

/// How a 3D world is reduced, if at all.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum IdealisationSpec {
    /// Full three-dimensional solids (the default).
    Solid3d,
    /// Thin 2D body in the xy plane with free z surfaces; `thickness` scales stiffness and loads.
    PlaneStress { thickness: Q<Length> },
    /// Long 2D body in the xy plane with zero z strain.
    PlaneStrain,
    /// Axisymmetric 2D body: x is the radius (x ≥ 0), y the axis of revolution.
    Axisymmetric,
}

/// Where a lattice mesh gets its element size: one size, or counts per direction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum LatticeSize {
    Size(Q<Length>),
    Counts { nx: u32, ny: u32, nz: u32 },
}

/// The shape of one edge of a mapped block, between the two corners it joins.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CurveSpec {
    /// The straight segment between the edge's two corners; the default when `edges` is omitted.
    Line,
    /// The circular arc about `center`, counter-clockwise when `ccw` is true, else clockwise.
    /// Both corners must lie at the same distance from `center` or the block is rejected.
    Arc { center: [Q<Length>; 2], ccw: bool },
    /// The arc of the axis-aligned ellipse with these semi-axes about `center`, taken the short
    /// way between the corners' parametric angles. Both corners must lie on the ellipse.
    Ellipse {
        center: [Q<Length>; 2],
        #[serde(rename = "semiAxes")]
        semi_axes: [Q<Length>; 2],
    },
}

/// One block of a mapped mesh: a curvilinear quadrilateral filled with a structured grid.
///
/// `corners` are the four corners counter-clockwise; the block's (u, v) square runs corner 0 to
/// corner 1 along u and corner 0 to corner 3 along v. Edge k joins corner k to corner k+1, so
/// edges 0 and 2 run along u and edges 1 and 3 along v; `edges` gives each one its shape
/// (straight by default). `n` is the number of elements along u and v, `grading` the ratio
/// between successive element sizes along each (1.0 uniform, above 1 packs elements toward the
/// u = 0 / v = 0 side), and `tags` the face-set name each edge contributes to, which becomes
/// `<body>.<tag>`. Blocks that share an edge must divide and grade it identically.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QuadBlockSpec {
    pub corners: [[Q<Length>; 2]; 4],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edges: Option<[CurveSpec; 4]>,
    pub n: [u32; 2],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grading: Option<[f64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<[Option<String>; 4]>,
}

/// A box in which the free mesher uses a smaller element size than elsewhere, for a stress
/// concentration a uniform mesh would smear out. The box is axis-aligned in the xy plane and a
/// triangle is refined when its centroid falls inside it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RefineBoxSpec {
    pub min: [Q<Length>; 2],
    pub max: [Q<Length>; 2],
    pub size: Q<Length>,
}

/// How a 2D mesh is swept into a 3D one: straight along z, or around the z axis.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SweepSpec {
    /// Extrude along z into `layers` layers of equal thickness, `height` in total. Use an even
    /// number of layers when a Set has to land on the mid-plane. The ends become the face sets
    /// `<body>.bottom` (z = 0) and `<body>.top`.
    Extrude { layers: u32, height: Q<Length> },
    /// Revolve the base, read as an (r, z) section with x the radius and y the axis, about the
    /// z axis through `angleDeg` in `segments` steps. Below a full turn the ends become the
    /// face sets `<body>.theta0` and `<body>.theta1`; a full turn merges its seam instead. A
    /// base node at r = 0 is refused: mesh a solid section as blocks and extrude it.
    Revolve {
        segments: u32,
        #[serde(rename = "angleDeg")]
        angle_deg: f64,
    },
}

/// The mesher and its settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MesherSpec {
    /// Structured hexahedra (or quadrilaterals in 2D) on an axis-aligned lattice covering
    /// every Body; exact for box geometry, stair-stepped for curved bodies.
    Lattice { size: LatticeSize },
    /// Structured quadrilaterals on one or more mapped blocks, merged where they touch. The
    /// blocks *are* the geometry: no geometry.add is needed, and the Body they make is named by
    /// `body` (default "sheet"), so each block edge tag becomes the face Set `<body>.<tag>`.
    /// This is the mesher for the classic 2D benchmarks: it is exact, has no quality surprises,
    /// grades toward a stress concentration, and puts quadratic mid-nodes on the real curve.
    /// The idealisation must be 2D (model.setIdealisation) because the mesh is.
    Mapped {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        body: Option<String>,
        blocks: Vec<QuadBlockSpec>,
    },
    /// Unstructured triangles inside the sketch of an existing 2D Body, at about `size`, with a
    /// 30 degree minimum angle. Every sketch segment tag becomes the face Set `<of>.<tag>`, and
    /// each entry of `refine` asks for a smaller size inside its box. Use it when the domain is
    /// too awkward to cover with mapped blocks; prefer mapped blocks when it is not, because
    /// they are exact and grade smoothly. The idealisation must be 2D, as the Body is.
    Free {
        of: String,
        size: Q<Length>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        refine: Option<Vec<RefineBoxSpec>>,
    },
    /// A 3D mesh swept from a 2D one: `base` is the mesher that makes the section, and `sweep`
    /// extrudes or revolves it into hexahedra (a quadratic base gives hex20 with the mid-nodes
    /// on the swept curve). The base's edge face Sets become the side faces of the solid, so a
    /// Set named on the section is still there in 3D, and the ends get their own. The
    /// idealisation must be 3D, and the base must make quadrilaterals, so it is the mapped
    /// mesher: sweeping free triangles would need wedge elements, which the engine has not got.
    Sweep { base: Box<MesherSpec>, sweep: SweepSpec },
}

/// A file format `mesh.export` writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    /// VTK XML UnstructuredGrid with base64 binary payloads: what ParaView opens. The only
    /// format that carries a Step's result fields as point data.
    Vtu,
    /// Gmsh `.msh` 4.1 ASCII: nodes, elements in Gmsh's node order, and the Sets as physical
    /// names. Mesh only; a `step` is ignored.
    Msh,
    /// Abaqus/CalculiX `.inp`: `*NODE`, `*ELEMENT` and the Sets as `*NSET`/`*ELSET`, for the
    /// CalculiX cross-check. Mesh only; a `step` is ignored.
    Inp,
    /// ASCII STL of the mesh boundary surface, for a 3D viewer or a printer. Mesh only; a
    /// `step` is ignored.
    Stl,
    /// The calculation note `query.report` writes: assumptions, geometry, materials, mesh and
    /// quality, loads with their totals, results with the reaction balance, the verification
    /// checks with a hand calculation, and the Journal as an appendix, as one Markdown file.
    /// Deterministic, so two exports of the same Journal are byte-identical.
    Report,
}

impl ExportFormat {
    /// The file extension and MIME type a host saves this format under.
    pub fn extension(self) -> (&'static str, &'static str) {
        match self {
            ExportFormat::Vtu => ("vtu", "application/xml"),
            ExportFormat::Msh => ("msh", "model/mesh"),
            ExportFormat::Inp => ("inp", "text/plain"),
            ExportFormat::Stl => ("stl", "model/stl"),
            ExportFormat::Report => ("md", "text/markdown"),
        }
    }
}

/// A quantity of interest for convergence studies.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum QuantityOfInterest {
    /// The largest value of a field (component) over the mesh.
    Max {
        field: Field,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        component: Option<u8>,
    },
    /// The smallest value of a field (component) over the mesh.
    Min {
        field: Field,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        component: Option<u8>,
    },
    /// The field interpolated at a point.
    Probe {
        field: Field,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        component: Option<u8>,
        at: [Q<Length>; 3],
    },
}

/// Plugin extension points (phase P).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum PluginKind {
    MaterialLaw,
    Element,
    Load,
    PostQuantity,
    Mesher,
    Procedure,
}

/// Plugin languages (phase P).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PluginLanguage {
    Ts,
    Wgsl,
    Wasm,
}

/// Where plugin code comes from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum PluginSource {
    Inline { inline: String },
    Url { url: String, sha256: String },
}

/// A face predicate with unit strings; converted to the geometry crate's SI form in `apply`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FacePredicate {
    /// Boundary faces on the plane `normal · x = offset` whose outward normal is within 10° of ±normal.
    Plane {
        normal: [f64; 3],
        offset: Q<Length>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tol: Option<Q<Length>>,
    },
    /// Boundary faces whose outward normal is within `maxAngleDeg` (default 10°) of `normal`.
    Normal {
        normal: [f64; 3],
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_angle_deg: Option<f64>,
    },
    /// Boundary faces whose centroid lies inside the box.
    Bbox { min: [Q<Length>; 3], max: [Q<Length>; 3] },
    /// Boundary faces at distance `radius` from the axis through `point` along `axis` (a circle in 2D).
    Cylinder {
        point: [Q<Length>; 3],
        axis: [f64; 3],
        radius: Q<Length>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tol: Option<Q<Length>>,
    },
    /// Faces matching any of the predicates.
    Any { of: Vec<FacePredicate> },
}

fn si3(q: &[Q<Length>; 3], where_: &str) -> Result<[f64; 3], Error> {
    let mut out = [0.0; 3];
    for (k, v) in q.iter().enumerate() {
        out[k] = v.si().map_err(|e| e.at(format!("{where_}[{k}]")))?;
    }
    Ok(out)
}

fn si2(q: &[Q<Length>; 2], where_: &str) -> Result<[f64; 2], Error> {
    let mut out = [0.0; 2];
    for (k, v) in q.iter().enumerate() {
        out[k] = v.si().map_err(|e| e.at(format!("{where_}[{k}]")))?;
    }
    Ok(out)
}

fn si_opt(q: &Option<Q<Length>>, where_: &str) -> Result<Option<f64>, Error> {
    match q {
        Some(v) => Ok(Some(v.si().map_err(|e| e.at(where_))?)),
        None => Ok(None),
    }
}

impl FacePredicate {
    pub fn to_si(&self) -> Result<GeoFacePredicate, Error> {
        Ok(match self {
            FacePredicate::Plane { normal, offset, tol } => GeoFacePredicate::Plane {
                normal: *normal,
                offset: offset.si().map_err(|e| e.at("where.offset"))?,
                tol: si_opt(tol, "where.tol")?,
            },
            FacePredicate::Normal { normal, max_angle_deg } => {
                GeoFacePredicate::Normal { normal: *normal, max_angle_deg: *max_angle_deg }
            }
            FacePredicate::Bbox { min, max } => {
                GeoFacePredicate::Bbox { min: si3(min, "where.min")?, max: si3(max, "where.max")? }
            }
            FacePredicate::Cylinder { point, axis, radius, tol } => GeoFacePredicate::Cylinder {
                point: si3(point, "where.point")?,
                axis: *axis,
                radius: radius.si().map_err(|e| e.at("where.radius"))?,
                tol: si_opt(tol, "where.tol")?,
            },
            FacePredicate::Any { of } => {
                GeoFacePredicate::Any { of: of.iter().map(FacePredicate::to_si).collect::<Result<_, _>>()? }
            }
        })
    }
}

/// A region predicate with unit strings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RegionPredicate {
    /// Nodes or elements inside the box.
    Bbox { min: [Q<Length>; 3], max: [Q<Length>; 3] },
    /// Everything belonging to the named Body.
    Body { name: String },
}

impl RegionPredicate {
    pub fn to_si(&self) -> Result<GeoRegionPredicate, Error> {
        Ok(match self {
            RegionPredicate::Bbox { min, max } => {
                GeoRegionPredicate::Bbox { min: si3(min, "where.min")?, max: si3(max, "where.max")? }
            }
            RegionPredicate::Body { name } => GeoRegionPredicate::Body { name: name.clone() },
        })
    }
}

/// One edge of a sketch loop, with unit strings. Segment k runs from the previous segment's
/// `to` (segment 0 from the last one's) to its own `to`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SegmentSpec {
    /// Straight edge to `to`; `tag` names the face it produces.
    Line {
        to: [Q<Length>; 2],
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tag: Option<String>,
    },
    /// Circular arc about `center` to `to`, counter-clockwise when `ccw`.
    Arc {
        center: [Q<Length>; 2],
        to: [Q<Length>; 2],
        ccw: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tag: Option<String>,
    },
}

/// A closed outer loop with optional hole loops, with unit strings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SketchSpec {
    pub outer: Vec<SegmentSpec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub holes: Vec<Vec<SegmentSpec>>,
}

fn segs_si(segs: &[SegmentSpec], where_: &str) -> Result<Vec<Segment>, Error> {
    segs.iter()
        .enumerate()
        .map(|(k, s)| {
            let w = format!("{where_}[{k}]");
            Ok(match s {
                SegmentSpec::Line { to, tag } => Segment::Line { to: si2(to, &format!("{w}.to"))?, tag: tag.clone() },
                SegmentSpec::Arc { center, to, ccw, tag } => Segment::Arc {
                    center: si2(center, &format!("{w}.center"))?,
                    to: si2(to, &format!("{w}.to"))?,
                    ccw: *ccw,
                    tag: tag.clone(),
                },
            })
        })
        .collect()
}

impl SketchSpec {
    pub fn to_si(&self, where_: &str) -> Result<Sketch, Error> {
        Ok(Sketch {
            outer: segs_si(&self.outer, &format!("{where_}.outer"))?,
            holes: self
                .holes
                .iter()
                .enumerate()
                .map(|(i, h)| segs_si(h, &format!("{where_}.holes[{i}]")))
                .collect::<Result<_, _>>()?,
        })
    }
}

/// A placement: translate (lengths), rotate about x, y, z in degrees, scale factors.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translate: Option<[Q<Length>; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotate: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<[f64; 3]>,
}

impl Placement {
    pub fn to_si(&self, where_: &str) -> Result<Affine3, Error> {
        Ok(Affine3 {
            translate: match &self.translate {
                Some(t) => si3(t, &format!("{where_}.translate"))?,
                None => [0.0; 3],
            },
            rotate: self.rotate.unwrap_or([0.0; 3]),
            scale: self.scale.unwrap_or([1.0; 3]),
        })
    }
}

/// A shape with unit strings; the geometry crate's `Shape` is its SI form.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ShapeSpec {
    /// Axis-aligned box from its `at` corner (default origin) spanning `size`; faces `xmin…zmax`.
    Box {
        size: [Q<Length>; 3],
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<[Q<Length>; 3]>,
    },
    /// Cylinder along z, base centred at `at` (default origin); faces `side`, `bottom`, `top`.
    Cylinder {
        radius: Q<Length>,
        height: Q<Length>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<[Q<Length>; 3]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        segments: Option<u32>,
    },
    /// Sphere centred at `at` (default origin); one face `surface`.
    Sphere {
        radius: Q<Length>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<[Q<Length>; 3]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        segments: Option<u32>,
    },
    /// A 2D body in the xy plane for plane-stress, plane-strain or axisymmetric Models.
    Sheet { sketch: SketchSpec },
    /// The sketch extruded along z by `height`; faces are the segment tags plus `bottom`, `top`.
    Extrude { sketch: SketchSpec, height: Q<Length> },
    /// The sketch (x = radius, y = axial) revolved about the axis through `angle` degrees.
    Revolve {
        sketch: SketchSpec,
        angle: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        segments: Option<u32>,
    },
    /// Union of shapes.
    Union { shapes: Vec<ShapeSpec> },
    /// `from` minus every shape in `cut`.
    Subtract { from: Box<ShapeSpec>, cut: Vec<ShapeSpec> },
    /// Intersection of shapes.
    Intersect { shapes: Vec<ShapeSpec> },
    /// A shape moved by a placement.
    Transform { shape: Box<ShapeSpec>, at: Placement },
}

fn placed(shape: Shape, at: &Option<[Q<Length>; 3]>, where_: &str) -> Result<Shape, Error> {
    Ok(match at {
        Some(t) => {
            Shape::Transform { shape: Box::new(shape), at: Affine3::translation(si3(t, &format!("{where_}.at"))?) }
        }
        None => shape,
    })
}

impl ShapeSpec {
    pub fn to_si(&self, where_: &str) -> Result<Shape, Error> {
        Ok(match self {
            ShapeSpec::Box { size, at } => {
                placed(Shape::Box { size: si3(size, &format!("{where_}.size"))? }, at, where_)?
            }
            ShapeSpec::Cylinder { radius, height, at, segments } => placed(
                Shape::Cylinder {
                    radius: radius.si().map_err(|e| e.at(format!("{where_}.radius")))?,
                    height: height.si().map_err(|e| e.at(format!("{where_}.height")))?,
                    segments: *segments,
                },
                at,
                where_,
            )?,
            ShapeSpec::Sphere { radius, at, segments } => placed(
                Shape::Sphere {
                    radius: radius.si().map_err(|e| e.at(format!("{where_}.radius")))?,
                    segments: *segments,
                },
                at,
                where_,
            )?,
            ShapeSpec::Sheet { sketch } => Shape::Sheet { sketch: sketch.to_si(&format!("{where_}.sketch"))? },
            ShapeSpec::Extrude { sketch, height } => Shape::Extrude {
                sketch: sketch.to_si(&format!("{where_}.sketch"))?,
                height: height.si().map_err(|e| e.at(format!("{where_}.height")))?,
            },
            ShapeSpec::Revolve { sketch, angle, segments } => Shape::Revolve {
                sketch: sketch.to_si(&format!("{where_}.sketch"))?,
                angle: *angle,
                segments: *segments,
            },
            ShapeSpec::Union { shapes } => Shape::Union { shapes: many(shapes, where_)? },
            ShapeSpec::Subtract { from, cut } => {
                Shape::Subtract { from: Box::new(from.to_si(&format!("{where_}.from"))?), cut: many(cut, where_)? }
            }
            ShapeSpec::Intersect { shapes } => Shape::Intersect { shapes: many(shapes, where_)? },
            ShapeSpec::Transform { shape, at } => Shape::Transform {
                shape: Box::new(shape.to_si(&format!("{where_}.shape"))?),
                at: at.to_si(&format!("{where_}.at"))?,
            },
        })
    }
}

fn many(shapes: &[ShapeSpec], where_: &str) -> Result<Vec<Shape>, Error> {
    shapes.iter().enumerate().map(|(i, s)| s.to_si(&format!("{where_}.shapes[{i}]"))).collect()
}

/// Every Command. Serialised with a `cmd` tag: `{ "cmd": "geometry.addBox", "name": "beam", … }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "cmd")]
pub enum Command {
    /// Start a new, empty Model and Journal with this name. Discards the current Model, its
    /// Results and the undo history; it is the first entry of every Journal, so call it once
    /// at the start, never to "reset" mid-way (use journal.undo for that).
    #[serde(rename = "model.new", rename_all = "camelCase")]
    ModelNew {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },

    /// Choose the display units used by Queries and the UI (for example mm, kN, MPa). Storage
    /// stays SI and every input may still use any unit of the right dimension; this only
    /// changes how values are reported back.
    #[serde(rename = "model.setUnits", rename_all = "camelCase")]
    ModelSetUnits { units: UnitSet },

    /// Set the idealisation: 3D solids (default), plane stress with a thickness, plane strain,
    /// or axisymmetric (x = radius, y = axis). 2D idealisations need Sheet bodies and 3D needs
    /// solid bodies; mixing them makes the Model ill-posed.
    #[serde(rename = "model.setIdealisation", rename_all = "camelCase")]
    ModelSetIdealisation { idealisation: IdealisationSpec },

    /// Rename a Body, Material, Set, Constraint, Load or Step and every reference to it. A Body
    /// rename also renames its auto faces (`<name>.xmin` …). Fails with name.taken if `to`
    /// already exists in that kind.
    #[serde(rename = "model.rename", rename_all = "camelCase")]
    ModelRename { kind: ObjectKind, name: String, to: String },

    /// Copy an object under a new name. A Body copy shares nothing with the original; a Step
    /// copy references the same Constraints and Loads. Useful for "the same load case but
    /// twice the pressure": duplicate, then re-issue the create Command with the new value.
    #[serde(rename = "model.duplicate", rename_all = "camelCase")]
    ModelDuplicate {
        kind: ObjectKind,
        name: String,
        #[serde(rename = "as")]
        as_: String,
    },

    /// Add an axis-aligned box Body with its minimum corner at `at` (default the origin). Its
    /// six faces are auto-named `<name>.xmin`, `<name>.xmax`, … `<name>.zmax` and can be used
    /// directly in constraints and loads. Re-issuing with an existing name replaces the body.
    #[serde(rename = "geometry.addBox", rename_all = "camelCase")]
    GeometryAddBox {
        name: String,
        size: [Q<Length>; 3],
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<[Q<Length>; 3]>,
    },

    /// Cut an axis-aligned box out of the Body `from` (a hole, notch or opening). The cut's
    /// walls are auto-named `<name>.xmin` … and refer to the faces of the hole, so a pressure
    /// on `hole.zmin` acts on the hole's floor. Cuts that remove everything are an error.
    #[serde(rename = "geometry.subtractBox", rename_all = "camelCase")]
    GeometrySubtractBox { name: String, from: String, size: [Q<Length>; 3], at: [Q<Length>; 3] },

    /// Add a Body from any shape: box, cylinder, sphere, an extruded or revolved sketch, a
    /// 2D sheet, or booleans of those. Faces are auto-named `<name>.<tag>` from the shape
    /// (`side`, `top`, sketch segment tags, …); list them with query.model. Lengths need units.
    #[serde(rename = "geometry.add", rename_all = "camelCase")]
    GeometryAdd { name: String, shape: ShapeSpec },

    /// Cut a shape out of the Body `from`. The cut's faces are auto-named `<name>.<tag>` (for a
    /// cylinder: `<name>.side`), which is how you load or fix the wall of a hole. The shape
    /// is positioned in world coordinates, so use its `at` or a transform to place it.
    #[serde(rename = "geometry.subtract", rename_all = "camelCase")]
    GeometrySubtract { name: String, from: String, shape: ShapeSpec },

    /// Name a face Set of Body `of` by a geometric rule (plane, normal, box, cylinder, or any
    /// of those) so constraints and loads can target it. Rules are re-evaluated after every
    /// remesh, so the Set survives refinement. Prefer the auto face names when one fits.
    #[serde(rename = "geometry.nameFace", rename_all = "camelCase")]
    GeometryNameFace {
        name: String,
        of: String,
        #[serde(rename = "where")]
        where_: FacePredicate,
    },

    /// Name a node/element Set by a region rule (a box or a whole Body), for point-like
    /// constraints, nodal forces and probes. Node sets from regions are exact at mesh nodes;
    /// use a box slightly larger than the points you mean.
    #[serde(rename = "geometry.nameRegion", rename_all = "camelCase")]
    GeometryNameRegion {
        name: String,
        #[serde(rename = "where")]
        where_: RegionPredicate,
    },

    /// Remove a Body, a cut, or a named Set. Fails with in-use listing the constraints, loads
    /// and material assignments that still reference it; remove or retarget those first.
    #[serde(rename = "geometry.remove", rename_all = "camelCase")]
    GeometryRemove { name: String },

    /// Define an isotropic linear-elastic Material by Young's modulus `E` and Poisson's ratio
    /// `nu` (0 ≤ ν < 0.5). Density `rho` is needed for gravity and modal analysis, `alpha` for
    /// thermal loads, `k` and `cp` for heat transfer; `source` records where the numbers came
    /// from. Re-issuing with an existing name edits the material in place.
    #[serde(rename = "material.add", rename_all = "camelCase")]
    MaterialAdd {
        name: String,
        #[serde(rename = "E")]
        e: Q<Stress>,
        nu: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rho: Option<Q<Density>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        alpha: Option<Q<ThermalExpansion>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        k: Option<Q<Conductivity>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cp: Option<Q<SpecificHeat>>,
        #[serde(default, skip_serializing_if = "Option::is_none", rename = "yield")]
        yield_: Option<Q<Stress>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
    },

    /// Assign a Material to one or more Bodies. Every Body needs a Material before solving;
    /// a Body without one is reported by query.model and blocks solve.run.
    #[serde(rename = "material.assign", rename_all = "camelCase")]
    MaterialAssign { material: String, bodies: Vec<String> },

    /// Remove a Material that is not assigned to any Body. Fails with in-use listing the Bodies
    /// that still use it; assign them another Material first with material.assign.
    #[serde(rename = "material.remove", rename_all = "camelCase")]
    MaterialRemove { name: String },

    /// Choose the Mesher and element settings; the Mesh is rebuilt lazily when needed. `order`
    /// 1 gives linear elements, 2 quadratic (more accurate in bending and at stress peaks).
    /// `formulation: full` is the textbook linear element that locks in bending: keep the
    /// default incompatible modes or use order 2 when bending matters.
    /// `simplices: true` splits hexes into tetrahedra (tet4/tet10) and quads into triangles
    /// (tri3/tri6), preserving named faces. It does not make a free tetrahedral mesh of curved
    /// geometry: the selected mesher still determines the boundary approximation.
    #[serde(rename = "mesh.set", rename_all = "camelCase")]
    MeshSet {
        mesher: MesherSpec,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        order: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        formulation: Option<Formulation>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        simplices: Option<bool>,
    },

    /// Write the current Mesh out as text the host saves; the Mesh is built first if it is
    /// stale. `vtu` is the VTK XML UnstructuredGrid that ParaView opens, carrying the element
    /// id and the Body index as cell data. Name a `step` to add that Step's result fields as
    /// point data — displacement, reaction, stress and von Mises — so ParaView colours by them.
    /// `msh`, `inp` and `stl` write the Mesh alone (Gmsh, Abaqus/CalculiX, an STL skin).
    #[serde(rename = "mesh.export", rename_all = "camelCase")]
    MeshExport {
        format: ExportFormat,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<String>,
    },

    /// Fix displacement components to zero on a Set (default: all components, a clamped
    /// support). For a roller give only the normal component. Fixing every node of a Body
    /// makes the solve trivial; fix faces, not bodies.
    #[serde(rename = "constraint.fix", rename_all = "camelCase")]
    ConstraintFix {
        name: String,
        on: SetRef,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dofs: Option<Vec<Dof>>,
    },

    /// Prescribe a non-zero displacement of one component on a Set, for example a settlement
    /// of "2 mm" in uy. Reactions on prescribed Sets are reported like any other constraint.
    #[serde(rename = "constraint.prescribe", rename_all = "camelCase")]
    ConstraintPrescribe { name: String, on: SetRef, dof: Dof, value: Q<Length> },

    /// Symmetry plane: fixes the displacement component along `normal` on the Set (the cut
    /// face of a half or quarter model). Model a half and say so in the report; loads on the
    /// symmetry plane itself must be halved by you.
    #[serde(rename = "constraint.symmetry", rename_all = "camelCase")]
    ConstraintSymmetry { name: String, on: SetRef, normal: Axis },

    /// Hold a Set at a fixed temperature in a heat Step (the Dirichlet boundary of conduction).
    /// A heat Step needs either one of these or a convection boundary, or the temperature is
    /// only defined up to a constant and the solve is singular. In a transient Step the value is
    /// multiplied by the Step's `amplitude`, so "100 K" with a sine amplitude is a driven end.
    #[serde(rename = "constraint.temperature", rename_all = "camelCase")]
    ConstraintTemperature { name: String, on: SetRef, value: Q<Temperature> },

    /// Remove a Constraint. Fails with in-use if a Step still lists it; re-issue step.add without
    /// it first. Removing a constraint makes existing Results of that Step stale.
    #[serde(rename = "constraint.remove", rename_all = "camelCase")]
    ConstraintRemove { name: String },

    /// Uniform pressure on a face Set, positive into the surface (a negative value pulls).
    /// The total force is the pressure times the face area and is reported by query.model.
    #[serde(rename = "load.pressure", rename_all = "camelCase")]
    LoadPressure { name: String, on: SetRef, value: Q<Stress> },

    /// A total force vector spread uniformly over a face Set's area ("10 kN downward on this
    /// face"). Use this instead of nodal forces on solids: point loads give singular stresses.
    #[serde(rename = "load.traction", rename_all = "camelCase")]
    LoadTraction { name: String, on: SetRef, total: [Q<Force>; 3] },

    /// A total force split equally over the nodes of a node Set. Point loads on solids give
    /// singular stresses near the node; prefer load.traction on a face unless you mean a point.
    #[serde(rename = "load.force", rename_all = "camelCase")]
    LoadForce { name: String, on: SetRef, total: [Q<Force>; 3] },

    /// Gravity (or any uniform acceleration) as a body force on every Body whose Material has
    /// a density; Bodies without one are skipped and listed in the warnings.
    #[serde(rename = "load.gravity", rename_all = "camelCase")]
    LoadGravity { name: String, g: [Q<Acceleration>; 3] },

    /// A uniform temperature on the listed Bodies relative to `reference` (default 293.15 K),
    /// producing thermal strain α·ΔT in a static Step. Needs `alpha` on the Material.
    #[serde(rename = "load.temperature", rename_all = "camelCase")]
    LoadTemperature {
        name: String,
        bodies: Vec<String>,
        value: Q<Temperature>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reference: Option<Q<Temperature>>,
    },

    /// Newton cooling on a face Set: heat `h (T − tInf)` leaves the surface per unit area. This
    /// is the usual "exposed to air" boundary and, unlike a flux, it also stiffens the system,
    /// so a heat Step with a convection face needs no fixed temperature to be well posed.
    #[serde(rename = "load.convection", rename_all = "camelCase")]
    LoadConvection { name: String, on: SetRef, h: Q<HeatTransfer>, t_inf: Q<Temperature> },

    /// A prescribed heat flux into a face Set, in W/m² (negative flows outward). An insulated
    /// face needs no Command at all: zero flux is what a face with no boundary condition does.
    #[serde(rename = "load.heatFlux", rename_all = "camelCase")]
    LoadHeatFlux { name: String, on: SetRef, q: Q<HeatFlux> },

    /// A volumetric heat source on whole Bodies, in W/m³ (ohmic heating, hydration, a reaction).
    /// It is a density, not a total: the heat delivered is `q` times each Body's volume.
    #[serde(rename = "load.heatSource", rename_all = "camelCase")]
    LoadHeatSource { name: String, bodies: Vec<String>, q: Q<HeatSource> },

    /// Remove a Load. Fails with in-use if a Step still lists it; re-issue step.add without it
    /// first. Removing a load makes existing Results of that Step stale.
    #[serde(rename = "load.remove", rename_all = "camelCase")]
    LoadRemove { name: String },

    /// Define an analysis Step: the procedure, and which Constraints and Loads are active in
    /// it. `output` lists the fields to compute (default displacement, stress, von Mises and
    /// reactions). Steps run in the order given by step.reorder, and `after` names an earlier
    /// Step whose Result this one continues — a static Step after a heat Step picks up its
    /// temperature field and turns it into thermal stress. The remaining fields belong to one
    /// procedure each and are ignored by the others: `nModes` and `shift` to modal, `dt`,
    /// `tEnd`, `theta`, `initial`, `amplitude` and `outputEvery` to heat-transient, `tEnd`,
    /// `dtFactor` and `outputEvery` to explicit.
    #[serde(rename = "step.add", rename_all = "camelCase")]
    StepAdd {
        name: String,
        procedure: Procedure,
        constraints: Vec<String>,
        loads: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<Vec<Field>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        n_modes: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shift: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dt: Option<Q<Time>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        t_end: Option<Q<Time>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        theta: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_every: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dt_factor: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        amplitude: Option<AmplitudeSpec>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        initial: Option<Q<Temperature>>,
    },

    /// Remove a Step and the Result it produced, if any. Constraints and Loads it referenced
    /// stay in the Model and can be reused by other Steps.
    #[serde(rename = "step.remove", rename_all = "camelCase")]
    StepRemove { name: String },

    /// Set the run order of Steps; `order` must list every Step name exactly once. Steps run in
    /// this order and a later Step may inherit state (a temperature field) from an earlier one.
    #[serde(rename = "step.reorder", rename_all = "camelCase")]
    StepReorder { order: Vec<String> },

    /// Run a Step. Checks well-posedness first (materials, constraints, rigid-body modes,
    /// element quality) and refuses with a suggested fix. Returns extremes and reactions;
    /// always check that reactions balance the applied loads before trusting a stress.
    #[serde(rename = "solve.run", rename_all = "camelCase")]
    SolveRun {
        step: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        solver: Option<Solver>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tolerance: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_iterations: Option<u32>,
    },

    /// Re-mesh at each size, re-solve the Step and report the quantity of interest per size,
    /// the observed convergence rate and a Richardson estimate of the converged value. Sizes
    /// should halve each time (three or more). Restores the previous mesh settings afterwards
    /// unless `restore` is false.
    #[serde(rename = "study.converge", rename_all = "camelCase")]
    StudyConverge {
        step: String,
        sizes: Vec<Q<Length>>,
        quantity: QuantityOfInterest,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        restore: Option<bool>,
    },

    /// Undo the last `steps` Commands (default 1), restoring the Model and orphaning any
    /// Result produced after that point. Not recorded in the Journal.
    #[serde(rename = "journal.undo", rename_all = "camelCase")]
    JournalUndo {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        steps: Option<u32>,
    },

    /// Redo the last `steps` undone Commands (default 1) by re-applying them; a redone solve
    /// re-solves. Not recorded in the Journal; any new Command after an undo clears the redo stack.
    #[serde(rename = "journal.redo", rename_all = "camelCase")]
    JournalRedo {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        steps: Option<u32>,
    },

    /// Load a Plugin filling one Extension Point (a material law, element, load, post
    /// quantity, mesher or procedure) in TypeScript, WGSL or wasm; recorded in the Journal by
    /// content hash. Not available yet: returns unsupported until the plugin phase lands.
    #[serde(rename = "plugin.load", rename_all = "camelCase")]
    #[schemars(extend("x-status" = "stub"))]
    PluginLoad {
        name: String,
        kind: PluginKind,
        language: PluginLanguage,
        source: PluginSource,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        manifest: Option<serde_json::Value>,
    },
}

impl Command {
    /// The wire name (`geometry.addBox`).
    pub fn name(&self) -> String {
        let v = serde_json::to_value(self).unwrap_or_default();
        v.get("cmd").and_then(|c| c.as_str()).unwrap_or("?").to_string()
    }
    /// Undo and redo are never journaled.
    pub fn is_journaled(&self) -> bool {
        !matches!(self, Command::JournalUndo { .. } | Command::JournalRedo { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_journaled() {
        let c = Command::GeometryAddBox {
            name: "b".into(),
            size: [Q::text("1 m"), Q::text("1 m"), Q::text("1 m")],
            at: None,
        };
        assert_eq!(c.name(), "geometry.addBox");
        assert!(c.is_journaled());
        assert!(!Command::JournalUndo { steps: None }.is_journaled());
        assert!(!Command::JournalRedo { steps: Some(2) }.is_journaled());
        let j = serde_json::to_string(&c).unwrap();
        assert_eq!(j, r#"{"cmd":"geometry.addBox","name":"b","size":["1 m","1 m","1 m"]}"#);
        let back: Command = serde_json::from_str(&j).unwrap();
        assert_eq!(back, c);
        let m: Command = serde_json::from_str(r#"{"cmd":"material.add","name":"s","E":"210 GPa","nu":0.3}"#).unwrap();
        assert_eq!(m.name(), "material.add");
        let d: Command =
            serde_json::from_str(r#"{"cmd":"model.duplicate","kind":"body","name":"a","as":"b"}"#).unwrap();
        assert_eq!(d.name(), "model.duplicate");
        assert_eq!(Dof::Uz.index(), 2);
        assert_eq!(Dof::Uy.index(), 1);
        assert_eq!(Dof::Ux.index(), 0);
        assert_eq!(Axis::X.index(), 0);
        assert_eq!(Axis::Y.index(), 1);
        assert_eq!(Axis::Z.index(), 2);
        assert_eq!(ObjectKind::Constraint.label(), "constraint");
        assert_eq!(ObjectKind::Body.label(), "body");
        assert_eq!(ObjectKind::Material.label(), "material");
        assert_eq!(ObjectKind::Set.label(), "set");
        assert_eq!(ObjectKind::Load.label(), "load");
        assert_eq!(ObjectKind::Step.label(), "step");
        assert_eq!(Solver::default(), Solver::Auto);
        assert_eq!(Formulation::default(), Formulation::IncompatibleModes);
    }

    #[test]
    fn predicates_convert_to_si_with_paths() {
        let p = FacePredicate::Plane { normal: [0.0, 0.0, 1.0], offset: Q::text("100 mm"), tol: Some(Q::text("1 mm")) };
        assert_eq!(
            p.to_si().unwrap(),
            GeoFacePredicate::Plane { normal: [0.0, 0.0, 1.0], offset: 0.1, tol: Some(0.001) }
        );
        let bad = FacePredicate::Plane { normal: [0.0, 0.0, 1.0], offset: Q::text("100 MPa"), tol: None };
        let e = bad.to_si().unwrap_err();
        assert_eq!(e.where_.as_deref(), Some("where.offset"));
        let bad = FacePredicate::Plane { normal: [0.0, 0.0, 1.0], offset: Q::text("1 m"), tol: Some(Q::text("1 s")) };
        assert_eq!(bad.to_si().unwrap_err().where_.as_deref(), Some("where.tol"));
        let n = FacePredicate::Normal { normal: [1.0, 0.0, 0.0], max_angle_deg: Some(5.0) };
        assert_eq!(n.to_si().unwrap(), GeoFacePredicate::Normal { normal: [1.0, 0.0, 0.0], max_angle_deg: Some(5.0) });
        let m = || [Q::text("0 m"), Q::text("0 m"), Q::text("0 m")];
        let bb = FacePredicate::Bbox { min: m(), max: [Q::text("1 m"), Q::text("2 mm"), Q::text("3 cm")] };
        assert_eq!(bb.to_si().unwrap(), GeoFacePredicate::Bbox { min: [0.0; 3], max: [1.0, 0.002, 0.03] });
        let bb_bad = FacePredicate::Bbox { min: m(), max: [Q::text("1 m"), Q::text("2 kg"), Q::text("3 cm")] };
        assert_eq!(bb_bad.to_si().unwrap_err().where_.as_deref(), Some("where.max[1]"));
        let bb_bad = FacePredicate::Bbox { min: [Q::text("1 kg"), Q::text("0 m"), Q::text("0 m")], max: m() };
        assert_eq!(bb_bad.to_si().unwrap_err().where_.as_deref(), Some("where.min[0]"));
        let cyl_bad_pt = FacePredicate::Cylinder {
            point: [Q::text("1 kg"), Q::text("0 m"), Q::text("0 m")],
            axis: [0.0, 0.0, 1.0],
            radius: Q::text("1 m"),
            tol: None,
        };
        assert_eq!(cyl_bad_pt.to_si().unwrap_err().where_.as_deref(), Some("where.point[0]"));
        let cyl_bad_tol = FacePredicate::Cylinder {
            point: m(),
            axis: [0.0, 0.0, 1.0],
            radius: Q::text("1 m"),
            tol: Some(Q::text("1 kg")),
        };
        assert_eq!(cyl_bad_tol.to_si().unwrap_err().where_.as_deref(), Some("where.tol"));
        let r_bad_max = RegionPredicate::Bbox { min: m(), max: [Q::text("x"), Q::text("0 m"), Q::text("0 m")] };
        assert!(r_bad_max.to_si().is_err());
        let cyl = FacePredicate::Cylinder { point: m(), axis: [0.0, 0.0, 1.0], radius: Q::text("5 mm"), tol: None };
        assert_eq!(
            cyl.to_si().unwrap(),
            GeoFacePredicate::Cylinder { point: [0.0; 3], axis: [0.0, 0.0, 1.0], radius: 0.005, tol: None }
        );
        let cyl_bad = FacePredicate::Cylinder { point: m(), axis: [0.0, 0.0, 1.0], radius: Q::text("5 N"), tol: None };
        assert_eq!(cyl_bad.to_si().unwrap_err().where_.as_deref(), Some("where.radius"));
        let any = FacePredicate::Any { of: vec![n.clone(), cyl.clone()] };
        assert!(matches!(any.to_si().unwrap(), GeoFacePredicate::Any { of } if of.len() == 2));
        let any_bad = FacePredicate::Any { of: vec![cyl_bad] };
        assert!(any_bad.to_si().is_err());
        let r = RegionPredicate::Bbox { min: m(), max: [Q::text("1 m"), Q::text("1 m"), Q::text("1 m")] };
        assert_eq!(r.to_si().unwrap(), GeoRegionPredicate::Bbox { min: [0.0; 3], max: [1.0; 3] });
        let r_bad = RegionPredicate::Bbox { min: [Q::text("x"), Q::text("0 m"), Q::text("0 m")], max: m() };
        assert!(r_bad.to_si().is_err());
        let rb = RegionPredicate::Body { name: "beam".into() };
        assert_eq!(rb.to_si().unwrap(), GeoRegionPredicate::Body { name: "beam".into() });
    }

    #[test]
    fn shapes_convert_to_si() {
        let mm = |v: f64| Q::<Length>::new(v, "mm");
        let b = ShapeSpec::Box { size: [mm(1000.0), mm(100.0), mm(50.0)], at: Some([mm(0.0), mm(0.0), mm(10.0)]) };
        let s = b.to_si("shape").unwrap();
        assert_eq!(
            s,
            Shape::Transform {
                shape: Box::new(Shape::Box { size: [1.0, 0.1, 0.05] }),
                at: Affine3::translation([0.0, 0.0, 0.01])
            }
        );
        let b0 = ShapeSpec::Box { size: [mm(1.0), mm(1.0), mm(1.0)], at: None };
        assert_eq!(b0.to_si("shape").unwrap(), Shape::Box { size: [0.001; 3] });
        let bad = ShapeSpec::Box { size: [mm(1.0), Q::new(1.0, "kg"), mm(1.0)], at: None };
        assert_eq!(bad.to_si("shape").unwrap_err().where_.as_deref(), Some("shape.size[1]"));
        let c = ShapeSpec::Cylinder { radius: mm(10.0), height: mm(20.0), at: None, segments: Some(16) };
        assert_eq!(c.to_si("s").unwrap(), Shape::Cylinder { radius: 0.01, height: 0.02, segments: Some(16) });
        let c_bad = ShapeSpec::Cylinder { radius: Q::new(1.0, "s"), height: mm(1.0), at: None, segments: None };
        assert_eq!(c_bad.to_si("s").unwrap_err().where_.as_deref(), Some("s.radius"));
        let c_bad2 = ShapeSpec::Cylinder { radius: mm(1.0), height: Q::new(1.0, "s"), at: None, segments: None };
        assert_eq!(c_bad2.to_si("s").unwrap_err().where_.as_deref(), Some("s.height"));
        let sp = ShapeSpec::Sphere { radius: mm(10.0), at: Some([mm(1.0), mm(2.0), mm(3.0)]), segments: None };
        assert_eq!(
            sp.to_si("s").unwrap(),
            Shape::Transform {
                shape: Box::new(Shape::Sphere { radius: 0.01, segments: None }),
                at: Affine3::translation([0.001, 0.002, 0.003])
            }
        );
        let bad_at =
            ShapeSpec::Sphere { radius: mm(10.0), at: Some([mm(1.0), Q::new(1.0, "s"), mm(3.0)]), segments: None };
        assert_eq!(bad_at.to_si("s").unwrap_err().where_.as_deref(), Some("s.at[1]"));
        let bad_at = ShapeSpec::Cylinder {
            radius: mm(1.0),
            height: mm(1.0),
            at: Some([Q::new(1.0, "s"), mm(1.0), mm(3.0)]),
            segments: None,
        };
        assert_eq!(bad_at.to_si("s").unwrap_err().where_.as_deref(), Some("s.at[0]"));
        let bad_at =
            ShapeSpec::Box { size: [mm(1.0), mm(1.0), mm(1.0)], at: Some([mm(1.0), mm(1.0), Q::new(1.0, "s")]) };
        assert_eq!(bad_at.to_si("s").unwrap_err().where_.as_deref(), Some("s.at[2]"));
        let sp_bad = ShapeSpec::Sphere { radius: Q::new(1.0, "s"), at: None, segments: None };
        assert!(sp_bad.to_si("s").is_err());
        let sk = SketchSpec {
            outer: vec![
                SegmentSpec::Line { to: [mm(20.0), mm(0.0)], tag: Some("ymin".into()) },
                SegmentSpec::Arc { center: [mm(0.0), mm(0.0)], to: [mm(0.0), mm(20.0)], ccw: true, tag: None },
                SegmentSpec::Line { to: [mm(0.0), mm(0.0)], tag: None },
            ],
            holes: vec![vec![
                SegmentSpec::Arc { center: [mm(5.0), mm(5.0)], to: [mm(4.0), mm(5.0)], ccw: true, tag: None },
                SegmentSpec::Arc { center: [mm(5.0), mm(5.0)], to: [mm(6.0), mm(5.0)], ccw: true, tag: None },
            ]],
        };
        let sheet = ShapeSpec::Sheet { sketch: sk.clone() }.to_si("s").unwrap();
        let si_sketch = sk.to_si("x").unwrap();
        assert_eq!(si_sketch.outer.len(), 3);
        assert_eq!(si_sketch.holes.len(), 1);
        assert_eq!(si_sketch.outer[0].to(), [0.02, 0.0]);
        assert_eq!(sheet, Shape::Sheet { sketch: si_sketch.clone() });
        let ex = ShapeSpec::Extrude { sketch: sk.clone(), height: mm(5.0) }.to_si("s").unwrap();
        assert!(matches!(ex, Shape::Extrude { height, .. } if (height - 0.005).abs() < 1e-15));
        let ex_bad = ShapeSpec::Extrude { sketch: sk.clone(), height: Q::new(1.0, "K") };
        assert_eq!(ex_bad.to_si("s").unwrap_err().where_.as_deref(), Some("s.height"));
        let bad_sketch =
            SketchSpec { outer: vec![SegmentSpec::Line { to: [Q::new(1.0, "s"), mm(0.0)], tag: None }], holes: vec![] };
        assert!(ShapeSpec::Extrude { sketch: bad_sketch.clone(), height: mm(1.0) }.to_si("s").is_err());
        assert!(ShapeSpec::Revolve { sketch: bad_sketch.clone(), angle: 90.0, segments: None }.to_si("s").is_err());
        assert!(ShapeSpec::Intersect { shapes: vec![bad.clone()] }.to_si("s").is_err());
        let rv = ShapeSpec::Revolve { sketch: sk.clone(), angle: 90.0, segments: None }.to_si("s").unwrap();
        assert!(matches!(rv, Shape::Revolve { angle, .. } if angle == 90.0));
        let bad_sk =
            SketchSpec { outer: vec![SegmentSpec::Line { to: [Q::new(1.0, "s"), mm(0.0)], tag: None }], holes: vec![] };
        let e = ShapeSpec::Sheet { sketch: bad_sk }.to_si("s").unwrap_err();
        assert_eq!(e.where_.as_deref(), Some("s.sketch.outer[0].to[0]"));
        let bad_hole = SketchSpec {
            outer: vec![SegmentSpec::Line { to: [mm(1.0), mm(0.0)], tag: None }],
            holes: vec![vec![SegmentSpec::Arc {
                center: [Q::new(1.0, "s"), mm(0.0)],
                to: [mm(0.0), mm(0.0)],
                ccw: true,
                tag: None,
            }]],
        };
        let e = ShapeSpec::Sheet { sketch: bad_hole }.to_si("s").unwrap_err();
        assert_eq!(e.where_.as_deref(), Some("s.sketch.holes[0][0].center[0]"));
        let bad_arc_to = SketchSpec {
            outer: vec![SegmentSpec::Arc {
                center: [mm(0.0), mm(0.0)],
                to: [mm(0.0), Q::new(1.0, "s")],
                ccw: true,
                tag: None,
            }],
            holes: vec![],
        };
        assert!(ShapeSpec::Sheet { sketch: bad_arc_to }.to_si("s").is_err());
        let u = ShapeSpec::Union { shapes: vec![b0.clone(), c.clone()] }.to_si("s").unwrap();
        assert!(matches!(u, Shape::Union { shapes } if shapes.len() == 2));
        let u_bad = ShapeSpec::Union { shapes: vec![bad.clone()] };
        assert_eq!(u_bad.to_si("s").unwrap_err().where_.as_deref(), Some("s.shapes[0].size[1]"));
        let sub = ShapeSpec::Subtract { from: Box::new(b0.clone()), cut: vec![c.clone()] }.to_si("s").unwrap();
        assert_eq!(
            sub,
            Shape::Subtract { from: Box::new(Shape::Box { size: [0.001; 3] }), cut: vec![c.to_si("s").unwrap()] }
        );
        assert!(ShapeSpec::Subtract { from: Box::new(bad.clone()), cut: vec![] }.to_si("s").is_err());
        assert!(ShapeSpec::Subtract { from: Box::new(b0.clone()), cut: vec![bad.clone()] }.to_si("s").is_err());
        let i = ShapeSpec::Intersect { shapes: vec![b0.clone()] }.to_si("s").unwrap();
        assert_eq!(i, Shape::Intersect { shapes: vec![Shape::Box { size: [0.001; 3] }] });
        let t = ShapeSpec::Transform {
            shape: Box::new(b0.clone()),
            at: Placement { translate: Some([mm(1.0), mm(0.0), mm(0.0)]), rotate: Some([0.0, 0.0, 90.0]), scale: None },
        }
        .to_si("s")
        .unwrap();
        assert_eq!(
            t,
            Shape::Transform {
                shape: Box::new(Shape::Box { size: [0.001; 3] }),
                at: Affine3 { translate: [0.001, 0.0, 0.0], rotate: [0.0, 0.0, 90.0], scale: [1.0; 3] }
            }
        );
        let t0 = ShapeSpec::Transform {
            shape: Box::new(b0.clone()),
            at: Placement { translate: None, rotate: None, scale: Some([2.0; 3]) },
        };
        assert!(
            matches!(t0.to_si("s").unwrap(), Shape::Transform { at, .. } if at.scale == [2.0; 3] && at.translate == [0.0; 3])
        );
        let t_bad = ShapeSpec::Transform {
            shape: Box::new(b0.clone()),
            at: Placement { translate: Some([Q::new(1.0, "s"), mm(0.0), mm(0.0)]), rotate: None, scale: None },
        };
        assert_eq!(t_bad.to_si("s").unwrap_err().where_.as_deref(), Some("s.at.translate[0]"));
        let t_bad2 = ShapeSpec::Transform {
            shape: Box::new(bad.clone()),
            at: Placement { translate: None, rotate: None, scale: None },
        };
        assert!(t_bad2.to_si("s").is_err());
        let j = serde_json::to_string(&b0).unwrap();
        assert!(j.starts_with(r#"{"kind":"box""#));
    }
}
