# Plan F: one deformation path, every geometry primitive, and an @-picker that opens

Plan, 2026-09-06. Covers issues #42 (deformed shape applied inconsistently, exaggeration
unexplained), #43 (add body offers only a box) and #39 (@-mention picker opens only after a
letter and overlaps the skills row). Rules are `../../AGENTS.md`; the visual spec is
`../design/README.md`; vocabulary is `../../CONTEXT.md`. Everything here is host code
(`packages/app`) — no engine change, no schema change, no new Command.

---

## 0. Summary

1. **#42 has two root causes, both outside `ResultsView.load`.** `Viewer.setSurface` rebuilds the
   position buffer from `base` and never re-applies the current deformation, and `main.tsx`'s
   `refresh()` calls `setSurface` after *every* Command — so a surface re-push after a load
   leaves the mesh undeformed while the store still says ×1311. `ResultsView.refresh`'s
   `loadedFor` memo then skips the reload that would have put it back. The second cause:
   `setDeformScale('auto')` degrades silently to ×1 when the Viewer or the displacement is not
   there yet, and nothing ever recomputes it. PR #35 fixed the *arrays* arriving before the
   Viewer; it did not fix the deformation being wiped by a later `setSurface`.
2. **The fix is two lines and one field.** `setSurface` ends by re-applying the last deformation
   (one guard where every caller routes through: `setVisible`, `setMode`, every host refresh),
   and `ResultsView` remembers the *requested* scale (`'auto' | 'true' | number`) so `load()`
   always ends with field **and** deformation applied together.
3. **The undeformed ghost is already on screen and free.** `this.edges` is built from `this.base`
   and `drawDeformed` never touches it, so the wireframe is the undeformed outline. Colour it as
   a ghost when the scale is not ×1; no second geometry, no new state.
4. **A modest default: 5 % of the model diagonal, snapped to 1/2/5·10ᵏ** by the `nice()` helper
   extracted from the existing `niceTick`. `×1311` becomes `×1000`, which is what the legend and
   the slider can both say honestly.
5. **#43 needs no new form engine.** `SchemaForm` already renders tagged unions (kind picker,
   then fields). What is missing is the add *menu*, a `sketch` field kind, a `SketchEditor`, one
   depth bump, and an Apply that stays disabled until the required fields are filled.
6. **#39 is one wrong expression.** `const query = draft.startsWith('@') ? draft.slice(1) : ''`
   is `''` for a bare `@`, and `''` is falsy in `{openPanel('mentions') || query ? …}`. Replace
   it with a caret-anchored match that also fires mid-line, and take the popover out of absolute
   positioning so it can never cover the skills row.

---

## 1 · Issue #42 — one code path for field and deformation

### 1.1 The bug, exactly

Opening `bracket-L` from the gallery: `file.openExample` (`host.ts`) dispatches the Journal,
`await refresh()`, then `results.onAck(solved)`. Meanwhile the three.js chunk lands, `ViewerPane`
sets `viewer.current` and calls `viewer.onReady`, which in `main.tsx` fires a second, unawaited
`refresh()`. The two chains interleave:

| # | chain | what it does |
|---|-------|--------------|
| 1 | onAck | `refresh(true)` → `load()` → `setField`, `setDeformed(u, 1)` |
| 2 | onAck | `setDeformScale('auto')` → `autoScale` = 1311 → `setDeformed(u, 1311)` — **deformed, correct** |
| 3 | onReady | `refresh()` → `setSurface(...)` → new `BufferGeometry` from `base` — **deformation wiped** |
| 4 | onReady | `results.refresh()` (not forced) → `key === loadedFor` → **early return, no `setDeformed`** |

Result: an undeformed mesh under a legend that reads *deformed ×1311*. Clicking `|u|` runs
`showField` → `refresh(true)` → `load()` → `setDeformed(u, 1311)` and the shape suddenly bends;
switching back re-loads and keeps it. That is the report, verbatim.

A second ordering (Viewer arrives after the whole `onAck` chain) hits the other defect:
`setDeformScale('auto')` at `results.ts:219` finds `this.displacement && v` falsy, silently
returns 1, and the Result opens at true scale with no way to notice.

`setVisible` → `setSurface` has the same bug: hiding a body drops the deformation.

