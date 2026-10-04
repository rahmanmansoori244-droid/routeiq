/**
 * Truck capacity in pallets (owner decision 4 Oct 2026), part B: the outputs. Orders, invoices and
 * stops stay in cases; a load planned by pallets (a truck with bays, the optimizer echoed the rule)
 * shows its pallets IN ADDITION, and only such a load:
 * - pallets.ts output helpers (load pallets, "11.1 / 12", the limit, bay fill, the manifest's full
 *   pallets + loose cases and its TOTAL words, the product-save note);
 * - the daily summary (pallets planned, average bay fill) and nothing new on a day without bays;
 * - the Excel workbook (LOAD PLAN column, the load sheet's pallets and manifest columns, SKU summary,
 *   SUMMARY rows, ASSUMPTIONS "Truck capacity" worded by the solver's echo);
 * - the driver sheet model (header and load check) and the PDF still renders;
 * - the WhatsApp text header.
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  bayFillPct,
  fullAndLooseText,
  loadPallets,
  manifestPalletTotals,
  manifestTotalText,
  palletFactorChangedNote,
  palletLimitText,
  palletsOverBays,
  palletValue,
  withManifestPallets,
} from '@/lib/dispatch/pallets';
import type { PlanDetail } from '@/lib/dispatch/plan-detail';
import { buildDispatchWorkbook, loadPalletsCell, solverRules, tenantAssumptions, type WorkbookMeta } from '@/lib/dispatch/workbook';
import { driverPackModel, renderDriverPackPdf } from '@/lib/dispatch/driver-pack';
import { whatsappText } from '@/lib/dispatch/driver-links';
import { computeSummary } from '@/lib/dispatch/summary';
import { readPortionPalletFactors } from '@/lib/dispatch/split';
import { CPP, fixture, palletFixture } from './plan-detail-fixture';

const META: WorkbookMeta = {
  tenantName: 'NMWC Test',
  currency: 'OMR',
  generatedAt: new Date('2026-10-04T13:05:00.000Z'),
  generatedBy: 'Planner One',
  assumptions: { Timezone: 'Asia/Muscat' },
};

async function render(d: PlanDetail) {
  const buf = await buildDispatchWorkbook(d, META);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  return wb;
}

const text = (c: ExcelJS.Cell) => (c.value === null || c.value === undefined ? '' : c.text);

function cells(ws: ExcelJS.Worksheet) {
  const out: { row: number; col: number; text: string; value: ExcelJS.CellValue }[] = [];
  ws.eachRow((row, r) => row.eachCell((c, col) => out.push({ row: r, col, text: text(c), value: c.value })));
  return out;
}

/** A row's texts, one per column (a merged cell once). */
const rowOf = (ws: ExcelJS.Worksheet, r: number) => {
  const out: string[] = [];
  ws.getRow(r).eachCell((c) => {
    if (!c.isMerged || c.master === c) out.push(text(c));
  });
  return out;
};
/** The long truck's load sheet (its sheet name is shortened). */
const longTruckSheet = (wb: ExcelJS.Workbook) => wb.worksheets.find((w) => w.name.endsWith(' - L1') && w.name !== 'T01 - L1')!;
const findCell = (ws: ExcelJS.Worksheet, t: string) => cells(ws).find((c) => c.text === t);

