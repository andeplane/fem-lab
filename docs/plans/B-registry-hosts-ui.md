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
  discriminator, keeps variant and field doc comments as `description`, leaves every `Option<T>`
  field out of `required` (with or without `#[serde(default)]`; serde accepts it missing, so `?`
  fields need no attribute) and emits it as `type: [T, "null"]`, and honours
  `#[schemars(extend("x-status" = "stub"))]` and `#[schemars(extend("x-returns" = "ModelSummary"))]`
  on variants (re-verified 2026-09-05 under `scratchpad/reviewB-spike`). A generic `Q<D: Dim>` with
  a hand-written `JsonSchema` impl emits one `$defs` entry per dimension that `$ref`s `Quantity`
  and carries the dimension in `description` and `x-dimension`.
- json-schema-to-typescript 16.0.0 turns that schema into a discriminated union with JSDoc, tuple
  types for `[Q; 3]`, and `string | { unit; value }` for `Quantity`.
- wasm-bindgen 0.2.128 compiles `pub async fn dispatch(&mut self, ..) -> Result<String, JsValue>`
  on a `#[wasm_bindgen]` struct for `wasm32-unknown-unknown`. Concurrent calls would panic
  ("recursive use of an object"), so the worker serialises them.
- wasm-bindgen-rayon 1.3.0 still needs a pinned nightly and `-Z build-std` (atomics); the repo's
  stable 1.94 cannot build the threaded wasm. See §13 and R2.
- wgpu 30.0.1: `Instance::new(InstanceDescriptor::new_without_display_handle())` (by value, no
  `Default`; plan A's spike), `request_adapter(..).await` returns `Result`. There is no API to wrap
  an existing `web_sys::GPUDevice`, so the engine-wasm host requests its own device inside Rust and
  the viewer uses its own WebGL2 context; the two never share a device (plan C §8 agrees).
- Anthropic tool names must match `^[a-zA-Z0-9_-]{1,64}$`: Command names with dots are mapped
  `geometry.addBox` → `geometry_addBox` in `toToolDefinitions()` and back on dispatch.
- Atomify's Pages recipe: `public/coi-serviceworker.min.js`, an inline `window.coi = {
  coepCredentialless: () => true, shouldRegister: () => !resetting }` before the script tag, and
  Vite dev headers `COOP: same-origin`, `COEP: credentialless`.
- npm on 2026-09-05: three 0.185.1 (23 MB unpacked) vs @babylonjs/core 9.25.0 (70 MB), zod 4.5.4,
  vite 8.2.2, vitest 5.0.0 (peer vite ^6.4 || ^7 || ^8), @playwright/test 1.63.0,
  json-schema-to-typescript 16.0.0, immer 11.1.18, sucrase 3.35.1, typescript 5.9.3 (**7.0.2 is
  what `npm view typescript version` returns, i.e. `latest`; every `package.json` pins `5.9.3`
  exactly**), @anthropic-ai/sdk 0.124.0, @modelcontextprotocol/sdk 1.30.0, preact 10.29.8,
  size-limit 13.0.3, coi-serviceworker 0.1.7, @types/wicg-file-system-access 2023.10.7
  (TypeScript 5.9's `lib.dom.d.ts` has no `showDirectoryPicker`; checked).
- Anthropic Messages API (via the `claude-api` skill, 2026-09-05): tools are
  `{ name, description, input_schema }` (`Anthropic.Tool`), optional `strict: true` for exact
  argument validation; the default model id for new code is `claude-opus-5` with adaptive
  thinking (`thinking: { type: 'adaptive' }`) and streaming; `dangerouslyAllowBrowser: true` is
  still the browser flag. `tool_result` blocks for all parallel calls go back in **one** user
  message; a failed tool returns `tool_result` with `is_error: true`.
- Not verifiable from this sandbox (network to github.com blocked): the `gfx-rs/ci-build` Mesa
  tarball URL and the exact latest tags of `actions/upload-pages-artifact` / `deploy-pages` /
  `setup-node`. §8 therefore uses apt `mesa-vulkan-drivers` first (plan A's recipe) and says
  "latest major" for action tags; the coder checks both on the first CI run.

---

## Reconciled with A and C (review, 2026-09-05)

Plans A (numerics), B (this) and C (geometry, meshing, order) were written the same day and
disagree in places. These are the decisions plan B codes against; where a decision lands in A's
or C's territory it is marked **ask A** / **ask C** and is a one-line change request there, not a
silent divergence here.

| Topic | A says | C says | B codes against |
|---|---|---|---|
| Workspace crates | `crates/engine` (+ `engine-wasm`, `femlab` assumed) | adds `crates/geometry` (manifold-rust, weka, meshers, `Mesh`, VTU/msh writers) | Four crates: `geometry`, `engine`, `engine-wasm`, `femlab`. `engine` depends on `geometry`; `geometry` depends on nothing of ours. B's §1 layout lists it |
| `Mesh` type and its owner | `crates/engine/src/mesh` (`coords: Vec<f64>`, `blocks: Vec<ElementBlock>`, `node_sets/elem_sets/face_sets: BTreeMap`, `Face { elem, local }`, Abaqus ordering) | `crates/geometry/src/mesh.rs` (`nodes: Vec<[f64;3]>`, `blocks`, `boundary_faces`, `face_tags`) | **A's struct, in C's crate**: A's `Mesh`/`ElementKind`/`ElementBlock`/`Face` definitions move verbatim to `crates/geometry/src/mesh.rs` so meshers can produce it without depending on the engine; A's `mesh/structured.rs` test builder stays in the engine and imports it. Face sets are `(elem, local)` lists (A Q4). Auto face names `<body>.xmin…` are ordinary `face_sets` keys. **ask A, ask C** |
| Engine `Cargo.toml` features | `default = ["gpu","threads"]`, wasm builds `--no-default-features --features gpu` | – | A owns the feature set; B adds `serde_json`, `schemars`, `sha2`, `hex`, `libm`, `thiserror`, `femlab-geometry`. §1 and §10 updated |
| `Gpu` handle | `pub struct Gpu { device, queue }` + `limits()` in `gpu/mod.rs`; host creates instance/adapter/device with `adapter.limits()` | – | A's struct; B's `Engine::new(gpu: Option<Gpu>, host, threads)` takes it. B's earlier `limits` field is dropped |
| Error type | `EngineError { code: &str-like dotted string, message, at, suggest }` | – | **One struct**, B's `Error { code: ErrorCode, cause, where, suggestion }` (the AGENTS.md words); `ErrorCode` is an enum whose serialised form is A's dotted string (`mesh.inverted`, `solve.stalled`, `constraint.rigid-modes`, `gpu.too-large`, …). A's `Diagnostic` = B's `Warning`. §2.6 lists the union. **ask A**: use `femlab_engine::Error` |
| Solve entry point | `procedure::run(p: &Problem, step: &Step, gpu: Option<&Gpu>, prev: Option<&StepResult>) -> Result<StepResult>`; `Problem { mesh, materials: [Material], constraints: [Constraint], loads: [Load] }` all SI f64 | – | B's `apply(solve.run)` builds A's `Problem` from the Model (unit strings → SI, names → set keys, `load.traction { total }` → per-area traction) and calls A's `run`. A's `StepResult { fields: BTreeMap<String, post::Field>, scalars, info: SolveInfo, checks }` is stored as-is; B's `ResultSummary` is derived from it with `post::extremes` and `post::reactions_per_constraint`. B's earlier `solve_static`/`StepResult`/`cost_estimate` seam is replaced (§0) |
| Progress and cancel | `run` has no callback; every GPU-touching fn is `async` | – | B emits **phase-level** progress itself around its calls (`mesh`, `assemble`, `solve`, `post`); iteration-level progress and cooperative cancel need a callback inside A's `SolveOptions` — **ask A** (`on_progress: Option<&mut dyn FnMut(Progress) -> bool>`, checked every 25 CG iterations / every outer refinement step). Until then cancel is the worker-terminate path (§5.1) |
| Element choice in `mesh.set` | `ElementKind` (8 kinds) × `Formulation { Full, IncompatibleModes }`; hex8 defaults to incompatible modes | order 1/2 per mesher; B-bar later | `mesh.set { mesher, size, order: 1\|2, formulation?: 'incompatible-modes' (default) \| 'full' }`; the Mesher picks the kind (lattice → hex, free2d → tri, mapped → quad/hex). B's `ElementType { Hex8, Hex8Im, Hex20 }` is dropped |
| Geometry Commands | – | `Shape` tree (`Box`, `Cylinder`, `Sphere`, `Extrude`, `Revolve`, booleans, `Transform`) evaluated by manifold-rust; `geometry.add { name, shape, at? }`, `geometry.subtract`, `geometry.nameFace/nameEdge/nameRegion`, `sketch.add`, `mesh.build`, `mesh.import/export`, `query.geometry` | The Model stores C's `Shape` from day one (`Body { name, shape: Shape, material? }`), so C's commit 6 adds variants, not a rewrite. B keeps `geometry.addBox`/`subtractBox` as the phase-1 Commands (they store `Shape::Box`; they stay as the friendliest AI tools). C's predicate enum carries SI `f64`; B's Command-side `FacePredicate`/`RegionPredicate` carry `Q<Length>` and `apply` converts (one `From` impl, ~30 lines). `mesh.export`/`query.geometry` are folded into B's `query.export`/`query.model` |
| Viewer | – | three.js WebGL2, not Babylon | Agreed (§7.1). PLAN §14.2 decision defaults to three.js |
| `model_hash` and native-vs-wasm equality | – | hash over inputs only; floats from libm may differ in the last ulp | Agreed and already true here: `Model` holds Command parameters (SI f64 obtained by multiplication, IEEE-exact); no mesh, no Result. §2.9 rule 3 (libm) is belt-and-braces |
| Journal vs UI Commands | – | registry = engine ∪ UI Commands; Journal = engine Commands only; a test asserts it | Agreed; the Rust Journal can only hold `Command`, so host Commands cannot land there by type. A registry test still asserts `query.journal.revision` is unchanged after every host Command (§9) |
| Coverage gate | 100 % lines/functions/regions with `--all-features` **in the lavapipe job**; the plain job runs `--no-default-features --features threads` | 100 % on pure crates, `gpu/` excluded via `--ignore-filename-regex`, branches dropped | A's scheme: `rust` job = `cargo llvm-cov --no-default-features --features threads` at 100 % (no GPU code compiled, nothing excluded); `gpu` job = `--all-features` at 100 %, `continue-on-error` until stable. No `--ignore-filename-regex` in the engine. `packages/registry` 100 % via vitest |
| Zod / immer | – | drop both; plain `{ name, description, inputSchema, run }` objects | **Keep zod 4** for host Commands: its `z.toJSONSchema` is the single source for the tool list, the form and `fem.d.ts`, and host inputs must be validated (the AI sends them). **Drop immer**: UI state is a handful of plain reducers; nothing needs patches (UI undo was already dropped, §13) |
| GPU lane recipe | apt `mesa-vulkan-drivers`, `LVP_POISON_MEMORY=true` | same | apt first (§8); the `gfx-rs/ci-build` tarball only if lavapipe from apt fails a test |
| Commit numbering | A §11: 1–23 (numerics) | C §5: 1–22 (whole build) | Each plan numbers its own sequence. B §11 maps its commits to C's: C1 ≙ B1, C2 ≙ B2, C3 ≙ B3–B5, C4 ≙ B7+B10, C5 ≙ B16, C15 ≙ B11–B15, C16 ≙ B11's deploy. A's commits are independent of B's until B17 |

Everything B asks of A is a signature or a moved file, not a design change; everything B asks
of C is where a struct lives.

---

## 0. Scope and the seam with plan A

This plan implements, in order: units → errors → Command/Query enums and schema export → Model,
transactional dispatch, Journal, undo/redo, hashing → codegen → TS registry → CLI → wasm → app
shell → panels → AI (mentions, skills, project folder) → export → CI → deploy. It stops at the
calls into plan A. Those calls are the seam; the signatures below are plan A's own (§1.3, §2, §6,
§7, §8 of plan A) and plan B codes against them as written:

```rust
// crates/geometry/src/mesh.rs (A's struct, C's crate; see "Reconciled")
pub struct Mesh { pub dim: usize, pub coords: Vec<f64>, pub blocks: Vec<ElementBlock>,
                  pub node_sets: BTreeMap<String, Vec<u32>>, pub elem_sets: BTreeMap<String, Vec<u32>>,
                  pub face_sets: BTreeMap<String, Vec<Face>> }
