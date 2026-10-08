/**
 * Audit 27 Sep 2026, quick hardening (assessment PR 1):
 *  - F01: the image endpoint is off (images.unoptimized: /_next/image answers 404), the unused
 *    Server Action size setting is gone, and no Server Action can come in: no use-server
 *    directive in the app's code, none in the built manifest (the CI step runs the same checks
 *    on the real build: scripts/check-build-output.ts);
 *  - side item: browser source maps are not made unless they are uploaded to Sentry, and then
 *    deleted after the upload; none may be left in .next/static;
 *  - Node 22 LTS is pinned the same way everywhere (engines, .nvmrc, .node-version, CI);
 *  - (audit P5) `pnpm build` makes the upload parser bundle, and the CI build check fails without
 *    a good one; (review M3) the same for the PDF renderer bundle.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  browserSourceMaps,
  buildOutputProblems,
  findServerActionDirectives,
  pdfRendererProblems,
  pdfRendererSmokeProblem,
  serverActionIds,
  uploadParserProblems,
  uploadParserSmokeProblem,
} from '@/scripts/build-guards';

const WEB = path.resolve(__dirname, '../..');
const REPO = path.resolve(WEB, '../..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'routeiq-hardening-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// ---------------------------------------------------------------------------------------
// next.config.js, loaded the way Next.js loads it (CommonJS), with @sentry/nextjs replaced by a
// stand-in that records the options it is given.
// ---------------------------------------------------------------------------------------

type SentryOptions = { sourcemaps?: { disable?: boolean; deleteSourcemapsAfterUpload?: boolean } } & Record<string, unknown>;
type LoadedConfig = {
  images?: { unoptimized?: boolean };
  experimental?: Record<string, unknown>;
  productionBrowserSourceMaps?: boolean;
};

function loadNextConfig(env: Record<string, string | undefined>): { config: LoadedConfig; sentry: SentryOptions | null } {
  const configPath = path.join(WEB, 'next.config.js');
  const req = createRequire(configPath);
  const sentryPath = req.resolve('@sentry/nextjs');
  let sentry: SentryOptions | null = null;
  const stub = new Module(sentryPath);
  stub.filename = sentryPath;
  stub.loaded = true;
  stub.exports = {
    withSentryConfig: (cfg: LoadedConfig, opts: SentryOptions) => {
      sentry = opts;
      return cfg;
    },
  };
  const keys = ['SENTRY_DSN', 'SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const setEnv = (values: Record<string, string | undefined>) => {
    for (const k of keys) {
      if (values[k] === undefined) delete process.env[k];
      else process.env[k] = values[k];
    }
  };
  const cache = req.cache as Record<string, NodeJS.Module | undefined>;
  const realSentry = cache[sentryPath];
  try {
    setEnv(env);
    cache[sentryPath] = stub;
    delete cache[configPath];
    const config = req(configPath) as LoadedConfig;
    return { config, sentry };
  } finally {
    setEnv(saved);
    delete cache[configPath];
    if (realSentry) cache[sentryPath] = realSentry;
    else delete cache[sentryPath];
  }
}

describe('next.config.js (audit F01)', () => {
  const { config } = loadNextConfig({});

  it('turns the image endpoint off: the app uses no next/image, /_next/image answers 404', () => {
    expect(config.images?.unoptimized).toBe(true);
    const imageUses = walkCode(path.join(WEB, 'app')).concat(walkCode(path.join(WEB, 'components')))
      .filter((f) => /from ['"]next\/(image|legacy\/image)['"]/.test(readFileSync(f, 'utf8')));
    expect(imageUses).toEqual([]);
  });

  it('the installed Next.js answers /_next/image with 404 when images.unoptimized is set', () => {
    // Re-check on every Next.js upgrade (audit PR 9): the CI step "Image endpoint off" asks the
    // running app, this line pins where Next.js 14 does it.
    const server = readFileSync(path.join(path.dirname(createRequire(path.join(WEB, 'package.json')).resolve('next/package.json')), 'dist/server/next-server.js'), 'utf8');
    expect(server).toMatch(/imagesConfig\.unoptimized\)\s*\{\s*await this\.render404\(req, res\);/);
  });

  it('has no Server Action settings (the app has none)', () => {
    expect(config.experimental?.serverActions).toBeUndefined();
    expect(readFileSync(path.join(WEB, 'next.config.js'), 'utf8')).not.toMatch(/serverActions\s*:/);
  });

  it('never turns on public browser source maps', () => {
    expect(config.productionBrowserSourceMaps).toBeFalsy();
  });
});

describe('Sentry never leaves browser source maps in the build (side item)', () => {
  it('without an upload configured, no source maps are made', () => {
    for (const env of [{}, { SENTRY_DSN: 'https://k@o0.ingest.sentry.io/1' }, { SENTRY_AUTH_TOKEN: 't', SENTRY_ORG: 'o' }]) {
      const { sentry } = loadNextConfig(env);
      expect(sentry?.sourcemaps).toEqual({ disable: true, deleteSourcemapsAfterUpload: true });
    }
  });

  it('with an upload configured, they are made, uploaded and deleted after the upload', () => {
    const { sentry } = loadNextConfig({ SENTRY_AUTH_TOKEN: 't', SENTRY_ORG: 'o', SENTRY_PROJECT: 'p' });
    expect(sentry?.sourcemaps).toEqual({ disable: false, deleteSourcemapsAfterUpload: true });
  });

  it('does not pass the Sentry 7 options that Sentry 8 ignores', () => {
    const { sentry } = loadNextConfig({});
    expect(sentry).not.toHaveProperty('disableServerWebpackPlugin');
    expect(sentry).not.toHaveProperty('disableClientWebpackPlugin');
  });

  it('the build check finds any .map file under .next/static', () => {
    const next = path.join(tmp, 'next-out');
    mkdirSync(path.join(next, 'static', 'chunks', 'app'), { recursive: true });
    writeFileSync(path.join(next, 'static', 'chunks', 'app', 'page-1.js'), '');
    expect(browserSourceMaps(next)).toEqual([]);
    writeFileSync(path.join(next, 'static', 'chunks', 'app', 'page-1.js.map'), '{}');
    expect(browserSourceMaps(next).map((f) => path.basename(f))).toEqual(['page-1.js.map']);
    expect(browserSourceMaps(path.join(tmp, 'no-build'))).toEqual([]);
  });

  it('the last step of `pnpm build` removes every map left under .next/static, the CSS maps too', () => {
    // A local build with a (failing) Sentry upload: Sentry deleted the *.js.map files and left
    // two .css.map files in .next/static/css. The build script now ends with this removal.
    const pkg = JSON.parse(readFileSync(path.join(WEB, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    // Audit P5 added the upload parser step (after `next build`, which empties .next, and before the
    // map removal); review M3 the PDF renderer step.
    expect(pkg.scripts.build).toBe('prisma generate && next build && node scripts/build-upload-parser.mjs && node scripts/build-pdf-renderer.mjs && node scripts/remove-public-source-maps.mjs');
    const next = path.join(tmp, 'build-with-maps');
    for (const d of ['static/chunks/app', 'static/css', 'server/app']) mkdirSync(path.join(next, d), { recursive: true });
    for (const f of ['static/chunks/app/page-1.js', 'static/chunks/app/page-1.js.map', 'static/css/a.css', 'static/css/a.css.map', 'server/app/page.js.map']) {
      writeFileSync(path.join(next, f), '');
    }
    const out = execFileSync(process.execPath, [path.join(WEB, 'scripts/remove-public-source-maps.mjs'), next], { encoding: 'utf8' });
    expect(out).toContain('2 source map file(s) removed');
    expect(browserSourceMaps(next)).toEqual([]);
    expect(existsSync(path.join(next, 'static/chunks/app/page-1.js'))).toBe(true);
    expect(existsSync(path.join(next, 'static/css/a.css'))).toBe(true);
    expect(existsSync(path.join(next, 'server/app/page.js.map'))).toBe(true); // not served: kept for server stack traces
    // No build at all: nothing to remove, no failure.
    expect(execFileSync(process.execPath, [path.join(WEB, 'scripts/remove-public-source-maps.mjs'), path.join(tmp, 'none')], { encoding: 'utf8' })).toContain('0 source map');
  });
});

describe('the CI build check (scripts/check-build-output.ts)', () => {
  /** A fake app folder with a build: `actions` in the manifest, `maps` under .next/static. */
  function fakeApp(name: string, opts: { built?: boolean; actions?: string[]; maps?: string[]; directive?: boolean } = {}) {
    const app = path.join(tmp, name);
    mkdirSync(path.join(app, 'app'), { recursive: true });
    writeFileSync(path.join(app, 'app', 'page.tsx'), opts.directive ? `'${['use', 'server'].join(' ')}';\n` : 'export default function P() { return null; }\n');
    if (opts.built !== false) {
      mkdirSync(path.join(app, '.next', 'server'), { recursive: true });
      mkdirSync(path.join(app, '.next', 'static', 'chunks'), { recursive: true });
      const node = Object.fromEntries((opts.actions ?? []).map((id) => [id, { workers: {}, layer: {} }]));
      writeFileSync(path.join(app, '.next', 'server', 'server-reference-manifest.json'), JSON.stringify({ node, edge: {}, encryptionKey: 'x' }));
      for (const m of opts.maps ?? []) writeFileSync(path.join(app, '.next', 'static', 'chunks', m), '');
    }
    return app;
  }
  const problems = (app: string) => buildOutputProblems(app, [app]).map((p) => p.split(path.sep).join('/'));

  it('a clean build passes', () => {
    expect(problems(fakeApp('clean'))).toEqual([]);
  });

  it('fails on a Server Action in the manifest, a map, a directive, and on a missing build', () => {
    expect(problems(fakeApp('action', { actions: ['f'.repeat(40)] }))).toEqual([`the build contains a Server Action (id ${'f'.repeat(40)})`]);
    expect(problems(fakeApp('map', { maps: ['main-1.js.map'] }))).toEqual(['public source map in the build: .next/static/chunks/main-1.js.map']);
    expect(problems(fakeApp('directive', { directive: true }))).toEqual(['Server Action directive in app code: app/page.tsx:1']);
    expect(problems(fakeApp('unbuilt', { built: false }))).toEqual([
      '.next/server/server-reference-manifest.json is missing: run `next build` first',
      '.next/static is missing: run `next build` first',
    ]);
  });
});

