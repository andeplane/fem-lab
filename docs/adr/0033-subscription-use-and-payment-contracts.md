---
status: accepted
date: 2026-10-15
---

# Subscription use and payment retry parameters are immutable

Issue [#680](https://github.com/andeplane/fem-lab/issues/680) serves individuals and
businesses without inferring their use from a tax ID. A new managed purchase has an
explicit personal/business argument on the registered `account.checkout` Command.
The account form holds an unsubmitted draft, has no default choice, and submits one
Command with the final values. It does not create a separate persisted account or
Journal setting.

The server owns every price identity. Personal and business aliases map to the
same tier allowance, with legacy direct prices retained for existing billing
history. The product tax category is a separately reviewed catalog choice; creating
candidate test fixtures does not select the owner's live legal classification.

A subscription keeps its original use. A next-period tier change takes only the
tier and derives use from the current allowed price. Legacy direct subscriptions
retain legacy prices; unknown or mixed identities require review. Canonical paid
periods record use and refuse a later period that changes it. A tier change cannot
convert a direct subscription into Managed Payments.

Each durable Checkout intent freezes price, use, merchant/tax mode, return origin,
customer/project identity, expiry and a request-format version before the provider
call. A retry must match them all. New code never reconstructs an old ambiguous
attempt from today's configuration: historical unversioned attempts wait until
their stored expiry. Version markers must change when fixed provider request
parameters change, including the integration identifier. Plan-change intents also
freeze their target price/use and request version before scheduling.

The trade-off is a bounded wait after choosing the wrong use or backing out of an
open Checkout. We retain the original intent rather than creating another payable
Session or changing parameters under an existing provider idempotency key. Opening
and closing the browser's Checkout page does not prove the Session was expired.
There is no automatic migration of historical request settings or tax category.

The shared schema/host types, encoded SDK tests, real PostgreSQL loss/retry and
renewal tests, release guards and Chromium form checks verify these boundaries.
Payment, tax, terms and merchant readiness still follow ADR 0032 and operator
acceptance, with staging supplier spending paused under #669.
