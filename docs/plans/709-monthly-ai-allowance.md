# Paid monthly AI allowance

Issue [#709](https://github.com/andeplane/fem-lab/issues/709).

Historical allocation change: the weighted-credit quantities below are the legacy
unit. [#728](728-credit-scale.md) presents the same paid allocations as
7,500/12,000/37,500 `usd-milli-v1` credits. [#712](712-free-monthly-allowance.md)
subsequently introduced reviewed monthly free funding and its separate pool.

Increase Plus from 4,000,000 to 10,000,000 weighted credits per confirmed paid
period at its existing $49 monthly price. This provides a $7.50 supplier-cost
baseline, within the requested $5–$10 range. Pro stays at 16,000,000 credits
($12 baseline) and Studio at 50,000,000 ($37.50). Prices exclude applicable tax;
payment fees, hosting, refunds and uncertain provider usage are additional costs.

The v1 tariff equates one million credits to $0.75. Its token weights match the
current standard [Mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
and [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) supplier
rates, including cached input, Astra cache writes and generated reasoning. Credits
remain weighted usage rather than a promise of equal raw tokens across models.
No token tariff, Stripe price, schema or model entitlement changes are required.

Paid grants follow the canonical invoice's billing period. A successful initial
payment or renewal issues one immutable allowance; event or invoice replay cannot
add another. Unused credits expire without rollover. Existing recorded grants
retain their amounts; future paid periods receive the new Plus allowance.
Signup, calendar rollover and sign-in do not create any allowance. Free previews
remain one-time operator invitations with no automatic monthly grants.

Reservations check credits and worst-case supplier cost atomically before
generation. Actual usage settles once, and uncertain usage remains held for
recovery. Keep the production aggregate safety limits unchanged: $100/day,
$1,000/month, $10 outstanding supplier exposure, 16 concurrent requests and a
separate $1/day free pool. These shared launch limits can temporarily stop paid
requests too; a paid allowance does not bypass service budgets. Staging AI remains
disabled with zero supplier caps.

Update the service allowance, account plan cards, public terms, descriptive
catalog quantities and current economics together. Verify independent USD
conversions, historical grant retention, one revised renewal, expiry/no rollover,
paid budget enforcement, all service tests on isolated real PostgreSQL, the
account UI tests and affected builds. The release owner deploys the focused
commit; historical live acceptance evidence retains the quantities it observed.

Provider consistency remains a release acceptance step: the release owner's
readback found the Plus Products in both Stripe modes still describe 4M credits,
and legacy Products also retain `credits=4000000` metadata. After the service
allowance is deployed, update those descriptions and descriptive metadata to
10M, preserving all Product/Price identities, prices and tax classifications.
No remote Stripe edits are made by this implementation PR.
