/**
 * Daily sales-order file intake (Excel/CSV) for dispatch planning.
 *
 * Step 1 `normalizeOrderRows` (pure): map whatever headers the NMWC export uses onto canonical
 *   fields, parse dates / numbers, and report row-level errors. Nothing is dropped silently:
 *   a row either becomes a line or an error with its file row number.
 * Step 2 `resolveOrderLines` (pure, given master-data lookups): attach customers/products,
 *   list the NEW customers/products that confirm will create (a new customer is NOT an error -
 *   it becomes "LOCATION REQUIRED" and is completed by the dispatcher), flag duplicates of
 *   lines already confirmed, and compute totals for the reconciliation baseline.
 *
 * Multiple product rows for one customer branch become ONE delivery stop at planning time,
 * but every SKU line (and its sales-order number) is kept so the truck manifest reconciles.
 */
import { normalizeBranchKey } from '../schemas';
import { normalizeProductCode, productCodeProblem, productKey } from '../product-code';

// The header matching (aliases, the order-sheet test) lives in order-headers.ts, which has no
// dependencies, so the upload parser process can use it (audit P5); it is re-exported here.
import { mapHeaders, type CanonicalField, type ColumnMapping } from './order-headers';
export { HEADER_ALIASES, isOrderSheet, mapHeaders, normHeader } from './order-headers';
export type { CanonicalField, ColumnMapping } from './order-headers';

export interface NormalizedLine {
  row: number; // file row (header = 1)
  salesOrderNo: string | null;
  orderDate: string | null;
  deliveryDate: string;
  customerCode: string;
  branchCode: string | null;
  branchKey: string;
  customerName: string | null;
  productCode: string;
  productDescription: string | null;
  cases: number;
  weightKg: number | null; // line weight (kg for the whole line) from the file, if given; 0 counts as not given
  salesValue: number | null;
  margin: number | null;
  priority: number | null;
  notes: string | null;
  depotCode: string | null;
  customerType: string | null;
}

export interface RowError {
  row: number;
  message: string;
  cases?: number | null;
}

export interface NormalizeResult {
  mapping: ColumnMapping;
  lines: NormalizedLine[];
  errors: RowError[];
  warnings: string[];
  fileCases: number; // every parseable case quantity in the file, including rejected rows
}

export type DateOrder = 'DMY' | 'MDY' | 'YMD';

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function validYmd(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Excel serial (1900 system) -> YYYY-MM-DD. */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 120000) return null;
  const ms = Math.round((serial - 25569) * 86_400_000);
  const d = new Date(ms);
  return validYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Accepts YYYY-MM-DD, DD/MM/YYYY (or MM/DD per tenant), DD-MM-YYYY, DD.MM.YYYY, 25-Sep-2026, Excel serials, ISO timestamps. */
export function parseDateCell(raw: string, order: DateOrder = 'DMY'): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  if (/^\d{5}(\.\d+)?$/.test(s)) return excelSerialToIso(Number(s));
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:\s.*)?$/.exec(s);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    const a = +m[1];
    const b = +m[2];
    if (order === 'MDY') return validYmd(y, a, b);
    return validYmd(y, b, a);
  }
  m = /^(\d{1,2})[-\s]([A-Za-z]{3,4})[A-Za-z]*[-\s,]+(\d{2,4})$/.exec(s);
  // "Sept" is its own key; full names ("March" -> "Marc") fall back to the 3-letter prefix.
  const mon = m ? MONTHS[m[2].toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()] : undefined;
  if (m && mon) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return validYmd(y, mon, +m[1]);
  }
  return null;
}

