# Preserve panel geometry and tutorial reading positions

Issue: [#798](https://github.com/andeplane/fem-lab/issues/798).

## Causal evidence

Main `b519eb043e175da095ac3e1e016518cc43426516` repeated three failures in [the preceding exact-head Chromium run](https://github.com/andeplane/fem-lab/actions/runs/38878884198): the phone Results tab was covered by a canvas, the initial bottom panel was 184 rather than 252 px, and the short tutorial explanation retained a 4 px offset. The unchanged baseline cases are `accessibility.spec.ts:83`, `panels.spec.ts:20` and `tutorial.spec.ts:80`.

The first two failures reproduced locally before edits (`/tmp/femlab-798-before.log`); the short-card case passed on local macOS Chromium but failed on Linux twice. The Linux trace records explanation offsets of 4, 1 and 4 px across preceding steps, including 4 px **before** the trial action click. The action was reachable; the reused explanation container retained an earlier reading position. Evidence is in `/tmp/femlab-794-ci-browser-report/data/fa63026ff9b4102d36546d14653e2252c1b78d87.zip` and its screenshot `1f1a2bea732ac71f313cd69a1134e602b9067d5b.png`.

Rendered local measurements (`/tmp/femlab-798-layout-before.jsonlog`) show:

- At 1600×900, the tour leaves a 632 px centre. The old 460 px viewer reserve clamps the requested 252 px bottom panel to its 184 px minimum.
- At 320×900, the first grid row is 320 px, but its status/comparison controls consume 143 px above the required 320 px canvas. The canvas overlaps the bottom tabs by 143 px and wins `elementFromPoint` at the Results tab's centre.

## Change

Keep the tour's desktop track adjustment out of mobile layout and give its desktop viewer a smaller 320 px reserve, preserving the normal 252 px bottom panel when space permits. Mobile viewer rows accommodate their complete control/canvas content before the bottom tabs. The visible workspace remains the scroll container and the Assistant keeps its workspace anchor.

Keep the tutorial replay control out of flex shrinking. Key only the explanation scroll container by tutorial identity and step: a new explanation starts at the top, while controls and rerenders within a step retain the user's reading position. This does not dismiss the tour, hide controls, change engineering Commands or alter existing acceptance assertions.

## Verification

The final local development-mode Chromium run passed all 32 cases across the complete original accessibility, panel, tutorial, Assistant, camera, geometry-draft and modeling-tour files, plus Assistant-tour integration. New cases cover actual Results hit testing/clicks at 320/375 px with the tour visible, plus deliberate reading-position preservation and reset on advancing to another explanation. The full original accessibility, panel and tutorial files remain unchanged. The original camera projected/captured size thresholds and mobile Properties focus assertions also remain unchanged.

Commands and proof:

```sh
FEMLAB_AI_MODE=development npm run build -w packages/app
npm run typecheck -w packages/app
npm run test -w packages/app -- --maxWorkers=2
PW_PORT=7980 npm run e2e -w packages/app -- --project=cpu e2e/accessibility.spec.ts e2e/assistant-tour-layout.spec.ts e2e/panels.spec.ts e2e/tutorial.spec.ts e2e/modeling-tour.spec.ts e2e/camera-clipping.spec.ts e2e/geometry-draft.spec.ts e2e/assistant.spec.ts
```

The original capability/alignment case also passed separately (`/tmp/femlab-798-alignment.log`), retaining the exact workspace/drawer and integral canvas-coordinate assertions, for 33 affected Chromium checks in total. Full app tests passed 1574 with five skipped; coverage included all 106 authored modules. Typecheck, root/subdirectory docs checks, Vite build and its 107-file secret scan passed. Logs are `/tmp/femlab-798-{development-build,typecheck,app-tests,browser-final}.log`. The phone Results screenshots are `/tmp/femlab-798-phone-results-{320,375}.png`; both were inspected. An independent read-only review found no concrete issue in the final diff. These are local checks; exact-head Linux CI and published checks remain separate gates.

An initial local adjacent run used the default hosted build: its 24 applicable cases passed, while two development-only Assistant cases failed because hosted builds do not expose BYOK settings. The final development-mode run uses the same explicit `FEMLAB_AI_MODE=development` setting as CI; those earlier mismatched-mode results are not final acceptance evidence.

No dependency, Rust, cloud, authentication, payment or deployment change is part of this issue.
