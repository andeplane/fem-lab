# Stripe subscription activation

Issue: [#661](https://github.com/andeplane/fem-lab/issues/661). Implementation: [#644](https://github.com/andeplane/fem-lab/issues/644).

## Verified configuration

- Selected merchant: Hafreager kode & koblinger (`acct_1UQmBTAAtmJJ65hf`).
- The owner confirmed the business is based in Norway, has no VAT registration, and will serve individuals and businesses internationally. Historical direct-mode test purchases used `not_collecting`; the prepared test catalog now selects Managed Payments with Stripe-controlled tax. Production remains disabled until Managed Payments usage terms and full hosted lifecycle acceptance are confirmed; Norwegian registration status alone does not settle international consumer tax handling.
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
- An independent dispute-card hosted purchase paid successfully and Stripe created a canonical `product_not_received` dispute. Its webhook exposed an adapter ID-prefix bug, fixed in #675 / PR #677 by routing through the verified event kind. The preserved real `du_` dispute then completed from the durable inbox: exactly one review, zero eligible credits, plan-change rejection, and the original 4,000,000-credit grant retained. Signed replay did not duplicate the review. The second fixture was durably deleted and its old token returned 401; renewal stopped and all private fixture files and owned database processes were removed.

## Deployed safeguards

- Both API environments, recovery jobs and frontends now run combined source `dc1bcb47db76cd0efc5510c387eec8fd17a7cb16`: safe Checkout expiry, dispute routing, explicit merchant mode, purchase-use contracts, independent account management and conditional policies. Production readiness is healthy with billing disabled; staging billing is enabled in Managed Payments test mode.
- Both restricted runtime keys and webhook signing secrets are pinned to version 1 in each environment. API and recovery job identities have the required Secret Manager access. The test and live webhook endpoints are enabled; enabling the live receiver does not enable Checkout or create a charge.
- All staging AI spending is disabled (`ai_limits.enabled=false`, supplier caps zero), including for paid test accounts. Test cards cannot purchase real supplier spend. Issue #669 makes this the staging migration default; any bounded AI QA must be explicitly temporary.
- The obsolete production `domain-600` traffic tag was removed and its diagnostic URL returns 404. The canonical API remains healthy.

## Remaining acceptance

1. #676 / PR #679 and #674 / PR #678 are merged. #680 / PR #685 and #683 / PR #688 are also merged after exact-head CI and independent review. Their code is already deployed in the combined candidate. Complete full hosted Managed Payments purchase and lifecycle acceptance. Direct-mode lifecycle acceptance above is complete; it is not evidence of a managed subscription purchase.
2. The owner selected preparation of [Stripe Managed Payments](https://docs.stripe.com/payments/managed-payments), subject to account eligibility review and owner acceptance of its terms. It supports Norway and eligible cloud AI products, and handles indirect tax in supported jurisdictions. The additional fee is [3.5% of the payment total, including tax](https://stripe.com/managed-payments), plus standard Payments and Billing fees. The owner confirmed cloud AI personal/business product classifications. The authenticated Dashboard reports the account ready to use and six eligible products. Explicit authorization to use the live Managed Payments terms is still pending. No tax registrations have been invented or added.
3. After the selected route is configured and tested, activate production and verify ready state and owned Checkout creation without charging a real customer. Production checkout stays disabled until then.

Independent implementation PRs: #648 (billing), #667 (direct Checkout parameters), #670 (safe expiry retry), #672 (staging AI pause defaults), #677 (real dispute IDs), #678 (conditional merchant policies), #679 (explicit merchant mode). Published policies and Google sign-in are already deployed.

## Managed Payments preparation evidence

- Six test-only candidate Products/Prices cover cloud AI personal (`txcd_10105001`) and business (`txcd_10105002`) use for all three tiers. These are test fixtures, not owner confirmation of live legal classification. These test fixtures preceded the owner confirmation and live catalog preparation recorded below.
- Both a minimal request and the exact prepared SDK request shape created real Managed Payments test Checkout Sessions. The direct-only automatic-tax, tax-ID and customer-update parameters were omitted. Stripe returned `automatic_tax.enabled=true`, `liability.type=stripe` and `provider=stripe`.
- Filling the fake Norway personal-use location in hosted Checkout produced canonical `automatic_tax.status=complete`, USD 49.00 subtotal, USD 12.25 tax and USD 61.25 total. The UI showed the managed seller's Link terms/support route. Neither contract-only Session was submitted or paid. Both Sessions were explicitly expired and their disposable customer deleted.
- The owner unlocked the Mac and the native Dashboard is authenticated. No additional passkey prompt was required. The subsequent account and product eligibility readback is recorded below; explicit live usage-terms consent has not been assumed.

## Prepared Managed Payments release configuration

- Both manifests explicitly select `merchantMode=managed` and `taxMode=automatic`. Production remains disabled. Live account/eligibility and classification/tax-decision gates now have the owner/provider evidence below. Terms and hosted managed checkout acceptance gates remain false until explicitly completed. Existing direct prices remain allowlisted solely for canonical recovery and existing subscriptions.
- Staging includes the six test-only personal/business catalog aliases above. Its classification, account and eligibility flags record only the accepted test API contract and candidate fixture setup; they do not attest to live eligibility, legal classification or binding consent. Test legal terms remain unaccepted and full hosted managed checkout acceptance remains false until the combined app purchase is verified.
- Both Stripe Portal configurations were read back from the provider: cancellation at period end, payment method updates and invoice history are enabled; subscription updates are disabled. Plan changes therefore stay in FEM Lab's validated usage and purchase-use flow.
- Migration 009 must be applied from the final #680 source before releasing its API. No earlier draft of 009 has been applied to either cloud database. The combined release also requires #683 so owned cancellation/payment management remain available when new sales are paused.

## Combined release verification

- Cloud builds `da4e5908-9116-4d14-92bb-56af624899b3` (staging) and `ab805976-2d22-4b00-a2d0-16d4bbfd9880` (production) succeeded. Both APIs and recovery jobs were released by immutable digest and the recovery jobs executed successfully before traffic moved. Each API serves 100% on its new revision and `/ready` returns 200.
- Migration `009-purchase-use-contract.sql` from final #680 source `f112b33d` is applied in both cloud databases, including all four source-contract fields. Its deployed contents are now immutable; future schema corrections require another migration. Staging AI remains disabled. The owned migration proxies and isolated local test databases were stopped and removed.
- Staging runs `BILLING_MERCHANT_MODE=managed`, `BILLING_TAX_MODE=automatic`, `BILLING_ENABLED=true` and six purchase-use aliases. Production selects managed/automatic but keeps `BILLING_ENABLED=false` with no live aliases. Anonymous Portal requests return 401 in both; anonymous new Checkout returns 401 in staging and 503 in paused production. No live Checkout or charge was created.
- Root's combined suite passed 222 service tests on real PostgreSQL, 1,327 app tests (five skipped) with coverage thresholds, 27 Stripe plus 10 Google Python guards, and app/service typechecks/builds. Both environment preflights validated provider prices using the existing restricted keys. The production and staging bundle scans passed.
- Independent review rejected ten changed-source/schedule retry probes before provider reuse and verified actual SDK lost-create replay through a durable SQL receipt to exactly one update. Local Chromium policy/landing tests passed at the hosted root path. Both Firebase frontend releases completed; published policy contents and entry assets were checked by HTTPS. A live signed-in Managed Payments browser purchase remains unverified.
- Evidence: `/tmp/femlab-plan-final-review-evidence-680.json`, `/tmp/femlab-managed-schema-evidence-661.json`, `/tmp/femlab-managed-release-evidence-661.json`, `/tmp/femlab-managed-hosting-evidence-661.json`. These contain public configuration, aggregate verification and test-only evidence, no credentials.

## Owner-confirmed live catalog and Dashboard readiness

- The owner confirmed cloud AI personal (`txcd_10105001`) and business (`txcd_10105002`) use. Six live Products with their default monthly USD Prices are now created and read back from the selected account: Plus49/4M, Pro149/16M, Studio499/50M, each with exclusive tax and fixed personal/business use. The public catalog evidence is `/tmp/femlab-managed-catalog-661-live.json`; runtime preflight verified all nine live price contracts using the existing restricted key.
- The live Dashboard reports **Ready to use**, changing to active only after the first managed transaction, and **6 of9 products eligible**. The three historical direct Products were left unchanged. The preset category is cloud AI personal; each of the six new Products has an explicit personal or business code.
- The Dashboard currently shows Managed Payments enabled by default for all Checkout Sessions/payment links. FEM Lab's adapter always sends explicit managed true/false, and production new sales are still disabled. The default setting and live usage terms need a final concrete review before activation; no separate binding terms acceptance action was performed by the agent.
- The disposable actual staging Managed Checkout was submitted once with official4242 test card and fake Norway personal-use details after reviewing USD49 subtotal +12.25 VAT =61.25 total. Browser returned to staging. Canonical payment/webhook and lifecycle verification is in progress; no live customer was charged.
