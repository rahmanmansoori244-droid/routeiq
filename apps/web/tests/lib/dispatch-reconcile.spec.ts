/**
 * Case reconciliation: uploaded == planned + unserved, in total, per SKU and per sales order,
 * and every order exactly once.
 */
import { describe, expect, it } from 'vitest';
import { aggregateSkus, reconcile, type ReconOrder, type ReconPlanned, type ReconUnserved } from '@/lib/dispatch/reconcile';

// O1: C1 main branch, SO1, two SKUs. O2: C1 branch B2 (separate customer row), SO2.
// O3: C3, no sales-order number.
const ORDERS: ReconOrder[] = [
  {
    id: 'O1',
    customerId: 'C1',
    customerKey: 'C1::__MAIN__',
    lines: [
      { productCode: 'W500', productName: 'Water 500ml', salesOrderNo: 'SO1', cases: 10 },
      { productCode: 'W1500', productName: 'Water 1.5L', salesOrderNo: 'SO1', cases: 5 },
    ],
  },
  {
    id: 'O2',
    customerId: 'C1B2',
    customerKey: 'C1::B2',
    lines: [{ productCode: 'W500', productName: 'Water 500ml', salesOrderNo: 'SO2', cases: 3 }],
  },
  {
    id: 'O3',
    customerId: 'C3',
    customerKey: 'C3::__MAIN__',
    lines: [{ productCode: 'G5', productName: 'Gallon 5L', salesOrderNo: null, cases: 4 }],
  },
];

const P = (orderId: string, customerId: string, truckId = 'T1', loadNo = 1): ReconPlanned => ({ orderId, customerId, truckId, loadNo });
const U = (orderId: string, reasonCode = 'CAPACITY'): ReconUnserved => ({ orderId, reasonCode });

const GOOD_PLANNED = [P('O1', 'C1'), P('O2', 'C1B2', 'T1', 2)];
const GOOD_UNSERVED = [U('O3')];

