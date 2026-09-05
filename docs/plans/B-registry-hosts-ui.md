# Plan B: registry, Journal, units, and every host

Implementation plan, 2026-09-05. Companion to plan A (numerics: lattice Mesher, elements, assembly,
CPU solvers, Benchmarks). This plan owns everything between the numerics and a person or an AI:
the Rust Command/Query registry, `Quantity`, structured errors, the Journal, the schema codegen,
the wasm host, the CLI host, the browser app with its UI, CI and the GitHub Pages deploy. It is
written to be coded from in one long session. Rules in `AGENTS.md` apply unchanged; vocabulary is
`CONTEXT.md`; the phase gates are `docs/PLAN.md` §2 (phase 0) and §3 (phase 1). Where this plan
departs from `PLAN.md` it says so in §13.

Every shell command in this document uses absolute paths and never `cd`; `$REPO` is
`/Users/anderhaf/projects/personal/fem-lab`.

Facts verified during planning (spikes under the session scratchpad, 2026-09-05):

- schemars 1.2.2 on a `#[serde(tag = "cmd")]` enum emits `oneOf` variants with a `const`
  discriminator, keeps variant and field doc comments as `description`, leaves `#[serde(default)]`
  fields out of `required`, and honours `#[schemars(extend("x-status" = "stub"))]`. A generic
  `Q<D: Dim>` with a hand-written `JsonSchema` impl emits one `$defs` entry per dimension that
  `$ref`s `Quantity` and carries the dimension in `description` and `x-dimension`.
- json-schema-to-typescript 16.0.0 turns that schema into a discriminated union with JSDoc, tuple
  types for `[Q; 3]`, and `string | { unit; value }` for `Quantity`.
- wasm-bindgen 0.2.128 compiles `pub async fn dispatch(&mut self, ..) -> Result<String, JsValue>`
  on a `#[wasm_bindgen]` struct for `wasm32-unknown-unknown`. Concurrent calls would panic
  ("recursive use of an object"), so the worker serialises them.
- wasm-bindgen-rayon 1.3.0 still needs a pinned nightly and `-Z build-std` (atomics); the repo's
  stable 1.94 cannot build the threaded wasm. See §13 and R2.
- wgpu 30.0.1 default features include `webgpu`; `Instance::request_adapter` is async and returns
  `Result`. There is no API to wrap an existing `web_sys::GPUDevice`, so the engine requests its
  own device inside Rust and the viewer uses its own (WebGL2) context.
- Anthropic tool names must match `^[a-zA-Z0-9_-]{1,64}$`: Command names with dots are mapped
  `geometry.addBox` → `geometry_addBox` in `toToolDefinitions()` and back on dispatch.
- Atomify's Pages recipe: `public/coi-serviceworker.min.js`, an inline `window.coi = {
  coepCredentialless: () => true, shouldRegister: () => !resetting }` before the script tag, and
  Vite dev headers `COOP: same-origin`, `COEP: credentialless`.
- npm on 2026-09-05: three 0.185.1 (23 MB unpacked) vs @babylonjs/core 9.25.0 (70 MB), zod 4.5.4,
  vite 8.2.2, vitest 5.0.0 (peer vite ^6.4 || ^7 || ^8), @playwright/test 1.63.0,
  json-schema-to-typescript 16.0.0, immer 11.1.18, sucrase 3.35.1, typescript 5.9.3 (7.0.2 is
  the native port; we pin 5.9), @anthropic-ai/sdk 0.124.0, @modelcontextprotocol/sdk 1.30.0,
  preact 10.29.8, size-limit 13.0.3, coi-serviceworker 0.1.7.

---

## 0. Scope and the seam with plan A

This plan implements, in order: units → errors → Command/Query enums and schema export → Model,
transactional dispatch, Journal, undo/redo, hashing → codegen → TS registry → CLI → wasm → app
shell → panels → CI → deploy. It stops at the calls into plan A. Those calls are the seam; the
signatures below are what plan B codes against, and plan A adopts these names (or plan B renames
in one commit when plan A lands first):

```rust
// crates/engine/src/mesh/mod.rs (plan A)
pub fn build_mesh(geom: &Geometry, settings: &MeshSettings) -> Result<Mesh, Error>;
pub struct Mesh { pub nodes: Vec<[f64; 3]>, pub elements: Vec<Element>, pub sets: BTreeMap<String, Set>,
                  pub element_type: ElementType, pub surface: Surface /* boundary quads, body id, auto face id */ }
// crates/engine/src/fem/mod.rs (plan A)
pub fn check_well_posed(model: &Model, mesh: &Mesh, step: &Step) -> Vec<Warning>;      // J6.11
pub async fn solve_static(ctx: &mut SolveCtx<'_>, model: &Model, mesh: &Mesh, step: &Step,
                          opts: &SolveOptions) -> Result<StepResult, Error>;              // yields via ctx.host
pub struct StepResult { pub fields: BTreeMap<Field, Vec<f64>>, pub reactions: Vec<Reaction>,
                        pub solver: SolverInfo, pub extremes: BTreeMap<Field, Extreme> }
