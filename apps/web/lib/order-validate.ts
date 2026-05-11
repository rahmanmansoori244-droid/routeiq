/**
 * Daily order upload validation pipeline (CLAUDE.md §6).
 *
 * Rules:
 *  1. Every (customer_code+branch_code) must exist in the tenant's Customer table.
 *     Blank/null branch_code normalizes to "__MAIN__".
 *  2. Every customer must have lat+lng OR be flagged with a warning (not blocking).
 *  3. Every product_code must exist in the tenant.
 *  4. cases must be a positive integer.
 *  5. delivery_date must be today..today+14 days, parseable as YYYY-MM-DD.
 *  6. Duplicate (customer_code, branch_code, product_code) within file → merge by
 *     sum and add a warning.
 */
import type { TenantDb } from './tenant';
import { normalizeBranchKey } from './schemas';

export interface RawOrderRow {
  row: number; // 1-based file row including header offset (row 2 = first data row)
  customer_code: string;
  branch_code: string | null;
  branchKey: string;
  delivery_date: string; // YYYY-MM-DD
  product_code: string;
  cases: number;
  priority: number | null;
  payment_collection_amount: number | null;
  notes: string | null;
}

export interface ValidationError {
  row: number;
  message: string;
}

export interface ValidationWarning {
  row?: number;
  message: string;
}

export interface ValidatedOrderRow {
  customerId: string;
  productId: string;
  branchKey: string;
  branchCode: string | null;
  customerCode: string;
  productCode: string;
  deliveryDate: string;
  cases: number;
  priority: number | null;
  paymentCollectionAmount: number | null;
  notes: string | null;
  sourceRows: number[]; // rows that contributed (merged duplicates)
  customerHasCoords: boolean;
}

export interface ValidationResult {
  totalRows: number;
  validRows: number;
  errorRows: number;
  warningRows: number;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  validated: ValidatedOrderRow[];
}

const REQUIRED_HEADERS = ['customer_code', 'branch_code', 'delivery_date', 'product_code', 'cases'] as const;

export function checkHeaders(rows: Record<string, string>[]): string[] {
  if (rows.length === 0) return ['File is empty.'];
  const first = rows[0];
  const missing = REQUIRED_HEADERS.filter((h) => h !== 'branch_code' && !(h in first));
  return missing.map((h) => `Missing required column: ${h}`);
}

export function parseRawRow(row: Record<string, string>, fileRow: number): RawOrderRow | ValidationError {
  const customer_code = (row['customer_code'] ?? '').trim();
  if (!customer_code) return { row: fileRow, message: 'customer_code is required.' };

  const branch_code = (row['branch_code'] ?? '').trim() || null;
  const branchKey = normalizeBranchKey(branch_code);

  const delivery_date = (row['delivery_date'] ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(delivery_date)) {
    return { row: fileRow, message: `delivery_date must be YYYY-MM-DD, got "${delivery_date}".` };
  }

  const product_code = (row['product_code'] ?? '').trim();
  if (!product_code) return { row: fileRow, message: 'product_code is required.' };

  const casesRaw = (row['cases'] ?? '').trim();
  const cases = Number(casesRaw);
  if (!Number.isInteger(cases) || cases <= 0) {
    return { row: fileRow, message: `cases must be a positive integer, got "${casesRaw}".` };
  }

  let priority: number | null = null;
  if (row['priority'] && row['priority'].trim() !== '') {
    const p = Number(row['priority']);
    if (!Number.isInteger(p) || p < 1 || p > 5) {
      return { row: fileRow, message: `priority must be 1-5 when present, got "${row['priority']}".` };
    }
    priority = p;
  }

  let payment_collection_amount: number | null = null;
  if (row['payment_collection_amount'] && row['payment_collection_amount'].trim() !== '') {
    const v = Number(row['payment_collection_amount']);
    if (!Number.isFinite(v) || v < 0) {
      return { row: fileRow, message: `payment_collection_amount must be ≥0, got "${row['payment_collection_amount']}".` };
    }
    payment_collection_amount = v;
  }

  return {
    row: fileRow,
    customer_code,
    branch_code,
    branchKey,
    delivery_date,
    product_code,
    cases,
    priority,
    payment_collection_amount,
    notes: row['notes']?.trim() || null,
  };
}

