---
status: proposed
date: 2026-09-07
---

# Model work owns a session; replacement publishes a prepared session

Design issue: [#378](https://github.com/andeplane/fem-lab/issues/378).
Implementation and verification plan: [session ownership](../plans/378-session-ownership.md).
This proposal is not an implemented guarantee. PR [#377](https://github.com/andeplane/fem-lab/pull/377)
is immediate containment for the interleaving reproduced in #376.

## Problem

An explicit Body name is not a complete execution target when asynchronous callers share an
implicit current Engine. The Worker queues messages, but opening a project replays multiple
messages. Another reset can run between them. A regression produced a new Journal containing
an old project's add/remove Commands. A later deterministic probe against corrected #377 retained an old facade, switched to a new
project with the same Body name, and successfully deleted the new Body using the old facade.
The original unclickable-tab incident is still unconfirmed.

A queue around whole operations reduces interleavings but cannot reject the *next* Command an
old Script or Assistant turn sends after a project switch. It also does not make a failed replay
transactional or make separately read Model/Journal/Result state coherent. Rust's exclusive
borrow protects an individual Engine call, not the semantic lifetime of its asynchronous caller.

## Proposed decision

Keep the headless Rust Engine and TypeScript hosts of ADR0012. Strengthen their execution
boundary: a host-neutral Rust session owner holds the mutable Engine privately, and the
schema-generated transport addresses that owner. Hosts own scheduling, Workers, persistence,
GPU factories and clocks; the session owner has no I/O or thread creation. The eventual public
mutation surface must have no tokenless Engine dispatch/replay/import escape hatch. Merely
adding a checked wrapper alongside an exported unchecked route is not completion.

The data model distinguishes the following identities:

| Identity | Meaning | Lifetime |
| --- | --- | --- |
| `BackendEpoch` | An issuing runtime incarnation, supplied by its host | Changes on restart/reconnect to a replacement runtime |
| `SessionId` | One activation of one Model, scoped by backend | Fresh on every new/open/import, even for identical files |
| `StateVersion` | Monotonic committed observable engine state | Advances for committed state changes, including undo/redo and equal-input solves; never equals Journal length by definition |
| `RunId` | One producer, such as an Assistant turn or Script | Revocable; child work inherits its session and cancellation |
| `OperationId` | One finite operation | Used for ordering, cancellation, tracing and remote outcome lookup |
| `ProjectId` | A persistence destination in the host | Independent of all engine identities; reopening it creates a new session |

These are runtime identities, not physics hashes. Neither a Model hash nor a revision prevents
ABA: different sessions can contain the same bytes and undo can revisit a revision. ADR0017's
validity fingerprint and ADR0018's Result ids retain their distinct meanings. Retained Result
handles also carry their owning session/backend; a new Engine may reuse an engine-local id.
Identity sources are injected and must not reuse an epoch/session pair. IDs are not authorization
secrets: a remote host still authenticates callers and checks access.

Every operation receives a session-bound execution context. UI gestures capture it when the
gesture starts, not after an await or when a queued call runs. Scripts and Assistant turns
receive a private bound facade for their entire run. A nested call inherits its parent's context.
No host default silently replaces a missing or expired session with the active one. Validate the
context at execution, under exclusive ownership, not merely when enqueuing it. Tag successful
replies, errors, progress and bulk buffers with their context as well.

The registry declares an exhaustive execution policy alongside each schema: model read, model
write, workspace-only, replacement, producer, or operation control. Registration requires that
policy; an unclassified capability cannot run. Handlers receive only the interfaces their policy
permits. Workspace-only handlers cannot obtain a mutable Engine. The browser list in #377 is
removed only after all entry points use this contract. Producers do not hold an exclusive lane
while waiting for their own child Commands; finite writes and replacement commits do. Controls
address the exact operation and bypass its work queue, not its identity checks.

## Replacement is a state transition

A replacement is a workspace Command with an expected active session and a private candidate:

```
Active(S) -> Preparing(S, candidate, operation) -> Active(T)
                         |
                         +-- error/cancel/conflict -> Active(S)
```

The owner orders the transition after an already executing write. During preparation, old
session reads may continue, while new writes receive `session.transitioning`; other replacement
requests receive a structured busy error. A second request is not silently rebound or retried.
The UI can expose progress and cancellation, then issue a new request. This conservative policy
makes the ordering explicit; a future latest-request-wins policy requires a separate contract.

Replay, import validation, plugin resolution and initial coherent snapshot construction happen
against the private candidate. Only a fully prepared candidate can be committed. Commit compares
the expected active session and version, swaps the owner, creates a fresh session, and revokes
old producer/write contexts. A stale candidate cannot replace a newer session. No operation
against S is forwarded to T, including one targeting a Body with the same name in both.

The host replaces one `ActiveProjectSession` value containing the bound engine facade,
persistence binding, view snapshot and model-dependent UI state. Preferences such as theme and
panel widths live outside it. Model selection, forms, picking state, pending model queries and
Result references live inside it. This replaces an ever-growing reset checklist.

Returned validation/resource failures leave S intact. Holding both candidates costs memory;
fail preparation instead of destroying S to make room. Browser preparation should use a separate
Worker so a candidate wasm trap does not poison the old Engine. This is not a promise that an
OS/process crash preserves unsaved state. Host recovery and durable saves retain their separate
failure contract. Remote switching and persistence are also not one distributed transaction.

## Reads, publication and persistence

Publish a coherent snapshot from one committed session/version, rather than assembling an
apparent snapshot from separately awaited reads. Large fields use immutable, explicitly pinned
snapshot/Result handles and the same stamp. A missing or evicted handle is an error, never a
fallback to current geometry. UI reducers accept only responses for the session and request
that still own the destination, including error and progress responses.

An autosave is an immutable captured tuple `(projectId, persistenceGeneration, session, version,
ModelFile)`. It never reads a mutable `currentProject` pointer when a delayed write completes.
Per-project ordered writes and deletion tombstones prevent old saves from overwriting newer
ones or resurrecting deleted projects. A stale completion may finish saving its original project
when permitted, but cannot mark another project's UI as saved. Old activation saves cannot
supersede a newer activation of the same ProjectId. Storage acknowledgement identifies the exact
captured version; it does not retroactively change what a snapshot contains.

## Compatibility and limits

Commands and Quantities inside Journals remain unchanged. Session/run/version metadata lives in
the execution envelope, not the Journal, file hash or deterministic replay inputs. Journal replay
has a private candidate-building interface; its historical `model.new` cannot reset the live owner.

A run that intentionally calls `fem.model.new` needs an explicit successful transition: only that
run's local facade advances to the returned lease; other runs remain revoked. Failure leaves its
binding unchanged. Publishing a new UI session never updates an existing Script's facade. Raw
Engine-level `model.new` is not available as a way around the replacement owner. Python and MCP
must implement the same boundary before we claim host parity; TS branding alone is insufficient.

The guarantee is narrow and enforceable: through supported interfaces, stale work cannot mutate
or publish into a different session under any scheduling order. It does not prevent a caller
that explicitly acquires a new session from issuing a semantically wrong Command, numerical
bugs, arbitrary code bypassing the trusted host, or process failure. Runtime ownership checks,
API visibility, exhaustive registry routing and adversarial tests must agree before this ADR can
be considered implemented.

## Alternatives

- **Only serialize all calls:** cannot distinguish a late old producer from intentional new work;
  locking an entire Script also deadlocks its child Commands and can starve cancellation.
- **Cancel promises/disable buttons:** useful UI behavior, but neither prevents already queued
  calls nor protects API, MCP or delayed callbacks. Cancellation is cooperative; ownership is checked.
- **ProjectId or Model hash as ownership:** aliases reopen, identical Models and undo; conflates
  persistence, execution lifetime and numerical identity.
- **Clone live state and roll it back on failure:** derived caches, undo, Results, plugin state and
  concurrent readers make completeness hard to establish. A private candidate has a clearer boundary.
- **One Worker per project with no owner contract:** separates memory but still allows the host to
  send old work to a mutable active Worker pointer and publish stale messages.
- **CRDT/event-sourcing rewrite:** the Journal already provides deterministic replay. The missing
  property is session ownership and transactional publication, not distributed edit merging.

## Consequences

This is a cross-host API migration, not an app-only reset refactor. It adds explicit identity and
candidate memory cost, but removes ambient model lookup, manual command allowlists and scattered
model-lifetime resets. The phased plan defines admission criteria and prevents an interim adapter
from being mistaken for the final guarantee. Do not add settled glossary definitions until this
proposal is adopted; these names are proposed implementation vocabulary.
