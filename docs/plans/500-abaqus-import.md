# Abaqus input-deck import: the first supported slice

Planning issue: [#500](https://github.com/andeplane/fem-lab/issues/500).
Implementation: [#501](https://github.com/andeplane/fem-lab/issues/501),
[#502](https://github.com/andeplane/fem-lab/issues/502),
[#503](https://github.com/andeplane/fem-lab/issues/503),
[#504](https://github.com/andeplane/fem-lab/issues/504).

Status, 2026-10-14: proposed implementation plan, **no Abaqus reader shipped**.
The endpoint names below are proposals until their implementation issues land.
This plan covers text `.inp` mesh/model conversion. Binary `.odb` Results and `.cae`
model databases are separate formats and are outside this slice.

## What exists

Checked against `origin/main` at `4e364b60`:

| Capability | Evidence | Current boundary |
|---|---|---|
| Abaqus `.inp` export | [`write_inp`](../../crates/engine/src/io/inp.rs), `ExportFormat::Inp` in [`command.rs`](../../crates/engine/src/command.rs), `mesh.export` in [`engine.rs`](../../crates/engine/src/engine.rs) | Nodes, connectivity, named node/element/face Sets. No Materials, Constraints, Loads or Steps; a mesh export is not a runnable analysis deck. |
| Geometry import | `MeshFormat::Stl`, `geometry.import` in [`command.rs`](../../crates/engine/src/command.rs), `geometry.importFile` in [`host-commands.ts`](../../packages/registry/src/host-commands.ts) | ASCII/binary STL as watertight triangle geometry, then remeshed. No `.inp` or `.odb` path. |
| FEM Lab file open | `importText` and `file.open` in [`host-commands.ts`](../../packages/registry/src/host-commands.ts) | A `femlab/1` JSON snapshot plus Journal, not a solver-neutral file reader. |
| Mesh and assignment data | [`model.rs`](../../crates/engine/src/model.rs), [`mesh.rs`](../../crates/engine/src/mesh.rs) | Model stores mesher settings and geometric Set predicates. `BuiltMesh` is derived; material association is per Body. |
| Transactional replacement | [`replacement.rs`](../../crates/engine/src/replacement.rs), [session host contract](../session-host-contract.md) | `Candidate::commands` builds privately; `finish` validates the first snapshot; checked replacement publishes once. |

The master [PLAN §3.8](../PLAN.md) describes a larger mesh I/O ambition, including a full
analysis writer and Gmsh read path. It is roadmap text, not evidence of current Abaqus
loading. This plan does not enlarge the existing writer's claims.

## Why a parser alone is insufficient

An arbitrary `.inp` has authored nodes, connectivity and exact memberships. It cannot be
inserted into the transient mesh cache: a later Command, save/open or replay rebuilds that
cache from the Model and would erase the imported data. A bounding-box predicate also cannot
represent an arbitrary NSET or distinguish two labelled nodes at the same coordinates.

There is a tempting smaller special case: `T3D2` into `geometry.addLine` with `divisions: 1`.
It would still change valid input semantics: [`bodies`](../../crates/engine/src/mesh.rs)
welds coincident line joints, while source labels can identify distinct coincident nodes.
It cannot retain general NSET/ELSET memberships through today's predicate-only definition.
That converter is not a correct general Abaqus loading feature.

The minimum correct route needs one persistent imported-source representation, then a
small strict parser. It needs no new element kernel, file system inside Rust, CAD kernel or
Extension Point. Implement it through the existing Mesher point
([ADR 0010](../adr/0010-plugins-fixed-extension-points-three-languages.md)).
[#501](https://github.com/andeplane/fem-lab/issues/501) records the hard-to-reverse source
representation/lifecycle decision in the next available ADR and updates the glossary then.
This plan proposes that decision; it does not silently redefine today's derived Mesh.

## Representation and callable surface

Extend `MesherSpec`/`MesherSettings` with an immutable `imported` source:

- One named implicit Body, following mapped/surface Body lifecycle rules in
  [ADR 0016](../adr/0016-mesher-owned-body-lifecycle.md). First slice requires a connected,
  conforming 3D mesh. One homogeneous material assignment uses `mesher_material`.
- Nodes retain positive source labels and Quantity coordinates at the Command boundary;
  the checked Model stores SI coordinates. Elements retain positive source labels,
  explicit `tet4`/`hex8` type, and connectivity expressed in source node labels.
- Store exact source node Sets, element Sets and element/local-face Sets with the source.
  Derived arrays use dense indices only after validation. Node/element labels are sorted
  for deterministic mapping; no coordinate welding or topology inference occurs.
- Keep source node, element and surface name namespaces distinct. Expose them as
  `<body>.nset_<LABEL>`, `<body>.elset_<LABEL>`, `<body>.surface_<LABEL>`; source labels are
  canonical uppercase in this slice. Numeric load/support targets get explicit singleton
  `<body>.node_<id>` Sets only when needed. Do not allocate a Set object for every unused node.
  Report the mapping. The synthetic FEM Lab `all` Set does not shadow a source ELSET `ALL`.
- Imported memberships are mesher-owned, like existing generated Sets. List them in
  `query.model`, inspect exact counts with `query.set`, and return the existing explicit
  non-editable-definition behavior from `query.definition`. Editing the source uses the
  owning `mesh.set` definition; no free node editing control is introduced.
- `mesh.set` validates the whole source before mutation. Replacing a source that removes a
  used Set fails with dependents listed. Body rename carries all qualified Set references;
  guarded removal rejects referenced sources. Undo/redo and replay restore the exact source.
- Require `order: 1`, `formulation: full`, `simplices: false`, no local refinement. Reject
  sweep, adaptive/convergence remeshing or order changes for this source. C3D8 must not
  inherit FEM Lab's default incompatible-mode formulation. C3D8I/R/H are rejected, not
  coerced into C3D8. No current geometric mesher changes its behavior.

`build` returns the ordinary `BuiltMesh`: correct `body_of_block`, all resolved Set kinds,
boundary skin and source-label mappings. Imported element Sets need explicit resolution;
the current node-only mesher Set pass is insufficient. Reuse ordinary quality checks,
assembly, Results, probes, retained surfaces and exporters. Update the unsolved viewer to
draw the imported boundary rather than requiring a `Solid` geometry preview. Cost/count
Queries must count this source without pretending it can be regenerated at another size.

Proposed `query.convertAbaqus` takes inline text, an explicit model/Body name, `mode`
(`mesh` or `static`), and unit scales. A pure Rust converter returns a typed report and
ordinary Commands: `model.new`, explicit `model.setIdealisation { solid3d }`, `mesh.set`
with the imported source, and any supported Material/Constraint/Load/Step Commands.
It neither mutates the active Model nor performs a solve.

Proposed host Command `file.importAbaqus` reads an injected picker or scoped project path,
or accepts inline text. It uses the same converter and existing checked
`Candidate::commands`/`finish`/replacement route. Do not add a second mutable engine API.
The native CLI gets a thin `import-inp` host entry, with I/O outside the engine
([ADRs 0011](../adr/0011-engine-is-a-headless-library-browser-is-one-host.md),
[0012](../adr/0012-engine-in-rust-hosts-in-typescript.md)).

The Journal records the resulting explicit, schema-owned Commands, including the imported
source. It does not record a file path as the source of truth. Replay needs neither the
original `.inp`, a browser handle, a network fetch nor the parser. This uses the existing
Commands/Journal contract ([ADR 0003](../adr/0003-everything-is-a-command.md)) and avoids
reinterpreting raw decks differently after a future parser expansion. Retain a source
SHA-256 and conversion version as provenance in the imported source; verification of the
input digest precedes conversion. Do not put runtime session ids in portable Commands.

## Units

Abaqus requires a self-consistent input unit system rather than supplying built-in physical
units. The importer therefore requires a positive Quantity `unitLength`, and static mode
also requires a positive Quantity `unitForce`. No SI or millimetre default is applied on
import. See the vendor [Conventions / Units](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEMODRefMap/simamod-c-conventions.htm)
and [ADR 0008](../adr/0008-si-inside-units-at-the-boundary.md).

For length scale L in metres and force scale F in newtons, convert coordinates and prescribed
displacements by L, nodal forces by F, and Young's modulus by F/L². Poisson's ratio remains
dimensionless. Thus `unitLength: "1 mm"`, `unitForce: "1 N"`, deck E = 210000 gives
210 GPa inside. UI display units are a separate choice. Scaling must be finite and positive;
wrong dimensions, overflow and nonfinite converted values fail before publication.

This mechanical static slice rejects density, thermal properties and temporal procedures.
A later slice needs an explicit time scale before deriving mass/density units, plus a
temperature convention for absolute/relative thermal data. Accepting those properties now
and silently discarding them is forbidden.

## Accepted text and options

This is a deliberately strict subset, not an implementation of every Abaqus shorthand.
Use the vendor-authored 2025 manuals linked below (public Virginia Tech documentation mirror;
the `help.3ds.com` pages were inaccessible during this review).

Lexing accepts ASCII keyword/data records, LF or CRLF, leading blanks on keywords, comments
beginning `**` in columns 1–2, case-insensitive full keyword/parameter spellings, E/D numeric
exponents, and comma-terminated keyword continuation. Keep the documented 256-character
line limit. Reject duplicate parameters, keyword abbreviations, quoted labels and unused
extra fields. Unquoted names in this first slice are `[A-Za-z][A-Za-z0-9_-]*`, at most 80
characters, normalized uppercase. Missing fields use only the defaults explicitly listed
below; missing required data is an error. These restrictions are narrower than Abaqus and
must appear in the tool description and error report. See
[Input Syntax Rules](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEMODRefMap/simamod-c-inputsyntax.htm).

| Keyword | Mesh mode | Static mode / exact restriction | Primary format reference |
|---|---|---|---|
| `*HEADING`, `**` comments | Accept title/comments | Same; no physics effect | [Input syntax](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEMODRefMap/simamod-c-inputsyntax.htm) |
| `*NODE` | Positive labels, x/y/z, optional `NSET`, `SYSTEM=R` or absent; omitted y/z = 0 | Same; global rectangular coordinates only | [NODE](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-node.htm) |
| `*ELEMENT` | `TYPE=C3D4` or `C3D8`, optional `ELSET`; exact arity | Same; preserve standard full integration | [ELEMENT](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-element.htm), [solid element types/order](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEELMRefMap/simaelm-r-3delem.htm) |
| `*NSET`, `*ELSET` | Sorted explicit label lists, `GENERATE` with positive integral increment (default 1), previously defined same-kind Set references; repeated definitions append | Same; referenced Sets capture membership at that record, not future additions. NSET from `ELSET` is supported with no data lines. | [NSET](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-nset.htm), [ELSET](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-elset.htm), [Node definition](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEMODRefMap/simamod-c-node.htm) |
| `*SURFACE` | `TYPE=ELEMENT`, `NAME`; source element or previously defined ELSET plus valid explicit `S1…S4`/`S1…S6` | Same; membership retained even if no imported Load uses it | [SURFACE](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-surface.htm) |
| `*PREPRINT` | Recognize `ECHO`, `MODEL`, `HISTORY`, `CONTACT` with YES/NO as presentation-only metadata; report no solver listing produced | Same | [PREPRINT](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-preprint.htm) |
| `*MATERIAL`, `*ELASTIC` | Reject | Exactly one material, `NAME`; isotropic `TYPE` or absent; one E/ν record. No temperature/dependency columns or property tables. | [ELASTIC](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-elastic.htm) |
| `*SOLID SECTION` | Reject | Exactly one homogeneous `ELSET`/`MATERIAL` association covering every element once; empty/default attribute line only for supported 3D solids | [SOLID SECTION](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-solidsection.htm) |
| `*BOUNDARY` | Reject | Direct format, source node or NSET, DOFs 1–3, last DOF defaults to first. Model-data magnitude must be absent/zero; Step-data displacement magnitude defaults to zero. `TYPE=DISPLACEMENT` or absent only. | [BOUNDARY](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-boundary.htm) |
| `*CLOAD` | Reject | Step data, source node or NSET, DOF 1–3, required scalar magnitude; no parameters | [CLOAD](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-cload.htm) |
| `*STEP`, `*STATIC`, `*END STEP` | Reject | Exactly one Step; optional `NAME`, `NLGEOM=NO` or absent; plain `STATIC` with absent/default increment fields only (initial = 1, period = 1, minimum = 1e-5, maximum unspecified). Import final linear equilibrium, with an explicit report that there is no Abaqus increment history. | [STEP](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-step.htm), [STATIC](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-static.htm) |

For NSET CLOAD, Abaqus's scalar is applied to each member node. FEM Lab `load.force.total`
is a Set total ([loads.rs](../../crates/engine/src/fem/loads.rs)). Convert total = magnitude
× cardinality, with a separate Load per axis. Direct node targets use singleton Sets.
Reject duplicate/overlapping CLOAD updates to the same node/DOF in this first slice rather
than guessing history precedence. Likewise reject conflicting prescribed values, including
model-versus-Step overrides. Equal repeated boundary values may deduplicate deterministically.

Everything else is an error, including unknown parameters on an accepted keyword. In
particular: `PART`/`ASSEMBLY`/`INSTANCE`, transforms and coordinate systems, external
`INCLUDE`/`INPUT`/`FILE`, generated/copy nodes/elements, `UNSORTED`, unsupported element
types/formulations, multiple or heterogeneous Sections, orthotropic/plastic/thermal material
data, `DLOAD`/`DSLOAD`, amplitudes, contact/ties/equations, nonlinear/modal/dynamic/heat Steps,
and `OUTPUT`/history requests. There is no automatic mesh-only fallback for a rejected full
deck. Many ordinary Abaqus/CAE exports contain assemblies/output blocks and will be rejected
until a later separately specified slice supports them; the UI must say so.

## Validation and publication

Suggested initial bounds, enforced in hosts and Rust before allocation: 16 MiB input,
250,000 nodes, 250,000 elements and 1,000,000 expanded Set memberships. Check arithmetic
before range expansion or allocation. Reject input whose resulting `femlab/1` snapshot plus
Journal exceeds the current 16 MiB Model-file limit, rather than creating an unsavable Model.
These are product bounds, not promises about available browser memory or solver feasibility.

Check duplicate/invalid labels (1…999999999), missing connectivity references, unsupported
arity, nonfinite coordinates, repeated local nodes, positive Jacobians at the element's
validation points, connected/conforming topology, valid source faces, absent Set references,
range divisibility and full homogeneous assignment coverage. Referenced Sets and Loads may
not be empty. Preserve unreferenced source data or report an explicit rejection; do not prune
unused nodes as an undocumented cleanup.

Errors use the existing structured `code`, one-line cause, `where` and suggested Command.
`where` includes source line, keyword, record/field and source label where available.
Unsupported intent reports `unsupported`; malformed data reports `schema`/`meshFailed` as
appropriate. The conversion report lists units, SI bounding box, counts, label/name mapping,
element formulation, retained model objects and any explicitly accepted presentation metadata.
Mesh mode reports missing analysis configuration; it never advertises a solved model.

Capture producer/session ownership before picker, read or conversion awaits. Conversion
reads are scoped; publication checks the original replacement ticket/state. Cancel, stale
producer, parse failure, candidate failure or persistence failure keeps the old Model,
Journal, project binding and Results intact. On success only the initiating producer advances
to the replacement Session. The original file is unnecessary after successful conversion.

## Independent evidence and release gates

Fixtures live alongside the single engine registry/physics integration binaries, with source
attribution and expected values. Add numerical rows to [BENCHMARKS.md](../BENCHMARKS.md).
Do not derive the only fixtures or oracle from `write_inp`.

| Evidence | Required checks |
|---|---|
| Hand-authored `sparse-label-tet.inp` and `brick-sets.inp` | Fixed coordinates/connectivity/source labels; out-of-order records; known NSET/ELSET/surface membership and independent vendor face tables. Include same NSET/ELSET name and distinct coincident labelled nodes in an otherwise connected mesh. |
| Syntax/property corpus | Case, LF/CRLF, E/D exponents, keyword continuation, repeated/prior Sets, GENERATE/default increment. Arbitrary text through a never-panics proptest; valid record permutations preserve canonical output; every unsupported keyword/parameter has a regression. |
| Invalid geometry/resource corpus | Duplicate labels, missing references, degenerate/inverted elements, unsupported type, overflow, malformed ranges, over-limit input/expansion. Exact diagnostics and no active state change. |
| Independent affine patch | C3D4/C3D8 meshes, prescribed affine displacements, closed-form stress and reaction conservation. Ensures mapping/order validation does not merely agree with the exporter. |
| Static axial bar | L = 1 m, A = 0.01 m², E = 200 GPa, ν = 0, F = 1 kN: δ = 5e-7 m, σ = 1e5 Pa. Equivalent SI and mm/N decks, at 2/4/8 axial cells for both types; exact axial response and equal/opposite 1 kN reactions within documented f64 tolerances. This exact patch has no invented convergence-rate assertion. |
| Load meaning | Several-node CLOAD Set delivers n×magnitude, individual target has one magnitude; vector components, overlapping-target rejection and nonzero prescribed displacement. Inspect applied totals and independent reactions. |
| Save/replay | Native and matching WASM conversion reports/Commands agree; each Journal hash agrees at 1 and N threads. Save/open and replay with source file removed; source replacement undo/redo; existing Journal hashes remain unchanged. |
| Production Chromium | Real file-picker and inline command imports, explicit unit choice, actual rendered mesh and named Sets, material/Step rows, solve plus δ/σ/reactions, save/reopen, malformed/oversized/unsupported and `.odb` rejection, project switch during delayed read. Own preview port; use the matching newly built WASM. |
| Additional round trip | Supported mesh `write_inp`→reader preserves coordinates/topology/memberships up to canonical index/name mapping. Mesh equality is separate from analysis/formulation equality. Optional installed Abaqus/CalculiX cross-checks are reported as external evidence only when actually run. |

Engine/geometry changes must satisfy strict 100% lines/functions/regions with GPU coverage,
and registry glue must retain all 100% thresholds. Run codegen/schema parity, fmt/clippy,
native tests, native/WASM replay, and Chromium smoke appropriate to each step. PR fast gates
and the fuller main matrix remain separate evidence ([ADR 0022](../adr/0022-fast-pull-request-gate-full-matrix-on-main.md)).

## Issue-sized delivery sequence

| Issue | Deliverable | Depends on | Done when |
|---|---|---|---|
| [#501](https://github.com/andeplane/fem-lab/issues/501) | Persistent imported Mesher source, exact Sets/labels, Body lifecycle, source preview and ADR/glossary | #500 plan | Independent typed source can build/solve/replay; no parser is claimed. |
| [#502](https://github.com/andeplane/fem-lab/issues/502) | Strict mesh parser and schema-owned conversion Query | #501 | Independent text fixtures convert; unsupported model intent fails; native/WASM outputs agree. |
| [#503](https://github.com/andeplane/fem-lab/issues/503) | Homogeneous small-displacement static-deck translation | #501, #502 | Imported independent supported decks solve with analytical displacement/stress/reactions at refinements; units and per-node CLOAD meaning verified. |
| [#504](https://github.com/andeplane/fem-lab/issues/504) | Registry picker/inline host Command, Chromium flow and CLI | #502, #503 | Atomic file load, actual solve, save/reopen without source file and adverse session cases pass. Only then advertise supported `.inp` loading. |

Each implementation issue links this plan and remains unclaimed until work begins. If an
implementation grows beyond a day, split its remaining deliverables rather than widening a
single PR. Later slices—assemblies, multiple materials, C3D10/C3D20, pressure, output request
mapping and thermal/dynamic procedures—need their own acceptance matrix and issues. `.odb`
requires a separately designed results exchange path; the vendor describes it as a binary
output database ([file extensions](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEEXCRefMap/simaexc-c-fileextensions.htm),
[binary database](https://docs.software.vt.edu/abaqusv2025/English/SIMACAECAERefMap/simacae-t-xypcopytoodbbtn.htm)).
No binary-results reader or future Python/remote host is promised by this plan.
