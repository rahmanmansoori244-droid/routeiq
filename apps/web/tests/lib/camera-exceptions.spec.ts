/**
 * Owner decision 2 (5 Oct 2026): "Camera not working" (Delivered or Partly delivered saved without a
 * photo) stays allowed, but it is MONITORED and DOCUMENTED: the count and the list (stop, customer,
 * driver, time) on the day's Deliveries card and the plan screen, a KPI on the dashboard, a clear
 * column and a sheet in the "Delivery actuals" Excel, and a driver link (truck-day) that used it 3 times
 * or more in a day highlighted. The monitor reads the driver's OWN last Delivered / Partly result, so an
 * office Record never takes a stop off it (review of 5 Oct 2026), and a result whose named photo never
 * arrived counts too. Synthetic data only: customers ACME, BETA, GAMMA, DELTA, EPSILON, trucks T05 and
 * T06, drivers Salim and Rashid; the database is the in-memory one (fake-plan-db.ts).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, resetDb, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return { audit: vi.fn(async (input: Record<string, unknown>) => m.fakePrisma.auditLog.create({ data: { ...input } })) };
});

import {
  CAMERA_ALERT_PER_DAY,
  PHOTO_WAIT_AFTER_COMPLETED_MIN,
  cameraAlertText,
  cameraExceptionText,
  cameraHeadline,
  cameraLinkAlerts,
  cameraShareText,
  isCameraException,
  noPhotoKind,
  photoWaitOver,
  type CameraException,
} from '@/lib/delivery/camera-exceptions';
import { deliveryKpis, type KpiVisit } from '@/lib/delivery/kpis';
import { dayDeliveries, rangeKpis } from '@/lib/delivery/day-results';
import { readOutcomeOverlay } from '@/lib/delivery/outcome-view';
import { recordOfficeOutcome } from '@/lib/delivery/office-service';
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
  it("a camera exception is the driver's own Delivered or Partly saved with \"Camera not working\"; never Not delivered or a result with a photo", () => {
    expect(isCameraException({ driverResultOutcome: 'DELIVERED', driverNoPhotoReason: 'CAMERA_FAILED' })).toBe(true);
    expect(isCameraException({ driverResultOutcome: 'PARTLY_DELIVERED', driverNoPhotoReason: 'CAMERA_FAILED' })).toBe(true);
    expect(isCameraException({ driverResultOutcome: 'NOT_DELIVERED', driverNoPhotoReason: 'CAMERA_FAILED' })).toBe(false);
    expect(isCameraException({ driverResultOutcome: 'DELIVERED', driverNoPhotoReason: null })).toBe(false);
    expect(isCameraException({ driverResultOutcome: null, driverNoPhotoReason: 'CAMERA_FAILED' })).toBe(false);
  });

  it('"photo not received": the driver named a photo, none arrived, and none can come any more; a photo that arrives ends it', () => {
    const f = { driverResultOutcome: 'DELIVERED', driverNoPhotoReason: null, driverPhotoKeys: 1, photoCount: 0 };
    expect(noPhotoKind(f, false)).toBeNull(); // still on its way
    expect(noPhotoKind(f, true)).toBe('PHOTO_NOT_RECEIVED');
    expect(noPhotoKind({ ...f, photoCount: 1 }, true)).toBeNull();
    expect(noPhotoKind({ ...f, driverPhotoKeys: 0 }, true)).toBeNull(); // photo not required that day
    expect(noPhotoKind({ ...f, driverResultOutcome: null }, true)).toBeNull();
    expect(noPhotoKind({ ...f, driverPhotoKeys: 0, driverNoPhotoReason: 'CAMERA_FAILED' }, false)).toBe('CAMERA_FAILED');
  });

  it('when a named photo can no longer arrive: the link reissued after the result, revoked, gone, past its upload time, or the trip completed an hour ago', () => {
    const now = new Date('2026-10-05T12:00:00Z');
    const link = { issuedAt: '2026-10-05T03:00:00Z', revokedAt: null, uploadUntil: '2026-10-09T08:00:00Z' };
    const base = { resultAt: '2026-10-05T06:00:00Z', link, load: { status: 'DISPATCHED', statusChangedAt: '2026-10-05T04:00:00Z' }, now };
    expect(photoWaitOver(base)).toBe(false);
    expect(photoWaitOver({ ...base, link: { ...link, issuedAt: '2026-10-05T07:00:00Z' } })).toBe(true); // Reissue link: the old phone's uploads are refused
    expect(photoWaitOver({ ...base, link: { ...link, revokedAt: '2026-10-05T07:00:00Z' } })).toBe(true);
    expect(photoWaitOver({ ...base, link: null })).toBe(true);
    expect(photoWaitOver({ ...base, link: { ...link, uploadUntil: '2026-10-05T12:00:00Z' } })).toBe(true);
    expect(PHOTO_WAIT_AFTER_COMPLETED_MIN).toBe(60);
    const done = (min: number) => ({ status: 'COMPLETED', statusChangedAt: new Date(now.getTime() - min * 60_000) });
    expect(photoWaitOver({ ...base, load: done(59) })).toBe(false);
    expect(photoWaitOver({ ...base, load: done(60) })).toBe(true);
  });

  const ex = (over: Partial<CameraException> = {}): CameraException => ({
    date: '2026-10-05', depotId: 'DA', truckId: 'T5', truckCode: 'T05', loadId: 'L1', loadNo: 1, sequence: 3, customerCode: 'ACME', branchCode: null,
    customerName: 'ACME Store', driverName: 'Salim', kind: 'CAMERA_FAILED', outcome: 'DELIVERED', outcomeAt: '2026-10-05T06:42:00.000Z', time: '10:42', after: null, ...over,
  });

  it('the list line names the stop, the customer, the driver and the time, why, and what changed after; the headline counts them', () => {
    expect(cameraExceptionText(ex())).toBe('T05 trip 1 stop 3 · ACME Store (ACME) · Salim · 10:42 · Delivered');
    expect(cameraExceptionText(ex({ branchCode: 'B2', driverName: null, time: null, outcome: 'PARTLY_DELIVERED' }), { withDate: true })).toBe(
      '5 Oct T05 trip 1 stop 3 · ACME Store (ACME/B2) · no driver set · time not known · Partly delivered',
    );
    expect(cameraExceptionText(ex({ after: 'corrected by office: Not delivered' }))).toBe('T05 trip 1 stop 3 · ACME Store (ACME) · Salim · 10:42 · Delivered · corrected by office: Not delivered');
    expect(cameraExceptionText(ex({ kind: 'PHOTO_NOT_RECEIVED' }))).toBe('T05 trip 1 stop 3 · ACME Store (ACME) · Salim · 10:42 · Delivered · photo not received');
    expect(cameraHeadline(0)).toBeNull();
    expect(cameraHeadline(1)).toBe('1 result saved without a photo (Camera not working)');
    expect(cameraHeadline(4)).toBe('4 results saved without a photo (Camera not working)');
    expect(cameraHeadline(4, 1)).toBe('4 results saved without a photo (3 Camera not working, 1 photo not received)');
    expect(cameraHeadline(1, 1)).toBe('1 result saved without a photo (photo not received)');
  });

  it(`a driver link (truck-day) with ${CAMERA_ALERT_PER_DAY} or more is highlighted; the day's count over every depot wins`, () => {
    expect(CAMERA_ALERT_PER_DAY).toBe(3);
    const rows = [ex({ sequence: 1 }), ex({ sequence: 2 }), ex({ sequence: 3 }), ex({ truckId: 'T6', truckCode: 'T06', loadId: 'L2', driverName: 'Rashid' })];
    expect(cameraLinkAlerts(rows)).toEqual([{ date: '2026-10-05', truckId: 'T5', truckCode: 'T05', drivers: ['Salim'], count: 3, notReceived: 0 }]);
    // T06 used it twice here and twice at its other depot that day: one link, 4 times.
    const alerts = cameraLinkAlerts(rows, new Map([['2026-10-05|T6', 4]]));
    expect(alerts.map((a) => [a.truckCode, a.count])).toEqual([['T06', 4], ['T05', 3]]);
    expect(cameraLinkAlerts(rows.slice(0, 2))).toEqual([]);
    expect(cameraAlertText(alerts[1]!)).toBe("T05 (Salim): Camera not working used 3 times on 5 Oct - check the phone's camera with the driver.");
    // A photo that never arrived counts towards the same link.
    const mixed = cameraLinkAlerts([ex({ sequence: 1 }), ex({ sequence: 2 }), ex({ sequence: 3, kind: 'PHOTO_NOT_RECEIVED' })]);
    expect(mixed.map((a) => [a.count, a.notReceived])).toEqual([[3, 1]]);
    expect(cameraAlertText(mixed[0]!)).toBe("T05 (Salim): 3 results saved without a photo on 5 Oct (2 Camera not working, 1 photo not received) - check the phone's camera and signal with the driver.");
  });
});

describe('the KPIs (Deliveries card, dashboard, Excel Summary)', () => {
  const dayStart = zonedDayStart('2026-10-05', TZ);
  const v = (over: Partial<KpiVisit> = {}): KpiVisit => ({
    outcome: 'DELIVERED', reason: null, casesPlanned: 10, casesDelivered: 10, arrivedAt: null, arrivalSource: null, arrivalObserved: true, timingSuspect: false,
    windowStartMin: null, windowEndMin: null, autoServiceMinutes: null, plannedServiceMin: null, outcomeLate: false, noPhotoReason: null, autoArrivedAt: null,
    deliveryDate: '2026-10-05', dayStart, truckId: 'T5', driverResultOutcome: 'DELIVERED', driverNoPhotoReason: null, driverPhotoKeys: 1, photoCount: 1, ...over,
  });
  const cam = { driverNoPhotoReason: 'CAMERA_FAILED', driverPhotoKeys: 0, photoCount: 0 } as const;

  it('counts them, their share of the delivered results and the truck-days with 3 or more', () => {
    const k = deliveryKpis([
      v(cam),
      v(cam),
      v({ ...cam, outcome: 'PARTLY_DELIVERED', casesDelivered: 5, driverResultOutcome: 'PARTLY_DELIVERED' }),
      v({ ...cam, truckId: 'T6' }),
      v({ truckId: 'T6' }),
      v({ outcome: 'NOT_DELIVERED', casesDelivered: 0, reason: 'SHOP_CLOSED', noPhotoReason: 'CAMERA_FAILED', driverResultOutcome: null }),
      null,
    ]);
    expect(k).toMatchObject({ cameraFailed: 4, photoNotReceived: 0, withoutPhoto: 4, cameraAlertDays: 1, delivered: 4, partly: 1 });
    expect(k.withoutPhotoPct).toBe(80);
    expect(cameraShareText(k)).toBe('4 of 5 delivered results (80 %)');
    expect(deliveryKpis([]).withoutPhotoPct).toBeNull();
    expect(cameraShareText(deliveryKpis([]))).toBe('0 of 0 delivered results');
  });

  it('a stop the office corrected still counts (its driver facts stay); a photo that never arrived counts once its wait is over', () => {
    const k = deliveryKpis([
      v({ ...cam, outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', casesDelivered: 0 }), // the office found it was not delivered
      v({ ...cam, outcome: null, casesDelivered: null }), // the office cleared it
      v({ photoCount: 0, photoWaitOver: true }),
      v({ photoCount: 0, photoWaitOver: false }), // still on its way: not yet
    ]);
    expect(k).toMatchObject({ cameraFailed: 2, photoNotReceived: 1, withoutPhoto: 3, cameraAlertDays: 1, noResult: 1 });
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
  tables.user = [{ id: 'u1', name: 'Dispatcher Ali' }];
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
  tables.stopEvent = [];
  // A visit as the driver page leaves it: the driver's result is also the driver facts, and its OUTCOME
  // event is stored (an office Record rebuilds the visit from the events).
  const visit = (id: string, truckId: string, sequence: number, outcome: string, noPhotoReason: string | null, min: number, depotId = 'DA') => {
    const code = codes[truckId === 'T5' ? sequence - 1 : 4]!;
    const delivered = outcome === 'NOT_DELIVERED' ? 0 : outcome === 'PARTLY_DELIVERED' ? 6 : 10;
    const driverLike = outcome === 'DELIVERED' || outcome === 'PARTLY_DELIVERED';
    tables.stopEvent.push({
      id: `ev-${id}`, tenantId: T, depotId, deliveryDate: day(D), truckId, loadNo: 1, sequence, visitId: id, kind: 'OUTCOME', source: 'PHONE_MANUAL', at: at(min), receivedAt: at(min), userId: null,
      payloadJson: { outcome, reason: outcome === 'NOT_DELIVERED' ? 'SHOP_CLOSED' : outcome === 'PARTLY_DELIVERED' ? 'DAMAGED_GOODS' : null, note: null, lines: outcome === 'PARTLY_DELIVERED' ? [{ lineId: `${code}-1`, delivered: 6 }] : [], photoKeys: [], ...(noPhotoReason ? { noPhotoReason } : {}) },
    });
    return {
      id, tenantId: T, depotId, deliveryDate: day(D), truckId, loadNo: 1, sequence, customerId: `c-${code}`, outcome, noPhotoReason, outcomeAt: at(min), outcomeSource: 'PHONE_MANUAL',
      outcomeById: null, reason: outcome === 'NOT_DELIVERED' ? 'SHOP_CLOSED' : outcome === 'PARTLY_DELIVERED' ? 'DAMAGED_GOODS' : null, reasonNote: null, casesPlanned: 10, casesDelivered: delivered,
      linesJson: [{ orderId: `O-${code}`, lineId: `${code}-1`, productCode: 'W500', plannedCases: 10, deliveredCases: delivered }], photoKeysJson: null, photoCount: 0, arrivedAt: null, arrivalSource: null, arrivalObserved: true, departedAt: null, departedAtOutcome: false, timingSuspect: false,
      outcomeLate: false, autoArrivedAt: null, autoServiceMinutes: null, autoMinutes: null, autoBasis: null, plannedServiceMin: 20, windowStartMin: 480, windowEndMin: 720, arrivalDistanceM: null,
      plannedLat: null, plannedLng: null, locationPurgedAt: null,
      driverResultAt: driverLike ? at(min) : null, driverResultOutcome: driverLike ? outcome : null, driverNoPhotoReason: driverLike ? noPhotoReason : null, driverPhotoKeys: 0,
    };
  };
  tables.stopVisit = [
    visit('v1', 'T5', 1, 'DELIVERED', 'CAMERA_FAILED', 9 * 60 + 5),
    visit('v2', 'T5', 2, 'PARTLY_DELIVERED', 'CAMERA_FAILED', 9 * 60 + 40),
    visit('v3', 'T5', 3, 'DELIVERED', 'CAMERA_FAILED', 10 * 60 + 42),
    visit('v4', 'T5', 4, 'NOT_DELIVERED', null, 11 * 60),
    visit('v5', 'T6', 1, 'DELIVERED', 'CAMERA_FAILED', 8 * 60 + 50),
  ];
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
    expect(d.cameraAlerts).toEqual([{ date: D, truckId: 'T5', truckCode: 'T05', drivers: ['Salim'], count: 3, notReceived: 0 }]);
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
    for (const v of tables.stopVisit) v.driverNoPhotoReason = null;
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

describe('an office Record after "Camera not working" keeps the stop on every monitor (review of 5 Oct 2026)', () => {
  beforeEach(seed);
  const correct = (over: Record<string, unknown>) =>
    recordOfficeOutcome(T, { id: 'u1', name: 'Dispatcher Ali' }, { key: randomUUID(), depotId: 'DA', date: D, truckId: 'T5', loadNo: 1, sequence: 3, outcome: 'DELIVERED', reason: null, ...over } as never);

  it('T05 stop 3 confirmed, then Partly with the real cases, then Not delivered by the office: still listed "corrected by office", still in the KPI, the Excel and T05\'s 3 a day', async () => {
    for (const [over, after] of [
      [{}, 'corrected by office'],
      [{ outcome: 'PARTLY_DELIVERED', reason: 'DAMAGED_GOODS', lines: [{ lineId: 'GAMMA-1', delivered: 7 }] }, 'corrected by office: Partly delivered'],
      [{ outcome: 'NOT_DELIVERED', reason: 'CUSTOMER_REFUSED' }, 'corrected by office: Not delivered'],
    ] as const) {
      expect(await correct(over)).toMatchObject({ result: 'ok' });
      const v3 = tables.stopVisit.find((v) => v.id === 'v3')!;
      // The current result is the office's; the driver's facts did not move.
      expect(v3).toMatchObject({ outcomeSource: 'DISPATCHER', noPhotoReason: null, driverResultOutcome: 'DELIVERED', driverNoPhotoReason: 'CAMERA_FAILED', driverResultAt: at(10 * 60 + 42) });

      const d = await dayDeliveries(T, 'DA', D);
      const row = d.cameraExceptions.find((e) => e.sequence === 3 && e.truckCode === 'T05')!;
      expect(cameraExceptionText(row)).toBe(`T05 trip 1 stop 3 · GAMMA Store (GAMMA) · Salim · 10:42 · Delivered · ${after}`);
      expect(d.kpis).toMatchObject({ cameraFailed: 4, cameraAlertDays: 1 });
      expect(d.cameraAlerts.map((a) => [a.truckCode, a.count])).toEqual([['T05', 3]]);

      const o = (await readOutcomeOverlay(T, 'P1'))!;
      expect(o.cameraExceptions.filter((e) => e.truckCode === 'T05')).toHaveLength(3);
      expect(o.loads.L1!.cameraFailedToday).toBe(3);
      expect(o.stops['L1:3']!.noPhotoText).toBe(over.outcome === 'NOT_DELIVERED' ? null : 'no photo: camera failed (driver), corrected by office');

      expect((await rangeKpis(fakePrisma as never, T, { from: D, to: D })).cameraFailed).toBe(4);
      const res = await readActuals(T, { from: D, to: D }, null);
      const x = res.rows.find((r) => r.truck === 'T05' && r.stop === 3)!;
      expect(x).toMatchObject({ cameraException: 'Yes', noPhotoReason: 'Camera failed (driver)', noPhotoAfter: after, linkCameraCount: 3, driverResult: 'Delivered', driverResultTime: '10:42', recordedBy: 'Dispatcher Ali' });
    }
  });

  it('the audit keeps what the office replaced: the no-photo reason and the source of the result before, and the driver\'s mark after', async () => {
    await correct({ outcome: 'PARTLY_DELIVERED', reason: 'DAMAGED_GOODS', lines: [{ lineId: 'GAMMA-1', delivered: 7 }] });
    const a = tables.auditLog.find((x) => x.action === 'DELIVERY_OUTCOME_SET')!;
    expect(a.beforeJson).toMatchObject({ outcome: 'DELIVERED', noPhotoReason: 'CAMERA_FAILED', outcomeSource: 'PHONE_MANUAL', photoCount: 0 });
    expect(a.afterJson).toMatchObject({ source: 'DISPATCHER', outcome: 'PARTLY_DELIVERED', driverNoPhotoReason: 'CAMERA_FAILED', correction: true });
  });
});

describe('a result whose named photo never arrived is counted like "Camera not working" (review of 5 Oct 2026)', () => {
  beforeEach(() => {
    seed();
    // T06's driver saved EPSILON Delivered WITH a photo (queued, no signal); the photo did not arrive.
    const v5 = tables.stopVisit.find((v) => v.id === 'v5')!;
    Object.assign(v5, { noPhotoReason: null, driverNoPhotoReason: null, driverPhotoKeys: 1, photoKeysJson: ['k1'], photoCount: 0 });
    tables.driverLink = [{ id: 'dl6', tenantId: T, truckId: 'T6', deliveryDate: day(D), generation: 1, issuedAt: at(6 * 60), revokedAt: null, expiresAt: new Date(Date.now() + 24 * 3600_000) }];
    // The trip was completed 10 minutes ago: the photo may still come.
    tables.planLoad.find((l) => l.id === 'L2')!.statusChangedAt = new Date(Date.now() - 10 * 60_000);
  });
  const t06 = async () => (await dayDeliveries(T, 'DA', D)).cameraExceptions.filter((e) => e.truckCode === 'T06');

  it('not while it can still come; yes once the link is reissued after the result (the old phone cannot send it), and the Excel and KPI say "photo not received"', async () => {
    expect(await t06()).toEqual([]);
    expect((await dayDeliveries(T, 'DA', D)).kpis).toMatchObject({ cameraFailed: 3, photoNotReceived: 0 });
    tables.driverLink[0]!.issuedAt = at(12 * 60); // Reissue link at 12:00
    const rows = await t06();
    expect(rows.map((e) => [e.kind, cameraExceptionText(e)])).toEqual([['PHOTO_NOT_RECEIVED', 'T06 trip 1 stop 1 · EPSILON Store (EPSILON) · Rashid · 08:50 · Delivered · photo not received']]);
    expect((await dayDeliveries(T, 'DA', D)).kpis).toMatchObject({ cameraFailed: 3, photoNotReceived: 1, withoutPhoto: 4 });
    const res = await readActuals(T, { from: D, to: D }, null);
    expect(res.rows.find((r) => r.truck === 'T06')).toMatchObject({ cameraException: 'Yes', noPhotoReason: 'Photo not received', photos: 0, linkCameraCount: 1 });
    expect(res.kpis).toMatchObject({ photoNotReceived: 1 });
  });

  it('yes when the link is revoked, or the trip has been completed for an hour; and it counts towards the 3 a day of its link', async () => {
    tables.driverLink[0]!.revokedAt = new Date();
    expect(await t06()).toHaveLength(1);
    tables.driverLink[0]!.revokedAt = null;
    tables.planLoad.find((l) => l.id === 'L2')!.statusChangedAt = new Date(Date.now() - 61 * 60_000);
    expect(await t06()).toHaveLength(1);
    // Two "Camera not working" of T06 at another depot + this one: 3 for the link.
    tables.stopVisit.push(
      { ...tables.stopVisit[4]!, id: 'v6', depotId: 'DB', sequence: 1, driverNoPhotoReason: 'CAMERA_FAILED', driverPhotoKeys: 0 },
      { ...tables.stopVisit[4]!, id: 'v7', depotId: 'DB', sequence: 2, driverNoPhotoReason: 'CAMERA_FAILED', driverPhotoKeys: 0 },
    );
    const d = await dayDeliveries(T, 'DA', D);
    expect(d.cameraAlerts.find((a) => a.truckCode === 'T06')).toMatchObject({ count: 3 });
  });

  it('a photo that arrives takes it off', async () => {
    tables.driverLink[0]!.revokedAt = new Date();
    tables.stopVisit.find((v) => v.id === 'v5')!.photoCount = 1;
    expect(await t06()).toEqual([]);
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
    const col = headers.indexOf('Saved without a photo') + 1;
    expect(col).toBeGreaterThan(0);
    expect(ACTUALS_COLUMNS.map((c) => c.header)).toEqual(expect.arrayContaining(['Driver link: saved without a photo that day', 'Saved without a photo: changed after']));
    // The exception rows are filled amber; the others are not.
    expect((stops.getRow(2).getCell(col).fill as { fgColor?: { argb?: string } }).fgColor?.argb).toBe('FFFFE699');
    expect((stops.getRow(5).getCell(col).fill as { fgColor?: { argb?: string } } | undefined)?.fgColor?.argb).not.toBe('FFFFE699');
    const wp = wb.getWorksheet('Without photo')!;
    expect(wp.rowCount).toBe(5); // the header and 4 results
    expect((wp.getRow(1).values as unknown[]).slice(1)).toEqual([
      'Date', 'Depot', 'Truck', 'Trip', 'Stop', 'Customer code', 'Customer', 'Driver', 'Why', "Driver's result", 'Saved at', 'Changed after', 'Driver link: saved without a photo that day',
    ]);
    expect((wp.getRow(2).values as unknown[]).slice(1)).toEqual([D, 'A1', 'T05', 1, 1, 'ACME', 'ACME Store', 'Salim', 'Camera failed (driver)', 'Delivered', '09:05', undefined, 3]);
    const summary = (wb.getWorksheet('Summary')!.getSheetValues() as unknown[][]).filter(Boolean).map((r) => [r[1], r[2]]);
    expect(summary).toEqual(
      expect.arrayContaining([
        ['Saved without a photo (Camera not working)', 4],
        ['Saved without a photo (photo not received)', 0],
        ['Saved without a photo, of the delivered results', '4 of 4 delivered results (100 %)'],
        ['Driver links with 3 or more in a day', 1],
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

  it('the dispatcher guide (what it is, the daily check, the weekly review, a correction keeps it, a reissue drops queued photos), the driver guide in English and Arabic, the handbook', () => {
    const guide = doc('DISPATCHER_GUIDE.md');
    expect(guide).toContain('### Camera not working: results saved without a photo');
    expect(guide).toMatch(/every day/i);
    expect(guide).toMatch(/operations manager[^.]*every week/i);
    expect(guide).not.toContain('nobody can remove the mark');
    expect(guide).toMatch(/corrected by office/);
    expect(guide).toMatch(/photo not received/);
    expect(guide).toMatch(/Reissue link[^\n]*photos[^\n]*still waiting to send on the old phone/);
    const driver = doc('DRIVER_GUIDE.md');
    expect(driver).toMatch(/Camera not working[^\n]*recorded[^\n]*checked/);
    // Arabic: "every use is recorded and the office reviews it every day".
    expect(driver).toMatch(/الكاميرا لا تعمل[^\n]*وتراجعه الإدارة كل يوم/);
    expect(doc('PROJECT_HANDBOOK.md')).toContain('camera-exceptions.ts');
  });
});
