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
 * `next build`). So are the checks of the two bundles `pnpm build` adds after `next build`: the
 * upload parser (audit P5) and the PDF renderer (review M3).
 */
import { fork } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { CHECK_MODEL, isRenderReply } from '../lib/pdf-render/protocol';
import { ReplyCollector, type ParseReply } from '../lib/upload-parse/protocol';

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

// ---------------------------------------------------------------------------------------------
// The upload parser (audit P5)
// ---------------------------------------------------------------------------------------------

/** What scripts/upload-parser-build.cjs finds wrong with a bundle's inputs (the one list of what it may hold). */
function parserInputProblems(inputs: string[]): string[] {
  const builder = createRequire(__filename)(path.join(__dirname, 'upload-parser-build.cjs')) as { inputProblems(inputs: string[]): string[] };
  return builder.inputProblems(inputs);
}

/**
 * Everything wrong with the upload parser bundle of a built app (empty = passes): `next start` forks
 * <webDir>/.next/upload-parser/parse.cjs for each upload (lib/upload-parse), so without it every
 * upload is refused. It must be there, built only from the parser's own modules, SheetJS's ESM build
 * and Papa Parse (its stamp.json), with no source map beside it. Separate from buildOutputProblems,
 * whose findings the tests pin.
 */
export function uploadParserProblems(webDir: string): string[] {
  const rel = (p: string) => path.relative(webDir, p);
  const dir = path.join(webDir, '.next', 'upload-parser');
  const bundle = path.join(dir, 'parse.cjs');
  if (!existsSync(bundle)) {
    return [`${rel(bundle)} is missing: run \`pnpm build\` (its step scripts/build-upload-parser.mjs makes it); without it every upload is refused`];
  }
  const problems: string[] = [];
  const stampPath = path.join(dir, 'stamp.json');
  try {
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8')) as { inputs?: Record<string, unknown> };
    for (const p of parserInputProblems(Object.keys(stamp.inputs ?? {}))) problems.push(`upload parser: ${p}`);
  } catch {
    problems.push(`${rel(stampPath)} is missing or unreadable: build the upload parser again`);
  }
  for (const name of readdirSync(dir)) if (name.endsWith('.map')) problems.push(`source map beside the upload parser: ${rel(path.join(dir, name))}`);
  return problems;
}

/**
 * Runs the parser bundle once as `next start` does (forked, with a heap cap, no secrets) on a
 * two-line CSV. Null when it answered the right rows; else what went wrong.
 */
export function uploadParserSmokeProblem(bundle: string, timeoutMs = 30_000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = fork(bundle, [], {
      execArgv: ['--max-old-space-size=256'],
      env: { NODE_ENV: 'production', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
    });
    let stderr = '';
    let finished = false;
    // The answer is put together as the web process does it (lib/upload-parse/protocol.ts).
    const collector = new ReplyCollector();
    const done = (problem: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(problem);
    };
    const timer = setTimeout(() => done(`the upload parser did not answer within ${timeoutMs} ms`), timeoutMs);
    child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-2_000)));
    child.on('message', (m: { kind?: unknown }) => {
      // Messages of another kind are not an answer: it still has to come.
      if (m?.kind !== 'rows' && m?.kind !== 'reply' && m?.kind !== 'too-large') return;
      let reply: ParseReply | null;
      try {
        reply = collector.add(m);
      } catch (err) {
        done(`the upload parser answered something that could not be read: ${(err as Error).message}`);
        return;
      }
      if (reply) {
        const ok = reply.ok === true && reply.parsed.fileType === 'csv' && JSON.stringify(reply.parsed.rows) === JSON.stringify([{ code: 'C1', name: 'One' }]);
        done(ok ? null : `the upload parser answered ${JSON.stringify(reply).slice(0, 300)}`);
      }
    });
    child.on('error', (err) => done(`the upload parser could not be started: ${err.message}`));
    child.on('exit', (code, signal) => setTimeout(() => done(`the upload parser ended without an answer (exit ${code}, signal ${signal}): ${stderr.trim()}`), 500));
    child.send({ name: 'check.csv', type: 'text/csv', bytes: new Uint8Array(Buffer.from('code,name\nC1,One\n')), spec: {} });
  });
}

// ---------------------------------------------------------------------------------------------
// The PDF renderer (review M3)
// ---------------------------------------------------------------------------------------------

/** What scripts/pdf-renderer-build.cjs finds wrong with a bundle's inputs (the one list of what it may hold). */
function rendererInputProblems(inputs: string[], imports: Record<string, string[]>): string[] {
  const builder = createRequire(__filename)(path.join(__dirname, 'pdf-renderer-build.cjs')) as { inputProblems(inputs: string[], imports: Record<string, string[]>): string[] };
  return builder.inputProblems(inputs, imports);
}

/**
 * Everything wrong with the PDF renderer bundle of a built app (empty = passes): `next start` forks
 * <webDir>/.next/pdf-renderer/render.cjs for each driver pack (lib/pdf-render), so without it every
 * driver sheet is refused. It must be there, built only from the renderer's own modules and what
 * React, @react-pdf/renderer and qrcode bring in (its stamp.json), with no source map beside it.
 */
export function pdfRendererProblems(webDir: string): string[] {
  const rel = (p: string) => path.relative(webDir, p);
  const dir = path.join(webDir, '.next', 'pdf-renderer');
  const bundle = path.join(dir, 'render.cjs');
  if (!existsSync(bundle)) {
    return [`${rel(bundle)} is missing: run \`pnpm build\` (its step scripts/build-pdf-renderer.mjs makes it); without it every driver sheet is refused`];
  }
  const problems: string[] = [];
  const stampPath = path.join(dir, 'stamp.json');
  try {
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8')) as { inputs?: Record<string, unknown>; imports?: Record<string, string[]> };
    for (const p of rendererInputProblems(Object.keys(stamp.inputs ?? {}), stamp.imports ?? {})) problems.push(`pdf renderer: ${p}`);
  } catch {
    problems.push(`${rel(stampPath)} is missing or unreadable: build the PDF renderer again`);
  }
  for (const name of readdirSync(dir)) if (name.endsWith('.map')) problems.push(`source map beside the PDF renderer: ${rel(path.join(dir, name))}`);
  return problems;
}

/**
 * Runs the renderer bundle once as `next start` does (forked, with a heap cap, no secrets) on the
 * smallest pack (CHECK_MODEL). Null when it answered a PDF; else what went wrong.
 */
export function pdfRendererSmokeProblem(bundle: string, timeoutMs = 60_000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = fork(bundle, [], {
      execArgv: ['--max-old-space-size=512'],
      env: { NODE_ENV: 'production', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
    });
    let stderr = '';
    let finished = false;
    const done = (problem: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(problem);
    };
    const timer = setTimeout(() => done(`the PDF renderer did not answer within ${timeoutMs} ms`), timeoutMs);
    child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-2_000)));
    child.on('message', (m: unknown) => {
      const ok = isRenderReply(m) && m.ok && Buffer.from(m.pdf.subarray(0, 5)).toString('latin1') === '%PDF-';
      done(ok ? null : `the PDF renderer answered ${JSON.stringify(m, (_k, v: unknown) => (v instanceof Uint8Array ? `<${v.byteLength} bytes>` : v)).slice(0, 300)}`);
    });
    child.on('error', (err) => done(`the PDF renderer could not be started: ${err.message}`));
    child.on('exit', (code, signal) => setTimeout(() => done(`the PDF renderer ended without an answer (exit ${code}, signal ${signal}): ${stderr.trim()}`), 500));
    child.send({ model: CHECK_MODEL });
  });
}
