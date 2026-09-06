//! The Query enum: every read of the Model, Mesh or Results. Queries never mutate the Model.
//! Scalar values use Model display units; bulk frame arrays explicitly carry their SI unit.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::command::{Command, Field, ObjectKind};
use crate::error::Warning;
use crate::units::{Length, Quantity, Time, Q};

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
    /// Everything about the Model in one read: bodies with volumes and materials, materials,
    /// named Sets, constraints, loads with their totals, steps, mesh settings, and the
    /// well-posedness warnings that would block a solve. Read this before changing anything.
    #[serde(rename = "query.model")]
    #[schemars(extend("x-returns" = "ModelSummary"))]
    Model {},

    /// Counts and sanity of the current Mesh (nodes, elements, element kind, DOF, bounding box,
    /// edge lengths, Sets with their resolved sizes, quality). Builds the Mesh if needed.
    #[serde(rename = "query.mesh")]
    #[schemars(extend("x-returns" = "MeshSummary"))]
    Mesh {},

    /// What a Set resolved to on the current Mesh: kind, count, bounding box, area or volume
    /// and centroid. Use it to verify a predicate selected what you meant.
    #[serde(rename = "query.set", rename_all = "camelCase")]
    #[schemars(extend("x-returns" = "SetInfo"))]
    Set { name: String },

    /// Summary of a Step's Result: solver info, extremes of every field with their location,
    /// reactions per constraint and the applied totals, and whether the Result is stale
    /// (the Model changed after it was solved). Check the reaction balance first.
    #[serde(rename = "query.result", rename_all = "camelCase")]
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
    #[schemars(extend("x-returns" = "RetainedResults"))]
    Results {},

    /// A final field in SI with explicit entity layout, selected by solve instance or the current per-Step default.
    /// Field names include mode:k for one-based modal shapes. Explicit ids use solved metadata;
    /// omitted ids refuse stale Results. Transient samples use query.frame's existing protocol.
    #[serde(rename = "query.field", rename_all = "camelCase")]
    #[schemars(extend("x-returns" = "ResultField"))]
    Field {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result_id: Option<String>,
        field: String,
    },

    /// Catalogue of retained transient primary-field frames (default: last solved Step).
    /// Index 0 is the initial state; indices count retained frames, not integration steps.
    /// Metadata remains available for stale Results. No nodal values are copied by this Query.
    #[serde(rename = "query.frames", rename_all = "camelCase")]
    #[schemars(extend("x-returns" = "FramesResult"))]
    Frames {
        /// Omit for the current per-Step selection; an explicit id uses its solved context.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<String>,
    },

    /// One retained transient primary field. Supply exactly one of zero-based retained index
    /// or sample (retained index / physical time with exact or nearest selection). Time
    /// selection uses the same roundoff tolerance, earlier-tie rule and no-extrapolation
    /// policy as sampled probe/path. Values are SI,
    /// component-fastest, with three components per node, matching final FieldData: a 2D
    /// displacement has zero z; temperature occupies x with zero y/z. Defaults to the retained
    /// primary field. Derived fields were not retained and are refused. Omitted resultId refuses result.stale.
    #[serde(rename = "query.frame", rename_all = "camelCase")]
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

    /// A field value interpolated at a point (default: the last solved Step). Component
    /// indices: displacement 0..3, stress Voigt 0..6 (xx, yy, zz, xy, xz, yz), principal 0..3.
    /// Optional sample selects a retained primary-field frame; omitted means the final field.
    /// Omitted resultId refuses `result.stale` after edits; an explicit id uses its solved Mesh.
    #[serde(rename = "query.probe", rename_all = "camelCase")]
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
    #[schemars(extend("x-returns" = "CostEstimate"))]
    Cost { step: String },

    /// The Journal: every applied Command with the Model hash after it, and whether undo or
    /// redo is possible. `fromSeq` returns only entries at or after that sequence number.
    #[serde(rename = "query.journal", rename_all = "camelCase")]
    #[schemars(extend("x-returns" = "JournalDump"))]
    Journal {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from_seq: Option<u32>,
    },

    /// The Journal as a TypeScript script against the `fem` API that reproduces the Model line by
    /// line; what the Script panel shows and what script.run accepts back.
    #[serde(rename = "query.script")]
    #[schemars(extend("x-returns" = "ScriptText"))]
    Script {},

    /// Convert a quantity to another unit of the same dimension ("2 MPa" to "psi"); an error
    /// names the dimensions when they differ. Handy for checking inputs before using them.
    #[serde(rename = "query.convert", rename_all = "camelCase")]
    #[schemars(extend("x-returns" = "Converted"))]
    Convert { quantity: Quantity, to: String },

    /// Every nameable thing in the Model as `@`-mention references (`body:beam`, `set:beam.top`,
    /// `material:steel`, `journal:12`), with a one-line summary each; the mention picker's index.
    #[serde(rename = "query.objects", rename_all = "camelCase")]
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MaterialRow {
    pub name: String,
    #[serde(rename = "E")]
    pub e: Valued,
    pub nu: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rho: Option<Valued>,
    /// Current yield strength in the Model's display stress unit, when specified.
    #[serde(rename = "yield", default, skip_serializing_if = "Option::is_none")]
    pub yield_: Option<Valued>,
    pub assigned_to: Vec<String>,
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
    pub name: String,
    pub kind: String,
    pub count: u32,
    pub bbox: [Valued; 6],
    pub measure: Valued,
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

/// `query.result` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResultSummary {
    /// Opaque identity scoped to the Engine instance that produced this solve.
    pub result_id: String,
    pub step: String,
    pub revision: u32,
    pub stale: bool,
    pub solver: String,
    pub iterations: u32,
    pub residual: f64,
    pub time_ms: f64,
    pub extremes: Vec<Extreme>,
    pub reactions: Vec<ReactionRow>,
    pub applied_total: [Valued; 3],
    /// Natural frequencies in ascending order; empty unless the Step was modal. Mode `k`'s
    /// shape is the Result field named `mode:k`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub frequencies: Vec<Valued>,
    /// One row per output time of a transient Step: when, and the range the field covered.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<HistoryRow>,
    /// |Σ reactions + Σ applied| over the largest single force in either, so a Step driven
    /// by a prescribed displacement — where both totals are zero — still reports a meaningful
    /// number. Zero is perfect balance; anything above 1e-9 means the solve did not converge.
    pub balance: f64,
}

