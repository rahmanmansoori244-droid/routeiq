// Last step of `pnpm build` (audit 27 Sep 2026, source-map side item): delete every .map file
// under .next/static, the folder Next.js serves to anyone. Source maps are not made at all unless
// a Sentry upload is configured (next.config.js); with an upload, Sentry deletes the JS maps after
// uploading them but leaves the CSS maps (its delete list is *.js.map only). This removes whatever
// is left, so no source map is ever deployed. Runtime needs none of them.
//
// Usage: node scripts/remove-public-source-maps.mjs [path to .next]  (default: the app's .next)
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const nextDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.next');
const staticDir = path.join(nextDir, 'static');

let removed = 0;
function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(p);
    else if (entry.name.endsWith('.map')) {
      rmSync(p, { force: true });
      removed++;
    }
  }
}
if (existsSync(staticDir)) visit(staticDir);
console.log(`remove-public-source-maps: ${removed} source map file(s) removed from ${path.relative(process.cwd(), staticDir) || staticDir}`);
