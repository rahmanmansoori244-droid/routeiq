/**
 * The "Delivery actuals" Excel (owner request 4 Oct 2026, spec section 11.3): the Stops, Summary and
 * Reasons sheets, one row per stop of a load that left, no money columns, the observed / late /
 * no-photo columns, and the rows read from the database (fake-plan-db.ts). Synthetic data only.
 */
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));

import { ACTUALS_COLUMNS, actualsRowOf, buildActualsWorkbook, readActuals } from '@/lib/delivery/actuals-workbook';
import { deliveryKpis, type KpiVisit } from '@/lib/delivery/kpis';
import { zonedDayStart } from '@/lib/dispatch/time';

const TZ = 'Asia/Muscat';
const D = '2026-10-05';
const dayStart = zonedDayStart(D, TZ);
const at = (min: number) => new Date(dayStart.getTime() + min * 60_000);
const stop = {
  date: D, depot: 'A1', truck: 'T05', hired: true, loadNo: 1, sequence: 3, customerCode: 'ACME', branch: null, customer: 'ACME', driver: 'Salim', dailyDriver: true,
  etaMin: 600, windowStartMin: 480, windowEndMin: 660, plannedServiceMin: 20, casesPlanned: 40, broughtForwardTo: null,
};
const visit = (over: Partial<KpiVisit> & Record<string, unknown> = {}) => ({
  outcome: 'DELIVERED', reason: null, casesPlanned: 40, casesDelivered: 40, arrivedAt: at(470), arrivalSource: 'PHONE_AUTO', arrivalObserved: true, timingSuspect: false,
  windowStartMin: 480, windowEndMin: 660, autoServiceMinutes: 21, plannedServiceMin: 20, outcomeLate: false, noPhotoReason: null, autoArrivedAt: at(470), deliveryDate: D, dayStart,
  autoBasis: 'DEPARTURE', departedAtOutcome: false, outcomeSource: 'PHONE_MANUAL', arrivalDistanceM: 12.4, outcomeAt: at(500), reasonNote: null, recordedBy: 'Driver link',
  ...over,
});

