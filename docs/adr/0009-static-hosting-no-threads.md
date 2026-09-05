---
status: proposed
date: 2026-09-05
---

# The browser host is static on GitHub Pages: single-threaded wasm, no SharedArrayBuffer

The browser app is a static Vite build deployed to GitHub Pages and must run with no server.
This ADR constrains the browser host only; the Node host (ADR 0011) may use threads. GitHub Pages cannot set COOP/COEP headers, so SharedArrayBuffer and
wasm threads are unavailable without the `coi-serviceworker` reload trick. We do not take
that trick: parallelism comes from the GPU, not from wasm threads, and the CPU side stays
single-threaded (a Web Worker for the solver so the UI never blocks, but one worker). The
wasm meshers are used in their serial builds. If a mesher or a direct solver ever needs
pthreads for a demo that matters, the move is to Cloudflare Pages or Netlify `_headers`,
not to a service-worker hack on Pages.

## Consequences

- Memory budget is wasm32's 4 GiB per module plus JS heap plus GPU buffers; Memory64 is not
  relied on (Safari status unverified). Models are sized accordingly: ~1M DOF is the design
  ceiling for the browser, and J15.3 (hand off to a bigger solver) covers the rest.
- Wasm packages (Manifold, fTetWild, later Replicad) are ~8–17 MB; they load lazily, on the
  first Command that needs them, and never on the landing page.
