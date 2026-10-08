/**
 * Review M3 (scenario findings s8-scale-1, s1-happy-day-4, web-exports-3): making the driver sheets
 * can no longer freeze the web process. Each pack is laid out in its own short-lived renderer process
 * (lib/pdf-render), the way uploads are read (lib/upload-parse, audit P5):
 *  - the web process keeps running its own work while a pack is made (its event loop is free), and
 *    the PDF is the one renderDriverPackPdf makes in this process;
 *  - a pack that takes longer than PDF_RENDER_TIMEOUT_MS is refused and its process is killed;
 *  - a pack that needs more memory than PDF_RENDER_MAX_HEAP_MB is refused; only the renderer process
 *    ends ("heap out of memory"), not this one;
 *  - a renderer that stops without an answer, or answers nonsense, is a plain refusal (500); an error
 *    of the layout itself comes back as that error;
 *  - at most PDF_RENDER_CONCURRENCY run at once; a further pack waits, then gets 503;
 *  - the renderer gets no secrets and none of this process's Node flags;
 *  - the PDF it sends back is at most MAX_PDF_BYTES;
 *  - nothing is left behind: no process, no slot, no timer.
 * The stand-in renderers are in tests/fixtures/pdf-renderer and tests/fixtures/upload-parser.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { driverPackModel, type DriverPackModel } from '@/lib/dispatch/driver-pack';
import { renderDriverPackPdf } from '@/lib/dispatch/driver-pack-pdf';
import type { PlanDetail } from '@/lib/dispatch/plan-detail';
import { MAX_WAITING, pdfRenderConfig, pdfRenderConfigProblems, pdfRendererStartupProblem, QUEUE_WAIT_MS, rendererEntry } from '@/lib/pdf-render/config';
import { checkPdfRenderer, lastPdfRender, PDF_REFUSALS, pdfRenderState, renderDriverPackIsolated, setPdfRenderTestOverrides } from '@/lib/pdf-render';
import { MAX_PDF_BYTES } from '@/lib/pdf-render/protocol';
import { fixture, load, ORDERS, stop } from './plan-detail-fixture';
import { longestStall, outcome, processGone } from './upload-parse-helpers';

const WEB = path.resolve(__dirname, '../..');
const g = globalThis as { __routeiqPdfRenderInProcess?: unknown };
const ENV_KEYS = ['PDF_RENDER_MAX_HEAP_MB', 'PDF_RENDER_TIMEOUT_MS', 'PDF_RENDER_CONCURRENCY'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let savedInProcess: unknown;

// This spec makes packs in the real renderer process (tests/setup.ts makes them in this process).
beforeAll(() => {
  savedInProcess = g.__routeiqPdfRenderInProcess;
  g.__routeiqPdfRenderInProcess = undefined;
  // The development bundle, built now (as the first pack would), not within a test's time limit.
  const builder = createRequire(__filename)(path.join(WEB, 'scripts', 'pdf-renderer-build.cjs')) as { ensurePdfRenderer(dir: string): string; DEV_OUT: string };
  builder.ensurePdfRenderer(builder.DEV_OUT);
}, 120_000);
afterEach(async () => {
  setPdfRenderTestOverrides(null);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await allGone();
});
afterAll(() => {
  g.__routeiqPdfRenderInProcess = savedInProcess;
});

const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;
const setNodeEnv = (v: string | undefined) => {
  (process.env as Record<string, string | undefined>).NODE_ENV = v;
};
const standIn = (mode: 'echo' | 'big') => path.join(WEB, 'tests', 'fixtures', 'pdf-renderer', `${mode}.cjs`);
/** The upload parser's stand-ins that answer nothing or nonsense, whatever they are sent. */
const silentStandIn = (mode: 'busy' | 'crash' | 'silent' | 'garbage' | 'hog') => path.join(WEB, 'tests', 'fixtures', 'upload-parser', `${mode}.cjs`);
const refusal = (code: keyof typeof PDF_REFUSALS) => ({
  error: { class: 'PdfRenderRefused', name: 'PdfRenderRefused', message: PDF_REFUSALS[code].message, code, status: PDF_REFUSALS[code].status },
});

/** A plan of `loads` loads of `stops` stops each (the fixture's customers in turn), and its pack with driver links. */
function pack(loads: number, stops: number): DriverPackModel {
  const d: PlanDetail = fixture();
  const ids = ORDERS.map((o) => o.id);
  d.loads = Array.from({ length: loads }, (_, li) =>
    load(`L${li}`, `t${li}`, `T${String(li + 1).padStart(2, '0')}`, 1, Array.from({ length: stops }, (_, i) => stop(ids[i % ids.length]!, i + 1, 4, 4 * (i + 1), 380 + 20 * i)), false),
  );
  const links = new Map(d.loads.map((l) => [l.truckId, { kind: 'QR' as const, url: `https://routeiq.example/d/${'x'.repeat(43)}${l.truckId}` }]));
  return driverPackModel(d, { tenantName: 'NMWC Test', driverLinks: links });
}

