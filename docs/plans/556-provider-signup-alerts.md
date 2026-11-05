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
