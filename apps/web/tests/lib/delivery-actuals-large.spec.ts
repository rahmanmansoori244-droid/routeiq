/**
 * The "Delivery actuals" Excel at NMWC volume (review of 8 Oct 2026: web-exports-1, web-exports-2,
 * web-delivery-2). Synthetic data only, on the fake database (fake-plan-db.ts), which refuses a query
 * over PostgreSQL's 32,767 bind parameters as Prisma does.
 *
 *  - An export of every depot whose range held 32,766 or more dispatched orders or visits answered
 *    500: the photos and the brought-forward orders were asked for with every id of the range in one
 *    query, which Prisma cannot split (P2035 / P2029). Now they are asked for in parts of
 *    IN_LIST_PART.
 *  - Every photo of the range was scanned for every stop, every planned row for every load, and
 *    every time was formatted with a new Intl.DateTimeFormat: a month of one depot (12,400 stops)
 *    blocked the only web process for 10-25 s. Now the rows are grouped once and the formatter is
 *    reused: linear, well inside the time below on a busy PC.
 *  - The workbook is written row by row (ExcelJS's streaming writer) instead of being held whole
 *    in memory first, and the process gets a turn between rows: no long block while it is made.
 */
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { fakePrisma, resetDb, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));

import { ACTUALS_COLUMNS, buildActualsWorkbook, readActuals, type ActualsRow } from '@/lib/delivery/actuals-workbook';
import { deliveryKpis } from '@/lib/delivery/kpis';
import { IN_LIST_PART } from '@/lib/in-parts';
import { addDaysIso, zonedDayStart } from '@/lib/dispatch/time';

const T = 'tA';
const TZ = 'Asia/Muscat';
const FROM = '2026-09-01';
/** PostgreSQL's limit of bind parameters in one query. */
const PG_MAX_BINDS = 32_767;

/** The bind parameters a where clause needs: one per value, every value of a list included. */
function binds(where: unknown): number {
  if (Array.isArray(where)) return where.reduce((n: number, w) => n + binds(w), 0);
  if (where === null || where === undefined) return 0;
  if (where instanceof Date || typeof where !== 'object') return 1;
  return Object.values(where).reduce((n: number, v) => n + binds(v), 0);
}

/** The largest query made, per model. */
let largest: Record<string, number> = {};

/** Every read of the fake database refuses a query over PostgreSQL's limit, as Prisma does (P2029). */
function limitBinds() {
  for (const model of ['tenantConfig', 'runPlan', 'planLoad', 'truck', 'driver', 'depot', 'routeAssignment', 'stopVisit', 'driverLink', 'deliveryPhoto', 'user', 'order']) {
    for (const method of ['findMany', 'findFirst']) {
      const real = fakePrisma[model][method];
      vi.spyOn(fakePrisma[model], method).mockImplementation(async (...args: unknown[]) => {
        const a = (args[0] ?? {}) as { where?: unknown };
        const n = binds(a.where);
        largest[model] = Math.max(largest[model] ?? 0, n);
        if (n > PG_MAX_BINDS) {
          throw new Prisma.PrismaClientKnownRequestError(
            'Query parameter limit exceeded error: Parameter limits for this database provider require this query to be split into multiple queries, but the negation filters used prevent the query from being split.',
            { code: 'P2029', clientVersion: '5.22.0' },
          );
        }
        return real(a);
      });
    }
  }
}

/**
 * A synthetic month: `depots` depots x `days` days x `trucks` trucks x 2 trips x `stops` stops, every
 * stop one order, a Delivered visit and one photo. Every 40th order was brought forward to the next
 * day, every 97th visit was saved without a photo ("Camera not working").
 */
