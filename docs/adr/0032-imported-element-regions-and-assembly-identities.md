---
status: accepted
date: 2026-10-15
---

# Imported element regions are editable Body identities over immutable connectivity

Issue [#652](https://github.com/andeplane/fem-lab/issues/652), within the interoperability
work [#650](https://github.com/andeplane/fem-lab/issues/650), removes two accidental limits
of ADR 0026: one connected component and one material for the entire source.

The optional `regions` map in `mesh.set` partitions authored element labels into disjoint,
nonempty named subsets. Region names are ordinary Body names. Uncovered elements belong
to the source Body. The source Body continues to own the complete immutable source and its
qualified node/element/surface Set namespace. No coordinates are welded, no element
connectivity is reordered, and shared authored node labels remain shared across regions.
Disconnected components are admitted with the same geometric validity checks as connected
ones; this does not turn coincident independent labels into a connection or implement contact.

Regions use ordinary `material.assign` and `section.assign` Commands. Their editable
assignments live on the Model, separately from immutable connectivity. A region assignment
overrides the source Body assignment; absent overrides inherit that assignment. A source
partitioned completely into material-assigned regions needs no artificial root material.
Derived element blocks split on ownership as well as element kind, retaining global source
label order. The existing per-block numerical material and section path remains authoritative.

`model.rename` carries region ownership, assignments and dependent references. Removing a
used region reports its users; otherwise removing/duplicating region geometry is unsupported
and directs callers to replace the complete source with `mesh.set`. Root removal checks
region users too. Replacement cannot remove referenced regions, and assignments for removed
regions are cleared. Region `query.definition` returns the complete owning mesh Command.
Undo, save/open and replay require no original file or parser.

Optional provenance identity maps retain original local source labels and original case of
part/instance names for assembly imports. Keys are global persistent source labels. These
bounded, checked maps are descriptive provenance, never a substitute for connectivity,
constitutive properties or exact source Set memberships. Flat sources omit them. Source Set names are exact 1..256 printable ASCII bytes, allowing
quoted and scoped source identities without invented encodings. The Abaqus parser separately
enforces its local naming grammar. Exact source Set lookup precedes geometric name parsing.

Embedding materials in the mesh would make ordinary material edits ineffective and create
a privileged import solver path. Welding shared coordinates would corrupt independent
instance identity. Treating each region as an independent mesh would duplicate shared
interface nodes. The partition and existing block assignment path avoid all three problems.
