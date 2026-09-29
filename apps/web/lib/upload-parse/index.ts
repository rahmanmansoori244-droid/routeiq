/**
 * Upload parsing outside the web process (audit P5: E2's proper fix, owner decision 16).
 *
 * Reading a spreadsheet with SheetJS is synchronous and, for a file just under the upload caps, takes
 * seconds and up to about 1 GB. In the web process that froze every user's requests and could run it
 * out of memory. Now each upload (order file, late orders, customer import, baseline) is read by
 * parseUploadIsolated in a separate, short-lived Node process:
 *  - one fresh process per file (child_process.fork of the parser bundle, lib/upload-parse/child.ts):
 *    nothing is shared, and when it ends every byte it used is freed;
 *  - its heap is capped (--max-old-space-size = UPLOAD_WORKER_MAX_HEAP_MB); a file that needs more
 *    ends that process only, and is refused "needs too much memory";
 *  - it is killed (SIGKILL) after UPLOAD_PARSE_TIMEOUT_MS, and the file refused "takes too long";
 *  - at most UPLOAD_PARSE_CONCURRENCY run at once; a further upload waits up to QUEUE_WAIT_MS, then
 *    gets 503 "busy, try again in a moment";
 *  - its environment has no secrets (no DATABASE_URL, no tokens), and it inherits no Node flags.
 * The web process only sends the bytes and receives the rows, so it keeps answering meanwhile. The
 * answer is bounded here too (P5 review, protocol.ts): each text crosses once, and an answer of more
 * than MAX_RESULT_BYTES (128 MB) is refused "needs too much memory".
 *
 * Why a process and not a worker thread (the assessment said worker thread): a worker's heap cap
 * does not always end only the worker. With a legal 0.22 MB upload (50,000 rows x 49 columns) and a
 * 256 MB cap, V8 aborted the WHOLE process ("heap out of memory", exit 134) on Node 22 and 24, while
 * the same file in a child process with the same cap ended that child only.
 *
 * The file is read by the unchanged parseUpload (lib/csv), so every cap, refusal and message of the
 * A1 and A5 work is the same; errors come back as data and are thrown again here (protocol.ts). The
 * web process never loads SheetJS for an upload. Tests read in-process unless a spec turns the real
 * process on (tests/setup.ts; honoured outside production only).
 */
import { fork, type ChildProcess } from 'node:child_process';
import { NextResponse } from 'next/server';
import type { ParsedFile } from '../csv';
import { fileRefusal } from '../upload-limits';
import { MAX_WAITING, parserEntry, QUEUE_WAIT_MS, uploadParseConfig, uploadParserStartupProblem, type UploadParseConfig } from './config';
import { AnswerTooLargeError, answerMessages, decodeError, MAX_RESULT_BYTES, ReplyCollector, type ParseReply, type ParseRequest, type ParseSpec } from './protocol';

export type { ParseSpec } from './protocol';

export type UploadRefusalCode = 'UPLOAD_TIMEOUT' | 'UPLOAD_OUT_OF_MEMORY' | 'UPLOAD_CRASHED' | 'UPLOAD_BUSY' | 'UPLOAD_UNAVAILABLE';

const ADVICE =
  'Delete the rows and columns you do not need (also empty rows below your data), or split it into smaller files. Save as .xlsx or CSV and upload again.';

/** The refusals of this module: what happened and what to do, and the answer's status. */
export const UPLOAD_REFUSALS: Record<UploadRefusalCode, { status: number; message: string; retryAfterSec?: number }> = {
  UPLOAD_TIMEOUT: { status: 400, message: `This file takes too long to read, so it was not read. Nothing was saved. ${ADVICE}` },
  UPLOAD_OUT_OF_MEMORY: { status: 400, message: `This file needs too much memory to read, so it was not read. Nothing was saved. ${ADVICE}` },
  UPLOAD_CRASHED: {
    status: 500,
    message: 'RouteIQ could not read this file: the file reader stopped. Nothing was saved. Try again. If it happens again, save the file as .xlsx or CSV and upload that, or tell your administrator.',
  },
  UPLOAD_BUSY: { status: 503, message: 'RouteIQ is reading other files right now. Try again in a moment.', retryAfterSec: 5 },
  UPLOAD_UNAVAILABLE: { status: 500, message: 'RouteIQ cannot read files right now: the file reader did not start. Nothing was saved. Tell your administrator.' },
};

