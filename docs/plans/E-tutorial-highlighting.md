# E — Tutorial highlighting, card placement and a runner that advances
Note (2026-09-06): PR #51 already landed a first fix for #37/#47/#48 — `TutorialRunner.resume(tutorial, deps, entries, hash)` now proves the saved step against the Journal, `store.dispatch` carries the app's wrapped dispatch, and 'Do it for me' is disabled while pending. Build on that: replace the seq watermark with the index baseline described here.

Closes #38 and #46; finishes #12. **#37 and #47 are already CLOSED** by PR #51 — this plan does not
close them, and the runner-baseline defect below (§1 A and B) has its own `bug` + `tutorials` issue,
**#87** (AGENTS: no work without an issue). #43 stays open and is plan F's.

## 1 · Diagnosis of #37

The reported session had #36 live. `packages/app/src/lazy.tsx` did `useState(loaded)` where `loaded` is a
function component once the chunk arrived. Preact treats a function passed to `useState` as a lazy
initialiser and *calls* it, so the second mount evaluated `TutorialPanel(undefined)` and threw at
`TutorialPanel.tsx:48`.

Preact flushes its rerender queue sorted by vnode depth. `App` is shallower than the `Lazy` wrapper, so:

- `App` re-rendered with the fresh Journal → the Journal tab showed all five `material.add` lines;
- the `Lazy` child threw → `TutorialPanel` never re-rendered again;
- its watcher, `useEffect(() => { if (runner && s.journal) runner.advanceIfMatched(s.journal.entries) }, [runner, s.journal])`, **only runs on a re-render**, so `advanceIfMatched` was never called;
- the stale DOM kept the step-4 card and the `onClick` closure over the step-3-index `runner`, so every press re-dispatched the identical `material.add`.

The `expect` matcher was never at fault: `{ cmd: 'material.add', match: { name: 'steel' } }` matches the
entry exactly, and the watermark was `-1`.

`31472f1` fixed the crash. Two defects keep the stall reachable:

**A — the watermark is a `seq`, and `seq` is not a clock.** `Journal::append` sets `seq = entries.len()`
(`crates/engine/src/journal.rs:27`); `model.new` does `self.journal = Journal::default()`
(`crates/engine/src/engine.rs:131`), and `journal.undo`, `file.restore` and `file.openExample` rewrite the
Journal the same way. Once `watermark = n` survives a Journal that got shorter,
`entries.find(e => e.seq > this.watermark && …)` returns `undefined` for every future entry and the step
never advances again, however many times its Command runs.

**B — one advance per Journal object.** `runner.step` is not in the effect's dependency array, so a Journal
that already satisfies three steps advances one; and because `find` scans from index 0 with no lower bound
tied to when the tutorial started, the runner also latches onto entries that predate it.

**C — back-pressure, now half fixed.** PR #51 added a `busy` flag that disables "Do it for me" across the
await and swallows the rejection (`store.fail` has already put the error on screen), so the
five-identical-lines symptom is gone. What remains true: nothing checks whether the step's Command is
*already* journaled, so a step can be re-issued rather than recognised. The baseline loop of §2.1 gives
that for free.

## 2 · Design

### 2.1 Runner: index baseline instead of a seq watermark

`baseline` is an index into `entries`, seeded from the Journal length when the runner is created — so
pre-tutorial entries can never satisfy a step. `advanceIfMatched` clamps it when the Journal shrank, then
loops, so a Journal that satisfies several steps walks through all of them and a step already journaled is
recognised rather than re-issued (idempotence falls out for free).

```ts
advanceIfMatched(entries: JournalEntry[]): boolean {
  let moved = false;
  for (;;) {
    const step = this.currentStep;
    if (!step?.expect) break;
    // The Journal was rewritten (model.new, undo, restore): indices below it no longer exist.
    if (this.baseline > entries.length) this.baseline = entries.length;
    const i = entries.findIndex((e, k) => k >= this.baseline && matches(e.cmd as never, step.expect!));
    if (i < 0) break;
    this.baseline = i + 1;
    this.stepIndex += 1;
    moved = true;
  }
  if (moved) this.notify();
  return moved;
}
```

`constructor(tutorial, deps, startAt = 0, baseline = 0)`; `resume(tutorial, deps, hash, baseline)`;
`restart()` returns `baseline` to its seed. `matches` is unchanged.

### 2.2 The wrapped dispatch (#12)

**Landed in PR #51.** `store.dispatch` now carries the app's wrapped `dispatch` and the panel uses it
(`store.dispatch ?? ((c) => registry.dispatch(c))`), so a "do it for me" already re-reads the Journal, the
tree, the viewer surface and the results exactly as a click does. That is what #12 asked for, and the
`busy` disable is already in place.

