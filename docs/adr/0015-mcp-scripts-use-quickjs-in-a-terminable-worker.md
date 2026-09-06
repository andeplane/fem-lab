---
status: accepted
date: 2026-09-06
---

# MCP scripts run in QuickJS inside a terminable Node worker

Issue [#117](https://github.com/andeplane/fem-lab/issues/117) showed that main-thread
`new Function` gives scripts the MCP process's authority, blocks its timeout on synchronous
loops and continues issuing Commands after an asynchronous timeout. ADR 0004 already names
QuickJS as the upgrade path when scripts require isolation. This decision applies that path
to the MCP host; it does not change the browser host.

A fresh QuickJS interpreter compiled to WebAssembly evaluates each script inside a disposable
Node worker. QuickJS supplies the capability boundary: no Node references, module loader,
filesystem, environment or network APIs enter the guest. The worker supplies independent
scheduling and hard termination even when guest JavaScript or its promise jobs never yield.
The host injects the worker factory and clock through typed interfaces (ADR 0011).

The guest installs the registry's existing, self-contained `makeFemProxy` from its source.
Only JSON Commands, Queries, console output and timer requests cross the boundary. The host
validates a discriminated message schema before routing a request. Registry validation still
applies. The host export Command remains available under its existing project policy;
QuickJS isolation does not repair or strengthen that Command's filesystem checks. Recursive
`script.run` is denied so a script cannot extend its lifetime by launching another script.

## Deadline and resource semantics

The wall-clock deadline includes worker startup. The host checks it before admitting requests,
closes the gate before terminating the worker, and ignores subsequent messages and RPC replies.
A successful return also terminates the worker, so detached callbacks do not outlive a run.
Commands already admitted to the engine may finish after timeout. There is no transaction,
rollback or engine cancellation implied by script termination.

QuickJS has a 64 MiB heap and a 512 KiB stack limit. The worker's V8 old generation is limited
to 128 MiB. Messages and aggregate console output are bounded, and a run can send at most
10,000 messages. The script deadline is greater than zero and at most 30 seconds.

## Alternatives and limits

- A plain Node worker fixes scheduling but retains filesystem, environment, imports and network
  access. It is not a security sandbox.
- `node:vm` is not a security boundary. A child Node process with only its permission model also
  does not provide a portable, comprehensive deny-all I/O boundary across supported Node hosts.
- An OS sandbox could isolate native-runtime vulnerabilities too, but requires separate Linux,
  macOS and Windows policies and deployment support. That exceeds this local MCP host's scope.

This confines ordinary guest JavaScript, not exploitable bugs in QuickJS, WebAssembly, Node or
host Commands. Host engine work, already-admitted Commands and trusted Query response sizes
are outside the script heap budget. The dependency and worker must ship with the npm package.

Verification exercises the built worker in a disposable process for infinite loops, concurrent
registry responsiveness, delayed mutations, failed imports and missing I/O globals, memory and
output limits, error mapping and the shared FEM API. The real wasm engine's Model is checked
before and after timeout. V8's 100% coverage gate measures the TypeScript host bridge; guest
JavaScript is a source string executed by QuickJS and is verified by these behavioral tests,
not claimed as V8-covered code. Only the thin CLI and worker entrypoints are excluded.

Reference: [QuickJS embedding, handles and runtime limits](https://github.com/justjake/quickjs-emscripten).
