# Assistant geometry follows the modeling workspace

Issue: [#792](https://github.com/andeplane/fem-lab/issues/792).

## Reproduction

On unmodified main `236b1f96`, the existing Chromium capability/alignment test (`browser-threads.spec.ts`, “capability information preserves solve blockers and Assistant alignment across viewports”) failed with `drawer.y = 46` while `workspace.y = 232.578125`. Its first-run tour remained visible. The screenshot shows the drawer covering the tour's right side, including its close control. Preserved evidence: `/tmp/femlab-792-before-browser.log`, `/tmp/femlab-792-before.png`, `/tmp/femlab-792-before-trace.zip` and `/tmp/femlab-792-before-context.md`.

The Assistant and splitter live outside the document subtree to retain the conversation across Model replacements. Their CSS used fixed 46/78 px insets, which accounted for the toolbar and banner but not the variable-height tour row.

## Change

Use a [CSS anchor](https://drafts.csswg.org/css-anchor-position-1/) on the rendered workspace. The fixed drawer and splitter follow its actual top and bottom. On small screens the workspace itself becomes the scroll container, keeping its visible bounds stable below the tour and banner. The start screen retains its full-height drawer.

The tour uses integer line boxes so the workspace/canvas origin retains the existing whole-pixel layout invariant. Its viewer track fits the remaining height rather than pushing the entire page down when a highlighted Results panel scrolls into view. Tour highlights retain their outlines without the elevation required by the separate tutorial's dim layer; a highlighted mobile panel therefore cannot intercept Assistant composer clicks. No engineering, account, draft or provider behavior changes.

## Verification

On 2026-10-16, the focused Chromium run passed all 13 cases: four new shown/dismissed/reopened drawer cases at 1600, 1280, 1100 and 390 px; the unchanged capability/alignment case; all three camera clipping/capture cases; all three geometry draft cases; and both modeling tour cases. The camera tests retain their 1700×1100 rendered-width/height thresholds, and the mobile tour test retains actual Properties input focus. The new cases exercise workspace scrolling, real composer hit testing, the resize handle, unchanged unsent draft and Journal, and absence of auth/AI/account/payment requests. The original alignment and whole-pixel viewport assertions remain unchanged.

Commands:

```sh
npm run typecheck -w packages/app
npm run build -w packages/app
npm run test -w packages/app -- --maxWorkers=2
PW_PORT=7920 npm run e2e -w packages/app -- --project=cpu e2e/assistant-tour-layout.spec.ts e2e/browser-threads.spec.ts e2e/camera-clipping.spec.ts e2e/geometry-draft.spec.ts e2e/modeling-tour.spec.ts --grep 'Assistant follows|capability information preserves solve blockers|fitted|uncommitted geometry drafts|first workspace entry through geometry|modeling tour'
```

The full app suite passed 1574 tests with five skipped, and coverage included all 106 authored modules. Typechecking and Vite build passed; docs checks cover both root and subdirectory hosting, and the build's secret scan passed on 107 files. Local proof logs are `/tmp/femlab-792-{typecheck,build,app-tests,browser-final}.log`. After tightening the new tests to assert the workspace's exact bounds, those four cases passed again in `/tmp/femlab-792-browser-strict.log`. Screenshots at `/tmp/femlab-792-tour-assistant-{1600,1280,1100,390}.png` show the final Results stop with the drawer open; all four renders were inspected. An independent read-only review found and confirmed the mobile elevation issue, then found no additional concrete regression after the scoped fix.

These are local Chromium checks using the existing matching prebuilt engine assets. No auth, provider requests, Rust build or deployment is part of this issue.
