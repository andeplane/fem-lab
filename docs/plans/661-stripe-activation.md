# Stripe subscription activation

Issue: [#661](https://github.com/andeplane/fem-lab/issues/661). Implementation: [#644](https://github.com/andeplane/fem-lab/issues/644).

## Verified configuration

- Selected merchant: Hafreager kode & koblinger (`acct_1UQmBTAAtmJJ65hf`).
- The owner confirmed the business is based in Norway, has no VAT registration, and will serve individuals and businesses internationally. Test purchases use `not_collecting`. Production remains disabled with `taxCollectionDecisionConfirmed: false` until the owner chooses a supported tax-handling route; Norwegian registration status alone does not settle international consumer tax handling.
- Production terms and privacy pages return HTTPS 200. Their URLs are saved in the live account public details, and legal-link display is enabled in hosted Checkout. Both dedicated FEM Lab billing portal configurations contain the same policy URLs.
- Restricted test and live runtime keys are installed as `stripe-api-key:1` in their respective projects. Write permissions cover Customers, Checkout Sessions, Customer Portal and Subscriptions (including schedules). Read permissions cover Prices, Invoices, Charges/Refunds and Payment Disputes. Only the API and recovery job identities can read the secret.
- The native browser accessibility output exposed an existing full-access test key. That test key was immediately rotated. The restricted replacement was transferred through a one-use loopback password form into the reviewed installer without logging its value. No live key was exposed.
- The invitation-only admission flow was verified in production: signup gets zero credits; explicit approval gives 200,000 once with stable expiry; a real Mini completion settled for 46 credits; replay did not regenerate; durable deletion revoked the old token. Free supplier pool is capped at USD 1/day.

## Hosted Stripe test acceptance

These are actual Stripe test-mode transactions through the deployed API and hosted Checkout, with real signed webhook delivery; no real customer was charged.

- A newly verified account had zero credits. Repeated Checkout creation returned the same payable Session. The hosted Plus purchase paid USD 49; canonical invoice verification and both paid-invoice webhooks produced exactly one 4,000,000-credit grant. Signed replay did not create another grant.
- Customer Portal session creation succeeded for the owned customer. A Plus-to-Pro change scheduled at the original paid period end, and retry preserved that schedule without an early grant.
- Advancing the Stripe test clock produced a real USD 149 renewal invoice. Both invoice events completed, including recovery of a queued duplicate. Exactly one future 16,000,000-credit grant starts at the original Plus period end, without overlap; current wall-clock credits remained 4,000,000.
- Fully refunding the original USD 49 charge delivered a real `charge.refunded` event. The account entered pending billing review, eligible credits became zero, and plan changes returned `409/billing-review`. Both historical paid grants remained immutable.
- The first disposable account was durably deleted; its old Firebase token returned 401, renewal stopped, and private QA credential files were removed.
- An independent dispute-card hosted purchase is being verified separately, followed by durable cleanup.

## Deployed safeguards

- Both API environments and recovery jobs run backend source `bf8505fa1a101879c33cd32b25912818b7b88dfc`, including the narrow safe Checkout-expiry retry. Production readiness is healthy with billing disabled; staging billing is enabled in test mode.
- Both restricted runtime keys and webhook signing secrets are pinned to version 1 in each environment. API and recovery job identities have the required Secret Manager access. The test and live webhook endpoints are enabled; enabling the live receiver does not enable Checkout or create a charge.
- All staging AI spending is disabled (`ai_limits.enabled=false`, supplier caps zero), including for paid test accounts. Test cards cannot purchase real supplier spend. Issue #669 makes this the staging migration default; any bounded AI QA must be explicitly temporary.
- The obsolete production `domain-600` traffic tag was removed and its diagnostic URL returns 404. The canonical API remains healthy.

## Remaining acceptance

1. Finish independent real test dispute verification and clean the disposable fixture.
2. Choose international tax handling. Recommended candidate: [Stripe Managed Payments](https://docs.stripe.com/payments/managed-payments), subject to account eligibility review and owner acceptance of its terms. It supports Norway and eligible cloud AI products, and handles indirect tax in supported jurisdictions. The additional fee is [3.5% of the payment total, including tax](https://stripe.com/managed-payments), plus standard Payments and Billing fees. The alternative is direct merchant billing after the owner confirms the applicable tax arrangements. No tax registrations have been invented or added.
3. After the selected route is configured and tested, activate production and verify ready state and owned Checkout creation without charging a real customer. Production checkout stays disabled until then.

Independent implementation PRs: #648 (billing), #667 (direct Checkout parameters), #670 (safe expiry retry), #672 (staging AI pause defaults). Published policies and Google sign-in are already deployed.
