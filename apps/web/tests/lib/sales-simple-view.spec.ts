/**
 * What the salesman page is sent (owner feedback of 20 Oct 2026: "make it very simple"): lib/sales-link/simple-view.ts
 * salesRouteView, pure. Invented data only (sales-day-fixture.ts).
 *
 *  - every detailed status and every kind of order not on a truck has exactly one simple status: delivered, partly,
 *    not delivered (a trip that never left too), not confirmed (no result: never guessed), on the way (planned, being
 *    loaded, on the road, at the customer), delayed (after the printed window), cancelled, not in the plan;
 *  - one time: delivered at; the expected time rounded to 5 and never past - live, "any minute" when due now, the
 *    lower bound, else the planned time while still ahead; nothing when there is nothing better than a planned time
 *    already past; minutes from now on the delivery day only; none while the truck is at the customer;
 *  - delayed: late against the window (the expected time, the window over, or the lower bound past it); never before
 *    the delivery day, never while at the customer;
 *  - the order: by time, then the orders cancelled, then those not on a truck (one row per customer and kind);
 *  - nothing else: no truck, trip, stop, window, reason, invoice, customer code, position or id in the answer.
 */
import { describe, expect, it } from 'vitest';
import { buildSalesDay, type DayDelivery, type DayOffTruck, type DayView, type DeliveryStatus, type OffTruckKind, type SalesDayInput } from '@/lib/sales-link/day';
import { salesRouteView } from '@/lib/sales-link/simple-view';
import type { SalesRow, SalesStatus } from '@/lib/sales-link/view-types';
import { at, DAY, dayInput, east, factsOf, gpsIn, hm, ln, load, planDetail, stop, TZ, visit } from './sales-day-fixture';

const simple = (input: SalesDayInput, route = 'R1') => {
  const v = buildSalesDay(input).routes.get(route);
  if (!v) throw new Error(`no route ${route}`);
  return salesRouteView(v, { date: input.date, tz: input.tz, now: input.now, builtAt: input.now });
};
const line = (r: SalesRow) => [r.customer, r.status, r.at ?? r.eta ?? '-', r.inMin ?? '-', r.atCustomer ? 'here' : ''].join(' ').trim();

// The day's three-stop trip of T05: stops at 08:00, 09:00, 10:00 (windows 07:45-08:45, 08:45-09:45, 09:45-10:45).
function trip(status: string) {
  return load({
    id: 'L1',
    status,
    stops: [
      stop({ seq: 1, customerId: 'c1', code: 'TST0001', name: 'Customer A', eta: hm(8), lines: [ln('o1', 'o1-l1', 'INV-1', 20, 'R1')] }),
      stop({ seq: 2, customerId: 'c2', code: 'TST0002', name: 'Customer B', eta: hm(9), lines: [ln('o2', 'o2-l1', 'INV-2', 12, 'R1')] }),
      stop({ seq: 3, customerId: 'c3', code: 'TST0003', name: 'Customer C', eta: hm(10), lines: [ln('o3', 'o3-l1', 'INV-3', 8, 'R1')] }),
    ],
  });
}
const plans = (status = 'DISPATCHED') => {
  const l = trip(status);
  return [{ detail: planDetail({ loads: [l] }), facts: factsOf(l.stops.flatMap((s) => s.orderLines.map((x) => ln(x.orderId, x.lineId, x.salesOrderNo, x.cases, 'R1')))) }];
};
const delivered = (seq: number, arr: string, dep: string) => visit({ seq, arrivedAt: at(arr), departedAt: at(dep), outcome: 'DELIVERED', outcomeAt: at(dep) });
const base = { loadTimes: new Map([['L1', at('07:00')]]) };

