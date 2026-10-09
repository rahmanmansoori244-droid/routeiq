/**
 * Review of 8 Oct 2026, fix "csv-intake" (findings web-intake-1, web-intake-2, web-intake-3,
 * s6-messy-intake-1, s6-messy-intake-3, s5-security-1, M4): how the text of an order, customer or
 * product CSV is read.
 *
 *  - The reader is chosen by the file's content, not by the type the browser sends. Chrome and Edge
 *    on a Windows PC with Excel send every .csv as application/vnd.ms-excel, and SheetJS then read
 *    the text and guessed each value's type: 11/10/2026 became 10 Nov (month first), 00123 became
 *    123, the item "1-2" a date serial. CSV text is now always read by Papa Parse, every value as the
 *    text in the file; only a real .xlsx / .xls (zip or compound-file bytes) goes to SheetJS.
 *  - One quote that is never closed swallowed the rest of the file into one value (390 of 400 orders
 *    lost, the file checked clean): the file is refused, naming the line.
 *  - The bytes are decoded explicitly: byte-order marks, strict UTF-8, else Arabic Windows
 *    (windows-1256) with a warning. Before, Arabic names became U+FFFD or Latin-1 mojibake silently.
 *  - U+0000 is taken out of the cells and the file name (PostgreSQL cannot store it: the upload
 *    answered an empty 500), and binary content named .csv is refused.
 *  - A .csv / .xlsx / .xls sent with a type that says nothing (application/octet-stream, text/plain,
 *    ...) is no longer refused for its type; its content decides.
 *
 * Follow-up (the review of that fix, 9 Oct 2026, "csv-intake-edges"): files SheetJS read when the
 * browser sent them as Excel, and Papa then read wrongly. A bare line feed in a file of CR LF lines
 * ends its row; Excel's ="00123" reads as 00123; a "sep=;" first line names the separator and is not
 * the header; a UTF-8 file with a few bytes that are not UTF-8 stays UTF-8 (each such place read as
 * U+FFFD, with a warning naming how many), and only a file that is clearly not UTF-8 is read as
 * windows-1256.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('xlsx', async (importOriginal) => {
  const real = await importOriginal<typeof import('xlsx')>();
  return { ...real, read: vi.fn(real.read) };
});

import * as XLSX from 'xlsx';
import { parseUpload } from '@/lib/csv';
import { normalizeOrderRows } from '@/lib/dispatch/order-intake';
import { parseUploadIsolated } from '@/lib/upload-parse';
import { fileRefusal, MAX_FILE_BYTES } from '@/lib/upload-limits';

const readSpy = vi.mocked(XLSX.read);
afterEach(() => {
  readSpy.mockClear();
});

const refusal = (p: Promise<unknown>) => p.then(() => 'accepted', (e: Error) => e.message);
const XLS = 'application/vnd.ms-excel';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Every type a browser sends a .csv with: text, Excel (Windows with Excel), none, and the ones that say nothing. */
const CSV_TYPES = ['text/csv', XLS, '', 'application/octet-stream', 'text/plain', 'text/comma-separated-values', 'application/csv', 'text/x-csv'];
const file = (body: string | Uint8Array, name: string, type: string) => new File([typeof body === 'string' ? body : new Uint8Array(body)], name, { type });

/** windows-1256 bytes of `text` (the table Node's own decoder reads them with). */
function cp1256(text: string): Uint8Array {
  const decoder = new TextDecoder('windows-1256');
  const byChar = new Map<string, number>();
  for (let b = 0; b < 256; b++) byChar.set(decoder.decode(Uint8Array.of(b)), b);
  return Uint8Array.from([...text].map((c) => byChar.get(c)!));
}
const utf16 = (text: string, endian: 'le' | 'be') => {
  const le = Buffer.from(text, 'utf16le');
  if (endian === 'be') le.swap16();
  return new Uint8Array(Buffer.concat([Buffer.from(endian === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]), le]));
};

