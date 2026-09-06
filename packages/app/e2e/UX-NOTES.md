# UX / QA pass against `docs/design/README.md`

The app was driven through every state the design names, in a real Chromium at 1440 × 900 and
1024 × 700, and each state was put beside the prototype (`docs/design/FEM Lab.dc.html`, served
statically and screenshotted through the same driver). States covered: start (loading and
ready), the ⌘K palette from the start screen, the examples gallery, an empty Model, a Body with
no Material, the built Model, the Properties form, each bottom tab, solving, Results, the export
modal, the palette in the workspace, the Assistant drawer, the tutorial panel, stale and error.

`pageerror` and `console.error` were collected throughout: none in any state, before or after.

## Defects and what happened to them

| # | What | Where | Severity | Status |
|---|------|-------|----------|--------|
| 1 | The top bar's children all had flex's default `shrink: 1`, so at 1440 px the logo wrapped to two lines ("FEM" / "Lab"), the Solve button wrapped ("Solved ·" / "rev 9"), the palette placeholder wrapped, and the ↶ / ↷ undo glyphs were squeezed to a 4 px sliver | `style.css` `.topbar` | high — the primary action was illegible | fixed: `.topbar > * { flex: none; white-space: nowrap }`, and only `.palette-field` gives way (`flex: 0 1 330px`, `min-width: 96px`, ellipsis) |
| 2 | That fix alone made the bar's min-content widen the whole shell (1495 px at a 1440 px viewport), giving the page a horizontal scrollbar | `style.css` `.topbar`, `.under-bar`, `.workspace` | high | fixed: `min-width: 0` on the three grid boxes so the track may be narrower than the content, plus `overflow: hidden` on the bar |
| 3 | The viewer toolbar wrapped onto a second row at 1440 px and below, leaving `fit` alone underneath and colliding with the stale banner | `style.css` `.viewer-toolbar`, `.viewer-chrome` | high | fixed: the chrome now spans the full width (the legend starts at `top: 56`, below the toolbar), `flex-wrap: nowrap`, and the selection chip keeps clear of the legend instead |
| 4 | The Model tree's **Results** group was hard-coded to `items: []`, so it stayed on its empty sentence — "A Result appears when a Step finishes" — while the Solve button read `Solved · rev 9`, and its badge came from `Step.solved` rather than from the Result | `Tree.tsx` `treeGroups` | high — the tree contradicted the rest of the screen | fixed: `resultItems()` lists every contourable scalar (fields, mode shapes, the derived checks), each row is `view.showField`, the current one is the selected row, and the badge is `ok` / `stale` / `—` from `query.result` |
| 5 | The page scrolled horizontally at 1024 px (`.shell { min-width: 1180px }`) | `style.css` | high (the brief asks for 1024) | fixed: a `max-width: 1179px` block — narrower tree and Properties, single-column Results, the Assistant drawer floats over the workspace, the search field collapses to its ⌘K chip, and the two read-only passengers in the top bar (engine chip, units segmented) stand down so every *button* stays clickable |
| 6 | `.legend .swatches button { width: 34px }` also hit the two clamp chips beside the colour maps, so `0…max` overflowed its own dashed border (44 px of text in a 32 px box) | `style.css` | medium | fixed: the rule is scoped `button:not(.chip-add)`, and `.chip-add` is `flex: none` |
| 7 | The Extremes table wrote the raw wire name and index — `displacement 2`, `stress 0` — which is not what the number is called | `Results.tsx` | medium | fixed: `extremeLabel()` uses the field picker's own name (`uz`, `σxx`), with the wire name kept faint beside it |
| 8 | The location cell wrapped to three lines and the tables pushed their column wider than the panel | `Results.tsx`, `style.css` | medium | fixed: both tables sit in `.rtable-wrap` (`overflow-x: auto`), the action column is `width: 1%; white-space: nowrap` so the `go to` chip cannot be squeezed or scrolled out of reach, and only the location cell wraps |
| 9 | The legend's title showed the internal picker key (`vonMises`) rather than the field's name | `App.tsx` `Legend` | medium | fixed: `choiceOf(s.fieldKey).label` → `σ_vM` |
| 10 | Design state 7 says Solve is disabled with the error's code while an error card stands; it stayed enabled and orange | `App.tsx` `TopBar` | medium | fixed: `s.lastError` now feeds the disabled reason and the button's title |
| 11 | Esc dispatched `panel.toggle … open: false` for four panels on every press whether or not they were open, and never closed the tutorial panel | `App.tsx` | low | fixed: only open panels are closed, and `tutorial` joined the list |
| 12 | The Properties panel was a `div`, so ↵ in a field did nothing — the design's "one Apply = one Command" had no keyboard path | `SchemaForm.tsx` | medium (keyboard flow) | fixed: it is a `<form>` whose `submit` is Apply |
| 13 | `input:focus { outline: none }` left only a border-colour change, which is under 3:1 against the panel; buttons had no ring of their own | `style.css` | medium (a11y) | fixed: a global `:focus-visible` ring in the accent cyan |
| 14 | The three overlays (palette, gallery, export) had no `role="dialog"`/`aria-modal`/label, and the bottom tab strip's tabs were `aria-pressed` buttons inside a `role="tablist"` rather than `role="tab"` with `aria-selected` | `Overlays.tsx`, `Export.tsx`, `Bottom.tsx`, `cmd.tsx` | medium (a11y) | fixed |
| 15 | At 1024 px the deformation bar's fixed `right: 190px` clipped its left end against the narrower viewer | `style.css` | low | fixed in the narrow block: the bar spans the well and right-aligns |
| 16 | The design's Results tab has no history plot, no frequencies table and no derived fields; the export dialog offers no 1× / 2× | — | (the missing work, not a defect) | built — see below |