function seed(depots: number, days: number, trucks: number, stops: number): number {
  tables.tenantConfig = [{ tenantId: T, timezone: TZ, outcomesSince: new Date('2026-01-01T00:00:00Z') }];
  tables.depot = [];
  tables.truck = [];
  tables.runPlan = [];
  tables.planLoad = [];
  tables.routeAssignment = [];
  tables.order = [];
  tables.stopVisit = [];
  tables.deliveryPhoto = [];
  tables.driverLink = [];
  tables.user = [];
  let n = 0;
  for (let d = 0; d < depots; d++) {
    const depotId = `D${d}`;
    tables.depot.push({ id: depotId, tenantId: T, code: `DP${d}` });
    for (let t = 0; t < trucks; t++) tables.truck.push({ id: `${depotId}-T${t}`, tenantId: T, code: `T${d}${String(t).padStart(2, '0')}`, hired: false });
    for (let day = 0; day < days; day++) {
      const date = addDaysIso(FROM, day);
      const runDate = new Date(`${date}T00:00:00Z`);
      const dayStart = zonedDayStart(date, TZ);
      const runId = `${depotId}-P${day}`;
      tables.runPlan.push({ id: runId, tenantId: T, depotId, runDate, status: 'DISPATCHED', version: 1, supersededAt: null, createdAt: runDate });
      for (let t = 0; t < trucks; t++) {
        const truckId = `${depotId}-T${t}`;
        for (const loadNo of [1, 2]) {
          const loadId = `${runId}-${truckId}-L${loadNo}`;
          tables.planLoad.push({ id: loadId, tenantId: T, runId, truckId, loadNo, status: 'COMPLETED', departMin: 420, returnMin: 900, driverId: null, breakJson: null });
          for (let s = 1; s <= stops; s++) {
            n++;
            const orderId = `O${n}`;
            const carried = n % 40 === 0;
            tables.order.push({
              id: orderId,
              tenantId: T,
              customerId: `C${n}`,
              customer: { code: `C${n}`, name: `Customer ${n}`, branchCode: null },
              lines: [{ id: `${orderId}-1`, cases: 10, weightKg: 100, product: { code: 'W500' } }],
              carriedToOrderId: carried ? `${orderId}-next` : null,
              carriedTo: carried ? { deliveryDate: new Date(`${addDaysIso(date, 1)}T00:00:00Z`) } : null,
            });
            const eta = 420 + s * 20;
            tables.routeAssignment.push({ id: `A${n}`, loadId, orderId, sequenceInTruck: s, orderInStop: 0, etaMin: eta, serviceStartMin: eta, departureMin: eta + 15, portionLinesJson: null, stopSnapshotJson: null });
            const camera = n % 97 === 0;
            const visitId = `V${n}`;
            tables.stopVisit.push({
              id: visitId,
              tenantId: T,
              depotId,
              deliveryDate: runDate,
              truckId,
              loadNo,
              sequence: s,
              outcome: 'DELIVERED',
              reason: null,
              casesPlanned: 10,
              casesDelivered: 10,
              arrivedAt: new Date(dayStart.getTime() + (eta - 5) * 60_000),
              arrivalSource: 'PHONE_AUTO',
              arrivalObserved: true,
              timingSuspect: false,
              windowStartMin: null,
              windowEndMin: null,
              autoServiceMinutes: 14,
              plannedServiceMin: 15,
              outcomeLate: false,
              noPhotoReason: camera ? 'CAMERA_FAILED' : null,
              autoArrivedAt: new Date(dayStart.getTime() + (eta - 5) * 60_000),
              autoBasis: 'DEPARTURE',
              autoMinutes: 14,
              departedAt: null,
              departureSource: null,
              departedAtOutcome: false,
              outcomeSource: 'PHONE_MANUAL',
              outcomeById: null,
              outcomeAt: new Date(dayStart.getTime() + (eta + 10) * 60_000),
              arrivalDistanceM: 12,
              reasonNote: null,
              driverResultOutcome: 'DELIVERED',
              driverResultAt: new Date(dayStart.getTime() + (eta + 10) * 60_000),
              driverNoPhotoReason: camera ? 'CAMERA_FAILED' : null,
              driverPhotoKeys: camera ? 0 : 1,
              photoCount: camera ? 0 : 1,
            });
            if (!camera) tables.deliveryPhoto.push({ id: `PH${n}`, tenantId: T, visitId, positionStatus: 'OK', distanceM: 20 + (n % 30), takenAt: new Date(dayStart.getTime() + (eta + 8) * 60_000) });
          }
        }
      }
    }
  }
  return n;
}