describe('CSV text is read as its text, whatever type the browser sends (web-intake-1, s6-messy-intake-1)', () => {
  // Days of 12 or less (read month-first by SheetJS), codes with leading zeros, an "n-n" code (a
  // date to SheetJS), "1E5" (a number) and "TRUE" (a boolean).
  const ORDERS = [
    'sales_order_no,delivery_date,customer_code,branch_code,product_code,cases',
    '000456,11/10/2026,00123,01,0500,5',
    'SO-2,09/10/2026,C77,B01,1-2,3',
    'SO-3,25/09/2026,C78,,1E5,4',
    'SO-4,2026-10-12,TRUE,,P1,2',
  ].join('\r\n');
  const WANT = [
    ['000456', '2026-10-11', '00123', '01', '0500', 5],
    ['SO-2', '2026-10-09', 'C77', 'B01', '1-2', 3],
    ['SO-3', '2026-09-25', 'C78', null, '1E5', 4],
    ['SO-4', '2026-10-12', 'TRUE', null, 'P1', 2],
  ];

  it.each(CSV_TYPES)('sent as "%s": the tenant date order applies, codes keep their zeros, nothing is guessed; SheetJS never reads it', async (type) => {
    const parsed = await parseUpload(file(ORDERS, 'orders.csv', type));
    expect(parsed.fileType).toBe('csv');
    expect(parsed.warnings).toEqual([]);
    const { lines, errors } = normalizeOrderRows(parsed.rows, { dateOrder: 'DMY' });
    expect(errors).toEqual([]);
    expect(lines.map((l) => [l.salesOrderNo, l.deliveryDate, l.customerCode, l.branchCode, l.productCode, l.cases])).toEqual(WANT);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('a semicolon CSV with a byte-order mark, saved by Excel on a PC set to a comma decimal, is read the same way', async () => {
    const semicolons = `\ufeff${ORDERS.replace(/,/g, ';')}`;
    for (const type of ['text/csv', XLS]) {
      const { lines } = normalizeOrderRows((await parseUpload(file(semicolons, 'orders.csv', type))).rows, { dateOrder: 'DMY' });
      expect([type, lines.map((l) => [l.salesOrderNo, l.deliveryDate, l.customerCode, l.branchCode, l.productCode, l.cases])]).toEqual([type, WANT]);
    }
  });

  it('a customer list sent as Excel keeps the codes as written (a leading-zero code is not a new customer)', async () => {
    const parsed = await parseUpload(file('code,name,lat,lng\n00451,Zero-Lead Trading,23.5850,58.4050\n', 'customers.csv', XLS), { decimalTextColumns: ['lat', 'lng'] });
    expect(parsed.rows).toEqual([{ code: '00451', name: 'Zero-Lead Trading', lat: '23.5850', lng: '58.4050' }]);
  });

  it('a real workbook is still read by SheetJS, also when the browser sends it as application/octet-stream (M4)', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['code', 'cases'], ['C1', 3]]), 'Orders');
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
    for (const type of [XLSX_TYPE, 'application/octet-stream', '']) {
      const parsed = await parseUpload(file(bytes, 'orders.xlsx', type));
      expect([type, parsed.fileType, parsed.rows]).toEqual([type, 'xlsx', [{ code: 'C1', cases: '3' }]]);
    }
    expect(readSpy).toHaveBeenCalled();
    // The web process lets it through to the parser too (it checks the size and type first).
    expect((await parseUploadIsolated(file(bytes, 'orders.xlsx', 'application/octet-stream'))).rows).toEqual([{ code: 'C1', cases: '3' }]);
  });
});

