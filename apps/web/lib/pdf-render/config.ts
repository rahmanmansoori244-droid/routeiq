/**
 * Settings of the PDF renderer process (review M3), from the environment. An unset or empty variable
 * takes its default; a value that is not a whole number in range takes the default too and is
 * reported once at startup (lib/startup-checks.ts).
 *
 *  - PDF_RENDER_MAX_HEAP_MB (1024): the renderer's JavaScript heap cap. A pack that needs more is
 *    refused ("needs too much memory"). Measured for the whole process (review M3, with driver-link
 *    QR codes): one load of 12 stops about 130 MB, a day of 25 loads and 300 stops about 460 MB (its
 *    heap under 256 MB: it was made with that cap too), 34 loads and 408 stops about 560 MB.
 *  - PDF_RENDER_TIMEOUT_MS (120000): after this the renderer process is killed and the pack refused
 *    ("takes too long to make"). Counted from the start of the process. The 300-stop day took 7-10 s
 *    on a busy PC (19 s with a 256 MB cap), the 408-stop day 12 s, one load about 1 s.
 *  - PDF_RENDER_CONCURRENCY (2): renderer processes at once in one web process. A further pack
 *    waits up to QUEUE_WAIT_MS for a free one (at most MAX_WAITING wait), then gets 503 "busy".
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface PdfRenderConfig {
  maxHeapMb: number;
  timeoutMs: number;
  concurrency: number;
}

const SETTINGS = [
  { key: 'maxHeapMb', env: 'PDF_RENDER_MAX_HEAP_MB', def: 1024, min: 128, max: 16_384 },
  { key: 'timeoutMs', env: 'PDF_RENDER_TIMEOUT_MS', def: 120_000, min: 1_000, max: 600_000 },
  { key: 'concurrency', env: 'PDF_RENDER_CONCURRENCY', def: 2, min: 1, max: 16 },
] as const;

export const PDF_RENDER_DEFAULTS: PdfRenderConfig = { maxHeapMb: 1024, timeoutMs: 120_000, concurrency: 2 };

/**
 * How long a pack waits for a free renderer process before it is answered 503 "busy". Longer than
 * an upload's 5 s: a whole day's pack takes seconds to make, so the one before it is soon done.
 */
export const QUEUE_WAIT_MS = 60_000;
/** Packs that may wait at once; one more is answered 503 at once. */
export const MAX_WAITING = 8;

function read(raw: string | undefined, s: (typeof SETTINGS)[number]): { value: number; problem: string | null } {
  const t = (raw ?? '').trim();
  if (!t) return { value: s.def, problem: null };
  const n = /^\d+$/.test(t) ? Number(t) : NaN;
  if (Number.isSafeInteger(n) && n >= s.min && n <= s.max) return { value: n, problem: null };
  return {
    value: s.def,
    problem: `${s.env}="${t}" is not a whole number from ${s.min} to ${s.max}: the default ${s.def} is used.`,
  };
}

export function pdfRenderConfig(env: NodeJS.ProcessEnv = process.env): PdfRenderConfig {
  const out = { ...PDF_RENDER_DEFAULTS };
  for (const s of SETTINGS) out[s.key] = read(env[s.env], s).value;
  return out;
}

/** The settings that are set but not usable (their default is used), as startup warnings. */
export function pdfRenderConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  return SETTINGS.flatMap((s) => read(env[s.env], s).problem ?? []);
}

/** Where `pnpm build` puts the renderer bundle, relative to the web app's folder (apps/web). */
export const RENDERER_BUNDLE = path.join('.next', 'pdf-renderer', 'render.cjs');
/** The development and test launcher (it builds the same bundle when its sources change). */
export const RENDERER_DEV_LAUNCHER = path.join('scripts', 'pdf-renderer-dev.cjs');

/**
 * The file the renderer process runs: the built bundle in production (`next start`, run from
 * apps/web as Railway and CI run it), the launcher elsewhere. Null when it is not there.
 */
export function rendererEntry(env: NodeJS.ProcessEnv = process.env, webDir = process.cwd(), exists: (p: string) => boolean = existsSync): string | null {
  const file = path.join(webDir, env.NODE_ENV === 'production' ? RENDERER_BUNDLE : RENDERER_DEV_LAUNCHER);
  return exists(file) ? file : null;
}

/** Startup error when a production server has no renderer bundle: every driver pack would be refused. */
export function pdfRendererStartupProblem(env: NodeJS.ProcessEnv = process.env, webDir = process.cwd(), exists: (p: string) => boolean = existsSync): string | null {
  if (env.NODE_ENV !== 'production' || rendererEntry(env, webDir, exists)) return null;
  return `The driver sheet (PDF) maker is missing (${path.join(webDir, RENDERER_BUNDLE)}): every driver sheet is refused. It is made by \`pnpm --filter @routeiq/web build\` (scripts/build-pdf-renderer.mjs); start the server from apps/web.`;
}
