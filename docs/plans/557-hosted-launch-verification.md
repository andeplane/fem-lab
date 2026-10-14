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
  console. DNS/custom-domain TLS and the final API domain/proxy remain pending.
- Google redirect login is implemented but hidden until its web OAuth client is configured.
  Email-link login is enabled and verified; real inbox delivery still needs an inbox check.
- Live Stripe account, seller/tax/retention details, prices, webhook and portal activation.
  All paid controls stay disabled until configuration and live validation are complete.
- Finish the isolated backup restore/rollback drill and verify a stream lasting over sixty
  seconds through the final production proxy. Short real streams and abort/uncertain-usage
  behavior are already covered by deployed smoke and deterministic service fixtures.
- Coordinate the broader engineering-answer live evaluation with #297's owner; this smoke
  verifies transport, authority, accounting and a real registry action, not numerical
  answer quality or a new physics Benchmark.
