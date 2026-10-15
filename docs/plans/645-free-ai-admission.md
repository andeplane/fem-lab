# Free AI invitation admission

Tracks [#645](https://github.com/andeplane/fem-lab/issues/645), with paid configuration
in [#644](https://github.com/andeplane/fem-lab/issues/644) and launch verification
in [#556](https://github.com/andeplane/fem-lab/issues/556).

Creating or reading an account and calling completions no longer issue free grants.
A verified email or Google login establishes account access, not entitlement to spend
FEM Lab money. A new UID, a new email and a deleted/recreated account start with zero
credits. Billing can still grant paid allowances from verified canonical paid invoices.

The launch preview is invitation-only. An operator reviews the person and records a
stable approval reference. The operator-only tool approves the existing 200,000-credit
free allowance once, expiring 30 days after approval. The source is immutable and unique
across accounts. Approval retries reuse the original period; another approval on the same
account fails; an existing approval cannot move to a recreated UID. No public HTTP route
can approve an invitation. The runtime cannot turn a signup into a free grant.

200,000 credits correspond to at most $0.15 of supplier cost under tariff v1, not a
promise of 200,000 raw model tokens. Mini uses one credit per uncached input token and
six per output token; 10,000 input plus 2,000 output consumes 22,000 credits, so the preview
covers nine such requests before output ceilings/reservations are considered. Actual
usage includes tool schemas, conversation history, reasoning and provider-reported caches.

Approval uses the migrator identity over an operator's existing local SQL proxy:

```sh
python3 infra/google/approve-trial.py --environment staging \
  --account andershaf@gmail.com --port 16445 --source "$PWD" \
  --account-id ACCOUNT_UUID --approval REVIEW_REFERENCE
```

Use the same review reference for retries or account recreation. Do not include a raw
email or other personal data in that reference. The tool retrieves the database password
from the selected project's Secret Manager and passes it only to its child process.
It never prints the password. Review is a human/product eligibility decision: operators
must not blindly approve new references for the same person. There is no claim that email,
CAPTCHA or card fingerprints prove unique people.

On 2026-10-15 production was checked at zero active accounts and zero Stripe-linked
accounts, then its free supplier pool was paused at `free_daily_micros=0` while this change
was prepared. Overall and paid spend limits were preserved. Once the guarded release is
verified, restore a small bounded free pool for invited users. Keep account signup open
for future paid purchases. Do not reinstate recurring automatic grants.

Automated trial eligibility is a separate later change: assess Firebase App Check with
reCAPTCHA Enterprise plus signup velocity signals, durable pseudonymous regrant controls,
and progressive payment-method verification. App Check cannot eliminate all abuse and
card fingerprints have wallet/region caveats. These measures must be evaluated before
opening automatic trial claims, with clear data-retention and shared-network behavior.
See [Firebase App Check](https://firebase.google.com/docs/app-check) and
[Stripe's trial-abuse guidance](https://stripe.com/resources/more/free-trial-abuse-tactics-signals-and-prevention).

Verification: real PostgreSQL tests exercise 24 concurrent approvals, idempotent retries,
expiry without renewal, inactive/deleted accounts, reused approval on recreated identity,
and eight distinct disposable identities rejected before provider input counting or
generation. Existing billing, privacy, credit, reservation and HTTP tests run with the
same real database. Browser copy describes invitation eligibility rather than promising
monthly free credits.