pub fn cost_estimate(mesh: &Mesh, opts: &SolveOptions) -> CostEstimate;                 // J4.7
```

Until plan A lands there is no stub mesher or fake solver (that would be scaffolding for its own
sake). Plan B lands with `mesh.set`, `solve.run`, `study.converge`, `query.mesh`, `query.result`,
`query.probe`, `query.path`, `query.cost` present in the enum and returning
`Error::unsupported("numerics land in plan A")` from `dispatch`, each with a test asserting exactly
that error, so coverage stays at 100 % and the schema, the TS types, the tool list and the UI are
complete from day one. When plan A lands, the `unsupported` arms are replaced by the calls above and
those tests by Benchmarks.

---

## 1. File layout

```
Cargo.toml                          workspace: crates/engine, crates/engine-wasm, crates/femlab; resolver 2
rust-toolchain.toml                 channel = "1.94", targets = ["wasm32-unknown-unknown"]
package.json                        npm workspaces: packages/*; root scripts: codegen, build, test, ci
.github/workflows/ci.yml            jobs: rust, gpu, wasm-hash, web, smoke       (§8)
.github/workflows/deploy.yml        Pages deploy of packages/app/dist on push to main
crates/engine/                      headless library, 100 % coverage
  Cargo.toml                        deps: serde, serde_json, schemars, sha2, hex, libm, thiserror, wgpu (default-features=false, features by target), rayon (native only); dev: proptest
  clippy.toml                       disallowed-types/methods: std::fs::*, std::net::*, std::time::Instant, std::thread::spawn, f64::{sin,cos,tan,exp,ln,powf,...} (use libm)
  src/lib.rs                        pub use; #![forbid(unsafe_code)]; #![deny(clippy::disallowed_methods, clippy::disallowed_types)]
  src/engine.rs                     Engine, Host trait, Gpu, dispatch, query, snapshots         (§2.1)
  src/command.rs                    enum Command + param types                                 (§2.2, §2.4)
  src/query.rs                      enum Query + response structs                              (§2.3)
  src/units.rs                      Quantity, Q<D>, Dim markers, Unit table, UnitSet           (§2.5)
  src/error.rs                      Error, ErrorCode, Warning                                  (§2.6)
  src/model.rs                      Model, Geometry, Body, Material, Constraint, Load, Step, MeshSettings
  src/journal.rs                    Journal, JournalEntry, ModelFile, as_script                (§2.8)
  src/hash.rs                       canonical JSON + sha256                                    (§2.9)
  src/mesh/, src/fem/, src/gpu/, shaders/, benches/    plan A
crates/engine-wasm/                 wasm-bindgen surface                                        (§5)
  Cargo.toml                        cdylib; deps: femlab-engine, wasm-bindgen, wasm-bindgen-futures, js-sys, web-sys, console_error_panic_hook
  src/lib.rs
crates/femlab/                      CLI host                                                    (§6)
  Cargo.toml                        deps: femlab-engine, clap (derive), serde_json, pollster, anyhow; dev: assert_cmd
  src/main.rs, src/run.rs, src/bench.rs, src/schema.rs
  tests/schema_is_current.rs        committed schema == schema_for!(Command|Query|Ack|Error)
  tests/replay_fixtures.rs          every benches/journals/*.json replays; per-step hashes match the committed .hashes
tools/
  build-wasm.mjs                    cargo build --target wasm32 + wasm-bindgen --target web/nodejs (version-matched CLI)
  codegen.mjs                       femlab schema → packages/registry/src/generated/{engine.schema.json, engine.ts, fem.d.ts}
  replay-wasm.mjs                   Node: replay a Journal in the wasm build, print per-step hashes
  static-serve.mjs                  header-less static server for the service-worker smoke test
packages/registry/                  TS registry glue, 100 % vitest thresholds                   (§4)
  package.json                      deps: zod; dev: vitest, @vitest/coverage-v8, json-schema-to-typescript, typescript
  src/generated/engine.schema.json  committed, regenerated by tools/codegen.mjs
  src/generated/engine.ts           committed TS types (Command, Query, Ack, Error, responses)
  src/generated/fem.d.ts            committed script-API typings for the script Worker and validate_script
  src/registry.ts                   Registry, CommandDef, QueryDef, Provider
  src/transport.ts                  EngineTransport interface + JSON message protocol types
  src/host-commands.ts              zod schemas for view.*, selection.*, panel.*, script.run, file.*, example.open, solve.cancel, ai.setKey
  src/tools.ts                      toToolDefinitions(), toolNameFor(), commandNameFor()
  src/script-api.ts                 makeFemProxy(dispatch, query): fem.geometry.addBox(...)
  src/index.ts
packages/app/                       browser host                                                (§7)
  package.json                      deps: three, preact, immer, sucrase, @anthropic-ai/sdk, @femlab/registry; dev: vite, vitest, @playwright/test, size-limit
  index.html                        coi-serviceworker registration (Atomify recipe), capability notes, <div id=app>
  public/coi-serviceworker.min.js   vendored 0.1.7
  public/examples/*.json            copied from crates/engine/benches/journals at build (tools/codegen.mjs step)
  vite.config.ts                    base '/fem-lab/', server.headers COOP/COEP, worker.format 'es', build.target 'es2022'
  src/main.tsx                      boot: capabilities → worker → registry → window.fem → render <App/>
  src/engine.worker.ts              owns the wasm Engine; message loop                          (§5.3)
  src/worker-transport.ts           WorkerTransport implements EngineTransport
  src/script.worker.ts              sucrase + fem proxy over a MessagePort                      (§7.5)
  src/store.ts                      UiState, createStore (immer), selectors
  src/panels.ts                     PANELS and CONTROLS data tables (every control names its Command)  (§7.3)
  src/viewer/viewer.ts              three.js Viewer                                             (§7.2)
  src/viewer/colormap.ts            viridis LUT → Float32Array RGB
  src/ui/*.tsx                      Preact components, one per panel
  src/ai/agent.ts                   tool loop over registry.toToolDefinitions() + run_script      (§7.6)
  e2e/smoke.spec.ts                 Playwright                                                  (§8)
docs/plans/B-registry-hosts-ui.md   this file
```

Crate names: `femlab-engine`, `femlab-engine-wasm`, `femlab` (binary `femlab`). npm names:
`@femlab/registry`, `@femlab/app`.

---

## 2. The Rust registry (`crates/engine`)

### 2.1 Engine, Host, dispatch

```rust
// src/engine.rs
pub trait Host {
    fn now_ms(&self) -> f64;                                   // monotonic; for SolverInfo.time_ms and progress
    fn yield_now(&self) -> Pin<Box<dyn Future<Output = ()> + '_>>; // browser: setTimeout(0) via JsFuture; native: ready()
}
pub struct Gpu { pub device: wgpu::Device, pub queue: wgpu::Queue, pub limits: wgpu::Limits }

pub struct Engine {
    model: Model,                 // the serialisable description; small; Clone
    mesh: Option<Mesh>,           // derived; rebuilt lazily when model.mesh_settings or geometry changed
    results: BTreeMap<String, StepResult>,   // key: step name; each carries the model revision hash it came from
    journal: Journal,
    undo: Vec<(Model, Journal)>,  // snapshots; Blender's memfile rule: push on FINISHED, never on CANCELLED
    redo: Vec<Command>,
    gpu: Option<Gpu>,
    host: Box<dyn Host>,
    threads: usize,
}

pub struct Progress { pub phase: &'static str, pub fraction: f64, pub message: String }
pub type OnProgress<'a> = &'a mut dyn FnMut(Progress) -> bool;   // return false to cancel → Error::cancelled()

impl Engine {
    pub fn new(gpu: Option<Gpu>, host: Box<dyn Host>, threads: usize) -> Engine;
    pub async fn dispatch(&mut self, cmd: Command, on_progress: OnProgress<'_>) -> Result<Ack, Error>;
    pub fn query(&mut self, q: Query) -> Result<QueryResult, Error>;   // &mut: may build the lazy mesh
    pub fn model_hash(&self) -> String;
    pub fn export_file(&self) -> ModelFile;
    pub fn import_file(&mut self, f: ModelFile) -> Result<Ack, Error>; // replaces model+journal; clears undo/redo/results
    pub fn mesh_surface(&mut self) -> Result<&Surface, Error>;         // bulk arrays for the viewer
    pub fn field(&self, step: &str, field: Field, component: Option<u8>) -> Result<&[f64], Error>;
}
```

`dispatch` is transactional and is the only mutator:

```rust
pub async fn dispatch(&mut self, cmd: Command, on_progress: OnProgress<'_>) -> Result<Ack, Error> {
    match &cmd {
        Command::JournalUndo { steps } => return self.undo(steps.unwrap_or(1)),
        Command::JournalRedo { steps } => return self.redo(steps.unwrap_or(1)).await,
        _ => {}
    }
    let before = (self.model.clone(), self.journal.clone());
    let out = self.apply(&cmd, on_progress).await;           // the big match; mutates self.model / self.results
    match out {
        Ok(output) => {
            self.undo.push(before); self.redo.clear();
            let entry = self.journal.append(cmd, self.model_hash());
            Ok(Ack { seq: entry.seq, revision: self.journal.len(), hash: entry.hash_after.clone(),
                     warnings: self.warnings(), output })
        }
        Err(e) => { self.model = before.0; self.journal = before.1; Err(e) }   // nothing ran, nothing recorded
    }
}
```

- `model.new` is the exception that resets: `apply` replaces `model`, `journal`, `results`, `undo`, `redo`.
- `Command::SolveRun` and `Command::StudyConverge` are journaled like any other; results are stored
  by step name with the model hash at solve time. `query.result` reports `stale: true` when that hash
  differs from the current one. Undo past a solve orphans its Result (ADR 0003).
- Model changes invalidate `self.mesh` (`geometry.*`, `mesh.set`, `material.assign` because sets carry
  material ids). `query.mesh`, `solve.run`, `mesh_surface` rebuild on demand.
- `threads` is honoured natively via a rayon pool built in `Engine::new`; the wasm build without
  the `threads` feature compiles the same `par_iter` shim to sequential iteration with the same
  fixed-order reductions, so output is bit-identical by construction.

### 2.2 `enum Command`, complete for phases 1–3

Conventions: `#[serde(tag = "cmd")]`, every variant `#[serde(rename = "ns.verb")]`, camelCase
fields (`#[serde(rename_all = "camelCase")]` on each struct variant), every variant has a doc
comment of 2–4 sentences (it is the tool description: what, when, effect on names/Sets, common
mistake). Names are unique per kind (`body`, `material`, `set`, `constraint`, `load`, `step`) and
`NameTaken` is an error, so replaying is unambiguous. All physical values are `Q<D>`.

| Command | Fields (schema) | Doc string (abridged; write the full 2–4 sentences in code) | Journaled | Phase |
|---|---|---|---|---|
| `model.new` | `name: String`, `description?: String` | Start a new, empty Model and Journal. Discards the current Model, its Results and undo history; the first entry of every Journal. | yes (entry 0) | 0 |
| `model.setUnits` | `units: UnitSet` (`length?, force?, stress?, mass?, density?, time?, temperature?, acceleration?`, each a unit symbol) | Choose display units for Queries and the UI. Storage is SI regardless; inputs may use any unit. | yes | 0 |
| `geometry.addBox` | `name`, `size: [Q<Length>;3]`, `at?: [Q<Length>;3]` (min corner, default origin) | Add an axis-aligned box Body. Auto-names faces `<name>.xmin … <name>.zmax`. Overlapping boxes merge into one connected Body region when meshed. | yes | 1 |
| `geometry.subtractBox` | `name`, `size`, `at` | Cut an axis-aligned box out of the existing geometry (hole, notch, opening). Cut faces are auto-named `<name>.xmin …` and refer to the walls of the hole. | yes | 1 |
| `geometry.nameFace` | `name`, `of: String` (body), `where: FacePredicate` | Name a face Set by a geometric predicate so constraints and loads can target it; predicates survive remeshing. Prefer auto-names when they exist. | yes | 1 |
| `geometry.nameRegion` | `name`, `where: RegionPredicate` | Name a node/element Set by a region predicate (bbox or whole body), for point-like constraints, nodal forces and probes. | yes | 1 |
| `geometry.remove` | `name` | Remove a Body, cut or named Set. Fails with `InUse` listing the constraints/loads that reference it. | yes | 1 |
| `material.add` | `name`, `E: Q<Stress>`, `nu: f64` (0 ≤ ν < 0.5), `rho?: Q<Density>`, `alpha?: Q<ThermalExpansion>`, `k?: Q<Conductivity>`, `cp?: Q<SpecificHeat>`, `yield?: Q<Stress>`, `source?: String` | Define an isotropic linear-elastic Material. `rho` is required for gravity and modal, `alpha` for thermal loads; `source` records where the numbers came from. | yes | 1 |
| `material.assign` | `material`, `bodies: Vec<String>` | Assign a Material to Bodies. A Body without a Material makes the Model ill-posed. | yes | 1 |
| `material.remove` | `name` | Remove an unassigned Material. | yes | 1 |
| `mesh.set` | `mesher: Mesher` (`"lattice"`), `size: LatticeSize` (`Q<Length>` or `{nx,ny,nz}`), `order: 1\|2` (default 1), `element?: ElementType` | Choose the Mesher and its settings; the Mesh is rebuilt lazily. Linear hex8 locks in bending; use `hex8-im` or `order: 2` when bending matters (the J4.3 warning names this). | yes | 1 |
| `constraint.fix` | `name`, `on: SetRef`, `dofs?: Vec<Dof>` (default all) | Fix displacement components to zero on a Set. | yes | 1 |
| `constraint.prescribe` | `name`, `on`, `dof: Dof`, `value: Q<Length>` | Prescribe a non-zero displacement component on a Set. | yes | 1 |
| `constraint.symmetry` | `name`, `on`, `normal: Axis` | Symmetry plane: fixes the normal component on the Set. Model a half or quarter and say so. | yes | 1 (3.7) |
| `constraint.remove` | `name` | | yes | 1 |
| `load.pressure` | `name`, `on`, `value: Q<Stress>` | Uniform pressure on a face Set, positive into the surface. | yes | 1 |
| `load.traction` | `name`, `on`, `total: [Q<Force>;3]` | A total force spread uniformly over a face Set's area (J5.4). Use this for "10 kN on this face". | yes | 1 |
| `load.force` | `name`, `on` (node Set), `total: [Q<Force>;3]` | A total force split equally over the nodes of a Set. Point loads on solids give singular stresses; prefer `load.traction`. | yes | 1 |
| `load.gravity` | `name`, `g: [Q<Acceleration>;3]` | Body force from gravity on every Body with a density. | yes | 1 |
| `load.temperature` | `name`, `bodies: Vec<String>`, `value: Q<Temperature>`, `reference?: Q<Temperature>` | Uniform temperature change producing thermal strain αΔT in a static Step (Benchmark A6). | yes | 1 |
| `load.remove` | `name` | | yes | 1 |
| `step.add` | `name`, `procedure: Procedure` (`static`), `constraints: Vec<String>`, `loads: Vec<String>`, `output?: Vec<Field>` (default displacement, stress, vonMises, reaction) | Define an analysis Step: which constraints and loads are active and what to write out. | yes | 1 |
| `step.remove` | `name` | | yes | 1 |
| `solve.run` | `step`, `solver?: Solver` (`auto\|cpu-direct\|cpu-pcg\|gpu-pcg`), `tolerance?: f64`, `maxIterations?: u32` | Run a Step. Checks well-posedness first and refuses with a fix. Returns extremes and reactions; check that reactions balance the applied load. | yes | 1 |
| `study.converge` | `step`, `sizes: Vec<Q<Length>>`, `quantity: QuantityOfInterest`, `restore?: bool` (default true) | Re-mesh and re-solve at each size, report the quantity, the observed convergence rate and a Richardson estimate. Restores the previous mesh settings unless told otherwise. | yes | 3 (3.6) |
| `journal.undo` | `steps?: u32` | Undo the last Command(s). Not recorded in the Journal. | no | 0 |
| `journal.redo` | `steps?: u32` | | no | 0 |
| `plugin.load` | `name`, `kind: PluginKind`, `language: PluginLanguage`, `source: PluginSource` (`{inline: code}` or `{url, sha256}`), `manifest: serde_json::Value` | Load a Plugin filling one Extension Point; recorded by content hash. **Stub**: returns `Unsupported` until phase P. `x-status: stub`. | yes (when real) | P |

Phase-3 geometry (`geometry.addCylinder`, `addSphere`, `extrude`, `revolve`, `union`, `subtract`,
`intersect`, `transform`) and `mesh.set { mesher: "tet" }` are added to the enum in phase 3 with
the Mesher work; they are not stubbed now (a stub that always errors is noise in the AI's tool
list; `plugin.load` is stubbed only because the task and PLAN name it).

Host-side Commands (TypeScript, §4.3) complete the registry: `view.fit`, `view.setCamera`,
`view.showField`, `view.setDeformScale`, `view.setClip`, `view.toggle`, `selection.set`,
`selection.clear`, `panel.toggle`, `script.run`, `script.stop`, `file.open`, `file.save`,
`file.exportVTU`, `example.open`, `solve.cancel`, `ai.setKey`.

### 2.3 `enum Query`, complete for phases 1–3

`#[serde(tag = "query")]`, variants renamed `query.*`. Queries never mutate the Model; `query.mesh`
may build the lazy Mesh. Every response is a `#[derive(Serialize, JsonSchema)]` struct in
`query.rs`; `enum QueryResult` is `#[serde(untagged)]` over them so the TS side gets one type per
Query. Values are returned in the Model's display units with their unit symbols (`{ value, unit }`),
so the UI never converts (ADR 0008 literally: units at the boundary).

| Query | Fields | Returns | Purpose |
|---|---|---|---|
| `query.model` | – | `ModelSummary { name, revision, hash, units, bodies: [{name, material?, bbox, volume, mass?}], materials: [MaterialRow], sets: [{name, kind, resolved?: count}], constraints: [ConstraintRow], loads: [LoadRow{…, total: [F;3]}], steps: [StepRow], meshSettings?, warnings: [Warning] }` | The AI's and the model tree's single read of everything; `warnings` are the J6.11 well-posedness checks and unset defaults ("assumption log", PLAN 4.9) |
| `query.mesh` | – | `MeshSummary { nodes, elements, elementType, dofs, bbox, minEdge, maxEdge, sets: [{name, kind, count}], quality?: QualitySummary }` | counts and sanity before solving; `quality` filled in phase 3.5 |
| `query.set` | `name` | `SetInfo { name, kind: node\|element\|face, count, bbox, measure: {area\|volume}, centroid }` | verify a predicate resolved to what was meant |
| `query.result` | `step?` (default last solved) | `ResultSummary { step, revision, stale, solver: {name, iterations?, residual?, timeMs}, fields, extremes: {field: {min: {value, at, node}, max}}, reactions: [{constraint, total: [F;3]}], appliedTotal: [F;3], balance: f64 }` | observe without pixels (ADR 0006); reaction balance is the first thing to check |
| `query.probe` | `step?`, `field: Field`, `component?: u8`, `at: [Q<Length>;3]` | `ProbeResult { value, unit, element, nearestNode, interpolated: bool }` | value at a point |
| `query.path` | `step?`, `field`, `component?`, `from: [Q;3]`, `to: [Q;3]`, `n: u32` | `PathResult { s: [..], values: [..], unit }` | line plots |
| `query.cost` | `step` | `CostEstimate { dofs, nnz?, bytes, estimatedMs?, feasible, note }` | J4.7; computed by plan A's `cost_estimate` |
| `query.journal` | `fromSeq?: u32` | `JournalDump { entries: [{seq, cmd: Command, hashAfter}], revision, canUndo, canRedo }` | the Journal panel; the AI's "show me what you did" diff |
| `query.script` | `language?: "ts"` | `ScriptText { text }` | live TypeScript export of the Journal (§2.8) |
| `query.convert` | `quantity: Quantity`, `to: String` | `Converted { value, unit }` or `UnitDimension` error | unit help for UI live-validation and the AI |
| `query.capabilities` | – | `Capabilities { gpu: bool, adapter?: String, threads, engineVersion, schemaVersion }` | feature notes in the status bar; the host merges browser facts (§7.7) |

Bulk data (mesh surface, fields) is not JSON. It crosses as typed arrays through the wasm surface
(§5.1) and the CLI never needs it (`file.exportVTU` writes it as text).

### 2.4 Shared parameter types

```rust
pub type SetRef = String;                       // a named Set: auto face name, geometry.nameFace / nameRegion name
#[derive(Serialize, Deserialize, JsonSchema, Clone)] #[serde(rename_all = "lowercase")]
pub enum Dof { Ux, Uy, Uz }
#[derive(..)] #[serde(rename_all = "lowercase")] pub enum Axis { X, Y, Z }
#[derive(..)] #[serde(tag = "kind", rename_all = "camelCase")]
pub enum FacePredicate {
    /// Boundary faces lying in the plane n·x = offset (tolerance: 1e-6 of the bbox diagonal).
    Plane { normal: [f64; 3], offset: Q<Length> },
    /// Boundary faces whose centroids lie inside the box.
    Bbox { min: [Q<Length>; 3], max: [Q<Length>; 3] },
    /// Boundary faces with this outward normal (axis-aligned in v1).
    Normal { normal: [f64; 3] },
}
#[derive(..)] #[serde(tag = "kind", rename_all = "camelCase")]
pub enum RegionPredicate { Bbox { min: [Q<Length>; 3], max: [Q<Length>; 3] }, Body { name: String } }
#[derive(..)] #[serde(rename_all = "lowercase")] pub enum Mesher { Lattice }
#[derive(..)] #[serde(untagged)] pub enum LatticeSize { Size(Q<Length>), Counts { nx: u32, ny: u32, nz: u32 } }
#[derive(..)] #[serde(rename_all = "kebab-case")] pub enum ElementType { Hex8, Hex8Im, Hex20 }
#[derive(..)] #[serde(rename_all = "lowercase")] pub enum Procedure { Static }
#[derive(..)] #[serde(rename_all = "kebab-case")] pub enum Solver { Auto, CpuDirect, CpuPcg, GpuPcg }
#[derive(..)] #[serde(rename_all = "camelCase")]
pub enum Field { Displacement, Stress, VonMises, Principal, Strain, Reaction, Temperature }
#[derive(..)] #[serde(tag = "kind", rename_all = "camelCase")]
pub enum QuantityOfInterest { Max { field: Field, component: Option<u8> }, Min { .. },
                              Probe { field: Field, component: Option<u8>, at: [Q<Length>; 3] } }
pub enum PluginKind { MaterialLaw, Element, Load, PostQuantity, Mesher, Procedure }
pub enum PluginLanguage { Ts, Wgsl, Wasm }
#[serde(untagged)] pub enum PluginSource { Inline { inline: String }, Url { url: String, sha256: String } }
```

### 2.5 Units: `Quantity`, `Q<D>`, `UnitSet`

```rust
// src/units.rs
/// "2 MPa", "250 mm", "9.81 m/s^2", "7850 kg/m^3", "1.2e-5 1/K", or { "value": 2, "unit": "MPa" }.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)] #[serde(untagged)]
pub enum Quantity { Text(String), Parts { value: f64, unit: String } }

/// Exponents of (length, mass, time, temperature). Force = [1,1,-2,0], stress = [-1,1,-2,0].
#[derive(Copy, Clone, PartialEq, Eq, Debug)] pub struct Dimension(pub [i8; 4]);

pub trait Dim { const DIM: Dimension; const NAME: &'static str; const EXAMPLE: &'static str; }
pub struct Length; pub struct Force; pub struct Stress; pub struct Density; pub struct Acceleration;
pub struct Temperature; pub struct ThermalExpansion; pub struct Conductivity; pub struct SpecificHeat;
pub struct Mass; pub struct Time; pub struct Dimensionless;   // impl Dim for each; ~10 lines each

/// Serialises exactly like Quantity; the schema carries the dimension (verified in the spike).
#[derive(Serialize, Deserialize, Clone, Debug)] #[serde(transparent)]
pub struct Q<D: Dim> { q: Quantity, #[serde(skip)] _d: PhantomData<D> }
impl<D: Dim> Q<D> {
    pub fn si(&self) -> Result<f64, Error>;        // parse + dimension check + SI conversion (temperature: absolute → K with offset; deltas via ThermalExpansion path are offset-free)
    pub fn new(value_si: f64, unit: &str) -> Q<D>;  // for tests and Benchmarks
}
impl<D: Dim> JsonSchema for Q<D> { /* $ref Quantity + description "A {NAME} with unit, e.g. \"{EXAMPLE}\"" + x-dimension */ }