// ---------------------------------------------------------------------------------------
// The upload parser bundle (audit P5): `next start` forks .next/upload-parser/parse.cjs
// ---------------------------------------------------------------------------------------

describe('the upload parser bundle (audit P5)', () => {
  const builder = createRequire(__filename)(path.join(WEB, 'scripts', 'upload-parser-build.cjs')) as {
    buildUploadParser(outDir: string): { file: string; inputs: string[] };
    inputProblems(inputs: string[]): string[];
  };
  const OK_INPUTS = [
    '../../node_modules/.pnpm/papaparse@5.5.3/node_modules/papaparse/papaparse.js',
    '../../node_modules/.pnpm/xlsx@0.20.2/node_modules/xlsx/xlsx.mjs',
    'lib/csv.ts',
    'lib/dispatch/order-headers.ts',
    'lib/upload-errors.ts',
    'lib/upload-limits.ts',
    'lib/upload-parse/child.ts',
    'lib/upload-parse/handler.ts',
    'lib/upload-parse/protocol.ts',
    'lib/workbook-guard.ts',
  ];
  function builtApp(name: string, opts: { bundle?: boolean; inputs?: string[]; map?: boolean } = {}) {
    const app = path.join(tmp, name);
    const dir = path.join(app, '.next', 'upload-parser');
    mkdirSync(dir, { recursive: true });
    if (opts.bundle !== false) writeFileSync(path.join(dir, 'parse.cjs'), '');
    writeFileSync(path.join(dir, 'stamp.json'), JSON.stringify({ inputs: Object.fromEntries((opts.inputs ?? OK_INPUTS).map((i) => [i, '1:1'])) }));
    if (opts.map) writeFileSync(path.join(dir, 'parse.cjs.map'), '{}');
    return app;
  }
  const problems = (app: string) => uploadParserProblems(app).map((p) => p.split(path.sep).join('/'));

  it('`pnpm build` bundles it with esbuild into a file plain node runs; it reads a file as `next start` runs it', async () => {
    const out = builder.buildUploadParser(path.join(tmp, 'parser-build'));
    expect(builder.inputProblems(out.inputs)).toEqual([]);
    // SheetJS's ESM build, as Next.js bundles it for the web and vitest loads it (not xlsx.js and its codepages).
    expect(out.inputs.filter((i) => /node_modules/.test(i)).map((i) => i.replace(/.*node_modules\//, '')).sort()).toEqual(['papaparse/papaparse.js', 'xlsx/xlsx.mjs']);
    expect(readFileSync(out.file, 'utf8')).not.toMatch(/sourceMappingURL/);
    expect(await uploadParserSmokeProblem(out.file)).toBeNull();
  }, 120_000);

  it('the bundle may hold only the parser, SheetJS (xlsx.mjs) and Papa Parse', () => {
    expect(builder.inputProblems(OK_INPUTS)).toEqual([]);
    expect(builder.inputProblems(OK_INPUTS.map((i) => i.replace('xlsx.mjs', 'xlsx.js')))).toEqual([
      'SheetJS is xlsx.js, not xlsx.mjs (the build Next.js and the tests use)',
    ]);
    expect(builder.inputProblems([...OK_INPUTS, 'lib/db.ts', '../../node_modules/.pnpm/@prisma+client@5.22.0/node_modules/@prisma/client/index.js'])).toEqual([
      'a module the parser must not hold: lib/db.ts',
      'a package the parser must not hold: ../../node_modules/.pnpm/@prisma+client@5.22.0/node_modules/@prisma/client/index.js',
    ]);
    expect(builder.inputProblems(OK_INPUTS.filter((i) => !i.includes('xlsx')))).toEqual(['SheetJS (xlsx.mjs) is not in the bundle']);
  });

  it('the CI build check fails when the bundle is missing, holds something else or has a source map; it passes a good one', () => {
    expect(problems(builtApp('parser-ok'))).toEqual([]);
    expect(problems(builtApp('parser-missing', { bundle: false }))).toEqual([
      '.next/upload-parser/parse.cjs is missing: run `pnpm build` (its step scripts/build-upload-parser.mjs makes it); without it every upload is refused',
    ]);
    expect(problems(builtApp('parser-cjs-sheetjs', { inputs: OK_INPUTS.map((i) => i.replace('xlsx.mjs', 'xlsx.js')) }))).toEqual([
      'upload parser: SheetJS is xlsx.js, not xlsx.mjs (the build Next.js and the tests use)',
    ]);
    expect(problems(builtApp('parser-map', { map: true }))).toEqual(['source map beside the upload parser: .next/upload-parser/parse.cjs.map']);
  });

  it('the CI build check runs the bundle: one that does not answer the rows fails it', async () => {
    const standIn = (mode: string) => path.join(WEB, 'tests', 'fixtures', 'upload-parser', `${mode}.cjs`);
    expect(await uploadParserSmokeProblem(standIn('crash'))).toMatch(/^the upload parser ended without an answer \(exit 7/);
    expect(await uploadParserSmokeProblem(standIn('garbage'), 5_000)).toMatch(/did not answer|ended without an answer/);
    expect(await uploadParserSmokeProblem(standIn('echo'))).toMatch(/^the upload parser answered /);
    expect(await uploadParserSmokeProblem(standIn('busy'), 1_000)).toBe('the upload parser did not answer within 1000 ms');
  }, 60_000);

  it('check-build-output.ts runs these checks after the others', () => {
    const src = readFileSync(path.join(WEB, 'scripts', 'check-build-output.ts'), 'utf8');
    expect(src).toMatch(/\.\.\.uploadParserProblems\(web\)/);
    expect(src).toMatch(/await uploadParserSmokeProblem\(path\.join\(web, '\.next', 'upload-parser', 'parse\.cjs'\)\)/);
  });
});

// ---------------------------------------------------------------------------------------
// The PDF renderer bundle (review M3): `next start` forks .next/pdf-renderer/render.cjs
// ---------------------------------------------------------------------------------------

describe('the PDF renderer bundle (review M3)', () => {
  const builder = createRequire(__filename)(path.join(WEB, 'scripts', 'pdf-renderer-build.cjs')) as {
    buildPdfRenderer(outDir: string): { file: string; inputs: string[]; imports: Record<string, string[]> };
    inputProblems(inputs: string[], imports: Record<string, string[]>): string[];
  };
  const OWN: Record<string, string[]> = {
    'lib/dispatch/driver-pack-pdf.tsx': ['@react-pdf/renderer', 'react'],
    'lib/dispatch/pdf-text.ts': [],
    'lib/dispatch/qr.ts': ['qrcode'],
    'lib/pdf-render/child.ts': [],
    'lib/pdf-render/handler.ts': [],
    'lib/pdf-render/protocol.ts': [],
  };
  const OK_INPUTS = [
    ...Object.keys(OWN),
    '../../node_modules/.pnpm/@react-pdf+renderer@3.4.5_react@18.3.1/node_modules/@react-pdf/renderer/lib/react-pdf.js',
    '../../node_modules/.pnpm/qrcode@1.5.4/node_modules/qrcode/lib/index.js',
    '../../node_modules/.pnpm/yoga-layout@2.0.1/node_modules/yoga-layout/dist/src/index.js',
  ];
  function builtApp(name: string, opts: { bundle?: boolean; inputs?: string[]; imports?: Record<string, string[]>; map?: boolean } = {}) {
    const app = path.join(tmp, name);
    const dir = path.join(app, '.next', 'pdf-renderer');
    mkdirSync(dir, { recursive: true });
    if (opts.bundle !== false) writeFileSync(path.join(dir, 'render.cjs'), '');
    const stamp = { inputs: Object.fromEntries((opts.inputs ?? OK_INPUTS).map((i) => [i, '1:1'])), imports: opts.imports ?? OWN };
    writeFileSync(path.join(dir, 'stamp.json'), JSON.stringify(stamp));
    if (opts.map) writeFileSync(path.join(dir, 'render.cjs.map'), '{}');
    return app;
  }
  const problems = (app: string) => pdfRendererProblems(app).map((p) => p.split(path.sep).join('/'));

  it('`pnpm build` bundles it with esbuild into a file plain node runs; it makes a PDF as `next start` runs it', async () => {
    const out = builder.buildPdfRenderer(path.join(tmp, 'renderer-build'));
    expect(builder.inputProblems(out.inputs, out.imports)).toEqual([]);
    // The renderer's own modules and nothing else of the app (no database client, no settings).
    expect(out.inputs.filter((i) => !/node_modules/.test(i)).sort()).toEqual(Object.keys(OWN).sort());
    expect(out.imports).toEqual(OWN);
    expect(readFileSync(out.file, 'utf8')).not.toMatch(/sourceMappingURL/);
    expect(await pdfRendererSmokeProblem(out.file)).toBeNull();
  }, 120_000);

  it("the bundle may hold only the renderer's own modules, and they may import only React, @react-pdf/renderer and qrcode", () => {
    expect(builder.inputProblems(OK_INPUTS, OWN)).toEqual([]);
    expect(builder.inputProblems([...OK_INPUTS, 'lib/db.ts', '../../node_modules/.pnpm/@prisma+client@5.22.0/node_modules/@prisma/client/index.js'], OWN)).toEqual([
      'a module the renderer must not hold: lib/db.ts',
      'a package the renderer must not hold: ../../node_modules/.pnpm/@prisma+client@5.22.0/node_modules/@prisma/client/index.js',
    ]);
    expect(builder.inputProblems(OK_INPUTS, { ...OWN, 'lib/dispatch/qr.ts': ['qrcode', 'exceljs'] })).toEqual([
      "lib/dispatch/qr.ts imports exceljs: the renderer's own modules may import only react, @react-pdf/renderer, qrcode",
    ]);
    expect(builder.inputProblems(OK_INPUTS.filter((i) => !i.includes('@react-pdf')), OWN)).toEqual(['@react-pdf/renderer is not in the bundle']);
  });

  it('the CI build check fails when the bundle is missing, holds something else or has a source map; it passes a good one', () => {
    expect(problems(builtApp('renderer-ok'))).toEqual([]);
    expect(problems(builtApp('renderer-missing', { bundle: false }))).toEqual([
      '.next/pdf-renderer/render.cjs is missing: run `pnpm build` (its step scripts/build-pdf-renderer.mjs makes it); without it every driver sheet is refused',
    ]);
    expect(problems(builtApp('renderer-db', { inputs: [...OK_INPUTS, 'lib/db.ts'] }))).toEqual(['pdf renderer: a module the renderer must not hold: lib/db.ts']);
    expect(problems(builtApp('renderer-map', { map: true }))).toEqual(['source map beside the PDF renderer: .next/pdf-renderer/render.cjs.map']);
  });

  it('the CI build check runs the bundle: one that does not answer a PDF fails it', async () => {
    const standIn = (dir: string, mode: string) => path.join(WEB, 'tests', 'fixtures', dir, `${mode}.cjs`);
    expect(await pdfRendererSmokeProblem(standIn('upload-parser', 'crash'))).toMatch(/^the PDF renderer ended without an answer \(exit 7/);
    expect(await pdfRendererSmokeProblem(standIn('upload-parser', 'garbage'), 5_000)).toMatch(/^the PDF renderer answered \{"hello":"world"\}/);
    expect(await pdfRendererSmokeProblem(standIn('pdf-renderer', 'echo'))).toMatch(/^the PDF renderer answered \{"ok":true,"pdf":"<\d+ bytes>"\}/);
    expect(await pdfRendererSmokeProblem(standIn('upload-parser', 'busy'), 1_000)).toBe('the PDF renderer did not answer within 1000 ms');
  }, 60_000);

  it('check-build-output.ts runs these checks after the others', () => {
    const src = readFileSync(path.join(WEB, 'scripts', 'check-build-output.ts'), 'utf8');
    expect(src).toMatch(/\.\.\.pdfRendererProblems\(web\)/);
    expect(src).toMatch(/await pdfRendererSmokeProblem\(path\.join\(web, '\.next', 'pdf-renderer', 'render\.cjs'\)\)/);
  });
});

// ---------------------------------------------------------------------------------------
// No Server Actions (owner decision 4)
// ---------------------------------------------------------------------------------------

function walkCode(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walkCode(p, out);
    } else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('no Server Actions until the Next.js upgrade (owner decision 4)', () => {
  const directive = `'${['use', 'server'].join(' ')}'`; // not written out, so this file never matches itself

  it('no use-server directive anywhere in the app code (apps/web, packages/)', () => {
    expect(findServerActionDirectives([WEB, path.join(REPO, 'packages')])).toEqual([]);
  });

  it('the guard finds the directive at the top of a file or inside a function, in any quotes', () => {
    const root = path.join(tmp, 'src');
    mkdirSync(path.join(root, 'app', 'orders'), { recursive: true });
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    writeFileSync(path.join(root, 'app', 'orders', 'actions.ts'), `${directive};\nexport async function save() {}\n`);
    writeFileSync(path.join(root, 'app', 'orders', 'page.tsx'), `export default function P() {\n  async function go() {\n    "${directive.slice(1, -1)}";\n  }\n  return null;\n}\n`);
    writeFileSync(path.join(root, 'app', 'orders', 'note.ts'), '// talks about server actions without the directive\nexport const x = 1;\n');
    writeFileSync(path.join(root, 'tests', 'guard.spec.ts'), `const s = ${directive};\n`);
    const hits = findServerActionDirectives([root]).map((h) => path.relative(root, h).split(path.sep).join('/'));
    expect(hits).toEqual(['app/orders/actions.ts:1', 'app/orders/page.tsx:3']);
  });

  it('a built manifest with no action passes; one with an action, or an unknown shape, fails', () => {
    // What `next build` wrote for RouteIQ (verifier build of 27 Sep 2026).
    expect(serverActionIds({ node: {}, edge: {} })).toEqual([]);
    const id = 'a'.repeat(40);
    expect(serverActionIds({ node: { [id]: { workers: { 'app/login/page': 1 }, layer: {} } }, edge: {} })).toEqual([id]);
    expect(serverActionIds({ node: {}, edge: { [id]: {} } })).toEqual([id]);
    expect(() => serverActionIds({})).toThrow(/expected/);
    expect(() => serverActionIds(null)).toThrow(/expected/);
  });

  it('CI runs the build check right after `next build`', () => {
    const ci = readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');
    const build = ci.indexOf('run: pnpm --filter @routeiq/web build');
    const check = ci.indexOf('run: pnpm --filter @routeiq/web exec tsx scripts/check-build-output.ts');
    expect(build).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(build);
    expect(ci).toMatch(/_next\/image\?url=%2Ffavicon\.ico&w=1&q=75'\)\s*\n\s*echo "\/_next\/image -> \$code"\s*\n\s*test "\$code" = 404/);
  });
});

// ---------------------------------------------------------------------------------------
// Local server binds to localhost (owner decision 4)
// ---------------------------------------------------------------------------------------

describe('the dev server binds to localhost (owner decision 4)', () => {
  // One of the recent critical Next.js advisories affects Windows hosts only. Until the Next.js
  // upgrade, the app must not listen on every interface when it runs on the maintainer's Windows
  // PC. `next dev` defaults to 0.0.0.0; `-H 127.0.0.1` keeps it on localhost. `start` (Railway)
  // must not carry `-H`, because Railway needs every interface.
  const pkg = JSON.parse(readFileSync(path.join(WEB, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

  it('`dev` binds 127.0.0.1 and `start` has no -H (localhost:3000 still works)', () => {
    expect(pkg.scripts.dev).toBe('next dev -H 127.0.0.1');
    expect(pkg.scripts.start).toBe('next start');
    expect(pkg.scripts.start).not.toMatch(/\s-H\b|--hostname/);
  });
});

// ---------------------------------------------------------------------------------------
// Node 22 LTS
// ---------------------------------------------------------------------------------------

describe('Node 22 LTS is pinned the same way everywhere', () => {
  it('root engines, .nvmrc, .node-version and CI all say 22', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { engines?: { node?: string } };
    // Nixpacks (Railway) takes the major from engines.node; Railpack, nvm, fnm and setup-node read the files.
    expect(pkg.engines?.node).toBe('22.x');
    expect(readFileSync(path.join(REPO, '.nvmrc'), 'utf8').trim()).toBe('22');
    expect(readFileSync(path.join(REPO, '.node-version'), 'utf8').trim()).toBe('22');
    const ci = readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('node-version-file: .nvmrc');
    expect(ci).not.toMatch(/node-version:\s*\d/);
  });
});
