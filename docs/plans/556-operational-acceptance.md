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
[Cloud Run's ten-second termination budget](https://docs.cloud.google.com/run/docs/container-contract); the already durable dispatch/hold is
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

Before the operator additions, the package passed all **299** real-Postgres/unit/HTTP tests with coverage,
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


## Actual revision traffic rollover and rollback

The pinned prior fixture image `sha256:5cf5b2df7f743a8d240bbe9adb0ed38fa0662dd2345e786b57d3d6c7f2273786`
and source-`f8d7cc1d` image
`sha256:b58b143279fae8108040d9b8d87703d4b0ff358e28c4120be0e8fa0c7d1398a7`
ran against the same disposable ledger. The old revision was
`femlab-qa556-3eb922f2-00002-xew`; the candidate was
`femlab-qa556-3eb922f2-00004-wuz`.

Candidate traffic promotion began **18.813 seconds** after an old-revision stream's
headers, while that stream was still active. It completed after **70.082 seconds**
with one confirmed 4,800-subcredit receipt. The candidate replayed that same
request key and receipt. Traffic then rolled back to the old revision, whose
negotiated `usd-milli-v1` replay returned the same 4,800 subcredits as 0.12 public
credits. Restoring candidate traffic left exactly one request, one receipt and
one debit. This proves these two source versions and the retained schema/credit
protocol; it does not assert compatibility with arbitrary older images.

Both provider-error and signup-surge source executions and machine-delivered
incidents in both environments are recorded in
[the category alert evidence](556-provider-signup-alerts.md). Pub/Sub is the
operator destination with documented retention and authenticated pull/ack use;
a human inbox or page was not part of these checks.


## Rotation and authenticated operator paths

[Key rotation evidence](556-key-rotation.md) distinguishes the historical actual
Stripe TEST credential replacement from the fresh QA-only Secret Manager numbered
pin/disable exercise. The latter used the existing authenticated operator and
added zero IAM grants.

[Authenticated operator actions](556-operator-actions.md) use the existing Google
principal and service logic for account suspension, debit-only audited correction
and a whole durable recovery pass. Their evidence includes real PostgreSQL races
and immutable audit/idempotency checks, typed fake-Auth disable/revoke behavior,
and authenticated staging/production dry runs with zero mutations. The recovery
path uses the actual queued canonical billing processor; a read-only snapshot is
not presented as an administration interface.

## Criterion-to-receipt map, 5 November 2026

| Required acceptance | Evidence and supported boundary |
|---|---|
| Separate EU infrastructure, identity and private storage | [Infrastructure baseline](563-google-infrastructure.md), [private project storage](774-cloud-project-storage.md) and [launch history](557-hosted-launch-verification.md); no new provider account or ownership change in this follow-up. |
| Final TLS proxy, long streams, concurrency and cancellation | The fresh protected same-LB drill above admitted sixteen streams, rejected the seventeenth, measured streams over seventy seconds and conserved all sixteen receipts/holds. Upstream continuation after reader abort is explicitly recorded. It proves transport with synthetic providers, not paid supplier throughput. |
| Global/free ceilings across service processes | Real-Postgres independent-pool races in `reservations-postgres.test.ts`, read-only aggregate equality/rollover tests and the fresh SQL exposure observer above; no production admission/cap change. |
| Unknown usage, lag, spend, provider errors and signup surge | [Scheduled operational delivery](556-operations-delivery.md) and [category-specific actual incidents](556-provider-signup-alerts.md); existing authenticated Pub/Sub pull/ack is the operator destination, with seven-day retention. No human page is claimed. |
| Reconciled durable paid-state restore | [Fresh actual Stripe TEST read-only SDK recovery](556-stripe-recovery.md), real Cloud SQL restore and immutable ledger hashes; operator backfill references existing TEST objects, not fresh signed webhooks or LIVE payments. |
| Drain, durable recovery and rollback | Actual quiet-stream SIGTERM, separately built container entrypoint checks, and the two-image in-flight promotion/rollback above; no arbitrary older-image compatibility guarantee. |
| Google/email-link CSP and isolation compatibility | [Published and native authentication history](557-hosted-launch-verification.md) and [activation receipts](661-stripe-activation.md); final release preserves each environment's existing Google-sign-in flag, auth domain and API origin. |
| Actual email delivery | [Applied sender and actual Inbox delivery, 17 October](557-hosted-launch-verification.md#applied-sender-and-actual-inbox-delivery-17-october-2026): the authorized single message arrived in Inbox with SPF/DKIM passing. No new email is sent or implied. |
| Key rotation | [Dated real TEST credential replacement and fresh QA Secret Manager pin exercise](556-key-rotation.md); no production provider key rotation. |
| Authenticated suspend, inbox replay and ledger adjustment | [Operator actions](556-operator-actions.md): verified Google principal/IAM, service-backed whole canonical recovery pass, disable/revoke adapter and immutable debit-only correction. Positive funding remains unsupported; inherited Auth-emulator routing fails closed. |
| Final production bundle secret scan and publication | Final hosted variants require a prepublication scan and exact source/artifact/WAN-byte receipts. These release receipts belong in #556's final deployment comment; source tests and a green PR alone do not establish publication. Public Firebase browser configuration is intended public metadata. |

Exact-head Linux verification for source `76be6817` passed
[PR run 42010066093](https://github.com/andeplane/fem-lab/actions/runs/42010066093):
**313/313** service tests with the real PostgreSQL 17 service, including twelve
operator/Postgres cases and the actual compiled child-process emulator guard.
All required checks passed; no test deadline or coverage threshold was increased.
Later canonical rebases require their own exact-head checks before merge.
