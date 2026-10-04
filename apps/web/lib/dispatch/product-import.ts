/**
 * Products import (owner decision 4 Oct 2026, truck capacity in pallets): the product master from
 * the ERP (CSV or Excel) - code, name, weight per case, cases per pallet, active - so the pilot's
 * 46+ SKUs get their pallet factor in one step instead of one form each. Pure: the route
 * (app/api/products/import/route.ts) reads the file, matches the existing products and writes.
 *
 * Rules:
 * - Header names are read without case, spaces or punctuation, with the ERP's usual names as aliases
 *   ("Cases per pallet", "Pallet factor", "Qty per pallet", "Weight per case (kg)", "Kg per case").
 * - code is required. Product codes have one rule, lib/product-code.ts (the Products page, the order
 *   intake and the late order use it too): the code is read tidy (normalizeProductCode: spaces at both
 *   ends cut, each run of spaces inside one) and matched to the master on productKey, in the program -
 *   whatever the letter case and the spacing it was saved with, "_" a letter, never a database ILIKE.
 *   Master twins of a code resolve like the order intake's (preferredProduct: active, then with a case
 *   weight, then code, then id). A code no product has becomes a new product only when the Products
 *   page could hold it (productCodeProblem, the rule behind productCodeSchema: letters, digits, spaces
 *   and . ( ) - _ / + &, at most 40, not starting with + or -), so NMWC's ERP codes ("JA1.5L(6)",
 *   "TN1.5L (6)", "SS5GB NRB") are created as written and their order lines find them; a product
 *   already in the master is found whatever its code looks like.
 * - A blank cell, or a column the file does not have, keeps what the product has (a re-import never
 *   erases a figure entered in RouteIQ). A new product without a name is named after its code.
 * - Case weights (pallets review): a weight of 0 counts as a blank cell (0 means "no weight": it would turn
 *   a weighed product into one planned at 0 kg). A product that already has a case weight keeps it
 *   unless the person ticks "Update case weights" (`updateWeights`): a dispatcher's correction in
 *   RouteIQ is never overwritten by an ERP estimate by accident. A product without a weight takes the
 *   file's. The answer lists each weight it changes (code, before, after) and each it keeps.
 * - Cases per pallet: a whole number 1-10,000; weight per case: 0-10,000 kg; active: yes / no.
 *   Anything else is an error for the row, and a file with an error imports nothing.
 * - A row that changes nothing writes nothing.
 */
// Both pure (no imports): this module is also loaded by the import form, in the browser.
import { normalizeProductCode, productCodeProblem, productKey } from '../product-code';
import { PALLET_FACTOR_MAX, validPalletFactor } from './pallets';

export type ProductImportField = 'code' | 'name' | 'weightPerCaseKg' | 'casesPerPallet' | 'active';

/** Header aliases per field, as headerKey() reads them (lower case, letters and digits only). */
export const PRODUCT_IMPORT_ALIASES: Record<ProductImportField, string[]> = {
  code: ['code', 'productcode', 'sku', 'skucode', 'itemcode', 'item', 'materialcode', 'material'],
  name: ['name', 'productname', 'description', 'productdescription', 'itemname', 'itemdescription'],
  weightPerCaseKg: ['weightpercasekg', 'weightpercase', 'kgpercase', 'casekg', 'caseweightkg', 'caseweight', 'weightkg', 'weightpercasekgestimate'],
  casesPerPallet: ['casesperpallet', 'palletfactor', 'cspallet', 'cspallets', 'casespallet', 'qtyperpallet', 'quantityperpallet', 'cartonsperpallet', 'cpp'],
  active: ['active', 'status'],
};