// crates/geometry (plan C): Shape → Solid → Mesh
pub fn mesher::build(shape_tree: &[Body], settings: &MeshSettings) -> Result<Mesh, Error>;   // C §2.7
// crates/engine/src/procedure (plan A §6)
pub struct Problem<'a> { pub mesh: &'a Mesh, pub materials: &'a [Material], pub constraints: &'a [Constraint], pub loads: &'a [Load] }
pub async fn procedure::run(p: &Problem<'_>, step: &Step, gpu: Option<&Gpu>, prev: Option<&StepResult>) -> Result<StepResult, Error>;
pub struct StepResult { pub fields: BTreeMap<String, post::Field>, pub scalars: BTreeMap<String, f64>,
                        pub modes: Option<Modes>, pub history: Option<History>, pub info: SolveInfo, pub checks: Vec<Warning> }
// crates/engine/src/fem/checks.rs (plan A §7): each returns Err(Error) with code/cause/where/suggestion
pub fn checks::run(p: &Problem<'_>) -> Result<(), Error>;                                   // J6.11; B maps Err → Warning for query.model
// crates/engine/src/solve/mod.rs (plan A §5, amended by #122): bounded cost counting
pub fn solve::cost_estimate(mesh: &Mesh, dofs_per_node: usize, solver: Solver) -> CostEstimate;
// crates/engine/src/post (plan A §8)
pub fn post::extremes(f: &Field, mesh: &Mesh) -> Vec<Extreme>;
pub fn post::reactions_per_constraint(p: &Problem, r: &[f64]) -> Vec<(String, [f64; 3])>;
pub fn post::probe(mesh, f: &Field, x: [f64; 3]) -> Option<Vec<f64>>;  pub fn post::path(..) -> Vec<(f64, Vec<f64>)>;
// asked of plan A (one-line additions):
pub fn mesh::face_set_area(mesh: &Mesh, faces: &[Face]) -> f64;     // load.traction { total } → per-area traction
pub struct SolveOptions { .., pub on_progress: Option<&mut dyn FnMut(Progress) -> bool> }  // iteration progress + cooperative cancel
```

`query.cost` calls the bounded estimator in A (#122): exact non-zero counts within a 16 MiB
scratch cap, conservative bounds above it, and mandatory assembly storage including element
slots. Feasibility is false above a fixed 1.5 GiB planning budget and unknown otherwise, since
solver fill/workspace are excluded. See plan A §5 for the storage accounting.

Until plan A lands there is no stub mesher or fake solver (that would be scaffolding for its own
sake). Plan B lands with `mesh.set`, `solve.run`, `study.converge`, `query.mesh`, `query.result`,
`query.probe`, `query.path`, `query.cost` present in the enum and returning
`Error::unsupported("numerics land in plan A")` from `dispatch`, each with a test asserting exactly
that error, so coverage stays at 100 % and the schema, the TS types, the tool list and the UI are
complete from day one. When plan A lands, the `unsupported` arms are replaced by the calls above and
those tests by Benchmarks. Export formats that need a Mesh (VTU, msh, inp, STL) are stubbed the same
way; `script`, `journal`, `csv` (of `query.model` tables) and `report` (without result sections) are
real from commit 6.

---

## 1. File layout

```
Cargo.toml                          workspace: crates/geometry (plan C), crates/engine, crates/engine-wasm, crates/femlab; resolver 2
rust-toolchain.toml                 channel = "1.94", targets = ["wasm32-unknown-unknown"]
package.json                        npm workspaces: packages/*; root scripts: codegen, build, test, ci (all `node tools/*.mjs`, Windows-safe)
.github/workflows/ci.yml            jobs: rust, gpu, wasm-hash, web, smoke       (§8)
.github/workflows/deploy.yml        Pages deploy of packages/app/dist on push to main
crates/geometry/                    plan C: Shape, Solid, predicates, Mesh type (A's struct), meshers, io/{vtu,msh}.rs
crates/engine/                      headless library, 100 % coverage
  Cargo.toml                        plan A §1.2 owns features (gpu, threads) and numerics deps; B adds femlab-geometry, serde_json, schemars, sha2, hex, libm, thiserror; dev: proptest
  clippy.toml                       disallowed-types/methods: std::fs::*, std::net::*, std::time::Instant, std::thread::spawn, f64::{sin,cos,tan,exp,ln,powf,...} (use libm)
  src/lib.rs                        pub use; #![forbid(unsafe_code)]; #![deny(clippy::disallowed_methods, clippy::disallowed_types)]
  src/engine.rs                     Engine, Host trait, dispatch, query, export, snapshots      (§2.1)
  src/command.rs                    enum Command + param types                                 (§2.2, §2.4)
  src/query.rs                      enum Query + response structs                              (§2.3)
  src/units.rs                      Quantity, Q<D>, Dim markers, Unit table, UnitSet           (§2.5)
  src/error.rs                      Error, ErrorCode, Warning (shared with plan A)             (§2.6)
  src/model.rs                      Model, Body { shape: geometry::Shape }, Material, Set, Constraint, Load, Step, MeshSettings
  src/journal.rs                    Journal, JournalEntry, ModelFile, as_script                (§2.8)
  src/hash.rs                       canonical JSON + sha256                                    (§2.9)
  src/surface.rs                    Mesh → Surface (triangulated boundary, body id, face-set id per triangle) for the viewer and STL
  src/export.rs                     ExportSpec, ExportFormats, write(): vtu/msh/inp via geometry::io, stl, csv, script, journal  (§7.10)
  src/report.rs                     Markdown report from Model + Results + Journal (image placeholders)                          (§7.10)
  src/mesh/structured.rs, src/fem/, src/solve/, src/gpu/, src/procedure/, src/post/, shaders/, benches/    plan A
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
  src/host-commands.ts              zod schemas + doc strings for every host Command and host Query of §4.3 (no DOM: takes a `HostContext` interface)
  src/tools.ts                      toToolDefinitions(), toolNameFor(), commandNameFor()
  src/script-api.ts                 makeFemProxy(dispatch, query): fem.geometry.addBox(...)
  src/mentions.ts                   parseMentions(text) → chips, refOf(kind, name), MENTION_KINDS (pure; §7.7)
  src/skills.ts                     parseSkill(md) → { name, description, when, body }; mergeSkills(builtin, project) (pure; §7.8)
  src/project-paths.ts              normalisePath(), assertInside() for file.read/write scoping (pure; §7.9)
  src/index.ts
packages/app/                       browser host                                                (§7)
  package.json                      deps: three, preact, sucrase, @anthropic-ai/sdk, @femlab/registry; dev: vite, vitest, happy-dom, @playwright/test, size-limit, @types/three, @types/wicg-file-system-access
  index.html                        coi-serviceworker registration (Atomify recipe), capability notes, <div id=app>
  public/coi-serviceworker.min.js   vendored 0.1.7
  public/examples/*.json            copied from crates/engine/benches/journals at build (tools/codegen.mjs step)
  skills/<name>/SKILL.md            built-in skills: beam-theory-check, convergence-study, write-report, nafems-benchmark (§7.8)
  vite.config.ts                    base '/fem-lab/', server.headers COOP/COEP, worker.format 'es', build.target 'es2022'
  src/main.tsx                      boot: capabilities → worker → registry → window.fem → render <App/>
  src/engine.worker.ts              owns the wasm Engine; message loop                          (§5.3)
  src/worker-transport.ts           WorkerTransport implements EngineTransport
  src/script.worker.ts              sucrase + fem proxy over a MessagePort                      (§7.5)
  src/store.ts                      UiState, createStore (plain reducers + subscribe), selectors
  src/panels.ts                     PANELS and CONTROLS data tables (every control names its Command)  (§7.3)
  src/viewer/viewer.ts              three.js Viewer                                             (§7.2)
  src/viewer/colormap.ts            viridis + rainbow LUTs → Float32Array RGB
  src/ui/*.tsx                      Preact components, one per panel — built after the design comes back (§11)
  src/ai/agent.ts                   tool loop over registry.toToolDefinitions() + run_script + skill.invoke  (§7.6)
  src/ai/context.ts                 system prompt assembly: API ref + rules + AGENTS.md + skills index; mention resolution (§7.6–7.8)
  src/project.ts                    ProjectFolder over FileSystemDirectoryHandle: open/persist/list/read/write/watch AGENTS.md (§7.9)
  src/export/image.ts               PNG/SVG of the viewer with legend and title (§7.10)
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
pub use crate::gpu::Gpu;          // plan A's `Gpu { device, queue }` (+ `limits()`); the host builds it (ADR 0002 limits)

pub struct Engine {
    model: Model,                 // the serialisable description; small; Clone
    mesh: Option<Mesh>,           // derived; rebuilt lazily when model.mesh_settings or geometry changed
    results: BTreeMap<String, (String /*model hash at solve*/, StepResult)>,   // key: step name
    journal: Journal,             // append-only; undo truncates it
    undo: Vec<Model>,             // Model snapshots only (a few KB each); Blender's memfile rule: push on FINISHED, never on CANCELLED
    redo: Vec<Command>,
    gpu: Option<Gpu>,
    host: Box<dyn Host>,
    threads: usize,
}
const UNDO_DEPTH: usize = 200;    // ponytail: fixed cap; a 10k-body Model is ~1 MB per snapshot, so 200 is the memory bound