pub struct Unit { symbol: &'static str, dim: Dimension, factor: f64, offset: f64 }   // offset only for degC, degF
pub const UNITS: &[Unit];   // m, mm, cm, km, in, ft, um; kg, g, t, lb; s, ms, min, h; K, degC, degF;
                            // N, kN, MN, lbf; Pa, kPa, MPa, GPa, psi, ksi; Hz; J; W; rad, deg
pub fn parse(text: &str) -> Result<(f64, Dimension, f64 /*factor*/, f64 /*offset*/), Error>;
   // grammar: number, optional whitespace, unit expression: term (('/' | '*' | '·') term)*, term = [prefix]symbol ['^' int]
   // prefixes apply to base symbols only (m, g, N, Pa, s, K, Hz, J, W); "kg" is the SI base for mass
pub fn to_si(q: &Quantity, expect: Dimension) -> Result<f64, Error>;
pub fn format(value_si: f64, unit: &str, sig: usize) -> String;      // "2.5 MPa"; used by Queries via UnitSet
pub fn convert(value_si: f64, to: &str, expect: Option<Dimension>) -> Result<f64, Error>;

#[derive(Serialize, Deserialize, JsonSchema, Clone, Default)] #[serde(rename_all = "camelCase")]
pub struct UnitSet { pub length: Option<String>, pub force: .., pub stress: .., pub mass: .., pub density: ..,
                     pub time: .., pub temperature: .., pub acceleration: .. }
impl UnitSet { pub fn resolve(&self) -> ResolvedUnits /* defaults: m, N, Pa, kg, kg/m^3, s, K, m/s^2 */ }
```

Dimension mismatch is `Error { code: UnitDimension, cause: "expected a stress/pressure, got a length (\"250 mm\")", where: "value", suggestion: "e.g. \"2 MPa\"" }`.
Unknown symbol is `UnitUnknown` with the nearest known symbols listed. Both are raised inside
`apply`, before any state changes (transactional), so "schema error before anything runs" holds.

Property tests (proptest): `parse(format(v, u)) == v` to 1e-12 relative for every unit symbol
and random `v`; `to_si` of `"1 <u>"` equals the table factor; every `Dim` marker's `DIM` matches
the dimension of its `EXAMPLE`. Unit tests: the offset units, composite units, rejection cases.

Why hand-rolled and not `uom`: uom is compile-time typed and has no string parser for user input,
which is the whole job here; the table is ~40 lines and the parser ~80.

### 2.6 Errors and warnings

```rust
// src/error.rs
#[derive(Serialize, Deserialize, JsonSchema, Debug, Clone, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{code:?}: {cause}")]
pub struct Error {
    pub code: ErrorCode,
    /// One line a student understands.
    pub cause: String,
    /// Field path or named thing: "size[1]", "set 'beam.top'", "step 'static'".
    #[serde(rename = "where")] pub where_: Option<String>,
    /// The Command that would fix it, as text: "call geometry.nameFace with where: {kind:'plane', …}".
    pub suggestion: Option<String>,
}
#[derive(..)] #[serde(rename_all = "camelCase")]
pub enum ErrorCode { Schema, UnitDimension, UnitUnknown, NameTaken, NotFound, InUse, EmptySet, IllPosed,
                     NoMaterial, Singular, NotConverged, TooLarge, Unsupported, Cancelled, Internal }
#[derive(..)] pub struct Warning { pub code: String, pub text: String, pub where_: Option<String> }
impl Error {
    pub fn not_found(kind: &str, name: &str, known: &[&str]) -> Error;   // suggestion lists known names
    pub fn unsupported(what: &str) -> Error;
    pub fn cancelled() -> Error;
    pub fn schema(msg: impl Into<String>) -> Error;                        // wraps serde_json errors at the boundary
}
```

Every error the wasm and CLI surfaces emit is this struct serialised; JS receives it as a thrown
object with these fields (never a bare string). Deserialisation failures of a Command JSON are
mapped to `Schema` with `where_` = serde's path and `suggestion` naming the nearest Command
(`strsim::jaro_winkler` over the variant names, or a 10-line hand-rolled edit distance to avoid the dep).

### 2.7 `Ack` and `Output`

```rust
#[derive(Serialize, Deserialize, JsonSchema)] #[serde(rename_all = "camelCase")]
pub struct Ack { pub seq: u32, pub revision: u32, pub hash: String, pub warnings: Vec<Warning>, pub output: Output }
#[derive(..)] #[serde(tag = "kind", rename_all = "camelCase")]
pub enum Output { None, Solve { summary: ResultSummary }, Study { report: StudyReport }, Undo { steps: u32, revision: u32, hash: String } }
pub struct StudyReport { pub rows: Vec<StudyRow { size, dofs, value, unit, time_ms }>, pub observed_rate: Option<f64>, pub extrapolated: Option<f64> }
```

### 2.8 Journal, undo/redo, script export, file format

```rust
// src/journal.rs
#[derive(Serialize, Deserialize, JsonSchema, Clone, Default)]
pub struct Journal { pub entries: Vec<JournalEntry> }
#[derive(..)] #[serde(rename_all = "camelCase")]
pub struct JournalEntry { pub seq: u32, pub cmd: Command, pub hash_after: String }
impl Journal {
    pub fn append(&mut self, cmd: Command, hash_after: String) -> &JournalEntry;
    pub fn as_script(&self) -> String;    // see below
}
/// The saved file: snapshot + Journal, "femlab/1".
#[derive(..)] #[serde(rename_all = "camelCase")]
pub struct ModelFile { pub format: String /* "femlab/1" */, pub engine_version: String, pub model: Model,
                       pub journal: Journal, pub plugins: Vec<PluginRecord> }
```

- **Undo** pops `(Model, Journal)` from `self.undo`, pushes the undone Command on `redo`, drops
  Results whose revision is newer. **Redo** re-dispatches the popped Command through `apply`
  (so a redone solve re-solves) without clearing the redo stack. Snapshots not inverses: `Model`
  is a few KB (no mesh, no results) and Blender's memfile experience says snapshots are the
  robust choice. `journal.undo/redo` are never entries; `query.journal` reports `canUndo/canRedo`.
- **Replay**: `Engine::replay(file_or_entries, skip_solves: bool)` = `model.new` semantics then
  `dispatch` each entry in order; per-entry `hash_after` is recomputed and compared, and the first
  mismatch is reported with its `seq` (this is how the native-vs-wasm CI job localises a divergence).
- **Script export** (`Journal::as_script`, exposed as `query.script`): one line per entry,
  `await fem.geometry.addBox({ name: "beam", size: ["1 m", "100 mm", "100 mm"] });` with the `cmd`
  key removed and the remaining fields as JSON (serde_json compact, then keys unquoted where they
  are identifiers — a 20-line formatter; no prettier in Rust). Header comment names the engine
  version. `journal.undo/redo` never appear. This is the text the Journal panel shows live and what
  `script.run` accepts back.
- `import_file` validates `format`, rejects unknown Plugins by hash (phase P), replays nothing:
  it installs the snapshot and the Journal as-is (fast open, ADR 0003). `femlab run --verify`
  replays and compares instead.

### 2.9 Model hashing and determinism

```rust
// src/hash.rs
pub fn model_hash(model: &Model) -> String   // hex sha256 of serde_json::to_vec(model)
```

Determinism rules that make native and wasm agree byte-for-byte:

1. `Model` uses only `BTreeMap`/`Vec`; no `HashMap` anywhere in serialised state (clippy `disallowed-types`).
2. Floats serialise through serde_json (ryu shortest round-trip), identical on both targets.
3. No `std` transcendental functions in the engine: `f64::{sin, cos, tan, exp, ln, log10, powf, cbrt}`
   are clippy-disallowed; use the `libm` crate (pure Rust, same bits on every target). `sqrt`, `+ - * /`
   are IEEE-exact and allowed. Lattice geometry in phase 1 needs none of them; phase 3 CSG will.
4. Rayon reductions are fixed-order (`par_chunks` + sequential combine in index order), tested at
   `threads = 1` and `threads = 4` for equality (ADR 0013). The wasm build without threads runs
   the same code sequentially.
5. `hash_after` in every `JournalEntry`; `femlab run --hashes` prints them; `tools/replay-wasm.mjs`
   prints the same list from the wasm build; CI diffs the two files (§8 job `wasm-hash`).

### 2.10 Doc strings as tool descriptions

Each variant's doc comment is the tool description; write it to Anthropic's guidance (what,
when, parameters' meaning, caveat), 2–4 sentences, and a test in `crates/femlab/tests/schema_is_current.rs`
asserts every `oneOf` variant of `Command` and `Query` has a `description` of ≥ 80 characters and
every property that is a `Q<..>` `$ref`s a `Q_*` def (so a bare number can never sneak into a
physical field). Field-level docs where the name is not self-explanatory (`at`, `total`, `offset`).

---

## 3. Schema codegen: Rust → JSON Schema → TypeScript

**Tool**: `json-schema-to-typescript` 16 (verified on the spike output). Not ts-rs/typeshare:
they generate TS from Rust directly, giving two generators (schema and types) that can disagree;
one JSON Schema as the single artefact keeps Rust, TS, the AI tools, the UI form and Python (phase
Py) on one source. Not typebox: we do not validate engine Commands in TS (Rust does), so runtime
schema objects buy nothing. A hand-written generator would be ~150 lines and jstt is a dev-only
dependency; take the library.

**Pipeline** (`tools/codegen.mjs`, `npm run codegen` at the root; `--check` mode exits 1 on diff):

1. `cargo run -q -p femlab -- schema` prints `{ "commands": schema_for!(Command), "queries": schema_for!(Query),
   "ack": .., "error": .., "queryResult": .., "modelFile": .., "hostCommands": null }` as one JSON document.
2. Write it to `packages/registry/src/generated/engine.schema.json` (pretty, sorted keys).
3. `compile(schema, 'Engine', { additionalProperties: false, bannerComment: '/* generated by tools/codegen.mjs — do not edit */', strictIndexSignatures: true })`
   → `packages/registry/src/generated/engine.ts` exporting `Command`, `Query`, `Ack`, `Error`,
   `QueryResult`, `ModelFile`, and every response type.
4. Emit `packages/registry/src/generated/fem.d.ts`: for each `oneOf` variant, `namespace.verb(args: Omit<Variant, 'cmd'>): Promise<Ack>`
   for Commands and `(args): Promise<ResponseType>` for Queries, grouped by namespace into
   `interface Fem { geometry: { addBox(args): Promise<Ack>; … }; query: { model(): Promise<ModelSummary>; … } }`,
   plus the host Commands from `host-commands.ts` (zod → JSON Schema via `z.toJSONSchema` → same path).
   This file is what the script Worker types against, what `validate_script` (phase 4.8) type-checks
   against, and what the system prompt (phase 4.5) is generated from.
5. Copy `crates/engine/benches/journals/*.json` to `packages/app/public/examples/` with an `index.json`.

Both generated files are committed. Freshness is enforced twice: `crates/femlab/tests/schema_is_current.rs`
compares `include_str!("../../../packages/registry/src/generated/engine.schema.json")` to
`schema_for!` output (so `cargo test` fails the moment a Rust doc string changes without regenerating),
and CI runs `npm run codegen -- --check`. The engine crate itself never touches the file system
(the test lives in the CLI crate).

---

## 4. The TypeScript registry (`packages/registry`)

### 4.1 One `Registry`, two providers

```ts
// src/registry.ts
export type Provider = 'engine' | 'host';
export interface CommandDef {
  name: string;                       // "geometry.addBox"
  description: string;
  schema: JSONSchema7;                // engine: the oneOf variant; host: z.toJSONSchema(zodSchema)
  provider: Provider;
  journaled: boolean;                 // engine Commands except journal.*; host Commands never
  tool: boolean;                      // exposed to the AI (false for ai.setKey; false for x-status: stub)
  run?: (input: unknown) => Promise<unknown>;   // host Commands only; engine ones go through the transport
}
export interface QueryDef { name; description; schema; provider; run? }

export class Registry {
  constructor(transport: EngineTransport, hostCommands: HostCommandDef[], hostQueries: HostQueryDef[]);
  static fromSchema(schema: EngineSchema, ...): pure builder used by tests
  list(): { commands: CommandDef[]; queries: QueryDef[] };
  dispatch(cmd: Command | HostCommand): Promise<Ack | unknown>;      // routes by name; host input validated with zod; engine input passed through (Rust validates)
  query(q: Query | HostQuery): Promise<QueryResult | unknown>;
  on(event: 'dispatched' | 'failed' | 'progress', cb): () => void;    // Journal panel, status bar
  toToolDefinitions(): AnthropicTool[];                               // §4.4
}
```

`dispatch` is the single entry point for the UI, `window.fem`, the script Worker and the AI.
The engine provider is the transport; the host provider is a table of zod-validated reducers over
the UI store. `Registry` has no DOM imports (it is in `packages/registry`, tested in Node).

### 4.2 Transport

```ts
// src/transport.ts
export interface EngineTransport {
  dispatch(cmd: Command, onProgress?: (p: Progress) => void): Promise<Ack>;   // rejects with Error (structured)
  query(q: Query): Promise<QueryResult>;
  surface(): Promise<Surface>;             // { positions: Float32Array, indices: Uint32Array, triBody: Uint32Array, triFace: Uint32Array, faceNames: string[], bodyNames: string[] }
  field(step: string, field: Field, component?: number): Promise<{ values: Float32Array; min: number; max: number; unit: string }>;
  exportFile(): Promise<ModelFile>;
  importFile(f: ModelFile): Promise<Ack>;
  cancel(): Promise<void>;                 // browser: terminate + recreate + replay(skipSolves); native: cooperative flag
  capabilities(): Promise<Capabilities>;
}
// Wire protocol shared by WorkerTransport now and HttpTransport (femlab serve) later:
export type Req = { id: number; op: 'dispatch' | 'query' | 'surface' | 'field' | 'export' | 'import' | 'capabilities'; payload: unknown };
export type Res = { id: number; ok: true; value: unknown; transfer?: ArrayBuffer[] } | { id: number; ok: false; error: Error } | { id: number; progress: Progress };
```

The worker and a future HTTP/WebSocket transport speak the same `Req/Res`, so `femlab serve` is
a transport swap (AGENTS.md "hosts are swappable").

### 4.3 Host Commands (zod 4, `src/host-commands.ts`)

| Command | Schema | Effect / notes | Tool |
|---|---|---|---|
| `view.fit` | `{}` | frame the mesh | yes |
| `view.setCamera` | `{ position: [n,n,n], target: [n,n,n], up?: [n,n,n] }` | metres, viewer space | yes |
| `view.showField` | `{ field: Field, component?: int, step?: string }` \| `{ field: null }` | contour on/off | yes |
| `view.setDeformScale` | `{ scale: number \| 'auto' }` | deformed shape | yes |
| `view.setClip` | `{ normal: [n,n,n], offset: number } \| null` | clip plane (three `clippingPlanes`) | yes |
| `view.toggle` | `{ layer: 'mesh'\|'edges'\|'loads'\|'constraints'\|'legend'\|'axes', on?: boolean }` | | yes |
| `selection.set` | `{ bodies?: string[], faces?: string[] }` | names, never ids (ADR 0003) | yes |
| `selection.clear` | `{}` | | yes |
| `panel.toggle` | `{ panel: PanelId, open?: boolean }` | | yes |
| `script.run` | `{ code: string, timeoutMs?: number }` | run TS in the script Worker; returns `{ result, console, error? }` | yes (as `run_script`) |
| `script.stop` | `{}` | terminate the running script Worker | yes |
| `file.open` | `{ json: string } \| { picker: true }` | host I/O then `transport.importFile` | yes (json only) |
| `file.save` | `{ name?: string }` | `exportFile` → download | yes |
| `file.exportVTU` | `{ step?: string, name?: string }` | VTU text (~100 lines in TS from `surface`+`field`; phase 1 boundary only; full volume via engine in phase 5) | yes |
| `example.open` | `{ name: string }` | fetch `examples/<name>.json` → `importFile` | yes |
| `solve.cancel` | `{}` | `transport.cancel()` | yes |
| `ai.setKey` | `{ key: string \| null }` | localStorage; never journaled, never a tool, never in exports | no |

Host Queries: `query.screenshot { width?, height? }` → `{ png: base64 }`, `query.view` → camera
state, `query.capabilities` merges the engine's with `{ webgpu, crossOriginIsolated, threads, userAgent }`.

The UI store is `UiState` (view, selection, panels, solve progress, last summaries); host Commands
are reducers `(state, input) => void` wrapped in immer `produce`. UI Commands push no undo step
(Blender: "UI changes are not stored"); `journal.undo` is Model-only. immer patches are kept in a
64-entry ring so `query.script({ includeView: true })` can append `view.*` lines for reproducing a
screenshot; nothing else uses them (see §13 on dropped UI undo).

### 4.4 `toToolDefinitions()`

```ts
export function toolNameFor(cmd: string) { return cmd.replace(/\./g, '_'); }      // geometry.addBox → geometry_addBox
export function commandNameFor(tool: string, registry) { /* reverse lookup in the registry, not string replace */ }
toToolDefinitions(): AnthropicTool[] =
  [...commands, ...queries].filter(d => d.tool).map(d => ({
     name: toolNameFor(d.name), description: d.description,
     input_schema: stripDiscriminator(inlineDefs(d.schema)),     // remove the `cmd`/`query` const property; inline $defs so each tool is self-contained
  }))
  .concat([{ name: 'run_script', description: '…TypeScript against the fem API; see fem.d.ts…', input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } }]);
