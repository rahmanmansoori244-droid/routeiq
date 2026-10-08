'use strict';
/**
 * Builds the PDF renderer bundle (review M3): lib/pdf-render/child.ts and what it imports, bundled by
 * esbuild into one CommonJS file that plain `node` runs. The web process forks it for each driver
 * pack (lib/pdf-render/index.ts). The same shape as the upload parser's (upload-parser-build.cjs).
 *
 *  - `pnpm build` makes .next/pdf-renderer/render.cjs (scripts/build-pdf-renderer.mjs), which
 *    `next start` uses; scripts/check-build-output.ts (CI) checks it and runs it once.
 *  - `next dev` and the tests fork scripts/pdf-renderer-dev.cjs, which builds the same bundle into
 *    node_modules/.cache/routeiq-pdf-renderer when one of its sources changed, and runs it.
 *
 * The bundle may hold only the renderer's own modules (RENDERER_MODULES), which may import only
 * React, @react-pdf/renderer and qrcode (PACKAGES), and what those bring in; never a database client,
 * the app framework or anything that reads the app's secrets (NEVER). Anything else is refused.
 * JSX is compiled as Next.js and vitest compile it (the automatic runtime), and React's production
 * build is used (the renderer prints, it does not need React's development checks).
 */
const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const WEB = path.resolve(__dirname, '..');
const ENTRY = 'lib/pdf-render/child.ts';
/** The production bundle's folder (`next start` reads .next/pdf-renderer/render.cjs). */
const PROD_OUT = path.join(WEB, '.next', 'pdf-renderer');
/** The development and test bundle's folder. */
const DEV_OUT = path.join(WEB, 'node_modules', '.cache', 'routeiq-pdf-renderer');
/** The app modules the renderer is made of (paths from apps/web). */
const RENDERER_MODULES = new Set([
  'lib/dispatch/driver-pack-pdf.tsx',
  'lib/dispatch/pdf-text.ts',
  'lib/dispatch/qr.ts',
  'lib/pdf-render/child.ts',
  'lib/pdf-render/handler.ts',
  'lib/pdf-render/protocol.ts',
]);
/** The packages those modules may import (each brings in its own dependencies). */
const PACKAGES = new Set(['react', '@react-pdf/renderer', 'qrcode']);
/** Packages the bundle must never hold, whoever imports them. */
const NEVER = new Set(['@prisma/client', '.prisma', 'prisma', 'next', 'next-auth', '@auth/prisma-adapter', '@sentry/nextjs', 'bcryptjs', 'xlsx', 'papaparse', 'exceljs']);

/** The package of a path (node_modules/<pkg>/..., also pnpm's node_modules/.pnpm/<dir>/node_modules/<pkg>/...), or null. */
function packageOf(p) {
  const m = /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\/(.+)$/.exec(p);
  return m ? m[1] : null;
}

/**
 * What is wrong with the bundle's inputs: `inputs` are their paths from apps/web, `imports` the
 * packages each of the renderer's own modules imports (as esbuild's metafile lists them).
 */
function inputProblems(inputs, imports) {
  const problems = [];
  let reactPdf = false;
  for (const input of inputs) {
    const p = input.split(path.sep).join('/');
    const pkg = packageOf(p);
    if (pkg) {
      if (NEVER.has(pkg)) problems.push(`a package the renderer must not hold: ${p}`);
      if (pkg === '@react-pdf/renderer') reactPdf = true;
    } else if (!RENDERER_MODULES.has(p)) {
      problems.push(`a module the renderer must not hold: ${p}`);
    } else {
      for (const used of imports[p] ?? []) if (!PACKAGES.has(used)) problems.push(`${p} imports ${used}: the renderer's own modules may import only ${[...PACKAGES].join(', ')}`);
    }
  }
  if (!reactPdf) problems.push('@react-pdf/renderer is not in the bundle');
  return problems;
}

/** The packages each of the renderer's own modules imports, from esbuild's metafile. */
function moduleImports(metaInputs) {
  const out = {};
  for (const [input, info] of Object.entries(metaInputs)) {
    const p = input.split(path.sep).join('/');
    if (packageOf(p)) continue;
    out[p] = [...new Set((info.imports ?? []).map((i) => packageOf(i.path.split(path.sep).join('/'))).filter(Boolean))].sort();
  }
  return out;
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

/** Bundles the renderer into `outDir`/render.cjs (and stamp.json: its inputs). Throws on refused inputs. */
function buildPdfRenderer(outDir) {
  const esbuild = require('esbuild');
  mkdirSync(outDir, { recursive: true });
  const tmp = path.join(outDir, `render.${process.pid}.${Date.now()}.tmp.cjs`);
  const result = esbuild.buildSync({
    absWorkingDir: WEB,
    entryPoints: [ENTRY],
    outfile: tmp,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    metafile: true,
    logLevel: 'silent',
    banner: { js: '// RouteIQ PDF renderer (review M3), built from lib/pdf-render/child.ts by scripts/pdf-renderer-build.cjs. Do not edit.' },
  });
  const inputs = Object.keys(result.metafile.inputs).sort();
  const imports = moduleImports(result.metafile.inputs);
  const problems = inputProblems(inputs, imports);
  if (problems.length) {
    rmSync(tmp, { force: true });
    throw new Error(`The PDF renderer bundle was refused:\n  - ${problems.join('\n  - ')}`);
  }
  let file = path.join(outDir, 'render.cjs');
  try {
    renameSync(tmp, file);
  } catch {
    file = tmp; // another process is replacing it at the same moment: run this copy
  }
  const stamp = { builder: fingerprint(__filename), esbuild: esbuild.version, inputs: Object.fromEntries(inputs.map((i) => [i, fingerprint(i)])), imports };
  try {
    writeFileSync(path.join(outDir, 'stamp.json'), JSON.stringify(stamp, null, 2));
  } catch {
    // another process wrote it: the next start checks again
  }
  return { file, inputs, imports, bytes: statSync(file).size };
}

/** The bundle in `outDir`, built again first when a source (or this builder) changed since. */
function ensurePdfRenderer(outDir) {
  const file = path.join(outDir, 'render.cjs');
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
  return buildPdfRenderer(outDir).file;
}

module.exports = { buildPdfRenderer, ensurePdfRenderer, inputProblems, DEV_OUT, PROD_OUT, RENDERER_MODULES, PACKAGES, WEB };
