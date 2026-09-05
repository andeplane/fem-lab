# FEM Lab: implementation plan

Plan, 2026-09-05. Read `PROPOSAL.md` first for what and why; this is how and in what order.
Decisions referenced as ADR-000N live in `adr/`. Jobs referenced as J1.1 etc. live in
`JOBS-TO-BE-DONE.md`; §12 maps every one of them to a phase. The physics test suite is
`BENCHMARKS.md`; every phase gate names cases from it.

## 0. Rules that apply to every task

1. **One way to change a Model.** A task that adds a UI control adds a Command first and a
   test that the control dispatches it (ADR 0003).
2. **Definition of done** for any task: (a) coverage is 100 % on the engine (`cargo llvm-cov`
   on `crates/engine`, vitest thresholds on the TypeScript registry glue); (b) every WGSL file
   validates statically; (c) every kernel touched has a GPU test that ran in CI on the software
   adapter; (d) every new numerical capability
   has a Benchmark in `BENCHMARKS.md` with a stated reference and tolerance, and a convergence
   study where a rate is known; (e) the Command's schema doc string is written, because it is
   the AI's tool description.
3. **Oracles are independent** (ADR 0007). Never a CPU copy of the kernel under test.
4. **SI inside, units at the boundary** (ADR 0008). No bare numbers for physical quantities in
   any Command schema.
5. **Ponytail applies to code, not to verification.** Fewest files, no speculative
   abstractions, but every Benchmark that has a known answer gets written.
6. **One shader, one copy.** WGSL lives in `crates/engine/shaders/*.wgsl`, pulled in with
   `include_str!` by the engine and read by the static validator; no copies in TypeScript.
7. **The engine is headless** (ADR 0011, 0012). `crates/engine` has no std::fs, no network, no
   DOM; the GPU device, storage and clock are constructor arguments. CI runs the same Journal
   through the native and the wasm build and compares Model hashes.
8. **Benchmarks are scripts.** Every case in `BENCHMARKS.md` is a script against the Command
   API, runnable by `femlab bench` with no browser. The suite is therefore also the proof that
   the engine is a scriptable library.
9. **CPU work is parallel and deterministic** (ADR 0013). Loops over elements, faces and nodes go
   through rayon with fixed-order reductions; every parallel path is tested at 1 and N threads
   for identical output. The browser gets the same threads via wasm-bindgen-rayon behind the
   coi-serviceworker shim.
10. **Commit after every feature-sized step**, on a branch, with the tests green. Small commits,
   often; a PR is a sequence of them, not one squash of a day.

## 1. Where it lives

This is its own repository, `andeplane/fem-lab`: a Cargo workspace for the engine and an npm
workspace for the hosts (ADR 0012):

```
crates/engine/                    the headless library (ADR 0011, 0012); no I/O, GPU injected     ← 100 % coverage
  src/model, commands, journal, units, mesh, fem, plugins, post, bench
  src/gpu/ + shaders/*.wgsl       wgpu compute; WGSL via include_str!, shared with the validator ← gpu tests (lavapipe)
  benches/                        Benchmark scripts + reference values (BENCHMARKS.md is their index)
crates/engine-wasm/               wasm-bindgen build of the engine for the browser host
crates/engine-py/                 PyO3/maturin binding (phase Py): `pip install femlab`
crates/femlab/                    Rust CLI/server host: femlab run | bench | serve; wasmtime for Plugins
packages/registry/                TypeScript: generated types + JSON Schema from the engine, UI Commands, Journal glue
packages/app/                     browser host: Vite, Babylon viewer, panels, script Worker, in-page agent
packages/mcp/                     Node host: stdio MCP server over the registry (or `femlab mcp` in Rust; decide in phase 4)
tools/                            wgsl-validate, schema codegen, ci helpers
docs/                             this folder
CONTEXT.md, AGENTS.md             glossary; working rules (CLAUDE.md is a symlink)
```

Dependencies: engine has wgpu, serde + schemars, nalgebra-sparse or hand-rolled CSR, faer (opt-in
for the native host), proptest (dev); app adds @babylonjs/core 8, zod 4 (UI Commands), immer,
sucrase; registry adds the schema codegen output; Manifold and fTetWild wasm arrive in phase 3
behind the Mesher Extension Point (Rust bindings or JS-hosted, decided then).

The owner's homepage links to the deployed app (GitHub Pages of this repo) with a project card.

## 2. Phase 0: spikes and scaffolding

Goal: retire the two risks that would change the plan, and stand up the empty, fully tested
skeleton. Nothing user-visible.