describe('pallets.ts output helpers', () => {
  it('a load is shown by pallets only with its stored pallets, bays and room (else cases only)', () => {
    expect(loadPallets({ palletUnits: 11_100, bays: 12, palletRoomUnits: 11_400, palletFillPct: 95 })).toEqual({ units: 11_100, room: 11_400, bays: 12, fillPct: 95 });
    expect(loadPallets({ palletUnits: null, bays: 12, palletRoomUnits: 11_400 })).toBeNull();
    expect(loadPallets({ palletUnits: 11_100, bays: null, palletRoomUnits: 11_400 })).toBeNull();
    expect(loadPallets({ palletUnits: 11_100, bays: 12, palletRoomUnits: undefined })).toBeNull();
    expect(loadPallets({})).toBeNull();
    const p = loadPallets({ palletUnits: 11_100, bays: 12, palletRoomUnits: 11_400, palletFillPct: 95 })!;
    expect(palletsOverBays(p)).toBe('11.1 / 12');
    expect(palletLimitText(p)).toBe('limit 11.4 at 95% fill');
    expect(palletLimitText({ ...p, fillPct: null })).toBe('limit 11.4');
  });

  it('bay fill is against the physical bays (95% fill reads 95%, never 100%)', () => {
    expect(bayFillPct(11_400, 12)).toBe(95);
    expect(bayFillPct(1_562, 2)).toBe(78.1);
    expect(bayFillPct(0, 12)).toBe(0);
    expect(bayFillPct(500, 0)).toBe(0);
    expect(palletValue(11_450)).toBe(11.5);
    expect(palletValue(143_919)).toBe(143.9);
  });

  it('the manifest: each product in full pallets + loose cases, the TOTAL in cases and pallets', () => {
    // The spec's example: JA0.5L at 96 per pallet, 300 cases = 3 pallets + 12 cases.
    const rows = withManifestPallets(
      [
        { productCode: 'JA0.5L', productName: 'JA0.5L', cases: 300, weightKg: 2_970 },
        { productCode: 'TN1.5L', productName: 'TN1.5L', cases: 50, weightKg: 600 },
      ],
      { unitsByCode: new Map([['JA0.5L', 3_125], ['TN1.5L', 1_283]]), factorByCode: new Map([['JA0.5L', 96], ['TN1.5L', 39]]) },
    );
    expect(rows[0]).toMatchObject({ casesPerPallet: 96, fullPallets: 3, looseCases: 12, palletUnits: 3_125 });
    expect(rows[1]).toMatchObject({ casesPerPallet: 39, fullPallets: 1, looseCases: 11, palletUnits: 1_283 });
    expect(fullAndLooseText(300, 96)).toBe('3 pallets + 12 cases');
    const totals = manifestPalletTotals(rows);
    expect(totals).toEqual({ full: 4, loose: 23 });
    expect(manifestTotalText(350, 4_408, totals)).toBe('350 cases = 4.4 pallets (4 full pallets + 23 loose cases on mixed pallets)');
    expect(manifestTotalText(1_045, 11_100, { full: 8, loose: 293 })).toBe('1,045 cases = 11.1 pallets (8 full pallets + 293 loose cases on mixed pallets)');
    expect(manifestTotalText(84, 1_000, { full: 1, loose: 0 })).toBe('84 cases = 1.0 pallets (1 full pallet)');
    // A load planned by cases keeps its rows as they are.
    const plain = [{ productCode: 'X', productName: 'X', cases: 5, weightKg: 1 }];
    expect(withManifestPallets(plain, null)).toBe(plain);
  });

  it('a product save says what a changed cases per pallet does', () => {
    expect(palletFactorChangedNote(84, 84)).toBeNull();
    expect(palletFactorChangedNote(null, null)).toBeNull();
    expect(palletFactorChangedNote(null, 84)).toMatch(/Loads planned before keep the pallets they were planned with; re-plan to use it/);
    expect(palletFactorChangedNote(39, 40)).toMatch(/re-plan to use it/);
    expect(palletFactorChangedNote(84, null)).toMatch(/cannot be optimized while this product is on its orders/);
  });

  it('a split portion keeps the factor each line was cut with', () => {
    const m = readPortionPalletFactors([{ lineId: 'a', cases: 10, casesPerPallet: 84 }, { lineId: 'b', cases: 5 }, { lineId: 'c', cases: 1, casesPerPallet: 84.5 }]);
    expect([...m]).toEqual([['a', 84]]);
    expect(readPortionPalletFactors(null).size).toBe(0);
  });
});

