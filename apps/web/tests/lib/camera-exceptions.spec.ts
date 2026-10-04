/**
 * Owner decision 2 (5 Oct 2026): "Camera not working" (Delivered or Partly delivered saved without a
 * photo) stays allowed, but it is MONITORED and DOCUMENTED: the count and the list (stop, customer,
 * driver, time) on the day's Deliveries card and the plan screen, a KPI on the dashboard, a clear
 * column and a sheet in the "Delivery actuals" Excel, and a driver link (truck-day) that used it 3 times
 * or more in a day highlighted. Synthetic data only: customers ACME, BETA, GAMMA, DELTA, EPSILON,
 * trucks T05 and T06, driver Salim; the database is the in-memory one (fake-plan-db.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});

import {
  CAMERA_ALERT_PER_DAY,
  cameraAlertText,
  cameraExceptionText,
  cameraHeadline,
  cameraLinkAlerts,
  cameraShareText,
  isCameraException,
  type CameraException,
} from '@/lib/delivery/camera-exceptions';
import { deliveryKpis, type KpiVisit } from '@/lib/delivery/kpis';
import { dayDeliveries } from '@/lib/delivery/day-results';
import { readOutcomeOverlay } from '@/lib/delivery/outcome-view';
import { ACTUALS_COLUMNS, buildActualsWorkbook, readActuals } from '@/lib/delivery/actuals-workbook';
import { todayIso, zonedDayStart } from '@/lib/dispatch/time';

const T = 'tA';
const TZ = 'Asia/Muscat';
// Yesterday: every load of the day is back.
const D = (() => {
  const d = new Date(`${todayIso(TZ)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
})();
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const at = (min: number) => new Date(zonedDayStart(D, TZ).getTime() + min * 60_000);
const WEB = path.resolve(__dirname, '../..');
const REPO = path.resolve(WEB, '../..');

describe('the rule and the words (pure)', () => {
  it('a camera exception is Delivered or Partly saved with "Camera not working"; never Not delivered or a result with a photo', () => {
    expect(isCameraException({ outcome: 'DELIVERED', noPhotoReason: 'CAMERA_FAILED' })).toBe(true);
    expect(isCameraException({ outcome: 'PARTLY_DELIVERED', noPhotoReason: 'CAMERA_FAILED' })).toBe(true);
    expect(isCameraException({ outcome: 'NOT_DELIVERED', noPhotoReason: 'CAMERA_FAILED' })).toBe(false);
    expect(isCameraException({ outcome: 'DELIVERED', noPhotoReason: null })).toBe(false);
    expect(isCameraException({ outcome: null, noPhotoReason: 'CAMERA_FAILED' })).toBe(false);
  });

  const ex = (over: Partial<CameraException> = {}): CameraException => ({
    date: '2026-10-05', depotId: 'DA', truckId: 'T5', truckCode: 'T05', loadId: 'L1', loadNo: 1, sequence: 3, customerCode: 'ACME', branchCode: null,
    customerName: 'ACME Store', driverName: 'Salim', outcome: 'DELIVERED', outcomeAt: '2026-10-05T06:42:00.000Z', time: '10:42', ...over,
  });

  it('the list line names the stop, the customer, the driver and the time; the headline counts them', () => {
    expect(cameraExceptionText(ex())).toBe('T05 trip 1 stop 3 · ACME Store (ACME) · Salim · 10:42 · Delivered');
    expect(cameraExceptionText(ex({ branchCode: 'B2', driverName: null, time: null, outcome: 'PARTLY_DELIVERED' }), { withDate: true })).toBe(
      '5 Oct T05 trip 1 stop 3 · ACME Store (ACME/B2) · no driver set · time not known · Partly delivered',
    );
    expect(cameraHeadline(0)).toBeNull();
    expect(cameraHeadline(1)).toBe('1 result saved without a photo (Camera not working)');
    expect(cameraHeadline(4)).toBe('4 results saved without a photo (Camera not working)');
  });

  it(`a driver link (truck-day) with ${CAMERA_ALERT_PER_DAY} or more is highlighted; the day's count over every depot wins`, () => {
    expect(CAMERA_ALERT_PER_DAY).toBe(3);
    const rows = [ex({ sequence: 1 }), ex({ sequence: 2 }), ex({ sequence: 3 }), ex({ truckId: 'T6', truckCode: 'T06', loadId: 'L2', driverName: 'Rashid' })];
    expect(cameraLinkAlerts(rows)).toEqual([{ date: '2026-10-05', truckId: 'T5', truckCode: 'T05', drivers: ['Salim'], count: 3 }]);
    // T06 used it twice here and twice at its other depot that day: one link, 4 times.
    const alerts = cameraLinkAlerts(rows, new Map([['2026-10-05|T6', 4]]));
    expect(alerts.map((a) => [a.truckCode, a.count])).toEqual([['T06', 4], ['T05', 3]]);
    expect(cameraLinkAlerts(rows.slice(0, 2))).toEqual([]);
    expect(cameraAlertText(alerts[1]!)).toBe("T05 (Salim): Camera not working used 3 times on 5 Oct - check the phone's camera with the driver.");
  });
});

describe('the KPIs (Deliveries card, dashboard, Excel Summary)', () => {
  const dayStart = zonedDayStart('2026-10-05', TZ);
  const v = (over: Partial<KpiVisit> = {}): KpiVisit => ({
    outcome: 'DELIVERED', reason: null, casesPlanned: 10, casesDelivered: 10, arrivedAt: null, arrivalSource: null, arrivalObserved: true, timingSuspect: false,
    windowStartMin: null, windowEndMin: null, autoServiceMinutes: null, plannedServiceMin: null, outcomeLate: false, noPhotoReason: null, autoArrivedAt: null,
    deliveryDate: '2026-10-05', dayStart, truckId: 'T5', ...over,
  });

  it('counts them, their share of the delivered results and the truck-days with 3 or more', () => {
    const cam = { noPhotoReason: 'CAMERA_FAILED' } as const;
    const k = deliveryKpis([
      v(cam),
      v(cam),
      v({ ...cam, outcome: 'PARTLY_DELIVERED', casesDelivered: 5 }),
      v({ ...cam, truckId: 'T6' }),
      v({ truckId: 'T6' }),
      v({ outcome: 'NOT_DELIVERED', casesDelivered: 0, reason: 'SHOP_CLOSED', noPhotoReason: 'CAMERA_FAILED' }),
      null,
    ]);
    expect(k).toMatchObject({ cameraFailed: 4, cameraAlertDays: 1, delivered: 4, partly: 1 });
    expect(k.cameraFailedPct).toBe(80);
    expect(cameraShareText(k)).toBe('4 of 5 delivered results (80 %)');
    expect(deliveryKpis([]).cameraFailedPct).toBeNull();
    expect(cameraShareText(deliveryKpis([]))).toBe('0 of 0 delivered results');
  });
});

/** Five stops: T05 trip 1 stops 1-4 (ACME, BETA, GAMMA, DELTA), T06 trip 1 stop 1 (EPSILON). */
function seed() {
  resetDb();
  const PIN = { lat: 23.6, lng: 58.4 };
  const snap = (code: string) => ({ v: 1, customerId: `c-${code}`, code, branchCode: null, name: `${code} Store`, lat: PIN.lat, lng: PIN.lng, hardStartMin: 480, hardEndMin: 720 });
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, timezone: TZ, geofenceRadiusM: 100, outcomesSince: new Date('2026-01-01T00:00:00Z'), serviceMinPerCase: 0, defaultServiceTimeMin: 10 }];
  tables.tenant = [{ id: T, name: 'Synthetic Water Co' }];
  tables.depot = [{ id: 'DA', tenantId: T, code: 'A1', active: true }];
  tables.truck = [
    { id: 'T5', tenantId: T, code: 'T05', hired: false },
    { id: 'T6', tenantId: T, code: 'T06', hired: true },
  ];
  tables.driver = [
    { id: 'dr1', tenantId: T, name: 'Salim', casual: false, phone: null },
    { id: 'dr2', tenantId: T, name: 'Rashid', casual: true, phone: null },
  ];
  tables.user = [];
  const codes = ['ACME', 'BETA', 'GAMMA', 'DELTA', 'EPSILON'];
  tables.order = codes.map((c) => ({
    id: `O-${c}`, tenantId: T, depotId: 'DA', customerId: `c-${c}`, deliveryDate: day(D), status: 'DISPATCHED', totalCases: 10,
    customer: { id: `c-${c}`, code: c, name: `${c} Store`, lat: PIN.lat, lng: PIN.lng }, lines: [{ id: `${c}-1`, cases: 10, weightKg: 100, product: { code: 'W500' } }],
  }));
  tables.runPlan = [{ id: 'P1', tenantId: T, depotId: 'DA', runDate: day(D), status: 'DISPATCHED', version: 1, chosenScenarioId: 'sc1', supersededAt: null, createdAt: new Date() }];
  tables.planLoad = [
    { id: 'L1', tenantId: T, runId: 'P1', truckId: 'T5', loadNo: 1, status: 'COMPLETED', departMin: 420, returnMin: 840, driverId: 'dr1', breakJson: null, statusChangedAt: new Date() },
    { id: 'L2', tenantId: T, runId: 'P1', truckId: 'T6', loadNo: 1, status: 'COMPLETED', departMin: 420, returnMin: 840, driverId: 'dr2', breakJson: null, statusChangedAt: new Date() },
  ];
  tables.routeAssignment = [
    ...codes.slice(0, 4).map((c, i) => ({ id: `ra-${c}`, runId: 'P1', loadId: 'L1', orderId: `O-${c}`, sequenceInTruck: i + 1, orderInStop: 0, etaMin: 500 + i * 30, serviceStartMin: 500 + i * 30, departureMin: 520 + i * 30, portionLinesJson: null, stopSnapshotJson: snap(c) })),
    { id: 'ra-EPSILON', runId: 'P1', loadId: 'L2', orderId: 'O-EPSILON', sequenceInTruck: 1, orderInStop: 0, etaMin: 500, serviceStartMin: 500, departureMin: 520, portionLinesJson: null, stopSnapshotJson: snap('EPSILON') },
  ];
  const visit = (id: string, truckId: string, sequence: number, outcome: string, noPhotoReason: string | null, min: number, depotId = 'DA') => ({
    id, tenantId: T, depotId, deliveryDate: day(D), truckId, loadNo: 1, sequence, customerId: 'c', outcome, noPhotoReason, outcomeAt: at(min), outcomeSource: 'PHONE_MANUAL',
    outcomeById: null, reason: outcome === 'NOT_DELIVERED' ? 'SHOP_CLOSED' : null, reasonNote: null, casesPlanned: 10, casesDelivered: outcome === 'NOT_DELIVERED' ? 0 : outcome === 'PARTLY_DELIVERED' ? 6 : 10,
    linesJson: [], photoKeysJson: null, photoCount: 0, arrivedAt: null, arrivalSource: null, arrivalObserved: true, departedAt: null, departedAtOutcome: false, timingSuspect: false,
    outcomeLate: false, autoArrivedAt: null, autoServiceMinutes: null, autoMinutes: null, autoBasis: null, plannedServiceMin: 20, windowStartMin: 480, windowEndMin: 720, arrivalDistanceM: null,
  });
  tables.stopVisit = [
    visit('v1', 'T5', 1, 'DELIVERED', 'CAMERA_FAILED', 9 * 60 + 5),
    visit('v2', 'T5', 2, 'PARTLY_DELIVERED', 'CAMERA_FAILED', 9 * 60 + 40),
    visit('v3', 'T5', 3, 'DELIVERED', 'CAMERA_FAILED', 10 * 60 + 42),
    visit('v4', 'T5', 4, 'NOT_DELIVERED', null, 11 * 60),
    visit('v5', 'T6', 1, 'DELIVERED', 'CAMERA_FAILED', 8 * 60 + 50),
  ];
  tables.stopEvent = [];
  tables.deliveryPhoto = [];
  tables.driverLink = [];
  tables.unservedOrder = [];
  tables.auditLog = [];
}