### 1.2 Changes

**`packages/app/src/viewer/viewer.ts`** (+18 / −6)
- `setSurface` (line 181): after `this.layers.add(this.mesh, this.edges)`, re-apply the last
  deformation. One guard, every caller (`setVisible`, host `refresh`, the onReady re-push) fixed
  at once. `this.box` stays computed from the *undeformed* geometry, so `autoScale` does not feed
  back on itself.
  **The re-apply must be length-checked** (review): `drawDeformed` indexes
  `displacement[this.vert[v] * 3 + k]`, and `main.tsx`'s `refresh()` calls `setSurface` *before*
  `results.refresh()`, so any Command that changes the mesh (a new body, `mesh.set`, `model.new`)
  would re-apply a displacement that is now too short — `undefined` → `NaN` positions → an
  invisible mesh. So
  `if (this.deformation && this.deformation.length >= s.positions.length) this.drawDeformed(…); else this.deformation = null;`
  with a unit case for the shrinking-surface path.
- `setDeformed` / `drawDeformed`: set the edge material's colour to `EDGE_GHOST` (`0x4a5260`)
  when `displacement !== null && scale !== 1`, back to `EDGE_GEOMETRY`/`EDGE_MESH` otherwise.
  The edges are built from `base` and never moved, so they *are* the undeformed ghost — say so
  in the doc comment. `view.toggle { layer: 'edges' }` already turns it off; no new Command.
- Extract `export function nice(x: number): number` (the 1/2/5·10ᵏ rounding inside `niceTick`)
  and let `niceTick(extent)` call `nice(extent / 20)`. One implementation.
- `autoScale` (line 316): target **5 %** of the diagonal, not 10 %, and return `nice(want)` for
  `want ≥ 1` (`Number(want.toPrecision(2))` below 1 for mass-normalised mode shapes, unchanged).

**`packages/app/src/results.ts`** (+8 / −6)
- New private field `requested: DeformScale = 'auto'`.
- `setDeformScale(s)` records `this.requested = s` before computing and applying.
- `load()` (line 150) ends with `this.setDeformScale(this.requested)` in place of
  `v.setDeformed(this.displacement, this.store.state.deformScale)`. **This is the "one code
  path": the field and the deformation are pushed by the same function, in the same order,
  every time.** An `'auto'` that could not be computed earlier is recomputed here, now that
  `this.displacement` exists.
- Delete the ad-hoc `if (choice.mode !== undefined) this.setDeformScale('auto')` in `load()` and
  the trailing `this.setDeformScale('auto')` in `onAck` — `requested` already defaults to
  `'auto'`, and a person who typed ×200 keeps ×200 across a re-solve instead of being reset.

**`packages/app/src/ui/App.tsx`** (+26 / −8)
- `Legend` (declared at line 222; the `.legend-sub` line is 232): `{s.result?.step} · exaggerated ×{formatNumber(s.deformScale)}` when the
  scale is not 1, `· true scale` when it is, with a `title`:
  *"Displacements are drawn N× larger than they are so the shape is readable. The Result itself
  is unchanged; the faint outline is the undeformed body. Press 'true scale' for ×1."*
- `DeformBar` (line 284): label the slider *exaggeration*, `max={Math.max(400, s.deformScale)}`
  and `step={Math.max(1, Math.round(max / 100))}` so a ×1000 auto scale is reachable and the
  thumb is not pinned at the end; give **true scale** `pressed={s.deformScale === 1}` so it
  reads as the toggle the design asks for.

**`packages/app/src/ui/Results.tsx`** (+12)
- A header above the two columns: *"Result · step `<name>` · `<procedure>` · solved at rev N ·
  N DOF · drawn exaggerated ×N"*, with the stale wording when `s.result.stale`. This is the
  issue's "explain in the Results tab header that a Result exists and what was solved".

**`packages/app/src/ui/style.css`** (+10) — ghost/legend/deform-bar tokens only.

### 1.3 Tests

**`packages/app/test/results.test.tsx`** (+45) — a fake viewer that records every
`setDeformed(u, scale)`:
- a `showField` between two fields pushes the same scale both times (the memo path and the
  forced path agree);
- `onAck` with `viewer.current === null`, then a Viewer arriving and a plain `refresh()`, ends
  with a non-1 scale — the Case C regression;
