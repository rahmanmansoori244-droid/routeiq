import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // JSX as Next.js compiles it (the automatic runtime: no `import React` in components), so the
  // component tests (tests/lib/hook-host.ts) can load the dispatch screen's .tsx files.
  esbuild: { jsx: 'automatic' },
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
