import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Each file boots its own in-process PGlite database; startup takes a few seconds.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
