# FEM Lab account and AI service

Firebase identities are validated with revocation checks on every authenticated request.
`GET /v1/account` provisions exactly one Postgres account per verified Firebase UID;
email changes do not relink ownership, and inactive accounts are rejected. No account ID
selector is accepted. Browser CORS origins are an explicit deployment allowlist.

Set `FIREBASE_PROJECT_ID` and standard `PGHOST`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`
connection settings on the host. Build, then run `node dist/main.mjs --migrate` before
serving. The migration transaction uses an advisory lock and records its version with
the DDL. Auth uses workload credentials in deployment; no service-account key file.

For real database tests set `TEST_DATABASE_URL` to a disposable Postgres 17 database.
The tests create isolated schemas and remove only those schemas; CI runs them against
its own Postgres service. Without that variable these integration tests are skipped.

Account reads report balance, plan, model allowlist, output ceiling and monthly free
eligibility without creating grants. Verified signup starts at zero. An operator
reviews a stable person reference using `tools/manage-free-allowance.mts` (the Google
wrapper is `infra/google/manage-free-allowance.py`). Approved accounts explicitly
claim via `POST /v1/account/free-allowance {}`: 6,666,666 weighted credits per UTC
month, once per reviewed person, subject to the shared monthly free pool. Revoke,
email review and rebind are operator-only. Retained keyed email/claim markers prevent
recreation from resetting the month; `FREE_ELIGIBILITY_HMAC_KEY` must be configured.
Runtime roles cannot approve eligibility. Legacy one-time invitations remain 200k
and do not stack with monthly eligibility. Grants expire without rollover. Paid grants
are admitted only from the verified billing lifecycle, never from a client plan ID.
Tariff `2026-10-14.v1` stores 30 integer subcredits per public credit, including cache
writes once and reasoning inside total output. Financial grants/debits are immutable
database rows. Reservations enforce per-account credits and aggregate/free daily,
monthly and outstanding supplier budgets before generation. See
[the monthly free allowance plan](../../docs/plans/712-free-monthly-allowance.md).

Payment webhooks use `POST /v1/billing/webhook`, with the original raw bytes and
Stripe signature. The durable inbox stores event/object/customer IDs and a digest,
not raw card/customer payloads. Canonical invoice/subscription reads and a leased
customer lock make duplicate/unordered events safe. Paid invoice/period sources are
unique; failed renewals and proration updates grant no new allowance. Cancellation
preserves an already-paid period. Refund/dispute events freeze paid access for an
auditable billing review without changing consumed-token history.

Set separate test/live `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PRICE_PLUS`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_STUDIO` and `BILLING_MODE`.
Missing configuration disables payment handling without disabling free AI. Scheduled
recovery retries failed inbox items; failures emit an error event and fail the job.
No live Stripe account or payment is configured by the fixtures in this repository.

`POST /v1/billing/checkout` accepts only `{plan: "plus"|"pro"|"studio"}`.
`POST /v1/billing/portal` accepts `{}`. Customer/price/return URLs are server-owned.
`POST /v1/billing/plan` schedules a tier change at the next period; its durable
operation is retried by recovery with the same Stripe idempotency key. It grants
no current credits. Checkout repeats reuse one account-owned intent; active paid
periods/subscriptions prevent another checkout. Redirect success grants nothing.

Activation additionally requires `STRIPE_PORTAL_CONFIGURATION`, an HTTPS
`APP_RETURN_ORIGIN`, matching key/test/live mode, and explicit `BILLING_ENABLED=true`.
The default remains disabled. Configure seller identity, terms, tax/market settings
and the Portal's cancellation/payment-method features before enabling paid checkout.

The Node host is separate from the headless Rust engine. It shares provider blocks,
completed tool/continuation events and versioned request schemas with the browser
through `@femlab/ai`. OpenAI clients, identity, storage, clock and request IDs are
host dependencies. Authentication and account-owned admission are independent of
the engine; the service never executes tool calls or creates an engine Session.

`npm run build -w packages/service`, then `PORT=8087 npm start -w packages/service`.

The production build type-checks runtime sources through `tsconfig.build.json`.
`npm run typecheck -w packages/service` also checks integration tests and their host
boundaries. CI runs `node tools/test-service-build.mjs` in an isolated copy containing
only the service, AI and registry packages, matching the production container layout.