beforeEach(() => {
  resetDb();
  largest = {};
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the actuals of every depot for a range with more ids than PostgreSQL takes in one query (web-exports-1)', () => {
  it('40,320 dispatched stops, orders, visits and photos: every row is read, no query passes the limit', async () => {
    const stops = seed(7, 6, 30, 16); // 7 depots x 6 days x 30 trucks x 2 trips x 16 stops
    expect(stops).toBe(40_320);
    expect(stops).toBeGreaterThan(PG_MAX_BINDS);
    limitBinds();
    const t0 = performance.now();
    const res = await readActuals(T, { from: FROM, to: addDaysIso(FROM, 5) }, null);
    const ms = performance.now() - t0;
    expect(res.rows).toHaveLength(stops);
    for (const model of Object.keys(largest)) expect(largest[model], model).toBeLessThanOrEqual(PG_MAX_BINDS);
    // The photos and the orders were asked for in parts of IN_LIST_PART ids (+ the company).
    expect(largest.deliveryPhoto).toBe(IN_LIST_PART + 1);
    expect(largest.order).toBe(IN_LIST_PART + 1);
    // The rows are right at both ends of the parts: the photo, the bring-forward date, the camera failure.
    const first = res.rows[0]!;
    expect(first).toMatchObject({ depot: 'DP0', date: FROM, trip: 1, stop: 1, result: 'Delivered', photos: 1, photoLocation: 'OK', cameraException: 'No' });
    const last = res.rows.at(-1)!;
    expect(last).toMatchObject({ depot: 'DP6', date: addDaysIso(FROM, 5), trip: 2, stop: 16, photos: 1 });
    const carried = res.rows.filter((r) => r.broughtForwardTo);
    expect(carried).toHaveLength(stops / 40);
    expect(carried.every((r) => r.broughtForwardTo === addDaysIso(r.date, 1))).toBe(true);
    const camera = res.rows.filter((r) => r.cameraException === 'Yes');
    expect(camera).toHaveLength(Math.floor(stops / 97));
    expect(camera.every((r) => r.photos === 0 && r.noPhotoReason === 'Camera failed (driver)')).toBe(true);
    expect(res.rows.filter((r) => r.photos === 1)).toHaveLength(stops - camera.length);
    expect(res.kpis).toMatchObject({ stops, delivered: stops, cameraFailed: camera.length });
    // Linear: about 1-2 s here with the fake database's own work; the old scans took minutes.
    expect(ms).toBeLessThan(20_000);
  });
});

/** `work`'s time and the longest stretch the event loop had no turn while it ran (a setImmediate ticker). */
async function longestBlock<R>(work: () => Promise<R>): Promise<{ value: R; ms: number; longestMs: number }> {
  let last = performance.now();
  let longestMs = 0;
  let on = true;
  const tick = () => {
    const now = performance.now();
    longestMs = Math.max(longestMs, now - last);
    last = now;
    if (on) setImmediate(tick);
  };
  setImmediate(tick);
  const t0 = performance.now();
  const value = await work();
  on = false;
  longestMs = Math.max(longestMs, performance.now() - last);
  return { value, ms: performance.now() - t0, longestMs };
}

/** Synthetic rows as readActuals makes them: every 50th saved without a photo, every 150th on a link that used it 3 times. */
function rowsOf(n: number): ActualsRow[] {
  return Array.from({ length: n }, (_, i) => {
    const camera = i % 50 === 0;
    return {
      date: '2026-09-05', depot: `DP${i % 7}`, truck: `T${i % 30}`, hired: 'No', trip: 1 + (i % 2), stop: 1 + (i % 16), customerCode: `C${i}`, branch: i % 3 ? null : 'B1',
      customer: `Customer ${i}`, driver: 'Salim', dailyDriver: 'No', plannedEta: '10:00', window: '08:00-11:00', actualArrival: '09:55', arrivalBy: 'Auto', insideWindow: 'Yes',
      earlyLateMin: 0, plannedUnloadMin: 15, actualUnloadMin: 14, waitingMin: 0, timedBy: 'Auto to departure', unverified: 'No', result: 'Delivered', reason: null, note: null,
      casesPlanned: 10, casesDelivered: 10, casesNotDelivered: 0, broughtForwardTo: null, late: 'No', photos: camera ? 0 : 1, noPhotoReason: camera ? 'Camera failed (driver)' : null,
      cameraException: camera ? 'Yes' : 'No', noPhotoAfter: null, driverResult: camera ? 'Delivered' : null, driverResultTime: camera ? '10:20' : null,
      linkCameraCount: camera ? (i % 150 === 0 ? 3 : 1) : 0, photoLocation: camera ? null : 'OK', photoDistanceM: camera ? null : 25, arrivalDistanceM: 12, recordedBy: 'Driver link', resultTime: '10:25',
    };
  });
}
const META = { tenantName: 'Synthetic Water Co', from: '2026-09-01', to: '2026-09-30', depot: null, generatedAt: new Date('2026-10-05T15:00:00Z'), generatedBy: 'Ali', kpis: deliveryKpis([]), tz: TZ };

