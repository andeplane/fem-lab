# Hosted AI release evidence

Tracks [#557](https://github.com/andeplane/fem-lab/issues/557), following
[the backend plan](545-ai-backend.md) and infrastructure [#563](563-google-infrastructure.md).

## Current release policy and evidence, 2026-10-15

Production is https://femlab.app, with https://femlab-app.web.app retained as an alias.
Staging is https://femlab-app-staging.web.app. DNS and normally validated TLS are active;
the final API is https://api.femlab.app. [#600](600-domain-routing.md) records the real
227.451-second final-proxy stream, immutable receipt, idempotent replay, cancellation
settlement and disposable-account deletion. Its automatic free grant was historical,
before the invitation policy; the transport proof remains useful.

Under [#645](645-free-ai-admission.md), creating or reopening an account grants **zero**
AI credits. The optional preview requires operator approval: one 200,000-credit grant,
expiring after 30 days, with no automatic renewal or regrant on account recreation.
Verified paid invoices remain the only public paid-credit authority. This smoke does
not issue invitations, change spend caps, call a supplier or create a subscription.

Public staging is deliberately [AI-disabled](669-staging-spend-defaults.md), including
for existing test-paid accounts. New completions must return HTTP 503 / `ai-unavailable`
before input counting or an AI request row is created. Billing QA can run with this
safety baseline. The default live smoke below now verifies zero signup allowance,
reopen/refresh stability, denied UI and alias admissions, empty request/credit/receipt
exports, UI logout preserving the local Model, cross-owner export selectors rejected,
private export downloads and durable deletion of two disposable identities. Signed
export URLs are short-lived bearer capabilities: someone given the valid URL can
download it. Ownership is enforced when authenticated APIs select and request records;
the smoke does not mistake an operator-shared signed URL for an ownership failure.

Both Google providers are enabled and redirect-start evidence is recorded in
[#616](616-google-sign-in.md). A fresh production observation found the Firebase `gapi`
script blocked by CSP; [#696](https://github.com/andeplane/fem-lab/issues/696) tracks the
fix and fresh redirect verification. A completed owner chooser/consent return and real
email inbox delivery remain separate unverified gates. Admin-generated email action
links exercise the real exchange without sending an email or using an owner identity.

A separate read-only Google Cloud Console check on 15 October 2026 found both OAuth
audiences External and In production, with empty sensitive/restricted declared-scope
tables. The runtime provider uses basic identity scopes; no scope or configuration was
changed. Audience publication does not prove an owner sign-in return. A generic Gemini
key banner did not identify a FEM issue: neither project enabled `generativelanguage`,
and the Firebase public-key API allowlists excluded it. No key or service change followed.

Managed Payments TEST lifecycle acceptance is recorded by activation
[#661](https://github.com/andeplane/fem-lab/issues/661); live terms acceptance and billing
activation remain pending. The TEST lifecycle does not prove a live charge or grant
authority from a browser redirect. [#695](695-seller-merchant-roles.md) distinguishes
Hafreager as seller/product provider from the merchant-of-record transaction role.

## Included usage and supplier accounting

The deployed `dc1bcb47` catalog and read-only production snapshot at 2026-10-15
17:57:26 UTC use [tariff `2026-10-14.v1`](../../packages/service/src/credits.ts):
one credit is 30 subcredits and `supplierMicros` rounds `subcredits / 40` upward.
Thus one million weighted credits have a nominal supplier-accounting value of $0.75.
These are catalog-derived estimates, not a fresh model-price lookup or supplier invoice.

| Offer | USD list price / paid month | Weighted credits | Supplier equivalent at full use | Price / nominal supplier value |
|---|---:|---:|---:|---:|
| Invited preview | $0, once | 200,000 | $0.15 | n/a |
| Plus | $49 | 4,000,000 | $3.00 | 16.33× |
| Pro | $149 | 16,000,000 | $12.00 | 12.42× |
| Studio | $499 | 50,000,000 | $37.50 | 13.31× |

Mini consumes one credit per uncached input token, 0.1 per cache-read token and six
per output token including reasoning. Astra uses 13⅓, 1⅓ and 66⅔ respectively, with
16⅔ per cache-write input token. These are weighted allowances, not fixed raw-token
bundles. Current context ceilings are 64,000 for free and 128,000 for paid plans;
output ceilings are 4,096 for free, 8,192 for Plus and 16,000 for Pro/Studio. There is
no automatic overage or rollover. History, tools and other provider-metered context
consume allowance too.

The supplier equivalents exclude per-receipt upward rounding (less than one USD
microdollar each), company-funded overrun/uncertainty losses, infrastructure, support,
refunds and payment costs. They are not guaranteed net margins. [Stripe's published
Managed Payments pricing](https://support.stripe.com/questions/managed-payments-pricing?locale=en-GB),
read on 15 October 2026, adds 3.5% of the full successful transaction **including tax**,
plus ordinary payment processing and separate subscription/Billing fees. Tax collected
from customers is not subscription revenue; FX, payment method and dispute charges may
also apply. No assumed all-in Stripe fee or future supplier price is presented here.

The same read-only snapshot found production shared supplier limits of $100/day,
$1,000/month, a $1/day free pool, $10 unresolved exposure and concurrency 16; no active
holds were present. These are shared admission caps, not additional per-account credits
or a promise of uninterrupted use. Recorded receipt-derived supplier accounting was
$0.894551 for the UTC day, $0.894587 for the UTC month, and $0.012010 for that day's
free pool. Those historical settled-accounting totals differ from offered allowances,
future full-consumption estimates and a reconciled upstream invoice. The current smoke
must create no new usage receipt or supplier spend. No production limit changed here.

## Historical real-AI and infrastructure proof, 2026-10-15

The following observations preceded invitation-only admission and the public staging
pause. The old automatic 200,000-credit grant and real generation are **not** current
signup behavior or a default rerun instruction. Migration counts, sources and local
suite counts in this historical record describe those earlier snapshots; current
release/schema readiness belongs to #556/#661.

Production: https://femlab-app.web.app. Staging: https://femlab-app-staging.web.app.
Both APIs and authenticated ten-minute recovery jobs run in Frankfurt, with separate
SQL credentials, private export buckets and supplier caps. Runtime users have neither
superuser membership nor DDL/financial mutation rights. All eight migrations are applied.

A disposable staging email action link was generated through the privileged Auth API
without sending email. The Chromium test completed the real email-link exchange and
verified the account received 200,000 free credits. It acknowledged the AI data flow,
received an actual OpenAI answer through the deployed completion stream and observed
an authoritative credit debit. A second request created `live_box` through the typed
registry Script host. Logout cleared chats and credentials from the UI while preserving
the local Model. Desktop and 390-pixel account screenshots were inspected.

The test then verified Firebase's public user-deletion API was blocked, queued an
owner-only export, ran the real recovery job, downloaded the signed private JSON and
checked owner identity and usage records. It requested deletion with recent original
sign-in, ran recovery, and confirmed the old token no longer accessed the account.
This exercises actual workload identity signing, storage/SQL permissions and identity
removal; Stripe cancellation is fixture-tested because live billing is unavailable.

A separate production disposable account verified the live `/chat/completions` alias,
the 200,000-credit free grant and disabled billing. An actual Mini response reported
18 input and 5 output tokens, charged exactly 48 credits, and delivered its confirmed
receipt before completion. Production recovery deleted the fixture and its old token
received HTTP 401. This check did not send email or charge a payment method.

Two direct Cloud Run streams ran for 69.884 and 70.063 seconds, each reaching the
16,000-output-token ceiling with 69 input tokens and a confirmed 96,069-credit debit.
The disposable staging account received a clearly marked QA grant for this ceiling
test; no paid entitlement or customer grant was changed. A separate client-disconnect
check canceled after four text deltas. Its request settled once from actual provider
usage (3,205 output tokens), with no generation retry. Cancellation does not mean zero
usage; unconfirmed recovery remains covered by the PostgreSQL service fixtures.
Both staging fixtures were deleted through the durable backend path afterwards.

Backup `1792019512295` (2026-10-14 23:11:52 UTC) was restored into the isolated
`femlab-restore-557` instance after creating a disposable clone. Restore operation
`24cb8979-076b-448f-a696-6d630000002e` completed at 23:48:57 UTC. All eight migration
names survived. SHA-256 comparisons of the immutable records before the backup cutoff
matched the source: three grants, five debit entries and six usage receipts. There are
no live paid periods to test while Stripe is disabled. Both runtime roles retained their
restricted membership, and an attempted financial-row mutation was rejected by the
restored trigger. The test instance and its owned proxy were removed after verification.
This is a SQL restore check; paid disaster recovery must also reconcile Stripe's state
before reopening admissions once live billing exists.

The release script now probes a tagged API candidate at zero traffic, executes recovery
and configures Scheduler before promoting traffic. An intentionally unhealthy staging
candidate failed startup while the healthy API stayed ready. Restoring the valid template
then allowed a traffic switch to the previous healthy revision and back. Both healthy
revisions used the current pinned image: this proves traffic rollback mechanics, not
arbitrary old-code compatibility. The first pre-health image failed the public health
probe with 404 and was not accepted as a rollback target. No database down-migration ran.

The full expanded 134-function catalogue counted at 95,215 input tokens before a user
prompt. Simply retaining JSON Schema references still counted at 91,854. The hosted
transport now exposes concise Query/file/validation tools and the existing typed Script
surface for every engineering/view Command and Journal comparison. Its 37 tool schemas
counted at 8,948 tokens. No capability is removed from the registry; account/billing/key
and consent operations remain explicitly forbidden in Assistant scripts.

Local verification: registry 126 tests with 100% coverage; app 1,199 tests plus a compact
catalogue regression, existing coverage/typecheck gates; service 92 tests on PostgreSQL 17.
Chromium checks cover production anonymous/login boundaries and the toolbar at every
supported desktop width. CI preserves generated thumbnails when rebuilding the explicit
local supplier-fixture host. No supplier/database credential appears in browser output.

## Run the staging smoke

Generate two fresh disposable `@example.invalid` email action links for each run. The local
JSON files contain `link` and `email`, must be mode 0600, and are never committed. Use
two distinct disposable addresses to verify ownership between real accounts. Configure:

```sh
FEMLAB_LIVE_ORIGIN=https://femlab-app-staging.web.app \
FEMLAB_LIVE_API_ORIGIN=https://femlab-api-dhphcl4vma-ey.a.run.app \
FEMLAB_LIVE_GOOGLE_ACCOUNT=<authorized-Google-account> \
FEMLAB_LIVE_LOGIN_PATH=<private-local-action-link-json> \
FEMLAB_LIVE_OTHER_LOGIN_PATH=<second-private-local-action-link-json> \
npm exec -w packages/app -- playwright test --config=playwright.live.config.ts
```

The test is staging-only, requires two disposable addresses, disables traces/video and
automatic retries, and never prints an ID token, auth link or signed export URL. It sends
no real email, generates no AI and creates no Stripe charge. The real recovery job builds
both exports and durably deletes both identities; each old token must then receive 401.
Success removes both private input files and the mode-0600 cleanup state file created
beside the first. On failure, keep those private files for owned fixture cleanup; never
commit or attach them. Do not blindly rerun consumed links. It never deletes an owner
account. Its sanitized proof attachment records current policy separately from the
historical real-AI evidence above.

### Current invocation proof

On 15 October 2026 at 18:12 UTC, the command above ran against the deployed staging app
and API with two fresh private action-link fixtures: **1 passed in 1.2 minutes**. The
app typecheck and Playwright test discovery passed first. Both real Firebase exchanges
created zero-credit accounts; reload and refresh retained the same account IDs and zero
allowance. The UI completion and `/chat/completions` alias both returned HTTP 503 /
`ai-unavailable`, without SSE. Owner exports contained zero request rows, grants, debits,
holds and receipts after those attempts, so this run produced no metered supplier work.

Anonymous export returned 401; cross-owner body selectors returned 422 and query
selectors 404. Both legitimate exports contained only their authenticated owner's
identity, and unsigned object requests returned 403. Public Firebase identity deletion
was explicitly blocked with `ADMIN_ONLY_OPERATION`. The 390px zero-credit account
screenshot was inspected. UI Sign out cleared account/chat state and preserved the
local Model. Recovery durably deleted both accounts; both old tokens returned 401.
Both input fixtures and the private token-state file were confirmed removed.

Sanitized evidence, containing no identity, token, action link or signed URL, is retained
outside the repository at `/tmp/femlab-staging-zero-signup-557-evidence.json`, bound to
the tested source SHA-256. The private execution log is separate. This proves the
current paused-staging policy, not inbox delivery, owner Google consent-return, new
real-AI answer quality or live billing.

## Remaining release gates

- Publish and verify the #696 Google CSP correction, then complete an owner-authorized
  chooser/consent return. Enabled providers and redirect-start acceptance alone are
  insufficient. Verify actual email inbox delivery separately.
- Finish live Managed Payments terms/eligibility and billing activation in #661, with
  current policies, tax coverage, paid controls, canonical live invoice/webhook authority
  and owned cancellation/payment management. TEST success is not live-payment proof.
- Keep staging AI disabled. Any new real supplier QA needs the explicit isolated,
  bounded procedure in #669; this smoke cannot open that window. Final-domain TLS,
  the 227-second stream, cancellation, SQL restore and traffic rollback already have
  dated evidence; do not list those completed checks as unresolved DNS gates.
- Coordinate the broader engineering-answer live evaluation with #297's owner; this smoke
  verifies transport, authority, accounting and a real registry action, not numerical
  answer quality or a new physics Benchmark.
