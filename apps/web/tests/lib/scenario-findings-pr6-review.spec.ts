/**
 * Stabilization PR6, review of the scenario-test fixes - each checked where it is used, not only
 * in its helper:
 *
 *  - the 50,000-row limit is for the sheet that is read: a large lookup sheet next to the orders
 *    is named in the warning, not a reason to refuse the file (the limit had been applied to the
 *    rows of every sheet together);
 *  - the baseline upload names the workbook sheets it did not read (response and
 *    ManualBaseline.notes) - it had dropped parseUpload's warning;
 *  - the order upload keeps that note in validationJson.warnings (the route, not only the parser);
 *  - the plan detail rewords a stored reason carrying a raw route-search code (getPlanDetail);
 *  - the Excel export's ASSUMPTIONS say the fuel price was not used and where the estimate
 *    settings applied on a road plan with some estimated legs (the export route).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { resetDb, tables } from './fake-plan-db';

const { auth } = vi.hoisted(() => ({
  auth: async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'PLANNER', name: 'Planner One', email: 'p@a.example' } }),
}));
vi.mock('@/lib/auth', () => ({ auth }));
vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => undefined) }));

import { parseUpload } from '@/lib/csv';
import { isOrderSheet } from '@/lib/dispatch/order-intake';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';
import { COST_POLICY } from '@/lib/dispatch/costs';
import { POST as uploadPost } from '@/app/api/orders/upload/route';
import { POST as baselinePost } from '@/app/api/runs/[id]/baseline/route';
import { GET as excelGet } from '@/app/api/runs/[id]/export/excel/route';

const T = 'tA';
const DAY = new Date('2026-10-07T00:00:00Z');
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A workbook file with one sheet per entry (sheet name -> header row + rows). */
function workbookFile(sheets: Record<string, unknown[][]>, name = 'orders.xlsx') {
  const wb = XLSX.utils.book_new();
  for (const [sheet, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet);
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new File([buf], name, { type: XLSX_TYPE });
}
const orderSheet = (n: number) => [
  ['sales_order_no', 'delivery_date', 'customer_code', 'product_code', 'cases'],
  ...Array.from({ length: n }, (_, i) => [`INV-${i + 1}`, '2026-10-07', `C${i % 200}`, 'W500', 3]),
];
const lookupSheet = (n: number) => [['code', 'name'], ...Array.from({ length: n }, (_, i) => [`C${i}`, `Customer ${i}`])];
const orders = { isDataSheet: (h: string[]) => isOrderSheet(h), rowsWord: 'order' };

// ---------------------------------------------------------------------------------------
// The row limit
// ---------------------------------------------------------------------------------------

describe('the 50,000-row limit is for the sheet that is read', () => {
  it('900 order rows next to a 49,500-row customer list: read, the list named in the warning', async () => {
    const file = workbookFile({ Orders: orderSheet(900), CustomerList: lookupSheet(49_500) });
    const parsed = await parseUpload(file, orders);
    expect(parsed.sheetName).toBe('Orders');
    expect(parsed.rows).toHaveLength(900);
    expect(parsed.warnings).toEqual([
      'Only sheet "Orders" was read. Other sheet(s) with rows but without the order columns were not read: "CustomerList" (49,500 rows).',
    ]);
    // The customer import (first sheet with rows) reads its sheet too.
    const first = await parseUpload(workbookFile({ Customers: lookupSheet(300), Archive: lookupSheet(49_800) }, 'customers.xlsx'));
    expect(first.rows).toHaveLength(300);
  });

  it('the sheet that is read is still limited, and named', async () => {
    const file = workbookFile({ Cover: [['title'], ['NMWC export']], Orders: orderSheet(50_001) });
    await expect(parseUpload(file, orders)).rejects.toThrow('Too many rows: 50001 on sheet "Orders". Max 50000.');
  });
});

// ---------------------------------------------------------------------------------------
// Upload routes: the skipped-sheet note reaches the dispatcher and is stored
// ---------------------------------------------------------------------------------------

describe('POST /api/runs/:id/baseline names the sheets it did not read', () => {
  beforeEach(() => {
    resetDb();
    tables.runPlan = [{ id: 'P', tenantId: T, depotId: 'D1', runDate: DAY, status: 'READY', version: 1 }];
    tables.customer = [];
    tables.order = [];
  });
  const post = (file: File) => {
    const fd = new FormData();
    fd.set('file', file);
    return baselinePost(new Request('http://localhost/api/runs/P/baseline', { method: 'POST', body: fd }), { params: { id: 'P' } });
  };
  const baselineSheet = [
    ['truck_code', 'customer_code', 'sequence', 'cases'],
    ['T01', 'C1', 1, 10],
    ['T01', 'C2', 2, 5],
  ];

  it('a second sheet: the answer and the stored baseline carry the note', async () => {
    const res = await post(workbookFile({ Baseline: baselineSheet, Notes: [['note'], ['Checked by the supervisor']] }, 'baseline.xlsx'));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { assignments: number; warnings: string[] } };
    const note = 'Only sheet "Baseline" was read. Other sheet(s) with rows were not read: "Notes" (1 row). Upload each sheet as its own file if it is needed.';
    expect(body.data.assignments).toBe(2);
    expect(body.data.warnings).toEqual([note]);
    expect(tables.manualBaseline[0].notes).toBe(`Warnings: 1 - ${note}`);
  });

  it('a one-sheet file: no note, as before', async () => {
    const res = await post(workbookFile({ Baseline: baselineSheet }, 'baseline.xlsx'));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { warnings: string[] } }).data.warnings).toEqual([]);
    expect(tables.manualBaseline[0].notes).toBeNull();
  });
});