describe('the actuals rows (spec 11.3)', () => {
  it('an early observed arrival: inside the window, 10 min early, 10 min waiting; timed automatically; photos and distances', () => {
    const r = actualsRowOf(stop, visit() as never, [{ positionStatus: 'OK', distanceM: 38.2 }], TZ);
    expect(r).toMatchObject({
      hired: 'Yes', dailyDriver: 'Yes', plannedEta: '10:00', window: '08:00-11:00', actualArrival: '07:50', arrivalBy: 'Auto', insideWindow: 'Yes', earlyLateMin: -10,
      plannedUnloadMin: 20, actualUnloadMin: 21, waitingMin: 10, timedBy: 'Auto to departure', unverified: 'No', result: 'Delivered', casesNotDelivered: 0,
      late: 'No', photos: 1, photoLocation: 'OK', photoDistanceM: 38, arrivalDistanceM: 12, recordedBy: 'Driver link', resultTime: '08:20',
    });
  });

  it('a found (not observed) arrival does not count for the window; a late result, a camera failure and a missing result say so', () => {
    const found = actualsRowOf(stop, visit({ arrivalObserved: false, autoServiceMinutes: null, autoArrivedAt: null, autoBasis: null }) as never, [], TZ);
    expect(found).toMatchObject({ arrivalBy: 'Auto, not observed', insideWindow: '-', earlyLateMin: null, actualUnloadMin: null, waitingMin: null });
    const late = actualsRowOf(stop, visit({ outcome: 'PARTLY_DELIVERED', reason: 'DAMAGED_GOODS', casesDelivered: 34, outcomeLate: true, noPhotoReason: 'CAMERA_FAILED' }) as never, [], TZ);
    expect(late).toMatchObject({ result: 'Partly delivered', reason: 'Damaged goods', casesDelivered: 34, casesNotDelivered: 6, late: 'Yes', noPhotoReason: 'Camera failed (driver)', photos: 0 });
    const none = actualsRowOf(stop, null, [], TZ);
    expect(none).toMatchObject({ result: 'No result', casesPlanned: 40, casesDelivered: null, insideWindow: '-', recordedBy: null });
    const office = actualsRowOf(stop, visit({ outcomeSource: 'DISPATCHER', recordedBy: 'Dispatcher Ali', arrivalSource: 'DISPATCHER' }) as never, [], TZ);
    expect(office).toMatchObject({ arrivalBy: 'Office', noPhotoReason: 'Office result', recordedBy: 'Dispatcher Ali' });
  });

  it('the workbook: Stops, Summary and Reasons; the headers; one row per stop; no money anywhere', async () => {
    const rows = [actualsRowOf(stop, visit() as never, [], TZ), actualsRowOf({ ...stop, sequence: 4 }, visit({ outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', casesDelivered: 0 }) as never, [], TZ)];
    const kpis = deliveryKpis([visit() as never, visit({ outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', casesDelivered: 0 }) as never]);
    const buf = await buildActualsWorkbook(rows, { tenantName: 'Demo Co', from: D, to: D, depot: 'A1', generatedAt: new Date('2026-10-05T15:00:00Z'), generatedBy: 'Ali', kpis });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Stops', 'Summary', 'Reasons']);
    const s = wb.getWorksheet('Stops')!;
    const headers = (s.getRow(1).values as unknown[]).slice(1);
    expect(headers).toEqual(ACTUALS_COLUMNS.map((c) => c.header));
    expect(headers).toEqual(expect.arrayContaining(['Arrival by', 'Inside window', 'Recorded after the trip closed', 'No photo reason', 'Unverified timing', 'Hired', 'Daily driver']));
    expect(s.rowCount).toBe(3);
    const all = wb.worksheets.flatMap((w) => w.getSheetValues().flat().map(String)).join(' ').toLowerCase();
    for (const money of ['cost', 'price', 'sales', 'margin', 'omr', 'payment amount', 'revenue']) expect(all).not.toContain(money);
    const reasons = wb.getWorksheet('Reasons')!;
    expect((reasons.getRow(2).values as unknown[]).slice(1)).toEqual(['Shop closed', 1, 40]);
  });
});

describe('the actuals read from the database', () => {
  beforeEach(() => {
    resetDb();
    const day = new Date(`${D}T00:00:00Z`);
    tables.tenantConfig = [{ tenantId: 'tA', timezone: TZ, outcomesSince: new Date('2026-01-01T00:00:00Z') }];
    tables.depot = [{ id: 'DA', tenantId: 'tA', code: 'A1' }];
    tables.truck = [{ id: 'T5', tenantId: 'tA', code: 'T05', hired: false }];
    tables.order = [{ id: 'OA', tenantId: 'tA', customerId: 'c-ACME', customer: { code: 'ACME', name: 'ACME' }, lines: [{ id: 'OA-1', cases: 10, weightKg: 100, product: { code: 'W' } }] }];
    tables.runPlan = [{ id: 'P1', tenantId: 'tA', depotId: 'DA', runDate: day, status: 'DISPATCHED', version: 1, supersededAt: null, createdAt: new Date() }];
    tables.planLoad = [
      { id: 'L1', tenantId: 'tA', runId: 'P1', truckId: 'T5', loadNo: 1, status: 'COMPLETED', departMin: 420, returnMin: 800, driverId: null, breakJson: null },
      { id: 'L2', tenantId: 'tA', runId: 'P1', truckId: 'T5', loadNo: 2, status: 'PLANNED', departMin: 820, returnMin: 900, driverId: null, breakJson: null },
    ];
    tables.routeAssignment = [
      { id: 'a1', loadId: 'L1', orderId: 'OA', sequenceInTruck: 1, orderInStop: 0, etaMin: 500, serviceStartMin: 500, departureMin: 520, portionLinesJson: null, stopSnapshotJson: null },
      { id: 'a2', loadId: 'L2', orderId: 'OA', sequenceInTruck: 1, orderInStop: 0, etaMin: 830, serviceStartMin: 830, departureMin: 840, portionLinesJson: null, stopSnapshotJson: null },
    ];
    tables.stopVisit = [];
    tables.driverLink = [];
    tables.deliveryPhoto = [];
  });

  it('one row per stop of a load that left (a planned load is not in it), with its KPIs; a range over 31 days is refused', async () => {
    const res = await readActuals('tA', { from: D, to: D }, null);
    expect(res.rows.map((r) => [r.truck, r.trip, r.stop, r.result])).toEqual([['T05', 1, 1, 'No result']]);
    expect(res.kpis).toMatchObject({ stops: 1, noResult: 1 });
    await expect(readActuals('tA', { from: '2026-09-01', to: '2026-10-05' }, null)).rejects.toThrow();
  });
});
