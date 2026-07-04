import { defineConfig } from 'vitest/config';

// Unit/component tests. E2E tests (spawning the real server + browser) live in
// test/e2e and run separately via `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**', 'node_modules/**'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
