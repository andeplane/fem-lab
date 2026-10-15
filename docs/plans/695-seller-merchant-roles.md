# Seller and merchant-of-record wording

Issue [#695](https://github.com/andeplane/fem-lab/issues/695), correcting the
customer-copy interpretation in [#674](674-managed-payment-policies.md) before
activation #661. No billing configuration, legal acceptance or deployment changes.

Read the current [Norway Stripe Managed Payments service terms](https://stripe.com/en-no/legal/ssa-service-terms#stripe-managed-payments)
on 15 October 2026 (last modified 28 September 2026). Section 1.1 identifies Sold
through Link, LLC as SMP. Section 2.1(a) makes SMP merchant of record, facilitating
the product sale on the seller’s behalf, while the business remains seller of
record. Sections 3.3 and 4.1 retain the additional Link refund policy and limit SMP
indirect-tax responsibilities to supported coverage. Do not equate merchant of
record with seller of record or promise universal tax handling.

Terms, Privacy and account copy therefore identify Hafreager kode & koblinger as
seller and provider in every payment mode. The explicit managed mode adds
transaction-role wording. Consumers can send withdrawal notices and all customers
can send refund requests or complaints to Hafreager for either payment route.
Managed purchases retain the additional receipt/Link support route and refund
policy. Cancellation, mandatory consumer rights and existing payment arrangements
are preserved.

Verify seller/provider identity across direct, managed, pending and missing account
responses with billing enabled and disabled. Chromium public-policy smoke checks
assert the distinct roles, supported-tax qualifier, both support routes, withdrawal
email and mandatory-rights wording at 390px without login or scripts. Inspect
rendered narrow pages as well as running the app typecheck, relevant unit tests,
production build and bundle secret scan. This verifies the correction, not a legal
compliance opinion or live merchant activation.