// A hand-made detailed delivery (one stop at 09:00, window 08:45-09:45) for the mapping rules.
const dd = (over: Partial<DayDelivery> = {}): DayDelivery => ({
  customerName: 'Customer A',
  customerCode: 'TST0001',
  branchCode: null,
  cases: 10,
  truckCode: 'T05',
  loadNo: 1,
  status: 'ON_THE_WAY',
  window: '08:45-09:45',
  slot: { from: hm(8, 45), to: hm(9, 45) },
  plannedMin: hm(9),
  at: null,
  atMin: null,
  delivered: null,
  eta: null,
  ...over,
});
const off = (kind: OffTruckKind, over: Partial<DayOffTruck> = {}): DayOffTruck => ({ kind, customerName: `Customer ${kind}`, customerCode: `TST-${kind}`, branchCode: null, cases: 3, movedTo: null, ...over });
const one = (deliveries: DayDelivery[], o: { now?: Date; offTruck?: DayOffTruck[] } = {}) =>
  salesRouteView({ kind: 'ROUTE', code: 'R1', query: 'R1', deliveries, offTruck: o.offTruck ?? [] } satisfies DayView, { date: DAY, tz: TZ, now: o.now ?? at('08:30'), builtAt: at('08:30') });

describe('one simple status per customer', () => {
  it('every detailed status maps to exactly one (owner: delivered, on the way, delayed, partly, not delivered, cancelled)', () => {
    const map: Record<DeliveryStatus, SalesStatus> = {
      DELIVERED: 'DELIVERED',
      PARTLY_DELIVERED: 'PARTLY_DELIVERED',
      NOT_DELIVERED: 'NOT_DELIVERED',
      TRUCK_DID_NOT_GO: 'NOT_DELIVERED',
      NO_RESULT: 'NOT_CONFIRMED',
      VISITED: 'NOT_CONFIRMED',
      AT_CUSTOMER: 'ON_THE_WAY',
      NEXT: 'ON_THE_WAY',
      ON_THE_WAY: 'ON_THE_WAY',
      PASSED: 'ON_THE_WAY',
      LOADING: 'ON_THE_WAY',
      PLANNED: 'ON_THE_WAY',
    };
    for (const [status, simpleStatus] of Object.entries(map)) expect([status, one([dd({ status: status as DeliveryStatus })]).rows[0]!.status]).toEqual([status, simpleStatus]);
  });

  it('every kind of order not on a truck: cancelled, or not in the plan with why (moved with its day, not planned yet, left out)', () => {
    const v = one([], {
      offTruck: [off('CANCELLED'), off('NOT_PLANNED'), off('PART_NOT_PLANNED'), off('ADDED_AFTER_PLAN'), off('NOT_PLANNED_YET'), off('MOVED', { movedTo: '2026-10-21' })],
    });
    expect(v.rows.map((r) => `${r.key} ${r.status} ${r.off ?? '-'} ${r.movedTo ?? '-'}`)).toEqual([
      'o1 CANCELLED - -',
      'o2 NOT_IN_PLAN NOT_IN_PLAN -',
      'o3 NOT_IN_PLAN NOT_IN_PLAN -',
      'o4 NOT_IN_PLAN NOT_PLANNED_YET -',
      'o5 NOT_IN_PLAN NOT_PLANNED_YET -',
      'o6 NOT_IN_PLAN MOVED 2026-10-21',
    ]);
  });

  it('the same customer cancelled twice, or moved twice to one day, is one row', () => {
    const v = one([], { offTruck: [off('CANCELLED', { customerCode: 'X1' }), off('CANCELLED', { customerCode: 'X1' }), off('MOVED', { customerCode: 'X1', movedTo: '2026-10-21' }), off('MOVED', { customerCode: 'X1', movedTo: '2026-10-21' }), off('MOVED', { customerCode: 'X1', movedTo: '2026-10-22' })] });
    expect(v.rows.map((r) => `${r.status} ${r.movedTo ?? '-'}`)).toEqual(['CANCELLED -', 'NOT_IN_PLAN 2026-10-21', 'NOT_IN_PLAN 2026-10-22']);
  });

  it('a partial delivery says its cases; a delivery its time; nothing else is carried', () => {
    const v = one([dd({ status: 'PARTLY_DELIVERED', delivered: { cases: 6, of: 10 }, at: '08:20', atMin: hm(8, 20) }), dd({ status: 'DELIVERED', delivered: { cases: 10, of: 10 }, at: '08:25', atMin: hm(8, 25) })]);
    expect(v.rows[0]).toEqual({ key: 'd1', customer: 'Customer A', branch: null, status: 'PARTLY_DELIVERED', at: null, eta: null, inMin: null, atCustomer: false, cases: { delivered: 6, of: 10 }, off: null, movedTo: null });
    expect(v.rows[1]).toMatchObject({ status: 'DELIVERED', at: '08:25', cases: null });
  });
});

