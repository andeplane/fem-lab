---
status: accepted
date: 2026-11-05
---

# Python is a generated registry client; notebooks are portable host files

Issue #31 requires notebook analysis and a server without another numerical implementation.
Rust's committed schema remains authoritative. `tools/codegen.mjs` now emits Python
keyword-only dataclass envelopes and named synchronous/asynchronous methods for every engine
Command and Query. Parameters omitted in Python stay absent on the wire; unit strings and
structured engine errors keep their existing meaning. Hosts validate with the same engine.

CPython uses a dependency-free HTTP client; Pyodide uses an injected asynchronous RPC. A
TypeScript Node host reuses the MCP host's checked WASM SessionEngine, with one private owner
per random capability session. It listens only on loopback and rejects browser Origin and
non-loopback Host headers. A remote notebook uses an SSH tunnel. This is a single-user
compute host, not a public authenticated service, and does not expose script execution,
provider credentials, payments, file paths or a hosted-service account. The existing Rust CLI
launches this TypeScript host as `femlab serve`, just as it launches `femlab mcp`.

Python in the browser loads a pinned Pyodide distribution and numpy only after an explicit
Python run, in a disposable Worker with a separate startup deadline and a hard execution
termination deadline. Matplotlib loads only when imported and renders via Agg to PNG. This
is an owner-authored analysis environment, not a security sandbox for arbitrary untrusted
Python: Pyodide itself can import JavaScript APIs in its Worker. AI `run_script` retains a
TypeScript-only tool schema and runtime admission check; it cannot request the Python
runtime, and nested script execution remains refused by the QuickJS host. Downloaded project source
never runs automatically on open. Credentials/account/billing/script host operations are
not admitted through the Python bridge. Scientific field values travel as transferred f64
typed buffers. Pyodide copies that binary data into its own WASM heap and numpy views the
Python memoryview; neither renderer f32 conversion nor additional JSON encoding is used.

The old Phase Py table proposed recording `script.run` in the engine Journal. That would
make headless replay depend on a Python runtime and conflicts with ADR0004 and the
architecture rule that the Journal contains only engine Commands. Instead, expanded ordinary
Commands are the authoritative replay sequence. Python source and generated plots are
captured as input/output files in the existing portable project artifact. Opening preserves
source/outputs; Run all cells is the explicit re-execution action. Python source is not an
engine capability, does not change Model hashes, and is not required to reopen a Model.

Alternative: a separate PyO3 ABI would reduce native-call overhead but introduce a second
binding/release path and would not serve browser Pyodide. Native RPC performance is adequate
for registry-sized calls; binary field transfer is the browser analysis seam. A public
multi-user server, native-GPU compute host and public package-index publishing remain release
and deployment concerns separate from this transport implementation.
