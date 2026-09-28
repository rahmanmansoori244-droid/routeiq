/**
 * CI check after `pnpm --filter @routeiq/web build` (audit 27 Sep 2026, F01 and the source-map
 * side item):
 *   1. no use-server directive in the app's code (apps/web, packages/);
 *   2. the built .next/server/server-reference-manifest.json lists no Server Action;
 *   3. no .map file under .next/static (those would be served publicly).
 * Run from apps/web: `tsx scripts/check-build-output.ts`. Exits 1 on any finding.
 */
import path from 'node:path';
import { buildOutputProblems } from './build-guards';

const web = path.resolve(__dirname, '..');
const problems = buildOutputProblems(web, [web, path.resolve(web, '../../packages')]);

if (problems.length) {
  console.error(`Build output check failed (${problems.length}):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('Build output check passed: no Server Actions, no public source maps.');
