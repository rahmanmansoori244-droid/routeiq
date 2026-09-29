/**
 * What the web process and the upload parser process (lib/upload-parse) send each other. Only data
 * crosses: the file's bytes, name and type, what the upload is for (a ParseSpec, never a function)
 * and the most its answer may be one way; the parsed file or the error the other way, rebuilt so the
 * routes see what parseUpload itself would have thrown (the same message; a MultipleSheetsError
 * again).
 *
 * The answer is bounded in the web process (P5 review). Node's IPC copies every text of a message
 * again, also a text that many cells share: 50,000 cells that show one 4,096-character shared string
 * of an .xlsx (a 6 KB file within every upload cap) came back as 50,000 copies, 200 MB held in the
 * web process, where parseUpload in the web process had held the one text. Now:
 *  - every text crosses once: the rows go as numbers into one list of the answer's texts (a text
 *    many cells show, a header, is sent the first time only), so the web process holds each text
 *    once, as it did when it read the file itself;
 *  - the parser turns each message into bytes itself (v8.serialize) and sends at most
 *    `maxResultBytes` (MAX_RESULT_BYTES) in all; an answer that would be larger is refused "needs too
 *    much memory". The web process counts the bytes before it turns them into objects and stops the
 *    parser past the same limit;
 *  - the pieces are cut by size as well as by cells.
 *
 * A byte limit does not bound the rows the web process builds (P5 second review): a row of a million
 * keys was a 16 MB answer, far under the limit, and one object of a million keys, built in one go
 * (1-2 s blocked, 70-130 MB held). So the rows are bounded by the upload caps too: no row of more
 * than MAX_COLS keys and no more than MAX_CELLS cells in all. parseUpload gives no more (lib/csv;
 * since that review a CSV sent as text too); the parser stops before it would send more, and the
 * web process checks both before it builds a row. Past either, the file is refused "needs too much
 * memory", like an answer past the byte limit.
 */
import { deserialize, serialize } from 'node:v8';
import type { ParsedFile } from '../csv';
import type { CanonicalField } from '../dispatch/order-headers';
import { MultipleSheetsError, WorkbookRefusedError, type SheetSummary } from '../upload-errors';
import { MAX_CELLS, MAX_COLS } from '../upload-limits';

/** What an upload is for, as data (lib/upload-parse/handler turns it into parseUpload's options). */
export interface ParseSpec {
  /** What the rows are, for messages ("order" -> "order rows"). */
  rowsWord?: string;
  /** Excel columns whose number cells keep the decimals they show (the customer import's lat / lng). */
  decimalTextColumns?: string[];
  /**
   * The rows are orders: the sheets with the order columns (the company's own aliases included) are
   * the data sheets, and a workbook with orders on more than one sheet is refused.
   */
  orderSheet?: { extraAliases: Partial<Record<CanonicalField, string[]>> };
}

/** The one message the parser process gets. */
export interface ParseRequest {
  name: string;
  type: string;
  bytes: Uint8Array<ArrayBuffer>;
  spec: ParseSpec;
  /** The most the answer may be, in bytes as sent (MAX_RESULT_BYTES when not given; smaller in tests). */
  maxResultBytes?: number;
}

/** An error thrown while the file was read, as data. */
export type EncodedError =
  | { kind: 'error'; name: string; message: string }
  | { kind: 'multiple-sheets'; message: string; sheets: SheetSummary[] }
  | { kind: 'value'; value: string | number | boolean | null | undefined };

/** The parser process's one answer; `maxRssKB` is its peak memory (process.resourceUsage). */
export type ParseReply = ({ ok: true; parsed: ParsedFile } | { ok: false; error: EncodedError }) & { maxRssKB?: number };

export function encodeError(err: unknown): EncodedError {
  if (err instanceof MultipleSheetsError) return { kind: 'multiple-sheets', message: err.message, sheets: err.sheets.map((s) => ({ ...s })) };
  if (err instanceof Error) return { kind: 'error', name: err.name, message: err.message };
  if (err === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof err)) return { kind: 'value', value: err as string | number | boolean | null | undefined };
  return { kind: 'error', name: 'Error', message: String(err) };
}

/**
 * The error to throw in the web process: the same message and name; a MultipleSheetsError or a
 * WorkbookRefusedError again (any other class, such as SheetJS's own errors, as an Error).
 */
