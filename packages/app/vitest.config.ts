import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __DEV_API_KEYS__: 'null', __FIREBASE_CONFIG__: 'null', __AI_API_ORIGIN__: 'null', __GOOGLE_SIGN_IN__: 'false', __HOSTED_AI__: 'false' },
  test: {
    environment: 'happy-dom',
    setupFiles: ['test/setup.ts'],
    // Exercise identity races in the real hosted branch while retaining the development-host suite.
    projects: [
      { extends: true, test: { name: 'app', include: ['test/**/*.test.{ts,tsx}'], exclude: ['test/assistant-attachment-ownership.test.tsx'] } },
      { extends: true, define: { __HOSTED_AI__: 'true' }, test: { name: 'hosted attachments', include: ['test/assistant-attachment-ownership.test.tsx'] } },
    ],
    coverage: {
      provider: 'v8',
      // Every authored app module counts, including workers and browser-only entry points.
      include: ['src/**/*.{ts,tsx}'],
      // Type declarations contain no executable code and cannot be instrumented.
      exclude: ['**/*.d.ts'],
      reporter: ['text', 'json-summary', 'html'],
      // #44: the measured baseline. Raise these with coverage gains; never lower them.
      thresholds: { lines: 82.5, statements: 79.76, functions: 74.7, branches: 76.43 },
    },
  },
});
