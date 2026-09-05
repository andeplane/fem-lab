# FEM Lab: a browser-native, AI-first finite-element editor

Proposal, 2026-09-05. Research notes are in `research/`, decisions in `adr/`, the vocabulary
in `../CONTEXT.md`, what engineers need in `JOBS-TO-BE-DONE.md`, the physics test suite in
`BENCHMARKS.md`, and the work in `PLAN.md`. Nothing is implemented; this is the plan to argue
with.

## The questions, answered

**Can FEniCS or a similar engine run in the browser?**
Not FEniCS. DOLFINx requires MPI and HDF5-with-MPI in its C++ core and compiles C code at
run time (FFCx → CFFI) for every form; nobody has ever built it for wasm, and there are zero
mentions of wasm or Pyodide on the FEniCS forum or in its issue trackers. PETSc does build
under Emscripten, serially, which is interesting but not FEniCS. The one full C++ FEM engine
that runs in a browser today is NGSolve/Netgen via Pyodide: 31 MB, no fast direct solvers,
32-bit, LGPL, Python. scikit-fem runs in Pyodide because it is pure Python, and is slow for
the same reason. MFEM compiles but only its viewer ships. GPU FEM in the browser is, as far as
the public record goes, unexplored: two toy repos. (Research note 01.)

**Is it hard to build a new one in WebGPU, copying FEniCS's ideas?**
Building a *general* PDE framework (UFL-style forms, arbitrary elements, form compilation)
is a decade of work and is what makes FEniCS unportable. Building a *solid-mechanics and
heat FEA code* with a fixed element library, the thing Abaqus users actually use, is a
well-trodden path: the Blast Wall demo already has corotational hex8 elements, a lumped-mass
explicit integrator and gather-based GPU assembly on WebGPU. What is missing is the implicit
side (static, modal, thermal), a mesher for non-lattice geometry, and the editor. The data
structures to copy are not FEniCS's; they are the ordinary ones: nodes, connectivity, dof
maps, CSR or matrix-free operators, sets. Rust is not needed; TypeScript with WGSL template
strings is within 1–2× of Rust-wasm on the CPU side and identical on the GPU side, and it
avoids a wasm boundary on every command (ADR 0001, note 02).

**Is it stupid because of memory and precision?**
No, but the platform sets two hard rules. WGSL has no double precision and no float atomics,
so the GPU does the f32 inner loop (operator, preconditioner, vectors) and the CPU keeps f64
for everything the conditioning cares about (ADR 0002). Memory is ample for the target: a
1M-DOF 3D elasticity problem is ~650 MB as f32 CSR or ~100 MB matrix-free, and desktop
adapters offer 1–4 GiB buffers when asked (default limits are 128/256 MiB and must be
raised). Expected solve time for 1M DOF on an M2-class laptop: 10–30 s with Jacobi-PCG,
1–3 s with a decent multigrid preconditioner. Below ~10k DOF the GPU is slower than the CPU
because each dispatch costs 30–70 µs. The design ceiling is therefore ~1M DOF in the browser,
which covers every student model, most bracket-and-plate engineering models, and every demo.
A model that outgrows it exports an Abaqus/CalculiX deck (JTBD J15.3).

**How do people work today?**
Geometry → mesh → materials → constraints/loads → steps → solve → post-process → verify →
report, in Abaqus/CAE, Ansys Mechanical or COMSOL, with a Python (Abaqus, PyAnsys),
Java/MATLAB (COMSOL) or APDL scripting layer that lags the GUI and a journal file
(`abaqus.rpy`) nobody reads. The browser products (SimScale, Onshape Simulation, Fusion 360)
put a UI in the browser and solve and mesh on servers. The research on LLMs and FEA
(FEABench on COMSOL, MechAgents on FEniCS, the OpenFOAM agents) says models fail on geometry,
boundary conditions, units and on verifying their own results, and succeed when they can
write code, run it, observe and fix. Every CAD MCP server that works is one `execute_code`
tool plus a few read-back tools. (Notes 03, 04.)

**Has anyone built this?**
Not this. Pieces exist: Zoo and Onshape did code-CAD for LLMs with server kernels; SimScale
did browser CAE with server solvers; Replicad did browser B-rep; a Kratos developer shipped
Gmsh, fTetWild and MMG as wasm this summer; FEAScript is a small JS FEM with a WebGPU Jacobi
solver. Nobody has put a verified implicit FEA solver on WebGPU behind a fully scriptable
editor on a static site. That is the gap.

## What we build

**FEM Lab** is a headless finite-element engine, written as a TypeScript library, with two
hosts: a static web app in which a Model is built, meshed, solved and inspected entirely in
the browser, and a Node CLI that runs the same engine on a server for batch, CI, an MCP server
and models that outgrow a laptop (ADR 0011). Every action is a typed Command that a person, a
script, a Python cell or an AI can call (ADR 0003). Blender's rule, enforced by construction.

