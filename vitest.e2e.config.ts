import { defineConfig } from 'vitest/config';

// Actual compiled entry points, isolated session directories, and --no-connect.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
