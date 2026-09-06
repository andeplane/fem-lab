# Design fidelity audit

Tracking issue: [#90](https://github.com/andeplane/fem-lab/issues/90).

The acceptance reference is [the handoff README](../design_handoff_fem_lab/README.md),
with [the brief](../design_handoff_fem_lab/DESIGN-BRIEF.md) for behavior and
`FEM Lab.dc.html` for visual comparison. The prototype's example numbers and simulated
operations are not production implementations. Engine data must remain real; no fabricated
verification, geometry, reference values, or performance estimates may fill a visual gap.

This is an open audit, not a statement that the app conforms. Source inspection was made
against `ac3c0a3` and the Assistant placement branch `6baf96b`; concurrent PRs must be
checked again on merged main. Chromium screenshots of the reference and a solved cantilever
were inspected at 1600 × 1000. A screenshot of one state does not verify the other states.

## Requirements and evidence still needed

| Handoff requirement | Current evidence / gap | Issue and acceptance evidence |
| --- | --- | --- |
| Assistant to the right of Properties, full workspace height | Fourth child in a three-column grid wrapped to the bottom left. Initial fix exposes canvas resizing and intermediate-width overflow defects. | [#88](https://github.com/andeplane/fem-lab/issues/88): Chromium bounds, visible composer, canvas backing size and camera aspect on repeated toggles at wide and narrow desktop widths. |
| Correct type, spacing and brand tokens | CSS names IBM Plex but does not supply font files; top-bar mark differs from the reference. | [#99](https://github.com/andeplane/fem-lab/issues/99), [#100](https://github.com/andeplane/fem-lab/issues/100): rendered comparison and loaded font evidence, including an offline production build. |
| All top-bar controls reachable on supported desktops | Actions clip at the handoff minimum width. | [#103](https://github.com/andeplane/fem-lab/issues/103): all controls visible or reachable without overlap at 1180 px, with drawer open and closed. |
| Editable Model name and unsaved dot | TopBar renders an inert name and has no saved/dirty indicator. | [#123](https://github.com/andeplane/fem-lab/issues/123): rename preserves the Model; saved baseline and undo determine dirty state, while view changes do not. |
| Empty/start screen and Assistant can build the first Model | Existing start-screen and empty-model Assistant work is owned elsewhere. | [#40](https://github.com/andeplane/fem-lab/issues/40), [#41](https://github.com/andeplane/fem-lab/issues/41): start before engine readiness, open chat, build first Model, preserve conversation during transition. |
| Model tree groups, row controls, geometry affordances | Tree does not expose all designed group/row interactions; geometry affordances have an existing issue. | [#101](https://github.com/andeplane/fem-lab/issues/101), [#43](https://github.com/andeplane/fem-lab/issues/43): keyboard and pointer actions issue registry Commands and reflect state. |
| Schema-driven Properties with accurate preview | Tagged-union default bug tracked separately; inline tetrahedron warning/fix missing. | [#49](https://github.com/andeplane/fem-lab/issues/49), [#102](https://github.com/andeplane/fem-lab/issues/102): visible values equal dispatched values; warning and supported quadratic fix use real schema. |
| Named face rule picking, quantity echoes and field errors | Source has pickers, quantity conversion and structured errors. Full interactive conformance remains unverified. | Audit #90: check each field pattern, multi-selection, remeshing persistence and failed dimension conversion in Chromium. |
| Solve disabled until well-posed; solving/progress/cancel; stale and error states | Components exist. Presence alone does not prove state transitions or viewer responsiveness. | Audit #90 plus [#34](https://github.com/andeplane/fem-lab/issues/34): run geometry → mesh → solve → edit → re-solve, and controlled failure/cancel cases. |
| Camera presets on Shift+1–4 | Keyboard handler lacks these shortcuts. | [#92](https://github.com/andeplane/fem-lab/issues/92): each shortcut calls the matching registry operation once; typing in editors remains intact. |
| Live deformation preview, one final Command per gesture | Slider only handles change; cross-field deformation is separately owned. | [#98](https://github.com/andeplane/fem-lab/issues/98), [#42](https://github.com/andeplane/fem-lab/issues/42): intermediate geometry changes before release; one final Command, no Journal edit. |
| Legend, glyphs, clip, probe, projection and animation | Viewer implements several operations; per-frame transient fields remain a known capability gap. | [#9](https://github.com/andeplane/fem-lab/issues/9); audit #90 must verify each viewer interaction and its registry boundary. Performance needs hardware evidence, never software-adapter timings. |
| Journal solve provenance and post-result edits | Fresh Results have no visible solve boundary because its rendering is gated by stale state. | [#91](https://github.com/andeplane/fem-lab/issues/91): fresh, stale, re-solved and undone Journal cases. |
| Script editor, run/stop and live Journal representation | Existing editor and worker runner; highlighting, error locations and edited replay behavior still need comparison. | Audit #90: real edited script execution and stop, visible errors with location, copied/downloaded script replay. |
| Results extremes, units, reactions and convergence | Real tables/charts exist; coordinate-unit defect is tracked. | [#50](https://github.com/andeplane/fem-lab/issues/50): value and coordinate units verified separately; audit balance and convergence from independent numerical evidence. |
| Checks well-posedness, mesh quality, cost and assumptions | Source contains these sections, but Assistant verification is not shared into Checks. | [#96](https://github.com/andeplane/fem-lab/issues/96): verification survives tab changes, carries provenance and becomes stale when its Model changes. |
| Palette searches Commands, accepts object references and natural-language parameters | Current palette performs text ranking and opens forms. | [#95](https://github.com/andeplane/fem-lab/issues/95): object routing and parameterized intent produce previewable registry operations; keyboard navigation verified. |
| Assistant conversation survives collapsing the drawer | Unmount discards component conversation/draft state. | [#94](https://github.com/andeplane/fem-lab/issues/94): transcript, tokens, draft and in-flight turn survive collapse/reopen without occupying a hidden column. |
| Streaming prose and composer suggestion/skill entry points | Text is buffered until a tool starts or the turn ends; designed suggestion chips and slash skill entry are absent. | [#138](https://github.com/andeplane/fem-lab/issues/138), [#139](https://github.com/andeplane/fem-lab/issues/139): text appears before completion; suggestions and skills route through the registry and preserve draft context. |
| Assistant tools, files, mentions, rules and skills | Existing implementation and separate project/mention issues; tool cards report pending calls and resolved script errors as successful. | [#13](https://github.com/andeplane/fem-lab/issues/13), [#39](https://github.com/andeplane/fem-lab/issues/39), [#124](https://github.com/andeplane/fem-lab/issues/124); audit #90 for cost and downloads. |
| Undo Assistant turn as one unit | Historical cards can remove later human edits or a different turn. | [#97](https://github.com/andeplane/fem-lab/issues/97): atomic provenance guard including interleaved human Commands, queued edits and Journal rewrites. |
| Export groups and functioning supported formats | Export modal lists supported and unavailable formats; screenshot dimensions have a known host gap. | [#11](https://github.com/andeplane/fem-lab/issues/11): export actual bytes, verify selected dimensions, errors and round-trip where supported. Unsupported engine formats must remain explicit. |
| Gallery thumbnails, reference values and theory beside Results | Blank gradient thumbnails and Command-count footer; no rendered theory panel. | [#30](https://github.com/andeplane/fem-lab/issues/30), [#109](https://github.com/andeplane/fem-lab/issues/109): real thumbnails, independently sourced values, typeset theory and actual Result comparisons with provenance. |
| Full-screen report, rendered calculation note and PDF | Report toggle has no report component. Markdown export exists. | [#14](https://github.com/andeplane/fem-lab/issues/14): real report from current Result, designed paper layout, copy Markdown, print/PDF and pre-result explanation. |
| Linear/quadratic tetrahedral mesh choices | The current MesherSpec has no tetrahedral mesher; the prototype's Tet4 state cannot be produced. | [#157](https://github.com/andeplane/fem-lab/issues/157) tracks the capability gap. #102 supplies teaching guidance for supported element families without claiming Tet4/Tet10 support. |

## Reviewed deliveries

- #99 / PR #105: reference top-bar mark merged after independent review and all CI checks.
- #100 / PR #108: bundled IBM Plex Sans and Mono, Latin weights 400/500/600, merged after review and all CI checks. Chromium checks load all six faces; local hashed assets avoid external font requests, and size budgets pass.
- #40 / PR #93 and #88 / PR #89: stable Assistant slot and right-side layout merged after review and all CI checks. Chromium verifies canvas backing size and repeated open/close at 1600, 1494, 1280, 1180 and 1100 px, including banner and solved states.

These deliveries do not close the audit. The remaining matrix still needs implementation,
review and integrated verification on merged main.

## Delivery and review

Each uncovered defect gets its own issue before implementation. Existing `in progress`
issues retain their owners. Work uses separate worktrees and numbered branches; test and
commit feature-sized changes and open a PR linking the issue. Independent review precedes
merge. Review includes the actual diff and failure cases, not only passing checks. Integrate
concurrent changes before final browser checks, especially Assistant mount/layout changes.

The audit closes only after the matrix has direct evidence for each implemented requirement,
all filed fixes have been reviewed and merged, and any unresolved capability or specification
gap is identified explicitly. Merely filing issues does not complete the requested work.
Items expressly not designed in this handoff (light-theme tokens, panel presets, settings
layout and member idealisations) must not be presented as implemented reference designs.
