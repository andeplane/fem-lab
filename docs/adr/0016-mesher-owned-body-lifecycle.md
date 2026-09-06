---
status: accepted
date: 2026-09-06
---

# Mapped geometry owns a Body identity with an explicit lifecycle

Issue [#251](https://github.com/andeplane/fem-lab/issues/251) exposed a mismatch: mapped and
swept mapped meshers expose a Body in Queries and accept material assignments, but Body
rename/removal only searched explicit geometry. ADR 0005 makes geometry and its references
scriptable; ADR 0010 lets each mesher own its geometry representation.

## Decision

A mapped mesher owns its Body name. A swept mapped mesher owns the name of its mapped base.
This is a Body identity alongside explicit geometry, without inventing an explicit primitive
or copying mapped block coordinates into a second representation. Its name cannot shadow
an explicit Body or cut when mesh geometry is defined; explicit geometry cannot replace an
existing mesher-owned Body.

`model.rename` renames that identity inside the mesher, including sweep bases. Material
association stays attached. Auto-face references, named Faces, whole-Body regions, Constraints
and Loads follow the rename. Free meshers own no Body; their explicit source-Body reference
also follows a Body rename, including inside a sweep.

`geometry.remove` removes an unused mesher-owned Body by clearing mesh settings and its
material association. Unrelated explicit Bodies, cuts and Materials survive. Constraints,
Loads, named Faces and whole-Body regions prevent removal while they refer to the Body.
A free mesher likewise prevents removal of the explicit geometry it still uses. Errors list
users and leave the Model and Journal unchanged.

`mesh.set` is an ownership transition too. Keeping the implicit name preserves its material
association. Changing/removing the name requires the same unused-Body check as removal and
clears that association. To rename a used Body, call `model.rename` first, then remesh using
its new name. This prevents a mesher replacement from silently orphaning selectors or
transferring a material to unrelated geometry.

`model.duplicate` returns structured `unsupported` for a mesher-owned Body. The Model has one
mesher settings slot, so a copy could neither own independent geometry nor satisfy the
Command's independent-copy promise. Supporting multiple mesher-owned Bodies requires an
explicit future representation change, rather than aliasing the existing slot. Subtraction likewise returns `unsupported` for
mapped geometry: cuts operate on explicit Shapes, and cannot alter mapped blocks.

All successful transitions are ordinary journalled Commands: undo, redo and replay rebuild
identical identities, references and material associations.

## Alternatives and consequences

- Synthesizing an explicit Body would duplicate geometry authority and require a new Shape
  representation for blocks and sweeps. Keeping ownership in the mesher avoids that coupling.
- Rejecting all lifecycle Commands would leave the public Body surface inconsistent with
  material assignment and named selectors. Rename and guarded removal need no new geometry.
- Silently dropping dependent objects on removal would make a geometry edit erase unrelated
  modelling intent. Explicit dependency errors let callers choose the next Commands.

Old scripts that relied on ambiguous explicit/implicit names, or replaced a referenced
implicit name through `mesh.set`, now receive a structured error. A same-name remesh keeps
existing references; geometric predicates still resolve against the resulting mesh.

The independent patch and lifecycle tests are recorded in `docs/BENCHMARKS.md`. Separate
existing material-rename and thermal-load creation defects are tracked in
[#113](https://github.com/andeplane/fem-lab/issues/113) and
[#260](https://github.com/andeplane/fem-lab/issues/260).
