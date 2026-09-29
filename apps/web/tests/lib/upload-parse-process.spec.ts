/**
 * Audit P5 (E2's proper fix, owner decision 16): no uploaded file can freeze or crash the web
 * process. Each upload is read in its own short-lived parser process (lib/upload-parse):
 *  - the web process keeps running its own work while a file is read (its event loop is free);
 *  - a file that takes longer than UPLOAD_PARSE_TIMEOUT_MS is refused and its process is killed,
 *    also a parse that never gives the event loop back;
 *  - a file that needs more memory than UPLOAD_WORKER_MAX_HEAP_MB is refused; only the parser
 *    process ends ("heap out of memory"), not this one;
 *  - a parser that stops without an answer, or answers nonsense, is a plain refusal (500);
 *  - at most UPLOAD_PARSE_CONCURRENCY run at once; a further upload waits briefly, then gets 503;
 *  - the parser gets no secrets and none of this process's Node flags;
 *  - nothing is left behind: no process, no slot, no timer, after thousands of parses too (the long
 *    run is .dev work; here a few dozen).
 * The stand-in parsers are in tests/fixtures/upload-parser.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseUpload } from '@/lib/csv';
import { MAX_WAITING, parserEntry, QUEUE_WAIT_MS, uploadParseConfig, uploadParseConfigProblems, uploadParserStartupProblem } from '@/lib/upload-parse/config';
import { checkUploadParser, parseUploadIsolated, setUploadParseTestOverrides, UPLOAD_REFUSALS, UploadParseRefused, uploadParseState } from '@/lib/upload-parse';
import { replyMessages, ReplyCollector, ROWS_PIECE_CELLS, type ParseReply } from '@/lib/upload-parse/protocol';
import { allGone, longestStall, outcome, processGone, standIn, useRealUploadParser } from './upload-parse-helpers';
import { denseSheet, workbook, xlsxFile } from './zip-fixtures';

useRealUploadParser();

const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;
const setNodeEnv = (v: string | undefined) => {
  (process.env as Record<string, string | undefined>).NODE_ENV = v;
};
const tiny = () => new File(['code,name\nC1,One\n'], 'customers.csv', { type: 'text/csv' });
/** A legal 34 KB .xlsx that takes the parser a few seconds (it reads 50,100 rows x 10 columns, then refuses "Too many rows"). */
const slowBytes = workbook({ Orders: { deflated: denseSheet(10, 8) } });
const slow = () => xlsxFile(slowBytes);
const refusal = (code: keyof typeof UPLOAD_REFUSALS) => ({
  error: { class: 'UploadParseRefused', name: 'UploadParseRefused', message: UPLOAD_REFUSALS[code].message, code, status: UPLOAD_REFUSALS[code].status },
});
/** The pid of the parser process that is running now (waits for it to start). */
async function runningParser(): Promise<number> {
  for (let i = 0; i < 500; i++) {
    const [pid] = uploadParseState().children;
    if (pid && pid > 0) return pid;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no parser process started');
}

describe('the file is read in another process, and this one keeps running (audit P5)', () => {
  it('the parser is a separate process with its own pid', async () => {
    setUploadParseTestOverrides({ entry: standIn('echo') });
    const parsed = await parseUploadIsolated(tiny());
    expect(Number(parsed.rows[0]!.pid)).toBeGreaterThan(0);
    expect(Number(parsed.rows[0]!.pid)).not.toBe(process.pid);
  });

  it('while a slow file is read, the event loop of this process is never blocked for long', async () => {
    // In the web process (before P5) the loop was blocked for the whole read.
    const { result, stallMs, elapsedMs } = await longestStall(() => outcome(parseUploadIsolated(slow())));
    expect(result).toEqual({ error: expect.objectContaining({ message: 'Too many rows: more than 50000. Max 50000.' }) });
    expect(elapsedMs).toBeGreaterThan(1_000);
    // Starting a process blocks the caller briefly (a few ms on Linux; up to several hundred on a
    // busy Windows PC), and the rows are turned back into objects a piece at a time.
    expect(stallMs).toBeLessThan(Math.min(1_000, elapsedMs / 2));
  });

  it('in-process (as before P5) the same file blocks the loop for the whole read: the check above would fail', async () => {
    const { stallMs, elapsedMs } = await longestStall(() => outcome(parseUpload(slow())));
    expect(stallMs).toBeGreaterThan(elapsedMs * 0.8);
  });
});

describe('a file that takes too long is refused and its process killed (UPLOAD_PARSE_TIMEOUT_MS)', () => {
  it('a parse that never gives the loop back is killed at the time limit', async () => {
    process.env.UPLOAD_PARSE_TIMEOUT_MS = '600';
    setUploadParseTestOverrides({ entry: standIn('busy') });
    const pending = outcome(parseUploadIsolated(tiny()));
    const pid = await runningParser();
    const t0 = performance.now();
    expect(await pending).toEqual(refusal('UPLOAD_TIMEOUT'));
    expect(performance.now() - t0).toBeLessThan(2_000);
    await allGone();
    expect(processGone(pid)).toBe(true);
  });

  it('the real parser reading a slow file is killed at the time limit; with the default limit it reads it', async () => {
    process.env.UPLOAD_PARSE_TIMEOUT_MS = '400';
    const pending = outcome(parseUploadIsolated(slow()));
    const pid = await runningParser();
    expect(await pending).toEqual(refusal('UPLOAD_TIMEOUT'));
    await allGone();
    expect(processGone(pid)).toBe(true);
    delete process.env.UPLOAD_PARSE_TIMEOUT_MS;
    expect(await outcome(parseUploadIsolated(slow()))).toEqual({ error: expect.objectContaining({ message: 'Too many rows: more than 50000. Max 50000.' }) });
  });
});

describe('a file that needs too much memory is refused; only the parser process ends (UPLOAD_WORKER_MAX_HEAP_MB)', () => {
  it('the real parser over its heap cap: "needs too much memory", and this process goes on', async () => {
    process.env.UPLOAD_WORKER_MAX_HEAP_MB = '64';
    expect(await outcome(parseUploadIsolated(slow()))).toEqual(refusal('UPLOAD_OUT_OF_MEMORY'));
    // Without the cap (the default 512 MB) the same file is read to its end.
    delete process.env.UPLOAD_WORKER_MAX_HEAP_MB;
    expect(await outcome(parseUploadIsolated(slow()))).toEqual({ error: expect.objectContaining({ message: 'Too many rows: more than 50000. Max 50000.' }) });
  });

  it('a parser that allocates without end: V8 aborts it ("heap out of memory"), the same refusal', async () => {
    process.env.UPLOAD_WORKER_MAX_HEAP_MB = '64';
    setUploadParseTestOverrides({ entry: standIn('hog') });
    expect(await outcome(parseUploadIsolated(tiny()))).toEqual(refusal('UPLOAD_OUT_OF_MEMORY'));
  });
});

describe('a parser that stops or answers nonsense is a plain refusal', () => {
  it.each(['crash', 'silent', 'garbage'] as const)('%s: "the file reader stopped" (500)', async (mode) => {
    setUploadParseTestOverrides({ entry: standIn(mode) });
    expect(await outcome(parseUploadIsolated(tiny()))).toEqual(refusal('UPLOAD_CRASHED'));
  });

  it('no parser bundle: "the file reader did not start" (500), and no process is started', async () => {
    setUploadParseTestOverrides({ entry: null });
    expect(await outcome(parseUploadIsolated(tiny()))).toEqual(refusal('UPLOAD_UNAVAILABLE'));
    expect(uploadParseState()).toEqual({ active: 0, waiting: 0, children: [] });
  });

  it('the size and type are checked before anything is started, with parseUpload\'s messages', async () => {
    setUploadParseTestOverrides({ entry: null }); // would refuse "did not start" if it got that far
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.csv', { type: 'text/csv' });
    expect(await outcome(parseUploadIsolated(big))).toEqual(await outcome(parseUpload(big)));
    const png = new File(['x'], 'x.png', { type: 'image/png' });
    expect(await outcome(parseUploadIsolated(png))).toEqual(await outcome(parseUpload(png)));
  });
});

describe('at most UPLOAD_PARSE_CONCURRENCY parses at once; more wait briefly, then get 503', () => {
  it('a second upload waits for the slot, then is answered "busy" (503, Retry-After); one more than may wait is answered at once', async () => {
    process.env.UPLOAD_PARSE_CONCURRENCY = '1';
    process.env.UPLOAD_PARSE_TIMEOUT_MS = '2500';
    setUploadParseTestOverrides({ entry: standIn('busy'), queueWaitMs: 300, maxWaiting: 1 });
    const first = outcome(parseUploadIsolated(tiny()));
    await runningParser();
    const t0 = performance.now();
    const second = outcome(parseUploadIsolated(tiny()));
    const third = await outcome(parseUploadIsolated(tiny())); // the queue (1) is full
    expect(third).toEqual(refusal('UPLOAD_BUSY'));
    expect(performance.now() - t0).toBeLessThan(250);
    expect(await second).toEqual(refusal('UPLOAD_BUSY'));
    expect(performance.now() - t0).toBeGreaterThanOrEqual(280);
    expect(await first).toEqual(refusal('UPLOAD_TIMEOUT'));
    const busy = new UploadParseRefused('UPLOAD_BUSY');
    expect([busy.status, busy.retryAfterSec, busy.message]).toEqual([503, 5, 'RouteIQ is reading other files right now. Try again in a moment.']);
  });

  it('a waiting upload gets the slot as soon as it is free, and is read', async () => {
    process.env.UPLOAD_PARSE_CONCURRENCY = '1';
    const results = await Promise.all([1, 2, 3].map(() => parseUploadIsolated(tiny())));
    expect(results.map((r) => r.rows)).toEqual([1, 2, 3].map(() => [{ code: 'C1', name: 'One' }]));
  });

  it('the defaults: 2 at once, 8 waiting at most, 5 s wait', () => {
    expect(uploadParseConfig(env({}))).toEqual({ maxHeapMb: 512, timeoutMs: 15_000, concurrency: 2 });
    expect([MAX_WAITING, QUEUE_WAIT_MS]).toEqual([8, 5_000]);
  });
});

describe('the parser process gets no secrets and no Node flags of this process', () => {
  it('its environment has only the time zone, locale and system paths; its flags are the heap cap only', async () => {
    process.env.DATABASE_URL ??= 'postgresql://user:secret@localhost:5432/x';
    process.env.ROUTEIQ_P5_TEST_SECRET = 'must-not-leak';
    process.env.UPLOAD_WORKER_MAX_HEAP_MB = '300';
    setUploadParseTestOverrides({ entry: standIn('echo') });
    try {
      const [row] = (await parseUploadIsolated(tiny())).rows;
      const names = row!.env!.split(',').map((n) => n.toUpperCase());
      const passed = ['NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'];
      const nodeIpc = ['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE'];
      // Windows adds these to every new process when they are missing (libuv's required variables).
      const windows = process.platform === 'win32' ? ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME', 'USERPROFILE'] : [];
      expect(names.filter((n) => ![...passed, ...nodeIpc, ...windows].includes(n))).toEqual([]);
      expect(names).not.toContain('DATABASE_URL');
      expect(row!.execArgv).toBe('--max-old-space-size=300');
    } finally {
      delete process.env.ROUTEIQ_P5_TEST_SECRET;
    }
  });
});

describe('nothing is left behind', () => {
  it('after 40 parses (read, refused, killed): no process, no slot, no timer or handle, no listener', async () => {
    const handles = () => process.getActiveResourcesInfo().filter((r) => r !== 'TTYWrap').length;
    const listeners = () => ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'].map((e) => process.listenerCount(e));
    await parseUploadIsolated(tiny());
    await allGone();
    const before = { handles: handles(), listeners: listeners() };
    process.env.UPLOAD_PARSE_TIMEOUT_MS = '500';
    for (let i = 0; i < 40; i++) {
      if (i % 10 === 9) setUploadParseTestOverrides({ entry: standIn('busy') });
      else if (i % 10 === 8) setUploadParseTestOverrides({ entry: standIn('crash') });
      else setUploadParseTestOverrides(null);
      await outcome(parseUploadIsolated(tiny()));
    }
    await allGone();
    expect({ handles: handles(), listeners: listeners() }).toEqual(before);
  });
});

describe('the rows come back in pieces (protocol)', () => {
  it('pieces of about 25,000 cells, put together in order; anything else is refused', () => {
    const rows = Array.from({ length: 10_001 }, (_, r) => Object.fromEntries(Array.from({ length: 49 }, (_, c) => [`h${c}`, `${r}.${c}`])));
    const reply: ParseReply = { ok: true, parsed: { fileName: 'f.xlsx', fileType: 'xlsx', rows, warnings: ['w'], sheetName: 'S' }, maxRssKB: 1 };
    const messages = replyMessages(structuredClone(reply));
    const size = Math.floor(ROWS_PIECE_CELLS / 49);
    expect(messages.length).toBe(Math.ceil(10_001 / size) + 1);
    const c = new ReplyCollector();
    let whole: ParseReply | null = null;
    for (const m of messages) whole = c.add(structuredClone(m));
    expect(whole).toEqual(reply);
    // A piece missing, a reply that is not one, or a message of another kind: never taken for a parse result.
    expect(() => new ReplyCollector().add(messages.at(-1))).toThrow(/something else/);
    expect(() => new ReplyCollector().add({ kind: 'reply', reply: { hello: 1 }, pieces: 0 })).toThrow(/something else/);
    expect(() => new ReplyCollector().add({ hello: 1 })).toThrow(/something else/);
    // An error reply is one message.
    expect(replyMessages({ ok: false, error: { kind: 'error', name: 'Error', message: 'x' } })).toHaveLength(1);
  });
});

describe('settings (UPLOAD_WORKER_MAX_HEAP_MB, UPLOAD_PARSE_TIMEOUT_MS, UPLOAD_PARSE_CONCURRENCY)', () => {
  it('reads whole numbers in range; anything else takes the default and is named at startup', () => {
    expect(uploadParseConfig(env({ UPLOAD_WORKER_MAX_HEAP_MB: ' 768 ', UPLOAD_PARSE_TIMEOUT_MS: '30000', UPLOAD_PARSE_CONCURRENCY: '3' }))).toEqual({ maxHeapMb: 768, timeoutMs: 30_000, concurrency: 3 });
    const bad = env({ UPLOAD_WORKER_MAX_HEAP_MB: '1GB', UPLOAD_PARSE_TIMEOUT_MS: '10', UPLOAD_PARSE_CONCURRENCY: '0' });
    expect(uploadParseConfig(bad)).toEqual({ maxHeapMb: 512, timeoutMs: 15_000, concurrency: 2 });
    expect(uploadParseConfigProblems(bad)).toEqual([
      'UPLOAD_WORKER_MAX_HEAP_MB="1GB" is not a whole number from 64 to 16384: the default 512 is used.',
      'UPLOAD_PARSE_TIMEOUT_MS="10" is not a whole number from 250 to 600000: the default 15000 is used.',
      'UPLOAD_PARSE_CONCURRENCY="0" is not a whole number from 1 to 16: the default 2 is used.',
    ]);
    expect(uploadParseConfigProblems(env({ UPLOAD_PARSE_CONCURRENCY: '' }))).toEqual([]);
  });

  it('production runs the built bundle and logs an error at startup when it is missing; elsewhere the launcher', () => {
    const has = (want: string) => (p: string) => p.replace(/\\/g, '/').endsWith(want);
    expect(parserEntry(env({ NODE_ENV: 'production' }), '/app', has('.next/upload-parser/parse.cjs'))?.replace(/\\/g, '/')).toBe('/app/.next/upload-parser/parse.cjs');
    expect(parserEntry(env({ NODE_ENV: 'development' }), '/app', has('scripts/upload-parser-dev.cjs'))?.replace(/\\/g, '/')).toBe('/app/scripts/upload-parser-dev.cjs');
    expect(parserEntry(env({ NODE_ENV: 'production' }), '/app', () => false)).toBeNull();
    expect(uploadParserStartupProblem(env({ NODE_ENV: 'production' }), '/app', () => false)).toMatch(/^The upload file reader is missing .*every file upload is refused/);
    expect(uploadParserStartupProblem(env({ NODE_ENV: 'production' }), '/app', () => true)).toBeNull();
    expect(uploadParserStartupProblem(env({ NODE_ENV: 'development' }), '/app', () => false)).toBeNull();
  });

  it('the test hooks are refused in production, and the in-process reading of the tests is ignored there', async () => {
    const saved = process.env.NODE_ENV;
    const g = globalThis as { __routeiqUploadParseInProcess?: unknown };
    let called = 0;
    g.__routeiqUploadParseInProcess = async () => {
      called += 1;
      throw new Error('in-process reading used in production');
    };
    setNodeEnv('production');
    try {
      expect(() => setUploadParseTestOverrides({ entry: null })).toThrow(/tests only/);
      // Production reads through the built bundle only: whatever .next holds here (a build, an older
      // build, none), the answer comes from it, never from the in-process reading.
      const r = (await outcome(parseUploadIsolated(tiny()))) as { ok?: unknown; error?: { code?: string } };
      expect(r.ok !== undefined || /^UPLOAD_/.test(r.error?.code ?? '')).toBe(true);
      expect(called).toBe(0);
    } finally {
      setNodeEnv(saved);
      g.__routeiqUploadParseInProcess = undefined;
    }
  });
});

describe('the startup check of a production server (instrumentation.ts)', () => {
  it('reads a test file with the real parser; names the problem when the parser is missing or broken', async () => {
    expect(await checkUploadParser()).toBeNull();
    setUploadParseTestOverrides({ entry: standIn('crash') });
    expect(await checkUploadParser()).toBe(`The upload file reader does not work (${UPLOAD_REFUSALS.UPLOAD_CRASHED.message}): every file upload is refused. Check the server log above.`);
    setUploadParseTestOverrides({ entry: standIn('echo') });
    expect(await checkUploadParser()).toMatch(/^The upload file reader read its startup test file wrongly/);
  });
});

describe.runIf(process.platform === 'linux')('Linux: the kernel kills the parser first when memory runs out', () => {
  it('the parser process raises its own oom_score_adj to 1000', async () => {
    process.env.UPLOAD_PARSE_TIMEOUT_MS = '20000';
    const pending = outcome(parseUploadIsolated(slow()));
    const pid = await runningParser();
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
