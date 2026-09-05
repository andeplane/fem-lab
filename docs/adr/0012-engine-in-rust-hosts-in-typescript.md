---
status: proposed
date: 2026-09-05
---

# The engine is written in Rust; the hosts in TypeScript

ADR 0001 chose TypeScript for the engine when the goal was a browser demo. Three requirements
added the same day change the answer: the engine must run headless on servers and eventually
as a paid backend, it must have a first-class Python environment, and it must host wasm
Plugins. Rust serves all three from one codebase: native on the server (threads via rayon,
memory beyond wasm32's 4 GiB, native wgpu on Vulkan/Metal, faer's supernodal sparse direct
solvers) and wasm + WebGPU in the browser through the same wgpu API; `pip install femlab`
through PyO3/maturin with no RPC; and wasmtime to host Plugins natively on the server. The
CPU-side speed gain over TypeScript (1.0–1.8× measured, note 02) was never the argument; the
server, Python and plugin stories are. Hosts stay TypeScript: the browser app, its UI Commands
(camera, selection, panels), the Node CLI and the MCP server, because that is where the DOM,
Babylon and the MCP SDK live.

## How the registry spans two languages

Commands are declared once in Rust with `serde` + `schemars`; the build emits JSON Schema and
generated TypeScript types, and the TypeScript registry imports them as one provider next to
the UI-side Commands. There is still exactly one registry and one Journal; the wasm–JS
boundary carries serialised Commands and typed-array views of Results. WGSL stays in `.wgsl`
files included with `include_str!` and shared with the static validator.

## Considered options

- **TypeScript engine (ADR 0001's choice).** Simplest for a browser-only demo. The server host
  is then Node with dawn.node, single-threaded CPU, and Python must go over RPC. Workable, but
  every later requirement fights it.
- **C++ with Emscripten.** Same reach as Rust with a weaker wasm and WebGPU toolchain and no
  PyO3-grade Python story.
- **Rust everywhere including the UI (Leptos/Yew).** Loses Babylon and the mature TS UI
  ecosystem for nothing the engine needs.

## Consequences

- Two languages in the repo, with the boundary at the registry. Coverage is `cargo llvm-cov`
  at 100 % on the engine crate and vitest at 100 % on the TS registry glue; hosts are smoke
  tested.
- GPU kernel tests run natively with wgpu on Mesa lavapipe, as wgpu's own CI does; the browser
  lane with SwiftShader remains for the app.
- wasm bundle of the engine is expected at 1–3 MB; it loads lazily after the landing page.
- Phase 0 grows a spike: the same WGSL kernel dispatched from the Rust engine natively and
  from the wasm build in a browser, bit-identical results, before any solver code is written.
- Plugins in the browser are wasm modules instantiated by the TS host and called through
  imports the Rust engine declares; on the server the Rust host instantiates them directly.
  The ABI (ADR 0010) is the same in both.
- ADR 0001's decision to build our own engine rather than port one stands; only its language
  paragraph is superseded by this ADR.