describe("the day's Deliveries card (dayDeliveries)", () => {
  beforeEach(seed);

  it('lists every result saved without a photo (stop, customer, driver, time) and highlights T05, which used it 3 times', async () => {
    const d = await dayDeliveries(T, 'DA', D);
    expect(d.kpis).toMatchObject({ cameraFailed: 4, cameraAlertDays: 1 });
    expect(d.cameraExceptions.map((e) => cameraExceptionText(e))).toEqual([
      'T05 trip 1 stop 1 · ACME Store (ACME) · Salim · 09:05 · Delivered',
      'T05 trip 1 stop 2 · BETA Store (BETA) · Salim · 09:40 · Partly delivered',
      'T05 trip 1 stop 3 · GAMMA Store (GAMMA) · Salim · 10:42 · Delivered',
      'T06 trip 1 stop 1 · EPSILON Store (EPSILON) · Rashid · 08:50 · Delivered',
    ]);
    expect(d.cameraAlerts).toEqual([{ date: D, truckId: 'T5', truckCode: 'T05', drivers: ['Salim'], count: 3 }]);
  });

  it("a driver link's count covers every depot of the day: T06's 2 more at another depot make it 3", async () => {
    tables.stopVisit.push({ ...tables.stopVisit[4]!, id: 'v6', depotId: 'DB', sequence: 1 }, { ...tables.stopVisit[4]!, id: 'v7', depotId: 'DB', sequence: 2 });
    const d = await dayDeliveries(T, 'DA', D);
    // The list is this depot's (one T06 stop); the alert counts the link's whole day.
    expect(d.cameraExceptions.filter((e) => e.truckCode === 'T06')).toHaveLength(1);
    expect(d.cameraAlerts.map((a) => [a.truckCode, a.count])).toEqual([
      ['T05', 3],
      ['T06', 3],
    ]);
  });

  it('none: an empty list and no alert', async () => {
    for (const v of tables.stopVisit) v.noPhotoReason = null;
    const d = await dayDeliveries(T, 'DA', D);
    expect([d.cameraExceptions, d.cameraAlerts, d.kpis.cameraFailed]).toEqual([[], [], 0]);
  });
});

