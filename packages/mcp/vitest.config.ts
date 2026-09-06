import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The integration test replays and solves the cantilever in the wasm engine.
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // CLI and worker entrypoints are wiring exercised by built-process tests.
      // QuickJS guest source is tested through QuickJS; V8 measures its host bridge only.
      exclude: ['src/femlab-mcp.ts', 'src/script-worker.ts'],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
