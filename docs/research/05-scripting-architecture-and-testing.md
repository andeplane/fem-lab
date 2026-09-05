# Scripting layer, command architecture, AI exposure, and CI testing of WebGPU

Research note, 2026-09-05. Primary sources where possible (official docs, GitHub repos, npm registry, PR/issue threads); every non-trivial claim has a URL in the Sources list. Versions were read from the npm registry and GitHub release APIs on 2026-09-05. The session's web-search budget ran out part-way; items that could not be verified against a primary source are marked **not verified**.

Context: a browser-only FEA editor (TypeScript, Vite 7, WebGPU, GitHub Pages, no server) where "everything is scriptable so an AI can do anything the UI can do". Repo today: root TS ~5.9 / Vite ^7; demos carry their own `vitest ^3.x` or `tsx` self-tests; CI is `ubuntu-latest`, Node 22, and runs `npm run build`, which runs every demo's build (and hence its Node self-tests). GPU kernels are checked only in the browser via `?selftest` (`demos/blast-wall/src/selftest.ts`), because headless Chrome on the runner exposes no `navigator.gpu`.

## Executive summary

1. **Script language: JavaScript/TypeScript, not Python, not a DSL.** The in-app API is a TypeScript object anyway; both Anthropic ("Code execution with MCP", Nov 2025) and Cloudflare ("Code Mode", Sep 2025) argue and measure that LLMs do best writing TypeScript against a typed API (Cloudflare: 2,500+ endpoints in ~1,000 tokens vs 1.17 M tokens as tool definitions). Pyodide costs a 6.8 MB compressed core plus numpy (~2.8 MB) and a second FFI surface to keep in parity; a KCL/FeatureScript-style language is a multi-year investment (Zoo ships a language *and* a wasm LSP). Accept TypeScript source by stripping types with `sucrase` (1.1 MB unpacked) or lazily loading `esbuild-wasm` (~10 MB wasm) only when a script actually contains TS syntax.
2. **Sandbox: a dedicated Web Worker first; QuickJS-in-wasm behind the same seam if/when untrusted third-party scripts appear.** The Worker gives a separate global with no DOM, `worker.terminate()` as a hard timeout, and postMessage RPC to the command registry. Figma's precedent is instructive: they abandoned the Realms shim after sandbox-escape bugs (Oct 2019) and now run plugins in QuickJS compiled to wasm; `quickjs-emscripten-core` + one variant is ~1.3 MB on disk and has `setInterruptHandler`, `setMemoryLimit`, `setMaxStackSize`. ShadowRealm is still TC39 Stage 2.7 (since Feb 2024) with no shipping browser verified; SES/Endo hardens intrinsics but explicitly does not stop infinite loops or memory exhaustion.
3. **Architecture: one command registry, schema-first with Zod 4.** Each command is declared once as `{ name, input: z.object(...), run }`; derive from it (i) runtime validation, (ii) JSON Schema via `z.toJSONSchema()` (draft 2020-12 default; draft-07/openapi-3.0 targets) for LLM tools, (iii) TS types, (iv) UI forms. Zod ≥4.2 also implements *Standard JSON Schema*, which the MCP TypeScript SDK (v2 branch), Vercel AI SDK 6 and others consume directly. Undo/redo: immutable document + `immer` `produceWithPatches` (inverse patches for free, 3 KB gzipped). Session = append-only command log (replayable/diffable by the AI; this is what Abaqus `.rpy`, ParaView Trace and Blender's Info editor emit); file = snapshot JSON. Skip CRDTs (Yjs/Automerge) until collaboration is a real requirement.
4. **AI exposure, in order of cost:** (a) zero-code today: expose `window.fem` (the registry) and let Claude Code drive it through **Chrome DevTools MCP** (`--autoConnect`/`--browser-url`, has `evaluate_script`, screenshots, console) or **Playwright MCP**; (b) in-page BYO-key agent calling the Anthropic Messages API directly from the browser (`dangerouslyAllowBrowser: true`, which sets `anthropic-dangerous-direct-browser-access: true`), tools = the registry's JSON Schemas **plus one `run_script` tool** (code mode); (c) a Node MCP bridge over WebSocket only if a non-browser client must reach the tab. Blender-MCP, FreeCAD-MCP and Figma's Dev Mode server all use a socket into the running app; Blender-MCP and FreeCAD-MCP both ship an unsandboxed `execute_code` tool.
5. **CI for WebGPU: three tiers.** (i) Node `vitest` with `coverage.thresholds: { 100: true }` on the pure core (mesh, assembly, schemas, command log). (ii) Static shader validation with no GPU: `naga-cli` 30.0.1 (`naga shader.wgsl`) and/or a browser test that compiles every shader and asserts `getCompilationInfo()` has no errors. (iii) Real WebGPU on `ubuntu-latest`: `@vitest/browser-playwright` + Chromium with **either** SwiftShader-Vulkan flags (`--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --use-vulkan=swiftshader --enable-unsafe-swiftshader`, verified compute readback under Playwright 1.62.1) **or** Mesa lavapipe (`apt-get install mesa-vulkan-drivers libvulkan1` + `VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json`, flags `--enable-unsafe-webgpu --enable-features=Vulkan`). Two independent 2026 reports of success and two of instability ("A valid external Instance reference no longer exists"; renderer crash after first frame), so spike it, serialize files, and start the GPU job as `continue-on-error`. Deno's WebGPU (still `--unstable-webgpu`, wgpu backend) with lavapipe is the no-browser fallback and is exactly how wgpu's own CTS CI runs on `ubuntu-24.04`.
6. **GitHub Pages:** 1 GB published-site cap, 100 GB/month soft bandwidth, 10 builds/hour soft (not with Actions), 10-minute deploy timeout, and no custom response headers. Threads/SharedArrayBuffer therefore need `coi-serviceworker` (separate same-origin file, reloads once) or a move to Cloudflare Pages / Netlify `_headers`. Not needed for a WebGPU solver; only if a wasm mesher wants pthreads.

---

## 1. Scripting language and sandbox

### 1.1 What comparable tools chose

| Tool | Script language | Where it runs | Notes |
|---|---|---|---|
| Figma plugins | JS (TS) | QuickJS compiled to wasm, on the main thread; plugin UI in a null-origin iframe with postMessage | Started on the Realms shim; switched to QuickJS in Oct 2019 after sandbox-escape vulnerabilities; "somewhat slower for certain plugins, but intrinsically more secure". iframe-only design was rejected because serializing a large document took 14+ s and forced `await` everywhere. |
| Zoo Design Studio | KCL (own functional language) | Rust/wasm interpreter in the app; geometry engine remote over WebSockets (view is a `<video>` stream) | "everything you make is really just kcl code under the hood"; hybrid point-and-click writes KCL; custom wasm LSP. Built for LLMs ("by representing geometry as text, KCL can reuse ... LLMs"). |
| Onshape | FeatureScript (own language) | Server | "types built for math in three dimensions"; the standard features (Extrude, Fillet) are themselves FeatureScript; std library is open source. |
| Blender | Python (`bpy`) | In-process, unsandboxed | Info editor "logs the executed operators as well as errors, warnings, and informational messages" — the classic macro-recording UX. |
| ParaView | Python (`paraview.simple`) | In-process | Tools > Start Trace records GUI actions as a Python script; design principle that everything in the GUI is available via Python. |
| Abaqus/CAE | Python | In-process | Writes every GUI action to `abaqus.rpy` (replay file). **Not verified** against the primary manual (paywalled); well known behaviour. |
| Observable | JS | Same-page reactive runtime (`@observablehq/runtime`) | Runtime README shows unresolved globals resolve "from the global window" — no sandbox in the runtime itself; hosting isolates notebooks by origin. |
| JupyterLite | Python | Pyodide kernel | `jupyterlite-pyodide-kernel`; deploys to GitHub Pages. |
| OpenSCAD playground | OpenSCAD language | headless OpenSCAD wasm build (Manifold backend); PWA | Hosted demo at ochafik.com/openscad2. Worker usage **not verified** from README text. |
| Replicad | JS/TS | OpenCascade.js (wasm) | Library-first; workbench execution model not documented. |
| tldraw SDK 5.x | TS (host app code) | `Editor` API: create/update/delete shapes, history, camera, events | "powers AI agents that read and edit canvases" — no end-user scripting, but a fully programmatic editor. |
| Excalidraw | none (imperative React API) | — | `@excalidraw/excalidraw` 0.18.1; no user scripting. |
| Cloudflare Code Mode | TS generated by the LLM | V8 isolate (Dynamic Worker Loader) | search()+execute(); default timeout 60 s; outbound network blocked unless a Fetcher is provided. |
| Val Town / Deno Deploy | JS/TS | V8 isolates server-side | Server-side only; not applicable to a static site. |

### 1.2 Sandbox options for JS in the browser

| Option | Isolation | Timeout / memory limits | Size | Status | Verdict |
|---|---|---|---|---|---|
| `new Function` / `eval` on main thread | none (shares globals, DOM, can freeze UI) | none | 0 | — | fine for a dev console, not for AI-generated code |
| Dedicated Web Worker + blob-URL `import()` | separate global; no DOM; still has `fetch`, IndexedDB, `importScripts` | `worker.terminate()` from the host is a hard stop; no memory cap | 0 | shipping everywhere | **recommended first step** |
| QuickJS via `quickjs-emscripten` 0.32.0 | separate engine; host chooses every exposed function | `setInterruptHandler` (+ `shouldInterruptAfterDeadline`), `setMemoryLimit`, `setMaxStackSize` | full package ~9.04 MB installed (4 wasm variants); `quickjs-emscripten-core` + `@jitl/quickjs-wasmfile-release-sync` ≈ 1.3 MB on disk (640 K variant + 588 K core); asyncify variant is ~2x the sync one | active (npm 2026-02-16; bellard/quickjs 2025-09-13) | **add behind the Worker seam when scripts become shareable/untrusted**; Figma's production choice |
| SES / Endo Compartments (`ses` 2.3.0, 4.7 MB unpacked) | same-realm; `lockdown()` freezes intrinsics, `Compartment` gives own globals | explicitly none: guests can "execute for an indefinite amount of time" and "allocate arbitrary amounts of memory" | large | active | not sufficient alone for runaway scripts; combine with a Worker if used |
| ShadowRealm | separate realm, callable boundary | none | 0 | TC39 Stage 2.7 (Feb 2024); Stage 3 gated on the list of Web APIs exposed (~50 identified by Igalia; fetch, timers, storage, canvas excluded); no shipping browser verified | not usable in 2026 |

TypeScript inside scripts: QuickJS and Workers run JS, so TS must be transpiled. `sucrase` 3.35.1 is 1.14 MB unpacked (type stripping only); `esbuild-wasm` 0.28.2 is 14.5 MB unpacked (the wasm is ~10 MB and takes noticeable time to initialise); `typescript` 5.9's `transpileModule` needs the multi-MB compiler bundle. The pragmatic choice is to *ask* the LLM for JS with JSDoc types, ship `.d.ts` of the API for humans, and lazily load `sucrase` if a pasted script fails to parse as JS.

### 1.3 Python via Pyodide

- Current release 314.0.6 (2026-08-25). Release assets: `pyodide-core` 6.76 MB (tar.bz2), full distribution 350 MB; docs: "The full distribution is quite large (200+ megabytes)". Sibling note 01 measured `pyodide.asm.wasm` 9.2 MB and the numpy wheel 2.8 MB.
- Startup time: **not found** in primary docs during this session (the docs only say loading the full stdlib "will increase the initial Pyodide load time").
- Exposing a JS API to Python is well supported: `pyodide.registerJsModule`, `from js import ...`, `JsProxy.to_py()`, `pyodide.ffi.to_js`, and `await proxy` on JS promises; the recurring pitfall is that every `PyProxy` handed to JS must be `.destroy()`ed or it leaks.
- Is Python the language LLMs write FEA scripts best in? The FEA corpus (Abaqus, FEniCS, scikit-fem) is Python, but the API here would be *our own* object model, not `dolfinx`; the evidence that matters is Cloudflare's and Anthropic's: models write reliably against a typed TypeScript API they are shown. A Python surface can be added later at ~zero design cost because it would just call the same registry through `registerJsModule`.

### 1.4 A DSL / declarative model

A JSON (or YAML) document *is* the model file either way; the question is whether the scripting layer should be a bespoke language. KCL and FeatureScript show the upside (source of truth is text, versionable, parametric, LLM-friendly) and the cost (a parser, interpreter, LSP, and years of language design). OpenSCAD's language exists but its ecosystem is CSG, not FEA. Recommendation: JSON document + JS scripting + a *recorded command log* gives the "text is the source of truth" property for free without inventing a language.

---

## 2. "UI == API": command registry, schema-first, undo, event log

### 2.1 Command pattern

- Every UI control dispatches `registry.run(name, params)`; nothing touches the document directly. This is the ParaView/Blender/Abaqus discipline that makes trace/replay possible (ParaView: "all your actions (or at least those relevant for scripting) are monitored"; Blender's Info editor logs operators).
- Macro recording is then trivial: the log of `{name, params}` *is* the script. Emit it as `await fem.<name>(params)` lines so a user can paste it back into the console, and as JSON so the AI can diff two sessions.
- Undo: with an immutable document, `immer`'s `produceWithPatches` returns forward and inverse patches, so no per-command inverse needs to be hand-written (immer 11.1.18, ~3 KB gzipped, "first class support for JSON patches"). Blender's design confirms the trade-offs: it keeps a single stack of steps that are either *stateful* (full snapshots, `memfile_undo`) or *differential*, the stack is "fully relative" (to reach a step you replay the ones in between), steps are created by operators, and "UI changes are not" stored.
- Snapshot vs event-sourced: keep both. The **session** is the append-only command log (replayable; a script that reproduces the state; diffable by an LLM). The **file** is a snapshot (fast load, no replay of long histories). Checkpoint snapshots every N commands bound replay time. Blender's relative stack is what you get if you keep only the log.
- CRDTs: Yjs 13.6.32 and Automerge 3.4.1 are mature, but they solve multi-writer merge; a single-user editor with an AI co-pilot does not need them. YAGNI until collaboration is scheduled.

### 2.2 Schema library

| Library (npm version on 2026-09-05) | JSON Schema export | Standard Schema / Standard JSON Schema | Notes |
|---|---|---|---|
| **zod 4.5.4** | built in: `z.toJSONSchema(schema, { target })`, default draft 2020-12; draft-07, draft-4, openapi-3.0; `.meta({ title, description, examples })` flows through; `unrepresentable: "throw" \| "any"`; experimental `z.fromJSONSchema` | yes (Standard JSON Schema since v4.2) | 14x faster parsing and 57% smaller core than v3 per release notes; the mainstream choice |
| @sinclair/typebox 1.0.0 | types *are* JSON Schema objects (no conversion) | not listed on standardschema.dev | JIT validator, draft 3 → 2020-12; strongest if JSON Schema itself is the source of truth |
| arktype 2.2.3 | `toJsonSchema()` (page 404'd during this session; **not re-verified**) | Standard JSON Schema since 2.1.28 | fastest runtime validation claims |
| effect 3.22.1 (Schema) | `JSONSchema.make`, default draft-07; 2019-09, 2020-12, openapi-3.1 targets; stops at first transformation | not listed | heavy unless already using Effect |
| valibot 1.4.2 | `@valibot/to-json-schema` | Standard JSON Schema since 1.2 | smallest bundles |

Consumers that accept these schemas directly:

- **MCP TypeScript SDK**: npm 1.30.0 (2026-07-27); the `main` branch is v2 targeting the 2026-07-28 spec and says "Tool and prompt schemas use Standard Schema — bring Zod v4, Valibot, ArkType, or any compatible library"; `server.registerTool(name, { description, inputSchema: z.object(...) }, handler)`. History: 1.17.x was incompatible with Zod 4 (issues #555, #906, #1429); fixed via a compatibility layer that detects the Zod version.
- **Vercel AI SDK** `ai` 7.0.93: `tool({ inputSchema: z.object(...), execute })`; `@ai-sdk/provider-utils` peer-depends on `zod ^3.25.76 || ^4.1.8` and `@standard-schema/spec ^1.1.0`; AI SDK 6 (Dec 22, 2025) accepts "any library implementing the Standard JSON Schema V1 specification".
- **Anthropic TypeScript SDK** 0.124.0: `betaZodTool({ name, inputSchema: z.object(...), run })` and `client.beta.messages.toolRunner(...)` run the tool loop for you; also a `mcp_servers` request parameter for remote MCP servers.

So one Zod 4 declaration per command yields validation, JSON Schema for any of the three LLM stacks, inferred TS types, and enough metadata (`.meta().description`, enums, min/max) to auto-render a form.

---

## 3. Exposing the app to an AI

### 3.1 Patterns and precedents

| Precedent | Transport | Tool shape |
|---|---|---|
| Blender-MCP (ahujasid, ~27 k stars) | addon opens a TCP socket on localhost:9876; MCP server relays JSON | structured tools *plus* `execute_blender_code` = arbitrary Python via `exec()` with "no sandboxing, validation, or restriction" (issue #207) |
| FreeCAD-MCP (neka-nat) | workbench hosts XML-RPC on localhost:9875; FastMCP server over stdio | structured tools plus `execute_code` with a persistent namespace; GUI work marshalled onto the main thread via a task queue |
| Figma Dev Mode MCP (June 4, 2025) | desktop app hosts `http://localhost:3845/mcp` (+ `/assets`); remote `https://mcp.figma.com/mcp` | read-mostly design context tools |
| Chrome DevTools MCP 1.8.0 (Google, 2026-08-25) | Puppeteer/CDP; launches Chrome, or `--autoConnect` to the running default profile, or `--browser-url http://127.0.0.1:9222` | 30-ish tools incl. `evaluate_script`, `take_screenshot`, `take_snapshot`, `list_console_messages`, network, performance traces |
| Playwright MCP 0.0.80 (Microsoft, 2026-09-01) | launches a browser, `--cdp-endpoint`, or `--extension` into a running Chrome | accessibility-snapshot based; README now says coding agents "increasingly favor CLI-based workflows exposed as SKILLs over MCP because CLI invocations are more token-efficient" |
| Anthropic "Code execution with MCP" (Nov 4, 2025) | tools presented as a filesystem of TS modules; agent writes code | 150,000 → 2,000 tokens ("98.7%"); benefits: progressive disclosure, in-sandbox filtering, control flow, privacy; caveat: needs "secure execution environment with appropriate sandboxing, resource limits, and monitoring" |
| Cloudflare Code Mode (Sep 26, 2025; MCP server Feb 20, 2026) | `@cloudflare/codemode` 0.5.1 generates a `codemode` TS namespace from JSON Schema (`generateTypesFromJsonSchema`), runs code in a Dynamic Worker isolate | two tools `search()` + `execute()`; 2,500+ endpoints in ~1,000 tokens vs 1.17 M ("99.9%"); "LLMs have seen a lot of code. They have not seen a lot of 'tool calls.'" |

### 3.2 Recommended path for a static site

1. **Day 0, no code:** put the registry on `window.fem` with a `fem.help()` that prints the schemas, and drive it from Claude Code through Chrome DevTools MCP `evaluate_script` (or Playwright MCP). Screenshots, console errors and DOM snapshots come free. This is the "browser-tab-as-MCP-server" without writing a server.
2. **In-page agent (BYO key):** call the Anthropic Messages API from the page. The TypeScript SDK gates this behind `dangerouslyAllowBrowser: true`, which adds the request header `anthropic-dangerous-direct-browser-access: true` (visible in `src/client.ts`); Anthropic's docs describe it as acceptable for internal tools and trusted users, i.e. the user's own key in their own browser (store it in `localStorage`, never in the bundle; the API name says "dangerous" for a reason). Organisations can disable CORS for their keys. Tools = registry JSON Schemas (many structured tools) **plus** a single `run_script({ code })` tool executed in the Worker sandbox — the two-mode design both Anthropic and Cloudflare converged on. Results, errors and a canvas PNG go back as tool results (the SDK's `ToolError` can carry image blocks).
3. **MCP bridge, only if needed:** a ~100-line Node process using `@modelcontextprotocol/sdk` that registers the *same* Zod schemas and forwards to the tab over a WebSocket the page opens to `ws://localhost:<port>` (mirrors Blender/FreeCAD's socket-into-the-app design). Not needed while Chrome DevTools MCP exists.
4. "Computer use" over pixels: last resort; every precedent above avoided it.

---

## 4. Testing WebGPU and numerics in CI

### 4.1 Coverage in vitest

- Current vitest is 5.0.0 (repo demos are on ^3.0/^3.2). Providers: `v8` (default) or `istanbul`; v8 uses AST-aware remapping (introduced 3.2, the only mode since v4) so it now matches Istanbul's accuracy; v8 works in "NodeJS, Deno or any Chromium based browsers", istanbul on any runtime.
- `coverage.thresholds: { 100: true }` is the shortcut for lines/functions/branches/statements = 100; negative numbers mean "max uncovered items"; per-glob thresholds exist and do not inherit `perFile`. `coverage.include` defaults to files imported during the run — set it explicitly (`['src/core/**']`) so untested files count.
- Browser mode: `@vitest/browser-playwright` 5.0.0; `provider: playwright({ launchOptions: { args: [...] } })`, `instances: [{ browser: 'chromium' }]`, `headless: true`; tests run in an iframe inside a real browser, served from `http://localhost` (a secure context — `navigator.gpu` is absent on `data:`/`about:blank`).

### 4.2 Real WebGPU on a GitHub-hosted Ubuntu runner: the evidence

Runner facts (`ubuntu-24.04` image readme): Ubuntu 24.04.4, Google Chrome 151 and Chromium 151 preinstalled, `xvfb` preinstalled, Node 22.23.2; **no** `mesa-vulkan-drivers`/`libvulkan1` listed. Ubuntu noble amd64 ships `mesa-vulkan-drivers` 25.2.8 (lavapipe is Mesa's Vulkan CPU driver). Chromium's own `FlagSpecificConfig` defines the `webgpu-swiftshader` configuration as `--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader --enable-dawn-features=allow_unsafe_apis --disable-dawn-features=use_dxc --enable-webgpu-developer-features --use-gpu-in-tests --enable-accelerated-2d-canvas`. Chromium's SwiftShader doc warns the *WebGL* SwiftShader fallback is deprecated; `--use-angle=swiftshader` affects ANGLE/WebGL only, not Dawn/WebGPU (the abyss-engine PR calls it "a red herring").

| Report (date) | Setup | Flags | Result |
|---|---|---|---|
| rpCal/hex-puzzle-generator #6 (2026-09-02) | Playwright 1.62.1 Chromium, local | A: none → no adapter; B: `--enable-unsafe-swiftshader` → none; C: `--enable-unsafe-webgpu --enable-unsafe-swiftshader` → adapter then `OperationError: A valid external Instance reference no longer exists`; **D: `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --use-vulkan=swiftshader --enable-unsafe-swiftshader`** | D: full pass, adapter `{vendor: "google", arch: "swiftshader"}`, compute readback correct through a `MAP_READ` staging buffer, `maxTexture: 8192`. Notes `navigator.gpu` needs a secure context. Running in GitHub Actions is the *exit criterion*, not yet demonstrated. |
| littlething666/abyss-engine PR #22 (2026-04-30, not merged) | Playwright e2e on GitHub Actions | `apt-get install mesa-vulkan-drivers libvulkan1 vulkan-tools`; `VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json`; `vulkaninfo --summary` pre-flight; `--enable-unsafe-webgpu --enable-features=Vulkan` | Root cause of earlier failures: "Dawn had no Vulkan ICD in the runner, so WebGPU bound to a degenerate fallback adapter with byte-sized buffer limits" (`createBuffer failed, size (288) is too large`). With lavapipe the smoke test passes. |
| visgl/deck.gl-community PR #706 (2026-07-30, draft) | vitest browser mode + Playwright, `channel: 'chrome'` on Actions | `--enable-unsafe-webgpu --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader --use-webgpu-adapter=swiftshader --use-gpu-in-tests`; `fileParallelism: false` | Passes locally; on the GitHub Ubuntu runner "the first native WebGPU rendering file loses Dawn's external instance" → `A valid external Instance reference no longer exists`, 6 failures across 5 files. No Vulkan ICD installed in that attempt. |
| BabylonJS/Babylon.js #18765 (2026-08-25) | headless Chromium harness on an Azure DevOps Linux agent | `--use-angle=swiftshader --enable-features=Vulkan` | Adapter `google/swiftshader` *is* available and the first frame renders in ~120 ms, then the renderer process crashes (`Target crashed`); cause not yet captured. |
| zenn.dev/syoyo (2026-01-02) | Chrome on Linux, no GPU | `--use-webgpu-adapter=swiftshader --enable-unsafe-webgpu --disable-gpu-blocklist` | Works only *headed under Xvfb*; `--headless=new` did not work for the author ("Chrome's ANGLE library uses DisplayVkXcb which needs an X11 connection"). |
| agent-browser.dev docs | Docker recipe | `--enable-features=Vulkan --use-angle=vulkan --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader --disable-vulkan-surface --enable-unsafe-webgpu`; installs `libvulkan1 mesa-vulkan-drivers xvfb` | Claims no real GPU or `/dev/dri` needed; starts a private Xvfb automatically. |
| tigerabrodi.blog (undated, Puppeteer) | cloud GPU | `--headless=new --enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --disable-vulkan-surface ...` | `--disable-vulkan-surface` allows offscreen without X11; Puppeteer injects `--use-angle=swiftshader-webgl` by default and it must be overridden. Hardware GPU path. |
| Chrome for Developers blog (2024-01-16) | Puppeteer on NVIDIA T4/V100 | same Vulkan flag set | hardware GPU; SwiftShader appeared only as fallback |
| electron/electron #38189 (2023-05, closed not planned) | Electron 25/Chromium 113 in Docker | `use-webgpu-adapter=swiftshader` | GPU process exited during init; no fix documented |
| Chromium CL 4167071 (abandoned 2023-02-03) | Chromium's own linux code-coverage builder | run CTS on SwiftShader | "never quite got this working, but don't need it right now" |

Reading: SwiftShader-for-WebGPU works when Chromium is told to use Vulkan (either SwiftShader's own Vulkan via `--use-vulkan=swiftshader`, or a system ICD such as lavapipe); the naked `--use-webgpu-adapter=swiftshader` without a Vulkan path is the flag set that produces the "external Instance" failures. Headless: the new headless mode (Chrome 112+; Playwright uses `chromium-headless-shell` by default and needs `channel: 'chromium'` for real new-headless) is contradicted by one 2026 report needing Xvfb; `xvfb-run` is preinstalled and cheap insurance.

### 4.3 Concrete CI recipe (to spike, in this order)

```yaml
# .github/workflows/ci.yml (GPU job; keep continue-on-error: true until it is green for a week)
gpu-tests:
  runs-on: ubuntu-24.04
  continue-on-error: true
  steps:
    - uses: actions/checkout@v5
    - uses: actions/setup-node@v5
      with: { node-version: 22, cache: npm }
    - run: npm ci
    - run: sudo apt-get update && sudo apt-get install -y --no-install-recommends mesa-vulkan-drivers libvulkan1 vulkan-tools
    - run: echo "VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.x86_64.json" >> "$GITHUB_ENV"
    - run: vulkaninfo --summary | head -n 40          # pre-flight: prove an ICD exists
    - run: npx playwright install --with-deps chromium
    - run: xvfb-run -a npx vitest run --project gpu    # headed-under-Xvfb is the belt-and-braces variant
```

```ts
// vitest.config.ts — gpu project
import { playwright } from '@vitest/browser-playwright'
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'core', include: ['src/core/**/*.test.ts'],
                coverage: { provider: 'v8', include: ['src/core/**'], thresholds: { 100: true } } } },
      { test: { name: 'gpu', include: ['src/gpu/**/*.browser.test.ts'],
                browser: {
                  enabled: true, headless: true, fileParallelism: false,
                  provider: playwright({ launchOptions: { channel: 'chromium', args: [
                    '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan',
                    // pick ONE Vulkan source: SwiftShader's own Vulkan ...
                    '--use-vulkan=swiftshader', '--enable-unsafe-swiftshader',
                    // ... or drop the two lines above and rely on the lavapipe ICD installed by apt.
                    '--enable-dawn-features=allow_unsafe_apis',
                  ] } }),
                  instances: [{ browser: 'chromium' }] } } },
    ],
  },
})
```

First GPU test to write (highest value per line, from the hex-puzzle issue): enumerate every WGSL source, `device.createShaderModule({ code })`, and assert `getCompilationInfo()` has zero `error` messages. Then move `demos/blast-wall/src/selftest.ts`-style known-answer checks (two-brick bed joint, patch tests) into `*.browser.test.ts` so they gate PRs instead of relying on someone opening `?selftest`.

Fallbacks if Chromium stays flaky:

- **Deno + lavapipe (no browser).** Deno 2.9.6 (2026-08-27) still gates WebGPU behind `--unstable-webgpu`; the implementation is wgpu (`deno_webgpu`), tested by wgpu's `cts_runner`, and wgpu's own CTS workflow runs the Linux Vulkan job on `ubuntu-24.04` with a prebuilt Mesa 26.1.3 lavapipe (`gfx-rs/ci-build`), a hand-written ICD JSON pointed at by `VK_DRIVER_FILES`, `LVP_POISON_MEMORY=true` (fills fresh memory with non-zero bytes so uninitialised-memory bugs fail loudly — worth copying) and `DENO_WEBGPU_BACKEND=vulkan`. Since the repo's kernels are WGSL template strings in `.ts` files, a Deno test can import them unchanged and run compute + `mapAsync` readback exactly as in the browser (`docs.deno.com/examples/webgpu_compute`). Costs: a second runtime in CI; `apt mesa-vulkan-drivers` may be an older lavapipe than wgpu's pinned 26.1.3 (**not tested** in this session).
- **`webgpu` npm (Dawn for Node)** 0.6.0 (2026-08-28, 95 MB unpacked, `dawn-gpu/node-webgpu`, Node ≥ 18, win64/macOS/linux): `create([...dawnFlags])` returns a `gpu`; dawn.node's README documents `VK_ICD_FILENAMES=<lvp_icd.json>` for lavapipe or SwiftShader. Its own README steers webpage authors to Puppeteer instead. Viable for kernel unit tests in plain vitest; no canvas.
- **wgpu-native / Rust** with lavapipe: proven in wgpu's CI, but adds a Rust toolchain for no gain here.

### 4.4 Validating WGSL without any GPU (cheap, do it first)

| Tool | What it gives | How to run in CI |
|---|---|---|
| `naga-cli` 30.0.1 (crates.io, 2026-08-22; wgpu workspace 30.0.0) | parse + validate WGSL (`naga shader.wgsl`), translate to SPIR-V/MSL/HLSL for extra checks | `cargo install naga-cli` (or cache the binary); would have caught a reserved-keyword bug |
| `getCompilationInfo()` in the browser job | the authoritative Tint diagnostics of the browser that actually ships | part of the GPU job above |
| `wgsl-analyzer` (LSP, releases through 2026-04-26) | editor diagnostics "with naga", go-to-def, completion | editor only; no CI CLI documented |
| `wesl` 0.7.31 / `wgsl_reflect` 1.5.0 (JS) | JS-side linking/parsing and reflection of bindings | parse-level checks in Node; not full validation |
| `wgsl-test` 0.2.34 | "Test WGSL and WESL shaders with the CLI or vitest" (npm description; **not evaluated**) | — |
| Tint standalone (Dawn) | Chrome's actual compiler | needs a Dawn build; naga is the practical proxy |

Because the repo keeps shaders as template strings, add a tiny script that evaluates the exported strings and writes `*.wgsl` files to a temp dir before `naga` runs — or export them from a `.ts` module that a Node test can `import` and pipe to `naga` via stdin.

### 4.5 Numerics: known answers and properties

- **Known-answer tests**: patch tests (constant strain reproduced exactly by any conforming element), analytical beams/plates, and the NAFEMS benchmark set are the standard oracles. (NAFEMS publications are paywalled; the benchmark *values* are widely reproduced in FE codes' verification manuals. **Not verified** in this session.)
- The repo's own lesson (`blast-wall/tools/selftest.ts`): do not keep a CPU mirror of the WGSL as the oracle — "the mirror was the copy that was wrong, so the suite certified a bug". Oracles must be independent: closed-form solutions, conservation laws, symmetry, mesh-refinement convergence rates.
- **Property-based**: `fast-check` 4.9.0 has `fc.float()`/`fc.double()` with `min/max`, `noNaN`, `noDefaultInfinity`, `noInteger`, plus shrinking; good for invariants such as "stiffness matrix is symmetric PSD for any admissible element geometry" and "assembling then applying a rigid-body mode gives zero force".

### 4.6 What to keep from the current strategy

The split already in `demos/blast-wall` — Node `tsx tools/selftest.ts` for everything that is a pure function of the mesh, browser `?selftest` for the shipped kernels — is the right shape. The proposal above only (a) moves both into vitest so thresholds and reporters apply, (b) makes the browser half run in CI, and (c) adds static WGSL validation as a zero-GPU gate.

---

## 5. GitHub Pages constraints and alternatives

| Constraint | Value | Source |
|---|---|---|
| Published site size | "may be no larger than 1 GB"; source repo recommended ≤ 1 GB | GitHub Pages limits |
| Bandwidth | soft 100 GB/month | same |
| Builds | soft 10/hour (does not apply with a custom Actions workflow — the repo already uses one) | same |
| Deployment timeout | 10 minutes | same |
| Custom response headers | not offered; the limits page does not mention headers and community discussion #13309 requests COOP/COEP support | GitHub docs; community |
| 100 MB per file | a Git/GitHub *repository* push limit, not a Pages limit; only relevant if wasm blobs are committed rather than built | (not on the Pages limits page) |

Consequences: no COOP/COEP → no cross-origin isolation → no `SharedArrayBuffer` → no wasm pthreads. A WebGPU solver does not need threads; a future wasm mesher might. Options:

- `coi-serviceworker` 0.1.7: a service worker that injects COOP/COEP; "must be in a separate file", "must be served from your own origin", page "will still need to be either served from HTTPS, or served from localhost", and it reloads the page once on first load; `coepCredentialless`/`coepDegrade` options. JupyterLite and Wasmer document the same trick for Pages.
- Cloudflare Pages `_headers`: up to 100 rules, 2,000 characters per line; static assets only.
- Netlify `_headers` or `netlify.toml [[headers]]`; some headers reserved.

Chrome's WebGPU adapter selection is unaffected by any of this; the user's own GPU does the work.

---

## Sources

Scripting and sandboxes
- Figma, "How to build a plugin system on the web and also sleep well at night" — https://www.figma.com/blog/how-we-built-the-figma-plugin-system/
- Figma, "An update on plugin security" (2019-10-02) — https://www.figma.com/blog/an-update-on-plugin-security/
- quickjs-emscripten README (package size section, limits API) — https://github.com/justjake/quickjs-emscripten ; npm — https://www.npmjs.com/package/quickjs-emscripten ; variant — https://github.com/justjake/quickjs-emscripten/blob/main/packages/variant-quickjs-wasmfile-release-sync/README.md
- quickjs-emscripten sync vs asyncify size note (libraries.io mirror of README) — https://libraries.io/npm/quickjs-emscripten
- TC39 ShadowRealm README (Stage 2.7) — https://github.com/tc39/proposal-shadowrealm/blob/main/README.md ; Web APIs gate — https://github.com/tc39/proposal-shadowrealm/issues/393
- SES README (threat model) — https://github.com/endojs/endo/blob/master/packages/ses/README.md ; npm `ses` — https://www.npmjs.com/package/ses
- Pyodide releases (asset sizes) — https://github.com/pyodide/pyodide/releases ; downloading/deploying — https://pyodide.org/en/stable/usage/downloading-and-deploying.html ; type conversions — https://pyodide.org/en/stable/usage/type-conversions.html
- esbuild-wasm — https://www.npmjs.com/package/esbuild-wasm ; "Running ESBuild in the Browser" (~10 MB wasm) — https://schof.co/running-esbuild-in-the-browser/ ; sucrase — https://www.npmjs.com/package/sucrase
- Zoo KCL — https://zoo.dev/research/introducing-kcl ; modeling-app README — https://github.com/KittyCAD/modeling-app
- Onshape FeatureScript — https://cad.onshape.com/FsDoc/
- Blender Info editor — https://docs.blender.org/manual/en/latest/editors/info_editor.html ; Blender undo system — https://developer.blender.org/docs/features/core/undo/
- ParaView User's Guide (Trace, paraview.simple) — https://docs.paraview.org/en/latest/UsersGuide/introduction.html
- Observable runtime README — https://github.com/observablehq/runtime
- JupyterLite pyodide kernel — https://github.com/jupyterlite/pyodide-kernel
- OpenSCAD playground — https://github.com/openscad/openscad-playground
- Replicad — https://replicad.xyz/docs/intro
- tldraw programmatic control — https://tldraw.dev/features/programmatic-control

Command/schema architecture
- Zod 4 JSON Schema — https://zod.dev/json-schema ; release notes — https://zod.dev/v4
- Standard JSON Schema (implementers and versions) — https://standardschema.dev/json-schema
- TypeBox README — https://github.com/sinclairzx81/typebox
- Effect Schema JSON Schema — https://effect.website/docs/schema/json-schema/
- Valibot JSON Schema — https://valibot.dev/guides/json-schema/
- MCP TypeScript SDK README (Standard Schema, v2) — https://github.com/modelcontextprotocol/typescript-sdk ; npm — https://www.npmjs.com/package/@modelcontextprotocol/sdk ; zod v4 issues — https://github.com/modelcontextprotocol/typescript-sdk/issues/555 , https://github.com/modelcontextprotocol/typescript-sdk/issues/906 , https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1429
- Vercel AI SDK tools docs — https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx ; provider-utils package.json (zod peer range) — https://github.com/vercel/ai/blob/main/packages/provider-utils/package.json ; AI SDK 6 announcement — https://vercel.com/blog/ai-sdk-6
- immer — https://immerjs.github.io/immer/

AI exposure
- Anthropic, "Code execution with MCP" (2025-11-04) — https://www.anthropic.com/engineering/code-execution-with-mcp
- Cloudflare, "Code Mode: the better way to use MCP" (2025-09-26) — https://blog.cloudflare.com/code-mode/ ; "give agents an entire API in 1,000 tokens" (2026-02-20) — https://blog.cloudflare.com/code-mode-mcp/ ; API reference — https://developers.cloudflare.com/agents/api-reference/codemode/
- Anthropic TypeScript SDK docs (browser usage, `dangerouslyAllowBrowser`, tool helpers) — https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript ; header in source — https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts ; Simon Willison on the CORS header (2024-08-23) — https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access/
- blender-mcp — https://github.com/ahujasid/blender-mcp ; exec() concern — https://github.com/ahujasid/blender-mcp/issues/207
- freecad-mcp — https://github.com/neka-nat/freecad-mcp
- Figma Dev Mode MCP server — https://www.figma.com/blog/introducing-figma-mcp-server/ ; desktop setup — https://help.figma.com/hc/en-us/articles/35281186390679
- Chrome DevTools MCP — https://github.com/ChromeDevTools/chrome-devtools-mcp ; tool reference — https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md ; advanced usage (`--autoConnect`, `--browser-url`) — https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md
- Playwright MCP — https://github.com/microsoft/playwright-mcp

WebGPU in CI
- Chromium FlagSpecificConfig (`webgpu-swiftshader`) — https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/web_tests/FlagSpecificConfig
- Chromium SwiftShader doc — https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md
- Dawn webgpu-cts README (`--use-webgpu-adapter=[default,swiftshader,compat]`) — https://dawn.googlesource.com/dawn/+/HEAD/webgpu-cts/README.md
- Abandoned Chromium CL to run CTS on SwiftShader — https://groups.google.com/a/chromium.org/g/chromium-reviews/c/_luQE-wnNBo
- rpCal/hex-puzzle-generator #6 (flag matrix, compute readback) — https://github.com/rpCal/hex-puzzle-generator/issues/6
- littlething666/abyss-engine PR #22 (lavapipe on Actions) — https://github.com/littlething666/abyss-engine/pull/22
- visgl/deck.gl-community PR #706 (vitest browser + SwiftShader on Actions) — https://github.com/visgl/deck.gl-community/pull/706
- BabylonJS/Babylon.js #18765 (adapter up, renderer crash on Linux agent) — https://github.com/BabylonJS/Babylon.js/issues/18765
- zenn.dev/syoyo, headless Chrome + WebGPU on Linux (2026-01-02) — https://zenn.dev/syoyo/articles/4f084b2288428f
- agent-browser WebGPU docs — https://agent-browser.dev/webgpu
- tigerabrodi, WebGPU in headless Chrome on cloud GPUs — https://tigerabrodi.blog/how-to-get-webgpu-in-headless-chrome-on-cloud-gpus
- Chrome for Developers, "Supercharge Web AI model testing" (2024-01-16) — https://developer.chrome.com/blog/supercharge-web-ai-testing
- electron/electron #38189 — https://github.com/electron/electron/issues/38189
- Chrome headless modes — https://developer.chrome.com/docs/chromium/headless ; Playwright browsers (headless shell vs `channel: 'chromium'`) — https://playwright.dev/docs/browsers
- GitHub runner image ubuntu-24.04 — https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md ; Ubuntu noble mesa-vulkan-drivers — https://packages.ubuntu.com/noble/mesa-vulkan-drivers
- vitest coverage config — https://vitest.dev/config/coverage ; coverage guide — https://vitest.dev/guide/coverage.html ; browser mode — https://vitest.dev/guide/browser/ ; playwright provider — https://vitest.dev/config/browser/playwright ; AST-aware remapping — https://github.com/vitest-dev/vitest/issues/7928
- Deno unstable flags (`--unstable-webgpu`) — https://docs.deno.com/runtime/reference/cli/unstable_flags/ ; Deno 1.39 WebGPU announcement — https://deno.com/blog/v1.39 ; compute example — https://docs.deno.com/examples/webgpu_compute/ ; deno_webgpu README — https://github.com/denoland/deno/blob/main/ext/webgpu/README.md
- wgpu CTS workflow — https://github.com/gfx-rs/wgpu/blob/trunk/.github/workflows/cts.yml ; install-mesa action — https://github.com/gfx-rs/wgpu/blob/trunk/.github/actions/install-mesa/action.yml ; testing doc (`LVP_POISON_MEMORY`) — https://github.com/gfx-rs/wgpu/blob/trunk/docs/testing.md ; cts_runner — https://github.com/gfx-rs/wgpu/tree/trunk/cts_runner
- node-webgpu (`webgpu` npm) — https://github.com/dawn-gpu/node-webgpu ; npm — https://www.npmjs.com/package/webgpu ; dawn.node README (lavapipe/SwiftShader ICD) — https://dawn.googlesource.com/dawn/+/HEAD/src/dawn/node/README.md
- naga-cli — https://crates.io/crates/naga-cli ; wgsl-analyzer — https://github.com/wgsl-analyzer/wgsl-analyzer ; wesl-js — https://github.com/wgsl-tooling-wg/wesl-js ; wgsl_reflect — https://www.npmjs.com/package/wgsl_reflect ; wgsl-test — https://www.npmjs.com/package/wgsl-test
- fast-check numeric arbitraries — https://fast-check.dev/docs/core-blocks/arbitraries/primitives/number/

GitHub Pages and headers
- GitHub Pages limits — https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits ; COOP/COEP request — https://github.com/orgs/community/discussions/13309
- coi-serviceworker — https://github.com/gzuidhof/coi-serviceworker ; Wasmer's Pages guide — https://docs.wasmer.io/sdk/wasmer-js/how-to/coop-coep-headers/ ; JupyterLite issue — https://github.com/jupyterlite/jupyterlite/issues/1409
- Cloudflare Pages `_headers` — https://developers.cloudflare.com/pages/configuration/headers/ ; Netlify headers — https://docs.netlify.com/manage/routing/headers/
