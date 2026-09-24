/**
 * Split deliveries: a customer bigger than the largest truck is cut into truck-sized parts on
 * real order lines, so every part knows exactly which SKUs (and how many cases) it carries.
 */
import { describe, expect, it } from 'vitest';
import {
  choosePartCapacity,
  fitsCapacity,
  mergePortions,
  orderIdOf,
  portionId,
  portionMoney,
  portionsOfPart,
  readPortionLines,
  rowLines,
  splitIntoParts,
  splitPartLabels,
  type OpenLine,
} from '@/lib/dispatch/split';

const L = (lineId: string, orderId: string, cases: number, kgPerCase = 10): OpenLine => ({ lineId, orderId, cases, kgPerCase });
const casesIn = (part: { cases: number }[]) => part.reduce((a, x) => a + x.cases, 0);
const kgIn = (part: { weightKg: number }[]) => part.reduce((a, x) => a + x.weightKg, 0);

describe('fitsCapacity', () => {
  it('checks cases and (when known) kg', () => {
    expect(fitsCapacity(100, 900, { cases: 100, kg: 1000 })).toBe(true);
    expect(fitsCapacity(101, 900, { cases: 100, kg: 1000 })).toBe(false);
    expect(fitsCapacity(50, 1000.0000001, { cases: 100, kg: 1000 })).toBe(true); // float sums
    expect(fitsCapacity(50, 1001, { cases: 100, kg: 1000 })).toBe(false);
    expect(fitsCapacity(50, 99_999, { cases: 100, kg: null })).toBe(true);
  });
});

describe('splitIntoParts', () => {
  it('fills full trucks first and leaves the remainder last, cutting a line only when needed', () => {
    const parts = splitIntoParts([L('a', 'O1', 120), L('b', 'O1', 60), L('c', 'O2', 70)], { cases: 100, kg: null });
    expect(parts.map(casesIn)).toEqual([100, 100, 50]);
    expect(parts[0]).toEqual([{ orderId: 'O1', lineId: 'a', cases: 100, weightKg: 1000 }]);
    expect(parts[1]).toEqual([
      { orderId: 'O1', lineId: 'a', cases: 20, weightKg: 200 },
      { orderId: 'O1', lineId: 'b', cases: 60, weightKg: 600 },
      { orderId: 'O2', lineId: 'c', cases: 20, weightKg: 200 },
    ]);
    expect(parts[2]).toEqual([{ orderId: 'O2', lineId: 'c', cases: 50, weightKg: 500 }]);
  });

  it('never loses or invents a case (per line)', () => {
    const lines = [L('a', 'O1', 333, 7.3), L('b', 'O2', 1, 20.5), L('c', 'O2', 250, 12.7), L('d', 'O3', 17, 0)];
    const parts = splitIntoParts(lines, { cases: 95, kg: 1000 });
    const perLine = new Map<string, number>();
    for (const p of parts) for (const a of p) perLine.set(a.lineId, (perLine.get(a.lineId) ?? 0) + a.cases);
    for (const l of lines) expect(perLine.get(l.lineId)).toBe(l.cases);
    for (const p of parts) {
      expect(casesIn(p)).toBeLessThanOrEqual(95);
      expect(kgIn(p)).toBeLessThanOrEqual(1000 + 0.5); // per-allocation kg is rounded to 0.1
    }
  });

  it('respects the payload when kg binds before cases', () => {
    // 300 cases of 50 kg = 15 t; truck 1000 cases / 10 t -> 200 + 100 cases.
    const parts = splitIntoParts([L('a', 'O1', 300, 50)], { cases: 1000, kg: 10_000 });
    expect(parts.map(casesIn)).toEqual([200, 100]);
    expect(parts.map(kgIn)).toEqual([10_000, 5_000]);
  });

  it('puts a single case heavier than the payload in a part of its own instead of looping', () => {
    const parts = splitIntoParts([L('a', 'O1', 2, 600), L('b', 'O1', 1, 10)], { cases: 100, kg: 500 });
    expect(parts.map(casesIn)).toEqual([1, 1, 1]);
    expect(parts[2][0].lineId).toBe('b');
  });

  it('keeps everything in one part when there is no usable capacity', () => {
    const parts = splitIntoParts([L('a', 'O1', 5), L('b', 'O1', 0)], { cases: 0, kg: null });
    expect(parts).toEqual([[{ orderId: 'O1', lineId: 'a', cases: 5, weightKg: 50 }]]);
  });
});

