---
status: accepted
date: 2026-09-06
---

# Browser hardening and threat model

Resolves the browser hardening review in #28. Extends ADR 0004 and ADR 0006 using the
portable QuickJS bridge from ADR 0015; the engine/host boundary remains ADR 0011.

Production hosted-AI credentials/account identity follow [ADR 0028](0028-hosted-ai-account-and-service-boundary.md).
The direct-provider key rules below describe the current development adapter until #554 migrates production.
Script isolation, file validation and the engine/host boundary remain unchanged.

## Trust boundaries and decisions

The static app, its bundled dependencies and origin are trusted. Pasted/generated scripts,
imported model files, and AI responses are untrusted inputs. The main page owns provider keys,
project storage and the registry; an interpreted script receives only the JSON `fem` bridge,
console output and timers. A script can issue the same exposed registry Commands as a person,
including modifying the Model. Review scripts before running them; execution is not read-only.

- Direct/development provider keys use `localStorage`, so one paste lasts across tabs and sessions in this
  browser. This ADR first scoped them to `sessionStorage`; re-pasting the key on every visit
  cost more than the tab scoping bought (#485), since same-origin app code can read either
  store and neither is an encrypted credential vault. At startup a key the session-only build
  left in `sessionStorage` is adopted once and that copy removed only after the persistent
  write succeeds; a persistent key wins. Refused persistence retains the usable tab copy
  and Settings labels it as tab-only. A refused save/forget reports a structured error.
  Forget clears both stores for the selected provider and records a provider-specific,
  non-secret marker so a second legacy tab cannot adopt the forgotten key again at boot.
  Hosted production neither reads nor migrates direct-provider credentials; any existing
  cached copies are left untouched. It uses the account/service boundary of ADR 0028.
  Model preferences and autosave keep their storage. Keys remain absent from tools, Journals
  and exports, and are sent only to the chosen provider. Development environment keys remain
  development-only. On a shared machine, forget the key from Settings before leaving.
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

Storage tests cover persistent and fallback migration, refused writes, provider-specific
forgetting, legacy-tab resurrection and hosted-mode isolation. Chromium tests exercise real
fresh tabs, reload and forgetting without calling a paid provider. Registry tests reject
oversized multi-byte input on all import routes and invalid script deadlines before execution.
Runtime tests exercise actual QuickJS heap exhaustion, absent network globals and source errors;
host tests cover termination, protocol/output limits and late RPC rejection. Chromium tests
exercise production CSP, WASM/Worker boot, script execution and failed import project retention.
