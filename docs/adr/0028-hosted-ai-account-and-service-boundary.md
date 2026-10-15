---
status: accepted
date: 2026-10-14
---

# Hosted AI uses account identity and a metered service; tool execution stays with the host

The user has authorized implementation of the hosted-AI plan (#545, #546–#557),
with femlab.app as the public domain, Cloudflare registration/DNS and Google Cloud
hosting. This supersedes ADR 0006's production browser-key/no-service decision.
The headless Rust engine and its registry/Journal boundary remain ADR 0011/0012.

Production modeling remains available anonymously. The built-in Assistant requires
a verified account and calls a TypeScript service through `/v1/ai/completions`.
Firebase Authentication supplies identity. Cloud SQL/Postgres owns entitlements,
versioned credit grants, reservations, immutable usage entries and Stripe mapping.
Provider credentials are server secrets, absent from browser bundles and Model files.
Cloud Run owns requests; scheduled Jobs reconcile durable work. Cloudflare owns DNS;
Google Hosting serves the static app. Long AI streams use the API origin directly.

The shared `@femlab/ai` package declares provider-neutral message/event types,
versioned strict request/error schemas and the existing injected Responses adapter.
The browser and service use one copy of that adapter. Completed tool proposals and
opaque reasoning continuation retain their existing semantics. The browser executes
tools through its registry and SessionOwner gate; the service never executes scripts
or changes an engine Model. Host account/billing actions are callable Commands, but
never Journal entries or Assistant tools carrying credentials/purchase authority.

Assistant tool dispatch checks both the supplied turn allowlist and the registry's
tool flag. Proposed arguments cannot replace a trusted `cmd`/`query` discriminator.
Browser script RPC rejects `account.*`, `billing.*`, `query.account` and credential
changes before they reach the host. These remain callable through explicit user
UI/console Commands, without granting a generated program account authority (#571).

Every provider round is authenticated, admitted against an atomic maximum-cost
reservation and settled from provider usage. Client balances/tiers are untrusted.
Canceled or interrupted streams without confirmed usage remain recoverable pending
requests; they are not automatically free. Server caps include outstanding holds and
unknown supplier costs. A paid subscription adds usage, not privileged physics.

## Trade-offs

Keeping browser tool execution preserves local GPU work, scoped files and the existing
Session semantics. It also means local model/context data selected for a turn goes
through our service to the provider. The first-use disclosure must say so. No transcript
archive is introduced. External agents can still operate the public registry with their
own models; the account gate covers our hosted service and built-in Assistant.

Postgres transactions cost a persistent database instance, but make identity, period
grants, duplicate invoices and reservation locking explicit and independently testable.
Cloud Storage serves private exports/future opt-in file storage, not financial balances.
Cloud Run autoscaling requires database-backed limits and durable reconciliation,
rather than in-memory counters or post-response background work.

Direct provider constructors remain explicit development adapters until the production
hosted path lands in #554. The service foundation is live but returns unavailable
readiness until its actual identity/database/provider dependencies are configured.

## Verification

Strict schema tests reject client identity, prices and arbitrary upstream behavior;
shared adapter fixtures preserve images, complete calls and opaque continuation,
and distinguish canceled/failed/truncated streams. HTTP smoke uses injected IDs,
clock and readiness without an engine or browser globals. Later issues must prove
database races, payment lifecycle, Chromium login/isolation, live streaming and cost.