describe('POST /api/orders/upload keeps the skipped-sheet note with the check', () => {
  beforeEach(() => {
    resetDb();
    tables.tenantConfig = [{ id: 'cfg', tenantId: T, orderColumnMapJson: null, timezone: 'Asia/Muscat', dateOrder: 'DMY', planningCutoffMin: 1080 }];
    tables.depot = [{ id: 'D1', tenantId: T, code: 'GHALA', name: 'Ghala', active: true, lat: 23.58, lng: 58.39 }];
  });

  it('Cover + Orders: the answer and validationJson.warnings name the cover sheet', async () => {
    const fd = new FormData();
    fd.set('file', workbookFile({ Cover: [['title', 'printed'], ['NMWC daily export', '2026-10-06']], Orders: orderSheet(4) }));
    const res = await uploadPost(new Request('http://localhost/api/orders/upload', { method: 'POST', body: fd }));
    expect(res.status).toBe(200);
    const note = 'Only sheet "Orders" was read. Other sheet(s) with rows but without the order columns were not read: "Cover" (1 row).';
    const body = (await res.json()) as { data: { validation: { totalRows: number; warnings: string[] } } };
    expect(body.data.validation.totalRows).toBe(4);
    expect(body.data.validation.warnings).toContain(note);
    // Stored with the batch: the upload page shows it again from there.
    expect(tables.uploadBatch).toHaveLength(1);
    expect((tables.uploadBatch[0].validationJson as { warnings: string[] }).warnings).toContain(note);
  });
});

// ---------------------------------------------------------------------------------------
// A plan on the in-memory database: stored reasons and the Excel export
// ---------------------------------------------------------------------------------------

const customer = {
  id: 'c1', tenantId: T, code: 'C1', branchCode: null, branchKey: '__MAIN__', name: 'Lulu Bausher', customerType: null, address: 'Bausher',
  accessNotes: null, lat: 23.6, lng: 58.4, priority: 3, priorityConfirmed: true, avgServiceTimeMin: 20, serviceTimeConfirmed: true,
  hardWindowStartMin: 360, hardWindowEndMin: 840, prefWindowStartMin: null, prefWindowEndMin: null, active: true, locationVerified: true, createdFromUpload: false,
};

