//! The Query enum: every read of the Model, Mesh or Results. Queries never mutate the Model.
//! Scalar values use Model display units; bulk frame arrays explicitly carry their SI unit.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::command::{Command, Field, ObjectKind};
use crate::error::Warning;
use crate::units::{
    Conductivity, Density, Dimensionless, Force, Length, Quantity, SpecificHeat, Stress, Temperature, ThermalExpansion,
    Time, Q,
};

/// A value with its display unit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Valued {
    pub value: f64,
    pub unit: String,
}

/// Every Query. Serialised with a `query` tag: `{ "query": "query.model" }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "query")]
pub enum Query {
    /// Lossless portable project snapshot, including all retained solved meshes and f64 fields.
    /// Host storage is separate; capture the checked ReadReply stamp with this owned value.
    #[serde(rename = "query.portableProject")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "PortableProject"))]
    PortableProject {},
    /// Everything about the Model in one read: bodies with volumes and materials, imported
    /// face patches with paste-ready naming predicates, named Sets, constraints, loads with
    /// their totals, steps and predecessor links, mesh settings, and the well-posedness warnings
    /// that would block a solve. Material properties include thermal expansion `alpha` in 1/K,
    /// conductivity `k` in W/(m K), specific heat `cp` in J/(kg K), and the supplied `source`.
    /// Expansion and conductivity preserve one isotropic value or three material-axis values.
    /// Read this before changing anything.
    #[serde(rename = "query.model")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "ModelSummary"))]
    Model {},

    /// The complete authoritative Model file and Journal in SI, with the real Model hash and
    /// revision. Retains selected display-unit strings without formatting a display summary;
    /// use this to save even when query.model reports unit.display. This read changes neither
    /// the Model nor retained Results. Hosts apply their exact UTF-8 save encoder and byte limit
    /// before writing; this Query performs no I/O or replacement validation.
    #[serde(rename = "query.document")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "ModelDocument"))]
    Document {},

    /// The complete upsert Command for an existing object's current definition, with exact
    /// SI quantities. Use it to populate an edit form; change its arguments and dispatch it
    /// to apply. Display summaries are rounded and must never be used to reconstruct edits.
    /// Auto-generated Sets and mesher-owned Bodies have no editable object definition.
    #[serde(rename = "query.definition", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "ObjectDefinition"))]
    Definition { kind: ObjectKind, name: String },

    /// Counts and sanity of the current Mesh (nodes, elements, element kind, DOF, bounding box,
    /// edge lengths, Sets with their resolved sizes, quality). Builds the Mesh if needed.
    #[serde(rename = "query.mesh")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "MeshSummary"))]
    Mesh {},

    /// What a Set resolved to on the current Mesh: kind, count, bounding box, geometric measure
    /// and corner-node centroid. Solid volumes integrate every original shape node, including
    /// Tet10/Hex20 midside nodes: tetrahedron degree3 and tensor degree5 per coordinate are
    /// sufficient for their Jacobian determinants, up to f64 roundoff. Surface areas and edge
    /// lengths use original tangents. Linear triangles and lines are exact up to roundoff;
    /// bilinear faces use Gauss2. Curved norms are numerical, using Gauss3 for Quad8/Line3
    /// and symmetric triangle degree5 for Tri6.
    /// Curved area/length accuracy improves under refinement; no corner skin is substituted.
    /// Face Sets also report pressureArea from the load boundary quadrature,
    /// including thickness or radial weighting (plane strain: one metre of depth). Pressure
    /// times pressureArea is a scalar integral, not a net vector force. Shell pressureArea is
    /// the original midsurface area without requiring Material/Section; curved physical shell
    /// loads use the Section's top/bottom offsets. Builds the Mesh if needed.
    /// The centroid averages resolved node coordinates; authored imported NSETs include
    /// unused source labels. A bounded fixed-order fallback prevents a finite coordinate
    /// mean overflowing through rounding, while preserving existing finite mean results.
    #[serde(rename = "query.set", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "SetInfo"))]
    Set { name: String },

    /// Summary of a Step's Result: solver info, extremes of every field with their location,
    /// reactions per constraint, applied totals, solver-used omitted material assumptions, and
    /// whether the Result is stale (the Model changed after it was solved). Check the reaction
    /// balance and assumptions first.
    #[serde(rename = "query.result", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "ResultSummary"))]
    Result {
        /// Omit for the current per-Step selection; an explicit id uses its solved context.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<String>,
    },

    /// Catalogue of the eight most recent successful solve instances, oldest first. Reads do
    /// not extend retention. Evicted ids are unavailable; Model import/new clears records.
    #[serde(rename = "query.results")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "RetainedResults"))]
    Results {},

    /// The triangulated boundary of a retained Result's solved Mesh, with f64 SI positions,
    /// original node indices, Body identities and face-Set memberships. Explicit resultId
    /// reads that immutable solve even after Model edits; an omitted id selects the latest
    /// compatible Result for step (or the last solved Step), rejecting stale or missing Results.
    /// This never substitutes the current Mesh or a geometry preview. Use query.results for ids.
    #[serde(rename = "query.surface", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "ResultSurface"))]
    Surface {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result_id: Option<String>,
    },

    /// A final field in SI with explicit entity layout, selected by solve instance or the current per-Step default.
    /// Field names include mode:k for one-based modal/buckling shapes owned by the Result
    /// (`1 <= k <= query.result.modeCount`) and stressPly:k:bottom/top
    /// for laminate ply faces (k starts at 1, bottom to top within each Section). Ply stresses
    /// are global xx, yy, zz, xy, xz, yz in Pa, unaveraged per element node; elements without
    /// that ply carry zeros. Both sides of an interface remain distinct. Explicit ids use solved metadata;
    /// omitted ids refuse stale Results. Retained samples use query.frame's existing protocol.
    #[serde(rename = "query.field", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "ResultField"))]
    Field {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result_id: Option<String>,
        field: String,
    },

    /// Subtract two explicitly retained nodal fields as `left - right` on either Result's
    /// Mesh. Unequal meshes use finite-element interpolation and report uncovered nodes as
    /// null values; nonfinite arithmetic is a structured error. No current Result, display
    /// conversion, or node-number pairing is implied. Each operand may independently select
    /// a retained primary frame with the existing exact/nearest FrameSample protocol; resolved
    /// indices and physical times are returned. Historical derived fields are unavailable.
    /// Omitted samples preserve final-field comparison. There is no temporal interpolation.
    #[serde(rename = "query.difference", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "DifferenceField"))]
    Difference { left: DifferenceOperand, right: DifferenceOperand, onto: DifferenceOnto },

    /// Catalogue of retained primary-field frames for heat-transient, explicit or amplitude-driven static Steps (default: last solved Step).
    /// Index 0 is the initial state; indices count retained frames, not integration steps.
    /// Metadata remains available for stale Results. No nodal values are copied by this Query.
    #[serde(rename = "query.frames", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "FramesResult"))]
    Frames {
        /// Omit for the current per-Step selection; an explicit id uses its solved context.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<String>,
    },

