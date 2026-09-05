# FEM Lab

A finite-element engine written as a headless TypeScript library, with a browser app as its
first host and a Node server as its second. Every action is a typed Command, so a person, a
script, a Python notebook or an AI can do anything the UI can do. Solves on the GPU through
WebGPU, in the browser and on the server alike.

## Run it

You need Rust 1.94 with the `wasm32-unknown-unknown` target and Node 22. Chromium is the
supported browser (ADR 0014).

```sh
cargo install --locked wasm-bindgen-cli --version "$(grep -A1 'name = "wasm-bindgen"' Cargo.lock | tail -1 | cut -d'"' -f2)"
node tools/build-wasm.mjs      # engine → packages/app/src/generated/wasm (gitignored)
npm ci
npm run dev                    # http://localhost:5173/fem-lab/
```

`npm run build` writes `packages/app/dist`, which is what GitHub Pages serves. In the browser
console, `fem` is the whole registry: `await fem.dispatch({ cmd: 'model.new', name: 'demo' })`,
`await fem.geometry.addBox({ name: 'beam', size: ['1 m', '100 mm', '100 mm'] })`,
`await fem.query.model()`, `fem.registry.list()`.

Tests: `npm test` (vitest), `npm run typecheck`, and in `packages/app`,
`npx playwright install chromium && npx playwright test` for the browser smokes.

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
