import { defineConfig } from 'vitest/config';

// End-to-end tests: spawn the built server (dist/) as a real child process,
// including a real headless browser. Requires `npm run build` first (the
// test:e2e script does this). Files run serially - the WhatsApp session
// directory can only be held by one browser at a time.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
