---
status: accepted
date: 2026-10-14
---

# Bound the actual saved ModelFile before replacement publication

Issue [#536](https://github.com/andeplane/fem-lab/issues/536) closes a publication gap in
the private Candidate path. A converter response containing Commands can fit its input
budget while the resulting ModelFile exceeds the save/reopen budget: the file contains
both the Model and its Journal. Compact JSON is also smaller than the saved pretty JSON.
Counting an input response or a separately reconstructed Model cannot establish this bound.

`Candidate::finish` creates its existing document snapshot once, passes that complete
ModelFile to an injected `ModelFileEncoder`, and measures the returned UTF-8 text before
constructing PreparedCandidate. The host supplies the byte limit. Equality is allowed.
The prepared value retains the validated text and exposes `file_bytes()` to native writers,
which can persist those bytes without serializing again after commit. Encoding or size
failure consumes the Candidate. Hosts abandon the owner's ticket; the active Model,
Journal and producer identity remain unchanged.

The encoder is a trusted, typed host dependency. It faithfully serializes the entire
supplied ModelFile, including Model, Journal, units and metadata, with the same policy as
that host's writer. It does no I/O, replay or mutation. This keeps the engine headless
(ADRs 0011 and 0012) and avoids a second Model builder or approximate size estimator.
The callback is not a Model field, Command argument or transport-supplied function.

Existing public file formats stay unchanged. The browser uses ECMAScript
`JSON.stringify(file, null, 2)`, MCP uses that text plus one LF, and the native host uses
serde pretty JSON plus one LF. Rust and ECMAScript can emit different text for equal
numbers: `1.0` versus `1`, or exponent versus decimal notation for `1e20`. Accordingly,
WASM's finish callback receives compact transfer JSON and returns the host's actual
persisted text; the engine counts the returned UTF-8 bytes, never the transfer string.
The registry provides the shared browser/MCP formatter so publication and ordinary saves
use the same encoding and 16 MiB budget. Ordinary file saves and journal exports check
their actual text before I/O as well, including MCP's newline.

This changes the private native/WASM preparation API, not ModelFile or Journal schemas.
Command replay remains host-independent; saved whitespace and numeric spelling need not
be byte-identical across hosts. Future hosts may inject another faithful encoder and
budget. A global canonical format was considered but would unnecessarily change existing
public saves and still require a host writer contract.

Boundary tests use actual prepared files and exact UTF-8 lengths, including Unicode,
escaping, number formatting and trailing newlines. They cover under/equal/over limits,
Model-plus-Journal duplication, callback failure, consumed candidates, owner admission,
save/reopen/replay and fake I/O. Existing stale/cancelled publication fences remain in
force; successful formatting cannot authorize a stale replacement.
