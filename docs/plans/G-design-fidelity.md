# Design fidelity audit

Tracking issue: [#90](https://github.com/andeplane/fem-lab/issues/90).

The acceptance reference is [the handoff README](../design_handoff_fem_lab/README.md),
with [the design brief](../design_handoff_fem_lab/DESIGN-BRIEF.md) for behaviour and
`FEM Lab.dc.html` for visual comparison. The prototype's example numbers and simulated
operations are not production implementations. Engine data must remain real; no fabricated
verification, geometry, reference values, or performance estimates may fill a visual gap.

This is an open audit, not a statement that the app conforms. The current source checkpoint is
main `09a1530` on 6 September 2026. Its [CI run](https://github.com/andeplane/fem-lab/actions/runs/34057866763)
and [deployment run](https://github.com/andeplane/fem-lab/actions/runs/34057866823) completed
successfully. Those runs establish that the committed checks pass; they do not compare every
handoff state pixel-for-pixel. Live issue and PR state below was read on the same date. The moving
main branch advanced after this checkpoint, so a later merge is identified explicitly instead of
being counted as part of `09a1530`.

## Delivery update — 7 September 2026

The integrated source checkpoint is now main `3a3e1e40e2496ae745768ae1f6473170d32d60e0`.
Its [deployment](https://github.com/andeplane/fem-lab/actions/runs/34074659030) passed,
including the actual thumbnail-generation step. Its
[CI](https://github.com/andeplane/fem-lab/actions/runs/34074659080) remains in progress at
this audit update; Windows and native/WASM parity have passed. This is not a claim that all
current-main gates or the complete design audit have passed.

The matrix below is retained as a historical checkpoint. Its statements that #221, #223,
#227 and #237 are open have been superseded: all four are merged into current main.
The corresponding source changes deliver pressure area/force previews, structured simplex
mesh selection, CodeMirror Script editing, and explicit Model saved-state semantics.
Assistant Checks, suggestions and the drawer background from #356 are also in current main.
These delivery facts do not close the remaining whole-screen and interaction acceptance gaps.

The theory work was not merged through #199: GitHub closed that stacked PR without a merge.
Its replacement [#366](https://github.com/andeplane/fem-lab/pull/366) merged at main
`19a6f5ddb2782bbaecb3dd0d1b3d555e470518f9`. All seven checks passed on its exact
source tree before merge; the actual merge tree matched. The subsequent
[deployment](https://github.com/andeplane/fem-lab/actions/runs/34095869924) passed,
including thumbnail generation. Subsequent
[main CI](https://github.com/andeplane/fem-lab/actions/runs/34095869938) completed
successfully with all seven checks, including CPU, service-worker and WebGPU browser scenarios.
Step dragging remains in #233, with all seven branch checks passed. Project-folder integration remains in #252. Full design acceptance remains open.

A manual inspection of the deployed page on 7 September used a new empty audit project with
Properties and Assistant open. At a 1600 × 1000 viewport, the order was Tree, Viewer/Bottom,
Properties, Assistant: the Assistant was on the right, not below the workspace. It showed
skills, suggestion shortcuts and the composer in the drawer. The 1180 × 1000 inspection
confirmed the same placement; DOM viewport width and document scroll width were both 1180.
This checks the original placement complaint for the empty-model state only. The viewer
control strip was clipped at its right edge with all panels open, so complete control
reachability and the populated Result-state comparison still need explicit acceptance.
No Assistant request or paid evaluation was submitted during this inspection.

### Deployed report inspection

A second manual inspection on 7 September opened the bundled cantilever through the Gallery,
then opened Report after the ten-Command solve completed. The full-screen calculation note
rendered the actual Model/revision, units, assumptions, geometry/material tables, Results,
verification and Journal. Two KaTeX expressions rendered, and the current static Result image
was fully decoded at 2400 × 1350. The report dialog's scroll width equalled its 1600 px client
width. This is direct evidence for the report's populated screen state, not print pagination.

Copy Markdown was invoked, but the browser tool returned an empty clipboard and exposed no
error feedback; its successful output is therefore unverified in this session. Subsequent
browser control timed out, so print/PDF and the remainder of the comparison were not completed.
The report acceptance row remains open. No API-backed Assistant request was made.

### Deployed Theory inspection at `19a6f5d`

A manual inspection of the newly deployed cantilever at 1600 × 1000 showed the
Theory panel beside the real Results table in the bottom panel. The card rendered
the bending and Timoshenko shear formula, current FEM displacement −0.1901 mm,
reference magnitude 0.192 mm, difference 0.957 %, and the ≤ 2 % tolerance with a
pass indication. Its source named the Euler–Bernoulli plus Timoshenko correction
and catalogue B1. The viewer showed the solved contoured beam and deformation
scale ×200; the Journal contained ten Commands.

This verifies the populated cantilever comparison on the deployed merge. The
Assistant was closed in this inspection; narrow-width scrolling, other benchmark
cards and the complete integrated state sweep remain separate acceptance work.

### Deployed Gallery and populated drawer inspection

A subsequent deployed-page inspection on 7 September confirmed all 22 Gallery
preview images were decoded at their intended 320 × 180 dimensions. The Gallery
exposed tag and difficulty filters, Command counts and benchmark references.
This is direct image-loading evidence; keyboard filtering remains part of the
interaction sweep.

Opening the cantilever and Assistant at the browser's 1280 × 720 viewport kept
the Assistant on the right and the document scroll width at 1280 px. The drawer
showed seven skill shortcuts, two suggestions and its composer. The adjacent
viewer controls and part of the Theory card were visibly clipped; horizontal
and keyboard reachability still require acceptance. This viewport does not
replace the required 1180 px boundary and 1600 × 1000 reference comparisons.
No paid Assistant request was submitted.

### Current source and scenario references

These references were inspected at `3a3e1e4`; scenario existence is not a substitute for
side-by-side visual acceptance.

| Delivered PR | Source and committed scenario | Remaining visual comparison |
| --- | --- | --- |
| #237 Model saved state | `src/ui/ModelName.tsx`, `src/store.ts`, `src/host.ts`; `e2e/model-document.spec.ts` | Long names, focus/truncation and top-bar density with both dirty dot and autosave status. |
| #221 Pressure preview | `src/ui/PressurePreview.tsx`, `src/ui/SchemaForm.tsx`; `e2e/pressure-preview.spec.ts` | The separate scalar pressure-times-area row versus the reference's compact quantity echo; wrapping and loading/error states at 308 px. |
| #227 Script editor | `src/ui/ScriptEditor.tsx`, `src/ui/Bottom.tsx`; `e2e/script-editor.spec.ts` | Reference syntax palette, 252 px panel, 214 px rail, gutter and error/output composition. |
| #356 Assistant surface | `src/ai/AssistantPanel.tsx`, `src/ai/assistant.css`, `src/ui/Results.tsx`; `e2e/assistant.spec.ts` | Populated drawer, card/composer density and suggestion wrapping; empty-drawer placement alone does not accept these. |
| #223 Simplex selection | `src/ui/SchemaForm.tsx`, `src/ui/Tree.tsx`, engine `command.rs`; `e2e/mesh-warning.spec.ts` | Discoverability of family/order choices and warning layout. The shipped quadratic fix preserves simplex family; the reference's Hex20 wording is not literal acceptance for Tet10. Free 3D tetrahedral meshing remains #22. |

App paths above are relative to `packages/app/`. Engine `command.rs` is
`crates/engine/src/command.rs`.

## Evidence key

- **Merged + rendered** — the implementation is in `09a1530`, and a committed Chromium scenario
  exercises the relevant visual or interaction state. The exact-baseline browser job is green.
- **Merged + source/test** — the implementation and direct tests are in `09a1530`, but this audit
  has no committed browser scenario that renders the complete handoff state.
- **Partial** — useful implementation is in the baseline, but a named handoff requirement remains.
- **Pending** — an open issue or PR contains work that is absent from `09a1530`. Passing branch
  checks are development evidence only; they are neither delivery nor merged-main acceptance.
- **After baseline** — a live PR merged after `09a1530`; its issue may therefore be closed even
  though the implementation is intentionally absent from this source checkpoint.

Source and test paths in the matrix are relative to `packages/app/` unless they begin with
`tools/`.

## Historical requirement matrix at `09a1530`

| Handoff requirement | Status at `09a1530` | Source and test evidence | Rendered acceptance or remaining gap |
| --- | --- | --- | --- |
| Desktop shell: Tree, Viewer/Bottom, Properties and Assistant in the specified order, with usable resizing | **Merged + rendered** ([#88](https://github.com/andeplane/fem-lab/issues/88), [#174](https://github.com/andeplane/fem-lab/issues/174)) | `src/ui/App.tsx`, `src/ui/style.css`; `e2e/smoke.spec.ts`, `e2e/panels.spec.ts` | Chromium checks canvas backing size, drawer placement, dividers, clamps and repeated toggles at 1100–1600 px. A final whole-screen comparison with every panel populated is still required for audit closure. |
| Dark tokens, IBM Plex Sans/Mono weights and FEM Lab mark | **Merged + rendered** ([#99](https://github.com/andeplane/fem-lab/issues/99), [#100](https://github.com/andeplane/fem-lab/issues/100)) | `src/ui/style.css`, local font assets; `e2e/smoke.spec.ts` | Chromium loads Sans and Mono at 400/500/600 and checks the mark. It does not prove every component uses the reference token, spacing and type role. |
| Top-bar actions remain reachable at the supported desktop width | **Merged + rendered** ([#103](https://github.com/andeplane/fem-lab/issues/103)) | `src/ui/App.tsx`, `src/ui/style.css`; `e2e/smoke.spec.ts` | The committed scenario checks nine widths from 1180 through 1600 px for clipping and overflow. |
| Editable Model/project name and truthful saved state | **Partial; pending #123** | `src/ui/App.tsx` has `ProjectName`, `project.rename` and an autosave status chip; `test/data-cmd.test.tsx`, `e2e/projects.spec.ts`, `e2e/open-file.spec.ts` | The baseline deliberately presents autosave state rather than the handoff's unsaved dot. [PR #237](https://github.com/andeplane/fem-lab/pull/237) remains open for the explicit saved-baseline semantics; branch checks do not complete this row. |
| Start screen, recent projects and opening Assistant or a parameter form before a Model exists | **Merged + rendered** ([#40](https://github.com/andeplane/fem-lab/issues/40), [#41](https://github.com/andeplane/fem-lab/issues/41), [#207](https://github.com/andeplane/fem-lab/issues/207)) | `src/ui/Overlays.tsx`, `src/ui/App.tsx`; `e2e/build.spec.ts`, `e2e/premodel-form.spec.ts`, `e2e/projects.spec.ts` | Chromium covers the pre-Model form and Assistant across representative desktop widths. Final visual comparison of the empty capability line and all three cards remains part of #90. |
| Model-tree workflow groups, collapse state, row menus, visibility and geometry creation affordances | **Merged + rendered** ([#43](https://github.com/andeplane/fem-lab/issues/43), [#101](https://github.com/andeplane/fem-lab/issues/101)) | `src/ui/Tree.tsx`; `e2e/add-menu.spec.ts`, `e2e/tree-edit.spec.ts`, `test/data-cmd.test.tsx` | Pointer and keyboard paths use registry Commands. Step rows still only expose “move earlier”; drag ordering is a separate pending row below. |
| Drag to reorder Steps, with cancellation, keyboard parity and one final `step.reorder` | **Pending #209 / PR #233** | Baseline `src/ui/Tree.tsx` has the earlier-arrow Command but no drag gesture | [PR #233](https://github.com/andeplane/fem-lab/pull/233) is open. Its branch checks are green, but the feature is absent from `09a1530`. |
| Schema-driven Properties: quantities, enums, Set picking, structured errors and accurate command preview | **Merged + source/test** ([#49](https://github.com/andeplane/fem-lab/issues/49)) | `src/ui/SchemaForm.tsx`; `test/form.test.tsx`, `e2e/build.spec.ts`, `e2e/sheet-preview.spec.ts` | Direct tests cover schema defaults, unit errors and form routing. #90 still needs a rendered sweep of every field pattern, multi-selection and failed dimension conversion. |
| Mesh accuracy warning teaches the supported quadratic alternative without inventing a tetra mesher | **Merged + rendered** ([#102](https://github.com/andeplane/fem-lab/issues/102)) | `src/ui/SchemaForm.tsx`; `e2e/mesh-warning.spec.ts` | Chromium covers supported linear/free-triangle and full quad/hex warnings and the real `form.open` fix. Tetrahedral reachability remains pending below. |
| Pressure quantity echo includes selected area and derived total force | **Pending #210 / PR #221** | Baseline Properties echoes normalized quantities but not the effective loaded area | [PR #221](https://github.com/andeplane/fem-lab/pull/221) is open with green branch checks. It is not delivered in `09a1530`. |
| Well-posedness banner, solve/progress/cancel, stale state and structured failure recovery | **Partial** ([#34](https://github.com/andeplane/fem-lab/issues/34) closed) | `src/ui/App.tsx`, `src/results.ts`; `e2e/smoke.spec.ts`, `e2e/results.spec.ts`, `e2e/postprocess.spec.ts` | The baseline renders real warning, Result, stale and error states. A single integrated Chromium workflow covering geometry → mesh → solve → edit → re-solve plus controlled cancellation remains required by #90. |
| Camera presets and Shift+1–4 without stealing editor input | **Merged + rendered** ([#92](https://github.com/andeplane/fem-lab/issues/92)) | `src/ui/App.tsx`; `e2e/shortcuts.spec.ts`, `e2e/smoke.spec.ts` | Chromium exercises the registered presets and editable-target isolation. |
| Deformation previews while dragging and emits one final view Command on release | **Merged + rendered** ([#42](https://github.com/andeplane/fem-lab/issues/42), [#98](https://github.com/andeplane/fem-lab/issues/98)) | `src/ui/App.tsx`, `src/ui/Results.tsx`; `e2e/deformation-preview.spec.ts`, `e2e/deformation-bounds.spec.ts` | Chromium covers live geometry, cancellation and one final Command without a Journal edit. |
| Viewer legend, glyphs, clip, probe, projection and animation use real result/mesh data | **Partial** | `src/ui/App.tsx`, `src/ui/Results.tsx`, `src/viewer/viewer.ts`; `e2e/postprocess.spec.ts`, `e2e/results.spec.ts`, `e2e/viewer-layers.spec.ts`, `e2e/view-export.spec.ts` | Modal animation and screenshot frames are rendered. [#9](https://github.com/andeplane/fem-lab/issues/9) remains open for the complete per-frame transient result capability; hardware frame-rate acceptance is also outstanding. |
| Retained transient-frame selection and playback | **Merged + rendered; broader #9 open** | `src/ui/Results.tsx`, `src/ui/Transient.tsx`, `src/transient.ts`; `e2e/transient-playback.spec.ts`, `e2e/transient-transport.spec.ts` | Chromium renders retained frames and playback without changing the Journal; cross-host replay is tested. This satisfies the visible playback slice, not every probe/export/performance item in #9. |
| Journal solve boundary, post-result styling, row selection and live-object highlight | **Merged + rendered** ([#91](https://github.com/andeplane/fem-lab/issues/91), [#172](https://github.com/andeplane/fem-lab/issues/172)) | `src/ui/Bottom.tsx`; `e2e/journal-interactions.spec.ts`, `e2e/results.spec.ts` | The producing revision stays visible through fresh, stale and undo states; hover/select targets the current object. |
| Script has line numbers, syntax highlighting, live Journal view, Run/Stop and located errors | **Partial; pending #173 / PR #227** | `src/ui/Bottom.tsx` uses a plain editing `<textarea>` and a line-numbered read-only view; `e2e/script-validation.spec.ts` | Run/Stop and validation exist. [PR #227](https://github.com/andeplane/fem-lab/pull/227) remains open, so CodeMirror editing and its rendered acceptance are not in `09a1530`. |
| Results extremes, units, reactions, balance and convergence | **Merged + rendered** ([#50](https://github.com/andeplane/fem-lab/issues/50)) | `src/ui/Results.tsx`; `e2e/results.spec.ts`, `e2e/postprocess.spec.ts` | Chromium exercises real Result tables, coordinate units, reaction balance and study rows. Numerical validity remains governed by engine benchmarks rather than the visual audit. |
| Checks shows well-posedness, mesh quality, cost, assumptions and Assistant verification | **Partial at baseline; after-baseline merge** | `src/ui/Results.tsx` in `09a1530` contains the first four groups but no shared Assistant verification rows | [PR #356](https://github.com/andeplane/fem-lab/pull/356) merged after the checkpoint at `3269a12`, closing [#96](https://github.com/andeplane/fem-lab/issues/96). Its seven checks are green, but it is not counted as `09a1530` evidence. |
| Command palette searches Commands, resolves object references and previews natural-language parameters | **Merged + rendered** ([#95](https://github.com/andeplane/fem-lab/issues/95), [#207](https://github.com/andeplane/fem-lab/issues/207)) | `src/ui/Overlays.tsx`, `src/ai/palette-intent.ts`; `e2e/palette.spec.ts`, `e2e/premodel-form.spec.ts` | Chromium covers keyboard selection, a real object route, preview-before-apply and pre-Model layout. |
| Assistant persists through collapse, streams prose, reports pending/failed tools and safely undoes one turn | **Merged + rendered** ([#94](https://github.com/andeplane/fem-lab/issues/94), [#97](https://github.com/andeplane/fem-lab/issues/97), [#124](https://github.com/andeplane/fem-lab/issues/124), [#138](https://github.com/andeplane/fem-lab/issues/138)) | `src/ai/AssistantPanel.tsx`, `src/store.ts`; `e2e/assistant.spec.ts`, `e2e/assistant-streaming.spec.ts`, `e2e/assistant-undo.spec.ts` | Chromium covers collapse/reopen, partial prose, tool lifecycle and interleaved-human-edit protection. |
| Assistant suggestion shortcuts, `/skill` entry and viewer-well background | **After baseline** | In `09a1530`, slash skills exist but the complete shortcut surface and `--bg-well` drawer token are absent; `src/ai/assistant.css` still uses `--bg-panel` | [PR #356](https://github.com/andeplane/fem-lab/pull/356) merged after the checkpoint, closing [#139](https://github.com/andeplane/fem-lab/issues/139) and [#175](https://github.com/andeplane/fem-lab/issues/175). Recheck its rendered result in the final integrated comparison. |
| Assistant project files, AGENTS.md, skills, downloads and Model/Journal `@` mentions | **Partial; pending #13** | `src/ai/project.ts`, `src/ai/AssistantPanel.tsx`; `test/ai-project.test.ts`, `e2e/command-parity.spec.ts` | Mention behaviour is delivered ([#39](https://github.com/andeplane/fem-lab/issues/39)). Full File System Access project open/close/refresh remains [#13](https://github.com/andeplane/fem-lab/issues/13), so the complete folder/files workflow is not accepted. |
| Export supported formats, exact screenshot dimensions and modal animation controls | **Merged + rendered** ([#11](https://github.com/andeplane/fem-lab/issues/11)) | `src/ui/Export.tsx`, `src/host.ts`, `src/animation-capture.ts`; `e2e/view-export.spec.ts` | Chromium verifies actual PNG dimensions, encoding failures, camera restoration, modal mode selection and distinct animation frames. Unsupported formats stay explicit. |
| Gallery has real viewer thumbnails, keyboard filters, difficulty/tags and reference values | **Merged + rendered** ([#30](https://github.com/andeplane/fem-lab/issues/30)) | `src/ui/Overlays.tsx`, `tools/copy-examples.mjs`; `e2e/build.spec.ts`, `e2e/thumbnails.spec.ts` | The scenario generates all 22 real 320 × 180 viewer images and checks lazy loading and filters. PR #357 makes thumbnail generation non-blocking for deployment, so final deployed-page inspection must confirm whether every preview was produced rather than infer it from a green deploy. |
| Worked benchmark theory and current Result comparison appear beside Results | **Pending #109 / PR #199** | No theory panel exists in baseline `src/ui/Results.tsx`; gallery metadata and tutorial prose are not a live Result comparison | [PR #199](https://github.com/andeplane/fem-lab/pull/199) remains open and its latest browser job failed. It must integrate valid benchmark-specific comparisons and provenance before this row can pass. |
| Full-screen calculation report uses real `query.report` Markdown, typeset maths, current viewer image, copy and PDF/print | **Merged + source/test** ([#14](https://github.com/andeplane/fem-lab/issues/14)) | `src/ui/Report.tsx`, `src/ui/report.css`; `test/report.test.tsx` covers Markdown, KaTeX, sanitisation, delayed image decode, copy, print readiness and no-Result/error states | PR #163 had reviewed real-Chromium paper/print evidence, but the baseline has no committed report-specific e2e scenario. The final audit should render and compare the integrated paper and exercise print once more. |
| Tet4/Tet10 are reachable through `mesh.set`; free tetrahedral meshing is available where promised | **Pending #4 / PR #223 and #22** | `09a1530` includes simplex element infrastructure and related numerical work, but the production registry cannot yet deliver the complete handoff choice | [PR #223](https://github.com/andeplane/fem-lab/pull/223) is open with green branch checks. [#22](https://github.com/andeplane/fem-lab/issues/22) separately tracks free 3D tetrahedral meshing. Neither capability is accepted on this baseline. |

## Audit closure

The audit remains open while any matrix row is partial, pending, after-baseline only, or lacks the
rendered evidence called out above. Closure requires a fresh comparison on one integrated main
commit, including the 1600 × 1000 reference state, the supported 1180 px desktop boundary, empty,
building, solving, Result, stale and error states, keyboard-only operation, report/print, export,
gallery and the complete Assistant workflow. Hardware performance claims need hardware evidence;
software adapters establish correctness only.

Items expressly outside this handoff — light-theme tokens, panel presets, settings layout and
member idealisations — must not be presented as implemented reference designs. Likewise, a closed
issue or passing feature-branch check does not establish rendered fidelity on the audited baseline.

## Historical audit record

The initial 1600 × 1000 comparison found the Assistant below the workspace, clipped top-bar
actions, a non-reference mark, missing local fonts, non-collapsible Tree groups, a hidden fresh
Result boundary and a static deformation gesture. Those findings became #88 and #98–#103 and are
now represented by merged source and committed browser scenarios in the current matrix.

Later independent reviews established the implementation details now visible in `09a1530`: panel
resize uses effective CSS-clamped sizes, Journal selection follows live object identity, screenshot
exports restore the camera and canvas, report printing waits for its decoded viewer image, and
retained transient frames are read without Journal mutations. This history explains why the matrix
requires semantic and rendered evidence, but it does not replace the final integrated comparison.