describe('the workbook is written row by row, the web process getting turns (web-exports-2)', () => {
  it('40,000 stops: no stretch without a turn near the 10 s the in-memory workbook blocked for', async () => {
    const res = await longestBlock(() => buildActualsWorkbook(rowsOf(40_000), META));
    expect(res.value.subarray(0, 2).toString()).toBe('PK'); // a zip (xlsx)
    expect(res.value.length).toBeGreaterThan(1_000_000);
    // About 0.1-0.3 s here (the in-memory workbook: one block of about 10 s and 1.1 GB more heap).
    expect(res.longestMs).toBeLessThan(2_000);
  });

  it('the same sheets, styles and layout: frozen panes, filter, widths, bold headers, amber rows, red counts', async () => {
    const rows = rowsOf(301);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildActualsWorkbook(rows, META)) as never);
    expect(wb.creator).toBe('RouteIQ');
    expect(wb.created?.toISOString()).toBe('2026-10-05T15:00:00.000Z');
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Stops', 'Summary', 'Without photo', 'Reasons']);
    const s = wb.getWorksheet('Stops')!;
    expect(s.rowCount).toBe(302);
    expect(s.views).toEqual([expect.objectContaining({ state: 'frozen', xSplit: 3, ySplit: 1 })]);
    expect(s.autoFilter).toBe(`A1:${s.getColumn(ACTUALS_COLUMNS.length).letter}1`);
    // ExcelJS leaves a width of 9 (its default) out of the file, the in-memory workbook too.
    expect(ACTUALS_COLUMNS.map((c, i) => s.getColumn(i + 1).width)).toEqual(ACTUALS_COLUMNS.map((c) => (c.width === 9 ? undefined : c.width)));
    expect(s.getRow(1).getCell(1)).toMatchObject({ value: 'Date', font: { bold: true }, alignment: { wrapText: true, vertical: 'top' } });
    expect((s.getRow(302).values as unknown[]).slice(1, 7)).toEqual(['2026-09-05', 'DP6', 'T0', 'No', 1, 13]);
    // Row 2 is stop 0 (saved without a photo, on a link that used it 3 times): every cell amber, the count red.
    const count = ACTUALS_COLUMNS.findIndex((c) => c.key === 'linkCameraCount') + 1;
    for (let c = 1; c <= ACTUALS_COLUMNS.length; c++) expect((s.getRow(2).getCell(c).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb, `column ${c}`).toBe('FFFFE699');
    expect(s.getRow(2).getCell(count).font).toMatchObject({ bold: true, color: { argb: 'FFC00000' } });
    expect((s.getRow(3).getCell(1).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb).toBeUndefined();
    expect(s.getRow(52).getCell(count)).toMatchObject({ value: 1 }); // stop 50: once that day, not red
    expect(s.getRow(52).getCell(count).font?.color?.argb).toBeUndefined();
    const wp = wb.getWorksheet('Without photo')!;
    expect(wp.views).toEqual([expect.objectContaining({ state: 'frozen', ySplit: 1 })]);
    expect(wp.rowCount).toBe(1 + 7); // stops 0, 50, ..., 300
    expect(wp.getRow(2).getCell(13)).toMatchObject({ value: 3, font: { bold: true, color: { argb: 'FFC00000' } } });
    expect((wb.getWorksheet('Summary')!.getSheetValues() as unknown[][]).find((r) => r?.[1] === 'Made')?.[2]).toBe('2026-10-05 19:00 by Ali');
  });
});

describe('a month of one depot is read in linear time (web-exports-2, web-delivery-2)', () => {
  it('12,400 stops (31 days x 400): well under the 10-25 s the scans took', async () => {
    const stops = seed(1, 31, 25, 8); // 1 depot x 31 days x 25 trucks x 2 trips x 8 stops
    expect(stops).toBe(12_400);
    const t0 = performance.now();
    const res = await readActuals(T, { from: FROM, to: addDaysIso(FROM, 30) }, 'D0');
    const ms = performance.now() - t0;
    expect(res.rows).toHaveLength(stops);
    expect(res.depot).toBe('DP0');
    expect(ms).toBeLessThan(4_000);
  });
});
