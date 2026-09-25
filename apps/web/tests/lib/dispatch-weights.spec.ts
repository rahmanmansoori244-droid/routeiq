/**
 * Order line weights (review F02): 0 kg on a line means UNKNOWN. Weights entered on the product
 * after the orders were confirmed are applied to open lines at the next optimize; lines on
 * frozen loads never change. The day overview reports weights per line, not per product.
 */
import { describe, expect, it } from 'vitest';
import {
  describeUnknownWeights,
  groupUnknownWeights,
  intakeLineWeight,
  lineWeightStatus,
  masterLineKg,
  orderUsesLineWeights,
  resolveOrderLineWeights,
  type WeightOrderIn,
} from '@/lib/dispatch/weights';
import { loadKgFromRefs } from '@/lib/dispatch/plan-service';
import { outdatedNotes } from '@/lib/dispatch/plan-detail';
import { normalizeOrderRows, resolveOrderLines } from '@/lib/dispatch/order-intake';
import { INTAKE_BUSY, isTransactionTimeout } from '@/lib/dispatch/intake-server';
import { askOverride, weightFixText } from '@/app/t/[slug]/dispatch/client-api';

/** A line with a file weight (fromMaster false) unless said otherwise; 0 kg lines follow the master. */
const line = (id: string, cases: number, weightKg: number, productKgPerCase: number, fromMaster = weightKg <= 0) => ({ id, cases, weightKg, fromMaster, productKgPerCase });
const st = (weightKg: number, fromMaster = weightKg <= 0, cases = 3) => ({ cases, weightKg, fromMaster });

describe('orderUsesLineWeights', () => {
  it('is true when the lines carry the kg (or nothing carries any kg)', () => {
    expect(orderUsesLineWeights({ totalWeightKg: 120, lines: [{ weightKg: 60 }, { weightKg: 60 }] })).toBe(true);
    expect(orderUsesLineWeights({ totalWeightKg: 0, lines: [{ weightKg: 0 }] })).toBe(true);
    expect(orderUsesLineWeights({ totalWeightKg: 60, lines: [{ weightKg: 60 }, { weightKg: 0 }] })).toBe(true);
  });

  it('is false for old orders whose kg is only on the order', () => {
    expect(orderUsesLineWeights({ totalWeightKg: 60, lines: [{ weightKg: 0 }] })).toBe(false);
    expect(orderUsesLineWeights({ totalWeightKg: 200, lines: [{ weightKg: 60 }] })).toBe(false);
  });
});

describe('lineWeightStatus (line-based missing-weight check)', () => {
  it('a line with kg is known, whatever the product says', () => {
    expect(lineWeightStatus(st(38.4), 0, false)).toBe('KNOWN');
    expect(lineWeightStatus(st(38.4), 99, false)).toBe('KNOWN'); // a file weight is never replaced
  });
  it('a 0 kg line whose product now has a case weight is applied at optimize', () => {
    expect(lineWeightStatus(st(0), 12.8, false)).toBe('MASTER');
  });
  it('a 0 kg line with no product weight is unknown', () => {
    expect(lineWeightStatus(st(0), 0, false)).toBe('UNKNOWN');
  });
  it('an old order that carries its kg on the order is known', () => {
    expect(lineWeightStatus(st(0), 0, true)).toBe('KNOWN');
  });
  it('a line weighed from the master is applied again when the case weight is corrected (1500 typed for 1.5)', () => {
    expect(lineWeightStatus(st(4500, true), 1.5, false)).toBe('MASTER');
    expect(lineWeightStatus(st(4.5, true), 1.5, false)).toBe('KNOWN');
  });
});

describe('resolveOrderLineWeights', () => {
  const orders: WeightOrderIn[] = [
    // O1: a new SKU confirmed at 0 kg (product now 12.8 kg), plus a known line.
    { id: 'O1', totalWeightKg: 94, lines: [line('a', 3, 0, 12.8), line('b', 10, 94, 9.4)] },
    // O2: on a frozen load - never changed.
    { id: 'O2', totalWeightKg: 0, lines: [line('c', 5, 0, 12.8)] },
    // O3: still no weight on the product - stays unknown.
    { id: 'O3', totalWeightKg: 0, lines: [line('d', 5, 0, 0)] },
    // O4: an old order with its kg on the order only - left as it was.
    { id: 'O4', totalWeightKg: 60, lines: [line('e', 5, 0, 12.8)] },
  ];

  it('resolves only 0 kg lines of open orders whose product has a weight now', () => {
    const r = resolveOrderLineWeights(orders, new Set(['O2']));
    expect(r.lines).toEqual([{ orderId: 'O1', lineId: 'a', cases: 3, beforeKg: 0, afterKg: 38.4 }]);
    expect(r.orders).toEqual([{ orderId: 'O1', beforeKg: 94, afterKg: 132.4 }]);
  });

  it('never touches a line that already has kg, and changes nothing twice', () => {
    const r1 = resolveOrderLineWeights(orders, new Set(['O2']));
    const after = orders.map((o) => ({
      ...o,
      totalWeightKg: r1.orders.find((x) => x.orderId === o.id)?.afterKg ?? o.totalWeightKg,
      lines: o.lines.map((l) => ({ ...l, weightKg: r1.lines.find((x) => x.lineId === l.id)?.afterKg ?? l.weightKg })),
    }));
    expect(resolveOrderLineWeights(after, new Set(['O2']))).toEqual({ lines: [], orders: [] });
  });
});

