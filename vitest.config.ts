import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __LITE__: 'false' },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