describe('the plan screen (readOutcomeOverlay)', () => {
  beforeEach(seed);

  it("lists them, and the load row knows its driver link's count today (3 or more: the red badge)", async () => {
    const o = (await readOutcomeOverlay(T, 'P1'))!;
    expect(o.cameraExceptions.map((e) => [e.truckCode, e.sequence, e.customerCode, e.driverName, e.time])).toEqual([
      ['T05', 1, 'ACME', 'Salim', '09:05'],
      ['T05', 2, 'BETA', 'Salim', '09:40'],
      ['T05', 3, 'GAMMA', 'Salim', '10:42'],
      ['T06', 1, 'EPSILON', 'Rashid', '08:50'],
    ]);
    expect(o.cameraAlerts.map((a) => a.truckCode)).toEqual(['T05']);
    expect(o.loads.L1!.cameraFailedToday).toBe(3);
    expect(o.loads.L2!.cameraFailedToday).toBe(1);
    expect(o.summary).toMatchObject({ cameraFailed: 4, cameraAlertDays: 1 });
  });
});

describe('the "Delivery actuals" Excel', () => {
  beforeEach(seed);

  it('a clear column per stop, the link count, the rows filled, a "Without photo" sheet and the Summary lines', async () => {
    const res = await readActuals(T, { from: D, to: D }, null);
    expect(res.rows.map((r) => [r.truck, r.stop, r.cameraException, r.linkCameraCount])).toEqual([
      ['T05', 1, 'Yes', 3],
      ['T05', 2, 'Yes', 3],
      ['T05', 3, 'Yes', 3],
      ['T05', 4, 'No', 3],
      ['T06', 1, 'Yes', 1],
    ]);
    const buf = await buildActualsWorkbook(res.rows, { tenantName: 'Synthetic Water Co', from: D, to: D, depot: null, generatedAt: new Date(), generatedBy: 'Ali', kpis: res.kpis, tz: res.tz });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Stops', 'Summary', 'Without photo', 'Reasons']);
    const stops = wb.getWorksheet('Stops')!;
    const headers = (stops.getRow(1).values as unknown[]).slice(1);
    const col = headers.indexOf('Saved without a photo (Camera not working)') + 1;
    expect(col).toBeGreaterThan(0);
    expect(ACTUALS_COLUMNS.map((c) => c.header)).toContain('Driver link: saved without a photo that day');
    // The exception rows are filled amber; the others are not.
    expect((stops.getRow(2).getCell(col).fill as { fgColor?: { argb?: string } }).fgColor?.argb).toBe('FFFFE699');
    expect((stops.getRow(5).getCell(col).fill as { fgColor?: { argb?: string } } | undefined)?.fgColor?.argb).not.toBe('FFFFE699');
    const wp = wb.getWorksheet('Without photo')!;
    expect(wp.rowCount).toBe(5); // the header and 4 results
    expect((wp.getRow(2).values as unknown[]).slice(1)).toEqual([D, 'A1', 'T05', 1, 1, 'ACME', 'ACME Store', 'Salim', 'Delivered', '09:05', 3]);
    const summary = (wb.getWorksheet('Summary')!.getSheetValues() as unknown[][]).filter(Boolean).map((r) => [r[1], r[2]]);
    expect(summary).toEqual(
      expect.arrayContaining([
        ['Saved without a photo (Camera not working)', 4],
        ['Saved without a photo, of the delivered results', '4 of 4 delivered results (100 %)'],
        ['Driver links that used it 3 times or more in a day', 1],
      ]),
    );
  });
});

