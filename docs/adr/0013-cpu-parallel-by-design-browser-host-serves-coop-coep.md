---
status: proposed
date: 2026-09-05
---

# The engine is multithreaded wherever it runs on a CPU; the browser host makes itself cross-origin isolated

The GPU does most of the work (ADR 0002), but assembly, meshing, factorisation, post-processing
and the CPU fallback are real work too, and a server host with 32 cores must use them. The
engine is therefore parallel by design: data-parallel loops over elements, faces and nodes go
through rayon, with deterministic reductions (fixed-order or tree reductions, never
order-dependent atomics) so results are bit-identical at any thread count. Natively that is
just rayon. In the browser, wasm threads need `SharedArrayBuffer`, which needs the document to
be cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin` plus
`Cross-Origin-Embedder-Policy`). GitHub Pages cannot set response headers, and the owner's
Atomify already solves exactly this for a KOKKOS/pthreads LAMMPS build: ship
`coi-serviceworker` with `coepCredentialless`, register it before the app module, reload once
on first visit with a `sessionStorage` guard against loops, and have Vite set the same headers
in dev. We copy that recipe, so the browser host stays on GitHub Pages and
`wasm-bindgen-rayon` provides the thread pool. This supersedes ADR 0009's "no threads" rule;
its memory-budget consequences (wasm32 4 GiB, lazy wasm chunks, `query.cost` before solving)
still hold.

## Considered options

- **Move the browser host to Cloudflare Pages or Netlify for real headers.** Cleaner (no reload,
  no service worker), and the door stays open: the app must work identically when the headers
  come from the server and the shim finds itself unnecessary. Not required now.
- **Single-threaded browser, threaded server.** Two code paths through the same loops, and the
  browser CPU fallback (no WebGPU, small models) stays slow for no reason.
- **Threads only as Web Workers with message passing.** Copies every array; the engine's data
  model would fork between hosts.

## Consequences

- Thread count is a constructor argument of the engine like the GPU device is; tests run every
  parallel path at 1 and at N threads and assert identical output.
- WebGPU on the JS side remains single-threaded; the engine issues GPU work from one thread and
  parallelises CPU work around it.
- `COEP: credentialless` keeps cross-origin subresources (Google Fonts, CDN scripts) working
  without CORP headers; anything the wasm fetches itself stays same-origin. Chromium supports
  it; other browsers are best-effort (ADR 0014).
- If isolation fails (an old worker, a browser without support), the app runs single-threaded
  with a visible note, never a crash or a reload loop.
- The second service worker problem Atomify hit (JupyterLite owning the scope) recurs when
  phase Py brings Pyodide: fold the header logic into one worker as Atomify's
  `jupyter_coi_patch.py` does, rather than registering two.
