/**
 * Hand-built .xlsx files for the upload-limit tests (audit E2 and its A1 review): a minimal zip
 * writer, so a test can say exactly what each part and each zip header contains - including sizes
 * that lie, a part with two names and a small file that unpacks to a very large sheet - and the
 * other formats SheetJS reads (.xls, .xlsb) with a link record whose range is set by the test.
 */
import { constants, deflateRawSync } from 'node:zlib';
import * as XLSX from 'xlsx';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface ZipPart {
  name: string;
  /** Name written in the part's local header instead of `name` (the central directory keeps `name`). */
  localName?: string;
  /** Plain content, deflated here. */
  data?: Buffer;
  /** Or an already deflated stream, with its real unpacked size. */
  deflated?: { raw: Buffer; size: number };
  /** Stored, not deflated. */
  stored?: boolean;
  /** Size written in the headers instead of the real one. */
  claimedSize?: number;
  /** General-purpose flags of the local header (bit 0: encrypted). */
  flags?: number;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function zip(parts: ZipPart[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const p of parts) {
    const name = Buffer.from(p.name, 'latin1');
    const localName = Buffer.from(p.localName ?? p.name, 'latin1');
    const method = p.stored ? 0 : 8;
    const raw = p.deflated ? p.deflated.raw : p.stored ? p.data! : deflateRawSync(p.data!, { level: 9 });
    const size = p.claimedSize ?? (p.deflated ? p.deflated.size : p.data!.length);
    const crc = p.data ? crc32(p.data) : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(p.flags ?? 0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(raw.length, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(localName.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(p.flags ?? 0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(raw.length, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(lh, localName, raw);
    central.push(cd, name);
    offset += 30 + localName.length + raw.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** The parts every workbook has, for `n` sheets (sheet i at xl/worksheets/sheet{i}.xml). */
function skeleton(names: string[]): ZipPart[] {
  const n = names.length;
  const overrides = names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  return [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`,
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(`${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(`${xml}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>${names.map((s, i) => `<sheet name="${s}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
      ),
    },
  ];
}

const SHEET_HEAD = `${xml}<worksheet xmlns="${MAIN}"><sheetData><row><c t="inlineStr"><is><t>code</t></is></c><c t="inlineStr"><is><t>cases</t></is></c></row>`;
const SHEET_TAIL = '</sheetData></worksheet>';

/** A sheet (no size record, as some generators write it): header "code, cases" + n rows. */
export function sheetXml(n: number): Buffer {
  const rows: string[] = [SHEET_HEAD];
  for (let i = 0; i < n; i++) rows.push(`<row><c t="inlineStr"><is><t>C${i}</t></is></c><c><v>${(i % 9) + 1}</v></c></row>`);
  rows.push(SHEET_TAIL);
  return Buffer.from(rows.join(''));
}

/**
 * A sheet that unpacks to about `mb` MB (header + about 25,000 rows per MB) from a small file:
 * one deflated 1 MB block of rows, repeated. Deflate blocks can be joined, so the result is one
 * valid stream of `mb` copies.
 */
export function hugeSheet(mb: number): { raw: Buffer; size: number } {
  const unit = '<row><c><v>1</v></c><c><v>1</v></c></row>';
  const block = unit.repeat(Math.floor((1 << 20) / unit.length));
  const head = deflateRawSync(Buffer.from(SHEET_HEAD), { finishFlush: constants.Z_SYNC_FLUSH });
  const body = deflateRawSync(Buffer.from(block), { level: 9, finishFlush: constants.Z_SYNC_FLUSH });
  const tail = deflateRawSync(Buffer.from(SHEET_TAIL));
  return { raw: Buffer.concat([head, ...Array<Buffer>(mb).fill(body), tail]), size: SHEET_HEAD.length + mb * block.length + SHEET_TAIL.length };
}

/** A workbook with one sheet per entry; a sheet is its XML, or a part to use as is. */
export function workbook(sheets: Record<string, Buffer | Omit<ZipPart, 'name'>>, extra: ZipPart[] = []): Buffer {
  const names = Object.keys(sheets);
  return zip([
    ...skeleton(names),
    ...names.map((s, i) => {
      const v = sheets[s]!;
      return Buffer.isBuffer(v) ? { name: `xl/worksheets/sheet${i + 1}.xml`, data: v } : { name: `xl/worksheets/sheet${i + 1}.xml`, ...v };
    }),
    ...extra,
  ]);
}

export const xlsxFile = (bytes: Buffer, name = 'orders.xlsx') => new File([new Uint8Array(bytes)], name, { type: XLSX_TYPE });

/** A sheet with the given XML inside <sheetData>, and `before` / `after` it (size record, links). */
export function rawSheet(sheetData: string, extra: { before?: string; after?: string } = {}): Buffer {
  return Buffer.from(`${xml}<worksheet xmlns="${MAIN}">${extra.before ?? ''}<sheetData>${sheetData}</sheetData>${extra.after ?? ''}</worksheet>`);
}

/** A row of inline-string / number cells with explicit addresses: row(1, ['A', 'code'], ['B', 3]). */
export function row(r: number, ...cells: [string, string | number][]): string {
  const cell = ([col, v]: [string, string | number]) =>
    typeof v === 'number' ? `<c r="${col}${r}"><v>${v}</v></c>` : `<c r="${col}${r}" t="inlineStr"><is><t>${v}</t></is></c>`;
  return `<row r="${r}">${cells.map(cell).join('')}</row>`;
}

/** The parts of a zip written by SheetJS (XLSX.write), by name, to be rearranged with zip(). */
export function sheetjsParts(bytes: Uint8Array): ZipPart[] {
  const cfb = XLSX.CFB.read(Buffer.from(bytes), { type: 'buffer' });
  const out: ZipPart[] = [];
  (cfb.FullPaths as string[]).forEach((p, i) => {
    const f = cfb.FileIndex[i] as { type: number; name: string; content?: Uint8Array };
    if (f.type === 2 && f.content && !p.endsWith('/') && !f.name.startsWith('\u0001')) out.push({ name: p.replace(/^Root Entry\//, ''), data: Buffer.from(f.content) });
  });
  return out;
}

const orderSheet = () => {
  const ws = XLSX.utils.aoa_to_sheet([['code', 'cases'], ['C1', 3], ['C2', 4]]);
  (ws['A2'] as XLSX.CellObject).l = { Target: 'https://example.com/C1', Tooltip: 'Customer C1' };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Orders');
  return wb;
};

/**
 * An old .xls (BIFF8, written by SheetJS): "code, cases" and two rows, with one link on A2 whose
 * range (HLink and its tooltip record) is set to rows 0..rows-1 x columns 0..cols-1.
 */
export function xlsWithLink(rows: number, cols: number): Buffer {
  const out = Buffer.from(XLSX.write(orderSheet(), { type: 'array', bookType: 'biff8' }) as ArrayBuffer);
  let patched = 0;
  for (let i = 0; i + 14 <= out.length; i++) {
    const at = out.readUInt16LE(i) === 0x01b8 ? i + 4 : out.readUInt16LE(i) === 0x0800 ? i + 6 : -1;
    if (at < 0 || at + 8 > out.length || out.readUInt16LE(at) !== 1 || out.readUInt16LE(at + 2) !== 1 || out.readUInt32LE(at + 4) !== 0) continue;
    out.writeUInt16LE(0, at);
    out.writeUInt16LE(rows - 1, at + 2);
    out.writeUInt16LE(0, at + 4);
    out.writeUInt16LE(cols - 1, at + 6);
    patched++;
  }
  if (patched !== 2) throw new Error(`xlsWithLink: patched ${patched} link records, expected 2`);
  return out;
}

/**
 * An Excel binary workbook (.xlsb, written by SheetJS) with the same sheet; `linkRows` x `linkCols`
 * sets the range of its one link record (BrtHLink) when given.
 */
export function xlsbWorkbook(link?: { rows: number; cols: number }): Buffer {
  const bytes = Buffer.from(XLSX.write(orderSheet(), { type: 'array', bookType: 'xlsb' }) as ArrayBuffer);
  if (!link) return bytes;
  const parts = sheetjsParts(bytes);
  const sheet = parts.find((p) => p.name === 'xl/worksheets/sheet1.bin')!.data!;
  let patched = 0;
  // BrtHLink: record type 0x1EE (bytes EE 03), a one-byte length, then rwFirst, rwLast, colFirst, colLast (u32).
  for (let i = 0; i + 19 <= sheet.length; i++) {
    if (sheet[i] !== 0xee || sheet[i + 1] !== 0x03 || sheet.readUInt32LE(i + 3) !== 1 || sheet.readUInt32LE(i + 7) !== 1) continue;
    sheet.writeUInt32LE(0, i + 3);
    sheet.writeUInt32LE(link.rows - 1, i + 7);
    sheet.writeUInt32LE(0, i + 11);
    sheet.writeUInt32LE(link.cols - 1, i + 15);
    patched++;
  }
  if (patched !== 1) throw new Error(`xlsbWorkbook: patched ${patched} link records, expected 1`);
  return zip(parts);
}

/**
 * A sheet that unpacks to about `mb` MB of rows of `perRow` one-digit number cells, from a small
 * file (one deflated 1 MB block, repeated, as in hugeSheet). `cells` is how many it holds.
 */
export function denseSheet(perRow: number, mb: number): { raw: Buffer; size: number; cells: number } {
  const unit = `<row>${'<c><v>1</v></c>'.repeat(perRow)}</row>`;
  const rowsPerBlock = Math.floor((1 << 20) / unit.length);
  const block = unit.repeat(rowsPerBlock);
  const head = deflateRawSync(Buffer.from(SHEET_HEAD), { finishFlush: constants.Z_SYNC_FLUSH });
  const body = deflateRawSync(Buffer.from(block), { level: 9, finishFlush: constants.Z_SYNC_FLUSH });
  const tail = deflateRawSync(Buffer.from(SHEET_TAIL));
  return {
    raw: Buffer.concat([head, ...Array<Buffer>(mb).fill(body), tail]),
    size: SHEET_HEAD.length + mb * block.length + SHEET_TAIL.length,
    cells: 2 + mb * rowsPerBlock * perRow,
  };
}

/**
 * An .xlsx (written by SheetJS) whose one worksheet is a binary part, xl/worksheets/sheet1.bin,
 * taken from xlsbWorkbook(link): SheetJS reads any worksheet whose name ends in ".bin" as .xlsb.
 */
export function xlsxWithBinarySheet(link: { rows: number; cols: number }): Buffer {
  const bin = sheetjsParts(xlsbWorkbook(link)).find((p) => p.name === 'xl/worksheets/sheet1.bin')!;
  const parts = sheetjsParts(Buffer.from(XLSX.write(orderSheet(), { type: 'array', bookType: 'xlsx' }) as ArrayBuffer))
    .filter((p) => p.name !== 'xl/worksheets/sheet1.xml')
    .map((p) => (p.name === 'xl/_rels/workbook.xml.rels' ? { ...p, data: Buffer.from(p.data!.toString('utf8').replace('worksheets/sheet1.xml', 'worksheets/sheet1.bin')) } : p));
  return zip([...parts, bin]);
}

/** An .xlsx (written by SheetJS) with `n` comments, all on cell A2. */
export function withComments(n: number): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([['code', 'cases'], ['C1', 3]]);
  (ws['A2'] as XLSX.CellObject).c = [{ a: 'Dispatcher', t: 'note' }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Orders');
  const parts = sheetjsParts(Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer));
  const part = parts.find((p) => /comments\d*\.xml$/.test(p.name))!;
  const text = part.data!.toString('utf8');
  const one = /<comment [\s\S]*?<\/comment>/.exec(text)![0];
  part.data = Buffer.from(text.replace(one, one.repeat(n)));
  return zip(parts);
}
