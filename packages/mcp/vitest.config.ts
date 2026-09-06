import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The integration test replays and solves the cantilever in the wasm engine.
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // The process entry point: six lines of wiring that only running the binary exercises.
      exclude: ['src/femlab-mcp.ts'],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
