# Google/Firebase infrastructure baseline

Implements [#563](https://github.com/andeplane/fem-lab/issues/563), a provisioning
slice of [#556](https://github.com/andeplane/fem-lab/issues/556), following
[the hosted AI plan](545-ai-backend.md) and ADR 0028. Other launch/routing evidence
stays with #556/#557. Region: `europe-west3` (Frankfurt).

## Accounts and projects

The user authorized choosing an open personal billing account. Both projects use
the same account as Atomify and the personal Google project. CLI commands always
pass the account/project explicitly; no global gcloud defaults are changed.

| Environment | Project | Number | Firebase web app |
|---|---|---|---|
| Staging | femlab-app-staging | 772080656490 | 1:772080656490:web:ce44258d4ffc31ffa52a13 |
| Production | femlab-app | 999163219889 | 1:999163219889:web:d32a34b7d0652454fdb790 |

Both projects have Firebase and email-link sign-in enabled. Anonymous Auth and SMS
sign-in are disabled. Modeling itself remains anonymous in the app. Production
authorized domains include femlab.app/www.femlab.app and Google Hosting domains;
staging permits its Hosting domains and localhost. Google sign-in still requires
the OAuth web client ID/secret; a provider cannot be enabled with an empty client.

## Runtime and database

Staging has `femlab-staging`, PostgreSQL 17 Enterprise, `db-f1-micro`, 10 GB SSD,
one Frankfurt zone, seven retained daily backups, encrypted-only connections and
no public authorized networks. Cloud Run uses the IAM-authenticated Cloud SQL
connector, not a direct database connection from the browser. This small instance
is for verification; production must use its separate provisioned instance.

`femlab-api` uses Firebase Auth viewer and Cloud SQL client roles. It can read only
its own OpenAI/database secrets. `femlab-jobs` uses a separate migration credential.
The database API user is removed from `cloudsqlsuperuser` and receives explicit
table permissions: no DDL, financial row updates/deletes or limit changes. New
tables require an explicit privilege migration before deploying a route using them.

Secrets are regional Secret Manager resources, never repository files, browser
configuration or command-line password arguments. The service image bundles the
TypeScript service/shared seam and uses Node 22 as a non-root user. No Rust engine,
browser UI or provider key is built into that image.

## Spend and release gates

The project-scoped Google budget alert is NOK 3,000/month, at 50%, 90% and 100%
forecast spend. It is an alert, not an enforcement control. Staging's database
supplier caps are $5/day, $20/month, $1/day for free usage, $1 of outstanding
uncertain exposure and four concurrent generations. Admissions include existing
holds and conservative company losses. Production limits require explicit release
configuration and remain isolated from staging.

Apply versioned migrations before serving, then run recovery through an authenticated
Cloud Run Job and Scheduler. `store:false` avoids a provider response archive;
unrecoverable usage releases the customer hold after 24 hours while retaining the
conservative company cost. Never silently release a dispatched request on lease expiry.

Custom-domain DNS/TLS, actual proxy streams, login delivery, private exports, restore,
rollback and live Stripe activation are separate acceptance evidence. Registration
records show femlab.app registered at Cloudflare on 2026-10-14; DNS writes require
verified access to that Cloudflare zone. Stripe credentials are not available yet.