describe('unknown weights for the WEIGHT_REQUIRED answer', () => {
  it('groups lines per product, biggest first, and lists them plainly', () => {
    const g = groupUnknownWeights([
      { productCode: 'NEW-1', productName: 'New one', cases: 5 },
      { productCode: 'NEW-2', productName: 'New two', cases: 40 },
      { productCode: 'NEW-1', productName: 'New one', cases: 7 },
    ]);
    expect(g).toEqual([
      { productCode: 'NEW-2', productName: 'New two', lines: 1, cases: 40 },
      { productCode: 'NEW-1', productName: 'New one', lines: 2, cases: 12 },
    ]);
    expect(describeUnknownWeights(g)).toBe('NEW-2 (40 cases), NEW-1 (12 cases)');
    expect(describeUnknownWeights(g, 1)).toBe('NEW-2 (40 cases) and 1 more');
  });
});

describe('loadKgFromRefs (PlanLoad.weightKg from its assignments)', () => {
  it('adds split portions by their own kg and whole orders by the order kg', () => {
    const scope = { portions: { 'O1~1': { orderId: 'O1', lines: [{ lineId: 'a', cases: 1 }], cases: 1, weightKg: 120, part: 1, parts: 2 } } };
    expect(loadKgFromRefs(['O1~1', 'O2'], scope, new Map([['O1', 240], ['O2', 38.44]]))).toBe(158.4);
    expect(loadKgFromRefs(['O9'], scope, new Map())).toBe(0);
  });
});

describe('a corrected product weight reaches open lines weighed from the master (review: weights frozen on open lines)', () => {
  it('masterLineKg: 0 kg and master-weighed lines follow the product, file weights never do', () => {
    expect(masterLineKg({ cases: 10, weightKg: 0, fromMaster: true }, 1.5)).toBe(15);
    expect(masterLineKg({ cases: 10, weightKg: 15000, fromMaster: true }, 1.5)).toBe(15); // 1500 typed for 1.5, then corrected
    expect(masterLineKg({ cases: 10, weightKg: 15, fromMaster: true }, 1.5)).toBeNull(); // already right
    expect(masterLineKg({ cases: 10, weightKg: 128, fromMaster: false }, 1.5)).toBeNull(); // from the file
    expect(masterLineKg({ cases: 10, weightKg: 15000, fromMaster: true }, 0)).toBeNull(); // no case weight: keep
  });

  it('after the product is corrected, the next optimize re-weighs the line and the order (the first value is not frozen)', () => {
    // The reviewer's case: 10 cases weighed at 1500 kg per case at the first optimize, then 1.5.
    const afterFirstOptimize: WeightOrderIn = { id: 'O1', totalWeightKg: 15000 + 94, lines: [line('a', 10, 15000, 1.5, true), line('b', 10, 94, 9.4)] };
    const r = resolveOrderLineWeights([afterFirstOptimize], new Set());
    expect(r.lines).toEqual([{ orderId: 'O1', lineId: 'a', cases: 10, beforeKg: 15000, afterKg: 15 }]);
    expect(r.orders).toEqual([{ orderId: 'O1', beforeKg: 15094, afterKg: 109 }]);
    expect(lineWeightStatus(afterFirstOptimize.lines[0], 1.5, false)).toBe('MASTER');
    // On a frozen load it stays as loaded.
    expect(resolveOrderLineWeights([afterFirstOptimize], new Set(['O1']))).toEqual({ lines: [], orders: [] });
  });
});