describe('reconcile', () => {
  it('a complete plan reconciles', () => {
    const r = reconcile(ORDERS, GOOD_PLANNED, GOOD_UNSERVED);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({
      uploadedCases: 22,
      plannedCases: 18,
      unservedCases: 4,
      orders: 3,
      plannedOrders: 2,
      unservedOrders: 1,
    });
  });

  it('bySku rows are summed per product and sorted by code', () => {
    const r = reconcile(ORDERS, GOOD_PLANNED, GOOD_UNSERVED);
    expect(r.bySku).toEqual([
      { key: 'G5', label: 'Gallon 5L', uploaded: 4, planned: 0, unserved: 4, ok: true },
      { key: 'W1500', label: 'Water 1.5L', uploaded: 5, planned: 5, unserved: 0, ok: true },
      { key: 'W500', label: 'Water 500ml', uploaded: 13, planned: 13, unserved: 0, ok: true },
    ]);
  });

  it('bySalesOrder rows group lines by SO; lines without an SO are keyed by customer branch', () => {
    const r = reconcile(ORDERS, GOOD_PLANNED, GOOD_UNSERVED);
    const by = Object.fromEntries(r.bySalesOrder.map((x) => [x.key, x]));
    expect(Object.keys(by).sort()).toEqual(['(no SO) C3::__MAIN__', 'SO1', 'SO2'].sort());
    expect(by.SO1).toMatchObject({ uploaded: 15, planned: 15, unserved: 0, ok: true });
    expect(by.SO2).toMatchObject({ uploaded: 3, planned: 3, unserved: 0, ok: true });
    expect(by['(no SO) C3::__MAIN__']).toMatchObject({ uploaded: 4, planned: 0, unserved: 4, ok: true });
    const keys = r.bySalesOrder.map((x) => x.key);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });

  it('an order that is neither planned nor unserved is a problem', () => {
    const r = reconcile(ORDERS, GOOD_PLANNED, []);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('Order O3 (C3::__MAIN__) is neither planned nor unserved.');
    expect(r.problems).toContain('Cases do not reconcile: uploaded 22 != planned 18 + unserved 0.');
    expect(r.bySku.find((x) => x.key === 'G5')).toMatchObject({ uploaded: 4, planned: 0, unserved: 0, ok: false });
    expect(r.bySalesOrder.find((x) => x.key === '(no SO) C3::__MAIN__')?.ok).toBe(false);
    expect(r.bySku.find((x) => x.key === 'W500')?.ok).toBe(true);
  });

  it('an order planned twice is a problem', () => {
    const r = reconcile(ORDERS, [...GOOD_PLANNED, P('O1', 'C1', 'T2', 1)], GOOD_UNSERVED);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('Order O1 (C1::__MAIN__) appears 2 times.');
  });

  it('an order both planned and unserved is a problem and fails the arithmetic', () => {
    const r = reconcile(ORDERS, GOOD_PLANNED, [...GOOD_UNSERVED, U('O2')]);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('Order O2 (C1::B2) appears 2 times.');
    // Counted on both sides on purpose so the duplicate cannot hide.
    expect(r.plannedCases + r.unservedCases).toBe(25);
    expect(r.problems).toContain('Cases do not reconcile: uploaded 22 != planned 18 + unserved 7.');
    expect(r.bySalesOrder.find((x) => x.key === 'SO2')).toMatchObject({ uploaded: 3, planned: 3, unserved: 3, ok: false });
  });

  it('an order id that was never uploaded is a problem', () => {
    const r = reconcile(ORDERS, [...GOOD_PLANNED, P('GHOST', 'C9')], GOOD_UNSERVED);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('Order GHOST is in the plan but was never uploaded for this day.');
    const ghostUnserved = reconcile(ORDERS, GOOD_PLANNED, [...GOOD_UNSERVED, U('GHOST2')]);
    expect(ghostUnserved.problems).toContain('Order GHOST2 is in the plan but was never uploaded for this day.');
  });

  it('an order planned for another customer branch (branch merge) is a problem', () => {
    // O2 belongs to branch B2 but the stop was planned for the main branch C1.
    const r = reconcile(ORDERS, [P('O1', 'C1'), P('O2', 'C1')], GOOD_UNSERVED);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['Order O2 belongs to C1::B2 but was planned for another customer/branch.']);
    // The arithmetic alone would not have caught it.
    expect(r.uploadedCases).toBe(r.plannedCases + r.unservedCases);
  });

  it('an unserved order without a reason is a problem', () => {
    const r = reconcile(ORDERS, GOOD_PLANNED, [U('O3', '')]);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['Unserved order O3 has no reason.']);
  });

  it('no orders and no plan is trivially ok', () => {
    const r = reconcile([], [], []);
    expect(r).toMatchObject({ ok: true, uploadedCases: 0, orders: 0, bySku: [], bySalesOrder: [] });
  });

  it('everything unserved still reconciles', () => {
    const r = reconcile(ORDERS, [], ORDERS.map((o) => U(o.id, 'NO_LOCATION')));
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ plannedCases: 0, unservedCases: 22, plannedOrders: 0, unservedOrders: 3 });
  });
});

describe('aggregateSkus', () => {
  it('sums cases and weight per product, largest first, ties by code', () => {
    const out = aggregateSkus([
      { productCode: 'W500', productName: 'Water 500ml', cases: 10, weightKg: 120 },
      { productCode: 'G5', productName: 'Gallon 5L', cases: 4, weightKg: 80 },
      { productCode: 'W500', productName: 'Water 500ml', cases: 3, weightKg: 36 },
      { productCode: 'B19', productName: 'Bottle 19L', cases: 7, weightKg: 140 },
      { productCode: 'A1', productName: 'Cup', cases: 7, weightKg: 7 },
    ]);
    expect(out).toEqual([
      { productCode: 'W500', productName: 'Water 500ml', cases: 13, weightKg: 156 },
      { productCode: 'A1', productName: 'Cup', cases: 7, weightKg: 7 },
      { productCode: 'B19', productName: 'Bottle 19L', cases: 7, weightKg: 140 },
      { productCode: 'G5', productName: 'Gallon 5L', cases: 4, weightKg: 80 },
    ]);
  });

  it('empty input gives an empty manifest', () => {
    expect(aggregateSkus([])).toEqual([]);
  });

  it('does not mutate the input lines', () => {
    const lines = [
      { productCode: 'W500', productName: 'Water', cases: 1, weightKg: 1 },
      { productCode: 'W500', productName: 'Water', cases: 2, weightKg: 2 },
    ];
    aggregateSkus(lines);
    expect(lines[0].cases).toBe(1);
  });
});

