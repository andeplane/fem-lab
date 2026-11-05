# Authenticated operator actions

Implements the remaining bounded operator path in
[#556](https://github.com/andeplane/fem-lab/issues/556), following the deployment
requirements in [the hosted-service plan](545-ai-backend.md).

`infra/google/manage-operator.py` accepts an explicit environment, existing Google
Cloud principal, reviewed source checkout, operation UUID, non-personal case
reference and private receipt path. For account actions it also requires the target
account UUID and the port of an operator-owned Cloud SQL proxy. It obtains a
short-lived OAuth token through the selected gcloud account, verifies the token's
email through Google's authenticated userinfo endpoint, rejects impersonation,
and checks the project's required IAM permissions. Both launcher and direct CLI
reject an inherited `FIREBASE_AUTH_EMULATOR_HOST` before credentials or Auth setup:
a shell configured for local emulation cannot report a real-project suspension. The actor reference recorded
in financial entries is SHA-256 of that verified principal, never an actor string
supplied by the account API caller.

No public administration endpoint, account role, engine Command, browser storage
credential, new identity or service-account key is introduced. These actions
require the existing operator's Cloud IAM/Secret Manager access, as does the
free-allowance operator launcher. The source checkout must have its normal Node
dependencies installed. The proxy must point to the selected existing Cloud SQL
instance: `femlab-app-staging:europe-west3:femlab-staging` or
`femlab-app:europe-west3:femlab-production`.

## Debit correction

```sh
python3 infra/google/manage-operator.py --environment staging --account OPERATOR \
  --source /absolute/reviewed/checkout --port 55887 --action debit \
  --account-id ACCOUNT_UUID --grant-id GRANT_UUID --subcredits 100 \
  --operation-id OPERATION_UUID --reason-ref issue-556-case-1 \
  --receipt /absolute/private/operator-receipt.json
```

Amounts are **positive, exact integer internal subcredits**, passed as decimal
strings within signed bigint. The operation appends the corresponding negative
`adjustment` entry; it does not update a grant, usage debit, hold or receipt. Public
AI-credit display units are distinct from these exact ledger units. The account
must be active and the named grant must belong to it and be active at the current
time. The debit cannot exceed grant amount plus existing debits minus every
reserved, dispatched or pending-reconciliation allocation.

The correction uses the same global Postgres transaction lock as admission and
settlement, including across service processes. Its entry ID is the supplied
operation UUID. Immutable `source` stores a versioned actor hash, bounded reason
reference and that UUID. Reusing the UUID returns the original receipt; changing
actor, reason, account, grant or amount under it returns `adjustment-conflict`.
Retry the same UUID after an uncertain result. A later expiry does not change an
already-recorded correction receipt.

Positive funding/correction is unsupported by the existing debit-only entry
format. It must not be simulated by editing history, fabricating an invoice or
minting an ad-hoc grant; that capability requires separate review.

## Suspend account access

```sh
python3 infra/google/manage-operator.py --environment staging --account OPERATOR \
  --source /absolute/reviewed/checkout --port 55887 --action suspend \
  --account-id ACCOUNT_UUID --operation-id OPERATION_UUID \
  --reason-ref issue-556-case-2 --receipt /absolute/private/suspension.json
```

The typed adapter resolves the existing account's Firebase UID internally, disables
that identity, then revokes refresh tokens. The service's existing
`verifyIdToken(token, true)` rejects disabled/revoked sessions on subsequent
requests. Account lifecycle fields retain their existing meaning; suspension does
not pretend the account is deleting. Already admitted generation retains normal
cancellation/metering/settlement behavior.

A lost disable response leaves the remote state unconfirmed; the error records
`disableConfirmed: false` without claiming that the identity remains enabled.
If revocation fails after an acknowledged disable, the error receipt records `disabled: true` and
never re-enables the identity. Repeating the action safely finishes revocation.
SDK diagnostics, UID, tokens and credentials are suppressed from output. The
operator receipt and Google's identity-administration audit trail establish the
action; no local user database is substituted for the identity provider.

## Recover durable inbox work

```sh
python3 infra/google/manage-operator.py --environment staging --account OPERATOR \
  --source /absolute/reviewed/checkout --action recover \
  --operation-id OPERATION_UUID --reason-ref issue-556-recovery \
  --receipt /absolute/private/recovery.json
```

This invokes the existing authenticated `femlab-recover` Cloud Run Job and waits
for its actual outcome. That job processes queued billing inbox work through
`billingLifecycle.recover()`, plus its normal usage, project and privacy recovery.
It is a whole recovery pass, not an API that blindly reapplies a completed event.
Only queued events are replayed; canonical invoice/subscription state and the
existing immutable period/source checks govern entitlement changes. Existing
signed-dispute recovery is recorded in [the activation evidence](661-stripe-activation.md);
actual restored canonical TEST recovery is recorded in
[the Cloud SQL/Stripe proof](556-stripe-recovery.md).

Use `--dry-run` on any launcher action to verify selected principal and project
permissions with **zero SQL/Auth/job mutations**. This verifies permissions, not
existence of a supplied target or a completed suspension/correction. Review actual
targets separately before executing an action. Credentials remain in process
memory; receipt files use mode 0600. No email or provider-generation request is
made by these tools.

## Verification

Real-Postgres and actual CLI checks cover immutable audit metadata, exact arithmetic
above 2^53, same/different-key concurrency, held allocation protection in all three
active states, racing an independent-instance reservation, stale/reassigned targets
and structured output redaction. A typed fake Firebase adapter proves disable-before-
revoke order, failure behavior, safe retry and rejection through the existing token
verifier. Existing operators' authenticated staging/production dry-runs prove current
Cloud SQL-connect and identity-update permissions; **no actual Firebase identity was
created, disabled or revoked in this verification**.

References: [Firebase session revocation](https://firebase.google.com/docs/auth/admin/manage-sessions)
and [Admin token verification](https://firebase.google.com/docs/reference/admin/node/firebase-admin.auth.baseauth).

### Recorded validation

A complete real-Postgres service run passed **311/311 tests** with coverage. The
financial core did not change afterward. Following receipt-normalization and
launcher review, the compiled actual CLI and all operator cases passed **12/12**
under the unchanged five-second test deadline; all **35** Google infrastructure
Python tests and the final service TypeScript check passed. The CLI is compiled
once for its subprocess tests; separate launcher tests verify the real TSX invocation
shape, principal checks, canonical UUID receipt and final recovery execution checks.
Pending child processes are aborted and awaited before fixture cleanup, and all
concurrent correction attempts settle before assertions/reset.

Other broad mini runs encountered existing fixture hooks exceeding their unchanged
ten-second deadlines. The first purchase-use timeout's cause remains **undetermined**.
A later run recorded 13.1/13.7-second `TRUNCATE` operations and an explicit 3.05-second
AccessExclusiveLock wait behind the earlier backend, followed by duplicate fixture
mapping. This proves that later SQL/blocking sequence, not its underlying cause or
a cause for the earlier timeout. The preserved activity sample window missed those
later failures; empty samples are not proof of no blocker. A separate normal-user
TypeScript process stack captured synchronous filesystem reads; that is an independent
observation. No tax behavior, production logic, test deadline or coverage gate was
changed in response. Canonical Linux package validation remains the final merge gate.

The operator's verified virtual 256-MiB RAM volume hosted only the isolated test
Postgres instance on loopback port 55887. Its logs, source snapshots, passing/failing
run outputs, stack sample, PG wait details and dry-run receipts are retained externally
under `control-20261105/556-operator`. The owned cluster was stopped and its verified
RAM device detached after verification; no persistent database or identity was changed.
