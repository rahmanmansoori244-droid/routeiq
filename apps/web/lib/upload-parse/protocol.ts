/**
 * What the web process and the upload parser process (lib/upload-parse) send each other. Only data
 * crosses: the file's bytes, name and type and what the upload is for (a ParseSpec, never a
 * function) one way; the parsed file or the error the other way, rebuilt so the routes see what
 * parseUpload itself would have thrown (the same message; a MultipleSheetsError again).
 */
import type { ParsedFile } from '../csv';
import type { CanonicalField } from '../dispatch/order-headers';
import { MultipleSheetsError, WorkbookRefusedError, type SheetSummary } from '../upload-errors';

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
 * The answer as the parser process sends it: the rows in pieces of about ROWS_PIECE_CELLS cells,
 * then the reply itself (its rows empty). The web process turns each message back into objects as
 * it arrives, a piece at a time, so it answers other requests in between: one message of 2.5
 * million cells took it 0.7-1.8 s in one go on a busy PC.
 */
export type ParseMessage = { kind: 'rows'; rows: ParsedFile['rows'] } | { kind: 'reply'; reply: ParseReply; pieces: number };

export const ROWS_PIECE_CELLS = 25_000;

export function replyMessages(reply: ParseReply): ParseMessage[] {
  if (!reply.ok) return [{ kind: 'reply', reply, pieces: 0 }];
  const { rows } = reply.parsed;
  const perRow = Math.max(1, Object.keys(rows[0] ?? {}).length);
  const size = Math.max(1, Math.floor(ROWS_PIECE_CELLS / perRow));
  const out: ParseMessage[] = [];
  for (let i = 0; i < rows.length; i += size) out.push({ kind: 'rows', rows: rows.slice(i, i + size) });
  out.push({ kind: 'reply', reply: { ...reply, parsed: { ...reply.parsed, rows: [] } }, pieces: out.length });
  return out;
}

/** Puts the answer back together from the parser's messages, in the order they came. */
export class ReplyCollector {
  private rows: ParsedFile['rows'] = [];
  private pieces = 0;

  /** Pieces of rows received so far. */
  get piecesReceived(): number {
    return this.pieces;
  }

  /** The whole reply once its last message came; null before; throws on a message it does not know. */
  add(m: unknown): ParseReply | null {
    const msg = m as Partial<ParseMessage> | null;
    if (msg?.kind === 'rows' && Array.isArray(msg.rows)) {
      for (const row of msg.rows) this.rows.push(row);
      this.pieces += 1;
      return null;
    }
    if (msg?.kind === 'reply' && isParseReply(msg.reply) && msg.pieces === this.pieces) {
      const reply = msg.reply;
      if (reply.ok) reply.parsed.rows = this.rows;
      this.rows = [];
      return reply;
    }
    throw new Error('the parser process sent something else than a parse result');
  }
}
