/**
 * Hand-built .xlsx files for the upload-limit tests (audit E2): a minimal zip writer, so a test
 * can say exactly what each part and each zip header contains - including sizes that lie and a
 * small file that unpacks to a very large sheet.
 */
import { constants, deflateRawSync } from 'node:zlib';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface ZipPart {
  name: string;
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
    lh.writeUInt16LE(name.length, 26);
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
    locals.push(lh, name, raw);
    central.push(cd, name);
    offset += 30 + name.length + raw.length;
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
