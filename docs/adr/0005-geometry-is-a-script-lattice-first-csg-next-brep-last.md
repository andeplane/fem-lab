---
status: proposed
date: 2026-09-05
---

# Geometry is a script of primitives with named faces; lattice meshing first, CSG + tets next, B-rep last

Geometry is defined by Commands that add primitives, combine them, and name faces; it is
never defined by picking nodes. The Mesher behind that API changes over time while the API
does not: v1 meshes axis-aligned primitives directly onto a structured hex8 lattice (zero
dependencies, exact, what Blast Wall does today); v1.5 adds Manifold CSG (Apache-2.0,
2.8 MB) feeding fTetWild-wasm (MPL-2.0, 5.6 MB) for tet4/tet10; v2 adds a B-rep kernel
(Replicad on OpenCascade, MIT/LGPL, 2.4–9 MB) for sketches, fillets and STEP import. Every
2025–2026 text-to-CAD result and every shipping product (Zoo, Onshape's FeatureScript MCP)
converged on "the LLM writes a program, the kernel executes it", and models are reliable on
primitives and booleans and unreliable on fillets and free-form topology (note 03).

## Considered options

- **Gmsh-wasm from the start.** Gives size fields, physical groups, hex recombination and
  tet10 natively, but is GPL-2.0+, 12–45 MB, and weeks old with one maintainer.
  Re-evaluate at v2 if grading and second-order meshing become the blocker.
- **Immersed / finite-cell method (no meshing).** Attractive, but moves the difficulty into
  the solver (cut-cell quadrature, conditioning, weak BCs), which is the part we want simple.
- **Pick-by-node like classic preprocessors.** Breaks remeshing, breaks scripting, and is
  exactly the interface LLMs cannot use.

## Consequences

- Sets are resolved from named faces and region predicates when the mesh is built, so a
  Model survives a remesh and a mesher swap unchanged.
- fTetWild's epsilon envelope erases features smaller than ε·bbox; the Mesher must report
  volume against the exact CSG volume and fail loudly when they disagree.
- The three wasm packages for meshing are vendored at pinned versions, not floated.
