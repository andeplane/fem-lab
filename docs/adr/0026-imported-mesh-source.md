---
status: accepted
date: 2026-10-14
---

# An imported Mesher source is immutable model data; its Mesh is derived

Issue [#501](https://github.com/andeplane/fem-lab/issues/501) is the foundation of the
[Abaqus input-deck plan](../plans/500-abaqus-import.md). A file reader cannot write only
the derived mesh cache: the next edit, replay or save/open rebuild would discard the
authored connectivity and memberships. Geometric predicates cannot distinguish two
labelled nodes at identical coordinates.

## Decision

`MesherSpec::Imported` supplies a complete labelled source through the existing Mesher
Extension Point. Quantity coordinates cross the Command boundary; `MesherSettings`
retains checked SI coordinates, source node/element labels, local connectivity and exact
memberships. Nodes and elements are canonicalized in ascending label order; local
connectivity is never sorted or welded. Dense indices exist only in the derived Mesh.
Unused source nodes survive in the authoritative source and exact source NSET memberships.
They have no finite-element DOFs: the derived Mesh maps participating labels only and reports
retained unused labels separately. Results cannot fabricate a zero displacement for them.
The active source-label map covers the derived node prefix. Ordinary auxiliary point-mass
nodes may follow that prefix, with their own named point Sets and no fabricated source
labels. The imported Body's bounds and volume cover its participating element geometry;
the complete derived Mesh bounds also include such auxiliary points. Unused authored
coordinates affect only their exact source NSET bounds, never physical Body/Mesh framing.
query.set reports the authored labels/count/extent, including unused members; a support or
load targeting any unused member is explicitly unsupported. This derivation is reported,
never an undocumented cleanup of authored data. Tet4 and standard full-integration Hex8 are
the first slice.

The source owns an implicit root Body under ADR 0016. Optional disjoint element regions
are additional editable Body identities under ADR 0035; the root retains the whole-source namespace. Its immutable Set namespaces become
`<body>.nset_<NAME>`, `<body>.elset_<NAME>` and `<body>.surface_<NAME>`. Source names preserve exact case and allow 1..256 printable ASCII bytes (ADR 0035); identical node/element Set names remain distinct. A source ELSET named
ALL therefore cannot shadow the synthetic `all` element Set. Numeric node targets allocate
`<body>.node_<label>` only when explicitly requested, rather than one object per source node.
Source surface faces use positive, one-based Abaqus local face numbers at the boundary.
The dense Mesh uses its existing zero-based `Face` representation.

`mesh.set` replaces the entire checked source. References to removed or emptied Sets block
replacement, with users listed. Body rename carries qualified references and material
assignment. Guarded Body removal clears the source; an individual source Set has no mutable
geometric definition. `query.definition` on the source Body returns its lossless mesh.set
Command; source Sets return a structured unsupported error naming that owner operation.
The Journal stores ordinary explicit Commands. Replay needs no source file or parser.
Optional converter provenance retains the verified SHA-256 and conversion version; raw
input text and host file handles are not model authority.

Imported sources cannot be swept, refined, split, upgraded to quadratic order or regenerated
by a convergence/adaptive study. Such operations must reject rather than repeatedly solving
the same source while claiming a new resolution. An independently authored refined source
is another mesh.set Command. Existing geometric meshers retain their current behavior.
This prohibition also applies when a Journal skips numerical solves and applies recorded
adaptive choices. The shared refinement helper checks the source before changing any
settings; replacement preparation rejects such a Journal without publishing a partial
Model or changing the active owner's Journal. Empty adaptive choices and restoring
convergence studies also reject: skipping work does not make an unsupported study valid.

## Geometry acceptance

Connectivity and sampled Jacobians are necessary checks, not non-overlap proof. Source
publication also uses issue #517's original-geometry certificate. Tet4 pairs use exact
containment and face intersections, allowing contact only in a shared labelled entity.
Hex8 local injectivity follows from an exact positive-definite normalized Jacobian matrix
certificate: its symmetric part is multi-affine and is the convex combination of its
positive-definite corner matrices. This is stronger than checking corner determinants.
Contacts use actual bilinear-face implicit quadrics composed with the original cell maps,
exact zero-entity identities and strict-sign Bernstein bounds. Deterministic dyadic proof
is bounded to 12 levels and 4096 boxes per pair.

An exact invalidity witness is meshFailed. Failure of a sufficient condition or proof
budget is unsupported and does not falsely say the source is invalid. Valid but strongly
warped cells may be unproved. Neither source coordinates, connectivity nor formulations
are changed to make certification pass; no tetrahedron split or planar skin substitutes
for an original warped Hex8. Source representation/lifecycle is tracked in #516; parent
#501 retains its full acceptance matrix and the Abaqus host remains #502–504.

## Alternatives and consequences

- Writing the transient BuiltMesh fails journal replay and portable storage.
- Converting source nodes to coordinate predicates loses exact membership and coincident
  node identity; converting solids to STL erases interior connectivity and formulations.
- A new mutable mesh engine API would bypass the registry and duplicate transactional logic.
- Keeping a raw Abaqus deck as authority would make old Journals change meaning when a parser
  adds support or fixes a bug. Conversion instead emits explicit schema-owned source data.

Hosts reuse ordinary unsolved mesh surfaces, retained Results, Sets, probes and exporters.
Abaqus parsing, analysis translation and file picker/CLI entry points remain separate
issues #502, #503 and #504; this representation does not imply those features are shipped.
