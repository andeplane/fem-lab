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
connector, not a direct database connection from the browser. Production has the separate `femlab-production` PostgreSQL 17 Enterprise instance,
`db-custom-1-3840`, regional HA, 10 GB SSD, seven daily backups and seven days of
point-in-time recovery. Both are running with no authorized public networks.

`femlab-api` uses Firebase Auth viewer and Cloud SQL client roles. It can read only
its own OpenAI/database secrets. `femlab-jobs` uses its own restricted database credential and only the Firebase
user-deletion permission. `femlab-migrate` owns the isolated migration credential.
Both API and recovery database users are removed from `cloudsqlsuperuser` and receive explicit
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


## Deployed baseline (2026-10-15)

Both service environments run source `619c395ceab2b3c48d1971dd5f734168d36f46c8`.
The browser release is `aa4455fe`, including the compact hosted tool catalogue and
the account UI fixes. Firebase configuration and API origins are environment-specific.
Service images are pinned by digest after successful Cloud Build; `/health` and
`/ready` use public Cloud Run paths (the platform reserves some `*z` paths).
Startup probes require the latest migration and configured inference/privacy seams.
All eight SQL migrations are applied in both projects; API/recovery users have no
superuser membership. Recovery runs as an authenticated job every ten minutes and
has executed successfully with its separate credential.

| Environment | Browser | API |
|---|---|---|
| Staging | https://femlab-app-staging.web.app | https://femlab-api-dhphcl4vma-ey.a.run.app |
| Production | https://femlab-app.web.app | https://femlab-api-3p4c7epl7a-ey.a.run.app |

The export buckets are regional, private, have uniform bucket-level access and
public-access prevention, disable soft deletion for disposable exports and use an
age-one-day deletion backstop. The application enforces a 24-hour link/access expiry;
the recovery job removes expired blobs. Only the recovery identity writes/deletes
objects. The API identity reads and signs via a custom `signBlob` permission on itself.
No service-account private key is created. Firebase disables client-side identity
deletion so callers cannot bypass the server's durable renewal-cancellation order.

Billing is explicitly disabled in both releases. The Stripe integration is implemented
and fixture-tested, but no live Stripe account, prices, webhook or portal is configured.
Google login is hidden until its OAuth client is configured; email-link login is enabled.
Domain ownership is awaiting confirmation, and the locked Mac currently prevents use
of the existing Cloudflare console session. Custom Hosting domains and the HTTPS API
load balancer are provisioned separately in #600/PR #601. Deployed browser/LLM/export/
deletion, long-stream, rollback and restore evidence remains tracked in #557.

## Reproduce the release

Use an explicitly selected Google account and environment for each command:

```sh
python3 infra/google/provision.py --environment staging --account <account> --billing-account <billing-account>
python3 infra/google/runtime.py --environment staging --account <account>
# Start an IAM Cloud SQL proxy on an owned local port, then build the chosen service checkout.
python3 infra/google/migrate.py --environment staging --account <account> --port <proxy-port> --source <checkout>
python3 infra/google/deploy-service.py --environment staging --account <account> --source <checkout>
# After the recorded Cloud Build is SUCCESS:
python3 infra/google/release-service.py --environment staging --account <account>
python3 infra/google/deploy-hosting.py --environment staging --account <account> --source <checkout>
```

`deploy-service.py` submits an archive of the checkout's committed revision and records
its build ID. `release-service.py` rejects incomplete builds, pins the resulting digest,
deploys an immutable named candidate at zero traffic, probes its tagged readiness URL,
executes recovery, and configures Scheduler before promoting API traffic. It records
the previous healthy traffic revisions for rollback and restores them if the final
readiness check fails. Migration-secret access is removed after recovery succeeds.
Credentials are read through gcloud/Secret Manager and never
printed. Deployment manifests in `/tmp` contain IDs, source hashes and public URLs only.
The browser build includes public Firebase metadata, never supplier/database credentials.
Repeat with `--environment production` for the isolated production project.

The procedure has completed in both environments. An intentionally unhealthy staging
candidate failed startup without receiving normal traffic; the healthy API stayed ready.
After restoring the valid service template, traffic switched between the two healthy
revisions of the current pinned image and returned to the release revision. This proves
traffic rollback mechanics, not arbitrary old-code compatibility. The initial pre-health
image returned 404 on public health and must not be used as a rollback target. Do not run
financial database down-migrations; validate image/schema compatibility and paired browser
behavior before each future release. Billing remains deliberately disabled in this baseline
release script; live Stripe deployment configuration is a separate activation step.


## Post-cutover tagged revision audit

Tracks [#663](https://github.com/andeplane/fem-lab/issues/663), following the
[invitation-only admission cutover](645-free-ai-admission.md). A revision with 0% of
normal service traffic can still receive requests through its tag URL. Promoting the
new backend therefore does not retire every public route to old authentication,
free-grant or billing behavior. Google's [revision-tag documentation](https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration)
explicitly supports calling a tagged revision before assigning it normal traffic.

After each such cutover, inventory **every** tagged traffic entry in both environments,
including entries whose percentage is absent or zero. Keep revision names, tag URLs and
traffic percentages in the release evidence; do not filter the inventory to the latest
revision or positive traffic alone:

```sh
gcloud run services describe femlab-api --region=europe-west3 \
  --project=femlab-app-staging --account=andershaf@gmail.com \
  --format='json(status.url,status.latestReadyRevisionName,status.traffic)'
gcloud run services describe femlab-api --region=europe-west3 \
  --project=femlab-app --account=andershaf@gmail.com \
  --format='json(status.url,status.latestReadyRevisionName,status.traffic)'
```

For each retained URL, identify its owner/purpose and deployed revision. Check readiness
and rerun the cutover's authentication/admission acceptance against that URL, including
a fresh verified account without an invitation or paid entitlement: it must receive no
free grant and must be rejected before provider counting/generation. Readiness alone proves availability,
not the new admission policy. Test fixtures must use the normal durable cleanup path.
Audit additional API services/regions too if a later release introduces them.

Remove only a specifically identified, owned obsolete tag after recording the intended
traffic and rollback target. Unknown tags can belong to another active task; resolve
ownership before changing them. Do not clear all tags or automatically remove every
zero-traffic entry. The owned `domain-600` diagnostic tag was removed with:

```sh
gcloud run services update-traffic femlab-api --remove-tags=domain-600 \
  --region=europe-west3 --project=femlab-app --account=andershaf@gmail.com --quiet
```

After removal, verify the old tagged URL no longer serves, the canonical API remains
ready, and intended traffic/tag mappings are unchanged. Record evidence without
credentials, prompts or customer data.

On 2026-10-15, that named cleanup succeeded. Independent read-only verification found:

- `https://domain-600---femlab-api-3p4c7epl7a-ey.a.run.app/ready` returned HTTP 404.
- `https://api.femlab.app/ready` returned HTTP 200 with `status=ready`.
- Production's only remaining tag was `release-candidate`, mapped to
  `femlab-api-r17d568be-bfc38d40` with 100% of normal traffic; its tagged `/ready` returned
  HTTP 200. Staging's only tag was also `release-candidate`, mapped to
  `femlab-api-r1723d1eb-e4876371` with 100% traffic and HTTP 200 tagged readiness.

This snapshot verifies removal and routing. Admission-policy acceptance for the current
release remains tracked with #645/#556; it is not inferred from readiness responses.