```

Property test (fast-check not needed; it is exhaustive): the tool names equal the registry's
`tool: true` names one-to-one, `commandNameFor(toolNameFor(n)) === n`, every `input_schema` has
no `$ref`, and every description is ≥ 80 chars. This is the "tool list == registry" gate.

### 4.5 Script API proxy (`src/script-api.ts`)

`makeFemProxy(dispatch, query)` returns a nested `Proxy`: `fem.geometry.addBox(args)` →
`dispatch({ cmd: 'geometry.addBox', ...args })`; `fem.query.model()` → `query({ query: 'query.model' })`;
`fem.help(name?)` prints descriptions from the schema. The same proxy is `window.fem` on the page
and the global inside the script Worker; the difference is only which `dispatch` it closes over.

---

## 5. The wasm host (`crates/engine-wasm`)

### 5.1 wasm-bindgen surface

```rust
#[wasm_bindgen]
pub struct Engine { inner: femlab_engine::Engine }

#[wasm_bindgen]
impl Engine {
    /// opts: { gpu: boolean, threads: number }. Requests a WebGPU device through wgpu's webgpu
    /// backend when gpu is true and navigator.gpu exists; falls back to CPU with a note in capabilities.
    #[wasm_bindgen(js_name = create)]
    pub async fn create(opts: JsValue) -> Result<Engine, JsValue>;
    /// cmd_json: a Command as JSON text. Resolves to Ack JSON; rejects with Error JSON (object, not string).
    pub async fn dispatch(&mut self, cmd_json: String, on_progress: Option<js_sys::Function>) -> Result<String, JsValue>;
    pub fn query(&mut self, query_json: String) -> Result<String, JsValue>;
    /// Zero-copy views over wasm memory. Valid only until the next call that can allocate.
    pub fn surface_positions(&mut self) -> Result<js_sys::Float32Array, JsValue>;
    pub fn surface_indices(&mut self) -> Result<js_sys::Uint32Array, JsValue>;
    pub fn surface_tri_body(&mut self) -> Result<js_sys::Uint32Array, JsValue>;
    pub fn surface_tri_face(&mut self) -> Result<js_sys::Uint32Array, JsValue>;
    pub fn surface_names(&mut self) -> Result<String, JsValue>;         // { faceNames, bodyNames } JSON
    pub fn field(&self, step: &str, field: &str, component: Option<u8>) -> Result<js_sys::Float32Array, JsValue>;  // f64 → f32 staging Vec kept in Engine; view over it
    pub fn export_file(&self) -> String;
    pub fn import_file(&mut self, json: String) -> Result<String, JsValue>;
    pub fn model_hash(&self) -> String;
    pub fn replay_hashes(&mut self, journal_json: String, skip_solves: bool) -> Result<String, JsValue>;  // for tools/replay-wasm.mjs
}
#[wasm_bindgen] pub fn schema() -> String;
#[wasm_bindgen(start)] fn start() { console_error_panic_hook::set_once(); }
```

Decisions:

- **JSON strings for control, typed arrays for bulk.** A Command is < 10 KB; `JSON.parse` of that
  is microseconds, and the same bytes go over `femlab serve` later. serde-wasm-bindgen would save a
  parse but make the browser path differ from every other host. Spike 0.7 in PLAN records the
  round-trip time (< 1 ms) to close the question.
- **Zero-copy views exist only inside the worker.** `js_sys::Float32Array::view` is `unsafe` and is
  invalidated by any wasm memory growth. The worker copies each view into a fresh `ArrayBuffer`
  immediately (`view.slice()`) and transfers it with `postMessage(…, [buffer])`: one copy, which the
  worker boundary forces anyway. Nothing on the main thread ever holds a view. `f64` fields are
  converted to `f32` once in Rust into a staging buffer the viewer wants anyway.
- **GPU inside Rust.** `wgpu::Instance::new(&InstanceDescriptor { backends: Backends::BROWSER_WEBGPU, .. })`,
  `request_adapter(&RequestAdapterOptions { power_preference: HighPerformance, .. }).await`,
  `request_device` with `required_limits: adapter.limits()` (ADR 0002). Failure → `gpu: None`, and
  `capabilities.gpu = false` with `adapter: None`; the UI shows the CPU note. The Host impl uses
  `js_sys::Date::now` and a `JsFuture` over `setTimeout(0)` for `yield_now`.
- **Async and `&mut self`.** Verified to compile; the worker keeps a promise chain so at most one
  `dispatch`/`query` is in flight (a concurrent call would panic inside wasm-bindgen's borrow check).
- **Cancel.** For CPU solves the wasm thread is busy and cannot observe a flag; `worker.terminate()`,
  recreate the worker, `import_file(lastExport)` (a snapshot taken by the transport before every
  `solve.run`), done. For GPU solves the progress callback's `false` return is honoured at the next
  await. Both paths are one `transport.cancel()`.
- **Build** (`tools/build-wasm.mjs`): `cargo build -p femlab-engine-wasm --target wasm32-unknown-unknown --release`,
  then `wasm-bindgen --target web --out-dir $REPO/packages/app/src/generated/wasm` and
  `--target nodejs --out-dir $REPO/tools/wasm-node` for the hash job. The script reads the
  `wasm-bindgen` version from `Cargo.lock` and runs `cargo install --locked wasm-bindgen-cli --version X`
  when the installed CLI differs (mismatch is a hard error at bind time). No wasm-pack: it adds a
  second tool for what two commands do. `wasm-opt` is skipped until size-limit says otherwise.

### 5.2 Threads (deferred lane)

The threaded build needs `-C target-feature=+atomics,+bulk-memory` and `-Z build-std`, i.e. a pinned
nightly, and a module built that way cannot instantiate without `SharedArrayBuffer`, so two artefacts
are needed for a fallback. Plan B ships the stable single-threaded artefact and the coi-serviceworker
from day one (so `crossOriginIsolated` is true on Pages and testable), and adds the threaded artefact
as commit 22 (§11) behind `continue-on-error` with `cargo +nightly-2026-08-01` (pin to the newest
nightly wasm-bindgen-rayon's README lists). The loader picks `engine_threads.wasm` when
`crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'`, else the plain one, and
`query.capabilities.threads` says which. See §13.

