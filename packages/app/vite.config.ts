import { defineConfig } from 'vite';

/** Isolation without the service worker in dev and preview (ADR 0013). */
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig(({ command }) => ({
  base: '/fem-lab/',
  server: { headers },
  preview: { headers },
  worker: { format: 'es' },
  build: { target: 'es2022' },
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