describe('a quote that is never closed refuses the file, naming the line (web-intake-2)', () => {
  const head = 'customer_code,product_code,cases,notes';
  const rows = (bad: string) => [head, 'C1,P1,5,ok', bad, ...Array.from({ length: 400 }, (_, i) => `C${i + 3},P1,${(i % 9) + 1},ok`)].join('\r\n');
  const QUOTE = (line: number) =>
    `Line ${line} of this file has a quote (") that is not closed where it should be, so the lines after it would be read as part of one value. ` +
    'The file was not read. Fix that quote (a quote inside a value is written twice: ""), or save the file again from Excel as CSV, and upload again.';

  it.each(['text/csv', XLS])('sent as "%s": an unclosed quote, and a quoted word followed by more text, are refused', async (type) => {
    // Before: 2 rows read, the second one's note holding the other 400 lines; no error, and as
    // application/vnd.ms-excel not even a warning.
    expect(await refusal(parseUpload(file(rows('C2,P1,3,"Back door, call Ahmed'), 'orders.csv', type)))).toBe(QUOTE(3));
    expect(await refusal(parseUpload(file(rows('C2,P1,3,"URGENT" call before delivery'), 'orders.csv', type)))).toBe(QUOTE(3));
    // The line is the file's own line, also after blank lines and a value over two lines.
    const text = [head, '', 'C1,P1,5,"Gate 2', 'only"', '', 'C2,P1,3,"open', 'C3,P1,4,ok'].join('\n');
    expect(await refusal(parseUpload(file(text, 'orders.csv', type)))).toBe(QUOTE(6));
  });

  it('quotes as Excel writes them are read: a value over two lines, a quote inside a value, a quote in the middle of a value', async () => {
    const text = [head, 'C1,P1,5,"Gate 2\r\nonly"', 'C2,P1,3,"Say ""hello"""', 'C3,P1,4,5" pipe', 'C4,P1,1,ok'].join('\r\n');
    for (const type of ['text/csv', XLS]) {
      const parsed = await parseUpload(file(text, 'orders.csv', type));
      // The line break inside the value is kept as a line feed (every line break is one since the
      // follow-up on mixed line endings, below).
      expect([type, parsed.rows.map((r) => r.notes), parsed.warnings]).toEqual([type, ['Gate 2\nonly', 'Say "hello"', '5" pipe', 'ok'], []]);
    }
  });
});

describe('the bytes are decoded explicitly; Arabic text is never garbled without a word (web-intake-3, s6-messy-intake-3)', () => {
  const NAME = 'مؤسسة النور التجارية';
  const NOTE = 'اتصل قبل الوصول';
  const text = `code,name,notes\r\nC1,${NAME},${NOTE}\r\n`;
  const WANT = [{ code: 'C1', name: NAME, notes: NOTE }];
  const ARABIC_WINDOWS =
    'This file is not saved as UTF-8, so its text was read as Arabic Windows text (Windows-1256). Check the names and notes; ' +
    'if they look wrong, save the file in Excel as "CSV UTF-8 (Comma delimited)" and upload that.';

  it.each([
    ['UTF-8 without a byte-order mark', new TextEncoder().encode(text)],
    ['UTF-8 with a byte-order mark', new TextEncoder().encode(`\ufeff${text}`)],
    ['UTF-16 little-endian with its mark (Excel "Unicode Text")', utf16(text, 'le')],
    ['UTF-16 big-endian with its mark', utf16(text, 'be')],
  ])('%s: read as written, sent as CSV or as Excel, without a warning', async (_what, bytes) => {
    for (const type of ['text/csv', XLS]) {
      const parsed = await parseUpload(file(bytes, 'customers.csv', type));
      expect([type, parsed.rows, parsed.warnings]).toEqual([type, WANT, []]);
    }
  });

  it('Windows-1256 (Excel "CSV (Comma delimited)" on an Arabic PC): read as Arabic, with a warning that says so', async () => {
    for (const type of ['text/csv', XLS]) {
      const parsed = await parseUpload(file(cp1256(text), 'customers.csv', type));
      // Before: "����� ..." as text/csv, "ãÄÓÓÉ ..." as Excel, and no warning.
      expect([type, parsed.rows, parsed.warnings]).toEqual([type, WANT, [ARABIC_WINDOWS]]);
      expect(JSON.stringify(parsed.rows)).not.toContain('�');
    }
  });

  it('a UTF-16 file whose text is cut (an odd number of bytes) is refused, not read with replacement characters', async () => {
    const cut = utf16(text, 'le').slice(0, -1);
    expect(await refusal(parseUpload(file(cut, 'customers.csv', 'text/csv')))).toBe(
      'This file says it is UTF-16 text, but its text is damaged, so it cannot be read. Open it in Excel, save it as "CSV UTF-8 (Comma delimited)" and upload that.',
    );
  });
});