/** An upload refused by this module (not by the file's content): the routes answer with its status. */
export class UploadParseRefused extends Error {
  readonly status: number;
  readonly retryAfterSec?: number;
  constructor(readonly code: UploadRefusalCode) {
    super(UPLOAD_REFUSALS[code].message);
    this.name = 'UploadParseRefused';
    this.status = UPLOAD_REFUSALS[code].status;
    this.retryAfterSec = UPLOAD_REFUSALS[code].retryAfterSec;
  }
}

/** The routes' answer to an UploadParseRefused: `{ data: null, error }`, and Retry-After on 503. */
export function uploadRefusedResponse(err: UploadParseRefused): NextResponse {
  return NextResponse.json(
    { data: null, error: err.message },
    { status: err.status, headers: err.retryAfterSec ? { 'Retry-After': String(err.retryAfterSec) } : undefined },
  );
}

// ---------------------------------------------------------------------------------------------
// Per-process state (on globalThis, so `next dev` reloads and the instrumentation bundle share it)
// ---------------------------------------------------------------------------------------------

interface Waiter {
  grant: () => void;
  timer: NodeJS.Timeout;
}
interface ParseState {
  active: number;
  waiting: Waiter[];
  children: Set<ChildProcess>;
}
const g = globalThis as unknown as {
  __routeiqUploadParses?: ParseState;
  /** Set by tests/setup.ts: read in-process (outside production only). */
  __routeiqUploadParseInProcess?: (req: ParseRequest) => Promise<ParseReply>;
};
const state: ParseState = g.__routeiqUploadParses ?? { active: 0, waiting: [], children: new Set() };
g.__routeiqUploadParses = state;

interface LastRun {
  pid: number | undefined;
  /** Pieces of rows and bytes of the answer received. */
  pieces: number;
  bytes: number;
  maxRssKB: number | undefined;
  /** The answer would have passed its limit: the parser said so and stopped, or this process counted more. */
  tooLarge?: 'parser' | 'web';
}
let lastRun: LastRun | null = null;
/**
 * The last parser process that answered or was refused for too large an answer: its pid, the pieces
 * and bytes of the answer received, its peak memory (tests, diagnostics).
 */
export function lastUploadParse(): LastRun | null {
  return lastRun;
}

/** Parses running, uploads waiting and the parser processes alive (tests, diagnostics). */
export function uploadParseState(): { active: number; waiting: number; children: number[] } {
  return { active: state.active, waiting: state.waiting.length, children: [...state.children].map((c) => c.pid ?? -1) };
}

interface TestOverrides {
  /** Another script to run as the parser process; null: as if the parser bundle were missing. */
  entry?: string | null;
  queueWaitMs?: number;
  maxWaiting?: number;
  /** A smaller limit on the parser's answer than MAX_RESULT_BYTES. */
  maxResultBytes?: number;
}
let testOverrides: TestOverrides = {};
/** Tests only (refused in production): another parser entry, a shorter queue wait, a smaller answer limit. Null resets. */
export function setUploadParseTestOverrides(o: TestOverrides | null): void {
  if (process.env.NODE_ENV === 'production') throw new Error('setUploadParseTestOverrides is for tests only');
  testOverrides = o ?? {};
}

const once = (fn: () => void) => {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
};

/** A slot to run one parse; resolves with its release. Rejects UPLOAD_BUSY when none is free in time. */
function acquireSlot(cfg: UploadParseConfig): Promise<() => void> {
  const release = once(() => {
    const next = state.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.grant(); // the slot passes on: `active` stays
    } else {
      state.active = Math.max(0, state.active - 1);
    }
  });
  if (state.active < cfg.concurrency && state.waiting.length === 0) {
    state.active += 1;
    return Promise.resolve(release);
  }
  const waitMs = testOverrides.queueWaitMs ?? QUEUE_WAIT_MS;
  const maxWaiting = testOverrides.maxWaiting ?? MAX_WAITING;
  if (state.waiting.length >= maxWaiting) return Promise.reject(new UploadParseRefused('UPLOAD_BUSY'));
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      grant: () => resolve(release),
      timer: setTimeout(() => {
        const at = state.waiting.indexOf(waiter);
        if (at >= 0) state.waiting.splice(at, 1);
        reject(new UploadParseRefused('UPLOAD_BUSY'));
      }, waitMs),
    };
    state.waiting.push(waiter);
  });
}

// ---------------------------------------------------------------------------------------------
// The parser process
// ---------------------------------------------------------------------------------------------

/** Environment variables the parser process gets (no secrets): time zone, locale, system paths. */
const PASS_ENV = new Set(['TZ', 'LANG', 'LC_ALL', 'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']);
function parserEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && PASS_ENV.has(k.toUpperCase())) env[k] = v;
  return env;
}

