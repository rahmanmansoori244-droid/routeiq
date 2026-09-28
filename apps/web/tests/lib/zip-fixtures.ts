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

/**
 * The parts every workbook has, for `n` sheets (sheet i at xl/worksheets/sheet{i}.xml); `more`
 * lists other parts in [Content_Types].xml ({ part: '/xl/metadata.xml', type: '...' }).
 */
function skeleton(names: string[], more: { part: string; type: string }[] = []): ZipPart[] {
  const n = names.length;
  const overrides =
    names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    more.map((o) => `<Override PartName="${o.part}" ContentType="${o.type}"/>`).join('');
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

/**
 * A workbook with one sheet per entry; a sheet is its XML, or a part to use as is. `extra` parts
 * are added as they are; `types` lists some of them in [Content_Types].xml, which is how SheetJS
 * finds a metadata part or a person list.
 */
export function workbook(sheets: Record<string, Buffer | Omit<ZipPart, 'name'>>, extra: ZipPart[] = [], types: { part: string; type: string }[] = []): Buffer {
  const names = Object.keys(sheets);
  return zip([
    ...skeleton(names, types),
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
 * A sheet that unpacks to about `mb` MB of rows of `perRow` cells (by default one-digit numbers;
 * `cell` is the XML of one), from a small file (one deflated 1 MB block, repeated, as in
 * hugeSheet). `cells` is how many it holds.
 */
export function denseSheet(perRow: number, mb: number, cell = '<c><v>1</v></c>'): { raw: Buffer; size: number; cells: number } {
  const unit = `<row>${cell.repeat(perRow)}</row>`;
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

/**
 * A workbook whose one sheet has a header row (c0, c1, ...) and `rows` rows of `cols` number cells
 * (row r, column c holds r * 100 + c), every number cell in the custom number format `format`.
 */
export function withNumberFormat(rows: number, cols: number, format: string): Buffer {
  const names = Array.from({ length: cols }, (_, c) => XLSX.utils.encode_col(c));
  let data = row(1, ...names.map((col, c): [string, string] => [col, `c${c}`]));
  for (let r = 2; r <= rows + 1; r++) data += `<row r="${r}">${names.map((col, c) => `<c r="${col}${r}" s="1"><v>${r * 100 + c}</v></c>`).join('')}</row>`;
  const styles =
    `${xml}<styleSheet xmlns="${MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="${format}"/></numFmts>` +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>';
  return workbook({ Orders: rawSheet(data) }, [{ name: 'xl/styles.xml', data: Buffer.from(styles) }], [
    { part: '/xl/styles.xml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml' },
  ]);
}

const METADATA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml';
const PERSON_TYPE = 'application/vnd.ms-excel.person+xml';

/**
 * A workbook ("code, cases" and one row) with an xl/metadata.xml that SheetJS reads, holding `n`
 * metadata types and `n` future-metadata blocks: SheetJS looks through every type for each block.
 */
export function withMetadata(n: number): Buffer {
  const data =
    `${xml}<metadata xmlns="${MAIN}"><metadataTypes count="${n}">${'<metadataType name="XLDAPR" minSupportedVersion="120000"/>'.repeat(n)}</metadataTypes>` +
    `${'<futureMetadata name="XLDAPR" count="1"><bk></bk></futureMetadata>'.repeat(n)}</metadata>`;
  return workbook({ Orders: sheetXml(1) }, [{ name: 'xl/metadata.xml', data: Buffer.from(data) }], [{ part: '/xl/metadata.xml', type: METADATA_TYPE }]);
}

/**
 * A workbook ("code, cases" and one row) with `comments` threaded comments (column C, one per row
 * from row 2) by an author who is not in its person list of `people` people: SheetJS looks
 * through the whole list for each comment.
 */
export function withPeople(people: number, comments: number): Buffer {
  const TCMNT_REL = 'http://schemas.microsoft.com/office/2017/10/relationships/threadedComment';
  const threaded =
    `${xml}<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">` +
    Array.from({ length: comments }, (_, i) => `<threadedComment ref="C${i + 2}" personId="{nobody}" id="{c${i}}"><text>check</text></threadedComment>`).join('') +
    '</ThreadedComments>';
  const list = `${xml}<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">${'<person displayName="Dispatcher" id="{p}"/>'.repeat(people)}</personList>`;
  return workbook(
    { Orders: sheetXml(1) },
    [
      { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: Buffer.from(`${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${TCMNT_REL}" Target="../threadedComments/threadedComment1.xml"/></Relationships>`) },
      { name: 'xl/threadedComments/threadedComment1.xml', data: Buffer.from(threaded) },
      { name: 'xl/persons/person.xml', data: Buffer.from(list) },
    ],
    [{ part: '/xl/persons/person.xml', type: PERSON_TYPE }],
  );
}

/**
 * A crafted compound file (an .xls signature) whose FAT chains are stored in descending sector
 * order: each data sector points to the one below it, so it reads as one ordinary chain, but
 * SheetJS's make_sector_list walks and copies a chain from every sector - about `dataSectors`^2 / 2
 * sectors in all. Its directory sector holds no streams, so once the walk is bounded the file is
 * refused as damaged (no /Workbook stream); the point is that it must be refused before the walk.
 * Adapted from .dev/scratch-a1-v2/cfb/run.ts. `dataSectors` is D; the file is 512 * (F + D + 1)
 * bytes, where F is the number of FAT sectors it needs.
 */
export function cfbDescendingChain(dataSectors: number): Buffer {
  const SSZ = 512;
  const D = dataSectors;
  let F = 1;
  while (F * 128 < F + D) F++; // FAT sectors needed to hold F + D FAT entries
  const N = F + D;
  const file = Buffer.alloc(SSZ * (N + 1));
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(file, 0);
  file.writeUInt16LE(0x3e, 24); // minor version
  file.writeUInt16LE(3, 26); // major version
  file.writeUInt16LE(0xfffe, 28); // byte order
  file.writeUInt16LE(9, 30); // sector shift (512)
  file.writeUInt16LE(6, 32); // mini sector shift
  file.writeInt32LE(0, 40); // directory sectors (v3: 0)
  file.writeInt32LE(F, 44); // FAT sectors
  file.writeInt32LE(F, 48); // first directory sector = first data sector
  file.writeUInt32LE(0x1000, 56); // mini stream cutoff
  file.writeInt32LE(-2, 60); // first mini FAT sector (none)
  file.writeInt32LE(0, 64); // mini FAT sector count
  file.writeInt32LE(-2, 68); // first DIFAT sector (none)
  file.writeInt32LE(0, 72); // DIFAT sector count
  for (let j = 0; j < 109; j++) file.writeInt32LE(j < F ? j : -1, 76 + j * 4);
  // FAT: sectors 0..F-1 are FAT sectors (-3); sector F ends its chain (-2); every later sector
  // points to the one before it, so the chains are stored in descending sector order.
  const fatEntry = (s: number) => (s < F ? -3 : s === F ? -2 : s - 1);
  for (let s = 0; s < N; s++) {
    const fatSector = Math.floor(s / 128);
    file.writeInt32LE(fatEntry(s), SSZ * (fatSector + 1) + (s % 128) * 4);
  }
  return file;
}

/** Relationship types SheetJS reads (its RELS table, xlsx 0.20.2). */
export const RELS = {
  worksheet: `${REL}/worksheet`,
  chartsheet: `${REL}/chartsheet`,
  dialogsheet: `${REL}/dialogsheet`,
  macrosheet: 'http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet',
  comments: `${REL}/comments`,
  vmlDrawing: `${REL}/vmlDrawing`,
  drawing: `${REL}/drawing`,
  chart: `${REL}/chart`,
};

export interface Rel {
  id: string;
  target: string;
  /** Worksheet when not given. */
  type?: string;
}

/** A relationships part (.rels) listing `rels`. */
export function relsXml(rels: Rel[]): Buffer {
  return Buffer.from(
    `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels
      .map((r) => `<Relationship Id="${r.id}" Type="${r.type ?? RELS.worksheet}" Target="${r.target}"/>`)
      .join('')}</Relationships>`,
  );
}

/**
 * A workbook built by hand, for the tests of which part each sheet reads: its sheet list (each
 * sheet's name and relationship id), the relationships of the workbook part and every other part.
 * [Content_Types].xml (with `types` added), _rels/.rels and the workbook part are added; the
 * workbook part is xl/workbook.xml unless `workbookPart` names another one, and its relationships
 * are in the _rels folder next to it. `sheetTags` replaces the <sheet> tags made from `sheets`.
 */
export function handWorkbook(
  sheets: { name: string; rid: string }[],
  rels: Rel[],
  parts: ZipPart[],
  opts: { types?: { part: string; type: string }[]; workbookPart?: string; sheetTags?: string } = {},
): Buffer {
  const wb = opts.workbookPart ?? 'xl/workbook.xml';
  const slash = wb.lastIndexOf('/');
  const overrides = [{ part: `/${wb}`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' }, ...(opts.types ?? [])];
  return zip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides
          .map((o) => `<Override PartName="${o.part}" ContentType="${o.type}"/>`)
          .join('')}</Types>`,
      ),
    },
    { name: '_rels/.rels', data: relsXml([{ id: 'rId1', type: `${REL}/officeDocument`, target: wb }]) },
    {
      name: wb,
      data: Buffer.from(
        `${xml}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>${opts.sheetTags ?? sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="${s.rid}"/>`).join('')}</sheets></workbook>`,
      ),
    },
    { name: `${wb.slice(0, slash + 1)}_rels/${wb.slice(slash + 1)}.rels`, data: relsXml(rels) },
    ...parts,
  ]);
}

/** A comments part with `n` comments, all on `ref`. */
export function commentsXml(n: number, ref = 'B2'): Buffer {
  return Buffer.from(
    `${xml}<comments xmlns="${MAIN}"><authors><author>Dispatcher</author></authors><commentList>${`<comment ref="${ref}" authorId="0"><text><t>check</t></text></comment>`.repeat(n)}</commentList></comments>`,
  );
}

/**
 * A legacy drawing (VML) with one note shape per row from row 2 (column B) for `notes` rows:
 * SheetJS reads it for a sheet whose <legacyDrawing r:id> names it, and makes a cell for each note.
 */
export function vmlNotes(notes: number): Buffer {
  const shape = (r: number) => `<v:shape type="#_x0000_t202"><x:ClientData ObjectType="Note"><x:Row>${r}</x:Row><x:Column>1</x:Column></x:ClientData></v:shape>`;
  const shapes: string[] = [];
  for (let r = 1; r <= notes; r++) shapes.push(shape(r));
  return Buffer.from(`<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:x="urn:schemas-microsoft-com:office:excel">${shapes.join('')}</xml>`);
}

/** A worksheet ("code, cases" and one row) whose <legacyDrawing> names relationship `rid`. */
export function sheetWithLegacyDrawing(rid: string): Buffer {
  return Buffer.from(
    `${xml}<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><sheetData>${row(1, ['A', 'code'], ['B', 'cases'])}${row(2, ['A', 'C1'], ['B', 3])}</sheetData><legacyDrawing r:id="${rid}"/></worksheet>`,
  );
}

/**
 * A chart sheet (as Excel writes one: the sheet, its drawing, the chart) whose chart caches
 * `points` numbers: SheetJS reads a chart sheet into a sheet with one cell per cached point.
 */
export function chartSheetParts(points: number): ZipPart[] {
  const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
  const pts = Array.from({ length: points }, (_, i) => `<c:pt idx="${i}"><c:v>${i + 1}</c:v></c:pt>`).join('');
  return [
    { name: 'xl/chartsheets/sheet1.xml', data: Buffer.from(`${xml}<chartsheet xmlns="${MAIN}" xmlns:r="${REL}"><drawing r:id="rId1"/></chartsheet>`) },
    { name: 'xl/chartsheets/_rels/sheet1.xml.rels', data: relsXml([{ id: 'rId1', type: RELS.drawing, target: '../drawings/drawing1.xml' }]) },
    {
      name: 'xl/drawings/drawing1.xml',
      data: Buffer.from(
        `${xml}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:absoluteAnchor><xdr:graphicFrame><a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" xmlns:r="${REL}" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame></xdr:absoluteAnchor></xdr:wsDr>`,
      ),
    },
    { name: 'xl/drawings/_rels/drawing1.xml.rels', data: relsXml([{ id: 'rId1', type: RELS.chart, target: '../charts/chart1.xml' }]) },
    {
      name: 'xl/charts/chart1.xml',
      data: Buffer.from(
        `${xml}<c:chartSpace xmlns:c="${C}"><c:chart><c:plotArea><c:barChart><c:ser><c:val><c:numRef><c:f>Orders!$B$2:$B$${points + 1}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${points}"/>${pts}</c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`,
      ),
    },
  ];
}
