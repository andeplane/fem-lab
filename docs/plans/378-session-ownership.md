# Session ownership and transactional replacement

Status: proposed architecture and migration plan, not implementation.
Design work: [#378](https://github.com/andeplane/fem-lab/issues/378).
Decision proposal: [ADR0020](../adr/0020-session-owned-execution.md).
Inspected baseline: `6ad6adc`; containment reviewed at PR #377 commits `a77830d` and `aeb885f`.
The initiating user report is #376. This document covers the design issue #378; implementation
steps below must receive their own issues before work begins. Implementation proceeds through separately scoped issues after design review.

## Evidence and the boundary that failed

| Source | Observation | Consequence |
| --- | --- | --- |
| [Worker transport](../../packages/app/src/worker-transport.ts), `call` | Queues one message; generation changes on Worker restart/cancel | Does not make a multi-message project replay exclusive, or distinguish Model activations |
| [Host](../../packages/app/src/host.ts), `replay` | Awaits individual `transport.dispatch` calls against the shared transport | Other callers can run between old Journal entries |
| [Projects](../../packages/app/src/projects.ts), `new`, `open`, `note` | Mutates `current` across awaits; later refresh chooses the current persistence destination | Engine state, activation and save identity have separate lifetimes |
| [Browser entry](../../packages/app/src/main.tsx), `refresh`, `viewer.onReady` | Reads Model, Journal, script, objects and Results across awaits; viewer readiness can refresh outside command dispatch | Command serialization alone does not make every publication/save a coherent snapshot |
| [Registry](../../packages/registry/src/registry.ts), `dispatch` | Validates command inputs and routes to a provider | No required session owner or execution policy |
| [Transport types](../../packages/registry/src/transport.ts), `Req`, `Res`, `EngineTransport` | Request ids identify calls; dispatch has only a Command; buffers have shape information | No owning session/version on requests, replies, progress or buffers |
| [Script host](../../packages/app/src/script-host.ts), `run`, `invoke` | A run checks activity/deadline but calls constructor-wide dispatch/query functions | Stopping a Script's output is distinct from invalidating already admitted model work |
| [Assistant](../../packages/app/src/ai/agent.ts), tool dispatch | Uses the supplied registry across an asynchronous turn | A globally rebound registry cannot preserve the turn's original model ownership |
| [MCP engine](../../packages/mcp/src/engine.ts), `handleOf` | Wraps a mutable wasm Engine directly | A browser-only queue cannot establish a shared host contract |
| [Engine](../../crates/engine/src/engine.rs), `replay`, `import_file` | Replay resets and mutates the receiver; import installs model and Journal after format checking | Candidate staging is needed; input consistency validation also depends on existing issue #341 |
| [Results](../../packages/app/src/results.ts) and [host definition reads](../../packages/app/src/host.ts) | Some local epochs/request fences already exist | Useful precedents, but no single session-wide publication rule |

Confirmed by the pre-fix Chromium regression: overlapping `project.open` and `project.new`
left the new Journal with old `geometry.addBox` and `geometry.remove` entries. The final #377
regression also covers deletion and selection/form reset. The exact timing in the user's tab
and the original unclickable-tab symptom were not recovered. The other rows expose unguarded
paths in source; they are not claims that all corresponding corruption scenarios have already
been reproduced.

A second deterministic Chromium probe against the corrected #377 build (`aeb885f`) confirmed
an additional ownership failure even after serialization. It used a manually released Promise,
not a timing sleep:

1. Create A with Body `shared`; retain `const old = window.fem` and pause an async task using it.
2. Create B with a different Body also named `shared`.
3. Release the task and execute `old.geometry.remove({ name: 'shared' })`.
4. Observe B with no Bodies and Journal Commands `model.new`, `geometry.addBox`, `geometry.remove`.

The call succeeded. This proves that a retained facade has no lifetime-bound authority and that
name reuse can turn a stale operation into silent mutation. The probe was a temporary experiment,
not a committed test asserting that incorrect behavior should remain. Turn its schedule into an
isolation regression (old call rejects, B unchanged) in implementation step 1. It does not establish
that an Assistant was running in the user's original tab.

The central mismatch is between *message serialization* and *ownership of work*. A mutex or
queue can execute a stale Command perfectly serially against the wrong Model. The design must
make that target invalid before numerical code can run.

## Proposed data structures

The following interfaces specify intended boundaries; they are not drop-in code or accepted
public names. Rust declarations are the schema source. TypeScript uses generated wire types
and opaque in-process wrappers. Branded strings help compile-time checking but runtime owners
must validate decoded messages too.

```ts
// Wire counters use decimal strings, avoiding JavaScript's integer precision limit.
type SessionRef = Readonly<{ backendEpoch: BackendEpoch; sessionId: SessionId }>;
type Stamp = Readonly<{ session: SessionRef; stateVersion: StateVersion }>;
type ExecutionContext = Readonly<{
  session: SessionRef;
  runId: RunId;
  operationId: OperationId;
}>;
type WriteRequest = Readonly<{
  context: ExecutionContext;
  expectedVersion: StateVersion;
  command: Command; // unchanged portable, unit-validated Command
}>;
type Reply<T> = Readonly<{
  context: ExecutionContext;
  outcome: { ok: true; stamp: Stamp; value: T }
    | { ok: false; error: EngineError; observed?: Stamp };
}>;

type ActiveProjectSession = Readonly<{
  lease: BoundSession;
  persistence: ProjectBinding;
  snapshot: DocumentSnapshot;
  ui: ModelUiState;
}>;
type WorkspaceState =
  | { kind: 'empty'; preferences: WorkspacePreferences }
  | { kind: 'active'; session: ActiveProjectSession; preferences: WorkspacePreferences }
  | { kind: 'preparing'; previous: ActiveProjectSession; replacement: ReplacementHandle;
      preferences: WorkspacePreferences };

type SaveJob = Readonly<{
  target: ProjectBinding; // exact id plus persistence generation, never a current-project getter
  stamp: Stamp;
  file: ModelFile; // captured immutable bytes or an immutable owned snapshot handle
}>;
```

A Rust `SessionOwner` privately owns the mutable engine state. Its externally reachable methods
accept checked execution envelopes or opaque session-bound handles. There is no `DerefMut`,
public `inner`, raw transport getter, or alternate unchecked import/replay API. Low-level
numerical tests can exercise internal functions, but browser/native/Python entry points cannot
select an ambient mutable Engine. Move or restrict the current public raw mutation API as part
of the migration; this is a real compatibility cost, not an optional cleanup.

Each owner serializes admission, identity/precondition checks and execution. A switch cannot
occur between checking a lease and using the Engine. Every engine Command has an exhaustive generated policy (normally model write, with
`model.new` routed as replacement); host definitions require a discriminated execution policy. The
registry code generator/test enumerates engine Commands and host definitions so a new capability
cannot be silently omitted from a parallel list. Workspace-only and control handlers receive
attenuated interfaces, not an unrestricted registry with an undocumented promise to avoid it.

### Versions and identity

- Session identity changes for every activation, including reopening the same saved project or
  identical Model. Backend incarnation changes on replacement runtime/recovery; old Result ids
  and old messages cannot alias fresh ones.
- StateVersion is monotonic and independent of Journal revision and physics hashes. Observable
  committed engine state changes advance it, including undo/redo and retained equal-input solves.
  A derived internal cache fill with no observable change does not need a new version.
- Writes carry a version precondition. A read-dependent edit must not silently overwrite a newer
  state in the same session. A producer advances its local version from its own successful reply
  or an explicit fresh read; it does not silently retarget/retry after conflict.
- Concurrent writes from one snapshot may therefore conflict. Canonical Scripts already await
  mutating Commands sequentially; `Promise.all` is not a promise of ordered model edits. Read-only
  parallelism remains possible against immutable snapshots.
- Hashes remain evidence of content, not authorization or lifetime. Runtime identifiers are not
  secret credentials. Remote permission checks are additional to session validity.

## Three lifetimes, with different rules

**Workspace actions** select or replace a session. They do not expose a mutable current-model
accessor to arbitrary code. A transition request names the expected active session and version.

**Finite model operations** own an exclusive execution interval through their committed snapshot.
Host I/O (file picking, downloads, plugin loading) is prepared outside that interval against a
captured lease. Admission revalidates the lease and version after the await. A host operation
needing several engine Commands must submit an explicit finite batch or use the candidate
builder; it cannot reacquire a global dispatcher between commands. A batch gives isolation, not
an undocumented all-or-nothing rollback contract. Project replacement specifically is atomic.

**Long-lived producers** (Script, Assistant turn, tutorial) hold a session-bound RunContext but
not the exclusive execution interval. Their child calls inherit the context. Cancellation
revokes the run for pending/admitted work and suppresses stale delivery; merely terminating a
Worker after it sent a message is insufficient. The owner checks cancellation at admission and
safe execution boundaries. A committed operation stays committed if cancellation arrives later;
responses distinguish committed, cancelled-before-commit and unknown outcome. For remote retry,
OperationId records the outcome or returns explicit outcome-unavailable, never blindly repeats
a possibly committed write. Operation ids are bound to a payload digest to reject reuse with a
different command. Define bounded retention and expiry instead of promising unlimited exactly-once
execution across failures.

### Preserve script semantics without ambient retargeting

`await fem.model.new(...)` in an exported Script must still work. Its binding invokes an explicit
replacement; only that run's local BoundSession advances after its own successful commit.
Existing unrelated runs are revoked. Updating the UI's active session must never update an old
Script/Assistant facade. A run attempting `model.new` after its lease has expired is rejected.
Nested child calls during transition are suspended until the initiating run has its new lease.

A browser-console `fem` object is bound: retaining `const old = window.fem` preserves the old
lease. The UI may publish a new `window.fem` object for new explicit user actions. Sandboxed
Scripts are given their private binding and cannot fetch this global object. MCP connections
and runs capture explicit sessions; a long tool call never silently follows a connection-wide
active pointer. Python receives an owned session handle, not an ambient process-global Model.

Historical `model.new` inside a portable Journal initializes the private candidate. It is not a
workspace transition command that can reach the live session owner. Validate Journal structure
and hashes in the candidate (including the Model/Journal consistency work tracked by #341).

## Transactional project opening

1. At admission, validate expected active session/version and finish the currently executing write.
   Mark the workspace preparing. Refuse new writes and concurrent replacements with a structured
   busy response; leave old-session reads and operation-specific cancellation available.
2. Resolve input and construct a private candidate using injected Engine/GPU/plugin factories.
   Replay and validate there; capture its coherent document snapshot and required resource handles.
   Never publish a partially replayed Model through the active UI or autosave.
3. Prepare an immutable host persistence binding. If creating a saved record requires I/O, keep
   its staging record invisible until ready. A failed or stale candidate cannot update an active
   project's metadata. Respect autosave-off behavior; do not silently introduce durable writes.
4. Compare the active session/version again and commit the replacement exactly once. Transfer
   ownership of the prepared candidate and its initial view value; allocate a fresh session,
   revoke old producers, and emit one activation event. The initiating replacement run receives
   its new lease explicitly. Retire old resources only after readers release their pinned handles.
5. On error/cancel/resource failure, dispose the candidate and retain the previous active value.
   Report the error on the replacement operation. Do not restore the old model by replaying it
   over a partially mutated live model.

The memory tradeoff is real: a candidate can temporarily double major engine allocations.
Refuse an oversized candidate while preserving the active session. In the browser use an isolated
candidate Worker so a wasm trap cannot poison both. Reusing a GPU resource pool is an optimization
only when ownership and result lifetimes remain explicit. Native process OOM, device loss and OS
termination are separate recovery limits; returned-error atomicity cannot guarantee unsaved-state
survival under those failures.

There is no atomic transaction across IndexedDB, an in-memory pointer and a remote service.
Separate activation commit from durable save receipts. Staging records must be recoverable or
garbage-collectable after a crash; reopening finds only complete saved records. Network failure
around a remote commit uses OperationId status lookup and expected-session CAS, not a second
unconditional open.

## Snapshots, UI state and saving

Introduce a schema-first coherent document snapshot Query: Model summary, normalized Journal,
object index and selected Result metadata are read from one engine state and stamped once.
Expensive numeric buffers are addressed by immutable pinned snapshot/Result handles, not copied
into every refresh. Account for pin lifetimes, eviction, cancellation and transferred-buffer
ownership; TypeScript `Readonly` alone does not freeze mutable typed-array contents.

The UI stores one ActiveProjectSession subtree. Responses can update it only if session,
operation/request ownership and appropriate version match. Errors and progress use the same
check as success. A stale response may be retained in its original operation log but cannot
replace the new project's error card or geometry. Selection and forms belong inside the subtree;
theme, panel sizes and other workspace preferences stay outside. This removes cross-model reset
lists rather than maintaining a larger list in main.tsx.

A refresh never schedules an autosave by reading ambient currentProject after several awaits.
SaveJob captures one immutable file and persistence target. Writes compare a per-project
persistence generation and version. Deletion advances a tombstone/generation so a delayed save
cannot resurrect the project. Reopening the same ProjectId gives a new persistence activation;
old saves may not supersede its newer state. A save completion changes only the matching
session/version's save indicator. Tests must examine durable bytes, not just green UI badges.

## Verification as invariants

Use a deterministic scheduler with controllable Engine, Worker, storage, clock and provider
fakes. Model-check bounded schedules and add fast-check/proptest action sequences. No sleeps
should decide whether the race occurs. Include instrumentation/decorators of public dispatch,
snapshot saves that must not block later edits, and candidate/base integration tests: the initial
#377 full CI exposed recursive facade decoration and an overbroad save queue that focused tests
had missed. Trace the operation/session/version and storage target
at each boundary; do not log project contents or credentials by default.

| Adversarial schedule | Required outcome |
| --- | --- |
| Pause old replay after adding `brick_shaft`; request new Model; resume old delete | Active new Model and Journal receive no old command; old context is rejected or stays private in candidate |
| Same Body name exists in both Models | Old delete cannot silently remove the new Body |
| Open two identical files; reopen same ProjectId; undo/redo back to same revision | Old lease still fails; no hash/revision/ProjectId ABA alias |
| Assistant network response or Script timer arrives after replacement | Child dispatch rejected before engine mutation; no new-session error/UI pollution |
| A Script intentionally creates a Model and continues | Only its own facade advances; subsequent awaited commands work; other old producers fail |
| Queued request was valid at enqueue but not at execution | Owner rejects it at execution with no engine or storage mutation |
| Stop a run after it has posted work; deliver that work later | No uncommitted work runs after revocation; already committed work is reported accurately |
| Late error/progress, geometry buffer or form definition arrives | Old session cannot publish into new subtree |
| UI readiness refresh overlaps replacement/solve | Every displayed Model/Journal/Result set has one coherent stamp |
| Fail each replay/import/plugin/snapshot preparation step | Old active engine, Journal, saved baseline and UI remain intact; candidate resources released |
| Delayed save across switch, same-project reopen or delete | Only captured target can be written; newer activation not overwritten; deletion not resurrected |
| Worker restart / reconnect reuses local request/result numbers | BackendEpoch prevents alias; old messages discarded; explicit reacquisition required |
| Nested Script child write while another operation runs; concurrent cancel | No deadlock, no unbounded control starvation, context inherited rather than rebound |
| Lost remote acknowledgement and retry | Same operation returns recorded outcome or explicit uncertainty; no duplicate blind write |
| Unknown/unclassified host command, malformed token or raw API import | Registration/type/runtime check rejects; no default execution against active Model |

Measure the invariant with a reference model of sessions, versions, operations and captured save
jobs, not by reimplementing FEM kernels. Existing analytical/NAFEMS/numerical tests still verify
physics. Run the same behavioral contract through native Rust, Worker/Chromium, MCP and Python
when present, plus future remote transport with reordered/delayed messages. Retain the #377
regression throughout migration. Add compile-fail/TypeScript negative tests for forbidden raw
access and CI registry enumeration; runtime tests deliberately forge stale/foreign wire tokens.

## Migration, each step gated before the next

Create bounded implementation issues for these steps after design review. Split a step further
if implementation would take more than a day; this design issue is not a multi-week coding claim.

1. **Contract and test harness.** Define Rust/schema execution envelopes, stamp semantics,
   structured errors, registry policy union and deterministic ownership reference model. Generate
   TS types; establish negative tests. No runtime safety claim while compatibility routes exist.
2. **Rust ownership boundary.** Introduce SessionOwner, fresh identities, atomic admission/version
   checks, coherent snapshot construction and operation cancellation/outcomes. Move raw mutators
   behind the owner and migrate native/wasm entry points and their tests. Preserve Journal bytes.
3. **Transactional replacement.** Candidate preparation/validation and single activation commit,
   resource-failure cleanup, explicit model.new initiating-run transition. Integrate #341's input
   consistency contract without duplicating its owner. Test failures at every transition edge.
4. **Browser state and persistence.** Bound session facade, ActiveProjectSession subtree, stamped
   reply reducers, immutable SaveJobs, per-project generations/tombstones and coherent refresh.
   Remove ambient current lookups and manual reset/serialization lists only when parity passes.
5. **All producers and hosts.** Bind Script/Assistant/tutorial/MCP run lifetimes and control traffic;
   enforce inherited context, explicit reacquisition and scope-aware recovery. Migrate Python when
   introduced and prohibit tokenless remote defaults. Test nested calls and delayed callbacks.
6. **Enforcement audit and rollout.** Enumerate every mutation/read/publication/storage entry point,
   run adversarial schedules through all available hosts, and delete transitional raw adapters.
   Only then mark ADR0020 implemented. Keep limitations about explicit reacquisition and process
   failures in the public contract; do not claim that arbitrary bugs become impossible.

Steps 2–5 may require temporary adapters to keep builds green, but their removal is a release
gate. Do not ship a feature claiming session isolation on a path that still accepts unbound
mutations. Schema/tool documentation changes and host smoke tests ship with each capability.
Engine coverage stays at the repository thresholds. No numerical Benchmark is added for this
non-numerical refactor; existing replay hash and physics suites must remain unchanged and green.

## Design review questions

The recommended choices above are concrete, but remain proposed: reject concurrent replacement
rather than silently superseding; use candidate ownership rather than rollback-in-place; make
write version preconditions explicit; isolate candidate Workers in the browser; and remove raw
Engine mutation access at the end of migration. Review API compatibility and large-model memory
cost before adopting the ADR. A useful first implementation spike is the stale-delete/same-name
case through a checked native and Worker owner, followed by Script model.new compatibility.
