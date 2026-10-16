# Available solver messages during a solve

Issue: [#743](https://github.com/andeplane/fem-lab/issues/743), a focused child of
[#90](https://github.com/andeplane/fem-lab/issues/90).

The public progress payload already carries optional engine text. CG and iterative refinement
use it for actual iteration/residual measurements, including while their fraction remains at 50%.
The accepted `2faecb11` host dropped this text before the Store and solving card, while the
request-local progress coalescer buffered fixed-percentage text changes until completion.

Preserve the supplied message through the existing transport/Store and show it as escaped,
wrapping text. Procedures that supply only a phase/percentage keep that presentation. Do not
parse an iteration maximum or invent an ETA from the fraction, and do not claim that every
procedure supplies a residual.

The runtime receives a required typed monotonic clock from the Worker host. The production
Worker supplies `performance.now`; deterministic test hosts supply their own clock. The runtime
does not read a global clock and creates no timer. Existing immediate phase/rounded-percentage
boundaries, prior-phase latest flush, and actual final sample before Ack/error are retained.
Changed message-only samples may additionally be delivered after 100 ms since the last delivery.
Thus these updates have a maximum 10 Hz rate; existing boundaries/final flush are explicit
exceptions. An unchanged message adds no periodic posts. State remains local to each serialized
request with its original id/context; progress still returns true and Cancel retains the
immediate channel-close/Worker-termination recovery route.

Original reds are retained independently: the main-host pipeline drops a typed public message,
the real solving-card component omits it, and the old coalescer (after clock-constructor plumbing
only) delivers 2 instead of 11 prescribed samples across 100,000 callbacks and 999 ms at fixed 50%.
The notification fixture wraps the real checked public engine dispatch/Ack; it is host delivery
evidence rather than a new numerical convergence claim. The first empty-workspace rendering
fixture was corrected before the genuine card red and is preserved separately.

Focused verification retains #713's 100,000-callback ≤102 notification gate under a fixed clock,
exact phase/percentage/final/error ordering, and request isolation. It adds the independent
fixed-fraction elapsed-clock schedule, no repeats for unchanged text, real main-host propagation,
live component replacement at fixed 50%, honest absent-metric display and the registered Cancel
action. One actual production Chromium case strengthens the existing physical cancellation
journey with the engine's real `stepping in time` text; all original Model/Journal/Mesh/save/reopen,
retired-authority and subsequent free-fall oracles remain intact. No synthetic browser progress,
artificial solve delay, engine/kernel change or numerical benchmark is introduced.

Local acceptance on the `2faecb11` parent passed all 37 focused tests across six files,
workspace type checks, codegen freshness, production build and size checks. The strengthened
production CPU Chromium case passed in 4.046 s with zero retries. Its actual active card showed
`stepping in time` and enabled Cancel; the checked saved files were byte-identical before and
after recovery, reopening succeeded, the retired facade rejected further work, and the later
free-fall displacement matched −gt²/2. Trace response bodies matched the accepted `a75ba0f8`
WASM. All three active/recovered/solved captures were inspected. This verifies live explicit
progress and cancellation, while typed host tests verify changing residual-message delivery;
it is not a live-browser GPU-CG convergence claim. Ordinary composed-head CI remains required.

Broader #90 all-state visual and keyboard acceptance remains separate. Real telemetry is shown
only when supplied, with no unavailable timing estimate presented as a measurement.
