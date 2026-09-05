---
status: proposed
date: 2026-09-05
---

# Scripts are TypeScript, executed in a dedicated Web Worker

The script language a person or an AI writes against the Command registry is TypeScript
(types stripped with sucrase at run time), executed in a dedicated Web Worker that holds a
typed proxy to the registry and nothing else. Not Python: Pyodide adds a 6.8 MB core plus
numpy, a second FFI surface to keep in parity with the TS registry, and the evidence that
LLMs prefer Python for FEA is really evidence that Abaqus and FEniCS are Python. Both
Anthropic ("Code execution with MCP", Nov 2025) and Cloudflare ("Code Mode", Sep 2025)
measured that LLMs do best writing TypeScript against a typed API. Not a DSL: Zoo and
Onshape each maintain a language and an LSP; that is a product in itself.

## Considered options

- **Main-thread `new Function`.** No isolation, an infinite loop freezes the editor. Fine
  for a dev console only.
- **QuickJS in wasm (Figma's choice).** Real isolation, interrupt and memory limits, ~1.3 MB.
  Not needed while every script is written by the user or by the user's own AI; the Worker
  seam is designed so QuickJS can be dropped in when scripts become shareable or untrusted.
- **SES / ShadowRealm.** ShadowRealm is still TC39 Stage 2.7 with no shipping browser; SES
  does not stop infinite loops or memory exhaustion.

## Consequences

- `worker.terminate()` is the hard timeout. Scripts see Commands and Queries through an
  async RPC, so the API is `await`-shaped from day one.
- The same TypeScript API surface is what the AI gets as `run_script`, what the Journal
  exports, and what the docs show. One vocabulary.
- Python is not excluded, it is positioned: a Pyodide environment (plan phase Py) is a
  *client* of the registry for analysis with numpy/scipy/matplotlib, with a generated Python
  binding over the same Commands and Queries. It is never a second implementation of the
  scripting core, and a Journal never depends on Python having been present.
