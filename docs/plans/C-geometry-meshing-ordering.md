# Plan C: geometry, meshing, 2D idealisations, and the order of the whole build

Plan, 2026-09-05. Companion to `../PLAN.md`; where the two disagree, this document says so
explicitly in §6 and the owner decides. Vocabulary is `../../CONTEXT.md`; rules are
`../../AGENTS.md`; the physics suite is `../BENCHMARKS.md`.

The owner's goal for this build, verbatim: "a working version with: rust library compiled to
wasm + webgpu; can run native on machine (linux and mac to begin with, but must support
windows eventually, so don't make bad decisions); many analytical cases confirmed to work
with our implementation; should be made so more or less every JTBD can be done in the
library; then a library for geometry building (can be separate); UI that is really great,
that allows for every use case."

Everything below was written against that sentence, and §5 says plainly which of its five
clauses one autonomous session can satisfy and which it cannot.

---

## 0. Summary

1. **Geometry is a boolean tree of primitives evaluated by `manifold-rust`** (pure Rust port of
   Manifold 3.5, Apache-2.0, 42k LOC, compiles to wasm32 with no FFI; verified today). It gives
   exact volume/area/bbox and per-triangle face identity that survives booleans. Not an SDF
   (no face identity), not a B-rep (nothing pure-Rust meshes one). This supersedes ADR 0005's
   "Manifold via JS wasm".
2. **The v1 meshers are mapped (transfinite) quad/hex blocks, extrude and revolve of 2D quad
   meshes, a lattice voxeliser for box trees, and `weka` for free 2D triangles** (pure-Rust
   Triangle port with holes, regions, quality refinement and tri6; MIT; verified today). Every
   classic benchmark in `BENCHMARKS.md` §B–D is a 1–3 block problem by construction; none of
   them needs a general tet mesher.
3. **No 3D tet mesher this session.** There is no pure-Rust quality tet mesher, `tritet` is
   TetGen (AGPL), and `float-tetwild-wasm` is a week old and JS-hosted. tet4/tet10 *elements*
   still ship, tested on hex-split meshes, so LE10's tet10 row is reachable.
4. **`faer` replaces the hand-rolled Cholesky** in PLAN §3.2 (100k-unknown sparse LLT in
   13 ms natively, compiles to wasm32 with `default-features = false`; verified today).
5. **Order: correctness breadth before GPU depth.** 2D/axisymmetric and mapped meshing move
   ahead of the GPU PCG because they produce the most "analytical cases confirmed" per line,
   and the owner's clause 3 is about confirmed cases, not DOF counts. The wgpu device plumbing
   and its CI lane still land in the first hour, because if that lane fails the plan changes.
6. **Formats this session: VTU writer, Gmsh `.msh` 4.1 write and read.** Abaqus `.inp` is
   deferred (it exists only for the manual CalculiX cross-check I1).
7. **Session cut line** (§5): above it are workspace, units, Model/Journal, geometry crate,
   the four meshers, quad4/quad8/tri3/tri6/hex8/hex20 (+ tet4/tet10 by split), plane
   stress/strain/axisymmetric/3D, faer static solve, ~14 Benchmarks, VTU/msh, the CLI, the
   wasm build, a functional viewer + script UI on Pages, and a wgpu kernel lane in CI; GPU
   PCG is the last item above the line and the first to slide. Below it, honestly deferred:
   thermal, modal, explicit, threads in wasm, tets, AI, plugins, report, nonlinear, B-rep,
   shells, Python, server.
8. **PLAN.md assumptions to change** (§6): three.js not Babylon; no Zod/immer in the critical
   path; UI Commands in the registry but never in the Journal; 100 % coverage scoped to the
   pure crates and branch coverage dropped (not measurable on stable); "byte-identical Model
   hash across native and wasm" restricted to inputs, not floats; wasm threads designed-for
   but not built; drop the 0.7 zero-copy spike.

---

## 1. What was verified today

Spikes live under `/private/tmp/claude-501/-Users-anderhaf-projects-personal-homepage/5a59eae6-9aba-4627-a89b-554d1c3f620f/scratchpad/planC-spike/` (`spade-wasm`, `weka-wasm`, `manifold-wasm`, `faer-wasm`), each a `cargo test --release` plus `cargo build --target wasm32-unknown-unknown`. Facts from `cargo info`, `cargo search` and the crate sources; download counts could not be fetched (crates.io API blocked in this sandbox).

| Crate | Version | Licence | wasm32 | What was run | Verdict |
|---|---|---|---|---|---|
| `manifold-rust` | 0.13.1 | Apache-2.0 | builds; deps are pure Rust (`clipper2-rust`, `dashu`, `rustc-hash`) | cube 10³ minus cylinder r=1 through it; volume vs analytic: 2.1e-4 (32 segments), 1.3e-5 (128), 8.1e-7 (512), 15 ms | **use** for the Shape evaluator. Port of Manifold 3.5.0 "exact numerical match" plus a robust exact-rational engine for soups; has extrude, revolve, cross-sections, `original_id`, per-vertex properties, progress/cancel, optional rayon with bit-identical results. Author: Lars Brubaker (MatterHackers). Young (0.13), so pin the version and keep our own volume assertions |
| `weka` | 0.1.0 | MIT | builds; single dep `robust` 1.1 (exact predicates) | Kirsch quarter plate PSLG, min angle 30°, max area 1 / 0.25 / 0.05 → 242 / 692 / 3191 triangles in 0.15 / 0.29 / 1.4 ms; mesh area 99.2159 vs polygonal exact | **use** for free 2D meshing. Triangle port: PSLG, hole seeds, region attributes, Ruppert refinement, `quadratic(true)` for tri6, `refine()` of an existing mesh, boundary markers. 3.8k LOC, one author, 0.1.0: vendor-able if abandoned |
| `spade` | 2.15.1 | MIT/Apache | builds | CDT with `RefinementParameters` (angle limit, max area, `exclude_outer_faces`) | runner-up. Mature and widely used, but no hole seeds, no region attributes, no tri6; refinement caps by default. Keep in mind if `weka` breaks |
| `faer` | 0.24.4 | MIT | builds with `default-features = false, features = ["std"]` | sparse LLT of a 100k tridiagonal SPD system: 13 ms, residual 7e-7 on a solution of magnitude 1.25e9 (relative ~1e-16) | **use** as the CPU direct solver on both hosts; `Par::Seq` on wasm |
| `boolmesh` | 0.1.9 | MPL-2.0 | not tried | — | alternative CSG; requires manifold input, no primitives/extrude/revolve; not needed |
| `tpt-fem-mesh-gen` | 0.1.0 | MIT/Apache | — | — | Bowyer–Watson on point clouds without boundary recovery, plus a box splitter; not a domain mesher |
| `tritet` | 3.2.0 | MIT **or AGPL-3.0** (TetGen) | FFI to C | — | out: AGPL |
| `csgrs` | 0.20.1 | MIT | — | — | BSP-tree CSG, not robust, drags `parry3d`/`geo`; out |
| `truck-modeling` | 0.6.0 | Apache-2.0 | — | — | B-rep/NURBS, no fillets or STEP advertised, the apps on it are archived; not v1 |
| `opencascade` | 0.3.0 | LGPL-2.1 | C++ build | — | out for now (v2, and JS-side Replicad is the easier route then) |
| `mshio` | 0.4.2 | MIT | nom-based, should build | — | candidate `.msh` 4.1 reader; hand-rolling is ~200 lines if it fights wasm |
| `vtkio` | 0.7.0-rc2 | MIT/Apache | — | — | not needed; a VTU writer is ~120 lines |

Toolchain facts: rustc 1.94 stable; **nightly with `rust-src` and `wasm32-unknown-unknown` std is installed on this machine** (the brief said not installed; CI would still need it); `wasm-bindgen-cli` 0.2.128 and `cargo-llvm-cov` 0.9 installed; `wasm-pack`, `wasm-opt`, `naga-cli` absent (use `naga` as a dev-dependency instead of the CLI).

Owner's demos: Blast Wall renders with raw WebGPU and hand-written WGSL; Flow Defence uses `@babylonjs/core`; `sunken`, `three-lefts`, `tidal-locking` use `three` 0.185. Babylon is not the house renderer.

---

## 2. Geometry library: `crates/geometry`

### 2.1 Shape of the crate

Standalone, no dependency on the engine: `serde` + `schemars` on every public type (so the
engine's Commands wrap them without redeclaring), `manifold-rust` and `weka` as the only
non-trivial dependencies, f64 everywhere, no I/O. The engine depends on it; the CLI can expose
`femlab geometry` sub-commands later; a Python binding can wrap it alone. Modules:

```
crates/geometry/src
  shape.rs        Shape tree (primitives, booleans, transforms, extrude/revolve of a Sketch)
  solid.rs        evaluated Solid: Manifold + face tags + exact properties + contains()
  sketch.rs       2D loops of Line/Arc segments, holes, Region2D idealisation
  predicate.rs    FacePredicate / EdgePredicate / RegionPredicate; Set resolution
  mesh.rs         Mesh (nodes, element blocks, boundary faces), quality, det J
  mesher/lattice.rs   box tree → hex8/hex20 on a lattice
  mesher/mapped.rs    transfinite quad and hex blocks, multi-block merge
  mesher/free2d.rs    weka wrapper: Sketch → tri3/tri6
  mesher/sweep.rs     extrude / revolve a quad mesh → hex8/hex20
  mesher/split.rs     hex → 6 tet4, hex20 → tet10 (verification meshes)
  io/vtu.rs, io/msh.rs
```

### 2.2 Representation: a boolean tree evaluated to a `Solid`

```rust
enum Shape {
  Box { size: [f64;3] }, Cylinder { r: f64, h: f64, segments: u32 }, Sphere { r: f64, segments: u32 },
  Extrude { sketch: Sketch, height: f64 }, Revolve { sketch: Sketch, angle_deg: f64, segments: u32 },
  Union(Vec<Shape>), Subtract(Box<Shape>, Vec<Shape>), Intersect(Vec<Shape>),
  Transform(Box<Shape>, Affine3),
}
```

`Solid::evaluate(&Shape)` builds a `manifold_rust::Manifold`, tagging every primitive's faces
before the booleans (box: 6 faces; cylinder: side/top/bottom; sphere: 1; extrude: one side per
sketch edge + two caps; revolve: one per sketch edge + two end caps if angle < 360°) through
Manifold's `original_id`/property channel so a tag survives a boolean where the face survives.
`Solid` exposes: `volume()`, `surface_area()`, `bbox()`, `centroid()` (exact from the triangle
mesh; Manifold's volume is exact for its own mesh, and the mesh is exact for polyhedra, so
`Box`/`Extrude` volumes are exact and curved ones converge with `segments`), `triangles()` for
the viewer, `face_tags()`.

`Shape::contains(p)` is evaluated **analytically on the tree**, not on the Manifold: box,
cylinder, sphere, point-in-polygon for extrude, (r, z)-in-polygon for revolve, composed
through the booleans, transformed by the inverse affine. The lattice mesher voxelises with it.
Consistency test: voxel volume → `Solid::volume()` as the lattice refines (property test over
random trees of aligned boxes: exact; over curved primitives: monotone convergence).

Why not an SDF: an SDF gives inside/outside and a normal, never "which face is this", and
face identity is the entire point of ADR 0005 (loads and constraints attach to named faces;
Sets survive remesh). Why not a B-rep now: nothing pure-Rust meshes one (§1), and the classic
benchmarks do not need fillets or splines. The B-rep path (Replicad/OCCT, JS-hosted) plugs in
later as another `Shape` leaf (`Brep { tessellation, face_tags }`) without touching the rest.

### 2.3 Face naming by predicates

```rust
enum FacePredicate {
  Tag(String),                                   // "plate.xmin", "hole.side"; primitive faces auto-tagged
  Plane { point: [f64;3], normal: [f64;3], tol: f64 },
  Normal { dir: [f64;3], max_angle_deg: f64 },
  Bbox { min: [f64;3], max: [f64;3] },
  Cylinder { point: [f64;3], axis: [f64;3], radius: f64, tol: f64 },
  Sphere { center: [f64;3], radius: f64, tol: f64 },
  All(Vec<FacePredicate>), Any(Vec<FacePredicate>), Not(Box<FacePredicate>),
}
```

Predicates are evaluated **on the boundary faces of the mesh** (centroid, outward normal,
inherited tag) when the mesh is built, never on nodes and never by picking. `Tag` is the
cheap, exact one and is what the UI's click-to-name suggests first; the geometric ones are
what an AI writes from a description ("the face at x = 0"). 2D uses the same enum with
`Circle`/`Line` variants on boundary edges. `RegionPredicate` (`Bbox`, `Inside(Shape)`,
`Body(name)`) selects elements for materials and element sets.

### 2.4 Sets that survive remesh

`Set { name, kind: Face|Edge|Node|Element, predicate }` is stored in the Model; `resolve(&Mesh)
-> Resolved { ids }` is a pure function, cached by mesh hash. A Set that resolves to nothing is
a structured error naming the predicate and the nearest face (by centroid distance), which is
the error an AI can act on. Node sets from face sets are the union of the faces' nodes; corner
nodes shared by two constrained faces are handled by the constraint layer, not the Set.

### 2.5 Transforms

`Affine3` (translate, rotate about axis, scale, mirror) as a `Shape::Transform` node, applied
to the Manifold as a matrix and to `contains` as the inverse. Predicates are in world
coordinates; the auto-tags follow the transformed primitive. Patterns (linear/circular
arrays) are later and are just `Union` of transforms in a script anyway.

### 2.6 2D sketches and idealisations

```rust
struct Sketch { outer: Loop, holes: Vec<Loop> }         // Loop = Vec<Segment>, closed, CCW outer / CW holes
enum Segment { Line { to: [f64;2] }, Arc { center: [f64;2], to: [f64;2], ccw: bool } }
enum Idealisation { PlaneStress { thickness: f64 }, PlaneStrain, Axisymmetric /* x = r ≥ 0, y = z */, Solid3D }
```

Arcs are discretised at mesh time with a chord tolerance derived from the mesh size, so a
finer mesh gets a rounder hole (the Kirsch convergence study depends on this). A `Sketch` is
also the input of `Extrude` and `Revolve`. Axisymmetric enforces x ≥ 0 at validation and r = 0
nodes get the `u_r = 0` constraint automatically.

### 2.7 Meshers

**Mapped (transfinite) blocks** are the v1 workhorse. A `QuadBlock` is 4 corners, 4 optional
edge curves (straight by default; `Arc`, `Polyline`, or `Parametric(fn)` for ellipses), `(n_u,
n_v)` divisions with optional geometric grading, and a Coons-patch interpolation; a `HexBlock`
is 8 corners and 12 edge curves with the 3D transfinite formula (Gordon–Hall). Multi-block
domains merge nodes on shared edges/faces by coordinate hashing at 1e-9·bbox and refuse
mismatched divisions with an error that names both blocks. Output quad4/quad8 or hex8/hex20
directly (mid-edge nodes are placed on the *curved* edge, not the chord: this is what makes
quad8 on LE1 hit 92.7 MPa).

Why this is the right v1 mesher: LE1, LE10, LE11, Lamé, Kirsch, Cook's, MacNeal–Harder,
the twisted beam and FV32 were all published with structured meshes and are 1–3 blocks each
(§7 gives the recipe per case). It is exact, deterministic, has no quality surprises, makes
hex20 trivially, and costs ~600 lines including grading. A general mesher would make every
one of those benchmarks *worse* to reproduce.

**Free 2D (`weka`)**: `Sketch` → PSLG (arcs sampled) + hole seeds + region seeds → tri3 or tri6
with `min_angle` and `max_area` from the requested size; local refinement via a size callback
is not in `weka` 0.1 — approximate with `refine()` passes on elements whose centroid is inside
a refinement `Bbox`/`Sphere` (J4.2, good enough for a plate-with-hole). Quads from triangles
(pairing) are not built; users who want quads on a free domain wait for a later mesher.

**Sweep**: `extrude(quad_mesh, layers, height)` → hex8/hex20 (hex20 adds mid-nodes on the
vertical edges); `revolve(quad_mesh_in_rz, n_theta, angle)` → hex8/hex20, merging the seam at
360°, refusing r = 0 nodes in v1 (solid cylinders use a butterfly block set on the disc and
then extrude; tubes revolve directly).

**Lattice**: box-tree → occupied cells by `contains` at cell centres → hex8/hex20 with shared
nodes and auto-tagged boundary faces (`xmin`…`zmax` plus the primitive tag where the cell face
lies on a primitive face). Exact for lattice-aligned boxes and asserted so; for anything
curved it reports `volume(mesh)/volume(solid)` and the UI shows the drift. This is Blast
Wall's mesher generalised and is still the fastest path for the student cantilever.

**Split** (verification only): hex8 → 6 tet4, hex20 → tet10 (with the correct mid-edge
mapping), so tet elements are tested on real meshes without a tet mesher.

**Not this session**: fTetWild (JS-hosted wasm, one maintainer, or a Rust port later), Gmsh
(GPL, 12–45 MB), any 3D Delaunay. The `Mesher` Extension Point takes `(Solid | Sketch,
settings) -> Mesh` so these plug in later; the tet mesher's job is then only to return
boundary faces with the Manifold face tags, which `manifold-rust` already carries per triangle.

### 2.8 Mesh, quality, det J

`Mesh { nodes: Vec<[f64;3]>, blocks: Vec<ElementBlock { kind, connectivity }>, boundary_faces,
face_tags }`. Every mesher's output passes `det J > 0` at every Gauss point (error with the
element id and its centroid) and computes the quality Query (aspect ratio, min angle / min
dihedral, Jacobian ratio, worst-N with locations) once; J4.5 comes free.

### 2.9 Geometry and mesh Commands (engine side, wrapping the crate's types)

`geometry.add { name, shape: Shape, at?: Affine3 }`, `geometry.subtract { from, shapes }`,
`geometry.union`, `geometry.transform`, `geometry.remove`, `geometry.nameFace { name, of,
where: FacePredicate }`, `geometry.nameEdge`, `geometry.nameRegion`, `sketch.add { name,
outer, holes }`, `mesh.set { mesher: Lattice{size|counts, order} | Mapped{blocks, order} |
Free{size, order, refine[]} | Extrude{of, layers, height, order} | Revolve{of, segments,
angle, order} }`, `mesh.build`, `mesh.import { format: msh, data }`, `mesh.export { format:
vtu|msh }`, `query.geometry` (volume, area, bbox, mass with materials), `query.mesh` (counts,
quality, worst elements), `query.set` (resolved size, bbox, area/length). All Quantities are
unit strings at the boundary (ADR 0008); the crate itself is unit-free SI f64.

---

## 3. Mesh formats

| Format | Direction | Tag | This session | Why / how |
|---|---|---|---|---|
| VTU (XML UnstructuredGrid, appended raw binary, `header_type=UInt64`) | write | **must** | yes | the way anyone checks our fields in ParaView; ~120 lines; cell ids quad4=9, quad8=23, tri3=5, tri6=22, hex8=12, hex20=25, tet4=10, tet10=24 |
| Gmsh `.msh` 4.1 (ASCII) | write | should | yes | lets a Gmsh user verify our mesh and gives the AI a textual mesh; ~150 lines; physical names from Sets |
| Gmsh `.msh` 4.1 | read | should | yes | J4.8/J15.1: bring a Gmsh mesh with physical groups → Sets by name; `mshio` or ~200 lines by hand; **tet10 mid-edge order differs from VTK/Abaqus** (Gmsh swaps the last two): one permutation table, tested both ways |
| Abaqus `.inp` (C3D8/C3D20/C3D4/C3D10/CPS4/CPE4/CAX4 + sets, `*MATERIAL`, `*BOUNDARY`, `*CLOAD`/`*DLOAD`, one static `*STEP`) | write | later | no | exists only for the manual CalculiX cross-check (I1); ~150 lines when wanted |
| STL / glTF | read/write | later | no | STL in only matters once a tet mesher exists; glTF out for viewers is a nicety |
| XDMF/HDF5, Nastran | — | never for now | no | no consumer |

---

## 4. Element and idealisation coverage

Tags: **must** = above the cut line and gated by the named Benchmark; **should** = above the
line if the day allows, otherwise first thing after; **later** = deferred phase.

| Element | Idealisations | Integration | Tag | Justifying Benchmarks |
|---|---|---|---|---|
| quad4 | plane stress, plane strain, axisymmetric | 2×2 Gauss | **must** | A1 patch, A5 bar (2D), C2 Lamé p=1 rows, C4 Cook p=1, B2 MacNeal–Harder quad4 row (recorded), C1 Kirsch coarse |
| quad8 (serendipity) | same | 3×3 (2×2 reduced as an option, recorded not gated) | **must** | C1 Kirsch (K_t 3.00/3.018), C4 Cook, C5 LE1 (92.7 MPa), C2 Lamé p=2, B2 quad8 ≤ 1 % |
| tri3 | same | 1-pt / 3-pt | **must** | A1 patch; `weka` default output; the "linear triangles are stiff" lesson next to tri6 |
| tri6 | same | 6-pt Dunavant (degree 4) | should | C1 Kirsch on a free mesh; C5 LE1 free-mesh row |
| hex8 (full integration) | 3D | 2×2×2 | **must** | A1–A5, B1 cantilever (locking shown), D1 LE10 hex8 row (−29 % recorded) |
| hex8 B-bar / selective reduced (volumetric) | 3D (+ quad4 equivalent for 2D) | mixed | should | C3 near-incompressible cylinder ν → 0.5; the locking-free row |
| hex8 incompatible modes | 3D | — | later | B1 "improved hex8 does not lock" row waits; hex20 already teaches the J4.3 lesson |
| hex20 (serendipity) | 3D | 3×3×3 (2×2×2 reduced optional) | **must** | B1 hex20 within 0.5 %, D1 LE10 −5.38 MPa at 2 %, C2 Lamé 3D revolve, D4 manufactured p=2 |
| tet4 | 3D | 1-pt | should | A1 patch on split meshes; the "tets too stiff" warning (J4.3) |
| tet10 | 3D | 4-pt (degree 2) | should | D1 LE10 tet10 row on a split hex20 mesh |
| hex27, quad9 | — | — | later | no Benchmark asks for them |
| Shells (MITC4), beams (Timoshenko) | — | — | later | G-series; a separate phase |

Idealisations: **plane stress** (thickness), **plane strain**, **axisymmetric** (r = x, z = y,
strain ε_θθ = u_r / r, 2π r weighting, r = 0 handled by Gauss points never sitting on the
axis) and **3D** are all must; Lamé is the case that exercises all four against one closed
form and is the best single test of the idealisation layer.

Stress recovery: at Gauss points, extrapolated to nodes with the standard inverse shape
functions, averaged per node (with the unaveraged element field kept for J8.7). Loads:
pressure (normal, follows the face), traction (vector, total-force option J5.4), point force
on a node set, gravity/body force; all as consistent nodal loads through the face shape
functions, so quad8/hex20 faces carry quadratic pressure distributions correctly (LE1 and
LE10 both apply pressure on curved quadratic faces).

---

## 5. End-to-end build order and the session cut line

Sizes: **S** ≤ ~300 lines with tests, **M** ~300–1000, **L** > 1000. "Ships" is what is
demonstrably true when the commit lands; every commit is green and self-contained (AGENTS.md).
Order is the dependency order; the numbering is the commit sequence.

### 5.1 Above the line: Line A (must ship)

| # | Commit | Depends on | Size | Ships / gate |
|---|---|---|---|---|
| 1 | **Workspace.** Cargo workspace `crates/{geometry,engine,engine-wasm,femlab}`, npm workspace `packages/{registry,app}`, MIT licence, CI: `cargo test`, `clippy -D warnings`, `cargo llvm-cov` on `geometry` + `engine` (excluding `gpu/`), matrix `ubuntu-latest` + `macos-latest` + `windows-latest` (Windows allowed-to-fail from day one: the cheapest way to honour "don't make bad decisions") | – | S | CI green on an empty workspace |
| 2 | **Units.** `Quantity` parse/format/dimension check/SI normalisation in `crates/engine/src/units.rs`; `schemars` schema as `{ value, unit }` or string; proptest `parse∘format = id`; wrong dimension is an error | 1 | M | B: property tests |
| 3 | **Model + Command enum + Journal.** `enum Command` (serde + schemars, doc comments), `Model` (geometry, sets, materials, constraints, loads, steps), `apply`, `Journal` (append, replay, undo by Model snapshot, `as_script()` → the Command list in a stable text form), `model_hash()` over the *inputs*; JSON Schema emitted to `packages/registry/schema.json` by a test | 2 | M | A8 replay property test; every Command has a doc string (test enumerates) |
| 4 | **CLI `femlab run <journal.json>`** replays and prints `query.model`; **`engine-wasm`** exposes `apply(json) -> json`, `query(json) -> json`, typed-array views of Results; CI builds both and runs the same Journal through both, compares `model_hash` | 3 | S | the engine is a library with two hosts before any numerics exist |
| 5 | **wgpu device plumbing + kernel lane.** `Engine::new(gpu: Option<wgpu::Device>, ...)`, `shaders/axpy.wgsl`, `shaders/dot.wgsl` via `include_str!`, `naga` validation as a unit test, native test on Mesa lavapipe in CI (`continue-on-error` until green three times), wasm build of the same kernel in Playwright Chromium (SwiftShader flags) asserting identical results to the native run | 4 | M | ADR 0007's claim is true or the plan changes now, while it is cheap |
| 6 | **Geometry crate: Shape → Solid.** `manifold-rust` evaluation, face tags, exact properties, `contains`, transforms; property tests: volume of aligned-box trees exact; curved volumes converge in `segments`; `contains` agrees with voxel volume | 1 | M | `query.geometry` correct for every primitive and a boolean |
| 7 | **Predicates and Sets.** `FacePredicate`/`RegionPredicate`, resolution against mesh boundary faces, structured "empty Set" error | 6 | S | a Set survives a remesh at three sizes (test) |
| 8 | **Mesh + lattice mesher + det J + quality.** `Mesh` type, `Mesh::from_arrays` (test constructor), lattice hex8/hex20, quality Query, VTU writer | 6, 7 | M | student cantilever meshes; VTU opens in ParaView (documented, not CI) |
| 9 | **Elements I: hex8, hex20, quad4, quad8, tri3** with plane stress / plane strain / axisymmetric / 3D constitutive matrices; consistent loads; stress recovery | 2 | L | A1 patch tests (all six modes, every element), A2 rigid modes, A3 eigenvalues of K_e, proptest "K symmetric PSD for random admissible shapes" |
| 10 | **Assembly + solve.** CSR f64 assembly (loops written as `iter()` behind a `par` shim so rayon is a feature flip), Dirichlet elimination with reactions, `faer` LLT (`Par::Seq` on wasm), f64 Jacobi-PCG fallback, well-posedness checks (no material, empty Set, det J ≤ 0, rigid modes by null-space probe), `step.add`, `solve.run`, post (displacement, stress fields, von Mises, principal, extremes with location, reactions per constraint, probe) | 3, 8, 9 | L | A4 operator symmetry, A5 bar, A7 reaction balance on every case, B1 cantilever hex8/hex20 h-convergence at the theoretical rate with locking shown |
| 11 | **Mapped mesher + sketches.** `Sketch`, `QuadBlock`/`HexBlock` transfinite with curved edges and grading, multi-block merge, quad4/quad8 output, 2D boundary predicates, `constraint.symmetry` | 7, 8 | M | C4 Cook's (1 block), C2 Lamé plane strain (1 polar block) and axisymmetric (1 rectangle), C1 Kirsch quarter plate (3 blocks, quarter = full test), B2 MacNeal–Harder regular/trapezoid/parallelogram |
| 12 | **Sweep mesher.** extrude/revolve quad → hex8/hex20 | 11 | M | C2 Lamé 3D by revolve agrees with the 2D rows; D1 LE10 hex20 (elliptical quad block extruded) at 2 %, hex8 row recorded |
| 13 | **LE1 + the elliptical edge curve** (`Parametric` edge), pressure on curved quadratic faces | 11 | S | C5 LE1 σyy(D) = 92.7 MPa at 2 % (quad8) |
| 14 | **`study.converge`** Command: rerun at n sizes, quantity of interest, observed rate; `femlab bench` runs every Benchmark and emits the `BENCHMARKS.md` status table | 10–13 | S | every Benchmark above is also a convergence study |
| 15 | **UI, functional.** Vite + TypeScript, engine-wasm in a Worker, three.js viewer (mesh edges, per-vertex scalar contour with legend and units, deformed scale, face pick → suggested `geometry.nameFace` Command), left panel = Model tree from `query.model`, bottom = script editor (`textarea` + run, sucrase lazy) and live Journal-as-script, undo/redo, Examples menu populated from the Benchmarks, "no WebGPU" notice; `window.fem` = registry (Commands, Queries, `toToolDefinitions()`) so Chrome DevTools MCP can drive it today | 4, 14 | L | the proposal's success story runs by hand; Playwright smoke: load, run example, contour visible |
| 16 | **GitHub Pages deploy** + homepage project card | 15 | S | link works in Chromium |

### 5.2 Above the line: Line B (target; first to slide, in this order from the bottom)

| # | Commit | Depends on | Size | Ships / gate |
|---|---|---|---|---|
| 17 | **Free 2D mesher (`weka`) + tri6** | 11 | M | C1 Kirsch and C5 LE1 on free meshes; tri3 vs tri6 lesson |
| 18 | **tet4/tet10 by split** | 9, 12 | S | A1 patch; D1 LE10 tet10 row |
| 19 | **Gmsh `.msh` 4.1 write + read** (Sets ↔ physical names, tet10 permutation) | 8 | S | round-trip property test |
| 20 | **D4 manufactured solution** (body-force Load from a closed-form field, L2/H1 norms) | 10, 14 | M | rates p+1 / p ± 0.1 for hex8/hex20/quad4/quad8 |
| 21 | **B-bar hex8/quad4** | 9 | S | C3 near-incompressible cylinder monotone, < 2 % |
| 22 | **GPU PCG.** Matrix-free hex8 operator in WGSL (per-element K_e gather, no atomics), Jacobi preconditioner, f32 PCG with f64 iterative refinement on the CPU, `solver: 'gpu-pcg'` | 5, 10 | L | B1 to 1e-8 relative of the faer answer; `gpu.test` operator symmetry and rigid modes; runs in CI on lavapipe; D5 timing is manual |

### 5.3 The cut line, and what it says about the owner's five clauses

**Everything above (1–16 firm, 17–22 if the day allows) ships in this session.** Below the
line is deferred with a reason; nothing there blocks the static-structural core.

| Owner's clause | Above the line | Honest gap |
|---|---|---|
| Rust library → wasm + WebGPU | `engine-wasm`, wgpu device injection, kernels validated and run in CI natively and in Chromium (5); GPU PCG (22) | if 22 slides, WebGPU is "plumbed and proven", not "solving"; say so in the README |
| Native on Linux and Mac, Windows-safe | CLI, CI matrix incl. Windows allowed-to-fail; no `unsafe`, no platform APIs outside the CLI; wgpu abstracts DX12 | Windows lane is not gated |
| Many analytical cases confirmed | ~14 Benchmarks (§7) with tolerances and convergence rates, `femlab bench` table | thermal, modal, explicit, nonlinear cases are not confirmed |
| Every JTBD doable in the library | J1.2–1.4, J2.1 (primitives/booleans), J2.6, J2.8, J3.2, J4.1, J4.3–4.6, J4.8–4.9, J5.1–5.4, J6.1, J6.11, J7.5–7.6, J8.1–8.3, J8.7, J8.9, J9.1–9.4, J13.1–13.2, J13.5, J15.1 | J5.5/J6.4 thermal, J6.2 modal, J6.5–6.8 nonlinear/dynamics, J13.3–13.8 plugins, J13.4 AI, J11 report, J2.3 CAD import: **not in one session**; the Extension Point seams (Element, Mesher, Procedure, MaterialLaw as traits with the built-ins as the only implementations) are in place so they are additions, not rewrites |
| A really great UI for every use case | a complete, scriptable, undoable UI for the static workflow, with examples and contours | "great" is iteration on real use; §5.4 lists the deferred UI work |

### 5.4 Below the line, in the order they should land afterwards

1. **Steady heat + convection** (E1, E2 VM97, C7 T4) — the smallest next procedure; a scalar
   Laplacian over the same elements, Robin BC. Then thermal strain into static (A6, C8, D2 LE11).
2. **Modal** (B4, C6 FV32, D3 FV52): shift-invert with faer LLT + Lanczos/LOBPCG on CPU first.
3. **Explicit** (F1, F2): port the Blast Wall integrator as `procedure: explicit`.
4. **wasm threads** (ADR 0013): nightly `build-std` in CI, `wasm-bindgen-rayon`, coi-serviceworker; the `par` shim from commit 10 becomes rayon.
5. **AI**: tool definitions already exist (`toToolDefinitions()` in 15); in-page agent, `run_script`, eval suite, `femlab mcp`.
6. **Tets**: fTetWild (JS-hosted wasm behind the Mesher point) or a Rust port; STL import.
7. **Plugins** (phase P), **report/share/compare** (phase 5), **nonlinear** (6), **B-rep** (7), **shells/beams/studies/library** (8), **server** (S), **Python** (Py) — as PLAN.md orders them.
8. UI: CodeMirror, section cuts, animations, side-by-side compare, material library forms.

### 5.5 How big is "one long session", honestly

Line A is roughly 9–11k lines of Rust and TypeScript including tests, Line B another 3–4k.
That is more than any single sitting that built the owner's demos; it is reachable only
because the geometry and solver crates carry their own libraries (`manifold-rust`, `weka`,
`faer`) and because the Benchmarks double as the tests. If the session is shorter than
hoped, the honest stopping points are after 10 (a verified 3D lattice solver with CLI and
wasm), after 14 (all 2D/axi Benchmarks green), and after 16 (deployed UI). Do not start 22
unless 1–16 are committed.

---

## 6. Challenges to PLAN.md

| # | Assumption in PLAN.md / ADRs | Why it is weak | Recommendation |
|---|---|---|---|
| 1 | Babylon.js is the viewer ("used in the owner's other demos") | Only Flow Defence uses Babylon; Blast Wall is raw WebGPU; three demos use three.js. Babylon core is ~4 MB vs three.js ~600 kB; the FEA viewer needs custom vertex-scalar shaders, edges, picking and a clip plane, which both do; the LLM corpus for three.js is far larger, which matters when an agent writes the UI. The viewer never needs WebGPU; WebGL2 is the robust choice and keeps the render device separate from wgpu's compute device (they cannot share one on the web anyway) | **three.js (WebGL2 renderer)** for the viewer; drop "Babylon" from AGENTS.md/ADR 0011/0012 wording |
| 2 | 100 % coverage "lines, branches, functions, statements" on the engine | `cargo llvm-cov` on stable reports line/region/function; **branch coverage needs nightly `-Z coverage-options=branch`**. GPU code (`gpu/`) cannot be covered on a CPU-only runner beyond what lavapipe runs, and a 100 % gate from the first commit slows an autonomous agent more than it catches | 100 % *line and function* on `crates/geometry` and the pure modules of `crates/engine` (`model, commands, journal, units, mesh, fem, post`); `gpu/`, `engine-wasm`, `femlab` excluded by `--ignore-filename-regex` and covered by their CI lanes; state that in AGENTS.md |
| 3 | Sparse Cholesky "simplicial, CSparse-style, ~500 lines" hand-rolled | Leftover from the TypeScript plan. `faer` 0.24 has supernodal LLT/LDLT with AMD, is MIT, pure Rust, compiles to wasm32 (verified) and solved 100k unknowns in 13 ms | `faer` on both hosts; keep a 60-line f64 Jacobi-PCG as the fallback and the independent cross-check |
| 4 | "CI runs the same Journal through the native and the wasm build and compares Model hashes" / "replays byte-for-byte" | True only for *inputs*. `f64::sin/cos` go through different libms on wasm and macOS, so cylinder node coordinates and any Result can differ in the last ulp; a hash over floats will flap | `model_hash` covers Commands and Model parameters (exact); meshes and Results are compared with tolerances; say "the Model replays identically; Results agree to 1e-12" |
| 5 | Journal-as-model is fine for large meshes | The Journal holds Commands, so size is not the problem; the problem is `solve.run` in a Journal: replay-on-open must not re-solve, and undo past a solve must orphan Results, not recompute | Journal replay skips `solve.*` unless asked; Results keyed by `model_hash`; snapshot = Model only. Already implied by ADR 0003, make it a test |
| 6 | Schema codegen: "the build emits JSON Schema and generated TypeScript types" via `tools/` | A custom codegen tool is a project. `schemars` → JSON Schema is one test; JSON Schema → `.d.ts` is `json-schema-to-typescript` (npm) in one script | No `tools/schema-codegen`; one Rust test writes `schema.json`, one npm script makes `commands.d.ts`; the AI tool list *is* `schema.json` |
| 7 | Threads in wasm via `wasm-bindgen-rayon` are part of the core plan (ADR 0013, rule 9) | Needs nightly + `build-std` + `+atomics,+bulk-memory` + a service-worker reload on Pages + Worker plumbing; nightly is on this machine but not in CI; none of the Benchmarks needs it; the GPU is the parallelism story in the browser | Design for it (all loops through a `par` shim, fixed-order reductions, tests at 1 and N threads *natively*), build it after the line. Native rayon lands with the shim |
| 8 | Manifold + fTetWild as JS-hosted wasm behind the Mesher (ADR 0005, PLAN 3.1–3.2) | `manifold-rust` removes the JS hop, the FFI and the 2.8 MB vendored module, and gives the geometry crate to the native CLI and Python for free; fTetWild stays the open question | Amend ADR 0005: geometry evaluation is `manifold-rust` in `crates/geometry`; tets are a later Mesher, JS-hosted or ported, decided when a demo needs an STL |
| 9 | Zod 4 + immer are needed for the registry | If Rust owns the engine schema and undo, the TS side only has a handful of UI Commands (camera, selection, panel state). Zod/immer are then two dependencies for ~10 schemas and view state that is not undoable anyway | No Zod/immer in this session; UI Commands are plain `{ name, description, inputSchema: JSON Schema, run }` objects merged into the same tool list. Add Zod only if forms need runtime validation of user input |
| 10 | "Every capability is a Command… including UI actions", and "the Journal is the model" | Two rules collide unless stated: camera moves must be callable by an AI (registry) but must not be replayed on open (Journal). ADR 0003 already says camera is view state | Registry = engine Commands ∪ UI Commands; **Journal = engine Commands only**; a test asserts no UI Command ever lands in a Journal. Write it in AGENTS.md |
| 11 | Phase order: GPU (phase 2) before 2D/geometry (phase 3) | 2D/axi + mapped meshing yields ~8 Benchmarks for ~1.5k lines; GPU PCG yields zero new confirmed cases (it must match the CPU answer). The owner's clause 3 is about confirmed cases | Order in §5: geometry and 2D first, GPU device lane early (cheap, de-risks), GPU PCG last |
| 12 | Phase 1 hex8 "with incompatible modes or selective reduced integration so a linear hex bends" | Incompatible modes (Wilson/Taylor) is a real formulation with a stabilisation story; not needed to teach the lesson when hex20 exists | hex8 full + hex20 in Line A; B-bar in Line B (for C3, where it is the point); incompatible modes later |
| 13 | 0.7 "a Result of 1M f32 values crosses to Babylon without a copy" | The renderer uploads to its own GPU device anyway; a wasm-memory view is already zero-copy on the JS side; 4 MB is nothing | Drop the spike; document "typed-array view, one GPU upload" |
| 14 | `naga-cli` / dawn.node lanes | `naga-cli` is not installed and not needed: `naga` as a dev-dependency validates every `include_str!` shader in a unit test; dawn.node only matters for TS-side kernels, of which there are none once the engine is Rust | One `naga` test; two GPU lanes (native lavapipe, Playwright Chromium), not three |
| 15 | Phase 3.1 "Manifold CSG … exact volume Query matches analytical for primitives" | Only true for polyhedra; cylinders and spheres are tessellated (8e-7 at 512 segments). A student's "volume" must not be off by 1e-4 silently | `segments` is a mesh setting shown in the UI; `query.geometry` reports the analytic volume for primitives and the tessellated volume for booleans, labelled |
| 16 | Cook's membrane reference "21.520 vs 23.9 — resolve" | Both numbers are in circulation for different ν/idealisations; hard-coding either is a coin flip | Gate Cook's on Richardson self-convergence (rate and extrapolated value stable to 0.5 %) and *report* both literature values next to ours; resolve later against the arXiv paper's stated setup |

---

## 7. Benchmarks reachable this session

Recipes name the mesher of §2.7. "Line" refers to §5.

| Case | Mesh recipe | Elements / idealisation | Line | Note |
|---|---|---|---|---|
| A1 patch tests | `Mesh::from_arrays`, single distorted element per type | all must/should elements, all idealisations | A | tri6/tet4/tet10 rows in B |
| A2 rigid-body modes, A3 eigenvalues of K_e | single element | hex8 (and every element as a proptest) | A | `faer` dense `selfadjoint_eigen` |
| A4 operator symmetry | any Benchmark mesh | — | A (CPU), B (GPU) | random u, v |
| A5 uniaxial bar | lattice 1×1×10 and mapped 1×10 (2D) | hex8, quad4 plane stress, axisymmetric rod | A | three idealisations, one closed form |
| A6 free thermal expansion | lattice box | hex8 | later | needs the thermal-strain Load (with steady heat) |
| A7 reaction balance | every case | — | A | |
| A8 Journal replay | every case | — | A | inputs-hash, see §6 #4 |
| B1 cantilever tip deflection | lattice 2×4×40, refined ×2, ×4 | hex8 (locking), hex20; quad8 plane-stress twin | A | Timoshenko correction in the reference |
| B2 MacNeal–Harder straight beam | mapped 1 block, corners moved for trapezoid/parallelogram | quad4, quad8; hex8/hex20 by extrude | A | 0.1081 in; quad4 row recorded |
| B3 twisted beam | `HexBlock` with twisted edge curves (or extrude with per-layer rotation) | hex8/hex20 | B/later | reference values still to verify (BENCHMARKS) |
| B4 cantilever modal, B5 buckling, B6 elastica | — | — | later | modal / nonlinear procedures |
| C1 Kirsch plate with hole | mapped 3 blocks around the quarter hole (arc edges) + `constraint.symmetry`; free `weka` tri6 as the second recipe | quad8, tri6 | A (mapped), B (free) | K_t 3.00 infinite / 3.018 VM142 geometry; refinement by grading toward the hole |
| C2 Lamé thick cylinder | plane strain: 1 polar block (arc edges), axisymmetric: 1 rectangle in r–z, 3D: revolve of the rectangle 90° with symmetry | quad4/quad8, hex8/hex20 | A | the idealisation-layer test |
| C3 near-incompressible cylinder | same as C2 | quad4 B-bar, quad8 | B | ν = 0.49 / 0.499 / 0.4999 |
| C4 Cook's membrane | mapped 1 block (4 corners) | quad4, quad8 | A | gate on Richardson, report both literature values (§6 #16) |
| C5 LE1 elliptic membrane | mapped 1 block with `Parametric` elliptical edges (inner and outer ellipses), pressure on the outer edge | quad8 (quad4 row recorded) | A | 92.7 MPa at D |
| C6 FV32 tapered membrane modal | mapped 1 block | quad8 | later | modal |
| C7 T4, C8 T1 | mapped / free | — | later | heat |
| D1 LE10 thick plate | LE1's elliptical quad block extruded 2 layers (hex20), 4 layers | hex20 (must), hex8 row recorded, tet10 by split | A (hex), B (tet10) | −5.38 MPa at D |
| D2 LE11 cylinder/taper/sphere | axisymmetric 3-block mapped (arc edge for the sphere) | quad8 axi | later | needs temperature field T(r,z) as a Load |
| D3 FV52 | lattice plate | — | later | modal; reference set unresolved |
| D4 manufactured solution | lattice and mapped (distorted) | hex8/hex20, quad4/quad8 | B | rates p+1 (L2), p (H1) |
| D5 1M-DOF cantilever | lattice | hex8 | B (22), timing manual | |
| E, F, G, H, I | — | — | later | |

Count: **14 Benchmark ids green in Line A** (A1–A5, A7, A8, B1, B2, C1, C2, C4, C5, D1), five
more in Line B (A4-GPU, C3, D4, D5, C1/C5 free-mesh rows, D1 tet10).

---

## 8. Risks and open decisions

| Risk / decision | Recommendation |
|---|---|
| `manifold-rust` and `weka` are young (0.13.1, 0.1.0), one author each | Pin exact versions; our own volume/area/`det J` assertions on every mesh; both are pure Rust and small enough (`weka` 3.8k LOC) to vendor into `crates/` if abandoned. `spade` is the fallback for 2D |
| Face tags through booleans: does Manifold keep a tag on every triangle of a surviving face after `difference`? | Verify in commit 6 with a test (box minus cylinder: `xmin`…`zmax` and `hole.side` all resolve); if a tag is lost on a split face, fall back to the geometric predicate, which the test also exercises |
| Multi-block merge tolerance and mismatched divisions | Refuse mismatches with a named error; the Kirsch 3-block recipe is the test |
| Axisymmetric r = 0 | Gauss points never sit on the axis; nodes at r = 0 get `u_r = 0` automatically; Lamé's inner radius is > 0 so the first exposure is LE11 (later) |
| `faer` on wasm without threads | `Par::Seq`; the fallback PCG covers pathological sizes; measure the 200k-DOF LLT time in wasm before promising it in the UI |
| Lavapipe lane flaky | `continue-on-error` until three green runs; the native and Chromium lanes are independent evidence |
| wgpu 30 web backend + a separate three.js WebGL2 context | No shared device is attempted; one upload of the result array to the renderer per solve |
| Windows | No platform code outside `crates/femlab`; `windows-latest` in the matrix allowed-to-fail; path handling via `std::path` only |
| Coverage gate slowing the session | Scope per §6 #2; ratchet, never lower |
| Cook's, FV52, MacNeal–Harder twisted beam references | Gate on self-convergence; report literature values; resolve before hard-coding (BENCHMARKS.md already flags them) |
| Licence posture | Everything above the line is MIT/Apache-2.0; the only copyleft candidates (Gmsh GPL, fTetWild MPL, OCCT LGPL) are below the line and JS-hosted if adopted |
| The AI surface without the AI | `toToolDefinitions()` and `window.fem` ship in 15 so Chrome DevTools MCP can drive the app; the in-page agent is deferred, not the API |

Open decisions for the owner:

1. three.js instead of Babylon (§6 #1). Default in this plan: three.js.
2. `.inp` writer in-session or not. Default: not; it serves one manual check.
3. Whether to accept the coverage scoping in §6 #2 and the Journal/registry split in §6 #10 as edits to AGENTS.md before the build starts. Default: yes, in the first commit.
4. Whether GPU PCG (22) or the free mesher/tet split (17–18) has priority when time runs short. Default in this plan: 17–21 before 22, because they add confirmed cases; flip it if "solving on WebGPU" is the demo that matters most on day one.
