# FEM Lab

A finite-element engine written in Rust, with a TypeScript browser app, a native CLI and a
Node MCP host. The browser runs the headless engine as WebAssembly; Commands and Queries
provide the typed boundary for the UI, scripts and tools.

Start with the [documentation index](docs/README.md), [getting-started guide](docs/GETTING-STARTED.md),
[generated Command reference](docs/COMMANDS.md) or [contribution guide](CONTRIBUTING.md).

## Run it

You need Rust 1.94 with the `wasm32-unknown-unknown` target and Node 22. Chromium is the
supported browser (ADR 0014).

```sh
cargo install --locked wasm-bindgen-cli --version "$(grep -A1 'name = "wasm-bindgen"' Cargo.lock | tail -1 | cut -d'"' -f2)"
npm ci
node tools/build-wasm.mjs      # engine → packages/app/src/generated/wasm (gitignored)
npm run dev                    # http://localhost:5173/fem-lab/
```

`npm run build` writes `packages/app/dist`, which is what GitHub Pages serves. In the browser
console, `fem` is the whole registry: `await fem.dispatch({ cmd: 'model.new', name: 'demo' })`,
`await fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] })`,
`await fem.query.model()`, `fem.registry.list()`.

Without a browser, `cargo run -p femlab --` replays a Journal (`run`), runs the Benchmarks
(`bench`), writes an export (`export <file> --format vtu|msh|inp|stl|report|script|journal`), and
serves the whole registry to an editor over MCP (`mcp --project <dir>`; see
[`packages/mcp/README.md`](packages/mcp/README.md) for the `mcpServers` snippet).

## Import an Abaqus input deck

Choose **Import .inp** in the browser, select **Mesh and Sets** or **Linear static analysis**,
and choose the source unit system. The mm · N · s preset means one source length unit is
`1 mm`, one force unit is `1 N`, and one time unit is `1 s`; each remains editable. Time is
required for density-bearing materials. The toolbar's display units do not select import units.

The reader preserves parts, translated/rotated instances, quoted and scoped Sets, shared-node
material regions, and disconnected components. Supported solids are C3D4, C3D8 with the
Abaqus mean-dilatation formulation, C3D10 and full-integration C3D20, including their original
quadratic connectivity and geometry. Geometry must pass the engine's exact validity and interface checks.
Static import translates isotropic elastic materials, translational supports/displacements,
nodal forces, face pressures and multiple linear-static load cases with their inherited or
changed active loads. Ordinary output requests appear in import notes. The report maps source
material and Step names to their FEM Lab names. Import does not solve; solve each named Step
to compare its final equilibrium with the source application.

For INCLUDE decks and NODE/ELEMENT `INPUT=` data files, choose the submission folder when
prompted. Paths are relative to that folder, including includes inside other includes;
filename case is preserved. The CLI reads
from the input file's directory, and MCP reads within its configured project. Inline tools can
provide `sourceName` and a `sourceFiles` map of relative filenames to exact UTF-8 contents.
The engine itself performs no file I/O. The deck and includes together, and the saved Model
file, each have a 16 MiB UTF-8 limit. Failed or cancelled imports keep the current project;
an intervening model edit or project switch prevents a pending import from replacing it.

Unsupported physical behavior or element formulations produce an error with source details.
Reduced-integration, hybrid and modified elements are not substituted with another formulation.
Abaqus increment history, nonlinear/contact analyses, and binary `.odb`/`.cae` databases are
outside this text input-deck workflow; export a text `.inp` model for supported analyses.

The CLI writes an unsolved normal Model file:

```sh
cargo run -p femlab -- import-inp bar.inp --out bar.femlab.json \
  --name "Imported bar" --body bar --mode static \
  --unit-length "1 mm" --unit-force "1 N" --unit-time "1 s" --cpu
cargo run -p femlab -- run bar.femlab.json --cpu
```

Mesh mode requires `--unit-length` and omits force/time units. Scripts and MCP use the same
`file.importAbaqus` Command with `text`, `picker: true` (browser), or a `path` inside the open
project folder. The checked Journal carries the imported source, scoped label identities,
file digests and conversion version; saved files reopen without the original deck or includes.
The displayed receipt describes the original import and is local to that session. See the
[interoperability plan and acceptance matrix](docs/plans/650-abaqus-interoperability.md).

### Import STEP geometry

Choose **Import STEP geometry**, name the Body and supply absolute linear and angular
deflections, then choose a `.step` or `.stp` file (at most 16 MiB). STEP's declared length
units are converted to meters independently of display units. The converter downloads only
when requested and runs in a dedicated cancellable Worker. The equivalent browser Command is:

```ts
await fem.geometry.importStep({ name: 'part', linearDeflection: '0.1 mm', angularDeflection: '15 deg' });
```

This adds or re-imports one tessellated Body. All returned meshes become that Body;
exact B-rep, CAD feature history, original face identifiers and CAD materials are discarded.
Unsupported free topology, external references and incomplete conversion fail explicitly.
Reported transfer warnings are also unsupported until complete conversion can be established;
this conservatively rejects potentially harmless warnings as well as partial geometry.
Inspect the imported patches, name durable targets with `geometry.nameFace` predicates,
assign a Material and mesh normally. Smaller deflection adds curved-surface detail;
source tolerances can supersede the request. The minimum absolute deflection is 0.0000001 m.

