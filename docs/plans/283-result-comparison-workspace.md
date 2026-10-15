# App Result comparison workspace

Implementation issue: [#283](https://github.com/andeplane/fem-lab/issues/283).
Parent decomposition: [Result and Journal comparison](16-result-journal-comparison.md), #16.
Initial inspected source: `191c4d65` (main, 2026-10-15). Final host composition preserves
the account, hosted-AI and service changes on `e11a0285`.
Transient frame selection and playback remain #286; comparison here uses each immutable
Result's final fields.

## Existing source contracts

- `query.results` returns up to eight immutable solve ids, solved revision, current/stale,
  node/element counts and measured payload sizes. #280, #281 and #282 are closed.
- `query.result { resultId }`, `transport.surface({ resultId })` and
  `transport.field(step, field, component, resultId)` read the solved context after edits.
  The scientific Query route remains f64; surface/field staging is f32 and identity checked.
- `query.difference` subtracts explicit left/right fields on an explicit left/right target
  Mesh. It owns unequal-Mesh interpolation, dimensions, supported-layout errors and coverage.
  Missing values are null; `result-transfer.ts` preserves the validity mask across transport.
- A selected `ResultSummary` supplies its retained field extrema in the solved display units.
  Comparison must use those units, never the current Model's unit preference. Engine-retained
  fields are the comparison choices; single-Result yield-derived checks remain unchanged.
- `ResultsView` currently owns one selection and writes one `ViewerRef`. It already loads an
  explicit retained surface before fields, but the app has no two-pane state or presentation.
- `Viewer` already owns complete surfaces, topology mappings, clipping, hidden bodies,
  independent field/range/color map and point picking. OrbitControls changes currently render
  one camera. `Bundle` and `SessionTransport` already fence project replacement and replies.

## Presentation contract

The default is the existing single-Result workflow. A comparison configuration pins both
Result ids and fields; new solves, Model edits and catalogue ordering cannot replace either.
Each pane shows solve id, Step, solved revision, current/stale status, node/element counts,
field/component, its own legend and any unavailable/evicted diagnostic.

Side-by-side has two real Viewer instances, each loaded with that id's exact retained surface
and field. Camera position, target, up and projection are shared in world coordinates; orbit
and zoom in either pane update the other. Fit/preset use the union of displayed retained bounds,
not whichever current mesh happens to be active. The renderer's original per-pane bounds remain
owned by its surface. A final camera gesture is callable as the existing `view.setCamera` Command.
The first automatic preset waits for actual pane mounting/CSS layout. Perspective distance
uses the narrowest pane aspect, while orthographic drawing uses the shared world span. A
camera action after configure admission, while payloads load or panes mount, cancels that
pending fit; later edits, solves and resizes keep
the person's camera. Canvas CSS sizing and the layout box are observed directly, without timers.

Difference is left minus right, using only `query.difference`. The caller explicitly chooses
`onto: left | right`; the target id also supplies the retained surface. The display labels the
operation and target, interpolation, inside/total nodes and unavailable nodes/warnings. Missing
nodes are visibly neutral and never enter the legend extrema or become scientific zero. A
vector difference is componentwise; its magnitude is explicitly labelled as the magnitude of
the vector difference. Temperature differences apply the conversion scale without a temperature origin offset. Unsupported fields/layouts/dimensions show the engine's structured error.

Each side has independent colormap, automatic/manual range and body visibility. A pick records
its pane and Result id, highlights only that retained context, and can probe that exact Result.
Difference picking reports the engine-computed f64 value at the nearest visible target
surface node, labelled as a nodal readout; it does not invent a difference-field interpolation
Query. Picking does not spend a live Properties pick target or select a same-named editable
object in a later Model. Body names and face/Set names come from that pane's retained surface. Shared live view
Commands retain their single-Result meaning; comparison-specific visibility/picking is explicit.

Geometry and mesh modes show the current Model through the existing single viewer and suspend
comparison drawing. Returning to results resumes the pinned ids without substituting a newer
mesh. Leaving comparison restores the prior single field/legend flow. Project replacement,
missing/evicted ids and late replies clear or refuse the relevant retained presentation; they
cannot write over a newer selection or attach old values to new geometry.

## Source mapping and planned changes

| Requirement | Source seam | Change and acceptance |
| --- | --- | --- |
| Independent identities, fields and legends | `store.ts`, new `result-comparison.ts`, `fields.ts` | Store JSON presentation metadata; controller owns staged arrays/caches by explicit id/field. Select both ids independently, including repeated solves of one Step. |
| Retained geometry | `EngineTransport.surface/field`, `result-transfer.ts` | Reuse existing routes and identity checks; never fetch current surface for comparison. Compare unequal Mesh counts and before/after geometry/material edits. |
| Difference and coverage | `query.difference`, `viewer/viewer.ts` | Reuse scientific difference Query; add honest missing-value paint/pick handling. Verify sign, selected target, partial overlap and incompatible-field error. |
| Shared camera, per-pane drawing | `Viewer`, `ui/App.tsx`, `main.tsx` Bundle | Mount a second Viewer only while side-by-side is active; synchronize gesture/Command cameras and projections, fit retained union bounds, dispose owned resources. |
| Picking and body visibility | Viewer retained names; comparison controller/UI | Explicit pane/id target, retained probe/selection readout, no accidental live-Model selection. Hide/show one pane and preserve the other. |
| Stale/current, eviction and transitions | `ResultsView.refresh`, Bundle refresh/dispose | Refresh catalogue metadata without repinning ids; generation/session fences for all awaited work. Test geometry/mesh/results and project replacement during pending work. |
| UI, script and AI parity | `registry/src/host-commands.ts`, `host.ts`, generated host declarations | Comparison configuration, legend, visibility and pick/probe Commands plus comparison-state Query. Concrete schemas/docstrings; registry tests at 100%. |
| Preserve single flow | `ResultsView`, existing Legend/DeformBar, host Commands | Existing default, solve completion, scalar/derived fields, stale contours, animation/playback, selection and exports retain their single-Result behavior. |

Planned host names are `view.compareResults`, `view.setComparisonLegend`,
`view.setComparisonVisible`, `view.pickComparison`, and `query.resultComparison`.
Configuration is explicit: single mode takes no operands; side-by-side takes left/right
id/field/component; difference additionally requires the target side. Existing camera, view mode
and projection Commands remain the shared boundary. New controls dispatch the same definitions
as scripts/AI. These are host capabilities, never Journal entries or a new engine architecture point.

## Delivery and verification

1. Add the typed registry contract and controller/presentation state with deferred-transport
   regression fixtures. Check explicit-id routing, unit conversion, stale status, mismatch,
   eviction, request ordering, mode suspension, replacement and leaving comparison.
2. Add independent Viewer mount/lifetime, shared cameras, missing-data rendering and scoped
   picking/visibility. Exercise the real three.js geometry/controls with a fake GPU boundary.
3. Add the comparison controls, pane metadata/legends and difference coverage/error presentation;
   retain single controls and responsive layout. Generate host declarations from the real registry.
4. Run narrow tests then required registry 100%, app/typecheck/codegen/build gates after the
   shared worker is released. Reuse a source-matching authentic engine module; no Rust change is
   planned and no compiler or broad browser worker is started during source preparation.
5. Chromium production-build cases use real solves and rendered bounds/pixels: before/after
   edits, two mesh densities, two Materials, independent fields and legend clamps, shared orbit/
   zoom/Command cameras, pane picks, hidden bodies, current/stale/evicted ids, project replacement,
   and geometry/mesh/results transitions. Exercise both target surfaces and scientific difference
   values/coverage. Retain the existing single-Result flow. Capture actual screenshots.
6. Commit green feature-sized steps, publish one #283 PR, and report source/artifact provenance
   and actual checks. #286 playback is separate; a missing numerical prerequisite is filed and
   reported rather than reconstructed in the host or silently omitted.

## Implemented acceptance

| Public behavior | Permanent regression |
| --- | --- |
| Distinct retained ids, visible per-pane node/element counts, unequal meshes, independent fields/units/clamps, scoped picking/hiding and shared orbit | `packages/app/e2e/result-comparison.spec.ts`, independent retained panes case. Headers use the exact catalogue id's retained Mesh counts, checked against retained surface node counts on both sides; unavailable ids retain their error without invented counts. Its axial oracles are `PL/EA = 0.01 mm` and `P/A = 0.01 MPa`, with 1/2 GPa materials and 100/50 mm meshes. |
| Explicit right target, partial coverage, null probes, edit/re-solve identity, mode transitions, eviction and project replacement | The engine differences Chromium case. Outside nodes remain neutral and absent from extrema. |
| Default first-entry perspective fit after dynamic pane mounting, portrait fit with docked legends, synchronized wheel zoom, both-pane PNG export, explicit left target and structured incompatible-field rejection preserving the prior configuration | The default-first-entry and portrait panes Chromium cases. Rendered bounds are checked against each actual canvas without a manual fit on first entry; resize/export preserve the public camera. |
| Scalar thermal component zero, independent absolute Celsius legends, signed Celsius differences and absence of deformation for heat-only payloads | The thermal Chromium case uses the E1 linear steady conduction oracle. Temperature differences remove the unit origin offset. |
| Concurrent per-pane legend updates, hide/pick ordering, interrupted first load, camera actions during preparation/mounting, late Model edits/eviction, session disposal and screenshot replacement fences | Deferred typed transport regressions in `packages/app/test/result-comparison.test.ts`. |
| Retained nulls on triangles and line elements, scientific missing picks, shared camera span/zoom and disposal | `packages/app/test/sheet-viewer-lifecycle.test.ts` exercises real three.js geometry/controls with only the GPU boundary replaced. |
| UI/AI/script parity, physical quantities, exact pane/id targets, unsupported headless host and existing camera compatibility | `packages/registry/test/result-comparison.test.ts` plus the exhaustive host registry samples and coverage gate. |
| Existing single-Result fields, playback, selection, session replacement and accepted account UI | The complete app suite includes `results.test.tsx`, `transient-results.test.ts`, `main-session.test.ts` and `account-ui.test.tsx`; leaving comparison restores the existing workflow. |

The engine, Cargo/build inputs and generated engine schema are unchanged from the authentic
`d0cd3769` runtime producer. Final verification uses its complete eight-file browser/Node
bindings (artifact `11930522380`, WASM SHA256 `cb8408f4…`), after byte-level source and binding
checks. Renderer surfaces stage coordinates in f32; nodal scientific values remain f64. A
comparison pick returns the staged surface node coordinate with physical units and the
scientific nodal value, rather than claiming a new exact-coordinate interpolation Query.
Chromium screenshots and raster bounds establish browser acceptance; they do not claim
physical-device validation.
