# Result and Journal comparison

Status: implemented; all children #280–#286 are closed. Epic #16 awaits its owner’s
acceptance decision, not an unimplemented comparison feature. Reconciliation: [status reconciliation #612](https://github.com/andeplane/fem-lab/issues/612).
Parent: [#16](https://github.com/andeplane/fem-lab/issues/16), Plan 5.6 and 5.9,
jobs J8.10, J12.1 and J12.4. Inspected baseline: `8b38f06` (2026-09-06).

## Historical baseline and missing state (2026-09-06)

The engine currently stores one `(Model hash, StepResult)` per Step. A later solve of the same
Step replaces it. The stored Result has no immutable solve identity, solved Mesh or solved Model
metadata. Its fields and extrema survive an edit, but probes and rendering cannot attach an old
field to the mesh that produced it. The browser compounds that lifetime: `Store`, `ResultsView`,
the Worker field route and `Viewer` each select one result by Step and use the current surface.
Two mesh densities therefore cannot be compared truthfully by keeping two arrays in the app.

PR [#237](https://github.com/andeplane/fem-lab/pull/237) separates Result-input validity from
full document identity with `result_hash(Model minus display name)`. A retained Result still needs
a solve-instance identity because solving identical inputs twice must not alias in host caches.
That PR also retains only a fingerprint of the last explicit save/open Journal in app state; the
full normalized baseline required by a Journal diff remains future work.

[#243](https://github.com/andeplane/fem-lab/issues/243) owns typed access to the transient frames
already retained inside the current per-Step Result. Its `{ step, modelHash, frame }` selector is
not a solve-instance counter and its probes intentionally reject stale meshes. Result retention
must integrate that selector rather than create a parallel frame protocol. The browser transfer
and playback children [#245](https://github.com/andeplane/fem-lab/issues/245) and
[#246](https://github.com/andeplane/fem-lab/issues/246) remain the owners of generic transient
transport and playback.

## Accepted Result records and numerical comparison

The decomposition below preserves the original requirements; every listed child has merged.
The final acceptance audit follows the completion gates.

[#280](https://github.com/andeplane/fem-lab/issues/280) introduces immutable Result records. A
record needs a stable solve-instance id, Step, solved revision, #237 input fingerprint, the exact
solved Mesh and enough solved Model metadata to interpret fields without consulting a later Model.
Multiple solves of one Step remain addressable. Existing omitted selectors continue to mean the
latest compatible Result. Retention is explicitly bounded and reported; eviction is visible and
never silently substitutes current geometry. This child incorporates the stale-field protections
from [#133](https://github.com/andeplane/fem-lab/issues/133).

[#281](https://github.com/andeplane/fem-lab/issues/281) computes a typed difference field between
two Result ids. Equal topology permits component-wise subtraction. Different meshes require an
explicit target surface and interpolation of the other Result onto it. The response reports
coverage and points outside the source domain; it never pairs unrelated node indices. Independent
constant and affine solutions on unequal meshes establish sign, units, projection accuracy and
partial-overlap behavior. Missing fields, incompatible dimensions and unsupported geometry are
structured errors.

[#282](https://github.com/andeplane/fem-lab/issues/282) carries retained surfaces, ordinary fields
and differences through WASM and the Worker. Scientific Query values remain f64; only fresh
renderer staging buffers become f32 and transfer ownership. Result ids guard out-of-order replies.
This route shares its selector and transfer rules with #245.

[#283](https://github.com/andeplane/fem-lab/issues/283) adds the app comparison workspace. Each
side owns a Result id, surface, field and legend. Side-by-side mode synchronizes the cameras and
defines selection behavior; difference mode consumes #281. Chromium tests cover before/after
edits, material changes, unequal meshes, picks, hidden bodies, and geometry/mesh/results
transitions. The existing single-Result workflow remains the default.

[#286](https://github.com/andeplane/fem-lab/issues/286) integrates transient frames only after
#243. Either side may select an exact retained index or physical time. Difference fields expose
only the retained primary field unless a future child adds honest per-frame derived data. Unequal
time schedules remain explicit; playback integration waits for #246. This preserves the full
J8.10 goal for transient Results without overlapping the current frame work.

## Causally ordered Journal comparison

[#284](https://github.com/andeplane/fem-lab/issues/284) is independent of Result storage and is the
first implementation child. `query.journalDiff` compares the current Journal with one supplied
typed Journal. A Journal entry depends on every entry before it, so the comparison finds the
shared prefix by structural entry identity and returns the two ordered divergent tails as removed
and added entries. It does not apply arbitrary LCS alignment after divergence: an identical-looking
Command applied after a different predecessor is not evidence of common history. It reports both
complete Journal hashes and never reads a file, replays a Command or mutates Model, Journal,
undo/redo or caches.

[#285](https://github.com/andeplane/fem-lab/issues/285) retains the full normalized Journal from a
successful explicit open/save and exposes current-versus-saved or imported-file comparison through
the host registry and UI. Autosave and failed I/O do not establish that baseline. The second Model
is parsed for comparison without replacing the open Model. The Journal and assistant views render
the ordered changes so a colleague can review what was done step by step. An imported baseline
stays selected until the next successful explicit save/open or new Model; otherwise the saved baseline is
selected. `query.journalComparison` recomputes against that selected baseline and returns `null`
when no baseline exists or a newer request/state supersedes the reply. Comparison replies cannot
replace a newer current Journal or baseline selection. Save completion is also fenced by
Model-document identity: opening or creating another Model invalidates older pending save
callbacks, while ordinary edits preserve their exact captured normalized receipt. A late save
still writes its original payload, but cannot replace the new document's saved or imported
comparison baseline. Failed opens do not invalidate saves of the unchanged document. Added rows are positions in the causal
tail, even when Command contents/hashAfter repeat or imported `seq` labels are noncanonical.

## Completion gates

#16 remains open until every child above is complete. Closing it requires the full J8.10 cases:
before/after, two materials and unequal meshes, both side-by-side and as a difference field. It
also requires typed current/saved/imported Journal comparison for J12.1 and J12.4. Result and
Journal selectors, host Commands and Queries stay schema-first and callable by the UI, scripts and
AI. Native and WASM Journal hashes remain identical, generated schema/types remain fresh,
registry coverage remains 100%, and engine/geometry line, function and region coverage remains
100% including GPU paths.

## Final acceptance audit (2026-10-15)

The accepted source is main `eced67dd09906269c8bd946c442225846bcb99db`, whole tree
`0abc2e2799c62f21c7128565a1b93a1a09efa66b`, identical to tested #286 head `79d9b7f5`.
[Final fast CI](https://github.com/andeplane/fem-lab/actions/runs/38676074047) and
[full strict validation](https://github.com/andeplane/fem-lab/actions/runs/38676136571) passed.
The GPU-inclusive report covers 28,545 lines, 3,328 functions and 61,241 regions at 100%, with
no exclusions. The separate CPU bridge excludes `src/gpu/`; its totals are not the full report.
Native/WASM replay, registry 135/135 at 100%, app 1,274 passes plus five existing skips,
27 thumbnails, build/size, CPU Chromium 204 passes plus two skips, service-worker four passes
and SwiftShader four passes are recorded in those runs.

[Deployment 38679221526](https://github.com/andeplane/fem-lab/actions/runs/38679221526)
succeeded at that main commit. Three existing production Chromium cases passed against the
actual deployed app, zero retries: independent retained panes, sampled thermal comparison
and sampled explicit comparison. Each browser trace loaded WASM SHA256
`471980d4942142d0bb319e1b265b15f5cfc912756e3882d0872010f08747cfba`, matching the tested
complete browser/Node binding pair and emitted schema `088b6ebd…`. The deployment receipt,
source/runtime manifests, original logs and standalone replay dependencies are retained in the
#612 issue evidence index. Browser/raster acceptance does not claim physical-device or user
visual acceptance.

The original Plan 5.6/J8.10 and Plan 5.9/J12.1/J12.4 scope is present; neither half is inferred
from the other. The following public tests run in the completed final fast/strict gates.

| Original requirement | Current implementation and concrete acceptance |
| --- | --- |
| Multiple immutable solves, revision/Model identity and exact solved Mesh after edits | #280–#282 are closed. [`retained_cases.rs`](../../crates/engine/tests/registry/retained_cases.rs), [`tools/test-retained-replay.mjs`](../../tools/test-retained-replay.mjs) and [`result-comparison.spec.ts`](../../packages/app/e2e/result-comparison.spec.ts) cover repeated solves, old/current status, unequal retained surfaces, transfer ownership, eviction and immutable reads. |
| J8.10 before/after, two Materials and unequal meshes, side-by-side and signed differences | Closed #283’s independent-panes case uses the axial `PL/EA` and `P/A` oracles with 1/2 GPa Materials and two Mesh densities. The difference/coverage case checks explicit targets, partial overlap, neutral missing nodes and scientific picks. Thermal comparison checks absolute Celsius legends and signed temperature differences without an origin offset. Real camera/pick/visibility/mode/session cases and default first-entry bounds run in `result-comparison.spec.ts`; the independent-panes case also passed on the final deployed runtime. |
| Retained transient index/time selection, unequal schedules and real playback | Closed #286 adds sampled primary differences and independent/shared physical clocks. [`transient_comparison.rs`](../../crates/engine/tests/registry/transient_comparison.rs), the 24-variant replay and both final production cases cover closed forms/refinement, actual unequal timestamps, exact/nearest policy, cancellation and stale/eviction/Session fences. See [#286 acceptance](286-transient-result-comparison.md). |
| J12.1/J12.4 typed Journal comparison between Models, not replacing the open Model | Closed #284 exposes `query.journalDiff`: typed Command+hash shared causal prefix and ordered divergent tails, with no replay. Closed #285 exposes `file.compare`/`query.journalComparison`, the full explicit save/open baseline and an independently parsed imported-file baseline. [`journal-comparison.spec.ts`](../../packages/app/e2e/journal-comparison.spec.ts) checks comparison-file nonmutation, repeated causal Commands, undo, saved/imported labels and current Journal preservation. |
| Saved/imported baseline authority and late I/O | The same Journal Chromium file and [`store.test.ts`](../../packages/app/test/store.test.ts) check edits during delayed saves, late save/open/query replies, replacement and failed I/O. Autosave does not replace the explicit baseline. These are separate checks from the Result-field physics and preserve the captured saved document. |
| Registry/host parity, native/WASM hashes, schema and full coverage | The final gates above cover generated declarations and callable host definitions, registry 100%, actual native one/four-thread and Node-WASM replay, all Chromium paths and GPU-inclusive engine/geometry 100%. |

No remaining original #16 implementation gate was identified. All #280–#286 children are closed,
including the Journal half (#284/#285), and the final deployed acceptance has passed. The
owner decides epic closeout after reviewing this audit; #612 does not automatically close #16.