- an explicit `setDeformScale(200)` survives a re-solve.

**`packages/app/e2e/results.spec.ts`** (+45) — the screenshot-hash regression the issue asks for.
Colour changes with the field, so hash the **silhouette**, not the pixels: take
`query.screenshot { legend: false }`, draw it to a canvas in the page, and reduce it to one bit
per 4×4 block (`any pixel ≠ the viewer background`, `0x0d0f13` at `viewer.ts:132`) hashed with
FNV-1a (~15 lines, no dependency). **Do not pass `width`** (review): `ScreenshotOptions` declares
`width`/`height` (`host-commands.ts:41`) but `HostContext.view.screenshot` in `host.ts` ignores
them and `Viewer.screenshot(legend?)` has no size parameter, so a `width` here would be silently
dropped and the test would look more deterministic than it is. The spec already pins the size with
`page.setViewportSize`, which is what makes the hash comparable; downscale in the page if the
buffer is unwieldy. (Making `width` work is a separate issue, not this one.) Then:
- `hash(σ_vM) === hash(|u|) === hash(σ_vM)` at the auto scale — the invariant;
- `hash(true scale) !== hash(auto scale)` — proof the test can fail;
- `.legend-sub` reads `exaggerated ×N` and the number matches `.deform-bar .mono`.

---

## 2 · Issue #43 — every primitive, and a sketch editor

### 2.1 What exists

`ShapeSpec` has ten kinds (`box`, `cylinder`, `sphere`, `sheet`, `extrude`, `revolve`, `union`,
`subtract`, `intersect`, `transform`). `ui/schema.ts::taggedOf` already detects the union and
`SchemaForm`'s `field.kind === 'union'` already draws a `Segmented` kind picker plus the chosen
variant's fields. Three things are missing: the tree only ever opens `geometry.addBox`, the `+ add`
chip is rendered **only when the group is empty** (so a second body cannot be added from the tree
at all), and `SketchSpec.outer` — an array whose items are a tagged union — falls through
`field()` to `{ kind: 'json' }`, i.e. a raw textarea.

### 2.2 Changes

**`packages/app/src/ui/schema.ts`** (+45)
- `export function shapeKinds(defs: Defs): { kind: string; hint: string }[]` — read
  `defs.ShapeSpec.oneOf`, return each `properties.kind.const` with its `description`. Derived, so
  a new engine kind appears in the menu without an edit here.
- In `field()`, **before** `resolve()`: `if (raw.$ref === '#/$defs/SketchSpec') return { …base,
  tag: 'sketch', kind: 'sketch' }`. One line matching on the `$ref` name, with a `ponytail:`
  comment naming the ceiling (structural detection when a second sketch-shaped def appears).
