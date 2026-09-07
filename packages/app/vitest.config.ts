import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __DEV_API_KEYS__: 'null' },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      // Every authored app module counts, including workers and browser-only entry points.
      include: ['src/**/*.{ts,tsx}'],
      // Type declarations contain no executable code and cannot be instrumented.
      exclude: ['**/*.d.ts'],
      reporter: ['text', 'json-summary', 'html'],
      // #44: the measured baseline. Raise these with coverage gains; never lower them.
      thresholds: { lines: 81.35, statements: 78.71, functions: 72.83, branches: 74.83 },
    },
  },
});
