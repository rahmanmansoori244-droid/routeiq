/**
 * Audit of 27 Sep 2026, F02 / F04 (and F03 at confirm): rows of one file with the same sales
 * order, customer branch, product and date are one line. Whatever their order in the file:
 *  - the line gets the highest priority of its rows (P1 wins; a row without a priority never
 *    removes another row's - the verifiers found a P1 on a second row lost completely);
 *  - every distinct note is kept (on the line and on the order), each row's values are kept with
 *    the checked file (`mergedRows`), and a warning names the rows;
 *  - money is known only when every row has it (a blank is unknown, never 0).
 * A file checked before this release with such a line cannot be confirmed (upload again), and a
 * file whose depot was deactivated or deleted after the check is refused (MASTER_CHANGED).
 */
import { describe, expect, it } from 'vitest';
import {
  contentFingerprint,
  joinNotes,
  normalizeOrderRows,
  resolveOrderLines,
  strongerPriority,
  type KnownCustomer,
  type KnownProduct,
  type ResolvedLine,
} from '@/lib/dispatch/order-intake';
import {
  batchDepotProblem,
  confirmIntake,
  IntakeConflict,
  MERGED_THE_OLD_WAY,
  mergedTheOldWay,
  revalidateIntake,
  type IntakeValidation,
} from '@/lib/dispatch/intake-server';

const CUST: KnownCustomer = { id: 'cust1', code: 'C9', branchKey: '__MAIN__', name: 'Cust', active: true, lat: 23.6, lng: 58.4 };
const PROD: KnownProduct = { id: 'prod1', code: 'JA1.5L', name: 'Water', active: true, weightPerCaseKg: 17 };

type Cells = Partial<Record<'so' | 'cases' | 'prio' | 'notes' | 'value' | 'margin' | 'item', string>>;
const row = (c: Cells): Record<string, string> => ({
  'SO Number': c.so ?? '777',
  'Delivery Date': '2026-10-01',
  'Customer Code': 'C9',
  'Product Code': c.item ?? 'JA1.5L',
  Cases: c.cases ?? '10',
  Priority: c.prio ?? '',
  Notes: c.notes ?? '',
  'Sales Value': c.value ?? '',
  Margin: c.margin ?? '',
});
const resolve = (rows: Cells[]) => {
  const norm = normalizeOrderRows(rows.map(row));
  return { norm, res: resolveOrderLines(norm, [CUST], [PROD, { ...PROD, id: 'prod2', code: 'SS0.5L' }], new Map()) };
};
const one = (rows: Cells[]) => {
  const { res } = resolve(rows);
  expect(res.lines).toHaveLength(1);
  return { line: res.lines[0]!, warnings: res.warnings };
};

const P5_ROUTINE: Cells = { cases: '10', prio: 'P5', notes: 'routine' };
const P1_URGENT: Cells = { cases: '5', prio: 'P1', notes: 'URGENT call receiving' };

