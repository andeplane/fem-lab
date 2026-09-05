# 03 — Browser CAD kernels, meshers, and file formats for an in-browser FEM lab

Research note, 2026-09-05. Question: how do we get geometry and a finite-element
mesh built *inside the browser*, with an AI/LLM able to build that geometry through a
script API? Liveness numbers (stars, last push) were read from the GitHub / npm / crates.io
APIs on the date above; sizes are as published by the projects themselves.

## Executive summary

1. **B-rep in the browser is real but heavy.** OpenCascade (OCCT) compiled to wasm is the
   only production-grade B-rep kernel available: the full opencascade.js is 9.1 MB brotli
   (48.9 MB raw), a custom build is 2.4 MB brotli; the newer `occt-wasm` is ~4.5 MB brotli.
   The upstream `opencascade.js` repo has not been pushed since **2023-08-15**; Replicad,
   Chili3D and occt-wasm each maintain their own OCCT wasm builds instead.
2. **Mesh CSG is small and robust.** Manifold (Apache-2.0, npm `manifold-3d` 3.5.1, 2.76 MB
   unpacked) does guaranteed-manifold booleans and is what OpenSCAD's wasm playground uses.
   It has no fillets, no NURBS, no STEP — it is triangles all the way down.
3. **The missing piece — a browser tet mesher — appeared this summer.** `float-tetwild-wasm`
   (fTetWild, MPL-2.0, 5.6 MB, 2026-08-28), `@loumalouomega/gmsh-wasm` (Gmsh 4.x + OCCT,
   GPL-2.0+, ~45 MB raw / ~12 MB without OCCT, 2026-07-29) and `@loumalouomega/mmg-wasm`
   (MMG 5.8, LGPL-3, 1.1 MB, 2026-07-05) are all by one author and weeks old (1–6 stars).
   No TetGen wasm exists (and TetGen is AGPL-3). Netgen runs in Pyodide via NGSolve.
4. **Verdict, geometry v1:** parametric primitives on a structured hex lattice, exactly as
   the Blast Wall demo does (H8 elements, no mesh generation step at all), driven by a tiny
   JSON/TS geometry script the LLM writes. Zero new dependencies, testable today.
5. **Verdict, geometry v1.5:** Manifold CSG of primitives → triangle soup → fTetWild-wasm →
   tet4/tet10 mesh. ~8 MB of wasm, permissive licences, no B-rep needed.
6. **Verdict, geometry v2:** true B-rep via Replicad (MIT; sketch/extrude/revolve/fillet/
   chamfer/booleans/STEP) or brepjs+occt-wasm, tessellate → fTetWild; or Gmsh-wasm on the
   OCCT shape if GPL is acceptable and we want physical groups, size fields and hex options.
7. **Verdict, mesher:** fTetWild-wasm as default (robust to soups and self-intersections, MPL),
   Gmsh-wasm as the "quality/structured/2nd-order" option, Delaunator / triangle-wasm for 2D.
8. **Verdict, formats:** write **VTU** (XML, appended binary) first, then read/write **Gmsh
   .msh 4.1**, then **Abaqus .inp** (CalculiX-compatible) for cross-checking against a real
   solver. STL/glTF for surfaces. STEP import later via `occt-import-js` (7.6 MB wasm).
   Skip XDMF/HDF5 in v1 (h5wasm exists but adds a large HDF5 wasm).