`geometry.cancelStep({name: 'part'})` terminates a pending conversion before publication.
A second pending conversion conflicts, and an intervening model edit or project switch
rejects publication. The receipt contains source/geometry hashes, SI deflections and counts;
it describes the last successful conversion in this project. Later edits or Undo can change
or remove that geometry. The Journal stores one normal `geometry.import` with
double-precision ASCII triangles and their hash. Saved files and Journals replay in the
native CLI, Node and other hosts without a converter, original STEP file or file handle.
Hosts without the converter report original-file conversion as unsupported.

The separately distributed LGPL converter includes its notices and complete corresponding
source/rebuild kit. App builds prepare and verify those assets; a first uncached build needs
Python 3.12+ and network access to the pinned source archives. No OCCT compiler is needed for
ordinary app builds. See the [converter build/replacement instructions](vendor/step-converter/README.md)
and [scope and verification plan](docs/plans/351-step-import.md).

Tests: `npm test` (vitest), `npm run typecheck`, and in `packages/app`,
`npx playwright install chromium && npx playwright test` for the browser smokes.

The app test command always measures every authored `src/**/*.ts` and `src/**/*.tsx` module,
including browser entry points, workers and the viewer. Its #44 baseline is 68.31% lines,
67.19% statements, 61.96% functions and 67.03% branches; CI fails below any of these floors.
Raise the thresholds in `packages/app/vitest.config.ts` when tests improve coverage; do not
lower them or exclude untested modules. HTML and JSON summaries are in `packages/app/coverage/`.
Only non-executable `.d.ts` declarations are excluded. Generated wasm JavaScript is covered
by the Rust and browser gates, not the authored TypeScript denominator. A post-test check
rejects missing source modules, so a transform failure cannot inflate the reported coverage.

Every Playwright spec imports `test` from `e2e/fixtures.ts`, whose automatic fixture fails on
uncaught page errors, including popup pages. The panel lifecycle smoke reopens implemented
panels, Assistant disclosures, bottom tabs and viewer modes twice. The Report renderer is
still tracked separately in [#14](https://github.com/andeplane/fem-lab/issues/14).

The Assistant streams prose and tool arguments as they arrive. Choose a model below its
composer; the choice is saved in this browser. Enter sends a message, or queues it while a
response is running. Enter again with an empty composer interrupts that response and starts
the next queued message after any active tool finishes. Shift+Enter adds a newline. Tool
arguments and results scroll inside their cards; image payloads are omitted from the display.

**Status: research, plan, engine, and a browser shell. Read in this order:**

1. [`docs/PROPOSAL.md`](docs/PROPOSAL.md): the questions answered (can FEniCS run in a
   browser, is a new WebGPU solver sensible, what people do today, who has built what), what we
   build, what we do not, risks.
2. [`docs/JOBS-TO-BE-DONE.md`](docs/JOBS-TO-BE-DONE.md): what FE engineers actually do, by
   persona, numbered so the plan can be checked against it.
3. [`docs/PLAN.md`](docs/PLAN.md): phases, tasks, gates, and the job-coverage matrix.
4. [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md): every case with a known answer that the engine
   must reproduce; this is the physics test suite.
5. [`CONTEXT.md`](CONTEXT.md): the vocabulary (Model, Command, Journal, Plugin, Host, ...).
6. [`docs/adr/`](docs/adr/): the decisions that would be hard to reverse and why.
7. [`docs/research/`](docs/research/): the cited notes everything above rests on.

| Research note | Question |
|---|---|
| [01](docs/research/01-existing-engines-in-browser.md) | Can FEniCS, NGSolve, MFEM, CalculiX, ... run in the browser? Who has tried? |
| [02](docs/research/02-webgpu-wasm-numerics.md) | WebGPU/WGSL numerics (no f64), limits, browser support, CI, wasm limits, Rust/C++ libraries, TS vs Rust |
| [03](docs/research/03-browser-cad-and-meshing.md) | CAD kernels, code-CAD, meshers and formats in the browser; AI + geometry |
| [04](docs/research/04-cae-products-workflows-and-ai.md) | How Abaqus/COMSOL/Ansys users work, Blender's scriptability, browser CAE, AI-for-FEA literature, benchmark sets |
| [05](docs/research/05-scripting-architecture-and-testing.md) | Script language and sandbox, command/schema architecture, AI exposure, WebGPU in CI, GitHub Pages limits |
| [06](docs/research/06-user-code-plugins.md) | User subroutines in incumbents; Fortran/C++ to wasm; WGSL plugin splicing; plugin manifests |

The research was done on 2026-09-05 against primary sources; each note lists what it could
not verify. The notes were written while this plan lived inside the owner's homepage repo
(`andeplane/andeplane.github.io`, whose Blast Wall and Flow Defence demos they cite), so "this
repo" inside a research note refers to that one.
