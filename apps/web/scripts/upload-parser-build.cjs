'use strict';
/**
 * Builds the upload parser bundle (audit P5): lib/upload-parse/child.ts and what it imports, bundled
 * by esbuild into one CommonJS file that plain `node` runs. The web process forks it for each upload
 * (lib/upload-parse/index.ts).
 *
 *  - `pnpm build` makes .next/upload-parser/parse.cjs (scripts/build-upload-parser.mjs), which
 *    `next start` uses; scripts/check-build-output.ts (CI) checks it and runs it once.
 *  - `next dev` and the tests fork scripts/upload-parser-dev.cjs, which builds the same bundle into
 *    node_modules/.cache/routeiq-upload-parser when one of its sources changed, and runs it.
 *
 * The bundle may hold only the parser's own modules, SheetJS and Papa Parse. SheetJS must be its
 * ESM build (xlsx.mjs), the one Next.js bundles for the web process and vitest loads: its CommonJS
 * build (xlsx.js) also loads the codepage tables, which could read old .xls text differently.
 * Anything else (a database client, the app's settings) is refused, so no secret-reading code and
 * nothing heavy ends up in the parser.
 */
const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const WEB = path.resolve(__dirname, '..');
const ENTRY = 'lib/upload-parse/child.ts';
/** The production bundle's folder (`next start` reads .next/upload-parser/parse.cjs). */
const PROD_OUT = path.join(WEB, '.next', 'upload-parser');
/** The development and test bundle's folder. */
const DEV_OUT = path.join(WEB, 'node_modules', '.cache', 'routeiq-upload-parser');
/** The app modules the parser is made of (paths from apps/web). */
const PARSER_MODULES = new Set([
  'lib/csv.ts',
  'lib/workbook-guard.ts',
  'lib/upload-errors.ts',
  'lib/upload-limits.ts',
  'lib/dispatch/order-headers.ts',
  'lib/upload-parse/child.ts',
  'lib/upload-parse/handler.ts',
  'lib/upload-parse/protocol.ts',
]);
const PACKAGES = new Set(['xlsx', 'papaparse']);

/** What is wrong with the bundle's inputs (paths from apps/web, as esbuild's metafile lists them). */
function inputProblems(inputs) {
  const problems = [];
  let sheetjs = null;
  for (const input of inputs) {
    const p = input.split(path.sep).join('/');
    // node_modules/<pkg>/<file>, also pnpm's node_modules/.pnpm/<dir>/node_modules/<pkg>/<file>
    const m = /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\/(.+)$/.exec(p);
    if (m) {
      if (!PACKAGES.has(m[1])) problems.push(`a package the parser must not hold: ${p}`);
      if (m[1] === 'xlsx') {
        sheetjs = m[2];
        if (m[2] !== 'xlsx.mjs') problems.push(`SheetJS is ${m[2]}, not xlsx.mjs (the build Next.js and the tests use)`);
      }
    } else if (!PARSER_MODULES.has(p)) {
      problems.push(`a module the parser must not hold: ${p}`);
    }
  }
  if (!sheetjs) problems.push('SheetJS (xlsx.mjs) is not in the bundle');
  return problems;
}

/** Size and time of a file, or null when it is not there. */
function fingerprint(file) {
  try {
    const s = statSync(path.resolve(WEB, file));
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch {
    return null;
  }
}

/** Bundles the parser into `outDir`/parse.cjs (and stamp.json: its inputs). Throws on refused inputs. */
function buildUploadParser(outDir) {
  const esbuild = require('esbuild');
  mkdirSync(outDir, { recursive: true });
  const tmp = path.join(outDir, `parse.${process.pid}.${Date.now()}.tmp.cjs`);
  const result = esbuild.buildSync({
    absWorkingDir: WEB,
    entryPoints: [ENTRY],
    outfile: tmp,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    metafile: true,
    logLevel: 'silent',
    banner: { js: '// RouteIQ upload parser (audit P5), built from lib/upload-parse/child.ts by scripts/upload-parser-build.cjs. Do not edit.' },
  });
  const inputs = Object.keys(result.metafile.inputs).sort();
  const problems = inputProblems(inputs);
  if (problems.length) {
    rmSync(tmp, { force: true });
    throw new Error(`The upload parser bundle was refused:\n  - ${problems.join('\n  - ')}`);
  }
  let file = path.join(outDir, 'parse.cjs');
  try {
    renameSync(tmp, file);
  } catch {
    file = tmp; // another process is replacing it at the same moment: run this copy
  }
  const stamp = { builder: fingerprint(__filename), esbuild: esbuild.version, inputs: Object.fromEntries(inputs.map((i) => [i, fingerprint(i)])) };
  try {
    writeFileSync(path.join(outDir, 'stamp.json'), JSON.stringify(stamp, null, 2));
  } catch {
    // another process wrote it: the next start checks again
  }
  return { file, inputs, bytes: statSync(file).size };
}

/** The bundle in `outDir`, built again first when a source (or this builder) changed since. */
function ensureUploadParser(outDir) {
  const file = path.join(outDir, 'parse.cjs');
  try {
    const stamp = JSON.parse(readFileSync(path.join(outDir, 'stamp.json'), 'utf8'));
    const fresh =
      existsSync(file) &&
      stamp.builder === fingerprint(__filename) &&
      Object.keys(stamp.inputs).length > 0 &&
      Object.entries(stamp.inputs).every(([input, fp]) => fp !== null && fingerprint(input) === fp);
    if (fresh) return file;
  } catch {
    // no stamp yet
  }
  return buildUploadParser(outDir).file;
}

module.exports = { buildUploadParser, ensureUploadParser, inputProblems, DEV_OUT, PROD_OUT, PARSER_MODULES, WEB };