export function decodeError(e: EncodedError, spec: ParseSpec): unknown {
  if (e.kind === 'multiple-sheets') {
    const out = new MultipleSheetsError(e.sheets, spec.rowsWord);
    out.message = e.message; // as the parser worded it (it is the same)
    return out;
  }
  if (e.kind === 'value') return e.value;
  if (e.name === 'WorkbookRefusedError') return new WorkbookRefusedError(e.message);
  const out = new Error(e.message);
  out.name = e.name;
  return out;
}

/** Whether a value is a ParseReply (anything else from the parser process is treated as a crash). */
export function isParseReply(m: unknown): m is ParseReply {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as { ok?: unknown; parsed?: unknown; error?: unknown };
  return (r.ok === true && typeof r.parsed === 'object' && r.parsed !== null) || (r.ok === false && typeof r.error === 'object' && r.error !== null);
}

/**
 * The answer as the parser process sends it, in order:
 *  - `rows`: a piece of rows, as bytes (v8.serialize of a RowsPiece). At most ROWS_PIECE_CELLS
 *    cells, and cut once its new texts pass about PIECE_BYTES (a row is never cut, and has at most
 *    MAX_COLS cells);
 *  - `reply`: the reply itself (its rows empty) as bytes, and how many pieces came before it;
 *  - or, instead of the rest, `too-large`: the answer would pass a limit, so nothing more is sent.
 *    `what` names it: the next message would take the answer past its limit in bytes (`count`: the
 *    bytes it would then be), the next row has more than MAX_COLS cells (`count`: its cells), or
 *    it would take the rows past MAX_CELLS cells (`count`: the cells they would then have).
 * The web process turns each piece into rows as it arrives, a piece at a time, so it answers other
 * requests in between: one message of 2.5 million cells took it 0.7-1.8 s in one go on a busy PC.
 */
export type ParseMessage =
  | { kind: 'rows'; bytes: Uint8Array }
  | { kind: 'reply'; bytes: Uint8Array; pieces: number }
  | { kind: 'too-large'; what: AnswerLimit; count: number; limit: number };

/** What an answer that is too large passes: its limit in bytes, MAX_COLS cells in a row, or MAX_CELLS cells in all. */
export type AnswerLimit = 'bytes' | 'columns' | 'cells';

/**
 * A piece of rows: the texts not sent before (they get the next numbers, from 0 for the answer's
 * first), then for each row its number of cells and, for each cell, the numbers of its key and of its
 * value.
 */
interface RowsPiece {
  texts: unknown[];
  cells: Uint32Array;
}

export const ROWS_PIECE_CELLS = 25_000;
/** A piece is cut once its new texts pass this many bytes (counted as two bytes a character, the most they take). */
export const PIECE_BYTES = 4 * 1024 * 1024;
/**
 * The most an answer may be, in bytes as sent: 128 MB. Every text is sent once, so what a file within
 * the upload caps sends is about its own text (at most 50 MB unpacked, 10 MB for a CSV) and 8 bytes a
 * cell (2.5 million cells at most, 20 MB): far below. A file past it is refused "needs too much
 * memory", like one past the parser's heap cap. It bounds the bytes, not the rows made of them: the
 * rows are bounded by MAX_COLS and MAX_CELLS (see above).
 */
export const MAX_RESULT_BYTES = 128 * 1024 * 1024;

export interface AnswerOptions {
  /** The most the answer may be, in bytes (MAX_RESULT_BYTES when not given). */
  maxResultBytes?: number;
  /** The parser's peak memory in KB, put into the reply when it is sent (after the pieces). */
  peakRssKB?: () => number;
}

/**
 * The messages of the answer, one at a time: each is turned into bytes only when the one before has
 * been taken, so the pieces are never all held as bytes at once.
 */
