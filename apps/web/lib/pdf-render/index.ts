/**
 * Driver sheets (PDF) made outside the web process (review M3; scenario findings s8-scale-1,
 * s1-happy-day-4, web-exports-3).
 *
 * Laying out a driver pack with @react-pdf/renderer is CPU work that hardly gives the event loop
 * back: a whole day's pack (150-400 stops) took 8-30 s in the web process, and for 4-15 s at a time
 * (up to 42 s on a loaded machine) it answered nothing, not the other dispatchers' screens, not the
 * drivers' phones, not /api/health/live. Now renderDriverPackIsolated makes each pack in a separate,
 * short-lived Node process, the way uploads are read (lib/upload-parse, audit P5):
 *  - one fresh process per pack (child_process.fork of the renderer bundle, lib/pdf-render/child.ts):
 *    nothing is shared, and when it ends every byte it used is freed;
 *  - its heap is capped (--max-old-space-size = PDF_RENDER_MAX_HEAP_MB); a pack that needs more
 *    ends that process only, and is refused "needs too much memory";
 *  - it is killed (SIGKILL) after PDF_RENDER_TIMEOUT_MS, and the pack refused "takes too long";
 *  - at most PDF_RENDER_CONCURRENCY run at once; a further pack waits up to QUEUE_WAIT_MS, then gets
 *    503 "busy, try again in a moment";
 *  - its environment has no secrets (no DATABASE_URL, no tokens), and it inherits no Node flags.
 * The web process builds the model (driverPackModel: the database reads, the driver links, 10 ms of
 * work) and sends it; the renderer sends back the PDF's bytes (at most MAX_PDF_BYTES), so the web
 * process keeps answering meanwhile. The layout is the unchanged renderDriverPackPdf
 * (lib/dispatch/driver-pack-pdf.tsx), so every sheet prints as before.
 *
 * A process and not a worker thread, as for uploads: a worker's heap cap does not always end only
 * the worker (lib/upload-parse/index.ts).
 *
 * Tests render in-process unless a spec turns the real process on (tests/setup.ts; honoured outside
 * production only).
 */
import { fork, type ChildProcess } from 'node:child_process';
import { NextResponse } from 'next/server';
import type { DriverPackModel } from '../dispatch/driver-pack';
import { MAX_WAITING, pdfRenderConfig, pdfRendererStartupProblem, QUEUE_WAIT_MS, rendererEntry, type PdfRenderConfig } from './config';
import { CHECK_MODEL, isRenderReply, MAX_PDF_BYTES, type RenderReply, type RenderRequest } from './protocol';

export type PdfRefusalCode = 'PDF_TIMEOUT' | 'PDF_OUT_OF_MEMORY' | 'PDF_CRASHED' | 'PDF_BUSY' | 'PDF_UNAVAILABLE';

const SMALLER = 'Print them one truck or one load at a time (the PDF button of each load).';

/** The refusals of this module: what happened and what to do, and the answer's status. */
export const PDF_REFUSALS: Record<PdfRefusalCode, { status: number; message: string; retryAfterSec?: number }> = {
  PDF_TIMEOUT: { status: 500, message: `These driver sheets take too long to make, so they were not made. ${SMALLER}` },
  PDF_OUT_OF_MEMORY: { status: 500, message: `These driver sheets need too much memory to make, so they were not made. ${SMALLER}` },
  PDF_CRASHED: {
    status: 500,
    message: 'RouteIQ could not make the driver sheets: the PDF maker stopped. Try again. If it happens again, print one truck or one load at a time, or tell your administrator.',
  },
  PDF_BUSY: { status: 503, message: 'RouteIQ is making other driver sheets right now. Try again in a moment.', retryAfterSec: 30 },
  PDF_UNAVAILABLE: { status: 500, message: 'RouteIQ cannot make driver sheets right now: the PDF maker did not start. Tell your administrator.' },
};

/** A pack refused by this module (not by its content): the export route answers with its status. */
export class PdfRenderRefused extends Error {
  readonly status: number;
  readonly retryAfterSec?: number;
  constructor(readonly code: PdfRefusalCode) {
    super(PDF_REFUSALS[code].message);
    this.name = 'PdfRenderRefused';
    this.status = PDF_REFUSALS[code].status;
    this.retryAfterSec = PDF_REFUSALS[code].retryAfterSec;
  }
}