/**
 * The objects of a PDF by number, each stream inflated, without its creation date: the one thing that
 * changes from one making to the next (the file's /ID is made from it; pdfkit may also write the
 * objects in another order, so their offsets are not compared).
 */
function pdfObjects(pdf: Buffer): Map<string, string> {
  const raw = pdf.toString('latin1');
  const out = new Map<string, string>();
  const re = /(\d+) 0 obj([\s\S]*?)endobj/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    let body = m[2]!;
    const at = body.indexOf('stream');
    if (at >= 0) {
      const start = at + 'stream'.length + (body[at + 6] === '\r' ? 2 : 1);
      const bytes = Buffer.from(body.slice(start, body.lastIndexOf('endstream')), 'latin1');
      let content: string;
      try {
        content = inflateSync(bytes).toString('latin1');
      } catch {
        content = bytes.toString('latin1');
      }
      body = `${body.slice(0, at)}stream ${content}`;
    }
    out.set(m[1]!, body.replace(/\(D:\d{14}Z\)/g, '(D:date)'));
  }
  return out;
}

/** The numbers of the objects two PDFs do not have alike (empty: the same document). */
function differentObjects(a: Buffer, b: Buffer): string[] {
  const [oa, ob] = [pdfObjects(a), pdfObjects(b)];
  const numbers = new Set([...oa.keys(), ...ob.keys()]);
  return [...numbers].filter((n) => oa.get(n) !== ob.get(n));
}