describe('U+0000 and binary content (s5-security-1)', () => {
  const NOT_TEXT = 'This file is not a CSV text file or an Excel workbook, so it cannot be read. Save it in Excel as .xlsx or as CSV and upload that.';

  it('U+0000 is taken out of the cells and the file name (PostgreSQL cannot store it)', async () => {
    const parsed = await parseUpload(file('customer_code,branch_code,delivery_date,product_code,cases\nC-001,__MAIN__,2026-12-01,P1,\u00005\n', 'ord\u0000er.csv', 'text/csv'));
    expect(parsed.fileName).toBe('order.csv');
    expect(parsed.rows).toEqual([{ customer_code: 'C-001', branch_code: '__MAIN__', delivery_date: '2026-12-01', product_code: 'P1', cases: '5' }]);
    expect(JSON.stringify(parsed)).not.toContain('\\u0000');
  });

  it('UTF-16 text without its mark (a NUL after every letter) reads as its letters', async () => {
    const bytes = new Uint8Array(Buffer.from('code,cases\r\nC1,3\r\n', 'utf16le'));
    expect((await parseUpload(file(bytes, 'orders.csv', 'text/csv'))).rows).toEqual([{ code: 'C1', cases: '3' }]);
  });

  it('binary content named .csv is refused, whatever type it is sent with: random bytes, a PNG, a PDF', async () => {
    let seed = 7;
    const random = Uint8Array.from({ length: 2_048 }, () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) >> 23);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...random.slice(0, 500)]);
    const pdf = Uint8Array.from([...new TextEncoder().encode('%PDF-1.7\n%âã\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n'), ...random]);
    for (const bytes of [random, png, pdf]) {
      for (const type of ['text/csv', 'application/octet-stream', '']) {
        expect(await refusal(parseUpload(file(bytes, 'orders.csv', type)))).toBe(NOT_TEXT);
      }
    }
  });
});

describe('the type check lets a spreadsheet through when the browser sends a type that says nothing (M4)', () => {
  const UNSUPPORTED = (type: string) => `Unsupported file type: ${type}. Use CSV or XLSX.`;

  it('application/octet-stream, text/plain, text/comma-separated-values, application/csv and text/x-csv with a .csv, .xlsx or .xls name', () => {
    for (const type of ['application/octet-stream', 'text/plain', 'text/comma-separated-values', 'application/csv', 'text/x-csv']) {
      for (const name of ['orders.csv', 'ORDERS.CSV', 'orders.xlsx', 'orders.xls']) expect([type, name, fileRefusal({ size: 10, type, name })]).toEqual([type, name, null]);
      // Any other name is refused for its type, as before.
      expect(fileRefusal({ size: 10, type, name: 'orders.pdf' })).toBe(UNSUPPORTED(type));
      expect(fileRefusal({ size: 10, type, name: 'orders.csv.exe' })).toBe(UNSUPPORTED(type));
    }
  });

  it('a type that is something else is refused whatever the name; the size limit is unchanged', () => {
    expect(fileRefusal({ size: 10, type: 'image/png', name: 'orders.csv' })).toBe(UNSUPPORTED('image/png'));
    expect(fileRefusal({ size: 10, type: 'text/html', name: 'orders.xls' })).toBe(UNSUPPORTED('text/html'));
    expect(fileRefusal({ size: MAX_FILE_BYTES + 1, type: 'application/octet-stream', name: 'orders.csv' })).toBe('File too large (max 10 MB).');
    expect(fileRefusal({ size: 10, type: 'text/csv', name: 'orders.csv' })).toBeNull();
  });

  it('parseUpload and the web process read such a CSV (before: "Unsupported file type")', async () => {
    for (const type of ['application/octet-stream', 'text/plain', 'text/comma-separated-values']) {
      const f = file('code,cases\nC1,3\n', 'orders.csv', type);
      expect((await parseUpload(f)).rows).toEqual([{ code: 'C1', cases: '3' }]);
      expect((await parseUploadIsolated(f)).rows).toEqual([{ code: 'C1', cases: '3' }]);
    }
  });
});

