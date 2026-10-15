# Practical Abaqus export interoperability

Parent: [#650](https://github.com/andeplane/fem-lab/issues/650).
Planning: [#651](https://github.com/andeplane/fem-lab/issues/651).
Implementation and evidence: [#652](https://github.com/andeplane/fem-lab/issues/652),
[#653](https://github.com/andeplane/fem-lab/issues/653),
[#654](https://github.com/andeplane/fem-lab/issues/654),
[#655](https://github.com/andeplane/fem-lab/issues/655),
[#656](https://github.com/andeplane/fem-lab/issues/656),
[#657](https://github.com/andeplane/fem-lab/issues/657),
[#673](https://github.com/andeplane/fem-lab/issues/673),
[#681](https://github.com/andeplane/fem-lab/issues/681),
[#691](https://github.com/andeplane/fem-lab/issues/691).

**Status, 2026-10-15: implementation and final composed verification accepted.** The
acceptance baseline is `1986cd90`, with matching native and complete browser/Node WASM
runtimes. The final evidence below supersedes the historical baseline and intermediate
child checkpoints. Parent #650 closeout records the required strict result and parent
review. The [#500 plan](500-abaqus-import.md) retains the accepted first-slice contract;
the unsupported mappings listed below remain separate work.

## Outcome and historical baseline

An engineer loads an ordinary exported text input deck and its supplied includes, selects
the source units, inspects the retained geometry, regions and analyses, solves a supported
analysis, and compares defined quantities with an independent reference. Saving and reopening
must preserve that model without the original files. Browser, native CLI and MCP use the
same conversion semantics. Rewriting an ordinary export by hand is not the workflow.

The first slice established persistent labelled input and atomic publication, but required
a flat connected C3D4/C3D8 mesh and, in static mode, one homogeneous elastic Material,
one section, translational boundary data, CLOAD and one linear STATIC Step. It rejected
assemblies, quoted/qualified names, output blocks and density. Passing fixtures written to
that subset did not establish practical interoperability with ordinary exports. Its mesh
writer round trip also did not establish analysis-deck or exporter compatibility.

The historical audit at `518dd29f` identified these boundaries; its gaps motivated this implementation:

| Layer | Existing implementation | Gap addressed here |
|---|---|---|
| Persistent source | [Imported source](../../crates/engine/src/imported.rs) and [ADR 0026](../adr/0026-imported-mesh-source.md): one implicit Body, exact memberships, no welding, connected certified Tet4/Hex8 | Multiple material regions, shared authored nodes, disconnected components and durable scoped provenance (#652) |
| Reader | [Mesh reader](../../crates/engine/src/io/abaqus.rs): keyword whitespace compaction and uppercasing; narrow flat records | Quote-aware records, source locations, assembly/instance namespaces and transforms, supplied INCLUDE bundles, classified output bookkeeping (#653) |
| Analysis translation | [Static reader](../../crates/engine/src/io/abaqus_static.rs): one material/section/Step; numeric translational boundaries and CLOAD | Multiple linear-static load cases, active load/boundary inheritance, pressure, material regions and density with explicit time units (#654) |
| Element admission | [ImportedElementKind](../../crates/engine/src/command.rs) is Tet4/Hex8; the [geometry inventory](../../crates/geometry/src/mesh.rs) also contains Tet10/Hex20 | Faithful quadratic connectivity, faces and actual curved-cell certification; an existing solver kernel alone does not admit a persistent source (#655) |
| Hosts | [Import boundary](../../packages/registry/src/abaqus-import.ts): one inline/picked/scoped-path file, explicit length and static force scales, checked replacement | Multi-file acquisition, scoped includes, explicit time basis and useful typed reports across browser/CLI/MCP (#657) |
| Evidence | Accepted first-slice analytical and replay tests | Independent ordinary-export corpus, exact formulation/reference definitions and genuine exporter provenance (#656) |

## Implementation sequence and ownership

Each row is a separate issue/PR. Contracts can be designed in parallel; dependent source
changes integrate after their foundation is frozen. Schema names are owned by the actual
implementation, generated from Rust, and reviewed across dependent issues before host code
is compiled. This plan does not invent a second wire schema.

| Issue | Deliverable and dependency | Completion evidence |
|---|---|---|
| [#651](https://github.com/andeplane/fem-lab/issues/651) | This plan and issue backlinks | Reviewed acceptance matrix; parent #650 remains open |
| [#652](https://github.com/andeplane/fem-lab/issues/652) | Persistent element-region ownership, material/section editing and scoped provenance; foundation for #653–655 | ADR for the persistent-model change; shared-node two-material bar, separated islands, legacy source compatibility, lifecycle/replay/undo |
| [#653](https://github.com/andeplane/fem-lab/issues/653) | Quote-aware assembly normalizer over the #652 source contract; engine consumes only supplied include contents | Unchanged independent export, reused/transformed instances, duplicate local labels, exact sets/surfaces and source-located failure cases |
| [#654](https://github.com/andeplane/fem-lab/issues/654) | Typed analysis translation over #652/#653; density/time/report contract consumed by #657 | Pressure, multiple materials and multiple linear-static cases with independent numerical/refinement answers and active-state semantics |
| [#655](https://github.com/andeplane/fem-lab/issues/655) | Tet10/Hex20 source kinds over #652; connectivity records coordinated with #653 and face loads with #654 | Original curved geometry, shared curved faces, sound admission, source order/labels and independent C3D10/C3D20 comparisons |
| [#673](https://github.com/andeplane/fem-lab/issues/673) | Explicit small-strain Hex8 mean-dilatation (B-bar) for Abaqus C3D8, discovered by the unchanged independently published CAE case | Preserve existing Full Journals; volume-weighted distorted-cell patch and energy/refinement oracles; all 825 authored displacement components at the predeclared corpus tolerance; CPU thread determinism and software-adapter GPU correctness |
| [#656](https://github.com/andeplane/fem-lab/issues/656) | Independent corpus and reference ledger, assembled alongside implementation | Exact source/license/digest/solver receipts; executable acceptance only on completed paths; remaining gaps visible |
| [#681](https://github.com/andeplane/fem-lab/issues/681) | Data-only alternate files on NODE/ELEMENT INPUT over the same supplied-bundle contract | Inline/alternate geometry and identities agree; original filenames, hashes and source diagnostics survive; real hosts acquire the required files |
| [#657](https://github.com/andeplane/fem-lab/issues/657) | Browser/CLI/MCP acquisition and reports over #653 supplied-bundle and #654 unit/report contracts | Real file/folder flow through inspection, solve, comparison and portable reopen; path/cancellation/admission atomicity |
| [#691](https://github.com/andeplane/fem-lab/issues/691) | Source-labelled nodal displacement CSV through the same registry and browser export action | Scientific f64 SI fields pinned to one result and its solved Model; original part/instance/node identities, exact CSV escaping and stale-context rejection; actual import/solve/export comparison |

### Source, namespace and lifecycle contract

#652 retains one authoritative labelled source with deterministic element-region ownership.
Regions use ordinary Body material/section assignments and ordinary Queries; there is no
private constitutive path. Shared authored nodes remain shared across material regions.
Disconnected islands are preserved without coordinate welding or artificial connections;
their physical restraints are validated at solve time. Coincident nodes with distinct
source identity must not become a bonded interface. Unsupported contact/tie intent cannot
be replaced by welding.

#653 carries the source part/instance identity with local node and element labels, including
reused parts and instance-local meshes. Any allocated global labels have a deterministic,
lossless map back to that scoped identity. Sets and local faces retain exact memberships
across regions and instances. Quoting, source spelling and file-name case survive; comparison
rules follow the source format, rather than indiscriminately uppercasing quoted values.
Instance placement applies the source translation/rotation semantics in their specified
order, with fixtures that make a reversed order measurably wrong.

Source-name maps, conversion version, per-file digests and region/element provenance must
survive `query.definition`, ordinary edits, Journal replay and save/open. Body rename,
source replacement, referenced Set removal and geometry-name collisions keep their existing
dependency guards. Legacy single-Body Journals remain valid. Unsupported or inconclusive
geometry is reported before publication; neither labels nor geometry are changed to make
a source pass.

### Provided includes, publication and reports

The Rust normalizer receives a bounded, typed bundle of already supplied file contents and
source identities. It never opens a path or fetches a URL. #653 and #657 share one documented
submission-directory resolution rule, preserving filename case and diagnostic include
chains; behavior must not depend on the process working directory. Browser selection or an
open project capability, CLI and MCP provide the files through injected I/O. Outside paths,
network includes and symlink escapes are not acquisition fallbacks.

Bound the aggregate bytes, file count, nesting depth, record expansion and prepared Model
file, not just each individual file. Missing files, cycles, changed metadata, cancellation
and a stale/switched project fail before checked publication. Every asynchronous read keeps
the captured owner/project admission. Retain the existing exact prepared-file byte limit.
No error may leave half an imported Model or a partially replaced Journal.

The typed report identifies retained regions, materials, source/target names, element kinds,
analyses, units and provenance. The imported mesh definition retains the explicit formulation. A documented allowlist of output
bookkeeping is recognized and reported as configuration not executed by FEM Lab; it must
not reject an otherwise representable model. Unknown keywords, physical intent and unknown
parameters must never disappear behind a generic ignore rule. Structured errors identify
the source file/line, keyword and object plus an actionable Command. Reports distinguish
conversion from an actual solve, final linear equilibrium from increment history, and
retained metadata from supported physics.

### Units and linear-static semantics

Source units are explicit Quantities independent of display units. #654/#657 add a source
time basis alongside length and force. For scales L metres, F newtons and T seconds per
source unit, displacement scales by L, stress/pressure/Young's modulus by F/L², mass by
F T²/L and density by F T²/L⁴. For example, N–mm–s with source density `7.85e-9` yields
7850 kg/m³. Density is retained as a material property even if the selected static solve
does not consume it; retaining it does not import a modal analysis. Missing time units when
density is present must not silently mean seconds. Existing flat calls remain valid when
their required dimensions are complete. All converted values must remain finite.

#654 resolves each supported source Step's actual active boundary and load state, including
inheritance and supported OP replacement/modification. Use explicit ordinary Commands and
source Step names; blindly chaining Steps or copying only the first load case is insufficient.
Common solid boundary shorthands must map to the actual solid DOFs without admitting
unsupported beam or connector intent. Preserve per-node CLOAD meaning and exact local-face
targets for DSLOAD and DLOAD Pn. Pressure sign, source-face orientation, area and resultant
must be tested on the original cell geometry; a rendered planar skin is not a load oracle.

### Quadratic geometry and formulation boundary

#655 admits the actual Tet10/Hex20 source geometry, connectivity continuations, mixed blocks,
midside labels, face order and Set mappings. It must include genuinely curved accepted cases,
not only straight-sided cells with inserted midpoints. The current Tet4/Hex8 certificate in
ADR 0026 does not prove arbitrary quadratic injectivity, conformity or non-overlap. Record
the proposed sufficient certificate and its bounded/inconclusive behavior before extending
admission. Sampled positive Jacobians alone do not establish that certificate. Invalidity
and failure to prove validity remain distinct; no straightening, tetrahedral replacement,
order reduction or unreported change of connectivity is allowed.

Standard C3D8 uses the explicit volume-weighted mean-dilatation formulation from #673,
with eight-point integration and a projected volumetric strain. Existing Full and
IncompatibleModes Journals keep their original meanings. C3D10/C3D20 retain their supported
full integration. C3D8R/C3D20R reduced integration and hourglass control remain separate
kernel gaps; MeanDilatation is not an implementation of either. Never alias an R, hybrid, modified or otherwise distinct
element to the closest supported type. If a required corpus deck needs a missing kernel,
record that blocker and a separate issue; changing its element card is not acceptance of
the original export.

## Corpus and acceptance matrix

#656 owns exact corpus selection, source URLs/revisions, licensing and reference receipts.
The following retain the original acceptance requirements. The final composed evidence
below identifies the five selected corpus cases and the separate analytical/adverse-path
checks; those cases alone do not stand for every row. Keep each original deck unchanged;
authored adversarial fixtures supplement it. A filename or a `Generated by` comment alone
is not exporter provenance.

| ID | Required corpus/behavior | Independent answer and acceptance | Owners |
|---|---|---|---|
| A | Existing flat Tet4/Hex8 mesh/static inputs | Retain accepted source identity, units, analytical answers and adverse atomicity; backward compatibility | #652–654, #657 |
| B | Genuine ordinary Abaqus/CAE export with assembly, quoted/qualified names and output requests | Record actual exporter/version/settings and source provenance; load without manual stripping, inspect transformed bounds, labels, Sets and analyses | #653, #656, #657 |
| C | Reused part instances, noncommuting translation/rotation, duplicate local labels and scoped Sets | Independently calculated transformed coordinates/bounds and membership counts; no collisions or unintended node sharing | #652, #653, #656 |
| D | Shared-node, constant-area ν=0 two-material series bar plus separated restrained islands | `u = F Σ L_i/(E_i A)`, `σ_i = F/A`, reaction balance over independently refined source meshes; distinct coincident labels remain distinct | #652, #654, #656 |
| E | Uniform pressure on exact source solid faces, including quadratic/warped cases | Planar-face `p A n`; curved-face `∫_S p n dA` and moments, with the stated normal/sign convention. A straight prismatic axial ν=0 bar also gives `u = p L/E`; document locations and refinements | #654–656 |
| F | Multiple linear-static source load cases with inherited and changed boundary/load state | Independently specified per-Step force/displacement/reaction answers; verify OP semantics and no cross-case leakage | #653, #654, #656 |
| G | Density-bearing material and explicit L/F/T choices | Independent density/mass scaling and dimension errors; round-trip material/property/report values, including unused-but-retained static density | #654, #657 |
| H | Independent official CalculiX quadratic corpus, including selected 10p/20p cases, and suitable official Abaqus examples | Inspect actual keywords/formulations rather than infer them from filenames; compare defined U/stress/reaction quantities with recorded references; preserve source/licensing distinction | #655, #656 |
| I | Genuinely curved Tet10/Hex20 cells and shared faces; invalid or unproved neighbors | Independent affine patch/conservation and known geometric integrals where available, refinement references, exact source/face identity, meaningful reject/inconclusive witnesses | #652, #655, #656 |
| J | Multi-file includes through browser picker/project, CLI and MCP | Same normalized model semantics and digests; missing/cyclic/outside/case-mismatched/oversized inputs and mid-read cancellation leave the active owner unchanged | #653, #657 |
| K | Portable save/reopen and replay with source files unavailable | Same regions, material assignments, Sets, source-label maps, analysis definitions and numerical answers across native 1/N workers and WASM | #652–657 |

For group B, an independently published input example is useful but is not automatically an
Abaqus/CAE export. A CalculiX deck demonstrates that corpus and compatibility, not execution
in Abaqus. If a genuine export or redistribution permission is unavailable, record the
missing evidence and lawful acquisition route; do not relabel an authored fixture. Store
authoritative files only when permitted. Otherwise retain reproducible acquisition and
precisely identified independent regression fixtures. Published reference checks and actual
external-solver executions have separate ledger entries, with solver version/options and
output digests only for runs that actually occurred.

Every numerical comparison defines units, coordinate frame, source labels, evaluation
location and stress recovery convention. An averaged nodal stress is not automatically an
integration-point reference. Match geometry, material law, boundary conditions, load state
and element formulation. Displacements, stresses and reactions are queried quantitatively;
a plausible deformed picture is insufficient. Set tolerances from independent references
and existing solver guarantees, before seeing results. Where a rate is known, use independently
authored refined sources and check it; do not repeatedly solve one immutable source under
the name of remeshing. Add the actual cases to BENCHMARKS.md in their implementation commits.

## Acceptance stages and remaining gaps

1. **Baseline and contracts — verified.** #651/#656 retain the initial failures, source and
   reference ledger. #652–655 establish the source, namespace, face and report contracts.
2. **Independent components — accepted.** Child changes
   retain their schema docstrings, independent numerical/refinement tests, Benchmarks and
   ADRs. Focused coverage and child CI do not substitute for the final full engine/geometry
   100% lines/functions/regions gate, including software-adapter GPU execution without
   exclusions. Registry thresholds remain 100% in all four metrics.
3. **Composed workflow — accepted on `1986cd90`.** Real browser/CLI/MCP acquisition, explicit
   solve, quantitative comparison and source-free portable reopen pass with the matching
   source/schema/native/WASM identities recorded below. Native 1/4 determinism and WASM
   reference checks are distinct claims; native/WASM bit identity is not claimed.
4. **Parent review — accepted with terminal strict success.** The final
   [strict run 38771622293](https://github.com/andeplane/fem-lab/actions/runs/38771622293)
   and composed evidence establish this scope. A parser milestone, hand-edited source deck
   or green child PR alone cannot close the parent.

Plane/axisymmetric, thermal, modal/dynamic and beam/truss/shell import mappings are **not
completed by these children**, even where the engine already has the corresponding element
or Procedure. They need separate source/DOF/section/property/load/Step mappings, independent
references and end-to-end acceptance. Thermal import also needs an explicit absolute versus
incremental temperature convention; modal import needs correct mass/time units and mode
comparison definitions. Nonlinear/contact/tie intent and distinct element formulations need
their own demonstrated representation and solver semantics. Keep these as explicit future
rows/issues before claiming support; density or a recognized keyword is not their completion.
Binary `.odb` Results and `.cae` model databases remain outside this text `.inp` workflow.

The boundaries remain the existing [registry/Journal](../adr/0003-everything-is-a-command.md),
[headless engine](../adr/0011-engine-is-a-headless-library-browser-is-one-host.md),
[Rust/host split](../adr/0012-engine-in-rust-hosts-in-typescript.md),
[SI Quantities](../adr/0008-si-inside-units-at-the-boundary.md) and
[independent-oracle rules](../adr/0007-three-test-tiers-and-gpu-in-ci.md).

## C3D8 formulation finding — issue #673

The unchanged independently published Abaqus/CAE Job-11 case admitted all original
coordinates and identities and conserved its 4 MN load, but the original Full Hex8
operator differed from the authored displacement report by up to `1.500332e-5 m`.
Abaqus C3D8 uses mean-dilatation B-bar, rather than pointwise full integration. The
explicit new formulation reduces the actual native CLI error to `4.980294e-10 m`,
within the independent corpus tolerance declared before the diagnostic (`7.16712e-10 m`).
All 825 displacement components are compared. The original `full` and omitted
imported-source Journal meanings remain unchanged; new C3D8 conversions explicitly
select `mean-dilatation`. Other supported source kinds retain their full integration.

A separate stricter per-token diagnostic retains four near-quantum discrepancies.
Their agreement after binary32 rounding is evidence consistent with stored single
precision, whose actual use in the author's result is unknown. Neither reference
values nor either original tolerance is relaxed. The source and report remain
separately LGPLv3-licensed originals. See [ADR 0034](../adr/0034-explicit-mean-dilatation-hex8.md).
The final composed checks below retain this formulation and the original tolerances;
the diagnostic alone does not replace the browser/CLI/portable-file acceptance matrix.

## Final composed verification — frozen `1986cd90`

The [acceptance source `1986cd90`](https://github.com/andeplane/fem-lab/commit/1986cd9064e30aaf9fbd73270433ee87b3c0f7a7)
and actual CI producer `1ca68175` have the identical complete tree
`d7194dac2dad9b466372bb1a294475d0e587f649`. The
[fast run 38771622270](https://github.com/andeplane/fem-lab/actions/runs/38771622270)
provides all eight browser/Node bindings: WASM SHA-256 `a75ba0f8a351…`, schema
`c79967c2ed85…`. The independently built ARM CLI has SHA-256 `5d4df0cfbf0c…` and
emits that same schema. All 1,022 tracked source files and all eight bindings remained
unchanged across host verification. Receipts retain the full hashes and actual producer.

| Verification | Observed result on this source/runtime |
|---|---|
| Independent corpus | Both original CalculiX 2.23 quadratic beams, the FreeCAD 0.17 export, author-published Abaqus Case06 and authored two-material assembly pass their unchanged per-case reference oracles. All five native 1/4-worker canonical outputs agree after removing only timing. |
| Portable WASM replay | All five portable files load through public `SessionEngine`/`PreparedEngine` without original decks, preserve their Journal hashes, explicitly solve and pass the same numerical oracles. Cross-host bit identity is not claimed. |
| Real include acquisition | Browser, CLI and MCP acquire `Root.inp`, `Parts/Mesh.inc`, raw `Nodes.inc`/`Elements.inc` through NODE/ELEMENT `INPUT=`, and `Material.inp`. All five hashes and aggregate bytes are checked. The complete submission is deleted before solve/reopen/replay; the browser reads no selected unrelated file. The bar gives `u_x=5e-7 m`, `sigma_xx=1e5 Pa`, and root reaction `-1000 N`. |
| Registry and MCP | 191 combined registry tests and 67 MCP tests pass at 100% statements, branches, functions and lines. Codegen freshness and all-workspace typechecks pass. |
| App | 1,333 tests pass with five existing skips; coverage includes all 90 authored modules and passes unchanged thresholds. Production build, secret check and size budgets pass. |
| Actual Chromium | All nine import and two nodal-CSV tests pass in one CPU production batch, zero retries. All 36 captured engine responses across 11 traces hash to the matching WASM. Report, complete-Mesh and visible Export-row captures were inspected. |
| Comparison CSV | The downloaded author case retains all 275 source-labelled rows and all 825 displacement components. Maximum absolute error `4.980293818134234e-10 m` stays below the unchanged `7.16712e-10 m` corpus gate. The analytical two-instance case keeps duplicate local labels distinct and leaves unused-node displacements blank. |
| Required strict acceptance | [38771622293](https://github.com/andeplane/fem-lab/actions/runs/38771622293) — **terminal success confirmed**. Full engine/geometry line/function/region thresholds, including the no-exclusion software-GPU gate, and required platform checks pass. |

Reproduction uses the unchanged [corpus and reference ledger](../../tools/abaqus-interoperability/corpus.json),
[native corpus runner](../../tools/abaqus-interoperability/corpus.py),
[source-free WASM runner](../../tools/test-abaqus-corpus-wasm.mjs),
[five-file host replay](../../tools/test-abaqus-hosts.mjs),
[browser import cases](../../packages/app/e2e/abaqus-import.spec.ts) and
[CSV download cases](../../packages/app/e2e/nodal-displacements-csv.spec.ts).
The retained evidence separates actual source-solver runs from published references.

Nodal CSV is an explicit registry-backed Export action. It joins scientific f64 SI values
and original local/part/instance identities using one immutable Result ID and its solved
Model hash. Stale, evicted or source-mismatched contexts, including edits during scientific
reads, fail before delivery. Auxiliary node identities and unused authored displacements
remain blank. Standard CSV quoting preserves exact names for machine-readable interchange;
identity columns are text. See the [#691 contract](691-source-nodal-csv.md).

The author's exact Abaqus/CAE version and export settings are **unknown**. No fresh licensed
Abaqus run or general stress-recovery equivalence is claimed. The declared per-case units,
source labels, evaluation locations, formulations and tolerances remain the comparison
contract. These are local/CI-source results, not deployed-product acceptance. Plane/axisymmetric,
thermal, modal/dynamic, beam/truss/shell, nonlinear/contact/tie and binary `.odb`/`.cae`
mappings remain outside this text linear-static scope as listed above.
