/**
 * CI check after `pnpm --filter @routeiq/web build` (audit 27 Sep 2026, F01 and the source-map
 * side item; the upload parser since audit P5):
 *   1. no use-server directive in the app's code (apps/web, packages/);
 *   2. the built .next/server/server-reference-manifest.json lists no Server Action;
 *   3. no .map file under .next/static (those would be served publicly);
 *   4. the upload parser bundle .next/upload-parser/parse.cjs is there, holds only what it may,
 *      and reads a two-line CSV when it is run as `next start` runs it (else every upload is refused);
 *   5. (review M3) the PDF renderer bundle .next/pdf-renderer/render.cjs is there, holds only what it
 *      may, and makes a PDF when it is run as `next start` runs it (else every driver sheet is refused).
 * Run from apps/web: `tsx scripts/check-build-output.ts`. Exits 1 on any finding.
 */
import path from 'node:path';
import { buildOutputProblems, pdfRendererProblems, pdfRendererSmokeProblem, uploadParserProblems, uploadParserSmokeProblem } from './build-guards';

async function main() {
  const web = path.resolve(__dirname, '..');
  const problems = [...buildOutputProblems(web, [web, path.resolve(web, '../../packages')]), ...uploadParserProblems(web), ...pdfRendererProblems(web)];
  if (!problems.length) {
    const ran = await uploadParserSmokeProblem(path.join(web, '.next', 'upload-parser', 'parse.cjs'));
    if (ran) problems.push(ran);
    const made = await pdfRendererSmokeProblem(path.join(web, '.next', 'pdf-renderer', 'render.cjs'));
    if (made) problems.push(made);
  }

  if (problems.length) {
    console.error(`Build output check failed (${problems.length}):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log('Build output check passed: no Server Actions, no public source maps, the upload parser is built and reads a file, the PDF renderer is built and makes a PDF.');
}

void main();
