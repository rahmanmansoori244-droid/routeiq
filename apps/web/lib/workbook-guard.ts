import { inflateRawSync } from 'node:zlib';

/**
 * Size check on an uploaded .xlsx workbook BEFORE SheetJS reads it (audit E2 quick fix,
 * 27 Sep 2026).
 *
 * An .xlsx file is a zip archive. SheetJS unpacks every part of it in the web process, on the
 * event loop, and takes the part sizes from the zip headers. A small crafted file can unpack to
 * hundreds of MB: a 606 KB file that unpacks to 200 MB blocked the parse for more than 3 minutes,
 * and a 138 KB file that unpacks to 45 MB for 9 s (measured on the maintainer's machine).
 *
 * checkWorkbookZip() walks the archive the way SheetJS does (its central directory, then each
 * part's local header) and unpacks every part with Node's zlib under a hard output cap. The size
 * is therefore measured, never taken from the headers, and a file over the cap is refused before
 * SheetJS sees it. Zip archives that are not an Excel workbook (OpenDocument, Apple Numbers,
 * an archive inside the archive) are refused too: SheetJS would unpack those further, beyond
 * what this check measured.
 *
 * This bounds the work of one upload; it does not isolate it. A workbook under the caps is still
 * parsed on the event loop, and nothing can stop that parse once it has started. Parsing in a
 * worker thread with a memory cap and a timeout that really stops it is audit PR 5.
 */

/** Refusal of an upload with a message for the dispatcher (the routes answer 400 with it). */
export class WorkbookRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbookRefusedError';
  }
}

export interface WorkbookZipLimits {
  /** Largest total size of all parts once unpacked. */
  maxUnpackedBytes: number;
  /** Most parts (files inside the zip) a workbook may have. */
  maxParts: number;
}

export interface WorkbookZipCheck {
  parts: number;
  unpackedBytes: number;
}

const SAVE_AGAIN = 'Save only the sheet you need as a new workbook or as CSV and upload that.';

const damaged = () =>
  new WorkbookRefusedError('This workbook is damaged and cannot be read. Open it in Excel, save it again as .xlsx and upload it again.');

/** The test SheetJS itself uses to read a file as a zip archive (readSync, first four bytes). */
export function isZipFile(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2]! < 9 && b[3]! < 9;
}

const u16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u32 = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)) + b[i + 3]! * 0x1000000;
const u64 = (b: Uint8Array, i: number) => u32(b, i) + u32(b, i + 4) * 0x100000000;

/** Parts that make SheetJS read the archive as something other than an Excel workbook. */
const FOREIGN_PARTS = new Set(['manifest.xml', 'objectdata.xml', 'document.iwa', 'index.zip', 'index.xml', 'index.xml.gz']);

/**
 * The ZIP64 sizes a local header's extra field carries, read as SheetJS reads them
 * (parse_extra_field): uncompressed size, then compressed size.
 */
function zip64Sizes(b: Uint8Array, from: number, to: number): { usz: number; csz: number } | null {
  let p = from;
  while (p + 4 <= to) {
    const id = u16(b, p);
    const size = u16(b, p + 2);
    if (id === 0x0001) {
      if (p + 20 > b.length) throw damaged();
      return { usz: u64(b, p + 4), csz: u64(b, p + 12) };
    }
    p += 4 + size;
  }
  return null;
}

/**
 * Measures what SheetJS would unpack from this zip archive and refuses it when the total is over
 * `maxUnpackedBytes`, when it has more than `maxParts` parts, when a part says it is smaller or
 * larger than it really is, and when it is not an Excel workbook. Throws WorkbookRefusedError.
 */
export function checkWorkbookZip(b: Uint8Array, limits: WorkbookZipLimits): WorkbookZipCheck {
  // End of the central directory: SheetJS takes the last signature in the file, and so does this.
  let eocd = -1;
  for (let i = b.length - 4; i >= 0; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > b.length) throw damaged();
  const parts = u16(b, eocd + 8); // the count SheetJS reads (records on this disk)
  if (parts > limits.maxParts) {
    throw new WorkbookRefusedError(`This workbook has ${parts.toLocaleString('en-US')} parts inside; at most ${limits.maxParts.toLocaleString('en-US')} can be read. ${SAVE_AGAIN}`);
  }

  const mb = Math.round(limits.maxUnpackedBytes / 1024 / 1024);
  const tooBig = () => new WorkbookRefusedError(`This workbook is too large to read: it unpacks to more than ${mb} MB. ${SAVE_AGAIN}`);

  let p = u32(b, eocd + 16); // start of the central directory
  let unpacked = 0;
  let contentTypes = false;
  for (let k = 0; k < parts; k++) {
    // Central directory record: only the name and where the part starts are used, as in SheetJS.
    if (p + 46 > b.length) throw damaged();
    const nameLen = u16(b, p + 28);
    const at = u32(b, p + 42);
    if (p + 46 + nameLen > b.length) throw damaged();
    const name = Buffer.from(b.subarray(p + 46, p + 46 + nameLen)).toString('latin1').replace(/^\/+/, '').toLowerCase();
    p += 46 + nameLen + u16(b, p + 30) + u16(b, p + 32);

    const base = name.slice(name.lastIndexOf('/') + 1);
    if (name === '[content_types].xml') contentTypes = true;
    if (FOREIGN_PARTS.has(base)) {
      throw new WorkbookRefusedError('This file is not an Excel workbook. Save it in Excel as .xlsx or as CSV and upload that.');
    }

    // Local header: SheetJS reads the part from here, with these sizes (parse_local_file).
    if (at + 30 > b.length) throw damaged();
    const flags = u16(b, at + 6);
    const method = u16(b, at + 8);
    if (flags & 0x2041) {
      throw new WorkbookRefusedError('This workbook is password-protected. Remove the password in Excel, save it and upload it again.');
    }
    let csz = u32(b, at + 18);
    let usz = u32(b, at + 22);
    const extraFrom = at + 30 + u16(b, at + 26);
    const dataAt = extraFrom + u16(b, at + 28);
    if (dataAt > b.length) throw damaged();
    const z64 = zip64Sizes(b, extraFrom, dataAt);
    if (z64?.usz) usz = z64.usz;
    if (z64?.csz) csz = z64.csz;

    let size: number;
    if (method === 8) {
      // Deflate: unpack for real, never more than what is left of the allowance (+1 byte, so
      // "over" is seen). SheetJS reads to the end of the compressed stream, whatever the header
      // says, and so does zlib.
      const room = limits.maxUnpackedBytes - unpacked;
      try {
        size = inflateRawSync(b.subarray(dataAt), { maxOutputLength: Math.max(1, room + 1) }).length;
      } catch (err) {
        if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw tooBig();
        throw damaged();
      }
      // A size in the header that is not the real one: SheetJS would allocate by the header
      // (a huge claim) or silently cut the part (a small one). A zero size (the real one
      // follows the data) is normal.
      if (usz !== 0 && usz !== size) throw damaged();
    } else if (method === 0) {
      size = Math.min(csz, b.length - dataAt); // stored: SheetJS takes these bytes as they are
    } else {
      throw new WorkbookRefusedError('This workbook uses a compression Excel does not use and cannot be read. Save it in Excel as .xlsx and upload it again.');
    }
    unpacked += size;
    if (unpacked > limits.maxUnpackedBytes) throw tooBig();
  }
  if (!contentTypes) {
    throw new WorkbookRefusedError('This file is not an Excel workbook. Save it in Excel as .xlsx or as CSV and upload that.');
  }
  return { parts, unpackedBytes: unpacked };
}