describe('F02: merged rows keep the highest priority and every note, in any row order', () => {
  it('P5 first or P1 first: the line is P1 with both notes, 15 cases', () => {
    const fwd = one([P5_ROUTINE, P1_URGENT]).line;
    const rev = one([P1_URGENT, P5_ROUTINE]).line;
    for (const l of [fwd, rev]) {
      expect(l.cases).toBe(15);
      expect(l.priority).toBe(1);
      expect((l.notes ?? '').split(' | ').sort()).toEqual(['URGENT call receiving', 'routine']);
    }
    // The fingerprint that detects a re-sent file was already order-insensitive; the meaning now is too.
    expect(contentFingerprint(resolve([P5_ROUTINE, P1_URGENT]).norm.lines)).toBe(contentFingerprint(resolve([P1_URGENT, P5_ROUTINE]).norm.lines));
  });

  it('the first row has no priority: the P1 of the second row is kept (it was lost completely)', () => {
    expect(one([{ cases: '10' }, { cases: '5', prio: 'P1' }]).line.priority).toBe(1);
    expect(one([{ cases: '10', prio: 'P1' }, { cases: '5' }]).line.priority).toBe(1);
    expect(one([{ cases: '10' }, { cases: '5' }]).line.priority).toBeNull();
  });

  it('a note on a later row only is kept; the same note twice is kept once', () => {
    expect(one([{ cases: '10' }, { cases: '5', notes: 'Gate 3 only' }]).line.notes).toBe('Gate 3 only');
    expect(one([{ notes: 'Gate 3 only' }, { notes: ' Gate 3 only ' }, { notes: 'Call first' }]).line.notes).toBe('Gate 3 only | Call first');
  });

  it("keeps each row's values with the checked file (provenance) and warns naming the rows", () => {
    const { line, warnings } = one([P5_ROUTINE, P1_URGENT]);
    expect(line.sourceRows).toEqual([2, 3]);
    expect(line.mergedRows).toEqual([
      { row: 2, cases: 10, priority: 5, notes: 'routine', salesValue: null, margin: null },
      { row: 3, cases: 5, priority: 1, notes: 'URGENT call receiving', salesValue: null, margin: null },
    ]);
    expect(warnings).toContain('Row 3: same sales order/product as row 2 - quantities added together.');
    expect(warnings).toContain(
      'Rows 2 and 3 are one line (sales order 777, JA1.5L for C9), 15 cases in all. Different priorities (row 2 P5, row 3 P1): P1 is used, the highest. Notes kept: row 2 "routine"; row 3 "URGENT call receiving".',
    );
  });

  it('no extra warning when the rows differ only in cases (and no mergedRows on a line from one row)', () => {
    const { res } = resolve([{ prio: 'P2', notes: 'x' }, { prio: 'P2', notes: 'x', cases: '3' }, { so: '778' }]);
    expect(res.warnings.filter((w) => w.startsWith('Rows '))).toEqual([]);
    expect(res.lines.find((l) => l.salesOrderNo === '778')!.mergedRows).toBeUndefined();
  });

  it('strongerPriority and joinNotes', () => {
    expect([strongerPriority(null, 1), strongerPriority(5, null), strongerPriority(5, 1), strongerPriority(null, null)]).toEqual([1, 5, 1, null]);
    expect(joinNotes('a | b', 'b', null, '  ', 'c')).toBe('a | b | c');
    expect(joinNotes(null, '')).toBeNull();
  });
});

describe('F04: merged money is known only when every row has it', () => {
  it('known + blank is unknown in both row orders (was 100 / 20: a subtotal shown as complete)', () => {
    for (const rows of [
      [{ cases: '10', value: '100', margin: '20' }, { cases: '5' }],
      [{ cases: '5' }, { cases: '10', value: '100', margin: '20' }],
    ]) {
      const { line, warnings } = one(rows);
      expect(line.salesValue).toBeNull();
      expect(line.margin).toBeNull();
      expect(warnings.some((w) => w.includes('sales value (blank on row') && w.includes('are unknown: a blank is not counted as 0'))).toBe(true);
    }
  });

  it('every row known: the sum; every row blank: unknown, no money warning', () => {
    expect(one([{ value: '100', margin: '20' }, { value: '50', margin: '5' }]).line).toMatchObject({ salesValue: 150, margin: 25 });
    const blank = one([{}, {}]);
    expect(blank.line).toMatchObject({ salesValue: null, margin: null });
    expect(blank.warnings.filter((w) => w.startsWith('Rows '))).toEqual([]);
  });

  it('a third row cannot turn unknown back into a number', () => {
    expect(one([{ value: '100' }, {}, { value: '7' }]).line.salesValue).toBeNull();
  });
});

describe('confirm: the order carries the merged line (in-memory transaction)', () => {
  async function confirmRows(rows: Cells[], customerPriority = 3) {
    const { res } = resolve(rows);
    const orders: Record<string, any>[] = [];
    const lines: Record<string, any>[] = [];
    const tx: any = {
      customer: { findMany: async () => [{ id: 'cust1', priority: customerPriority, avgServiceTimeMin: 10 }] },
      product: { findMany: async () => [{ id: 'prod1', weightPerCaseKg: 17, volumePerCaseL: 5 }, { id: 'prod2', weightPerCaseKg: 17, volumePerCaseL: 5 }] },
      order: { create: async ({ data }: any) => { const o = { id: `o${orders.length + 1}`, ...data }; orders.push(o); return o; } },
      orderLine: {
        createMany: async ({ data }: any) => { lines.push(...data.map((d: any, i: number) => ({ id: `l${lines.length + i}`, ...d }))); },
        findMany: async ({ where }: any) => lines.filter((l) => l.orderId === where.orderId),
      },
      intakeLineKey: { createMany: async () => ({}) },
    };
    await confirmIntake(tx, 'T', { id: 'B1', depotId: 'D1' }, res as unknown as IntakeValidation, { id: 'U1' }, { isLate: false, reason: null });
    return { orders, lines };
  }

  it('P5-first file for a P3 customer reaches planning as P1 with both notes (was P3, the urgent note lost)', async () => {
    for (const rows of [[P5_ROUTINE, P1_URGENT], [P1_URGENT, P5_ROUTINE]]) {
      const { orders, lines } = await confirmRows(rows);
      expect(orders[0]).toMatchObject({ priority: 1, priorityFromFile: true, totalCases: 15 });
      expect((orders[0]!.notes as string).split(' | ').sort()).toEqual(['URGENT call receiving', 'routine']);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.notes).toBe(orders[0]!.notes);
    }
  });

  it('order notes list each note once across lines (a merged line and another product with the same note)', async () => {
    const { orders } = await confirmRows([P5_ROUTINE, P1_URGENT, { item: 'SS0.5L', notes: 'URGENT call receiving' }]);
    expect(orders[0]!.notes).toBe('routine | URGENT call receiving');
  });

  it('a merged line with partial money leaves the order total unknown', async () => {
    const { orders, lines } = await confirmRows([{ cases: '10', value: '100', margin: '20' }, { cases: '5' }]);
    expect(orders[0]).toMatchObject({ salesValue: null, marginValue: null });
    expect(lines[0]).toMatchObject({ salesValue: null, marginValue: null, cases: 15 });
  });
});

