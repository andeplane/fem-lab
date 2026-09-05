---
status: proposed
date: 2026-09-05
---

# The engine is a headless TypeScript library; the browser app and a Node server are two hosts of it

The browser version ships first, but the same engine must later run on servers: batch runs,
CI benchmarks, an MCP server, and models too big for a laptop. So the engine is its own
package (`packages/engine`), with no DOM, no Babylon, no `navigator`, no `window`, and
no file system. It takes its dependencies as arguments: a WebGPU `GPU` object (from
`navigator.gpu` in the browser, from dawn.node or Deno on a server, or `null` for the CPU-only
path), a storage adapter for Model files and Plugins, and a clock. Everything the proposal
calls the registry, the Journal, the Meshers, the Solvers and the Benchmarks lives in the
engine. The browser app (`packages/app`) and a Node CLI are thin hosts that construct an
engine and wire it to a screen or a terminal. The test that enforces this is a Node import of
the engine with no polyfills, run in CI, plus a lint rule that forbids DOM and Babylon types
inside `engine/`.

## Considered options

- **One Vite app, discipline only.** This is how the existing demos are built and it holds for
  a while, then a `document` reference lands in the solver and the server story is a
  rewrite. A package boundary is cheap now and expensive later.
- **Server first.** Loses the demo, the zero-install story and the differentiator (client-side
  GPU FEA is uncontested); the browser is where the users and the owner's other demos are.
- **Two engines (browser TS, server C++/Rust).** The Blast Wall lesson at project scale: two
  implementations drift. One engine, two hosts.

## Consequences

- The same WGSL runs in both hosts because both expose the WebGPU API; the phase-0 dawn.node
  spike is therefore not only a test lane but the server GPU path.
- Concurrency is a host concern: the browser host runs the engine in a Web Worker; the Node
  host runs it on the main thread or in `worker_threads`. The engine exposes async Commands
  and progress events and knows nothing about either.
- ADR 0009's "no threads" constraint applies to the browser host only. A server host may use
  `worker_threads`, native memory and, later, a native sparse direct solver behind the same
  Solver interface.
- The Node MCP server deferred in ADR 0006 becomes trivial: it is the registry's tool
  definitions served over stdio by a 100-line host. Remote solving (browser sends a Journal,
  server returns a Result) is a protocol on top of the same two objects and is planned, not
  built, until a model needs it.
- Model files, Journals, Plugins and Results are host-independent by construction; a Journal
  recorded in the browser replays on the server byte-for-byte, and that is a test.