/// One time of a transient Step's history: the extremes of the field at that instant.
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
    /// Logical f64 bytes for retained times and unpadded primary values.
    pub retained_bytes: u64,
    /// Conservative full-field allowance for procedure working f64 vectors live with History.
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
    Mesh(MeshSummary),
    Set(SetInfo),
    Result(ResultSummary),
    Results(RetainedResults),
    Field(ResultField),
    Frames(FramesResult),
    Frame(FrameResult),
    Probe(ProbeResult),
    Path(PathResult),
    Cost(CostEstimate),
    Journal(JournalDump),
    Script(ScriptText),
    Converted(Converted),
    Objects(ObjectList),
    Capabilities(Capabilities),
    Report(ReportText),
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
    Solve {
        summary: Box<ResultSummary>,
    },
    Study {
        report: StudyReport,
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_schema_document() {
        assert_eq!(Query::Model {}.name(), "query.model");
        assert_eq!(Query::Convert { quantity: Quantity::text("1 m"), to: "mm".into() }.name(), "query.convert");
        let doc = schema_document();
        assert_eq!(doc["schemaVersion"], crate::SCHEMA_VERSION);
        let variants = doc["commands"]["oneOf"].as_array().unwrap();
        let n = variants.len();
        assert!(n >= 30, "{n}");
        for v in variants {
            let desc = v["description"].as_str().unwrap_or("");
            let name = v["properties"]["cmd"]["const"].as_str().unwrap();
            let dl = desc.len();
            assert!(dl >= 80, "{name}: description too short ({dl}): {desc}");
        }
        let qs = doc["queries"]["oneOf"].as_array().unwrap();
        let defs = doc["queryResult"]["$defs"].as_object().unwrap();
        for q in qs {
            let name = q["properties"]["query"]["const"].as_str().unwrap();
            assert!(q["description"].as_str().unwrap_or("").len() >= 80, "{name}");
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
    /// f64 arrays in final fields, modes, frequencies and transient History.
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
