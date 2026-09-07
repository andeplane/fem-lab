---
status: proposed
date: 2026-09-06
---

# Retained Results identify solve instances and own their solved context

Issue [#280](https://github.com/andeplane/fem-lab/issues/280) implements the first Result
comparison child of [#16](https://github.com/andeplane/fem-lab/issues/16). A Step name and an
input fingerprint cannot identify two equal-input solves, and an old field cannot be sampled
on a newly generated Mesh. The accepted comparison plan requires both problems to be resolved
before difference fields or the comparison workspace are implemented.

Each successful solve receives an opaque string Result id from an engine-local monotonic
sequence. The sequence is independent of Model and Journal identity and is never reset by
model.new, import or replay on that Engine. Those operations clear the retained records;
previous ids therefore fail explicitly rather than identifying replacement records. Ids are
scoped to one Engine instance. They are neither portable document identifiers nor hashes of
numerical values. Fresh hosts may produce the same local sequence; callers must keep ids with
the transport instance that issued them. Equal-input repeated solves remain distinct.

A record owns its Step name, solved revision, full solved Model hash, ADR0017 Result-input
fingerprint, solved Model, exact BuiltMesh and StepResult. None is subsequently updated from
the live Model. An explicit Result selector reads that record's fields, mesh and display-unit
metadata even after edits. Omitted selectors preserve the existing latest-per-Step behavior
and stale-field safeguards. Supplying both Step and Result id requires them to agree. Missing
or evicted ids return a structured error; no current geometry or newer Result is substituted.
The existing transient FrameSample type and its Rust time resolver remain the frame protocol.

The Engine retains the eight most recent successful solve records in insertion order. Reads
do not extend their lifetime. A ninth success evicts the oldest record, including its owned
mesh and metadata. Failed solves do not consume an id or evict a record. This is a bounded
record lifetime, not a claim that arbitrary input models consume a fixed number of bytes.
The catalogue reports the retention limit and per-record numeric field/history and mesh
payload sizes, with serialized Model metadata size reported separately. These measurements
must identify their scope; allocator/container overhead and temporary solve/transfer memory
are not represented as a measured process peak. Hosts can display the accounting without
claiming a complete memory guarantee.

The catalogue and selected summaries, raw fields, probes and paths are schema-first Queries.
Retention changes neither Model hashing nor Journal export/replay semantics. A saved Model
file does not include derived records. Hosts that need an old Result must keep its owning
Engine alive; persistence or configurable retention is a separate capability, not hidden I/O
inside the headless library.

Alternatives rejected: a fingerprint aliases repeated solves; a Step-keyed replacement cache
loses before/after comparisons; attaching old values to the current Mesh gives scientifically
incorrect probes; unbounded retention can silently accumulate every solve. A fixed byte cap
without accounting for all allocations would promise a bound the implementation cannot prove.

Verification belongs to #280: material and mesh changes with independent analytical fields,
equal-input repeated solves, selected old display metadata, omitted-selector compatibility,
selector mismatch, eviction and reset non-aliasing, failure transactionality, unchanged
Journal/replay hashes, and engine/geometry coverage of lines, functions and regions including
GPU paths.