describe('the screens and the docs say it', () => {
  const read = (p: string) => readFileSync(path.join(WEB, p), 'utf8');
  const doc = (p: string) => readFileSync(path.join(REPO, 'docs', p), 'utf8');

  it('the Deliveries card, the plan screen (with the red load badge) and the dashboard show them', () => {
    expect(read('app/t/[slug]/dispatch/delivery-summary.tsx')).toContain('<CameraExceptions list={deliveries.cameraExceptions');
    const plan = read('app/t/[slug]/dispatch/plan-view.tsx');
    expect(plan).toContain('<CameraExceptions list={overlay.cameraExceptions');
    expect(plan).toContain('(o.cameraFailedToday ?? 0) >= CAMERA_ALERT_PER_DAY');
    expect(read('app/t/[slug]/page.tsx')).toContain('data-testid="dashboard-camera"');
  });

  it('the dispatcher guide (what it is, the daily check, the weekly review), the driver guide in English and Arabic, the handbook', () => {
    const guide = doc('DISPATCHER_GUIDE.md');
    expect(guide).toContain('### Camera not working: results saved without a photo');
    expect(guide).toMatch(/every day/i);
    expect(guide).toMatch(/operations manager[^.]*every week/i);
    const driver = doc('DRIVER_GUIDE.md');
    expect(driver).toMatch(/Camera not working[^\n]*recorded[^\n]*checked/);
    // Arabic: "every use is recorded and the office reviews it every day".
    expect(driver).toMatch(/الكاميرا لا تعمل[^\n]*وتراجعه الإدارة كل يوم/);
    expect(doc('PROJECT_HANDBOOK.md')).toContain('camera-exceptions.ts');
  });
});
