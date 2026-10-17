# Cloud project storage API

Cloud project storage keeps private, complete project artifacts for signed-in accounts. The storage service accepts an opaque portable artifact containing the Model, Journal and any retained results, source files and completed outputs included by its host. A plain Model-and-Journal file alone does not preserve every solved result. Local modeling remains available without an account.

## Quotas and privacy

| Plan | Included project storage | Exact bytes |
| --- | --- | --- |
| Free | 100 MB | 100,000,000 |
| Plus | 2 GB | 2,000,000,000 |
| Pro | 10 GB | 10,000,000,000 |
| Studio | 50 GB | 50,000,000,000 |

MB and GB use decimal bytes. Project storage is separate from AI credits: spending an AI allowance does not remove storage. The service determines entitlement; a request cannot select its own plan. A downgrade retains project reads and deletion. Bring usage within the new quota before writing more data. Temporary uploads and content awaiting cleanup are bounded separately, so a failed upload cannot silently consume unlimited storage.

Artifacts are private in the Frankfurt region. A replaced revision becomes unavailable and its chunks are queued for deletion; this service provides the current revision, not a version-history or backup product. Incomplete uploads expire after 30 minutes. Cleanup failures retry and can temporarily limit new uploads. Account deletion freezes cloud access and waits for project content and metadata cleanup before deleting identity; it has no guaranteed immediate completion time. Infrastructure backups can retain metadata under the applicable backup policy.

## Authentication and representations

Use the configured service origin with a verified Firebase ID token in `Authorization: Bearer …`. Do not put tokens in URLs. Each route derives its account from that identity; account IDs, GCS object names and provider keys are never client selectors. JSON responses and binary downloads use `Cache-Control: no-store`.

Project metadata has `id`, `name`, string-valued `revision` and `changeVersion`, `bytes`, `updatedAt` and nullable `deletedAt`. Revisions are server-owned. Storage status has `available`, `plan`, `limitBytes`, `usedBytes`, `reservedBytes`, `pendingBytes`, `overQuota` and `maxChunkBytes`. Reading quota does not allocate a storage account or grant credits. On older/unavailable hosts, the optional account `storage` field can be absent.

Project JSON requests are limited to 1,000,000 bytes; binary chunks have the separate limit below.

The manifest is:

```json
{"format":"femlab-project/1","bytes":1234,"chunks":[{"bytes":1234,"sha256":"64 lowercase hexadecimal characters"}]}
```

All nonfinal chunks must be exactly 8,000,000 bytes; the final chunk contains 1–8,000,000 bytes. Their sum must equal `bytes`. There are at most 8,192 chunks and 50,000,000,000 artifact bytes; plan and host artifact limits can be smaller. Names have 1–200 characters. SHA-256 refers to actual chunk bytes, not Base64 text.

## Upload and commit

1. `POST /v1/projects/uploads`, with a stable `Idempotency-Key` and JSON `{name, baseRevision, manifest}`. Use `baseRevision: null` for a new server-owned project ID. To update, include `projectId` and its last string revision. The response contains `uploadId`, `projectId`, `expiresAt` and `missingChunks` indexes.
2. `PUT /v1/projects/uploads/{uploadId}/chunks/{index}` with `Content-Type: application/octet-stream` and the exact raw bytes. The server authenticates/admit-checks before buffering, then verifies declared length and SHA-256. Retry the same upload/chunk when needed; objects are immutable.
3. `POST /v1/projects/uploads/{uploadId}/commit` with `{}`. The service verifies uploaded objects, the base revision and current quota, then returns the committed project metadata. Repeating a successful commit returns its receipt.

Persist the exact artifact, upload ID, idempotency key and base revision until acknowledgment. Reusing a key for different content is a conflict. An expired/aborted upload returns `410`; start a new reservation. One project has at most one pending upload. An account has at most four pending uploads and 1,000 current/pending projects. Independent global and per-account metadata/physical limits can return a temporary capacity error; a small-byte artifact does not bypass them.

Operation keys and committed receipts remain retained even after old chunk bytes or manifest metadata are cleaned up. Replaying an old creation operation cannot create a duplicate project. An expired/aborted key remains expired; creating a new operation must be an explicit choice, not an automatic retry with a different key.

## List, download and delete

| Route | Meaning |
| --- | --- |
| `GET /v1/projects?after={changeVersion}` | Up to 100 changed projects, including deletion markers, plus `nextCursor` and storage status. Omit `after` for a full listing. |
| `GET /v1/projects/{id}` | Current project metadata and its manifest. |
| `GET /v1/projects/{id}/chunks/{index}?revision={revision}` | Raw verified bytes for that revision, as an attachment with `nosniff`. |
| `POST /v1/projects/{id}/delete` | JSON `{baseRevision}` and a stable `Idempotency-Key`; returns a deletion marker. |

Follow `nextCursor` until null. Keep the greatest returned change version for the next refresh. A deletion marker has a blank name, zero bytes and a non-null `deletedAt`. Deleted content is unavailable immediately even when physical cleanup is pending. Repeating the same delete key/body returns the original marker.

A stale base or download revision returns `409 project-conflict` with `details.project` containing only the authenticated owner's current metadata. Refresh before retrying, or save an explicit separate copy; do not silently overwrite. A cross-account or unavailable project returns `404`. Quota errors use `413 storage-quota-exceeded`; temporary storage capacity errors use `503`; request rate limits use `429`. The default per-account rate is 240 reads and 240 writes per minute, counting chunks. Existing cloud storage does not authorize AI execution.

See [projects and storage](./projects-storage.md), [accounts](./accounts-billing.md) and [import/export](./import-export.md) for host workflows and file boundaries.
