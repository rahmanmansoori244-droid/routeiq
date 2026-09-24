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

export type CanonicalField =
  | 'sales_order_no'
  | 'order_date'
  | 'delivery_date'
  | 'customer_code'
  | 'branch_code'
  | 'customer_name'
  | 'product_code'
  | 'product_description'
  | 'cases'
  | 'weight_kg'
  | 'sales_value'
  | 'margin'
  | 'priority'
  | 'notes'
  | 'depot_code'
  | 'customer_type';

/** Built-in aliases (normalized: lowercase, letters+digits only). Tenants can add more. */
export const HEADER_ALIASES: Record<CanonicalField, string[]> = {
  sales_order_no: ['salesorderno', 'salesorder', 'salesordernumber', 'sono', 'sonumber', 'orderno', 'ordernumber', 'orderid', 'docno', 'documentno', 'documentnumber', 'so'],
  order_date: ['orderdate', 'sodate', 'documentdate', 'docdate', 'salesorderdate'],
  delivery_date: ['deliverydate', 'requesteddeliverydate', 'reqdeliverydate', 'requesteddate', 'reqdate', 'deliverydt', 'shipdate', 'dispatchdate', 'deliveryon', 'date'],
  customer_code: ['customercode', 'custcode', 'customerno', 'customernumber', 'customerid', 'customer', 'accountcode', 'account', 'cust', 'soldto', 'soldtocode'],
  branch_code: ['branchcode', 'branch', 'branchno', 'shiptocode', 'shipto', 'shiptono', 'outletcode', 'outlet', 'site', 'sitecode', 'locationcode'],
  customer_name: ['customername', 'custname', 'name', 'outletname', 'shiptoname', 'accountname', 'branchname'],
  product_code: ['productcode', 'itemcode', 'sku', 'skucode', 'item', 'itemno', 'materialcode', 'material', 'productid', 'product'],
  product_description: ['productdescription', 'description', 'itemdescription', 'productname', 'itemname', 'skuname', 'materialdescription'],
  cases: ['cases', 'orderedcases', 'qtycases', 'casesordered', 'quantity', 'qty', 'orderqty', 'orderedqty', 'cartons', 'ctn', 'ctns', 'cs'],
  weight_kg: ['weightkg', 'weight', 'totalweight', 'grossweight', 'kg', 'netweight', 'linweight'],
  sales_value: ['salesvalue', 'value', 'amount', 'netvalue', 'netamount', 'salesamount', 'revenue', 'linevalue', 'totalvalue'],
  margin: ['contributionmargin', 'margin', 'cm', 'grossmargin', 'marginvalue', 'gm'],
  priority: ['priority', 'prio', 'deliverypriority'],
  notes: ['notes', 'note', 'remarks', 'remark', 'comment', 'comments', 'instructions'],
  depot_code: ['depotcode', 'depot', 'warehouse', 'warehousecode', 'plant', 'plantcode'],
  customer_type: ['customertype', 'channel', 'custtype', 'outlettype', 'segment'],
};

export function normHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface ColumnMapping {
  /** canonical field -> original header used */
  used: Partial<Record<CanonicalField, string>>;
  unmapped: string[];
}

export function mapHeaders(headers: string[], extra: Partial<Record<CanonicalField, string[]>> = {}): ColumnMapping {
  const used: Partial<Record<CanonicalField, string>> = {};
  const byNorm = new Map(headers.map((h) => [normHeader(h), h]));
  const taken = new Set<string>();
  // Tenant aliases first, then exact canonical name, then built-ins in declaration order.
  for (const field of Object.keys(HEADER_ALIASES) as CanonicalField[]) {
    const candidates = [...(extra[field] ?? []).map(normHeader), normHeader(field), ...HEADER_ALIASES[field]];
    for (const c of candidates) {
      const h = byNorm.get(c);
      if (h && !taken.has(h)) {
        used[field] = h;
        taken.add(h);
        break;
      }
    }
  }
  return { used, unmapped: headers.filter((h) => !taken.has(h)) };
}

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
  weightKg: number | null; // line weight from the file, if given
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
    const productCode = get(r, 'product_code');
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
      weightKg: w,
      salesValue: sv,
      margin: mg,
      priority: pr,
      notes: get(r, 'notes') || null,
      depotCode: get(r, 'depot_code') || null,
      customerType: get(r, 'customer_type') || null,
    });
  });
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

