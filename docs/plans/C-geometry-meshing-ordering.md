# Plan C: geometry, meshing, 2D idealisations, and the order of the whole build

Plan, 2026-09-05; reviewed the same day (see `## Review log` at the end). Companion to
`../PLAN.md`; where the two disagree, this document says so explicitly in §6 and the owner
decides. Vocabulary is `../../CONTEXT.md`; rules are `../../AGENTS.md`; the physics suite is
`../BENCHMARKS.md`. **This plan owns the master commit order (§5); plan A owns the numerics
detail and plan B owns the registry/hosts/UI detail.** Where A, B and C disagree, §6 picks one.

The owner's goal for this build, verbatim: "a working version with: rust library compiled to
wasm + webgpu; can run native on machine (linux and mac to begin with, but must support
windows eventually, so don't make bad decisions); many analytical cases confirmed to work
with our implementation; should be made so more or less every JTBD can be done in the
library; then a library for geometry building (can be separate); UI that is really great,
that allows for every use case." Also required: multithreading designed in; 100 % coverage
on the engine; plugin Extension Points; exports to VTU, Gmsh `.msh`, Abaqus `.inp`, STL,
CSV, PNG/SVG, script and report. A designer designs the UI from `docs/DESIGN-BRIEF.md`
before any UI is built, so the UI commits sit behind a design gate in §5.

Everything below was written against that sentence, and §5.3 says plainly which of its five
clauses one autonomous session can satisfy and which it cannot.

---

## 0. Summary

1. **Geometry is a boolean tree of primitives evaluated by `manifold-rust`** (pure Rust port of
   Manifold, Apache-2.0, 42k LOC, compiles to wasm32 with no FFI; verified). It gives exact
   volume/area/bbox for polyhedra and **per-triangle source-face identity that survives
   booleans and transforms** (verified in the review spike: `(run_original_id, face_id)` of the
   result maps every triangle back to a tagged primitive face). Not an SDF (no face identity),
   not a B-rep (nothing pure-Rust meshes one). This supersedes ADR 0005's "Manifold via JS wasm".
2. **The v1 meshers are: mapped (transfinite) quad blocks with curved edges, extrude and
   revolve of a 2D quad mesh, a lattice voxeliser for box trees, and `weka` for free 2D
   triangles** (pure-Rust Triangle port with hole seeds, region attributes, Ruppert refinement,
   tri6 and boundary markers; MIT; verified). Every classic benchmark in `BENCHMARKS.md` §B–D is
   a 1–2 block problem by construction; none needs a general tet mesher. A `HexBlock` is not
   built: extrude/revolve of quad blocks covers every 3D case above the line.
3. **No 3D tet mesher this session.** There is no pure-Rust quality tet mesher, `tritet` is
   TetGen (AGPL), and `float-tetwild-wasm` is a week old and JS-hosted. tet4/tet10 *elements*
   still ship (plan A's `Iso<R>` implements all eight kinds at once), tested on hex-split
   meshes, so LE10's tet10 row is reachable.
4. **`faer` replaces the hand-rolled Cholesky** in PLAN §3.2 (100k-unknown sparse LLT in
   13 ms natively, compiles to wasm32 with `default-features = false`; verified). Plan A's
   feature list `["std", "sparse-linalg"]` is adopted (the `sparse` module is unconditional in
   0.24.4, so `["std"]` alone also compiles; the explicit list is clearer).
5. **Order: correctness breadth first, GPU solve above the cut line.** 2D/axisymmetric and
   mapped meshing come before the GPU CG because they produce the most "analytical cases
   confirmed" per line. The wgpu device plumbing, one kernel and both CI lanes land in the first
   hours (commit 9); the f32 CG with f64 refinement (commit 26) is **above the cut line**,
   because the owner asked for wasm + WebGPU *working*, not plumbed. It is behind the whole
   static-correctness core so that if the session ends early the thing that exists is correct.
6. **Formats this session: VTU (engine, base64 XML), Gmsh `.msh` 4.1 write + read, Abaqus
   `.inp` write, STL write of the geometry surface, script (`as_script`), CSV and PNG from the
   host.** SVG and the report are with the report phase; STL/glTF *import* waits for a tet mesher.
7. **One master sequence** (§5.1, 37 commits above the cut line, 1–27 and 31–32 firm, 28–30
   target, 33–37 behind the design gate; then §5.4 in order). Honest stopping points after 19,
   27, 32 and 37. The UI commits (33–37) cannot start before the design returns; §5.2 says what
   the coder does meanwhile.
8. **PLAN.md / A / B assumptions changed here** (§6): three.js not Babylon; Zod for host
   Commands only, no immer; UI Commands in the registry but never in the Journal; 100 %
   line/function/region coverage measured the way plan A does it (GPU code covered by running
   it on lavapipe, not excluded), with an explicit interim rule while that lane is
   `continue-on-error`; "byte-identical Model hash across native and wasm" restricted to inputs,
   not floats; wasm threads designed-for (the `par` shim, rayon natively) but built after the
   line; drop PLAN 0.7's zero-copy spike; the `Mesh` type lives in `crates/geometry` and A's
   `mesh::structured` builders move there; one VTU writer (Rust), not two.

---

## 1. What was verified

Spikes live under the session scratchpad: `planC-spike/{spade-wasm, weka-wasm, manifold-wasm,
faer-wasm}` (author) and `reviewC-spike/{manifold-faces, weka-tri6}` (review), each a
`cargo test --release` plus `cargo build --target wasm32-unknown-unknown`. Facts from
`cargo info`, the crate sources and the spikes; download counts could not be fetched (crates.io
API blocked in this sandbox).

| Crate | Version | Licence | wasm32 | What was run | Verdict |
|---|---|---|---|---|---|
| `manifold-rust` | 0.13.1 | Apache-2.0 | builds; deps are pure Rust (`clipper2-rust`, `dashu-int`/`dashu-ratio`, `num-traits`, `rustc-hash`, optional `rayon`) | cube 10³ minus cylinder r=1: volume vs analytic 2.1e-4 (32 segments), 1.3e-5 (128), 8.1e-7 (512), 15 ms; volume is *exact* against the tessellated cylinder (968.7855 = 1000 − 32·½·sin(2π/32)·10). **Review spike:** after `difference` every result triangle's `(run_original_id, face_id)` maps to a tagged face of its source primitive (box: 6 tags; cylinder: 32 side facets share tag `side`, caps vanish for a through-hole); `union` keeps both run ids; `translate`/`rotate` keep `run_original_id` in the MeshGL (but `Manifold::original_id()` returns −1 after a transform, C++ semantics: **always read the run id from `get_mesh_gl()`**); `extrude` of a 4-gon gives exactly 6 `face_id`s (one per side + 2 caps) and volume exact to 1e-12 | **use** for the Shape evaluator. Has `cube`, `cylinder`, `sphere`, `extrude(polygons, height, divisions, twist, scale_top)`, `revolve(polygons, segments, degrees)`, `union/difference/intersection`, `translate/rotate/scale/mirror/transform`, `volume`, `surface_area`, `bounding_box`, `get_mesh_gl` with `run_index`, `run_original_id`, `face_id`, `set_properties`, progress/cancel, optional rayon. Author: Lars Brubaker (MatterHackers), one maintainer; young (0.13): pin the exact version and keep our own volume/tag assertions |
| `weka` | 0.1.0 | MIT | builds; single dep `robust` 1.1 (exact predicates) | Kirsch quarter plate PSLG, min angle 30°, max area 1 / 0.25 / 0.05 → 242 / 692 / 3191 triangles in 0.15 / 0.29 / 1.4 ms. **Review spike:** full plate with an interior 32-gon hole via `Pslg::holes` seed; `quadratic(true)` gives `corners_per_triangle = 6` and `edge_nodes: Vec<[usize;3]>` per triangle **ordered as Triangle emits them: `edge_nodes[k]` is the midpoint of the edge opposite corner k** (so Abaqus CPS6 mid-nodes are `[e2, e0, e1]`); `segment_markers` propagate to every split boundary segment (hole: 32 marked edges, `xmin`: 12 → 34 with refinement); mesh area equals the polygon area to 1e-12 | **use** for free 2D meshing. Triangle port: PSLG, hole seeds, region attributes, Ruppert refinement (`min_angle`, `max_area`), tri6, `refine()` of an existing mesh, boundary markers. 5.3k LOC (not 3.8k), one author (Tom Simpson), 0.1.0: vendor-able if abandoned |
| `spade` | 2.15.1 | MIT/Apache | builds | CDT with `RefinementParameters` (angle limit, max area, `exclude_outer_faces`) | runner-up. Mature and widely used, but no hole seeds, no region attributes, no tri6; refinement caps by default. Fallback if `weka` breaks |
| `faer` | 0.24.4 | MIT | builds with `default-features = false`; `features = ["std"]` (spike) and `["std", "sparse-linalg"]` (plan A) both compile: `pub mod sparse` is unconditional, `sparse-linalg` only pulls `linalg` | sparse LLT (`sp_cholesky`) of a 100k tridiagonal SPD system: 13 ms, residual 7e-7 on a solution of magnitude 1.25e9 (relative ~1e-16) | **use** as the CPU direct solver on both hosts; `Par::Seq` on wasm; plan A's wrapper |
| `boolmesh` | 0.1.9 | MPL-2.0 | not tried | — | alternative CSG; requires manifold input, no primitives/extrude/revolve; not needed |
| `tpt-fem-mesh-gen` | 0.1.0 | MIT/Apache | — | — | Bowyer–Watson on point clouds without boundary recovery, plus a box splitter; not a domain mesher |
| `tritet` | 3.2.0 | MIT **or AGPL-3.0** (TetGen) | FFI to C | — | out: AGPL |
| `csgrs` | 0.20.1 | MIT | — | — | BSP-tree CSG, not robust, drags `parry3d`/`geo`; out |
| `truck-modeling` | 0.6.0 | Apache-2.0 | — | — | B-rep/NURBS, no fillets or STEP advertised, the apps on it are archived; not v1 |
| `opencascade` | 0.3.0 | LGPL-2.1 | C++ build | — | out for now (v2, and JS-side Replicad is the easier route then) |
| `mshio` | 0.4.2 | MIT | nom-based, should build | — | candidate `.msh` 4.1 reader; hand-rolling is ~200 lines if it fights wasm |
| `vtkio` | 0.7.0-rc2 | MIT/Apache | — | — | not needed; a VTU writer is ~120 lines |

Toolchain facts: rustc 1.94 stable; **nightly with `rust-src` and `wasm32-unknown-unknown` std is installed on this machine** (the brief said not installed; CI would still need it); `wasm-bindgen-cli` 0.2.128 and `cargo-llvm-cov` 0.9 installed; `wasm-pack`, `wasm-opt`, `naga-cli` absent (use `naga` as a dev-dependency instead of the CLI).

Node-ordering facts that the writers depend on (checked against the VTK, Gmsh and Abaqus
tables): **VTK's quadratic orderings equal Abaqus's for all eight kinds** (tri6, quad8, tet10,
hex20), so VTU needs no permutation. **Gmsh differs for tet10 (nodes 8 and 9 swapped) and for
hex20 (all twelve mid-edge nodes reordered)**; tri6 and quad8 are identical. weka's tri6 needs
the `[e2, e0, e1]` permutation above.

Owner's demos: Blast Wall renders with raw WebGPU and hand-written WGSL; Flow Defence uses `@babylonjs/core`; `sunken`, `three-lefts`, `tidal-locking` use `three` 0.185. Babylon is not the house renderer.

---

## 2. Geometry library: `crates/geometry`

### 2.1 Shape of the crate

Standalone, no dependency on the engine: `serde` + `schemars` on every public type (so the
engine's Commands wrap them without redeclaring), `manifold-rust` and `weka` as the only
non-trivial dependencies, f64 everywhere, **no I/O (not even writers: the format writers live in
the engine, §3)**. The engine depends on it; the CLI can expose `femlab geometry` sub-commands
later; a Python binding can wrap it alone. It also owns the `Mesh` type and the structured
builders that plan A §2 puts in `crates/engine/src/mesh/` — one `Mesh`, one builder (see §6 #17).
Modules:

```
crates/geometry/src
  shape.rs        Shape tree (primitives, booleans, transforms, Sheet/Extrude/Revolve of a Sketch)
  solid.rs        evaluated Solid: Manifold + (run_id, face_id) → tag map + exact properties + contains()
  sketch.rs       2D loops of Line/Arc segments, holes
  predicate.rs    FacePredicate / RegionPredicate; Set resolution against a Mesh
  mesh.rs         Mesh (plan A §2: coords stride 3, ElementBlock{kind, conn, first_elem}, node/elem/face sets,
                  Abaqus ordering + face tables, validate, node_to_elems, boundary_faces, bbox)
  surface.rs      Surface for the viewer: boundary triangles + body id + face-set id per triangle
  mesher/structured.rs  plan A's Structured::build(map), box_, perturb_interior, split_to_simplices,
                        annulus, elliptic_annulus (moved here verbatim; tests come with them)
  mesher/lattice.rs     box tree → hex8/hex20 on a lattice
  mesher/mapped.rs      QuadBlock (corners, edge curves, grading, tags) → the map closure for structured.rs;
                        multi-block merge
  mesher/free2d.rs      weka wrapper: Sketch → tri3/tri6 with boundary tags from segment markers
  mesher/sweep.rs       extrude / revolve a quad mesh → hex8/hex20
  quality.rs            det J at Gauss points (reuses the engine? no: a 20-line Jacobian here), aspect,
                        min angle/dihedral, Jacobian ratio, worst-N
```

`ElementBlock` here is `{ kind: ElementKind, conn: Vec<u32>, first_elem: u32 }`; plan A's
`formulation`, `idealisation` and `material` per block move to a parallel `Vec<BlockProps>` in
the engine's `Problem` (A §6), so the geometry crate knows nothing about FEM. `ElementKind`
(8 kinds), `Face { elem, local }`, `FaceKind` and the Abaqus tables are A §2's definitions,
unchanged, just in this crate.

### 2.2 Representation: a boolean tree evaluated to a `Solid`

```rust
enum Shape {
  Box { size: [f64;3] }, Cylinder { r: f64, h: f64, segments: u32 }, Sphere { r: f64, segments: u32 },
  Sheet { sketch: Sketch },                         // a 2D body (plane stress/strain/axisymmetric domain)
  Extrude { sketch: Sketch, height: f64 }, Revolve { sketch: Sketch, angle_deg: f64, segments: u32 },
  Union(Vec<Shape>), Subtract(Box<Shape>, Vec<Shape>), Intersect(Vec<Shape>),
  Transform(Box<Shape>, Affine3),
}
```

`Solid::evaluate(&Shape)` builds a `manifold_rust::Manifold` leaf per primitive and, **before any
boolean**, classifies that leaf's own `get_mesh_gl()` triangles geometrically into a
`BTreeMap<(run_original_id, face_id), Tag>`: box by dominant normal → `xmin … zmax`;
cylinder by `|n_z|` → `side | top | bottom`; sphere → `surface`; extrude → `side.<k>` for the
facet whose midpoint lies on sketch segment k (a whole `Arc` segment is one tag, however many
chords it was sampled into) plus `top | bottom`; revolve → `<segment k>` plus `cap0 | cap1` if
angle < 360°. After the booleans, the result MeshGL's `(run_original_id, face_id)` per triangle
is looked up in the union of the leaf maps; a miss is an internal error (the spike shows none;
the test asserts none on box−cylinder, box∪box and extrude−cylinder). `Manifold::original_id()`
is **not** used: it is −1 for anything but an untouched original. A named `geometry.add`
body's tags become face Sets `<body>.<tag>` (§2.4); a `geometry.subtract { name }` cut's tags
become `<name>.<tag>` (so the hole wall is `hole.side`).

`Solid` exposes `volume()`, `surface_area()`, `bbox()`, `centroid()` (exact for the triangle
mesh, which is exact for polyhedra, so `Box`/`Extrude` volumes are exact and curved ones
converge with `segments`), `triangles()` + `triangle_tags()` for the viewer and the STL
writer, and `body_of_run(run_id)` for multi-body unions.

`Shape::contains(p)` is evaluated **analytically on the tree**, not on the Manifold: box,
cylinder, sphere, point-in-polygon for sheet/extrude, (r, z)-in-polygon for revolve, composed
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
#[serde(tag = "kind", rename_all = "camelCase")]
enum FacePredicate {
  /// Boundary faces whose centroid satisfies n·c = offset (within tol, default 1e-6·bbox diagonal)
  /// and whose outward normal is within 10° of ±n. In 2D the same thing selects boundary edges on a line.
  Plane { normal: [f64;3], offset: Q<Length>, tol: Option<Q<Length>> },
  /// Boundary faces whose outward normal is within max_angle_deg (default 10°) of `normal`.
  Normal { normal: [f64;3], max_angle_deg: Option<f64> },
  /// Boundary faces whose centroid lies inside the box.
  Bbox { min: [Q<Length>;3], max: [Q<Length>;3] },
  /// Boundary faces whose centroid is at distance `radius` (± tol) from the axis line. Axis z in 2D = a circle.
  Cylinder { point: [Q<Length>;3], axis: [f64;3], radius: Q<Length>, tol: Option<Q<Length>> },
  Any(Vec<FacePredicate>),
}
#[serde(tag = "kind", rename_all = "camelCase")]
enum RegionPredicate { Bbox { min: [Q<Length>;3], max: [Q<Length>;3] }, Body { name: String } }
```

This is plan B §2.4's enum (same serde tagging, `Q<Length>` fields) extended with `Cylinder`
and `Any`, which Kirsch/Lamé/LE1 need to name curved boundaries without auto-tags. Struck from
the author's draft: `Tag` (auto-tagged faces are already Sets by name, `plate.xmin`, so a
predicate for them is redundant), `Sphere`, `All`, `Not`, a separate `EdgePredicate` and 2D
`Circle`/`Line` variants (the same enum evaluates on boundary edges in 2D), and
`RegionPredicate::Inside(Shape)` (no case needs it). Predicates are evaluated **on the boundary
faces of the mesh** (centroid, outward normal from the Abaqus face tables, body) when the mesh
is built, never on nodes and never by picking. The UI's click-to-name proposes the auto-name
first (`on: "plate.xmin"`), else a `Plane` from the picked point and normal (B §7.2); the
geometric ones are what an AI writes from a description ("the face at x = 0").

### 2.4 Sets that survive remesh

`Set { name, kind: Face|Node|Element, source: AutoTag | Predicate }` is stored in the Model;
`resolve(&Mesh) -> Resolved { ids }` is a pure function run when the mesh is (re)built. A Set
that resolves to nothing is `Error { code: EmptySet }` naming the predicate and the nearest
boundary face (by centroid distance), which is the error an AI can act on. Node sets from face
sets are the union of the faces' nodes; corner nodes shared by two constrained faces are handled
by the constraint layer (`constraint.conflict` only on *conflicting values*, A §4), not by the
Set. Face sets are `Vec<Face { elem, local }>`, never node lists (A Q4: pressure needs the
face's shape functions).

How mesh faces get their auto-tag, per mesher:

- **Mapped / sweep / free**: no Solid needed. A `QuadBlock` edge carries an optional tag; the
  merge keeps tags only on edges that stay on the boundary. `Extrude` adds `bottom`/`top`,
  `Revolve` adds `theta0`/`theta1` (if angle < 360°). The free mesher tags each `Sketch`
  segment (`outer.<k>` / `hole<i>.<k>`, or a user tag on the segment) through weka's
  `segment_markers`, which propagate to every split segment (verified).
- **Lattice**: a boundary cell face lying on the body's bbox plane gets `xmin … zmax`;
  otherwise it gets the tag of the nearest `Solid` triangle (centroid distance < ½ cell, normal
  within 45°). Exact for aligned box trees; approximate for curved bodies, which the lattice
  approximates anyway.

### 2.5 Transforms

`Affine3` (translate, rotate about axis, scale, mirror) as a `Shape::Transform` node, applied
to the Manifold as a matrix and to `contains` as the inverse. Predicates are in world
coordinates; the auto-tags follow the transformed primitive (`run_original_id` survives a
transform, verified). Patterns (linear/circular arrays) are later and are just `Union` of
transforms in a script anyway.

### 2.6 2D sketches and idealisations

```rust
struct Sketch { outer: Loop, holes: Vec<Loop> }         // Loop = Vec<Segment>, closed, CCW outer / CW holes
enum Segment { Line { to: [f64;2], tag: Option<String> }, Arc { center: [f64;2], to: [f64;2], ccw: bool, tag: Option<String> } }
enum Idealisation { Solid3D, PlaneStress { thickness: f64 }, PlaneStrain, Axisymmetric /* x = r ≥ 0, y = z */ }
```

Arcs are discretised at mesh time with a chord tolerance derived from the mesh size, so a
finer mesh gets a rounder hole (the Kirsch free-mesh convergence depends on this). A `Sketch`
is the input of `Sheet` (2D body), `Extrude` and `Revolve`. **Idealisation is a Model setting**
(`model.setIdealisation`, §2.9; plan B has no such Command and needs one), default `Solid3D`;
a `Sheet` body with `Solid3D` is an `IllPosed` error and vice versa. Axisymmetric enforces
x ≥ 0 at validation and r = 0 nodes get the `u_r = 0` constraint automatically; the engine's
element handles ε_θθ at r → 0 (A §3.2).

### 2.7 Meshers

**Mapped (transfinite) quad blocks** are the v1 workhorse.

```rust
struct QuadBlock {
  corners: [[f64;2];4],                 // c0..c3 CCW; the block's (u,v) unit square maps c0→c1 along u, c0→c3 along v
  edges: [Curve;4],                     // edge k joins c_k → c_{k+1}; Line by default
  n: [u32;2],                           // divisions along u and v
  grading: [f64;2],                     // geometric ratio along u and v, 1.0 = uniform; > 1 packs nodes toward the u=0 / v=0 side
  tags: [Option<String>;4],             // face-set tag per edge
}
enum Curve { Line, Arc { center: [f64;2], ccw: bool }, Ellipse { center: [f64;2], semi_axes: [f64;2] } }
```

Mapping: parameters `u_i = (1 − r^i)/(1 − r^n)` for ratio r (uniform when r = 1), then the Coons
patch `x(u,v) = (1−v) E0(u) + u E1(v) + v E2(1−u) + (1−u) E3(1−v) − [(1−u)(1−v) c0 + u(1−v) c1 + uv c2 + (1−u)v c3]`
with `E_k(t)` the point at fraction t along edge k (arc: by angle; ellipse: by parametric angle
between the two corners' angles; line: linear). That closure is handed to A's
`Structured::build(map)`, which numbers nodes `id = j·(n_u+1) + i` and emits quad4 elements
`[n(i,j), n(i+1,j), n(i+1,j+1), n(i,j+1)]` (Abaqus CPS4, CCW) or quad8 by evaluating the map at
half-integer parameters (A §2: **mid-edge nodes lie on the curve, not the chord**; this is what
makes quad8 on LE1 hit 92.7 MPa). Multi-block domains merge nodes on shared edges by
sort-based coordinate quantisation at 1e-9·bbox (deterministic) and refuse mismatched divisions
or grading with an error naming both blocks. A `Curve::Parametric(fn)` is **not** offered: a
closure cannot live in a Command or a Journal; `Ellipse` is the one non-circular curve any
benchmark needs (LE1/LE10). `HexBlock` is not built this session (no case uses it; the twisted
beam B3 is later).

**Mapped blocks are geometry.** `mesh.set { mesher: Mapped { blocks } }` needs no `geometry.add`:
the Body is the union of the blocks, named by `mesh.set { body }` (default `"sheet"`), and each
tagged block edge becomes the face Set `<body>.<tag>`. If a `Sheet` Shape exists as well,
`query.mesh` reports `volume(mesh)/volume(solid)` so the two cannot silently disagree.

Why this is the right v1 mesher: LE1, LE10, Lamé, Kirsch, Cook's and MacNeal–Harder were all
published with structured meshes and are 1–2 blocks each (§7 gives the recipe per case). It
is exact, deterministic, has no quality surprises, makes quad8/hex20 trivially, and costs
~500 lines including grading and merge on top of A's builder. A general mesher would make
every one of those benchmarks *worse* to reproduce.

**Free 2D (`weka`)**: `Sketch` → PSLG (arcs sampled to the chord tolerance) + one hole seed per
hole loop (its centroid, or the midpoint of the first segment pushed inward when the centroid
is outside) + `segment_markers` = tag ids → tri3, or tri6 with `quadratic(true)` and the
`[e2, e0, e1]` permutation to Abaqus order; `min_angle` 30° and `max_area = ½·size²`. Local
refinement via a size callback is not in `weka` 0.1: `mesh.set { refine: [Bbox { min, max, size }] }`
is approximated by a `refine()` pass with `triangle_area_constraints` set on triangles whose
centroid is inside the box (J4.2, good enough for a plate-with-hole). Quads from triangles are
not built.

**Sweep**: `extrude(quad_mesh, layers, height)` → hex8 (each layer copies the quad4 nodes) or
hex20 (**layer k at integer height uses all 8 quad8 nodes; the half-height layer uses only the 4
corner nodes** — a hex20 has no mid-face nodes). `revolve(quad_mesh_in_rz, segments, angle)` →
hex8/hex20 about the z axis (x = r); hex20 circumferential mid-nodes sit at the half angle, so
they lie on the arc; the seam is merged at 360°; r = 0 nodes are refused in v1 (solid cylinders
use a butterfly block set on the disc and then extrude; tubes revolve directly). Tags:
`bottom`/`top` (extrude), `theta0`/`theta1` (revolve, angle < 360°), plus the quad edges' tags
swept into side faces.

**Lattice**: box-tree → occupied cells by `contains` at cell centres → hex8/hex20 (cell-edge
midpoints) with shared nodes and auto-tagged boundary faces (§2.4). Exact for lattice-aligned
boxes and asserted so; for anything curved it reports `volume(mesh)/volume(solid)` and the UI
shows the drift. This is Blast Wall's mesher generalised and is still the fastest path for the
student cantilever.

**Split** (verification only): A's `split_to_simplices` (hex8 → 6 tet4 Kuhn, hex20 → tet10 with
the correct mid-edge mapping, quad → 2 tri, quad8 → tri6), so tet/tri elements are tested on
real meshes without a tet mesher. Not a separate commit: it moves with A's builder (commit 10).

**Not this session**: fTetWild (JS-hosted wasm, one maintainer, or a Rust port later), Gmsh
(GPL, 12–45 MB), any 3D Delaunay. The `Mesher` Extension Point takes `(&Solid | &Sketch,
&MeshSettings) -> Result<Mesh>` so these plug in later; a tet mesher's only extra job is to
return boundary faces with the Solid's triangle tags, which `manifold-rust` already carries per
triangle.

### 2.8 Mesh, quality, det J

`Mesh` is plan A §2's struct (in this crate). Every mesher's output passes `validate()` and
`det J > 0` at every Gauss point (error with the element id and its centroid; the engine's
element repeats the check and is the authoritative one) and computes the quality Query
(aspect ratio, min angle / min dihedral, Jacobian ratio, worst-N with locations) once; J4.5
comes free. `Surface` (boundary triangles, body id, face-set id per triangle) is what the viewer
and the STL writer consume; B's `surface_*` accessors read it.

### 2.9 Geometry and mesh Commands (engine side, wrapping the crate's types)

Plan B §2.2 is the Command table; these are the geometry/mesh rows it defers to phase 3, made
concrete and reduced to what the cases need. B's `geometry.addBox`/`subtractBox` are
**replaced** by the two generic Commands (a tagged `Shape` union in the schema is one tool
with one good doc string, not eight):

| Command | Fields | Notes |
|---|---|---|
| `model.setIdealisation` | `idealisation: solid3d \| planeStress { thickness: Q<Length> } \| planeStrain \| axisymmetric` | new; default `solid3d`; B lacks it |
| `geometry.add` | `name`, `shape: Shape` (all lengths `Q<Length>`), `at?: Affine3` | auto face Sets `<name>.<tag>` (§2.2) |
| `geometry.subtract` | `from: body`, `name`, `shape`, `at?` | the cut's faces are `<name>.<tag>` (`hole.side`) |
| `geometry.remove` | `name` | B's semantics (`InUse`) |
| `geometry.nameFace` | `name`, `of: body`, `where: FacePredicate` | §2.3; 2D: boundary edges |
| `geometry.nameRegion` | `name`, `where: RegionPredicate` | B's |
| `mesh.set` | `mesher: Lattice { size \| counts } \| Mapped { body?, blocks: [QuadBlock] } \| Free { of: body, size, refine?: [..] } \| Sweep { base: Mapped \| Free, extrude: { layers, height } \| revolve: { segments, angle } }`, `order: 1 \| 2`, `element?: ElementType` | B's `order`/`element` kept; `ElementType` gains quad4/quad4-im/quad8/tri3/tri6/tet4/tet10 |
| `mesh.import` | `format: "msh"`, `text` | physical names → Sets (§3) |
| `mesh.export` | `format: vtu \| msh \| inp \| stl`, `step?` | returns the file as a `String` (§3); the host saves it |
| `query.mesh` | – | B's `MeshSummary` + `quality` + `volumeRatio` |
| `query.set` | `name` | B's |

Struck from the author's draft: `geometry.union/intersect/transform` (express them in the
`Shape` tree), `geometry.nameEdge` (2D edges are the boundary "faces"), `sketch.add` (a Sketch
is a `Shape::Sheet` or an `Extrude` argument), `mesh.build` (the mesh is rebuilt lazily, B §2.1),
`query.geometry` (B's `query.model` bodies row gains `area` and `centroid`). All Quantities are
unit strings at the boundary (ADR 0008); the crate itself is unit-free SI f64.

---

## 3. Mesh formats

All writers live in `crates/engine/src/io/` and return a `String`, so one code path serves the
CLI, the wasm host and a future server without a bytes channel; the host saves the text
(B's `file.exportVTU` becomes "call `mesh.export`, download the string" — B's separate TS VTU
writer is struck, §6 #18).

| Format | Direction | Tag | This session | Why / how |
|---|---|---|---|---|
| VTU (XML UnstructuredGrid, `format="binary"` = base64 with `header_type="UInt64"`, so the file is text) | write, with point fields (u, σ nodal averaged, von Mises, principal, reactions) and cell fields (σ per element, det J) | **must** | yes (commit 19) | the way anyone checks our fields in ParaView; ~150 lines; VTK cell ids quad4=9, quad8=23, tri3=5, tri6=22, hex8=12, hex20=25, tet4=10, tet10=24; **no node permutation: VTK's quadratic orderings are Abaqus's** |
| Gmsh `.msh` 4.1 (ASCII) | write | should | yes (commit 30) | lets a Gmsh user verify our mesh and gives the AI a textual mesh; ~150 lines; physical names from Sets; **permutations: tet10 swaps nodes 8↔9, hex20 reorders all twelve mid-edge nodes; tri6/quad8 identical** — one `permutation(kind, Convention)` table (A R10), tested both ways |
| Gmsh `.msh` 4.1 | read | should | yes (commit 30) | J4.8/J15.1: bring a Gmsh mesh with physical groups → Sets by name; `mshio` or ~200 lines by hand; same permutation table |
| Abaqus `.inp` (C3D8/C3D8I/C3D20/C3D4/C3D10/CPS4/CPS8/CPE4/CPE8/CAX4/CAX8/CPS3/CPS6 + `*NSET`/`*ELSET`/`*SURFACE`, `*MATERIAL`, `*BOUNDARY`, `*CLOAD`/`*DSLOAD`, one static `*STEP`) | write | should | yes (commit 30) | the owner lists it; the mesh is already in Abaqus order so it is ~150 lines; the CalculiX cross-check I1 stays manual and documented |
| STL (ASCII) of the geometry surface | write | should | yes (commit 30) | `Solid::triangles()`; ~40 lines; J15.4 |
| Script | write | must | yes (commit 6) | B's `Journal::as_script`, exists |
| CSV of any table (extremes, reactions, probe, path, study) | write | should | host Command `file.exportCSV` (commit 36) | ~30 lines in TS over the Query result |
| PNG of the viewer | write | should | host Query `query.screenshot` (commit 34) | B §4.3 |
| SVG (legend, XY plots), Markdown/PDF report | write | later | no | with the report phase (PLAN 5.7) |
| STL / glTF | read | later | no | STL in only matters once a tet mesher exists |
| XDMF/HDF5, Nastran | — | never for now | no | no consumer |

---

## 4. Element and idealisation coverage

Reconciled with plan A §0/§3: **all eight reference elements are one generic `Iso<R>` and land
together (master commits 12–14)**, so "must/should" below is about which *Benchmark rows* gate
above the line, not about whether the element exists. Tags: **must** = gated above the cut
line by the named Benchmark; **should** = above the line if the day allows (commits 28–30),
otherwise first thing after; **later** = deferred phase.

| Element | Idealisations | Integration (A §3.1) | Tag | Justifying Benchmarks |
|---|---|---|---|---|
| quad4 (`quad4` = QM6 incompatible modes, `quad4-full` = the locking lesson) | plane stress, plane strain, axisymmetric | 2×2 Gauss | **must** | A1 patch (perturbed, both formulations), A5 bar (2D), C2 Lamé p=1 rows, C3 near-incompressible (quad4-im < 2 %, quad4-full recorded), C4 Cook p=1, B2 MacNeal–Harder quad4 row (recorded) |
| quad8 (serendipity) | same | 3×3 | **must** | C1 Kirsch, C4 Cook, C5 LE1 (92.7 MPa), C2 Lamé p=2, B2 quad8 ≤ 1 % |
| tri3 | same | 1-pt | **must** (element) / should (free-mesh rows) | A1, A5; `weka` default output; the "linear triangles are stiff" lesson next to tri6 (commit 28) |
| tri6 | same | 3-pt (degree 2; A's rule; Abaqus CPE6 uses the same) | **must** (element) / should (free-mesh rows) | A1, A5 on split meshes; C1 Kirsch and C5 LE1 on free meshes (commit 28) |
| hex8 (`hex8` = incompatible modes, Wilson–Taylor with the Taylor–Beresford–Wilson correction; `hex8-full` = full integration) | 3D | 2×2×2 | **must** | A1–A5, B1 cantilever (hex8-full error > 5× hex8-im at the same mesh: the J4.3 lesson), D1 LE10 hex8 rows recorded |
| B-bar / selective reduced hex8 | 3D | — | **only if C3 fails** with incompatible modes (A R4, ~40 lines) | C3 ν = 0.4999 |
| hex20 (serendipity) | 3D | 3×3×3 | **must** | B1 hex20 within 0.5 %, D1 LE10 −5.38 MPa at 2 %, C2 Lamé 3D revolve, D4 manufactured p=2 |
| tet4 | 3D | 1-pt | **must** (element) / should (its own rows) | A1, A5 on split meshes (commit 16); D4 tet rows (commit 29) |
| tet10 | 3D | 4-pt Keast (degree 2) | **must** (element) / should (its own rows) | A1, A5 on split meshes; D1 LE10 tet10 row on the split hex20 mesh (commit 24) |
| hex27, quad9, hex20 reduced (C3D20R) | — | — | later | no Benchmark asks for them (A Q3) |
| Shells (MITC4), beams (Timoshenko) | — | — | later | G-series; a separate phase |

Idealisations: **plane stress** (thickness; A's Newton condensation of the 3D law), **plane
strain**, **axisymmetric** (r = x, z = y, ε_θθ = u_r / r, 2π r weighting, Gauss points never on
the axis) and **3D** are all must; Lamé is the case that exercises all four against one closed
form and is the best single test of the idealisation layer.

Stress recovery is A §8's: Gauss-point stresses, per-element least-squares extrapolation to
nodes (`gp_to_nodes`), averaging per node in ascending element order (with the unaveraged
element field kept for J8.7). Loads are A §3.4's: pressure (along −n, follows the face), traction
(vector; `load.traction { total }` spreads a total force, J5.4), nodal force, gravity/body
force, body field (D4), temperature (A6); all consistent nodal loads through the face shape
functions, so quad8/hex20 faces carry quadratic pressure distributions correctly (LE1 and LE10
both apply pressure on curved quadratic faces).

---

## 5. End-to-end build order and the session cut line

Sizes: **S** ≤ ~300 lines with tests, **M** ~300–1000, **L** > 1000. Every commit is green
(`cargo fmt --check`, `clippy -D warnings`, tests, llvm-cov 100 % on what exists) and
self-contained (AGENTS.md). Order is the dependency order; the numbering is the commit
sequence. "Detail" names the plan section a coder reads for that commit; A = plan A, B =
plan B, C = this file. Plan A's and B's own commit numbers are given as `A#n` / `B#n` so their
"done when" columns can be reused verbatim.

### 5.1 The master sequence

| # | Commit | Depends on | Size | Done when | Detail |
|---|---|---|---|---|---|
| 1 | **Workspace + CI skeleton.** Cargo workspace `crates/{geometry,engine,engine-wasm,femlab}`, `rust-toolchain.toml` (1.94 + wasm32 target), npm workspace `packages/{registry,app}`, MIT licence, `.gitattributes` (`* text=auto eol=lf`, so snapshot/`.hashes` fixtures compare byte-equal on a Windows checkout), engine `#![forbid(unsafe_code)]`, clippy deny list (`std::fs`, `std::net`, `Instant`, `thread::spawn`, std transcendentals), `error.rs`, `par.rs` shim (`map_collect`, `fold_ordered`, `dot`; rayon behind `threads`, sequential otherwise), CI: `rust` job (fmt, clippy, `cargo llvm-cov -p femlab-geometry -p femlab-engine --fail-under-lines 100 --fail-under-functions 100 --fail-under-regions 100`) on `ubuntu-latest` + `macos-latest`, `windows-latest` allowed-to-fail running `cargo test --workspace --no-default-features --features threads`; wasm32 `cargo check` of engine + geometry | – | S | CI green on empty crates with an `engine::version()` test; Windows job runs and reports | B §1, §8, B#1; A §1.1–1.2, A#1 |
| 2 | **Units.** `Quantity`, `Dimension`, `Dim` markers, `Q<D>`, unit table, parser, `format`, `convert`, `UnitSet`; proptests | 1 | M | `parse∘format` identity 1000 cases; dimension mismatch and unknown symbol produce the structured errors | B §2.5, B#2 |
| 3 | **Geometry crate: Shape → Solid.** `shape.rs`, `sketch.rs`, `solid.rs` (`manifold-rust` evaluation, `(run_id, face_id)` → tag map, exact properties, `contains`, `Affine3`); `predicate.rs` types (resolution comes in 11) | 1 | M | tag map complete on box−cylinder, box∪box, extrude−cylinder (assert no unmapped triangle); volume of aligned-box trees exact; curved volumes converge in `segments`; `contains` agrees with voxel volume (proptest) | C §2.2, §2.3, §2.5, §2.6 |
| 4 | **Errors, `Command`/`Query` enums, doc strings, schema snapshot.** B's table + C §2.9's geometry/mesh rows + `model.setIdealisation`; `plugin.load` stub `x-status: stub`; `Ack`/`Output`; `femlab` test compares `schema_for!` to the committed `engine.schema.json`. Arms for `mesh.set`, `solve.run`, `study.converge`, `query.mesh|set|result|probe|path|cost` return `Unsupported` with one test each until their commit (B §0: no fake mesher, no fake solver) | 2, 3 | M | every variant has a ≥ 80-char description; every physical field `$ref`s a `Q_*` def | B §2.2–2.4, §2.6–2.7, §2.10, B#3; C §2.9 |
| 5 | **Model + transactional dispatch.** `apply` for model/geometry/material/constraint/load/step Commands: name uniqueness, referential checks, auto face Sets from the Solid's tags, `InUse` on remove, `Host` trait, `Gpu` struct (construction only), `warnings()` for checks that need no mesh | 4 | M | unit tests per Command incl. every error path; hash stable across a run | B §2.1, B#4 |
| 6 | **Journal, undo/redo, `as_script`, `ModelFile`, replay, `model_hash`.** Proptests: replay determinism, undo inverse, transactionality; a test asserts no host Command name can ever be appended | 5 | M | proptests pass at 256 cases; `as_script` round-trips through serde | B §2.8–2.9, B#5 |
| 7 | **CLI `femlab run \| schema \| bench \| serve`(stub).** Fixtures `benches/journals/*.json` + `.hashes`; `assert_cmd` tests; `bench` case format `{ name, journal, checks }` and `--markdown` | 6 | M | `femlab run fixture --verify` exits 0; `femlab schema --check` passes | B §6, B#7 |
| 8 | **`engine-wasm` + `tools/build-wasm.mjs` + `tools/replay-wasm.mjs` + CI job `wasm-hash`.** JSON in, JSON out, typed-array views for `surface_*`/`field` (copied and transferred inside the worker) | 7 | M | native and wasm per-entry hash lists identical for every fixture in CI: **the engine is a library with two hosts before any numerics exist** | B §5.1, B#10 |
| 9 | **GPU lane.** `gpu/mod.rs` (`Gpu { device, queue }`, `buffer_f32/u32`, `read_back` with the `futures-channel` oneshot and the native `poll`), `shaders/dot.wgsl` (partial + final), `tests/wgsl_validate.rs` (naga, plus a deliberately broken string), `tests/gpu_kernels.rs` dot vs f64 within the f32 bound and bit-identical across two runs; CI `gpu` job with wgpu's Mesa lavapipe recipe (`continue-on-error` until green three times, then required; a missing adapter is a hard failure); `Engine.create({ gpu: true })` in wasm requests a device; `#[wasm_bindgen] gpu_self_test()` returns the dot value; Playwright Chromium (`--use-vulkan=swiftshader` flags) loads the wasm from a 30-line `tools/gpu-harness.html` and asserts the native value | 8 | M | ADR 0007's claim is true (kernel ran on lavapipe and in Chromium) or the plan changes now, while it is cheap | A §1.2, §5.4 (`Gpu`, `read_back`, `dot.wgsl`), A#14 (dot part); B §8 `gpu`/`smoke gpu`, B#16 |
| 10 | **`Mesh` type + structured builders** (in `crates/geometry`): `mesh.rs` (A §2 verbatim minus `BlockProps`), Abaqus ordering/face tables, `validate`, `node_to_elems`, `boundary_faces`, `mesher/structured.rs` (`Structured::build(map)`, `box_`, `perturb_interior`, `split_to_simplices`, `annulus`, `elliptic_annulus`), `surface.rs` | 3 | M | face normals outward for all 8 kinds; volumes of mapped meshes converge to π-based values; sets sorted/unique proptest; split meshes validate | A §2, A#2; C §2.1, §2.8 |
| 11 | **Predicates + Sets + lattice mesher + quality.** `resolve(&Mesh)`, `EmptySet` error with nearest face, lattice hex8/hex20 with auto-tags, `quality.rs`, `query.mesh`/`query.set` arms, `mesh.set { lattice }` arm + lazy rebuild + `mesh_surface` | 5, 10 | M | student cantilever meshes at three sizes; every auto face resolves non-empty; a `Plane` predicate Set survives a remesh at three sizes; lattice volume exact for aligned boxes | C §2.3, §2.4, §2.7 lattice, §2.8; B#17 |
| 12 | **Quadrature + shape functions.** 8 reference elements + 6 face parents | 10 | M | partition of unity, derivative sums, monomial integration to rule degree, Kronecker at nodes | A §3.1, A#3 |
| 13 | **Material Extension Point.** trait, `LinearElastic`, plane-stress condensation | 12 | S | D matrices vs closed form 1e-14; batched == single bitwise; props-length error | A §3.2, A#4 |
| 14 | **`Iso<R>` element.** stiffness (full integration), mass, det J check, `inverse_map`, `gp_xi`, `shape_at`; `Formulation` enum present (`IncompatibleModes` arm lands in 21) | 13 | M | A2 for 8 kinds; A3 fixed + proptest; `mesh.inverted` on a folded element; inverse map round-trips | A §3.3, A#5 |
| 15 | **Assembly.** pattern/slot map, chunked deterministic assembly, `Csr::spmv`, `reduce`, `expand`, `reactions`; `tests/determinism.rs` at 1 and N threads (native rayon is real from here: **multithreading designed in**) | 14 | M | A4 (f64); pattern symmetric proptest; bit-identical at 1/N threads; conflict error | A §4, A#6 |
| 16 | **Direct solve + static procedure + checks + post basics.** faer LLᵀ wrapper, `solve()` dispatch, `procedure/static_.rs`, `fem/checks.rs` (no material, empty set, det J, rigid modes by the constrained-DOF rank test, not PD), `post/mod.rs` (u, reactions, extremes) | 15 | M | A1 (8 kinds incl. tet/tri via split), A5 (8 kinds), A7 helper; each check has a failing-input test; rigid-mode check names "rotation about x" | A §5.1, §6, §7, §8, A#7 |
| 17 | **Loads.** pressure, traction (total option), nodal, gravity, body field, `LoadTotals` | 16 | S | curved-face pressure total = p·A_proj to 1e-12; gravity = ρgV; A7 on all of A5 | A §3.4, A#8 |
| 18 | **Post: stress, probe, path.** GP stress, least-squares extrapolation, averaging, von Mises, principal, probe, path | 17 | M | A5 nodal stress = F/A to 1e-8 averaged and not; principal vs hand cases; probe at Gauss points reproduces GP values | A §8, A#9 |
| 19 | **The library solves through both hosts.** `solve.run` arm (progress, cancel via the host), `query.result|probe|path`, `query.cost` (DOF, nnz from `pattern()`, bytes; `estimatedMs: None`), `study.converge` left `Unsupported`, `io/vtu.rs` + `mesh.export { vtu }`; B1 fixture Journal committed with `.hashes`; wasm-hash job now covers a solve-free replay and `femlab bench` runs B1 hex8-full/hex20 | 11, 18 | M | **Stopping point 1:** B1 cantilever hex8-full (locking recorded) and hex20 (within 0.5 %) h-converge at the theoretical rate from `femlab run` and from Node via the wasm build; A8 replay on every fixture; VTU opens in ParaView (documented, not CI) | B §2.1–2.3, B#18 (engine half); C §3 |
| 20 | **Thermal strain.** `ElementCtx.temperature`, `Element::thermal_load`, `Load::Temperature`, `load.temperature` arm | 19 | S | A6 (hex8, hex20, quad4 plane stress, axisymmetric ring) | A §3.3, A#10 |
| 21 | **Incompatible modes** for hex8/quad4 + `Formulation` plumbing + `element: hex8-im \| quad4-im` | 20 | M | A1 still passes on the perturbed patch; B1 full study: hex8-full error > 5× hex8-im, hex8-im rate ≥ 1.8, hex20 ≤ 0.5 % | A §3.3, A#11 |
| 22 | **2D idealisations end to end** (plane strain, axisymmetric weights, plane-stress thickness, `model.setIdealisation`, `constraint.symmetry`) on A's `annulus`/mapped builders | 21 | M | C2 (three idealisations agree to 0.5 %, see §7 for the axial condition), C3 (quad4-im/quad8 < 2 %, quad4-full recorded; B-bar only if this fails), C4 both idealisations with Richardson (§6 #16), C1 quarter = full to 1e-10 | A §3.2, A#12; C §4 |
| 23 | **Mapped mesher as Commands.** `QuadBlock` (corners, `Line/Arc/Ellipse` edges, grading, tags), Coons map → `Structured::build`, multi-block merge with named errors, `mesh.set { mapped }`, `Shape::Sheet` + free-standing 2D bodies, 2D predicate evaluation on boundary edges; every case of 22 rewritten as a Journal fixture and run by `femlab bench` | 22 | M | C2 plane strain (1 polar block) / axisymmetric (1 rectangle), C4 (1 block), C1 (2 blocks, graded), B2 MacNeal–Harder regular/trapezoid/parallelogram (6 one-element blocks) all green from Journals in both hosts | C §2.7 mapped, §2.9, §7 |
| 24 | **Sweep mesher + LE1 + LE10.** extrude/revolve quad → hex8/hex20 (hex20 layer rule), `Sweep` arm; LE1 (`Ellipse` edges, pressure on the curved quad8 edge); LE10 = LE1's block extruded; tet10 twin by split | 23 | M | C2 Lamé 3D by 90° revolve agrees with the 2D rows; C5 σyy(D) = 92.7 MPa at 2 % (quad8), quad4 row at 5 %; D1 −5.38 MPa at 2 % (hex20 and tet10), hex8/hex8-im rows recorded | C §2.7 sweep, §7; A #22 |
| 25 | **CPU PCG + iterative refinement.** `solve/pcg.rs`, `solve/refine.rs`, `solver: cpu-pcg` | 19 | S | A5/B1 via `CpuPcg` inside `refine` equal direct to 1e-10; stall error with `max_inner = 1` | A §5.2–5.3, A#13 |
| 26 | **GPU CG: wasm + WebGPU solving.** `spmv_csr.wgsl`, `cg_vec.wgsl` (7 entry points), chunked CSR, Jacobi-scaled f32 CG with α/β on the GPU, f64 refinement outside, `GpuCg` in `solve()`, `Auto` policy (wasm-aware threshold), `solver: gpu-pcg`; `Engine.create({ gpu: true })` in the worker; Playwright `gpu` smoke solves B1 `[8,2,2]` on SwiftShader via `window.fem` from the harness page | 9, 25 | L | A4 GPU (SpMV vs f64 within `4·ε_f32·‖K‖‖u‖`); D5's CI sibling (66k DOF) matches direct to 1e-8 on lavapipe; B1 `[32,8,8]` via `GpuPcg`; same solve twice bit-identical on one adapter; `#[ignore]` 800k-DOF run prints time on Metal; coverage 100 % with `--all-features` in the lavapipe job | A §5.4, A#14 (rest), A#15; B#16 |
| 27 | **`study.converge` + `femlab bench` + BENCHMARKS status.** `StudyReport` (rows, observed rate, Richardson), `bench/` registry of every un-ignored case, `BENCHMARKS.md` status table generated by `femlab bench --markdown`, the C2 displacement note (§7) | 24, 26 | M | **Stopping point 2:** every Benchmark in §7 marked A is green as a convergence study from one Command, in both hosts; the status table is committed | B §2.2 `study.converge`, B#19 (engine half); A #23; C §7 |
| 28 | **Free 2D mesher (`weka`) + tri6.** `mesher/free2d.rs`, `mesh.set { free }`, `refine` boxes, tags from segment markers, `[e2,e0,e1]` permutation | 23 | M | C1 Kirsch and C5 LE1 on free tri6 meshes within tolerance; tri3 rows recorded (the stiff-triangle lesson); every Sketch segment tag resolves | C §2.7 free, §7 |
| 29 | **D4 manufactured solutions.** `post::error_norms`, elasticity + Poisson body fields, hex8/hex20/tet4/tet10, quad4/quad8 | 27 | M | L2 rate p+1, H1 rate p, within ± 0.1 | A §8, A#21 |
| 30 | **Formats.** `io/msh.rs` write + read (permutation table, physical names ↔ Sets), `io/inp.rs` write, `io/stl.rs` write, `mesh.import { msh }`, `mesh.export { msh \| inp \| stl }` | 27 | M | msh round-trip proptest on every kind (tet10/hex20 permutation both ways); `.inp` of B1 loads in CalculiX (manual, documented, I1); STL is watertight for box−cylinder | C §3; A R10 |
| 31 | **Codegen + TS registry.** `tools/codegen.mjs` (`engine.schema.json` → `engine.ts`, `fem.d.ts`), `packages/registry` (`Registry`, `EngineTransport` + `Req/Res`, host Commands as `{ name, description, zodSchema, run }` with `z.toJSONSchema`, `toToolDefinitions`, `makeFemProxy`), vitest 100 % | 27 | M | tool-list invariants; fake-transport round trips; `fem.d.ts` has one method per Command/Query | B §3, §4, B#8, B#9 |
| 32 | **Developer shell on Pages (not the designed UI).** `index.html` with the coi recipe and capability detection, `engine.worker.ts`, `WorkerTransport`, `window.fem`, a bare full-window three.js viewer driven only by `view.*`/`selection.*` Commands (surface by body/face colour, per-vertex contour + CSS legend, deformed scale, clip plane, edges, pick → logs the auto-face name / `Plane` proposal), a one-line status bar (engine version, gpu/threads capability notes), no panels, no forms; Playwright `cpu`, `sw`, `gpu` smokes; `deploy.yml`; homepage project card marked "developer preview" | 26, 31 | L | **Stopping point 3:** on the deployed page Chrome DevTools MCP builds, meshes, solves and shows a contour of the cantilever through `window.fem`; `crossOriginIsolated === true` after one reload; `capabilities.gpu === true` on SwiftShader in CI at least once | B §5.3, §7.1–7.2, §7.4, §7.7, §8, B#11, B#13 (rendering half), B#16 |
| — | **DESIGN GATE.** Commits 33–37 wait for the deliverables of `docs/DESIGN-BRIEF.md` §13 (IA and panel layout, key states, form patterns, Journal/Script panel, viewer chrome, palette, tokens). Nothing below the gate is started before the design returns; §5.2 says what happens meanwhile | | | | DESIGN-BRIEF §5–§13 |
| 33 | **Designed app shell + Model tree + Properties form.** Preact components from the design's tokens, `panels.ts` tables + `panels.test.ts` enumeration, schema-driven form for every Command shape (`Q_*` fields with live `query.convert`, tagged enums as kind select + sub-form), well-posedness reasons on the Solve button | 32 + design | L | adding a body, a material, a constraint and a load via forms produces the expected Journal; `[data-cmd]` ⊆ registry | B §7.3, B#11, B#12; DESIGN-BRIEF §5.1–5.3, §8 |
| 34 | **Viewer chrome.** legend/colour-map controls, deformation slider, clip handle, layer toggles, pick chip → `geometry.nameFace`, view presets, `query.screenshot` (PNG with legend burned in) | 33 | M | pick → chip → `nameFace` in the Journal; screenshot smoke artifact | B §7.2, B#13; DESIGN-BRIEF §6 |
| 35 | **Journal/Script panels + Examples gallery + file open/save.** live script, undo/redo, sucrase script Worker with timeout/stop, examples from the Benchmark Journals with reference values and a theory snippet, `?example=` deep link, `file.open/save` | 33 | M | pasting the Journal's script into the Script panel reproduces the Model hash; opening an example rebuilds tree and viewer | B §7.5, B#14, B#15; DESIGN-BRIEF §5.5, §5.7 |
| 36 | **Results + Checks panels, study table, Export menu.** extremes with "go to", reactions vs applied with balance, probe/path forms, `study.converge` table and rate, quality and cost from `query.mesh`/`query.cost`, Export menu enumerating `mesh.export` formats + `file.exportCSV` | 34, 35 | M | B1 solves from the UI in under a minute with the reaction balance shown (PLAN §3 exit); a convergence study from one click | B §7.3 Results, B#18 (UI half), B#19; DESIGN-BRIEF §5.5, §4 step 12 |
| 37 | **Budget + polish.** size-limit (landing < 1 MB gz; viewer, wasm, sucrase lazy), homepage card un-marked as preview | 36 | S | **Stopping point 4:** `npx size-limit` passes; the designed app is live | B#21; C #16 |

**Firm** (ships in this session, in this order): 1–27 and 31–32. **Target**: 28–30, which slide
in the order 30, 29, 28 if the day runs short. **Behind the design gate**: 33–37, sized ~2.5k
lines, started only after the design returns (§5.2).

### 5.2 The design gate: what proceeds while the design is out

The designer works from `docs/DESIGN-BRIEF.md` in parallel with commits 1–32; nothing in
1–32 is visual design (the developer shell in 32 is a Command-driven canvas and a status line,
and is labelled as such on the homepage card). If the design has not returned when 32 lands,
the coder continues with §5.4 items 1–5 in order (heat, modal, thermal→structural, transient
heat, explicit: all engine work with Benchmarks), then returns to 33 when it has. If the design
returns early, 33–37 may start as soon as 32 has landed, never before (a UI without the wasm
engine and the viewer behind it is a mock-up, not a commit).

Two things the brief must settle that the code depends on, flagged for the designer: the
Properties form is *generated from the Command schema* (DESIGN-BRIEF §5.3), so the design is a
pattern per field type, not a form per Command; and the viewer's picking produces a Command
proposal chip (§6), never a node list.

### 5.3 The cut line, and what it says about the owner's five clauses

**Everything in §5.1 up to the gate (1–32) is this session's product; 33–37 land when the design
does.** Below the line (§5.4) is deferred with a reason; nothing there blocks the static-structural core.

| Owner's clause | Above the line | Honest gap |
|---|---|---|
| Rust library → wasm + WebGPU | `engine-wasm` (8), wgpu device injection and kernels validated and run in CI natively and in Chromium (9), **f32 CG with f64 refinement solving B1 on lavapipe, SwiftShader and Metal (26)** | GPU CG is CSR-based (A's design), not matrix-free; D5's 10-second target is measured manually on Metal, never asserted on software adapters |
| Native on Linux and Mac, Windows-safe | CLI, CI matrix incl. Windows allowed-to-fail; no `unsafe`, no platform APIs outside `crates/femlab`; `std::path` only; LF-normalised fixtures; wgpu abstracts DX12 | Windows lane is not gated and has no GPU |
| Many analytical cases confirmed | 18 Benchmark ids with tolerances and convergence rates (A1–A8, B1, B2, C1–C5, D1, D4, D5-CI), `femlab bench` table | thermal, modal, explicit, nonlinear cases are not confirmed (first after the line) |
| Every JTBD doable in the library | J1.2–1.4, J2.1 (primitives/booleans/extrude/revolve), J2.6, J2.8, J3.2, J4.1–4.6 (4.2 approximate), J4.7, J4.8–4.9, J5.1–5.4, J6.1, J6.11, J7.5–7.6, J8.1–8.3, J8.7, J8.9, J9.1–9.4, J13.1–13.2, J13.5, J15.1, J15.4 (VTU/msh/inp/STL/CSV/PNG/script) | J5.5/J6.4 thermal, J6.2 modal, J6.5–6.8 nonlinear/dynamics, J13.3–13.8 plugins, J13.4 AI, J11 report, J2.3 CAD import: **not in one session**; the Extension Point seams (`Element`, `MaterialLaw`, `Mesher`, `Procedure`, `Load` as traits with the built-ins as the only implementations, A §3) are in place so they are additions, not rewrites |
| A really great UI for every use case | the developer shell proves the engine in a browser (32); the designed UI is 33–37 | "great" needs the design first, then iteration on real use; §5.4 item 10 lists the deferred UI work |

### 5.4 Below the line, in the order they should land afterwards

1. **Steady heat + convection** (E1, E2 VM97, C7 T4; A#17): a scalar Laplacian over the same
   elements, Robin BC. S–M.
2. **Modal** (B4, C6 FV32; A#16): subspace iteration on faer LLᵀ of `K + |σ| M`. M.
3. **Thermal → structural chaining** (C8 T1, D2 LE11; A#19), with LE11's axisymmetric 3-block
   mapped recipe (arc edge for the sphere). M.
4. **Transient heat** (E3; A#18). S.
5. **Explicit** (F1, F2; A#20): the Blast Wall integrator as `procedure: explicit`. M.
6. **AI panel** behind `?ai=1` (B#20): the tool list exists since 31; the in-page loop, Journal
   diff and eval suite (PLAN 4.6) are the work.
7. **wasm threads** (ADR 0013; B#22): nightly `build-std` lane, `wasm-bindgen-rayon`, loader
   picks the threaded artefact when isolated; the `par` shim from commit 1 becomes rayon.
8. **Tets**: fTetWild (JS-hosted wasm behind the Mesher point) or a Rust port; STL import.
9. **Plugins** (phase P), **report/share/compare + SVG export** (phase 5), **nonlinear** (6),
   **B-rep** (7), **shells/beams/studies/library** (8), **server** (S), **Python** (Py) — as
   PLAN.md orders them.
10. UI: CodeMirror, section cuts with iso-surfaces, animations, side-by-side compare, material
    library forms, `femlab mcp`.

### 5.5 How big is "one long session", honestly

Commits 1–32 are roughly 12–14k lines of Rust and TypeScript including tests; 33–37 another
~2.5k. That is more than any single sitting that built the owner's demos; it is reachable only
because the geometry and solver crates carry their own libraries (`manifold-rust`, `weka`,
`faer`), because plan A's numerics and plan B's registry are specified to the function
signature, and because the Benchmarks double as the tests. The honest stopping points, each a
working, committed, tested product: **after 19** (a verified 3D lattice static solver with CLI,
wasm build and VTU), **after 27** (every static Benchmark green as a convergence study in both
hosts, GPU CG included), **after 32** (deployed developer page driven by `window.fem`),
**after 37** (the designed app). Do not start 26 unless 1–25 are committed; do not start 33
unless the design has returned and 32 is committed.

---

## 6. Challenges to PLAN.md, and where A, B and C disagree

| # | Assumption in PLAN.md / ADRs / a sibling plan | Why it is weak | Recommendation (the resolution this plan adopts) |
|---|---|---|---|
| 1 | Babylon.js is the viewer ("used in the owner's other demos") | Only Flow Defence uses Babylon; Blast Wall is raw WebGPU; three demos use three.js. Babylon core is ~4 MB vs three.js ~600 kB; the FEA viewer needs vertex-scalar colours, edges, picking and a clip plane, which both do; the LLM corpus for three.js is far larger, which matters when an agent writes the UI. The viewer never needs WebGPU; WebGL2 keeps the render device separate from wgpu's compute device (they cannot share one on the web anyway; B verified there is no API to wrap an existing `GPUDevice`) | **three.js (WebGL2 renderer)**, as A/B/C all say; drop "Babylon" from AGENTS.md/ADR 0011/0012 wording; record as ADR 0015 |
| 2 | 100 % coverage "lines, branches, functions, statements" on the engine; C's draft excluded `gpu/` | `cargo llvm-cov` on stable reports line/region/function; **branch coverage needs nightly**. Excluding `gpu/` (C's draft) would silently drop GPU code from the gate; A's answer (run coverage in the lavapipe job with `--all-features`, a missing adapter is a hard failure) is better but that job is `continue-on-error` at first, so nothing gates until it is stable | **A's scheme**: lines/functions/regions at 100 % on `crates/geometry` and `crates/engine`, measured in the lavapipe job with `--all-features` once that job is required. **Interim rule** (until the lavapipe job has been green three times): the `rust` job runs the same thresholds with `--no-default-features --features threads` and `--ignore-filename-regex 'src/gpu/'`; the ignore is deleted in the commit that makes the lavapipe job required (target: commit 26). `engine-wasm` and `femlab` are hosts, smoke-tested. State this in AGENTS.md in commit 1 |
| 3 | Sparse Cholesky "simplicial, CSparse-style, ~500 lines" hand-rolled | Leftover from the TypeScript plan. `faer` 0.24 has supernodal LLT/LDLT with AMD, is MIT, pure Rust, compiles to wasm32 (verified) and solved 100k unknowns in 13 ms | `faer` on both hosts with A's feature list `["std", "sparse-linalg"]` (`["std"]` also compiles); keep A's f64 Jacobi-PCG as the fallback and the independent cross-check |
| 4 | "CI runs the same Journal through the native and the wasm build and compares Model hashes" / "replays byte-for-byte" | True only for *inputs*. `manifold-rust` and mapped curves use `f64::sin/cos`, which go through different libms on wasm and macOS, so mesh coordinates and any Result can differ in the last ulp; a hash over floats would flap. B's `libm`-only rule applies to the engine crate's Model code, not to the geometry crate | `model_hash` covers Commands and Model parameters (exact; B §2.9); meshes and Results are compared with tolerances (1e-12 relative for CPU solves, a later Benchmark); say "the Model replays identically; Results agree to 1e-12" |
| 5 | Journal-as-model is fine for large meshes | The Journal holds Commands, so size is not the problem; the problem is `solve.run` in a Journal: replay-on-open must not re-solve, and undo past a solve must orphan Results, not recompute | B §2.1/§2.8 already do this (`replay(skip_solves)`, Results keyed by revision hash, `stale: true`); make it a test in commit 6 |
| 6 | Schema codegen: "the build emits JSON Schema and generated TypeScript types" via `tools/` | A custom codegen tool is a project. `schemars` → JSON Schema is one test; JSON Schema → `.d.ts` is `json-schema-to-typescript` (npm) in one script | B §3 exactly: one Rust snapshot test writes/compares `schema.json`, one npm script makes `engine.ts`/`fem.d.ts`; the AI tool list *is* `schema.json` |
| 7 | Threads in wasm via `wasm-bindgen-rayon` are part of the core plan (ADR 0013, rule 9) | Needs nightly + `build-std` + `+atomics,+bulk-memory` + a service-worker reload on Pages + Worker plumbing; nightly is on this machine but not in CI; none of the Benchmarks needs it; the GPU is the parallelism story in the browser | Design for it and build the native half now (A's `par.rs`: all loops through the shim, fixed-order reductions, `tests/determinism.rs` at 1 and N threads natively from commit 15); the coi-serviceworker ships in 32 so isolation is real and tested; the threaded wasm artefact is §5.4 item 7 (B#22). A, B and C agree |
| 8 | Manifold + fTetWild as JS-hosted wasm behind the Mesher (ADR 0005, PLAN 3.1–3.2) | `manifold-rust` removes the JS hop, the FFI and the 2.8 MB vendored module, gives the geometry crate to the native CLI and Python for free, and (verified) carries face identity through booleans; fTetWild stays the open question | Amend ADR 0005: geometry evaluation is `manifold-rust` in `crates/geometry`; tets are a later Mesher, JS-hosted or ported, decided when a demo needs an STL |
| 9 | Zod 4 + immer are needed for the registry (PLAN 0.3, B §4.3); C's draft said neither | Engine Commands are validated in Rust, so Zod buys nothing there. Host Commands (`view.*`, `selection.*`, `script.run`, `file.*`) take user and AI input in TypeScript with no Rust behind them, and `z.toJSONSchema` gives their tool schema for free: that is ~15 schemas for one small dependency. immer's only stated job in B is a patch ring for `query.script({ includeView })`, which nothing needs | **Zod for host Commands only** (B); **no immer** (plain reducers over a small `UiState`); UI state is not undoable (Blender's rule, B §13 #4). This resolves the A/B/C disagreement in B's favour on Zod and C's on immer |
| 10 | "Every capability is a Command… including UI actions", and "the Journal is the model" | Two rules collide unless stated: camera moves must be callable by an AI (registry) but must not be replayed on open (Journal). ADR 0003 already says camera is view state | Registry = engine Commands ∪ host Commands; **Journal = engine Commands only** (B's `journaled: false` on every host Command); a Rust test (commit 6) asserts no host Command name can be appended. Write it in AGENTS.md. A, B, C agree |
| 11 | Phase order: GPU (phase 2) before 2D/geometry (phase 3) | 2D/axi + mapped meshing yields ~8 Benchmarks for ~1.5k lines; GPU CG yields zero new confirmed cases (it must match the CPU answer). But the owner's first clause is wasm + WebGPU *working* | Order in §5: geometry, 2D and the static core first (10–25), the GPU device lane at 9 (cheap, de-risks), the **GPU CG at 26, above the cut line**, before the free mesher and formats. This moves C's draft #22 up; A's own note that 13–15 "can be reordered after 16–21" is consistent |
| 12 | Phase 1 hex8 "with incompatible modes or selective reduced integration so a linear hex bends"; C's draft chose hex8-full + hex20 now, B-bar later, incompatible modes never | A decided incompatible modes (Wilson–Taylor with the Taylor correction, 9 internal DOFs, condensed per element) and B's `ElementType` already has `hex8-im`; A#11 lands it with the B1 locking gate. C was the outlier | **Incompatible modes in the master sequence (commit 21)**, A's design; B-bar only if C3 fails at ν = 0.4999 (A R4); no separate B-bar commit |
| 13 | 0.7 "a Result of 1M f32 values crosses to Babylon without a copy" | The renderer uploads to its own GPU device anyway; a wasm-memory view is already zero-copy on the JS side; 4 MB is nothing | Drop the spike; B §5.1's "slice in the worker, transfer once" is the design |
| 14 | `naga-cli` / dawn.node lanes | `naga-cli` is not installed and not needed: `naga` as a dev-dependency validates every `include_str!` shader in a unit test; dawn.node only matters for TS-side kernels, of which there are none once the engine is Rust | One `naga` test; two GPU lanes (native lavapipe, Playwright Chromium), not three. **Feature name**: A's `gpu` (a default feature); B §8's `--features gpu-tests` is a typo for it |
| 15 | Phase 3.1 "Manifold CSG … exact volume Query matches analytical for primitives" | Only true for polyhedra; cylinders and spheres are tessellated (8e-7 at 512 segments). A student's "volume" must not be off by 1e-4 silently | `segments` is a mesh setting shown in the UI; `query.model` reports the analytic volume for primitives and the tessellated volume for booleans, labelled |
| 16 | Cook's membrane reference "21.520 vs 23.9 — resolve" | Both numbers are in circulation for different idealisations at ν = 1/3 (A §9 C4: ≈ 23.9 plane stress, 21.52 plane strain); hard-coding either is a coin flip | A's recipe: run both idealisations at quad8 n = 32, Richardson-extrapolate, hard-code the confirmed value per idealisation, and *report* both literature values next to ours |
| 17 | **Two `Mesh` types and two structured builders**: A puts `Mesh` and `mesh::structured` in `crates/engine`; C's draft put `Mesh` and `mesher/mapped.rs` in `crates/geometry`; B's seam has a third `Mesh` shape (`nodes: Vec<[f64;3]>`, `elements`, `surface`) | One mesh type, one builder. The geometry crate is the lower crate and must not depend on the engine; A's builder *is* the mapped mesher with a closure instead of edge curves | **`Mesh` (A §2's definition) and A's `structured.rs` live in `crates/geometry`** and the engine re-exports them; C's `QuadBlock` produces the closure A's builder consumes; `ElementBlock` loses `material/formulation/idealisation` to a parallel `Vec<BlockProps>` in A's `Problem`; B's seam adopts A's names (`procedure::run(&Problem, &Step, gpu, prev) -> StepResult` with A's `fields: BTreeMap<String, Field>`), and B's `apply` arms translate `Model → Problem` and `StepResult → ResultSummary`. B's workspace list gains `crates/geometry` |
| 18 | **Two VTU writers**: B §4.3 has a ~100-line TS `file.exportVTU` (boundary only); C's draft had `io/vtu.rs` in the geometry crate | Two writers drift, and the TS one cannot write volume cells or element fields | **One writer, in `crates/engine/src/io/vtu.rs`**, base64 `format="binary"` so the file is a `String` across every host boundary; `mesh.export { vtu }` is the engine Command; B's `file.exportVTU` host Command calls it and saves the text. Likewise `msh`, `inp`, `stl` |
| 19 | B stubs `mesh.set/solve.run/study.converge/query.*` with `Unsupported` arms so the schema is complete on day one; C's draft implied Commands land with their code | In the master sequence the numerics land within ~15 commits of the enum, so the stubs are short-lived; but the enum must be complete for the schema snapshot and codegen, and each stub is one test | Keep B's stubs (commit 4), replace each with the real arm in 11, 19, 27; no fake mesher or solver |
| 20 | **No `Idealisation` Command** in B §2.2; A's `Idealisation` sits on the element block; the design brief's first workflow step is "choose the idealisation" | A 2D body needs to say plane stress/strain/axisymmetric somewhere a Journal can replay | `model.setIdealisation` (§2.9), default `solid3d`; a `Sheet` body under `solid3d` or a solid under a 2D idealisation is `IllPosed` |
| 21 | B's seam expects `cost_estimate(mesh, opts) -> CostEstimate` from A; A never defines it | Small gap, but a coder would stall on it | `query.cost` = DOF count, nnz from A's `pattern()`, bytes = `nnz·12 + n·8·k`, `estimatedMs: None` until PLAN 2.9's calibration; lands in commit 19 |
| 22 | C's draft `Curve::Parametric(fn)` for LE1's ellipse | A closure cannot be serialised into a Command or replayed from a Journal | `Curve::Ellipse { center, semi_axes }` (§2.7); the Coons patch with two elliptical edges is exactly A's `elliptic_annulus` map |
| 23 | BENCHMARKS.md C2: "Lamé … plane strain and 3D … u_r(a) = 5.90e-5 m" | With A's data (a = 0.1, b = 0.2, p = 60 MPa, E = 200 GPa, ν = 0.3) the plane-**stress** (σ_z = 0, open-ended) closed form gives 5.90e-5 m and the plane-**strain** (ε_z = 0) form gives 5.72e-5 m; the stresses (100 / −60 MPa) are the same in both. A's "three idealisations agree to 0.5 %" only holds if the axisymmetric and 3D models impose the same axial condition | §7 C2 fixes the axial condition (`u_z = 0` on both end faces ⇒ ε_z = 0) and hard-codes the closed form per idealisation (A already does); the commit that lands C2 annotates BENCHMARKS.md: 5.90e-5 is the σ_z = 0 value, 5.72e-5 the ε_z = 0 value |
| 24 | C's draft deferred A6 (free thermal expansion) to "later, needs steady heat" | A6 needs only a uniform ΔT load (A#10, ~150 lines), not the heat procedure | A6 is commit 20, above the line |
| 25 | Over-building in C's draft: `HexBlock` with 12 edge curves, `Tag`/`All`/`Not`/`Sphere` predicates, `EdgePredicate`, `RegionPredicate::Inside(Shape)`, `geometry.union/intersect/transform/nameEdge`, `sketch.add`, `mesh.build`, `query.geometry`, `Mesh::from_arrays`, 6-point tri6 rule, a separate tet-split commit | None is used by a case above the line, or it duplicates something that exists (A's builders, `query.model`, B's lazy mesh) | All struck (§2.3, §2.7, §2.9, §4); each is one small addition when a case needs it |

---

## 7. Benchmarks reachable this session

Recipes name the mesher of §2.7 and the master commit of §5.1. Steel unless stated (E = 210 GPa,
ν = 0.3, ρ = 7850 kg/m³). Reference values are `BENCHMARKS.md`'s; where this table adds a
number it is derived from the closed form in plan A §13.

| Case | Mesh recipe (concrete) | Elements / idealisation | Commit | Reference / note |
|---|---|---|---|---|
| A1 patch tests | A: `Structured{n:[2,2,2]}.box_([1,1,1])` (2D `[2,2,1]`), `perturb_interior(0.15h, seed 7)`, simplices by `split_to_simplices` | all 8 kinds, all idealisations, both hex8/quad4 formulations | 16 (21 for `-im`) | exact, 1e-10 |
| A2 rigid modes, A3 eigenvalues of K_e | single perturbed element | hex8 fixed + proptest over all kinds | 14 | 1e-12 / 6 zeros, 18 positive |
| A4 operator symmetry | B1's `[8,2,2]` | f64 (15), GPU SpMV (26) | 15, 26 | 1e-12 / `4·ε_f32·‖K‖‖u‖` |
| A5 uniaxial bar | bar 1 × 0.1 × 0.1, `[10,1,1]`; 2D `[10,1]` plane stress t = 0.1; axisymmetric rod as a 1 × 10 (r, z) strip | all 8 kinds | 16, 22 (2D/axi) | σ = F/A, δ = FL/EA, 1e-8 |
| A6 free thermal expansion | `[4,4,4]` block, 3-2-1 constraints, ΔT = 100 K | hex8, hex20, quad4 plane stress, axisymmetric ring | 20 | ε = αΔT, ‖σ‖ ≤ 1e-10·EαΔT |
| A7 reaction balance | every case | — | 16 onward | 1e-9 rel |
| A8 Journal replay | every fixture | — | 6 onward | inputs hash exact (§6 #4) |
| B1 cantilever | L = 1, b = h = 0.1, P = 1 kN as `load.traction { total }` on `beam.xmax`, `beam.xmin` fixed; lattice `[8,2,2]`, `[16,4,4]`, `[32,8,8]` | hex8-full, hex8-im, hex20 (`[8,2,2]`, `[16,4,4]`) | 19 (full, hex20), 21 (`-im`) | δ = PL³/3EI + PL/(κGA), κ = 5/6; hex20 ≤ 0.5 %, hex8-im rate ≥ 1.8, hex8-full error > 5× hex8-im at `[8,2,2]` |
| B2 MacNeal–Harder straight beam | **6 one-element `QuadBlock`s**, L = 6, w = 0.2, t = 0.1 (imperial as-is), E = 1e7, ν = 0.3, plane stress; regular: corners (i,0),(i+1,0),(i+1,0.2),(i,0.2); **trapezoid**: interior node i (1..5) at x = i + (−1)^i·0.1 on the bottom row and x = i − (−1)^i·0.1 on the top row (edges at 45°, alternating); **parallelogram**: every top-row node at x + 0.2 (all edges at 45°); tags `root` (x = 0), `tip` (x = 6); root fixed, `load.traction { total: (0, 1, 0) }` on `tip`; hex8/hex20 twins by extrude 1 layer | quad4, quad4-im, quad8; hex8, hex20 | 23 (2D), 24 (hex) | 0.1081 in tip deflection; quad8/hex20 ≤ 1 %; quad4/hex8 recorded |
| B3 twisted beam | needs a `HexBlock` with twisted edges or per-layer rotation in extrude | hex20 | later | reference **resolve** (BENCHMARKS) |
| B4 modal, B5 buckling, B6 elastica | — | — | later (§5.4 #2, phase 6) | |
| C1 Kirsch plate with hole | quarter plate, a = 1, half-width W = 10 (finite-width K_tg ≈ 3.03 by Heywood at d/W = 0.1; the 2 % gate vs 3.00 is met after Richardson). **Two `QuadBlock`s**: block 1 corners (a,0), (W,0), (W,W), (a/√2, a/√2) with edge 3 an `Arc` about the origin (tag `hole`), edges 0/1 tagged `ymin`/`xmax`; block 2 corners (a/√2, a/√2), (W,W), (0,W), (0,a) with edge 3 an `Arc` (tag `hole`), edges 1/2 tagged `ymax`/`xmin`; the diagonal (W,W)–(a/√2, a/√2) is shared, so both blocks use the same radial division n_r and grading ratio measured from the hole; `constraint.symmetry` on `xmin` (u_x) and `ymin` (u_y), `load.traction` σ on `xmax`; n_r = n_θ = 8, 16, 32 with grading 1.15 toward the hole. Free recipe: full plate `Sheet` with a circular hole, `weka` tri6 with a `refine` box around the hole | quad8 (mapped), tri6 (free; tri3 recorded) | 23 (mapped), 28 (free) | K_t = σ_xx(0, a)/σ → 3.00 (infinite plate) within 2 % after Richardson; 3.018 (VM142 geometry) reported; quarter = full to 1e-10 (a full-plate 8-block or free mesh) |
| C2 Lamé thick cylinder | a = 0.1, b = 0.2 m, p = 60 MPa inside, E = 200 GPa, ν = 0.3. **Plane strain**: 1 polar `QuadBlock`, corners (a,0), (b,0), (0,b), (0,a), edges 1 and 3 `Arc`s about the origin (tags `outer`, `inner`), edges 0/2 tagged `ymin`/`xmin`; symmetry on both, `load.pressure { value: 60 MPa }` on `inner`; n = (4, 8), (8, 16), (16, 32). **Axisymmetric**: 1 rectangle r ∈ [a, b] × z ∈ [0, 0.1], `u_z = 0` on **both** z edges (⇒ ε_z = 0). **3D**: the axisymmetric strip revolved 90° with `u_y = 0` on `theta0`, `u_x = 0` on `theta1`, `u_z = 0` on both z faces | quad4, quad8; hex8, hex20 | 22/23 (2D, axi), 24 (3D) | closed form (A §13) with the **ε_z = 0** axial condition in all three rows: σ_θθ(a) = 100 MPa, σ_rr(a) = −60 MPa, **u_r(a) = 5.72e-5 m** (BENCHMARKS.md's 5.90e-5 is the σ_z = 0 open-ended value; annotate it in commit 27). 1 % disp, 2 % stress at p = 2; the three rows agree to 0.5 %; u_r rate ≥ 1.8 (quad8 ≥ 2.8) |
| C3 near-incompressible cylinder | C2's plane-strain block, ν = 0.49, 0.499, 0.4999 | quad4-full (recorded), quad4-im, quad8 | 22 | Lamé closed form; monotone; quad4-im and quad8 < 2 %, else B-bar (A R4) |
| C4 Cook's membrane | 1 `QuadBlock`, corners (0,0), (48,44), (48,60), (0,44), straight edges, tags `left` (edge 3), `right` (edge 1); E = 1, ν = 1/3, t = 1; `left` fixed, `load.traction { total: (0, 1, 0) }` on `right`; n = 4, 8, 16, 32; quantity u_y at (48, 60); plane stress **and** plane strain | quad4, quad4-im, quad8 | 22/23 | Richardson-extrapolated per idealisation (≈ 23.9 plane stress, 21.52 plane strain expected); 1 % vs the extrapolated value; both literature values reported (§6 #16) |
| C5 NAFEMS LE1 elliptic membrane | 1 `QuadBlock`, corners D = (2,0), C = (3.25,0), B = (0,2.75), A = (0,1); edge 0 (D→C) `Line` tag `y0`, edge 1 (C→B) `Ellipse { center (0,0), semi_axes (3.25, 2.75) }` tag `outer`, edge 2 (B→A) `Line` tag `x0`, edge 3 (A→D) `Ellipse { semi_axes (2, 1) }` tag `inner`; t = 0.1, plane stress, E = 210 GPa, ν = 0.3; `constraint.symmetry` u_x on `x0`, u_y on `y0`; `load.pressure { value: "-10 MPa" }` on `outer` (outward); n = (6,6), (12,12), (24,24) | quad8 (quad4 row recorded), tri6 free row in 28 | 24 | σ_yy(D) = 92.7 MPa by `query.probe` of the averaged nodal field at (2, 0); 2 % (quad8), 5 % (quad4 n = 24) |
| C6 FV32, C7 T4, C8 T1 | mapped 1 block / mapped | — | later (§5.4) | modal / heat |
| D1 NAFEMS LE10 thick plate | C5's block extruded by 0.6 in **2 layers (hex20) and 4 layers (hex8 rows)** — an even count so the mid-plane z = 0.3 has nodes; `u_y = 0` on `y0` (DCD'C'), `u_x = 0` on `x0` (ABA'B'), `u_x = u_y = 0` on `outer` (BCB'C'), `u_z = 0` on the mid-plane line of `outer` (a `nameRegion` Bbox at z = 0.3 ∩ the outer face's nodes), `load.pressure { 1 MPa }` on `top`; tet10 twin by `split_to_simplices` | hex20 (must), tet10 (split), hex8/hex8-im recorded | 24 | σ_yy(D) = −5.38 MPa at D = (2, 0, 0.3) by probe of the averaged nodal field (A R6); 2 % for hex20 and tet10 at n = 12 |
| D2 LE11, D3 FV52 | axisymmetric 3-block mapped / lattice plate | — | later | thermal / modal |
| D4 manufactured solution | unit cube `[4,8,16]` (`[8,16,32]` for p = 1), `perturb_interior` variant; `Load::BodyField(−div σ(u))` | hex8, hex20, tet4, tet10; quad4, quad8 | 29 | L2 rate p+1, H1 rate p, ± 0.1 |
| D5 1M-DOF cantilever | lattice `[50,20,20]` (66k DOF, CI on lavapipe) and `[100,50,50]` (`#[ignore]`, manual on Metal) | hex8 via `gpu-pcg` | 26 | GPU refinement vs CPU direct ≤ 1e-8; time printed, never asserted on software adapters |
| E, F, G, H, I | — | — | later (I1 manual after 30) | |

Count: **18 Benchmark ids green above the line** (A1–A8, B1, B2, C1–C5, D1, D4, D5-CI); C1 and
C5 gain free-mesh rows in 28. First after the line: E1, E2, C7 (heat), B4, C6 (modal), C8, D2
(thermal→structural), E3, F1, F2.

---

## 8. Risks and open decisions

| Risk / decision | Recommendation |
|---|---|
| `manifold-rust` and `weka` are young (0.13.1, 0.1.0), one author each | Pin exact versions (`=0.13.1`, `=0.1.0`); our own volume/area/tag/`det J` assertions on every mesh; both are pure Rust (`weka` 5.3k LOC) and vendor-able into `crates/` if abandoned. `spade` is the fallback for 2D |
| Face tags through booleans | **Verified** (§1): `(run_original_id, face_id)` maps every result triangle to a source face after `difference`/`union`/transform; the test of commit 3 keeps it true across version bumps. Do not read `Manifold::original_id()` after a transform (−1) |
| Multi-block merge tolerance, mismatched divisions, grading on a shared edge | Refuse mismatches with a named error; the Kirsch 2-block recipe (shared diagonal, graded from the hole) is the test |
| Axisymmetric r = 0 | Gauss points never sit on the axis; nodes at r = 0 get `u_r = 0` automatically; Lamé's inner radius is > 0 so the first exposure is LE11 (later) |
| `faer` on wasm without threads; wasm size | `Par::Seq`; the fallback PCG covers pathological sizes; A R1: measure the wasm size in commit 8's lane (`opt-level = "z"`, `lto`, `panic = "abort"`) and gate `sparse-linalg` behind a feature only if faer alone exceeds ~1.5 MB |
| Lavapipe lane flaky | `continue-on-error` until three green runs; the native and Chromium lanes are independent evidence; §6 #2's interim coverage rule keeps the gate honest meanwhile |
| wgpu 30 web backend + a separate three.js WebGL2 context | No shared device is attempted; one upload of the result array to the renderer per solve |
| Windows | No platform code outside `crates/femlab`; `windows-latest` in the matrix allowed-to-fail running the CPU test suite; `std::path` only; **LF line endings enforced by `.gitattributes`** so the schema snapshot and `.hashes` fixtures compare byte-equal; the GPU lanes are Linux-only by construction (Mesa) and the Windows lane runs `--no-default-features` |
| Coverage gate slowing the session | Scope per §6 #2; ratchet, never lower |
| Cook's, FV52, MacNeal–Harder twisted beam references; Lamé displacement | Gate on self-convergence; report literature values; resolve before hard-coding (BENCHMARKS.md already flags them); annotate C2's two displacement values (§6 #23) |
| Licence posture | Everything above the line is MIT/Apache-2.0; the only copyleft candidates (Gmsh GPL, fTetWild MPL, OCCT LGPL) are below the line and JS-hosted if adopted |
| The AI surface without the AI | `toToolDefinitions()` (31) and `window.fem` (32) ship so Chrome DevTools MCP can drive the app; the in-page agent is §5.4 #6, not the API |
| Design returns late | §5.2: continue with §5.4 items 1–5; the developer shell (32) is already deployed and driveable |

Open decisions for the owner:

1. three.js instead of Babylon (§6 #1). Default in this plan: three.js.
2. Accept the A/B/C resolutions in §6 #2 (coverage), #9 (Zod yes, immer no), #12 (incompatible
   modes), #17 (`Mesh` in the geometry crate), #18 (one VTU writer) as edits to AGENTS.md and
   to plans A/B's seams before the build starts. Default: yes, in commit 1.
3. Whether GPU CG (26) may slide below the free mesher and formats (28–30) if time runs short.
   Default in this plan: **no** — 26 is firm because the owner asked for WebGPU working; 28–30
   slide first.
4. `.inp` writer in-session (30) or not. Default: yes, it is ~150 lines on Abaqus-ordered
   meshes and the owner listed it; the CalculiX cross-check stays manual.

---

## Review log

Review of 2026-09-05 (senior review, in place). One line per change: what, why.

1. §1 table, `manifold-rust`: added the review spike's face-identity result (`(run_original_id, face_id)` survives `difference`/`union`/transform; caps vanish; extrude = 1 face per edge + 2 caps) and the `original_id() == −1 after transform` trap; fixed the dependency list (`dashu-int`/`dashu-ratio`, `num-traits`); verified from the crate source and `reviewC-spike/manifold-faces`.
2. §1 table, `weka`: LOC corrected 3.8k → 5.3k (`wc -l`); added verified tri6 `edge_nodes` order (opposite corner ⇒ Abaqus permutation `[e2,e0,e1]`), hole seeds and marker propagation (`reviewC-spike/weka-tri6`); author named from Cargo.toml.
3. §1 table, `faer`: recorded that `pub mod sparse` is unconditional so both `["std"]` (C spike) and `["std","sparse-linalg"]` (A) compile on wasm32; adopted A's list.
4. §1: added the node-ordering facts (VTK = Abaqus for all 8 kinds; Gmsh differs for tet10 *and* hex20) because the writers depend on them and the draft only mentioned tet10.
5. §0 summary rewritten to match the new ordering, formats and resolutions.
6. §2.1: `Mesh` and A's `structured.rs` moved into `crates/geometry`; `ElementBlock` stripped of FEM fields; writers moved to the engine (`no I/O` made literal); `HexBlock`, `split.rs` (now A's), `io/` removed from the module list.
7. §2.2: replaced the vague "original_id/property channel" with the concrete, verified tagging algorithm; added `Shape::Sheet` for 2D bodies; named how cut faces get `<name>.<tag>`.
8. §2.3: aligned `FacePredicate` with plan B's serde tagging and `Q<Length>` fields; added `Cylinder`/`Any` (needed by curved boundaries); struck `Tag`, `Sphere`, `All`, `Not`, `EdgePredicate`, 2D-only variants, `RegionPredicate::Inside` (YAGNI).
9. §2.4: specified the per-mesher auto-tag rule (block edge tags / sketch segment markers / lattice nearest tagged triangle) — the draft never said how mesh faces map to geometry faces for mapped and lattice meshes.
10. §2.6: `Idealisation` made a Model setting (`model.setIdealisation`) because plan B has no Command for it and the design brief's first step needs one; `tag` added to `Segment`.
11. §2.7: `QuadBlock` given a codeable definition (corner order, edge order, grading formula, Coons formula, node numbering, quad8 mid-node rule, merge algorithm); `Curve::Parametric(fn)` replaced by `Ellipse` (a closure cannot be journaled); `HexBlock` struck (no case above the line uses it); "mapped blocks are geometry" rule added; hex20 extrude layer rule and revolve mid-node rule added (a hex20 has no mid-face nodes); weka hole-seed, marker and permutation details added; `Split` folded into A's builder.
12. §2.9: Command list reconciled with plan B (generic `geometry.add/subtract` replace `addBox/subtractBox`; `mesh.set` nests `Sweep { base }`; `mesh.export` returns a `String`); struck `geometry.union/intersect/transform/nameEdge`, `sketch.add`, `mesh.build`, `query.geometry`.
13. §3: all writers in the engine returning `String` (VTU base64); `.inp`, STL, CSV, PNG and script added because the owner listed them; VTU "no permutation" and Gmsh hex20 permutation facts added; B's TS VTU writer struck (§6 #18).
14. §4: reconciled with plan A: all 8 elements land together, hex8/quad4 default to incompatible modes (A's decision, B's `hex8-im`), B-bar only if C3 fails, tri6 uses A's 3-point rule (not 6-point), stress recovery and loads reference A §8/§3.4.
15. §5 rewritten as ONE master sequence (37 commits above the cut line + §5.4 in order) merging A#1–23, B#1–22 and C's draft, each with depends-on, size, done-when and the detail section; design gate inserted before 33; developer shell (32) separated from the designed UI; GPU CG moved above the cut line as commit 26 (owner's clause 1) behind the static core; A6 moved above the line (commit 20); B-bar and tet-split commits struck; stopping points restated after 19, 27, 32, 37.
16. §5.2 added: what proceeds while the design is out, and two flags for the designer.
17. §5.3 clause table updated (GPU CG above the line, 18 Benchmarks, J4.7/J15.4 covered, Windows LF fixtures).
18. §5.5 sizes re-estimated for the merged sequence.
19. §6: rows 2 (coverage: A's scheme + interim rule), 9 (Zod yes for host Commands, immer no), 11 (GPU CG above the line), 12 (incompatible modes per A), 14 (`gpu` vs `gpu-tests` feature name) rewritten; new rows 17–25 record the A/B/C disagreements and their resolutions (one `Mesh`, one VTU writer, stubs kept, `model.setIdealisation`, `query.cost` gap, `Ellipse` not `Parametric`, Lamé 5.90e-5 is the σ_z = 0 value, A6 not "later", YAGNI strikes).
20. §7 recipes made concrete enough to code from: B1 meshes aligned with A; B2 as six one-element blocks with exact distorted coordinates; C1 as two blocks with corner coordinates, shared-diagonal rule, finite-width note and σ_xx(0,a) (the draft said 3 blocks and gave no corners); C2 with block corners, tags and the **ε_z = 0 axial condition** (found by recomputing the closed form: BENCHMARKS.md's 5.90e-5 is plane stress); C4 corners/tags/quantity; C5 corners, edge curves, tags, outward pressure sign; D1 even layer count so the mid-plane has nodes, constraint set from A; D4/D5 meshes from A.
21. §7 count corrected 14 → 18 Benchmark ids above the line (A6, C3, D4, D5-CI added by the reordering).
22. §8: face-tag row turned from a risk into a verified fact; Windows row gains the `.gitattributes` LF rule (a CRLF checkout would break the schema snapshot and `.hashes` byte comparisons); faer size risk cross-referenced to A R1; "design returns late" row added; open decision 3 flipped (GPU CG firm, 28–30 slide) and decision 4 defaulted to shipping `.inp`.
23. Spike locations updated (`reviewC-spike/{manifold-faces, weka-tri6}` under the session scratchpad).
