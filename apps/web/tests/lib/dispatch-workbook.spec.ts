/**
 * NMWC master dispatch workbook - pure (no DB). Renders the workbook from the shared PlanDetail
 * fixture (plan-detail-fixture.ts), loads it back with exceljs and checks what the warehouse and
 * dispatcher rely on.
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { PlanDetail } from '@/lib/dispatch/plan-detail';
import { buildDispatchWorkbook, loadSheetName, SHEETS, tenantAssumptions, type WorkbookMeta } from '@/lib/dispatch/workbook';
import { fixture, LONG_TRUCK } from './plan-detail-fixture';

const META: WorkbookMeta = {
  tenantName: 'NMWC Test',
  currency: 'OMR',
  generatedAt: new Date('2026-09-24T13:05:00.000Z'),
  generatedBy: 'Planner One',
  assumptions: { Timezone: 'Asia/Muscat', 'Max trips per truck per day': '3' },
};

async function render(d: PlanDetail, meta: WorkbookMeta = META) {
  const buf = await buildDispatchWorkbook(d, meta);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  return wb;
}

const text = (c: ExcelJS.Cell) => (c.value === null || c.value === undefined ? '' : c.text);

/** Every non-empty cell as {row, col, text, value}. */
function cells(ws: ExcelJS.Worksheet) {
  const out: { row: number; col: number; text: string; value: ExcelJS.CellValue }[] = [];
  ws.eachRow((row, r) => row.eachCell((c, col) => out.push({ row: r, col, text: text(c), value: c.value })));
  return out;
}

function find(ws: ExcelJS.Worksheet, pred: (t: string) => boolean, col?: number, afterRow = 0) {
  return cells(ws).find((c) => c.row > afterRow && (col === undefined || c.col === col) && pred(c.text));
}

function sheet(wb: ExcelJS.Workbook, name: string) {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`missing sheet ${name}`);
  return ws;
}

// ---------------------------------------------------------------------------------------

