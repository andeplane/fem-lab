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

The latest published API source is `fe94e445` and frontend source is `b18c37a5` in
both environments, adding the public credit unit described below. At 20:18:28 UTC,
both published pages/assets/sign-in hosts returned 200 with the intended cache policy,
and headless Chromium Google start/cancel/return/retry preserved the local Model on
both origins. The existing-owner native check at the new unit display has not been
repeated because the Mac is locked; it is not claimed as a new screenshot or sign-in.

The reviewed-monthly release used source
`6c5d4daaf46d59fd68aca725c4b8074b06acf2a8` for both frontends, APIs and recovery jobs.
At that release both APIs were healthy at 100% traffic and both recovery executions
succeeded. Migration 010 and version 1 of the server-only eligibility
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
free accounts can claim an advertised 5,000 public AI credits, approximately $5 of
supplier-accounting value. The existing exact allocation remains 199,999,980 internal
subcredits (formerly 6,666,666 weighted credits); public-unit responses preserve
4,999.9995 credits and the UI displays 5,000. The later unit release below changes no
allowance purchasing power or ledger row. Credits expire at 00:00 UTC on the first of
the next month without rollover,
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
or replacement identity was used. This records the public REST exchange separately
from the later native browser completion below.

Amounts in this 19:22 snapshot use legacy weighted-credit units. The approved owner's
public monthly-claim call returned 6,666,666 credits with
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