describe('line breaks of mixed kinds end their rows, as SheetJS read them (follow-up: mixed line endings)', () => {
  const head = 'sales_order_no,customer_code,product_code,cases,notes';
  const read = (rows: Record<string, string>[]) => rows.map((r) => [r.sales_order_no, r.cases, r.notes]);

  it.each(['text/csv', XLS])('sent as "%s": a bare line feed inside a file of CR LF lines ends its row, and so does a lone CR', async (type) => {
    // The reviewer's file. Before: Papa took CR LF as the line break of the whole file, so SO2 (6
    // cases) was read into SO1's note as "ok\nSO2,C2,P1,6,ok2", with only a "Too many fields" warning.
    const text = `${head}\r\nSO1,C1,P1,5,ok\nSO2,C2,P1,6,ok2\r\nSO3,C3,P1,7,ok3\rSO4,C4,P1,8,ok4\r\n`;
    const parsed = await parseUpload(file(text, 'orders.csv', type));
    expect(parsed.warnings).toEqual([]);
    expect(read(parsed.rows)).toEqual([['SO1', '5', 'ok'], ['SO2', '6', 'ok2'], ['SO3', '7', 'ok3'], ['SO4', '8', 'ok4']]);
    expect(parsed.rowNumbers).toEqual([2, 3, 4, 5]);
  });

  it('a CR LF header over LF lines: every order is read (before: one order of a small file, a large one refused for 2,001 columns)', async () => {
    const small = `${head}\r\nSO1,C1,P1,5,ok\nSO2,C2,P1,6,ok\n`;
    expect(read((await parseUpload(file(small, 'orders.csv', XLS))).rows)).toEqual([['SO1', '5', 'ok'], ['SO2', '6', 'ok']]);
    const large = `${head}\r\n${Array.from({ length: 500 }, (_, i) => `SO${i + 1},C${i + 1},P1,${(i % 9) + 1},ok`).join('\n')}\n`;
    const parsed = await parseUpload(file(large, 'orders.csv', XLS));
    expect([parsed.rows.length, parsed.warnings, parsed.rows[499]]).toEqual([500, [], { sales_order_no: 'SO500', customer_code: 'C500', product_code: 'P1', cases: '5', notes: 'ok' }]);
    // parseUploadIsolated, which the upload routes call, gives the same rows.
    expect((await parseUploadIsolated(file(large, 'orders.csv', XLS))).rows).toHaveLength(500);
  });

  it('a line break inside a quoted value stays in its value, as a line feed, whichever kind it is', async () => {
    const text = `${head}\r\nSO1,C1,P1,5,"Gate 2\r\nonly"\r\nSO2,C2,P1,6,"Gate 3\nonly"\r\nSO3,C3,P1,7,"Gate 4\ronly"\r\nSO4,C4,P1,8,ok\r\n`;
    for (const type of ['text/csv', XLS]) {
      const parsed = await parseUpload(file(text, 'orders.csv', type));
      expect([type, read(parsed.rows), parsed.rowNumbers, parsed.warnings]).toEqual([
        type,
        [['SO1', '5', 'Gate 2\nonly'], ['SO2', '6', 'Gate 3\nonly'], ['SO3', '7', 'Gate 4\nonly'], ['SO4', '8', 'ok']],
        [2, 3, 4, 5],
        [],
      ]);
    }
  });
});

