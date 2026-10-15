---
status: accepted
date: 2026-10-15
---

# Public AI credits measure a small supplier-dollar budget

Issue [#728](https://github.com/andeplane/fem-lab/issues/728) replaces confusing
millions-scale public quantities with one credit per USD 0.001 of supplier usage.
Advertised allowances are Free 5,000, Plus 7,500, Pro 12,000 and Studio 37,500.
Prices, model access, supplier tariffs and spending limits stay unchanged.

The integer ledger, grant amounts, holds, immutable usage entries and historical
tariff versions remain unchanged. Tariff v1 uses 40 subcredits per supplier
microdollar, so one new public credit is 40,000 subcredits. Its old public unit was
30 subcredits. Balances in the new unit divide exact stored subcredits by 40,000;
receipts read their immutable `chargedSubcredits`. Conversion does not round each
request, debit, reservation or grant. Only the UI rounds its display to at most
two decimals. A cached-input charge of 3 subcredits still costs 0.000075 credit.

The existing monthly free grant of 199,999,980 subcredits is 4,999.9995 new credits,
displayed as 5,000. Its rounded-up supplier budget remains exactly USD 5. This
change neither tops up historical grants nor changes future allocation. Existing
one-time invitations retain their original amount, expiry and eligibility rules.

## Compatibility and rollout

Clients opt in with `X-FEMLab-Credit-Unit: usd-milli-v1`. The account response has
a top-level `creditUnit` covering its `usage` and `freeAllowance` quantities;
claim responses and every converted receipt carry the same marker. Both completion
routes, streamed receipts, request status and JSON idempotency replays use the
negotiated representation. Unknown units fail with 422 before account/claim or
generation work. Credit-unit selection is transport metadata, never provider input,
client spending authority or part of a generation's idempotency identity.

Requests without the header retain the old response contract, including integer
truncation of account balances and the historical receipt credit values. A cached
old browser can complete and reconcile its requests after deployment. Raw receipt
fields and tariff versions never change; switching units for a replay does not
dispatch, create a debit or add a grant. New clients normalize an absent marker
once using the legacy conversion and reject unknown response units.

Deploy the header-capable backend first, then the new frontend. Keep a
header-capable API available while new clients can be cached; rolling back below
this protocol would reject their cross-origin preflight. Financial/AI POSTs are
not automatically retried to negotiate transport. ADR 0037's stronger safety
boundary still applies to any rollback below monthly eligibility support.

Account exports retain their raw ledger tables and `femlab-account/1` format,
adding a `creditAccounting` descriptor with stored unit `subcredit`, scales 30
and 40,000, and the new public unit. Descriptive Stripe catalogs use the new unit
and quantities; runtime grant allocation continues to use the existing fixed
ledger amounts and canonical invoice periods, independently of Product metadata.

The trade-off is supporting two response representations during this early
preview transition. Explicit negotiation prevents a new fractional receipt from
breaking old integer-credit clients and prevents unlabelled mixed units. Removing
the legacy representation later requires a separately versioned API decision.

Verification covers real PostgreSQL grants/entries/receipts before and after
account reads, claims and cross-unit replay, tiny fractional debits, unchanged
legacy responses, strict unknown-unit rejection and browser display states.