A further native Chrome check at the then-published source `6c5d4daa` used a fresh tab in the
existing profile and a normal Google redirect with existing authorization. The owner
Account UI visibly showed 6,666,554 available of 6,666,666, zero reserved, the monthly
allowance already claimed, and disabled claim/purchase controls. No identity was
injected, browser data cleared, claim repeated or AI request made. The original blank
tab was preserved; this observation establishes that release's rendered owner balance,
not a universal cause or source fix for that tab's visual problem. Evidence is
`/tmp/femlab-native-owner-account-721.json` and `.png`, recorded separately under
[#721](https://github.com/andeplane/fem-lab/issues/721). This observation records
Google sign-in; native email-link completion is recorded separately below.

After the `6c5d4daa` publication, actual published Google start/cancel/return/retry
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
above. A separate actual native Chrome email-link flow completed successfully under
[#720](https://github.com/andeplane/fem-lab/issues/720). One fresh UI request was made
on 15 October 2026 at **19:31:53 UTC**; its message arrived at **19:31:57 UTC** in Spam,
with SPF/DKIM passing. Opening that exact newly requested Firebase action helper in the
same request tab completed through the normal Firebase SDK and returned to a clean
`https://femlab.app/` URL and isolated engine. The authenticated Account UI showed the
existing owner's 6,666,554 available of 6,666,666, zero reserved and already-claimed
monthly allowance. No identity/token injection, new claim, AI request or payment was
made. The working Google tab, original blank production tab, staging and local projects
were preserved. Native accessibility evidence is
`/tmp/femlab-native-owner-email-720.json`; screenshot capture after successful verification
was blocked by the Mac lock, so no email-flow screenshot is claimed. The private action
link/handoff file was removed. This completes the positive browser email-return check.

Earlier invalid-code Chromium checks reached Firebase and returned `INVALID_OOB_CODE`
without an identity or Auth resource CSP failure; they remain negative-path evidence.
The earlier browser network failure did not establish a product defect.
[#710](https://github.com/andeplane/fem-lab/issues/710) tracks
custom-sender/deliverability work. Four sender records were subsequently added in
Cloudflare and verified on both authoritative nameservers, preserving the original
six records and hosting/API DNS. At 20:13:33 UTC Firebase still reported the custom
domain `IN_PROGRESS` and sender method `DEFAULT`; Apply had not run and no post-change
message was sent. `/tmp/femlab-sender-domain-710.json` records that intermediate state.
DNS publication is complete; provider activation and Inbox delivery remain unverified.
Mail evidence is
`/tmp/femlab-email-delivery-557.json`. Disposable Admin-generated links in the staging
smoke below prove exchange separately and did not send mail.

### Live subscription activation and unpaid Checkout

Under [#661](https://github.com/andeplane/fem-lab/issues/661), owner-approved live
Managed Payments terms/eligibility and subscription activation completed. The 19:47 UTC
production release exited successfully with image source `6c5d4daa`, activation config
`da7291a2` and API revision `femlab-api-rec9d6678-57d285f5`. Billing became available in
managed mode. TEST lifecycle acceptance remains separately recorded by #661.

A genuine existing-owner public-API Checkout check at 19:49:34 UTC created one LIVE
Plus personal Session and its public retry reused that Session. Stripe readback showed
Managed Payments enabled, automatic tax complete, and liability/provider `stripe`.
The hosted page showed USD 49 plus USD 12.25 Norway VAT, USD 61.25 total. No card details
were entered, the terms checkbox was not checked and Subscribe was not submitted.
The Session was deliberately expired and verified at 19:56:35 UTC as expired/unpaid,
with null subscription and PaymentIntent, zero owner subscriptions, zero paid grants
and zero active holds. The existing monthly allowance/account stayed unchanged.
Evidence is `/tmp/femlab-661-live-checkout-evidence.json`; the hosted screenshot is
`/tmp/femlab-live-unpaid-checkout-661.png`. This is real live Checkout/tax/idempotency
proof, with no actual live payment or paid-invoice grant claimed. Canonical paid invoice
and webhook authority remain the only route to a paid entitlement.
[#695](695-seller-merchant-roles.md) distinguishes Hafreager as seller/product provider
from the merchant-of-record transaction role.

## Included usage and supplier accounting

[#728](728-credit-scale.md) introduces public unit `usd-milli-v1`: one AI credit is
USD 0.001 of supplier/model usage. The unit-aware API source
`fe94e445b00424cdf3f2ea58d02b3779a2f0c512` released successfully to production and staging;
release manifests are `/tmp/femlab-app-release-563.json` and
`/tmp/femlab-app-staging-release-563.json`. Unit-aware clients send
`X-Femlab-Credit-Unit: usd-milli-v1`; old clients retain their legacy numeric contract.
Responses carry the unit marker. Balances/receipts read exact immutable subcredits,
not an already truncated legacy display. One public credit is 40,000 internal subcredits;
there is no per-request rounding, new grant or history/budget change. UI formatting
uses at most two decimal places.

Independent Cloud Run readback at 20:19:56 UTC confirmed both new API revisions ready
with 100% traffic. Production retained billing enabled/live/managed/automatic-tax;
staging retained billing enabled/test/managed/automatic-tax, while staging supplier
caps remained zero. `/tmp/femlab-728-runtime-readback.json` records those runtime facts.
The hosting helper's older hardcoded disabled-billing summary was misleading text,
tracked separately in #737; it did not disable the actual service.

| Current offer | USD list price / paid month | Advertised public AI credits | Supplier equivalent at full use | Price / nominal supplier value |
|---|---:|---:|---:|---:|
| Reviewed free monthly | $0, explicit claim | 5,000 | approximately $5.00 | n/a |
| Plus | $49 | 7,500 | $7.50 | 6.53× |
| Pro | $149 | 12,000 | $12.00 | 12.42× |
| Studio | $499 | 37,500 | $37.50 | 13.31× |

All 18 existing provider Products (three plans × direct/personal/business × TEST/LIVE)
were synced at 20:13:00 UTC to the new descriptions, allowance quantities and explicit
`usd-milli-v1` metadata. Product/Price identities, price amounts and tax classifications
were preserved; no payments were created. Evidence is `/tmp/femlab-728-provider-catalog.json`.
Frontend source `b18c37a5d0b62cfe7f6954b8e69780fe516d0476` was then published to both
sites. At 20:18:28 UTC production served `index-DdPWQvkF.js` and staging
`index-DkhnJjf3.js`; root, asset and sign-in requests returned 200 with root no-cache,
assets immutable and sign-in no-store. Actual published Chromium Google start/cancel/
return/retry and Model preservation passed on both origins; owner authentication was
not rerun for that check. Evidence is `/tmp/femlab-728-published-release.json`.

Read-only production SQL at 20:18:05 UTC confirmed the same 199,999,980 total and
199,996,620 available subcredits, one eligibility/monthly grant, zero paid grants and
zero holds. Those exact values convert to 4,999.9995 total and 4,999.9155 available
public credits, displayed as 5,000 and 4,999.92. No ledger adjustment or new funding
was applied. Eligibility tables remain SELECT-only for both runtime roles, and budgets
retain their recorded values. `/tmp/femlab-728-production-balance.json` contains that
SQL proof; numeric conversion follows the committed public-unit contract. Native
owner UI verification of the new display remains unavailable while the Mac is locked;
the earlier Google/email owner screenshots/accessibility checks retain their original
legacy-unit context. This update includes no new owner-unit screenshot, claim, supplier
request or paid transaction.

The previous `6c5d4daa` offer used 6,666,666/10M/16M/50M legacy weighted credits for
reviewed-free/Plus/Pro/Studio. Those amounts have the same purchasing power as the current
public unit. [#709](709-monthly-ai-allowance.md) had already increased Plus from 4M to 10M
without changing its USD 49 price; its six-Product sync at 19:15:17 UTC remains dated in
`/tmp/femlab-709-provider-catalog.json`. The earlier `dc1bcb47` snapshot at 17:57:26 UTC
had Plus 4M/USD 3.00 nominal supplier value (16.33× list-price/value) and a one-time invited
200k/USD 0.15 preview. Historical grants retain their original exact amount and expiry;
the unit release does not regrant, increase or renew them.

The immutable [tariff `2026-10-14.v1`](https://github.com/andeplane/fem-lab/blob/fe94e445b00424cdf3f2ea58d02b3779a2f0c512/packages/service/src/credits.ts)
uses 30 internal subcredits per legacy weighted credit and rounds `subcredits/40` upward
for supplier USD microdollar accounting. Mini's raw rates remain 30 per uncached input,
3 per cache-read input and 180 per output token including reasoning. Astra uses 400/40/
2,000 respectively and 500 per cache-write input. Public unit conversion changes none
of those tariffs. Allowances account for model cost rather than a fixed raw-token count;
history, tools and provider-metered context consume usage too. Context ceilings remain
64,000 free/128,000 paid, with output ceilings 4,096 free/8,192 Plus/16,000 Pro and Studio.
There is no automatic overage or rollover. Catalog equivalents are not a fresh model
price lookup or supplier invoice.

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
a reconciled upstream invoice. The later owner acceptance's 112-legacy-credit receipt
has 3,360 subcredits, equal to 0.084 public credits and nominal supplier accounting of
$0.000084 under this tariff; it does not
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

The private-project check also cancels its signed-in worker after an acknowledged edit, verifies the recovered Model and original browser project identity, and waits for that edit to reach the same single cloud project. All credit, isolation, export and deletion assertions remain in place.

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
to the exact tested source and test SHA-256. This proves the dated disposable staging
browser flow and monthly denial at the legacy-unit release, separately from the
production owner REST exchange
and real Mini debit/replay above. It does not prove positive genuine owner email delivery
through the browser, live billing or engineering-answer quality.

The prepared smoke now explicitly requests `usd-milli-v1` for direct API calls and
expects the exact preserved monthly allocation 4,999.9995 plus the unit marker, matching
the new browser profile. The revised contract has not been rerun with fresh fixtures;
the 19:32 test remains bound to its actual legacy-unit source.

The updated verification source passed `npm run typecheck -w packages/app` and
`npm exec -w packages/app -- playwright test --config=playwright.live.config.ts --list`
on 15 October 2026 (one test discovered), plus `git diff --check`. No new fixture,
supplier generation or deployment was triggered by the final documentation update;
the separately authorized two-fixture rerun is recorded immediately above.
The sanitized combined rollup is `/tmp/femlab-release-557-evidence.json`; it keeps
the dated staging source, current deployed source and final verification-source
commit separate, with no identity, credentials, action link or export URL.

### Current-unit staging acceptance, 16 October 2026

At 13:01 UTC the current three-file verification slice passed against the actual staging
origins: **1 passed in 47.7 seconds**. The API reported ready revision
`femlab-api-re31c2aa4-f5ec22ef`; this is a runtime identity, not a claim that the current
PR source is deployed. A read-only SQL preflight confirmed AI disabled with every global
spending limit zero. Two fresh return-only Admin links completed real browser email-link
sign-in without sending email.

Both accounts retained zero signup/reopen credits and `review-required` status. Direct
requests negotiated `usd-milli-v1`; profiles returned the exact 4,999.9995 monthly
allocation. Unapproved claims returned 403 and the claim control stayed disabled. UI
and alias completion admissions returned 503 before generation; owned exports contained
no requests, grants, debits, holds or usage receipts. Anonymous/cross-owner export denials,
private unsigned objects, blocked public identity deletion, logout preserving the Model
and durable deletion with both old tokens returning 401 all passed. Both private action
fixtures and cleanup-token state were removed. The 390px account view was inspected.

The first fresh attempt exposed a stale test selector (`Your AI allowance` after the
account heading became `Your account`). Its cleanup completed and both revoked tokens
were independently checked before fresh fixtures were generated. The corrected run also
fails on uncaught errors in either account's browser page. No email, eligibility change,
credits, supplier generation, payment, budget change or deployment occurred.

Sanitized current proof, bound to the test source SHA-256, is retained at
`/Users/anderhaf/.codex/tmp/fem-lab-triage-802/599-current-staging-evidence.json`.
Earlier dated evidence remains separate. Production sender verification in #710 still
reports `IN_PROGRESS`; post-apply Inbox delivery remains unverified.

### Account-partitioned staging acceptance, 17 October 2026

At 23:15 UTC on 16 October (01:15 Oslo on 17 October), the revised smoke passed
against the deployed staging client: **1 passed in 60.0 seconds** (61.6 seconds
including the runner). Its test SHA-256 is
`1a722a18c2c7bb54699b6546a11c295c59aa2d37dab3b2c2bca6a9c56e860705`.
The mini-built client source was `bad659e25b17271f48059726fb4d38bfc182a314`,
Hosting release `1792192244673000`; the API remained
`femlab-api-re31c2aa4-f5ec22ef`. The published HTML matched the verified artifact.

The cloud client in #775 changes sign-out intentionally: private account Models and
project lists disappear, while anonymous browser work remains recoverable. The smoke
saved an anonymous boxed Model before login, created a distinct private project after
authentication and waited for actual cloud sync. Sign-out hid the private Model/project;
reopening the anonymous project recovered its original Model and body. Owned exports
included the private project only for its owner. Earlier dated runs predate this client
and do not establish that boundary.

A read-only SQL preflight again verified AI disabled and all monetary caps zero. Both
fresh disposable email-link SDK sessions retained zero credits and review-required
eligibility; unapproved monthly claims were denied, AI admissions returned 503 without
generation, exports stayed private and both identities were durably deleted. Both old
tokens returned 401. Private action-link and cleanup-state files were removed. The
390px account view was inspected. No email, AI generation, credit grant or payment occurred.

The first attempt encountered the intentionally expired anonymous session while
Firebase restored its owner during reload. Its two disposable identities were deleted;
both still-unexpired tokens were independently rejected before new fixtures were made.
The test now retries only explicit session-expired/transitioning errors during account
polling. Persistent expiry still times out; all other errors and uncaught page errors
remain fatal. Types and test discovery passed on the mini before the deployed rerun.

Source-bound sanitized evidence is retained at
`/Users/anderhaf/.codex/tmp/fem-lab-triage-802/599-partition-staging-evidence.json`.
This establishes staging behavior with disposable accounts. #775's production owned-account
browser acceptance and #710's actual sender delivery remain separate release gates.


### Current project-sync client acceptance, 17 October 2026

At 00:19:53 UTC (02:19 Oslo), the same smoke passed again against client source
`17823a0a8a9807097f312537bab7c2599d88bdb8`, Hosting release
`1792196250720000`, with the API still at `femlab-api-re31c2aa4-f5ec22ef`.
The runner completed in 59.9 seconds. The clean verification source was
`b0a480a4fa945d120e148423e8c1c7c20f5a60da`; its test SHA-256 remains
`1a722a18c2c7bb54699b6546a11c295c59aa2d37dab3b2c2bca6a9c56e860705`.
This source includes the clean-checkout development fixture fix and the merged
frozen #297 evaluation, which the earlier staging build did not include.

Two fresh disposable SDK accounts passed the same private-project sync, isolation,
sign-out, anonymous recovery, owned export and durable-deletion assertions. Both
old tokens returned 401. AI remained disabled with every monetary cap at zero;
no email, generation, grant or payment occurred. Private fixture and token-state
files were removed, and the 390px account view was inspected.

Backend recovery logs independently confirm two completed exports at 00:19:24 UTC
and two completed deletions at 00:19:45 UTC, with zero pending or failed operations.
The following scheduled recovery at 00:20:12 UTC also reported zero pending or
failed operations. These logs establish completed identity cleanup in addition to
the API's rejection of old tokens.

Sanitized source-bound evidence is retained at
`/Users/anderhaf/.codex/tmp/fem-lab-triage-802/599-partition-staging-evidence-17823a0a.json`;
the corresponding cleanup audit is
`/Users/anderhaf/.codex/tmp/fem-lab-triage-802/599-partition-staging-backend-cleanup-17823a0a.json`
(SHA-256 `abc4181e5c66fd9727b9a88332339430c549019e433255f8f17745dbeb12eca0`).
Production owned-account acceptance and actual sender delivery remain separate gates.


### Reconnect correction staging acceptance, 17 October 2026

At 00:44:33 UTC (02:44 Oslo), the smoke passed against the corrected project-sync
client `6051922801e131cfaaf6fc303cf9fb152192ddb0`, Hosting release
`1792197773094000`. The runner completed in 65.3 seconds. Its clean verification
source was `1a37299e6a1e0f4c831fb2654af12dc43bd93234`; the test SHA-256 remains
`1a722a18c2c7bb54699b6546a11c295c59aa2d37dab3b2c2bca6a9c56e860705`.
The API remained `femlab-api-re31c2aa4-f5ec22ef`.

The client now reconciles a reconnect listing of its own committed upload when
that upload's exact receipt arrives. Newer remote edits still require conflict
resolution. A deterministic sync test failed before the correction and passed
after it; the companion newer-remote case, all 38 sync tests, the full app suite
and all three cloud browser cases also passed on home-mini.

The deployed smoke again passed private project sync, account isolation, anonymous
recovery, owned exports and durable deletion with two fresh disposable SDK accounts.
Both old tokens returned 401. Backend logs independently recorded two completed
exports at 00:44:02 UTC and two completed identity deletions at 00:44:27 UTC, with
zero pending or failed operations. Private fixtures and token state were removed;
the 390px account view was inspected. AI stayed disabled and every monetary cap
remained zero. No email, generation, credit grant or payment occurred.

Sanitized evidence is retained at
`/Users/anderhaf/.codex/tmp/fem-lab-triage-802/599-partition-staging-evidence-60519228.json`;
its cleanup audit is
`/Users/anderhaf/.codex/tmp/fem-lab-triage-802/599-partition-staging-backend-cleanup-60519228.json`.
This is staging acceptance. Production owned-account browser verification and actual
custom-sender delivery remain outstanding.


### Cancellation recovery staging acceptance, 17 October 2026

At 02:05:10 UTC (04:05 Oslo), the expanded smoke passed against project-sync
client `08805e85f81041f7dcd62db0d930c3b3be11ea05`, Hosting release
`1792202636820000`, with a 56.7-second runner. Clean verification source:
`b7021d7c6f38ee1a46f27966172d03503c423cf9`; test SHA-256:
`0660f26eb3c10f0bd068e990d1dcee166a4e333f4b325138686b4c4c98c82265`.
The API remained `femlab-api-re31c2aa4-f5ec22ef`.

The signed-in test acknowledged an unsaved Model edit, cancelled the worker,
verified the recovered Model and original browser project identity, then confirmed
that its revision advanced in the same single cloud project. Private sync, logout
isolation, anonymous recovery, owner exports and durable deletion also passed with
two fresh disposable SDK accounts. Both old tokens returned 401. Backend logs
independently recorded two completed exports at 02:04:43 UTC and two completed
identity deletions at 02:05:03 UTC, with zero pending or failed operations.

The fresh private fixtures and token state were removed. The 390px account view
was inspected. AI stayed disabled and every monetary cap remained zero. No email,
generation, credit grant or payment occurred. Separately, the same client passed
255 CPU Chromium cases (five intentional skips) and all four cloud Chromium cases
on home-mini, with retries disabled. Both public build archives include all 27
generated viewer thumbnails.

Sanitized source-bound evidence is retained at
`/Users/anderhaf/.codex/tmp/fem-lab-triage-802/599-partition-staging-evidence-08805e85.json`;
its independent cleanup audit is
`/Users/anderhaf/.codex/tmp/fem-lab-triage-802/599-partition-staging-backend-cleanup-08805e85.json`.
This is staging acceptance. Current exact-head GitHub validation, production
owned-account browser verification and actual custom-sender delivery remain
outstanding. Prior dated source-specific results above remain historical.

## Remaining release gates

- Resolve production email Spam placement/custom-sender deliverability in #710, then
  verify actual Inbox delivery. Receipt and SPF/DKIM checks passed; Google's owner
  chooser/consent return is already verified on both environments.
- Complete #775's production owned-account browser acceptance; the new staging
  result above does not substitute for that check.
- Complete required exact-head CI and review for the final three-file verification
  source. Recorded deployed acceptance is separate from that source gate.

Staging AI stays disabled. Any future real supplier QA needs the explicit isolated,
bounded procedure in #669; this smoke cannot open that window. Final-domain TLS, the
227-second stream, cancellation, SQL restore and traffic rollback have dated evidence.
The separate engineering-answer evaluation in #297 is now merged. Its frozen
Sol 6.1 run completed twenty cases on both real hosts with 18/20 passing per host;
the four catalogue-completeness failures remain scored and tracked in #793. See the
[dated evaluation report](../evaluations/assistant-20-problems-results-2026-10-16.md).
These account-flow checks do not extend that CPU/direct-provider result to every
model or engineering task, and they do not establish a new physics Benchmark.