pub struct Progress { pub phase: &'static str, pub fraction: f64, pub message: String }
pub type OnProgress<'a> = &'a mut dyn FnMut(Progress) -> bool;   // return false to cancel → Error::cancelled()

impl Engine {
    pub fn new(gpu: Option<Gpu>, host: Box<dyn Host>, threads: usize) -> Engine;
    pub async fn dispatch(&mut self, cmd: Command, on_progress: OnProgress<'_>) -> Result<Ack, Error>;
    pub fn query(&mut self, q: Query) -> Result<QueryResult, Error>;   // &mut: may build the lazy mesh
    pub fn model_hash(&self) -> String;
    pub fn export_file(&self) -> ModelFile;
    pub fn import_file(&mut self, f: ModelFile) -> Result<Ack, Error>; // replaces model+journal; clears undo/redo/results
    pub fn replay(&mut self, entries: &[JournalEntry], skip_solves: bool) -> Result<Vec<String>, Error>;  // §2.8
    pub fn mesh_surface(&mut self) -> Result<&Surface, Error>;         // bulk arrays for the viewer (surface.rs)
    pub fn field(&self, step: &str, field: Field, component: Option<u8>) -> Result<&[f64], Error>;
    pub fn export(&mut self, spec: &ExportSpec) -> Result<Export, Error>;   // §7.10; Export { filename, mime, bytes: Vec<u8> }
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
    let before = self.model.clone();                          // the Journal needs no snapshot: it is append-only
    let out = self.apply(&cmd, on_progress).await;           // the big match; mutates self.model / self.results
    match out {
        Ok(output) => {
            self.undo.push(before); if self.undo.len() > UNDO_DEPTH { self.undo.remove(0); }
            self.redo.clear();
            let entry = self.journal.append(cmd, self.model_hash());
            Ok(Ack { seq: entry.seq, revision: self.journal.len(), hash: entry.hash_after.clone(),
                     warnings: self.warnings(), output })
        }
        Err(e) => { self.model = before; Err(e) }             // nothing ran, nothing recorded (apply must not touch results before it can fail)
    }
}
```

Snapshotting `(Model, Journal)` per entry, as the first draft did, is O(n²) over a session (a
10k-entry Journal copied 10k times); the Journal is append-only, so undo is `journal.truncate(len - steps)`
and only the Model is snapshotted.

- `model.new` is the exception that resets: `apply` replaces `model`, `journal`, `results`, `undo`, `redo`.
- `Command::SolveRun` and `Command::StudyConverge` are journaled like any other; results are stored
  by step name with the model hash at solve time. `query.result` reports `stale: true` when that hash
  differs from the current one. Undo past a solve orphans its Result (ADR 0003).
- Model changes invalidate `self.mesh` (`geometry.*`, `mesh.set`, `material.assign` because sets carry
  material ids). `query.mesh`, `solve.run`, `mesh_surface` rebuild on demand.
- **Edits are re-issues (upsert).** Every "create" Command (`geometry.addBox/subtractBox`,
  `geometry.nameFace/nameRegion`, `material.add`, `constraint.*`, `load.*`, `step.add`) with a
  `name` that already exists *in its own kind* replaces that object in place (tree order kept) and
  returns `Ack.output = Replaced { kind, name }` plus a Warning, so the Properties form's "Apply"
  on an existing item is the same Command the form was generated from, and an AI cannot silently
  duplicate. Names are still unique per kind; `NameTaken` is raised only by `model.rename` when
  the target exists. Replay stays unambiguous (last write wins, in Journal order).
- `threads` is honoured natively via a rayon pool built in `Engine::new`; the wasm build without
  the `threads` feature compiles the same `par_iter` shim to sequential iteration with the same
  fixed-order reductions, so output is bit-identical by construction.

### 2.2 `enum Command`, complete for phases 1–3

Conventions: `#[serde(tag = "cmd")]`, every variant `#[serde(rename = "ns.verb")]`, camelCase
fields (`#[serde(rename_all = "camelCase")]` on each struct variant), every variant has a doc
comment of 2–4 sentences (it is the tool description: what, when, effect on names/Sets, common
mistake). Names are unique per kind (`body`, `material`, `set`, `constraint`, `load`, `step`);
re-issuing a create Command with an existing name is an edit (§2.1). All physical values are `Q<D>`.
`?` marks an `Option<T>` field (schemars leaves it out of `required`; no attribute needed).

| Command | Fields (schema) | Doc string (abridged; write the full 2–4 sentences in code) | Journaled | Phase |
|---|---|---|---|---|
| `model.new` | `name: String`, `description?: String` | Start a new, empty Model and Journal. Discards the current Model, its Results and undo history; the first entry of every Journal. | yes (entry 0) | 0 |
| `model.setUnits` | `units: UnitSet` (`length?, force?, stress?, mass?, density?, time?, temperature?, acceleration?`, each a unit symbol) | Choose display units for Queries and the UI. Storage is SI regardless; inputs may use any unit. | yes | 0 |
| `model.rename` | `kind: ObjectKind`, `name`, `to` | Rename a Body, Material, Set, Constraint, Load or Step and every reference to it (a Body rename renames its auto faces `<name>.xmin…`). Fails with `NameTaken` if `to` exists in that kind. | yes | 1 |
| `model.duplicate` | `kind: ObjectKind`, `name`, `as` | Copy an object under a new name (a Body copy shares nothing; a Step copy references the same constraints and loads). The model tree's "duplicate" item. | yes | 1 |
| `step.reorder` | `order: Vec<String>` | Set the run order of Steps (a permutation of every Step name; anything else is `Schema`). Steps may inherit state from the previous one. | yes | 1 |
| `geometry.addBox` | `name`, `size: [Q<Length>;3]`, `at?: [Q<Length>;3]` (min corner, default origin) | Add an axis-aligned box Body (stored as C's `Shape::Box`). Auto-names faces `<name>.xmin … <name>.zmax`. Overlapping boxes merge into one connected Body region when meshed. | yes | 1 |
| `geometry.subtractBox` | `name`, `size`, `at` | Cut an axis-aligned box out of the existing geometry (hole, notch, opening). Cut faces are auto-named `<name>.xmin …` and refer to the walls of the hole. | yes | 1 |
| `geometry.nameFace` | `name`, `of: String` (body), `where: FacePredicate` | Name a face Set by a geometric predicate so constraints and loads can target it; predicates survive remeshing. Prefer auto-names when they exist. | yes | 1 |
| `geometry.nameRegion` | `name`, `where: RegionPredicate` | Name a node/element Set by a region predicate (bbox or whole body), for point-like constraints, nodal forces and probes. | yes | 1 |
| `geometry.remove` | `name` | Remove a Body, cut or named Set. Fails with `InUse` listing the constraints/loads that reference it. | yes | 1 |
| `material.add` | `name`, `E: Q<Stress>`, `nu: f64` (0 ≤ ν < 0.5), `rho?: Q<Density>`, `alpha?: Q<ThermalExpansion>`, `k?: Q<Conductivity>`, `cp?: Q<SpecificHeat>`, `yield?: Q<Stress>`, `source?: String` | Define an isotropic linear-elastic Material. `rho` is required for gravity and modal, `alpha` for thermal loads; `source` records where the numbers came from. | yes | 1 |
| `material.assign` | `material`, `bodies: Vec<String>` | Assign a Material to Bodies. A Body without a Material makes the Model ill-posed. | yes | 1 |
| `material.remove` | `name` | Remove an unassigned Material. | yes | 1 |
| `mesh.set` | `mesher: Mesher` (`"lattice"`; C adds `mapped`, `free2d`, `extrude`, `revolve`), `size: LatticeSize` (`Q<Length>` or `{nx,ny,nz}`), `order?: 1\|2` (default 1), `formulation?: Formulation` (`incompatible-modes` default, `full`) | Choose the Mesher and its settings; the Mesh is rebuilt lazily. The Mesher picks the element kind (lattice → hex8/hex20). `formulation: "full"` is the fully integrated linear hex that locks in bending; keep the default or use `order: 2` when bending matters (the J4.3 warning names this). | yes | 1 |
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
| `solve.run` | `step`, `solver?: Solver` (`auto\|cpu-direct\|cpu-pcg\|gpu-pcg` = A's `SolverChoice`), `tolerance?: f64` (→ A's `rel_tol`), `maxIterations?: u32` (→ A's `max_inner`) | Run a Step. Checks well-posedness first and refuses with a fix. Returns extremes and reactions; check that reactions balance the applied load. | yes | 1 |
| `study.converge` | `step`, `sizes: Vec<Q<Length>>`, `quantity: QuantityOfInterest`, `restore?: bool` (default true) | Re-mesh and re-solve at each size, report the quantity, the observed convergence rate and a Richardson estimate. Restores the previous mesh settings unless told otherwise. | yes | 3 (3.6) |
| `journal.undo` | `steps?: u32` | Undo the last Command(s). Not recorded in the Journal. | no | 0 |
| `journal.redo` | `steps?: u32` | | no | 0 |
| `plugin.load` | `name`, `kind: PluginKind`, `language: PluginLanguage`, `source: PluginSource` (`{inline: code}` or `{url, sha256}`), `manifest: serde_json::Value` | Load a Plugin filling one Extension Point; recorded by content hash. **Stub**: returns `Unsupported` until phase P. `x-status: stub`. | yes (when real) | P |

Plan C's geometry Commands (`geometry.add { shape }`, `subtract`, `union`, `transform`,
`nameEdge`, `sketch.add`) and the extra `mesh.set` meshers are added to the enum by C's commits
6–12; they are not stubbed now (a stub that always errors is noise in the AI's tool list;
`plugin.load` is stubbed only because the task and PLAN name it). Because the Model already stores
`Shape`, adding them touches `command.rs`, `apply` and the schema snapshot only.

Host-side Commands (TypeScript, §4.3) complete the registry; the full list with schemas is the
table in §4.3.

### 2.3 `enum Query`, complete for phases 1–3

`#[serde(tag = "query")]`, variants renamed `query.*`. Queries never mutate the Model; `query.mesh`
may build the lazy Mesh. Every response is a `#[derive(Serialize, JsonSchema)]` struct in
`query.rs`; `enum QueryResult` is `#[serde(untagged)]` over them. An untagged union cannot tell
the codegen which response belongs to which Query, so every variant carries
`#[schemars(extend("x-returns" = "<ResponseStruct>"))]` (verified to pass through) and
`tools/codegen.mjs` uses it to type `fem.query.model(): Promise<ModelSummary>`; a test in
`schema_is_current.rs` asserts every Query variant has `x-returns` naming a `$defs` entry. Values
are returned in the Model's display units with their unit symbols (`{ value, unit }`), so the UI
never converts (ADR 0008 literally: units at the boundary).

| Query | Fields | Returns | Purpose |
|---|---|---|---|
| `query.model` | – | `ModelSummary { name, revision, hash, units, bodies: [{name, material?, bbox, volume, mass?}], materials: [MaterialRow], sets: [{name, kind, resolved?: count}], constraints: [ConstraintRow], loads: [LoadRow{…, total: [F;3]}], steps: [StepRow], meshSettings?, warnings: [Warning] }` | The AI's and the model tree's single read of everything; `warnings` are the J6.11 well-posedness checks and unset defaults ("assumption log", PLAN 4.9) |
| `query.mesh` | – | `MeshSummary { nodes, elements, elementType, dofs, bbox, minEdge, maxEdge, sets: [{name, kind, count}], quality?: QualitySummary }` | counts and sanity before solving; `quality` filled in phase 3.5 |
| `query.set` | `name` | `SetInfo { name, kind: node\|element\|face, count, bbox, measure: {area\|volume}, centroid }` | verify a predicate resolved to what was meant |
| `query.result` | `step?` (default last solved) | `ResultSummary { step, revision, stale, solver: {name, iterations?, residual?, timeMs}, fields, extremes: {field: {min: {value, at, node}, max}}, reactions: [{constraint, total: [F;3]}], appliedTotal: [F;3], balance: f64 }` | observe without pixels (ADR 0006); reaction balance is the first thing to check |
| `query.probe` | `step?`, `field: Field`, `component?: u8`, `at: [Q<Length>;3]` | `ProbeResult { value, unit, element, nearestNode, interpolated: bool }` | value at a point |
| `query.path` | `step?`, `field`, `component?`, `from: [Q;3]`, `to: [Q;3]`, `n: u32` | `PathResult { s: [..], values: [..], unit }` | line plots |
| `query.cost` | `step` | `CostEstimate { dofs, nnzLower, nnz, bytes, budgetBytes, feasible, note }` | J4.7; bounded counting (#122), `bytes` is an assembly lower bound; `feasible` is false above the planning budget, otherwise null; no host-memory guarantee |
| `query.exportFormats` | – | `[ExportFormat { format, extension, mime, description, needs: ["mesh"\|"result"\|"geometry"\|"view"], available: bool, reason?: String }]` | the Export menu enumerates this (§7.10); `available` says whether the current Model can produce it (no mesh → no VTU) |
| `query.export` | `spec: ExportSpec` (§7.10) | `ExportInfo { filename, mime, bytes: u64 }` (metadata only; the bytes cross as a typed array via the transport's `export` op) | "each export names the format, what it contains and its size before writing" (DESIGN-BRIEF §4.12) |
| `query.objects` | `kinds?: Vec<ObjectKind>` | `[ObjectRef { ref: "body:beam", kind, name, summary: String }]` | the `@`-mention picker's index (§7.7); one call, every nameable thing in the Model plus Journal entries (`journal:12`) and Results (`result:static`) |
| `query.journal` | `fromSeq?: u32` | `JournalDump { entries: [{seq, cmd: Command, hashAfter}], revision, canUndo, canRedo }` | the Journal panel; the AI's "show me what you did" diff |
| `query.script` | `language?: "ts"` | `ScriptText { text }` | live TypeScript export of the Journal (§2.8) |
| `query.convert` | `quantity: Quantity`, `to: String` | `Converted { value, unit }` or `UnitDimension` error | unit help for UI live-validation and the AI |
| `query.capabilities` | – | `Capabilities { gpu: bool, adapter?: String, threads, engineVersion, schemaVersion }` | feature notes in the status bar; the host merges browser facts and `engine: local \| remote` (§4.3, §7.11) |

Bulk data (mesh surface, fields, export bytes) is not JSON. It crosses as typed arrays through the
wasm surface (§5.1); the CLI writes it to files (`femlab export`, §6).

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
#[derive(..)] #[serde(rename_all = "lowercase")] pub enum Mesher { Lattice }          // C adds Mapped, Free2d, Extrude, Revolve
#[derive(..)] #[serde(untagged)] pub enum LatticeSize { Size(Q<Length>), Counts { nx: u32, ny: u32, nz: u32 } }
pub use femlab_geometry::mesh::ElementKind;                                             // A's 8 kinds; reported by query.mesh, never chosen directly
#[derive(..)] #[serde(rename_all = "kebab-case")] pub enum Formulation { IncompatibleModes, Full }   // A's enum, re-exported
#[derive(..)] #[serde(rename_all = "lowercase")] pub enum ObjectKind { Body, Material, Set, Constraint, Load, Step }
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
/// Serialised as A's dotted, namespaced strings (`#[serde(rename = "mesh.inverted")]` per variant);
/// the enum keeps TS a closed union and the UI a switch. Plan A adds variants as it needs them.
#[derive(..)]
pub enum ErrorCode {
    // registry / boundary (plan B)
    Schema, UnitDimension, UnitUnknown, NameTaken, NotFound, InUse, SetEmpty, Unsupported, Cancelled, Internal,
    FileScope /* path outside the project folder */, FileNotFound, ExportUnavailable,
    // numerics (plan A §3–§7, same spelling)
    MaterialProps, MeshInverted, ModelNoMaterial, ConstraintConflict, ConstraintRigidModes,
    SolveNotPositiveDefinite, SolveStalled, GpuShader, GpuTooLarge, ExplicitUnstable,
}
#[derive(..)] pub struct Warning { pub code: String, pub text: String, pub where_: Option<String> }   // = plan A's `Diagnostic`
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
pub enum Output { None, Replaced { kind: ObjectKind, name: String }, Solve { summary: ResultSummary }, Study { report: StudyReport }, Undo { steps: u32, revision: u32, hash: String } }
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

- **Undo** pops a `Model` from `self.undo`, pops the last `JournalEntry` (its Command goes on
  `redo`), and drops Results whose model hash is no longer the current one (they show `stale`;
  ADR 0003 "orphans"). **Redo** re-dispatches the popped Command through `apply` (so a redone
  solve re-solves) without clearing the redo stack. Snapshots not inverses: `Model` is a few KB
  (no mesh, no results) and Blender's memfile experience says snapshots are the robust choice.
  `journal.undo/redo` are never entries; `query.journal` reports `canUndo/canRedo`.
- **Replay**: `Engine::replay(entries, skip_solves: bool)` = `model.new` semantics then
  `dispatch` each entry in order (which also rebuilds the undo stack); per-entry `hash_after` is
  recomputed and compared, and the first mismatch is reported with its `seq` (this is how the
  native-vs-wasm CI job localises a divergence). With `skip_solves`, `solve.run`/`study.converge`
  calculations are omitted while every entry retains its undo snapshot and recomputed hash.
  A `study.converge` with `restore: false` still applies its final mesh settings, so skipping
  numerical work preserves the same Model and Journal as normal replay (#145).
- **Script export** (`Journal::as_script`, exposed as `query.script`): one line per entry,
  `await fem.geometry.addBox({ name: "beam", size: ["1 m", "100 mm", "100 mm"] });` with the `cmd`
  key removed. The formatter walks the `serde_json::Value` (never a regex over text, which a string
  value containing `":` would break), quoting keys only when they are not identifiers — ~25 lines.
  Header comment names the engine version and schema hash. `journal.undo/redo` never appear. This
  is the text the Journal panel shows live and what `script.run` accepts back; every line is valid
  TypeScript against `fem.d.ts`, which the round-trip test in commit 5 asserts by parsing each
  line's object back into `Command`.
- **Large payloads never go inline.** A Command that carries data (C's `mesh.import { data }`,
  `plugin.load { inline }`) makes the Journal and every undo snapshot heavy. Rule: the Journal
  entry stores `{ sha256, bytes }` and the host stores the blob next to the ModelFile (project
  folder or a `blobs` array in the file); `import_file` refuses a missing blob by hash. Applies to
  C's `mesh.import` the day it lands. **ask C**.
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
   "ack": .., "error": .., "queryResult": .., "modelFile": .., "exportSpec": .. }` as one JSON document.
   `--from <engine.schema.json>` skips the cargo step and reads the file (the `web` CI job has no
   Rust toolchain and takes the file from the `wasm-hash` artifact).
2. Write it to `packages/registry/src/generated/engine.schema.json` (pretty, sorted keys).
3. `compile(schema, 'Engine', { additionalProperties: false, bannerComment: '/* generated by tools/codegen.mjs — do not edit */', strictIndexSignatures: true })`
   → `packages/registry/src/generated/engine.ts` exporting `Command`, `Query`, `Ack`, `Error`,
   `QueryResult`, `ModelFile`, and every response type.
4. Emit `packages/registry/src/generated/fem.d.ts`: for each `oneOf` variant, `namespace.verb(args: Omit<Variant, 'cmd'>): Promise<Ack>`
   for Commands and `(args): Promise<ResponseType>` for Queries (the response type is the
   variant's `x-returns`), grouped by namespace into
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
The engine provider is the transport; the host provider is a table of zod-validated functions
over a `HostContext` interface (`{ store, viewer?, project?, clipboard, chat }`) that the app
implements and tests fake. `Registry` has no DOM imports (it is in `packages/registry`, tested in
Node). Host Commands are never sent to the engine, so by type they cannot enter the Journal; a
registry test dispatches every host Command against a fake transport and asserts the transport saw
no `dispatch` call and `query.journal.revision` is unchanged (plan C §6 #10 made into a test).

### 4.2 Transport

```ts
// src/transport.ts
export interface EngineTransport {
  dispatch(cmd: Command, onProgress?: (p: Progress) => void): Promise<Ack>;   // rejects with Error (structured)
  query(q: Query): Promise<QueryResult>;
  surface(): Promise<Surface>;             // { positions: Float32Array, indices: Uint32Array, triBody: Uint32Array, triFace: Uint32Array, faceNames: string[], bodyNames: string[] }
  field(step: string, field: Field, component?: number): Promise<{ values: Float32Array; min: number; max: number; unit: string }>;
  export(spec: ExportSpec): Promise<{ filename: string; mime: string; bytes: Uint8Array }>;   // §7.10
  exportFile(): Promise<ModelFile>;
  importFile(f: ModelFile): Promise<Ack>;
  cancel(): Promise<void>;                 // browser: terminate + recreate + replay(skipSolves) (§5.1); remote: server kills the solve task
  capabilities(): Promise<Capabilities>;
}
// Wire protocol shared by WorkerTransport now and WebSocketTransport (femlab serve) later:
export type Op = 'dispatch' | 'query' | 'surface' | 'field' | 'export' | 'exportFile' | 'importFile' | 'cancel' | 'capabilities';
export type Req = { id: number; op: Op; payload: unknown };
export type Res =
  | { id: number; ok: true; value: unknown; buffers?: { name: string; dtype: 'f32' | 'u32' | 'u8'; length: number }[] }  // header
  | { id: number; ok: false; error: Error }
  | { id: number; progress: Progress };
```

Bulk replies are a JSON header (`buffers` lists name, dtype and length) followed by the raw
buffers in that order: the Worker sends them as `postMessage` transferables, a WebSocket sends
one binary frame per buffer after the header frame. `decodeBulk(header, buffers)` in
`transport.ts` is the one function both transports share, and its test feeds it a fake
header + buffers. The transport also serialises: at most one `dispatch`/`query` in flight
(a queue in `transport.ts`, tested), so the wasm single-borrow rule (R11) is enforced on the
calling side too and a remote server sees the same ordering. `femlab serve` is therefore a
transport swap (AGENTS.md "hosts are swappable"); nothing above the transport knows where the
engine runs, and `query.capabilities.engine: 'local' | 'remote'` is the brief's §9.6 indicator.

### 4.3 Host Commands (zod 4, `src/host-commands.ts`)

Every control in DESIGN-BRIEF §5–§7 maps to exactly one row here or in §2.2; the table is the
contract the designer designs against, not a layout. Each row has a 2–4 sentence doc string in
code (same rule as engine Commands). `n` = number, `PanelId` = the `id` column of `PANELS` (§7.3).

| Command | Schema | Effect / notes | Tool |
|---|---|---|---|
| `view.fit` | `{}` | frame the mesh (or the selection when one exists) | yes |
| `view.setCamera` | `{ position: [n,n,n], target: [n,n,n], up?: [n,n,n] }` | metres, viewer space | yes |
| `view.preset` | `{ view: 'iso'\|'front'\|'back'\|'left'\|'right'\|'top'\|'bottom' }` | the view-preset buttons and keys; implemented as `setCamera` on the mesh bbox | yes |
| `view.setProjection` | `{ projection: 'perspective'\|'orthographic' }` | | yes |
| `view.showField` | `{ field: Field, component?: int, step?: string } \| { field: null }` | contour on/off | yes |
| `view.setLegend` | `{ colormap?: 'viridis'\|'rainbow', bands?: int \| null, range?: [n, n] \| 'auto' }` | legend appearance and clamp; brief §6 | yes |
| `view.setDeformScale` | `{ scale: n \| 'auto' \| 'true' }` | deformed shape; `'true'` = 1 | yes |
| `view.setClip` | `{ normal: [n,n,n], offset: n } \| null` | section cut (three `clippingPlanes`) | yes |
| `view.toggle` | `{ layer: 'mesh'\|'edges'\|'loads'\|'constraints'\|'sets'\|'legend'\|'axes'\|'grid', on?: boolean }` | glyph and overlay layers | yes |
| `view.setVisible` | `{ bodies: string[], on: boolean }` | the tree's visibility eye | yes |
| `view.setTheme` | `{ theme: 'dark'\|'light' }` | persisted in localStorage | yes |
| `view.animate` | `{ step: string, mode?: int, playing: boolean, speed?: n, frame?: int }` | mode shapes / transient (phase 2; row exists so the design has a Command to point at) | yes |
| `selection.set` | `{ bodies?: string[], faces?: string[], sets?: string[], mode?: 'replace'\|'add'\|'remove' }` | names, never ids (ADR 0003); `mode` is the shift-click | yes |
| `selection.clear` | `{}` | | yes |
| `selection.setPickTarget` | `{ target: 'face'\|'body'\|'off' }` | the Properties form's "pick in viewer" arms the next click | yes |
| `panel.toggle` | `{ panel: PanelId, open?: boolean }` | includes `palette` (⌘K), `examples`, `report`, `project`, `export` | yes |
| `script.run` | `{ code: string, timeoutMs?: n }` | run TS in the script Worker; returns `{ result, console, error? }` | yes (as `run_script`) |
| `script.stop` | `{}` | terminate the running script Worker | yes |
| `script.setSource` | `{ code: string, append?: boolean }` | put text in the Script editor ("insert from Journal", the AI handing over a script to edit) | yes |
| `chat.send` | `{ text: string }` | send a chat turn; `text` may contain `@kind:name` chips and a leading `/skill` (§7.7, §7.8) | no |
| `chat.insertMention` | `{ ref: string }` | insert a chip into the chat input (click-with-chat-focused, paste, drag) | no |
| `chat.clear` | `{}` | new conversation | no |
| `skill.invoke` | `{ name: string, args?: string }` | returns the skill body; the person's `/name`, and the AI's self-invocation tool (§7.8) | yes |
| `clipboard.copy` | `{ what: { kind: 'selection' } \| { kind: 'mention', ref } \| { kind: 'script', seqs?: int[] } \| { kind: 'text', text } }` | one Command for every copy affordance: ⌘C on a selection writes `@face:beam.top` (§7.7); "copy as script" writes `query.script` lines | yes |
| `file.open` | `{ json: string } \| { picker: true } \| { path: string }` | host I/O then `transport.importFile`; `path` is relative to the open project folder | yes (json, path) |
| `file.save` | `{ name?: string, to?: 'download'\|'project' }` | `exportFile` → download, or write into the project folder (default when one is open) | yes |
| `file.export` | `{ spec: ExportSpec, name?: string, to?: 'download'\|'project' }` | one Export Command for every format (§7.10); the Export menu is `query.exportFormats` | yes |
| `file.shareLink` | `{}` → `{ url }` | Journal deflated (`CompressionStream('deflate-raw')`, base64url) into the URL fragment; phase 5.8, listed so the brief's Share button has a Command | yes |
| `file.read` | `{ path: string }` → `{ text }` | scoped to the project folder (§7.9); text files ≤ 2 MB | yes |
| `file.write` | `{ path: string, text: string }` | scoped to the project folder; creates directories | yes |
| `project.open` | `{ picker: true } \| { handle: FileSystemDirectoryHandle }` | `showDirectoryPicker({ mode: 'readwrite' })`; `handle` is for tests and reopen (§7.9) | no |
| `project.close` | `{}` | | yes |
| `project.refresh` | `{}` | re-list files, re-read `AGENTS.md`/`CLAUDE.md` and `skills/*/SKILL.md` | yes |
| `example.open` | `{ name: string }` | fetch `examples/<name>.json` → `importFile` | yes |
| `solve.cancel` | `{}` | `transport.cancel()` | yes |
| `ai.setKey` | `{ key: string \| null }` | localStorage (ADR 0016); never journaled, never a tool, never in exports | no |
| `ai.setModel` | `{ model: string }` | model id for the agent (default `claude-opus-5`) | no |

Host Queries (same file, same zod treatment, all `tool: true` unless noted): `query.screenshot
{ width?, height?, legend?, title? }` → `{ png: base64 }`; `query.view` → camera state;
`query.capabilities` merges the engine's with `{ webgpu, crossOriginIsolated, threads, userAgent,
engine: 'local' | 'remote' }`; `query.selection` → `{ bodies, faces, sets, refs: string[] }` (what
`@selection` expands to); `query.skills` → `[{ name, description, when, source: 'builtin' | 'project' }]`;
`query.project` → `{ name, files: [{ path, size, kind }], agentsMd: 'AGENTS.md' | 'CLAUDE.md' | null,
skills: string[] } | null`. `query.objects` is an engine Query (§2.3); the host appends
`file:<path>` refs from `query.project` in the mention picker.

The UI store is `UiState` (view, selection, panels, solve progress, chat, project, last
summaries); host Commands are plain reducers `(state, input) => UiState` behind one `subscribe`
(no immer: nothing needs patches). UI Commands push no undo step (Blender: "UI changes are not
stored"); `journal.undo` is Model-only. `query.script({ includeView: true })` appends the current
`view.setCamera`/`view.showField`/`view.setDeformScale`/`view.setClip` lines from the store so a
screenshot is reproducible; no ring buffer of patches (see §13 on dropped UI undo).

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

`run_script` is the only tool that is not a registry Command (it is `script.run` under the name
Anthropic's guidance and PLAN 4.2 use); `skill.invoke` is an ordinary Command and therefore an
ordinary tool, which is how the AI self-invokes a skill (§7.8). Tools use `Anthropic.Tool` from the
SDK, no local type. `strict: true` is not set: engine schemas carry `$defs`-inlined `oneOf`s, and
Rust validates anyway.

Property test (fast-check not needed; it is exhaustive): the tool names equal the registry's
`tool: true` names one-to-one plus `run_script`, `commandNameFor(toolNameFor(n)) === n`, every
`input_schema` has no `$ref`, every name matches `^[a-zA-Z0-9_-]{1,64}$`, and every description
is ≥ 80 chars. This is the "tool list == registry" gate.

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
    pub fn export_meta(&mut self, spec_json: String) -> Result<String, JsValue>;          // ExportInfo JSON; runs the exporter into a staging Vec<u8>
    pub fn export_bytes(&self) -> js_sys::Uint8Array;                                      // view over that staging Vec (same rules as field())
    pub fn export_file(&self) -> String;
    pub fn import_file(&mut self, json: String) -> Result<String, JsValue>;
    pub fn model_hash(&self) -> String;
    pub fn replay_hashes(&mut self, journal_json: String, skip_solves: bool) -> Result<String, JsValue>;  // for tools/replay-wasm.mjs and cancel recovery
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
- **GPU inside Rust.** `let mut d = InstanceDescriptor::new_without_display_handle(); d.backends = Backends::BROWSER_WEBGPU;`
  `wgpu::Instance::new(d)` (plan A's verified shape: by value, no `Default`), then
  `request_adapter(&RequestAdapterOptions { power_preference: HighPerformance, .. }).await?`,
  `request_device` with `required_limits: adapter.limits()` (ADR 0002) → plan A's `Gpu { device, queue }`.
  Failure → `gpu: None`, and `capabilities.gpu = false` with `adapter: None`; the UI shows the CPU
  note. The Host impl uses `js_sys::Date::now` and a `JsFuture` over `setTimeout(0)` for `yield_now`.
- **Async and `&mut self`.** Verified to compile; the worker keeps a promise chain so at most one
  `dispatch`/`query` is in flight (a concurrent call would panic inside wasm-bindgen's borrow check).
- **Cancel.** For CPU solves the wasm thread is busy and cannot observe a flag; `worker.terminate()`,
  recreate the worker, then `replay_hashes(journal, skip_solves = true)` from the transport's
  acknowledged Journal shadow, including any redo tail. Undo back to the acknowledged active
  revision after replay, preserving both undo and redo history. Undo/redo acknowledgements move
  the active revision without becoming Journal entries; exports use the same acknowledged
  dispatch path. Queued calls from the cancelled worker are rejected, and new calls wait for
  recovery ([#110](https://github.com/andeplane/fem-lab/issues/110), building on #145).
  Cancellation still discards every earlier step's Result (Results are not in the ModelFile;
  they show as "not solved"). For GPU solves the progress callback's `false` return is honoured at the next
  await. Both paths are one `transport.cancel()`. With plan A's `on_progress` in `SolveOptions`
  (Reconciled table) the CPU path also becomes cooperative at 25-iteration granularity and the
  terminate path stays as the fallback for a hung solve.
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
as commit 23 (§11) behind `continue-on-error` with `cargo +nightly-2026-08-01` (pin to the newest
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
buffers as transferables; `handle('export')` calls `export_meta` then `export_bytes().slice()` the
same way. Boot: `await init(wasmUrl)` where `wasmUrl` is `new URL('./generated/wasm/femlab_engine_wasm_bg.wasm', import.meta.url)`
(Vite hashes and serves it as `application/wasm`).

---

## 6. The CLI host (`crates/femlab`)

```
femlab run <file.json> [--hashes] [--skip-solves] [--verify] [--as-script] [--json] [--cpu] [--threads N]
    file.json is a ModelFile or a bare Journal array. Prints query.model (text or --json), or the per-entry
    hash list (--hashes), or the Journal as a TypeScript script (--as-script). --verify replays and compares
    hash_after per entry; exit 3 on the first mismatch with its seq.
femlab bench [--filter <substr>] [--json] [--markdown] [--cpu] [--threads N]
    Runs every case in crates/femlab/benches/cases/*.json: { name, journal: [...], checks: [{ query, path, expect, tol, rel }] }.
    Exit 1 if any check fails. --markdown prints the status table BENCHMARKS.md links to.
femlab export <file.json> --format vtu|msh|inp|stl|csv|script|journal|report [--step S] [--table T] --out <path>
    Replays (skip-solves unless --solve) and writes Engine::export(spec) to --out. The same exporters the app uses (§7.10);
    tests/export_fixtures.rs compares every format against committed reference files for the 2-hex fixture.
femlab schema [--out <path>] [--check]
    Prints the combined schema document (§3 step 1); --check compares to --out and exits 1 on diff.
femlab serve [--port 7777]
    Stub: prints "femlab serve is planned (phase S); the wire protocol is packages/registry/src/transport.ts" and exits 2.
femlab mcp [--project <dir>]
    Stub until phase 4.10; --project is where file.read/file.write will be scoped (same normalisePath rule as the browser, §7.9).
```

clap 4.6 derive; `pollster::block_on` around the async engine; native GPU via
`Instance::new(InstanceDescriptor::new_without_display_handle())` with `Backends::PRIMARY` +
`request_adapter`, `--cpu` forces `None`; Host impl uses `std::time::Instant` (allowed here: the
CLI is a host) and `yield_now` = ready future. Paths go through `std::path::Path` only and the
`--out` value is used as given, so Windows paths work (no string joins with `/`). `tests/` use
`assert_cmd` on the fixture journals; `tests/replay_fixtures.rs` iterates `benches/journals/*.json`
and asserts `--verify` passes and `--hashes` equals the committed `*.hashes` file next to each journal.

Native-vs-wasm hash comparison (CI job `wasm-hash`): for each fixture,
`femlab run <j> --hashes --skip-solves > native/<j>.txt` and
`node $REPO/tools/replay-wasm.mjs <j> > wasm/<j>.txt` (Node loads `tools/wasm-node`, `gpu: false`),
then `node tools/compare-hashes.mjs native wasm` (a 15-line line-by-line diff that prints the first
differing `seq`; Node rather than `diff -r` so the same command runs on a Windows laptop). Solves
are skipped in this job because the wasm build in Node has no GPU and because Results are not part
of the Model hash anyway; a second, later comparison of CPU-solve Results to 1e-12 is a Benchmark
in plan A.

---

## 7. The browser app (`packages/app`)

**Scope note.** The visual design comes from the designer working from `docs/DESIGN-BRIEF.md`,
before any panel component is built. This section is therefore about architecture, data flow and
Commands: what state exists, which Command every control dispatches, what the viewer and the AI
need from the registry. Panel placement words below ("left", "bottom tab") are the brief's
defaults for the phase-1 shell and carry no design weight; the components in `src/ui/*.tsx` are
written against the design when it comes back (§11 marks those commits).

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
- **sucrase** in the script Worker, **@anthropic-ai/sdk** in the AI panel, **zod 4** (via
  `@femlab/registry`) for host Commands, **@types/wicg-file-system-access** for the project folder.
  No immer (plain reducers), no router, no CSS framework (one `style.css`; the designer's tokens
  land as CSS variables).

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
  setLegend(l: { colormap; bands; range }): void; setProjection(p): void; setVisible(bodies, on): void;
  onPick(cb): void;
}
```

Picking never yields node ids to anyone. A pick shows a "Name this face" chip: if the picked
triangle's `autoFace` set is exactly what was picked, the suggested Command is
`geometry.nameFace { name, of: body, where: { kind: 'normal', normal } }` restricted to that body
(equivalently the auto-name is offered directly as `on: "<body>.<side>"`); otherwise the chip offers
`{ kind: 'plane', normal, offset }` from the picked point. Accepting dispatches the Command; the pick
itself is `selection.set { faces: [autoFaceName] }`, also a Command. When the chat input has focus
the same click dispatches `chat.insertMention { ref: 'face:<name>' }` instead (§7.7). Legend is an
HTML element with a CSS gradient and min/max in display units from `query.result`.

### 7.3 Panels and controls as data

> **Superseded in part by plan D** (`docs/plans/D-projects-and-start.md`, issues #40 and #41).
> The top bar's "model name + unsaved flag" is now the **project** name with a saved chip, and it
> gains **Projects** (`panel.toggle { panel: 'projects' }`), **Save** (`project.save`) and
> **Save as file** (`file.save`). The Assistant drawer is mounted outside `.workspace`, so it
> exists on the start screen. `file.restore` and `query.autosave` are deleted; Recent projects
> replaces them.

`src/panels.ts` declares `PANELS: { id, title, side, defaultOpen }[]` and
`CONTROLS: { id, label, cmd: string, args?: unknown, panel: PanelId, kind: 'button'|'toggle'|'form' }[]`.
Components render from these tables; every rendered control carries `data-cmd`. The vitest
`panels.test.ts` asserts: every `CONTROLS[i].cmd` is in `registry.list()`; every host Command is
reachable from at least one control or is listed in `SCRIPT_ONLY` with a reason (`ai.setKey` is
the only expected entry); every engine Command with `tool: true` has a form entry point (the
Properties panel's "Add…" menu is one control per engine Command, generated from the schema).
Playwright's smoke checks the DOM agrees (`[data-cmd]` set ⊆ registry).

| Panel (brief §) | Contents (data, not layout) | Commands it dispatches / Queries it reads |
|---|---|---|
| Top bar (5.1) | model name, unsaved flag, units, undo/redo, ⌘K palette, Solve with state (disabled + reason from `query.model.warnings`; stale from `query.result.stale`), Share, Save, Open, Export, Examples, Report, Settings, capability badges | `model.rename`, `model.setUnits`, `journal.undo/redo`, `panel.toggle { palette\|export\|examples\|report\|settings }`, `solve.run`, `solve.cancel`, `file.shareLink`, `file.save`, `file.open`, `project.open`; reads `query.model`, `query.result`, `query.capabilities` |
| Command palette (5.1, 9.8) | every registry Command with its doc string; parameters as a mini form; natural language → `chat.send` | `registry.list()`; dispatches the chosen Command |
| Model tree (5.2) | groups in workflow order; per item: name, one-line summary, warning badge, eye, context menu (rename, duplicate, delete, select in viewer, copy as script); steps drag-reorder | `selection.set`, `view.setVisible`, `model.rename`, `model.duplicate`, `geometry.remove`, `material.remove`, `constraint.remove`, `load.remove`, `step.remove`, `step.reorder`, `clipboard.copy { script }`; reads `query.model`, `query.mesh` |
| Properties (5.3) | schema-driven form for the selected item's Command (edit = re-issue, §2.1) or an "Add…" Command: string → input, number → number input with min/max from schema, enum → segmented/select, `Q_*` → text input with placeholder EXAMPLE and live `query.convert` validation, `[Q;3]` → three inputs, `Vec<enum>` → checkboxes, tagged enum (`FacePredicate`) → kind select + sub-form, `SetRef` → chip + "pick in viewer"; footer shows the Command as one script line | dispatches the chosen Command with the form's JSON; `selection.setPickTarget`; shows `Error.where/suggestion` inline |
| Viewer (6) | canvas, legend, pick chip, field picker, deform scale, clip, layer toggles, presets, projection, animation bar | `view.*`, `selection.*`, `geometry.nameFace`, `chat.insertMention` (when chat focused) |
| Journal (5.5) | entries with seq and hash prefix; click selects the object, undo boundary; live TypeScript from `query.script`; copy; download; "run as script" | `journal.undo/redo`, `selection.set`, `clipboard.copy { script }`, `file.export { script }`, `script.run`; reads `query.journal`, `query.script` |
| Script (5.5) | editor + Run + Stop + "insert from Journal"; output pane (console, return value, structured error) | `script.run`, `script.stop`, `script.setSource`; the Stop button is a host Command so it passes the enumeration test |
| Results (5.5) | solver info, extremes table with "go to" (sets camera), reactions vs applied with balance, probe form, path form, frequencies (phase 2), export | `view.setCamera`, `view.showField`, `file.export`; reads `query.result`, `query.probe`, `query.path` |
| Checks (5.5) | well-posedness list, mesh quality, cost estimate, assumption log | reads `query.model.warnings`, `query.mesh.quality`, `query.cost`; "fix" buttons dispatch the `Error.suggestion` Command |
| Console (5.5) | progress lines, warnings, errors with codes | registry `on('dispatched' \| 'failed' \| 'progress')` |
| Export dialog (4.12, 8b) | one row per `query.exportFormats` entry: name, what it contains, `available`/reason, size after `query.export`; destination download or project | `file.export`; reads `query.exportFormats`, `query.export` |
| Project panel (7, 8b) | folder name, file list, AGENTS.md badge with click-through, skills found, "open/close/refresh" | `project.open/close/refresh`, `file.open { path }`, `file.read`; reads `query.project` |
| Examples / Benchmarks gallery (5.7) | cards from `public/examples/index.json` with reference value, tolerance, theory snippet (KaTeX later) | `example.open` |
| Report view (5.8) | rendered Markdown from `file.export { report }` with the viewer PNGs; print | `file.export { report }`, `panel.toggle { report }` |
| AI chat (7; flag `?ai=1` until phase 4 eval passes) | key entry with the plain notice (ADR 0006), model id, chat with `@` picker and `/` menu, streamed tool-call cards (each also a Journal entry), "show me what you did" = `query.journal` diff since the turn's first seq with "undo this turn" = `journal.undo { steps }`, verification card, cost per turn from `usage`, AGENTS.md badge | everything, via `registry.dispatch`; `chat.*`, `skill.invoke`, `ai.setKey`, `ai.setModel`; reads `query.objects`, `query.selection`, `query.skills`, `query.project` |
| Start / empty state (5.9) | three paths and a capability line | `chat.send`, `panel.toggle { examples }`, the geometry "Add…" form; reads `query.capabilities` |
| Status bar (8) | progress from `dispatch` progress events, capability notes (no WebGPU → CPU; not isolated → single thread; not Chromium → best effort), engine local/remote, engine version | reads `query.capabilities` |

Editing existing objects (#141) uses `form.edit { kind, name }` and the engine's
`query.definition` to read an exact upsert Command from the current Model. Rounded
`query.model` summaries only label rows; they never supply editable values. Definitions
retain all shape, material, constraint, load and Step parameters after rename or duplicate.
Structured SI quantities display as round-trippable unit text; a delayed edit response
cannot replace a newer form. Imported internal-only shapes are refused explicitly.

Hover highlighting (tree ↔ viewer) is transient view state with no control and no Command; the
brief's "hover is view state" sentence covers it. Everything a click does is a row above.

### 7.4 Boot (`src/main.tsx`)

1. Read `navigator.gpu`, `crossOriginIsolated`, `typeof SharedArrayBuffer`, `navigator.userAgent` → `hostCaps`.
2. `const transport = new WorkerTransport(new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' }))`;
   `await transport.init({ gpu: !!navigator.gpu, threads: hostCaps.isolated ? navigator.hardwareConcurrency : 1 })`.
3. `const ctx: HostContext = { store, viewer: lazy, project: null, clipboard, chat }`;
   `const registry = new Registry(transport, hostCommands(ctx), hostQueries(ctx))`.
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

### 7.6 AI agent (`src/ai/agent.ts`, `src/ai/context.ts`)

`new Anthropic({ apiKey, dangerouslyAllowBrowser: true })`; `tools = registry.toToolDefinitions()`
(typed `Anthropic.Tool[]`); model from `ai.setModel` (default `claude-opus-5`); a ~80-line loop:
`client.messages.stream({ model, max_tokens: 16000, thinking: { type: 'adaptive' }, system, tools, messages })`,
render text deltas, `await stream.finalMessage()`, on `stop_reason === 'tool_use'` run **every**
`tool_use` block (`registry.dispatch/query`, `script.run` for `run_script`), append **one** user
message holding all `tool_result` blocks (structured `Error` JSON with `is_error: true` on
failure so the model can fix its call), repeat until `end_turn`; on `stop_reason === 'refusal'`
show `stop_details`. `messages` are `Anthropic.MessageParam[]`; the transcript is kept in the
store (not persisted). Per turn the panel records `usage` (input/output/cache tokens) and shows
the cost from a small price table keyed by model id. The turn's first Journal `seq` is remembered
so "show me what you did" is `query.journal { fromSeq }` and "undo this turn" is
`journal.undo { steps: revisionNow - revisionThen }`.

**System prompt** (`context.ts`, `buildSystem(ctx)`, generated, never hand-edited; a test snapshots
it for a fixture context): in this order, each block stable so prompt caching hits —
1. the app rules: units (write unit strings, read `{ value, unit }`), the verification habit (after
   a solve check reactions and compare with a hand estimate; PLAN 4.5), "prefer `run_script` for
   more than three Commands", "targets are names, never node ids";
2. the generated API reference: `fem.d.ts` text (§3 step 4);
3. the skills index: one line per skill from `query.skills` (`/name — description — when`), with
   the instruction that the AI may call `skill.invoke` itself when a skill's `when` applies;
4. the project block, only when a project folder is open: `<project name="…">` with the file list
   and the full text of `AGENTS.md` (or `CLAUDE.md` if only that exists), framed as standing
   instructions for this project; the badge state in the store is derived from the same value.
`cache_control: { type: 'ephemeral' }` sits on the last system block; blocks 1–2 change only on
deploy, 3–4 on `project.refresh`.

**User message assembly** (`chat.send { text }`): `parseMentions(text)` (§7.7) yields the plain
text with chips left as `@kind:name` tokens plus a list of refs; `@selection` is expanded from
`query.selection.refs` at send time; every ref is resolved (§7.7) and the summaries are appended
as one `<context>` JSON block after the text. A leading `/name` (§7.8) is replaced by the skill
body as a preceding block. Nothing about the message layout is visual; the designer decides how
chips look.

Keys in `localStorage['femlab.ai.key']` and `localStorage['femlab.ai.key.openai']` (ADR 0016), never in the store snapshot, Journal, export or
screenshot. Phase 4's eval suite decides when the `?ai=1` flag is removed.

Tests (vitest, no network): the loop against a fake `Anthropic` client that replays a scripted
stream (text → two parallel `tool_use` → `end_turn`) asserts both tools ran, the single
`tool_result` message, the Journal diff, and that a thrown structured `Error` becomes
`is_error: true`; `buildSystem` snapshot with and without a project; cost table covers every id the
settings offer.

### 7.7 `@`-mentions (`packages/registry/src/mentions.ts`, `src/ai/context.ts`)

Data: a **ref** is the string `<kind>:<name>` with `kind ∈ MENTION_KINDS = body | face | set |
material | constraint | load | step | result | journal | file` (`face` is a Set of kind face; kept
as its own word because that is what people say). `journal:<seq>` and `result:<step>` follow the
same shape. `@selection` is the one live pseudo-ref.

```ts
export type Chip = { ref: string; kind: MentionKind; name: string };
export function parseMentions(text: string): { text: string; chips: Chip[]; selection: boolean };
   // tokens: /@(kind):([^\s,;)]+)/ and /@selection\b/; a bare "@name" (no kind) is left as text — the picker always inserts the kinded form
export function refOf(kind: MentionKind, name: string): string;     // "face:beam.top"
```

Resolution (`resolveMention(ref, registry)` in `context.ts`, one `switch` on kind): `body`,
`material`, `constraint`, `load`, `step` → the matching row of `query.model`; `face`/`set` →
`query.set { name }`; `result` → `query.result { step }`; `journal` → the entry from
`query.journal { fromSeq: seq }`; `file` → `file.read { path }` (first 4 KB); unknown →
`Error { code: NotFound, suggestion: nearest names from query.objects }`, shown inline and
never sent. The picker's index is `query.objects` (engine) ∪ `file:` refs from `query.project`,
filtered client-side as the user types.

Three more ways to point, each a Command from §4.3: a viewer/tree click while the chat input is
focused → `chat.insertMention { ref }` (the click handler checks `document.activeElement`);
⌘C with a selection and no text selected → `clipboard.copy { what: { kind: 'selection' } }`
writes `@face:beam.top @body:beam` as plain text (`navigator.clipboard.writeText`, inside the key
handler so the user-gesture requirement holds), and the chat input's paste handler runs
`parseMentions` on `text/plain` and inserts chips (so the same text pastes into any other field
as text); drag from tree/viewer sets `text/plain` to the ref and the drop handler does the same.

Tests: `parseMentions` table (kinded, multiple, `@selection`, bare `@x` untouched, punctuation
after a chip); `resolveMention` for every kind against a fixture Model through a fake registry;
unknown ref → `NotFound` with suggestions; round trip `refOf → parseMentions`. Playwright:
click a face with the chat focused → chip present; `clipboard.copy` then paste event → chip.

### 7.8 Skills (`packages/registry/src/skills.ts`, `packages/app/skills/`)

```ts
export type Skill = { name: string; description: string; when?: string; body: string; source: 'builtin' | 'project' };
export function parseSkill(markdown: string, source): Skill;   // frontmatter between the first two "---" lines: `key: value` per line (name, description, when); rest is body; missing name → Error(Schema, where: 'frontmatter.name')
export function mergeSkills(builtin: Skill[], project: Skill[]): Skill[];  // project overrides builtin of the same name; sorted by name
```

Built-ins live in `packages/app/skills/<name>/SKILL.md` and are bundled with
`import.meta.glob('../skills/*/SKILL.md', { query: '?raw', eager: true })`; the four from PLAN
4.12: `beam-theory-check`, `convergence-study`, `write-report`, `nafems-benchmark`. Project skills
are every `skills/*/SKILL.md` under the open project folder, read on `project.open/refresh`.
`query.skills` lists the merged set; the `/` menu in the chat is that list filtered by prefix.

Invocation is one Command, `skill.invoke { name, args? }`, which returns
`{ name, body, source }`. The chat's `/name rest of line` calls it and prepends the body (as a
block "Skill <name>:") to the user turn with `args = rest of line`. The AI calls the same
Command as a tool; the `tool_result` is the body, so the instructions enter its context at the
point it asked for them, and the card in the chat shows "used skill <name>". No hidden prompt
surgery: the system prompt only carries the index (§7.6).

Tests: `parseSkill` on the four built-ins and on a malformed one; `mergeSkills` override; every
built-in has `name`, `description` ≥ 40 chars and a body; `query.skills` == merged list;
`skill.invoke` unknown → `NotFound` listing names; a Playwright step types `/beam` and asserts
the menu shows the built-in.

### 7.9 Project folder (`src/ai/project.ts`, `packages/registry/src/project-paths.ts`)

> **Renamed by plan D.** A *project* is now one saved Model in this browser (issue #41), so the
> disk-side Commands here are `folder.open | folder.close | folder.refresh` and the Query is
> `query.folder`; `HostContext.project` is `HostContext.folder` and `ProjectInfo` is `FolderInfo`.
> The handle store is `src/db.ts`'s `handles` object store — one module owns the `femlab`
> database, which is what fixes the two-modules-at-version-1 collision described there. Read the
> Commands below as `folder.*`.

Chromium's File System Access API (ADR 0014; `showDirectoryPicker` needs a user gesture and is
Window-only, so `project.open { picker: true }` runs on the main thread from a click). The handle
is stored in IndexedDB (`FileSystemDirectoryHandle` is structured-cloneable) under one key so a
reload can offer "reopen <name>", which calls `handle.requestPermission({ mode: 'readwrite' })`
from a click and then `project.open { handle }`.

```ts
export class ProjectFolder {
  static async fromHandle(h: FileSystemDirectoryHandle): Promise<ProjectFolder>;   // lists files (depth ≤ 4, skips node_modules/.git), reads AGENTS.md|CLAUDE.md and skills/*/SKILL.md
  readonly name: string; readonly files: { path: string; size: number; kind: 'journal'|'script'|'skill'|'agents'|'export'|'other' }[];
  readonly agentsMd: { file: 'AGENTS.md' | 'CLAUDE.md'; text: string } | null;
  readonly skills: Skill[];
  readText(path: string): Promise<string>;                 // normalisePath + walk handles; FileNotFound
  writeText(path: string, text: string): Promise<void>;    // createWritable; creates directories
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
}
// registry/src/project-paths.ts (pure, tested exhaustively)
export function normalisePath(p: string): string[];   // split on / or \, drop '' and '.', reject '..' or a leading '/' / drive letter with Error(FileScope), reject segments with ':' or control chars
```

Scoping is structural: every read and write walks from the stored directory handle segment by
segment, so nothing outside the folder is reachable even without the path check; the check exists
to give a clean `FileScope` error instead of a browser exception. `file.read`/`file.write`/
`file.open { path }`/`file.save { to: 'project' }`/`file.export { to: 'project' }` all go through
`ProjectFolder`. `AGENTS.md` text feeds `buildSystem` (§7.6) and the badge; the AI gets the same
`file.read` the person has (PLAN 4.13 "scoped").

Tests: `normalisePath` table (`a/b.md`, `./a`, `a\\b` on either OS, `../x` → FileScope, `/etc` →
FileScope, `C:\\x` → FileScope); `ProjectFolder` against a 40-line fake `FileSystemDirectoryHandle`
(in-memory map) for list/read/write/AGENTS.md/skills; `buildSystem` includes the AGENTS.md text
exactly once. Playwright cannot drive `showDirectoryPicker`, so the e2e test uses
`navigator.storage.getDirectory()` (OPFS returns a real `FileSystemDirectoryHandle`), writes
`AGENTS.md` and `skills/x/SKILL.md` into it, dispatches `project.open { handle }` via `window.fem`,
and asserts `query.project`, `query.skills` and the badge state. The Node/MCP host implements the
same class over `node:fs` under `--project` with the same `normalisePath`.

### 7.10 Export (`crates/engine/src/export.rs`, `report.rs`; `src/export/image.ts`)

One Command (`file.export { spec, name?, to? }`), one engine Query (`query.export { spec }`), one
enumeration Query (`query.exportFormats`). `ExportSpec` is a tagged enum so each format keeps its
own fields and the schema still drives the dialog:

```rust
#[serde(tag = "format", rename_all = "kebab-case")]
pub enum ExportSpec {
    /// VTU XML UnstructuredGrid, appended raw binary (header_type UInt64): the full volume mesh plus every nodal field of `step` (or none). Opens in ParaView.
    Vtu { step: Option<String>, fields: Option<Vec<Field>> },
    /// Gmsh .msh 4.1 ASCII with Sets as physical names. (writer in crates/geometry/io/msh.rs, plan C)
    Msh,
    /// Abaqus/CalculiX .inp: nodes, elements (C3D8/C3D20/…), *NSET/*ELSET/*SURFACE from Sets, *MATERIAL, *BOUNDARY, *DLOAD/*CLOAD, one *STEP per Step. For the CalculiX cross-check (I1).
    Inp { step: Option<String> },
    /// Binary STL of the mesh boundary surface (from surface.rs); geometry-only when no mesh.
    Stl,
    /// CSV of one table: model summary, sets, reactions, extremes, or a probe/path result.
    Csv { table: CsvTable },      // enum CsvTable { Bodies, Sets, Extremes { step }, Reactions { step }, Path { step, field, component, from, to, n } }
    /// The Journal as TypeScript (query.script) — the same text, as a file.
    Script { include_view: bool },
    /// The ModelFile JSON (snapshot + Journal).
    Journal,
    /// Markdown report: assumptions, geometry, materials, mesh and quality, loads with totals, results tables, benchmark comparison when an example is open, Journal as appendix. Images are placeholders `![iso](img/iso.png)` the host fills.
    Report { steps: Option<Vec<String>>, images: Vec<String> /* names the host will provide */ },
    /// PNG or SVG of the viewer with legend and title burned in. Host-side (viewer); the engine returns ExportUnavailable so the CLI says why.
    Png { width: u32, height: u32, legend: bool, title: Option<String> },
    Svg { width: u32, height: u32, legend: bool, title: Option<String> },
}
pub struct Export { pub filename: String, pub mime: &'static str, pub bytes: Vec<u8> }
pub fn formats(engine: &Engine) -> Vec<ExportFormat>;     // static table + `available`/`reason` from the current Model
```

The host `file.export` runs `transport.export(spec)` for every format except `png`/`svg`, which
`src/export/image.ts` renders from the `Viewer` (offscreen render at the requested size; SVG =
the PNG as `<image>` plus the legend and title as real SVG text, which is what a report wants);
for `report` it also renders each requested image and writes `img/<name>.png` next to the `.md`
when `to: 'project'`, or zips nothing and downloads the `.md` alone with a note when
`to: 'download'`. STEP is not in the enum until B-rep (PLAN 7.2); `query.exportFormats` does not
list what does not exist.

Tests (Rust, `export_fixtures.rs`, 2-hex fixture with one solved step from plan A's structured
builder once it lands; until then the mesh-needing formats assert `ExportUnavailable`): every
format equals a committed reference file byte-for-byte (`--bless` regenerates); VTU additionally
parsed back by a 30-line reader that checks point/cell counts and the appended-data offsets; msh
round-trips through C's reader; `.inp` reference checked for `*NODE`/`*ELEMENT`/`*BOUNDARY`
counts; STL triangle count = surface triangles and the divergence-theorem volume equals
`query.model` volume to 1e-9; CSV row counts; `script` re-parses into `Command`s; `report`
contains every section header and the Journal appendix has one line per entry. TS: `image.ts`
against a fake Viewer returns a PNG blob of the requested size (happy-dom + a 2D canvas stub) and
SVG containing the title text; the Export dialog table equals `query.exportFormats`.

### 7.11 Capability detection and coi-serviceworker (`index.html`)

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
| `rust` | ubuntu-24.04 | `dtolnay/rust-toolchain@1.94` (+wasm32 target; the action accepts a version as the ref), `Swatinem/rust-cache@v2`, `taiki-e/install-action@cargo-llvm-cov`, `cargo fmt --check`, `cargo clippy --workspace --all-targets --all-features -- -D warnings`, `cargo llvm-cov -p femlab-engine -p femlab-geometry --no-default-features --features threads --fail-under-lines 100 --fail-under-functions 100 --fail-under-regions 100 --lcov --output-path lcov.info` (no GPU code compiled, so nothing is excluded; regions stand in for branches, `--branch` needs nightly), `cargo test -p femlab` (CLI tests incl. schema freshness, fixture replay, export fixtures), `cargo check -p femlab-engine --target wasm32-unknown-unknown --no-default-features --features gpu` | yes |
| `gpu` | ubuntu-24.04 | plan A's recipe: `apt-get install -y mesa-vulkan-drivers vulkan-tools`, `LVP_POISON_MEMORY=true`, `WGPU_BACKEND=vulkan`, `vulkaninfo --summary` pre-flight; `cargo llvm-cov -p femlab-engine --all-features --fail-under-* 100` (this is where `gpu/` is covered, A §10); a missing adapter is a hard failure, never a skip. If Ubuntu's Mesa is too old for a test, switch to the `gfx-rs/ci-build` tarball recipe (URL not verified from this sandbox; take it from wgpu's own `.github/workflows/ci.yml`) | `continue-on-error: true` until green for a week (ADR 0007), then required |
| `wasm-hash` | ubuntu-24.04 | rust toolchain + cache, `node tools/build-wasm.mjs` (installs matching `wasm-bindgen-cli`, cached under `~/.cargo/bin` by rust-cache), `cargo build -p femlab --release`, `femlab schema --out engine.schema.json`, run the native and wasm hash lists for every fixture, `node tools/compare-hashes.mjs`; upload `packages/app/src/generated/wasm` and `engine.schema.json` as artifact `wasm` | yes |
| `web` | ubuntu-24.04, needs `wasm-hash` | `actions/setup-node@v5` (22, cache npm; use the latest major at coding time), download `wasm` artifact, `npm ci`, `npm run codegen -- --check --from engine.schema.json` (no Rust toolchain in this job), `npm run typecheck`, `npm run test -w packages/registry` (vitest, `coverage.thresholds: { 100: true }`, `coverage.include: ['src/**']`, excluding `src/generated/**`), `npm run test -w packages/app` (store, panels, colormap, agent loop, mentions, skills, project, image export; no threshold), `npm run build -w packages/app`, `npx size-limit` (landing chunk < 1 MB gz per PLAN §11; viewer, wasm, sucrase, anthropic SDK are lazy chunks); upload `packages/app/dist` as artifact `dist` | yes |
| `smoke` | ubuntu-24.04, needs `web` | download `dist`, `npx playwright install --with-deps chromium` (browsers cached by `actions/cache` on `~/.cache/ms-playwright` keyed by the Playwright version), `xvfb-run -a npx playwright test` with three projects: `cpu` (default Chromium, `vite preview`) — page loads, `window.fem` exists, `fem.geometry.addBox(...)` then `fem.query.model()` returns one body, Journal panel shows one line, `[data-cmd]` set ⊆ `fem.registry.list()`, project-folder flow via OPFS (§7.9), mention chip via click and paste (§7.7), `/` menu (§7.8), `file.export { format: 'script' }` downloads, screenshot artifact; `sw` (header-less `tools/static-serve.mjs`) — after one reload `crossOriginIsolated === true` and `fem.query.capabilities()` reports it; `gpu` (flags `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --use-vulkan=swiftshader --enable-unsafe-swiftshader`, `channel: 'chromium'`) — `capabilities.gpu === true` | `cpu`, `sw` required; `gpu` `continue-on-error` |

Shell only appears inside these ubuntu job steps; everything a developer runs locally is
`cargo …` or `node tools/*.mjs`, which is what keeps Windows unblocked (plan C §5.1 adds a
`windows-latest` allowed-to-fail lane for `cargo test`; B adds nothing to it).

`.github/workflows/deploy.yml` on `push: main`: the `wasm-hash` + `web` build steps (no tests),
`actions/upload-pages-artifact` + `actions/deploy-pages` at their latest majors (v3/v4 at the
time of writing; not verifiable from this sandbox), `permissions: pages: write, id-token: write`,
`concurrency: pages`. GitHub Pages serves `.wasm` as `application/wasm` and `.js` for the service
worker at the app root (`/fem-lab/coi-serviceworker.min.js`, scope `/fem-lab/`); `.nojekyll` keeps
Jekyll from dropping underscore-prefixed files; hashed asset names make stale caches a non-issue.

Caching: `Swatinem/rust-cache` (keyed by lockfile and job), npm cache via `setup-node`, Playwright
browsers, and the Mesa tarball (`actions/cache` on the extracted dir keyed by version).

---

## 9. Test strategy

| Layer | Tool | Threshold | What |
|---|---|---|---|
| `crates/engine` (registry, units, journal, hash, dispatch) | `cargo test`, proptest | 100 % lines/functions/regions | unit tests per module; proptest: `parse∘format` identity; **replay determinism**: a `proptest` strategy generates valid Command sequences (names drawn from a pool, boxes with positive sizes, constraints/loads on existing auto faces), applies them, replays the Journal into a fresh Engine, asserts equal `model_hash` and equal per-entry `hash_after`; **undo inverse**: for any prefix, `dispatch(c)` then `journal.undo` gives the hash before and `redo` gives the hash after; **transactionality**: a failing Command leaves hash and Journal length unchanged; every `Unsupported` stub arm is hit by a test |
| `crates/engine` export/report | `cargo test` | 100 % | reference files per format, VTU re-read, STL volume, script re-parse, report sections (§7.10) |
| `crates/femlab` | `assert_cmd` | none (host) | `run`, `export`, `schema --check`, `bench` on fixtures; schema freshness (incl. every Query has `x-returns`); fixture `.hashes` |
| `crates/engine-wasm` | `wasm-bindgen-test`? No: Node via `tools/replay-wasm.mjs` in `wasm-hash` job | none (host) | replay equality with native is the test |
| `packages/registry` | vitest + v8 coverage | 100 % all four | Registry routing, zod validation errors → structured Error shape, `toToolDefinitions` invariants (§4.4), `makeFemProxy`, transport protocol encode/decode + `decodeBulk` + in-flight queue with a fake `EngineTransport`, **no host Command reaches the engine or moves `query.journal.revision`** (§4.1), `parseMentions`/`refOf`, `parseSkill`/`mergeSkills`, `normalisePath` (§7.7–7.9); script export formatting is Rust so not here |
| `packages/app` | vitest (Node, happy-dom for components) | none | store reducers for every host Command, `panels.test.ts` enumeration (§7.3: every `CONTROLS[i].cmd` ∈ registry; every host Command reachable from a control or in `SCRIPT_ONLY` with a reason — expected entries `ai.setKey`, `ai.setModel`, `project.open { handle }`), colormap, agent loop with a fake Anthropic client, `buildSystem` snapshots, `resolveMention` per kind, `ProjectFolder` over a fake handle, `image.ts`, `WorkerTransport` with a fake worker |
| end-to-end | Playwright Chromium | smoke | §8 `smoke` (incl. OPFS project folder, chips, `/` menu, export download) |

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
| engine | femlab-geometry | workspace | plan C's Shape/Mesh/meshers/io (Reconciled table) |
| engine | wgpu, rayon, faer, bytemuck, futures-channel | per plan A §1.2 (features `gpu`, `threads`) | plan A owns these lines |
| engine dev | proptest | 1 | property tests |
| engine-wasm | wasm-bindgen 0.2.128, wasm-bindgen-futures 0.4.78, js-sys, web-sys, console_error_panic_hook | | the JS boundary; panics become readable errors |
| femlab | clap 4.6 (derive), pollster, anyhow | | CLI; block_on for the async engine |
| femlab dev | assert_cmd | 2 | CLI smoke |
| registry | zod | 4.5 | host Command schemas with `z.toJSONSchema` |
| registry dev | json-schema-to-typescript 16, vitest 5, @vitest/coverage-v8 5, typescript 5.9 | | codegen and tests |
| app | three 0.185, preact 10.29, sucrase 3.35, @anthropic-ai/sdk 0.124 | | §7.1 |
| app dev | vite 8.2, vitest 5, happy-dom, @playwright/test 1.63, size-limit 13 + @size-limit/file, @types/three, @types/wicg-file-system-access 2023.10 | | build, tests, budget, FS Access typings (absent from TS 5.9 lib.dom) |
| app public | coi-serviceworker.min.js 0.1.7 (vendored) | | must be a separate same-origin file |

Not taken: wasm-pack (two commands replace it), serde-wasm-bindgen (JSON is the wire format),
uom (no parser), Babylon (§7.1), immer (plain reducers; nothing needs patches), comlink (the
protocol is 40 lines and must match a future WebSocket transport), CodeMirror (PLAN 3.3: a
textarea is enough in phase 1; the designer may ask for it later), a YAML parser (skill
frontmatter is `key: value` lines), lz-string (`CompressionStream` is native in Chromium),
@modelcontextprotocol/sdk (phase 4.10, `femlab mcp`).

---

## 11. Commit sequence

Each commit is green (fmt, clippy, tests, coverage) and self-contained. Branch `plan-b/registry-hosts`
(or one PR per group of ~5 commits if the diff gets large). **D** in the "Waits for" column means
the commit's *components* wait for the design; the Commands, store, data tables and their tests
in the same row do not and land first with an unstyled default rendering. **A** = plan A's
numerics, **C** = plan C's geometry crate. Mapping to plan C's whole-build numbering: C1 ≙ 1,
C2 ≙ 2, C3 ≙ 3–5, C4 ≙ 7+10, C5 ≙ 16, C15 ≙ 11–15, C16 ≙ 11's deploy.

| # | Commit | Waits for | Done when |
|---|---|---|---|
| 1 | Workspace skeleton: Cargo workspace with `geometry`, `engine`, `engine-wasm`, `femlab` (empty), `rust-toolchain.toml`, `clippy.toml` deny list, `#![forbid(unsafe_code)]` in engine, npm workspaces with empty `registry` and `app`, `ci.yml` with `rust` and `web` jobs | – | CI green on empty crates; `cargo llvm-cov` reports 100 % of nothing without erroring (`--fail-under-*` with an `engine::version()` fn and its test) |
| 2 | `units.rs`: `Quantity`, `Dimension`, `Dim` markers, `Q<D>`, unit table, parser, `format`, `convert`, `UnitSet`; proptests | – | `parse∘format` identity passes 1000 cases; dimension mismatch and unknown symbol produce the structured errors of §2.6 |
| 3 | `error.rs` (the shared `Error`/`ErrorCode`/`Warning`), `command.rs`, `query.rs` with the full enums incl. `model.rename/duplicate`, `step.reorder`, `query.objects/export/exportFormats`, `ExportSpec`, param types, doc strings, `x-returns`, response structs, `Ack/Output`; `schema_for!` snapshot test in `crates/femlab/tests` against a committed `engine.schema.json` (first version generated by a test `--bless` flag) | – | every variant has a ≥ 80-char description; every physical field `$ref`s a `Q_*` def; every Query has `x-returns`; `plugin.load` carries `x-status: stub` |
| 4 | `model.rs` (`Body { shape: Shape }` with a minimal `Shape::Box` until C's crate lands), `engine.rs` `apply` for model/geometry/material/constraint/load/step Commands (upsert on name, referential checks, auto face names, `InUse` on remove, rename with reference update, duplicate, reorder), transactional `dispatch`, `Host` trait, `warnings()` with the checks that need no mesh (unassigned body, dangling names) | – | unit tests per Command incl. every error path and the upsert `Replaced` output; hash stable across a run |
| 5 | `journal.rs`, Model-only undo snapshots with the depth cap, redo, `as_script` (Value walker), `ModelFile`, `export/import_file`, `replay(skip_solves)`; `hash.rs`; proptests for replay determinism, undo inverse, transactionality | – | proptests pass at 256 cases; `as_script` output round-trips (parse each line's object back into `Command`); undo after 300 Commands still works and memory is bounded |
| 6 | Stub arms: `mesh.set` stores settings and invalidates; `solve.run`, `study.converge`, `query.mesh/result/probe/path/cost`, `export { vtu\|msh\|inp\|stl }` return `Unsupported`/`ExportUnavailable` with tests; `query.model/set/journal/script/convert/capabilities/objects/exportFormats` real; `export.rs` `script/journal/csv(bodies,sets)`; `report.rs` without result sections | – | coverage 100 % on the engine crate; report and CSV reference files committed |
| 7 | `crates/femlab`: clap, `run` (all flags), `export`, `schema`, `bench` (case format, runner, markdown/json), `serve`/`mcp` stubs; fixtures `benches/journals/cantilever.json` + `.hashes`; `assert_cmd` tests | – | `femlab run fixture --verify` exits 0; `femlab schema --check` passes; `femlab export --format script` equals `query.script` |
| 8 | `tools/codegen.mjs` (with `--from`), `packages/registry/src/generated/*` committed, `npm run codegen -- --check` in CI | – | generated `engine.ts` type-checks; `fem.d.ts` has one method per Command/Query with typed responses |
| 9 | `packages/registry`: `Registry` + `HostContext`, `transport.ts` types + `decodeBulk` + in-flight queue, `host-commands.ts` (zod, every row of §4.3 incl. doc strings; `run` functions call `HostContext`), `tools.ts`, `script-api.ts`, `mentions.ts`, `skills.ts`, `project-paths.ts`; vitest at 100 % | – | tool-list invariants pass; fake-transport round trips; host Commands never touch the transport; mention/skill/path tables pass |
| 10 | `crates/engine-wasm`: surface of §5.1 incl. `export_meta/export_bytes`, `tools/build-wasm.mjs` (web + nodejs targets, version-matched CLI), `tools/replay-wasm.mjs`, `tools/compare-hashes.mjs`, CI job `wasm-hash` | – | native and wasm hash lists identical for every fixture in CI |
| 11 | `packages/app` shell: Vite config, `index.html` with coi recipe, capability detection, `engine.worker.ts`, `WorkerTransport` (incl. cancel-by-replay), `store.ts` with every reducer of §4.3 and their tests, `window.fem`, minimal unstyled `<App/>` with top bar + status bar; Playwright `cpu` and `sw` smokes; `deploy.yml` | – | deployed to Pages; on Chromium `crossOriginIsolated === true` after one reload; `fem.geometry.addBox` works from DevTools; every host Command dispatches from the console |
| 12 | `panels.ts` tables + `panels.test.ts`; Model tree from `query.model`; Properties schema-driven form (all schema shapes of §7.3, edit = re-issue); command palette | D (components) | adding a box, a material, assigning it, adding a fixed constraint via forms produces the expected Journal; editing the constraint re-issues it |
| 13 | Viewer: three.js surface rendering, fit/camera/presets/projection, edges, picking with the name-face chip, `selection.*`, `view.*` Commands incl. legend/visibility/theme | D (chrome only; the `Viewer` class is design-independent) | pick → chip → `geometry.nameFace` appears in the Journal; screenshot smoke artifact shows the box |
| 14 | Journal panel (live script, undo/redo, copy as script) and Script panel (sucrase Worker, timeout, stop, setSource) | D (components) | pasting the Journal's script into the Script panel and running it reproduces the Model hash |
| 15 | Examples gallery from `public/examples/index.json`; `file.open/save`, `?example=` deep link; `project.ts` + project panel + `file.read/write` + AGENTS.md/skills loading; OPFS e2e | D (components) | opening an example rebuilds the tree and viewer; OPFS project shows the badge and a project skill |
| 16 | `gpu` CI job (lavapipe recipe) and `smoke` `gpu` project; `Engine.create({ gpu: true })` requests a device in the worker; `query.capabilities` reports it | A's `Gpu` (commit A14) or a 20-line local `Gpu` until then | `capabilities.gpu === true` on SwiftShader in CI at least once; job stays `continue-on-error` |
| 17 | `mesh.set` builds, `query.mesh`, `query.set`, `mesh_surface` from the real Mesh; viewer shows the lattice; loads/constraints layer markers; `export { vtu\|msh\|stl }` real with reference files | C (lattice mesher, io) | cantilever fixture meshes at three sizes; every auto face resolves to a non-empty Set; VTU opens in ParaView (documented) |
| 18 | `solve.run` with phase progress, `query.result/probe/path/cost`, Results and Checks panels, field contours, deformed shape, legend, clip plane, `export { inp\|csv(extremes,reactions,path) }`, report result sections | A (static solver), D (components) | Benchmark B1 solves from the UI in under a minute (PLAN §3 exit criterion); reaction balance shown |
| 19 | `study.converge` with `StudyReport`; Results panel shows the table and rate | A | B1 convergence study from one Command |
| 20 | AI agent behind `?ai=1`: key notice, model setting, tool loop with fake-client tests, system prompt builder with AGENTS.md block, `@`-mentions (parse, resolve, picker, click-insert, ⌘C/paste), `/` skills menu + four built-in SKILL.md files, `skill.invoke` tool, Journal diff/undo turn, cost; e2e for chips and menu | D (chat components), 15 | the success story runs with a stated model id against the deployed page; an eval task phrased only with chips passes (PLAN 4.11); a project `AGENTS.md` rule is followed (PLAN 4.13) |
| 21 | Export dialog from `query.exportFormats`; `image.ts` PNG/SVG with legend and title; report images; `file.shareLink` | D (dialog), 17–18 for mesh formats | every format in the menu downloads or lands in the project folder; `npx size-limit` still passes |
| 22 | size-limit budget, lazy chunks (viewer, wasm, sucrase, SDK), landing < 1 MB gz | – | `npx size-limit` passes in CI |
| 23 | Threads lane: nightly-pinned `engine_threads.wasm` build in `wasm-hash` (`continue-on-error`), loader selects by isolation, `capabilities.threads`; equality test 1 vs N threads on a fixture | A's `par` shim | identical hashes; single-thread note appears when not isolated |

Commits 1–11, 16, 22 are independent of A, C and the design and land first; 12–15, 20, 21 ship
their Commands, stores and tests immediately and their components when the design is back
(until then a plain default rendering keeps the Playwright smokes honest); 17–19 wait for A/C.

---

## 12. Risks and recommendations

| # | Risk | Recommendation |
|---|---|---|
| R1 | **Typed-array views over wasm memory are invalidated by memory growth** (a `dispatch` after `field()` can move the heap). | Views never leave the worker; `slice()` immediately and transfer. A debug assertion in the worker checks `view.buffer === memory.buffer` before slicing and throws `Internal` if not. |
| R2 | **wasm threads need nightly + build-std**; two artefacts; PLAN 0.8 wanted it in phase 0. | Ship single-threaded stable first (§5.2), coi-serviceworker from day one so isolation is real and tested, threaded artefact as commit 23 with pinned nightly and `continue-on-error`. Plan A's `par.rs` shim makes the switch a build flag, not a code change. |
| R3 | **Native vs wasm hash divergence** from libm differences or `HashMap` iteration order. | `libm` crate only; clippy `disallowed-methods/types`; `BTreeMap` only in serialised state; per-entry hashes localise the first divergence. |
| R4 | **serde-wasm-bindgen vs JSON strings performance.** | JSON for control (< 1 ms per Command, measured in spike 0.7), typed arrays for bulk; the same bytes serve `femlab serve`. Revisit only if a profile shows it. |
| R5 | **Viewer bundle size.** three ~600 KB min / ~150 KB gz tree-shaken; Babylon would be 1.5 MB+. | three.js, lazy `import()` of the viewer chunk after the shell renders; size-limit gate. |
| R6 | **GitHub Pages + service worker + wasm MIME / stale caches.** | Pages serves `application/wasm`; coi-serviceworker only injects headers on pass-through and caches nothing; Vite hashes assets. Reload loop guarded by `sessionStorage`; `shouldRegister` false when already isolated. Test both the header path (preview) and the SW path (static-serve) in CI. |
| R7 | **Chromium+SwiftShader WebGPU flakiness in CI** ("external Instance" errors). | Vulkan-via-SwiftShader flag set (note 05), `xvfb-run`, `continue-on-error`, `cpu` and `sw` smokes never depend on a GPU; the wgpu-on-lavapipe `gpu` job is the primary GPU lane. |
| R8 | **wasm-bindgen CLI/crate version mismatch** breaks the build silently on a new machine. | `tools/build-wasm.mjs` reads `Cargo.lock` and installs the exact CLI version. |
| R9 | **Anthropic tool constraints**: names cannot contain `.` (`^[a-zA-Z0-9_-]{1,64}$`). | `toolNameFor` mapping with reverse lookup, asserted by the tool-list test; `run_script` + generated API reference as the primary mode (Anthropic/Cloudflare findings, note 05). Token cost is R20. |
| R10 | **Schema drift** between Rust, JSON, TS, forms and tools. | Rust snapshot test + `codegen --check` + tool-list invariant test; three independent gates on one artefact. |
| R11 | **Concurrent calls into the wasm `Engine`** panic ("recursive use of an object"). | The worker's promise queue; the transport never issues two calls at once; a test with a fake worker asserts ordering. |
| R12 | **Cancelling a CPU solve** cannot interrupt wasm. | `terminate` + recreate + `replay(journal, skip_solves)` from the acknowledged shadow, then undo the redo tail back to the active revision. Cancelled and queued unacknowledged Commands stay outside the Journal; earlier Results are lost, while undo/redo history is preserved (#110). Plan A's `on_progress` in `SolveOptions` makes it cooperative later. |
| R18 | **`showDirectoryPicker` cannot be automated** and needs a user gesture; handles need re-permission after reload. | `project.open { handle }` is the internal form; e2e uses an OPFS directory handle (same interface); reopen goes through a click that calls `requestPermission` first. |
| R19 | **Clipboard writes need a user gesture** and `navigator.clipboard` is main-thread only. | `clipboard.copy` runs synchronously inside the ⌘C key handler; from a script/AI it returns `Unsupported` with the text in the error so the caller still gets it. |
| R20 | **Tool count** is now ~70 (engine + host) ≈ 25–30 k tokens of definitions per turn. | Prompt caching on the tool prefix (tools render first and are stable); `run_script` first in the system rules; if evals show selection trouble, consolidate `view.*` into one `view` tool with an `action` field — a change in `toToolDefinitions`, not in the registry. |
| R21 | **Upsert edits let an AI overwrite an object by reusing a name.** | `Ack.output = Replaced` + a Warning in the tool result; the Journal shows both entries; undo restores. Accepted over a separate `*.update` family (twice the Commands for the same schema). |
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
4. **No UI undo via immer patches** (ADR 0003 mentions `produceWithPatches`), and no immer at
   all. Model undo is Rust snapshots; UI state is not undoable, as in Blender; the store is plain
   reducers. Amend ADR 0003's "undo is `produceWithPatches`" sentence.
5. **`file.*`, `project.*` are host Commands**, not engine Commands (the engine has no file
   system); the engine exposes `export_file/import_file/export`. Same names as PLAN 3.1, different
   provider.
6. **Phase-3 CSG Commands are not stubbed**; only `plugin.load` is, because PLAN names it.
7. **Preact** as the UI library; the demos so far are vanilla DOM. Owner's call; swapping is a
   day's work while panels are few.
8. **Repo licence and `base` path**: `/fem-lab/` assumed; a custom domain changes one line.
9. **One `file.export { spec }` Command with a tagged `ExportSpec`** instead of PLAN 4.14's nine
   `file.exportVTU/Msh/Inp/STL/CSV/PNG/SVG/Script/Report` names. Same formats, same tests, one
   tool instead of nine, and the Export menu enumerates `query.exportFormats` (derived from the
   same schema). If the owner prefers one Command per format, `toToolDefinitions` can expand the
   enum into per-format tools without touching the engine.
10. **Edits are re-issues** (upsert on `name` within a kind; §2.1) rather than a `*.update` family.
    PLAN 3.1 has no edit Commands at all; the Properties form needs one.
11. **Undo snapshots the Model only** and the Journal is truncated; the first draft snapshotted
    `(Model, Journal)` per entry, which is quadratic.
12. **`model_hash` covers inputs only** (plan C §6 #4), which this design already satisfied; stated
    explicitly now so the "byte-identical across native and wasm" test is understood as a test of
    Commands and parameters, with Results compared to 1e-12 in plan A.

---

## Review log

Senior review, 2026-09-05. One line per change: what, why.

1. Added "Reconciled with A and C" section at the top: A, B, C disagreed on crate layout, `Mesh` owner, `Error` type, `Gpu` struct, solve entry point, element choice, geometry Commands, coverage gate, zod/immer, GPU lane and commit numbering; B now states one decision per topic and marks what it asks of A/C.
2. Rewrote the §0 seam to plan A's real signatures (`procedure::run(&Problem, &Step, Option<&Gpu>, prev)`, A's `StepResult`, `checks::run`, `assembly::pattern`, `post::*`); the old `solve_static`/`cost_estimate`/`check_well_posed` seam did not exist in A. Listed the two one-line additions asked of A (`face_set_area`, `on_progress` in `SolveOptions`).
3. Verified-facts block: corrected the schemars claim (Option fields need no `#[serde(default)]`; re-spiked), added `x-returns`, the TS 7.0.2-is-latest pin warning, `@types/wicg-file-system-access` (lib.dom lacks `showDirectoryPicker`, checked), Anthropic tool/model facts from the `claude-api` skill, and an honest "not verifiable from this sandbox" note for the Mesa tarball URL and action tags.
4. Fixed the wgpu `Instance::new` call shape (§ facts, §5.1, §6) to A's verified by-value `InstanceDescriptor::new_without_display_handle()`; B had a non-existent `&InstanceDescriptor { .. }` form.
5. `Gpu`: dropped B's `limits` field; use A's `Gpu { device, queue }` + `limits()` (§2.1, §5.1).
6. §1 layout: added `crates/geometry`, `surface.rs`, `export.rs`, `report.rs`, registry `mentions.ts`/`skills.ts`/`project-paths.ts`, app `skills/`, `project.ts`, `ai/context.ts`, `export/image.ts`; removed immer; Cargo features now owned by A §1.2.
7. Undo redesign (§2.1, §2.8): snapshot `Model` only and truncate the append-only Journal; the `(Model, Journal)` snapshot per entry was O(n²) over a session. Added `UNDO_DEPTH` cap so memory is bounded on large Models.
8. Upsert semantics (§2.1, §2.2, §2.7): re-issuing a create Command with an existing name is an edit (`Output::Replaced` + Warning). The Properties form had no Command to edit an existing item; a `*.update` family would double the schema.
9. Added engine Commands `model.rename`, `model.duplicate`, `step.reorder` (DESIGN-BRIEF §5.2 context menu and drag-reorder had no Command).
10. `mesh.set`: replaced B's invented `ElementType { Hex8, Hex8Im, Hex20 }` with A's `Formulation` (+ `order`); the Mesher picks `ElementKind`.
11. Geometry: the Model stores plan C's `Shape` from day one so C's `geometry.add`/booleans are additive; kept `addBox/subtractBox` as phase-1 sugar; Command-side predicates keep `Q<Length>` and convert to C's SI enum.
12. `Error`/`ErrorCode` (§2.6): merged A's dotted codes into B's enum so there is one error type across the crate; `Warning` = A's `Diagnostic`.
13. `Query`: added `x-returns` on every variant (an untagged `QueryResult` cannot tell codegen which response belongs to which Query); test added in `schema_is_current.rs`; `fem.d.ts` generator uses it (§3).
14. Added Queries `query.exportFormats`, `query.export`, `query.objects`; `query.cost` now says how B computes it (no `cost_estimate` in A).
15. Script export: formatter walks `serde_json::Value`, never a regex over text (a string value containing `":` would break unquoting).
16. Added the "large payloads never go inline" rule (blob by hash) for C's `mesh.import` and `plugin.load`, protecting the Journal and every undo snapshot.
17. §3 codegen: `--from <schema.json>` flag; the `web` CI job has no Rust toolchain and the text said "do the latter" without a mechanism.
18. §4.1: `HostContext` interface for host Command `run` functions; test that no host Command reaches the transport or moves `query.journal.revision` (plan C §6 #10 as a test).
19. §4.2 transport: added `export` op, a bulk-reply framing (`buffers` header + raw buffers) that works over `postMessage` transferables and WebSocket frames alike, `decodeBulk` shared function, in-flight queue on the calling side, `engine: local|remote` capability (DESIGN-BRIEF §9.6).
20. §4.3 host Commands rewritten as the complete contract against DESIGN-BRIEF §5–§7: added `view.preset/setProjection/setLegend/setVisible/setTheme/animate`, `selection.set.mode`, `selection.setPickTarget`, `script.setSource`, `chat.send/insertMention/clear`, `skill.invoke`, `clipboard.copy` (one Command for ⌘C/copy-as-script), `file.export`, `file.shareLink`, `file.read/write`, `project.open/close/refresh`, `ai.setModel`; host Queries `query.selection/skills/project`. Removed `file.exportVTU` (subsumed).
21. Dropped immer everywhere (plain reducers; UI undo was already out) and the 64-entry patch ring; `includeView` reads the store instead.
22. §4.4: `run_script` is the only non-registry tool; `skill.invoke` as a tool is how the AI self-invokes; tool-name regex added to the invariant test; SDK `Anthropic.Tool` type, no `strict`.
23. §5.1 wasm surface: `export_meta`/`export_bytes`; cancel path now replays the Journal (rebuilds undo) instead of `import_file` (which cleared undo) and states what a cancel costs.
24. §6 CLI: added `femlab export` (same exporters as the app, reference-file tests), `femlab mcp --project` stub, Windows-safe path note; replaced `diff -r` with `tools/compare-hashes.mjs`.
25. §7 scope note: visual design is the designer's; the section is architecture, data flow and Commands; placement words carry no design weight.
26. §7.3 panel table rebuilt against every DESIGN-BRIEF §5–§7 item (palette, Checks, Console, Export dialog, Project panel, Report view, Start state, chat features) with the Command each control dispatches; hover explicitly excluded as transient view state.
27. §7.6 AI agent rewritten to current SDK usage (`messages.stream`, `finalMessage`, adaptive thinking, one `tool_result` message for parallel calls, `is_error`, `refusal`), default model `claude-opus-5`, cache-friendly ordered system prompt with the AGENTS.md and skills-index blocks, turn-boundary seq for "undo this turn", fake-client tests.
28. New §7.7 `@`-mentions: ref grammar, `parseMentions`/`refOf`, per-kind resolution, `@selection`, click-insert, ⌘C/paste round trip, drag, tests and e2e (owner requirement (b), PLAN 4.11).
29. New §7.8 skills: `SKILL.md` frontmatter format, `parseSkill`/`mergeSkills`, built-ins via `import.meta.glob`, project override, `/` menu from `query.skills`, `skill.invoke` for person and AI, tests (owner requirement (a), PLAN 4.12).
30. New §7.9 project folder: `ProjectFolder` over `FileSystemDirectoryHandle`, IndexedDB handle persistence + `requestPermission`, `normalisePath` scoping rule shared with the Node host, AGENTS.md/CLAUDE.md into the system prompt with badge, OPFS trick for Playwright since `showDirectoryPicker` cannot be automated (owner requirement (c), PLAN 4.13).
31. New §7.10 export: one `file.export { spec }` with a tagged `ExportSpec` (vtu, msh, inp, stl, csv, script, journal, report, png, svg), `query.exportFormats` for the menu, where each exporter lives (Rust vs viewer), reference-file tests per format, STL volume check, report sections (owner requirement (d), PLAN 4.14; deviation recorded in §13.9).
32. §8 CI: coverage split per plan A (`rust` job `--no-default-features --features threads` at 100 %, `gpu` job `--all-features` at 100 %); `gpu` job uses apt `mesa-vulkan-drivers` first; `wasm-hash` uploads the schema; `web` uses `--from`; `smoke` downloads the `dist` artifact (it was never uploaded); e2e list extended; Windows note (shell only inside ubuntu steps); Pages action tags marked "latest major"; `.nojekyll` reason stated.
33. §9 tests: rows for export/report, mentions/skills/paths, host-Command-never-journaled, agent loop, `ProjectFolder`, `image.ts`; `SCRIPT_ONLY` expected entries listed.
34. §10 deps: A owns numerics lines; added `femlab-geometry`, `@types/wicg-file-system-access`; not-taken list adds immer, YAML parser, lz-string.
35. §11 commits: added a "Waits for" column (design D / plan A / plan C) so the coder knows which components are blocked on the design and that Commands, stores and tests land first; added export, project, mentions/skills work to commits 6, 7, 9, 15, 20, 21; renumbered threads lane to 23; mapped to plan C's numbering.
36. §12 risks: R12 updated to replay-based cancel; added R18 (FS Access automation), R19 (clipboard gesture), R20 (tool count/caching), R21 (upsert overwrite); R9 narrowed to the name constraint.
37. §13 deviations: added 9 (one export Command), 10 (upsert edits), 11 (Model-only undo), 12 (inputs-only hash); 4 and 5 updated for no-immer and `project.*`.
38. Struck YAGNI: immer patch ring, per-format export Commands, `Gpu.limits` field, `ElementType` enum, `(Model, Journal)` snapshots, `diff -r` dependency on bash for local use.
