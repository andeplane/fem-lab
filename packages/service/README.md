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

The Node host is separate from the headless Rust engine. It shares provider blocks,
completed tool/continuation events and versioned request schemas with the browser
through `@femlab/ai`. OpenAI clients, identity, storage, clock and request IDs are
host dependencies. This first slice (#546) supplies the protocol and HTTP host;
it does not yet admit an inference or claim that billing/login are implemented.

`npm run build -w packages/service`, then `PORT=8087 npm start -w packages/service`.
`GET /healthz` proves the process is live; `/readyz` remains 503 until real service
adapters are configured. Unknown routes return a structured error and never echo
request bodies or credentials. Later slices add the typed API and injected adapters.
