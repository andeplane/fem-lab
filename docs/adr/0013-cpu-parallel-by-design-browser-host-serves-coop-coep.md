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

## Browser implementation (#17)

The portable stable-1.94 browser and Node modules remain a matched pair. A separate
`wasm-threads` feature builds the browser-only shared-memory module with
`tools/build-wasm-threads.mjs` and pinned `nightly-2026-09-05` (`build-std=panic_abort,std`).
The build limits shared memory to the existing wasm32 4 GiB ceiling; this is a maximum,
not a reservation. Native builds and portable wasm retain the stable toolchain.

Each dedicated session Worker owns one wasm module and one wasm-bindgen-rayon pool.
The browser host selects this runtime only with cross-origin isolation and
SharedArrayBuffer, initializes the pool before any session or replacement candidate,
and reuses that pool for candidates. Changing the pool size requires a new Worker;
a mismatched constructor request is a structured schema error. Portable wasm reports
one actual thread regardless of a caller's requested count. The engine itself neither
spawns browser Workers nor reads browser capabilities. Parallel assembly, postprocessing
and fixed-partition f64 direct solves use the same Rayon algorithms as native hosts.

Chromium smoke tests cover both server COOP/COEP and headerless Pages service-worker
isolation. They compare exact Journal hashes and IEEE-754 field bytes at one and four
workers, and check an axial bar against F L / EA and force balance at 2/4/8 cells.
A headerless document without service workers exercises the portable module and its
visible single-thread note. Pool initialization failures remain explicit errors; they
do not silently claim that a requested pool exists.

Upstream build and initialization contract:
https://github.com/RReverser/wasm-bindgen-rayon/tree/v1.3.0
