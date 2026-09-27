/**
 * Checks that keep two things out of RouteIQ until the Next.js upgrade (audit 27 Sep 2026, F01
 * and the source-map side item; owner decision 4):
 *
 *  - Server Actions. The app has none, which is why the Next.js 14 advisories in the Server
 *    Action handler cannot reach it. A Server Action is made by the use-server directive (in the
 *    app's code or in a package it imports); either way it shows up in the built
 *    .next/server/server-reference-manifest.json. Both are checked.
 *  - Public source maps of the browser code (.map files under .next/static, which Next.js
 *    serves to anyone).
 *
 * Used by tests/lib/build-hardening.spec.ts (source) and scripts/check-build-output.ts (CI, after
 * `next build`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Skipped at any depth: dependencies and build output. */
const SKIP_DIRS = new Set(['node_modules', '.next', '.turbo']);
/** Skipped directly under a root: not app code (the tests mention the directive on purpose). */
const SKIP_TOP = new Set(['tests', 'scripts']);
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
// The directive, built here so this file does not contain it: 'use server' in any quotes.
const DIRECTIVE = new RegExp(`(['"\`])${['use', 'server'].join(' ')}\\1`);

function walk(dir: string, top: boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || (top && SKIP_TOP.has(name))) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, false, out);
    else if (CODE.test(name)) out.push(p);
  }
  return out;
}

/**
 * Every code file (with its line) under the given folders that contains the use-server
 * directive, in any quotes. node_modules and build output are skipped at any depth, a root's
 * own tests/ and scripts/ folders too (not app code).
 */
export function findServerActionDirectives(roots: string[]): string[] {
  const hits: string[] = [];
  for (const root of roots) {
    for (const file of walk(root, true)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (DIRECTIVE.test(line)) hits.push(`${file}:${i + 1}`);
      });
    }
  }
  return hits;
}

/**
 * The Server Action ids a built server-reference-manifest.json lists (Next.js 14: `node` and
 * `edge` maps keyed by action id). Anything that is not that shape throws, so a changed format
 * fails the check instead of passing it.
 */
export function serverActionIds(manifest: unknown): string[] {
  const m = manifest as { node?: unknown; edge?: unknown } | null;
  const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isMap(m) || !isMap(m.node) || !isMap(m.edge)) {
    throw new Error('server-reference-manifest.json does not have the expected { node: {...}, edge: {...} } shape');
  }
  return [...Object.keys(m.node), ...Object.keys(m.edge)];
}

/**
 * Everything wrong with a built app, as messages (empty = passes): a use-server directive under
 * `codeRoots`, a missing build, a Server Action in the manifest, a .map file under .next/static.
 * A missing or unreadable build output is a finding too, so the check never passes on nothing.
 */
export function buildOutputProblems(webDir: string, codeRoots: string[]): string[] {
  const rel = (p: string) => path.relative(webDir, p);
  const problems = findServerActionDirectives(codeRoots).map((hit) => `Server Action directive in app code: ${rel(hit)}`);
  const nextDir = path.join(webDir, '.next');
  const manifestPath = path.join(nextDir, 'server', 'server-reference-manifest.json');
  if (!existsSync(manifestPath)) {
    problems.push(`${rel(manifestPath)} is missing: run \`next build\` first`);
  } else {
    try {
      for (const id of serverActionIds(JSON.parse(readFileSync(manifestPath, 'utf8')))) problems.push(`the build contains a Server Action (id ${id})`);
    } catch (err) {
      problems.push(`${rel(manifestPath)}: ${(err as Error).message}`);
    }
  }
  if (!existsSync(path.join(nextDir, 'static'))) problems.push(`${rel(path.join(nextDir, 'static'))} is missing: run \`next build\` first`);
  for (const map of browserSourceMaps(nextDir)) problems.push(`public source map in the build: ${rel(map)}`);
  return problems;
}

/** Every .map file under <nextDir>/static: the files Next.js would serve publicly. */
export function browserSourceMaps(nextDir: string): string[] {
  const staticDir = path.join(nextDir, 'static');
  if (!existsSync(staticDir)) return [];
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) visit(p);
      else if (name.endsWith('.map')) out.push(p);
    }
  };
  visit(staticDir);
  return out;
}
