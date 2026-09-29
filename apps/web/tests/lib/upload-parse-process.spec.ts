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
 *    run is .dev work; here a few dozen);
 *  - the answer is bounded in this process (P5 review): each text crosses once, and an answer of more
 *    than MAX_RESULT_BYTES is refused "needs too much memory", by the parser and by this process;
 *  - so are the rows made of it (P5 second review): a CSV sent as text has the column and cell caps
 *    (lib/csv), and no row of more than MAX_COLS keys, or more than MAX_CELLS cells in all, crosses:
 *    the parser stops before it, and this process refuses it before it builds the row.
 * The stand-in parsers are in tests/fixtures/upload-parser.
 */
import { readFileSync } from 'node:fs';
import { serialize } from 'node:v8';
import { describe, expect, it } from 'vitest';
import { MAX_CELLS, MAX_COLS, parseUpload } from '@/lib/csv';
import { MAX_WAITING, parserEntry, QUEUE_WAIT_MS, uploadParseConfig, uploadParseConfigProblems, uploadParserStartupProblem } from '@/lib/upload-parse/config';
import { checkUploadParser, lastUploadParse, parseUploadIsolated, setUploadParseTestOverrides, UPLOAD_REFUSALS, UploadParseRefused, uploadParseState } from '@/lib/upload-parse';
import { MAX_RESULT_BYTES, PIECE_BYTES, replyMessages, ReplyCollector, ROWS_PIECE_CELLS, type ParseReply } from '@/lib/upload-parse/protocol';
import { allGone, heapHeldBy, longestStall, outcome, processGone, standIn, useRealUploadParser } from './upload-parse-helpers';
import { denseSheet, rawSheet, workbook, xlsxFile } from './zip-fixtures';

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

  it('a row comes back as the parser had it: its keys in order, an own "__proto__" as a plain key, the same prototype (P5 second review)', () => {
    const row = JSON.parse('{"b":"1","__proto__":"x","a":"2"}') as Record<string, string>;
    const reply: ParseReply = { ok: true, parsed: { fileName: 'f.csv', fileType: 'csv', rows: [row], warnings: [] } };
    const c = new ReplyCollector();
    let got: ParseReply | null = null;
    for (const m of replyMessages(reply)) got = c.add(structuredClone(m));
    const back = (got as { parsed: { rows: Record<string, string>[] } }).parsed.rows[0]!;
    expect(Object.keys(back)).toEqual(['b', '__proto__', 'a']);
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(back, '__proto__')).toEqual({ value: 'x', enumerable: true, writable: true, configurable: true });
  });

  it('pieces are cut by size too, and a text the answer holds many times crosses once (P5 review)', () => {
    // 300 rows of 100,000 characters each of their own (30 MB): in pieces of at most about PIECE_BYTES.
    const long: ParseReply = { ok: true, parsed: { fileName: 'f.csv', fileType: 'csv', rows: Array.from({ length: 300 }, (_, r) => ({ note: String(r).padEnd(100_000, 'z') })), warnings: [] } };
    const pieces = [...replyMessages(long)].filter((m) => m.kind === 'rows');
    expect(pieces.length).toBeGreaterThan(5);
    for (const m of pieces) expect((m as { bytes: Uint8Array }).bytes.byteLength).toBeLessThanOrEqual(PIECE_BYTES + 200_000);
    // 50,000 cells of one 4,096-character text: it crosses once (it used to cross 50,000 times, 200 MB).
    const same = 'x'.repeat(4_096);
    const shared: ParseReply = { ok: true, parsed: { fileName: 'f.xlsx', fileType: 'xlsx', rows: Array.from({ length: 50_000 }, () => ({ note: same })), warnings: [], sheetName: 'S' } };
    const messages = [...replyMessages(shared)];
    expect(messages.reduce((n, m) => n + ('bytes' in m && typeof m.bytes === 'object' ? m.bytes.byteLength : 0), 0)).toBeLessThan(1024 * 1024);
    const c = new ReplyCollector();
    let whole: ParseReply | null = null;
    for (const m of messages) whole = c.add(structuredClone(m));
    expect(whole).toEqual(shared);
  });
});

/**
 * A workbook whose one sheet has a header row and `rows` rows of one cell that shows the one shared
 * string (xl/sharedStrings.xml) of `length` characters: 50,000 cells of 4,096 characters is a 6 KB
 * file within every cap (the P5 review's file).
 */