/** "Cases per pallet" -> "casesperpallet", "weight_per_case_kg" -> "weightpercasekg". */
export function headerKey(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface ProductImportRow {
  /** The file's row number (header = 1). */
  row: number;
  code: string;
  /** null = blank or no such column: keep (a new product is named after its code). */
  name: string | null;
  weightPerCaseKg: number | null;
  casesPerPallet: number | null;
  active: boolean | null;
}

export interface ProductImportError {
  row: number;
  message: string;
}

export interface ReadProducts {
  rows: ProductImportRow[];
  errors: ProductImportError[];
  /** The fields the file has a column for. */
  columns: ProductImportField[];
  /** Columns not read (shown so a misspelt header is noticed). */
  unreadColumns: string[];
}

function yesNo(raw: string): boolean | null | 'BAD' {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (['yes', 'y', 'true', '1', 'active'].includes(v)) return true;
  if (['no', 'n', 'false', '0', 'inactive'].includes(v)) return false;
  return 'BAD';
}

/** A number cell: "1,234.5" and " 84 " read as numbers; blank = null; anything else NaN. */
function numberCell(raw: string): number | null {
  const v = raw.trim().replace(/,/g, '');
  if (!v) return null;
  return /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(v) ? Number(v) : Number.NaN;
}

/** Read the rows of a products file (the parser's rows: header names trimmed and lower case). */
export function readProductRows(raw: Record<string, string>[]): ReadProducts {
  // Every header any row has (a parsed sheet gives each row the same keys; a missing cell is blank).
  const headers = [...new Set(raw.flatMap((r) => Object.keys(r)))];
  const fieldOf = new Map<string, ProductImportField>();
  const columns = new Set<ProductImportField>();
  const unread: string[] = [];
  for (const h of headers) {
    const k = headerKey(h);
    const f = (Object.keys(PRODUCT_IMPORT_ALIASES) as ProductImportField[]).find((x) => PRODUCT_IMPORT_ALIASES[x].includes(k));
    if (f && !columns.has(f)) {
      fieldOf.set(h, f);
      columns.add(f);
    } else if (h.trim()) unread.push(h);
  }
  const errors: ProductImportError[] = [];
  const rows: ProductImportRow[] = [];
  if (!columns.has('code')) {
    errors.push({ row: 1, message: 'No code column: the file needs a "code" column (or SKU, item code).' });
    return { rows, errors, columns: [...columns], unreadColumns: unread };
  }
  const seen = new Map<string, number>();
  raw.forEach((r, i) => {
    const row = i + 2;
    const cells: Partial<Record<ProductImportField, string>> = {};
    for (const [h, f] of fieldOf) cells[f] = String(r[h] ?? '').trim();
    // The tidy code (lib/product-code.ts): " TN1.5L  (6) " is "TN1.5L (6)" in the master and in every message.
    const code = normalizeProductCode(cells.code ?? '');
    // A fully blank row (Excel often has some) is skipped.
    if (!Object.values(cells).some((v) => v)) return;
    const problems: string[] = [];
    if (!code) problems.push('code is blank');
    const twin = code ? seen.get(productKey(code)) : undefined;
    if (twin) problems.push(`code ${code} is also on row ${twin} (codes are the same whatever the letter case or extra spaces)`);
    else if (code) seen.set(productKey(code), row);
    // 0 kg = no weight: read like a blank cell (keep what the product has; a new product has none).
    const kgCell = numberCell(cells.weightPerCaseKg ?? '');
    const kg = kgCell === 0 ? null : kgCell;
    if (kg !== null && !(Number.isFinite(kg) && kg >= 0 && kg <= 10_000)) problems.push(`weight per case "${cells.weightPerCaseKg}" must be a number of kg, 0-10,000`);
    const cpp = numberCell(cells.casesPerPallet ?? '');
    if (cpp !== null && validPalletFactor(cpp) === null) {
      problems.push(`cases per pallet "${cells.casesPerPallet}" must be a whole number 1-${PALLET_FACTOR_MAX.toLocaleString('en-US')}`);
    }
    const active = yesNo(cells.active ?? '');
    if (active === 'BAD') problems.push(`active "${cells.active}" must be yes or no`);
    const name = cells.name ? cells.name.slice(0, 120) : null;
    if (problems.length) {
      errors.push({ row, message: `${problems.join('; ')}.` });
      return;
    }
    rows.push({ row, code, name, weightPerCaseKg: kg, casesPerPallet: cpp, active: active === 'BAD' ? null : active });
  });
  return { rows, errors, columns: [...columns], unreadColumns: unread };
}

/** An existing product, as the import compares it. */
export interface KnownImportProduct {
  id: string;
  code: string;
  name: string;
  weightPerCaseKg: number;
  casesPerPallet: number | null;
  active: boolean;
}

/** A case weight the import changes (an existing product), and one it keeps although the file has another. */
export interface ProductWeightChange {
  code: string;
  before: number;
  after: number;
}
export interface ProductWeightKept {
  code: string;
  /** The case weight the product keeps (entered or corrected in RouteIQ). */
  kg: number;
  /** The file's figure, not used (tick "Update case weights" to use it). */
  fileKg: number;
}

export type ProductChange =
  | { kind: 'CREATE'; row: number; code: string; data: { code: string; name: string; weightPerCaseKg: number; casesPerPallet: number | null; active: boolean } }
  | { kind: 'UPDATE'; row: number; id: string; code: string; before: Record<string, unknown>; data: Record<string, unknown> }
  | { kind: 'UNCHANGED'; row: number; id: string; code: string };

/**
 * The master row a group of twins (codes with the same productKey) resolves to: the order intake's
 * preferredProduct (order-intake.ts) - active, then with a case weight, then code, then id. Repeated
 * here, not imported: order-intake.ts reads lib/schemas.ts (Prisma's enums), and this module is also
 * loaded by the import form in the browser.
 */
function preferredTwin(list: KnownImportProduct[]): KnownImportProduct | undefined {
  return [...list].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      Number(b.weightPerCaseKg > 0) - Number(a.weightPerCaseKg > 0) ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0];
}

