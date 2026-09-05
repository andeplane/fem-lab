# FEM Lab: working rules

A finite-element engine as a headless library, with a browser app, a Node CLI and later a paid
backend and a Python environment as hosts. These rules hold for every change. The reasons live
in `docs/adr/`; the vocabulary in `CONTEXT.md`; the phases in `docs/PLAN.md`; the physics
tests in `docs/BENCHMARKS.md`. Read the ADR a rule cites before departing from it.

## Architecture

- **Engine in Rust, hosts in TypeScript.** The engine crate compiles natively for the server
  and Python binding and to wasm + WebGPU (wgpu) for the browser; the app, its UI Commands and
  the MCP server are TypeScript. The boundary is the registry. (ADR 0012)
- **The engine is a library and headless.** It has no screen, no file system, no `navigator`,
  no `window`, no Babylon. It receives the GPU, storage and clock as constructor arguments and
  runs unchanged in the browser, in Node, and in a container. Hosts own I/O and concurrency.
  (ADR 0011)
- **Dependency injection everywhere a boundary exists.** Anything that touches a device, a
  clock, randomness, storage, the network or a Worker is passed in as a typed interface, so
  every unit is testable with a fake and every fake is type-checked against the real thing.
- **Every capability is a Command or a Query in one schema-first registry**, including UI
  actions: camera moves, selection, view toggles, panel state. If a person can do it by
  clicking, an AI can do it by calling, and a test enumerates the registry against the UI.
  Commands take explicit targets; selectors are named Sets or geometric predicates. (ADR 0003)
- **The Journal is the model.** Every Command is appended; replay rebuilds the Model; export
  yields a script; undo pops. Interactive gestures emit one Command with final values.
- **Composable by construction.** Elements, material laws, loads, procedures (static now,
  implicit dynamics and nonlinear later), meshers and solvers each implement a fixed
  Extension Point that the built-ins also use. A new feature is a new implementation of an
  existing point, or a new point with an ADR. There is no privileged built-in path. (ADR 0010)
- **Plugins fill the same Extension Points** in TypeScript, WGSL or wasm, are loaded by a
  Command, and are recorded in the Journal by content hash. Design every point assuming its
  next implementation is written by an AI from the schema and the doc string alone.
- **Hosts are swappable, including a remote one.** The app talks to the engine through the
  registry's async RPC surface and nothing else, so pointing it at `femlab serve` on a paid
  backend is a transport change, not a UI change. Keep Results, Journals and Plugins
  host-independent; a browser Journal replays on a server byte-for-byte, and that is a test.
- **SI inside, unit strings at the boundary.** Every physical quantity in a schema is a
  `Quantity`; dimension mismatches are schema errors. (ADR 0008)
- **f64 on the CPU wraps f32 on the GPU.** Assembly, residuals, norms and factorisations are
  f64; the GPU runs the f32 operator, preconditioner and vectors. GPU assembly gathers, never
  scatters with atomics. (ADR 0002)

## Testing

- **100 % coverage on the engine** is a CI threshold (lines, branches, functions, statements),
  and the only acceptable way to meet it is tests that would fail if the logic broke. Hosts are
  thin and covered by smoke tests.
- **Every numerical capability ships with Benchmarks from `docs/BENCHMARKS.md`**: analytical
  solutions, NAFEMS and MacNeal–Harder values, patch tests, and a convergence study where a
  rate is known. A case that only passes at one mesh size is not a Benchmark. Add the case to
  `BENCHMARKS.md` in the same change.
- **Oracles are independent.** A kernel is checked against closed forms, conservation laws,
  symmetry and reference values, never against a CPU re-implementation of itself. (ADR 0007)
- **GPU kernels run in CI** on the software adapter (dawn.node or Deno with lavapipe, or
  Chromium with SwiftShader), and every WGSL string is validated statically. One shader, one
  copy, imported by the app, the tests and the validator alike.
- **Property tests** (fast-check / proptest) for invariants: replay determinism, undo
  inverses, symmetric PSD stiffness for any admissible element, `parse∘format` identity for
  units.
- **Software adapters are for correctness, never for timing.**

## Working

- Ponytail applies to code, never to verification: fewest files, no speculative abstractions,
  and every Benchmark with a known answer gets written.
- A Command's schema doc string is the AI's tool description. Write it in the same change.
- Errors are structured: code, one-line cause, where, suggested Command.
- Record a decision as an ADR when it is hard to reverse, surprising without context, and a
  real trade-off. Update `CONTEXT.md` when a term is settled. Scan `docs/adr/` for the next
  number.
- Stage files by name. Run the tests before claiming done; report failures with their output.
