import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Tests share a single Postgres instance; running test files in parallel
    // creates races on TRUNCATE/INSERT against shared tables.
    fileParallelism: false
  }
});
