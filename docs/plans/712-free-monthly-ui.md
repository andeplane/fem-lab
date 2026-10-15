# Reviewed monthly free allowance: account controls and public copy

Issue [#712](https://github.com/andeplane/fem-lab/issues/712), with backend invariants,
review tooling and funding in the [core #712 plan](712-free-monthly-allowance.md). This slice changes app/registry
controls and public disclosures; it grants no eligibility, modifies no budget and
performs no deployment or provider request.

`GET /v1/account` may return `freeAllowance` with `status`, `credits`,
`periodStartsAt` and `periodEndsAt`. Only exact `eligible` status enables the explicit
`account.claimFreeAllowance` Command; paid access, loading, missing or unknown status
cannot enable it. The strict empty Command accepts no account, approval or calendar
selector. The account client posts `{}` to `/v1/account/free-allowance` using its
authenticated token, refreshes authoritative state, and rejects late responses after
an identity change. It cannot approve eligibility or mint local credits. The Command
is excluded from Assistant tools/scripts and never enters the engine Journal.

Approved free accounts can claim 6,666,666 weighted credits in a UTC calendar month,
approximately $5 at the current supplier-accounting tariff. Each month requires a
new explicit claim. Unused credits expire at 00:00 UTC on the first of the following
month, without rollover. Approval/revocation, one reviewed-person claim per month
across aliases/account recreation, paid-plan exclusion and shared budget availability
are backend decisions. Historical one-time 200,000-credit previews retain their
recorded amount/expiry and do not stack with reviewed monthly access or become a
revocation fallback.

The UI explains review-required, eligible, claimed, revoked, paid and unavailable
states without describing email or Google verification as proof of unique people.
The Privacy notice records the confirmed backend design: durable pseudonymous
reviewed-person identifiers/references, keyed reviewed-email fingerprints and monthly
claim markers remain after deletion; raw account email/Firebase identity still clear
through durable deletion. Account exports expose only their account's eligibility
and claim records, never an earlier account's ledger after eligibility rebinding.
These markers are described as pseudonymous, with no anonymous-data or automatic
expiry promise. See [Datatilsynet's anonymisation guidance](https://www.datatilsynet.no/globalassets/global/dokumenter-pdfer-skjema-ol/regelverk/veiledere/anonymisering-veileder-041115.pdf)
and [personal-data principles](https://lovdata.no/nav/lov/2018-06-15-38/kapii), read
15 October 2026. This factual disclosure is not a legal compliance opinion; retained
purpose/necessity and data-rights requests still require the operator's assessment.

Verification covers strict registry arguments, injected routing, Assistant/script
exclusion, authenticated POST/refresh and account-switch races; UI state transitions,
no automatic claim and no paid/free stacking; public policy semantics and readable
390px Chromium pages. Backend real-database tests establish the security and budget
invariants; this app slice does not substitute client controls for those checks.

Local verification on 15 October 2026 passed 95 focused app tests, all 192 registry
tests with 100% coverage, both TypeScript checks, four Chromium account/policy tests,
the production build and its secret scan. The actual account component was also
rendered at 390px in all six allowance states, with no horizontal overflow and only
the eligible state dispatching a claim. The broader app run first required the
ignored Node wasm artifact, then exposed the existing debug-wasm STL overflow tracked
separately in [#716](https://github.com/andeplane/fem-lab/issues/716); it was stopped
after diagnosis. This slice makes no engine change and does not claim a green full
app run with that artifact. Integration verification uses the candidate's matching
release wasm baseline.