    /// One retained primary field from a heat-transient, explicit or amplitude-driven static Step. Supply exactly one of zero-based retained index
    /// or sample (retained index / physical time with exact or nearest selection). Time
    /// selection uses the same roundoff tolerance, earlier-tie rule and no-extrapolation
    /// policy as sampled probe/path. Values are SI,
    /// component-fastest, with three components per node, matching final FieldData: a 2D
    /// displacement has zero z; temperature occupies x with zero y/z. Defaults to the retained
    /// primary field. Derived fields were not retained and are refused. Omitted resultId refuses result.stale.
    #[serde(rename = "query.frame", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "FrameResult"))]
    Frame {
        /// Omit for the current per-Step selection; an explicit id uses its solved context.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sample: Option<FrameSample>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field: Option<Field>,
    },

    /// A field value at a point (default: the last solved Step). Nodal fields are
    /// interpolated; errorEstimate returns the containing element's constant value
    /// with interpolated=false. Shared-face ties use the lowest element id. Component
    /// indices: displacement 0..3, stress Voigt 0..6 (xx, yy, zz, xy, xz, yz), principal 0..3.
    /// Optional sample selects a retained primary-field frame; omitted means the final field.
    /// Omitted resultId refuses `result.stale` after edits; an explicit id uses its solved Mesh.
    #[serde(rename = "query.probe", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "ProbeResult"))]
    Probe {
        /// Omit for the current per-Step selection; an explicit id uses its solved context.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<String>,
        field: Field,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        component: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sample: Option<FrameSample>,
        at: [Q<Length>; 3],
    },

    /// A field sampled at `n` points along the line from `from` to `to`, for a line plot.
    /// Optional sample selects a retained primary-field frame; omitted means the final field.
    /// Omitted resultId refuses `result.stale` after edits; an explicit id uses its solved Mesh.
    #[serde(rename = "query.path", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "PathResult"))]
    Path {
        /// Omit for the current per-Step selection; an explicit id uses its solved context.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<String>,
        field: Field,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        component: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sample: Option<FrameSample>,
        from: [Q<Length>; 3],
        to: [Q<Length>; 3],
        n: u32,
    },

    /// Cost before solving: DOF, matrix non-zero bounds, exact retained-frame schedule and
    /// counted peak memory. Counting uses at most 16 MiB scratch after meshing. Feasibility is
    /// false above a fixed 1.5 GiB planning budget, otherwise unknown because solver fill,
    /// allocator overhead and host serialization are excluded.
    /// Use before large solves; this query does not promise that a solve fits the current host.
    #[serde(rename = "query.cost", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "CostEstimate"))]
    Cost { step: String },

    /// The Journal: every applied Command with the Model hash after it, and whether undo or
    /// redo is possible. `fromSeq` returns only entries at or after that sequence number.
    #[serde(rename = "query.journal", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "JournalDump"))]
    Journal {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_seq: Option<u32>,
    },

    /// Compare this Model's Journal with a supplied base Journal. Returns the shared causal
    /// prefix and each ordered divergent tail: removed entries belong to `base`, added entries
    /// to the current Journal. Entry identity is the typed Command plus `hashAfter`; `seq` is
    /// only a displayed location and is ignored. Entries after the first divergence are not
    /// re-aligned. This read never replays either Journal.
    #[serde(rename = "query.journalDiff", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "JournalDiff"))]
    JournalDiff { base: crate::journal::Journal },

    /// The Journal as a TypeScript script against the `fem` API that reproduces the Model line by
    /// line; what the Script panel shows and what script.run accepts back.
    #[serde(rename = "query.script")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "ScriptText"))]
    Script {},

    /// Convert a quantity to another unit of the same dimension ("2 MPa" to "psi"); an error
    /// names the dimensions when they differ. Handy for checking inputs before using them.
    /// Rejects nonfinite values and nonzero scaling that rounds to zero, including input
    /// scaling before adding a temperature offset. Surviving subnormals, ordinary f64
    /// rounding and affine zeros (273.15 K to 0 degC) remain valid.
    #[serde(rename = "query.convert", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "Converted"))]
    Convert { quantity: Quantity, to: String },

    /// Inspect the supplied Abaqus bundle for missing INCLUDE and NODE/ELEMENT INPUT files.
    /// Uses the same bounded lexer and safe relative-path graph as conversion. This read
    /// performs no model/physics conversion or file/network I/O; hosts can acquire listed
    /// files through their captured scoped I/O and repeat until the bundle is complete.
    /// The actual conversion still rejects missing files and never publishes partial data.
    #[serde(rename = "query.abaqusDependencies", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "AbaqusDependencies"))]
    AbaqusDependencies {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_name: Option<String>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        source_files: BTreeMap<String, String>,
    },

    /// Convert a bounded Abaqus text deck to checked portable Commands without mutating
    /// the active Model or solving. Explicit positive unitLength and static-mode unitForce
    /// define source units; coordinates/displacements scale by L, forces by F and stress
    /// by F/L². Structural instances, labels, exact Sets and surfaces are normalized by
    /// the typed deck reader. The report records all translated analysis Steps and notes
    /// recognized requests whose output/increment execution differs from FEM Lab.
    /// Static mode imports constant isotropic materials and exact nonoverlapping solid
    /// section regions covering every element, direct or solid symbolic BOUNDARY,
    /// CLOAD and uniform DLOAD Pn / DSLOAD P pressure. Multiple small-displacement static
    /// Steps retain effective inherited loads/supports; OP=NEW resets that family's state,
    /// OP=MOD updates it. Conflicting repeated definitions within one Step fail explicitly.
    /// Each Step configures its final linear equilibrium, without source increment history.
    /// Unsupported physics/formulations/parameters fail rather than being discarded.
    /// Mesh mode configures no analysis. Neither mode infers missing physical units.
    /// Input and serialized response are bounded to 16 MiB; hosts must privately prepare
    /// all returned Commands through Candidate and publish one validated replacement.
    #[serde(rename = "query.convertAbaqus", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "AbaqusConversion"))]
    ConvertAbaqus {
        text: String,
        name: String,
        body: String,
        mode: AbaqusImportMode,
        unit_length: Q<Length>,
        /// Mandatory in static mode; absent in mesh mode. Positive force per source force.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit_force: Option<Q<Force>>,
        /// Positive seconds per source time. Required when a DENSITY is translated:
        /// source density scales by F T²/L⁴. No time or mass unit is inferred.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit_time: Option<Q<Time>>,
        /// Logical root filename for resolving an explicitly supplied include bundle.
        /// Paths identify bundle entries only; the engine never reads a file system.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source_name: Option<String>,
        /// Explicit relative filenames and UTF-8 contents for INCLUDE and NODE/ELEMENT INPUT.
        /// Missing/cyclic/escaping references fail; the engine never fetches a file.
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        source_files: BTreeMap<String, String>,
        sha256: String,
    },