describe('intakeLineWeight (confirm)', () => {
  it('keeps a file weight, and weighs lines without one from the master (0 = unknown), following it later', () => {
    expect(intakeLineWeight({ cases: 10, weightKg: 128 }, 9)).toEqual({ weightKg: 128, fromMaster: false });
    expect(intakeLineWeight({ cases: 10, weightKg: null }, 12.8)).toEqual({ weightKg: 128, fromMaster: true });
    expect(intakeLineWeight({ cases: 10, weightKg: null }, 0)).toEqual({ weightKg: 0, fromMaster: true });
  });

  it('a merged line with some blank weights is never stored at a partial kg that would count as known', () => {
    // Unknown master: 0 kg (unknown), not the 100 kg of 10 of its 15 cases.
    expect(intakeLineWeight({ cases: 15, weightKg: 100, weightMissingCases: 5 }, 0)).toEqual({ weightKg: 0, fromMaster: true });
    // Known master: the whole line from it, and it follows later corrections.
    expect(intakeLineWeight({ cases: 15, weightKg: 100, weightMissingCases: 5 }, 12.8)).toEqual({ weightKg: 192, fromMaster: true });
  });

  it("the reviewer's file: SO+SKU rows 10 cases at 100 kg + 5 cases blank, new product -> the line is UNKNOWN", () => {
    const rows = [
      { 'SO No': 'SO-1', 'Req. Delivery Date': '27/09/2026', 'Customer Code': 'C1', 'Item Code': 'NEW-1', 'Qty (Cases)': '10', Weight: '100' },
      { 'SO No': 'SO-1', 'Req. Delivery Date': '27/09/2026', 'Customer Code': 'C1', 'Item Code': 'NEW-1', 'Qty (Cases)': '5', Weight: '' },
    ];
    const norm = normalizeOrderRows(rows);
    const res = resolveOrderLines(norm, [{ id: 'c1', code: 'C1', branchKey: '__MAIN__', name: 'C1', active: true, lat: 23.6, lng: 58.4 }], [], new Set());
    expect(res.lines).toHaveLength(1);
    expect(res.issues.productsWithoutWeight).toEqual(['NEW-1']);
    const w = intakeLineWeight(res.lines[0], 0);
    expect(w.weightKg).toBe(0);
    expect(lineWeightStatus({ cases: res.lines[0].cases, weightKg: w.weightKg, fromMaster: w.fromMaster }, 0, false)).toBe('UNKNOWN');
    // ... and once the case weight is entered, the whole line gets it at the next optimize.
    expect(masterLineKg({ cases: 15, weightKg: w.weightKg, fromMaster: w.fromMaster }, 12.8)).toBe(192);
  });
});

describe('outdatedNotes (plan view: what a re-plan would change on planned loads)', () => {
  const order = (over: Record<string, unknown> = {}) => ({
    status: 'ASSIGNED',
    totalWeightKg: 150,
    customer: { code: 'C2', branchCode: null, active: true },
    lines: [{ id: 'l1', cases: 10, weightKg: 150, weightFromMaster: true, product: { code: 'P1', weightPerCaseKg: 15 } }],
    ...over,
  });
  const load = (status: string, o: ReturnType<typeof order>, portionLinesJson: unknown = null) => ({ status, loadNo: 1, truck: { code: 'T01' }, assignments: [{ portionLinesJson, order: o }] });

  it('is empty when nothing changed', () => {
    expect(outdatedNotes([load('PLANNED', order())])).toEqual([]);
  });

  it('names customers deactivated since and corrected case weights, on planned loads only', () => {
    const o = order({ customer: { code: 'C2', branchCode: null, active: false }, totalWeightKg: 15000, lines: [{ id: 'l1', cases: 10, weightKg: 15000, weightFromMaster: true, product: { code: 'P1', weightPerCaseKg: 1.5 } }] });
    const notes = outdatedNotes([load('PLANNED', o), load('LOCKED', order({ customer: { code: 'C9', branchCode: null, active: false } }))]);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/Deactivated after this plan was made, but still on planned loads: C2 \(T01 L1\)\. Re-plan/);
    expect(notes[0]).not.toMatch(/C9/);
    expect(notes[1]).toMatch(/P1 \(10 cases on planned loads\)/);
  });

  it('counts only the cases of a split portion', () => {
    const o = order({ totalWeightKg: 0, lines: [{ id: 'l1', cases: 10, weightKg: 0, weightFromMaster: true, product: { code: 'P1', weightPerCaseKg: 15 } }] });
    const notes = outdatedNotes([load('PLANNED', o, [{ lineId: 'l1', cases: 4 }])]);
    expect(notes[0]).toMatch(/P1 \(4 cases on planned loads\)/);
  });
});

describe('weight question wording by role (only company admins can edit products)', () => {
  const body = { code: 'WEIGHT_REQUIRED', unknownWeights: [{ productCode: 'NEW-1', lines: 1, cases: 4 }] };
  function asked(canEditProducts: boolean): string {
    let text = '';
    const g = globalThis as unknown as { window?: { confirm: (t: string) => boolean } };
    const prev = g.window;
    g.window = { confirm: (t: string) => ((text = t), false) };
    try {
      expect(askOverride(body, 'Re-plan', { canEditProducts })).toBeNull();
    } finally {
      g.window = prev;
    }
    return text;
  }
  it('tells an admin to add the weight, and a planner or supervisor to ask an admin', () => {
    expect(weightFixText(true)).toBe('add the case weight under Products');
    expect(weightFixText(false)).toBe('ask a company admin to add the case weight under Products');
    expect(asked(true)).toMatch(/Cancel, and add the case weight under Products - or re-plan anyway/);
    expect(asked(false)).toMatch(/Cancel, and ask a company admin to add the case weight under Products - or re-plan anyway/);
  });
});

describe('isTransactionTimeout (intake lock busy -> 409, not 500)', () => {
  it('recognises only Prisma P2028', () => {
    expect(isTransactionTimeout({ code: 'P2028' })).toBe(true);
    expect(isTransactionTimeout({ code: 'P2002' })).toBe(false);
    expect(isTransactionTimeout(null)).toBe(false);
    expect(INTAKE_BUSY.code).toBe('INTAKE_BUSY');
  });
});
