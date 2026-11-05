# Cloud SQL restore with canonical Stripe TEST reconciliation

Completes the financial-recovery acceptance slice of
[#556](https://github.com/andeplane/fem-lab/issues/556). The existing signed
TEST-webhook lifecycle remains recorded separately in
[the activation evidence](661-stripe-activation.md).

## Procedure and trust boundaries

`packages/service/tools/reconcile556.ts` is an operator-only drill, excluded from
the production entry point and image bundle. It requires an explicitly named
`femlab_qa556_financial_*` database, a dedicated `qa556_financial_*` role and a
TEST-only Stripe credential. Its SDK HTTP client rejects every method except GET
and every origin except `https://api.stripe.com`. The actual production
`stripeGateway`, `billingLifecycle`, account provisioner and credit ledger are
imported from source. No replacement gateway supplies invoice/subscription data.

The existing restricted staging TEST key was read from Secret Manager into the
operator process. No key was printed, committed, copied to the QA container or
written into a fixture. No LIVE credential was accessed. Existing TEST invoices,
subscriptions, charges and refunds were read; no Stripe object was created,
changed, paid, refunded or canceled during this drill. The key does not permit
Events listing, so no permission change or new Event API receipt is claimed.

Two dedicated databases on the existing Frankfurt Cloud SQL instance held only
fake internal accounts and references to existing TEST objects. Their role had
no superuser, database creation, role creation or inherited privilege, and an
actual SELECT against the real application's `ai_limits` table was denied.
No application database, account, eligibility, cap or provider configuration was
changed. The operator's existing Cloud SQL proxy was reused; no new SQL instance
or cloud service was provisioned.

The source database deliberately models a stale paid snapshot whose refund
notification has not yet been reconciled: both paid grants exist and their
accounts are still unblocked, although canonical TEST charges are already
refunded. Admissions remain disabled throughout. This is an isolated failure
fixture, not an assertion that a real application account was in this state.

The driver first retrieves and checks the canonical customer/subscription/charge
bindings, paid invoice status, currency, line/period and succeeded refund. It
backfills clearly identified operator-generated QA inbox envelopes. Those
trusted operator envelopes are **not new signed webhooks** and do not exercise
signature verification or delivery. `billingLifecycle.recover()` then retrieves
current canonical data through the real Stripe SDK adapter.

After creating two paid grants, the paused database was dumped with `pg_dump -Fc`
and restored into the second owned database with `pg_restore --exit-on-error`.
All six compared table hashes matched. Before reconciliation, the driver also
requires exact SHA-256 equality for grants, debit entries, holds and paid periods
against the seed proof. It then backfills canonical invoice replays, refund and
subscription updates and runs recovery twice. It checks once-only grants/reviews,
current subscription state, zero eligible refunded balances and unchanged
immutable-ledger hashes. Admissions must still be paused at the end.

## Actual result, 5 November 2026

The actual run completed at **08:39:28 UTC**, using `stripe` 23.0.0 and `pg` 8.23.1.
The SDK made 22 GET requests during seeding and 26 during restored reconciliation,
with zero Stripe mutations.

| Existing TEST fixture | Paid invoice | Grant period UTC | Canonical subscription | Canonical refund | Eligible public credits before / after |
|---|---|---|---|---|---|
| Invoice hash `d2250721cd04`, charge hash `cb1e329a9b4c` | USD 61.25 | 15 Oct 17:24:49–15 Nov 17:24:49 | canceled | succeeded; charge refunded | 7,500 / 0 |
| Invoice hash `0a784256d88d`, charge hash `9322c1b61650` | USD 49.00 | 15 Oct 13:44:40–15 Nov 13:44:40 | active | succeeded; charge refunded | 7,500 / 0 |

These are existing October TEST invoices, not new payments or newly granted real
customer periods. Public credits use `usd-milli-v1`. Refund reconciliation blocked
both QA accounts, including the account whose canonical subscription remains
active; cancellation alone is not the refund authority.

The first restored recovery pass processed six events with zero failures. The
second processed zero with zero failures. Exactly two grants and two paid periods
remained, with exactly two refund reviews. Grants, periods, debit entries and
holds retained their original SHA-256 values. The debit/hold tables are empty in
this focused fixture; the separate streaming/drain drill covers outstanding
reservation recovery.

The dump SHA-256 was
`5848994cb655f444f1398e6e69e736309f261e57c6eebcea48cd27777cecee7b`.
Source and restored `credit_grants`, `credit_entries`, `credit_holds`, `paid_periods`,
`billing_inbox` and `billing_accounts` matched before canonical reconciliation.
Both dedicated databases and their role were removed afterward; the shared proxy
and other independently owned QA resources were preserved.

The whole service typecheck passed, and three actual negative driver executions
rejected a real-application database name, an ordinary runtime role and a LIVE-mode
credential prefix before reading the private fixture or making external calls.
No coverage or timing threshold changed. Sanitized seed, restore, reconciliation,
credential/database guards, isolation and cleanup JSON receipts are retained under
`control-20261105/556-financial` on home-mini. Exact TEST IDs remain only in the
restricted operator fixture file; committed evidence uses hashes.

This proves fresh canonical TEST reconciliation after an actual isolated Cloud SQL
restore. It does not create or verify a LIVE paid lifecycle, perform a production
restore, deliver a fresh signed webhook, or establish arbitrary older-code
rollback compatibility. The operator must keep admissions paused during a real
restore until provider and ledger reconciliation completes.
