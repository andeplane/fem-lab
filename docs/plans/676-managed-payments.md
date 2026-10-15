# Explicit Managed Payments preparation

Issue: [#676](https://github.com/andeplane/fem-lab/issues/676). Decision:
[ADR 0032](../adr/0032-billing-merchant-responsibility.md). Activation evidence is
owned by [#661](https://github.com/andeplane/fem-lab/issues/661); policies/copy by
[#674](https://github.com/andeplane/fem-lab/issues/674).

## Runtime and release contract

The public manifest adds `merchantMode: pending | direct | managed`, bound as
`BILLING_MERCHANT_MODE` to API and recovery Jobs. The host rejects enabled billing
with a missing/pending merchant decision or managed mode without
`taxMode: automatic`. Disabled configuration can prepare signed webhooks and
recovery without permitting a new purchase. Account profiles add optional
`billing.merchantMode` with the same enum; clients treat an absent field as pending.

Common activation evidence remains `taxCollectionDecisionConfirmed` and
`policyUrlsConfirmed`. Automatic collection requires
`taxClassificationConfirmed`. Direct automatic mode also requires
`activeTaxRegistrationVerified`; managed mode does not require or change that
owner-registration flag. Managed mode instead requires:

- `managedPaymentsAccountEnabled`
- `managedPaymentsEligibilityConfirmed`

Live mode retains `stagingCheckoutVerified` and `webhookVerified`, with
`managedPaymentsTermsAccepted` and `managedPaymentsCheckoutVerified` additionally
required for the managed route. Test-mode classification verifies a candidate
fixture catalog, not the owner's legal classification; test-mode account readiness
does not represent acceptance of a live legal contract. Live classification remains
unconfirmed until the owner explicitly reviews it.
These are evidence gates, not legal decisions made by software. No public catalog
manifest, Stripe setting, key permission, terms acceptance or deployment changes
as part of this code preparation. The existing restricted runtime key scopes are
sufficient for Checkout, invoices, subscriptions/schedules, Portal, refunds and
disputes; no Products or Tax permission is added for legal classification checks.

Managed Checkout explicitly enables `managed_payments` and omits the unsupported
direct tax/customer-update/tax-ID fields. Stripe handles their collection. Direct
Checkout explicitly disables Managed Payments and retains its tax decision and
optional tax-ID entry. The integration identifier has one generated eight-letter
suffix fixed in source, so retrying an intent sends identical parameters.

## Catalog and acceptance boundaries

The owner serves international individuals and businesses. Candidate codes from
the [official AI tax guide](https://docs.stripe.com/tax/ai) are cloud AI personal
`txcd_10105001` and cloud AI business `txcd_10105002`; these remain candidates for
owner review, not an inferred legal classification. Stripe lists both as
Managed-eligible. A separate focused issue will add explicit purchase-use and
server-allowlisted personal/business price aliases per tier. Tax-ID collection
alone does not select a different product tax code. Test candidate catalog setup
does not constitute live legal confirmation.

Verify real hosted managed Checkout and a paid invoice, then duplicate delivery,
next-period plan change, renewal, cancellation, refund and dispute handling before
live activation. Existing direct subscriptions require their original merchant
route; changing the global selection only affects new purchases. Do not claim
worldwide tax coverage: Stripe accepts customers in more destinations than those
where it assumes indirect tax responsibility.

Tests exercise actual SDK request encoding for both routes, stable retry labels,
USD canonical invoices alongside localized payment details, schedule inheritance,
runtime guards, every readiness gate before secret access, and identical pinned
API/Jobs configuration. These local tests do not establish account eligibility,
legal classification, accepted terms or a completed Managed Payments purchase.
