/**
 * The parser process's work (lib/upload-parse/child.ts): the uploaded file rebuilt from its bytes,
 * name and type, read by the unchanged parseUpload (lib/csv) with the options the ParseSpec stands
 * for. Every error is caught and sent back as data. Only the parser process runs this for an upload
 * (and the tests, in-process: tests/setup.ts); the web process never loads it.
 */
import { parseUpload, type ParseOptions } from '../csv';
import { isOrderSheet } from '../dispatch/order-headers';
import { encodeError, type ParseReply, type ParseRequest, type ParseSpec } from './protocol';

/** parseUpload's options for a ParseSpec (the order-sheet test is a function, so it is made here). */
export function parseOptions(spec: ParseSpec): ParseOptions {
  const opts: ParseOptions = {};
  if (spec.orderSheet) {
    const extra = spec.orderSheet.extraAliases;
    opts.isDataSheet = (headers) => isOrderSheet(headers, extra);
  }
  if (spec.rowsWord !== undefined) opts.rowsWord = spec.rowsWord;
  if (spec.decimalTextColumns !== undefined) opts.decimalTextColumns = spec.decimalTextColumns;
  return opts;
}

export async function handleParseRequest(req: ParseRequest): Promise<ParseReply> {
  try {
    const file = new File([req.bytes], req.name, { type: req.type });
    return { ok: true, parsed: await parseUpload(file, parseOptions(req.spec)) };
  } catch (err) {
    return { ok: false, error: encodeError(err) };
  }
}
