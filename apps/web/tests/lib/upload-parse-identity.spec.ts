/**
 * Audit P5 (E2's proper fix): an upload read in the parser process (parseUploadIsolated, the real
 * process as `next dev` runs it) gives exactly what parseUpload gave in the web process before:
 * the same rows (keys, order, text), warnings, sheet name and file name, and the same error - its
 * class for the orders route's MultipleSheetsError answer, its message, code and sheets - for every
 * A1 and A5 case: the caps, the guard's refusals, sheet selection, the row limits, CSV read as
 * Excel, "ID" files, the lat / lng decimals the cells show. Each route's options are built as the
 * route built them before P5.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseUpload, READ_ROWS, type ParseOptions } from '@/lib/csv';
import { isOrderSheet, type CanonicalField } from '@/lib/dispatch/order-intake';
import { MultipleSheetsError } from '@/lib/upload-errors';
import { lastUploadParse, parseUploadIsolated, type ParseSpec } from '@/lib/upload-parse';
import { outcome, useRealUploadParser } from './upload-parse-helpers';
import {
  cfbDescendingChain,
  chartSheetParts,
  denseSheet,
  handWorkbook,
  hugeSheet,
  rawSheet,
  row,
  sheetXml,
  withComments,
  withMetadata,
  withNumberFormat,
  withPeople,
  workbook,
  xlsbWorkbook,
  xlsWithLink,
  xlsxFile,
  zip,
  XLSX_TYPE,
} from './zip-fixtures';

useRealUploadParser();

const XLS_TYPE = 'application/vnd.ms-excel';
const asExcel = (body: string | Buffer, name = 'orders.xls') => new File([typeof body === 'string' ? body : new Uint8Array(body)], name, { type: XLS_TYPE });
const csv = (text: string, name = 'orders.csv') => new File([text], name, { type: 'text/csv' });
function book(sheets: Record<string, unknown[][]>, formats: Record<string, Record<string, string>> = {}): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    for (const [cell, z] of Object.entries(formats[name] ?? {})) ws[cell]!.z = z;
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

// The three routes' options, as each route passed them to parseUpload before P5, and the spec it passes now.
const ALIASES: Partial<Record<CanonicalField, string[]>> = { customer_code: ['Kunde'], product_code: ['Artikel'], cases: ['Menge'] };
const ROUTES: Record<string, { opts: ParseOptions; spec: ParseSpec }> = {
  orders: { opts: { isDataSheet: (headers) => isOrderSheet(headers, {}), rowsWord: 'order' }, spec: { orderSheet: { extraAliases: {} }, rowsWord: 'order' } },
  'orders (company aliases)': {
    opts: { isDataSheet: (headers) => isOrderSheet(headers, ALIASES), rowsWord: 'order' },
    spec: { orderSheet: { extraAliases: ALIASES }, rowsWord: 'order' },
  },
  customers: { opts: { decimalTextColumns: ['lat', 'lng'] }, spec: { decimalTextColumns: ['lat', 'lng'] } },
  baseline: { opts: {}, spec: {} },
};

const ORDER_HEAD = ['sales_order_no', 'delivery_date', 'customer_code', 'product_code', 'cases'];
const orderRows = (n: number) => [ORDER_HEAD, ...Array.from({ length: n }, (_, i) => [`INV-${i + 1}`, '2026-10-07', `C${i % 200}`, 'W500', (i % 9) + 1])];
const CUSTOMERS = [['code', 'name', 'priority', 'lat', 'lng'], ['K1', 'Shop 1', 3, 23.585, 58.405], ['K2', 'Shop 2', 2, 23.58, 58.4059], ['K3', 'Shop 3', 1, 23.6, 58.5]];
const small = readFileSync(path.join(__dirname, '..', 'fixtures', 'nmwc-small.csv'), 'utf8');
/** An order sheet of n rows as raw XML (much faster to make than with SheetJS). */
function orderSheet(n: number): Buffer {
  const cell = (v: unknown) => (typeof v === 'number' ? `<c><v>${v}</v></c>` : `<c t="inlineStr"><is><t>${String(v)}</t></is></c>`);
  return rawSheet(orderRows(n).map((r) => `<row>${r.map(cell).join('')}</row>`).join(''));
}
/** The same File each time (a File cannot change): made once, read by both. */
const memo = (f: () => File) => {
  let file: File | undefined;
  return () => (file ??= f());
};
const twoOrderSheetsOneLong = memo(() => xlsxFile(workbook({ Orders: orderSheet(3), Big: orderSheet(READ_ROWS + 5) })));