describe('reconcile - split deliveries (portions)', () => {
  // O9: one customer, two lines (ids given so portions can refer to them).
  const BIG: ReconOrder[] = [
    {
      id: 'O9',
      customerId: 'C9',
      customerKey: 'C9::__MAIN__',
      lines: [
        { id: 'l1', productCode: 'W500', productName: 'Water 500ml', salesOrderNo: 'SO9', cases: 150 },
        { id: 'l2', productCode: 'G5', productName: 'Gallon 5L', salesOrderNo: 'SO9', cases: 40 },
      ],
    },
  ];
  const part = (truckId: string, lines: { lineId: string; cases: number }[]): ReconPlanned => ({ orderId: 'O9', customerId: 'C9', truckId, loadNo: 1, lines });

  it('an order planned in parts reconciles when the parts add up per line', () => {
    const r = reconcile(BIG, [part('T1', [{ lineId: 'l1', cases: 100 }]), part('T2', [{ lineId: 'l1', cases: 50 }, { lineId: 'l2', cases: 40 }])], []);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.plannedCases).toBe(190);
    expect(r.plannedOrders).toBe(1);
    expect(r.partialOrders).toBe(0);
  });

  it('part planned + rest unserved reconciles and counts as a partial order', () => {
    const r = reconcile(BIG, [part('T1', [{ lineId: 'l1', cases: 100 }])], [
      { orderId: 'O9', reasonCode: 'CAPACITY', lines: [{ lineId: 'l1', cases: 50 }, { lineId: 'l2', cases: 40 }] },
    ]);
    expect(r.ok).toBe(true);
    expect([r.plannedCases, r.unservedCases]).toEqual([100, 90]);
    expect([r.plannedOrders, r.unservedOrders, r.partialOrders]).toEqual([1, 1, 1]);
  });

  it('flags a lost case in the parts', () => {
    const r = reconcile(BIG, [part('T1', [{ lineId: 'l1', cases: 100 }]), part('T2', [{ lineId: 'l1', cases: 49 }, { lineId: 'l2', cases: 40 }])], []);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain('W500: uploaded 150 != planned 149 + unserved 0 across its split portions');
    expect(r.problems.join('\n')).toContain('Cases do not reconcile');
  });

  it('flags a duplicated case (parts overlapping)', () => {
    const r = reconcile(BIG, [part('T1', [{ lineId: 'l1', cases: 150 }, { lineId: 'l2', cases: 40 }]), part('T2', [{ lineId: 'l2', cases: 1 }])], []);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain('G5: uploaded 40 != planned 41');
  });

  it('flags a whole-order entry mixed with portions', () => {
    const r = reconcile(BIG, [{ orderId: 'O9', customerId: 'C9', truckId: 'T1', loadNo: 1 }, part('T2', [{ lineId: 'l1', cases: 1 }])], []);
    expect(r.problems.join('\n')).toContain('Order O9 (C9::__MAIN__) appears 2 times.');
  });

  it('flags a portion that refers to a line not on the order', () => {
    const r = reconcile(BIG, [part('T1', [{ lineId: 'l1', cases: 150 }, { lineId: 'l2', cases: 40 }, { lineId: 'zz', cases: 3 }])], []);
    expect(r.problems.join('\n')).toContain('refers to line zz');
  });

  it('flags a part planned for another customer', () => {
    const r = reconcile(BIG, [{ ...part('T1', [{ lineId: 'l1', cases: 150 }, { lineId: 'l2', cases: 40 }]), customerId: 'C1' }], []);
    expect(r.problems.join('\n')).toContain('planned for another customer/branch');
  });
});

describe('reconcile - orders the plan was made for (review F20)', () => {
  it('an expected order that no longer exists makes the plan not reconciled', () => {
    // O3 was deleted after planning: its unserved row is gone with it, so the case sum alone
    // would still balance. The expected ids catch it.
    const r = reconcile(ORDERS.slice(0, 2), GOOD_PLANNED, [], ['O1', 'O2', 'O3']);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('Order O3 is in this plan but no longer exists (deleted after planning).');
    expect(reconcile(ORDERS.slice(0, 2), GOOD_PLANNED, []).ok).toBe(true);
  });

  it('every expected order present: no extra problem', () => {
    const r = reconcile(ORDERS, GOOD_PLANNED, GOOD_UNSERVED, ['O1', 'O2', 'O3', 'O1']);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
