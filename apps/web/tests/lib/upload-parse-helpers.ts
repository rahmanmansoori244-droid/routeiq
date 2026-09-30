/**
 * Helpers for the specs of the upload parser process (audit P5, lib/upload-parse). tests/setup.ts
 * makes every spec read uploads in-process; useRealUploadParser() gives a spec file the real
 * parser process (the bundle scripts/upload-parser-dev.cjs builds, as `next dev` runs it).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { setUploadParseTestOverrides, uploadParseState } from '@/lib/upload-parse';

const WEB = path.resolve(__dirname, '../..');
const g = globalThis as { __routeiqUploadParseInProcess?: unknown };

/** The stand-in parser processes of tests/fixtures/upload-parser (busy, crash, silent, garbage, hog, echo, flood, wide). */
export const standIn = (mode: 'busy' | 'crash' | 'silent' | 'garbage' | 'hog' | 'echo' | 'flood' | 'wide') =>
  path.join(WEB, 'tests', 'fixtures', 'upload-parser', `${mode}.cjs`);

/**
 * How much more of this process's JavaScript heap is in use, after a full garbage collection, while
 * `fn`'s result is kept than before it ran (V8's collector is switched on for this, as --expose-gc).
 */
export async function heapHeldBy<T>(fn: () => Promise<T>): Promise<{ result: T; heldMB: number }> {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  gc();
  const before = process.memoryUsage().heapUsed;
  const result = await fn();
  gc();
  return { result, heldMB: (process.memoryUsage().heapUsed - before) / 1024 / 1024 };
}

/** Builds the development parser bundle if a source changed (as the first upload would). */
export function buildParserBundle(): string {
  const builder = createRequire(__filename)(path.join(WEB, 'scripts', 'upload-parser-build.cjs')) as { ensureUploadParser(dir: string): string; DEV_OUT: string };
  return builder.ensureUploadParser(builder.DEV_OUT);
}

const ENV_KEYS = ['UPLOAD_WORKER_MAX_HEAP_MB', 'UPLOAD_PARSE_TIMEOUT_MS', 'UPLOAD_PARSE_CONCURRENCY'] as const;

/** The spec file reads uploads in the real parser process; the settings and overrides are reset after each test. */
export function useRealUploadParser(): void {
  let saved: unknown;
  const env = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  beforeAll(() => {
    saved = g.__routeiqUploadParseInProcess;
    g.__routeiqUploadParseInProcess = undefined;
    buildParserBundle(); // now, not within a test's time limit
  }, 120_000);
  afterEach(async () => {
    setUploadParseTestOverrides(null);
    for (const k of ENV_KEYS) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    await allGone();
  });
  afterAll(() => {
    g.__routeiqUploadParseInProcess = saved;
  });
}

/** Waits until no parse runs or waits and no parser process is left (a slot is freed when its process has closed). */
export async function allGone(timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const s = uploadParseState();
    if (s.active === 0 && s.waiting === 0 && s.children.length === 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(uploadParseState()).toEqual({ active: 0, waiting: 0, children: [] });
}

/** Whether a process is gone (process.kill(pid, 0) only asks). */
export function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Runs `fn` while a 5 ms timer measures the longest time this process did not run it (the event loop was blocked). */
export async function longestStall<T>(fn: () => Promise<T>): Promise<{ result: T; stallMs: number; elapsedMs: number }> {
  let last = performance.now();
  let stallMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    stallMs = Math.max(stallMs, now - last);
    last = now;
  }, 5);
  const t0 = performance.now();
  try {
    const result = await fn();
    // A call that never gave the loop back never let the timer run: count up to its end too.
    const now = performance.now();
    return { result, stallMs: Math.max(stallMs, now - last), elapsedMs: now - t0 };
  } finally {
    clearInterval(timer);
  }
}

/** A promise's outcome as data: `{ ok }` or the error's class, name and message (and code and sheets, if any). */
export async function outcome(p: Promise<unknown>): Promise<unknown> {
  try {
    return { ok: await p };
  } catch (e) {
    const err = e as Error & { code?: unknown; sheets?: unknown; status?: unknown };
    if (!(e instanceof Error)) return { thrown: e };
    return {
      error: {
        class: e.constructor.name,
        name: err.name,
        message: err.message,
        ...(err.code !== undefined ? { code: err.code } : {}),
        ...(err.sheets !== undefined ? { sheets: JSON.stringify(err.sheets) } : {}),
        ...(err.status !== undefined ? { status: err.status } : {}),
      },
    };
  }
}