function todayIso(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function plusDaysIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function validateOrderRows(
  rows: Record<string, string>[],
  db: TenantDb,
): Promise<ValidationResult> {
  const headerErrors = checkHeaders(rows);
  if (headerErrors.length > 0) {
    return {
      totalRows: rows.length,
      validRows: 0,
      errorRows: rows.length,
      warningRows: 0,
      errors: headerErrors.map((m) => ({ row: 1, message: m })),
      warnings: [],
      validated: [],
    };
  }

  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Parse all rows; collect parsed rows + parse errors.
  const parsed: RawOrderRow[] = [];
  rows.forEach((raw, idx) => {
    const fileRow = idx + 2; // header is row 1
    const r = parseRawRow(raw, fileRow);
    if ('message' in r) errors.push(r);
    else parsed.push(r);
  });

  // Date window check
  const minDate = todayIso();
  const maxDate = plusDaysIso(14);
  parsed.forEach((r) => {
    if (r.delivery_date < minDate) {
      errors.push({ row: r.row, message: `delivery_date ${r.delivery_date} is in the past.` });
    } else if (r.delivery_date > maxDate) {
      errors.push({ row: r.row, message: `delivery_date ${r.delivery_date} is more than 14 days out.` });
    }
  });

  // Pull customers + products. Tenant-scoped via wrapper.
  const customers = await db.customer.findMany({
    select: { id: true, code: true, branchKey: true, lat: true, lng: true, active: true },
  });
  const products = await db.product.findMany({ select: { id: true, code: true, active: true } });

  const customerByKey = new Map(customers.map((c) => [`${c.code}::${c.branchKey}`, c]));
  const productByCode = new Map(products.map((p) => [p.code, p]));

  // Validate references + merge duplicates
  type Bucket = ValidatedOrderRow & { _customerCoordsOk: boolean };
  const buckets = new Map<string, Bucket>();

  for (const r of parsed) {
    const cust = customerByKey.get(`${r.customer_code}::${r.branchKey}`);
    if (!cust) {
      errors.push({
        row: r.row,
        message: `Unknown customer code+branch: ${r.customer_code}${
          r.branch_code ? ` / ${r.branch_code}` : ''
        }.`,
      });
      continue;
    }
    if (!cust.active) {
      errors.push({ row: r.row, message: `Customer ${r.customer_code} is inactive.` });
      continue;
    }
    const prod = productByCode.get(r.product_code);
    if (!prod) {
      errors.push({ row: r.row, message: `Unknown product code: ${r.product_code}.` });
      continue;
    }
    if (!prod.active) {
      errors.push({ row: r.row, message: `Product ${r.product_code} is inactive.` });
      continue;
    }
    const hasCoords = cust.lat !== null && cust.lng !== null;

    const key = `${cust.id}::${prod.id}::${r.delivery_date}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.cases += r.cases;
      existing.sourceRows.push(r.row);
      if (r.priority !== null) existing.priority = Math.min(existing.priority ?? 5, r.priority);
      if (r.payment_collection_amount !== null) {
        existing.paymentCollectionAmount = (existing.paymentCollectionAmount ?? 0) + r.payment_collection_amount;
      }
      warnings.push({
        row: r.row,
        message: `Merged with row ${existing.sourceRows[0]} (same customer + product + date).`,
      });
    } else {
      buckets.set(key, {
        customerId: cust.id,
        productId: prod.id,
        branchKey: r.branchKey,
        branchCode: r.branch_code,
        customerCode: r.customer_code,
        productCode: r.product_code,
        deliveryDate: r.delivery_date,
        cases: r.cases,
        priority: r.priority,
        paymentCollectionAmount: r.payment_collection_amount,
        notes: r.notes,
        sourceRows: [r.row],
        customerHasCoords: hasCoords,
        _customerCoordsOk: hasCoords,
      });
    }
  }

  // Coord warnings (per unique customer)
  const warnedCustomers = new Set<string>();
  for (const b of buckets.values()) {
    if (!b._customerCoordsOk && !warnedCustomers.has(b.customerCode)) {
      warnings.push({
        message: `Customer ${b.customerCode} has no coordinates — fix on the map before optimizing.`,
      });
      warnedCustomers.add(b.customerCode);
    }
  }

  const validated = Array.from(buckets.values()).map(({ _customerCoordsOk, ...rest }) => {
    void _customerCoordsOk;
    return rest;
  });

  // Sort errors and warnings by row for stable display.
  errors.sort((a, b) => a.row - b.row);
  warnings.sort((a, b) => (a.row ?? 0) - (b.row ?? 0));

  // Row counts: "valid rows" is what made it into a bucket (after merge).
  return {
    totalRows: rows.length,
    validRows: validated.length,
    errorRows: errors.length,
    warningRows: warnings.length,
    errors,
    warnings,
    validated,
  };
}