    /// Primary-source material data with dimensions, grade, condition, temperature and a source
    /// for every reported property. With no `name`, lists the stable catalogue. With a canonical
    /// id, name or unambiguous alias, returns that entry. Missing properties are explicit nulls:
    /// never infer them before material.add. Copy the entry's `materialAddSource` into that
    /// Command's `source` so the Journal preserves provenance.
    #[serde(rename = "query.materialLibrary", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "MaterialLibrary"))]
    MaterialLibrary {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },

    /// Every nameable thing in the Model as `@`-mention references (`body:beam`, `set:beam.top`,
    /// `material:steel`, `journal:12`), with a one-line summary each; the mention picker's index.
    #[serde(rename = "query.objects", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "ObjectList"))]
    Objects {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kinds: Option<Vec<ObjectKind>>,
    },

    /// The whole analysis as one Markdown calculation note: assumptions, geometry, materials,
    /// mesh and quality, loads with totals, results with the reaction balance, the verification
    /// checks with a hand calculation where one applies, and the Journal as an appendix. Nothing
    /// in it depends on the clock or the machine, so two runs of the same Journal produce
    /// byte-identical text. `step` reports one Step instead of every solved one; `include` picks
    /// sections. Automatic hand references require a current static Step on an uncut 3D lattice
    /// box with one fully clamped end and one single-component force on the opposite end;
    /// other cases explicitly report no applicable automatic reference. Formulas are `$$…$$` for KaTeX.
    #[serde(rename = "query.report", rename_all = "camelCase")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "ReportText"))]
    Report {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        include: Option<Vec<crate::report::ReportSection>>,
    },

    /// What this engine can do here: GPU presence and adapter name, thread count, engine and
    /// schema versions. Hosts add browser facts (cross-origin isolation, local or remote engine).
    #[serde(rename = "query.capabilities")]
    #[schemars(extend("x-execution" = "modelRead"))]
    #[schemars(extend("x-returns" = "Capabilities"))]
    Capabilities {},
}

impl Query {
    pub fn name(&self) -> String {
        let v = serde_json::to_value(self).unwrap_or_default();
        v.get("query").and_then(|c| c.as_str()).unwrap_or("?").to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BodyRow {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<String>,
    pub bbox: [Valued; 6],
    /// Volume for solids, area for 2D sheets.
    pub measure: Valued,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mass: Option<Valued>,
    /// Auto-named faces of this body (`beam.xmin` …), plus its cuts' faces.
    pub faces: Vec<String>,
    /// Measured source patches and durable naming suggestions, for an imported mesh Body.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub patches: Vec<ImportedPatchRow>,
}

/// One face patch of an imported mesh Body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPatchRow {
    /// The import's ordinal face name. Use `suggestedPredicate` to create a durable name.
    pub tag: String,
    pub triangle_count: u32,
    pub area: Valued,
    pub centroid: [Valued; 3],
    /// Area-weighted mean of the triangles' outward unit normals. It is zero for a complete curved side.
    pub mean_normal: [f64; 3],
    /// Paste this value into `geometry.nameFace.where`.
    pub suggested_predicate: crate::command::FacePredicate,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MaterialRow {
    pub name: String,
    /// Young's modulus for isotropic stiffness; absent for orthotropic or thermal-only materials.
    #[serde(rename = "E", default, skip_serializing_if = "Option::is_none")]
    pub e: Option<Valued>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nu: Option<f64>,
    /// The nine orthotropic constants in the material axes, when the material is orthotropic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orthotropic: Option<OrthotropicRow>,
    /// Where the material axes point, when they are not the global ones.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orientation: Option<OrientationRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rho: Option<Valued>,
    /// Thermal expansion in 1/K, as one isotropic value or three values in material-axis order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpha: Option<AxialRow>,
    /// Conductivity in W/(m K), as one isotropic value or three values in material-axis order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub k: Option<AxialRow>,
    /// Specific heat in J/(kg K), when specified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cp: Option<Valued>,
    /// Current yield strength in the Model's display stress unit, when specified.
    #[serde(rename = "yield", default, skip_serializing_if = "Option::is_none")]
    pub yield_: Option<Valued>,
    /// Whether the Material carries a plasticity block (J2, isotropic hardening).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub plasticity: bool,
    /// The material definition's property source or citation, when supplied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub assigned_to: Vec<String>,
}

/// One isotropic property or its three material-axis values, each with an explicit unit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum AxialRow {
    Isotropic(Valued),
    Axes([Valued; 3]),
}

/// The orthotropic constants of a Material, in the Model's display stress unit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OrthotropicRow {
    #[serde(rename = "E1")]
    pub e1: Valued,
    #[serde(rename = "E2")]
    pub e2: Valued,
    #[serde(rename = "E3")]
    pub e3: Valued,
    #[serde(rename = "G12")]
    pub g12: Valued,
    #[serde(rename = "G13")]
    pub g13: Valued,
    #[serde(rename = "G23")]
    pub g23: Valued,
    pub nu12: f64,
    pub nu13: f64,
    pub nu23: f64,
}

/// A Material's axes: `angle` degrees about the unit `axis`, which is how `material.add` took
/// them and how the report and the tree read them back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OrientationRow {
    pub axis: [f64; 3],
    pub degrees: f64,
}

/// One primary source used by [`MaterialLibrary`]. Property `source` fields name its `id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MaterialCitation {
    pub id: String,
    pub organization: String,
    pub title: String,
    pub url: String,
    pub locator: String,
    pub retrieved_on: String,
}

macro_rules! sourced_quantity {
    ($name:ident, $dim:ty) => {
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            pub value: Q<$dim>,
            /// The exact grade, direction, statistic or test condition to which the value applies.
            pub basis: String,
            /// A [`MaterialCitation::id`].
            pub source: String,
        }
    };
}

sourced_quantity!(SourcedStress, Stress);
sourced_quantity!(SourcedDensity, Density);
sourced_quantity!(SourcedRatio, Dimensionless);
sourced_quantity!(SourcedThermalExpansion, ThermalExpansion);
sourced_quantity!(SourcedConductivity, Conductivity);
sourced_quantity!(SourcedSpecificHeat, SpecificHeat);

/// A documented catalogue entry. Every optional property serializes as a value or `null`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MaterialLibraryEntry {
    pub id: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub specification: String,
    pub product_form: String,
    pub condition: String,
    pub temperature: Option<Q<Temperature>>,
    pub temperature_basis: String,
    #[serde(rename = "E")]
    pub e: Option<SourcedStress>,
    pub nu: Option<SourcedRatio>,
    pub rho: Option<SourcedDensity>,
    pub alpha: Option<SourcedThermalExpansion>,
    pub k: Option<SourcedConductivity>,
    pub cp: Option<SourcedSpecificHeat>,
    #[serde(rename = "yield")]
    pub yield_: Option<SourcedStress>,
    /// Limitations that prevent a reported value from being treated as a generic default.
    pub limitations: Vec<String>,
    /// Ready to copy into `material.add.source` with the applicable reported values.
    pub material_add_source: String,
}

