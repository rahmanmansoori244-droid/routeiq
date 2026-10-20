/**
 * Special-loading lines (owner request 20 Oct 2026, lib/dispatch/loading-split.ts) - pure: a load's products
 * split into the normal lines and one block per loading-instruction text, by the order lines of its stops.
 * - a mixed load, a product only for the block, two branches of one text (letter case ignored), two texts;
 * - a split order's part, a cancelled or brought-forward order (only loaded orders go to a block, as the box);
 * - normal + every block = the products, per product and in total, in cases, kg and pallet units;
 * - the mismatch answer, no instruction, the folding and the tags;
 * - a block's pallets for the loader (owner, 20 Oct 2026): full pallets per product, the loose cases of all
 *   its products together on mixed pallets, and their words.
 * Every customer here is invented (INSTRUCTED); the instruction texts are synthetic ("SPECIAL").
 */
import { describe, expect, it } from 'vitest';
import type { DetailLoad, DetailStop, PlanDetail } from '@/lib/dispatch/plan-detail';
import { aggregateSkus } from '@/lib/dispatch/reconcile';
import { fullAndLoose, palletUnits } from '@/lib/dispatch/pallets';
import { blockPalletsText, specialLinesPalletTotal } from '@/lib/dispatch/loading-instruction';
import {
  blockPallets,
  LOADING_TAG_MAX,
  loadingTag,
  loadingTags,
  splitByLoadingInstruction,
  type ManifestSplit,
  type SplitInputRow,
} from '@/lib/dispatch/loading-split';
import { CPP, INSTRUCTED, instructionFixture, palletFixture } from './plan-detail-fixture';

const SPECIAL = 'SPECIAL';
const l1 = (d: PlanDetail) => d.loads[0]!;
/** The fixture's L1 with stop 1 (Hyper Example A, C100 / B1) under SPECIAL: o1 = TAN-500-24 x50 + JAB-1500-6 x20; stop 2: o2 = TAN-500-24 x30 + TAN-5G x10. */
function mixed(text = SPECIAL): PlanDetail {
  const d = instructionFixture();
  l1(d).stops[0] = { ...l1(d).stops[0]!, loadingInstruction: text };
  return d;
}
/** The manifest again from the stops (after a test changed them), as getPlanDetail builds it. */
function remanifest(l: DetailLoad) {
  l.manifest = aggregateSkus(l.stops.flatMap((s) => s.skus));
  l.cases = l.manifest.reduce((a, m) => a + m.cases, 0);
}
const split = (l: DetailLoad) => splitByLoadingInstruction(l.manifest, l.stops);
const lines = (rows: { productCode: string; cases: number }[]) => rows.map((r) => `${r.productCode} x${r.cases}`);

/** normal + every block = the products, per product and in total: cases and pallet units exactly, kg to 0.1. */
function expectInvariant(rows: readonly SplitInputRow[], s: ManifestSplit) {
  for (const r of rows) {
    const parts = [...s.normal, ...s.groups.flatMap((g) => g.rows)].filter((x) => x.productCode === r.productCode);
    expect(parts.reduce((a, x) => a + x.cases, 0), r.productCode).toBe(r.cases);
    if (typeof r.weightKg === 'number') expect(parts.reduce((a, x) => a + (x.weightKg ?? 0), 0), r.productCode).toBeCloseTo(r.weightKg, 1);
    if (typeof r.palletUnits === 'number') expect(parts.reduce((a, x) => a + (x.palletUnits ?? 0), 0), r.productCode).toBe(r.palletUnits);
    // Full pallets and loose cases are worked out per line shown.
    for (const x of parts) if (typeof r.palletUnits === 'number') expect({ full: x.fullPallets, loose: x.looseCases }).toEqual(fullAndLoose(x.cases, r.casesPerPallet));
  }
  const total = rows.reduce((a, r) => a + r.cases, 0);
  expect(s.normalCases + s.groups.reduce((a, g) => a + g.cases, 0)).toBe(total);
  expect(s.normalCases).toBe(s.normal.reduce((a, x) => a + x.cases, 0));
  for (const g of s.groups) expect(g.cases).toBe(g.rows.reduce((a, x) => a + x.cases, 0));
}

