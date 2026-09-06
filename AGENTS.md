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
  no `window`, no renderer. It receives the GPU and clock as constructor arguments and runs
  unchanged in the browser, in Node, and in a container. Hosts own I/O and concurrency.
  (ADR 0011)
- **Dependency injection everywhere a boundary exists.** Anything that touches a device, a
  clock, randomness, storage, the network or a Worker is passed in as a typed interface, so
  every unit is testable with a fake and every fake is type-checked against the real thing.
- **Every capability is a Command or a Query in one schema-first registry**, including UI
  actions: camera moves, selection, view toggles, panel state. If a person can do it by
  clicking, an AI can do it by calling, and a test enumerates the registry against the UI.
  Commands take explicit targets; selectors are named Sets or geometric predicates. (ADR 0003)
- **The Journal is the model.** Every engine Command is appended; replay rebuilds the Model;
  export yields a script; undo pops. Interactive gestures emit one Command with final values.
  The registry is engine Commands ∪ host Commands (camera, selection, panels); the Journal holds
  engine Commands only, so view state is callable by an AI but never replayed on open.
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
- **The GPU does most of the work; the CPU work that remains is multithreaded and
  deterministic.** rayon natively, wasm-bindgen-rayon in the browser behind the
  coi-serviceworker shim Atomify uses on GitHub Pages; fixed-order reductions so any thread
  count gives bit-identical results, and tests run at 1 and N threads. (ADR 0013)

- **Chromium is the supported browser.** Develop, test and gate against Chromium; detect
  missing capabilities elsewhere and say so, never degrade silently or spend time on
  workarounds for other browsers. (ADR 0014)

## Testing

- **100 % coverage on the engine and geometry crates** is a CI threshold (lines, functions and
  regions as `cargo llvm-cov` measures them on stable; regions stand in for branches), and the
  only acceptable way to meet it is tests that would fail if the logic broke. GPU code counts
  too: it is covered by running it on the software adapter, never by excluding it. Hosts are
  thin and covered by smoke tests; `packages/registry` has 100 % vitest thresholds.
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
- **Geometry input validation is tested with a never-panics proptest**: random sketches go
  through `Sketch::check` and the free mesher, and any `Err` is a pass while a panic is a
  failure. The triangulator panics on degenerate and crossing input, so nothing reaches it
  unchecked.
- **Software adapters are for correctness, never for timing.**
- **Coverage mechanics that bite.** `cargo llvm-cov` does not merge generic or async
  instantiations across test binaries, so a crate's integration tests live in ONE
  `tests/*.rs` binary, in-source `#[cfg(test)]` tests only exercise the small pure functions
  of their own module, generic helpers take `fn` pointers rather than closures where each
  call site would otherwise be its own instantiation, and test code avoids `matches!`,
  `_ => panic!()` arms and `unwrap_or_else(|| panic!())` (their never-taken arms count).
  Unreachable code is designed out (restructure), never excluded.

## Issues are the unit of work

Everything happens through GitHub issues on `andeplane/fem-lab`; many people and agents work
here at once, and the issue tracker is the only shared view of who is doing what.

- **No work without an issue.** A bug you find, a feature you are asked for, a plan you are
  writing: file the issue first (`gh issue create`), with the symptom or the ask, the cause if
  known, and how it will be verified. Then work. Split anything that takes more than a day.
- **Take an issue by labelling it `in progress`** the moment you start (planning counts). Do
  not start on an issue that already carries the label; message its owner instead.
- **Branch and PR carry the number**: `fix/36-lazy-initialiser`, PR body ends with
  `Closes #36`. One issue per PR unless the issues are inseparable; say so in the body.
- **Finish by closing.** The PR merge closes the issue and drops the label; if the work stops,
  remove the label and comment why. Never leave an `in progress` issue silent for a day.
- **Labels mean something**: `bug`, `enhancement`; areas `engine`, `geometry`, `numerics`,
  `app`, `ux`, `ai`, `tutorials`, `ci`, `docs`; `release-blocker` for what gates a public launch;
  `in progress` as above. Add an area label to every issue you file.
- **Plans link both ways.** A plan in `docs/plans/` names the issues it covers; each of those
  issues links the plan. Reviews of a plan are comments on the issue.

## Working

- Ponytail applies to code, never to verification: fewest files, no speculative abstractions,
  and every Benchmark with a known answer gets written.
- A Command's schema doc string is the AI's tool description. Write it in the same change.
- Errors are structured: code, one-line cause, where, suggested Command.
- Record a decision as an ADR when it is hard to reverse, surprising without context, and a
  real trade-off. Update `CONTEXT.md` when a term is settled. Scan `docs/adr/` for the next
  number.
- **Commit after every feature-sized step, and often.** Work on a branch, keep each commit
  green and self-contained (code, its tests, its Benchmark, its doc string), and open a PR as a
  sequence of such commits. A day of uncommitted work is a bug.
- Stage files by name. Run the tests before claiming done; report failures with their output.
