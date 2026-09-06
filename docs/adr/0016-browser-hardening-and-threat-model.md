---
status: accepted
date: 2026-09-06
---

# Browser hardening and threat model

Resolves the browser hardening review in #28. Extends ADR 0004 and ADR 0006 using the
portable QuickJS bridge from ADR 0015; the engine/host boundary remains ADR 0011.

## Trust boundaries and decisions

The static app, its bundled dependencies and origin are trusted. Pasted/generated scripts,
imported model files, and AI responses are untrusted inputs. The main page owns provider keys,
project storage and the registry; an interpreted script receives only the JSON `fem` bridge,
console output and timers. A script can issue the same exposed registry Commands as a person,
including modifying the Model. Review scripts before running them; execution is not read-only.

- Provider keys use `sessionStorage`, scoped to the tab session. At startup, legacy keys are
  moved from `localStorage` into the session and the persistent copies are removed. A newer
  session key wins. Model preferences and autosave retain their existing storage. Browsers
  may restore tab sessions; this is not an encrypted credential vault. Same-origin app code
  can still read a session key. Keys remain absent from tools, Journals and exports, and are
  sent only to the chosen provider. Development environment keys remain development-only.
- Production HTML declares CSP before scripts: same-origin scripts and Workers, WebAssembly
  compilation through `wasm-unsafe-eval`, no JavaScript string evaluation or inline scripts,
  and connections only to the origin and the Anthropic/OpenAI API origins. Fonts are local;
  image data/blob URLs support screenshots. Inline styles remain allowed for UI presentation.
  The dev server additionally permits loopback HMR sockets. A static meta policy cannot enforce
  `frame-ancestors` or protect a compromised origin; an embedding restriction needs deployment
  response headers. See [CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP).
- Browser scripts run in QuickJS inside a disposable Worker, without browser/network globals.
  The guest heap is limited to 64 MiB and stack to 512 KiB. The execution deadline defaults to
  30 seconds and cannot exceed 30 seconds; validation has its own bounded deadline. Source is
  capped at 64,000 characters, JSON messages and aggregate console output at 1 MiB, and messages
  at 10,000. Expiry/stop closes the host RPC gate before terminating the Worker. Nested
  `script.run` is refused. This is a wall-clock bound, not CPU metering; browser and engine
  allocations lie outside the guest heap. An already admitted engine Command can finish after
  script termination and is not rolled back. Runtime vulnerabilities remain a residual risk.
- `file.open` accepts at most 16 MiB of UTF-8 JSON on every route, with picker size checked
  before reading. Paths stay inside the chosen folder; JSON syntax failures are structured.
  The browser folder-open host is still unimplemented; future folder readers must check the
  file size before reading, in addition to the shared post-read bound.
  The WASM boundary deserializes `ModelFile` before mutation, and the engine checks its format.
  Failed file imports retain the current project identity. There is no current `file.load`
  Command. Files are data, not evaluated JavaScript.

## Limits of the file review

The current engine does not prove that an imported snapshot matches its Journal or eagerly
validate all geometry semantics. Recovery replays the imported Journal, so a mismatched file
can recover to a different Model. This pre-existing integrity gap is tracked separately in
[#341](https://github.com/andeplane/fem-lab/issues/341); the byte limit does not solve it.
Model generation/meshing/solving can still request substantial engine memory and time, even
from a small valid file or script. The engine Worker remains separately cancellable.

## Verification

Session-storage tests cover migration, forgetting and refused storage. Registry tests reject
oversized multi-byte input on all import routes and invalid script deadlines before execution.
Runtime tests exercise actual QuickJS heap exhaustion, absent network globals and source errors;
host tests cover termination, protocol/output limits and late RPC rejection. Chromium tests
exercise production CSP, WASM/Worker boot, script execution and failed import project retention.
