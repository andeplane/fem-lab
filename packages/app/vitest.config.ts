import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __DEV_API_KEYS__: 'null' },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