/** The route's answer to a PdfRenderRefused: `{ data: null, error: { code, message } }`, and Retry-After on 503. */
export function pdfRefusedResponse(err: PdfRenderRefused): NextResponse {
  return NextResponse.json(
    { data: null, error: { code: err.code, message: err.message } },
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
interface RenderState {
  active: number;
  waiting: Waiter[];
  children: Set<ChildProcess>;
}
const g = globalThis as unknown as {
  __routeiqPdfRenders?: RenderState;
  /** Set by tests/setup.ts: render in-process (outside production only). */
  __routeiqPdfRenderInProcess?: (req: RenderRequest) => Promise<RenderReply>;
};
const state: RenderState = g.__routeiqPdfRenders ?? { active: 0, waiting: [], children: new Set() };
g.__routeiqPdfRenders = state;

interface LastRun {
  pid: number | undefined;
  bytes: number;
  maxRssKB: number | undefined;
  ms: number;
}
let lastRun: LastRun | null = null;
/** The last renderer process that answered: its pid, the PDF's bytes, its peak memory, how long it took (tests, diagnostics). */
export function lastPdfRender(): LastRun | null {
  return lastRun;
}

/** Packs being made, packs waiting and the renderer processes alive (tests, diagnostics). */
export function pdfRenderState(): { active: number; waiting: number; children: number[] } {
  return { active: state.active, waiting: state.waiting.length, children: [...state.children].map((c) => c.pid ?? -1) };
}

interface TestOverrides {
  /** Another script to run as the renderer process; null: as if the renderer bundle were missing. */
  entry?: string | null;
  queueWaitMs?: number;
  maxWaiting?: number;
  /** A smaller limit on the PDF than MAX_PDF_BYTES. */
  maxPdfBytes?: number;
}
let testOverrides: TestOverrides = {};
/** Tests only (refused in production): another renderer entry, a shorter queue wait, a smaller PDF limit. Null resets. */
export function setPdfRenderTestOverrides(o: TestOverrides | null): void {
  if (process.env.NODE_ENV === 'production') throw new Error('setPdfRenderTestOverrides is for tests only');
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

/** A slot to make one pack; resolves with its release. Rejects PDF_BUSY when none is free in time. */
function acquireSlot(cfg: PdfRenderConfig): Promise<() => void> {
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
  if (state.waiting.length >= maxWaiting) return Promise.reject(new PdfRenderRefused('PDF_BUSY'));
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      grant: () => resolve(release),
      timer: setTimeout(() => {
        const at = state.waiting.indexOf(waiter);
        if (at >= 0) state.waiting.splice(at, 1);
        reject(new PdfRenderRefused('PDF_BUSY'));
      }, waitMs),
    };
    state.waiting.push(waiter);
  });
}

// ---------------------------------------------------------------------------------------------
// The renderer process
// ---------------------------------------------------------------------------------------------

/** Environment variables the renderer process gets (no secrets): time zone, locale, system paths. */
const PASS_ENV = new Set(['TZ', 'LANG', 'LC_ALL', 'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']);
function rendererEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && PASS_ENV.has(k.toUpperCase())) env[k] = v;
  return env;
}

/** The last part of the renderer's stderr kept (V8 prints "heap out of memory" there before it aborts). */
const STDERR_TAIL = 16_384;
/** How long after a kill the slot is kept at most, waiting for the process to be gone. */
const CLOSE_GRACE_MS = 10_000;

function exitRefusal(code: number | null, signal: NodeJS.Signals | null, stderr: string): PdfRefusalCode {
  // V8 prints "FATAL ERROR: ... JavaScript heap out of memory" and aborts (SIGABRT; exit 134 on
  // Windows). A SIGKILL this module did not send is the kernel's out-of-memory killer.
  if (/heap out of memory|reached heap limit|allocation failed/i.test(stderr)) return 'PDF_OUT_OF_MEMORY';
  if (signal === 'SIGABRT' || signal === 'SIGKILL' || code === 134) return 'PDF_OUT_OF_MEMORY';
  return 'PDF_CRASHED';
}

function runInChild(req: RenderRequest, cfg: PdfRenderConfig, release: () => void): Promise<{ reply: RenderReply; pid: number | undefined }> {
  const entry = testOverrides.entry !== undefined ? testOverrides.entry : rendererEntry();
  if (!entry) {
    release();
    log('error', 'the renderer bundle is missing: every driver pack is refused. Build with `pnpm --filter @routeiq/web build` and start the server from apps/web.');
    return Promise.reject(new PdfRenderRefused('PDF_UNAVAILABLE'));
  }
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = fork(entry, [], {
        // Only the heap cap: never the web process's own flags (--inspect, test runner options).
        execArgv: [`--max-old-space-size=${cfg.maxHeapMb}`],
        env: rendererEnv(),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        serialization: 'advanced',
      });
    } catch (err) {
      release();
      log('error', `the renderer process could not be started: ${(err as Error).message}`);
      reject(new PdfRenderRefused('PDF_UNAVAILABLE'));
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
          log('error', `renderer process ${pid} was still there ${CLOSE_GRACE_MS} ms after it was killed; its slot is freed`);
          finished();
        }, CLOSE_GRACE_MS);
        closeGuard.unref();
      }
      outcome();
    };
    const timer = setTimeout(() => settle(() => reject(new PdfRenderRefused('PDF_TIMEOUT'))), cfg.timeoutMs);

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    child.stderr?.on('error', () => {}); // a broken pipe of a killed process is not the web's problem
    child.on('message', (m: unknown) => {
      if (settled) return;
      if (!isRenderReply(m)) {
        settle(() => {
          log('error', `renderer process ${pid ?? '-'} sent something else than a PDF`);
          reject(new PdfRenderRefused('PDF_CRASHED'));
        });
        return;
      }
      settle(() => resolve({ reply: m, pid }));
    });
    child.on('error', (err) => {
      // Not started (no pid), or a kill or send that failed: the 'close' below decides otherwise.
      if (child.pid === undefined) {
        exited = true;
        settle(() => {
          log('error', `the renderer process could not be started: ${err.message}`);
          reject(new PdfRenderRefused('PDF_UNAVAILABLE'));
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
          why === 'PDF_CRASHED' ? 'error' : 'warn',
          `renderer process ${pid} ended without an answer (exit ${code ?? '-'}, signal ${signal ?? '-'})${why === 'PDF_CRASHED' ? `: ${stderr.slice(-1_000).trim()}` : ': out of memory'}`,
        );
        reject(new PdfRenderRefused(why));
      });
      finished();
    });
    child.send(req, (err) => {
      // It could not be sent (the process is already gone): its 'close' decides the outcome.
      if (err) log('warn', `the pack could not be sent to renderer process ${pid}: ${err.message}`);
    });
  });
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  if (process.env.NODE_ENV === 'test' && level !== 'error') return;
  console[level](`[pdf-render] ${message}`);
}