function sharedStringBook(rows: number, length: number): Buffer {
  const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${rows}" uniqueCount="1"><si><t>${'x'.repeat(length)}</t></si></sst>`;
  return workbook(
    { Notes: rawSheet(`<row><c t="inlineStr"><is><t>note</t></is></c></row>${'<row><c t="s"><v>0</v></c></row>'.repeat(rows)}`) },
    [{ name: 'xl/sharedStrings.xml', data: Buffer.from(sst) }],
    [{ part: '/xl/sharedStrings.xml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml' }],
  );
}

describe('the answer is bounded in this process, whatever the file (P5 review)', () => {
  it('50,000 cells that show one 4,096-character text: this process holds the text once, as parseUpload did here', async () => {
    const bytes = sharedStringBook(50_000, 4_096);
    expect(bytes.length).toBeLessThan(10_000);
    const { result, heldMB } = await heapHeldBy(() => parseUploadIsolated(xlsxFile(bytes, 'notes.xlsx')));
    expect(result.rows).toHaveLength(50_000);
    // Each cell used to come back as its own copy: about 200 MB held here (cells x 4 KB), from a 6 KB file.
    expect(heldMB).toBeLessThan(32);
    expect(lastUploadParse()?.bytes).toBeLessThan(1024 * 1024);
    expect(result).toEqual(await parseUpload(xlsxFile(bytes, 'notes.xlsx')));
  });

  it('an answer larger than the limit is refused "needs too much memory": the parser stops before it', async () => {
    // 2,000 rows of 1,000 characters each of their own: about 2 MB of text, over a 1 MB limit.
    const text = ['code,note', ...Array.from({ length: 2_000 }, (_, i) => `C${i},${String(i).padEnd(1_000, 'y')}`)].join('\n');
    const file = () => new File([text], 'notes.csv', { type: 'text/csv' });
    setUploadParseTestOverrides({ maxResultBytes: 1024 * 1024 });
    expect(await outcome(parseUploadIsolated(file()))).toEqual(refusal('UPLOAD_OUT_OF_MEMORY'));
    expect(lastUploadParse()).toMatchObject({ tooLarge: 'parser' });
    expect(lastUploadParse()!.bytes).toBeLessThanOrEqual(1024 * 1024);
    // Under the limit (the default) the same file is read.
    setUploadParseTestOverrides(null);
    expect((await parseUploadIsolated(file())).rows).toHaveLength(2_000);
  });

  it('a parser that sends more anyway is stopped here at the limit: the same refusal, and its process is killed', async () => {
    setUploadParseTestOverrides({ entry: standIn('flood'), maxResultBytes: 3 * 1024 * 1024 });
    const pending = outcome(parseUploadIsolated(tiny()));
    const pid = await runningParser();
    expect(await pending).toEqual(refusal('UPLOAD_OUT_OF_MEMORY'));
    // Pieces of 1 MB against a 3 MB limit: the third is counted, found too much and never read.
    expect(lastUploadParse()).toMatchObject({ tooLarge: 'web', pieces: 2 });
    await allGone();
    expect(processGone(pid)).toBe(true);
  });

  it('the limit is MAX_RESULT_BYTES (128 MB), which no file within the upload caps comes near', () => {
    expect(MAX_RESULT_BYTES).toBe(128 * 1024 * 1024);
  });
});

/** What `fn` throws (null when it throws nothing). */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

