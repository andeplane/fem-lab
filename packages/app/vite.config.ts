import { defineConfig, type Plugin } from 'vite';

/** Isolation without the service worker in dev and preview (ADR 0013). */
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

const BASE = '/fem-lab/';

/** Chunks the start screen needs next but does not import: warm them from `<head>`. */
const PRELOAD = /^assets\/(viewer|three)-/;

/**
 * Vite emits `<link rel="modulepreload">` for the entry's *static* imports only. The viewer is a
 * dynamic import (`App.tsx`, warmed in `main.tsx`), so its chunk would otherwise not start
 * downloading until the entry has parsed and run. One link tag per chunk fixes that, and the
 * hashed names come from the bundle rather than being guessed.
 */
function preloadLazyChunks(): Plugin {
  return {
    name: 'femlab-preload-lazy-chunks',
    transformIndexHtml: {
      order: 'post',
      handler: (_html, ctx) =>
        Object.keys(ctx.bundle ?? {})
          .filter((name) => PRELOAD.test(name))
          .map((name) => ({ tag: 'link', attrs: { rel: 'modulepreload', href: BASE + name }, injectTo: 'head' as const })),
    },
  };
}

export default defineConfig(({ command }) => ({
  base: BASE,
  server: { headers },
  preview: { headers },
  worker: { format: 'es' },
  plugins: [preloadLazyChunks()],
  build: {
    target: 'es2022',
    // `tools/size-check.mjs` reads this to tell the landing chunk (the entry and its static
    // import closure) from everything that only arrives when someone asks for it.
    manifest: true,
    rollupOptions: {
      output: {
        advancedChunks: {
          groups: [
            // three.js under its own name: the preload filter above needs to find it, and the
            // viewer's own code then re-hashes without dragging 550 kB out of everyone's cache.
            // The AI SDKs get NO group: grouping them makes rolldown hoist the shared chunk into
            // the entry's *static* imports, which is exactly what this commit is removing.
            { name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ },
          ],
        },
      },
    },
  },
  define: {
    // Dev convenience only: the AI panel can pick a key up from the shell environment while
    // `vite dev` runs. A production build defines `null`, so no key can reach `dist/`
    // (`test/no-secrets.test.ts` checks the built files).
    __DEV_API_KEYS__:
      command === 'serve'
        ? JSON.stringify({
            anthropic: process.env['ANTHROPIC_API_KEY'] ?? null,
            openai: process.env['OPENAI_API_KEY'] ?? null,
          })
        : 'null',
  },
}));
