---
status: accepted
date: 2026-09-08
---

# Adaptive refinement records its local size field in the Journal

Issue [#83](https://github.com/andeplane/fem-lab/issues/83) adds a spatial error
estimator and `study.adapt`. Choosing a refinement region depends on a numerical
solution. Repeating that choice during replay would make the Model depend on
solver roundoff, and opening a Journal with skipped solves could not reconstruct
its final mesh. ADR 0003 requires deterministic Commands and a replayable Model.

The study records its chosen world-coordinate refinement boxes, in iteration
order, as unit-bearing `refinements` in its Journal Command. An ordinary invocation
omits this field. Numerical replay solves the same sequence of meshes using the
recorded choices; replay with skipped solves applies those choices without solving.
A saved Model contains the accumulated SI size field in `mesh.refinement`.
`mesh.set` can also author this field directly. No element or node ids become
user-facing selectors, and geometry edits leave geometric sizing rules meaningful.

The size field is applied after the base mesher, by conforming linear-simplex
edge bisection. All elements sharing a selected edge split together. A batch uses
sorted edge ids internally for deterministic topology; material blocks and face
ancestry survive. This supports both free triangles and tetrahedra, as well as
linear simplex splits of mapped/lattice meshes, without building a second tet
background lattice. Element bounds that intersect a box obey its maximum edge
length; overlapping boxes choose the finer size. Adjacent elements may split to
maintain conformity. The final element budget is checked during refinement.

This extends ADR 0021's globally sized base tet mesher with local *discretisation*
refinement, not its proposed graded isosurface-stuffing background (#349). Bisection
preserves the base mesh's faceted boundary approximation; it does not move new
boundary nodes onto CAD or claim the original stuffing algorithm's dihedral bound
for its descendants. Curved-boundary geometry error still requires a finer base
mesh. These distinctions appear in the Command documentation.

`study.adapt` uses material-separated, volume-weighted ZZ stress or heat-flux
recovery and the inverse constitutive tensor to integrate local energy errors.
Bulk marking selects a fraction of the squared estimate with deterministic ties.
The relative estimate is η/sqrt(||q_h||²+η²), with zero for a zero field. It is an
indicator, not a guaranteed error bound. The first implementation supports linear
triangles/tetrahedra in planar/3D static elasticity and conduction. Transient heat
restarts the full Step on each spatial mesh and estimates its final field: it does
not adapt during time integration, coarsen, or estimate time discretisation error.

A study retains only its final successful Result. Cancellation, invalid input and
resource-limit failures roll back the Command; hitting the iteration limit returns
an explicit nonconverged report and the last solved mesh. Recorded decisions allow
undo, redo, script export and skipped-solve replay to agree on that mesh.
