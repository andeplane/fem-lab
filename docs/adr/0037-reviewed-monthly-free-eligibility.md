---
status: accepted
date: 2026-10-15
---

# Monthly free usage follows a reviewed person, not a login

Issue [#712](https://github.com/andeplane/fem-lab/issues/712) includes roughly $5
of monthly supplier usage for approved free users. A verified Firebase email or
Google account establishes account access; neither proves a unique person nor
automatically approves spending. A privileged operator assigns one stable,
pseudonymous reviewed-person reference and binds it to one active account.

The service retains a principal UUID and append-only keyed email fingerprints.
Gmail/Googlemail dot and plus aliases share a canonical mailbox; custom domains
retain their dot/plus semantics. The dedicated project HMAC key is injected,
kept in Secret Manager, pinned at version 1 and absent from logs and exports.
Email changes need another explicit operator review. Reviewed prior fingerprints
remain unique, so replacing an email or deleting/recreating an account cannot
create another principal by discarding the old binding. A rebind requires the old
account to be inactive and preserves the same principal and claim history.
Manual review still does not prove unique humans.

An authenticated, explicit `account.claimFreeAllowance` Command submits an empty
body. The server selects the UTC calendar month and 6,666,666 weighted credits
(5,000,000 supplier microdollars under tariff v1). One immutable grant source per
principal/month survives request retries, concurrency, revocation and account
recreation. Credits expire at the next UTC month boundary without rollover.
There is no signup, account-read or completion-triggered grant and no backdated
claim. Existing 200k one-time invitations keep their recorded amounts/expiry;
monthly eligibility hides legacy free grants rather than stacking them.

Runtime roles can only read eligibility/fingerprint tables. Approval, revocation
and rebind use the operator's migrator identity. Eligibility, account state and
billing blocks gate balance and admission; revocation is checked again before
provider dispatch. Work already dispatched settles against its original grant.
An active paid period takes precedence even if exhausted, and a refund/dispute
cannot unlock free fallback.

The monthly free supplier pool also bounds funded principal-months: the number
of issued grants, including revoked/deleted bindings, cannot exceed the pool
divided by the fixed per-person budget. Supplier daily/monthly/held limits still
apply at generation. Missing keys, missing budgets and paused staging fail closed
for monthly claims. Approval alone does not reserve funding.

The trade-off is retaining pseudonymous anti-regrant records after account
deletion. Raw email/Firebase UID are erased by the existing deletion job, while
principal references, fingerprints and immutable monthly grant markers remain
without an automatic expiry for this program. These records are pseudonymous,
not anonymous or a claimed statutory retention requirement. Account exports
include the bound account's eligibility/fingerprints and its own ledger, never a
different account's ledger after rebind. Ordinary releases and operator tools use
fixed key version 1, even if a later version exists. Future rotation requires an
explicit retained-key/lookup migration: deleted raw emails cannot simply be
rehashed. Changing the key alone would erase alias matching.

Version #712 is the minimum safe generation version after the first monthly
grant. Earlier APIs treat all free grants as eligible and do not enforce the new
revocation/monthly controls. Publish to 100% ready traffic and wait for successful
release-helper exit before the first production claim. Before rolling back below
#712 or importing these grants into older code, set `ai_limits.enabled=false`
before traffic moves and keep old generation paused. Existing dispatched work
can settle; account/billing management remains available. No RLS or new plan tag
is introduced solely to permit an unsafe rollback.
