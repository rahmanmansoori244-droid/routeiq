/**
 * The "Delivery actuals" Excel (owner request 4 Oct 2026, spec section 11.3): the Stops, Summary and
 * Reasons sheets, one row per stop of a load that left, no money columns, the observed / late /
 * no-photo columns, and the rows read from the database (fake-plan-db.ts). Synthetic data only.
 */
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));

import { ACTUALS_COLUMNS, actualsRowOf, buildActualsWorkbook, madeAtText, readActuals } from '@/lib/delivery/actuals-workbook';
import { deliveryKpis, kpiHeadline, kpiOnTimeText, type KpiVisit } from '@/lib/delivery/kpis';
import { actualsDefaultRange, actualsRangeProblem, actualsUrl, countOf, officeTimesPrefill, officeTimesToSend } from '@/lib/delivery/office-text';
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
    const late = actualsRowOf(
      stop,
      visit({ outcome: 'PARTLY_DELIVERED', reason: 'DAMAGED_GOODS', casesDelivered: 34, outcomeLate: true, noPhotoReason: 'CAMERA_FAILED', driverResultOutcome: 'PARTLY_DELIVERED', driverNoPhotoReason: 'CAMERA_FAILED', driverResultAt: at(500) }) as never,
      [],
      TZ,
    );
    expect(late).toMatchObject({ result: 'Partly delivered', reason: 'Damaged goods', casesDelivered: 34, casesNotDelivered: 6, late: 'Yes', noPhotoReason: 'Camera failed (driver)', cameraException: 'Yes', noPhotoAfter: null, driverResult: 'Partly delivered', driverResultTime: '08:20', photos: 0 });
    // A named photo that never arrived (its wait is over) is saved without a photo too.
    const lost = actualsRowOf(stop, visit({ driverResultOutcome: 'DELIVERED', driverPhotoKeys: 1, photoCount: 0, photoWaitOver: true }) as never, [], TZ);
    expect(lost).toMatchObject({ noPhotoReason: 'Photo not received', cameraException: 'Yes', photos: 0 });
    expect(actualsRowOf(stop, visit({ driverResultOutcome: 'DELIVERED', driverPhotoKeys: 1, photoCount: 0, photoWaitOver: false }) as never, [], TZ)).toMatchObject({ noPhotoReason: null, cameraException: 'No' });
    const none = actualsRowOf(stop, null, [], TZ);
    expect(none).toMatchObject({ result: 'No result', casesPlanned: 40, casesDelivered: null, insideWindow: '-', recordedBy: null });
    const office = actualsRowOf(stop, visit({ outcomeSource: 'DISPATCHER', recordedBy: 'Dispatcher Ali', arrivalSource: 'DISPATCHER' }) as never, [], TZ);
    expect(office).toMatchObject({ arrivalBy: 'Office', noPhotoReason: 'Office result', recordedBy: 'Dispatcher Ali' });
  });

  it('"Actual unloading" is the value the plan screen shows (actualMinutes): office and manual timings too; "Timed by" names it', () => {
    // A phone-less daily driver: the dispatcher typed Arrived 10:05, Left 10:30.
    const office = actualsRowOf(
      stop,
      visit({ arrivalSource: 'DISPATCHER', departureSource: 'DISPATCHER', arrivedAt: at(605), departedAt: at(630), autoArrivedAt: null, autoServiceMinutes: null, autoMinutes: null, autoBasis: null, outcomeSource: 'DISPATCHER' }) as never,
      [],
      TZ,
    );
    expect(office).toMatchObject({ actualUnloadMin: 25, timedBy: 'Office' });
    // "I have arrived" (manual) and the driver's result 18 min later.
    const manual = actualsRowOf(
      stop,
      visit({ arrivalSource: 'PHONE_MANUAL', arrivedAt: at(600), departedAt: at(618), departedAtOutcome: true, autoArrivedAt: null, autoServiceMinutes: null, autoMinutes: null, autoBasis: null }) as never,
      [],
      TZ,
    );
    expect(manual).toMatchObject({ actualUnloadMin: 18, timedBy: 'Result time' });
    // Nothing to show: no "Timed by" either.
    const none = actualsRowOf(stop, visit({ arrivedAt: null, departedAt: null, autoArrivedAt: null, autoServiceMinutes: null, autoMinutes: null, autoBasis: null, arrivalSource: null }) as never, [], TZ);
    expect(none).toMatchObject({ actualUnloadMin: null, timedBy: null });
  });

  it('the workbook: Stops, Summary, Without photo and Reasons; the headers; one row per stop; no money anywhere', async () => {
    const rows = [actualsRowOf(stop, visit() as never, [], TZ), actualsRowOf({ ...stop, sequence: 4 }, visit({ outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', casesDelivered: 0 }) as never, [], TZ)];
    const kpis = deliveryKpis([visit() as never, visit({ outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', casesDelivered: 0 }) as never]);
    const buf = await buildActualsWorkbook(rows, { tenantName: 'Demo Co', from: D, to: D, depot: 'A1', generatedAt: new Date('2026-10-05T15:00:00Z'), generatedBy: 'Ali', kpis });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    // Owner decision 2 (5 Oct 2026): the "Without photo" sheet lists every result saved without a photo.
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Stops', 'Summary', 'Without photo', 'Reasons']);
    const s = wb.getWorksheet('Stops')!;
    const headers = (s.getRow(1).values as unknown[]).slice(1);
    expect(headers).toEqual(ACTUALS_COLUMNS.map((c) => c.header));
    expect(headers).toEqual(
      expect.arrayContaining(['Arrival by', 'Inside window', 'Recorded after the trip closed', 'No photo reason', 'Saved without a photo', 'Saved without a photo: changed after', 'Unverified timing', 'Hired', 'Daily driver']),
    );
    expect(s.rowCount).toBe(3);
    const all = wb.worksheets.flatMap((w) => w.getSheetValues().flat().map(String)).join(' ').toLowerCase();
    for (const money of ['cost', 'price', 'sales', 'margin', 'omr', 'payment amount', 'revenue']) expect(all).not.toContain(money);
    const reasons = wb.getWorksheet('Reasons')!;
    expect((reasons.getRow(2).values as unknown[]).slice(1)).toEqual(['Shop closed', 1, 40]);
    // Demo fix (4 Oct 2026): "Made" is Muscat time like every other time in the file (15:00 UTC = 19:00), never "UTC".
    const made = (wb.getWorksheet('Summary')!.getSheetValues() as unknown[][]).find((r) => r?.[1] === 'Made');
    expect(made?.[2]).toBe('2026-10-05 19:00 by Ali');
    expect(String(made?.[2])).not.toContain('UTC');
  });

  it('the Made line is in the company time zone, across midnight too (madeAtText)', () => {
    expect(madeAtText(new Date('2026-10-05T15:00:00Z'))).toBe('2026-10-05 19:00');
    expect(madeAtText(new Date('2026-10-05T21:30:00Z'))).toBe('2026-10-06 01:30'); // the next day in Muscat
    expect(madeAtText(new Date('2026-10-05T15:00:00Z'), 'UTC')).toBe('2026-10-05 15:00');
  });

  it('countOf: "1 stop", "2 stops", "0 stops" (the dashboard tile said "1 stops")', () => {
    expect(countOf(1, 'stop')).toBe('1 stop');
    expect(countOf(0, 'stop')).toBe('0 stops');
    expect(countOf(12, 'case')).toBe('12 cases');
    expect(countOf(1, 'observed arrival')).toBe('1 observed arrival');
    // The Deliveries card's sentences say it right with one stop and one observed arrival.
    const one = deliveryKpis([visit() as never]);
    expect(kpiHeadline(one)).toBe('1 of 1 stop has a result · 1 delivered in full · 0 partly · 0 not delivered · 0 no result yet');
    expect(kpiOnTimeText(one)).toBe('Arrived inside the window 100 % (of 1 observed arrival)');
  });
});

describe('the range picker on the Deliveries card (D9c: a day or a range)', () => {
  it('defaults to the 7 days up to the day on screen; at most 31 days; the same URL the route reads', () => {
    expect(actualsDefaultRange('2026-10-07')).toEqual({ from: '2026-10-01', to: '2026-10-07' });
    expect(actualsRangeProblem('2026-10-01', '2026-10-07')).toBeNull();
    expect(actualsRangeProblem('2026-09-01', '2026-10-01')).toBeNull(); // 31 days
    expect(actualsRangeProblem('2026-09-01', '2026-10-02')).toBe('At most 31 days at a time.');
    expect(actualsRangeProblem('2026-10-07', '2026-10-01')).toBe('"To" must not be before "From".');
    expect(actualsRangeProblem('', '2026-10-01')).toBe('Choose both dates.');
    expect(actualsUrl('2026-10-01', '2026-10-07', 'DA')).toBe('/api/dispatch/delivery-actuals?from=2026-10-01&to=2026-10-07&depotId=DA');
  });
});

describe('Record outcome: the stored Arrived / Left (review of 4 Oct 2026)', () => {
  it('prefills the stored times (never the result time as Left) and sends only a box the dispatcher changed', () => {
    const shown = officeTimesPrefill({ arrivedAt: at(605).toISOString(), departedAt: at(630).toISOString(), departedAtOutcome: false }, TZ);
    expect(shown).toEqual({ arrived: '10:05', left: '10:30' });
    expect(officeTimesPrefill({ arrivedAt: at(605).toISOString(), departedAt: at(1050).toISOString(), departedAtOutcome: true }, TZ)).toEqual({ arrived: '10:05', left: '' });
    expect(officeTimesPrefill(null, TZ)).toEqual({ arrived: '', left: '' });
    expect(officeTimesToSend(shown, shown)).toEqual({ arrivedAt: null, departedAt: null });
    expect(officeTimesToSend({ arrived: '09:55', left: '10:30' }, shown)).toEqual({ arrivedAt: '09:55', departedAt: null });
    expect(officeTimesToSend({ arrived: '', left: '10:40' }, { arrived: '', left: '' })).toEqual({ arrivedAt: null, departedAt: '10:40' });
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
    expect(res.tz).toBe(TZ); // the workbook prints "Made" in this zone
    await expect(readActuals('tA', { from: '2026-09-01', to: '2026-10-05' }, null)).rejects.toThrow();
  });
});
