---
status: proposed
date: 2026-09-05
---

# Chromium is the supported browser; others are best-effort

The browser host is developed, tested and gated against Chromium (Chrome, Edge, and the
Playwright Chromium CI lane). Firefox and Safari are not tested in CI, not gated, and not a
reason to avoid a feature. WebGPU, wasm threads with `SharedArrayBuffer`, `COEP:
credentialless`, raised adapter limits and the newest WGSL features all landed in Chromium
first and are most complete there (research note 02 §1.3), and every hour spent on a Safari
workaround is an hour not spent on the engine. The app detects missing capabilities and says
so plainly instead of degrading silently.

## Consequences

- Phase-0 gates say "in Chromium", not "in Chrome, Firefox and Safari".
- Feature detection stays: no WebGPU means the CPU path with a note; no cross-origin isolation
  means one thread with a note. The notes name the browser that would work.
- Revisit when a real user population needs Safari (an iPad classroom, say). That is a
  product decision, recorded then, not an engineering default now.