describe('one time: the approximate expected time and how far it is', () => {
  it('on the road: the live times rounded, with the minutes from now; delivered with its time', () => {
    const v = simple(dayInput({ ...base, plans: plans(), now: at('08:40'), visits: [delivered(1, '08:10', '08:25')], phoneSeen: new Map([['t5', at('08:25')]]) }));
    expect(v.rows.map(line)).toEqual(['Customer A DELIVERED 08:25 -', 'Customer B ON_THE_WAY 09:10 30', 'Customer C ON_THE_WAY 10:10 90']);
    expect(v).toMatchObject({ kind: 'ROUTE', code: 'R1', query: 'R1', updated: '08:40' });
  });

  it('the clock pushed a stop: "any minute" (0) for it and the lower bound for the next - both delayed once past their windows; never "no update" words', () => {
    const v = simple(dayInput({ ...base, plans: plans(), now: at('10:00'), visits: [delivered(1, '08:10', '08:25')], phoneSeen: new Map([['t5', at('08:25')]]) }));
    expect(v.rows.map(line)).toEqual(['Customer A DELIVERED 08:25 -', 'Customer B DELAYED 10:00 0', 'Customer C DELAYED 11:00 60']);
    // An hour and a half later the times move on; the reason is never said.
    const later = simple(dayInput({ ...base, plans: plans(), now: at('11:30'), visits: [delivered(1, '08:10', '08:25')], phoneSeen: new Map([['t5', at('08:25')]]) }));
    expect(later.rows.map(line)).toEqual(['Customer A DELIVERED 08:25 -', 'Customer B DELAYED 11:30 0', 'Customer C DELAYED 12:30 60']);
    expect(JSON.stringify(later.rows)).not.toMatch(/update|before|reason|GPS|TRIP/i);
  });

  it('no live source at all: the planned time while it is still ahead; once it is past, no time (and delayed after the window)', () => {
    const v = simple(dayInput({ ...base, plans: plans(), now: at('08:00') }));
    expect(v.rows.map(line)).toEqual(['Customer A ON_THE_WAY 08:00 0', 'Customer B ON_THE_WAY 09:00 60', 'Customer C ON_THE_WAY 10:00 120']);
    const noon = simple(dayInput({ ...base, plans: plans(), now: at('12:00') }));
    expect(noon.rows.map(line)).toEqual(['Customer A DELAYED - -', 'Customer B DELAYED - -', 'Customer C DELAYED - -']);
  });

  it('the truck at the customer: being delivered now - no time, never delayed', () => {
    const v = simple(dayInput({ ...base, plans: plans(), now: at('09:55'), visits: [delivered(1, '08:10', '08:25'), visit({ seq: 2, arrivedAt: at('09:50') })], phoneSeen: new Map([['t5', at('09:50')]]) }));
    expect(v.rows[1]).toMatchObject({ customer: 'Customer B', status: 'ON_THE_WAY', atCustomer: true, eta: null, inMin: null });
  });

  it('late against the window by the expected time (GPS or the trip so far)', () => {
    const v = simple(dayInput({ ...base, plans: plans(), now: at('09:40'), visits: [delivered(1, '09:15', '09:30')], phoneSeen: new Map([['t5', at('09:30')]]) }));
    expect(v.rows.map(line)).toEqual(['Customer A DELIVERED 09:30 -', 'Customer B DELAYED 10:15 35', 'Customer C DELAYED 11:15 95']);
    const gps = simple(dayInput({ ...base, plans: plans(), now: at('08:40'), visits: [delivered(1, '08:10', '08:25')], phoneSeen: new Map([['t5', at('08:25')]]), gps: gpsIn({ fixAt: at('08:39'), pos: east(1500), trailTo: at('08:35') }) }));
    expect(gps.rows[1]).toMatchObject({ status: 'ON_THE_WAY', eta: '09:00', inMin: 20 });
  });

  it('the evening before (tomorrow\'s link): the planned times, no minutes, never delayed', () => {
    const v = simple(dayInput({ plans: plans('LOCKED'), now: at('21:00', '2026-10-18') }));
    expect(v.rows.map(line)).toEqual(['Customer A ON_THE_WAY 08:00 -', 'Customer B ON_THE_WAY 09:00 -', 'Customer C ON_THE_WAY 10:00 -']);
  });

  it('a trip that has not left yet today: as planned, counting down', () => {
    const v = simple(dayInput({ plans: plans('LOCKED'), now: at('06:00') }));
    expect(v.rows.map(line)).toEqual(['Customer A ON_THE_WAY 08:00 120', 'Customer B ON_THE_WAY 09:00 180', 'Customer C ON_THE_WAY 10:00 240']);
  });

  it('no result after the trip: not confirmed (never "delivered"); a trip of an earlier day that never left: not delivered', () => {
    const completed = simple(dayInput({ ...base, plans: plans('COMPLETED'), now: at('14:00'), visits: [delivered(1, '08:10', '08:25'), visit({ seq: 2, arrivedAt: at('09:05'), departedAt: at('09:20') })] }));
    expect(completed.rows.map((r) => r.status)).toEqual(['DELIVERED', 'NOT_CONFIRMED', 'NOT_CONFIRMED']);
    const past = simple(dayInput({ plans: plans('LOCKED'), now: at('01:00', '2026-10-20') }));
    expect(past.rows.map((r) => r.status)).toEqual(['NOT_DELIVERED', 'NOT_DELIVERED', 'NOT_DELIVERED']);
  });

  it('the minutes are from the moment asked (a memo read up to 30 s earlier) and never below 0; "updated" is when it was read', () => {
    const d = dd({ eta: { min: hm(9), notBeforeMin: null, source: 'TRIP', timing: 'ON_TIME' } });
    expect(one([d], { now: at('08:30') }).rows[0]).toMatchObject({ eta: '09:00', inMin: 30 });
    const later = salesRouteView({ kind: 'ROUTE', code: 'R1', query: 'R1', deliveries: [d], offTruck: [] }, { date: DAY, tz: TZ, now: new Date(at('09:00').getTime() + 20_000), builtAt: at('08:59') });
    expect(later).toMatchObject({ updated: '08:59', rows: [{ eta: '09:00', inMin: 0 }] });
  });
});