describe('daily summary with pallets', () => {
  it('adds the pallets planned and the average bay fill of the loads planned by pallets', () => {
    const d = palletFixture();
    // T01 L1: TAN 50 (596) + 30 (358), JAB 20 (358), 5G 10 (250) = 1,562; long truck: 1,191 + 447 + 125 = 1,763.
    expect(d.loads.map((l) => l.palletUnits ?? null)).toEqual([1_562, null, 1_763]);
    expect(d.summary!.palletUnits).toBe(3_325);
    expect(d.summary!.palletLoads).toBe(2);
    // (1,562 / 2 bays = 78.1% + 1,763 / 12 bays = 14.7%) / 2.
    expect(d.summary!.avgBayFillPct).toBe(46.4);
  });

  it('a day without loads planned by pallets has the summary it always had (no new keys)', () => {
    const s = fixture().summary!;
    expect(s).not.toHaveProperty('palletUnits');
    expect(s).not.toHaveProperty('avgBayFillPct');
    expect(s).not.toHaveProperty('palletLoads');
    const again = computeSummary({
      orders: [],
      plannedOrderIds: new Set(),
      unserved: [],
      loads: [{ truckId: 't', loadNo: 1, cases: 5, weightKg: 1, distanceKm: 1, durationMin: 1, utilizationPct: 1, fuelLitres: null, fuelCost: 0, operatingCost: 0, status: 'PLANNED', palletUnits: 900, bays: null }],
      warnings: [],
      distanceIsEstimated: false,
      distanceProvider: 'OSRM',
      solver: null,
    });
    expect(again).not.toHaveProperty('palletUnits');
  });
});

