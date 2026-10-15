# Personal and business subscription aliases

Issue: [#680](https://github.com/andeplane/fem-lab/issues/680). Decisions:
[ADR 0033](../adr/0033-subscription-use-and-payment-contracts.md) and
[merchant responsibility ADR 0032](../adr/0032-billing-merchant-responsibility.md).
This PR stacks on [#679](https://github.com/andeplane/fem-lab/pull/679). Catalog and
activation evidence remain [#661](https://github.com/andeplane/fem-lab/issues/661);
conditional policy copy is [#674](https://github.com/andeplane/fem-lab/issues/674).

## Contracts

The registered `account.checkout` Command and `/v1/billing/checkout` accept
`purchaseUse: personal | business`. New managed purchases require it. The form has
no default and sends an explicit choice; this is an argument on the callable
Command, not a hidden persistent setting. Existing direct legacy callers without
the new argument remain compatible. Plan changes still accept only `plan`, derive
the subscription's original allowed use, and keep legacy direct prices in their
original route. Unknown/mixed aliases fail with a structured review error.

The manifest retains each tier's legacy product/price and adds
`plans.<tier>.purchaseUses.personal|business = {product,price,taxCode}`. Amounts and
credits remain tier properties; aliases cannot override them. Release binds
`STRIPE_PRICE_<TIER>_PERSONAL` and `_BUSINESS` beside legacy IDs on API and recovery
Jobs. All six aliases are required for managed activation. Prices Read verifies
each configured ID, product owner, environment, active state, USD amount and
monthly interval. No Products/Tax permission is added; product tax classification
remains recorded owner/operator evidence under #661. Duplicate price identities
and malformed mappings fail before credential access.

Canonical paid invoices recognize the nine configured price roles and grant only
one tier allowance for an owned subscription period. A period records use; a later
invoice cannot silently change it. Unknown/multiple/prorated invoice lines do not
mint an allowance. Adaptive local-currency presentation does not replace canonical
USD invoice accounting.

## Migration and retry safety

Build this committed service source, then run the existing migration helper with
the explicit environment, owner account, owned IAM proxy port and built source.
Migration `009-purchase-use-contract.sql` must precede deployment; readiness checks
for its receipt. Staging migrations reapply disabled admission and zero supplier
caps. This code does not change runtime limits, external catalog, legal acceptance
or either real public manifest.

New Checkout intents persist request version, selected price/use, merchant/tax
mode, return origin, customer/project identity and the original expiry. Plan-change
intents persist request version and target price/use. Historical rows remain
unversioned, without backfill. A payable intent with changed or missing frozen
settings returns `409 checkout-open` and its original expiry, making no new Session
creation call. Closing/canceling the browser page alone does not expire it. The
initial window is 31 minutes, so a different selection may need to wait for the
remaining window. Unknown plan-change contracts require review instead of new
parameters under an old operation key.

## Verification

Real PostgreSQL tests cover both uses, canonical grants/deduplication, fixed-use
renewals and tier changes, lost responses, legacy/unversioned rows, configuration
drift and bounded expiry. Shared registry tests retain 100% coverage. Controller
tests verify the exact purchase-use body and plan-only changes; Chromium checks
the actual panel with injected accounts/dispatch, keyboard selection, reset and a
390px viewport. These UI checks do not perform a real purchase. Root coordinates
full hosted Managed Payments acceptance using explicitly candidate TEST products;
live legal classification and terms remain separate approvals.
