/**
 * Audit 27 Sep 2026, quick hardening (assessment PR 1):
 *  - F01: the image endpoint is off (images.unoptimized: /_next/image answers 404), the unused
 *    Server Action size setting is gone, and no Server Action can come in: no use-server
 *    directive in the app's code, none in the built manifest (the CI step runs the same checks
 *    on the real build: scripts/check-build-output.ts);
 *  - side item: browser source maps are not made unless they are uploaded to Sentry, and then
 *    deleted after the upload; none may be left in .next/static;
 *  - Node 22 LTS is pinned the same way everywhere (engines, .nvmrc, .node-version, CI).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { browserSourceMaps, buildOutputProblems, findServerActionDirectives, serverActionIds } from '@/scripts/build-guards';

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
    expect(pkg.scripts.build).toBe('prisma generate && next build && node scripts/remove-public-source-maps.mjs');
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
