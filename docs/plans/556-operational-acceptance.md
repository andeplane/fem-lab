# Hosted deployment acceptance

Tracks [#556](https://github.com/andeplane/fem-lab/issues/556). Read the dated
[launch history](557-hosted-launch-verification.md), the
[operational check map](824-operational-readiness.md), actual
[machine notification delivery](556-operations-delivery.md), and fresh
[canonical Stripe TEST recovery](556-stripe-recovery.md) separately.

## Actual final-proxy load, 5 November 2026

A dedicated `qa556` database role owned two disposable Cloud SQL databases. Its
superuser, create-role, create-database and inheritance flags were false; a read
of the real `femlab.ai_limits` table was denied. A dedicated Cloud Run identity
had only Cloud SQL client access and access to its one temporary database secret.
It had no OpenAI, Stripe or Firebase credential. All identities, invoices and
provider responses in the transport fixture were synthetic; no real owner
account, supplier request, payment or email was created.

The existing `api.femlab.app` HTTPS load balancer routed only a random protected
`/qa556_<run>/*` path to that service. The original default backend stayed intact.
The fixture required a fresh bearer capability and rejected a real database name,
a non-QA database role or supplier/payment/Auth configuration. CPU was one core,
concurrency eight, memory 512 MiB and at most two instances. Route propagation was
preparation: sixteen parallel probes had to pass three consecutive times before
measurement. A measured completion was never retried.

At **08:37:41.272 UTC**, sixteen concurrent completion calls began. All sixteen
received SSE; a seventeenth admission returned **429**. Eight readers were aborted
at **08:37:52.867 UTC**. The other eight received one confirmed receipt each, with
the shortest complete stream lasting **70.104 seconds** after headers. By
**08:38:53.788 UTC**, all sixteen upstream responses had confirmed usage and exactly
sixteen receipts existed. Each debit was independently checked as
`100 × 30 + 10 × 180 = 4,800` integer subcredits: **76,800** in total. Completed and
aborted request keys replayed their existing outcomes without another generation.

The real proxy continued these upstream responses after the local reader aborted.
HTTP disconnection therefore does **not** promise immediate supplier cancellation.
A canceled reader can later receive a confirmed charge for actual usage; an
unconfirmed dispatch retains its hold. This distinction is documented in the
Assistant guide. No claim of eight upstream cancellations is made.

A separate SQL observer retained **429 timestamped samples**. Peak held supplier
exposure was **73,200 microdollars**, exactly sixteen reservations of 4,575, below
the synthetic 1,000,000-microdollar ceiling. The observer recorded each request's
state, timestamps, hold and receipt, using fake request keys and no transcript.

## In-flight SIGTERM

With the disposable service reduced to one instance and session affinity enabled,
a quiet 90-second fixture stream was active when its actual Linux container
received SIGTERM. The host stopped admissions, closed remaining sockets after its
five-second grace and recorded `pending_reconciliation` **5.178 seconds** after
that request's creation. Its hold remained; a same-key replay returned pending.
The full availability check took **17.156 seconds**, including the replacement
instance's startup. That is not reported as a seventeen-second shutdown handler.

Five seconds bounds socket grace. A hung dependency can outlast that grace and
Cloud Run's ten-second termination budget; the already durable dispatch/hold is
then recovered by the scheduled worker. The test delivered SIGTERM to a real
Cloud Run container; it did not claim to observe a platform-issued SIGKILL.

## Paid records and restoration

The synthetic transport database was paused, dumped and restored to its sibling.
Seven exact row-content hashes matched: grants, debits, holds, receipts, paid
periods, billing inbox and request state. Dump SHA-256:
`42251803bdbd8f1bb00ce542e881218aa6dee0b4e9c16b9d9ae735622b75814d`.

A redundant synthetic renewal check subsequently failed because the original
fixture reused its first invoice ID for a different period. The backend correctly
rejected that conflict. This failed fixture is not claimed as passed acceptance;
the reusable fixture now gives a renewal its own invoice identity.

Financial acceptance instead uses the stronger fresh
[actual Stripe TEST adapter and Cloud SQL restore](556-stripe-recovery.md):
48 canonical SDK GETs, six backfill items processed then zero on repetition,
unchanged immutable paid grants/ledger hashes, and both refunded accounts blocked
before reopening admission. These were operator-generated trusted backfill
references to existing TEST objects, not new signed webhooks or LIVE payments.

## Runtime packaging and operator modes

Cloud Build `49895935-f426-4e19-88f8-2f3a87305dcd` built the lazy-runtime container
image `sha256:b442c3c356873a7ae079fa17bacb91f2e858d384a299778e621f726c3f96c504`.
Actual Cloud Run executions of `service/main.mjs --migrate`, `--recover` and
`--operations` succeeded against a separate owned QA database. The normal private
HTTP entry returned health 200 and readiness 503 when its required inference
adapters were deliberately absent. The entire generated `dist` directory,
including runtime chunks and migrations, was present; no development source was
mounted. All temporary container-mode resources were removed afterward.

The package passed all **287** real-Postgres/unit/HTTP tests with coverage,
including a CLI loader that throws if Auth/storage/provider/payment SDKs load in
read-only mode. Both documentation route bases and seven documentation tests passed.
Host coverage is distinct from the unchanged engine/geometry coverage gates.

## Reusable fixture and cleanup

`packages/service/tools/acceptance556.ts` is a separately built disposable fixture,
never the production service entry point. `infra/google/acceptance556.Dockerfile`
and `cloudbuild.acceptance556.yaml` build it with the actual service library.
`acceptance556-client.mjs` measures the protected final-proxy stream, validates
receipts and exercises drain/recovery; its private state directory is selected
with `FEMLAB_556_EVIDENCE`. Credentials stay in operator memory or mode-0600
files under a mode-0700 directory and are not committed.

The operator must provision a least-privilege QA role, two owned databases and a
fresh capability; preserve the existing URL map before adding the random path;
and run cleanup in `finally`. Restore and independently compare the original
routes/default, then delete the QA service, seed job, NEG, backend, databases,
role, secret and identity. Every transport attempt, including preparation failures,
used this cleanup. Production account records and the staging supplier-spend pause
were preserved. Transport/runtime fixture images do not establish production API
promotion; final release source/image and rollout receipts are recorded separately.