describe('portion ids and records', () => {
  it('maps a portion id back to its order', () => {
    expect(portionId('ckorder1', 2)).toBe('ckorder1~2');
    expect(orderIdOf('ckorder1~2')).toBe('ckorder1');
    expect(orderIdOf('ckorder1~open')).toBe('ckorder1');
    expect(orderIdOf('ckorder1')).toBe('ckorder1');
  });

  it('groups a part by order and merges portions of one order', () => {
    const [p1, p2] = splitIntoParts([L('a', 'O1', 150), L('c', 'O2', 30)], { cases: 100, kg: null });
    const r1 = portionsOfPart(p1, 1, 2);
    const r2 = portionsOfPart(p2, 2, 2);
    expect(r1).toEqual([{ orderId: 'O1', lines: [{ lineId: 'a', cases: 100 }], cases: 100, weightKg: 1000, part: 1, parts: 2 }]);
    expect(r2.map((r) => [r.orderId, r.cases])).toEqual([
      ['O1', 50],
      ['O2', 30],
    ]);
    const merged = mergePortions([r1[0], r2[0]]);
    expect(merged).toEqual({ orderId: 'O1', lines: [{ lineId: 'a', cases: 150 }], cases: 150, weightKg: 1500, part: null, parts: null });
  });

  it('reads stored portion lines defensively', () => {
    expect(readPortionLines(null)).toBeNull();
    expect(readPortionLines({ lineId: 'a' })).toBeNull();
    expect(readPortionLines([{ lineId: 'a', cases: 3 }, { lineId: 5 }, 'x'])).toEqual([{ lineId: 'a', cases: 3 }]);
  });

  it('rowLines returns the portion lines with kg pro rata, or the whole order', () => {
    const lines = [
      { id: 'a', cases: 10, weightKg: 125, sku: 'X' },
      { id: 'b', cases: 4, weightKg: 40, sku: 'Y' },
    ];
    expect(rowLines(lines, null)).toBe(lines);
    expect(rowLines(lines, [{ lineId: 'a', cases: 3 }, { lineId: 'zz', cases: 1 }, { lineId: 'b', cases: 0 }])).toEqual([
      { id: 'a', cases: 3, weightKg: 37.5, sku: 'X' },
    ]);
  });
});

describe('splitPartLabels', () => {
  it('numbers the parts of each customer in departure order across the plan', () => {
    const s = (customerId: string, portion: boolean, departMin: number, truckCode: string, sequence: number) => ({ customerId, portion, departMin, truckCode, sequence });
    const a2 = s('C1', true, 600, 'T2', 1);
    const a1 = s('C1', true, 420, 'T9', 3);
    const a3 = s('C1', true, 600, 'T3', 1);
    const other = s('C2', false, 420, 'T1', 1);
    const labels = splitPartLabels([a2, other, a1, a3]);
    expect(labels.get(a1)).toEqual({ part: 1, parts: 3 });
    expect(labels.get(a2)).toEqual({ part: 2, parts: 3 });
    expect(labels.get(a3)).toEqual({ part: 3, parts: 3 });
    expect(labels.has(other)).toBe(false);
  });
});

describe('choosePartCapacity', () => {
  const T = (code: string, cases: number, kg: number | null, tripsLeft = 3) => ({ code, cases, kg, tripsLeft });

  it('fewest parts when the trucks that can carry them have the trips', () => {
    const r = choosePartCapacity(1600, 0, [T('BIG', 800, null), T('S1', 500, null), T('S2', 500, null)]);
    expect(r).toEqual({ cap: { cases: 800, kg: null }, truckCode: 'BIG' });
  });

  it('sizes parts for smaller trucks when the biggest has too few trips left', () => {
    // BIG can do one more load only: 2 x 800 cannot all go; 4 x 500 fits BIG + S1 + S2... 3 trips -> 1500 deliverable.
    const r = choosePartCapacity(1600, 0, [T('BIG', 800, null, 1), T('S1', 500, null, 1), T('S2', 500, null, 1)]);
    expect(r?.cap.cases).toBe(500);
    const r2 = choosePartCapacity(1000, 0, [T('BIG', 800, null, 1), T('S1', 500, null, 1), T('S2', 500, null, 1)]);
    expect(r2?.cap.cases).toBe(500); // 2 x 500 on S1 + S2, instead of an 800 part only BIG could take
  });

  it('respects payload: a bigger-case truck with a small payload does not carry heavy parts', () => {
    // 3000 kg / 400 cases. VAN: 1000 cases but 1 t; LORRY: 400 cases, 10 t.
    const r = choosePartCapacity(900, 3000 * 2.25, [T('VAN', 1000, 1000), T('LORRY', 400, 10_000)]);
    expect(r?.truckCode).toBe('LORRY');
    expect(r?.cap).toEqual({ cases: 400, kg: 10_000 });
  });

  it('floors the payload to whole kg and ignores trucks without capacity', () => {
    expect(choosePartCapacity(300, 3000, [T('A', 120, 2500.7), T('Z', 0, null)])).toEqual({ cap: { cases: 120, kg: 2500 }, truckCode: 'A' });
    expect(choosePartCapacity(300, 0, [T('Z', 0, null)])).toBeNull();
  });
});

describe('portionMoney', () => {
  const lines = [
    { id: 'a', cases: 100, value: 1000 },
    { id: 'b', cases: 100, value: 100 },
  ];
  it('values a part from its own lines', () => {
    expect(portionMoney(1100, 200, lines, [{ lineId: 'a', cases: 100 }])).toBe(1000);
    expect(portionMoney(1100, 200, lines, [{ lineId: 'a', cases: 50 }, { lineId: 'b', cases: 50 }])).toBe(550);
  });
  it('falls back to the order value pro rata when a line has no value, and stays null when the order has none', () => {
    expect(portionMoney(1100, 200, [lines[0], { id: 'b', cases: 100, value: null }], [{ lineId: 'a', cases: 100 }])).toBe(550);
    expect(portionMoney(null, 200, lines, [{ lineId: 'a', cases: 100 }])).toBeNull();
  });
});
