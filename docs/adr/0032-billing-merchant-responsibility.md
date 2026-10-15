---
status: accepted
date: 2026-10-15
---

# Checkout declares merchant responsibility independently of tax collection

Issue [#676](https://github.com/andeplane/fem-lab/issues/676) prepares the owner's
selected Managed Payments route while preserving direct merchant Checkout.
`BILLING_MERCHANT_MODE` is `pending`, `direct`, or `managed`. Missing or unknown
runtime values become pending and cannot enable billing. This choice never
inherits a Stripe account default. Public account state exposes the optional
`billing.merchantMode`; an older response without it is pending for presentation.
The field describes new purchases, not a conversion of an existing subscription.

Tax mode remains separate. Direct automatic tax requires evidence of the owner's
active registration. Managed mode requires automatic tax intent but never asserts
owner registrations: Stripe controls collection. Per the
[Managed Checkout contract](https://docs.stripe.com/payments/managed-payments/update-checkout),
its request enables `managed_payments` and omits `automatic_tax`, tax-ID collection
and customer-update parameters. Direct requests retain those parameters. Both use
hosted Checkout, server-owned prices, stable idempotency parameters and a fixed
integration identifier. Portal, webhook and recovery access survive disabled new
purchases.

Managed activation requires recorded account enablement, terms acceptance, product
eligibility, classification and policy readiness. Production additionally needs
route-specific test Checkout evidence. Selecting this mode does not accept legal
terms or select a tax code. Products and destinations must meet Stripe's
[eligibility](https://docs.stripe.com/payments/managed-payments/eligibility) and
[tax coverage](https://docs.stripe.com/payments/managed-payments/tax-compliance)
requirements; permitted customer countries exceed tax-covered countries. Existing
direct subscriptions cannot be converted by changing this setting.

The existing invoice/price ownership graph remains the credit authority. Adaptive
Pricing may display local currency while
[invoices remain in integration currency](https://docs.stripe.com/tax/calculating/adaptive-pricing).
Stripe supports subscription schedules for Managed subscriptions; our schedule
updates preserve inherited tax settings. Payment method updates stay in Portal.
Refunds and disputes continue through signed events and immutable ledger entries.

The trade-off is explicit operational readiness and Stripe-controlled payment UX,
fees, refund decisions and transaction support in exchange for its merchant role.
This does not transfer application support, supplier usage or the headless engine
boundary established in ADR 0028.
