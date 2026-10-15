# Reviewed monthly free allowance

Issue [#712](https://github.com/andeplane/fem-lab/issues/712); decision
[ADR 0037](../adr/0037-reviewed-monthly-free-eligibility.md). Paid Plus's 10M credits
remain independently implemented by [#709](709-monthly-ai-allowance.md).

Approved free users explicitly claim 6,666,666 weighted credits per UTC calendar
month, approximately $5 of supplier usage. Signup stays open with zero grants;
email/Google login never approves eligibility. A stable reviewed-person reference
and unique HMAC email history prevent another allowance on a reviewed alias or
recreated account. Rebind requires the old account to be inactive; a current-month
claim cannot move to another account or be reissued. Legacy 200k invitations keep
their recorded expiry but cannot stack with monthly eligibility or bypass revoke.

`POST /v1/account/free-allowance` accepts `{}` only. The response is
`{status:'claimed',credits,periodStartsAt,periodEndsAt,replay}`. The account read adds
`freeAllowance` with the same amount/period plus status `review-required`,
`eligible`, `claimed`, `revoked`, `paid` or `unavailable`. A claimed status can mean
the same reviewed person claimed on a former account; it does not transfer funds.
Reads never claim. Paid periods, including exhausted balances, take precedence.
Financial-review blocks prevent free fallback. Unused revoked grants are hidden
and cannot dispatch; accepted work still settles once.

Migration 010 adds eligibility/fingerprint records and `free_monthly_micros`,
defaulting to zero. Runtime roles receive SELECT only on eligibility tables.
`FREE_ELIGIBILITY_HMAC_KEY` uses the project-specific `free-eligibility-hmac-key`
Secret Manager version 1 for API, jobs and the privileged operator helper. Never
log the key, raw email, person reference or fingerprints. Retain pseudonymous
identity/month claims through account deletion, include only owned records in
exports, and describe that retention in public Privacy. Rotate keys only with a
reviewed retained-identity migration.

The explicit production operator script sets free supplier limits to $10/day and
$50/month. It does not enable AI or alter $100/day, $1,000/month aggregate or $10
outstanding limits. The claim transaction funds at most ten principal-months at
$5 each; revoked/deleted claims continue to count. Approval alone does not fund a
claim. Actual supplier limits can temporarily stop requests. Staging remains
disabled with all supplier caps zero after every migration.

Operator example, using an owned local SQL proxy and a stable non-personal review
reference; use `revoke` or explicit `rebind` for the other operations:

```sh
python3 infra/google/manage-free-allowance.py --environment production \
  --account andershaf@gmail.com --port 16445 --source "$PWD" \
  --action approve --account-id ACCOUNT_UUID --person-reference REVIEWED_PERSON_REFERENCE
```

Run service verification against a disposable local PostgreSQL 17 database:

```sh
TEST_DATABASE_URL=postgresql://femlab_test@127.0.0.1:16448/postgres npm run test -w packages/service
npm run build -w packages/service
python3 -m unittest discover -s infra/google -p 'test_*.py'
python3 -m unittest discover -s infra/stripe -p 'test_*.py'
```

The full real-PG suite covers concurrent claims across connection pools,
principal-month replay, Gmail aliases/reviewed email history, recreate/rebind,
month rollover/expiry, legacy and paid precedence, revoke at admission boundaries,
settlement, monthly capacity and supplier limits, owned export/deletion and actual
read-only runtime privileges. The app/registry/public-copy checks are recorded in
[the UI verification plan](712-free-monthly-ui.md).

Root owns all cloud changes and production acceptance. Apply 010 with staging
paused, install the dedicated keys, publish API/jobs to 100% ready traffic and wait
for successful release-helper exit before any production monthly claim. After a
monthly grant exists, rollback below #712 requires a global AI pause before
traffic moves and remains paused on old code (ADR 0037). Verify the owner's real
account through the same explicit operator/claim flow; never grant disposable
production identities or use published Stripe test cards to obtain real AI.
