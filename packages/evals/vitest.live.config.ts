import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['live/**/*.live.ts'],
    testTimeout: 86_400_000,
    hookTimeout: 60_000,
    maxWorkers: 1,
  },
});
