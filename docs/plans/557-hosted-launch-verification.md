# Hosted AI release evidence

Tracks [#557](https://github.com/andeplane/fem-lab/issues/557), following
[the backend plan](545-ai-backend.md) and infrastructure [#563](563-google-infrastructure.md).

## Verified on Google, 2026-10-15

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

Generate a fresh disposable `@example.invalid` email action link for each run. The local
JSON file contains `link` and `email`, must be mode 0600, and is never committed. Configure:

```sh
FEMLAB_LIVE_ORIGIN=https://femlab-app-staging.web.app \
FEMLAB_LIVE_API_ORIGIN=https://femlab-api-dhphcl4vma-ey.a.run.app \
FEMLAB_LIVE_GOOGLE_ACCOUNT=<authorized-Google-account> \
FEMLAB_LIVE_LOGIN_PATH=<private-local-action-link-json> \
npm exec -w packages/app -- playwright test --config=playwright.live.config.ts
```

The test is staging-only, requires a disposable address, disables trace collection, and
never prints an ID token or signed URL. It does not send a real email, verify inbox delivery
or represent a live Stripe charge. Account deletion leaves only pseudonymous immutable
financial records. Remove the local action-link file after the run.

## Remaining release gates

- Confirm femlab.app ownership and unlock the Mac to use the authenticated Cloudflare
  console. DNS/custom-domain TLS and final-proxy acceptance remain pending. Google
  routing is provisioned and exact records are in [#600's plan](https://github.com/andeplane/fem-lab/blob/codex/600-domain-routing/docs/plans/600-domain-routing.md).
- Google redirect login is implemented but hidden until its web OAuth client is configured.
  Email-link login is enabled and verified; real inbox delivery still needs an inbox check.
- Live Stripe account, seller/tax/retention details, prices, webhook and portal activation.
  All paid controls stay disabled until configuration and live validation are complete.
- Verify a stream lasting over sixty seconds through the final production proxy.
  Direct Cloud Run long streams, client disconnect, isolated SQL restore and traffic
  rollback mechanics have passed; final-domain routing still requires DNS/TLS activation.
- Coordinate the broader engineering-answer live evaluation with #297's owner; this smoke
  verifies transport, authority, accounting and a real registry action, not numerical
  answer quality or a new physics Benchmark.