/// `query.materialLibrary` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MaterialLibrary {
    pub entries: Vec<MaterialLibraryEntry>,
    pub sources: Vec<MaterialCitation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetRow {
    pub name: String,
    pub kind: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintRow {
    pub name: String,
    pub on: String,
    pub summary: String,
}

/// One connection between parts: a bonded contact, listed apart from the Constraints because
/// it prescribes nothing and names two Sets. Pair counts and gaps are not here: they exist only
/// on a built Mesh, and a Model summary must answer before there is one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRow {
    pub name: String,
    pub kind: String,
    pub master: String,
    pub slave: String,
    pub summary: String,
}

/// One lumped point mass: where it sits and how heavy it is. It is also a node Set of the same
/// name, which is what constraint.couple, load.force and query.set target.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PointRow {
    pub name: String,
    pub at: [Valued; 3],
    pub mass: Valued,
    /// The Constraints that attach it, empty when nothing does — which makes a Step ill-posed.
    pub coupled_by: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LoadRow {
    pub name: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<String>,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StepRow {
    pub name: String,
    pub procedure: String,
    pub constraints: Vec<String>,
    pub loads: Vec<String>,
    /// Earlier Step whose Result this Step continues, including heat-to-stress coupling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    pub solved: bool,
}

/// `query.model` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    pub name: String,
    pub revision: u32,
    pub hash: String,
    pub units: crate::units::UnitSet,
    pub idealisation: String,
    pub bodies: Vec<BodyRow>,
    pub materials: Vec<MaterialRow>,
    pub sets: Vec<SetRow>,
    pub constraints: Vec<ConstraintRow>,
    pub connections: Vec<ConnectionRow>,
    /// Lumped point masses; omitted when the Model has none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<PointRow>,
    pub loads: Vec<LoadRow>,
    pub steps: Vec<StepRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_settings: Option<crate::model::MeshSettings>,
    pub warnings: Vec<Warning>,
}

/// `query.mesh` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MeshSummary {
    /// Source labels in dense node/element order for an imported source; absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_labels: Option<crate::imported::SourceLabels>,
    pub nodes: u32,
    pub elements: u32,
    pub element_kind: String,
    pub dofs: u32,
    pub bbox: [Valued; 6],
    pub min_edge: Valued,
    pub max_edge: Valued,
    pub sets: Vec<SetRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<QualitySummary>,
}

/// Mesh quality inside `query.mesh`: worst-case ratios and the elements that set them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QualitySummary {
    /// Smallest corner `min(det J) / max(det J)`; 1 is perfect, 0 degenerate, negative inverted.
    pub min_det_j_ratio: f64,
    /// Largest longest-edge over shortest-edge ratio.
    pub max_aspect: f64,
    /// Smallest angle at any element corner, in degrees.
    pub min_angle_deg: f64,
    /// Smallest interior angle between two faces meeting at an element edge, in degrees. Absent
    /// for a 2D mesh. This is the number that judges a tetrahedral mesh: `minDetJRatio` is
    /// identically 1 for a simplex whatever its shape. The free tet mesher holds it inside
    /// [10.7, 164.8]; below about 10 degrees the element stiffness is badly conditioned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_dihedral_deg: Option<f64>,
    /// Largest interior angle between two faces meeting at an element edge, in degrees. Absent
    /// for a 2D mesh; 180 is a flat sliver.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_dihedral_deg: Option<f64>,
    pub worst: Vec<QualityRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QualityRow {
    pub element: u32,
    pub value: f64,
}

/// `query.set` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetInfo {
    /// Authored membership for an imported node Set, including retained unused labels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_node_labels: Option<Vec<u32>>,
    /// These source nodes have no FE DOFs and cannot be load/support targets.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unused_source_node_labels: Vec<u32>,
    pub name: String,
    pub kind: String,
    pub count: u32,
    pub bbox: [Valued; 6],
    pub measure: Valued,
    /// Effective loaded area from the pressure/traction boundary quadrature, including plane
    /// stress thickness or axisymmetric 2πr. Plane strain uses one metre of out-of-plane depth.
    /// Null for non-face Sets. Pressure times this area is a scalar, not a net vector force.
    pub pressure_area: Option<Valued>,
    pub centroid: [Valued; 3],
}

/// One extreme of a field component.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Extreme {
    pub field: String,
    pub component: u8,
    pub min: Valued,
    pub min_at: [Valued; 3],
    pub max: Valued,
    pub max_at: [Valued; 3],
}

/// An omitted optional material property that a successful solve read as its resolved zero.
/// The value is kept in SI with the Result, so later unit, name and material edits cannot
/// rewrite the assumption under an already-computed answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AssumedMaterialProperty {
    Rho,
    Alpha,
}

/// One solver-used material assumption captured at solve time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResultAssumption {
    pub step: String,
    pub body: String,
    pub material: String,
    pub property: AssumedMaterialProperty,
    pub value: Valued,
    /// The Material provenance at solve time; null when the Material named none.
    pub source: Option<String>,
    pub cause: String,
}