/** A road (OSRM) plan: T1 L1 + T2 L1, no truck with a km per litre (fuelLitres null), 2 legs of L1 estimated. */
function seedRoadPlan() {
  const loadCost = (estimatedLegs: number) => ({
    v: 2, policy: COST_POLICY, fixed: 20, trip: 0, distance: 1, fuel: 0, driver: 0, overtime: 0, total: 21,
    driverPaidMin: 100, paidFromMin: 400, overtimeMin: 0, estimatedLegs,
  });
  const load = (id: string, truckId: string, estimatedLegs: number) => ({
    id, tenantId: T, runId: 'P', truckId, loadNo: 1, status: 'PLANNED', driverId: null, departMin: 400, returnMin: 500, distanceKm: 10,
    durationMin: 100, cases: 40, weightKg: 400, utilizationPct: 40, fuelLitres: null, fuelCost: 0, operatingCost: 21, returnLegKm: 2,
    distanceIsEstimated: false, carriedFromLoadId: null, truckSnapshotJson: null, costJson: loadCost(estimatedLegs), statusChangedAt: null,
    statusChangedById: null, createdAt: new Date(),
  });
  const assignment = (id: string, loadId: string, truckId: string, orderId: string) => ({
    id, runId: 'P', truckId, orderId, sequenceInTruck: 1, plannedArrivalMin: 20, plannedDistanceFromPrevKm: 5, plannedLoadCases: 40,
    lockedByUserId: null, manualOverrideReason: null, loadId, loadNo: 1, orderInStop: 0, etaMin: 420, serviceStartMin: 420, departureMin: 440,
    waitMin: 0, cumulativeKm: 5, hardWindowOk: true, prefWindowOk: true, portionCases: null, portionWeightKg: null, portionLinesJson: null,
    stopSnapshotJson: null,
  });
  tables.tenant = [{ id: T, name: 'NMWC Test', currency: 'OMR', country: 'OM' }];
  tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true, lat: 23.58, lng: 58.39, openMin: 0, closeMin: 1440 }];
  tables.truck = [
    { id: 'T1', tenantId: T, code: 'T01', defaultDriverId: null, capacityCases: 100, capacityWeightKg: 1000, kmPerLitre: null },
    { id: 'T2', tenantId: T, code: 'T02', defaultDriverId: null, capacityCases: 100, capacityWeightKg: 1000, kmPerLitre: null },
  ];
  tables.customer = [customer];
  tables.order = ['O1', 'O2', 'O3'].map((id) => ({
    id, tenantId: T, customerId: 'c1', customer, lines: [], totalCases: 40, totalWeightKg: 400, priority: 3,
    salesValue: null, marginValue: null, isLate: false, status: id === 'O3' ? 'CONFIRMED' : 'ASSIGNED', notes: null, depotId: 'D1', deliveryDate: DAY,
  }));
  tables.runPlan = [{
    id: 'P', tenantId: T, depotId: 'D1', runDate: DAY, status: 'READY', version: 1, reason: 'INITIAL', optimizationMode: 'BALANCED',
    chosenScenarioId: 'sc1', parentRunId: null, supersededAt: null, currentJobId: null, finalizedAt: null, totalOrders: 3, unservedCount: 1,
    summaryJson: null, reconciliationJson: null, changeSummaryJson: null, feasibilityJson: null, createdById: 'u1', createdAt: new Date(),
  }];
  tables.planLoad = [load('L1', 'T1', 2), load('M1', 'T2', 0)];
  tables.routeAssignment = [assignment('A1', 'L1', 'T1', 'O1'), assignment('A2', 'M1', 'T2', 'O2')];
  tables.scenarioResult = [{
    id: 'sc1', runId: 'P', name: 'RECOMMENDED', trucksUsed: 2, totalDistanceKm: 20, totalTimeMin: 200, totalCost: 42, avgUtilizationPct: 40, unservedCount: 1,
    createdAt: new Date(),
    detailsJson: {
      name: 'RECOMMENDED', status: 'OPTIMIZED', solver_status: 'ROUTING_SUCCESS', solver_time_sec: 1, trucks_used: 2, trips: 2,
      total_distance_km: 20, total_duration_min: 200, operating_cost: 42, avg_utilization_pct: 40, loads: [], unserved: [], warnings: [],
      objective: null, engine: 'OR-Tools', matrix_provider: 'OSRM', distance_is_estimated: false, estimated_legs: 2, cost_version: 2, response_warnings: [],
      scope: { orderIds: ['O1', 'O2', 'O3'], frozenOrderIds: [], orderPriority: {}, frozenLoadIds: [], frozenLoadOrderIds: [] },
      feasibility: { status: 'VERIFIED', timing: 'EXACT', violations: [] },
    },
  }];
  // Saved by a solver from before PR6, which put the raw status code in the reason.
  tables.unservedOrder = [{
    id: 'U1', scenarioId: 'sc1', orderId: 'O3', reasonCode: 'INFEASIBLE', reasonMessage: 'The optimizer found no feasible plan (ROUTING_FAIL_TIMEOUT).',
    portionLinesJson: null, portionCases: null, portionWeightKg: null,
  }];
  tables.runJob = [];
  tables.auditLog = [];
  tables.driver = [];
  tables.customerTypeProfile = [];
  tables.tenantConfig = [{
    id: 'cfg', tenantId: T, timezone: 'Asia/Muscat', planningCutoffMin: 1080, shiftStartMin: 360, driverShiftMaxMinutes: 660, reloadMinutes: 30,
    maxTripsPerTruck: 3, fuelPricePerLitre: 0.25, driverCostPerHour: 0, overtimeAfterMin: 540, overtimeCostPerHour: 0, prefWindowPenaltyPerMin: 0.05,
    roadTimeFactor: 1.25, distanceProvider: 'OSRM', distanceMultiplier: 1.3, avgSpeedKmh: 40, defaultServiceTimeMin: 10, osrmUrl: null,
  }];
}