| # | Task | Done when |
|---|---|---|
| 0.1 | **GPU-in-CI spike.** Lanes in one workflow, all `continue-on-error`: (a) Rust wgpu native tests on `mesa-vulkan-drivers` lavapipe (wgpu's own CI recipe, incl. `LVP_POISON_MEMORY=true`); (b) the wasm build of the same crate in Playwright Chromium with `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --use-vulkan=swiftshader --enable-unsafe-swiftshader`; (c) fallback: dawn.node with `VK_ICD_FILENAMES=.../lvp_icd.x86_64.json` for TS-side kernel tests. Each runs an axpy + dot kernel and asserts bit-identical results across lanes | (a) and (b) green on three consecutive runs; result recorded in ADR 0007 |
| 0.2 | **Static WGSL validation.** `naga` over `crates/engine/shaders/*.wgsl` in CI (naga is already a wgpu dependency), plus `getCompilationInfo()` in the browser lane | a deliberately broken shader fails CI |
| 0.3 | **Registry skeleton, two providers.** Engine Commands in Rust (`serde` + `schemars`, one `enum Command` with doc comments), schema codegen to JSON Schema + TS types in `packages/registry`; UI Commands in TS with zod 4; one `Registry` and one `Journal` in TS that dispatch to either; undo via engine snapshots (Rust) and immer patches (UI state); `toToolDefinitions()` | property tests: any Journal replays to the same Model hash in native and wasm builds; any Command then undo returns the previous Model; tool list equals registry |
| 0.4 | **Units.** `Quantity` type in Rust (`"2 MPa"`, `{ value, unit }`) with dimension check and SI normalisation, mirrored in the generated TS schema; formatting in a chosen unit set | proptest: parse∘format is identity; wrong dimension is a schema error on both sides |
| 0.5 | **Test lanes.** `cargo llvm-cov` at 100 % on `crates/engine`; wgpu tests on lavapipe; vitest with 100 % thresholds on `packages/registry`; Playwright smoke on `packages/app` | CI green on an empty workspace |
| 0.6 | **Workspace and hosts.** `crates/engine` with `Engine::new(gpu: Option<wgpu::Device>, storage, clock)`; `crates/engine-wasm` exposing it via wasm-bindgen; `crates/femlab` with `femlab run <journal>` that replays a Journal and prints `query.model`; `packages/app` Babylon `WebGPUEngine` viewer showing an empty grid and a WebGPU-unavailable message; `#![deny]` of std::fs/network in the engine crate; CI job that runs `femlab run` natively and the same Journal in the wasm build | app deployed to GitHub Pages; the two builds produce identical Model hashes |
| 0.7 | **Rust↔TS boundary spike.** A Result of 1M f32 values crosses to Babylon as a typed-array view without a copy; a Command round-trips serialised in < 1 ms | numbers recorded in ADR 0012 |
| 0.8 | **Threads-in-browser spike.** Copy Atomify's recipe: `public/coi-serviceworker.min.js` with `coepCredentialless`, registered before the app module, one guarded reload, Vite dev headers; `wasm-bindgen-rayon` pool in `crates/engine-wasm`; a parallel element loop at 1 and N threads on GitHub Pages | `crossOriginIsolated === true` on the deployed page in Chromium (ADR 0014); identical results at 1 and N threads; the single-thread fallback shows its note when headers are absent |

Exit criterion: ADR 0007's claim ("GPU kernels run in CI") is true or the plan is revised.

## 3. Phase 1: the vertical slice, linear static on the lattice

Goal: a cantilever from script to contour plot, every step a Command, with CPU f64 only.

### 3.1 Model and Commands

| Command / Query | Schema (abridged) | Notes |
|---|---|---|
| `model.new`, `model.setUnits` | `{ name }`, `{ length: 'mm'\|'m', force, stress, ... }` | display units only; storage is SI |
| `geometry.addBox` | `{ name, size: [Q,Q,Q], at: [Q,Q,Q] }` | lattice-aligned in v1; faces auto-named `name.xmin` … `name.zmax` |
| `geometry.subtractBox` | same | openings/holes on the lattice |
| `geometry.nameFace` | `{ name, of: Body, where: FacePredicate }` | predicates: `plane`, `bbox`, `normal` |
| `geometry.remove` | `{ name }` | |
| `material.add`, `material.assign` | `{ name, E: Q, nu, rho: Q, alpha?: Q, k?: Q, cp?: Q }`, `{ material, bodies }` | library entries are just pre-filled Commands |
| `mesh.set` | `{ mesher: 'lattice', size: Q \| { nx, ny, nz }, order: 1\|2 }` | hex8 in v1, hex20/hex27 in phase 2 |
| `constraint.fix`, `constraint.prescribe`, `constraint.symmetry` | `{ name, on: Set, dofs: ('ux'\|'uy'\|'uz')[] }`, `{ ..., value: Q }` | |
| `load.pressure`, `load.traction`, `load.force`, `load.gravity` | `{ name, on: Set, value: Q }`, `{ name, on: Set, total: [Q,Q,Q] }` (J5.4), `{ g: [Q,Q,Q] }` | |
| `step.add` | `{ name, procedure: 'static', constraints: [names], loads: [names], output: [...] }` | |
| `solve.run` | `{ step, solver?: 'auto'\|'cpu-direct'\|'cpu-pcg' }` | async; progress events |
| `query.model`, `query.mesh`, `query.set`, `query.result` | | summaries an AI can read: counts, bbox, volume, mass, min/max with location, reactions per constraint |
| `query.probe`, `query.path` | `{ field, at: [Q,Q,Q] }`, `{ field, from, to, n }` | |
| `journal.get`, `journal.asScript`, `journal.undo`, `journal.redo` | | |
| `file.save`, `file.load`, `file.exportVTU` | | snapshot + Journal; VTU by hand (~100 lines) |

### 3.2 Numerics

- Lattice Mesher: bodies → occupied cells → nodes/elements/sets; exact volumes; face sets from
  predicates. Reuses the ideas (not the code) of `blast-wall/src/model/mesh.ts`.
- Elements: hex8 full integration, plus hex8 with incompatible modes or selective reduced
  integration so a linear hex bends (J4.3 warning depends on it). `B`, `K_e`, consistent load
  vectors for pressure and gravity, stress recovery at Gauss points and extrapolated to nodes.
- Assembly: CSR in f64 (`Float64Array` values, `Int32Array` indices), Dirichlet by row/col
  elimination with reaction recovery.
- Solvers (CPU, f64): sparse Cholesky (simplicial, CSparse-style, ~500 lines) for
  <~200k DOF; Jacobi-PCG fallback above. This CPU path is permanent (ADR 0002).
- Well-posedness (J6.11): body without material, Set that resolved to nothing, element with
  `det J ≤ 0`, rigid-body modes detected by a cheap null-space check before factorising.
- Post: nodal displacement, element/nodal stress (averaged and not, J8.7), von Mises,
  principal, reaction totals, extremes with location.

### 3.3 Viewer and UI

Babylon.js renders mesh + contour (custom shader material reading a per-vertex scalar), face
picking to *suggest* a `geometry.nameFace` predicate (the click produces a Command, never a
node list), deformed-shape scale, legend, Journal panel that shows the script live, a script
panel (CodeMirror is YAGNI in phase 1; a textarea plus "run" is enough) executing in the
Worker (ADR 0004), and undo/redo. Camera and hover are view state, not Model state.

### 3.4 Benchmarks (phase 1 gate)

| Benchmark | Reference | Tolerance / what it proves |
|---|---|---|
| Patch tests (constant strain, all 6 modes) | exact | 1e-10; element is conforming |
| Single-element rigid-body modes | zero force | 1e-12 |
| Uniaxial bar | σ = F/A, δ = FL/EA | 1e-8 |
| Cantilever tip deflection, bending | Euler–Bernoulli + Timoshenko shear correction | h-convergence at the theoretical rate; full-integration hex8 shows locking, the improved hex8 does not (this *is* the J4.3 lesson) |
| Reaction balance | Σ reactions = − Σ applied, all Benchmarks | 1e-9 relative (J9.3) |
| Thermal expansion of a free block | ε = αΔT, zero stress | 1e-10 |
| Journal replay | Model hash equal | property test, every Benchmark |

Exit criterion: the proposal's "success looks like" story runs by hand (no AI yet) in under a
minute, and every table above is green in CI.

## 4. Phase 2: GPU implicit solver, modal, thermal, explicit

Goal: 1M-DOF static in seconds on a laptop, frequencies and mode shapes, heat, and the Blast
Wall integrator as a procedure.

| # | Task | Done when |
|---|---|---|
| 2.1 | Matrix-free hex8 operator in WGSL (shared `K_e` per lattice cell size; gather-based, no atomics; ADR 0002), f32 | `gpu.test`: `K·u` matches CPU assembly to f32 rounding for random `u`; rigid modes give zero; symmetric via `⟨Ku,v⟩=⟨u,Kv⟩` |
| 2.2 | PCG on GPU with Jacobi and Chebyshev/aggregation-AMG preconditioners; residual checked on GPU every k iterations, read back asynchronously; f64 iterative refinement on the CPU | converges to CPU-direct answer to 1e-8 relative on all phase-1 Benchmarks; iteration counts logged per Benchmark and asserted not to regress |
| 2.3 | CSR SpMV kernel for unstructured meshes (needed in phase 3), chunked to ≤ binding limit | same tests on a tet mesh once phase 3 lands |
| 2.4 | hex20 / hex27 elements (CPU + matrix-free) | cantilever converges at order 2 |
| 2.5 | Modal: shift-invert with the CPU direct solver for small, LOBPCG on the GPU operator for large; consistent mass | Euler–Bernoulli cantilever, β_nL = 1.8751, 4.6941, 7.8548 → f_n within 1.5 % (mode 1) and 3 % (mode 3, Timoshenko drift); FV32 and FV52 once 2D/tet10 exist (phase 3) |
| 2.6 | Thermal: steady conduction, convection BCs, transient (implicit Euler / Crank–Nicolson); thermal strain into a static step (J5.5, J6.9) | 1D bar analytical; Ansys VM97 fin (tip 416 °F, 1 %); NAFEMS T3 transient (36.60 °C at x = 0.08 m, t = 32 s); two-step thermal→structural against LE11 later |
| 2.7 | Explicit dynamics procedure: port the Blast Wall central-difference integrator and its critical-step estimator as `procedure: 'explicit'`; pure f32 | momentum conservation 1e-6; Δt_crit test (0.9× stable, 1.25× diverges) as Blast Wall already does |
| 2.8 | Engine runs off the UI thread with progress/cancel (J7.1, J7.2): the app host puts it in a Web Worker, the CLI host on the main thread or `worker_threads`; the engine only emits progress events | UI stays at 60 fps during a 1M-DOF solve; the same Journal solves in `femlab run` |
| 2.9 | Cost estimate Query before solve (J4.7): DOF, nnz or matrix-free bytes, predicted seconds from a calibration run | shown before `solve.run` |

Exit criterion: 1M-DOF cantilever, 8-noded hexes, static, under 10 s on an M2-class GPU
(software adapters exempt), and the same model without WebGPU still solves on the CPU.

## 5. Phase 3: real geometry, tets, 2D, convergence studies

Goal: geometry that is not a box, and the classic benchmarks that need it.

| # | Task | Done when |
|---|---|---|
| 3.1 | Manifold CSG behind the geometry Commands: `addCylinder`, `addSphere`, `extrude(polygon)`, `revolve`, `union/subtract/intersect`, `transform`; lazy-loaded wasm (ADR 0009) | exact volume Query matches analytical for primitives |
| 3.2 | fTetWild Mesher: `mesh.set({ mesher: 'tet', size, epsRel, order })`; boundary faces mapped back to named faces via Manifold face IDs; `det J > 0` check on import; volume drift vs CSG reported | every named face resolves to a non-empty Set after remeshing at three sizes |
| 3.3 | tet4 and tet10 elements; CSR assembly on CPU; GPU CSR operator (2.3) | patch tests; tet4 shown stiff, tet10 not (J4.3) |
| 3.4 | 2D idealisations: quad4/quad8, tri3/tri6 plane stress, plane strain, axisymmetric (J1.2) | Cook's membrane; Kirsch plate with hole; Lamé thick cylinder (axisymmetric) |
| 3.5 | Mesh quality Query (J4.5): aspect, min dihedral, Jacobian ratio; worst-N with locations | shown in UI, readable by AI |
| 3.6 | `study.converge` Command (J4.6, J9.4): rerun a step at n sizes, report the quantity of interest and the observed rate | every Benchmark in `bench/` is also a convergence study |
| 3.7 | Symmetry constraints as a first-class Command (J1.3) | quarter plate-with-hole equals full |
| 3.8 | Mesh import/export: Gmsh .msh 4.1 read/write, Abaqus .inp write (C3D8/C3D4/C3D10, sets, materials, BCs, static step) for CalculiX cross-checks (J9.5, J15) | round-trip property test; a CalculiX run of an exported deck matches within 1e-6 (manual, documented) |

### Benchmarks added in phase 3 (reference values from research note 04 §5)

| Benchmark | Elements | Reference | Tolerance |
|---|---|---|---|
| NAFEMS LE1 elliptic membrane, plane stress | quad4/quad8 | σyy(D) = 92.7 MPa | 2 % (p=2), 5 % (p=1) |
| NAFEMS LE10 thick plate under pressure | hex20 / tet10 | σyy(D) = −5.38 MPa | 2 % (p=2); the p=1 error (~−29 %) is recorded and shown as the J4.3 lesson |
| NAFEMS LE11 solid cylinder, thermal stress | hex20, axisymmetric | σzz(A) = −105 MPa | 3 % |
| NAFEMS T4 steady conduction + convection | quad/tri | T(E) = 18.3 °C (converged 18.25) | 0.5 °C |
| NAFEMS FV32 tapered membrane, modal | quad8 | 44.623, 130.03, 162.70, 246.05, 379.90, 391.44 Hz | 1 % |
| Lamé thick cylinder (plane strain + 3D) | quad/hex p=1,2 | u_r(a) = 5.90e-5 m, σθθ = 100 MPa, σrr = −60 MPa | 1 % disp, 2 % stress at p=2 |
| Near-incompressible cylinder, ν = 0.49 / 0.499 / 0.4999 | quad4/quad8/hex, mixed later | regenerated from Lamé | monotone; < 2 % for a locking-free element |
| Kirsch plate with hole | p=2 | K_t = 3.00 (infinite plate); 3.018 for the Ansys VM142 geometry | 2 % |
| Cook's membrane | tri/quad p=1,2 | 21.520 (ν = 1/3) vs 23.9 (plane stress) — **resolve before hard-coding** | 1 % at fine mesh + Richardson |
| MacNeal–Harder straight cantilever, in-plane shear, skewed meshes | quad4, quad4-incompatible, quad8 | 0.108 in | quad8 ≤ 1 %; quad4 error recorded, not gated |
| Manufactured solution, Poisson and elasticity | hex/tet p=1,2 | L2 rate p+1, H1 rate p | rate ± 0.1 |

Open items before hard-coding, all in note 04: FV52 reference set (Ansys vs Abaqus rows
disagree), Cook's converged plane-stress value, MacNeal–Harder values beyond 0.108.
Scordelis–Lo (0.3024), LE3 (0.185 m) and the SS plate (0.00406 qa⁴/D) wait for shells (8.1).

## 6. Phase 4: the AI

Goal: the in-page agent does the proposal's story end to end; Claude Code can drive the page.

| # | Task | Done when |
|---|---|---|
| 4.1 | `window.fem`: the registry (Commands, Queries, Journal) on the page, typed | Chrome DevTools MCP `evaluate_script` builds and solves a cantilever (recorded transcript in `docs/`) |
| 4.2 | Tool derivation: `toToolDefinitions()` → Anthropic tool array; plus `run_script` whose input is TypeScript and whose output is the script's return value, console, and thrown errors | schema snapshot test; every Command has a doc string ≥ 1 sentence |
| 4.3 | Read-back Queries the papers say models need: `query.model` summary, `query.mesh` stats, `query.result` extremes/reactions, `query.screenshot` (PNG from the viewer), `query.journal` | an agent with *no* screenshot can still detect a wrong BC from reaction totals (eval case) |
| 4.4 | In-page agent: Anthropic Messages API from the browser (`dangerouslyAllowBrowser`), BYO key in localStorage with a plain notice, streaming, tool loop, "show me what you did" as Journal diff | the success story runs with a stated model ID; cost shown |
| 4.5 | System prompt = generated API reference (from schemas) + units rule + verification habit ("after solving, check reactions and compare with a hand estimate") | prompt is generated, never hand-edited |
| 4.6 | **Agent eval suite** (FEABench-style, ours): 20 tasks from student problems with reference answers; run by a script against a frozen build; pass = within tolerance and reactions balanced | ≥ 80 % pass before shipping the agent; failures listed in `docs/` with causes |
| 4.7 | Guardrails: `run_script` runs in the Worker with a timeout; the agent cannot call `file.load` on arbitrary URLs; no key ever in a Journal or export | tests |
| 4.8 | `validate_script` tool: parse + type-check the script against the registry's `.d.ts` before running it (VFEAgent found most Abaqus-script failures were API hallucination and lifecycle errors); structured errors `{ ok, code, where, hint }` from every Command | an intentionally wrong call is caught before execution |
| 4.9 | Material lookup for the agent: the library of 8.4 is pulled forward as data (name, E, ν, ρ, α, yield, source) so the model never invents a modulus (note 04: 900–2000× errors without lookup); every unset default the solver used is listed in the result ("assumption log") | eval tasks that name a material pass without numbers in the prompt |
| 4.11 | **@-mentions**: the chat resolves `@name` to a Model object (body, face, set, material, constraint, load, step, result, Journal entry, project file) and attaches its `query.*` summary to the message; picker over the registry's object index; `@selection` resolves to the live viewer/tree selection; clicking an object with the chat focused inserts its chip; ⌘C on a selected object puts `@kind:name` on the clipboard so it pastes as a chip | an eval task phrased with `@` chips only passes; copy in viewer → paste in chat round-trips |
| 4.12 | **Skills**: `skills/<name>/SKILL.md` (frontmatter: name, description, when) from the app's built-ins and from the project folder; `/` menu in the chat; a skill is prepended to the turn when invoked, and the AI may invoke one itself from its description | built-in skills: beam-theory check, convergence study, report, NAFEMS benchmark; a project skill overrides a built-in of the same name |
| 4.13 | **Project folder**: open a directory via the File System Access API (Chromium, ADR 0014); the Journal, scripts, plugins and exports live in it; `AGENTS.md`/`CLAUDE.md` in the folder is read into the system prompt with a visible badge; the AI gets `file.read`/`file.write` scoped to that folder | a project rule ("all stresses in MPa, S355 yield 355 MPa") is followed without being repeated in the chat |
| 4.14 | **Export** Commands: `file.exportVTU` (mesh + fields), `file.exportMsh` (Gmsh 4.1), `file.exportInp` (Abaqus/CalculiX), `file.exportSTL` (geometry surface), `file.exportCSV` (any table/probe/path), `file.exportPNG`/`SVG` (viewer, legend burned in), `file.exportScript`, `file.exportReport` (Markdown; PDF via print); STEP when B-rep lands (7.2) | each exporter has a round-trip or reference-file test; the UI Export menu enumerates the registry |
| 4.15 | **Images in the chat**: paste, drop or pick images (PNG/JPEG/WebP, downscaled client-side to ≤ 1568 px on the long edge, ≤ 5 MB), shown as chips with optional captions, sent as `image` content blocks (base64) alongside the text; "attach current view" adds a `query.screenshot` PNG; images live in the conversation store, never in the Journal or a Model file; the eval suite gains "build from this drawing" tasks with hand-drawn inputs | an eval task whose only geometry description is a drawing produces a Model within tolerance of the intended one |
| 4.10 | `femlab mcp`: the CLI host serves the registry's tool definitions plus `run_script` over stdio with the MCP SDK; a running engine, headless, with dawn.node if a GPU exists (ADR 0011) | Claude Code builds and solves a cantilever through `femlab mcp` with no browser; the eval suite of 4.6 runs against both hosts |

## 7. Phase 5: post-processing and reporting

| # | Task | Job |
|---|---|---|
| 5.1 | Contours for every field; deformed scale; legends with units; section cuts (clip plane in shader); iso-surfaces later | J8.1, J8.6 |
| 5.2 | Probe, path plot, extremes with location, reaction table | J8.2, J8.3 |
| 5.3 | History (XY) plots for transient/modal/convergence | J8.4 |
| 5.4 | Mode shape and transient animation; PNG/WebM export at set resolution | J8.5, J11.1 |
| 5.5 | Derived fields: von Mises, principal, safety factor vs yield, utilisation | J8.8 |
| 5.6 | Compare two Results (difference field, side-by-side) | J8.10 |
| 5.7 | Report Command: Markdown with assumptions, geometry, materials, mesh + quality, loads (with totals), results tables, Benchmarks run, the Journal as an appendix; KaTeX theory sections as the other demos do | J11.2, J11.3, J14.4 |
| 5.8 | Share link: compressed Journal in the URL fragment; save/load to file; IndexedDB autosave | J11.4, J12.2 |
| 5.9 | Journal diff between two Models (J12.1, J12.4) | |
| 5.10 | **Tutorials**: a `Tutorial` is data (`tutorials/<name>.json`: steps with `explain`, `expect: Command pattern`, `highlight: control id`, `doIt: Command`); the runner watches `query.journal` and advances when the expected Command appears; "do it for me" dispatches it; progress in the URL; first-run tour; built-in tutorials: cantilever, plate with hole, thermal bar, "read a result" | J14.5; a tutorial completes by driving the UI only and by driving `window.fem` only (two e2e tests) |
| 5.11 | **Examples gallery**: every Benchmark Journal plus ~20 everyday models (bracket, L-plate, tube, bolt flange, slab strip, heated fin), each with explanation, reference/expected values, thumbnail generated by the viewer in CI, theory snippet; simple ones link to their tutorial variant | J14.1, J14.6; every example replays green in `femlab bench` |

## 8. Phase 6: nonlinear

| # | Task | Benchmark |
|---|---|---|
| 6.1 | Geometric nonlinearity: total/updated Lagrangian hex8/tet, Newton–Raphson with load stepping, line search, convergence controls exposed as schema | large-deflection cantilever (Bathe), buckling by load-displacement |
| 6.2 | J2 plasticity with isotropic hardening; return mapping; consistent tangent | plate with hole plastic zone vs reference; bar with yield |
| 6.3 | Linear buckling (eigen on K + K_σ) | Euler column load factors |
| 6.4 | Implicit dynamics (Newmark / HHT-α) and harmonic response | SDOF and cantilever transient analytical |
| 6.5 | Tie / bonded contact between bodies (node-to-face, penalty); frictional contact later or never | two-block tie patch test |
| 6.6 | Restart / rerun only changed steps (J7.4) | Journal-driven cache keyed by Model revision |

## 9. Phase 7: B-rep geometry (v2) and CAD interop

| # | Task | Job |
|---|---|---|
| 7.1 | Replicad behind the geometry Commands: sketch, extrude, revolve, fillet, chamfer, shell; lazy 2.4–9 MB | J2.1 |
| 7.2 | STEP import (Replicad `importSTEP` or `occt-import-js`); STL import straight into fTetWild | J2.3, J15.2 |
| 7.3 | Defeature Commands: remove fillets/holes below a size (Replicad/OCCT) | J2.4 |
| 7.4 | Gmsh-wasm as an optional Mesher if graded/hex/tet10-native meshing is worth GPL and 12–45 MB; decision recorded as an ADR then | J4.2, J4.4 |
| 7.5 | Assembly of parts with ties (uses 6.5) | J2.7 |

## 10. Phase 8: idealisations, parametric studies, extension

| # | Task | Job |
|---|---|---|
| 8.1 | Shell (MITC4) and beam (Timoshenko) elements with sections | J2.9, J3.5; Scordelis–Lo, pinched cylinder, hemispherical shell |
| 8.2 | `study.sweep` (one parameter), `study.doe` (grid/LHS), response plots; runs in the Worker with a queue | J10.1, J10.2 |
| 8.3 | Simple optimisation (scalar objective, bounds; Nelder–Mead / golden section) | J10.3 (topology optimisation: out of scope) |
| 8.4 | Material library as data (S355, S235, 6061-T6, C30/37, ABS, PLA, wood classes) with sources; user library in IndexedDB | J3.1, J12.3 |
| 8.5 | Orthotropic elasticity with orientation; temperature-dependent tables | J3.3, J3.6 |
| 8.6 | Custom fields as `PostQuantity` Plugins (Phase P) | J13.6 |
| 8.7 | Templates: a Model with parameters exposed as a form derived from the script | J10.4 |

## 10b. Phase P: plugins (user code)

Goal: what an Abaqus user does with a UMAT, done in TypeScript, WGSL or wasm, recorded in the
Journal. Detailed interface decisions are in ADR 0010; research in note 06. Phase P starts
after phase 1 (the Extension Points must exist before anything can fill them) and its
material-law part is the first deliverable because it is the job Ingrid actually has.

| # | Task | Done when |
|---|---|---|
| P.1 | **Extension Points in the core**, each a TS interface with a schema for its parameters: `MaterialLaw` (material point: strain, state, props → stress, tangent, state), `Element` (shape functions, integration, `K_e`/`f_int`), `Load` (traction at a face point), `PostQuantity` (fields → field), `Mesher`, `Procedure` | built-in materials/elements/loads are themselves implemented through the Extension Points, so there is no privileged path |
| P.2 | `plugin.load` Command: `{ source: 'inline' \| 'url' \| 'file', kind, language: 'ts' \| 'wgsl' \| 'wasm', code \| bytes, manifest }`; content hash computed and stored in the Journal; `plugin.list`, `plugin.unload` | a Model that used a Plugin cannot be replayed without it, and says so by hash |
| P.3 | **TypeScript plugins**: compiled with sucrase, executed in the host's Worker and called by the engine through an injected callback in batched form; a `MaterialLaw` test harness (`plugin.test({ strainPath })`) that drives the law through a strain history and plots stress | a user J2 plasticity written as a Plugin reproduces the built-in one to 1e-12 |
| P.4 | **WGSL plugins**: a `MaterialLaw` or `Load` written as a WGSL function with a fixed signature, spliced into the element kernel template at pipeline build (named hook points as Babylon's `getCustomCode`, or WESL `link()` if imports are wanted), validated with `getCompilationInfo()` before use, errors mapped back to the user's line numbers, pipelines cached by source hash | the same user law on the GPU matches the TS version to f32 rounding; a WGSL syntax error is reported before any dispatch |
| P.4b | **Manifest** (JSON): `id`, `version`, `kind`, `language`, `entry`, `abi`, `props` (Zod schema → UI form and AI tool), `nstatev`, `tensorOrder`, `units`, `permissions: []`, `sha256`; the Model file records `{ id, version, sha256, sourceUrl }` per Plugin used and verifies the hash on load with `crypto.subtle.digest` | loading a Model whose Plugin hash mismatches refuses with a clear message |
| P.5 | **wasm plugins**: hand-written C ABI for the batched material point (`f64` SoA arrays in linear memory, n points per call, fixed strides), instantiated by the TS host in the browser (`WebAssembly.instantiate`, empty imports) and by wasmtime in the Rust server host; C/C++ via `clang --target=wasm32-wasip1` (wasi-sdk) or `emcc -sSTANDALONE_WASM --no-entry`; Fortran via flang-wasm + Emscripten or f2c + clang (ADR 0010); a header `femlab_plugin.h` and a Fortran interface module define the ABI once | the same J2 law compiled from C and from Fortran 77 (via f2c) both pass the P.3 harness bit-for-bit against the TS version |
| P.6 | **Upload `.wasm` is the supported path**: drag-and-drop or URL + SHA-256; a documented local build recipe per language. In-browser compilers (LFortran wasm backend, wasm-clang) are optional demos behind the same manifest, not in v1 | recipe verified on macOS and Linux in CI (build the sample plugins from source in a CI job) |
| P.7 | **Plugin manifest**: name, version, kind, language, author, parameters schema (Zod, so the UI form and the AI tool follow), state variable count, hash | the AI can write and load a Plugin through `run_script`, then use it as a material |
| P.8 | Sandbox: plugins run in the solver Worker (terminate on timeout), wasm has no imports, TS plugins see the Extension Point argument and nothing else | tests |

## 10c. Phase S: the server host

Goal: the same engine, on a machine with more memory and a bigger GPU, for batch, CI and
models that outgrow the laptop. Deliberately thin; the engine already runs in Node after
phase 0, so this phase is protocol and packaging, not solver work.

| # | Task | Done when |
|---|---|---|
| S.1 | `femlab run` and `femlab bench` in the CLI host are the CI entry points for every Benchmark; results as JSON and a Markdown table | `BENCHMARKS.md` status table is generated from a CI run |
| S.2 | Remote solve protocol: the app host can send a Journal (plus Plugin hashes) to a `femlab serve` endpoint and receive a Result stream; the engine is unchanged, the host does transport | a Journal recorded in the browser solves on the server byte-for-byte equal to the local CPU path |
| S.3 | Server GPU: native wgpu with a real Vulkan/Metal adapter; raised limits; rayon across all cores for assembly and factorisation of large models (ADR 0013) | a 5M-DOF model solves on a workstation GPU; the browser refuses it with `query.cost` and offers the server |
| S.4 | Container image (Node + Mesa lavapipe for GPU-less, Vulkan ICD passthrough for GPU) | `docker run femlab bench` passes on a GPU-less runner |
| S.5 | Native sparse direct solver behind the same `Solver` interface for the Node host only (faer via napi or wasm; note 02), if measured as the bottleneck | opt-in; parity test against the TS Cholesky |

Out of scope for S: multi-user, auth, job queues. If those are ever wanted they are a product
on top of `femlab serve`, not part of the engine.

## 10d. Phase Py: Python environment (todo, after phase 4)

Goal: engineers who think in numpy do their analysis in Python without leaving the app, and a
notebook can drive the engine. Python is a *client* of the registry (ADR 0004), never a second
scripting core.

| # | Task | Done when |
|---|---|---|
| Py.1 | Generated Python binding: from the same Zod schemas, a `femlab` Python module with one function per Command and Query (typed with dataclasses, unit strings accepted), calling the registry over the host's RPC | binding is generated in the build, never hand-edited; a Journal replays from Python identically |
| Py.2 | Pyodide host in the app: Pyodide loaded lazily in a Worker (6.8 MB core + numpy ~2.8 MB, note 05), `femlab` pre-imported, Results exposed as numpy arrays without copying through JSON (typed-array transfer) | `import femlab; r = femlab.solve('static'); np.max(r.stress.von_mises)` works in the app |
| Py.3 | Notebook-style cell UI with matplotlib output (agg → PNG) next to the 3D view; cells and their outputs are recorded in the Journal as `script.run({ language: 'python' })` so the Model stays reproducible | a saved Model with Python cells reopens and re-executes |
| Py.4 | Same binding installable from PyPI for the Node/server host (`pip install femlab`), talking to `femlab serve` or spawning `femlab mcp`-style stdio | a Jupyter notebook on a laptop drives a server engine |
| Py.5 | The AI may write Python cells as well as TypeScript scripts; the eval suite gains Python variants | eval parity within 5 % of the TS pass rate |

## 11. Cross-cutting, every phase

- **Docs**: each phase ships a README section and a KaTeX theory page (element formulation,
  procedure, solver) next to the UI, in the notation of a standard FEA course (J14.4).
- **Errors** (J7.3, J14.2): every thrown error has a code, a one-line cause, and a suggested
  Command; the AI sees the same text.
- **Examples** (J14.1): every Benchmark is also a one-click example with its theory.
- **Performance budget**: landing chunk < 1 MB; Babylon and the solver core lazy; wasm
  meshers lazy; measured in CI with size-limit.
- **Memory (ADR 0009)**: `query.cost` before every solve; refuse with a clear message above
  the adapter's limits rather than crash.

## 12. Jobs-to-be-done coverage

Phase numbers refer to §2–§10. "Out" means deliberately out of scope with the reason.

| Job | Phase | Job | Phase | Job | Phase |
|---|---|---|---|---|---|
| J1.1 question | 5 (report asks for it) | J5.1 fix/pin/roller/symmetry | 1, 3.7 | J8.6 cuts/iso | 5 |
| J1.2 idealisation 3D/2D/axi | 1, 3.4; shells/beams 8.1 | J5.2 prescribed disp | 1 | J8.7 nodal vs element | 1 |
| J1.3 symmetry | 3.7 | J5.3 pressure/traction/force/gravity | 1 | J8.8 derived | 5 |
| J1.4 units | 0.4 | J5.4 total force on face | 1 | J8.9 export | 1 (VTU), 5 |
| J1.5 hand estimate | 4.5 (agent habit), 5.7 | J5.5 thermal loads | 2.6 | J8.10 compare | 5 |
| J1.6 physics choice | 1, 2 | J5.6 time/parameter variation | 2.6, 6.4 | J9.1 analytical | 1 |
| J2.1 primitives/booleans/fillets | 1 (boxes), 3.1, 7.1 | J5.7 remote points/couplings | 6.5 (ties); rigid couplings: 8 | J9.2 NAFEMS | 1–3, 8.1 |
| J2.2 parametric | 1 (scripts are parametric), 8.7 | J5.8 contact | 6.5 (bonded); frictional: **Out**, contact search is a project of its own | J9.3 sanity checks | 1 |
| J2.3 import CAD | 7.2 | J5.9 draw + total load | 1 | J9.4 convergence | 3.6 |
| J2.4 defeature | 7.3 | J6.1 static | 1 | J9.5 cross-check | 3.8 |
| J2.5 partition | 3.1 (booleans), 7 | J6.2 modal | 2.5 | J9.6 theory shown | 11 |
| J2.6 named faces | 1 | J6.3 buckling | 6.3 | J10.1 sweep | 8.2 |
| J2.7 assemblies | 7.5 | J6.4 heat | 2.6 | J10.2 DOE | 8.2 |
| J2.8 measure | 1 (`query.model`) | J6.5 NLGEOM | 6.1 | J10.3 optimise | 8.3 (topology: **Out**) |
| J2.9 shells/beams | 8.1 | J6.6 plasticity | 6.2 | J10.4 templates | 8.7 |
| J2.10 viewport | 1 | J6.7 implicit dynamics/harmonic | 6.4 | J11.1 images | 5.4 |
| J3.1 library | 8.4 | J6.8 explicit | 2.7 | J11.2 report | 5.7 |
| J3.2 custom material | 1 | J6.9 chained steps | 2.6 | J11.3 reproducible | 0.3 (Journal), 5.7 |
| J3.3 temp-dependent/ortho | 8.5 | J6.10 output requests | 1 (`step.add.output`) | J11.4 share | 5.8 |
| J3.4 nonlinear materials | 6.2 (J2); hyperelastic: 6 later; creep/damage: **Out** for now | J6.11 well-posedness | 1 | J12.1 versions/diff | 5.9 |
| J3.5 sections | 8.1 | J7.1 progress/cancel | 2.8 | J12.2 save/autosave | 5.8 |
| J3.6 orientation | 8.5 | J7.2 responsive/queue | 2.8, 8.2 | J12.3 libraries | 8.4 |
| J4.1 global size | 1 | J7.3 plain failure reasons | 11 | J12.4 review journal | 1 (Journal panel), 5.9 |
| J4.2 local refinement | 3.2 (fTetWild size), 7.4 (Gmsh fields) | J7.4 restart | 6.6 | J13.1 record as script | 0.3, 1 |
| J4.3 element type/order + warning | 1, 2.4, 3.3 | J7.5 solver choice/cost | 1, 2.9, S.5 | J13.2 batch/no UI | 0.6 (`femlab run`), 4.10 (`femlab mcp`), S.1, Py.4 |
| J4.4 hex/structured | 1 (lattice), 7.4 | J7.6 determinism | 0.3, 2.1 (gather, no atomics) | J13.3 custom material law | P.1–P.5 |
| | | | | J13.6 custom element/load/post | P.1 (Element, Load, PostQuantity) |
| | | | | J13.7 bring Fortran/C++, run on GPU | P.5 (wasm), P.4 (WGSL) |
| | | | | J13.8 result records plugin hash | P.2, P.7 |
| J4.5 quality | 3.5 | J8.1 contours | 1, 5.1 | J13.4 AI | 4 |
| | | | | J14.5 tutorials | 5.10 |
| | | | | J14.6 examples gallery | 5.11 |
| J4.6 convergence study | 3.6 | J8.2 probe/path/extremes | 1, 5.2 | J13.5 discoverable API | 0.3, 4.2 |
| J4.7 cost estimate | 2.9 | J8.3 reactions | 1 | J14.1–J14.4 learn | 11 |
| J4.8 mesh import/export | 3.8 | J8.4 XY plots | 5.3 | J15.1–J15.2 interop | 1, 3.8, 7.2 |
| | | J7.2 responsive/queue (server) | S.2, S.3 | J15.3 outgrow the browser | S.2, S.3 (same engine, bigger machine); 3.8 (export deck) |
| | | | | Python analysis (P3 researcher habit) | Py.1–Py.5 |
| J4.9 sets survive remesh | 1 (design), 3.2 | J8.5 animation | 5.4 | J13.9 @-mentions | 4.11 |
| | | | | J13.10 skills | 4.12 |
| | | | | J13.11 project AGENTS.md | 4.13 |
| | | | | J13.12 images to the AI | 4.15 |
| | | | | J15.4 export formats | 4.14, 3.8, 7.2 (STEP) |

Every job has a phase or an explicit Out. The Outs: frictional contact and topology
optimisation, each a project rather than a task. Creep and damage materials are not built in,
but they are exactly what the `MaterialLaw` Extension Point exists for, so they are covered by
Phase P rather than by the core.

## 13. Order, effort, and gates

| Phase | Depends on | Rough effort (focused sessions) | Gate |
|---|---|---|---|
| 0 spikes + skeleton | – | 3–5 | GPU lane green in CI |
| 1 vertical slice | 0 | 8–12 | success story by hand; benchmarks green |
| 2 GPU + modal + thermal + explicit | 1 | 8–12 | 1M DOF < 10 s on M2-class |
| 3 CSG + tets + 2D + convergence | 1 (2 for GPU CSR) | 8–12 | NAFEMS LE1/LE10, Cook, Kirsch, Lamé |
| 4 AI | 1 (better after 3) | 5–8 | eval ≥ 80 % |
| 5 post + report + share | 1 | 5–8 | report reproduces the Model |
| 6 nonlinear | 2, 3 | 10–15 | Bathe cantilever, plastic plate |
| 7 B-rep | 3 | 6–10 | fillet + STEP demo |
| 8 shells/beams, studies, library | 3, 5 | 8–12 | Scordelis–Lo; sweep plot |
| P plugins | 1 (TS + wasm), 2 (WGSL) | 8–12 | a user UMAT in Fortran-via-wasm and in WGSL pass the same harness |
| S server host | 0 (CLI), 2 (GPU) | 3–5 | browser Journal solves on the server byte-for-byte; 5M DOF on a workstation GPU |
| Py Python environment | 4 | 5–8 | numpy analysis of a Result in the app; notebook drives a server engine |

Phases 4 and 5 can start as soon as phase 1 lands and run alongside 2 and 3; the AI is most
useful early because it exercises the API the way a stranger would. Effort is in sessions of
the kind that built Blast Wall, not calendar weeks.

## 14. Open decisions for the owner

1. **Name.** "FEM Lab" is the working name and the repo name; the product name can differ.
2. **Viewer**: Babylon.js (picking, camera, GUI for free; used in the owner's other demos) vs
   raw WebGPU (zero-copy from solver buffers). Plan assumes Babylon and a CPU copy of results;
   zero-copy is an optimisation for later.
3. **Licence posture**: is GPL-2.0+ acceptable for an optional Gmsh Mesher chunk (phase 7.4)?
   The plan assumes no until asked. Also: the repo's own licence (MIT assumed).
4. **Python priority**: phase Py is a todo after phase 4. Pull it forward if the first real
   users are Abaqus/numpy people rather than students.
5. **Server timing**: phase S is thin and can land any time after phase 2; the question is when
   a model that needs it appears.
