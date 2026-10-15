# Stripe catalog and guarded billing release

Implements [#644](https://github.com/andeplane/fem-lab/issues/644), a launch slice of
[#556](https://github.com/andeplane/fem-lab/issues/556). Follow-up acceptance belongs
with [#557](https://github.com/andeplane/fem-lab/issues/557). Free account abuse is
handled separately by [#645](https://github.com/andeplane/fem-lab/issues/645);
public policies by [#646](https://github.com/andeplane/fem-lab/issues/646).

## Prepared configuration

The user selected **Hafreager kode & koblinger**, Stripe account
`acct_1UQmBTAAtmJJ65hf`. Readback on 2026-10-15 shows country NO, charges and payouts
enabled, details submitted and no outstanding verification requirements. Both
environments were empty before provisioning. No customer, subscription, charge,
invoice, coupon, auto-converting trial or tax registration was created.

The public resource manifests are [test](../../infra/stripe/test.json) and
[live](../../infra/stripe/live.json). Each tier has its own Product and monthly USD
Price, exclusive of applicable tax. Product subscription statement descriptors are
`FEMLAB`; existing account-wide settings were preserved. Stripe's actual bank
statement formatting still needs verification with a real owner-approved payment.

| Plan | Monthly price before tax | Included credits per paid period | Maximum supplier baseline if fully used | Price / supplier baseline |
|---|---:|---:|---:|---:|
| Plus | $49 | 4,000,000 | $3.00 | 16.3x |
| Pro | $149 | 16,000,000 | $12.00 | 12.4x |
| Studio | $499 | 50,000,000 | $37.50 | 13.3x |

The last two columns use the current tariff's $0.75 per million credits. They
exclude Stripe fees, tax, Google hosting/storage/database costs, refunds, fraud,
support and uncertain provider charges. They are pricing inputs, not profit
forecasts. Paid credits expire at the period end, replace free allowance and have
no rollover or automatic overage purchase. Plan changes take effect at renewal.

The restricted Portal permits billing address/name/tax-ID updates, payment method
updates, invoice history and cancellation at period end. Plan switching, quantity
changes, promotion codes, retention offers and public Portal login are disabled.
The application owns plan changes and customer ownership.

Each webhook points to its own API's `/v1/billing/webhook`, pins
`2026-09-30.endive` to match installed Stripe Node 23, and selects exactly the eight
events consumed by the existing lifecycle: `invoice.paid`,
`invoice.payment_succeeded`, `invoice.payment_failed`,
`customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created`.
Entitlement comes from a canonical, paid subscription invoice, never a browser
success redirect. Existing durable receipt and invoice deduplication remain the
authority. The endpoints are disabled until their consumers are configured.

Webhook signing secrets were sent through a hidden local prompt directly to
Secret Manager as `stripe-webhook-secret` version 1 in both Google projects. Only
the API and recovery identities have secret access. Signing values were never
printed, committed or written to temporary files.

## Runtime key handoff and release

Stripe MCP can configure resources but cannot issue the application's restricted
runtime API keys. The owner creates a separate restricted key in each mode under
[API keys](https://dashboard.stripe.com/acct_1UQmBTAAtmJJ65hf/apikeys).
Use Write for Customers, Checkout Sessions, Subscriptions, Subscription Schedules
and Customer/Billing Portal; Read for Prices, Invoices, Charges and Disputes;
leave other resources at None. Write includes Read. Actual staging flows must
verify these permissions; broaden only a permission a documented call needs.

Run locally, with no key in the command or chat:

```sh
python3 infra/stripe/install-runtime-key.py --mode test --account andershaf@gmail.com
python3 infra/stripe/install-runtime-key.py --mode live --account andershaf@gmail.com
```

The installer prompts without echo, rejects secret rather than restricted keys,
rejects a mode mismatch, and reads all three exact prices before storing anything.
It validates product, active state, currency, amount and monthly interval. The key
goes to `stripe-api-key` in `femlab-app-staging` or `femlab-app` through process
stdin; the API and recovery job receive scoped access. Existing enabled versions
remain available for rollback. It does not enable checkout.

Read-only release preflight:

```sh
python3 infra/stripe/billing_config.py --environment staging --account andershaf@gmail.com
python3 infra/stripe/billing_config.py --environment production --account andershaf@gmail.com
```

Without both enabled secrets it reports billing disabled. With both, it verifies
the runtime key against the exact catalog and emits only public environment values
and pinned secret references, never key bytes. A normal service release now binds
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BILLING_MODE`, the three prices and
Portal configuration to **both** the API and recovery job, together with
`BILLING_TAX_MODE`. The public manifest's `taxMode` is `pending`, `automatic`, or
`not_collecting`. Pending or unknown collection decisions cannot enable checkout;
disabled billing still prepares webhook and recovery processing. Automatic
collection requires the owner-confirmed decision and separately verified active
registration evidence and confirmed product classification. An explicit
owner-confirmed non-collection decision requires neither a registration nor an
invented product classification. Following the owner's clarification below, both
manifests record `not_collecting`; other launch acceptance gates remain false and
checkout remains disabled. The code does not infer the owner's tax obligations
from company or Stripe account status.
Production's return
origin is `https://femlab.app`; staging uses its own Hosting origin.

`release-service.py --billing preserve` is the default: it retains an active
configuration after rechecking prerequisites, and leaves an unconfigured service
disabled. Preservation reads the revisions actually receiving traffic, so a failed
candidate left in the service template cannot silently reset billing after rollback.
Mixed billing states across a traffic split require an explicit activation choice.
`--billing disabled` stops new checkout while preserving webhook and
recovery processing. `--billing enabled` is an explicit activation request and
fails before deployment unless the manifest records the required acceptance.
Production also requires recorded staging checkout and webhook acceptance.
Record true only after the evidence exists; these fields are not a shortcut around
the checks. Revision names include a hash of public configuration and pinned secret
references, allowing a safe new revision for a key rotation or billing activation
without rebuilding the image. Existing readiness, zero-traffic candidate,
recovery-job and traffic rollback gates remain in place.

## Remaining live acceptance

1. Install both restricted runtime keys and verify permissions against the real
   staging API. Bind secrets with billing disabled and verify raw signed delivery,
   rejection of wrong signature/mode, retry recovery and receipt deduplication.
2. Publish `/terms.html` and `/privacy.html` (#646), add them to both Portal
   configurations, and configure the account's Checkout legal-policy URLs in
   [Checkout settings](https://dashboard.stripe.com/acct_1UQmBTAAtmJJ65hf/settings/checkout).
   Required terms consent depends on those account settings; direct account policy
   URLs are a Dashboard operation. Preserve unrelated account branding/settings.
3. Confirm collection policy with the owner; product classification is required
   before activating automatic collection. On
   inspection, live Tax settings are active but have **no registrations and no
   default tax code**. Test mode has no registrations and an existing downloadable
   personal software default (`txcd_10202000`), which must not be silently inherited
   for hosted AI. Canonical candidate codes include cloud AI personal/business
   `txcd_10105001` / `txcd_10105002`, or SaaS personal/business
   `txcd_10103000` / `txcd_10103001` if the sold product is classified as SaaS.
   [Stripe tax codes](https://docs.stripe.com/tax/tax-codes) describe the categories.
   The owner must confirm the classification and where the business is already
   registered; Stripe account activation is not evidence of VAT registration.
   Record confirmed registrations only after explicit owner authorization.
   The adapter enables `automatic_tax` only for `taxMode=automatic`, and release
   activation requires `activeTaxRegistrationVerified=true` as well as the owner's
   decision. `taxMode=not_collecting` explicitly sends `automatic_tax.enabled=false`
   after the owner confirms that collection policy. Missing decisions remain
   pending; the owner's explicit initial choice is recorded below. Automatic tax
   does not collect in a jurisdiction without an applicable
   registration; never describe that as verified tax collection. Run a test
   calculation and inspect `taxability_reason` for an automatic collection setup.
   A later change of tax policy does not retroactively reconfigure existing Stripe
   subscriptions or completed invoices; handle that as a separately reviewed change.
4. Enable the staging consumer before its webhook, then test real hosted Checkout
   using Stripe test payment details, paid invoice grant, duplicate delivery,
   renewal, failed payment, cancellation, scheduled plan change, refund/dispute
   blocking and account deletion cancelling renewal. No live payment is needed for
   these tests. Record evidence and enable the live webhook before live checkout.
5. Activate production only after the above evidence and owner decisions are
   recorded. The present manifests intentionally keep billing disabled.

## Owner statements and initial collection mode

On 2026-10-15 the owner reported: “not VAT, but will work in norway”, then clarified
that **the business is based in Norway and customers are international**. Both
manifests therefore record the owner's initial `not_collecting` decision and
`taxCollectionDecisionConfirmed=true`; checkout remains disabled until the other
acceptance gates pass. No Norway-only customer or payment restriction is applied.
No registration or product tax classification was invented. Automatic collection
still requires confirmed classification and verified active registration.

This records the owner's stated registration status and initial configuration; it
is not a determination that no tax obligations exist in any customer country.
International registration, collection and filing obligations remain the owner's
responsibility to establish with a qualified tax adviser, using Stripe's
[threshold monitoring](https://docs.stripe.com/tax/monitoring) as supporting data.

## Tokens and model choice

Customer-facing allowances should remain **credits**, with concrete token examples.
Raw token promises hide large differences between input, cached input, reasoning
and output, and between models. The current tariff charges Mini one credit per
uncached input token and six per output token; Astra charges 13 1/3 and 66 2/3
respectively, with separate cache rates and long-context multipliers.

For an illustrative request with 10,000 uncached input tokens and 2,000 output
tokens, Mini uses 22,000 credits; Astra uses about 266,667. Plus therefore covers
about 181 such Mini requests or 15 Astra requests. Real engineering sessions vary
with journal/tool context, retries, reasoning and cache usage; these are not
guaranteed conversation counts. A 200,000-credit invitation allowance costs at
most $0.15 at the supplier baseline. Under #645 it is operator-reviewed and
one-time, with no automatic monthly issuance or grant on signup. A 50,000-credit
invitation ($0.0375 baseline) is a possible later reduction, not an implemented
change. No email or Google account can prove a unique person; removing automatic
issuance closes the present account-farming incentive without making that claim.

The current launch models remain OpenAI Mini (`gpt-5.4-mini`) and Astra
(`gpt-6-astra`); both already passed real production generation checks. Google
Cloud hosting does not require using Gemini. Candidate provider changes should
first pass the same FEM tasks: correct registry calls, quantities, model edits,
error recovery, tool-call sequencing, long sessions, cancellation and usage
settlement. Then compare successful-task cost and latency with current models.
Keep provider cost changes in a new versioned tariff rather than rewriting old
receipts. Neither a second provider nor a replacement model is silently enabled.

Official pricing references, checked for the parent launch review on 2026-10-15:
[OpenAI](https://developers.openai.com/api/docs/pricing) and
[Gemini](https://ai.google.dev/gemini-api/docs/pricing). Current Astra input/output
prices are $10/$50 per million tokens; Sol 6.1 is $2/$10 and Luna 6 is $0.10/$0.50.
Gemini Argon 4 lists $2/$10 promotional pricing through November 30, then $4/$20;
Flash 3.8 lists $0.75/$3.75 through December 31, then $1.50/$7.50. Promotions are
not a durable margin assumption. The current Mini tariff corresponds to
$0.75/$4.50. Evaluate smaller/cheaper models against actual FEM tasks before
choosing one as the default; token price alone is insufficient.

## Verification

Fourteen Python checks exercise secret stdin handling, mode/owner/currency/product
guards, error redaction, missing-key refusal, explicit activation gates,
preservation across releases, pinned references and both API/recovery bindings.
The release orchestration check uses fake cloud boundaries and verifies the
canonical return origin, separate database credentials and retained rollback
revision, including the same explicit tax mode on API and recovery job. Adapter
tests inspect the actual SDK request body for automatic collection and explicit
non-collection, reject pending checkout before a network request, and verify that
enabled runtime configuration refuses a missing or unknown collection decision.
Both live read-only preflights currently report billing disabled because
the runtime keys have not been installed. Stripe API readbacks confirmed all six
prices, both restricted Portal configurations and both version-pinned webhook
resources. No paid checkout, tax collection or live charge is claimed verified.

Stripe integration guidance: [restricted keys](https://docs.stripe.com/keys/restricted-api-keys),
[subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks),
[recurring tax setup](https://docs.stripe.com/billing/taxes/collect-taxes),
[Checkout policies](https://docs.stripe.com/payments/checkout/custom-components).