/** Waits until no pack is made or waits and no renderer process is left (a slot is freed when its process has closed). */
async function allGone(timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const s = pdfRenderState();
    if (s.active === 0 && s.waiting === 0 && s.children.length === 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(pdfRenderState()).toEqual({ active: 0, waiting: 0, children: [] });
}

/** The pid of the renderer process that is running now (waits for it to start). */
async function runningRenderer(): Promise<number> {
  for (let i = 0; i < 500; i++) {
    const [pid] = pdfRenderState().children;
    if (pid && pid > 0) return pid;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no renderer process started');
}

describe('the pack is made in another process, and this one keeps running (review M3)', () => {
  // 12 loads of 12 stops, each with its driver-link and route QR codes: 2-6 s of layout.
  const day = pack(12, 12);

  it('the renderer is a separate process, and the PDF is the one this process would make', async () => {
    const pdf = await renderDriverPackIsolated(day);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(lastPdfRender()).toMatchObject({ pid: expect.any(Number), bytes: pdf.byteLength });
    expect(lastPdfRender()!.pid).not.toBe(process.pid);
    const here = await renderDriverPackPdf(day);
    expect(pdfObjects(pdf).size).toBeGreaterThan(day.sheets.length);
    expect(differentObjects(pdf, here)).toEqual([]);
  });

  it('while a day is made, the event loop of this process is never blocked for long', async () => {
    // In the web process (before) the loop was blocked for seconds at a time (review M3).
    const { result, stallMs, elapsedMs } = await longestStall(() => outcome(renderDriverPackIsolated(day)));
    expect(result).toEqual({ ok: expect.any(Buffer) });
    expect(elapsedMs).toBeGreaterThan(1_000);
    // Starting a process blocks the caller briefly (a few ms on Linux; up to several hundred on a
    // busy Windows PC).
    expect(stallMs).toBeLessThan(Math.min(1_000, elapsedMs / 2));
  });

  it('in-process (as before) the same day blocks the loop for seconds: the check above would fail', async () => {
    // Measured: 2.4-2.6 s in one go of the 3.8-4.4 s the layout took.
    const { stallMs, elapsedMs } = await longestStall(() => outcome(renderDriverPackPdf(day)));
    expect(stallMs).toBeGreaterThanOrEqual(Math.min(1_000, elapsedMs / 2));
  });

  it('an error of the layout comes back as that error (its name and message)', async () => {
    const broken = { ...day, sheets: null } as unknown as DriverPackModel;
    const here = (await outcome(renderDriverPackPdf(broken))) as { error: { name: string; message: string } };
    expect(here.error.name).toBe('TypeError');
    expect(await outcome(renderDriverPackIsolated(broken))).toEqual({ error: { class: 'Error', name: here.error.name, message: here.error.message } });
  });
});

describe('a pack that takes too long is refused and its process killed (PDF_RENDER_TIMEOUT_MS)', () => {
  it('a renderer that never gives the loop back is killed at the time limit', async () => {
    process.env.PDF_RENDER_TIMEOUT_MS = '1000';
    setPdfRenderTestOverrides({ entry: silentStandIn('busy') });
    const pending = outcome(renderDriverPackIsolated(pack(1, 2)));
    const pid = await runningRenderer();
    const t0 = performance.now();
    expect(await pending).toEqual(refusal('PDF_TIMEOUT'));
    expect(performance.now() - t0).toBeLessThan(2_500);
    await allGone();
    expect(processGone(pid)).toBe(true);
  });

  it('the real renderer making a day is killed at the time limit; with the default limit it makes it', async () => {
    process.env.PDF_RENDER_TIMEOUT_MS = '1000';
    const day = pack(20, 12);
    const pending = outcome(renderDriverPackIsolated(day));
    const pid = await runningRenderer();
    expect(await pending).toEqual(refusal('PDF_TIMEOUT'));
    await allGone();
    expect(processGone(pid)).toBe(true);
    delete process.env.PDF_RENDER_TIMEOUT_MS;
    expect(await outcome(renderDriverPackIsolated(day))).toEqual({ ok: expect.any(Buffer) });
  });
});

describe('a pack that needs too much memory is refused; only the renderer process ends (PDF_RENDER_MAX_HEAP_MB)', () => {
  it('a renderer that allocates without end: V8 aborts it ("heap out of memory"), "needs too much memory", and this process goes on', async () => {
    process.env.PDF_RENDER_MAX_HEAP_MB = '128';
    setPdfRenderTestOverrides({ entry: silentStandIn('hog') });
    expect(await outcome(renderDriverPackIsolated(pack(1, 2)))).toEqual(refusal('PDF_OUT_OF_MEMORY'));
    // With the default cap a pack is made as before.
    delete process.env.PDF_RENDER_MAX_HEAP_MB;
    setPdfRenderTestOverrides(null);
    expect(await outcome(renderDriverPackIsolated(pack(1, 2)))).toEqual({ ok: expect.any(Buffer) });
  });
});

describe('a renderer that stops or answers nonsense is a plain refusal', () => {
  it.each(['crash', 'silent', 'garbage'] as const)('%s: "the PDF maker stopped" (500)', async (mode) => {
    setPdfRenderTestOverrides({ entry: silentStandIn(mode) });
    expect(await outcome(renderDriverPackIsolated(pack(1, 2)))).toEqual(refusal('PDF_CRASHED'));
  });

  it('no renderer bundle: "the PDF maker did not start" (500), and no process is started', async () => {
    setPdfRenderTestOverrides({ entry: null });
    expect(await outcome(renderDriverPackIsolated(pack(1, 2)))).toEqual(refusal('PDF_UNAVAILABLE'));
    expect(pdfRenderState()).toEqual({ active: 0, waiting: 0, children: [] });
  });
});

describe('the PDF that comes back is bounded (MAX_PDF_BYTES)', () => {
  it('a PDF over the limit is refused "needs too much memory": the renderer says so and sends none of it', async () => {
    setPdfRenderTestOverrides({ maxPdfBytes: 20_000 });
    expect(await outcome(renderDriverPackIsolated(pack(1, 12)))).toEqual(refusal('PDF_OUT_OF_MEMORY'));
    setPdfRenderTestOverrides(null);
    expect(await outcome(renderDriverPackIsolated(pack(1, 12)))).toEqual({ ok: expect.any(Buffer) });
  });

  it('a renderer that sends more anyway is refused here: the same refusal', async () => {
    setPdfRenderTestOverrides({ entry: standIn('big'), maxPdfBytes: 1024 * 1024 });
    expect(await outcome(renderDriverPackIsolated(pack(1, 2)))).toEqual(refusal('PDF_OUT_OF_MEMORY'));
  });

  it('the limit is 64 MB; a whole day of 400 stops is about 1.7 MB', () => {
    expect(MAX_PDF_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe('at most PDF_RENDER_CONCURRENCY packs at once; more wait, then get 503', () => {
  it('a second pack waits for the slot, then is answered "busy" (503, Retry-After); one more than may wait is answered at once', async () => {
    process.env.PDF_RENDER_CONCURRENCY = '1';
    process.env.PDF_RENDER_TIMEOUT_MS = '2500';
    setPdfRenderTestOverrides({ entry: silentStandIn('busy'), queueWaitMs: 300, maxWaiting: 1 });
    const first = outcome(renderDriverPackIsolated(pack(1, 2)));
    await runningRenderer();
    const t0 = performance.now();
    const second = outcome(renderDriverPackIsolated(pack(1, 2)));
    const third = await outcome(renderDriverPackIsolated(pack(1, 2))); // the queue (1) is full
    expect(third).toEqual(refusal('PDF_BUSY'));
    expect(performance.now() - t0).toBeLessThan(250);
    expect(await second).toEqual(refusal('PDF_BUSY'));
    expect(performance.now() - t0).toBeGreaterThanOrEqual(280);
    expect(await first).toEqual(refusal('PDF_TIMEOUT'));
    expect([PDF_REFUSALS.PDF_BUSY.status, PDF_REFUSALS.PDF_BUSY.retryAfterSec]).toEqual([503, 30]);
  });

  it('a waiting pack gets the slot as soon as it is free, and is made', async () => {
    process.env.PDF_RENDER_CONCURRENCY = '1';
    const results = await Promise.all([1, 2, 3].map((n) => renderDriverPackIsolated(pack(n, 2))));
    expect(results.map((r) => r.subarray(0, 5).toString('latin1'))).toEqual(['%PDF-', '%PDF-', '%PDF-']);
  });

  it('the defaults: 2 at once, 8 waiting at most, 60 s wait, 2 min, a 1 GB heap', () => {
    expect(pdfRenderConfig(env({}))).toEqual({ maxHeapMb: 1024, timeoutMs: 120_000, concurrency: 2 });
    expect([MAX_WAITING, QUEUE_WAIT_MS]).toEqual([8, 60_000]);
  });
});

describe('the renderer process gets no secrets and no Node flags of this process', () => {
  it('its environment has only the time zone, locale and system paths; its flags are the heap cap only', async () => {
    process.env.DATABASE_URL ??= 'postgresql://user:secret@localhost:5432/x';
    process.env.ROUTEIQ_M3_TEST_SECRET = 'must-not-leak';
    process.env.PDF_RENDER_MAX_HEAP_MB = '300';
    setPdfRenderTestOverrides({ entry: standIn('echo') });
    try {
      const info = JSON.parse((await renderDriverPackIsolated(pack(3, 2))).toString('utf8')) as { env: string; execArgv: string; pid: number; sheets: number };
      const names = info.env.split(',').map((n) => n.toUpperCase());
      const passed = ['NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'];
      const nodeIpc = ['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE'];
      // Windows adds these to every new process when they are missing (libuv's required variables).
      const windows = process.platform === 'win32' ? ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME', 'USERPROFILE'] : [];
      expect(names.filter((n) => ![...passed, ...nodeIpc, ...windows].includes(n))).toEqual([]);
      expect(names).not.toContain('DATABASE_URL');
      expect(info.execArgv).toBe('--max-old-space-size=300');
      expect(info.pid).not.toBe(process.pid);
      expect(info.sheets).toBe(3); // the model crossed whole
    } finally {
      delete process.env.ROUTEIQ_M3_TEST_SECRET;
    }
  });
});

describe('nothing is left behind', () => {
  it('after 20 packs (made, refused, killed): no process, no slot, no timer or handle, no listener', async () => {
    const handles = () => process.getActiveResourcesInfo().filter((r) => r !== 'TTYWrap').length;
    const listeners = () => ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'].map((e) => process.listenerCount(e));
    await renderDriverPackIsolated(pack(1, 1));
    await allGone();
    const before = { handles: handles(), listeners: listeners() };
    process.env.PDF_RENDER_TIMEOUT_MS = '1000';
    for (let i = 0; i < 20; i++) {
      if (i % 5 === 4) setPdfRenderTestOverrides({ entry: silentStandIn('busy') });
      else if (i % 5 === 3) setPdfRenderTestOverrides({ entry: silentStandIn('crash') });
      else setPdfRenderTestOverrides(null);
      await outcome(renderDriverPackIsolated(pack(1, 1)));
    }
    await allGone();
    expect({ handles: handles(), listeners: listeners() }).toEqual(before);
  });
});

describe('settings (PDF_RENDER_MAX_HEAP_MB, PDF_RENDER_TIMEOUT_MS, PDF_RENDER_CONCURRENCY)', () => {
  it('reads whole numbers in range; anything else takes the default and is named at startup', () => {
    expect(pdfRenderConfig(env({ PDF_RENDER_MAX_HEAP_MB: ' 768 ', PDF_RENDER_TIMEOUT_MS: '30000', PDF_RENDER_CONCURRENCY: '1' }))).toEqual({ maxHeapMb: 768, timeoutMs: 30_000, concurrency: 1 });
    const bad = env({ PDF_RENDER_MAX_HEAP_MB: '1GB', PDF_RENDER_TIMEOUT_MS: '10', PDF_RENDER_CONCURRENCY: '0' });
    expect(pdfRenderConfig(bad)).toEqual({ maxHeapMb: 1024, timeoutMs: 120_000, concurrency: 2 });
    expect(pdfRenderConfigProblems(bad)).toEqual([
      'PDF_RENDER_MAX_HEAP_MB="1GB" is not a whole number from 128 to 16384: the default 1024 is used.',
      'PDF_RENDER_TIMEOUT_MS="10" is not a whole number from 1000 to 600000: the default 120000 is used.',
      'PDF_RENDER_CONCURRENCY="0" is not a whole number from 1 to 16: the default 2 is used.',
    ]);
    expect(pdfRenderConfigProblems(env({ PDF_RENDER_CONCURRENCY: '' }))).toEqual([]);
  });

  it('production runs the built bundle and logs an error at startup when it is missing; elsewhere the launcher', () => {
    const has = (want: string) => (p: string) => p.replace(/\\/g, '/').endsWith(want);
    expect(rendererEntry(env({ NODE_ENV: 'production' }), '/app', has('.next/pdf-renderer/render.cjs'))?.replace(/\\/g, '/')).toBe('/app/.next/pdf-renderer/render.cjs');
    expect(rendererEntry(env({ NODE_ENV: 'development' }), '/app', has('scripts/pdf-renderer-dev.cjs'))?.replace(/\\/g, '/')).toBe('/app/scripts/pdf-renderer-dev.cjs');
    expect(rendererEntry(env({ NODE_ENV: 'production' }), '/app', () => false)).toBeNull();
    expect(pdfRendererStartupProblem(env({ NODE_ENV: 'production' }), '/app', () => false)).toMatch(/^The driver sheet \(PDF\) maker is missing .*every driver sheet is refused/);
    expect(pdfRendererStartupProblem(env({ NODE_ENV: 'production' }), '/app', () => true)).toBeNull();
    expect(pdfRendererStartupProblem(env({ NODE_ENV: 'development' }), '/app', () => false)).toBeNull();
  });

  it('the test hooks are refused in production, and the in-process making of the tests is ignored there', async () => {
    const saved = process.env.NODE_ENV;
    let called = 0;
    g.__routeiqPdfRenderInProcess = async () => {
      called += 1;
      throw new Error('in-process making used in production');
    };
    setNodeEnv('production');
    try {
      expect(() => setPdfRenderTestOverrides({ entry: null })).toThrow(/tests only/);
      // Production makes packs through the built bundle only: whatever .next holds here (a build, an
      // older build, none), the answer comes from it, never from the in-process making.
      const r = (await outcome(renderDriverPackIsolated(pack(1, 1)))) as { ok?: unknown; error?: { code?: string } };
      expect(r.ok !== undefined || /^PDF_/.test(r.error?.code ?? '')).toBe(true);
      expect(called).toBe(0);
    } finally {
      setNodeEnv(saved);
      g.__routeiqPdfRenderInProcess = undefined;
    }
  });
});

describe('the startup check of a production server (instrumentation.ts)', () => {
  it('makes a one-sheet pack with the real renderer; names the problem when the renderer is missing or broken', async () => {
    expect(await checkPdfRenderer()).toBeNull();
    setPdfRenderTestOverrides({ entry: silentStandIn('crash') });
    expect(await checkPdfRenderer()).toBe(`The driver sheet (PDF) maker does not work (${PDF_REFUSALS.PDF_CRASHED.message}): every driver sheet is refused. Check the server log above.`);
    setPdfRenderTestOverrides({ entry: standIn('echo') });
    expect(await checkPdfRenderer()).toMatch(/^The driver sheet \(PDF\) maker made something that is not a PDF/);
  });
});

describe.runIf(process.platform === 'linux')('Linux: the kernel kills the renderer first when memory runs out', () => {
  it('the renderer process raises its own oom_score_adj to 1000', async () => {
    const pending = outcome(renderDriverPackIsolated(pack(12, 12)));
    const pid = await runningRenderer();
    let score = '';
    for (let i = 0; i < 200 && score !== '1000'; i++) {
      await new Promise((r) => setTimeout(r, 10));
      try {
        score = readFileSync(`/proc/${pid}/oom_score_adj`, 'utf8').trim();
      } catch {
        break; // already done
      }
    }
    await pending;
    expect(score).toBe('1000');
  });
});