/// `query.result` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResultSummary {
    /// Opaque identity scoped to the Engine instance that produced this solve.
    pub result_id: String,
    pub step: String,
    /// The Journal revision after the Command that produced this Result. It stays fixed while
    /// later edits make the Result stale and when undo removes that producing Command.
    pub revision: u32,
    pub stale: bool,
    pub solver: String,
    pub iterations: u32,
    /// The solver's measured residual. For modal Results, the maximum requested-pair normwise
    /// generalized-eigenproblem backward residual, not a frequency or mesh error estimate.
    pub residual: f64,
    pub time_ms: f64,
    pub extremes: Vec<Extreme>,
    /// Force for structural Results; power for thermal Results, retained with the solved state.
    pub reaction_quantity: crate::units::ReactionQuantity,
    pub reactions: Vec<ReactionRow>,
    /// Applied force vector or net thermal power (flux/source plus incoming minus outgoing
    /// convection and radiation) in component 0, with remaining thermal components zero.
    pub applied_total: [Valued; 3],
    /// Retained force and moment accounting for linear Cartesian static Results only.
    /// Absent for thermal, dynamic, eigen, nonlinear and axisymmetric procedures. A
    /// nonrepresentable SI wrench or preferred-unit ledger rejects a solve or retaining
    /// study before Result publication. If later display units cannot represent the
    /// retained values, this Query returns a structured error; model.setUnits with
    /// force N and length m restores readable SI quantities.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub static_equilibrium: Option<Box<StaticEquilibrium>>,
    /// Thermal stored-energy rate in power display units (zero for steady heat). Transient
    /// power totals/reactions use the last θ-method integration stage; the temperature field
    /// itself is at the final time. Positive reactions remove heat: applied − removed = storage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_power: Option<Valued>,
    /// The fraction of the integration points whose equivalent plastic strain is positive:
    /// how much of the Model has yielded. Only a `static-nonlinear` Step with an
    /// elastic–plastic Material reports it; 0 there means everything stayed elastic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yielded_fraction: Option<f64>,
    /// Optional material properties the successful procedure actually read as zero because the
    /// Material omitted them. Empty when every solver-used property was explicit.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assumptions: Vec<ResultAssumption>,
    /// Number of displacement mode shapes owned by this retained Result. Fields `mode:k`
    /// are available for `1 <= k <= modeCount`; frequency metadata alone does not identify
    /// available fields. Modal and buckling Results own shapes; harmonic and random-vibration
    /// Results own response fields instead, even when they retain modal-basis metadata.
    pub mode_count: u32,
    /// Natural frequencies in ascending order for a modal Result, or its modal basis for a
    /// harmonic response. Use `modeCount`, not the frequency count, to discover mode fields.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub frequencies: Vec<Valued>,
    /// The preload Step whose stress state stiffened these frequencies, present only on a
    /// prestressed modal Result: the Step named by `after`, solved statically, whose stress
    /// was added to the stiffness as `K_sigma` before the eigenproblem. Absent means the
    /// frequencies are those of the unloaded structure. Kept with the Result, so it still says
    /// which preload produced these numbers after the Model has moved on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prestress_from: Option<String>,
    /// Buckling load factors, smallest magnitude first and dimensionless; empty unless the Step
    /// was a buckling one. Multiply the Step's Loads by one to get its critical load; a negative
    /// factor buckles under the reversed load. Factor `k`'s shape is the field named `mode:k`,
    /// and it has arbitrary amplitude: it says where the structure buckles, not how far. The
    /// factor is an upper bound — imperfections, pre-buckling rotation and yielding all lower
    /// the real capacity — so it is not a safety factor.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub buckling_factors: Vec<f64>,
    /// One row per retained output time: when, and the range the field covered.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<HistoryRow>,
    /// One row per retained frequency of a harmonic sweep; empty for every other procedure.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sweep: Vec<SweepRow>,
    /// Structural force equilibrium: |Σ reactions + Σ applied| / force scale. Linear
    /// Cartesian static uses retained unaggregated nodal force/moment actions, with M/L
    /// converting moments to force. Actual residuals and scales are in staticEquilibrium;
    /// no residual is snapped to zero. Other structural procedures retain their existing
    /// largest-force scale. Thermal
    /// conservation: |net applied − removed − storage| divided by Σ|Kij Tθj| + Σ|fi| +
    /// Σ|C dT/dt|, an assembled-power scale that remains meaningful at zero net heat flow.
    /// Zero is perfect balance; values above 1e-9 fail the report's conservation check.
    pub balance: f64,
    /// One row per frictionless contact the Step listed: how much of the paired slave face
    /// ended in contact and the resultant it carries. Empty for a Step without one. These forces
    /// are internal to the assembly — they are what one part pushes on the other with — so they
    /// are not in `reactions` and do not enter `balance`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub contacts: Vec<ContactRow>,
    /// What the solve wanted the user to know but would not stop for: a bonded contact tied
    /// across a gap, a slave face coarser than its master, a frictionless pair that ended fully
    /// open. Retained with the Result.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<Warning>,
}

/// Linear Cartesian static equilibrium, retained with the solved state in SI and displayed
/// in the requested unit set. Moments use reference-configuration node coordinates.
/// A passing force check alone is not moment conservation: translation-only bonded ties
/// across a gap can transfer a force without its offset couple, leaving a real angular
/// residual. This diagnostic exposes that model behavior without changing tie mechanics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StaticEquilibrium {
    /// First retained Mesh node: the origin used by all applied/support moments.
    pub reference: [Valued; 3],
    /// Maximum node distance from reference; independent of element length, covariant under
    /// rigid frame changes. A zero-span force-only ledger has no moment-derived force scale.
    pub characteristic_length: Valued,
    /// Actual vector Σ applied forces + Σ support forces, never rounded away.
    pub force_residual: [Valued; 3],
    /// max(Σ|F_applied,node|, Σ|F_support,node|, Σ|M_applied,node|/L, Σ|M_support,node|/L).
    /// Each nodal moment includes its force lever arm plus rotational couple. Summing
    /// magnitudes before Constraint grouping preserves scales for opposing actions.
    pub force_scale: Valued,
    /// Σ((x-reference)×F_applied + applied rotational couple).
    pub applied_moment: [Valued; 3],
    /// Each Constraint's support moment, including force lever arms and raw rotational
    /// reactions; DOFs shared by Constraints belong to the first owner, as for reactions.
    pub reaction_moments: Vec<MomentReactionRow>,
    /// Actual vector Σ applied moments + Σ support moments about reference.
    pub moment_residual: [Valued; 3],
    /// max(Σ|M_applied,node|, Σ|M_support,node|, LΣ|F_applied,node|, LΣ|F_support,node|).
    pub moment_scale: Valued,
    /// |momentResidual| / momentScale. Exact zero action/residual gives zero; no epsilon.
    /// The report checks this separately from force balance at its conservation tolerance.
    pub moment_balance: f64,
}

/// One Constraint's support moment about the static equilibrium reference, in torque units.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MomentReactionRow {
    pub constraint: String,
    pub total: [Valued; 3],
}

/// One frictionless contact of a solved Step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContactRow {
    pub contact: String,
    /// Slave nodes held on the master surface at the end of the Step.
    pub active: usize,
    /// Slave nodes the search found within `tol` of the master: the ones that could touch.
    pub paired: usize,
    /// `active / paired`: 1 is a face fully in contact, 0 a pair that has opened completely.
    pub active_fraction: f64,
    /// The resultant of the normal forces the master exerts on the slave, in the Model's force
    /// unit: the load the contact transmits.
    pub force: [Valued; 3],
}

/// One retained frequency of a harmonic sweep.
///
/// `amplitude` is the largest displacement amplitude any DOF reached at this frequency, and
/// `phase` is that same DOF's lag behind the driving load, so the pair describes one real
/// motion: `u(t) = amplitude · cos(2π f t − phase)`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SweepRow {
    pub frequency: Valued,
    pub amplitude: Valued,
    pub phase: Valued,
}

/// One retained output time in a Step's history: the extremes of the field at that instant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub time: Valued,
    pub min: Valued,
    pub max: Valued,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReactionRow {
    pub constraint: String,
    pub total: [Valued; 3],
}

/// How to select retained output; there is no temporal interpolation or extrapolation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FrameSample {
    Frame { index: u32 },
    Time { time: Q<Time>, sampling: TimeSampling },
}