export function* answerMessages(reply: ParseReply, opts: AnswerOptions = {}): Generator<ParseMessage, void, undefined> {
  const limit = opts.maxResultBytes ?? MAX_RESULT_BYTES;
  let sent = 0;
  let pieces = 0;
  let stopped = false;
  // One message of `bytes`, or `too-large` (and nothing after it) when it would pass the limit.
  function* message(bytes: Uint8Array, kind: 'rows' | 'reply'): Generator<ParseMessage, void, undefined> {
    if (sent + bytes.byteLength > limit) {
      stopped = true;
      yield { kind: 'too-large', what: 'bytes', count: sent + bytes.byteLength, limit };
      return;
    }
    sent += bytes.byteLength;
    if (kind === 'rows') {
      pieces += 1;
      yield { kind: 'rows', bytes };
    } else {
      yield { kind: 'reply', bytes, pieces };
    }
  }

  let failed: { err: unknown } | null = null;
  try {
    const rows = reply.ok ? reply.parsed.rows : [];
    const numberOf = new Map<string, number>(); // each text sent so far, by its content
    let next = 0;
    let texts: unknown[] = [];
    let textBytes = 0;
    let cells: number[] = [];
    let cellCount = 0;
    let allCells = 0;
    const ref = (v: unknown): number => {
      if (typeof v === 'string') {
        const at = numberOf.get(v);
        if (at !== undefined) return at;
        numberOf.set(v, next);
        textBytes += 2 * v.length;
      } else {
        textBytes += 16; // not a text (rows hold texts only): sent each time, as it is
      }
      texts.push(v);
      return next++;
    };
    const piece = (): Uint8Array => {
      const bytes = serialize({ texts, cells: Uint32Array.from(cells) } satisfies RowsPiece);
      texts = [];
      cells = [];
      textBytes = 0;
      cellCount = 0;
      return bytes;
    };
    for (const row of rows) {
      const keys = Object.keys(row);
      // The upload caps (P5 second review): checked before anything of this row is sent.
      const over: ParseMessage | null =
        keys.length > MAX_COLS
          ? { kind: 'too-large', what: 'columns', count: keys.length, limit: MAX_COLS }
          : allCells + keys.length > MAX_CELLS
            ? { kind: 'too-large', what: 'cells', count: allCells + keys.length, limit: MAX_CELLS }
            : null;
      if (over) {
        stopped = true;
        yield over;
        return;
      }
      allCells += keys.length;
      if (cellCount > 0 && cellCount + keys.length > ROWS_PIECE_CELLS) {
        yield* message(piece(), 'rows');
        if (stopped) return;
      }
      cells.push(keys.length);
      for (const k of keys) cells.push(ref(k), ref(row[k]));
      cellCount += keys.length;
      if (textBytes >= PIECE_BYTES) {
        yield* message(piece(), 'rows');
        if (stopped) return;
      }
    }
    if (cells.length) {
      yield* message(piece(), 'rows');
      if (stopped) return;
    }
  } catch (err) {
    // A piece could not be turned into bytes: say so instead of dying silently.
    failed = { err };
  }
  const head: ParseReply = failed ? { ok: false, error: encodeError(failed.err) } : reply.ok ? { ...reply, parsed: { ...reply.parsed, rows: [] } } : { ...reply };
  const peak = opts.peakRssKB ? opts.peakRssKB() : reply.maxRssKB;
  if (peak !== undefined) head.maxRssKB = peak;
  let bytes: Uint8Array;
  try {
    bytes = serialize(head);
  } catch (err) {
    bytes = serialize({ ok: false, error: encodeError(err), ...(peak !== undefined ? { maxRssKB: peak } : {}) } satisfies ParseReply);
  }
  yield* message(bytes, 'reply');
}

/** All the messages of the answer at once (the tests; the parser process sends them one at a time). */
export function replyMessages(reply: ParseReply, opts: AnswerOptions = {}): ParseMessage[] {
  return [...answerMessages(reply, opts)];
}

/**
 * The answer would pass a limit (`what`: its bytes, MAX_COLS cells in a row, MAX_CELLS cells in all):
 * the parser said so and stopped (`by` parser), or the web process counted more (`by` web); `count`
 * is what was counted. The file is refused "needs too much memory".
 */
export class AnswerTooLargeError extends Error {
  constructor(
    readonly by: 'parser' | 'web',
    readonly what: AnswerLimit,
    readonly count: number,
    readonly limit: number,
  ) {
    const passed = what === 'bytes' ? `${limit} bytes` : what === 'columns' ? `${limit} cells in a row` : `${limit} cells`;
    super(`the parser process's answer would pass ${passed} (${by === 'parser' ? 'the parser stopped' : 'counted in the web process'})`);
    this.name = 'AnswerTooLargeError';
  }
}

const ANSWER_LIMITS: ReadonlySet<unknown> = new Set<AnswerLimit>(['bytes', 'columns', 'cells']);

