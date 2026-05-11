import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'lib/**/*.spec.ts'],
    setupFiles: ['./tests/setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // Integration tests hit the dev server + spin up the OR-Tools solver path,
    // so the per-test budget needs to cover an optimize() round-trip.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: { '@': rootDir },
  },
});