/// Exact accepts SI conversion roundoff only: 8 epsilon times the larger absolute time.
/// Nearest explicitly selects a retained time; equal-distance ties (within the same relative
/// roundoff bound on the distances) choose the earlier frame.
/// Both reject times outside the retained interval (except endpoint conversion roundoff).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TimeSampling {
    Exact,
    Nearest,
}

/// One retained frame's zero-based index and time in seconds and Model display units.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FrameStamp {
    pub index: u32,
    pub time_si: f64,
    pub time: Valued,
}

/// Result identity and the actual resolved sample. The solved Model hash is not a solve-instance
/// counter: hosts must invalidate frame caches on solve acknowledgements, even for the same Model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedFrame {
    /// Opaque identity scoped to the Engine instance that produced this solve.
    pub result_id: String,
    pub step: String,
    pub model_hash: String,
    pub frame: FrameStamp,
}

/// `query.frames` response; stored components describe the unpadded History storage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FramesResult {
    /// Opaque identity scoped to the Engine instance that produced this solve.
    pub result_id: String,
    pub step: String,
    pub model_hash: String,
    pub stale: bool,
    pub node_count: usize,
    pub field: Field,
    /// Public field layout, matching final FieldData (three components, zero-padded).
    pub components: usize,
    pub stored_components: usize,
    /// Logical bytes of retained f64 times and unpadded primary values; excludes allocator
    /// overhead, spare capacity, final derived fields and temporary Query response copies.
    pub retained_bytes: u64,
    pub frames: Vec<FrameStamp>,
}

/// `query.frame` response: SI values in the existing component-fastest FieldData layout.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FrameResult {
    pub sample: ResolvedFrame,
    pub field: Field,
    pub components: usize,
    pub node_count: usize,
    /// SI unit for values: K for temperature, m for displacement, never a display unit.
    pub unit: String,
    pub values: Vec<f64>,
}

/// `query.probe` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample: Option<ResolvedFrame>,
    pub value: Valued,
    pub element: u32,
    pub interpolated: bool,
}

/// `query.path` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PathResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample: Option<ResolvedFrame>,
    pub s: Vec<f64>,
    pub values: Vec<Option<f64>>,
    pub unit: String,
}

/// `query.cost` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CostEstimate {
    pub dofs: u64,
    /// Upper bound on matrix non-zeros; exact when equal to nnzLower.
    pub nnz: u64,
    /// Lower bound on matrix non-zeros.
    pub nnz_lower: u64,
    /// Estimated peak of the counted solve and frame-read phases. It includes mandatory
    /// assembly storage, retained primary values, a conservative transient f64 working-vector
    /// allowance and known native/browser frame-response storage. It is incomplete because
    /// solver fill, JSON and allocator overhead are not known before solving.
    pub bytes: u64,
    /// Mandatory assembly storage before transient-specific values are added.
    pub assembly_bytes: u64,
    /// Numeric fields and Mesh snapshots of every existing retained Result; none is evicted before success.
    pub resident_result_bytes: u64,
    /// Numeric Mesh snapshot created for the new Result; excludes Model and allocator overhead.
    pub result_mesh_bytes: u64,
    /// Initial state, requested stride and a unique final endpoint; zero for steady/modal Steps.
    pub retained_frames: u64,
    /// Logical f64 bytes for retained times and unpadded primary values, or random-response RMS fields.
    pub retained_bytes: u64,
    /// Conservative full-field allowance for procedure working f64 vectors live with History or RMS fields.
    /// Free-DOF vectors are charged at the full nodal length.
    pub transient_work_bytes: u64,
    /// One normalized three-component f64 frame owned by a native Query result.
    pub transport_staging_bytes: u64,
    /// Known lower bound for the WASM/Worker frame route while two normalized three-component
    /// numeric payloads coexist. JSON strings and JavaScript array/object overhead are additional.
    pub wasm_transport_staging_bytes: u64,
    /// False while the generic JSON route has value- and runtime-dependent allocation overhead.
    pub wasm_transport_staging_complete: bool,
    /// Fixed 1.5 GiB planning budget; not measured free memory on the current host.
    pub budget_bytes: u64,
    /// False if the counted conservative estimate exceeds the planning budget; null means
    /// feasibility is unknown. Fitting it does not establish that assembly or factorisation fits.
    pub feasible: Option<bool>,
    pub note: String,
}

/// `query.journal` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JournalDump {
    /// Complete-history hash, independent of `fromSeq`; pass as journal.undo expectedJournal.
    pub hash: String,
    pub entries: Vec<crate::journal::JournalEntry>,
    pub revision: u32,
    pub can_undo: bool,
    pub can_redo: bool,
}

/// `query.journalDiff` response. Journals are causal histories, so this is a shared-prefix
/// comparison rather than a text diff that aligns similar Commands after histories diverge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JournalDiff {
    /// Hash of every supplied base entry, including its `seq` labels. A noncanonical supplied
    /// `seq` can therefore change this hash without changing `sharedEntries`.
    pub base_hash: String,
    pub current_hash: String,
    pub shared_entries: u32,
    /// The base Journal's ordered tail after `sharedEntries`.
    pub removed: Vec<crate::journal::JournalEntry>,
    /// The current Journal's ordered tail after `sharedEntries`.
    pub added: Vec<crate::journal::JournalEntry>,
}

/// `query.script` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ScriptText {
    pub text: String,
}

/// `query.convert` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Converted {
    pub value: f64,
    pub unit: String,
}

/// The chosen strict subset; unsupported physics is rejected rather than discarded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum AbaqusImportMode {
    Mesh,
    Static,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum AbaqusSetKind {
    Node,
    Element,
    Face,
}

/// One authored Abaqus Set or numeric node target and its exact qualified FEM Lab name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AbaqusSetMapping {
    pub kind: AbaqusSetKind,
    pub source: String,
    pub target: String,
    pub count: u32,
}

/// One source section's exact material-to-Body assignment. Shared labelled nodes retain
/// their identity across section regions; no interface is welded or disconnected.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AbaqusSectionMapping {
    pub section_elset: String,
    /// Exact source material label, including its quoted case and punctuation.
    pub source_material: String,
    /// Callable material identifier; differs only when the source label cannot be used
    /// as an ordinary FEM Lab object name.
    pub material: String,
    pub body: String,
    pub elements: u32,
}

/// A recognized source request or solver setting with an explicit import consequence.
/// Notes never stand in for silently discarded physical definitions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AbaqusImportNote {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub line: usize,
    pub keyword: String,
    pub cause: String,
}

/// Missing relative source filenames, discovered without any host I/O or Model mutation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AbaqusDependencies {
    pub missing_files: Vec<String>,
}

