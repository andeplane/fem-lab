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

Account reads add the current UTC monthly free grant idempotently and report balance,
plan, model allowlist and output ceiling. Grants expire without rollover. Paid grants
will be admitted only from the verified billing lifecycle, never from a client plan ID.
Tariff `2026-10-14.v1` stores 30 integer subcredits per public credit, including cache
writes once and reasoning inside total output. Financial grants/debits are immutable
database rows. Reservation/settlement admission follows in #549.

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

The Node host is separate from the headless Rust engine. It shares provider blocks,
completed tool/continuation events and versioned request schemas with the browser
through `@femlab/ai`. OpenAI clients, identity, storage, clock and request IDs are
host dependencies. Authentication and account-owned admission are independent of
the engine; the service never executes tool calls or creates an engine Session.

`npm run build -w packages/service`, then `PORT=8087 npm start -w packages/service`.
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
