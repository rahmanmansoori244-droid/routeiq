/**
 * Order line weights (review F02): 0 kg on a line means UNKNOWN. Weights entered on the product
 * after the orders were confirmed are applied to open lines at the next optimize; lines on
 * frozen loads never change. The day overview reports weights per line, not per product.
 */
import { describe, expect, it } from 'vitest';
import {
  describeUnknownWeights,
  groupUnknownWeights,
  lineWeightStatus,
  orderUsesLineWeights,
  resolveOrderLineWeights,
  type WeightOrderIn,
} from '@/lib/dispatch/weights';
import { loadKgFromRefs } from '@/lib/dispatch/plan-service';

const line = (id: string, cases: number, weightKg: number, productKgPerCase: number) => ({ id, cases, weightKg, productKgPerCase });

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
    expect(lineWeightStatus({ weightKg: 38.4 }, 0, false)).toBe('KNOWN');
  });
  it('a 0 kg line whose product now has a case weight is applied at optimize', () => {
    expect(lineWeightStatus({ weightKg: 0 }, 12.8, false)).toBe('MASTER');
  });
  it('a 0 kg line with no product weight is unknown', () => {
    expect(lineWeightStatus({ weightKg: 0 }, 0, false)).toBe('UNKNOWN');
  });
  it('an old order that carries its kg on the order is known', () => {
    expect(lineWeightStatus({ weightKg: 0 }, 0, true)).toBe('KNOWN');
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