describe('the plan detail rewords a stored reason with a raw route-search code', () => {
  beforeEach(() => {
    resetDb();
    seedRoadPlan();
  });

  it('getPlanDetail: "(ROUTING_FAIL_TIMEOUT)" is shown in plain words', async () => {
    const d = (await getPlanDetail(T, 'P'))!;
    expect(d.unserved.map((u) => u.reasonMessage)).toEqual(['The optimizer found no feasible plan (no plan found in the time allowed).']);
  });
});

describe('GET /api/runs/:id/export/excel: ASSUMPTIONS state only what the plan used', () => {
  beforeEach(() => {
    resetDb();
    seedRoadPlan();
  });

  async function assumptions(): Promise<Map<string, string>> {
    const res = await excelGet(new Request('http://localhost/api/runs/P/export/excel'), { params: { id: 'P' } });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const ws = wb.getWorksheet('ASSUMPTIONS')!;
    const out = new Map<string, string>();
    ws.eachRow((r) => out.set(r.getCell(1).text, r.getCell(2).text));
    return out;
  }

  it('no truck with a km per litre: the fuel price is "not used"; 2 estimated legs of a road plan: the estimate settings say where', async () => {
    const a = await assumptions();
    expect(a.get('Fuel price')).toMatch(/^0\.25 OMR per litre - not used in this plan: its trucks have no km per litre/);
    expect(a.get('Road time factor (truck vs car)')).toBe('x1.25 on road travel times (not on estimated legs)');
    expect(a.get('Estimated-distance multiplier')).toBe("x1.3 on straight-line distance (on the 2 leg(s) that could not be routed on roads)");
    expect(a.get('Average speed for estimates')).toBe('40 km/h (on the 2 leg(s) that could not be routed on roads)');
  });

  it('a load with fuel litres: the fuel price is stated as used; no estimated leg: no estimate settings', async () => {
    tables.planLoad[0].fuelLitres = 4.2;
    for (const l of tables.planLoad) l.costJson = { ...l.costJson, estimatedLegs: 0 };
    tables.scenarioResult[0].detailsJson = { ...tables.scenarioResult[0].detailsJson, estimated_legs: 0 };
    const a = await assumptions();
    expect(a.get('Fuel price')).toBe('0.25 OMR per litre');
    expect(a.has('Estimated-distance multiplier')).toBe(false);
  });
});