describe('splitByLoadingInstruction', () => {
  it('a mixed load: a product with both shares has a normal line and a block line; the block is exactly its customer\'s cases', () => {
    const d = mixed();
    const { split: s, mismatch } = split(l1(d));
    expect(mismatch).toBe(false);
    // The manifest's order (cases, then code) is kept in both parts.
    expect(lines(l1(d).manifest)).toEqual(['TAN-500-24 x80', 'JAB-1500-6 x20', 'TAN-5G x10']);
    expect(lines(s!.normal)).toEqual(['TAN-500-24 x30', 'TAN-5G x10']);
    expect(s!.normalCases).toBe(40);
    expect(s!.groups).toHaveLength(1);
    const g = s!.groups[0]!;
    expect([g.key, g.text, g.tag, g.stops, g.cases]).toEqual([SPECIAL, SPECIAL, SPECIAL, [1], 70]);
    expect(lines(g.rows)).toEqual(['TAN-500-24 x50', 'JAB-1500-6 x20']);
    // Kg: each line's own kg (fixture: 12 kg and 9.5 kg a case).
    expect(g.rows.map((x) => x.weightKg)).toEqual([600, 190]);
    expect(s!.normal.map((x) => x.weightKg)).toEqual([360, 200]);
    expect([g.weightKg, s!.normalWeightKg]).toEqual([790, 560]);
    expectInvariant(l1(d).manifest, s!);
  });

  it('a product only for the block is not on the normal lines at all', () => {
    const { split: s } = split(l1(mixed()));
    expect(s!.normal.some((x) => x.productCode === 'JAB-1500-6')).toBe(false);
    expect(s!.groups[0]!.rows.map((x) => x.productCode)).toContain('JAB-1500-6');
  });

  it('two branches with the same text (any letter case) share one block: the stops of both, the cases added up', () => {
    const d = mixed();
    const first = l1(d).stops[0]!;
    l1(d).stops.push({
      ...first,
      sequence: 3,
      customerId: 'c101',
      branchCode: 'B2',
      orderIds: ['o1b'],
      loadingInstruction: 'special',
      orderLines: first.orderLines.map((l) => ({ ...l, orderId: 'o1b', lineId: `${l.lineId}b`, salesOrderNo: 'SO-1001B' })),
    });
    remanifest(l1(d));
    const { split: s } = split(l1(d));
    expect(s!.groups.map((g) => [g.text, g.tag, g.stops])).toEqual([[SPECIAL, SPECIAL, [1, 3]]]);
    expect(lines(s!.groups[0]!.rows)).toEqual(['TAN-500-24 x100', 'JAB-1500-6 x40']);
    expect(lines(s!.normal)).toEqual(['TAN-500-24 x30', 'TAN-5G x10']);
    expectInvariant(l1(d).manifest, s!);
  });

  it('another text is its own block, in stop order; a load all of whose customers have one has no normal lines', () => {
    const d = mixed();
    l1(d).stops[1] = { ...l1(d).stops[1]!, loadingInstruction: 'Cartons on top only' };
    const { split: s } = split(l1(d));
    expect(s!.groups.map((g) => [g.tag, g.stops, lines(g.rows)])).toEqual([
      [SPECIAL, [1], ['TAN-500-24 x50', 'JAB-1500-6 x20']],
      ['Cartons on top only', [2], ['TAN-500-24 x30', 'TAN-5G x10']],
    ]);
    expect(s!.normal).toEqual([]);
    expect(s!.normalCases).toBe(0);
    expect(s!.normalWeightKg).toBe(0);
    expectInvariant(l1(d).manifest, s!);
    // The stop order decides, not the order of the stops in the list.
    const swapped = { ...l1(d), stops: [...l1(d).stops].reverse() };
    expect(split(swapped).split!.groups.map((g) => g.tag)).toEqual([SPECIAL, 'Cartons on top only']);
  });

  it("a split order's part counts only the cases on this load", () => {
    const d = mixed();
    const s1 = l1(d).stops[0]!;
    // Part 1 of 2: 25 of the order's 50 TAN-500-24 cases (and its 20 JAB-1500-6) on this load.
    const orderLines = s1.orderLines.map((l) => (l.productCode === 'TAN-500-24' ? { ...l, cases: 25, weightKg: 300 } : l));
    l1(d).stops[0] = {
      ...s1,
      split: { part: 1, parts: 2, restUnserved: false },
      cases: 45,
      orderLines,
      skus: aggregateSkus(orderLines.map((l) => ({ productCode: l.productCode, productName: l.productName, cases: l.cases, weightKg: l.weightKg ?? 0 }))),
    };
    remanifest(l1(d));
    const { split: s } = split(l1(d));
    expect(lines(s!.groups[0]!.rows)).toEqual(['TAN-500-24 x25', 'JAB-1500-6 x20']);
    expect(lines(s!.normal)).toEqual(['TAN-500-24 x30', 'TAN-5G x10']);
    expectInvariant(l1(d).manifest, s!);
  });

  it('a stop nothing of which is loaded makes no block (as the box); in a stop with two orders only the loaded one goes to the block', () => {
    const cancelled = mixed();
    l1(cancelled).stops[0] = { ...l1(cancelled).stops[0]!, cancelled: true, cancelledOrderIds: ['o1'] };
    expect(split(l1(cancelled))).toEqual({ split: null, mismatch: false });
    const carried = mixed();
    l1(carried).stops[0] = { ...l1(carried).stops[0]!, carriedTo: '2026-09-26', carriedOrderIds: ['o1'] };
    expect(split(l1(carried))).toEqual({ split: null, mismatch: false });

    for (const mark of ['cancelledOrderIds', 'carriedOrderIds'] as const) {
      const d = mixed();
      const s1 = l1(d).stops[0]!;
      // A second order of the customer on the stop: 5 TAN-5G, cancelled (or brought forward).
      const extra = { orderId: 'o1x', lineId: 'o1x-l1', salesOrderNo: 'SO-1001X', productCode: 'TAN-5G', productName: 'Tanuf 5 gallon', cases: 5, weightKg: 100 };
      const orderLines = [...s1.orderLines, extra];
      l1(d).stops[0] = {
        ...s1,
        orderIds: ['o1', 'o1x'],
        [mark]: ['o1x'],
        orderLines,
        skus: aggregateSkus(orderLines.map((l) => ({ productCode: l.productCode, productName: l.productName, cases: l.cases, weightKg: l.weightKg ?? 0 }))),
      } as DetailStop;
      remanifest(l1(d));
      const { split: s } = split(l1(d));
      expect(lines(s!.groups[0]!.rows), mark).toEqual(['TAN-500-24 x50', 'JAB-1500-6 x20']);
      // Its cases stay on the normal line (the banners say so): 10 of stop 2 + these 5.
      expect(lines(s!.normal), mark).toEqual(['TAN-500-24 x30', 'TAN-5G x15']);
      expectInvariant(l1(d).manifest, s!);
    }
  });

  it('a stop brought forward FROM an earlier day is loaded: its lines count', () => {
    const d = mixed();
    l1(d).stops[0] = { ...l1(d).stops[0]!, carriedFrom: '2026-09-23' };
    expect(split(l1(d)).split!.groups[0]!.cases).toBe(70);
  });

  it('on a load planned by pallets the pallet units split exactly (each line its own), full pallets and loose cases per line', () => {
    const d = palletFixture();
    l1(d).stops[0] = { ...l1(d).stops[0]!, ...INSTRUCTED.a, loadingInstruction: SPECIAL };
    const { split: s } = split(l1(d));
    // 50 at 84 a pallet = 596 units, 20 at 56 = 358; stop 2: 30 at 84 = 358, 10 at 40 = 250.
    expect(s!.groups[0]!.rows.map((x) => [x.productCode, x.palletUnits, x.casesPerPallet, x.fullPallets, x.looseCases])).toEqual([
      ['TAN-500-24', 596, CPP['TAN-500-24'], 0, 50],
      ['JAB-1500-6', 358, CPP['JAB-1500-6'], 0, 20],
    ]);
    expect(s!.normal.map((x) => [x.productCode, x.palletUnits])).toEqual([
      ['TAN-500-24', 358],
      ['TAN-5G', 250],
    ]);
    expect([s!.groups[0]!.palletUnits, s!.normalPalletUnits]).toEqual([954, 608]);
    expect(954 + 608).toBe(l1(d).palletUnits);
    // The block's pallets for the loader: 50 of 84 + 20 of 56 loose = 0.95 of a pallet = 1 mixed pallet.
    expect(s!.groups[0]!.pallets).toEqual({ full: 0, mixed: 1, casesWithoutFactor: 0 });
    expectInvariant(l1(d).manifest, s!);
    // Without per-line units (an older plan detail): worked out from the cases and the row's factor.
    const older = { ...l1(d), stops: l1(d).stops.map((st) => ({ ...st, orderLines: st.orderLines.map(({ palletUnits: _u, weightKg: _k, ...rest }) => rest) })) };
    const again = split(older).split!;
    expect(again.groups[0]!.rows.map((x) => x.palletUnits)).toEqual([596, 358]);
    expectInvariant(older.manifest, again);
    // A big block: 100 cases at 84 = 1 full pallet + 16 loose cases.
    const big = palletFixture();
    big.loads[2]!.stops[0] = { ...big.loads[2]!.stops[0]!, ...INSTRUCTED.b, loadingInstruction: SPECIAL };
    const whole = split(big.loads[2]!).split!;
    expect(whole.normal).toEqual([]);
    expect(whole.groups[0]!.rows.find((x) => x.productCode === 'TAN-500-24')).toMatchObject({ cases: 100, fullPallets: 1, looseCases: 16 });
    // 1 full pallet of TAN-500-24; 16 of 84 + 25 of 56 + 5 of 40 loose = 0.76 = 1 mixed pallet.
    expect(whole.groups[0]!.pallets).toEqual({ full: 1, mixed: 1, casesWithoutFactor: 0 });
    expectInvariant(big.loads[2]!.manifest, whole);
  });

  it('the invariant holds in every scenario of this file, kg included, with the line kg missing (the row kg shared by cases)', () => {
    const d = mixed();
    const noKg = { ...l1(d), stops: l1(d).stops.map((st) => ({ ...st, orderLines: st.orderLines.map(({ weightKg: _k, ...rest }) => rest) })) };
    const s = split(noKg).split!;
    expect(s.groups[0]!.rows.map((x) => x.weightKg)).toEqual([600, 190]);
    expectInvariant(noKg.manifest, s);
    // Rows without kg (the load sheet's products): no kg anywhere.
    const casesOnly = l1(d).manifest.map(({ productCode, productName, cases }) => ({ productCode, productName, cases }));
    const c = splitByLoadingInstruction(casesOnly, l1(d).stops).split!;
    expect('weightKg' in c.groups[0]!).toBe(false);
    // A load planned by cases: no pallets anywhere, the block's neither.
    expect('pallets' in s.groups[0]!).toBe(false);
    expect('pallets' in c.groups[0]!).toBe(false);
    expect('normalWeightKg' in c).toBe(false);
    expect('weightKg' in c.normal[0]!).toBe(false);
    expectInvariant(casesOnly, c);
  });

  it('order lines that do not add up to the products: nothing split, mismatch (never expected)', () => {
    const more = mixed();
    l1(more).stops[0] = { ...l1(more).stops[0]!, orderLines: l1(more).stops[0]!.orderLines.map((l) => ({ ...l, cases: l.cases * 10 })) };
    expect(split(l1(more))).toEqual({ split: null, mismatch: true });
    const unknown = mixed();
    l1(unknown).stops[0] = { ...l1(unknown).stops[0]!, orderLines: [{ ...l1(unknown).stops[0]!.orderLines[0]!, productCode: 'NOT-ON-LOAD' }] };
    expect(split(l1(unknown))).toEqual({ split: null, mismatch: true });
  });

  it('no instruction, or only spaces and invisible characters: nothing to split; control characters fold as the box folds them', () => {
    expect(split(l1(instructionFixture()))).toEqual({ split: null, mismatch: false });
    for (const none of ['', '   ', '​', '\n\t']) expect(split(l1(mixed(none))), JSON.stringify(none)).toEqual({ split: null, mismatch: false });
    const d = mixed('SPE\u0000CIAL​');
    l1(d).stops[1] = { ...l1(d).stops[1]!, loadingInstruction: ' special\n' };
    expect(split(l1(d)).split!.groups.map((g) => [g.text, g.stops])).toEqual([[SPECIAL, [1, 2]]]);
  });
});