Packages and layers, each importable without the one above it:

```
packages/app      browser host: Babylon viewer, panels, Journal-as-script view, script Worker,
                  in-page Claude whose tools are the registry schemas + run_script   (ADR 0004, 0006)
packages/cli      Node host: femlab run | bench | mcp | serve; dawn.node for a server GPU  (ADR 0011)
packages/python   Pyodide host (later): generated Python binding over the same registry
packages/engine   the library both hosts construct; no DOM, no Babylon, GPU injected  (ADR 0011)
  commands/       the registry: Zod 4 schemas, run(), Journal, undo (immer patches)  (ADR 0003)
  model/          Model, Geometry, Sets, Materials, Constraints, Loads, Steps; SI + units (ADR 0008)
  mesh/           Meshers: lattice hex8 (v1), Manifold+fTetWild tets (v1.5), B-rep (v2)  (ADR 0005)
  fem/            elements, assembly, procedures (static, modal, thermal, explicit), f64 CPU
  plugins/        Extension Points (MaterialLaw, Element, Load, PostQuantity, Mesher, Procedure)
                  and loaders for TS, WGSL and wasm Plugins; built-ins use the same points (ADR 0010)
  gpu/            WGSL kernels: matrix-free / CSR operator, PCG, preconditioners, explicit (ADR 0002)
  post/           fields, probes, extremes, reactions, VTU export
  bench/          the Benchmarks as scripts: analytical, NAFEMS, patch tests, convergence (ADR 0007)
```

The Model, the Journal and the script are the same information in three forms. Opening a
file replays a Journal onto a snapshot; sharing a link carries a compressed Journal;
"copy as script" is a Query on the Journal; the AI's `run_script` appends to it.

## What makes it different

1. **Everything is a Command**, so the AI has the whole app on day one, and a UI control
   without a Command fails a test.
2. **Verification is a feature.** Benchmarks with reference values ship in the app, run in
   CI, and are one click away from any Model ("check this against beam theory").
3. **Units at the boundary.** `"2 MPa"` is valid input; `"250 mm"` for a pressure is an error.
4. **Well-posedness before solving.** Rigid-body modes, missing materials, zero-volume
   elements and unconstrained bodies are reported before a matrix is assembled.
5. **The Journal is the model.** Review, diff, replay, share, and reproduce from the report.
6. **No server required.** The GPU in the laptop does the work; nothing leaves the machine
   except the user's own calls to their own AI account. The same engine runs on a server when
   a model needs one, and a Journal recorded in the browser replays there byte-for-byte.
7. **User code is first-class.** What an Abaqus user does with a Fortran UMAT, a FEM Lab user
   does with a Plugin in TypeScript, WGSL or wasm (from C, C++ or Fortran), loaded by a
   Command, hashed into the Journal, and run on the GPU when the interface allows.

## What it is not

- Not a general PDE framework. Solids and heat, with a built-in element library that is
  extended through Plugins rather than through weak forms.
- Not CFD, not electromagnetics, not a CAD system. Geometry is what FEA needs and no more.
- Not a collaboration platform. One person, one Model, one Journal; a link to share.
- Not a replacement for Abaqus at 10M DOF in the browser. Above ~1M DOF, run the same engine
  on a server or export the deck.
- Not a Python code. Python is a first-class client of the engine (phase Py), not its
  implementation language.

## Risks and how the plan treats them

| Risk | Mitigation |
|---|---|
| f32 GPU PCG stalls on badly conditioned meshes | f64 CPU path always present; iterative refinement; multigrid preconditioner in phase 3; conditioning reported to the user |
| WebGPU in CI turns out flaky on GitHub runners | phase 0 spike with three independent recipes (dawn.node, Deno+lavapipe, Chromium+SwiftShader); `continue-on-error` until stable |
| Wasm meshers are weeks old with one maintainer | vendored, pinned, behind the Mesher seam; lattice mesher needs none of them |
| B-rep (OCCT) robustness and size | v2 only, lazy-loaded, and the v1/v1.5 vocabulary already covers the models LLMs are reliable on |
| The registry becomes a bottleneck for UI ergonomics (drag, orbit, hover) | view state is not Model state; camera and hover never go through Commands, only Model changes do |
| Scope creep toward "all of Abaqus" | the JTBD coverage matrix in `PLAN.md` says, for every job, which phase or why not |

## Success looks like

A student opens a link, asks the in-page AI for "a 1 m steel cantilever, 50×100 mm, 10 kN at
the tip, quadratic hexes, compare the tip deflection with beam theory", watches it build the
Model, mesh, solve, plot, and report a 0.4 % difference with a convergence table, then opens
the script it wrote, changes the load, and reruns. Every step of that is a Command in the
Journal, and every Benchmark behind it ran in CI that morning.