export interface ResolvedLine extends NormalizedLine {
  customerKey: string; // code::branchKey
  customerId: string | null; // null = will be created on confirm
  productId: string | null; // null = will be created on confirm
  sourceRows: number[];
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

export function resolveOrderLines(
  norm: NormalizeResult,
  customers: KnownCustomer[],
  products: KnownProduct[],
  alreadyConfirmed: Set<string>, // keys `${deliveryDate}|${salesOrderNo}|${customerKey}|${productCode}`
): ResolveResult {
  const custByKey = new Map(customers.map((c) => [customerKey(c.code, c.branchKey), c]));
  const prodByCode = new Map(products.map((p) => [p.code.toUpperCase(), p]));
  const errors: RowError[] = [...norm.errors];
  const warnings: string[] = [...norm.warnings];
  const duplicates: RowError[] = [];
  const newCustomers = new Map<string, NewCustomer>();
  const newProducts = new Map<string, NewProduct>();
  const noLoc = new Set<string>();
  const noWeight = new Set<string>();
  const merged = new Map<string, ResolvedLine>();

  for (const l of norm.lines) {
    const ck = customerKey(l.customerCode, l.branchKey);
    const cust = custByKey.get(ck);
    if (cust && !cust.active) {
      errors.push({ row: l.row, message: `Customer ${l.customerCode}${l.branchCode ? ` / ${l.branchCode}` : ''} is inactive. Reactivate it or remove the row.`, cases: l.cases });
      continue;
    }
    const prod = prodByCode.get(l.productCode.toUpperCase());
    if (prod && !prod.active) {
      errors.push({ row: l.row, message: `Product ${l.productCode} is inactive.`, cases: l.cases });
      continue;
    }
    const dupKey = `${l.deliveryDate}|${l.salesOrderNo ?? ''}|${ck}|${l.productCode.toUpperCase()}`;
    if (l.salesOrderNo && alreadyConfirmed.has(dupKey)) {
      duplicates.push({ row: l.row, message: `Already uploaded: sales order ${l.salesOrderNo}, ${l.productCode} for ${l.customerCode} on ${l.deliveryDate}. Skipped.`, cases: l.cases });
      continue;
    }
    if (!cust) {
      const nc = newCustomers.get(ck);
      if (nc) nc.rows.push(l.row);
      else newCustomers.set(ck, { code: l.customerCode, branchCode: l.branchCode, branchKey: l.branchKey, name: l.customerName || l.customerCode, customerType: l.customerType, rows: [l.row] });
    } else if (cust.lat === null || cust.lng === null) {
      noLoc.add(`${cust.code}${l.branchCode ? ` / ${l.branchCode}` : ''} ${cust.name}`);
    }
    if (!prod) {
      const code = l.productCode.toUpperCase();
      const np = newProducts.get(code);
      if (np) np.rows.push(l.row);
      else newProducts.set(code, { code: l.productCode, name: l.productDescription || l.productCode, rows: [l.row] });
    } else if (!(prod.weightPerCaseKg > 0) && l.weightKg === null) {
      noWeight.add(prod.code);
    }
    // Same sales order + customer branch + product + date twice in one file -> sum (warned).
    // Rows without a sales-order number are never merged (no evidence they are the same line).
    const mk = l.salesOrderNo ? `${l.deliveryDate}|${l.salesOrderNo}|${ck}|${l.productCode.toUpperCase()}` : `row:${l.row}`;
    const existing = merged.get(mk);
    if (existing) {
      existing.cases += l.cases;
      if (l.weightKg !== null) existing.weightKg = (existing.weightKg ?? 0) + l.weightKg;
      if (l.salesValue !== null) existing.salesValue = (existing.salesValue ?? 0) + l.salesValue;
      if (l.margin !== null) existing.margin = (existing.margin ?? 0) + l.margin;
      existing.sourceRows.push(l.row);
      warnings.push(`Row ${l.row}: same sales order/product as row ${existing.sourceRows[0]} - quantities added together.`);
      continue;
    }
    merged.set(mk, {
      ...l,
      customerKey: ck,
      customerId: cust?.id ?? null,
      productId: prod?.id ?? null,
      sourceRows: [l.row],
    });
  }

  const lines = [...merged.values()];
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