describe('Excel\'s ="..." text values read as the text inside (follow-up: leading zeros kept by an ERP)', () => {
  it.each(['text/csv', XLS])('sent as "%s": ="00123" keeps its zeros and matches the customer; the quoted form "=""..."""" too', async (type) => {
    const text = [
      'sales_order_no,delivery_date,customer_code,branch_code,product_code,cases',
      '="000456",11/10/2026,="00123",="01",="0500",5',
      '"=""SO-2""",09/10/2026,"=""C77""",,"=""1-2""",3',
    ].join('\r\n');
    const parsed = await parseUpload(file(text, 'orders.csv', type));
    expect(parsed.warnings).toEqual([]);
    const { lines, errors } = normalizeOrderRows(parsed.rows, { dateOrder: 'DMY' });
    // Before: customer_code '="00123"' was accepted and became a new customer with no location.
    expect(errors).toEqual([]);
    expect(lines.map((l) => [l.salesOrderNo, l.deliveryDate, l.customerCode, l.branchCode, l.productCode, l.cases])).toEqual([
      ['000456', '2026-10-11', '00123', '01', '0500', 5],
      ['SO-2', '2026-10-09', 'C77', null, '1-2', 3],
    ]);
  });

  it('a quote inside is written twice; only a whole ="..." value is unwrapped, any other value with "=" kept as written', async () => {
    const text = 'code,notes\nC1,="Say ""hi"""\nC2,=""\nC3,="  P7 "\nC4,="a"&"b"\nC5,=SUM(A1:A2)\nC6,x="1"\nC7,="open\n';
    const parsed = await parseUpload(file(text, 'notes.csv', 'text/csv'));
    expect(parsed.rows.map((r) => r.notes)).toEqual(['Say "hi"', '', 'P7', '="a"&"b"', '=SUM(A1:A2)', 'x="1"', '="open']);
  });

  it('the text path only: a workbook cell holding the text ="00123" is read as it is', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['code'], ['="00123"']]), 'Customers');
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
    expect((await parseUpload(file(bytes, 'customers.xlsx', XLSX_TYPE))).rows).toEqual([{ code: '="00123"' }]);
  });
});