### 5.3 The engine Worker (`packages/app/src/engine.worker.ts`)

```ts
import init, { Engine } from './generated/wasm/femlab_engine_wasm.js';
let engine: Engine; const q = new PromiseQueue();               // serialises calls
self.onmessage = async (e: MessageEvent<Req>) => { const r = e.data; try {
  const value = await q.run(() => handle(r));                   // handle switches on r.op; progress posts {id, progress}
  self.postMessage(value.res, value.transfer ?? []);
} catch (err) { self.postMessage({ id: r.id, ok: false, error: toStructured(err) }); } };
```

`handle('surface')` calls the five `surface_*` accessors, `slice()`s each view, and returns the
buffers as transferables. Boot: `await init(wasmUrl)` where `wasmUrl` is `new URL('./generated/wasm/femlab_engine_wasm_bg.wasm', import.meta.url)`
(Vite hashes and serves it as `application/wasm`).

---

## 6. The CLI host (`crates/femlab`)

```
femlab run <file.json> [--hashes] [--skip-solves] [--verify] [--as-script] [--json] [--cpu] [--threads N]
    file.json is a ModelFile or a bare Journal array. Prints query.model (text or --json), or the per-entry
    hash list (--hashes), or the Journal as a TypeScript script (--as-script). --verify replays and compares
    hash_after per entry; exit 3 on the first mismatch with its seq.
femlab bench [--filter <substr>] [--json] [--markdown] [--cpu] [--threads N]
    Runs every case in crates/engine/benches/cases/*.json: { name, journal: [...], checks: [{ query, path, expect, tol, rel }] }.
    Exit 1 if any check fails. --markdown prints the status table BENCHMARKS.md links to.
femlab schema [--out <path>] [--check]
    Prints the combined schema document (§3 step 1); --check compares to --out and exits 1 on diff.
femlab serve [--port 7777]
    Stub: prints "femlab serve is planned (phase S); the wire protocol is packages/registry/src/transport.ts" and exits 2.
```