### Found only by driving a modal and a transient Step (`e2e/postprocess.spec.ts`)

Every state above was a static Step, because that is all the gallery had. The two fixtures
under `e2e/fixtures/` found four more.

| # | What | Where | Severity | Status |
|---|------|-------|----------|--------|
| 17 | `ResultsView.refresh` loaded whatever field the *previous* Result was contoured by, so `solve.run` on a modal Step failed outright with `step 'modes' has no vonMises field`, and on a heat Step with `no displacement field`. The whole Command threw, so the Journal reverted and the Result never reached the screen | `results.ts` | **critical** — modal and transient were unusable in the app | fixed: `available()` picks a field the Result actually has (its first mode shape for a modal Step), and the deformed shape is only fetched when the Result has a displacement |
| 18 | `Viewer.autoScale` rounded to an integer, and a mass-normalised mode shape wants an exaggeration near 0.1, so every mode opened at ×0 — a mode shape that could not be seen | `viewer/viewer.ts` | high | fixed: below 1 the scale keeps two significant figures |
| 19 | Both derived chips dispatched `view.showField { field: "vonMises" }`, because that is the array they read — clicking `σ/f_y` showed σ_vM | `App.tsx`, `Tree.tsx`, `fields.ts` | high | fixed: `showFieldArgs()` names a derived choice by its own key |
| 20 | The tree's Results rows put `view.showField` into the Properties form instead of running it, and it has no form (it is a host Command), so the panel went blank | `Tree.tsx` | medium | fixed: a `run` row dispatches its Command; Model rows still fill the form, which is how an edit works |
| 21 | `form.test.tsx` and `tutorial-panel.test.tsx` waited a fixed `setTimeout(20)` for Preact's effects, which loses about one run in three under a full vitest worker pool | `test/*` | medium (a flaky gate) | fixed: `test/wait-for.ts` — `waitFor` / `waitForText` / `waitForGone` poll for the state the assertion is about (2 s cap), and `afterEffects` waits for Preact's own boundary (a frame *and* the `setTimeout(0)` turn `afterNextFrame` queues behind it) rather than for a number of milliseconds. Five consecutive `npm test -w packages/app` runs green |

### Checked and found correct

- Every `[data-cmd]` in every state names a Command or Query the registry has (the built-DOM
  check in `e2e/smoke.spec.ts`, and `test/data-cmd.test.tsx` per panel).
- ⌘K opens the palette from the start screen and from the workspace; Esc closes it; ↑↓ move,
  ↵ runs a Command with no required parameters and ⇥ fills the form otherwise.
- The blocker banner names the next missing thing at every build stage, and its mono link fills
  the form with that Command.
- Quantities are echoed in SI under the field and shown in the Model's units in the tree, the
  legend, the extremes and the reactions; switching `model.setUnits` re-renders all of them.
- The stale banner, the dimmed contours and the `Re-solve` button all appear on the first Model
  edit after a Result, and the Journal marks the lines after the solve boundary.

## Known limits left alone

- The design's Report view and the light theme are not built (both are listed as open in the
  design README); the Report button opens nothing.
- Below 1180 px the top bar drops the engine chip and the units segmented. Both are reachable
  as Commands (`query.capabilities`, `model.setUnits`), and the design itself only promises
  ≥ 1180 px.

## New post-processing UI

- **History plot** — `LineChart`, one inline-SVG component with axis ticks in the Model's units
  and a hover readout, used by the transient history (`query.result.history`), the convergence
  study and the sampled path.
- **Frequencies table** — one row per natural frequency of a modal Step, with its period and a
  `view.showField { field: "mode:k" }` chip.
- **Mode shape and transient animation** — ▶ / ❚❚ and a phase scrub on the deformation bar.
  A mode shape is drawn as its own deformation and swept through `A·sin(2πt)`.
  `Engine::field_named` exposes `mode:k` but no per-frame transient arrays, so for a transient
  Step the sweep is the amplitude of the final field, and the control says so.
- **Derived fields** — `n_y = f_y / σ_vM` and `σ/f_y`, computed in the app from von Mises and
  the smallest positive `yield` in `query.model`'s current material rows, converted to SI
  from their display stress units. The legend opens clamped at 1 for a utilisation and
  at the safety cap for a factor.
- **`query.screenshot` at 1× / 2×** on the export dialog's PNG row, with explicit pixel
  dimensions forwarded to the viewer.
- **Mode-shape WebM capture** at 720p or 1080p from the Export dialog. The typed `file.export`
  Command also accepts any validated pixel size, frame rate and duration; `view.animate` uses
  the same selected mode and phase-percentage sweep.

## Follow-ups

- GIF and true transient-frame video wait for a GIF encoder and the transient frame playback
  path respectively; the app does not advertise either as available.