/** The corpus: [what, the file, the routes to read it for]. */
const CORPUS: [string, () => File, string[]][] = (<[string, () => File, string[]][]>[
  ['an order CSV (the NMWC fixture)', () => csv(small), ['orders', 'baseline']],
  ['the same as .xlsx', () => xlsxFile(book({ Orders: Papa(small) })), ['orders', 'orders (company aliases)']],
  ['the same CSV sent as Excel (Windows browsers)', () => asExcel(small, 'orders.csv'), ['orders', 'customers']],
  ['a CSV with a byte-order mark sent as Excel', () => asExcel(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('code,cases\nC1,3\n')]), 'orders.csv'), ['baseline']],
  ['UTF-16 tab text sent as Excel', () => asExcel(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('code\tcases\nC1\t3\n', 'utf16le')])), ['baseline']],
  ['a comma CSV starting with "ID" sent as Excel', () => asExcel('ID,Customer Code,Product Code,Cases\n1,C1,P1,5\n2,C2,P2,7\n', 'orders.csv'), ['orders']],
  ['a semicolon CSV starting with "ID" sent as Excel', () => asExcel('ID;Customer Code;Cases\n1;C1;5\n', 'orders.csv'), ['orders']],
  ['a semicolon CSV whose first ID is a SYLK record letter', () => asExcel('ID;name\nC;Shop\nF;Other\n', 'customers.csv'), ['customers']],
  ['a real SYLK file (refused)', () => asExcel('ID;PWXL\nP;PGeneral\nC;Y1;X1;K"code"\nE\n'), ['orders']],
  ['a web page sent as Excel (refused)', () => asExcel('<html><body><table><tr><td>code</td></tr></table></body></html>'), ['orders']],
  ['CSV with broken quotes (warnings)', () => csv('code,name\nC1,"Shop\nC2,Other\n'), ['customers']],
  ['an empty CSV', () => csv(''), ['customers']],
  ['an empty .xlsx file (refused)', () => new File([], 'empty.xlsx', { type: XLSX_TYPE }), ['orders']],
  ['random bytes named .xlsx (refused)', () => new File([new Uint8Array(4096).map((_, i) => (i * 7919) % 251)], 'x.xlsx', { type: XLSX_TYPE }), ['orders']],
  ['a type that is not CSV or Excel (refused before anything is read)', () => new File(['code\n1\n'], 'x.png', { type: 'image/png' }), ['orders']],
  ['a file over 10 MB (refused before anything is read)', () => csv('a'.repeat(10 * 1024 * 1024 + 1)), ['customers']],
  ['orders on two sheets (MultipleSheetsError)', () => xlsxFile(book({ Orders: orderRows(3), LateOrder: orderRows(2) })), ['orders', 'baseline']],
  ['orders on two sheets, one going on past READ_ROWS ("or more")', twoOrderSheetsOneLong, ['orders']],
  ['orders on two sheets found by the company aliases only', () => xlsxFile(book({ A: [['Kunde', 'Artikel', 'Menge'], ['C1', 'P1', 2]], B: [['Kunde', 'Artikel', 'Menge'], ['C2', 'P2', 3]] })), ['orders', 'orders (company aliases)']],
  ['an order sheet next to a customer list (warning)', () => xlsxFile(book({ Customers: [['code', 'name'], ['C1', 'One']], Orders: orderRows(4) })), ['orders', 'customers']],
  ['a blank formatted first sheet, then the data', () => xlsxFile(workbook({ Blank: rawSheet(row(1, ['A', ' '])), Orders: rawSheet(row(1, ['A', 'code'], ['B', 'cases']) + row(2, ['A', 'C1'], ['B', 3])) })), ['orders', 'baseline']],
  ['50,000 order rows (read)', () => csv(Papa2(orderRows(50_000))), ['orders']],
  ['50,001 order rows (refused with the count)', () => xlsxFile(workbook({ Orders: orderSheet(50_001) })), ['orders']],
  ['a sheet going on past READ_ROWS (refused)', () => xlsxFile(workbook({ Orders: { deflated: hugeSheet(3) } })), ['baseline']],
  ['a 0.2 MB file that unpacks to 64 MB (refused)', () => xlsxFile(workbook({ Orders: { deflated: hugeSheet(64) } })), ['orders']],
  ['more than 10 sheets (refused)', () => xlsxFile(book(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`S${i}`, [['code'], ['C1']]])))), ['customers']],
  ['more than 2,500,000 cells (refused)', () => xlsxFile(workbook({ Orders: { deflated: denseSheet(50, 39) } })), ['baseline']],
  ['a link over the whole sheet (refused)', () => xlsxFile(workbook({ Orders: rawSheet(row(1, ['A', 'code']) + row(2, ['A', 'C1']), { after: '<hyperlinks><hyperlink ref="A1:XFD1048576" location="Orders!A1"/></hyperlinks>' }) })), ['orders']],
  ['an old .xls with a link over 65,536 x 65,536 cells (refused)', () => asExcel(xlsWithLink(65_536, 65_536)), ['orders']],
  ['a descending-chain .xls (refused as damaged)', () => asExcel(cfbDescendingChain(2_000)), ['orders']],
  ['a renamed .xlsb (refused)', () => xlsxFile(xlsbWorkbook()), ['orders']],
  ['a password-protected part (refused)', () => xlsxFile(workbook({ Orders: { data: sheetXml(3), flags: 1 } })), ['orders']],
  ['an OpenDocument archive (refused)', () => xlsxFile(zip([{ name: 'mimetype', data: Buffer.from('application/vnd.oasis.opendocument.spreadsheet'), stored: true }, { name: 'content.xml', data: Buffer.from('<x/>') }])), ['orders']],
  ['20,000 metadata entries (refused)', () => xlsxFile(withMetadata(20_000)), ['customers']],
  ['100,000 comment authors (refused)', () => xlsxFile(withPeople(100_000, 2_000)), ['customers']],
  ['10,000 comments (read)', () => xlsxFile(withComments(10_000)), ['customers']],
  ['a long number format on every number cell (read)', () => xlsxFile(withNumberFormat(2_000, 10, `0${'!'.repeat(254)}`)), ['customers']],
  [
    'a chart sheet (refused)',
    () =>
      xlsxFile(
        handWorkbook(
          [{ name: 'Orders', rid: 'rId1' }, { name: 'Chart1', rid: 'rId2' }],
          [{ id: 'rId1', target: 'worksheets/sheet1.xml' }, { id: 'rId2', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet', target: 'chartsheets/sheet1.xml' }],
          [{ name: 'xl/worksheets/sheet1.xml', data: rawSheet(row(1, ['A', 'code']) + row(2, ['A', 'C1'])) }, ...chartSheetParts(3)],
        ),
      ),
    ['orders'],
  ],
  ['ten sheets naming one worksheet part (refused as damaged)', () => xlsxFile(handWorkbook(Array.from({ length: 10 }, (_, i) => ({ name: `S${i}`, rid: 'rId1' })), [{ id: 'rId1', target: 'worksheets/sheet1.xml' }], [{ name: 'xl/worksheets/sheet1.xml', deflated: denseSheet(49, 1) }])), ['orders']],
  ['a range record wider than its cells (read as its cells)', () => xlsxFile(workbook({ Orders: rawSheet(row(1, ['A', 'code'], ['B', 'cases']) + row(2, ['A', 'C1'], ['B', 3]), { before: '<dimension ref="A1:XFD2000"/>' }) })), ['baseline']],
  ['formulas give their saved values; dates stay serials', () => xlsxFile(workbook({ Orders: rawSheet(row(1, ['A', 'code'], ['B', 'cases'], ['C', 'date']) + '<row r="2"><c r="A2" t="inlineStr"><is><t>C1</t></is></c><c r="B2"><f>1+2</f><v>3</v></c><c r="C2" s="0"><v>46300</v></c></row>') })), ['orders', 'baseline']],
  ['duplicate and empty header cells', () => xlsxFile(book({ Orders: [['code', 'code', '', 'Code '], ['a', 'b', 'c', 'd']] })), ['baseline']],
  ['lat / lng number cells formatted with 4 decimals', () => xlsxFile(book({ Customers: CUSTOMERS }, { Customers: { D2: '0.0000', E2: '0.0000', D3: '0.0000', E3: '0.00', D4: '0.0000' } })), ['customers', 'baseline']],
  ['lat / lng as CSV sent as Excel with trailing zeros', () => asExcel('code,name,priority,lat,lng\nK1,Shop,3,23.5850,58.4050\nK2,Shop,2,23.5800,58.4000\n', 'customers.csv'), ['customers']],
  ['lat / lng as a plain CSV', () => csv('code,name,priority,lat,lng\nK1,Shop,3,23.5850,58.4050\n', 'customers.csv'), ['customers']],
]).map(([what, file, routes]) => [what, memo(file), routes]);

