/**
 * Settings of the upload parser process (audit P5), from the environment. An unset or empty variable
 * takes its default; a value that is not a whole number in range takes the default too and is
 * reported once at startup (lib/startup-checks.ts).
 *
 *  - UPLOAD_WORKER_MAX_HEAP_MB (512): the parser's JavaScript heap cap. A file that needs more is
 *    refused ("needs too much memory"); the process's memory as a whole is about this plus 100-150 MB.
 *  - UPLOAD_PARSE_TIMEOUT_MS (15000): after this the parser process is killed and the file refused
 *    ("takes too long to read"). Counted from the start of the process.
 *  - UPLOAD_PARSE_CONCURRENCY (2): parser processes at once in one web process. A further upload
 *    waits up to QUEUE_WAIT_MS for a free one (at most MAX_WAITING wait), then gets 503 "busy".
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface UploadParseConfig {
  maxHeapMb: number;
  timeoutMs: number;
  concurrency: number;
}

const SETTINGS = [
  { key: 'maxHeapMb', env: 'UPLOAD_WORKER_MAX_HEAP_MB', def: 512, min: 64, max: 16_384 },
  { key: 'timeoutMs', env: 'UPLOAD_PARSE_TIMEOUT_MS', def: 15_000, min: 250, max: 600_000 },
  { key: 'concurrency', env: 'UPLOAD_PARSE_CONCURRENCY', def: 2, min: 1, max: 16 },
] as const;

export const UPLOAD_PARSE_DEFAULTS: UploadParseConfig = { maxHeapMb: 512, timeoutMs: 15_000, concurrency: 2 };

/** How long an upload waits for a free parser process before it is answered 503 "busy". */
export const QUEUE_WAIT_MS = 5_000;
/** Uploads that may wait at once; one more is answered 503 at once. */
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

export function uploadParseConfig(env: NodeJS.ProcessEnv = process.env): UploadParseConfig {
  const out = { ...UPLOAD_PARSE_DEFAULTS };
  for (const s of SETTINGS) out[s.key] = read(env[s.env], s).value;
  return out;
}

/** The settings that are set but not usable (their default is used), as startup warnings. */
export function uploadParseConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  return SETTINGS.flatMap((s) => read(env[s.env], s).problem ?? []);
}

/** Where `pnpm build` puts the parser bundle, relative to the web app's folder (apps/web). */
export const PARSER_BUNDLE = path.join('.next', 'upload-parser', 'parse.cjs');
/** The development and test launcher (it builds the same bundle when its sources change). */
export const PARSER_DEV_LAUNCHER = path.join('scripts', 'upload-parser-dev.cjs');

/**
 * The file the parser process runs: the built bundle in production (`next start`, run from apps/web
 * as Railway and CI run it), the launcher elsewhere. Null when it is not there.
 */
export function parserEntry(env: NodeJS.ProcessEnv = process.env, webDir = process.cwd(), exists: (p: string) => boolean = existsSync): string | null {
  const file = path.join(webDir, env.NODE_ENV === 'production' ? PARSER_BUNDLE : PARSER_DEV_LAUNCHER);
  return exists(file) ? file : null;
}

/** Startup error when a production server has no parser bundle: every upload would be refused. */
export function uploadParserStartupProblem(env: NodeJS.ProcessEnv = process.env, webDir = process.cwd(), exists: (p: string) => boolean = existsSync): string | null {
  if (env.NODE_ENV !== 'production' || parserEntry(env, webDir, exists)) return null;
  return `The upload file reader is missing (${path.join(webDir, PARSER_BUNDLE)}): every file upload is refused. It is made by \`pnpm --filter @routeiq/web build\` (scripts/build-upload-parser.mjs); start the server from apps/web.`;
}