describe('confirm re-check: files merged the old way, and the depot (F02 / F03)', () => {
  const merged = (over: Partial<ResolvedLine> = {}) => ({ sourceRows: [2, 3], mergedRows: [{ row: 2 }, { row: 3 }], ...over }) as unknown as ResolvedLine;

  it('mergedTheOldWay: a merged line without its rows (checked before this release) must be uploaded again', () => {
    expect(mergedTheOldWay([merged({ mergedRows: undefined })])).toBe(true);
    expect(mergedTheOldWay([merged()])).toBe(false);
    expect(mergedTheOldWay([{ sourceRows: [2] } as ResolvedLine, { sourceRows: undefined } as unknown as ResolvedLine])).toBe(false);
  });

  it('batchDepotProblem: deleted or deactivated after the check', () => {
    expect(batchDepotProblem('d1', { code: 'NZW', active: true })).toBeNull();
    expect(batchDepotProblem('d1', { code: 'NZW', active: false })).toMatch(/^Depot NZW was deactivated after this file was checked/);
    expect(batchDepotProblem(null, null)).toMatch(/deleted after the file was checked/);
    expect(batchDepotProblem('d1', null)).toMatch(/deleted after the file was checked/);
  });

  async function revalidate(v: Partial<IntakeValidation>, depot: { code: string; active: boolean } | null, depotId: string | null = 'd1') {
    const queries: string[] = [];
    const tx: any = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        queries.push(strings.join('?'));
        return depot ? [depot] : [];
      },
      uploadBatch: { findFirst: async () => null },
      orderLine: { findMany: async () => [] },
      customer: { findMany: async () => [] },
      product: { findMany: async () => [] },
      tenantConfig: { findUniqueOrThrow: async () => ({ planningCutoffMin: 1080, timezone: 'Asia/Muscat' }) },
    };
    const batch = { id: 'b1', depotId, uploadedAt: new Date(), fileHash: null };
    const full = { lines: [], totals: { deliveryDates: [] }, late: { isLate: false, reasons: [] }, ...v } as unknown as IntakeValidation;
    try {
      await revalidateIntake(tx, 'T', batch, full, new Date());
      return { ok: true as const, queries };
    } catch (e) {
      return { ok: false as const, error: e as IntakeConflict, queries };
    }
  }

  it('refuses a file merged the old way with STALE_VALIDATION, nothing else checked', async () => {
    const r = await revalidate({ lines: [merged({ mergedRows: undefined })] }, { code: 'MCT', active: true });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : [r.error.code, r.error.message]).toEqual(['STALE_VALIDATION', MERGED_THE_OLD_WAY]);
  });

  it('refuses a file whose depot was deactivated or deleted after the check (MASTER_CHANGED); the depot row is locked FOR SHARE', async () => {
    const off = await revalidate({}, { code: 'NZW', active: false });
    expect(off.ok ? null : off.error.code).toBe('MASTER_CHANGED');
    expect(off.queries.join(' ')).toMatch(/FROM "Depot" WHERE "id" = \? AND "tenantId" = \? FOR SHARE/);
    const gone = await revalidate({}, null, null);
    expect(gone.ok ? null : gone.error.message).toMatch(/deleted after the file was checked/);
    expect((await revalidate({}, { code: 'MCT', active: true })).ok).toBe(true);
  });
});
