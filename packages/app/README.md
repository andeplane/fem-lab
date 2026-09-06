# `@femlab/app` — the browser host

The designed FEM Lab shell (plan B §7): Preact panels, a three.js viewer, the wasm engine in a
Worker, and the Assistant drawer. It is a static site — no server, no build step at run time —
published to GitHub Pages by `.github/workflows/deploy.yml`.

## Run it

```sh
npm ci
node tools/build-wasm.mjs        # from the repo root: cargo → wasm-bindgen → wasm-opt
npm run dev -w packages/app      # http://localhost:5173/fem-lab/
```

`vite dev` and `vite preview` send `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy`
themselves, so the app is cross-origin isolated locally without the service worker. Isolation
is a prerequisite for shared memory; query.capabilities reports the engine capabilities. GitHub Pages cannot send headers, so there the isolation comes from
`public/coi-serviceworker.min.js`, wired up in `index.html`; the `sw` Playwright project drives
exactly that path against a header-less server.

`node tools/build-wasm.mjs` needs `wasm-bindgen-cli` at the version in `Cargo.lock` (it prints the
`cargo install` line if yours differs) and picks up binaryen's `wasm-opt` from `node_modules`, so
run `npm ci` **before** it. Without binaryen it still produces a working module, a third larger,
and says so.

## Build, test, gate

```sh
npm run build -w packages/app    # vite build; `postbuild` refuses a bundle with an API key in it
npm run test  -w packages/app    # vitest, happy-dom
npm run typecheck -w packages/app
npm run e2e -w packages/app -- --project cpu   # or --project sw --project gpu
npm run size                     # the bundle budget, from the repo root
```

The `e2e` projects each start their own server: `cpu`/`gpu` use `vite preview` (real headers),
`sw` uses `tools/static-serve.mjs` (no headers, so the service worker has to earn isolation).
`gpu` needs Chromium's SwiftShader Vulkan adapter and is allowed to fail in CI.

## The bundle budget

`tools/size-check.mjs` (`npm run size`, run in CI's `web` job) prints every built file with its raw
and gzipped size and fails on two numbers:

| budget | what it counts |
| --- | --- |
| **landing JS ≤ 1 MB gz** | the entry chunk and its *static* import closure — what has to be parsed and run before the start screen paints |
| **cold boot ≤ 3 MB gz** | the above, plus the chunks `index.html` preloads, plus the engine Worker and the wasm module it fetches at once |

The static/dynamic split is read from Vite's `dist/.vite/manifest.json`, not guessed from
filenames, so a static import creeping back into the entry moves the number and the job fails.

What is deliberately *not* in the landing chunk, and how it stays out:

| chunk | kept out by |
| --- | --- |
| `three-*.js` + `viewer-*.js` | `import('../viewer/viewer')` inside `ViewerPane`'s effect (`src/ui/App.tsx`), warmed by `main.tsx` right after the first render and by a `<link rel="modulepreload">` the Vite plugin in `vite.config.ts` injects |
| `ai-*.js` (both SDKs) | `lazy(() => import('../ai'))` for the drawer, and a dynamic `chatBridge` in `src/host.ts` — a static import there would drag the SDKs back in |
| `tutorial-*.js` | `lazy(() => import('../tutorial'))` |
| `script.worker-*.js` (sucrase) | it is a Worker entry; `ScriptHost` only constructs it on the first `script.run` |
| `femlab_engine_wasm_bg.wasm` | only `src/engine.worker.ts` imports the glue, and it fetches the module by URL |

Give the AI SDKs their own `advancedChunks` group and rolldown hoists the shared chunk into the
entry's *static* imports — the one thing that undoes all of this. `npm run size` catches it.