/**
 * The PDF's bytes from a reply: a PDF over the limit (said by the renderer, or counted here) is
 * refused "needs too much memory"; an error of the layout is thrown again with its name and message,
 * as renderDriverPackPdf threw it in the web process before.
 */
function replyPdf(reply: RenderReply, maxPdfBytes: number, pid: number | undefined): Buffer {
  if (reply.ok) {
    if (reply.pdf.byteLength > maxPdfBytes) {
      log('warn', `renderer process ${pid ?? '-'}: its PDF of ${reply.pdf.byteLength} bytes passes ${maxPdfBytes}: out of memory`);
      throw new PdfRenderRefused('PDF_OUT_OF_MEMORY');
    }
    return Buffer.from(reply.pdf.buffer, reply.pdf.byteOffset, reply.pdf.byteLength);
  }
  if ('tooLarge' in reply) {
    log('warn', `renderer process ${pid ?? '-'}: its PDF of ${reply.tooLarge} bytes would pass ${maxPdfBytes}: out of memory`);
    throw new PdfRenderRefused('PDF_OUT_OF_MEMORY');
  }
  const err = new Error(reply.error.message);
  err.name = reply.error.name;
  throw err;
}

/**
 * renderDriverPackPdf (lib/dispatch/driver-pack-pdf.tsx) for the export route, run in the renderer
 * process. The same PDF and the same errors; in addition PdfRenderRefused (too long, too much memory,
 * the PDF maker stopped or did not start, busy).
 */
export async function renderDriverPackIsolated(model: DriverPackModel): Promise<Buffer> {
  const cfg = pdfRenderConfig();
  const release = await acquireSlot(cfg);
  const t0 = performance.now();
  // runInChild frees the slot when its process is gone; until the pack is handed to it, this does.
  let handedOver = false;
  try {
    const maxPdfBytes = testOverrides.maxPdfBytes ?? MAX_PDF_BYTES;
    const req: RenderRequest = { model, maxPdfBytes };
    const inProcess = process.env.NODE_ENV !== 'production' ? g.__routeiqPdfRenderInProcess : undefined;
    if (inProcess) {
      // As the request and the answer cross the process boundary: each a structured copy.
      return replyPdf(structuredClone(await inProcess(structuredClone(req))), maxPdfBytes, undefined);
    }
    handedOver = true;
    const { reply, pid } = await runInChild(req, cfg, release);
    const pdf = replyPdf(reply, maxPdfBytes, pid);
    const ms = Math.round(performance.now() - t0);
    lastRun = { pid, bytes: pdf.byteLength, maxRssKB: reply.maxRssKB, ms };
    const peak = reply.maxRssKB ? `, renderer peak ${Math.round(reply.maxRssKB / 1024)} MB` : '';
    log('info', `made ${model.sheets.length} driver sheet(s), ${Math.round(pdf.byteLength / 1024)} KB, in ${ms} ms${peak} (process ${pid})`);
    return pdf;
  } catch (err) {
    if (err instanceof PdfRenderRefused && err.code !== 'PDF_BUSY') {
      log('warn', `${model.sheets.length} driver sheet(s) refused after ${Math.round(performance.now() - t0)} ms: ${err.code}`);
    }
    throw err;
  } finally {
    if (!handedOver) release();
  }
}

/**
 * The startup check of a production server (instrumentation.ts): makes one empty sheet in a renderer
 * process. Null when it works; else what to tell the operator (every driver pack would be refused).
 */
export async function checkPdfRenderer(): Promise<string | null> {
  const missing = pdfRendererStartupProblem();
  if (missing) return missing;
  try {
    const pdf = await renderDriverPackIsolated(CHECK_MODEL);
    if (pdf.subarray(0, 5).toString('latin1') === '%PDF-') return null;
    return 'The driver sheet (PDF) maker made something that is not a PDF at its startup check: driver sheets cannot be trusted. Check the server log above.';
  } catch (err) {
    return `The driver sheet (PDF) maker does not work (${(err as Error).message}): every driver sheet is refused. Check the server log above.`;
  }
}
