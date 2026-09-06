# Result and Journal comparison

Status: accepted decomposition; implementation proceeds through the linked child issues.
Parent: [#16](https://github.com/andeplane/fem-lab/issues/16), Plan 5.6 and 5.9,
jobs J8.10, J12.1 and J12.4. Inspected baseline: `8b38f06` (2026-09-06).

## Existing contracts and missing state

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

## Result records and numerical comparison

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
the ordered changes so a colleague can review what was done step by step.

## Completion gates

#16 remains open until every child above is complete. Closing it requires the full J8.10 cases:
before/after, two materials and unequal meshes, both side-by-side and as a difference field. It
also requires typed current/saved/imported Journal comparison for J12.1 and J12.4. Result and
Journal selectors, host Commands and Queries stay schema-first and callable by the UI, scripts and
AI. Native and WASM Journal hashes remain identical, generated schema/types remain fresh,
registry coverage remains 100%, and engine/geometry line, function and region coverage remains
100% including GPU paths.