/** Papa-free CSV -> rows for the .xlsx copy of the fixture (quotes are not used in it). */
function Papa(text: string): unknown[][] {
  return text.trim().split(/\r?\n/).map((l) => l.split(','));
}
function Papa2(aoa: unknown[][]): string {
  return aoa.map((r) => r.join(',')).join('\n') + '\n';
}

describe('an upload read in the parser process gives exactly what parseUpload gave (audit P5)', () => {
  const cases = CORPUS.flatMap(([what, file, routes]) => routes.map((r) => [what, r, file] as const));
  it.each(cases)('%s, for the %s route', async (_what, route, file) => {
    const { opts, spec } = ROUTES[route]!;
    const before = await outcome(parseUpload(file(), opts));
    const now = await outcome(parseUploadIsolated(file(), spec));
    expect(now).toEqual(before);
  });

  it('a workbook with orders on two sheets is a MultipleSheetsError again, answered by the orders route as before', async () => {
    const before = await parseUpload(twoOrderSheetsOneLong(), ROUTES.orders!.opts).catch((e: unknown) => e);
    const now = await parseUploadIsolated(twoOrderSheetsOneLong(), ROUTES.orders!.spec).catch((e: unknown) => e);
    expect(now).toBeInstanceOf(MultipleSheetsError);
    const answer = (e: MultipleSheetsError) => JSON.stringify({ data: null, error: { code: e.code, message: e.message, sheets: e.sheets } });
    expect(answer(now as MultipleSheetsError)).toBe(answer(before as MultipleSheetsError));
    expect((now as MultipleSheetsError).sheets).toEqual([{ name: 'Orders', rows: 3 }, { name: 'Big', rows: READ_ROWS - 1, truncated: true }]);
  });

  it('a large file comes back in pieces and is put together in order (50,000 rows x 15 columns)', async () => {
    const aoa = [Array.from({ length: 15 }, (_, c) => `h${c}`), ...Array.from({ length: 50_000 }, (_, r) => Array.from({ length: 15 }, (_, c) => `${r}-${c}`))];
    const file = memo(() => csv(Papa2(aoa), 'wide.csv'));
    const before = await parseUpload(file());
    const now = await parseUploadIsolated(file());
    expect(now.rows.length).toBe(50_000);
    expect(now).toEqual(before);
    // 750,000 cells in pieces of about 25,000: this process never turns them into objects in one go.
    expect(lastUploadParse()?.pieces).toBe(Math.ceil(50_000 / Math.floor(25_000 / 15)));
    expect(Object.keys(now.rows[49_999]!)).toEqual(aoa[0]);
  });
});