describe('the tags', () => {
  it('a short text is its own tag; a long one is cut at a word (or at 23 characters) with "…", never half of a two-unit character', () => {
    expect(LOADING_TAG_MAX).toBe(24);
    expect(loadingTag(SPECIAL)).toBe(SPECIAL);
    expect(loadingTag('x'.repeat(24))).toBe('x'.repeat(24));
    expect(loadingTag('x'.repeat(25))).toBe(`${'x'.repeat(23)}…`);
    expect(loadingTag('Water at the bottom, max 5 layers')).toBe('Water at the bottom…');
    expect(loadingTag(`${'x'.repeat(22)}😀 and more`)).toBe(`${'x'.repeat(22)}…`);
    for (const t of ['Water at the bottom, max 5 layers', 'x'.repeat(200), 'الماء في الأسفل دائما ولا أكثر من خمس طبقات']) expect(loadingTag(t).length).toBeLessThanOrEqual(LOADING_TAG_MAX);
  });

  it('two blocks whose tags would read the same: the second gets " (2)"', () => {
    const a = `${'Y'.repeat(30)} one`;
    const b = `${'Y'.repeat(30)} two`;
    expect(loadingTags([a, b, 'Z'])).toEqual([`${'Y'.repeat(23)}…`, `${'Y'.repeat(23)}… (2)`, 'Z']);
    const d = mixed(a);
    l1(d).stops[1] = { ...l1(d).stops[1]!, loadingInstruction: b };
    expect(split(l1(d)).split!.groups.map((g) => [g.tag, g.text])).toEqual([
      [`${'Y'.repeat(23)}…`, a],
      [`${'Y'.repeat(23)}… (2)`, b],
    ]);
  });
});