/** The last part of the parser's stderr kept (V8 prints "heap out of memory" there before it aborts). */
const STDERR_TAIL = 16_384;
/** How long after a kill the slot is kept at most, waiting for the process to be gone. */
const CLOSE_GRACE_MS = 10_000;

function exitRefusal(code: number | null, signal: NodeJS.Signals | null, stderr: string): UploadRefusalCode {
  // V8 prints "FATAL ERROR: ... JavaScript heap out of memory" and aborts (SIGABRT; exit 134 on
  // Windows). A SIGKILL this module did not send is the kernel's out-of-memory killer.
  if (/heap out of memory|reached heap limit|allocation failed/i.test(stderr)) return 'UPLOAD_OUT_OF_MEMORY';
  if (signal === 'SIGABRT' || signal === 'SIGKILL' || code === 134) return 'UPLOAD_OUT_OF_MEMORY';
  return 'UPLOAD_CRASHED';
}

interface ChildRun {
  reply: ParseReply;
  pid: number | undefined;
}

/**
 * The refusal for an answer that could not be put together (protocol.ts): too large, "needs too much
 * memory" (the parser stopped before its limit, or this process counted more); anything else, "the
 * reader stopped".
 */
function answerRefusal(err: unknown, pid: number | undefined, collector: ReplyCollector): UploadParseRefused {
  if (err instanceof AnswerTooLargeError) {
    lastRun = { pid, pieces: collector.piecesReceived, bytes: collector.bytesReceived, maxRssKB: undefined, tooLarge: err.by };
    log('warn', `parser process ${pid ?? '-'}: its answer would pass ${mb(err.limit)} MB (${err.by === 'parser' ? 'it stopped' : `${mb(err.bytes)} MB counted here`}): out of memory`);
    return new UploadParseRefused('UPLOAD_OUT_OF_MEMORY');
  }
  log('error', `parser process ${pid ?? '-'}: ${(err as Error).message}`);
  return new UploadParseRefused('UPLOAD_CRASHED');
}

function runInChild(req: ParseRequest, cfg: UploadParseConfig, release: () => void): Promise<ChildRun> {
  const entry = testOverrides.entry !== undefined ? testOverrides.entry : parserEntry();
  if (!entry) {
    release();
    log('error', 'the parser bundle is missing: every upload is refused. Build with `pnpm --filter @routeiq/web build` and start the server from apps/web.');
    return Promise.reject(new UploadParseRefused('UPLOAD_UNAVAILABLE'));
  }
  return new Promise<ChildRun>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = fork(entry, [], {
        // Only the heap cap: never the web process's own flags (--inspect, test runner options).
        execArgv: [`--max-old-space-size=${cfg.maxHeapMb}`],
        env: parserEnv(),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        serialization: 'advanced',
      });
    } catch (err) {
      release();
      log('error', `the parser process could not be started: ${(err as Error).message}`);
      reject(new UploadParseRefused('UPLOAD_UNAVAILABLE'));
      return;
    }
    state.children.add(child);
    let settled = false;
    let exited = false;
    let stderr = '';
    const pid = child.pid;

    // The process is gone (or never started): free its slot. Nothing else points at it then.
    const finished = once(() => {
      clearTimeout(timer);
      clearTimeout(closeGuard);
      state.children.delete(child);
      child.stderr?.destroy();
      release();
    });
    let closeGuard: NodeJS.Timeout | undefined;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!exited) {
        child.kill('SIGKILL');
        closeGuard = setTimeout(() => {
          log('error', `parser process ${pid} was still there ${CLOSE_GRACE_MS} ms after it was killed; its slot is freed`);
          finished();
        }, CLOSE_GRACE_MS);
        closeGuard.unref();
      }
      outcome();
    };
    const timer = setTimeout(() => settle(() => reject(new UploadParseRefused('UPLOAD_TIMEOUT'))), cfg.timeoutMs);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    child.stderr?.on('error', () => {}); // a broken pipe of a killed process is not the web's problem
    // The rows come in pieces (protocol.ts), each counted, then turned into objects as it arrives;
    // an answer past its limit is refused and its process killed (settle).
    const collector = new ReplyCollector(req.maxResultBytes);
    child.on('message', (m: unknown) => {
      if (settled) return;
      let reply: ParseReply | null;
      try {
        reply = collector.add(m);
      } catch (err) {
        settle(() => reject(answerRefusal(err, pid, collector)));
        return;
      }
      if (reply) {
        lastRun = { pid, pieces: collector.piecesReceived, bytes: collector.bytesReceived, maxRssKB: reply.maxRssKB };
        settle(() => resolve({ reply: reply!, pid }));
      }
    });
    child.on('error', (err) => {
      // Not started (no pid), or a kill or send that failed: the 'close' below decides otherwise.
      if (child.pid === undefined) {
        exited = true;
        settle(() => {
          log('error', `the parser process could not be started: ${err.message}`);
          reject(new UploadParseRefused('UPLOAD_UNAVAILABLE'));
        });
        finished();
      }
    });
    child.once('exit', () => {
      exited = true;
    });
    // 'close' comes after the exit AND after every message was delivered (the IPC channel is
    // closed), so an answer sent just before the exit is never taken for a crash.
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      exited = true;
      settle(() => {
        const why = exitRefusal(code, signal, stderr);
        log(
          why === 'UPLOAD_CRASHED' ? 'error' : 'warn',
          `parser process ${pid} ended without an answer (exit ${code ?? '-'}, signal ${signal ?? '-'})${why === 'UPLOAD_CRASHED' ? `: ${stderr.slice(-1_000).trim()}` : ': out of memory'}`,
        );
        reject(new UploadParseRefused(why));
      });
      finished();
    });
    child.send(req, (err) => {
      // It could not be sent (the process is already gone): its 'close' decides the outcome.
      if (err) log('warn', `the file could not be sent to parser process ${pid}: ${err.message}`);
    });
  });
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  if (process.env.NODE_ENV === 'test' && level !== 'error') return;
  console[level](`[upload-parse] ${message}`);
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);

