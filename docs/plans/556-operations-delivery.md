# Scheduled operational checks and machine alert delivery

Part of [#556](https://github.com/andeplane/fem-lab/issues/556), using the read-only
snapshot implemented in [#824](824-operational-readiness.md).

`infra/google/operations.py` deploys a separate `femlab-operations` Cloud Run Job
in the selected existing Frankfurt project. It requires an already-built,
same-project immutable service image digest and pins the existing database jobs
password to a numbered Secret Manager version. It mounts no provider, Firebase
or payment secret. `PGOPTIONS=-c default_transaction_read_only=on` makes the
session read-only. The service entry point selects `--operations` before any
provider, identity, migration, recovery or HTTP initialization.

The job uses one task, no retries and a 30-second outer deadline; its internal
connection and statement deadlines are five seconds. Cloud Scheduler invokes it
every ten minutes with the existing Scheduler identity. Successful ready/paused
snapshots exit zero. Actionable alarms exit one; unavailable checks exit two.
The normal staging supplier pause is unchanged.

A Google Monitoring log-match policy watches ERROR entries from this named job,
including snapshot alarms and process failures. It delivers to a same-project
Pub/Sub topic whose storage policy is Frankfurt, with a seven-day durable pull
subscription and no expiry. Notifications are rate-limited to fifteen minutes;
incidents close after thirty minutes without matching logs. Only Monitoring's
notification identity receives topic publish permission. No human email, Slack
message or owner sign-in is part of this deployment.

The pull subscription is the operator delivery destination. Inspect and acknowledge
messages through authenticated Pub/Sub tooling; acknowledgement removes the item
from this subscription. This is durable machine delivery, not a promise of human
paging. To connect another recipient, configure and verify that explicitly.

```sh
python3 infra/google/operations.py --environment staging --account ACCOUNT \
  --image europe-west3-docker.pkg.dev/femlab-app-staging/femlab/service@sha256:DIGEST \
  --receipt /absolute/operator/evidence/operations-staging.json
```

The optional `--notification-drill` writes a fixed, explicitly synthetic redacted
ERROR entry to Cloud Logging under the same job resource and filter. It does not
change a request, ledger, cap or webhook. Proof requires pulling the resulting
Monitoring incident from the subscription and matching its policy, project,
resource and drill time. Publishing a test message directly to Pub/Sub would not
prove Monitoring delivery.

The script does not deploy API traffic, restore data, recover usage, increase caps
or send requests to an AI or billing provider. Re-running it updates only its
named job/schedule/policy/channel. The existing API and recovery job retain their
independent release images and traffic.

## Verification

Deployment-contract tests reject a cross-project/mutable image or unpinned secret,
check both environment bindings and read-only settings, and verify that the drill
uses Logging rather than a direct Pub/Sub publish. Actual deployment and delivery
receipts are recorded below after provider readback.


### Applied 5 November 2026

Both service images were built from committed source
`79f62f6ee20a1168b274e0993cbbb93489a68372`, using the existing Cloud Build identities,
Artifact Registry repositories and build buckets. Only the separate operations
jobs consume these images; the API and recovery releases were not promoted.

| Environment | Cloud Build | Immutable digest | First successful execution | Snapshot |
|---|---|---|---|---|
| Staging | `d49d68c2-12ac-4a1c-9be1-5bf2b9d781e9` | `sha256:01a144054c3238661d0818b5c4e429d59f3e6754206571cdcbe37e12d6a96e56` | `femlab-operations-8nfxp`, 07:59:37 UTC | paused; zero supplier caps, no holds or alarms |
| Production | `0a1e8702-9716-43bb-a298-51ed9d65a6fb` | `sha256:7200e8d64fca51144a3384b76a74def4a52d997535953436db8624bc6aefa011` | `femlab-operations-2v645`, 07:59:37 UTC | ready; no active/pending/overdue requests, queued webhooks or alarms |

The staging Scheduler's independent 08:00 invocation also succeeded as
`femlab-operations-6x7bn`. A separate staging execution overrode only its own
`PGDATABASE` to a nonexistent database. It failed as intended with exit two and
the fixed redacted `operations-unavailable` record (`femlab-operations-dllq5`).
Readback confirmed the persistent job still uses `PGDATABASE=femlab`; no real
record or SQL schema was changed by the failure drill.

Actual Google Monitoring incident messages were pulled and acknowledged from
the two operator subscriptions:

| Environment | Policy | Open incident | Pub/Sub message | Published UTC |
|---|---|---|---|---|
| Production | `799027468623084032` | `0.oenly5egmp4k` | `22343258343290540` | 08:01:10.696 |
| Staging | `17348865825393696793` | `0.oenm0esanqj8` | `22354658093373774` | 08:03:55.460 |

Each message identifies the expected policy, Cloud Run Job, project, Frankfurt
location and ERROR log-match condition. Production followed its explicitly
synthetic 08:00:19.409 entry by 51 seconds. Staging's error sequence included both
synthetic entries and the actual unavailable-check drill; the incident does not
identify which individual entry first triggered it, so no per-entry latency is
claimed there. No notification was directly published to Pub/Sub, and neither
channel targets a person. Initial negative pulls established propagation delay,
not a delivered notification; the table records the subsequently pulled messages.

The four new deployment-contract tests and all 27 Google infrastructure tests
passed on home-mini. The first live synthetic write exposed an incorrect HTTP
method in the new helper; it was corrected to POST and the test now requires that
method. No runtime threshold, alert severity or delivery gate was weakened.

Sanitized build, job, Scheduler, snapshot, negative-check and notification JSON
receipts are preserved in the operator evidence directory
`control-20261105/556-operations` under the home-mini worker root. They contain
aggregate operational data and resource identifiers, not credential values.

This completes scheduled checks and machine notification delivery for unknown
metering, settlement/webhook lag, company losses, admission exposure and check
failures. It does not turn a local fixture into proxy-load, paid-recovery or
in-flight-drain acceptance; those remain separate #556 procedures. Broader
provider-error and unusual-signup alert categories are not inferred from the
SQL snapshot.

References: [Google log-based alerts](https://docs.cloud.google.com/logging/docs/alerting/log-based-alerts)
and [Pub/Sub notification channels](https://docs.cloud.google.com/monitoring/support/notification-options#pubsub).