describe('a row wider than the column cap, or more cells than the cell cap, never reaches this process (P5 second review)', () => {
  it('the parser refuses a CSV of one row of 1,000,000 columns (9.4 MB): this process holds almost nothing and is not blocked', async () => {
    // Before: the parser read it (7-9 s) and this process built one row of a million keys in one go,
    // 1.0-1.4 s blocked and 71 MB held; the answer, 16 MB, was far under MAX_RESULT_BYTES.
    const cols = 1_000_000;
    const text = `${Array.from({ length: cols }, (_, c) => `c${c}`).join(',')}\n${Array(cols).fill('1').join(',')}\n`;
    const file = new File([text], 'wide.csv', { type: 'text/csv' });
    expect(file.size).toBeLessThan(10 * 1024 * 1024);
    const { result, heldMB } = await heapHeldBy(() => longestStall(() => outcome(parseUploadIsolated(file))));
    expect(result.result).toEqual({
      error: expect.objectContaining({ class: 'WorkbookRefusedError', message: expect.stringMatching(/^This file has 1,000,000 columns; at most 200 can be read\./) }),
    });
    expect(heldMB).toBeLessThan(16);
    expect(result.stallMs).toBeLessThan(1_000);
  });

  it('protocol: the parser sends no row of more than MAX_COLS keys and no more than MAX_CELLS cells; this process checks both before it builds a row', () => {
    const reply = (rows: Record<string, string>[]): ParseReply => ({ ok: true, parsed: { fileName: 'f.csv', fileType: 'csv', rows, warnings: [] } });
    const row = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, c) => [`h${c}`, '1']));
    // Columns: a row of MAX_COLS keys crosses; at a row of one more the answer stops, with nothing of it sent.
    expect(replyMessages(reply([row(MAX_COLS)])).map((m) => m.kind)).toEqual(['rows', 'reply']);
    expect(replyMessages(reply([row(3), row(MAX_COLS + 1), row(3)]))).toEqual([{ kind: 'too-large', what: 'columns', count: MAX_COLS + 1, limit: MAX_COLS }]);
    // Cells: 25,000 rows of 100 keys (MAX_CELLS) cross; with one cell more the answer stops before it.
    const full = Array.from({ length: MAX_CELLS / 100 }, () => row(100));
    const messages = replyMessages(reply(full));
    const whole = new ReplyCollector();
    let got: ParseReply | null = null;
    for (const m of messages) got = whole.add(m);
    expect(got?.ok && got.parsed.rows.length).toBe(MAX_CELLS / 100);
    const over = replyMessages(reply([...full, row(1)]));
    expect(over.at(-1)).toEqual({ kind: 'too-large', what: 'cells', count: MAX_CELLS + 1, limit: MAX_CELLS });
    expect(over.filter((m) => m.kind === 'reply')).toEqual([]);
    // This process: a piece with a row of MAX_COLS + 1 cells, or one cell past MAX_CELLS, is refused before the row is built.
    const piece = (texts: string[], cells: number[]) => ({ kind: 'rows', bytes: serialize({ texts, cells: Uint32Array.from(cells) }) });
    const keys = Array.from({ length: MAX_COLS + 1 }, (_, c) => `h${c}`);
    const wideRow = [MAX_COLS + 1, ...keys.flatMap((_, c) => [c + 1, 0])];
    expect(thrown(() => new ReplyCollector().add(piece(['1', ...keys], wideRow)))).toMatchObject({ name: 'AnswerTooLargeError', by: 'web', what: 'columns' });
    const past = new ReplyCollector();
    for (const m of messages.filter((m) => m.kind === 'rows')) past.add(m);
    expect(thrown(() => past.add(piece([], [1, 0, 1])))).toMatchObject({ name: 'AnswerTooLargeError', by: 'web', what: 'cells' });
  });

  it('the rows of a legal file at the caps are compact here: 50,000 rows of 49 columns hold under 48 MB (151 MB when a row was built one key at a time)', async () => {
    // V8 stores an object that gets more than about 16 keys one at a time as a hash table: 3 KB a row here.
    const text = [Array.from({ length: 49 }, (_, c) => `h${c}`).join(','), ...Array.from({ length: 50_000 }, () => Array(49).fill('1').join(','))].join('\n');
    const { result, heldMB } = await heapHeldBy(() => parseUploadIsolated(new File([text], 'legal-wide.csv', { type: 'text/csv' })));
    expect(result.rows).toHaveLength(50_000);
    expect(Object.keys(result.rows[49_999]!)).toHaveLength(49);
    expect(heldMB).toBeLessThan(48);
  });

  it('a parser that sends a row of 250,000 keys anyway is refused "needs too much memory" before the row is built here', async () => {
    setUploadParseTestOverrides({ entry: standIn('wide') });
    const { result, heldMB } = await heapHeldBy(() => outcome(parseUploadIsolated(tiny())));
    expect(result).toEqual(refusal('UPLOAD_OUT_OF_MEMORY'));
    expect(lastUploadParse()).toMatchObject({ tooLarge: 'web', over: 'columns', pieces: 0 });
    expect(heldMB).toBeLessThan(16);
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