describe('Excel\'s "sep=" first line names the separator and is not the header (follow-up)', () => {
  it.each(['text/csv', XLS])('sent as "%s": "sep=;" over a semicolon file with commas in its values', async (type) => {
    // Before: the header was "sep=;", and the check said "Missing required column(s) ... Found columns: sep=;".
    const text = 'sep=;\r\ncustomer_code;product_code;cases;notes\r\nC1;P1;5;Ruwi, near the roundabout\r\nC2;P1;3;Gate 2, call first\r\n';
    const parsed = await parseUpload(file(text, 'orders.csv', type));
    expect(parsed.warnings).toEqual([]);
    expect(parsed.rows).toEqual([
      { customer_code: 'C1', product_code: 'P1', cases: '5', notes: 'Ruwi, near the roundabout' },
      { customer_code: 'C2', product_code: 'P1', cases: '3', notes: 'Gate 2, call first' },
    ]);
    // Rows as Excel shows the file: it does not show the "sep=" line, so the header is row 1.
    expect(parsed.rowNumbers).toEqual([2, 3]);
  });

  it('the separator named is used where Papa would guess another; any one character, after a byte-order mark too', async () => {
    // Guessing, Papa splits these lines at the commas (two values on every line either way).
    const tie = await parseUpload(file('sep=;\ncode;address, area\nC1;Noor, Ruwi\nC2;Seeb, Muscat\n', 'customers.csv', 'text/csv'));
    expect(tie.rows).toEqual([
      { code: 'C1', 'address, area': 'Noor, Ruwi' },
      { code: 'C2', 'address, area': 'Seeb, Muscat' },
    ]);
    for (const sep of ['|', '\t', ',', ';']) {
      const parsed = await parseUpload(file(`\ufeffSEP=${sep}\r\ncode${sep}cases\r\nC1${sep}3\r\n`, 'orders.csv', XLS));
      expect([sep, parsed.rows, parsed.warnings]).toEqual([sep, [{ code: 'C1', cases: '3' }], []]);
    }
  });

  it('a "Line N" refusal counts the sep= line, as the file does; a first line that is more than the hint is the header', async () => {
    const bad = 'sep=,\ncustomer_code,product_code,cases,notes\nC1,P1,5,ok\nC2,P1,3,"open\nC3,P1,4,ok\n';
    expect(await refusal(parseUpload(file(bad, 'orders.csv', 'text/csv')))).toMatch(/^Line 4 of this file has a quote \("\) that is not closed/);
    expect((await parseUpload(file('sep=;x,cases\nC1,3\n', 'orders.csv', 'text/csv'))).rows).toEqual([{ 'sep=;x': 'C1', cases: '3' }]);
  });
});

describe('a UTF-8 file with a few bytes that are not UTF-8 stays UTF-8 (follow-up: one stray byte garbled the whole file)', () => {
  const NAME = 'مؤسسة النور التجارية';
  const NOTE = 'اتصل قبل الوصول';
  const enc = (s: string) => [...new TextEncoder().encode(s)];
  const places = (n: number, word: string, verb: string) =>
    `This file is saved as UTF-8, but ${n} ${word} not UTF-8 text and ${verb} read as "\uFFFD". ` +
    'Look for "\uFFFD" in the names and notes; if it matters, correct the file and upload it again.';
  const ARABIC_WINDOWS =
    'This file is not saved as UTF-8, so its text was read as Arabic Windows text (Windows-1256). Check the names and notes; ' +
    'if they look wrong, save the file in Excel as "CSV UTF-8 (Comma delimited)" and upload that.';

  it.each(['text/csv', XLS])('sent as "%s": one stray byte (0xA0) reads as U+FFFD, the Arabic as written, with a warning naming 1 character', async (type) => {
    const bytes = Uint8Array.from([...enc(`code,name,notes\r\nC1,${NAME},${NOTE}\r\nC2,Al Noor`), 0xa0, ...enc('Store,ok\r\n')]);
    const parsed = await parseUpload(file(bytes, 'customers.csv', type));
    // Before: the whole file was read as windows-1256, every Arabic letter garbled ("ظ…ط¤ط³ط³ط©").
    expect(parsed.rows).toEqual([
      { code: 'C1', name: NAME, notes: NOTE },
      { code: 'C2', name: 'Al Noor\uFFFDStore', notes: 'ok' },
    ]);
    expect(parsed.warnings).toEqual([places(1, 'character in it is', 'was')]);
  });

  it('the places are counted as the decoder replaces them: a stray byte, a letter cut short, a byte that never begins a letter', async () => {
    const bytes = Uint8Array.from([
      ...enc(`code,name,notes\r\nC1,${NAME},${NOTE}\r\nC2,a`),
      0xa0, // a byte that only continues a letter
      ...enc('b,c'),
      0xe2, 0x82, // the first two bytes of a three-byte letter (one place)
      ...enc('d'),
      0xd8, // the first byte of a two-byte letter, cut by the line break
      ...enc('\r\nC3,'),
      0xff, // never in UTF-8
      ...enc(`${NOTE},ok\r\n`),
    ]);
    const parsed = await parseUpload(file(bytes, 'customers.csv', 'text/csv'));
    expect(parsed.rows).toEqual([
      { code: 'C1', name: NAME, notes: NOTE },
      { code: 'C2', name: 'a\uFFFDb', notes: 'c\uFFFDd\uFFFD' },
      { code: 'C3', name: `\uFFFD${NOTE}`, notes: 'ok' },
    ]);
    // As many as the warning names: one U+FFFD for each place.
    expect(parsed.warnings).toEqual([places(4, 'characters in it are', 'were')]);
    expect(JSON.stringify(parsed.rows).match(/\uFFFD/g)).toHaveLength(4);
  });

  it('a file that is clearly not UTF-8 is still read as windows-1256: Arabic with commas that make a UTF-8 letter by chance, Latin letters', async () => {
    const arabic = 'code,name,notes\r\nC1,مسقط، روي،,النور، الخوض؛ اتصل؟\r\n';
    const parsed = await parseUpload(file(cp1256(arabic), 'customers.csv', XLS));
    expect([parsed.rows, parsed.warnings]).toEqual([[{ code: 'C1', name: 'مسقط، روي،', notes: 'النور، الخوض؛ اتصل؟' }], [ARABIC_WINDOWS]]);
    const latin = await parseUpload(file(cp1256('code,name\r\nC1,Café Muscat\r\n'), 'customers.csv', 'text/csv'));
    expect([latin.rows, latin.warnings]).toEqual([[{ code: 'C1', name: 'Café Muscat' }], [ARABIC_WINDOWS]]);
  });
});
