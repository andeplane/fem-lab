---
status: accepted
date: 2026-09-07
---

# Free tet meshing is isosurface stuffing, written in Rust, not fTetWild-wasm

Issue [#22](https://github.com/andeplane/fem-lab/issues/22) needs an unstructured tetrahedral
mesher for an arbitrary CSG `Solid`: curved bodies the lattice mesher stair-steps and the
mapped/sweep meshers cannot reach because they are not prismatic. ADR 0005's v1.5 sketch named
fTetWild-wasm for this. This ADR supersedes that sentence and records why every crate
alternative and the fTetWild plan itself were rejected, and what was built instead.

## What was rejected, and why

Every Rust tet-meshing crate available at the time fails on licence, wasm, or maturity:
`tritet` (MIT **or** AGPL-3.0, the AGPL half wraps vendored C++ TetGen and cannot build for
wasm32), `tetgen` (AGPL-3.0-only, one WIP release), `delaunay` (BSD-3, but an *unconstrained*
Delaunay triangulator — boundary recovery, the hard part of the problem, is still ours to
write, and the Schönhardt polyhedron makes Steiner points unavoidable), `tpt-fem-mesh-gen`
(MIT/Apache, one release, no users, unvetted), `outram-park-fork-cfmesh` ("scaffold stage, no
human V&V" by its own README) and `gaia-mesh` (a CFD/BSP mesher, not an FEM tet mesher).

fTetWild is a harder rejection because it reverses a decision already made, not merely absent
from the crate registry. It is a C++/emscripten module: a *host* artefact, not something
`crates/femlab` — the CLI that gates every Benchmark, and a future Python host — can call, so
those hosts would have no mesher at all, breaking ADR 0011's headless-engine-library rule
outright. It is 5.6 MB raw against the project's 3 MB gzip cold-boot budget, before the 2.8 MB
Manifold-CSG dependency ADR 0005 already accepted alongside it. And no Rust port exists, so
using it means a second build system (emscripten) inside CI for the one feature that needs it.

## Decision

Isosurface stuffing (Labelle & Shewchuk, *Isosurface Stuffing: Fast Tetrahedral Meshes with
Good Dihedral Angles*, SIGGRAPH 2007), written from scratch in
`crates/geometry/src/mesher/tet.rs`, about 550 lines of `f64`/`libm` with `BTreeMap`, no new
dependency. It is the lazy choice, not merely the safe one: the two expensive parts of any tet
mesher already exist in this crate for other reasons. `Solid::triangles()` is a watertight,
per-triangle *tagged* boundary (manifold by construction, via `manifold-rust`'s booleans), and
`Solid::contains(p)` is an *exact analytic* inside/outside oracle on the shape tree — closed
forms for box, cylinder, sphere, extrude and revolve, composed through the CSG set operations —
already the lattice mesher's own containment test. Isosurface stuffing needs exactly those two
primitives: a body-centred cubic background lattice is cut against `contains`, warped to bound
the dihedral angle, and its boundary faces are tagged by nearest triangle exactly as
`mesher/lattice.rs` already tags a stair-stepped one (the two meshers now share that logic as
`mesher/tag.rs`). No exact predicates, no flips, no Steiner-point boundary recovery, no octree.

Labelle & Shewchuk prove every dihedral angle of the cut-and-warp variant lies in
**[10.7°, 164.8°]**, and every emitted tetrahedron is positively oriented. That bound is
measured, not merely cited: `crates/geometry/tests/mesh.rs` gates it on a box, a cylinder, a
sphere and a box minus a cylinder, at multiple sizes, alongside volume conservation against
each body's closed form and Set survival.

## Consequences

- **A sharp CSG edge falling between two lattice crossings is chamfered by up to one element
  size.** The mesher learns the surface only where a background-lattice edge crosses it; a
  corner between two crossings is smoothed over that gap. This is the same class of
  approximation as fTetWild's ε-envelope (ε ≈ h here), bounded and measured rather than
  silently accepted, and it is why the mesher's own doc string steers prismatic geometry —
  anything the mapped or sweep mesher can already mesh exactly — away from it.
- **The boundary is otherwise exact, unlike `Solid::volume()`.** Every cut point is placed by
  bisecting `Solid::contains`, the same analytic oracle the primitives evaluate exactly, so a
  cylinder or sphere meshed by isosurface stuffing is rounder than the faceted `TriMesh`
  `Solid::volume()` and `Solid::area()` already approximate it by. The mesher therefore checks
  its own meshed volume against the Solid's *closed form* in tests, and against the Solid's own
  (faceted) volume at run time, hard-erroring past 20 % drift rather than shipping a mesh that
  quietly lost a thin feature — ADR 0005's "report volume against the exact CSG volume and fail
  loudly" carried over unchanged.
- **No grading.** `size` and `maxElements` are the only settings; curvature is already
  controlled on the geometry (`Cylinder { segments }` and friends), and boundary nodes land on
  the exact surface regardless of element size. A graded octree background lattice with a size
  field is real future work, filed separately as #349, linked from here rather than built now.
- **`min_dihedral_deg` / `max_dihedral_deg` are new, permanent Quality fields.** They exist
  because `min_det_j_ratio` is identically 1.0 for every simplex whatever its shape and says
  nothing about a tetrahedral mesh; the dihedral range is the number this ADR's guarantee is
  stated in, and the quality Query and the calculation note report it for every mesh, 2D or 3D.
- **`crates/femlab`'s CLI keeps a mesher on every target it builds for**, including wasm32,
  because nothing here is a native or emscripten module — the reason this ADR exists rather
  than simply implementing ADR 0005's v1.5 sketch as written.
