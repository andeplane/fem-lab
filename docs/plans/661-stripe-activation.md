# Stripe subscription activation

Issue: [#661](https://github.com/andeplane/fem-lab/issues/661). Implementation: [#644](https://github.com/andeplane/fem-lab/issues/644).

## Verified configuration

- Selected merchant: Hafreager kode & koblinger (`acct_1UQmBTAAtmJJ65hf`).
- The owner confirmed the business is based in Norway, has no VAT registration, and may serve international customers. The initial technical mode is `not_collecting`; this does not determine international tax obligations.
- Production terms and privacy pages return HTTPS 200. Their URLs are saved in the live account public details, and legal-link display is enabled in hosted Checkout. Both dedicated FEM Lab billing portal configurations contain the same policy URLs.
- A restricted test runtime key is installed as staging `stripe-api-key:1`. Write permissions cover Customers, Checkout Sessions, Customer Portal and Subscriptions (including schedules). Read permissions cover Prices, Invoices, Charges/Refunds and Payment Disputes. Only the API and recovery job identities can read the secret.
- The native browser accessibility output exposed an existing full-access test key. That test key was immediately rotated. The restricted replacement was transferred through a one-use loopback password form into the reviewed installer without logging its value. No live key was exposed.
- The invitation-only admission flow was verified in production: signup gets zero credits; explicit approval gives 200,000 once with stable expiry; a real Mini completion settled for 46 credits; replay did not regenerate; durable deletion revoked the old token. Free supplier pool is capped at USD 1/day.

## Remaining acceptance

1. Enable staging with its pinned test secrets, and verify a real Stripe test Checkout purchase through webhook delivery and canonical paid invoice credit settlement.
2. Verify renewal, plan change, cancellation, refund/dispute freeze and retry behavior against Stripe test mode; record evidence without customer or credential material.
3. Install an equally restricted live runtime key, record test acceptance gates, then activate production and verify ready state and checkout creation without charging a real customer.
4. Preserve independent reviewable PRs and keep production Checkout disabled until the acceptance gates pass.