/// Retained static load case. Only the final linear equilibrium is configured;
/// there is no Abaqus increment history and conversion never produces a solved Result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AbaqusStaticAnalysis {
    /// First material, retained for compatibility; `materials` lists the complete case.
    pub material: String,
    /// First section, retained for compatibility; `sections` gives every exact assignment.
    pub section_elset: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub materials: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sections: Vec<AbaqusSectionMapping>,
    /// Exact source Step label; `step` is its callable FEM Lab identifier.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source_step: String,
    pub step: String,
    pub constraints: Vec<String>,
    pub loads: Vec<String>,
    pub final_equilibrium_only: bool,
}

/// Source metadata and physical bounds; unused nodes remain authored source data but do not
/// contribute to these bounds or receive fabricated finite-element DOFs/Result values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AbaqusConversionReport {
    pub mode: AbaqusImportMode,
    pub sha256: String,
    pub conversion_version: String,
    /// Root plus all explicitly supplied source-file UTF-8 bytes; repeated INCLUDE expansion is bounded separately.
    pub input_bytes: u32,
    pub body: String,
    /// Metres per source coordinate, as an explicit SI Quantity.
    pub unit_length: Q<Length>,
    /// Newtons per source force, present only for static analysis conversion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit_force: Option<Q<Force>>,
    /// Explicit seconds per source time; present when supplied for material density.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit_time: Option<Q<Time>>,
    pub source_nodes: u32,
    pub active_nodes: u32,
    pub source_elements: u32,
    pub element_kind: crate::command::ImportedElementKind,
    /// Every authored kind in first-source-occurrence order; `elementKind` remains the
    /// first kind for compatibility and must not be read as a homogeneous-mesh claim.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub element_kinds: Vec<crate::command::ImportedElementKind>,
    /// Mesh mode supplies no materials or Steps; the host must configure analysis explicitly.
    pub analysis_configured: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analysis: Option<AbaqusStaticAnalysis>,
    /// All imported analysis Steps in source order; `analysis` is its first entry for
    /// compatibility. Every case contains its effective inherited supports and loads.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub analyses: Vec<AbaqusStaticAnalysis>,
    /// Recognized output/solver requests whose execution differs in FEM Lab.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<AbaqusImportNote>,
    /// Physical participating-node bounds: xmin/ymin/zmin/xmax/ymax/zmax in metres.
    pub bbox: [Q<Length>; 6],
    pub source_labels: crate::imported::SourceLabels,
    pub sets: Vec<AbaqusSetMapping>,
    pub headings: Vec<String>,
    /// All authored ECHO/MODEL/HISTORY/CONTACT YES/NO flags, without implied execution.
    pub preprint: Vec<BTreeMap<String, bool>>,
}

/// Checked portable conversion. Publication requires the host's exact Candidate preparation
/// and serialized Model-file limit; receiving this response never changes the active Model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AbaqusConversion {
    pub report: AbaqusConversionReport,
    pub commands: Vec<Command>,
}

/// One `@`-mentionable object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRef {
    /// `body:beam`, `set:beam.top`, `journal:12`.
    #[serde(rename = "ref")]
    pub ref_: String,
    pub kind: String,
    pub name: String,
    pub summary: String,
}

/// `query.objects` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ObjectList {
    pub objects: Vec<ObjectRef>,
}

/// `query.report` response: the Markdown document and the sections it actually contains.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReportText {
    pub markdown: String,
    pub sections: Vec<String>,
}

/// `query.capabilities` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub gpu: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter: Option<String>,
    pub threads: u32,
    pub engine_version: String,
    pub schema_version: String,
}

/// Any Query response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum QueryResult {
    Model(ModelSummary),
    Document(ModelDocument),
    Project(crate::portable::PortableProject),
    Definition(ObjectDefinition),
    Mesh(MeshSummary),
    Set(SetInfo),
    Result(ResultSummary),
    Results(RetainedResults),
    Surface(ResultSurface),
    Field(ResultField),
    Difference(DifferenceField),
    Frames(FramesResult),
    Frame(FrameResult),
    Probe(ProbeResult),
    Path(PathResult),
    Cost(CostEstimate),
    Journal(JournalDump),
    JournalDiff(JournalDiff),
    Script(ScriptText),
    Converted(Converted),
    AbaqusConversion(AbaqusConversion),
    AbaqusDependencies(AbaqusDependencies),
    MaterialLibrary(MaterialLibrary),
    Objects(ObjectList),
    Capabilities(Capabilities),
    Report(ReportText),
}

/// An owned SI document read. Execution identity belongs to the enclosing checked ReadReply,
/// not to the portable file; display formatting is deliberately absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ModelDocument {
    pub file: crate::journal::ModelFile,
    pub hash: String,
    pub revision: u32,
}

/// Lossless input for editing one Model object through the same Command used to create it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ObjectDefinition {
    pub command: Command,
}

/// Acknowledgement of a dispatched Command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Ack {
    /// Sequence number of the Journal entry (undo/redo report the new revision instead).
    pub seq: u32,
    /// Journal length after the Command.
    pub revision: u32,
    /// Model hash after the Command.
    pub hash: String,
    pub warnings: Vec<Warning>,
    pub output: Output,
}

/// What a Command produced beyond changing the Model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Output {
    None,
    /// A create Command re-issued with an existing name edited that object.
    Replaced {
        kind: ObjectKind,
        name: String,
    },
    // Boxed, and not a doc comment because the reason is internal and would reach the schema:
    // a Result summary is much larger than every other variant of an enum returned by value
    // from every Command. `Box` changes neither the serde shape nor the JSON schema.
    Solve {
        summary: Box<ResultSummary>,
    },
    Study {
        report: StudyReport,
    },
    Adapt {
        report: AdaptReport,
    },
    /// A file `mesh.export` produced, for the host to save.
    Export {
        format: crate::command::ExportFormat,
        filename: String,
        mime: String,
        text: String,
    },
    Undo {
        steps: u32,
    },
    Redo {
        steps: u32,
    },
}

/// Adaptive spatial-error study. The retained Result owns the final element field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdaptReport {
    pub rows: Vec<AdaptRow>,
    pub converged: bool,
    pub target_error: f64,
    pub result_id: String,
    pub refinements: Vec<Vec<crate::command::SizeBoxSpec>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdaptRow {
    pub elements: u64,
    pub dofs: u64,
    pub estimated_error: f64,
    pub time_ms: f64,
}

/// `study.converge` output.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StudyReport {
    pub rows: Vec<StudyRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extrapolated: Option<f64>,
    pub unit: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StudyRow {
    pub size: Valued,
    pub dofs: u64,
    pub value: f64,
    pub time_ms: f64,
}

