import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.integration.test.ts'],
    testTimeout: 60000, // Integration tests may be slower
    hookTimeout: 30000,
    globals: true,
  },
});