describe('buildDispatchWorkbook', () => {
  it('writes the sheets in the agreed order, one per load', async () => {
    const d = fixture();
    const wb = await render(d);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual([
      'SUMMARY',
      'LOAD PLAN',
      'T01 - L1',
      'T01 - L2',
      loadSheetName(LONG_TRUCK, 1, new Set()),
      'SKU LOADING SUMMARY',
      'UNSERVED - EXCEPTIONS',
      'RECONCILIATION',
      'ASSUMPTIONS',
    ]);
  });

  it('sanitises load sheet names (no []:*?/\\, max 31 chars, unique)', async () => {
    const wb = await render(fixture());
    const names = wb.worksheets.map((w) => w.name);
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(31);
      expect(n).not.toMatch(/[[\]:*?/\\]/);
    }
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    const long = names[4];
    expect(long).toBe('MCT-TRUCK-02-EXTRA-LONG-FL - L1');
    expect(long.endsWith(' - L1')).toBe(true);

    const used = new Set<string>();
    const a = loadSheetName('A/B:C*D?E[F]G\\H-VERY-LONG-TRUCK-CODE-1', 1, used);
    const b = loadSheetName('A/B:C*D?E[F]G\\H-VERY-LONG-TRUCK-CODE-2', 1, used);
    expect(a).not.toBe(b);
    for (const n of [a, b]) {
      expect(n.length).toBeLessThanOrEqual(31);
      expect(n).not.toMatch(/[[\]:*?/\\]/);
    }
    expect(loadSheetName("'quoted'", 2, new Set())).not.toMatch(/^'|'$/);
    // Same truck + load twice (e.g. codes differing only by case) still gives unique names.
    const u = new Set<string>();
    const n1 = loadSheetName('t01', 1, u);
    const n2 = loadSheetName('T01', 1, u);
    expect(n1.toLowerCase()).not.toBe(n2.toLowerCase());
    expect(n2).toBe('T01 - L1 (2)');
  });

  it('every load sheet: manifest TOTAL = load cases, route has DEPOT start/end and stop details', async () => {
    const d = fixture();
    const wb = await render(d);
    const used = new Set<string>(Object.values(SHEETS).map((s) => s.toLowerCase()));
    for (const l of d.loads) {
      const ws = sheet(wb, loadSheetName(l.truckCode, l.loadNo, used));
      const manifestTitle = find(ws, (t) => t === 'LOADING MANIFEST', 1)!;
      const routeTitle = find(ws, (t) => t === 'DELIVERY ROUTE', 1)!;
      expect(manifestTitle && routeTitle).toBeTruthy();

      const total = find(ws, (t) => t === 'TOTAL', 2, manifestTitle.row)!;
      expect(total.row).toBeLessThan(routeTitle.row);
      expect(ws.getCell(total.row, 5).value).toBe(l.cases);
      // Manifest lines sum to the TOTAL row.
      let lines = 0;
      for (let r = manifestTitle.row + 2; r < total.row; r++) lines += Number(ws.getCell(r, 5).value);
      expect(lines).toBe(l.cases);

      // Route: DEPOT, stops in sequence, DEPOT, TOTAL.
      const head = routeTitle.row + 1;
      expect(text(ws.getCell(head, 13))).toBe('SKUs');
      expect(text(ws.getCell(head + 1, 2))).toBe('DEPOT');
      l.stops.forEach((s, i) => {
        const r = head + 2 + i;
        expect(ws.getCell(r, 1).value).toBe(s.sequence);
        expect(text(ws.getCell(r, 2))).toBe(s.customerCode);
        expect(text(ws.getCell(r, 5))).toBe(`P${s.priority}`);
        expect(ws.getCell(r, 11).value).toBe(s.cases);
        expect(text(ws.getCell(r, 13))).toBe(s.skus.map((k) => `${k.productCode} x${k.cases}`).join('; '));
        expect((ws.getCell(r, 17).value as ExcelJS.CellHyperlinkValue).hyperlink).toBe(s.mapsUrl);
      });
      const ret = head + 2 + l.stops.length;
      expect(text(ws.getCell(ret, 2))).toBe('DEPOT');
      expect(ws.getCell(ret, 15).value).toBe(l.returnLegKm);
      expect(ws.getCell(ret + 1, 11).value).toBe(l.cases);
      expect(find(ws, (t) => t.startsWith('Loaded by'))).toBeTruthy();
      expect(find(ws, (t) => t.startsWith('Driver (name'))).toBeTruthy();
      expect(ws.pageSetup.orientation).toBe('landscape');
      expect(ws.pageSetup.fitToWidth).toBe(1);
    }
    // Multi-SKU stop text in the agreed style.
    const t1 = sheet(wb, 'T01 - L1');
    expect(find(t1, (t) => t === 'TAN-500-24 x50; JAB-1500-6 x20', 13)).toBeTruthy();
  });

  it('SKU LOADING SUMMARY totals equal the sum of the loads', async () => {
    const d = fixture();
    const wb = await render(d);
    const ws = sheet(wb, SHEETS.skuSummary);
    const n = d.loads.length;
    expect([...Array(n).keys()].map((i) => text(ws.getCell(4, 3 + i)))).toEqual(['T01-L1', 'T01-L2', `${LONG_TRUCK}-L1`]);
    const total = find(ws, (t) => t === 'TOTAL', 1)!;
    for (let i = 0; i < n; i++) {
      expect(ws.getCell(total.row, 3 + i).value).toBe(d.loads[i].cases);
      let col = 0;
      for (let r = 5; r < total.row; r++) col += Number(ws.getCell(r, 3 + i).value ?? 0);
      expect(col).toBe(d.loads[i].cases);
    }
    const all = d.loads.reduce((a, l) => a + l.cases, 0);
    expect(ws.getCell(total.row, 3 + n).value).toBe(all);
    expect(total.row - 5).toBe(3); // three distinct SKUs
    const check = find(ws, (t) => t === 'Check', 1)!;
    for (let i = 0; i <= n; i++) expect(text(ws.getCell(check.row, 3 + i))).toBe('OK');
  });

  it('UNSERVED sheet lists the unserved order with its reason', async () => {
    const wb = await render(fixture());
    const ws = sheet(wb, SHEETS.unserved);
    const row = find(ws, (t) => t === 'C005', 1)!;
    expect(row).toBeTruthy();
    expect(text(ws.getCell(row.row, 4))).toBe('P4');
    expect(ws.getCell(row.row, 5).value).toBe(15);
    expect(text(ws.getCell(row.row, 7))).toBe('SO-1005');
    expect(text(ws.getCell(row.row, 8))).toBe('LATE');
    expect(text(ws.getCell(row.row, 9))).toBe('MISSING_COORDINATES');
    expect(text(ws.getCell(row.row, 10))).toContain('no delivery location');
    expect(find(ws, (t) => t === 'All orders planned')).toBeUndefined();
  });

  it('UNSERVED sheet says "All orders planned" when nothing is unserved', async () => {
    const wb = await render(fixture({ noUnserved: true }));
    expect(find(sheet(wb, SHEETS.unserved), (t) => t === 'All orders planned')).toBeTruthy();
    expect(text(sheet(wb, SHEETS.reconciliation).getCell(6, 2))).toBe('OK');
  });

  it('labels distances "Estimated km" only when they are estimated', async () => {
    const road = await render(fixture({ estimated: false }));
    expect(find(sheet(road, SHEETS.summary), (t) => t === 'Total road km', 1)).toBeTruthy();
    expect(find(sheet(road, SHEETS.summary), (t) => t === 'Estimated km', 1)).toBeUndefined();
    expect(find(sheet(road, SHEETS.loadPlan), (t) => t === 'Route km', undefined)).toBeTruthy();
    expect(find(sheet(road, 'T01 - L1'), (t) => t === 'Route km', 6)).toBeTruthy();

    const dEst = fixture({ estimated: true });
    const est = await render(dEst);
    const s = sheet(est, SHEETS.summary);
    const label = find(s, (t) => t === 'Estimated km', 1)!;
    expect(label).toBeTruthy();
    expect(s.getCell(label.row, 2).value).toBe(dEst.summary!.totalKm);
    expect(find(s, (t) => t === 'Total road km', 1)).toBeUndefined();
    expect(find(sheet(est, SHEETS.loadPlan), (t) => t === 'Estimated km')).toBeTruthy();
    expect(find(sheet(est, 'T01 - L1'), (t) => t === 'Estimated km', 6)).toBeTruthy();
    expect(find(sheet(est, 'T01 - L1'), (t) => t === 'Km from prev (est.)')).toBeTruthy();
  });

  it('shows "not supplied" for revenue and margin when they are missing, and the numbers when present', async () => {
    const wb = await render(fixture({ revenue: false }));
    const s = sheet(wb, SHEETS.summary);
    const rev = find(s, (t) => t.startsWith('Revenue served'), 1)!;
    const mar = find(s, (t) => t.startsWith('Contribution margin served'), 1)!;
    expect(text(s.getCell(rev.row, 2))).toBe('not supplied');
    expect(text(s.getCell(mar.row, 2))).toBe('not supplied');

    const d = fixture({ revenue: true });
    const s2 = sheet(await render(d), SHEETS.summary);
    const rev2 = find(s2, (t) => t.startsWith('Revenue served'), 1)!;
    const mar2 = find(s2, (t) => t.startsWith('Contribution margin served'), 1)!;
    expect(s2.getCell(rev2.row, 2).value).toBe(d.summary!.revenueServed);
    expect(s2.getCell(mar2.row, 2).value).toBe(d.summary!.marginServed);
    expect(s2.getCell(mar2.row, 2).numFmt).toBe('0.000');
  });

  it('SUMMARY carries the plan header, KPIs, reconciliation status and change text', async () => {
    const d = fixture();
    const s = sheet(await render(d), SHEETS.summary);
    const val = (label: string) => {
      const c = find(s, (t) => t === label, 1);
      if (!c) throw new Error(`no ${label}`);
      return s.getCell(c.row, 2);
    };
    expect(text(s.getCell(1, 1))).toBe('NMWC Daily Dispatch Plan');
    expect(text(val('Depot'))).toBe('MCT - Muscat Depot');
    expect(text(val('Delivery date'))).toBe('2026-09-25');
    expect(text(val('Plan version'))).toBe('v2');
    expect(text(val('Plan reason'))).toBe('LATE_ORDER');
    expect(text(val('Generated at'))).toBe('2026-09-24 17:05'); // Asia/Muscat = UTC+4
    expect(val('Total orders').value).toBe(6);
    expect(val('Orders unserved').value).toBe(1);
    expect(val('P1 service %').value).toBe(100);
    expect(text(val('P5 service %'))).toBe('—');
    expect(val('Physical trucks used').value).toBe(2);
    expect(val('Total trips (loads)').value).toBe(3);
    expect(text(val('Late orders (served / total)'))).toBe('1 / 2');
    expect(text(val('Status'))).toBe('OK');
    expect(find(s, (t) => t.startsWith('1 order added'))).toBeTruthy();
  });

  it('RECONCILIATION shows totals, by SKU, by sales order; ASSUMPTIONS has settings and fixed notes', async () => {
    const d = fixture();
    const wb = await render(d);
    const r = sheet(wb, SHEETS.reconciliation);
    const rc = d.reconciliation!;
    expect(rc.ok).toBe(true);
    expect([r.getCell(4, 3).value, r.getCell(4, 4).value, r.getCell(4, 5).value]).toEqual([rc.uploadedCases, rc.plannedCases, rc.unservedCases]);
    expect(text(r.getCell(4, 6))).toBe('OK');
    expect(text(r.getCell(6, 2))).toBe('OK');
    for (const x of rc.bySku) expect(find(r, (t) => t === x.key, 1)).toBeTruthy();
    for (const x of rc.bySalesOrder) expect(find(r, (t) => t === x.key, 1)).toBeTruthy();
    expect(find(r, (t) => t === 'MISMATCH')).toBeUndefined();

    const a = sheet(wb, SHEETS.assumptions);
    expect(find(a, (t) => t === 'Max trips per truck per day', 1)).toBeTruthy();
    expect(find(a, (t) => t.includes('not a proven optimum'))).toBeTruthy();
    expect(find(a, (t) => t.includes('P1 = HIGHEST'))).toBeTruthy();
    expect(find(a, (t) => t.includes('Preferred windows are soft'))).toBeTruthy();
    expect(find(a, (t) => t.includes('counted once'))).toBeTruthy();
  });

  it('flags a load whose manifest does not match its recorded cases', async () => {
    const d = fixture();
    d.loads[0] = { ...d.loads[0], cases: d.loads[0].cases + 1 };
    const wb = await render(d);
    expect(text(sheet(wb, SHEETS.summary).getCell(find(sheet(wb, SHEETS.summary), (t) => t === 'Status', 1)!.row, 2))).toBe('FAILED');
    expect(find(sheet(wb, 'T01 - L1'), (t) => t.startsWith('MISMATCH'))).toBeTruthy();
    expect(find(sheet(wb, SHEETS.skuSummary), (t) => t === 'MISMATCH')).toBeTruthy();
  });
});

