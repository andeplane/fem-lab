# Read-only operational readiness

Implements [#824](https://github.com/andeplane/fem-lab/issues/824), a bounded child of
the hosted-launch umbrella [#556](https://github.com/andeplane/fem-lab/issues/556).

The scheduled recovery job mutates durable work and emits completion counts. It did
not provide a separate read-only snapshot of overdue work, uncertain usage and the
same aggregate supplier ceilings that admission enforces.

`operationalSnapshot` receives a typed SQL interface and a clock. One aggregate
statement observes requests, immutable receipts, queued billing events and shared
limits in one MVCC snapshot. It returns fixed structured alarms and aggregate
decimal strings, never identities, payloads or secrets. The existing service host's
`--operations` mode runs before Firebase, provider, payment, migration, recovery and
HTTP initialization. It emits one JSON record and exits 0/1/2 for a healthy-or-paused
snapshot, an actionable alarm, or an unavailable check. Its pool uses one connection
and a five-second statement deadline. No new public HTTP or engine registry surface
is introduced.

Verification covers real Postgres, a SELECT-only role, the actual built CLI, distinct
read/configuration failure signals, exact threshold equality and one-microdollar
margin, UTC rollover with retained holds, conservative company losses, counters above
the JavaScript safe-integer boundary, independent process connections, paused zero
caps and identifier redaction. The numerical engine and pricing are unchanged.

This child does not substitute local fixtures for actual production alert delivery,
proxy load, paid-state restore/reconciliation, or deployment drain evidence. #556
retains those criteria. The historical 227-second proxy stream/cancellation, unpaid
SQL restore and same-image traffic rollback are separately recorded in
[the launch evidence](557-hosted-launch-verification.md); owner activation and the
waived fresh-storage comparison must not be reintroduced as unresolved prerequisites.

## Parent acceptance map, 4 November 2026

These are dated committed receipts and explicit proof limits, not a fresh runtime audit.

| #556 criterion | Owning evidence | Remaining boundary |
|---|---|---|
| Separate EU projects, identities, SQL, private objects, immutable release and Scheduler | [Infrastructure baseline](563-google-infrastructure.md), [project storage](774-cloud-project-storage.md) and [launch evidence](557-hosted-launch-verification.md) | No fresh provider-configuration readback in this child |
| Final HTTPS API and streams beyond Hosting's timeout | [Final-domain acceptance](600-domain-routing.md#final-domain-acceptance-2026-10-15), including the 227.451-second stream and once-only cancellation receipt | A single-stream transport receipt does not establish concurrent proxy load capacity |
| Cross-process admission, global/free ceilings and conservative unknown usage | `packages/service/test/reservations-postgres.test.ts` and the new operational-snapshot tests | Local Postgres fixtures are not a deployed load drill |
| Auth redirects, account isolation, export/deletion, browser secret boundary | [Dated release checks](557-hosted-launch-verification.md), #616, #696 and #775/#789 | Final fresh-storage full-byte comparison was explicitly waived, not performed |
| Custom sender delivery | [17 October Inbox receipt](557-hosted-launch-verification.md#applied-sender-and-actual-inbox-delivery-17-october-2026), #710/#719 | The one-message authorization does not authorize another email |
| Managed Payments activation and test lifecycle | [Activation evidence](661-stripe-activation.md), including real test-mode renewal/refund/dispute webhooks and the expired unpaid live Checkout | No live charge or fresh paid-state disaster-recovery proof is inferred |
| Backup and ledger restore | [Historical SQL restore](557-hosted-launch-verification.md#historical-real-ai-and-infrastructure-proof-2026-10-15) | The restored snapshot was unpaid; canonical Stripe-state reconciliation is still required for paid recovery |
| Candidate failure, traffic rollback and recovery jobs | Same launch record and `infra/google/release-service.py` | Same-image traffic rollback does not prove arbitrary older-code compatibility or a fresh in-flight drain drill |
| Unknown metering, settlement/webhook lag and exposure signals | #824, `--operations`, and real-Postgres/actual-CLI verification | One-shot JSON/exit status does not configure scheduling, notifications or prove alert delivery |

The parent therefore remains open for the outstanding real-proxy load, operational
alert delivery and financial-recovery/drain acceptance. New drills require their own
bounded procedure and must preserve the existing staging supplier-spend pause.

## Verification

On 4 November 2026, the isolated external-drive home-mini checkout passed service
and test typechecking, all twelve real-Postgres operational tests, the production
service build, and documentation checks for both `/` and `/fem-lab/` (23 pages,
194 authoritative API definitions and 21 typed examples per route). The test host
used a separately owned Postgres 17 cluster on loopback port 55824, disposable
schemas and a SELECT-only role, including the actual built CLI. No cloud database,
provider account, payment, email, grant, deployment or notification was touched.

The first fixture run exposed a UUID/text bind mismatch in test setup. A subsequent
slow query outlived Vitest's deadline and conflicted with the next fixture reset;
fixture SQL now has a two-second statement deadline before the unchanged test
deadline. The final run passed all twelve cases, with no retries or
timeout-threshold increase.