clap 4.6 derive; `pollster::block_on` around the async engine; native GPU via
`wgpu::Instance::new(Backends::PRIMARY)` + `request_adapter`, `--cpu` forces `None`; Host impl uses
`std::time::Instant` (allowed here: the CLI is a host) and `yield_now` = ready future. `tests/`
use `assert_cmd` on the fixture journals; `tests/replay_fixtures.rs` iterates `benches/journals/*.json`
and asserts `--verify` passes and `--hashes` equals the committed `*.hashes` file next to each journal.

Native-vs-wasm hash comparison (CI job `wasm-hash`): for each fixture,
`femlab run <j> --hashes --skip-solves > native/<j>.txt` and
`node $REPO/tools/replay-wasm.mjs <j> > wasm/<j>.txt` (Node loads `tools/wasm-node`, `gpu: false`),
then `diff -r native wasm`. Solves are skipped in this job because the wasm build in Node has no GPU
and because Results are not part of the Model hash anyway; a second, later comparison of CPU-solve
Results to 1e-12 is a Benchmark in plan A.

---

## 7. The browser app (`packages/app`)

### 7.1 Stack

- **Vite 8 + TypeScript 5.9 + Preact 10.** Preact because the app is panels and forms, which are
  miserable as imperative DOM and trivial as components; 4 KB, no build magic, works with vitest.
  TS 5.9 not 7.0: the native port is weeks old and the Vite/vitest/Preact typings chain is proven on 5.9.
- **three.js 0.185, WebGL2 renderer.** Decided over Babylon: three is a third the size and tree-shakes
  to ~150 KB gz for what we use (BufferGeometry, MeshLambertMaterial with `vertexColors`, LineSegments,
  Raycaster, OrbitControls, `clippingPlanes`), it needs no WebGPU so the viewer works on the CPU-only
  path and never competes with the engine for the one WebGPU device, and every feature phase 1–5
  needs (vertex-colour contours, picking, clip planes, deformed shape, screenshots) is built in
  without a custom shader. Babylon's GUI and WebGPU engine buy nothing the panels and the wasm
  engine do not already cover; three's WebGPURenderer is available later if a reason appears.
- **immer** for the store, **sucrase** in the script Worker, **@anthropic-ai/sdk** in the AI panel,
  **zod 4** (via `@femlab/registry`) for host Commands. No router, no CSS framework (one `style.css`).

### 7.2 Viewer (`src/viewer/viewer.ts`)

```ts
export class Viewer {
  constructor(canvas: HTMLCanvasElement);
  setSurface(s: Surface): void;                       // BufferGeometry: position (copy), index; per-vertex colour attr allocated
  setField(values: Float32Array | null, range: [number, number]): void;   // per-vertex → viridis RGB into the colour attr; null → flat grey
  setDeformed(disp: Float32Array | null, scale: number): void;            // position = X + s·u on the CPU; 'auto' = 0.1·bboxDiag / |u|max
  setClip(plane: { normal; offset } | null): void;    // renderer.localClippingEnabled = true; material.clippingPlanes = [new Plane(...)]
  setLayer(layer, on): void;                          // edges: LineSegments from unique surface edges; loads/constraints: ArrowHelper/marker sprites per Set (from query.model + surface face ids)
  fit(): void; setCamera(c): void; getCamera(): CameraState;
  pick(x: number, y: number): Pick | null;            // Raycaster → face index → { body, autoFace, point, normal }
  screenshot(w?, h?): Promise<Blob>;                  // preserveDrawingBuffer: false; render then toBlob inside the same frame
  onPick(cb): void;
}
```

Picking never yields node ids to anyone. A pick shows a "Name this face" chip: if the picked
triangle's `autoFace` set is exactly what was picked, the suggested Command is
`geometry.nameFace { name, of: body, where: { kind: 'normal', normal } }` restricted to that body
(equivalently the auto-name is offered directly as `on: "<body>.<side>"`); otherwise the chip offers
`{ kind: 'plane', normal, offset }` from the picked point. Accepting dispatches the Command; the pick
itself is `selection.set { faces: [autoFaceName] }`, also a Command. Legend is an HTML element with a
CSS gradient and min/max in display units from `query.result`.

### 7.3 Panels and controls as data