/**
 * What each row does to the master: create a product (its tidy code), update the fields it changes,
 * or nothing. `existing` is matched on productKey (lib/product-code.ts: whatever the letter case and
 * the spacing, in the program); a row whose code matches no product and that the product code rule
 * refuses (productCodeProblem: a comma, a quote, over 40 characters, a leading + or - ...) is an error.
 */
export function planProductImport(
  rows: ProductImportRow[],
  existing: KnownImportProduct[],
  opts: { updateWeights?: boolean } = {},
): { changes: ProductChange[]; errors: ProductImportError[]; weightChanges: ProductWeightChange[]; weightsKept: ProductWeightKept[] } {
  // The master grouped once by productKey (what twinsOf compares), each group to its preferred row.
  const twins = new Map<string, KnownImportProduct[]>();
  for (const p of existing) {
    const k = productKey(p.code);
    if (k) twins.set(k, [...(twins.get(k) ?? []), p]);
  }
  const byKey = new Map([...twins].map(([k, list]) => [k, preferredTwin(list)!]));
  const changes: ProductChange[] = [];
  const errors: ProductImportError[] = [];
  const weightChanges: ProductWeightChange[] = [];
  const weightsKept: ProductWeightKept[] = [];
  for (const r of rows) {
    const m = byKey.get(productKey(r.code));
    if (!m) {
      // A new product: its code must be one the Products page could hold (the same rule).
      const bad = productCodeProblem(normalizeProductCode(r.code));
      if (bad) {
        errors.push({ row: r.row, message: `code ${JSON.stringify(r.code)} cannot be a new product: ${bad}.` });
        continue;
      }
      const code = normalizeProductCode(r.code);
      changes.push({
        kind: 'CREATE',
        row: r.row,
        code,
        data: { code, name: r.name ?? code, weightPerCaseKg: r.weightPerCaseKg ?? 0, casesPerPallet: r.casesPerPallet, active: r.active ?? true },
      });
      continue;
    }
    const data: Record<string, unknown> = {};
    if (r.name !== null && r.name !== m.name) data.name = r.name;
    if (r.weightPerCaseKg !== null && r.weightPerCaseKg !== m.weightPerCaseKg) {
      // A weight already in RouteIQ is replaced only when asked; a product without one takes the file's.
      if (m.weightPerCaseKg > 0 && !opts.updateWeights) {
        weightsKept.push({ code: m.code, kg: m.weightPerCaseKg, fileKg: r.weightPerCaseKg });
      } else {
        data.weightPerCaseKg = r.weightPerCaseKg;
        weightChanges.push({ code: m.code, before: m.weightPerCaseKg, after: r.weightPerCaseKg });
      }
    }
    if (r.casesPerPallet !== null && r.casesPerPallet !== m.casesPerPallet) data.casesPerPallet = r.casesPerPallet;
    if (r.active !== null && r.active !== m.active) data.active = r.active;
    if (!Object.keys(data).length) {
      changes.push({ kind: 'UNCHANGED', row: r.row, id: m.id, code: m.code });
      continue;
    }
    const before = Object.fromEntries(Object.keys(data).map((k) => [k, (m as unknown as Record<string, unknown>)[k] ?? null]));
    changes.push({ kind: 'UPDATE', row: r.row, id: m.id, code: m.code, before, data });
  }
  return { changes, errors, weightChanges, weightsKept };
}