describe("a block's pallets (owner, 20 Oct 2026: separate from the normal lines, the same cases per pallet, loose cases on one pallet together)", () => {
  const row = (cases: number, casesPerPallet: number | null) => ({ cases, casesPerPallet });

  it("the owner's example: 40 normal + 30 special cases of one product at 56 a pallet - two lines, each at 56, the block 1 mixed pallet", () => {
    const rows: SplitInputRow[] = [{ productCode: 'P1', productName: 'Product one', cases: 70, casesPerPallet: 56, palletUnits: palletUnits(40, 56) + palletUnits(30, 56) }];
    const stops = [
      { sequence: 1, orderLines: [{ orderId: 'a', productCode: 'P1', cases: 40 }] },
      { sequence: 2, loadingInstruction: SPECIAL, orderLines: [{ orderId: 'b', productCode: 'P1', cases: 30 }] },
    ];
    const s = splitByLoadingInstruction(rows, stops).split!;
    expect(s.normal.map((x) => [x.cases, x.casesPerPallet, x.fullPallets, x.looseCases])).toEqual([[40, 56, 0, 40]]);
    expect(s.groups[0]!.rows.map((x) => [x.cases, x.casesPerPallet, x.fullPallets, x.looseCases])).toEqual([[30, 56, 0, 30]]);
    expect(s.groups[0]!.pallets).toEqual({ full: 0, mixed: 1, casesWithoutFactor: 0 });
    expectInvariant(rows, s);
  });

  it('two products with loose cases share one mixed pallet; full pallets per product', () => {
    // 50 of 84 + 20 of 56 = 0.95 of a pallet.
    expect(blockPallets([row(50, 84), row(20, 56)])).toEqual({ full: 0, mixed: 1, casesWithoutFactor: 0 });
    // 100 at 84 = 1 full + 16 loose; 30 of 56 loose: 0.19 + 0.54 = 0.73 of a pallet.
    expect(blockPallets([row(100, 84), row(30, 56)])).toEqual({ full: 1, mixed: 1, casesWithoutFactor: 0 });
  });

  it('loose cases over one pallet: 2 mixed pallets; exactly one pallet stays 1 (the fractions added exactly)', () => {
    // 60 of 84 + 40 of 56 = 1.43 pallets.
    expect(blockPallets([row(60, 84), row(40, 56)])).toEqual({ full: 0, mixed: 2, casesWithoutFactor: 0 });
    // Half + half = 1.
    expect(blockPallets([row(42, 84), row(28, 56)])).toEqual({ full: 0, mixed: 1, casesWithoutFactor: 0 });
    // A third each = 1 (in 1/1000 pallets rounded up it would be 1.002, i.e. 2).
    expect(blockPallets([row(28, 84), row(14, 42), row(7, 21)])).toEqual({ full: 0, mixed: 1, casesWithoutFactor: 0 });
    expect(blockPallets([row(29, 84), row(14, 42), row(7, 21)])).toEqual({ full: 0, mixed: 2, casesWithoutFactor: 0 });
    // Large coprime factors, no rounding anywhere: 9,999 of 9,999 is a full pallet; 1 of 9,973 + 9,966 of 9,967 + 1 of 9,949 is over 1.
    expect(blockPallets([row(9999, 9999)])).toEqual({ full: 1, mixed: 0, casesWithoutFactor: 0 });
    expect(blockPallets([row(1, 9973), row(9966, 9967), row(1, 9949)])).toEqual({ full: 0, mixed: 2, casesWithoutFactor: 0 });
  });

  it('a product without cases per pallet (none, 0 or not a whole number): its cases counted separately, on no pallet', () => {
    expect(blockPallets([row(50, 84), row(12, null)])).toEqual({ full: 0, mixed: 1, casesWithoutFactor: 12 });
    expect(blockPallets([row(168, 84), row(5, 0), row(7, 84.5)])).toEqual({ full: 2, mixed: 0, casesWithoutFactor: 12 });
    expect(blockPallets([{ cases: 9 }])).toEqual({ full: 0, mixed: 0, casesWithoutFactor: 9 });
  });

  it('a block with only full pallets: no mixed pallet; nothing at all for no cases', () => {
    expect(blockPallets([row(168, 84), row(112, 56)])).toEqual({ full: 4, mixed: 0, casesWithoutFactor: 0 });
    expect(blockPallets([row(0, 84)])).toEqual({ full: 0, mixed: 0, casesWithoutFactor: 0 });
    expect(blockPallets([])).toEqual({ full: 0, mixed: 0, casesWithoutFactor: 0 });
  });

  it('the words: full and mixed pallets, a 0 part left out, cases without cases per pallet said so', () => {
    const p = (full: number, mixed: number, casesWithoutFactor = 0) => ({ full, mixed, casesWithoutFactor });
    expect(specialLinesPalletTotal(SPECIAL, 70, p(2, 1))).toBe('SPECIAL total: 70 cases - 2 full pallets + 1 mixed pallet (the loose cases of all SPECIAL products together)');
    expect(specialLinesPalletTotal(SPECIAL, 70, p(0, 1))).toBe('SPECIAL total: 70 cases - 1 mixed pallet (the loose cases of all SPECIAL products together)');
    expect(specialLinesPalletTotal(SPECIAL, 1100, p(0, 2))).toBe('SPECIAL total: 1,100 cases - 2 mixed pallets (the loose cases of all SPECIAL products together)');
    expect(specialLinesPalletTotal(SPECIAL, 280, p(4, 0))).toBe('SPECIAL total: 280 cases - 4 full pallets');
    expect(specialLinesPalletTotal(SPECIAL, 85, p(1, 0))).toBe('SPECIAL total: 85 cases - 1 full pallet');
    expect(specialLinesPalletTotal(SPECIAL, 62, p(0, 1, 12))).toBe(
      'SPECIAL total: 62 cases - 1 mixed pallet (the loose cases of all SPECIAL products together) + 12 cases of products without cases per pallet (counted separately)',
    );
    expect(specialLinesPalletTotal(SPECIAL, 1, p(0, 0, 1))).toBe('SPECIAL total: 1 case - 1 case of products without cases per pallet (counted separately)');
    expect(blockPalletsText(SPECIAL, p(0, 0))).toBe('');
    expect(specialLinesPalletTotal(SPECIAL, 0, p(0, 0))).toBe('SPECIAL total: 0 cases');
  });
});
