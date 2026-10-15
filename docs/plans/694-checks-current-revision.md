# Checks measurements belong to the current Model revision

Issue [#694](https://github.com/andeplane/fem-lab/issues/694), a bounded child of the
[#90 integrated app journey](https://github.com/andeplane/fem-lab/issues/90).

The handoff requires live pre-solve Mesh quality and cost evidence in Checks
([bottom panel](../design_handoff_fem_lab/README.md#bottom-panel-252-px-min-184)).
The prepared baseline is `e796da9d`, whose whole tree equals the already verified
`1986cd90` final-import candidate. Parent PR693 must land before this child is retargeted.
Existing draft PR107 and accepted import/CSV/layout/report/movie proofs are preserved.

## Defect and bounded change

`Checks` retains the previous Mesh and cost values when the same Model changes. Its
asynchronous readers also lack a dependency-generation cleanup, so a retired response can
write into the current presentation. Model activation already keys/remounts the document
subtree; this is not a claim that the core or project-session fence is bypassed.

Associate displayed receipts with the query/revision/Mesh/Step generation that requested
them. While the current receipt is pending, show that state rather than previous numbers.
Ignore retired success/error replies and report a current read failure without presenting
old measurements. Mesh and cost remain independent public Queries. Inspection changes no
Model/Journal state; every existing control remains registry-callable.

No new solver telemetry, estimates, physics, registry capability, project-folder integration,
or general design-fidelity claim is included. Procedure-specific wording is outside this fix.

## Verification

1. Capture unchanged-source failures using typed public-query DTOs and deferred replies:
   replace visible measurements after a Model edit, retire pending successes/errors, and
   preserve the other current measurement when one read fails.
2. Run focused Checks/Results UI tests and app types; preserve existing honest cost bounds.
3. In production Chromium, delay real public Worker responses, edit the current Model
   through ordinary Commands and inspect pending/current Checks values and screenshots.
   Verify the tab action, Journal preservation and current query receipts. The bounded
   imported-model journey then uses explicit units, solve, CSV and portable save/reopen.
   Reuse the verified 11-case final-import batch where behavior is unchanged.
4. Use only the matching complete `1986cd90` WASM pair after protected-source verification;
   preserve producer/runtime identities and use private preview ports. No Rust build is
   required. Full parent #90 remains open after this child.