/**
 * parseUpload (lib/csv) for an upload route, run in the parser process. Same result and same errors
 * as parseUpload; in addition UploadParseRefused (too long, too much memory, the reader stopped,
 * busy). A file that is too large or of another type is refused here, before anything is started.
 */
export async function parseUploadIsolated(file: File, spec: ParseSpec = {}): Promise<ParsedFile> {
  const refused = fileRefusal(file);
  if (refused) throw new Error(refused);
  const cfg = uploadParseConfig();
  const release = await acquireSlot(cfg);
  let reply: ParseReply;
  const t0 = performance.now();
  // runInChild frees the slot when its process is gone; until the file is handed to it, this does.
  let handedOver = false;
  try {
    const maxResultBytes = testOverrides.maxResultBytes ?? MAX_RESULT_BYTES;
    const req: ParseRequest = { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()), spec, maxResultBytes };
    const inProcess = process.env.NODE_ENV !== 'production' ? g.__routeiqUploadParseInProcess : undefined;
    if (inProcess) {
      // As the answer crosses the process boundary: the same messages, each a structured copy.
      const collector = new ReplyCollector(maxResultBytes);
      let whole: ParseReply | null = null;
      const answer = await inProcess(structuredClone(req));
      try {
        for (const m of answerMessages(answer, { maxResultBytes })) whole = collector.add(structuredClone(m));
      } catch (err) {
        throw answerRefusal(err, undefined, collector);
      }
      if (!whole) throw answerRefusal(new Error('the answer ended before its reply'), undefined, collector);
      reply = whole;
    } else {
      handedOver = true;
      const run = await runInChild(req, cfg, release);
      reply = run.reply;
      const peak = reply.maxRssKB ? `, parser peak ${Math.round(reply.maxRssKB / 1024)} MB` : '';
      log('info', `read ${mb(file.size)} MB in ${Math.round(performance.now() - t0)} ms${peak} (process ${run.pid}): ${reply.ok ? `${reply.parsed.rows.length} rows` : 'refused'}`);
    }
  } catch (err) {
    if (err instanceof UploadParseRefused && err.code !== 'UPLOAD_BUSY') {
      log('warn', `${mb(file.size)} MB file refused after ${Math.round(performance.now() - t0)} ms: ${err.code}`);
    }
    throw err;
  } finally {
    if (!handedOver) release();
  }
  if (reply.ok) return reply.parsed;
  throw decodeError(reply.error, spec);
}

/**
 * The startup check of a production server (instrumentation.ts): reads a two-line CSV in a parser
 * process. Null when it works; else what to tell the operator (every upload would be refused).
 */
export async function checkUploadParser(): Promise<string | null> {
  const missing = uploadParserStartupProblem();
  if (missing) return missing;
  try {
    const parsed = await parseUploadIsolated(new File(['code,name\nC1,One\n'], 'startup-check.csv', { type: 'text/csv' }));
    if (parsed.rows.length === 1 && parsed.rows[0]!.code === 'C1') return null;
    return 'The upload file reader read its startup test file wrongly: file uploads cannot be trusted. Check the server log above.';
  } catch (err) {
    return `The upload file reader does not work (${(err as Error).message}): every file upload is refused. Check the server log above.`;
  }
}
