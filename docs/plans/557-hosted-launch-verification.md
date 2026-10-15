# Hosted AI release evidence

Tracks [#557](https://github.com/andeplane/fem-lab/issues/557), following
[the backend plan](545-ai-backend.md) and infrastructure [#563](563-google-infrastructure.md).

## Current release policy and evidence, 2026-10-15

Production is https://femlab.app, with https://femlab-app.web.app retained as an alias.
Staging is https://femlab-app-staging.web.app. DNS and normally validated TLS are active;
the final API is https://api.femlab.app. [#600](600-domain-routing.md) records the real
227.451-second final-proxy stream, immutable receipt, idempotent replay, cancellation
settlement and disposable-account deletion. Its automatic free grant was historical,
before reviewed free admission; the transport proof remains useful.

Both frontends, APIs and recovery jobs now run source
`6c5d4daaf46d59fd68aca725c4b8074b06acf2a8`. Both APIs were healthy at 100% traffic and both
recovery executions succeeded. Migration 010 and version 1 of the server-only eligibility
fingerprint key are installed in both environments. Anonymous monthly-claim requests
returned 401. Runtime evidence is `/tmp/femlab-712-runtime-release.json`; these deployment
and migration observations are distinct from the authenticated claim acceptance below.
The combined candidate passed 1,375 app tests (five skipped), coverage for all 93 app
modules, all 143 registry tests at 100% coverage, 246 real-PostgreSQL service tests,
service build and 27 Stripe/11 Google guards. It uses its matching release-wasm engine
baseline; the separate debug-wasm STL issue [#716](https://github.com/andeplane/fem-lab/issues/716)
is not described as fixed by this release. Both frontend secret scans passed for 74 files.

Under [#712](712-free-monthly-allowance.md), creating or reopening an account still
grants **zero** AI credits. Free monthly access requires explicit operator-reviewed
eligibility and an explicit authenticated claim for each UTC calendar month. Approved
free accounts can claim 6,666,666 weighted credits, approximately $5 of supplier-accounting
value. Credits expire at 00:00 UTC on the first of the next month without rollover,
including a late-month claim. Reviewed-person, approved-alias and immutable claim markers
prevent an additional claim through account recreation. Revocation and paid/free
exclusion are enforced by the backend; Google/email verification alone does not establish
a unique person. The former invited one-time 200,000-credit preview from
[#645](645-free-ai-admission.md) is historical: existing grants retain their recorded
expiry, do not renew and cannot stack with monthly access or bypass its revocation.
Canonical paid invoices remain the paid-credit authority; a browser return cannot grant
an entitlement. The default staging smoke changes no eligibility, budgets or subscription.

Public staging remains deliberately [AI-disabled](669-staging-spend-defaults.md), with
all supplier-spend caps zero, including for existing test-paid accounts. New completions
must return HTTP 503 / `ai-unavailable` before input counting or an AI request row is
created. The current smoke verifies zero signup allowance, rejected unapproved monthly
claims, reopen/refresh stability, denied UI and alias admissions, empty request/credit/
receipt exports, UI logout preserving the local Model, cross-owner export selectors
rejected, private export downloads and durable deletion of two disposable identities.
Signed export URLs are short-lived bearer capabilities: someone given the valid URL can
download it. Ownership is enforced when authenticated APIs select and request records;
the smoke does not mistake an operator-shared signed URL for an ownership failure.

### Actual production owner acceptance

On 15 October 2026 at 19:22:42 UTC, a fresh real production email link completed through
the normal public Identity Toolkit REST exchange. The existing owner identity/account
matched, `isNewUser` was false, and `email_verified` was true. No Admin-token injection
or replacement identity was used. This is a successful real email-link REST exchange,
**not** evidence of a successful positive browser email-link return.

The approved owner's public monthly-claim call returned 6,666,666 credits with
`replay: false`; a repeat returned `replay: true`. A real Mini completion used 40 input
and 12 output tokens and charged exactly 112 credits. Replaying that completion returned
the same confirmed receipt. SQL showed exactly one monthly grant, one request, one receipt
and zero active holds. The remaining allowance was 6,666,554 credits. The legitimate owner
account was preserved, with no Checkout or live payment. Sanitized evidence is
`/tmp/femlab-712-owner-acceptance.json`; it records deployed source `6c5d4daa` and separates
claim/receipt replay from new generation. This bounded production acceptance was performed
separately from the no-generation staging smoke below.

### Sign-in and delivery boundaries

Both Google providers are enabled; configuration evidence is recorded in
[#616](616-google-sign-in.md). Frontend source
`1b008badd2868dc27b242919952fbbe34ae12730` first published the
[#696](https://github.com/andeplane/fem-lab/issues/696) Auth helper and
[#704](https://github.com/andeplane/fem-lab/issues/704) root-cache corrections to both
origins. Native Chrome owner checks completed Google's actual chooser, basic-identity
consent, Firebase callback and authenticated Account UI in both production and staging,
then showing free total/available/reserved credits 0/0/0. No AI, Checkout, payment or owner
deletion occurred in those sign-in checks. Google sign-in is usable; these actual owner
returns are distinct from provider configuration and cancel/retry checks.

A further native Chrome check at current source `6c5d4daa` used a fresh tab in the
existing profile and a normal Google redirect with existing authorization. The owner
Account UI visibly showed 6,666,554 available of 6,666,666, zero reserved, the monthly
allowance already claimed, and disabled claim/purchase controls. No identity was
injected, browser data cleared, claim repeated or AI request made. The original blank
tab was preserved; this observation establishes the current rendered owner balance,
not a universal cause or source fix for that tab's visual problem. Evidence is
`/tmp/femlab-native-owner-account-721.json` and `.png`, recorded separately under
[#721](https://github.com/andeplane/fem-lab/issues/721). It remains a Google sign-in
check and does not establish positive browser email-link completion.

After the current `6c5d4daa` publication, actual published Google start/cancel/return/retry
checks passed again on both origins without a candidate overlay, preserving the local
Model. Evidence is `/tmp/femlab-google-stage-published-712.json` and
`/tmp/femlab-google-prod-published-712.json`. Root documents use no-cache, Auth helper
responses no-store and hashed assets immutable caching; strict isolation/security headers
remain. A read-only Google Cloud Console check found both OAuth audiences External and
In production, with empty sensitive/restricted declared-scope tables. Basic identity scopes
remain unchanged. The generic Gemini-key banner did not identify a FEM issue: neither
project enabled `generativelanguage`, and Firebase public-key API allowlists excluded it.

Real production email messages arrived, with the first receipt taking one second and
passing SPF/DKIM, but Gmail placed both the first message and a fresh 19:22 message in
**Spam**, not Inbox. The fresh message supplied the successful public REST exchange
above. Positive browser email-link completion remains unverified under
[#720](https://github.com/andeplane/fem-lab/issues/720); invalid-code Chromium checks did
reach Firebase and return `INVALID_OOB_CODE` without an identity or Auth resource CSP
failure, which proves only the negative path. The earlier browser network failure does
not prove a product defect. [#710](https://github.com/andeplane/fem-lab/issues/710) tracks
custom-sender/deliverability work; Cloudflare's explicit terms/login step is still gated,
and no DNS, sender verification or sender activation is claimed. Mail evidence is
`/tmp/femlab-email-delivery-557.json`. Disposable Admin-generated links in the staging
smoke below prove exchange separately and did not send mail.

Managed Payments TEST lifecycle acceptance is recorded by activation
[#661](https://github.com/andeplane/fem-lab/issues/661). Live terms acceptance and billing
activation remain pending, and production billing is disabled. No actual live payment
has occurred. TEST success does not establish live charge or invoice authority.
[#695](695-seller-merchant-roles.md) distinguishes Hafreager as seller/product provider
from the merchant-of-record transaction role.

## Included usage and supplier accounting

The deployed `6c5d4daa` catalog uses [tariff `2026-10-14.v1`](https://github.com/andeplane/fem-lab/blob/6c5d4daaf46d59fd68aca725c4b8074b06acf2a8/packages/service/src/credits.ts):
one credit is 30 subcredits and `supplierMicros` rounds `subcredits / 40` upward.
Thus one million weighted credits have a nominal supplier-accounting value of $0.75.
These are catalog-derived estimates, not a fresh model-price lookup or supplier invoice.

| Current offer | USD list price / paid month | Weighted credits | Supplier equivalent at full use | Price / nominal supplier value |
|---|---:|---:|---:|---:|
| Reviewed free monthly | $0, explicit claim | 6,666,666 | approximately $5.00 | n/a |
| Plus | $49 | 10,000,000 | $7.50 | 6.53× |
| Pro | $149 | 16,000,000 | $12.00 | 12.42× |
| Studio | $499 | 50,000,000 | $37.50 | 13.31× |

[#709](709-monthly-ai-allowance.md) changed Plus from 4M to 10M without changing its $49
price. All six existing Plus provider Products (direct/personal/business in TEST and LIVE)
now have matching 10M descriptions/metadata, confirmed at 19:15:17 UTC in
`/tmp/femlab-709-provider-catalog.json`. Runtime and frontend publication use `6c5d4daa`.
This verifies the deployed offer and catalog sync; it does not claim a newly paid live
10M grant while billing is disabled. Pro and Studio are unchanged. The earlier deployed
`dc1bcb47` snapshot at 17:57:26 UTC had Plus 4M/$3.00 nominal supplier value (16.33×
list-price/value) and an invited one-time 200k/$0.15 preview. Those dated historical
offers are superseded and are not current signup or monthly benefits.

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

The current release retains production shared supplier limits of $100/day, $1,000/month,
$10 unresolved exposure and concurrency 16. The reviewed-free pool is now $10/day and
$50/month, with at most ten fully funded principal-months at the current tariff. These
are shared admission limits, not additional per-account credits or uninterrupted-use
guarantees; approved claims and requests can pause when limits are reached. Staging's
supplier caps remain zero. Approval is operator-reviewed, not automatic account signup.

The earlier 17:57:26 UTC snapshot, before this free-policy change, had a $1/day free
pool and no active holds. Receipt-derived settled accounting then was $0.894551 for
the UTC day, $0.894587 for the UTC month, and $0.012010 for that day's free pool. Those
historical totals are distinct from current caps, future full-consumption estimates and
a reconciled upstream invoice. The later owner acceptance's 112-credit receipt has
3,360 subcredits, nominal supplier accounting of $0.000084 under this tariff; it does not
update or replace that earlier snapshot. The default staging smoke creates no new usage
receipt or supplier spend. This verification slice itself changes no production limit.

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

### Dated staging smoke executions

On 15 October 2026 at 18:12 UTC, before the monthly allowance and later Auth/cache changes,
the command above ran against the deployed staging app and API with two fresh private
action-link fixtures: **1 passed in 1.2 minutes**. The
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
the tested source SHA-256 and commit `f75da285`. The private execution log is separate.
That historical result is retained without attributing later monthly assertions to it.

On 15 October 2026 at 19:32:41 UTC, the updated staging smoke at verification source
`afa5cd9520967cedbcfc51b1ec49657b6bbdf0de` ran once against the actual published
`6c5d4daa` frontend/API: **1 passed in 59.2 seconds**. Exactly two fresh return-only
Admin-generated `@example.invalid` links completed actual Firebase browser email-link
exchanges. Neither sent email. Both profiles began at zero credits and `review-required`;
explicit unapproved monthly claims returned 403 / `eligibility-required`. Reload and
refresh preserved identity, zero balance and review status. The current monthly copy
and disabled claim control were visible and inspected at 390px.

Both UI and alias completion admissions returned 503 / `ai-unavailable`, with no SSE
or request/grant/debit/hold/receipt rows in either authenticated export. Anonymous and
cross-owner selector denials, unsigned-storage denial, blocked public Firebase deletion,
logout clearing chat/account state while preserving the Model, durable deletion and
both old-token 401s passed again. Both private link JSONs and cleanup-token state were
confirmed absent after success. No eligibility, credits, email, supplier work, payment,
spend-cap change or owner-account action was created by this run; staging stayed paused.

Sanitized evidence is `/tmp/femlab-staging-monthly-zero-signup-557-evidence.json`, bound
to the exact tested source and test SHA-256. This proves the current disposable staging
browser flow and monthly denial, separately from the production owner REST exchange
and real Mini debit/replay above. It does not prove positive genuine owner email delivery
through the browser, live billing or engineering-answer quality.

The tested source passed `npm run typecheck -w packages/app` and
`npm exec -w packages/app -- playwright test --config=playwright.live.config.ts --list`
on 15 October 2026 (one test discovered), plus `git diff --check`. No new fixture,
supplier generation or deployment was triggered by the final documentation update;
the separately authorized two-fixture rerun is recorded immediately above.
The sanitized combined rollup is `/tmp/femlab-release-557-evidence.json`; it keeps
the dated staging source, current deployed source and final verification-source
commit separate, with no identity, credentials, action link or export URL.

## Remaining release gates

- Resolve production email Spam placement/custom-sender deliverability in #710, then
  verify actual Inbox delivery. Receipt and SPF/DKIM checks passed; Google's owner
  chooser/consent return is already verified on both environments.
- Complete a genuine positive email-link return in the browser under #720. The real
  public REST exchange and browser invalid-code path are verified separately and do
  not substitute for that positive browser return.
- Finish live Managed Payments terms/eligibility and billing activation in #661, with
  current policies, tax coverage, paid controls, canonical live invoice/webhook authority
  and owned cancellation/payment management. TEST success is not live-payment proof.
- Keep staging AI disabled. Any new real supplier QA needs the explicit isolated,
  bounded procedure in #669; this smoke cannot open that window. Final-domain TLS,
  the 227-second stream, cancellation, SQL restore and traffic rollback already have
  dated evidence; do not list those completed checks as unresolved DNS gates.
- Coordinate the broader engineering-answer live evaluation with #297's owner. The
  dated real-AI/registry proof and current owner claim/112-credit request verify transport,
  authority and accounting, not numerical answer quality or a new physics Benchmark.