describe('tenantAssumptions', () => {
  it('reports the tenant settings the plan was built with', () => {
    const a = tenantAssumptions(
      {
        timezone: 'Asia/Muscat', planningCutoffMin: 1080, shiftStartMin: 360, driverShiftMaxMinutes: 540, reloadMinutes: 30,
        maxTripsPerTruck: 3, fuelPricePerLitre: 0.25, driverCostPerHour: 1.5, overtimeAfterMin: 540, overtimeCostPerHour: 0,
        prefWindowPenaltyPerMin: 0.05, roadTimeFactor: 1.25, distanceProvider: 'OSRM', distanceMultiplier: 1.3, avgSpeedKmh: 40,
        defaultServiceTimeMin: 10, osrmUrl: null, priorityWeightsJson: null,
      },
      { currency: 'OMR', providerUsed: 'OSRM', distanceIsEstimated: false, osrmEnvConfigured: false },
    );
    expect(a['Planning cutoff (day before delivery)']).toContain('18:00');
    expect(a['Shift start (earliest departure)']).toBe('06:00');
    expect(a['Fuel price']).toBe('0.25 OMR per litre');
    // The planner ranks priorities strictly (the weights are no longer used): the export says so.
    expect(a.Priorities).toMatch(/^strict - one higher-priority order always wins/);
    expect(a['Priority weights']).toBeUndefined();
    expect(a['Loading time per case']).toBe('not set (0)');
    expect(a['OSRM server configured']).toMatch(/^no/);
    expect(a['Estimated-distance multiplier']).toBeUndefined();
    expect(tenantAssumptions(null, { currency: 'OMR', providerUsed: null, distanceIsEstimated: null, osrmEnvConfigured: false })).toEqual({
      'Tenant configuration': 'not set - system defaults were used',
    });
  });
});