9. **Verdict, AI interface:** code-CAD. Every 2024–2026 paper (Text2CAD, CAD-Recode,
   Text-to-CadQuery, CAD-Coder, Zero-to-CAD) and every shipping product (Zoo's KCL/Zookeeper,
   Onshape's FeatureScript MCP, Aug 2026) converged on "LLM writes a program, kernel executes
   it". Every popular CAD MCP server (blender-mcp 27k stars, freecad-mcp 2k) is essentially
   an `execute_code` tool plus a handful of inspect/screenshot helpers. Do the same.

---

## 1. CAD kernels in the browser

### 1.1 Comparison table

| Project | Kind | Booleans | Fillet/chamfer | Sketch→extrude/revolve | STEP | Wasm size | TS API | Licence | Liveness (2026-09-05) |
|---|---|---|---|---|---|---|---|---|---|
| [opencascade.js](https://github.com/donalffons/opencascade.js) | OCCT B-rep, raw bindings | yes | yes | yes | in/out | 48.9 MB raw / **9.1 MB brotli** full; 7.1 MB / **2.4 MB brotli** custom ([docs](https://ocjs.org/docs/getting-started/file-size)) | auto-generated 1:1 C++ (9.2 MB .d.ts) | LGPL-2.1 | 924★, **last push 2023-08-15**, 77 open issues |
| [Replicad](https://github.com/sgenoud/replicad) | TS code-CAD on OCCT | fuse/cut/intersect | yes | draw/sketch, extrude, revolution, loft, sweep | importSTEP/exportSTEP | own build `replicad-opencascadejs` 0.23; replicad 1.1.0 is 5.4 MB unpacked (JS only) | high-level, fluent | MIT (OCCT LGPL) | 680★, pushed 2026-09-04 |
| [CascadeStudio](https://github.com/zalo/CascadeStudio) | live-scripted OCCT IDE | yes | yes | yes | yes | uses opencascade.js | JS globals | MIT | 1,469★, pushed 2026-09-03 |
| [Chili3D](https://github.com/xiangechen/chili3d) | full browser CAD app | yes | yes | sketch, revolve, sweep, loft | STEP/IGES/BREP/STL | own OCCT **8.0.0** wasm build; size not published | app + plugin/macro system, not a library | AGPL-3.0 (wasm module LGPL-3.0); commercial available | 4,799★, pushed 2026-09-05 |
| [occt-wasm](https://github.com/andymai/occt-wasm) + [brepjs](https://github.com/andymai/brepjs) | OCCT V8 B-rep, modern TS | yes | yes | brepjs: primitives, booleans, fillets; sketching "delegated to brepjs" | STEP/STL/BREP in/out, glTF out | **~4.5 MB brotli** | arena handles, branded types, structured errors, Comlink worker | MIT/Apache-2 tooling; wasm LGPL-2.1 | 49★ / 99★, active (312 / 2,333 commits) |
| [Manifold](https://github.com/elalish/manifold) | mesh CSG | guaranteed-manifold | **no** | extrude/revolve of polygons, hull, minkowski, SDF level set, smooth refine | **no** (3MF, glTF) | npm `manifold-3d` 3.5.1 (2026-06-04), 2.76 MB unpacked | good TS | Apache-2.0 | 2,256★, pushed 2026-09-05 |
| [JSCAD](https://github.com/jscad/OpenJSCAD.org) | JS mesh CSG | yes (slower, JS) | no | extrude/revolve of 2D | no | `@jscad/modeling` 2.13, ~1.5 MB | JS functional | MIT | 3,238★, pushed 2026-09-03, 155 issues |
| [OpenSCAD wasm](https://github.com/openscad/openscad-wasm) / [playground](https://github.com/openscad/openscad-playground) | OpenSCAD language, Manifold backend | yes | no | linear_extrude/rotate_extrude | no | 2022 release: `openscad.wasm` 7.7 MB + 8.2 MB fonts JS (pre-Manifold); current playground size **not found** | none (SCAD text in, STL out) | GPL-2.0 | playground 468★; wasm repo 99 commits |
| [Truck](https://github.com/ricosjp/truck) | Rust B-rep + NURBS | yes | **not mentioned** | sweeps via modeling crate | not in README | `truck-js` wasm bindings | Rust/wasm-bindgen | Apache-2.0 | 1,543★, pushed 2026-08-31 |
| [CADmium](https://github.com/CADmium-Co/CADmium) | browser CAD on Truck | — | — | sketch+extrude | — | — | — | — | **archived**, last push 2025-09-05 |
| [Fornjot](https://github.com/hannobraun/fornjot) | Rust code-CAD kernel | — | — | — | — | — | — | — | **archived 2026-06-19**, "goals not reached" |
| [Zoo / KittyCAD](https://github.com/KittyCAD/modeling-app) | cloud kernel, KCL language | yes | yes | yes | STEP/STL/OBJ/glTF/… export | n/a (engine is server-side, "internet connection required for modeling") | KCL text; REST API | app MIT; **engine closed** | 1,290★, pushed 2026-09-05 |
| Onshape | cloud Parasolid, FeatureScript | yes | yes | yes | yes | n/a (server) | FeatureScript | proprietary | commercial; FeatureScript MCP server Aug 2026 |
| [OCP.wasm](https://github.com/Yeicor/OCP.wasm) (build123d/CadQuery in Pyodide) | OCCT via Python | yes | yes | yes | yes | Pyodide + OCP wheel; size **not found** (no GitHub releases); VTK removed | Python | Apache-2 (build123d) / OCCT LGPL | 45★, 408 commits |
| Plasticity | desktop app on Parasolid | yes | yes | yes | yes | n/a | none for browser | commercial | not a browser option |
| [occt-import-js](https://github.com/kovacsv/occt-import-js) | OCCT import only | — | — | — | **STEP/IGES/BREP → JSON mesh** | **7.6 MB wasm** (npm 0.0.23, 11.6 MB unpacked) | small | LGPL-2.1 | 287★, last push 2024-12-03 |

### 1.2 Notes per kernel

**OpenCascade.js.** The canonical port; every TS code-CAD project (Replicad, CascadeStudio,
BitByBit, ArchiYou) sits on it or on a fork. The maintenance signal is poor — no push since
August 2023, 2.0 still a beta tag on npm — which is why the ecosystem has forked: Replicad
ships `replicad-opencascadejs` (only the API surface Replicad needs), Chili3D compiles OCCT
8.0.0 itself, and `occt-wasm` is a fresh OCCT V8 build with SIMD/tail-calls and a 4.5 MB
brotli payload ("roughly 2x smaller than opencascade.js"). Disabling exceptions cuts ~45%
off the size per the ocjs docs. Load time for the full 9 MB build: "less than a second" on
4G/DSL, ~9 s on good 3G.

**Replicad** is the best TS *API* for an LLM to target on top of OCCT: `draw()`/`Sketcher`
→ `extrude`/`revolution`/`loft`/`genericSweep`, `fuse`/`cut`/`intersect`, `fillet`/`chamfer`/
`shell`/`offset`, `EdgeFinder`/`FaceFinder` for topology selection, `measureVolume`,
`importSTEP`/`exportSTEP`. It runs OCCT in a worker. Fillet/boolean robustness is OCCT's —
the same failures (fillets that fail on tangent edges, booleans that leave slivers) that
desktop OCCT users know; the "Topology-First B-Rep Meshing" paper reports OCCT's own
tessellator fails on 1.56% of ABC and 8.82% of Fusion360 models, a useful proxy for how often
a B-rep→mesh step will need a fallback.

**Manifold** is the opposite trade: it does one thing (exact, guaranteed-manifold mesh
booleans) very fast — a filleted OpenSCAD design that took 1,132 s in CGAL renders in 11 s —
and cannot do the B-rep things: no fillets on existing edges, no NURBS, no face/edge
identity, no STEP. For FEM that is less of a loss than for manufacturing: a tet mesher
consumes a triangle surface anyway. Its `EXT_mesh_manifold` glTF output is the cleanest
surface handoff to a mesher.

**Truck / Fornjot / CADmium (Rust).** Truck is alive and does B-rep+NURBS with booleans, but
fillets and STEP are not advertised, and the two apps built on it (CADmium) or beside it
(Fornjot) are both archived in 2025–2026. Not a v1/v2 option.

**Zoo (KittyCAD)** is the most complete "code-CAD for LLMs" product: KCL is the source of
truth, Zookeeper (shipped Jan 2026) is an LLM loop that generates, executes and debugs KCL.
But the engine is proprietary and server-side, billed by the second; it cannot run in our
page. Worth reading for API design, not for embedding.

**CadQuery / build123d in the browser.** OCP.wasm makes build123d pass "almost 100%" of its
tests under Pyodide (VTK removed). It works, but Pyodide + OCP is tens of MB and Python is a
second runtime next to our TS/WebGPU code. `yet-another-cad-viewer` embeds this as a
playground; `three-cad-viewer` (MIT, 388★) is the standalone tessellated-shape viewer used by
ocp_vscode.

### 1.3 Which to pick for an LLM script API

For an LLM the interface matters more than the kernel. Ranked by "an LLM will write this
correctly first try": OpenSCAD (huge training corpus) > CadQuery/build123d (Python, many
papers) > Replicad/JSCAD (TS, smaller corpus but readable) > KCL/FeatureScript (proprietary,
thin corpus) > raw OCCT bindings (`BRepPrimAPI_MakeBox_2(...)`, 9 MB of .d.ts — hopeless).
Since our stack is TS, **Replicad's vocabulary** (or a small subset of it we define
ourselves) is the right target, with a system prompt that includes the API surface.

---

## 2. Meshing in the browser

### 2.1 Comparison table

| Mesher | Dim | Input | Output | Wasm? | Size | Licence | Liveness |
|---|---|---|---|---|---|---|---|
| [Gmsh](https://gmsh.info/) via [`@loumalouomega/gmsh-wasm`](https://github.com/loumalouomega/GMSH-JS) | 2D/3D, tri/tet/quad/hex (recombine, transfinite, subdivision) | geo or OCC kernel, STEP/IGES/BREP import | .msh, in-memory arrays | **yes, since 2026-07** (342 API functions, OpenMP threads, needs COOP/COEP for threads) | **~45 MB raw with OCCT, ~12 MB minimal** | **GPL-2.0-or-later** (static link) | Gmsh 4.15.2 (2026-03-24); wasm wrapper 1★, created 2026-06-28, pushed 2026-07-29 |
| [fTetWild](https://github.com/wildmeshing/fTetWild) via [`float-tetwild-wasm`](https://www.npmjs.com/package/float-tetwild-wasm) | 3D tet | **triangle soup** (any, incl. self-intersecting, non-manifold) | tets + boundary, epsilon envelope | **yes, 2026-08-28** (v0.2.0, serial + threaded builds; v0.2.0 fixed inverted tet winding) | **5.6 MB unpacked** | MPL-2.0 | upstream 599★, pushed 2026-05; wasm fork 0★ |
| [MMG](https://www.mmgtools.org/) via [`@loumalouomega/mmg-wasm`](https://www.npmjs.com/package/@loumalouomega/mmg-wasm) | 2D/surface/3D **remeshing**, level-set | existing mesh + metric | adapted mesh | yes, 2026-07-05 | **1.1 MB** | LGPL-3.0-or-later | v5.8.0; wrapper 0.1.0 |
| [TetGen](https://wias-berlin.de/software/index.jsp?id=TetGen&lang=1) | 3D CDT tet, quality | PLC (clean, watertight) | tets | **not found** (0 GitHub/npm hits for tetgen+wasm) | — | **AGPL-3.0** (since 1.5.0) | 1.6.0 (2020) |
| [Netgen](https://github.com/NGSolve/netgen) via NGSolve Pyodide | 3D tet, CSG/STEP/STL | OCC or CSG | .vol, in-memory | yes, via [NGSolve JupyterLite](https://docu.ngsolve.org/ngs24/myaddons/lite.html) (Pyodide wheels; 32-bit memory, no umfpack/pardiso, weak threading) | Pyodide + wheels (tens of MB) | LGPL-2.1 | 390★, pushed 2026-09-03 |
| [@itk-wasm/cleaver](https://www.npmjs.com/package/@itk-wasm/cleaver) | 3D multimaterial tet from labeled volumes | voxel/indicator images | tets | yes | — | Apache-2 (ITK) | 0.4.0, 2023-05 |
| CGAL tet meshing / remeshing | 3D | domains, images | tets | **not verified** ("CGAL.js" mentioned only in a blog; no maintained package found) | — | GPL/LGPL mix | — |
| [Triangle](https://www.cs.cmu.edu/~quake/triangle.html) via [`triangle-wasm`](https://github.com/brunoimbrizi/triangle-wasm) | 2D CDT, quality (no small angles) | PSLG | tris | yes | small | Triangle: free for non-commercial, else ask | 1.0.0, **2020-12, inactive** |
| [Delaunator](https://github.com/mapbox/delaunator) | 2D Delaunay only (no constraints) | points | tris | pure JS | tiny | ISC | 2,622★, 5.1.0 (2026-03) |
| [CDT (artem-ogre)](https://github.com/artem-ogre/CDT) | 2D CDT, header-only C++ | PSLG | tris | compilable | small | MPL-2.0 | 1,444★, pushed 2026-08 |
| Rust: [spade](https://crates.io/crates/spade) | 2D Delaunay/CDT, pure Rust | points/edges | tris | wasm-friendly | small | MIT/Apache | 2.15.1 (2026-03), 18.6M downloads |
| Rust: [tritet](https://crates.io/crates/tritet) | 2D/3D via **C Triangle/TetGen** | PLC | tris/tets | FFI to C, TetGen AGPL | — | mixed | 3.2.0 (2026-06), 13k downloads |
| Rust: [delaunay](https://crates.io/crates/delaunay) | D-dim Delaunay, exact predicates | points | simplices | pure Rust | — | — | explicitly "not a replacement for CGAL/TetGen/Gmsh" (no CDT) |
| [meshio++ wasm](https://www.npmjs.com/package/@meshioplusplus/wasm) | I/O only | 42 formats | 42 formats | yes, 2026-09-03 | 15.4 MB (includes libhdf5+libnetcdf) | MIT | 6★, same author as the three above |

The four July–September 2026 wasm packages (gmsh, fTetWild, MMG, meshio++) are all by
Vicente Mataix Ferrandiz (`loumalouomega`, a Kratos Multiphysics developer). That is one
person and a few weeks of history: treat them as "works today, vendor the build" rather than
"depend on npm latest".

### 2.2 The CSG → tet pipeline and its pitfalls

The v1.5 pipeline is: primitives/CSG in Manifold → indexed triangle mesh → fTetWild →
tet4 (or split to tet10) → our solver. Known pitfalls, and why fTetWild is the right pick:

- **Self-intersections / non-manifold soups.** Delaunay-refinement meshers (TetGen, Netgen,
  Gmsh's default 3D algorithms) need a clean, watertight PLC; a soup makes them fail or
  produce garbage. fTetWild's whole point is that it "maintains a valid floating-point
  tetrahedral mesh at all algorithmic stages" and takes "triangle soups" as input. Manifold
  output is already manifold, so both work — but fTetWild also survives STL uploads.
- **Tiny features / slivers.** fTetWild's epsilon envelope (`epsRel`) deliberately smooths
  features smaller than ε·bbox; that is what makes it robust, and it is also what will erase
  a 1 mm chamfer on a 10 m wall. Set ε relative to the smallest feature you care about, and
  check volume against Manifold's exact volume after meshing.
- **Element quality vs. size.** fTetWild optimises an AMIPS energy until `stopEnergy`
  (default ~10); the result is usable for elasticity but not graded — no size fields, no
  boundary layers, no second-order nodes. Gmsh gives size fields, physical groups, hex via
  recombination/subdivision, and tet10 directly, at the cost of GPL and 12–45 MB.
- **Boundary tagging.** Manifold carries per-face "original ID" / vertex properties through
  booleans, and fTetWild returns boundary faces; mapping face → load/BC set is on us. With
  Gmsh, physical groups do this natively.
- **Winding.** float-tetwild-wasm 0.2.0 fixed inverted tets ("silent correctness issue");
  always check `det J > 0` per element on import regardless of source.

### 2.3 What the browser FEA products do

They mesh on the server. SimScale: meshing "runs on cloud computing instances", you choose
the instance size, memory "is the limiting factor in meshing", structural is tets only
(Standard mesher). Fusion 360: since 2022-09-06 "all simulation study types ... will only
have the cloud-solving option". Onshape Simulation (Intact.Simulation) sidesteps meshing
altogether — "No pre-processing or meshing required. We operate directly on Onshape models"
— with a meshfree/immersed solver, also server-side. None of them run a mesher in the page.

---

## 3. Alternatives to CAD + meshing for v1

| Path | What the LLM writes | Mesh step | Dependencies | Time to a testable browser FEA |
|---|---|---|---|---|
| **A. Parametric primitives on a structured lattice** (Blast Wall today) | a JSON/TS parameter block: bricks, openings, supports, loads | none — H8 tiles the lattice exactly; "no tetrahedralisation, no quality metrics, no slivers" (blog post in this repo) | 0 | **already here**; extend with more primitives (plates, beams, cylinders as swept quads, L/T junctions) |
| **B. Voxel / immersed (FCM, CutFEM)** | any implicit or triangle geometry | none — structured background grid, cut cells integrated adaptively, Dirichlet BCs weakly | Manifold or SDF for inside/outside tests | medium: solver work (cut-cell quadrature, conditioning/ghost penalty), not geometry work |
| **C. Code-defined geometry → tets** (Manifold + fTetWild) | Replicad/OpenSCAD-like TS calls | fTetWild-wasm | ~8 MB wasm, Apache-2 + MPL | weeks: wire two wasm libs, add tet4 element and a boundary-tag mapping |
| **D. B-rep code-CAD → tets** (Replicad/occt-wasm + fTetWild or Gmsh) | Replicad TS | tessellate → fTetWild, or Gmsh on the shape | +2.4–9 MB (OCCT) or +12–45 MB (Gmsh, GPL) | months; unlocks fillets, STEP, physical groups |

**Assessment.** Path A gets to a *useful, testable* FEA soonest because it is already
running, its mesh is exact, and H8 is the element explicit codes want anyway. Its limits are
geometric: everything must be a box on a lattice. Path C is the natural next step because
the LLM's script stays the same shape (make primitives, combine them) and the two libraries
are permissive and small; the solver only needs one new element (tet4/tet10). Path B is the
academically attractive one — the FCM review shows it works on both CAD (T-spline propeller)
and voxel (CT metal foam) input — but its difficulties are in the solver (cut-cell
integration, ill-conditioning of small cuts, weak BCs), which is exactly the part we would
rather keep simple in a teaching demo. Path D is v2.

Recommendation: **A now, C next, D when a fillet or a STEP file is the thing blocking a
demo.** Keep the geometry script API stable across A→C→D: a `Geometry` object built by
primitives and booleans, consumed by a `mesh(geometry, options)` step whose implementation
is swapped.

---

## 4. File formats and interop

| Format | Role | Spec / reference | Browser reader/writer | Recommendation |
|---|---|---|---|---|
| **VTU** (VTK XML UnstructuredGrid) | results + mesh for ParaView | [VTK file formats](https://examples.vtk.org/site/VTKFileFormats/): `<Piece>` with Points, Cells (connectivity/offsets/types), PointData/CellData; ascii, base64, or appended raw with `header_type` (UInt32/UInt64) and optional compressor; cell ids tet4=10, hex8=12, tet10=24 | trivial to write by hand (~100 lines TS); meshio++ wasm reads/writes | **write first** — it is how anyone will check our results in ParaView |
| **Gmsh .msh 4.1** | mesh exchange with physical groups | [Gmsh reference manual](https://gmsh.info/doc/texinfo/gmsh.html) §MSH: `$MeshFormat`, `$PhysicalNames`, `$Entities`, `$Nodes` and `$Elements` in entity blocks; ASCII or binary; node tags need not be contiguous; element types tri3=2, tet4=4, hex8=5, tet10=11 | gmsh-wasm writes it; `msh-parser` (TS, 2023) reads; hand parser is ~200 lines | **read+write second** — lets users bring Gmsh meshes and lets us verify against Gmsh |
| **Abaqus .inp** | de facto solver-input exchange; CalculiX reads it | keyword blocks `*NODE`, `*ELEMENT, TYPE=C3D8/C3D4/C3D10`, `*NSET/*ELSET`, `*MATERIAL/*ELASTIC/*DENSITY`, `*BOUNDARY`, `*STEP … *END STEP`; [CalculiX](http://www.calculix.de/) 2.23 (2025-11) "makes use of the abaqus input format" | write by hand; meshio/meshio++ read/write mesh part | **write third** — running the same deck in CalculiX is the cheapest independent check of our solver |
| Nastran BDF | legacy aerospace exchange | GRID/CTETRA/CHEXA cards | meshio, meshio++ | skip in v1 |
| XDMF + HDF5 | large time series (FEniCS/dolfinx native) | XML light data + HDF5 heavy data | [h5wasm](https://github.com/usnistgov/h5wasm) 0.10.3 (146★, pushed 2026-08), memfs/IDBFS/WORKERFS backends, gzip built in; meshio++ wasm includes libhdf5 | skip in v1; add if we ever ingest dolfinx output |
| STEP (AP203/214/242) | B-rep import from real CAD | ISO 10303 | `occt-import-js` 7.6 MB wasm → JSON mesh (last push 2024-12); Replicad `importSTEP`; gmsh-wasm OCC kernel | v2, and only as *import*; we never need to write STEP |
| STL / OBJ / glTF | surfaces in and out | — | native to Manifold (glTF + 3MF preferred; STL "lossy and inefficient"), three.js loaders | STL import (into fTetWild) and glTF export for viewers |
| meshio (Python) | the format zoo reference | [nschloe/meshio](https://github.com/nschloe/meshio): Abaqus, ANSYS, CGNS, Exodus, Gmsh 2.2/4.0/4.1, MED, Nastran, Netgen .vol, OBJ, OFF, PLY, STL, TetGen .node/.ele, SU2, UGRID, VTK, VTU, XDMF … | meshio++ wasm is the browser equivalent (42 formats, MIT, 15.4 MB) | use as the reference for cell-ordering conventions between formats |

Cell-ordering gotcha worth writing down once: VTK, Gmsh and Abaqus agree on tet4 and hex8
corner order, but **tet10 mid-edge node order differs between Gmsh (msh) and VTK/Abaqus**
(Gmsh swaps the last two). meshio's converters are the reference for the permutation.

---

## 5. AI + geometry: is code-CAD the right interface?

### 5.1 Research evidence (2024–2026)

| Work | Representation the model emits | Evidence |
|---|---|---|
| [Text2CAD](https://arxiv.org/abs/2409.17106) (NeurIPS 2024 spotlight) | sketch-extrude sequences (custom tokens) | ~170K models, ~660K text annotations; custom transformer needed |
| [CAD-Recode](https://arxiv.org/abs/2412.14042) (2024-12) | **CadQuery Python code** | "translates a point cloud into Python code"; a *small* LLM suffices as decoder because LLMs already know Python; output is editable/queryable by off-the-shelf LLMs |
| [Text-to-CadQuery](https://arxiv.org/abs/2505.06507) (2025-05) | CadQuery | 170K pairs; fine-tuning six open models; top-1 exact match 58.8% → **69.3%**, Chamfer −48.6%; argues code "eliminates unnecessary conversion steps" |
| [CAD-Coder](https://arxiv.org/abs/2505.19713) (NeurIPS 2025) | CadQuery | SFT + RL with geometric (Chamfer) reward; 110K triplets; CoT planning |
| [CADmium](https://arxiv.org/abs/2507.09792) (2025-07, rev. 2026-01) | JSON CAD sequences | fine-tuned code LMs on >170K models — the outlier that used JSON, not code |
| [Zero-to-CAD](https://arxiv.org/abs/2604.24479) (2026-04) | executable CAD programs | ~1M programs synthesised by an LLM in a **generate → execute → validate** loop, no real data; fine-tuned VLM beats GPT-5.2 on image→CAD |
| [Text2CAD-Bench](https://arxiv.org/abs/2605.18430) (2026-05) | CadQuery (executed in CadQuery 2.4 → STEP → point cloud) | 600 human-curated tasks in 4 levels; models "perform reasonably on basic geometry but degrade substantially on complex topology and advanced features" |

Takeaways: (1) the field moved from custom token sequences (Text2CAD, 2024) to plain
CadQuery code (2025 onward) because pretrained code ability transfers; (2) the *execution
feedback loop* is what makes the difference — Zero-to-CAD and Zookeeper both generate,
run, observe, fix; (3) even in 2026, complex topology (fillets on tangent chains, freeform)
is where it breaks — which is another argument for a v1 vocabulary of boxes and booleans.

### 5.2 Products

- **Zoo:** KCL is "the source of truth"; Zookeeper (2026-01, research note 2026-02-05) is an
  LLM agent — "Plan → Act → Observe results → Update the plan" — that writes and debugs KCL
  against the engine. They chose code "after recognizing how LLMs were beginning to show
  accuracy in writing code" and because it "preserves design intent and enables iterative
  editing".
- **Onshape FeatureScript MCP Server** (Onshape Labs, announced **2026-08-11**): the AI
  client "generates FeatureScript code", inserts it, executes it, reads errors, refines —
  text-to-code-to-CAD, with Claude/ChatGPT/Gemini as clients.

### 5.3 MCP servers: what "expose the app to the LLM" looks like in practice

| Server | Stars / activity | Tools |
|---|---|---|
| [blender-mcp](https://github.com/ahujasid/blender-mcp) (ahujasid) | 27,000★, MIT | `execute_blender_code` (arbitrary Python, `exec()`, unsandboxed — see [issue #207](https://github.com/ahujasid/blender-mcp/issues/207)), `get_scene_info`, `get_object_info`, screenshot, plus asset-search helpers (Poly Haven, Sketchfab, Hyper3D). Architecture: a Blender addon running a TCP socket server + a Python MCP server speaking JSON to it. |
| [freecad-mcp](https://github.com/neka-nat/freecad-mcp) (neka-nat) | 2,017★, MIT, pushed 2026-09-05 | `create_document`, `create_object`, `edit_object`, `delete_object`, `get_object(s)`, **`execute_code`**, `get_view` (screenshot), `insert_part_from_library`, **`run_fem_analysis`** (CalculiX). XML-RPC server inside FreeCAD + MCP bridge. |
| Fusion 360 MCP ([Joe-Spencer](https://github.com/Joe-Spencer/fusion-mcp-server), [faust-machines](https://github.com/faust-machines/fusion360-mcp-server)) | small community servers | Fusion API scripts driven from Claude/Cursor |
| Onshape MCP ([BLamy](https://github.com/BLamy/onshape-mcp), [hedless](https://github.com/hedless/onshape-mcp), PTC FeatureScript MCP) | community + official | REST API wrappers; PTC's exposes FeatureScript generate/insert/execute/refine |

The pattern is identical everywhere: **one `execute_code` tool** (the app's whole scripting
surface becomes available at once), **two or three read-back tools** (scene/object info,
screenshot/render, measurements), and optional convenience helpers. The read-back tools
are what close the loop; without a screenshot or a volume/bbox query the model cannot
"observe results". freecad-mcp's `run_fem_analysis` is the closest existing analogue to what
our lab should expose.

### 5.4 Implications for the FEM lab

1. Define the geometry as a **TS script API** (Replicad-like vocabulary, subset we control),
   executed in a sandboxed Web Worker. That is our `execute_code`.
2. Provide **read-back**: `describe()` (bodies, bbox, volume, mass), `mesh_stats()` (element
   count, min det J, min dihedral), `screenshot()` (WebGPU canvas → PNG), `probe(x,y,z)`.
3. Run the **generate → execute → observe → fix** loop the papers and Zookeeper run; surface
   kernel/mesher errors as text to the model.
4. Keep the v1 vocabulary to primitives + booleans + named faces for BCs/loads, since that is
   where 2026 models are reliable; add fillets/sketches with the B-rep kernel in v2.

---

## 6. Open questions / not found

- No published wasm size for the current OpenSCAD playground build (only the 2022
  `openscad.wasm` 7.7 MB asset, pre-Manifold) or for Chili3D's OCCT 8 module.
- OCP.wasm publishes no GitHub releases, so wheel/wasm size was not verified.
- No TetGen wasm exists; no maintained CGAL wasm package was found.
- gmsh-wasm brotli/gzip sizes are not published (raw 45 MB / 12 MB only); its GPL-2.0+
  applies to anything that statically links it — check this repo's licence before adopting.
- The Text2CAD-Bench abstract gives no per-model success rates; read the paper body before
  quoting numbers.

---

## Sources

CAD kernels
- OpenCascade.js file size: https://ocjs.org/docs/getting-started/file-size
- OpenCascade.js custom builds: https://ocjs.org/docs/app-dev-workflow/custom-builds
- OpenCascade.js repo (GitHub API: 924★, pushed 2023-08-15, LGPL-2.1): https://github.com/donalffons/opencascade.js
- Replicad repo (680★, pushed 2026-09-04, MIT): https://github.com/sgenoud/replicad
- Replicad API reference: https://replicad.xyz/docs/api/
- replicad-opencascadejs on npm (0.23): https://www.npmjs.com/package/replicad-opencascadejs
- CascadeStudio (1,469★, MIT): https://github.com/zalo/CascadeStudio
- Chili3D (4,799★, AGPL-3.0, OCCT 8.0.0): https://github.com/xiangechen/chili3d
- occt-wasm (~4.5 MB brotli, OCCT V8): https://github.com/andymai/occt-wasm
- brepjs (Apache-2.0, 99★): https://github.com/andymai/brepjs
- occt-import-js (287★, last push 2024-12-03): https://github.com/kovacsv/occt-import-js ; wasm 7.6 MB: https://app.unpkg.com/occt-import-js@0.0.23/files/dist/occt-import-js.wasm
- Manifold repo (2,256★, Apache-2.0): https://github.com/elalish/manifold ; docs: https://manifoldcad.org/docs/html/ ; npm manifold-3d 3.5.1: https://registry.npmjs.org/manifold-3d
- OpenSCAD Manifold PR: https://github.com/openscad/openscad/pull/4533
- JSCAD (3,238★, MIT): https://github.com/jscad/OpenJSCAD.org ; @jscad/modeling: https://registry.npmjs.org/@jscad%2Fmodeling
- openscad-wasm (GPL-2.0; 2022 release assets): https://github.com/openscad/openscad-wasm ; https://api.github.com/repos/openscad/openscad-wasm/releases/latest
- openscad-playground (468★, Manifold backend): https://github.com/openscad/openscad-playground
- Truck (1,543★, Apache-2.0): https://github.com/ricosjp/truck
- CADmium (archived 2025-09): https://github.com/CADmium-Co/CADmium
- Fornjot (archived 2026-06-19): https://github.com/hannobraun/fornjot
- Zoo Design Studio app (MIT app, closed engine): https://github.com/kittycad/modeling-app ; FAQ: https://zoo.dev/docs/faq ; KCL: https://zoo.dev/research/introducing-kcl
- OCP.wasm (build123d in the browser): https://github.com/Yeicor/OCP.wasm ; CadQuery discussion: https://github.com/CadQuery/cadquery/discussions/1876
- yet-another-cad-viewer: https://github.com/yeicor-3d/yet-another-cad-viewer
- three-cad-viewer (388★, MIT): https://github.com/bernhard-42/three-cad-viewer
- Plasticity (Parasolid): https://en.wikipedia.org/wiki/Plasticity_(software)
- Onshape architecture (Parasolid + D-Cubed): https://www.onshape.com/en/blog/how-does-onshape-really-work
- OCCT tessellation failure rates (Topology-First B-Rep Meshing): https://arxiv.org/abs/2604.02141
- ModelRift on Manifold vs CGAL timing: https://modelrift.com/blog/why-openscad/

Meshing
- Gmsh reference manual 4.15.2 (licence, MSH format, hex options): https://gmsh.info/doc/texinfo/gmsh.html
- @loumalouomega/gmsh-wasm (npm, 0.3.0, 2026-07-29): https://registry.npmjs.org/@loumalouomega%2Fgmsh-wasm ; repo: https://github.com/loumalouomega/GMSH-JS
- float-tetwild-wasm (0.2.0, 2026-08-28, MPL-2.0): https://registry.npmjs.org/float-tetwild-wasm ; fork: https://github.com/loumalouomega/fTetWild
- fTetWild upstream (599★, MPL-2.0): https://github.com/wildmeshing/fTetWild ; paper: https://dl.acm.org/doi/10.1145/3386569.3392385
- @loumalouomega/mmg-wasm (MMG 5.8.0, 1.1 MB, LGPL-3): https://registry.npmjs.org/@loumalouomega%2Fmmg-wasm
- @meshioplusplus/wasm (42 formats, MIT, 15.4 MB): https://registry.npmjs.org/@meshioplusplus%2Fwasm ; repo: https://github.com/loumalouomega/meshioplusplus
- TetGen licence (AGPLv3 since 1.5.0): https://wias-berlin.de/software/index.jsp?id=TetGen&lang=1
- npm search "tetgen" (0 results) / "tetrahedral": https://registry.npmjs.org/-/v1/search?text=tetgen&size=10 ; https://registry.npmjs.org/-/v1/search?text=tetrahedral&size=15
- GitHub search tetgen+wasm (0 repos): https://api.github.com/search/repositories?q=tetgen+wasm+OR+tetgen+emscripten+OR+tetgen+webassembly
- NGSolve in JupyterLite (Pyodide limits): https://docu.ngsolve.org/ngs24/myaddons/lite.html ; Netgen repo (LGPL-2.1): https://github.com/NGSolve/netgen
- @itk-wasm/cleaver: https://www.npmjs.com/package/@itk-wasm/cleaver
- CGAL tetrahedral remeshing (C++ only): https://doc.cgal.org/latest/Tetrahedral_remeshing/index.html
- triangle-wasm (1.0.0, 2020, inactive): https://github.com/brunoimbrizi/triangle-wasm
- Delaunator (2,622★, 5.1.0): https://github.com/mapbox/delaunator
- CDT (1,444★, MPL-2.0): https://github.com/artem-ogre/CDT
- spade crate: https://crates.io/api/v1/crates/spade ; tritet crate: https://crates.io/api/v1/crates/tritet ; delaunay crate: https://crates.io/crates/delaunay
- SimScale meshing docs (cloud instances): https://www.simscale.com/docs/simulation-setup/meshing/
- Fusion 360 cloud-only solving (2022-09-06): https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Updates-to-the-Fusion-360-Simulation-Extension.html
- Intact.Simulation for Onshape (meshfree): https://intact-solutions.com/innovation/intact-simulation-onshape/

Immersed / structured alternatives
- Finite Cell Method review: https://arxiv.org/abs/1807.01285
- Three-grid immersed FEM for CAD models: https://arxiv.org/html/2401.07823
- This repo, Blast Wall H8 lattice rationale: src/content/blog/a-brick-wall-from-the-weak-form-up.md

Formats
- VTK file formats (VTU, appended binary, cell ids): https://examples.vtk.org/site/VTKFileFormats/
- Gmsh MSH format: https://gmsh.info/doc/texinfo/gmsh.html#MSH-file-format
- CalculiX (Abaqus-format input, 2.23): http://www.calculix.de/
- meshio format list: https://github.com/nschloe/meshio
- h5wasm (146★, 0.10.3): https://github.com/usnistgov/h5wasm ; npm: https://registry.npmjs.org/h5wasm
- msh-parser (TS): https://www.npmjs.com/package/msh-parser

AI + geometry
- Text2CAD (NeurIPS 2024): https://arxiv.org/abs/2409.17106
- CAD-Recode: https://arxiv.org/abs/2412.14042
- Text-to-CadQuery: https://arxiv.org/abs/2505.06507
- CAD-Coder (NeurIPS 2025): https://arxiv.org/abs/2505.19713
- CADmium (paper): https://arxiv.org/abs/2507.09792
- Zero-to-CAD: https://arxiv.org/abs/2604.24479
- Text2CAD-Bench: https://arxiv.org/abs/2605.18430
- Zoo Zookeeper research note (2026-02-05): https://zoo.dev/research/zookeeper ; Text-to-CAD intro: https://docs.zoo.dev/blog/introducing-text-to-cad
- Onshape FeatureScript MCP Server (2026-08-11): https://www.onshape.com/en/blog/featurescript-mcp-server-enables-text-code-cad ; PTC release: https://www.ptc.com/en/news/2026/onshape-launches-featurescript-mcp-server
- blender-mcp (27k★, MIT): https://github.com/ahujasid/blender-mcp ; execute_blender_code issue: https://github.com/ahujasid/blender-mcp/issues/207
- freecad-mcp (2,017★, MIT): https://github.com/neka-nat/freecad-mcp
- Fusion MCP servers: https://github.com/Joe-Spencer/fusion-mcp-server ; https://github.com/faust-machines/fusion360-mcp-server
- Onshape MCP servers: https://github.com/BLamy/onshape-mcp ; https://github.com/hedless/onshape-mcp
