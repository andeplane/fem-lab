# 0043 — Private cloud project artifacts and revision-safe admission

Status: accepted. Issue: [#774](https://github.com/andeplane/fem-lab/issues/774).

## Context

Browser project records contain Commands and metadata; a ModelFile does not contain solved retained results or every completed output. Cloud storage must preserve a complete portable artifact without coupling the service to engine internals, exposing bucket credentials, accepting another account's selectors or charging AI credits for storage.

## Decision

The authenticated service stores opaque `femlab-project/1` artifacts as canonical 8,000,000-byte chunks with SHA-256 and size metadata. PostgreSQL owns account linkage, project IDs, monotonically increasing revisions/change cursors, current manifests, upload reservations, immutable operation receipts and cleanup intents. GCS stores immutable private objects in a dedicated Frankfurt bucket with uniform access/public-access prevention and no expiry, versioning or soft delete. The browser receives neither signed GCS capabilities nor object names.

Every project operation resolves identity and rechecks active account state. A short storage-specific PostgreSQL advisory transaction serializes quota and metadata admission across service instances. Replacing a project uses a base-revision comparison; downloads specify a revision so concurrent updates cannot splice artifact chunks. Only the current committed revision is downloadable. Older chunks become cleanup intents when replaced/deleted.

Decimal byte quotas are Free 100 MB, Plus 2 GB, Pro 10 GB and Studio 50 GB. Active paid grants determine the plan even when AI credits have been spent; free-AI approval is independent. The logical reservation is the positive replacement delta. Full staging and awaiting-cleanup bytes have a separate per-account ceiling, and the initial operator global physical ceiling includes committed, staging and failed-cleanup exposure. Neither expiry nor a failed object deletion frees physical exposure prematurely. Fixed chunk topology, bulk metadata insertion and separate row/pending limits bound tiny-object abuse below the byte ceiling.

Uploads expire after 30 minutes; five-minute writer leases cover the Node receive deadline plus bounded GCS operations. Commit verifies every uploaded generation outside the SQL transaction, then rechecks account state, revision and current entitlement under the lock. Account deletion first freezes new work, waits for project object/metadata purge, and only then deletes identity. Failures stay pending for recovery.

## Consequences

Uploading and downloading pass through authenticated service routes, adding one bounded proxy hop but avoiding browser GCS credentials, signed-upload expiry races and bucket CORS. A complete artifact's inner format is validated by its host, not by the storage service. Chunk checksums protect stored bytes; they do not certify an engineering result.

Projects do not gain unlimited version history, automatic backup restoration or remote FEM compute. Metadata/temporary limits can temporarily deny new writes while reads/deletes remain available. The API exposes quota status separately from AI credits, and storage-status failures do not disable ordinary account/billing access.

Once cloud artifacts exist, operational rollback must preserve migration 011, private project buckets and the project-aware recovery image. Older recovery code must not finalize account deletion without cloud purge. API traffic rollback and job rollback are separate decisions.
