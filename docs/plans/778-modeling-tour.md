# Modeling workflow tour

Issue: [#778](https://github.com/andeplane/fem-lab/issues/778).

The empty local workspace needs a discoverable sequence from geometry to interpretation. The previous five-region tour remembered dismissal in `femlab.tour.dismissed` but offered no replay control. A missing tour in an older screenshot does not establish whether this preference was set; no owner browser storage was inspected for this issue.

## Behavior

Extend the existing tour and preference rather than introducing another onboarding system. Eight stages explain Geometry, Material creation and assignment, Mesh, Constraints, Loads, Step, Solve and Results. The tour occupies a shell row above the workspace, so it cannot cover the highlighted control or Properties form. Targets scroll into view; the guide is nonmodal and does not trap focus. Close, Escape and Continue on my own remain available, with focus restored when the invoking control still exists.

Three schema-first session-view Commands (`tour.show`, `tour.dismiss`, `tour.startCantilever`) expose every tour action to the same registry used by people, scripts and tools. They do not enter the engineering Journal. Browser preference access and tutorial launch are injected. Automatic first-entry opening respects the existing dismissal flag and does not interrupt an active tutorial. Explicit Tutorials → Modeling tour works after dismissal without clearing it.

The final Build the cantilever tutorial action opens the existing runner at its first step. Opening applies no engineering Commands, even when the current Journal already contains a previous cantilever. The tutorial's explicit model.new action replaces the current Model; the guide tells readers to use a new project to preserve earlier work. Anonymous local modeling and the existing draft/account state remain unchanged.

## Verification

Verified 16 October 2026 with the merged profile base `9e61ab29`:

- App typecheck and production build passed; the built-artifact scan found no API keys in 106 files.
- Full app coverage passed with `npm run test -w packages/app -- --maxWorkers=2`: 1,560 passed, five skipped; all 105 authored modules included, 89.12% lines. Default-concurrency runs earlier hit the existing SI-document export test's five-second timeout on this shared machine; that test passed in isolation and the complete bounded-worker run passed without changing its timeout or assertions.
- `npm run docs:test` passed all seven checks. Both `/` and `/fem-lab/` docs checks covered 22 pages, 184 authoritative definitions and 19 typed examples, including all three new tour Commands.
- `PW_PORT=7780 npm run e2e -w packages/app -- --project=cpu e2e/modeling-tour.spec.ts e2e/tutorial.spec.ts` passed all ten Chromium tests. This includes first local entry, all eight stages, dismissal/replay after the saved flag, Escape/focus, 390 px target scrolling and editable Properties, full cantilever solve, and direct registry restart without modifying its solved Journal. No authentication, AI or checkout requests occurred in the new desktop flow.
- Inspected `/tmp/femlab-tour-778-desktop.png` and `/tmp/femlab-tour-778-390.png`. These are local Chromium renders, not a deployment claim.

Independent review identified two handoff cases, both now covered: starting from an already active runner, and following the tutorial's first model.new into its replacement Store without mistaking the reset generation for another restart. The existing profile's modal exclusion is preserved alongside tutorial/tour exclusivity.

The final integration rebase onto the geometry picker/preview changes will receive focused unit, type/build and the ten Chromium checks before publication of the PR. Existing dismissed users must use Tutorials → Modeling tour; release communication should point out this location rather than resetting their preference.