describe('frozen plan facts, kg check and unverified times in the workbook (review F08 / F04)', () => {
  it('ASSUMPTIONS says whether it shows the settings the plan was built with or the current ones', async () => {
    const planned = sheet(await render(fixture(), { ...META, assumptionsSource: 'PLAN' }), SHEETS.assumptions);
    expect(text(planned.getCell(2, 1))).toBe('Settings this plan (v2) was built and costed with.');
    const current = sheet(await render(fixture(), { ...META, assumptionsSource: 'CURRENT' }), SHEETS.assumptions);
    expect(text(current.getCell(2, 1))).toMatch(/^Current settings, at export time\. Plan v2 was made before its settings were stored with it/);
  });

  it('the settings kept with a plan feed the same assumptions (OSRM address never kept, only whether one was set)', () => {
    const a = tenantAssumptions(
      {
        timezone: 'Asia/Muscat', planningCutoffMin: 1080, shiftStartMin: 390, driverShiftMaxMinutes: 600, reloadMinutes: 20, loadingMinPerCase: 0.04,
        serviceMinPerCase: 0.05, maxTripsPerTruck: 3, fuelPricePerLitre: 0.25, driverCostPerHour: 1.5, overtimeAfterMin: 540, overtimeCostPerHour: 0,
        prefWindowPenaltyPerMin: 0.05, roadTimeFactor: 1.25, distanceProvider: 'OSRM', distanceMultiplier: 1.3, avgSpeedKmh: 40,
        defaultServiceTimeMin: 10, osrmConfigured: true,
      },
      { currency: 'OMR', providerUsed: 'OSRM', distanceIsEstimated: false, osrmEnvConfigured: false },
    );
    expect(a['Shift start (earliest departure)']).toBe('06:30');
    expect(a['Loading time per case']).toMatch(/^0\.04 min per case/);
    expect(a['OSRM server configured']).toBe('yes (tenant setting)');
  });

  it('LOAD PLAN checks each load kg against its stops and the payload', async () => {
    const d = fixture();
    d.loads[0] = { ...d.loads[0], truckPayloadKg: 500 }; // L1 weighs 790 + 560 = 1,350 kg
    const wb = await render(d);
    const lp = sheet(wb, SHEETS.loadPlan);
    const col = find(lp, (t) => t === 'Kg check')!.col;
    expect(text(lp.getCell(5, col))).toBe('OVER PAYLOAD by 850 kg');
    expect(text(lp.getCell(6, col))).toBe('OK');
    expect(text(sheet(wb, 'T01 - L1').getCell(5, 9))).toMatch(/OVER PAYLOAD/);
    const mism = fixture();
    mism.loads[1] = { ...mism.loads[1], weightKg: mism.loads[1].weightKg + 50 };
    const lp2 = sheet(await render(mism), SHEETS.loadPlan);
    expect(text(lp2.getCell(6, col))).toMatch(/^MISMATCH: stops add up to/);
  });

  it('a stop whose master data changed after planning says so in its own column', async () => {
    const d = fixture();
    d.loads[0].stops[0] = { ...d.loads[0].stops[0], masterChanged: [{ kind: 'LOCATION', text: 'Location updated after planning: new pin 23.60100, 58.39000 (1.8 km from the planned one)' }] };
    const ws = sheet(await render(d), 'T01 - L1');
    const head = find(ws, (t) => t === 'Changed after planning')!;
    expect(text(ws.getCell(head.row + 2, head.col))).toMatch(/^Location updated after planning/);
    expect(text(ws.getCell(head.row + 3, head.col))).toBe('');
    expect(text(ws.getCell(head.row, head.col + 1))).toBe('Received by (sign)');
  });

  it('prints TIMES NOT VERIFIED on the summary, the load plan and the sheets of the trucks concerned', async () => {
    const d = fixture();
    d.loads[1] = { ...d.loads[1], timing: { status: 'VIOLATED', ok: false } };
    d.feasibility = {
      v: 1, ok: false, status: 'VIOLATED', source: 'SOLVER_AND_WEB', solverStatus: 'VIOLATED', solverTiming: 'ESTIMATED',
      trucks: { t1: { truckCode: 'T01', status: 'VIOLATED', ok: false, blocking: 1, warnings: 0 } },
      violations: [{ code: 'TURNAROUND', severity: 'BLOCK', source: 'SOLVER', truckId: 't1', truckCode: 'T01', loadId: 'L2', loadNo: 2, message: 'T01 load 2 leaves 20 min before the truck is reloaded.' }],
      inputHash: 'x', checkedAt: '2026-09-27T05:00:00Z',
    };
    const wb = await render(d);
    const s = sheet(wb, SHEETS.summary);
    expect(find(s, (t) => t.startsWith('TIMES NOT VERIFIED'), 1)).toBeTruthy();
    expect(find(s, (t) => t === 'T01 load 2 leaves 20 min before the truck is reloaded.', 3)).toBeTruthy();
    expect(s.headerFooter.oddHeader).toContain('TIMES NOT VERIFIED');
    const lp = sheet(wb, SHEETS.loadPlan);
    const col = find(lp, (t) => t === 'Timing')!.col;
    expect(text(lp.getCell(6, col))).toBe('TIMES NOT VERIFIED');
    expect(text(lp.getCell(5, col))).toBe('Times checked');
    expect(text(sheet(wb, 'T01 - L2').getCell(3, 1))).toMatch(/^TIMES NOT VERIFIED/);
    expect(sheet(wb, 'T01 - L2').headerFooter.oddHeader).toContain('TIMES NOT VERIFIED');
    expect(text(sheet(wb, 'T01 - L1').getCell(3, 1))).toBe('');
    // A verified plan carries no mark.
    const ok = await render(fixture());
    expect(find(sheet(ok, SHEETS.summary), (t) => t.startsWith('TIMES NOT VERIFIED'))).toBeUndefined();
  });
});
