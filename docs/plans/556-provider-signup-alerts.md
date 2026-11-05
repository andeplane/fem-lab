# Provider and signup operational alerts

Completes the provider-error and unusual-signup signal classes in
[#556](https://github.com/andeplane/fem-lab/issues/556) and the deployment criteria in
[the hosted-service plan](545-ai-backend.md). The other read-only signal classes and
machine delivery baseline are recorded in [operational readiness](824-operational-readiness.md)
and [operations delivery](556-operations-delivery.md).

## Provider failures inside successful HTTP streams

`completionService` receives a typed observer. It reports at most one fixed event per
request for input-count failure, provider-stream failure, explicit supplier rejection,
or a stream that ends without authoritative usage. A provider can fail after SSE
headers have been sent, so HTTP 200 alone cannot establish supplier success. The event
contains only `event`, `severity`, `code` and `where`; the host adds its injected UTC
clock. No account, request key, prompt, tool payload, token, supplier error text or
payment metadata is logged by this observer.

Intentional cancellation, admission denials, output transport failures and known
settlement-storage failures are excluded from provider-error classification. Those
paths retain their existing financial behavior. A logging callback failure cannot
release a dispatched hold or replace an authoritative receipt. Unknown metering still
uses the separate aggregate operational signal and durable recovery path.

## Unusual account provisioning

The read-only snapshot counts application-account rows created in the trailing twenty
minutes, including the exact cutoff and excluding future timestamps. Reopening an
existing identity does not create another row. This counts first application-account
provisioning; it is not a count of every Firebase identity creation or every sign-in.

The default review threshold is 20 new rows in twenty minutes. The small-preview
baseline is deliberately an operator review signal. The twenty-minute lookback spans
two ten-minute checks and avoids splitting a short burst across adjacent polling
windows. It does not prove fraud, approve an allowance, suspend an account or change
supplier ceilings. Operators should tune it to expected launch traffic.

`OPERATIONS_SIGNUP_LIMIT` and `infra/google/operations.py --signup-limit` accept a whole
number from 1 through 1000000. Malformed policy produces the fixed unavailable result
and exit 2. The snapshot exposes only the decimal count, window and threshold; crossing
the inclusive threshold adds `signup-surge` and exit 1.

## Notification routing

Provider and signup classes have separate log-match policies and separate fifteen-minute
notification rate limits. They use the existing durable seven-day Pub/Sub operator
subscription in each environment. A provider event matches the actual API service;
signup alarms match the scheduled operations job. Explicitly synthetic source events
from owned disposable `femlab-qa556-*` fixture services or jobs also match, so delivery can be
verified without real supplier calls or creating customer/Auth identities.

The queue is a machine delivery channel. An operator must pull and acknowledge it, or
configure a consumer. These policies do not send email or establish human paging.


## Live source and delivery receipts, 5 November 2026

The signal implementation and container fixtures were built from committed source
`f8d7cc1d9f7ffc020b9482b8fea627cb7363859d`. The follow-up source
`f9f530784a208ec09bb134451803374e2493e2dd` also gates provider errors after confirmed
usage, preserving the already-authoritative receipt. Source tests pass all 299 service
cases on real PostgreSQL; infrastructure checks pass all 30 cases, and documentation
checks pass for both public bases.

Fresh source execution used disposable data and no supplier, payment or Auth secrets.
The production-project QA service produced an HTTP 200/SSE interruption with one retained
uncertain hold and the actual SQL snapshot counted 24 synthetic account rows. Staging
ran the same code inside the isolated Cloud Run Job
`femlab-qa556-d3b9aee3-gnmst`: a child HTTP host, a real loopback HTTP 200/SSE failure,
and the source SQL snapshot. Its three source log records were retrieved independently.
The reviewed job driver SHA-256 is
`835fcbc29106443e31cd0a99d96ee0c499bd8d316d58e655b09f3d9d996c68af`.
This is fresh execution in each environment; no source log was replayed into staging
and no notification was published directly to Pub/Sub.

The actual Monitoring notifications below were pulled, their policy/resource bindings
verified, proof files saved, and only then acknowledged. Times are UTC.

| Environment | Class | Published | Incident | Pub/Sub message |
|---|---|---|---|---|
| Production | Provider | 09:07:28.449 | `0.oenngnmp59hq` | `20343867850478222` |
| Production | Signup | 09:07:28.477 | `0.oenngnmp59hw` | `23079070216688471` |
| Staging | Provider | 09:08:22.774 | `0.oennhe9fas7j` | `20349808054324090` |
| Staging | Signup | 09:08:22.681 | `0.oennhe9fas7c` | `20343893800935509` |

Both scheduled read-only jobs now use source f8 images and explicit threshold 20.
Normal executions reported zero recent signups, no alarms and no supplier exposure:

| Environment | Execution | Snapshot UTC | Result | Immutable image digest |
|---|---|---|---|---|
| Staging | `femlab-operations-4fmwk` | 09:12:40.862 | Paused; all supplier caps remain zero | `sha256:f0feb31b0007738fd034beb7aadfa22a03d2bfd51705d93bf027b8e5111ee2b6` |
| Production | `femlab-operations-hfhl6` | 09:15:29.638 | Ready | `sha256:269d4cfb4118c7a0dfbdfd9056b040043ef1702db125ba8269ff0acc2deaa919` |

The jobs retain the existing jobs identity, mount only their numbered database secret,
and enforce read-only sessions. API and recovery specifications had identical SHA-256
values before and after this operations rollout. The provider observer's final normal
API promotion is owned by the parent deployment receipt; these fixture receipts do not
claim a real customer/provider failure or an API traffic promotion.

The staging fixture Job, database, SQL role, secret and service identity were removed;
its local SQL proxy stopped. The isolated 256 MiB RAM-backed PostgreSQL test cluster was
stopped and detached after its logs were exported to the external worker evidence.
No real account/Auth identity was created, and no email or real supplier/payment
operation was performed by this signal drill.

Reapplying unchanged policy fields now leaves Monitoring incident state alone,
following [Google's incident guidance](https://docs.cloud.google.com/monitoring/alerts/log-based-incidents).
Requested policy changes preserve the existing condition resource identity. A live
readback verified that all four current policy filters/channels match the delivered
definitions without requiring another mutation.

The durable delivery resource is
`projects/<project>/subscriptions/femlab-operations-alerts-operator`, where `<project>`
is `femlab-app` or `femlab-app-staging`. It retains unacknowledged machine notifications
for seven days; it is not a human paging service. Sanitized source logs, current job
readbacks, all four notifications, cleanup and hashes are preserved under the external
worker's `fem-lab-556-complete.control/alerts/cloud/manifest.json`.