/** The answer of POST /api/products/import (the import form shows it). */
export interface ProductImportResult {
  fileName: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  warningRows: number;
  creates: number;
  updates: number;
  unchanged: number;
  factorsSet: number;
  productsWithoutFactor: string[];
  /** Case weights of existing products the import changes (before -> after). */
  weightChanges: ProductWeightChange[];
  /** Case weights kept although the file has another ("Update case weights" not ticked). */
  weightsKept: ProductWeightKept[];
  errors: ProductImportError[];
  warnings: string[];
  dryRun: boolean;
  imported: number;
}

/** "products.xlsx - validation only: 3 new, 40 changed (cases per pallet set on 43, case weight changed on 2), 2 unchanged". */
export function productImportHeadline(r: ProductImportResult): string {
  const weights = r.weightChanges?.length ? `, case weight changed on ${r.weightChanges.length}` : '';
  const counts = `${r.creates} new, ${r.updates} changed (cases per pallet set on ${r.factorsSet}${weights}), ${r.unchanged} unchanged`;
  if (r.errorRows) return `${r.fileName} - ${r.errorRows} error(s): nothing imported`;
  return r.dryRun ? `${r.fileName} - validation only: ${counts}` : `${r.fileName} - imported: ${counts}`;
}

/** "TN1.5L 12 -> 12.5 kg, SS0.5L 0 -> 11.3 kg" (at most `max` named, then "and N more"). */
export function describeWeightChanges(list: readonly ProductWeightChange[], max = 10): string {
  const shown = list.slice(0, max).map((w) => `${w.code} ${w.before} -> ${w.after} kg`);
  return list.length > max ? `${shown.join(', ')} and ${list.length - max} more` : shown.join(', ');
}

/** "TN1.5L 12 kg (file 12.5 kg)" (at most `max` named, then "and N more"). */
export function describeWeightsKept(list: readonly ProductWeightKept[], max = 10): string {
  const shown = list.slice(0, max).map((w) => `${w.code} ${w.kg} kg (file ${w.fileKg} kg)`);
  return list.length > max ? `${shown.join(', ')} and ${list.length - max} more` : shown.join(', ');
}

/**
 * Products of the master still without a usable cases per pallet after the import (active ones):
 * trucks with bays cannot plan a day that has them on its orders.
 */
export function productsStillWithoutFactor(existing: KnownImportProduct[], changes: ProductChange[]): string[] {
  const after = new Map(existing.map((p) => [p.id, { code: p.code, cpp: p.casesPerPallet, active: p.active }]));
  const created: { code: string; cpp: number | null; active: boolean }[] = [];
  for (const c of changes) {
    if (c.kind === 'CREATE') created.push({ code: c.code, cpp: c.data.casesPerPallet, active: c.data.active });
    if (c.kind === 'UPDATE') {
      const p = after.get(c.id)!;
      if ('casesPerPallet' in c.data) p.cpp = c.data.casesPerPallet as number;
      if ('active' in c.data) p.active = c.data.active as boolean;
    }
  }
  return [...after.values(), ...created]
    .filter((p) => p.active && validPalletFactor(p.cpp) === null)
    .map((p) => p.code)
    .sort();
}
