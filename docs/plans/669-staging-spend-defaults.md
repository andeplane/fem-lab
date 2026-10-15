# Pause supplier spending on public staging

Issue: [#669](https://github.com/andeplane/fem-lab/issues/669).

Stripe test payments are free to the tester, but the staging model API uses a real
supplier key. A verified staging account could purchase test credits and consume
real supplier budget. Disabling new Checkout does not revoke existing test-paid
credits, and invitation-only free grants do not protect the paid path.

The baseline for `femlab-app-staging` is `ai_limits.enabled=false`, with
`daily_micros`, `monthly_micros`, `free_daily_micros`, and `uncertain_micros` all
zero. `enabled=false` rejects a new completion during `prepare`, before supplier
input-token counting. Zero caps also prevent generation admission. Concurrency
remains positive, as required by the existing schema constraint. Existing
credits, subscriptions, invoices, and usage receipts remain intact. Billing-only
QA, including test-card Checkout and webhook delivery, needs no model spending.

`infra/google/migrate.py --environment staging` applies
`infra/google/sql-staging-ai-paused.sql` after every migration run, even if no new
schema migration exists, before runtime permissions are applied. The transaction
resets both the singleton configuration row and its column defaults. Production
migrations do not run this reset; production invitation approval and spend
policy are separate controls. Applied shared migrations are not rewritten.

## Temporary bounded AI QA

Prefer a local/private service with its own disposable test database. Keep the
public staging baseline paused. If a real staging AI acceptance run is required,
an operator must explicitly authorize its identity, short time window, model,
maximum output, and finite supplier budget before opening admission:

1. Record the current limits, settled spend in the current UTC day/month, active
   holds, and the named QA account. Check there are no unresolved active requests.
   Caps are total period limits in USD millionths, not an extra allowance.
2. Restrict staging API invocation to the operator before enabling AI. Verify an
   ordinary external request is rejected by Cloud Run, including through every
   publicly reachable API origin. Keep the Firebase bearer token in
   `Authorization`; Cloud Run supports a separate operator ID token in
   `X-Serverless-Authorization`. Verify this isolated harness can authenticate
   before changing budgets. Do not enable the shared public API without isolation.
   See [Google's Cloud Run authentication documentation](https://docs.cloud.google.com/run/docs/authenticating/service-to-service).
3. Using the existing IAM SQL proxy and migration/operator database identity,
   transactionally set finite daily, monthly, uncertainty and (only when testing
   free grants) free-pool caps, then set `enabled=true`. Include outstanding holds
   and prior spend when calculating the ceiling. A zero free-pool cap is suitable
   for paid-only QA. Do not enlarge a cap to make an unexpected failure disappear.
4. Run only the approved account and bounded request. Capture request ID,
   authoritative usage receipt, supplier cost and idempotent replay evidence.
   Do not run public Checkout/webhook acceptance during the private invocation
   window; Stripe cannot authenticate to an operator-only Cloud Run endpoint.
5. In a `finally` cleanup, apply `sql-staging-ai-paused.sql`, including after a
   timeout, provider failure or aborted test. Read back disabled admission and all
   four zero caps. Reconcile dispatched requests: pausing admission does not
   cancel already dispatched supplier work or remove financial history.
6. Before restoring public invocation, verify a fresh completion from an existing
   paid QA account returns `503` / `ai-unavailable` with no new request, token
   count, receipt or ledger entry. Only then restore prior invocation settings and
   verify billing-only webhook/recovery operation again.

The reset SQL can also be applied directly through the existing operator SQL
connection with `psql -v ON_ERROR_STOP=1 -f
infra/google/sql-staging-ai-paused.sql`. Do not use a production connection or put
database/provider credentials in command arguments or shell history. Every
staging migration intentionally closes a temporary AI QA window.

## Verification

The release-boundary tests cover staging reset ordering, stop-on-reset failure,
explicit Google project/account selection, and production preservation. The real
PostgreSQL completion test applies the actual reset SQL twice, verifies defaults
on a replacement singleton, and denies both approved free and existing paid
credits before any provider call while preserving the paid balance.

On 2026-10-15 the operator paused the actual staging database: disabled admission,
all four caps zero, concurrency four, no active AI requests. The existing Stripe
test Plus QA account retained 4,000,000 credits and available billing. A fresh
completion returned `503` / `ai-unavailable`; requests, receipts and credit
entries were zero before and after. Public evidence was saved outside the repo
at `/tmp/femlab-staging-ai-pause-evidence-669.json`. No production setting changed.