function num(raw: string | undefined): number | null {
  const s = (raw ?? '').trim().replace(/,/g, '');
  if (!s) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

function priorityOf(raw: string | undefined): number | null | 'bad' {
  const s = (raw ?? '').trim().toUpperCase();
  if (!s) return null;
  const m = /^P?([1-5])$/.exec(s);
  return m ? Number(m[1]) : 'bad';
}

export interface NormalizeOptions {
  defaultDeliveryDate?: string | null;
  dateOrder?: DateOrder;
  extraAliases?: Partial<Record<CanonicalField, string[]>>;
}

export function normalizeOrderRows(rows: Record<string, string>[], opts: NormalizeOptions = {}): NormalizeResult {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const mapping = mapHeaders(headers, opts.extraAliases);
  const errors: RowError[] = [];
  const warnings: string[] = [];
  const lines: NormalizedLine[] = [];
  const zeroWeightRows: number[] = [];
  let fileCases = 0;

  if (rows.length === 0) {
    return { mapping, lines, errors: [{ row: 1, message: 'The file has no data rows.' }], warnings, fileCases };
  }
  const missing: string[] = [];
  if (!mapping.used.customer_code) missing.push('customer code');
  if (!mapping.used.product_code) missing.push('product / item code');
  if (!mapping.used.cases) missing.push('cases / quantity');
  if (!mapping.used.delivery_date && !opts.defaultDeliveryDate) missing.push('delivery date (or choose one on the upload screen)');
  if (missing.length) {
    return {
      mapping,
      lines,
      errors: [{ row: 1, message: `Missing required column(s): ${missing.join(', ')}. Found columns: ${headers.join(', ')}.` }],
      warnings,
      fileCases,
    };
  }
  if (!mapping.used.delivery_date) warnings.push(`No delivery-date column: every row uses ${opts.defaultDeliveryDate}.`);
  if (!mapping.used.sales_order_no) warnings.push('No sales-order number column: duplicate uploads are detected by file only.');

  const get = (r: Record<string, string>, f: CanonicalField) => {
    const h = mapping.used[f];
    return h === undefined ? '' : (r[h] ?? '').toString().trim();
  };

  rows.forEach((r, i) => {
    const row = i + 2;
    const blank = Object.values(r).every((v) => (v ?? '').toString().trim() === '');
    if (blank) return;
    const casesRaw = get(r, 'cases');
    const casesNum = num(casesRaw);
    const casesForTotal = casesNum !== null && Number.isFinite(casesNum) ? casesNum : null;
    if (casesForTotal !== null) fileCases += casesForTotal;
    const err = (message: string) => errors.push({ row, message, cases: casesForTotal });

    const customerCode = get(r, 'customer_code');
    if (!customerCode) return err('Customer code is empty.');
    // The tidy code (spaces at the ends cut, runs of spaces inside one): " TN1.5L  (6) " is
    // "TN1.5L (6)" in the master, in every message and in the duplicate checks (lib/product-code.ts).
    const productCode = normalizeProductCode(get(r, 'product_code'));
    if (!productCode) return err('Product / item code is empty.');
    if (casesNum === null) return err('Cases is empty.');
    if (!Number.isFinite(casesNum) || !Number.isInteger(casesNum) || casesNum <= 0) {
      return err(`Cases must be a whole number above 0 (got "${casesRaw}").`);
    }
    const dRaw = get(r, 'delivery_date');
    const deliveryDate = dRaw ? parseDateCell(dRaw, opts.dateOrder) : opts.defaultDeliveryDate ?? null;
    if (!deliveryDate) return err(`Delivery date "${dRaw}" is not a date.`);
    const oRaw = get(r, 'order_date');
    const orderDate = oRaw ? parseDateCell(oRaw, opts.dateOrder) : null;
    if (oRaw && !orderDate) warnings.push(`Row ${row}: order date "${oRaw}" ignored (not a date).`);
    const pr = priorityOf(get(r, 'priority'));
    if (pr === 'bad') return err(`Priority must be 1-5 or P1-P5 (got "${get(r, 'priority')}"). P1 is the highest.`);
    const w = num(get(r, 'weight_kg'));
    const sv = num(get(r, 'sales_value'));
    const mg = num(get(r, 'margin'));
    if ([w, sv, mg].some((v) => v !== null && !Number.isFinite(v))) {
      return err('Weight / value / margin must be numbers.');
    }
    if (w !== null && w < 0) return err('Weight cannot be negative.');
    // 0 kg is "unknown" everywhere (product and line weights): a 0 in the file must not
    // override the product's case weight.
    if (w === 0) zeroWeightRows.push(row);
    const branchCode = get(r, 'branch_code') || null;
    lines.push({
      row,
      salesOrderNo: get(r, 'sales_order_no') || null,
      orderDate,
      deliveryDate,
      customerCode,
      branchCode,
      branchKey: normalizeBranchKey(branchCode),
      customerName: get(r, 'customer_name') || null,
      productCode,
      productDescription: get(r, 'product_description') || null,
      cases: casesNum,
      weightKg: w === 0 ? null : w,
      salesValue: sv,
      margin: mg,
      priority: pr,
      notes: get(r, 'notes') || null,
      depotCode: get(r, 'depot_code') || null,
      customerType: get(r, 'customer_type') || null,
    });
  });
  if (zeroWeightRows.length) {
    warnings.push(
      `${zeroWeightRows.length} row(s) have weight 0 (row${zeroWeightRows.length > 1 ? 's' : ''} ${zeroWeightRows.slice(0, 10).join(', ')}${zeroWeightRows.length > 10 ? ', ...' : ''}): treated as blank, so the product's case weight is used.`,
    );
  }
  return { mapping, lines, errors, warnings, fileCases };
}

// --------------------------------------------------------------------------------------
// Step 2: resolve against master data
// --------------------------------------------------------------------------------------

export interface KnownCustomer {
  id: string;
  code: string;
  branchKey: string;
  name: string;
  active: boolean;
  lat: number | null;
  lng: number | null;
}

export interface KnownProduct {
  id: string;
  code: string;
  name: string;
  active: boolean;
  weightPerCaseKg: number;
}

/**
 * One file row of a line added together from several rows (the same sales order, customer
 * branch, product and date), as it was in the file. Kept with the checked file (the batch's
 * validation), so every row's quantity, priority, note and money stays traceable (audit F02).
 */
export interface MergedRow {
  row: number;
  cases: number;
  priority: number | null;
  notes: string | null;
  salesValue: number | null;
  margin: number | null;
}

export interface ResolvedLine extends NormalizedLine {
  customerKey: string; // code::branchKey
  customerId: string | null; // null = will be created on confirm
  productId: string | null; // null = will be created on confirm
  sourceRows: number[];
  /**
   * Cases whose rows had no file weight (the product master weight is used for them at confirm).
   * `weightKg` then holds only the kg of the rows that had one. Absent in batches validated
   * before this field existed.
   */
  weightMissingCases?: number;
  /**
   * Only on a line added together from several rows: each row as it was in the file (audit F02).
   * A batch checked before this field existed has merged lines without it and must be uploaded
   * again (revalidateIntake): its priority, notes and money were merged the old way.
   */
  mergedRows?: MergedRow[];
}

/**
 * The stronger of two file priorities (P1 is the highest). A row without a priority never
 * weakens or removes another row's (audit F02: a P1 on a second row was lost).
 */
export function strongerPriority(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * Notes as their distinct parts, joined with " | " - the separator the plan screen, driver sheets
 * and WhatsApp split notes on. Blank notes are dropped; null when nothing is left (audit F02:
 * the notes of every row of a merged line are kept, each once).
 */
export function joinNotes(...notes: (string | null | undefined)[]): string | null {
  const parts = [...new Set(notes.flatMap((n) => (n ?? '').split(' | ')).map((n) => n.trim()).filter(Boolean))];
  return parts.length ? parts.join(' | ') : null;
}

/** A money value of a merged line: known only when every row had one (audit F04: blank = unknown, never 0). */
function sumKnown(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

const fmtPriority = (p: number | null) => (p === null ? 'none' : `P${p}`);

/**
 * The warning for a line added together from rows that differ in priority, note or money
 * (audit F02 / F04), naming each row; null when the rows differ only in cases. The plain
 * "quantities added together" warning is given per row as well.
 */
export function mergedLineWarning(l: ResolvedLine, names: { customer: string; product: string }): string | null {
  const rows = l.mergedRows;
  if (!rows || rows.length < 2) return null;
  const parts: string[] = [];
  if (new Set(rows.map((r) => r.priority)).size > 1) {
    parts.push(`Different priorities (${rows.map((r) => `row ${r.row} ${fmtPriority(r.priority)}`).join(', ')}): ${fmtPriority(l.priority)} is used, the highest.`);
  }
  const withNote = rows.filter((r) => r.notes && r.notes.trim());
  if (withNote.length && new Set(rows.map((r) => (r.notes ?? '').trim())).size > 1) {
    parts.push(`Notes kept: ${withNote.map((r) => `row ${r.row} "${(r.notes as string).trim()}"`).join('; ')}.`);
  }
  const blankMoney = (k: 'salesValue' | 'margin') => (rows.some((r) => r[k] !== null) ? rows.filter((r) => r[k] === null).map((r) => r.row) : []);
  const blankValue = blankMoney('salesValue');
  const blankMargin = blankMoney('margin');
  if (blankValue.length || blankMargin.length) {
    const what = [blankValue.length ? `sales value (blank on row ${blankValue.join(', ')})` : '', blankMargin.length ? `margin (blank on row ${blankMargin.join(', ')})` : '']
      .filter(Boolean)
      .join(' and ');
    parts.push(`The line's ${what} ${blankValue.length && blankMargin.length ? 'are' : 'is'} unknown: a blank is not counted as 0.`);
  }
  if (!parts.length) return null;
  const rowList = rows.map((r) => r.row);
  return `Rows ${rowList.slice(0, -1).join(', ')} and ${rowList[rowList.length - 1]} are one line (sales order ${l.salesOrderNo}, ${names.product} for ${names.customer}), ${l.cases} cases in all. ${parts.join(' ')}`;
}

export interface NewCustomer {
  code: string;
  branchCode: string | null;
  branchKey: string;
  name: string;
  customerType: string | null;
  rows: number[];
}

export interface NewProduct {
  code: string;
  name: string;
  rows: number[];
}

export interface IntakeIssueSummary {
  newCustomers: NewCustomer[];
  newProducts: NewProduct[];
  customersWithoutLocation: string[]; // existing customers lacking coordinates
  /** Products (existing without a case weight, or new) with rows that carry no file weight. */
  productsWithoutWeight: string[];
}

export interface ResolveResult {
  lines: ResolvedLine[];
  errors: RowError[];
  warnings: string[];
  duplicates: RowError[]; // rows skipped because already confirmed
  issues: IntakeIssueSummary;
  totals: { lines: number; cases: number; customers: number; salesOrders: number; deliveryDates: string[] };
}

/** Case-insensitive identity of a delivery location (customer code + branch): exports often
 * change case ("c001" vs "C001"); treating those as different customers would create duplicates. */
export function customerKey(code: string, branchKey: string) {
  return `${code.trim().toUpperCase()}::${branchKey.trim().toUpperCase()}`;
}

/** A sales-order number as it identifies a line: trimmed, upper-case; null when blank. */
export function normSalesOrder(so: string | null | undefined): string | null {
  const s = (so ?? '').trim().toUpperCase();
  return s === '' ? null : s;
}

/** Identity of a sales-order line for duplicate checks: `${date}|${SO}|${customerKey}|${PRODUCT}`. */
export function lineDupKey(deliveryDate: string, salesOrderNo: string, custKey: string, productCode: string): string {
  return `${deliveryDate}|${normSalesOrder(salesOrderNo) ?? ''}|${custKey}|${productKey(productCode)}`;
}

/**
 * Master-data rows whose codes differ only in letter case ("C001" and "c001") are the same
 * customer or product for intake. One of them is picked, always the same one: active first,
 * then (customers) the one with a location / (products) the one with a case weight, then the
 * code in plain character order, then the id.
 */
export function preferredCustomer<C extends { id: string; code: string; active: boolean; lat: number | null; lng: number | null }>(list: C[]): C | undefined {
  return [...list].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      Number(b.lat !== null && b.lng !== null) - Number(a.lat !== null && a.lng !== null) ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0];
}

export function preferredProduct<P extends { id: string; code: string; active: boolean; weightPerCaseKg: number }>(list: P[]): P | undefined {
  return [...list].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      Number(b.weightPerCaseKg > 0) - Number(a.weightPerCaseKg > 0) ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0];
}

function groupBy<T>(list: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of list) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

export interface ResolveOptions {
  /**
   * Sales orders already confirmed for OTHER delivery dates, keyed `${SO normalized}|${customerKey}`
   * -> those dates. The same sales order again on another date is a warning (a re-sent order?),
   * not an error.
   */
  confirmedOnOtherDates?: Map<string, string[]>;
}

/** A file line weight is "per line"; one far from cases x the master case weight is suspicious. */
function weightLooksWrong(lineKg: number, cases: number, masterKgPerCase: number): boolean {
  if (!(masterKgPerCase > 0) || !(cases > 0) || !(lineKg > 0)) return false;
  const perCase = lineKg / cases;
  return perCase < masterKgPerCase / 2 || perCase > masterKgPerCase * 2;
}

export function resolveOrderLines(
  norm: NormalizeResult,
  customers: KnownCustomer[],
  products: KnownProduct[],
  /**
   * Lines already confirmed, keyed by lineDupKey. A Map gives the confirmed case quantities: an
   * identical line is skipped as a duplicate, the same line with another quantity is an error
   * (changing a confirmed line is not supported). A Set only says the key exists (skipped).
   */
  alreadyConfirmed: Set<string> | Map<string, number[]>,
  opts: ResolveOptions = {},
): ResolveResult {
  // Case-variant twins resolve to one master row, always the same one.
  const custTwins = groupBy(customers, (c) => customerKey(c.code, c.branchKey));
  // Products are matched on productKey: whatever the letter case, and whatever the spacing of the
  // code (one saved before spaces were tidied still matches). Nothing else is folded: "TN1.5L(6)"
  // and "TN1.5L (6)" are two products.
  const prodTwins = groupBy(products, (p) => productKey(p.code));
  const custByKey = new Map([...custTwins].map(([k, list]) => [k, preferredCustomer(list)!]));
  const prodByCode = new Map([...prodTwins].map(([k, list]) => [k, preferredProduct(list)!]));
  const errors: RowError[] = [...norm.errors];
  const warnings: string[] = [...norm.warnings];
  const duplicates: RowError[] = [];
  const newCustomers = new Map<string, NewCustomer>();
  const newProducts = new Map<string, NewProduct>();
  const noLoc = new Set<string>();
  const noWeight = new Set<string>();
  const merged = new Map<string, ResolvedLine>();
  // Each line's first row as it was in the file: the start of `mergedRows` once a second row comes.
  const firstRowOf = new Map<string, MergedRow>();
  const twinWarned = new Set<string>();
  // Rows of an inactive customer or product, grouped like `merged`: a line of them that is already
  // confirmed (the customer was deactivated after its orders were added) is a duplicate, never an
  // "inactive" error (scenario test S05).
  const blocked = new Map<string, { rows: NormalizedLine[]; cases: number; kind: 'CUSTOMER' | 'PRODUCT'; customerCode: string; productCode: string }>();
  // Messages name the master codes ("S05-C05"), not the file's spelling ("s05-c05").
  const custName = (l: NormalizedLine, c: KnownCustomer | undefined) => `${c?.code ?? l.customerCode}${l.branchCode ? ` / ${l.branchCode}` : ''}`;

  for (const l of norm.lines) {
    const ck = customerKey(l.customerCode, l.branchKey);
    const cust = custByKey.get(ck);
    const pk = productKey(l.productCode);
    const prod = prodByCode.get(pk);
    // A code that is not in the master becomes a product on confirm, so it must be one the Products
    // page could hold (no comma, quote or control character, at most 40 long). A product already in
    // the master keeps matching whatever its code looks like.
    const badCode = prod ? null : productCodeProblem(l.productCode);
    if (badCode) {
      errors.push({ row: l.row, message: `Item code ${JSON.stringify(l.productCode)} cannot be used: ${badCode}. Correct it in the file.`, cases: l.cases });
      continue;
    }
    const inactive: 'CUSTOMER' | 'PRODUCT' | null = cust && !cust.active ? 'CUSTOMER' : prod && !prod.active ? 'PRODUCT' : null;
    if (inactive) {
      const bk = l.salesOrderNo ? lineDupKey(l.deliveryDate, l.salesOrderNo, ck, l.productCode) : `row:${l.row}`;
      const g = blocked.get(bk);
      if (g) {
        g.rows.push(l);
        g.cases += l.cases;
      } else {
        blocked.set(bk, { rows: [l], cases: l.cases, kind: inactive, customerCode: custName(l, cust), productCode: prod?.code ?? l.productCode });
      }
      continue;
    }
    const twins = custTwins.get(ck) ?? [];
    if (cust && twins.length > 1 && !twinWarned.has(`c:${ck}`)) {
      twinWarned.add(`c:${ck}`);
      warnings.push(
        `Customer codes ${twins.map((t) => t.code).join(' and ')}${l.branchCode ? ` / ${l.branchCode}` : ''} differ only in letter case and are treated as one customer: rows use ${cust.code}${cust.lat === null ? '' : ' (the one with a location)'}. Deactivate the other code in Customers.`,
      );
    }
    const ptwins = prodTwins.get(pk) ?? [];
    if (prod && ptwins.length > 1 && !twinWarned.has(`p:${pk}`)) {
      twinWarned.add(`p:${pk}`);
      warnings.push(`Product codes ${ptwins.map((t) => t.code).join(' and ')} differ only in letter case and are treated as one product: rows use ${prod.code}. Deactivate the other code in Products.`);
    }
    // Same sales order + customer branch + product + date twice in one file -> sum (warned).
    // Rows without a sales-order number are never merged (no evidence they are the same line).
    // Whatever the row order: the highest priority of the rows, every distinct note, and money
    // only when every row has it (audit F02 / F04); each row is kept in `mergedRows`.
    const mk = l.salesOrderNo ? lineDupKey(l.deliveryDate, l.salesOrderNo, ck, l.productCode) : `row:${l.row}`;
    const rowOf: MergedRow = { row: l.row, cases: l.cases, priority: l.priority, notes: l.notes, salesValue: l.salesValue, margin: l.margin };
    const existing = merged.get(mk);
    if (existing) {
      existing.cases += l.cases;
      if (l.weightKg !== null) existing.weightKg = (existing.weightKg ?? 0) + l.weightKg;
      else existing.weightMissingCases = (existing.weightMissingCases ?? 0) + l.cases;
      existing.salesValue = sumKnown(existing.salesValue, l.salesValue);
      existing.margin = sumKnown(existing.margin, l.margin);
      existing.priority = strongerPriority(existing.priority, l.priority);
      existing.notes = joinNotes(existing.notes, l.notes);
      existing.mergedRows = [...(existing.mergedRows ?? [firstRowOf.get(mk)!]), rowOf];
      existing.sourceRows.push(l.row);
      warnings.push(`Row ${l.row}: same sales order/product as row ${existing.sourceRows[0]} - quantities added together.`);
      continue;
    }
    firstRowOf.set(mk, rowOf);
    merged.set(mk, {
      ...l,
      customerKey: ck,
      customerId: cust?.id ?? null,
      productId: prod?.id ?? null,
      sourceRows: [l.row],
      weightMissingCases: l.weightKg === null ? l.cases : 0,
    });
  }

  // Lines already confirmed (another file, or a late order): an identical line is skipped; the
  // same line with another quantity would be an amendment, which is not supported yet.
  // undefined = not confirmed; null = confirmed (quantity unknown); else the confirmed quantities.
  const confirmedOf = (key: string): number[] | null | undefined =>
    alreadyConfirmed instanceof Map ? alreadyConfirmed.get(key) : alreadyConfirmed.has(key) ? null : undefined;
  const changedLineText = (so: string, product: string, customer: string, date: string, confirmed: number[], cases: number, rows: string) =>
    `Sales order ${so}, ${product} for ${customer} on ${date} was already confirmed with ${confirmed.join(' + ')} cases; this file has ${cases}${rows}. Changing a confirmed line is not supported yet: remove the row. For extra cases, record a late order with no sales-order number (or a new one), or send them under a new sales-order number.`;
  const lines: ResolvedLine[] = [];
  for (const [mk, l] of merged) {
    const confirmed = l.salesOrderNo ? confirmedOf(mk) : undefined;
    if (confirmed !== undefined) {
      const rows = l.sourceRows.length > 1 ? ` (rows ${l.sourceRows.join(', ')})` : '';
      const product = prodByCode.get(productKey(l.productCode))?.code ?? l.productCode;
      const customer = custByKey.get(l.customerKey)?.code ?? l.customerCode;
      if (confirmed === null || confirmed.includes(l.cases)) {
        duplicates.push({ row: l.row, message: `Already confirmed: sales order ${l.salesOrderNo}, ${product} for ${customer} on ${l.deliveryDate}${rows}. Skipped.`, cases: l.cases });
      } else {
        errors.push({ row: l.row, message: changedLineText(l.salesOrderNo as string, product, customer, l.deliveryDate, confirmed, l.cases, rows), cases: l.cases });
      }
      continue;
    }
    lines.push(l);
  }
  // Rows of an inactive customer or product: a line already confirmed with the same cases is a
  // duplicate (skipped, like any re-sent line), and the note says the customer or product is
  // inactive now; anything else is an error on each row, as before.
  for (const [bk, g] of blocked) {
    const first = g.rows[0];
    const confirmed = first.salesOrderNo ? confirmedOf(bk) : undefined;
    const rows = g.rows.length > 1 ? ` (rows ${g.rows.map((r) => r.row).join(', ')})` : '';
    if (confirmed !== undefined && (confirmed === null || confirmed.includes(g.cases))) {
      const now =
        g.kind === 'CUSTOMER'
          ? `Customer ${g.customerCode} is inactive now: its confirmed orders are not planned until it is reactivated.`
          : `Product ${g.productCode} is inactive now: its confirmed lines stay on the day.`;
      duplicates.push({
        row: first.row,
        message: `Already confirmed: sales order ${first.salesOrderNo}, ${g.productCode} for ${g.customerCode} on ${first.deliveryDate}${rows}. Skipped. ${now}`,
        cases: g.cases,
      });
      continue;
    }
    const inactive = g.kind === 'CUSTOMER' ? `Customer ${g.customerCode} is inactive. Reactivate it or remove the row.` : `Product ${g.productCode} is inactive.`;
    for (const l of g.rows) {
      const changed = confirmed ? ` ${changedLineText(first.salesOrderNo as string, g.productCode, g.customerCode, first.deliveryDate, confirmed, g.cases, rows)}` : '';
      errors.push({ row: l.row, message: `${inactive}${changed}`, cases: l.cases });
    }
  }
  duplicates.sort((a, b) => a.row - b.row);

  const otherDateWarned = new Set<string>();
  for (const l of lines) {
    const cust = custByKey.get(l.customerKey);
    const prod = prodByCode.get(productKey(l.productCode));
    const mergedWarning = mergedLineWarning(l, { customer: custName(l, cust), product: prod?.code ?? l.productCode });
    if (mergedWarning) warnings.push(mergedWarning);
    if (!cust) {
      const nc = newCustomers.get(l.customerKey);
      if (nc) nc.rows.push(...l.sourceRows);
      else newCustomers.set(l.customerKey, { code: l.customerCode, branchCode: l.branchCode, branchKey: l.branchKey, name: l.customerName || l.customerCode, customerType: l.customerType, rows: [...l.sourceRows] });
    } else if (cust.lat === null || cust.lng === null) {
      noLoc.add(`${cust.code}${l.branchCode ? ` / ${l.branchCode}` : ''} ${cust.name}`);
    }
    const missingWeight = (l.weightMissingCases ?? 0) > 0;
    if (!prod) {
      const code = productKey(l.productCode);
      const np = newProducts.get(code);
      if (np) np.rows.push(...l.sourceRows);
      else newProducts.set(code, { code: l.productCode, name: l.productDescription || l.productCode, rows: [...l.sourceRows] });
      // Named once by the code the product will get (rows spelled in another case or spacing are one product).
      if (missingWeight) noWeight.add(newProducts.get(code)!.code);
    } else if (!(prod.weightPerCaseKg > 0) && missingWeight) {
      noWeight.add(prod.code);
    } else if (prod && l.weightKg !== null && !missingWeight && weightLooksWrong(l.weightKg, l.cases, prod.weightPerCaseKg)) {
      warnings.push(
        `Row ${l.row}: weight ${l.weightKg} kg for ${l.cases} cases of ${prod.code} is ${Math.round((l.weightKg / l.cases) * 10) / 10} kg per case, but the product's case weight is ${prod.weightPerCaseKg} kg. The weight column must be the kg of the whole line - check the file.`,
      );
    }
    const so = normSalesOrder(l.salesOrderNo);
    if (so && opts.confirmedOnOtherDates) {
      const k = `${so}|${l.customerKey}`;
      const dates = (opts.confirmedOnOtherDates.get(k) ?? []).filter((d) => d !== l.deliveryDate);
      if (dates.length && !otherDateWarned.has(`${k}|${l.deliveryDate}`)) {
        otherDateWarned.add(`${k}|${l.deliveryDate}`);
        warnings.push(
          `Sales order ${l.salesOrderNo} for ${l.customerCode} was already confirmed for ${[...new Set(dates)].sort().join(', ')}; this file has it again for ${l.deliveryDate}. Check that it is not the same order sent twice.`,
        );
      }
    }
  }

  const dates = [...new Set(lines.map((l) => l.deliveryDate))].sort();
  if (dates.length > 1) warnings.push(`The file contains ${dates.length} delivery dates (${dates.join(', ')}). Each date is planned separately.`);
  return {
    lines,
    errors: errors.sort((a, b) => a.row - b.row),
    warnings,
    duplicates,
    issues: {
      newCustomers: [...newCustomers.values()],
      newProducts: [...newProducts.values()],
      customersWithoutLocation: [...noLoc],
      productsWithoutWeight: [...noWeight],
    },
    totals: {
      lines: lines.length,
      cases: lines.reduce((a, l) => a + l.cases, 0),
      customers: new Set(lines.map((l) => l.customerKey)).size,
      salesOrders: new Set(lines.map((l) => l.salesOrderNo).filter(Boolean)).size,
      deliveryDates: dates,
    },
  };
}

/**
 * Order-insensitive fingerprint of a file's content: every normalized line (delivery date
 * included) as text, sorted. The same data in another row or column order - or re-exported -
 * gives the same text, and the same rows for another delivery date give a different one.
 */
export function contentFingerprint(lines: NormalizedLine[]): string {
  return lines
    .map((l) =>
      [
        l.deliveryDate,
        normSalesOrder(l.salesOrderNo) ?? '',
        customerKey(l.customerCode, l.branchKey),
        productKey(l.productCode),
        l.cases,
        l.weightKg ?? '',
        l.salesValue ?? '',
        l.margin ?? '',
        l.priority ?? '',
        (l.depotCode ?? '').toUpperCase(),
      ].join('|'),
    )
    .sort()
    .join('\n');
}

/** Map a free-text channel to a CustomerType enum value (null if unknown). */
export function customerTypeFromText(raw: string | null | undefined): string | null {
  // Strip accents ("Café" -> "CAFE"); most specific words first ("Wholesale Trading" = WHOLESALE).
  const s = (raw ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  if (!s) return null;
  const table: [RegExp, string][] = [
    [/HYPER/, 'HYPERMARKET'],
    [/SUPER/, 'SUPERMARKET'],
    [/WHOLE/, 'WHOLESALE'],
    [/CATER/, 'CATERING'],
    [/HORECA|HOTEL|RESTAURANT|CAFE/, 'HORECA'],
    [/TRAD/, 'TRADING'],
    [/GROC|BAQALA|MINI ?MART|CONVENIENCE/, 'GROCERY'],
  ];
  for (const [re, t] of table) if (re.test(s)) return t;
  return 'OTHER';
}