describe('the same customer twice (review of 20 Oct 2026: a split delivery or two trips were two rows alike)', () => {
  const mart = { customerName: 'Example Mart', customerCode: 'TST0007', branchCode: 'B2' } as const;
  const pending = (h: number, m: number) => dd({ ...mart, status: 'PLANNED', plannedMin: hm(h, m), slot: { from: hm(h, m) - 25, to: hm(h, m) + 50 } });

  it('two deliveries still to come are ONE row with the earliest time (one customer on the On the way button)', () => {
    const v = one([pending(14, 10), pending(9, 40)], { now: at('09:10') });
    expect(v.rows.map(line)).toEqual(['Example Mart ON_THE_WAY 09:40 30']);
    expect(v.rows[0]).toMatchObject({ key: 'd2', branch: 'B2' });
    // The same with the truck at the customer for the first: "being delivered now" (the later one waits its turn).
    const here = one([dd({ ...mart, status: 'AT_CUSTOMER', plannedMin: hm(9, 40) }), pending(14, 10)], { now: at('09:45') });
    expect(here.rows.map(line)).toEqual(['Example Mart ON_THE_WAY - - here']);
  });

  it('delivered twice: one row at the last time; partly twice: the cases added up; not delivered or not confirmed twice: one row', () => {
    const b = { customerName: 'Customer B', customerCode: 'TST0002', branchCode: null };
    const v = one(
      [
        dd({ ...mart, status: 'DELIVERED', at: '13:40', atMin: hm(13, 40) }),
        dd({ ...mart, status: 'DELIVERED', at: '09:20', atMin: hm(9, 20) }),
        dd({ ...b, status: 'PARTLY_DELIVERED', delivered: { cases: 6, of: 10 }, at: '10:00', atMin: hm(10) }),
        dd({ ...b, status: 'PARTLY_DELIVERED', delivered: { cases: 3, of: 8 }, at: '12:00', atMin: hm(12) }),
        dd({ customerName: 'Customer C', customerCode: 'TST0003', status: 'NOT_DELIVERED', at: '11:00', atMin: hm(11) }),
        dd({ customerName: 'Customer C', customerCode: 'TST0003', status: 'TRUCK_DID_NOT_GO', plannedMin: hm(11, 30) }),
        dd({ customerName: 'Customer D', customerCode: 'TST0004', status: 'NO_RESULT', plannedMin: hm(8) }),
        dd({ customerName: 'Customer D', customerCode: 'TST0004', status: 'VISITED', plannedMin: hm(8, 30) }),
      ],
      { now: at('14:00') },
    );
    expect(v.rows.map((r) => `${r.customer} ${r.status} ${r.at ?? '-'} ${r.cases ? `${r.cases.delivered}/${r.cases.of}` : '-'}`)).toEqual([
      'Customer D NOT_CONFIRMED - -',
      'Customer C NOT_DELIVERED - -',
      'Customer B PARTLY_DELIVERED - 9/18',
      'Example Mart DELIVERED 13:40 -',
    ]);
    // One partial delivery without its cases: the sum is not known, so none is said.
    const unknown = one([dd({ ...b, status: 'PARTLY_DELIVERED', delivered: { cases: 6, of: 10 } }), dd({ ...b, status: 'PARTLY_DELIVERED', delivered: null })]);
    expect(unknown.rows).toHaveLength(1);
    expect(unknown.rows[0]!.cases).toBeNull();
  });

  it('different statuses, or another branch of the same name, stay apart: each says something the other does not', () => {
    const v = one(
      [
        dd({ ...mart, status: 'DELIVERED', at: '09:45', atMin: hm(9, 45) }),
        pending(14, 10),
        dd({ ...mart, branchCode: 'B3', status: 'PLANNED', plannedMin: hm(15), slot: { from: hm(14, 45), to: hm(15, 45) } }),
      ],
      { now: at('13:50') },
    );
    expect(v.rows.map((r) => `${r.customer} ${r.branch} ${r.status} ${r.at ?? r.eta}`)).toEqual(['Example Mart B2 DELIVERED 09:45', 'Example Mart B2 ON_THE_WAY 14:10', 'Example Mart B3 ON_THE_WAY 15:00']);
  });

  it('on the real day: one customer on two trips of the route is one row (and one in the truck\'s view)', () => {
    const mk = (id: string, loadNo: number, departMin: number, eta: number, lineId: string, cases: number) =>
      load({ id, loadNo, status: 'LOCKED', departMin, returnMin: departMin + 180, stops: [stop({ seq: 1, customerId: 'c7', code: 'TST0007', name: 'Example Mart', eta, lines: [ln('o7', lineId, 'INV-7', cases, 'R1')] })] });
    const loads = [mk('L1', 1, hm(7), hm(9, 40), 'o7-l1', 20), mk('L2', 2, hm(13), hm(14, 10), 'o7-l2', 10)];
    const input = dayInput({ plans: [{ detail: planDetail({ loads }), facts: factsOf([ln('o7', 'o7-l1', 'INV-7', 20, 'R1'), ln('o7', 'o7-l2', 'INV-7', 10, 'R1')]) }], now: at('06:00') });
    const day = buildSalesDay(input);
    expect(day.routes.get('R1')!.deliveries).toHaveLength(2);
    const at0 = { date: DAY, tz: TZ, now: input.now, builtAt: input.now };
    for (const v of [salesRouteView(day.routes.get('R1')!, at0), salesRouteView([...day.trucks.values()][0]!, at0)]) {
      expect(v.rows.map(line)).toEqual(['Example Mart ON_THE_WAY 09:40 220']);
    }
  });
});