describe('Excel workbook with pallets', () => {
  it('LOAD PLAN: a "Pallets / bays" column for the loads planned by pallets, "by cases" for the others, the total in pallets', async () => {
    const wb = await render(palletFixture());
    const ws = wb.getWorksheet('LOAD PLAN')!;
    const heads = rowOf(ws, 4);
    expect(heads.slice(7, 11)).toEqual(['Cases', 'Capacity (cases)', 'Pallets / bays', 'Weight kg']);
    const col = heads.indexOf('Pallets / bays') + 1;
    expect(ws.getCell(5, col).text).toBe('1.6 / 2 (limit 1.9 at 95% fill)');
    expect(ws.getCell(5, col - 1).text).toBe('by pallets'); // the case capacity is not used
    expect(ws.getCell(6, col).text).toBe('by cases');
    expect(ws.getCell(6, col - 1).value).toBe(600);
    expect(ws.getCell(7, col).text).toBe('1.8 / 12 (limit 11.4 at 95% fill)');
    expect(ws.getCell(8, 1).text).toBe('TOTAL');
    expect(ws.getCell(8, col).text).toBe('3.3 pallets');
  });

  it('LOAD PLAN keeps its columns when no load was planned by pallets', async () => {
    const wb = await render(fixture());
    const heads = rowOf(wb.getWorksheet('LOAD PLAN')!, 4);
    expect(heads).not.toContain('Pallets / bays');
    expect(heads.slice(7, 10)).toEqual(['Cases', 'Capacity (cases)', 'Weight kg']);
  });

  it('a load sheet planned by pallets: cases · pallets / bays in the header, the manifest per product in pallets + loose cases, the TOTAL words', async () => {
    const d = palletFixture();
    const wb = await render(d);
    const ws = longTruckSheet(wb);
    const label = findCell(ws, 'Cases · pallets / bays')!;
    expect(ws.getCell(label.row, 9).text).toBe('130 · 1.8 / 12 (limit 11.4 at 95% fill)');
    expect(findCell(ws, 'Cases / capacity')).toBeUndefined();
    const head = findCell(ws, 'Cases per pallet')!;
    const colOf = (t: string) => cells(ws).find((c) => c.row === head.row && c.text === t)!.col;
    expect(['Cases', 'Cases per pallet', 'Full pallets', 'Loose cases', 'Pallets', 'Kg', 'Loaded'].map(colOf)).toEqual([5, 6, 7, 8, 9, 10, 11]);
    // TAN-500-24: 100 cases at 84 = 1 full pallet + 16 loose cases, 1.191 pallets (the cell shows 1.2).
    const tan = cells(ws).find((c) => c.row > head.row && c.text === 'TAN-500-24')!;
    expect([5, 6, 7, 8, 9, 10].map((c) => ws.getCell(tan.row, c).value)).toEqual([100, 84, 1, 16, 1.191, 1200]);
    expect(ws.getCell(tan.row, 9).numFmt).toBe('0.0');
    const total = cells(ws).find((c) => c.row > head.row && c.text === 'TOTAL')!;
    expect([5, 7, 8, 9].map((c) => ws.getCell(total.row, c).value)).toEqual([130, 1, 46, 1.763]);
    expect(ws.getCell(total.row, 10).value).toBe(d.loads[2]!.weightKg);
    expect(ws.getCell(total.row + 1, 2).text).toBe('130 cases = 1.8 pallets (1 full pallet + 46 loose cases on mixed pallets)');
  });

  it('the pallet cells hold the exact pallets (shown to 0.1): the column adds up to its TOTAL (pallets review)', async () => {
    // Before: each product's cell was rounded to 0.1 (1.2 + 0.4 + 0.1 = 1.7) under a TOTAL of 1.8.
    const wb = await render(palletFixture());
    const ws = longTruckSheet(wb);
    const head = findCell(ws, 'Cases per pallet')!;
    const total = cells(ws).find((c) => c.row > head.row && c.text === 'TOTAL')!;
    let products = 0;
    for (let r = head.row + 1; r < total.row; r++) products += ws.getCell(r, 9).value as number;
    expect(products).toBeCloseTo(ws.getCell(total.row, 9).value as number, 9);
    // SKU LOADING SUMMARY: the loads' pallets add up to the total too (before: 1.6 + 1.8 under 3.3).
    const sku = wb.getWorksheet('SKU LOADING SUMMARY')!;
    const p = findCell(sku, 'Pallets (plan)')!;
    const vals = cells(sku).filter((c) => c.row === p.row && typeof c.value === 'number').map((c) => c.value as number);
    expect(vals[0]! + vals[1]!).toBeCloseTo(vals[2]!, 9);
  });

  it('a load sheet planned by pallets keeps the header block on rows 4-9: the driver break on row 10 is not cut off (pallets review)', async () => {
    // Before: "Pallets / bays" was a 7th header row on row 10, F10 / I10, where the driver break's text in D10 overflows.
    const d = palletFixture();
    d.loads[2]!.break = { v: 1, startMin: 720, endMin: 780, lengthMin: 60, where: 'DEPOT', afterSequence: null };
    const wb = await render(d);
    const ws = longTruckSheet(wb);
    expect(ws.getCell(10, 1).text).toBe('Driver break');
    expect(ws.getCell(10, 4).text).toMatch(/^12:00-13:00 /);
    for (let c = 5; c <= 20; c++) expect(ws.getCell(10, c).value ?? null, `row 10, column ${c}`).toBeNull();
    const label = findCell(ws, 'Cases · pallets / bays')!;
    expect(label.row).toBeLessThanOrEqual(9);
  });

  it('a load sheet planned by cases is unchanged (cases / capacity, no pallet columns)', async () => {
    const wb = await render(palletFixture());
    const ws = wb.getWorksheet('T01 - L2')!;
    expect(findCell(ws, 'Cases / capacity')).toBeTruthy();
    expect(findCell(ws, 'Cases · pallets / bays')).toBeUndefined();
    expect(findCell(ws, 'Cases per pallet')).toBeUndefined();
  });

  it('SKU LOADING SUMMARY: a Pallets row and the bays per load; SUMMARY: pallets planned and bay fill', async () => {
    const wb = await render(palletFixture());
    const sku = wb.getWorksheet('SKU LOADING SUMMARY')!;
    const p = findCell(sku, 'Pallets (plan)')!;
    // Exact pallets, shown to 0.1 by the cell format.
    expect(cells(sku).filter((c) => c.row === p.row).map((c) => c.value)).toEqual(['Pallets (plan)', 'mixed pallets: cases / cases per pallet, added up', 1.562, 1.763, 3.325]);
    const b = findCell(sku, 'Bays')!;
    expect(cells(sku).filter((c) => c.row === b.row).map((c) => c.value)).toEqual(['Bays', 'pallet positions of the truck', 2, 12]);
    const sum = wb.getWorksheet('SUMMARY')!;
    const planned = findCell(sum, 'Pallets planned')!;
    expect(sum.getCell(planned.row, 2).value).toBe(3.325);
    expect(sum.getCell(planned.row, 2).numFmt).toBe('0.0');
    expect(sum.getCell(planned.row, 3).text).toMatch(/^on 2 loads of trucks with bays/);
    const fill = findCell(sum, 'Average bay fill %')!;
    expect(sum.getCell(fill.row, 2).value).toBe(46.4);
    const plain = await render(fixture());
    expect(findCell(plain.getWorksheet('SUMMARY')!, 'Pallets planned')).toBeUndefined();
    expect(findCell(plain.getWorksheet('SKU LOADING SUMMARY')!, 'Pallets (plan)')).toBeUndefined();
  });

  it('ASSUMPTIONS: "Truck capacity" is worded by the rule the optimizer reported, never by the settings', () => {
    const cfg = {
      timezone: 'Asia/Muscat', planningCutoffMin: 1080, shiftStartMin: 360, driverShiftMaxMinutes: 540, reloadMinutes: 30,
      maxTripsPerTruck: 3, fuelPricePerLitre: 0.25, driverCostPerHour: 1.5, overtimeAfterMin: 540, overtimeCostPerHour: 0,
      prefWindowPenaltyPerMin: 0.05, roadTimeFactor: 1.25, distanceProvider: 'OSRM', distanceMultiplier: 1.3, avgSpeedKmh: 40,
      defaultServiceTimeMin: 10,
    };
    const rules = solverRules(palletFixture());
    expect(rules.pallets).toEqual({ fillPct: 95 });
    const a = tenantAssumptions(cfg, { currency: 'OMR', providerUsed: 'OSRM', distanceIsEstimated: false, solverRules: rules });
    expect(a['Truck capacity']).toMatch(/^trucks with bays: pallets up to bays x 95% \(Pallet fill\) and the payload/);
    expect(a['Truck capacity']).toMatch(/mixed pallets; each order line rounded up to 0.001 pallet/);
    const none = tenantAssumptions(cfg, { currency: 'OMR', providerUsed: 'OSRM', distanceIsEstimated: false, solverRules: solverRules(fixture()) });
    expect(none['Truck capacity']).toBe('cases and payload (no truck of this plan was planned by pallets)');
  });

  it('loadPalletsCell is empty for a load planned by cases', () => {
    const d = palletFixture();
    expect(loadPalletsCell(d.loads[0]!)).toBe('1.6 / 2 (limit 1.9 at 95% fill)');
    expect(loadPalletsCell(d.loads[1]!)).toBe('');
  });

  it('the manifest says when a cases per pallet changed after planning', async () => {
    const d = palletFixture();
    d.loads[2]!.palletNotes = ['Changed after planning: cases per pallet of TAN-500-24 is now 90 (planned with 84). This load keeps the pallets it was planned with; re-plan to use the new figure.'];
    const wb = await render(d);
    const ws = longTruckSheet(wb);
    expect(cells(ws).some((c) => c.text.startsWith('Changed after planning: cases per pallet of TAN-500-24 is now 90'))).toBe(true);
  });
});

describe('driver sheet and WhatsApp with pallets', () => {
  it('the driver sheet shows pallets / bays beside the cases, and the load check in pallets too; a load by cases keeps cases / capacity', async () => {
    const d = palletFixture();
    const m = driverPackModel(d, { tenantName: 'NMWC Test' });
    expect(m.sheets.map((s) => s.pallets)).toEqual([{ overBays: '1.6 / 2', total: '1.6' }, null, { overBays: '1.8 / 12', total: '1.8' }]);
    // The stops stay in cases.
    expect(m.sheets[0]!.stops.map((s) => s.cases)).toEqual([70, 40]);
    const pdf = await renderDriverPackPdf(m);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('WhatsApp: "· 1.6 pallets" in the header of a load planned by pallets only', () => {
    const d = palletFixture();
    const one = whatsappText(d.run, d.loads[0]!, 2).split('\n');
    expect(one).toContain('Depart 06:00 · 2 stops · 110 cases · 1.6 pallets');
    const two = whatsappText(d.run, d.loads[1]!, 2).split('\n');
    expect(two).toContain('Depart 10:00 · 2 stops · 100 cases');
  });

  it('the fixture factors match the products (sanity)', () => {
    expect(CPP['TAN-500-24']).toBe(84);
  });
});