const SOMETHING_ELSE = 'the parser process sent something else than a parse result';

/**
 * Puts the answer back together from the parser's messages, in the order they came. Counts their
 * bytes before it turns them into objects: past `maxResultBytes` it throws AnswerTooLargeError. So
 * it does, before a row is built, for a row of more than MAX_COLS cells and for a row that would take
 * the rows past MAX_CELLS cells (P5 second review).
 */
export class ReplyCollector {
  private rows: ParsedFile['rows'] = [];
  private texts: unknown[] = [];
  private pieces = 0;
  private bytes = 0;
  private cells = 0;

  constructor(private readonly maxResultBytes: number = MAX_RESULT_BYTES) {}

  /** Pieces of rows received so far. */
  get piecesReceived(): number {
    return this.pieces;
  }

  /** Bytes of the answer received so far. */
  get bytesReceived(): number {
    return this.bytes;
  }

  /** The whole reply once its last message came; null before; throws on a message it does not know. */
  add(m: unknown): ParseReply | null {
    const msg = m as { kind?: unknown; bytes?: unknown; pieces?: unknown; what?: unknown; count?: unknown } | null;
    if (msg?.kind === 'too-large') {
      // The limit is this process's own; the parser's words are only what it counted.
      const what = ANSWER_LIMITS.has(msg.what) ? (msg.what as AnswerLimit) : 'bytes';
      const limit = what === 'columns' ? MAX_COLS : what === 'cells' ? MAX_CELLS : this.maxResultBytes;
      throw new AnswerTooLargeError('parser', what, typeof msg.count === 'number' ? msg.count : NaN, limit);
    }
    if ((msg?.kind !== 'rows' && msg?.kind !== 'reply') || !(msg.bytes instanceof Uint8Array)) throw new Error(SOMETHING_ELSE);
    this.bytes += msg.bytes.byteLength;
    if (this.bytes > this.maxResultBytes) throw new AnswerTooLargeError('web', 'bytes', this.bytes, this.maxResultBytes);
    let data: unknown;
    try {
      data = deserialize(msg.bytes);
    } catch {
      throw new Error(SOMETHING_ELSE);
    }
    if (msg.kind === 'rows') {
      this.addPiece(data);
      this.pieces += 1;
      return null;
    }
    if (isParseReply(data) && msg.pieces === this.pieces) {
      if (data.ok) data.parsed.rows = this.rows;
      this.rows = [];
      this.texts = [];
      return data;
    }
    throw new Error(SOMETHING_ELSE);
  }

  private addPiece(data: unknown): void {
    const p = data as Partial<RowsPiece> | null;
    if (!Array.isArray(p?.texts) || !(p.cells instanceof Uint32Array)) throw new Error(SOMETHING_ELSE);
    const texts = this.texts;
    for (const t of p.texts) texts.push(t);
    const cells = p.cells;
    const text = (at: number | undefined) => {
      if (at === undefined || at >= texts.length) throw new Error(SOMETHING_ELSE);
      return texts[at];
    };
    for (let i = 0; i < cells.length; ) {
      const n = cells[i++]!;
      if (i + 2 * n > cells.length) throw new Error(SOMETHING_ELSE);
      // The upload caps, before the row is built (P5 second review).
      if (n > MAX_COLS) throw new AnswerTooLargeError('web', 'columns', n, MAX_COLS);
      if (this.cells + n > MAX_CELLS) throw new AnswerTooLargeError('web', 'cells', this.cells + n, MAX_CELLS);
      this.cells += n;
      const entries: [string, string][] = [];
      for (let c = 0; c < n; c++) {
        const key = text(cells[i++]);
        const value = text(cells[i++]) as string;
        if (typeof key !== 'string') throw new Error(SOMETHING_ELSE);
        entries.push([key, value]);
      }
      // As the parser's row had it: Object.fromEntries defines each key as an own property in turn (an
      // own "__proto__" too, which an assignment would not make; a key met again keeps its place and
      // takes the later value). And V8 keeps such an object compact, where a row that gets its keys one
      // at a time becomes a hash table past about 16 keys (P5 second review: 50,000 rows of 49 columns
      // held 151 MB here, now 21 MB, on Node 22 and 24).
      this.rows.push(Object.fromEntries(entries) as Record<string, string>);
    }
  }
}