Decision (review): **keep the `registry` prop and the `!store.dispatch` fallback.** Dropping them would
force every existing `tutorial-panel.test.tsx` case to hand in a fake dispatch and buys nothing at runtime;
the manual `Promise.all` survives only on the bare-panel path the unit tests use. Nothing left here beyond
closing #12 with the PR that lands the baseline. The `main.tsx` re-comment is cut — `main.tsx` is plan D's
file.

### 2.3 Target resolution

`Cmd` gains one attribute: `data-opens={args.command}` when it dispatches `form.open` with a string
`command`. That covers the tree's `+ add …` chips *and* every tree row *and* the banner links, all of which
already route through `form.open`. Form inputs carry a bare `data-cmd="form.open"` with no args, so they
never collide.

`candidates(step, form)` is pure and returns an ordered selector list:

1. `.props [data-field="<path>"]` for each key in `fieldsOf(step)` — only when `form?.cmd === step.expect.cmd`, i.e. the form is already open on the Command;
2. `[data-cmd="<highlight>"]` — a control that dispatches it (Solve, the start card, the units segmented, the tree's run rows);
3. `[data-opens="<highlight>"]` — a control that fills the form with it;
4. the raw string, for `highlight: "[title=\"panel.toggle results\"]"`;
5. `.palette-field` — last resort, with the card reading "press ⌘K and run `material.assign`".

`resolve(cands, doc)` returns the first match. Coverage over the nine bundled tutorials: rungs 2–4 hit 11 of
20 distinct `highlight` values; `material.assign`, `load.traction`, `constraint.temperature`,
`constraint.symmetry`, `load.temperature`, `load.convection`, `study.converge`, `model.setIdealisation` and
`geometry.add` have no control of their own today and take the palette rung. That is honest and teaches the
app; one chip per family is #43.

Note that the tree's `+ add …` chip only renders while its group is empty — which is exactly the state each
build step is in — and once an object exists its row carries the same `data-opens`.

### 2.4 Spotlight, scroll, placement

No canvas, no four-div mask. One fixed `div.tutorial-spot` at the target's rect with
`box-shadow: 0 0 0 9999px rgba(0,0,0,.45)` for the cut-out, `pointer-events: none`, and the existing
`[data-tutorial-target]` pulse for the outline. `el.scrollIntoView({ block: 'nearest' })` once per target.
Rect recomputed on `resize` and `scroll`.

`place(rect, card, viewport)` is pure: prefer `rect.right + 16`, fall back to `rect.left - width - 16`,
clamp into the viewport, and return the side so the card's `::before` triangle points the right way. When
nothing resolves — or the target is within 340 px of the right edge — the card keeps its current docked
position. That is #46's "never over the Properties panel" without a drag handle.

### 2.5 Values on the card and in the form (#46)

`fieldsOf(step)` returns `[label, value][]` from `step.fields ?? step.doIt` minus `cmd`, through a small
label map (`nu → ν`, `rho → ρ`, `kg/m^3 → kg/m³`). Deriving from `doIt` means the card can never disagree
with what "Do it for me" runs, and the nine tutorial JSONs need no edit. `fields?: Record<string, string>`
stays on `Step` as an override for when the derived list reads badly.

The same map goes into the store as `formHints: Record<string, string> | null` while a step with fields is
current; `SchemaForm` reads it into `placeholder=` on its three input sites. The tutorial module keeps its
rule of never reaching into `src/ui/**` — the dependency is one-way through the Store.

The control's name in prose is read off the resolved element's own visible text, so it cannot drift from
the UI and costs no JSON.

### 2.6 Keyboard and a11y

Focus moves to the resolved target on a step change **only** when `document.activeElement` is `body` or
inside the card — never while someone is typing. The card is `aria-live="polite"` so a new step is
announced. `@media (prefers-reduced-motion: reduce)` turns the pulse off, which is missing today.

## 3 · File-by-file

| File | Change | Lines |
|---|---|---|
| `packages/app/src/tutorial/runner.ts` | `baseline` index replaces the `seq` watermark; looping `advanceIfMatched`; baseline ctor/resume args; `restart` seeds it | +40 / −15 |
| `packages/app/src/tutorial/target.ts` | **new** — `candidates`, `resolve`, `fieldsOf`, `place`, the label map | +70 |
| `packages/app/src/tutorial/Spotlight.tsx` | **new** — `useTarget` (bounded retry, resize/scroll, `data-tutorial-target`, `scrollIntoView`, focus guard) and the cut-out div | +55 |
| `packages/app/src/tutorial/TutorialPanel.tsx` | seed the baseline; anchored card + spotlight; values list; `formHints`; `aria-live` (the `dispatch` and `pending` work landed in #51) | +65 / −15 |
| `packages/app/src/tutorial/types.ts` | `fields?: Record<string, string>` with its doc string | +8 |
| `packages/app/src/tutorial/tutorial.css` | `.tutorial-spot`, `.anchored`, arrow triangles, `.tutorial-values`, reduced-motion | +45 |
| `packages/app/src/tutorial/index.ts` | export `candidates`, `resolve`, `fieldsOf`, `place` | +2 |
| `packages/app/src/ui/cmd.tsx` | `data-opens` when `cmd === 'form.open'` and `args.command` is a string | +3 |
| `packages/app/src/ui/App.tsx` | none — the panel keeps `registry`/`store` (§2.2), so E touches only this line if the mount moves at all | 0 |
| `packages/app/src/store.ts` | `formHints` on `UiState` + `initialState` | +4 |
| `packages/app/src/ui/SchemaForm.tsx` | `placeholder` from `s.formHints` at lines 86 / 254 / 281 | +3 |
| `docs/TUTORIALS.md` | `fields`, the resolution order, the ⌘K fallback | +25 |
| `packages/app/test/tutorial-runner.test.ts` | baseline, truncation, multi-advance, stale immunity, idempotence | +70 |
| `packages/app/test/tutorial-target.test.tsx` | **new** — candidate order, resolve against a fixture DOM, `fieldsOf`, `place` | +90 |
| `packages/app/test/tutorial-panel.test.tsx` | rewrite the fake to a `dispatch` mirroring `refresh`; pending-disable; already-journaled step; anchored card; `formHints` | +80 / −25 |
| `packages/app/test/data-cmd.test.tsx` | every `data-opens` names a real Command | +5 |
| `packages/app/e2e/tutorial.spec.ts` | the whole cantilever by highlighted controls only | +70 |

≈ 640 added, 70 removed, two new source files and one new test file.

## 4 · Sequencing

1. Runner baseline + its unit tests (green on its own; fixes the stall).
2. Panel tests for the already-journaled step and the pending disable (#12 and #37 are already met by #51).
3. `data-opens`, `target.ts`, its unit tests.
4. `Spotlight.tsx`, CSS, anchored placement (#38).
5. `fieldsOf`, `formHints`, `SchemaForm` placeholders, card prose (#46).
6. Docs, then the e2e as the last commit.

Each is green and self-contained.

## 5 · Tests

**Unit — runner.** A Journal truncated by `model.new` still advances (the case that stalls today). A step
whose Command is already journaled advances without a dispatch. Entries that predate the runner never
satisfy a step. One `advanceIfMatched` call walks three satisfied steps and notifies once.

**Unit — target.** `candidates` ordering with and without an open form; `resolve` against a fixture DOM
carrying `data-cmd`, `data-opens`, `.props [data-field]`, a raw selector and nothing at all; `fieldsOf`
derived from `doIt` and overridden by `fields`; `place` on both sides and clamped at the viewport edge.

**Unit — panel.** "Do it for me" is disabled across the await and re-enabled after. `doIt` → fake dispatch
appends to the store's Journal exactly as `refresh` does → the panel advances (this is the test #37 asks
for, driven through the real panel). A step already in the Journal advances without calling `dispatch`.
The card carries `.anchored` and a `left`/`top` when a target exists, and stays docked when none does.

**E2E — `@cpu`, `test.setTimeout(180_000)`.** Complete the cantilever tutorial clicking only highlighted
controls: for each step assert `[data-tutorial-target]` exists and is visible, click it; if the step has
fields, fill each `.props [data-field]` from its own `placeholder` and press Apply; assert
`.tutorial-progress` advanced. The two palette-fallback steps click `.palette-field`, type the Command and
press ↵. Assert the card never overlaps `.props` (compare bounding boxes) — that is #46's regression gate.

## 6 · Risks

- The anchored card at 1024 px can collide with the Properties panel; `place` clamps, and the docked
  fallback triggers within 340 px of the right edge. The e2e's overlap assertion is the gate.
- The dim layer sits over the WebGL canvas as a sibling with `pointer-events: none`; it is its own
  compositor layer and does not force a canvas repaint, but check the frame time on the results view.
- `data-opens` enters a shell whose invariant is enforced against `registry.list()`; the added assertion in
  `data-cmd.test.tsx` keeps it from drifting.
- Changing the panel's props breaks the five existing `tutorial-panel.test.tsx` cases; they must be updated
  in the same commit.
- Focus routing is the one place this can annoy: the `activeElement` guard is load-bearing, and the e2e
  should type into a form field and confirm focus is not stolen on the next step.
- The e2e becomes the slowest gate in the suite (~60–90 s against real wasm).

## 7 · Out of scope

- ~~#47~~ — closed by PR #51: `TutorialRunner.resume` proves the saved step against the Journal before
  applying it.
- **#43** — one chip per geometry primitive / load kind, which is what would retire the palette fallback.
- Dragging or hand-docking the card (#46's second half): anchored placement that never covers the target
  is the actual requirement; a drag handle is state to persist and a11y to get right for no gain.
- KaTeX rendering of `theory` (#14), and adding the missing `solve.run` steps to the tutorials that end
  before the solve.
- The Assistant's `registry` Proxy in `main.tsx` stays as it is.

---

## Review (2026-09-06)

Reviewed against `main` at `f507046` (PR #51 in). Verdict: **the diagnosis holds, the issue list does
not.** #37 and #47 are closed; retarget the plan at #38 and #46, close #12 alongside, and file a new
issue for the runner baseline.

### Diagnoses

- **A confirmed, and still live after #51.** `Journal::append` sets `seq = self.entries.len()`
  (`crates/engine/src/journal.rs:26-27`) — an index, not a clock. `model.new` resets the Journal
  (`crates/engine/src/engine.rs:133`, and a second reset at 228 for the import path), and `undo` pops
  entries off it (`engine.rs:163`), so seqs are re-used. `advanceIfMatched` compares `e.seq >
  this.watermark`, and #51 only seeds the watermark in `resume`/`provenStep` — nothing clamps it
  afterwards. A Journal that got shorter therefore leaves the watermark unreachable and the step
  stalls for good. The index baseline is the right fix.
- **B confirmed on both halves.** The effect is `[runner, s.journal]` and `advanceIfMatched` advances
  at most one step, so a Journal that satisfies three (a resume, an example, a replayed share link)
  advances one. And picking a tutorial from the list goes through `new TutorialRunner(t, deps, 0)`
  with `watermark = -1`, so entries that predate the tutorial satisfy its steps instantly.
- **C now half true**, corrected in §1 above: #51's `busy` flag disables the button across the await.
  What remains is idempotence, which the baseline loop supplies.
- **§2.3's `data-opens` premise confirmed.** Tree rows dispatch `form.open` with
  `args={{ command: item.cmd, args: item.args }}` (`Tree.tsx:304-307`), the `+ add …` chip and the
  banner's fix link the same; the Properties form's own inputs carry a bare `data-cmd="form.open"`
  with no args (`SchemaForm.tsx:86, 254, 281`), so there is no collision.
- **Coverage count confirmed.** The nine bundled tutorials use 20 distinct `highlight` values; nine
  have no control of their own (`material.assign`, `load.traction`, `constraint.temperature`,
  `constraint.symmetry`, `load.temperature`, `load.convection`, `study.converge`,
  `model.setIdealisation`, `geometry.add`) — eight once plan F's Geometry add menu gives
  `geometry.add` a control.

### Design against AGENTS.md

No new Command, no engine change, `data-opens` is an attribute on controls that already carry their
`data-cmd`, and the tutorial module still reaches the UI only through the Store (`formHints`). The
`data-cmd` ⊆ `registry.list()` invariant is untouched and the plan adds an assertion for the new
attribute. All good.

### Decisions

1. **Do not drop the `registry` prop.** #12 is already satisfied by `store.dispatch`; removing the
   fallback would churn five existing tests for no runtime gain. §2.2 is rewritten to say so.
2. **Rung 2–4 must exclude the Properties panel.** `SchemaForm`'s **Revert** button is
   `cmd="form.open" args={{ command: form.cmd, args: form.initial }}`, so under §2.3 it will carry
   `data-opens="<the command the step is about>"` and the spotlight can land on *Revert*. Skip
   elements inside `aside.props` for rungs 2–4 (rung 1 is the only one that should ever point into
   the form), and add that case to `tutorial-target.test.tsx`.
3. **`place()`'s recompute needs a capturing scroll listener.** The tree and the Properties panel are
   their own scroll containers; a `scroll` listener on `window` never fires for them, so the
   spotlight and card drift when a person scrolls the tree. `addEventListener('scroll', …, true)`,
   or accept the drift and say so in §2.4.
4. **Do not move the tree's `+ add …` chip.** §2.3's note that the chip only renders while the group
   is empty is correct, and plan F #43 moves it out of that branch — E must not do it too. After F,
   a group with items has both the chip and the row carrying `data-opens` for related Commands, so
   `resolve` takes the first in DOM order; that is the chip, which is the better target anyway.
5. **File the runner-baseline issue before starting.** #37 is closed; a PR whose body says
   `Closes #37` would reopen a settled thread. The baseline work is a new `bug` + `tutorials` issue,
   linked from this plan (AGENTS: plans link both ways).
6. **Answer #46's "dragged or docked" on the issue, not only here.** §7 declines the drag handle for
   good reasons; the issue should carry that decision so it can be closed honestly.
7. **Scope is otherwise right.** `fieldsOf` deriving from `doIt` rather than editing nine JSON files
   is the lazy correct call; `Spotlight.tsx` at ~55 lines with one `box-shadow` cut-out beats a
   four-div mask; `prefers-reduced-motion` and `aria-live` are accessibility, never to be trimmed.

### Tests

The named set is adequate and the e2e's card-vs-`.props` overlap assertion is the right #46 gate. Add
two cases: the spotlight never resolves onto **Revert** (decision 2), and a `model.new` mid-tutorial
that truncates the Journal still advances (defect A, driven through the real panel — that is the test
#37 asked for and it belongs to the new issue).

## Ownership and merge order

Three plans, three worktrees, one shell. Merge **F → E → D**. F is two small bug fixes plus one
feature and touches the viewer, the results path and the Assistant's composer; E is the tutorial
module plus one attribute in `ui/cmd.tsx`; D is the largest, moves the Assistant drawer and rewrites
the start screen, so it rebases onto the other two rather than the other way round.

File ownership — a plan edits only what it owns; anything else it needs, it waits for:

- **F owns** `viewer/viewer.ts`, `results.ts`, `ui/Results.tsx`, `ui/Tree.tsx`, `ui/schema.ts`,
  `ui/SketchEditor.tsx` (new), `ui/SchemaForm.tsx`, `ai/assistant.css`, `ai/context.ts`, the mention
  half of `ai/AssistantPanel.tsx`, and in `ui/App.tsx` only `Legend`, `DeformBar` and the `shapes`
  prop. Tests: `results.test.tsx`, `schema.test.ts`, `form.test.tsx`, `tree.test.ts`,
  `ai-panel.test.tsx`, `ai-context.test.ts`, `e2e/results.spec.ts`, `e2e/build.spec.ts`.
- **E owns** `tutorial/**`, `ui/cmd.tsx`, `store.ts`'s `formHints` field, and in `ui/App.tsx` only
  the `<TutorialPanel …/>` line. Tests: `tutorial-runner.test.ts`, `tutorial-target.test.tsx`,
  `tutorial-panel.test.tsx`, `e2e/tutorial.spec.ts`. E does **not** touch `main.tsx` (its comment
  change is cut) and does **not** move the tree's `+ add …` chip — that is F #43.
- **D owns** `db.ts` (new), `projects.ts` (new), `share.ts`, `host.ts`, `main.tsx`,
  `ui/Overlays.tsx`, `packages/registry/src/host-commands.ts`, the `chatBridge` half of
  `ai/AssistantPanel.tsx`, and in `ui/App.tsx` the top bar, the `started` branch and the Assistant
  mount. Tests: `projects.test.ts`, `share.test.ts`, `packages/registry/test/*`,
  `e2e/projects.spec.ts`.

Three files are shared and get a rule instead of an owner:

- `ui/App.tsx` — the three disjoint regions above. Whoever merges later rebases; nobody reformats.
- `store.ts` — append new `UiState` fields at the end of the interface and of `initialState`, in
  merge order (E's `formHints`, then D's `project` / `projects` / `saving` and D's removal of
  `autosave`). Textual conflicts only.
- `ui/style.css` and `test/data-cmd.test.tsx` — append your block or case at the end under a comment
  naming the plan; never edit another plan's block. D rewrites the start-screen `data-cmd` case last.

Two ordering dependencies are real rather than cosmetic:

1. **E's `formHints` placeholders sit on F's `placeholder` prop.** F #43 adds `placeholder` to
   `SchemaForm`'s three input sites (lines 86, 254, 281); E only chooses the value. E's steps 1–4 are
   independent and can land first; E's step 5 rebases after F #43, or ships the store field with the
   wiring as a follow-up commit.
2. **D renames `query.project` → `query.folder` and `project.open` → `folder.open`.** F's
   `objectIndex` (`ai/context.ts:145`) reads the Query and `AssistantPanel`'s folder button
   dispatches the Command. F merges first; D carries both renames in its rename commit.

One consequence of the order: F #43's Geometry add menu gives `geometry.add` a `data-opens` control,
so E's palette fallback covers eight `highlight` values after F, not nine.