`GET /health` proves the process is live; `/ready` is 503 until identity, database
migrations and provider configuration are available. Unknown routes return a
structured error and never echo request bodies or credentials.

Cloud Run reserves some paths ending in `z`; public probes use `/health` and
`/ready`. The old `/healthz`/`/readyz` aliases remain available to local/container
checks, but must not be used to verify public routing (issue #570).

`POST /v1/ai/completions` (alias `/chat/completions`) accepts the strict normalized
`CompletionInput` protocol, a Firebase bearer ID token and an `Idempotency-Key`.
This uses FEM Lab events rather than the OpenAI Chat Completions wire format.
The service counts the exact Responses input, reserves maximum cost, commits
dispatch and streams SSE envelopes (`request`, `receipt`, `chat`). A receipt is
emitted before completed tool calls. Upstream failures with confirmed usage are
settled; absent usage remains pending. Explicit HTTP rejections without a started
response receive an unbilled rejection receipt. SDK generation retries are disabled.

`GET /v1/ai/requests/:id` returns only the authenticated owner's status/receipt;
it never replays response text. `GET /v1/ai/models` reports the owner's effective
allowlist and limits. Launch context is bounded at 64,000 counted input tokens for
Free / 128,000 for paid, with 4,096 / up to 16,000 output tokens. HTTP bodies are
bounded at 16 MiB. At most two PNG/JPEG/WebP images are accepted, each at most
5 MiB and 1568 pixels on the longest edge; remote file references are rejected.

Deploy long SSE directly to Cloud Run/the API load balancer. Firebase Hosting
rewrites time out at 60 seconds. Run `node dist/main.mjs --recover` as a scheduled,
authenticated Cloud Run Job, not as post-response work in the HTTP process.

The optional browser account build accepts public configuration through
`FEMLAB_FIREBASE_CONFIG` (Firebase web app JSON), `FEMLAB_AI_API_ORIGIN` (HTTPS API origin)
and `FEMLAB_BASE_PATH=/` for Firebase Hosting. These are not service credentials.
`FEMLAB_GOOGLE_SIGN_IN=true` displays Google redirect login only after the Google provider
and same-domain auth helper have been configured. Email links use session persistence,
retain the pending email in this tab only, and remove the callback code after completing
sign-in. No ID token is exposed by a host Command/Query or stored in the Journal.

Production Assistant requests use the normalized streaming API and server usage receipts.
A completed tool call cannot execute before a confirmed receipt; identity changes abort the
request and clear the conversation and queued messages. First use requires an explicit
account-scoped data-flow acknowledgement. No browser provider-key setting is offered.
`FEMLAB_AI_MODE=development` is an explicit local/CI supplier-fixture build only; it is
rejected when a hosted API origin is configured. CI tests the production anonymous/login
boundary first and then runs existing supplier wire fixtures in this development host.

Account data actions require a verified owner: `POST /v1/account/export {}` queues a private
JSON export; repeating the request returns its current status or a signed download URL.
The URL lasts at most 15 minutes and never beyond the export's 24-hour expiry. The recovery
job writes account, grant, debit, hold, receipt and billing metadata; no model, prompt,
transcript, tool content or image is archived. Export generation is capped at 100,000 rows
per record type and 32 MiB; larger histories require a support export. `EXPORT_BUCKET` must
name the private regional bucket with public-access prevention and an expiry lifecycle.

`POST /v1/account/delete {"confirm":"DELETE"}` requires original Firebase authentication
within five minutes; refreshing an old ID token is insufficient. The request freezes new
AI/billing admissions and queues deletion under the same account lease used for checkout.
The job expires known checkout sessions, waits for uncertain checkout expiry, releases
future plan schedules and confirms cancellation of renewal before deleting the Firebase
identity. Vendor outages retain the identity and a retryable job. Accepted AI requests
must first finish or be reconciled. Identity removal is idempotent; the final transaction
clears login/email and disposable export/checkout/plan records while retaining immutable
financial records under the opaque account ID. Current Stripe customer contact fields are
cleared; historical vendor invoices are subject to the seller's required retention policy.
Live billing activation requires that policy and seller details to be settled separately.

The API identity may read and sign its private export objects. The recovery identity may
write/delete exports and delete Firebase users. Google workload identities sign URLs;
no service-account private key is used. Recovery logs contain counts and fixed failure
codes, never exported content, signed URLs, credentials or vendor exception messages.
