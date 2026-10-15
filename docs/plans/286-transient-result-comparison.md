# Compare retained transient frames

Status: implementation plan; #286 remains open until the complete acceptance below passes.
Issue: [#286](https://github.com/andeplane/fem-lab/issues/286), child of
[#16](https://github.com/andeplane/fem-lab/issues/16) and integration with #9.
Parent plan: [Result and Journal comparison](16-result-journal-comparison.md).
Inspected main: `946bb6a45a098d24b65bcaf60968f4584a787e26` (2026-10-15).
Inspected comparison integration: #283 `4ace08f2`, then its status-fence successor
`53dac14b`. Its final browser/host step must integrate before overlapping host edits.

This covers sampled side-by-side and difference presentation, independent and synchronized
scrubbing and playback, truthful primary-field availability, unequal meshes and time schedules,
and the numerical/transport/browser gates. A plan commit is preparation, not completion.

## Existing contracts and real prerequisites

#243 and #246 are closed. `frames.rs` already owns `FrameSample`: zero-based retained
`{kind:"frame",index}` or `{kind:"time",time:Quantity,sampling:"exact"|"nearest"}`.
Exact selection tolerates only SI conversion roundoff (eight epsilon times the larger
absolute physical time). Nearest is explicitly requested, ties choose the earlier frame,
and both reject extrapolation. Indices count retained output, not integration steps.

`query.frames`, `query.frame`, sampled `query.probe` and sampled `query.path` accept an
explicit immutable `resultId`. The record owns its solved Model, Mesh, primary History and
display-unit metadata; explicit ids remain readable after Model edits. The response carries
the resolved Result id, Step, solved Model hash, retained index and physical time. Temperature
frame payloads expose x with zero y/z; 2D displacement exposes x/y with zero z. All scientific
values remain f64 SI, and renderer staging alone casts to f32. Retention is eight solves;
reads do not pin a record. No additional History storage or re-solving is necessary.

`retained.rs::query_difference` already owns spatial comparison, explicit left/right ids,
the target Mesh, f64 subtraction, incompatible-layout/dimension errors and nullable
unequal-Mesh coverage. Its `DifferenceOperand` currently has no sample, so it can only read
final fields. This is the genuine engine prerequisite within #286.

`result-transfer.ts` already transports frame arrays and nullable differences over the
checked session route. `TransientPlayback` in `transient.ts` supplies the injected
`PlaybackClock`, actual-time hold semantics, current/next caching and request generations.
Its existing single-view path targets the latest Step and rejects stale current Results;
it is not by itself an independently pinned two-Result player.

#283 supplies independently retained surfaces/fields, shared cameras, per-pane legends,
visibility, scoped picks, single-view restoration and catalogue status. Its latest fix reads
status after payload preparation and commits without a further await; pane/action sequences
and configuration/session epochs protect late replies. #286 must preserve those contracts.
The host ownership handoff waits for #283's final integration; engine preparation can remain
separate while host files are owned there. Compiler and JS/browser slots remain coordinated.

## Engine and generated boundary

Add optional `sample: FrameSample` to the existing `DifferenceOperand`. Omission keeps final
fields, one-based modal aliases, layouts and response compatibility. Supplying a sample
resolves that operand through the same existing primary-frame resolver used by `query.frame`
and sampled probes; no new temporal resolver or field-name string protocol is introduced.
Each side resolves independently and may have a different requested/resolved time. A mixed
final/sampled comparison is explicit and supported when its actual fields/layouts are compatible.

Add an optional resolved sample to `ResolvedDifferenceOperand`, identifying the actual
retained frame used on each side. It is absent for an unsampled final operand. Difference
metadata must report both actual physical times and the explicit target Result, even when
nearest selection resolves two different times. Left minus right and both target choices keep
their existing meanings. No temporal interpolation, extrapolation or index pairing occurs.

Use the existing `sampled_frame` result and `FieldData` layout helpers before entering the
current difference projector. Borrow final fields; own only the requested frame staging
needed by the difference read. Preserve the existing public three-component primary layout:
temperature occupies x with zero y/z, and 2D displacement has zero z. Scalar temperature
comparisons explicitly select component0. A final steady temperature may have one component;
mixed complete layouts retain the existing error and explicit component selection resolves it.
Test that final-frame differences agree with final-field differences on those same layouts.

A sample may read only its retained primary field (temperature or displacement, including
amplitude-driven static History when available). Stress, flux, reaction, mode and other
unretained historical fields fail with structured errors at `left.field` or `right.field`.
Never substitute a final derived field for an earlier sample. Invalid index, dimension,
exact non-retained time, out-of-range time and evicted identity retain useful operand paths
and suggested Queries. Legacy unsampled errors and final-field defaults remain unchanged.

Regenerate schema, engine types, fem declarations and runtime schema with an actual freshly
built CLI emitter from the frozen composed source. No handwritten type/schema overlay or
mutable publication API is needed. The changed Query docstring describes the temporal and
physical-field limits in the same implementation commit.

## Host and UI behavior

Extend #283's `ComparisonOperand` with the same typed sample and its pane metadata with the
requested sample, resolved frame and catalogue. No sample means final. Each side independently
offers final, retained index and physical time with an explicit exact/nearest choice. Historical
field choices come from `query.frames.field`; derived fields remain selectable only for final
views and are visibly unavailable for sampled views. The engine enforces the same restriction
for scripts and AI. Index, time and Result identity remain visible beside each pane legend.

Read sampled arrays through `query.frame` with that side's explicit id; retain its solved
surface and unit metadata. Temperature contours take the physical x values and have no
deformation controls. Explicit displacement colors and deformation use the same selected
frame. A sampled pick/probe includes that exact id/sample; a difference pick reports the engine
f64 difference and both resolved times. Neither spends a live Properties pick target or selects
an editable current-Model object. Sampled legend bounds come from the selected values, not
the final Result extrema; temperature differences remove origin offsets as #283 does now.

Keep `view.compareResults` as the explicit configuration/selection Command. Register a typed
`view.playComparison` session-view Command for play/pause/speed/scrub rather than treating
legacy `view.animate.frame` phase as time. Independent mode requires pane plus retained id,
playing, optional positive speed and optional `FrameSample`. Synchronized mode requires both
retained ids, playing, optional positive speed, optional physical `time: Quantity`, and an
explicit exact/nearest selection policy. `query.resultComparison` reports the resulting
requested/common playhead and each side's resolved frame, playing/speed state and errors.
All controls, script calls and AI calls dispatch those same schemas/docstrings.

Independent scrubbing or playback advances only the specified side, preserving the other
side's id, sample, legend and visibility. Both clocks may run independently. Synchronized
scrubbing resolves one physical time independently against both catalogues; an index scrub
on one pane is first identified by its retained timestamp, never copied as the other pane's
index. Exact mode requires a retained time on both sides and otherwise fails before either
presentation changes. Explicit nearest mode shows the two actual selected times.

Synchronized playback uses one injected wall-clock anchor in physical seconds, with positive
simulated seconds per wall second. Each schedule holds its previous retained value until its
own next retained timestamp, just as #246 does; this is a displayed hold, not an interpolated
field. Show the common playhead and both held timestamps. Playback is restricted to the
intersection of the retained physical intervals and stops at its end, identifying a longer
side's unplayed remainder; independent mode can explore that remainder. Missing overlap or
a final-only operand refuses synchronized playback. Slow reads cannot present one side's
new frame with the other side's old labels: prepare both payloads (and engine difference when
active), then atomically commit the chosen pair. No overlapping timer jobs accumulate.

Reuse the existing `PlaybackClock` boundary and #246's current/next cache discipline. At most
current/next primary payloads per side are cached, with Result id and resolved index in the
key; difference staging is separate and transient. Do not copy every History into the host
or claim a total process-memory bound from cache counts. All asynchronous preparation is
fenced by session/configuration plus appropriate per-pane/action generation. Read the current
catalogue after preparation before publication, retaining #283's corrected status ordering.

Scrub preview uses the same checked controller preparation without committed host logging.
One successful pointer/key gesture emits one final registered Command. Escape/pointer cancel
restores both captured samples and paused/playing state only if the original configuration and
session still own the gesture. A late cancellation cannot undo a newer id/sample/configuration.

Model edits or new solves pause active comparison playback and refresh stale/current status
without repinning either solve. Explicit stale retained contexts remain inspectable and may
be explicitly restarted on their own solved surfaces, with stale styling/times visible; the
existing single-view omitted-id stale refusal remains unchanged. Eviction stops affected
playback, clears unavailable drawings and reports the exact missing id. Geometry/mesh modes,
single-view restoration and project replacement stop timers and invalidate every pending
frame, difference, conversion and preview. An id reused in a new backend cannot resolve an
old callback. Modal amplitude playback and the ordinary one-Result thermal/explicit workflow
retain their existing behavior.

## Independent numerical and lifecycle acceptance

Extend `docs/BENCHMARKS.md` with the sampled comparison cases when they pass, using the existing
retained-frame thermal/free-fall Benchmarks as independent sources rather than a second
implementation of the comparator:

- Uniform heating `T(t)=T0+q*t/(rho*cp)` on two independent solves, unequal mesh densities,
  time steps, retained strides and endpoints; compare every target node to
  `T_left(t_left)-T_right(t_right)`. Use both element orders, several mesh/time choices,
  Kelvin/Celsius solved metadata, exact and nearest selectors, both onto sides and reversal.
  Add the existing amplitude-driven axial bar's primary displacement History,
  `u_x(x,t)=F*a(t)*x/(E*A)`, to check unequal-Mesh affine projection at retained times
  against a spatial closed form as well as the uniform conservation case.
- Reuse the E5 forced-slab Fourier solution and its stated series bound at several retained
  times/locations. Refine spatial meshes and time steps at both orders, checking the established
  spatial/temporal rates and absolute analytical errors rather than treating a fine run as
  truth. Use independently retained schedules, including nonintegral endpoints.
- Explicit rigid free fall in 2D and 3D, both orders and multiple meshes/time-step factors:
  `u(t)=v0*t+g*t^2/2`, so sampled differences are the closed-form subtraction at the two
  actual resolved times. Check zero-padded z, component and vector layouts, reversal,
  unequal meshes and final-frame agreement. No convergence rate is invented for an exact
  rigid-motion patch; require the independent answer at every listed refinement.
- Initial/stride/final-only schedules, exact conversions in s/ms/min, midpoint earlier ties,
  differing schedules, missing exact time, out-of-range time, wrong dimensions and indices;
  reject historical stress/flux/reaction/modes with no partial mutation. Preserve dimensions,
  unsupported spatial-layout errors and null partial-overlap coverage.
- Public checked owner tests establish old same-Step/repeated-solve identity, stale reads,
  eviction, cancellation/replacement, immutable staging and unchanged Model/Journal/catalogue
  after every read. Deferred host tests cover independent concurrent samples/legends, shared
  atomic commits, live status edits, out-of-order frame/difference replies, timer cancellation,
  bounded current/next caches and restoration after preview cancellation.
- Native CPU at one and N threads and Node WASM replay the same full-solve Journals: exact
  hashes and retained times, analytical frame/difference/probe values with documented numerical
  tolerances, both target surfaces and repeated transfer detachment. Skip-solves replay reports
  unavailable Results. Save/open cannot silently persist retained Result ids as portable data.
- Real production Chromium solves thermal and explicit pairs, selects index and exact/nearest
  physical time, demonstrates unequal schedules and both actual timestamps, independent and
  synchronized play/pause/speed/scrub/cancel, correct contours/deformation/probes, difference
  sign/coverage and immutable Journal. Include stale/new solve, eviction, geometry/mesh/results,
  session replacement and old callback refusal; retain single/modal regressions and captures.

Registry remains 100% on all metrics. Engine and geometry remain 100% lines/functions/regions,
including real software GPU paths and existing replay checks. No exclusions, timeout inflation,
coverage-only poisoned state or kernel mirror is an oracle. Generated schema freshness,
typechecks, app/MCP gates and production Chromium are required before claiming completion.
Native/host source and artifact provenance must identify the actual composed producer; no
runtime claim uses stale ignored bindings. Software adapters establish correctness, not timing.

## Feature-sized delivery and ownership

1. Commit/link this scoped plan on #286 while the shared compiler/browser slots are occupied.
2. Implement the backward-compatible sampled difference contract and independent numerical
   regressions; obtain the coordinated native/emitter slot, then publish authentic bindings.
3. After #283 lands, rebase only #286-owned work; extend its frame payload/state, typed host
   Commands and UI, retaining its race fixes. Implement independent and synchronized clocks
   with deferred lifecycle tests, then meaningful real-WASM host checks.
4. Run the matched native/WASM replay and production Chromium acceptance, required full host
   and strict GPU-inclusive coverage. Commit green feature-sized steps and publish one #286 PR.
5. Close #286 only after the full sampled comparison/playback scope passes. #16/#9 completion
   remains their owners' responsibility. A newly discovered prerequisite is filed and assigned
   rather than bypassed or silently omitted. Keep #591's separate source/proofs untouched while
   its #580 parent is being finalized.

This extends the existing read/host registry boundaries (ADRs 0003, 0007, 0008, 0012 and 0018).
Rust owns frame resolution/interpolation and scientific values; the TypeScript host owns I/O,
clock, caching and drawing. No new mutable engine entry point or second Model builder is planned.

## Implemented steps and remaining gates

The sampled engine boundary, scalar/vector compatibility, same-id selection, uniform thermal,
explicit rigid-fall, axial affine, partial-coverage and Fourier refinement oracles are implemented.
Eight public native cases pass, including decreasing spatial and temporal errors on the documented
grids. Actual optimized sampled bindings and two production Chromium cases verify independent
thermal/free-fall samples and quantitative difference/pick values. These browser receipts predate
the parent first-entry camera correction; the stronger complete-body bounds gate is still pending.

`view.playComparison` now has the typed independent/shared-clock boundary. Deferred clock and
controller tests cover irregular schedules, actual held times, shared shorter-endpoint stopping,
independent remainder, speed/pause continuity, atomic pairs, concurrent independent selections,
primary-field restrictions and late mode/session replies. Review exposed two additional clock
races: an unresolved retired read blocked its replacement generation, and an unrelated right
selection suppressed a still-current left error. Both deferred regressions fail on the original
clock step and pass with generation-owned tick locks and participating-pane error ownership;
new right playback continues while the failed left pane pauses. The focused 38-case host suite and
registry 134 cases pass; registry coverage is 100% on all four measures, and both typechecks pass.
This step is callable through the registered host Command; playback UI, transactional scrub
preview/cancel, production playback/lifecycle checks, cross-runtime replay and the final full
host/strict coverage remain open. #286 is incomplete until those gates are fulfilled.