describe('the order and what is never sent', () => {
  it('by time (delivered at, else expected, else planned), then the cancelled, then the orders not on a truck', () => {
    const v = one(
      [
        dd({ customerName: 'Late one', plannedMin: hm(8), slot: { from: hm(7, 45), to: hm(8, 45) }, status: 'NEXT', eta: { min: hm(11), notBeforeMin: null, source: 'TRIP', timing: 'LATE' } }),
        dd({ customerName: 'Done', plannedMin: hm(9), status: 'DELIVERED', at: '08:20', atMin: hm(8, 20) }),
        dd({ customerName: 'Unknown', plannedMin: hm(10), status: 'NO_RESULT' }),
      ],
      { offTruck: [off('MOVED', { movedTo: '2026-10-21' }), off('CANCELLED')] },
    );
    expect(v.rows.map((r) => `${r.key} ${r.customer} ${r.status}`)).toEqual(['d2 Done DELIVERED', 'd3 Unknown NOT_CONFIRMED', 'd1 Late one DELAYED', 'o1 Customer CANCELLED CANCELLED', 'o2 Customer MOVED NOT_IN_PLAN']);
  });

  it('only the customer, the status and one time: no truck, trip, stop, window, reason, invoice, customer code, position or id', () => {
    const l = load({
      id: 'LOAD-ID-SENTINEL',
      truckId: 'TRUCK-ID-SENTINEL',
      truckCode: 'TRUCKCODE-SENTINEL',
      status: 'DISPATCHED',
      stops: [stop({ seq: 1, customerId: 'CUST-ID-SENTINEL', code: 'CUSTCODE-SENTINEL', name: 'Customer A', eta: hm(8), pin: { lat: 20.123456, lng: 55.987654 }, lines: [ln('ORDER-ID-SENTINEL', 'LINE-ID-SENTINEL', 'INV-SENTINEL', 5, 'R1')] })],
    });
    const input = dayInput({
      plans: [{ detail: planDetail({ depotId: 'DEPOT-ID-SENTINEL', runId: 'RUN-ID-SENTINEL', loads: [l] }), facts: factsOf([ln('ORDER-ID-SENTINEL', 'LINE-ID-SENTINEL', 'INV-SENTINEL', 5, 'R1')]) }],
      now: at('07:30'),
      loadTimes: new Map([['LOAD-ID-SENTINEL', at('07:00')]]),
      gps: gpsIn({ truckId: 'TRUCK-ID-SENTINEL', fixAt: at('07:29'), pos: east(500), depotId: 'DEPOT-ID-SENTINEL' }),
    });
    const day = buildSalesDay(input);
    const at0 = { date: DAY, tz: TZ, now: input.now, builtAt: input.now };
    for (const v of [salesRouteView(day.routes.get('R1')!, at0), salesRouteView([...day.trucks.values()][0]!, at0)]) {
      const text = JSON.stringify(v.rows);
      for (const s of ['SENTINEL', '20.12', '55.98', '07:45', '08:45', 'Trip', 'GPS']) expect(text).not.toContain(s);
      expect(Object.keys(v).sort()).toEqual(['code', 'kind', 'query', 'rows', 'updated']);
      for (const r of v.rows) expect(Object.keys(r).sort()).toEqual(['at', 'atCustomer', 'branch', 'cases', 'customer', 'eta', 'inMin', 'key', 'movedTo', 'off', 'status']);
    }
    // A truck's result names the truck only as the code it was found by (the heading the salesman typed).
    expect(salesRouteView([...day.trucks.values()][0]!, at0)).toMatchObject({ kind: 'TRUCK', code: 'TRUCKCODE-SENTINEL', query: 'Truck TRUCKCODE-SENTINEL' });
  });
});
