# Private durable project-object infrastructure

Tracks [#774](https://github.com/andeplane/fem-lab/issues/774), following the
[Google infrastructure baseline](563-google-infrastructure.md). This is the
infrastructure contract for the authenticated project repository; it does not
publish the API or implement browser synchronization.

## Resources and permissions

| Environment | Google project | Private bucket | Location |
| --- | --- | --- | --- |
| Staging | `femlab-app-staging` | `femlab-app-staging-projects` | `europe-west3` |
| Production | `femlab-app` | `femlab-app-projects` | `europe-west3` |

Both buckets use regional Standard storage in Frankfurt, alongside the existing
Cloud Run API and Cloud SQL database. They enforce uniform bucket-level access
and public-access prevention. There is no public grant, CORS rule, browser storage
credential, signed browser upload, retention lock, object versioning, Autoclass,
or age-based lifecycle rule. The disposable `*-exports` buckets and their one-day
deletion backstop remain separate and unchanged.

Soft deletion is explicitly disabled (`retentionDurationSeconds: 0`). Deleting
objects therefore frees physical storage without a hidden seven-day retained
copy. Accidental-deletion recovery is not provided by this configuration. The
repository retains the current committed revision, with database-driven cleanup
of superseded, abandoned and deleted objects; no bucket-wide TTL can remove live
projects. Account-deletion and recovery jobs must complete the same durable cleanup
path. A quota reservation remains charged while object cleanup is unresolved.

Each project's custom role `femlabProjectObjects` contains exactly:

```text
storage.objects.create
storage.objects.get
storage.objects.delete
```

It is bound only at that project's project-object bucket to its `femlab-api` and
`femlab-jobs` service accounts. The recovery identity needs object access for
abandoned uploads and account deletion. There is no runtime object-list, bucket
metadata/admin, IAM mutation, restore, ACL, or new signing permission. Object
metadata uses `storage.objects.get`; runtime code must not call bucket-level
`exists`/`getMetadata`. Cleanup enumerates authoritative database rows, not GCS.
Existing operator/project-administrator access is unaffected. The initial
project-level IAM inventory found no Storage role on either runtime identity.

Migration 011's seven `cloud_*` tables receive explicit
`SELECT, INSERT, UPDATE, DELETE` for `femlab_api` and `femlab_jobs`. These are UUID
keys and account-local counters, so no sequence or DDL grant is added. The service
derives account ownership from verified authentication and authorizes every row;
the shared runtime identity itself is not a separate GCS identity per customer.

## Provision and release

Run the isolated provisioner with an explicitly selected environment and account:

```sh
python3 infra/google/project-storage.py --environment staging --account <account>
python3 infra/google/project-storage.py --environment production --account <account>
```

This command touches only the named project bucket, its dedicated custom role,
and its two runtime bindings. It does not rerun authentication, billing, secrets,
database credential creation, exports configuration, or a service deployment. A
403/network failure is not treated as a missing resource. Existing buckets with
unexpected ownership, location, privacy, retention, lifecycle, versioning, CORS,
or IAM are rejected for review rather than silently reconfigured. The same rule
applies to a custom role containing more than the three reviewed permissions.
Readbacks require an explicit zero soft-delete duration; an absent field is not
assumed to mean disabled. Only the idempotent fixed-role/member bucket binding is
retried, at most three times with five-second gaps; a permanent failure still
stops provisioning without any broader permission fallback. The final output contains resource IDs and reviewed
policy metadata, never credentials or object names.

`release-service.py` performs the shared read-only project-bucket/IAM preflight
after confirming the build succeeded and before any runtime release. A mismatch
stops before deploying Cloud Run, changing traffic/Scheduler, or reading runtime
secrets. A successful release passes the same explicit values to API and recovery:

```text
PROJECT_BUCKET=<environment-project>-projects
PROJECT_STORAGE_GLOBAL_BYTES=100000000000
```

The physical cap is 100 decimal GB per environment across committed bytes,
pending reservations and failed-cleanup exposure. Per-account quotas are decimal:
Free 100,000,000 bytes, Plus 2,000,000,000, Pro 10,000,000,000 and Studio
50,000,000,000. GCS bills actual GiB-hours separately: 100 decimal GB is about
93.13 GiB. The initial cap therefore bounds steady stored data to about 93.13 GiB
per environment (186.26 GiB combined), provided repository accounting is enforced.
Creating a bucket does not reserve that disk capacity.

Storage charges equal the actual average GiB stored multiplied by the current
Frankfurt Standard rate. The official pricing table, with Frankfurt selected on
2026-10-16, lists $0.000031507 per GiB-hour. At full 100 GB capacity for a 730-hour
planning month, that is about $2.14 per environment, or $4.28 combined for stored
bytes alone; an actual calendar month's hours and billing currency can differ.
Operations and network are additional; a byte quota is not an overall Google
billing cap. Regional Standard lists $0.005 per 1,000 Class A
operations and $0.0004 per 1,000 Class B operations in USD. Standard has no minimum
storage duration or retrieval fee. Inbound transfer is free; browser downloads
through the authenticated API also incur applicable Cloud Run/network costs.
Existing project budget alerts remain alerts, not enforcement. Check current
region/currency pricing before changing the cap or promising a total bill.

Before release, apply the additive migration and explicit runtime grants through
the normal migration path. After the coordinated service release, use an existing
legitimate owned account/artifact to verify authenticated upload/read/delete and
quota accounting, and verify cross-account denial without creating fake
production accounts. Operator metadata/IAM checks alone do not establish runtime
object access or endpoint authorization.

## Verification and rollback

```sh
python3 -m unittest discover -s infra/google -p 'test_*.py' -v
python3 -m unittest discover -s infra/stripe -p 'test_*.py' -v
git diff --check
```

The guards cover private creation, safe existing resources, non-404 failures,
retention/expiry and public-policy rejection, exact object permissions, recovery
identity inclusion, read-only release preflight, preserved billing bindings, and
runtime grants for every project table. They use fake boundaries, not cloud writes.

Roll back a service through a compatible previously healthy immutable revision
and its recorded traffic map. Keep both project buckets and migration 011 data;
never delete a bucket or down-migrate customer metadata as an application rollback.
If provisioning stops after creating a bucket, fix the reported policy mismatch
under review and rerun the isolated command. Do not attach the export lifecycle or
grant `storage.admin` to work around a failed runtime request.

## Provisioned snapshot: 2026-10-16

Both isolated provisioners completed under the selected operator account. The
independent readback at 07:51 UTC confirmed both named buckets in `EUROPE-WEST3`,
Standard class, enforced public-access prevention and enabled uniform access.
Both report explicit `softDeletePolicy.retentionDurationSeconds: "0"`; lifecycle,
versioning, retention and CORS configuration are absent. Their GA custom roles
contain only the three reviewed object permissions, with API and recovery bound
only at their own project bucket. Neither runtime received a project-level Storage
role. Anonymous bucket requests returned HTTP 403, and the real read-only release
preflight passed for both environments. Both actual Cloud SQL instances also
report `europe-west3`.

The first binding attempt after each new custom-role creation failed; the same
binding succeeded on retry, and the full idempotent provisioner then completed.
No broader role was substituted. This snapshot proves resource configuration and
anonymous denial. No object upload or service rollout was performed, and actual
authenticated repository/recovery acceptance remains part of the coordinated
backend release.

Primary references:
[Cloud Storage IAM roles](https://docs.cloud.google.com/storage/docs/access-control/iam-roles),
[public-access prevention](https://docs.cloud.google.com/storage/docs/public-access-prevention),
[soft-delete behavior](https://docs.cloud.google.com/storage/docs/soft-delete),
[regional storage pricing](https://cloud.google.com/storage/pricing),
and [Standard storage](https://docs.cloud.google.com/storage/docs/storage-classes).
