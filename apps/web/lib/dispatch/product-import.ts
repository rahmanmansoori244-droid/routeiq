/**
 * Products import (owner decision 4 Oct 2026, truck capacity in pallets): the product master from
 * the ERP (CSV or Excel) - code, name, weight per case, cases per pallet, active - so the pilot's
 * 46+ SKUs get their pallet factor in one step instead of one form each. Pure: the route
 * (app/api/products/import/route.ts) reads the file, matches the existing products and writes.
 *
 * Rules:
 * - Header names are read without case, spaces or punctuation, with the ERP's usual names as aliases
 *   ("Cases per pallet", "Pallet factor", "Qty per pallet", "Weight per case (kg)", "Kg per case").
 * - code is required; a code matches an existing product whatever its letter case (as the order
 *   intake matches it). A new product takes the code as the ERP writes it, like the order intake does
 *   (NMWC's codes have spaces and brackets: "TN1.5L (6)", "SS5GB NRB", "EFF24 (0)"), so its order
 *   lines find it: any text of at most 64 characters without line breaks or tabs.
 * - A blank cell, or a column the file does not have, keeps what the product has (a re-import never
 *   erases a figure entered in RouteIQ). A new product without a name is named after its code.
 * - Cases per pallet: a whole number 1-10,000; weight per case: 0-10,000 kg; active: yes / no.
 *   Anything else is an error for the row, and a file with an error imports nothing.
 * - A row that changes nothing writes nothing.
 */
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

/** The longest code a new product may have (an ERP code; the order intake takes any non-blank code). */
export const IMPORT_CODE_MAX = 64;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

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
    const code = cells.code ?? '';
    // A fully blank row (Excel often has some) is skipped.
    if (!Object.values(cells).some((v) => v)) return;
    const problems: string[] = [];
    if (!code) problems.push('code is blank');
    const twin = code ? seen.get(code.toUpperCase()) : undefined;
    if (twin) problems.push(`code ${code} is also on row ${twin} (codes are the same whatever the letter case)`);
    else if (code) seen.set(code.toUpperCase(), row);
    const kg = numberCell(cells.weightPerCaseKg ?? '');
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

export type ProductChange =
  | { kind: 'CREATE'; row: number; code: string; data: { code: string; name: string; weightPerCaseKg: number; casesPerPallet: number | null; active: boolean } }
  | { kind: 'UPDATE'; row: number; id: string; code: string; before: Record<string, unknown>; data: Record<string, unknown> }
  | { kind: 'UNCHANGED'; row: number; id: string; code: string };

/**
 * What each row does to the master: create a product (its code as the ERP writes it), update the
 * fields it changes, or nothing. `existing` is matched by code whatever the letter case; a row with a
 * code that cannot be created (too long, a line break or tab) is an error.
 */
export function planProductImport(rows: ProductImportRow[], existing: KnownImportProduct[]): { changes: ProductChange[]; errors: ProductImportError[] } {
  const byCode = new Map<string, KnownImportProduct>();
  // Case-variant twins (older data): the active one, then the first by code, like the order intake.
  for (const p of [...existing].sort((a, b) => Number(b.active) - Number(a.active) || a.code.localeCompare(b.code))) {
    if (!byCode.has(p.code.toUpperCase())) byCode.set(p.code.toUpperCase(), p);
  }
  const changes: ProductChange[] = [];
  const errors: ProductImportError[] = [];
  for (const r of rows) {
    const m = byCode.get(r.code.toUpperCase());
    if (!m) {
      if (r.code.length > IMPORT_CODE_MAX || CONTROL.test(r.code)) {
        errors.push({ row: r.row, message: `code "${r.code.slice(0, IMPORT_CODE_MAX)}" cannot be created: at most ${IMPORT_CODE_MAX} characters, without line breaks or tabs.` });
        continue;
      }
      changes.push({
        kind: 'CREATE',
        row: r.row,
        code: r.code,
        data: { code: r.code, name: r.name ?? r.code, weightPerCaseKg: r.weightPerCaseKg ?? 0, casesPerPallet: r.casesPerPallet, active: r.active ?? true },
      });
      continue;
    }
    const data: Record<string, unknown> = {};
    if (r.name !== null && r.name !== m.name) data.name = r.name;
    if (r.weightPerCaseKg !== null && r.weightPerCaseKg !== m.weightPerCaseKg) data.weightPerCaseKg = r.weightPerCaseKg;
    if (r.casesPerPallet !== null && r.casesPerPallet !== m.casesPerPallet) data.casesPerPallet = r.casesPerPallet;
    if (r.active !== null && r.active !== m.active) data.active = r.active;
    if (!Object.keys(data).length) {
      changes.push({ kind: 'UNCHANGED', row: r.row, id: m.id, code: m.code });
      continue;
    }
    const before = Object.fromEntries(Object.keys(data).map((k) => [k, (m as unknown as Record<string, unknown>)[k] ?? null]));
    changes.push({ kind: 'UPDATE', row: r.row, id: m.id, code: m.code, before, data });
  }
  return { changes, errors };
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