`src/panels.ts` declares `PANELS: { id, title, side, defaultOpen }[]` and
`CONTROLS: { id, label, cmd: string, args?: unknown, panel: PanelId, kind: 'button'|'toggle'|'form' }[]`.
Components render from these tables; every rendered control carries `data-cmd`. The vitest
`panels.test.ts` asserts: every `CONTROLS[i].cmd` is in `registry.list()`; every host Command is
reachable from at least one control or is listed in `SCRIPT_ONLY` with a reason (`ai.setKey` is
the only expected entry); every engine Command with `tool: true` has a form entry point (the
Properties panel's "Add…" menu is one control per engine Command, generated from the schema).
Playwright's smoke checks the DOM agrees (`[data-cmd]` set ⊆ registry).

| Panel | Contents | Commands it dispatches / Queries it reads |
|---|---|---|
| Header bar | New, Open, Save, Examples ▾, Undo, Redo, Solve ▾ (step picker), capability badges | `model.new`, `file.open`, `file.save`, `example.open`, `journal.undo/redo`, `solve.run`, `solve.cancel` |
| Model tree (left) | bodies → material; materials; sets (kind, count); constraints; loads (with totals); steps; results (stale flag); warnings from `query.model` | `selection.set`, `geometry.remove`, `material.remove`, `constraint.remove`, `load.remove`, `step.remove`; reads `query.model`, `query.mesh` |
| Properties (left, below) | schema-driven form for the selected item's Command or an "Add…" Command: string → input, number → number input with min/max from schema, enum → select, `Q_*` → text input with placeholder EXAMPLE and live `query.convert` validation, `[Q;3]` → three inputs, `Vec<enum>` → checkboxes, tagged enum (`FacePredicate`) → kind select + sub-form | dispatches the chosen Command with the form's JSON; shows `Error.where/suggestion` inline |
| Viewer (centre) | canvas, legend, pick chip, field picker, deform scale, clip toggle, layer toggles | `view.*`, `selection.*`, `geometry.nameFace` |
| Journal (right tab) | entries with seq and hash prefix; live TypeScript from `query.script`; copy; "run as script" | `journal.undo/redo`, `script.run`; reads `query.journal`, `query.script` |
| Script (right tab) | textarea + Run + Stop; output pane (console, return value, structured error) | `script.run`, `script.stop` (terminates the script Worker; a host Command so the Stop button passes the enumeration test) |
| Results (right tab) | solver info, extremes table with "go to" (sets camera), reactions vs applied with balance, probe form, path form, export VTU | `view.setCamera`, `view.showField`, `file.exportVTU`; reads `query.result`, `query.probe`, `query.path` |
| Examples / Benchmarks gallery (modal) | cards from `public/examples/index.json` with reference value, tolerance, theory snippet (KaTeX later) | `example.open` |
| AI (right tab, flag `?ai=1` until phase 4 eval passes) | key entry with the plain notice (ADR 0006), model id, chat, streamed tool calls shown as Journal entries, "what I did" = `query.journal` diff, cost estimate | everything, via `registry.dispatch`; `ai.setKey` |
| Status bar | progress from `dispatch` progress events, capability notes (no WebGPU → CPU; not isolated → single thread; not Chromium → best effort), engine version | reads `query.capabilities` |

### 7.4 Boot (`src/main.tsx`)

1. Read `navigator.gpu`, `crossOriginIsolated`, `typeof SharedArrayBuffer`, `navigator.userAgent` → `hostCaps`.
2. `const transport = new WorkerTransport(new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' }))`;
   `await transport.init({ gpu: !!navigator.gpu, threads: hostCaps.isolated ? navigator.hardwareConcurrency : 1 })`.
3. `const registry = new Registry(transport, hostCommands(store, viewer), hostQueries(viewer))`.
4. `window.fem = Object.assign(makeFemProxy(registry.dispatch, registry.query), { registry, help })` — the
   DevTools-MCP surface (PLAN 4.1); typed via `declare global { interface Window { fem: Fem } }`.
5. `render(<App registry store viewer/>, #app)`; if the URL has `?example=<name>` dispatch `example.open`.
6. Failure modes are messages, not crashes: no `WebAssembly` → "This browser cannot run FEM Lab";
   `init` rejects → show the error and a reload button; no WebGPU → status note; not isolated →
   status note naming Chromium (ADR 0014).

### 7.5 Script Worker (`src/script.worker.ts`)

`script.run { code }`: main thread creates a Worker, a `MessageChannel`, passes `port1` to the
script Worker and keeps `port2` wired to `registry.dispatch/query` (so scripts can also call host
Commands, e.g. `fem.view.fit()`), posts `{ code, timeoutMs }`. The Worker `sucrase.transform(code,
{ transforms: ['typescript'] })`, wraps it in `(async (fem, console) => { ${js} })` via
`new Function`, captures console into an array, awaits, posts `{ result, console }` or `{ error }`.
Main thread `terminate()`s on timeout (default 60 s) or `script.stop`. Every Command a script runs
lands in the Journal like any other, so "record what I clicked, edit, replay" is the same loop.

### 7.6 AI panel (`src/ai/agent.ts`)

`new Anthropic({ apiKey, dangerouslyAllowBrowser: true })`; `tools = registry.toToolDefinitions()`;
a 60-line loop: `messages.create({ stream: true, system, tools, messages })`, on `tool_use` →
`registry.dispatch/query` (or `script.run` for `run_script`), append `tool_result` (structured
`Error` JSON on failure so the model can fix its call), repeat until `end_turn`. `system` is the
generated API reference (`fem.d.ts` text) plus the units and verification habit lines (PLAN 4.5).
Key in `localStorage['femlab.anthropicKey']`, never in the store snapshot, Journal, export or
screenshot. Phase 4's eval suite decides when the `?ai=1` flag is removed.

### 7.7 Capability detection and coi-serviceworker (`index.html`)

```html
<script>
  // Atomify's recipe (ADR 0013). Reload once on first visit, guarded against loops.
  const resetting = sessionStorage.getItem('coi-reloaded') === '1' && !crossOriginIsolated;
  window.coi = { coepCredentialless: () => true, shouldRegister: () => !resetting && 'serviceWorker' in navigator,
                 doReload: () => { sessionStorage.setItem('coi-reloaded', '1'); location.reload(); }, quiet: true };
</script>
<script src="coi-serviceworker.min.js"></script>
<script type="module" src="/src/main.tsx"></script>
```

`vite.config.ts`: `server.headers` and `preview.headers` set `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: credentialless` so dev and preview are isolated without the
worker; the worker is exercised by the header-less `tools/static-serve.mjs` smoke. When headers come
from the server the worker sees `crossOriginIsolated === true` and `shouldRegister` still registers
harmlessly (ADR 0013: the app must work identically either way). `base: '/fem-lab/'`, `.nojekyll`
in `public/`.

---

## 8. CI/CD

`.github/workflows/ci.yml`, on `pull_request` and `push: main`, `concurrency` per ref:

| Job | Runner | Steps | Required |
|---|---|---|---|
| `rust` | ubuntu-24.04 | `dtolnay/rust-toolchain@1.94` (+wasm32 target), `Swatinem/rust-cache@v2`, `taiki-e/install-action@cargo-llvm-cov`, `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo llvm-cov -p femlab-engine --fail-under-lines 100 --fail-under-functions 100 --fail-under-regions 100 --lcov --output-path lcov.info` (regions stand in for branches; `--branch` needs nightly), `cargo test -p femlab` (CLI tests incl. schema freshness and fixture replay) | yes |
| `gpu` | ubuntu-24.04 | wgpu's recipe: download `https://github.com/gfx-rs/ci-build/releases/download/build29/mesa-26.1.3-linux-x86_64.tar.xz`, write `icd.json`, `VK_DRIVER_FILES=$PWD/icd.json`, `LD_LIBRARY_PATH`, `LVP_POISON_MEMORY=true`, `WGPU_BACKEND=vulkan`; `vulkaninfo --summary` pre-flight (`apt-get install vulkan-tools`); `cargo test -p femlab-engine --features gpu-tests -- gpu::` | `continue-on-error: true` until green for a week (ADR 0007), then required |
| `wasm-hash` | ubuntu-24.04 | rust toolchain + cache, `node tools/build-wasm.mjs` (installs matching `wasm-bindgen-cli`, cached under `~/.cargo/bin` by rust-cache), `cargo build -p femlab --release`, run the native and wasm hash lists for every fixture, `diff -r`; upload `packages/app/src/generated/wasm` as artifact `wasm` | yes |
| `web` | ubuntu-24.04, needs `wasm-hash` | `actions/setup-node@v5` (22, cache npm), download `wasm` artifact, `npm ci`, `npm run codegen -- --check` (needs `cargo run -p femlab -- schema`: reuse the rust cache, or have `wasm-hash` upload `engine.schema.json` too — do the latter), `npm run typecheck`, `npm run test -w packages/registry` (vitest, `coverage.thresholds: { 100: true }`, `coverage.include: ['src/**']`, excluding `src/generated/**`), `npm run test -w packages/app` (store, panels, colormap, VTU writer; no threshold), `npm run build -w packages/app`, `npx size-limit` (landing chunk < 1 MB gz per PLAN §11; viewer, wasm, sucrase, anthropic SDK are lazy chunks) | yes |
| `smoke` | ubuntu-24.04, needs `web` | `npx playwright install --with-deps chromium` (browsers cached by `actions/cache` on `~/.cache/ms-playwright` keyed by the Playwright version), `xvfb-run -a npx playwright test` with two projects: `cpu` (default Chromium, `vite preview`) — page loads, `window.fem` exists, `fem.geometry.addBox(...)` then `fem.query.model()` returns one body, Journal panel shows one line, `[data-cmd]` set ⊆ `fem.registry.list()`, screenshot artifact; `sw` (header-less `tools/static-serve.mjs`) — after one reload `crossOriginIsolated === true` and `fem.query.capabilities()` reports it; `gpu` (flags `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --use-vulkan=swiftshader --enable-unsafe-swiftshader`, `channel: 'chromium'`) — `capabilities.gpu === true` | `cpu`, `sw` required; `gpu` `continue-on-error` |

`.github/workflows/deploy.yml` on `push: main`: the `wasm-hash` + `web` build steps (no tests),
`actions/upload-pages-artifact@v3` with `packages/app/dist`, `actions/deploy-pages@v4`,
`permissions: pages: write, id-token: write`. GitHub Pages serves `.wasm` as `application/wasm`
and `.js` for the service worker at the app root; hashed asset names make stale caches a non-issue.

Caching: `Swatinem/rust-cache` (keyed by lockfile and job), npm cache via `setup-node`, Playwright
browsers, and the Mesa tarball (`actions/cache` on the extracted dir keyed by version).

---

## 9. Test strategy

| Layer | Tool | Threshold | What |
|---|---|---|---|
| `crates/engine` (registry, units, journal, hash, dispatch) | `cargo test`, proptest | 100 % lines/functions/regions | unit tests per module; proptest: `parse∘format` identity; **replay determinism**: a `proptest` strategy generates valid Command sequences (names drawn from a pool, boxes with positive sizes, constraints/loads on existing auto faces), applies them, replays the Journal into a fresh Engine, asserts equal `model_hash` and equal per-entry `hash_after`; **undo inverse**: for any prefix, `dispatch(c)` then `journal.undo` gives the hash before and `redo` gives the hash after; **transactionality**: a failing Command leaves hash and Journal length unchanged; every `Unsupported` stub arm is hit by a test |
| `crates/femlab` | `assert_cmd` | none (host) | `run`, `schema --check`, `bench` on fixtures; schema freshness; fixture `.hashes` |
| `crates/engine-wasm` | `wasm-bindgen-test`? No: Node via `tools/replay-wasm.mjs` in `wasm-hash` job | none (host) | replay equality with native is the test |
| `packages/registry` | vitest + v8 coverage | 100 % all four | Registry routing, zod validation errors → structured Error shape, `toToolDefinitions` invariants (§4.4), `makeFemProxy`, transport protocol encode/decode with a fake `EngineTransport`, script export formatting is Rust so not here |
| `packages/app` | vitest (Node, happy-dom for components) | none | store reducers for every host Command, `panels.test.ts` enumeration (§7.3), colormap, VTU writer against a 2-hex fixture, `WorkerTransport` with a fake worker |
| end-to-end | Playwright Chromium | smoke | §8 `smoke` |

The rule "tests that would fail if the logic broke": the replay and undo property tests are the
ones that catch a Command whose `apply` reads hidden state or mutates before validating.

---

## 10. Dependencies

| Where | Dependency | Version | Why (one line) |
|---|---|---|---|
| engine | serde, serde_json | 1 | the boundary format everywhere |
| engine | schemars | 1.2 | JSON Schema from the same derive (spike-verified) |
| engine | sha2, hex | 0.11, 0.4 | Model hash |
| engine | libm | 0.2 | identical transcendentals native/wasm (§2.9) |
| engine | thiserror | 2 | `Error` display without boilerplate |
| engine | wgpu | 30 (`default-features = false`, features `wgsl`, +`webgpu` on wasm, +`vulkan`/`metal` native) | the one GPU API for both hosts (ADR 0012) |
| engine | rayon | 1 (native only, `[target.'cfg(not(target_arch = "wasm32"))'.dependencies]`) | CPU parallelism (ADR 0013) |
| engine dev | proptest | 1 | property tests |
| engine-wasm | wasm-bindgen 0.2.128, wasm-bindgen-futures 0.4.78, js-sys, web-sys, console_error_panic_hook | | the JS boundary; panics become readable errors |
| femlab | clap 4.6 (derive), pollster, anyhow | | CLI; block_on for the async engine |
| femlab dev | assert_cmd | 2 | CLI smoke |
| registry | zod | 4.5 | host Command schemas with `z.toJSONSchema` |
| registry dev | json-schema-to-typescript 16, vitest 5, @vitest/coverage-v8 5, typescript 5.9 | | codegen and tests |
| app | three 0.185, preact 10.29, immer 11.1, sucrase 3.35, @anthropic-ai/sdk 0.124 | | §7.1 |
| app dev | vite 8.2, vitest 5, happy-dom, @playwright/test 1.63, size-limit 13 + @size-limit/file, @types/three | | build, tests, budget |
| app public | coi-serviceworker.min.js 0.1.7 (vendored) | | must be a separate same-origin file |

Not taken: wasm-pack (two commands replace it), serde-wasm-bindgen (JSON is the wire format),
uom (no parser), Babylon (§7.1), comlink (the protocol is 40 lines and must match a future HTTP
transport), CodeMirror (PLAN 3.3: a textarea is enough in phase 1), @modelcontextprotocol/sdk
(phase 4.10, `femlab mcp`).

---

## 11. Commit sequence

Each commit is green (fmt, clippy, tests, coverage) and self-contained. Branch `plan-b/registry-hosts`
(or one PR per group of ~5 commits if the diff gets large).

| # | Commit | Done when |
|---|---|---|
| 1 | Workspace skeleton: Cargo workspace with three empty crates, `rust-toolchain.toml`, `clippy.toml` deny list, `#![forbid(unsafe_code)]` in engine, npm workspaces with empty `registry` and `app`, `ci.yml` with `rust` and `web` jobs | CI green on empty crates; `cargo llvm-cov` reports 100 % of nothing without erroring (`--fail-under-*` with an `engine::version()` fn and its test) |
| 2 | `units.rs`: `Quantity`, `Dimension`, `Dim` markers, `Q<D>`, unit table, parser, `format`, `convert`, `UnitSet`; proptests | `parse∘format` identity passes 1000 cases; dimension mismatch and unknown symbol produce the structured errors of §2.6 |
| 3 | `error.rs`, `command.rs`, `query.rs` with the full enums, param types, doc strings, response structs, `Ack/Output`; `schema_for!` snapshot test in `crates/femlab/tests` against a committed `engine.schema.json` (first version generated by a test `--bless` flag) | every variant has a ≥ 80-char description; every physical field `$ref`s a `Q_*` def; `plugin.load` carries `x-status: stub` |
| 4 | `model.rs`, `engine.rs` `apply` for model/geometry/material/constraint/load/step Commands (name uniqueness, referential checks, auto face names, `InUse` on remove), transactional `dispatch`, `Host` trait, `Gpu` struct (construction only), `warnings()` with the checks that need no mesh (unassigned body, dangling names) | unit tests per Command incl. every error path; hash stable across a run |
| 5 | `journal.rs`, undo/redo snapshots, `as_script`, `ModelFile`, `export/import_file`, `replay`; `hash.rs`; proptests for replay determinism, undo inverse, transactionality | proptests pass at 256 cases; `as_script` output round-trips through `serde_json` (parse each line's object back into `Command`) |
| 6 | Stub arms: `mesh.set` stores settings and invalidates; `solve.run`, `study.converge`, `query.mesh/result/probe/path/cost` return `Unsupported` with tests; `query.model/set/journal/script/convert/capabilities` real | coverage 100 % on the engine crate |
| 7 | `crates/femlab`: clap, `run` (all flags), `schema`, `bench` (case format, runner, markdown/json), `serve` stub; fixtures `benches/journals/cantilever.json` + `.hashes`; `assert_cmd` tests | `femlab run fixture --verify` exits 0; `femlab schema --check` passes |
| 8 | `tools/codegen.mjs`, `packages/registry/src/generated/*` committed, `npm run codegen -- --check` in CI | generated `engine.ts` type-checks; `fem.d.ts` has one method per Command/Query |
| 9 | `packages/registry`: `Registry`, `transport.ts` types, `host-commands.ts` (zod), `tools.ts`, `script-api.ts`; vitest at 100 % | tool-list invariants pass; fake-transport round trips |
| 10 | `crates/engine-wasm`: surface of §5.1, `tools/build-wasm.mjs` (web + nodejs targets, version-matched CLI), `tools/replay-wasm.mjs`, CI job `wasm-hash` | native and wasm hash lists identical for every fixture in CI |
| 11 | `packages/app` shell: Vite config, `index.html` with coi recipe, capability detection, `engine.worker.ts`, `WorkerTransport`, `store.ts`, `window.fem`, minimal `<App/>` with header + status bar; Playwright `cpu` and `sw` smokes; `deploy.yml` | deployed to Pages; on Chromium `crossOriginIsolated === true` after one reload; `fem.geometry.addBox` works from DevTools |
| 12 | `panels.ts` tables + `panels.test.ts`; Model tree panel from `query.model`; Properties schema-driven form (all schema shapes of §7.3) | adding a box, a material, assigning it, adding a fixed constraint via forms produces the expected Journal |
| 13 | Viewer: three.js surface rendering, fit/camera, edges, picking with the name-face chip, `selection.*`, `view.*` Commands | pick → chip → `geometry.nameFace` appears in the Journal; screenshot smoke artifact shows the box |
| 14 | Journal panel (live script, undo/redo) and Script panel (sucrase Worker, timeout, stop) | pasting the Journal's script into the Script panel and running it reproduces the Model hash |
| 15 | Examples gallery from `public/examples/index.json`; `file.open/save`, `?example=` deep link | opening an example rebuilds the tree and viewer |
| 16 | `gpu` CI job (lavapipe recipe) and `smoke` `gpu` project; `Engine.create({ gpu: true })` requests a device in the worker; `query.capabilities` reports it | `capabilities.gpu === true` on SwiftShader in CI at least once; job stays `continue-on-error` |
| 17 | *(after plan A's mesher)* `mesh.set` builds, `query.mesh`, `query.set`, `mesh_surface` from the real Mesh; viewer shows the lattice; loads/constraints layer markers | cantilever fixture meshes at three sizes; every auto face resolves to a non-empty Set |
| 18 | *(after plan A's static solver)* `solve.run` with progress, `query.result/probe/path/cost`, Results panel (extremes, reactions, probe), field contours, deformed shape, legend, clip plane, `file.exportVTU` | Benchmark B1 solves from the UI in under a minute (PLAN §3 exit criterion); reaction balance shown |
| 19 | `study.converge` with `StudyReport`; Results panel shows the table and rate | B1 convergence study from one Command |
| 20 | AI panel behind `?ai=1`: key notice, tool loop, Journal diff, cost | the success story runs with a stated model id against the deployed page |
| 21 | size-limit budget, lazy chunks (viewer, wasm, sucrase, SDK), landing < 1 MB gz | `npx size-limit` passes in CI |
| 22 | Threads lane: nightly-pinned `engine_threads.wasm` build in `wasm-hash` (`continue-on-error`), loader selects by isolation, `capabilities.threads`; equality test 1 vs N threads on a fixture | identical hashes; single-thread note appears when not isolated |

Commits 17–19 wait for plan A; everything else is independent of it and lands first.

---

## 12. Risks and recommendations

| # | Risk | Recommendation |
|---|---|---|
| R1 | **Typed-array views over wasm memory are invalidated by memory growth** (a `dispatch` after `field()` can move the heap). | Views never leave the worker; `slice()` immediately and transfer. A debug assertion in the worker checks `view.buffer === memory.buffer` before slicing and throws `Internal` if not. |
| R2 | **wasm threads need nightly + build-std**; two artefacts; PLAN 0.8 wanted it in phase 0. | Ship single-threaded stable first (§5.2), coi-serviceworker from day one so isolation is real and tested, threaded artefact as commit 22 with pinned nightly and `continue-on-error`. The engine's `par_iter` shim makes the switch a build flag, not a code change. |
| R3 | **Native vs wasm hash divergence** from libm differences or `HashMap` iteration order. | `libm` crate only; clippy `disallowed-methods/types`; `BTreeMap` only in serialised state; per-entry hashes localise the first divergence. |
| R4 | **serde-wasm-bindgen vs JSON strings performance.** | JSON for control (< 1 ms per Command, measured in spike 0.7), typed arrays for bulk; the same bytes serve `femlab serve`. Revisit only if a profile shows it. |
| R5 | **Viewer bundle size.** three ~600 KB min / ~150 KB gz tree-shaken; Babylon would be 1.5 MB+. | three.js, lazy `import()` of the viewer chunk after the shell renders; size-limit gate. |
| R6 | **GitHub Pages + service worker + wasm MIME / stale caches.** | Pages serves `application/wasm`; coi-serviceworker only injects headers on pass-through and caches nothing; Vite hashes assets. Reload loop guarded by `sessionStorage`; `shouldRegister` false when already isolated. Test both the header path (preview) and the SW path (static-serve) in CI. |
| R7 | **Chromium+SwiftShader WebGPU flakiness in CI** ("external Instance" errors). | Vulkan-via-SwiftShader flag set (note 05), `xvfb-run`, `continue-on-error`, `cpu` and `sw` smokes never depend on a GPU; the wgpu-on-lavapipe `gpu` job is the primary GPU lane. |
| R8 | **wasm-bindgen CLI/crate version mismatch** breaks the build silently on a new machine. | `tools/build-wasm.mjs` reads `Cargo.lock` and installs the exact CLI version. |
| R9 | **Anthropic tool constraints and token cost**: names cannot contain `.`; ~45 tools ≈ 15–20 k tokens of definitions. | `toolNameFor` mapping with reverse lookup; `run_script` + generated API reference as the primary mode (Anthropic/Cloudflare findings, note 05); consolidate to one tool per namespace with an `action` field if evals show selection ambiguity. |
| R10 | **Schema drift** between Rust, JSON, TS, forms and tools. | Rust snapshot test + `codegen --check` + tool-list invariant test; three independent gates on one artefact. |
| R11 | **Concurrent calls into the wasm `Engine`** panic ("recursive use of an object"). | The worker's promise queue; the transport never issues two calls at once; a test with a fake worker asserts ordering. |
| R12 | **Cancelling a CPU solve** cannot interrupt wasm. | `terminate` + recreate + `import_file(snapshot)`; the transport snapshots before every `solve.run`; cancelled solve leaves the Journal as before the solve (the `solve.run` entry is appended only on `Ok`). |
| R13 | **`Option<T>` schemas emit `type: [.., "null"]`**; the AI may pass `null`. | serde accepts `null` for `Option`; TS gets `| null`; fine. Do not use `#[serde(skip_serializing_if)]` on Commands (Journal round-trip must be exact). |
| R14 | **100 % coverage with stub arms and error paths.** | Every stub and every `Error` constructor has a test in the same commit; `llvm-cov` regions replace branches (nightly-only). |
| R15 | **TypeScript 7 / Vite 8 / vitest 5 churn.** | Pin TS 5.9.3; vite 8 and vitest 5 are verified peers; upgrade TS when Preact and Vite typings publish support. |
| R16 | **The engine takes no storage argument** although ADR 0011 lists one. | Nothing in phases 0–3 needs it (hosts do file I/O); add it with `plugin.load { url }` in phase P and amend the ADR then. |
| R17 | **Blender's "context is incorrect"** creeping in via the selection. | Host Commands take names; `selection.set` is itself a Command; engine Commands never read selection. The pick chip *proposes* a Command with explicit arguments. |

---

## 13. Deviations from `docs/PLAN.md` and open decisions for the owner

1. **Viewer: three.js instead of Babylon.js** (PLAN §1, §14.2). Reasons in §7.1. Record as ADR 0015
   if accepted; otherwise the `Viewer` class is the only file that changes.
2. **Threads land last, not in phase 0** (PLAN 0.8). Nightly + build-std + two artefacts is a lane of
   its own; isolation on Pages is still proven in phase 0 (`sw` smoke). Amend ADR 0013's consequences
   with the toolchain note.
3. **No `storage` constructor argument** (PLAN 0.6, ADR 0011). See R16.
4. **No UI undo via immer patches** (ADR 0003 mentions `produceWithPatches`). Model undo is Rust
   snapshots; UI state is not undoable, as in Blender. immer stays as the store's update primitive.
5. **`file.save/load/exportVTU` are host Commands**, not engine Commands (the engine has no file
   system); the engine exposes `export_file/import_file`. Same names as PLAN 3.1, different provider.
6. **Phase-3 CSG Commands are not stubbed**; only `plugin.load` is, because PLAN names it.
7. **Preact** as the UI library; the demos so far are vanilla DOM. Owner's call; swapping is a
   day's work while panels are few.
8. **Repo licence and `base` path**: `/fem-lab/` assumed; a custom domain changes one line.