- `export function missingRequired(fields: Field[], values: Record<string, unknown>): string[]` —
  recurse through `union` (only the chosen variant's fields) and `object`, return the labels of
  required fields that are empty. Pure, so `schema.test.ts` covers it without a DOM.
- `fieldsOf` default `depth` 2 → 3, so `geometry.subtract`'s `shape → transform → shape → box`
  renders as fields instead of JSON.

**`packages/app/src/ui/SketchEditor.tsx`** (new, ~210 lines)
- Props `{ value: SketchSpec | undefined; unit: string; onChange(v): void }`. No state of its
  own: every edit is `onChange(next)`, which `SchemaForm` routes through `form.open` exactly like
  a text field, so the AI can fill a sketch and ADR 0003 still holds.
- A loop selector (`outer`, `hole 1`, …, `+ hole`, `× hole`), then a row per segment:
  `line | arc` segmented, `to` x/y quantity inputs, arc's `center` x/y and a `ccw` toggle, a
  `tag` text box, `↑ ↓ ×` and `+ line` / `+ arc`. Every button carries `data-cmd="form.open"`.
- Live SVG preview (~60 of the 210 lines): the loop closes by wrapping — segment 0 starts at the
  **last** segment's `to` — so build the point list from `[last.to, …each.to]`; lines are `L`,
  arcs are `A r r 0 largeArc sweep x y` with `r` from `|to − center|`, `largeArc` from the swept
  angle and `sweep` from `ccw`. Holes are extra sub-paths on the same `<path>` with
  `fill-rule="evenodd"`. Numbers come from `parseQuantity`; a segment that does not parse is
  skipped and the preview says how many were.
- New default when a `sheet`/`extrude`/`revolve` kind is picked with no sketch: a 4-line unit
  rectangle in the Model's display unit, so the preview is never empty.

**`packages/app/src/ui/SchemaForm.tsx`** (+30)
- `field.kind === 'sketch'` → `<SketchEditor …>` inside the usual `<Row>`.
- `Quantity` takes a `placeholder` (`0 mm`, from `s.model?.units.length ?? 'm'`) — the issue's
  "the placeholder should show the units".
- Apply: `disabled={missing.length > 0}` with `title={\`fill in ${missing.join(', ')}\`}` — the
  issue's "should not offer Add body until the required fields are filled". Revert stays live.
  **Guard `apply()` itself too** (review): the panel is a real `<form onSubmit={…}>`
  (`SchemaForm.tsx:315`), so ↵ in any field applies whatever the button says. `apply()` returns
  early and sets `formError` when `missingRequired` is non-empty; the button's `disabled` is then
  the visible half of one rule rather than the rule. Cover the ↵ path in `form.test.tsx`.

**`packages/app/src/ui/Tree.tsx`** (+40 / −6)
- `TreeGroup.add` grows an optional `menu: { kind: string; glyph: string; cmd: string; args: object }[]`;
  `ModelTree` takes a `shapes` prop (built once in `App.tsx` from `shapeKinds(DEFS)`).
- Move the `+ add …` chip **out** of the `items.length === 0` branch so a second body can be added.
- The Geometry chip opens a small menu (the existing `.menu` markup the row context menu already
  uses): `box ▭ → form.open geometry.addBox` (the dedicated Command, which the tutorials and
  `build.spec.ts` already speak), every other kind → `form.open geometry.add { shape: { kind } }`,
  plus `cut ∖ → form.open geometry.subtract`. Glyphs are a small `Record<string, string>` with a
  `◇` fallback, so an unknown new kind still gets a row.

**`packages/app/src/ui/App.tsx`** (+3), **`style.css`** (+55, menu + editor + SVG preview).

### 2.3 Tests

- `test/schema.test.ts` (+30): `shapeKinds` returns all ten in schema order; the `sketch` kind is
  detected on `geometry.add`; `missingRequired` on an empty `geometry.add` names `Name` and
  `Shape`, and is empty once a box's `size` is filled.
- `test/form.test.tsx` (+40): pick `cylinder` in the union → radius/height fields appear; pick
  `sheet` → the sketch editor, not a textarea; add a line and assert the emitted `form.open` args
  are a valid `SketchSpec`; Apply is `disabled` on an empty form.
- `test/form-every-command.test.tsx`: unchanged, but re-run — the depth bump makes it walk deeper.
- `test/tree.test.ts` (+12) and `test/data-cmd.test.tsx` (+4): the new `shapes` prop, the menu
  entries, and the add chip present with items in the group.
- `packages/app/e2e/build.spec.ts` (+35 / −1): the existing "+ add body" click gains one menu
  click for `box` (the recorded command stays `geometry.addBox`); a new case adds a cylinder from
  the menu and a sheet whose sketch is built with the editor, then meshes and solves it.

---

## 3 · Issue #39 — the mention popover

### 3.1 The bug, exactly

`AssistantPanel.tsx:224`: `const query = draft.startsWith('@') ? draft.slice(1) : ''`. A bare `@`
gives `''`, and line 293 is `{openPanel('mentions') || query ? …}` — `''` is falsy, so nothing
opens until a letter follows. The same expression only matches at the *start* of the draft, so
`@` after any word never opens the picker at all. The popover is `position: absolute; bottom:
100%` on `.composer` with `z-index: 2` (`assistant.css:355`); `.messages` is `flex: 1`, so on a
short or empty conversation the 236 px list is drawn straight over the `.strip` skills row.

### 3.2 Changes

**`packages/app/src/ai/AssistantPanel.tsx`** (+75 / −20)
- Track `caret` (`selectionStart`) on input/click/keyup, and replace `query` with
  `const at = /(?:^|\s)@([^\s@]*)$/.exec(draft.slice(0, caret))` → `{ from, q }`. Open the
  popover whenever `at !== null` (including `q === ''`), or when the `@` button toggled
  `assistant.mentions`. The `@` button path stays exactly as it is.
- Group `shown` by kind in the order the issue lists — bodies, faces, sets, materials,
  constraints, loads, steps, results, journal, files — plus two pinned rows at the top:
  `selection` (inserts every `ui.selection.refs`, disabled when empty) and `view` / `image`
  (the two attach actions already in the bar, reused, not re-implemented). Render a
  `.group-label` per kind; cap at 8 per group with a `+N more` line so a long Journal cannot
  push the model objects off screen.
- One `active` index shared by the mention list and the existing `/skill` list (only one is ever
  open). In the textarea's `onKeyDown`, **before** the Enter-sends branch: `ArrowDown`/`ArrowUp`
  move and `preventDefault`, `Enter` picks the active row, `Escape` closes (and only closes —
  it must not clear the draft), `Tab` picks like Enter. Reset `active` to 0 whenever `q` changes.
- `insert(ref)` also strips the pending `@q` from the draft (`draft.slice(0, from) +
  draft.slice(caret)`), so the token is added and no orphan `@bo` is left to be sent.
- `refreshIndex` on open, as today.

**`packages/app/src/ai/context.ts`** (+14)
- `objectIndex` appends what the engine's `query.objects` does not carry but `resolveMention`
  and `MENTION_KINDS` both accept: `face:<name>` for every auto face of every body (from
  `query.model`, the same source `SchemaForm`'s picker uses) and `result:<step>` for each solved
  Step. Host-side, so no engine change and no new coverage burden on the Rust crate; a
  `ponytail:` comment records that the honest home for these is `query_objects`.

**`packages/app/src/ai/assistant.css`** (+30 / −4)
- Take the popover out of absolute positioning: render it as a flex item of `.assistant`
  immediately above `.composer`, with `flex: 0 1 auto; min-height: 0`, its own panel surface,
  border and `box-shadow: 0 12px 30px #000000aa`, and `overflow: auto` on `.list` only. It then
  takes its space from `.messages` (which is `flex: 1`) and **cannot** overlap the skills row or
  the composer, at any drawer height, with no magic offsets. Keep `z-index: 5` for the shadow
  over the transcript. Add `.popover .group-label` and an `[aria-selected]` row style for the
  keyboard cursor.

### 3.3 Tests

- `test/ai-panel.test.tsx` (+60), using the file's existing `type()` helper: typing `@` alone
  shows the popover; typing `ask about @be` filters mid-line; `ArrowDown ArrowDown Enter` inserts
  the third candidate as a token and leaves the draft free of `@`; `Escape` closes and keeps the
  draft; the rows are grouped and every row still carries `data-cmd="chat.insertMention"` (the
  file's existing registry check then covers them).
- `test/ai-context.test.ts` (+12): `objectIndex` lists a body's faces and a solved Step's result.
- `packages/app/e2e/smoke.spec.ts` (+30): open the drawer with no API key, type `@`, and assert
  `popover.boundingBox().y >= skillsRow.y + skillsRow.height` and
  `popover.bottom <= composer.top` — the geometric claim happy-dom cannot make.

---

## 4 · Sequence

Four commits, each green on its own:

1. **#42 engine of the fix** — `viewer.ts` + `results.ts` + `results.test.tsx`. The behaviour is
   correct here; the wording is still the old one.
2. **#42 wording** — `App.tsx`, `Results.tsx`, `style.css`, `e2e/results.spec.ts`.
3. **#39** — `AssistantPanel.tsx`, `context.ts`, `assistant.css`, the three test files. Independent
   of 1–2; can be done in parallel.
4. **#43** — `schema.ts`, `SketchEditor.tsx`, `SchemaForm.tsx`, `Tree.tsx`, `App.tsx`, `style.css`,
   the four test files, `e2e/build.spec.ts`. Largest; do it last so the two bug fixes ship first.

Totals: ~250 lines of source added, ~40 removed, ~300 lines of test, one new source file
(`SketchEditor.tsx`) and no new dependency.

---

## 5 · Risks

- **The interleaved-refresh race is timing-dependent**, so the Playwright regression can pass on a
  fast machine even with the fix reverted. Mitigated by the `true scale ≠ auto scale` assertion
  (which fails deterministically if the deformation is never applied) and by the unit test that
  drives the Case C ordering explicitly.
- **The silhouette hash is antialiasing-sensitive at the fringe.** The 4×4 block reduction with a
  "any pixel differs from the background" rule absorbs single-pixel blends; if it still flakes,
  compare block *counts* within a tolerance rather than the hash, and say so in the test.
- **The ghost edges depart from the design's "results: edges hidden".** Deliberate, and the issue
  asks for it; `view.toggle { layer: 'edges' }` is the escape hatch. Worth a line in
  `docs/design/README.md` §Viewer chrome if the design owner agrees.
- **`fieldsOf` depth 2 → 3 deepens every form**, not just geometry's.
  `form-every-command.test.tsx` mounts all of them with wrong-shaped values and is the gate; if
  a form gets visibly noisy, pass `3` only from the geometry call site rather than changing the
  default.
- **`ShapeSpec` is recursive.** `union`/`intersect` carry `shapes: ShapeSpec[]`, an array of a
  tagged union, which stays a JSON textarea. Acceptable — `geometry.subtract` and the nested
  single-`shape` kinds cover the practical cases — but say so in the field hint so nobody thinks
  it is broken.
- **The sketch preview assumes one length unit across a sketch.** Mixed units render at the wrong
  relative scale in the SVG while the *Command* stays correct (the engine converts). Guard with a
  note in the editor when more than one unit string appears.
- **Moving the popover into the flex column shifts the transcript up** when it opens. Cheaper and
  exact compared with clamping an absolutely positioned box against a strip whose height varies
  with the project folder; if the shift is judged worse than the overlap, the fallback is
  `position: absolute` plus `max-height` driven by a CSS custom property the strip's
  `ResizeObserver` sets — more code, same pixels.

---

## 6 · Out of scope

- Any engine or schema change. `query.objects` still omits auto faces and results; the host fills
  the gap and a `ponytail:` comment records where it belongs.
- A real 2D sketch **canvas** (drag points, snapping, constraints, dimensions). This is a list
  with a live preview, which is what the issue asks for; a direct-manipulation canvas is its own
  plan.
- Nested boolean trees in the Properties form (`shapes: ShapeSpec[]` stays JSON).
- Light theme tokens for the new surfaces; the ghost colour and the popover follow the dark
  tokens only, as the rest of the app does.
- Mention support for `journal:` ranges (`journal:12-20`) and project-file globbing; the picker
  lists what `objectIndex` returns and nothing more.
- Persisting the exaggeration in the Journal. View state is never journaled (ADR 0003) and this
  plan does not change that.

---

## Review (2026-09-06)

Reviewed against `main` at `f507046` (PR #35 and PR #51 in). Verdict: **all three diagnoses confirmed
in the code; ship it first.** These are the smallest, best-understood changes of the three plans.

### Diagnoses

- **#42, cause one confirmed.** `Viewer.setSurface` (`viewer/viewer.ts:181-218`) rebuilds the
  `BufferGeometry` from `s.positions` and ends at `this.paint(); this.setChrome(); this.render();` —
  it never re-applies `this.deformation` / `this.deformScale`. `setVisible` routes straight through it
  (`viewer.ts:369`), and `main.tsx`'s `refresh()` calls `viewer.current?.setSurface(await
  transport.surface())` after every journaled Command. So the surface re-push flattens the mesh while
  `store.deformScale` still reads ×1311.
- **#42, the memo confirmed.** `ResultsView.refresh` builds
  `key = step|fieldKey|clamp|journal.revision` and returns early when `!force && key === this.loadedFor`
  (`results.ts:130-133`), which is exactly the un-forced `onReady` refresh. PR #35's
  `if (!v) { this.loadedFor = ''; return; }` in `load()` (`results.ts:153-156`) is present and covers
  the *other* ordering only, as §0.1 says.
- **#42, cause two confirmed.** `setDeformScale` (`results.ts:217-221`) computes
  `this.displacement && v ? v.autoScale(this.displacement) : 1` — a silent ×1 when either is missing,
  never recomputed. `load()` ends at `v.setDeformed(this.displacement, this.store.state.deformScale)`
  with the ad-hoc `if (choice.mode !== undefined) this.setDeformScale('auto')` after it, and `onAck`
  has its own trailing `this.setDeformScale('auto')`. Both are as the plan describes; `requested` is
  the right shape and keeps a typed ×200 across a re-solve.
- **The free ghost confirmed.** `buildEdges` builds from `this.base` (`viewer.ts:222-229`) and
  `drawDeformed` only writes the mesh's position attribute, so the wireframe *is* the undeformed
  outline. `autoScale` (`viewer.ts:316-327`) targets `0.1 * diagonal` with `Math.round`, and
  `niceTick` (`viewer.ts:83-89`) holds exactly the 1/2/5·10ᵏ rounding to extract.
- **#39 confirmed to the character.** `AssistantPanel.tsx:224` is
  `const query = draft.startsWith('@') ? draft.slice(1) : ''` and line 293 is
  `{openPanel('mentions') || query ? …}` — `''` is falsy, so a bare `@` opens nothing and an `@` after
  any word never matches. The popover is `position: absolute; bottom: 100%; z-index: 2` with
  `.list { max-height: 236px }` (`ai/assistant.css:355-378`) over `.messages { flex: 1 }`, which is the
  overlap. The flex-item rewrite is the correct fix and removes the magic offsets.
- **#43 confirmed.** The `+ add …` chip lives inside the `group.items.length === 0` branch
  (`Tree.tsx:347-355`), the Geometry group's `add.cmd` is `geometry.addBox` (`Tree.tsx:122`), the
  Loads group's is `load.pressure`; `taggedOf` (`ui/schema.ts:136`) already detects the union,
  `field()` falls through to `{ kind: 'json' }` (`schema.ts:159, 186`), and `fieldsOf`'s default depth
  is 2 (`schema.ts:199`).

### Design against AGENTS.md

No engine change, no schema change, no new Command — as claimed. Every new control is a `form.open`
with `data-cmd`, including the `SketchEditor`'s own buttons, so the editor stays inside ADR 0003 and
the AI can fill a sketch the same way. `objectIndex`'s host-side face and result entries carry a
`ponytail:` comment naming `query_objects` as their honest home, which is the right way to take that
shortcut. Tests are named per file.

### Decisions

1. **Length-check the deformation re-apply in `setSurface`** (folded into §1.2 above). Without it the
   fix trades a flat mesh for an invisible one whenever the mesh changes shape, because `refresh()`
   calls `setSurface` before `results.refresh()` clears the stale array.
2. **Drop `width` from the silhouette screenshot** (folded into §1.3 above): `ScreenshotOptions`
   declares it but `HostContext.view.screenshot` and `Viewer.screenshot` both ignore it. The e2e's
   determinism comes from `page.setViewportSize`, not from the parameter.
3. **Guard `apply()`, not only the Apply button** (folded into §2.2 above): the Properties panel is a
   real `<form onSubmit>`, so ↵ bypasses a `disabled` button.
4. **Three PRs, one per issue**, in the plan's own order: #42 (two commits), #39 (one), #43 (one).
   AGENTS wants one issue per PR, and #42 and #39 are both small enough to merge the same day.
5. **The ghost-edge departure from the design is worth the design owner's line.** §5 already flags it;
   add the sentence to `docs/design/README.md` §Viewer chrome in the #42 wording commit rather than
   leaving it as a diff the design spec does not know about.
6. **Scope is honest.** `SketchEditor.tsx` is the one place this could overreach, but #43 asks for
   "a small 2D editor (points, lines, arcs, holes) rather than raw JSON" in as many words, and the
   plan declines the direct-manipulation canvas. The `Results.tsx` header is #42's second bullet.
   Nothing to cut.

### Risky assumptions to keep an eye on

- The silhouette hash's antialiasing sensitivity is real; §5's fallback (compare block counts within a
  tolerance) should be written into the test's comment when it is first written, not after it flakes.
- `fieldsOf` depth 2 → 3 widens every form. `form-every-command.test.tsx` is the gate, but if a form
  gets noisy the plan's own fallback — pass `3` from the geometry call site only — is the lazier
  change and should be preferred over arguing about the default.
- The mention popover moving into the flex column shifts the transcript when it opens. That is the
  right trade; say so in the commit message so the next reader does not "fix" it back to absolute.

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