/// The whole schema document hosts generate code from.
pub fn schema_document() -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": crate::SCHEMA_VERSION,
        "commands": schemars::schema_for!(Command),
        "queries": schemars::schema_for!(Query),
        "queryResult": schemars::schema_for!(QueryResult),
        "ack": schemars::schema_for!(Ack),
        "error": schemars::schema_for!(crate::error::Error),
        "modelFile": schemars::schema_for!(crate::journal::ModelFile),
        "portableProject": schemars::schema_for!(crate::portable::PortableProject),
        "writeRequest": schemars::schema_for!(crate::session::WriteRequest),
        "readRequest": schemars::schema_for!(crate::session::ReadRequest),
        "stamp": schemars::schema_for!(crate::session::Stamp),
        "executionPolicy": schemars::schema_for!(crate::session::ExecutionPolicy),
        "writeReply": schemars::schema_for!(crate::session_owner::WriteReply),
        "readReply": schemars::schema_for!(crate::session_owner::ReadReply),
        "runLease": schemars::schema_for!(crate::session_owner::RunLease),
        "documentSnapshot": schemars::schema_for!(crate::session_owner::DocumentSnapshot),
        "replacementTicket": schemars::schema_for!(crate::replacement::ReplacementTicket),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_schema_document() {
        assert_eq!(Query::Model {}.name(), "query.model");
        assert_eq!(Query::Convert { quantity: Quantity::text("1 m"), to: "mm".into() }.name(), "query.convert");
        assert_eq!(Query::MaterialLibrary { name: None }.name(), "query.materialLibrary");
        let doc = schema_document();
        assert_eq!(doc["schemaVersion"], crate::SCHEMA_VERSION);
        let variants = doc["commands"]["oneOf"].as_array().unwrap();
        let n = variants.len();
        assert!(n >= 30, "{n}");
        for v in variants {
            let desc = v["description"].as_str().unwrap_or("");
            let name = v["properties"]["cmd"]["const"].as_str().unwrap();
            assert!(v["x-execution"].is_string(), "{name}: execution policy required");
            let dl = desc.len();
            assert!(dl >= 80, "{name}: description too short ({dl}): {desc}");
        }
        let qs = doc["queries"]["oneOf"].as_array().unwrap();
        let defs = doc["queryResult"]["$defs"].as_object().unwrap();
        for q in qs {
            let name = q["properties"]["query"]["const"].as_str().unwrap();
            assert!(q["description"].as_str().unwrap_or("").len() >= 80, "{name}");
            assert_eq!(q["x-execution"], "modelRead");
            let ret = q["x-returns"].as_str().expect("every Query names its response type");
            assert!(defs.contains_key(ret), "{name}: {ret}");
        }
        // every physical field is a Q_* reference, never a bare number
        let s = serde_json::to_string(&doc["commands"]).unwrap();
        assert!(s.contains("Q_length") && s.contains("Q_stress") && s.contains("x-dimension"));
        let stub = variants.iter().find(|v| v["properties"]["cmd"]["const"] == "plugin.load").unwrap();
        assert_eq!(stub["x-status"], "stub");
    }
}

/// One immutable solve instance. Byte counts describe payloads, not allocator or peak memory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RetainedResult {
    pub id: String,
    pub step: String,
    pub solved_revision: u32,
    pub model_name: String,
    pub model_hash: String,
    pub input_hash: String,
    pub stale: bool,
    pub nodes: usize,
    pub elements: usize,
    /// f64 arrays in final fields, modes, frequencies and retained History.
    pub field_bytes: u64,
    /// Numeric coordinates, connectivity and resolved geometry Sets; excludes container overhead.
    pub mesh_bytes: u64,
    /// Serialized solved Model metadata size, not its in-memory allocation size.
    pub model_json_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RetainedResults {
    pub limit: usize,
    pub records: Vec<RetainedResult>,
}

/// A solved Mesh surface. Flat arrays preserve original node identities for field lookup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResultSurface {
    /// Authored label mapping for this retained Mesh, independent of later source edits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_labels: Option<crate::imported::SourceLabels>,
    pub result_id: String,
    pub step: String,
    pub node_count: usize,
    /// Position unit, always metres.
    pub unit: String,
    /// Every solved Mesh node, xyz component-fastest, in f64 SI.
    pub positions: Vec<f64>,
    /// Triangle node indices, three per triangle, oriented outward.
    pub indices: Vec<u32>,
    /// Index into element-node fields for each triangle corner, in the same order as indices.
    /// Shared mesh nodes retain distinct field values on their incident elements.
    pub tri_element_node: Vec<u32>,
    pub tri_body: Vec<u32>,
    /// Global element behind each surface triangle; indexes element-based Result fields.
    pub tri_element: Vec<u32>,
    /// First face Set for each triangle; u32::MAX means no face Set (including 2D interiors).
    pub tri_face: Vec<u32>,
    pub face_names: Vec<String>,
    /// Every named Set, including overlapping face aliases; memberships are CSR by triangle.
    pub set_names: Vec<String>,
    pub tri_set_offsets: Vec<u32>,
    pub tri_sets: Vec<u32>,
    pub body_names: Vec<String>,
    /// Sheet boundary edges and line members, two node indices per segment.
    pub edges: Vec<u32>,
    /// Global element behind each boundary edge or line member; indexes element-based fields.
    pub edge_element: Vec<u32>,
    /// Element-node field index for each edge endpoint, in the same order as edges.
    /// Members sharing a mesh node retain their own values at that joint.
    pub edge_element_node: Vec<u32>,
    /// u32::MAX means no face Set, including line members.
    pub edge_face: Vec<u32>,
    pub edge_body: Vec<u32>,
}

/// Final scientific values are f64 SI in component-fastest entity order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResultField {
    pub result_id: String,
    pub step: String,
    pub field: String,
    pub components: usize,
    pub per: String,
    pub entity_count: usize,
    pub node_count: usize,
    pub unit: String,
    pub values: Vec<f64>,
}

/// One explicit retained field used by `query.difference`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DifferenceOperand {
    pub result_id: String,
    pub field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<u8>,
    /// Omit for the final field. A sample selects only the retained primary field through
    /// query.frame's exact/nearest resolver, with earlier ties and no extrapolation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample: Option<FrameSample>,
}

/// The retained Result whose Mesh receives the difference values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum DifferenceOnto {
    Left,
    Right,
}

/// The resolved identity and layout of one difference operand.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDifferenceOperand {
    pub result_id: String,
    pub step: String,
    pub field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<u8>,
    pub source_components: usize,
    /// The actual retained frame used by this operand; absent for a final field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample: Option<ResolvedFrame>,
}

/// Nodewise coverage of the selected comparison Mesh by the other Mesh.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DifferenceCoverage {
    pub inside_nodes: usize,
    pub total_nodes: usize,
    pub outside_nodes: Vec<u32>,
}

/// `query.difference` response. Values are retained f64 SI, component-fastest by target node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DifferenceField {
    pub left: ResolvedDifferenceOperand,
    pub right: ResolvedDifferenceOperand,
    pub comparison_result_id: String,
    pub components: usize,
    pub node_count: usize,
    pub unit: String,
    pub values: Vec<Option<f64>>,
    pub interpolated: bool,
    pub coverage: DifferenceCoverage,
    pub warnings: Vec<Warning>,
}
