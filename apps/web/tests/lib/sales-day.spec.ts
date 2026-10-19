/**
 * The salesman link's day (owner request 19 Oct 2026): lib/sales-link/day.ts buildSalesDay, pure. Invented
 * data only (tests/lib/sales-day-fixture.ts): customers TST0001.., "Example Mart", routes R1 / R2X / R10,
 * trucks T05 / T06, pins in empty desert.
 *
 *  - the status rules: every trip status x the delivery date before / on / after the company's today (critique
 *    item 2), and each live rule (at the customer, visited, still due, next, on the way, no result, probably over);
 *  - one stop holding two salesmen's lines: a row on each route with its own invoices, cases and result;
 *  - the expected time: GPS only while the fix is fresh AND the history covers it (critique 3), else the trip
 *    so far, the plan before the trip leaves, "due now" with no minutes when the clock pushed it, "no live
 *    updates" without any source (critique 4); late / early against the printed window (critique 5); a later
 *    trip moved by the trip before (critique 6); "should have left" (critique 14);
 *  - the orders not on a truck: cancelled (any plan state), moved (three ways), left out (salesman words), the
 *    rest of a split delivery under its own line's route only, received after planning, not planned yet
 *    (critique 7); notes; two depots merged; lines without a route on no page;
 *  - the truck card: the position only while the trip on the road has the route's deliveries to make, 3
 *    decimals (critique 10); pins at 4 decimals; nothing private in the answer;
 *  - parity with the printed Salesman ETA (salesmanEtaModel) on the same plan.
 */
import { describe, expect, it } from 'vitest';
import { buildSalesDay, etaView, type SalesDayInput } from '@/lib/sales-link/day';
import { salesmanEtaModel } from '@/lib/exports/salesman-eta';
import type { DeliveryStatus, SalesRouteView } from '@/lib/sales-link/view-types';
import { at, atMin, DAY, dayInput, east, extraOrder, factsOf, gpsIn, hm, ln, load, planDetail, stop, unserved, visit, type Ln } from './sales-day-fixture';

const view = (input: SalesDayInput, route = 'R1'): SalesRouteView => {
  const v = buildSalesDay(input).routes.get(route);
  if (!v) throw new Error(`no route ${route}`);
  return v;
};
const statusOf = (v: SalesRouteView) => v.deliveries.map((d) => `${d.customerCode} ${d.status}`);

// A three-stop trip of T05 from the D1 depot: 07:00-13:00, stops at 08:00, 09:00, 10:00 (15 min each).
const L1 = { a: ln('o1', 'o1-l1', 'INV-1', 20, 'R1'), b: ln('o2', 'o2-l1', 'INV-2', 12, 'R1'), c: ln('o3', 'o3-l1', 'INV-3', 8, 'R1') };
function trip(status: string, over: { departMin?: number; returnMin?: number; loadNo?: number; id?: string; date?: string } = {}) {
  return load({
    id: over.id ?? 'L1',
    status,
    loadNo: over.loadNo ?? 1,
    departMin: over.departMin ?? hm(7),
    returnMin: over.returnMin ?? hm(13),
    stops: [
      stop({ seq: 1, customerId: 'c1', code: 'TST0001', eta: hm(8), lines: [L1.a] }),
      stop({ seq: 2, customerId: 'c2', code: 'TST0002', eta: hm(9), lines: [L1.b] }),
      stop({ seq: 3, customerId: 'c3', code: 'TST0003', eta: hm(10), lines: [L1.c] }),
    ],
  });
}
const onePlan = (loads = [trip('DISPATCHED')], o: { unserved?: ReturnType<typeof unserved>[]; facts?: ReturnType<typeof factsOf> } = {}) => [
  { detail: planDetail({ loads, unserved: o.unserved }), facts: o.facts ?? factsOf(loads.flatMap((l) => l.stops.flatMap((s) => s.orderLines.map((x) => ln(x.orderId, x.lineId, x.salesOrderNo, x.cases, 'R1'))))) },
];
const delivered = (seq: number, arr: string, dep: string, extra: Partial<Parameters<typeof visit>[0]> = {}) =>
  visit({ seq, arrivedAt: at(arr), departedAt: at(dep), outcome: 'DELIVERED', outcomeAt: at(dep), ...extra });

// ---------------------------------------------------------------------------------------------
// The status rules
// ---------------------------------------------------------------------------------------------

describe('every trip status x the delivery date before, on and after the company today (critique item 2)', () => {
  const NOW = {
    // 01:00 on the day after: the link still works (until 06:00), the trips are of "yesterday".
    PAST: at('01:00', '2026-10-20'),
    TODAY: at('07:20'),
    // 21:00 the evening before: tomorrow's trucks are loaded tonight.
    FUTURE: at('21:00', '2026-10-18'),
  } as const;
  const cells: [string, keyof typeof NOW, DeliveryStatus, string | null][] = [
    ['PLANNED', 'PAST', 'TRUCK_DID_NOT_GO', null],
    ['LOCKED', 'PAST', 'TRUCK_DID_NOT_GO', null],
    ['LOADING', 'PAST', 'TRUCK_DID_NOT_GO', null],
    ['DISPATCHED', 'PAST', 'NO_RESULT', 'Trip probably finished - result not recorded'],
    ['COMPLETED', 'PAST', 'NO_RESULT', 'Trip finished - no result recorded'],
    ['PLANNED', 'TODAY', 'PLANNED', null],
    ['LOCKED', 'TODAY', 'PLANNED', null],
    ['LOADING', 'TODAY', 'LOADING', null],
    ['DISPATCHED', 'TODAY', 'NEXT', null],
    ['COMPLETED', 'TODAY', 'NO_RESULT', 'Trip finished - no result recorded'],
    ['PLANNED', 'FUTURE', 'PLANNED', null],
    ['LOCKED', 'FUTURE', 'PLANNED', null],
    // Loaded the evening before (carry-over.ts header): never "no rule" (critique item 2).
    ['LOADING', 'FUTURE', 'LOADING', null],
    ['DISPATCHED', 'FUTURE', 'NEXT', null],
    ['COMPLETED', 'FUTURE', 'NO_RESULT', 'Trip finished - no result recorded'],
  ];
  it.each(cells)('%s trip, %s: the first stop is %s', (status, rel, expected, detail) => {
    const now = NOW[rel];
    const v = view(dayInput({ plans: onePlan([trip(status)]), now, loadTimes: new Map([['L1', at('07:00')]]) }));
    const first = v.deliveries[0]!;
    expect(first.status).toBe(expected);
    if (detail) expect(first.detailText).toBe(detail);
    // Before the delivery day: the printed window only, no live time.
    if (rel === 'FUTURE') expect(first.eta).toBeNull();
    expect(first.window).toBe('07:45-08:45');
  });

  it('a trip still out after midnight (now past 1440) is followed while the phone is heard, not "finished"', () => {
    const v = view(dayInput({ plans: onePlan([trip('DISPATCHED')]), now: at('01:00', '2026-10-20'), loadTimes: new Map([['L1', at('07:00')]]), phoneSeen: new Map([['t5', at('00:50', '2026-10-20')]]) }));
    expect(statusOf(v)).toEqual(['TST0001 NEXT', 'TST0002 ON_THE_WAY', 'TST0003 ON_THE_WAY']);
    // Its expected time is behind the clock: "due now", no minutes (critique 4).
    expect(v.deliveries[0]!.eta).toMatchObject({ timing: 'DUE_NOW', expected: null, lateMin: null });
  });

  it('PLANNED trips carry the "not locked" note; a locked trip does not', () => {
    const planned = view(dayInput({ plans: onePlan([trip('PLANNED')]), now: at('05:00') }));
    expect(planned.notLocked).toBe(true);
    expect(planned.deliveries[0]!.notes).toContain('Not locked yet: times can change if the day is re-planned');
    const locked = view(dayInput({ plans: onePlan([trip('LOCKED')]), now: at('05:00') }));
    expect(locked.notLocked).toBe(false);
    expect(locked.deliveries[0]!.notes).toEqual([]);
  });
});

describe('the live rules of a trip on the road', () => {
  const base = { loadTimes: new Map([['L1', at('07:00')]]) };

  it('a result: delivered with its time; the next stop and the one after with stops before', () => {
    const v = view(dayInput({ ...base, plans: onePlan(), now: at('08:40'), visits: [delivered(1, '08:10', '08:25')], phoneSeen: new Map([['t5', at('08:25')]]) }));
    expect(statusOf(v)).toEqual(['TST0001 DELIVERED', 'TST0002 NEXT', 'TST0003 ON_THE_WAY']);
    expect(v.deliveries[0]).toMatchObject({ at: '08:25', detailText: 'Delivered 08:25', delivered: { cases: 20, of: 20 }, reason: null, eta: null });
    expect(v.deliveries[1]).toMatchObject({ stopsBefore: 0, eta: { expected: '09:10', source: 'TRIP', timing: 'ON_TIME', text: 'Expected about 09:10 - within 08:45-09:45' } });
    expect(v.deliveries[2]).toMatchObject({ stopsBefore: 1, detailText: 'Expected about 10:10 - within 09:45-10:45 · 1 stop before' });
    expect(v.counts).toMatchObject({ delivered: 1, now: 1, onTheWay: 1, delayed: 0 });
  });

  it('at the customer: arrived, no departure, no result, nothing later - also by a delivery photo alone', () => {
    const tapped = view(dayInput({ ...base, plans: onePlan(), now: at('09:10'), visits: [delivered(1, '08:10', '08:25'), visit({ seq: 2, arrivedAt: at('09:05') })], phoneSeen: new Map([['t5', at('09:05')]]) }));
    expect(tapped.deliveries[1]).toMatchObject({ status: 'AT_CUSTOMER', statusText: 'Truck at the customer now', detailText: 'Truck there since 09:05', eta: null });
    const photo = view(
      dayInput({
        ...base,
        plans: onePlan(),
        now: at('09:10'),
        visits: [delivered(1, '08:10', '08:25'), visit({ seq: 2, photos: [{ source: 'PHONE_MANUAL', takenAt: at('09:05'), receivedAt: at('09:06'), oldPhoto: false }] })],
      }),
    );
    expect(photo.deliveries[1]).toMatchObject({ status: 'AT_CUSTOMER', detailText: 'Truck there since 09:05 (delivery photo)' });
  });

  it('visited: arrived and left without a result yet', () => {
    const v = view(dayInput({ ...base, plans: onePlan(), now: at('09:30'), visits: [delivered(1, '08:10', '08:25'), visit({ seq: 2, arrivedAt: at('09:05'), departedAt: at('09:20') })] }));
    expect(v.deliveries[1]).toMatchObject({ status: 'VISITED', detailText: 'Truck was there 09:05-09:20 - result not sent yet' });
  });

  it('still due (critique 13): not reached while a later stop was; its time comes after the stops still ahead', () => {
    const v = view(dayInput({ ...base, plans: onePlan(), now: at('09:10'), visits: [delivered(2, '08:45', '09:00')], phoneSeen: new Map([['t5', at('09:00')]]) }));
    expect(statusOf(v)).toEqual(['TST0001 PASSED', 'TST0002 DELIVERED', 'TST0003 NEXT']);
    const passed = v.deliveries[0]!;
    expect(passed.statusText).toBe('Still due');
    expect(passed.detailText).toBe('Still due - the driver is serving other customers first · 1 stop before');
    // After stop 3 (expected 09:45, leaves 10:00), plus its own planned leg (60 min): 11:00.
    expect(passed.eta).toMatchObject({ expected: '11:00', source: 'TRIP', timing: 'LATE' });
  });

  it('no result after the trip: Completed, or Back at depot tapped; with the times the truck was seen (critique 12)', () => {
    const completed = view(dayInput({ ...base, plans: onePlan([trip('COMPLETED')]), now: at('14:00'), visits: [delivered(1, '08:10', '08:25'), visit({ seq: 2, arrivedAt: at('09:05'), departedAt: at('09:20') })] }));
    expect(statusOf(completed)).toEqual(['TST0001 DELIVERED', 'TST0002 NO_RESULT', 'TST0003 NO_RESULT']);
    expect(completed.deliveries[1]!.detailText).toBe('Truck stopped there 09:05-09:20 - result not recorded');
    expect(completed.deliveries[2]!.detailText).toBe('Trip finished - no result recorded');
    const back = view(dayInput({ ...base, plans: onePlan(), now: at('12:00'), visits: [delivered(1, '08:10', '08:25')], backAt: new Map([[`D1|${DAY}|t5|1`, at('11:30')]]) }));
    expect(statusOf(back)).toEqual(['TST0001 DELIVERED', 'TST0002 NO_RESULT', 'TST0003 NO_RESULT']);
    expect(back.deliveries.some((d) => d.statusText === 'Delivered' && d.status !== 'DELIVERED')).toBe(false);
  });

  it('probably over (critique 4): past the planned return + 60 min with no sign for an hour', () => {
    const v = view(dayInput({ ...base, plans: onePlan(), now: at('14:30'), visits: [delivered(1, '08:10', '08:25')], phoneSeen: new Map([['t5', at('08:25')]]) }));
    expect(statusOf(v)).toEqual(['TST0001 DELIVERED', 'TST0002 NO_RESULT', 'TST0003 NO_RESULT']);
    expect(v.deliveries[1]!.detailText).toBe('Trip probably finished - result not recorded');
    expect(v.trucks[0]!.trip).toMatchObject({ status: 'DISPATCHED', text: 'Trip 1 probably finished - not closed yet' });
    // A truck still tapping late in the day is followed.
    const busy = view(dayInput({ ...base, plans: onePlan(), now: at('14:30'), visits: [delivered(1, '13:50', '14:20')], phoneSeen: new Map([['t5', at('14:20')]]) }));
    expect(busy.deliveries[1]!.status).toBe('NEXT');
  });
});

describe('route R of a stop holding two salesmen\'s lines', () => {
  const shared = stop({ seq: 1, customerId: 'c1', code: 'TST0001', eta: hm(8), lines: [ln('o1', 'o1-l1', 'INV-1', 20, 'R1'), ln('o1', 'o1-l2', 'INV-1', 10, 'R2X'), ln('o9', 'o9-l1', 'INV-9', 6, 'R2X')] });
  const plans = () => {
    const l = load({ id: 'L1', status: 'DISPATCHED', stops: [shared] });
    return [{ detail: planDetail({ loads: [l] }), facts: factsOf(l.stops.flatMap((s) => s.orderLines.map((x) => ln(x.orderId, x.lineId, x.salesOrderNo, x.cases, x.lineId === 'o1-l1' ? 'R1' : 'R2X')))) }];
  };

  it('a row on each route with only its own invoices and cases', () => {
    const day = buildSalesDay(dayInput({ plans: plans(), now: at('07:30') }));
    expect([...day.routes.keys()]).toEqual(['R1', 'R2X']);
    expect(day.routes.get('R1')!.deliveries.map((d) => [d.invoices, d.cases])).toEqual([[['INV-1'], 20]]);
    expect(day.routes.get('R2X')!.deliveries.map((d) => [d.invoices, d.cases])).toEqual([[['INV-1', 'INV-9'], 16]]);
  });

  it("a stop partly delivered overall is fully delivered for R1 and not delivered for R2X, with the driver's reason", () => {
    const v = visit({
      seq: 1,
      arrivedAt: at('08:05'),
      departedAt: at('08:20'),
      outcome: 'PARTLY_DELIVERED',
      outcomeAt: at('08:20'),
      reason: 'SHOP_CLOSED',
      lines: [
        { orderId: 'o1', lineId: 'o1-l1', plannedCases: 20, deliveredCases: 20 },
        { orderId: 'o1', lineId: 'o1-l2', plannedCases: 10, deliveredCases: 0 },
        { orderId: 'o9', lineId: 'o9-l1', plannedCases: 6, deliveredCases: 0 },
      ],
    });
    const day = buildSalesDay(dayInput({ plans: plans(), now: at('08:30'), visits: [v] }));
    expect(day.routes.get('R1')!.deliveries[0]).toMatchObject({ status: 'DELIVERED', delivered: { cases: 20, of: 20 }, reason: null });
    expect(day.routes.get('R2X')!.deliveries[0]).toMatchObject({ status: 'NOT_DELIVERED', delivered: { cases: 0, of: 16 }, reason: 'Shop closed (as reported by the driver)', detailText: 'Not delivered (08:20)' });
  });

  it('partly for the route: x of y; the office\'s result says so; a null count follows the outcome (deliveredOf)', () => {
    const v = visit({
      seq: 1,
      outcome: 'PARTLY_DELIVERED',
      outcomeAt: at('08:20'),
      outcomeSource: 'DISPATCHER',
      reason: 'CUSTOMER_REFUSED',
      lines: [
        { orderId: 'o1', lineId: 'o1-l1', plannedCases: 20, deliveredCases: null },
        { orderId: 'o1', lineId: 'o1-l2', plannedCases: 10, deliveredCases: 4 },
        { orderId: 'o9', lineId: 'o9-l1', plannedCases: 6, deliveredCases: 6 },
      ],
    });
    const day = buildSalesDay(dayInput({ plans: plans(), now: at('08:30'), visits: [v] }));
    expect(day.routes.get('R1')!.deliveries[0]!.status).toBe('DELIVERED');
    expect(day.routes.get('R2X')!.deliveries[0]).toMatchObject({ status: 'PARTLY_DELIVERED', delivered: { cases: 10, of: 16 }, reason: 'Customer refused (recorded by the office)', detailText: 'Delivered 10 of 16 cases at 08:20' });
  });
});

// ---------------------------------------------------------------------------------------------
// The expected time
// ---------------------------------------------------------------------------------------------

describe('the expected time and where it comes from', () => {
  const base = { loadTimes: new Map([['L1', at('07:00')]]), visits: [delivered(1, '08:10', '08:25')], phoneSeen: new Map([['t5', at('08:25')]]) };
  // Between stop 1 (1 km east) and stop 2 (2 km east), heading for stop 2.
  const fix = east(1500);

  it('GPS while the fix is fresh and the history covers it (critique 3); the truck card shows the position', () => {
    const v = view(dayInput({ ...base, plans: onePlan(), now: at('08:40'), gps: gpsIn({ fixAt: at('08:39'), pos: fix, trailTo: at('08:35') }) }));
    expect(v.deliveries[1]!.eta).toMatchObject({ source: 'GPS', expected: '09:00', timing: 'ON_TIME', text: 'Expected about 09:00 (GPS) - within 08:45-09:45' });
    expect(v.deliveries[2]!.eta!.source).toBe('GPS');
    const truck = v.trucks[0]!;
    expect(truck.position).toMatchObject({ lat: 20.1, lng: 55.114, updatedText: 'Updated 08:39', stale: false, moving: true });
    expect(truck.gpsText).toBe('GPS: updated 08:39');
  });

  it('the trip so far when the fix is old, when the history is behind it, or without GPS', () => {
    const stale = view(dayInput({ ...base, plans: onePlan(), now: at('08:40'), gps: gpsIn({ fixAt: at('08:20'), pos: fix, trailTo: at('08:20') }) }));
    expect(stale.deliveries[1]!.eta!.source).toBe('TRIP');
    expect(stale.trucks[0]!.position).toMatchObject({ stale: true, updatedText: 'Last GPS position 08:20 (20 min ago)' });
    const behind = view(dayInput({ ...base, plans: onePlan(), now: at('08:40'), gps: gpsIn({ fixAt: at('08:39'), pos: fix, trailTo: at('08:00') }) }));
    expect(behind.deliveries[1]!.eta!.source).toBe('TRIP');
    const none = view(dayInput({ ...base, plans: onePlan(), now: at('08:40') }));
    expect(none.deliveries[1]!.eta!.source).toBe('TRIP');
    expect(none.trucks[0]!.position).toBeNull();
    expect(none.trucks[0]!.gpsText).toBeNull();
    const untracked = view(dayInput({ ...base, plans: onePlan(), now: at('08:40'), gps: gpsIn({ fixAt: at('08:39'), pos: fix, tracked: false }) }));
    expect(untracked.trucks[0]!.gpsText).toBe("No GPS on this truck - times from the driver's updates");
  });

  it('late or early against the printed window, not the planned minute (critique 5)', () => {
    // 30 min behind plan at stop 2 is still inside its window 08:45-09:45.
    const inside = view(dayInput({ ...base, plans: onePlan(), now: at('08:40'), visits: [delivered(1, '08:40', '08:55')], phoneSeen: new Map([['t5', at('08:55')]]) }));
    expect(inside.deliveries[1]!.eta).toMatchObject({ expected: '09:40', timing: 'ON_TIME', lateMin: null });
    // 75 min behind: 30 min after the window.
    const late = view(dayInput({ ...base, plans: onePlan(), now: at('09:40'), visits: [delivered(1, '09:15', '09:30')], phoneSeen: new Map([['t5', at('09:30')]]) }));
    expect(late.deliveries[1]!.eta).toMatchObject({ expected: '10:15', timing: 'LATE', lateMin: 30, text: 'Expected about 10:15 - about 30 min after the window 08:45-09:45' });
    expect(late.counts.delayed).toBe(2);
    expect(late.trucks[0]!.lateText).toBe('Running about 75 min behind plan');
    // GPS well before the window: "earlier than the window".
    expect(etaView({ expectedMin: hm(8, 20), source: 'GPS', dueNow: false, noLive: null, detail: null }, { from: hm(8, 45), to: hm(9, 45) }, hm(8))).toMatchObject({ timing: 'EARLY', earlyMin: 25 });
    // Never a time before now.
    expect(etaView({ expectedMin: hm(8, 2), source: 'GPS', dueNow: false, noLive: null, detail: null }, null, hm(8, 1))).toMatchObject({ expected: '08:05' });
  });

  it('the clock pushed the stop (the phone silent): due now, no minutes (critique 4)', () => {
    const v = view(dayInput({ ...base, plans: onePlan(), now: at('10:00') }));
    expect(v.deliveries[1]!.eta).toEqual({ expected: null, source: 'TRIP', timing: 'DUE_NOW', lateMin: null, earlyMin: null, text: 'Due now - no update from the truck yet (last update 08:25)' });
    expect(v.counts.delayed).toBe(1); // stop 3 only: it cannot be reached before 11:00, after its window
  });

  it('no live source at all (no phone, no GPS, nothing recorded): the window, no time (critique 4)', () => {
    const v = view(dayInput({ plans: onePlan(), now: at('08:00'), loadTimes: new Map([['L1', at('07:00')]]) }));
    expect(v.deliveries[0]).toMatchObject({ status: 'NEXT', eta: { timing: 'NO_UPDATES', expected: null, text: 'No live updates from this truck - window 07:45-08:45' } });
    expect(v.trucks[0]!.trip!.text).toBe('On the road (trip 1) since 07:00 - no live updates from this truck');
  });

  it('a trip that has not left: as planned before its departure, "should have left" 30 min after it (critique 14)', () => {
    const early = view(dayInput({ plans: onePlan([trip('LOCKED')]), now: at('06:00') }));
    expect(early.deliveries[0]!.eta).toMatchObject({ source: 'PLAN', expected: '08:00', text: 'Expected about 08:00 (as planned) - within 07:45-08:45' });
    expect(early.trucks[0]!.trip!.text).toBe('Trip 1 planned to leave 07:00');
    const late = view(dayInput({ plans: onePlan([trip('LOCKED')]), now: at('08:00') }));
    expect(late.deliveries[0]!.eta).toMatchObject({ timing: 'NO_UPDATES', expected: null, text: 'Trip should have left at 07:00 - not marked as left yet - window 07:45-08:45' });
    expect(late.trucks[0]!.trip!.text).toBe('Trip 1 should have left at 07:00 - not marked as left yet');
    const loading = view(dayInput({ plans: onePlan([trip('LOADING')]), now: at('06:30') }));
    expect(loading.trucks[0]!.trip!.text).toBe('Being loaded (trip 1), planned to leave 07:00');
  });

  it("a later trip leaves when the truck is back from the trip before (critique 6): its times move", () => {
    const l2 = load({ id: 'L2', loadNo: 2, status: 'LOCKED', departMin: hm(14), returnMin: hm(16), stops: [stop({ seq: 1, customerId: 'c4', code: 'TST0004', eta: hm(15), lines: [ln('o4', 'o4-l1', 'INV-4', 5, 'R1')] })] });
    const loads = [trip('DISPATCHED'), l2];
    const lines = loads.flatMap((l) => l.stops.flatMap((s) => s.orderLines.map((x) => ln(x.orderId, x.lineId, x.salesOrderNo, x.cases, 'R1'))));
    const v = view(
      dayInput({ plans: [{ detail: planDetail({ loads }), facts: factsOf(lines) }], now: at('09:40'), loadTimes: new Map([['L1', at('07:00')]]), visits: [delivered(1, '09:15', '09:30')], phoneSeen: new Map([['t5', at('09:30')]]) }),
    );
    const later = v.deliveries.find((d) => d.customerCode === 'TST0004')!;
    // Trip 1 is back 75 min late (14:15): trip 2 leaves 15:15 at the earliest, the stop is reached about 16:15.
    expect(later).toMatchObject({ status: 'PLANNED', eta: { source: 'TRIP', expected: '16:15', timing: 'LATE', lateMin: 30 } });
  });
});

// ---------------------------------------------------------------------------------------------
// Orders not on a truck, notes, depots
// ---------------------------------------------------------------------------------------------

describe('the orders of the route that are not on a truck', () => {
  const lines = {
    o1: ln('o1', 'o1-l1', 'INV-1', 10, 'R1'),
    o2: ln('o2', 'o2-l1', 'INV-2', 7, 'R1'),
    o3: ln('o3', 'o3-l1', 'INV-3', 9, 'R1'),
    o6a: ln('o6', 'o6-l1', 'INV-6', 10, 'R1'),
    o6b: ln('o6', 'o6-l2', 'INV-6', 5, 'R2X'),
    o11: ln('o11', 'o11-l1', 'INV-11', 4, null),
  } satisfies Record<string, Ln>;
  function input(now = at('05:00')) {
    const l = load({
      id: 'L1',
      status: 'PLANNED',
      stops: [
        stop({ seq: 1, customerId: 'c1', code: 'TST0001', eta: hm(8), lines: [lines.o1, lines.o11] }),
        stop({ seq: 2, customerId: 'c2', code: 'TST0002', eta: hm(9), lines: [lines.o2], cancelled: ['o2'] }),
        stop({ seq: 3, customerId: 'c3', code: 'TST0003', eta: hm(10), lines: [lines.o3] }),
        stop({ seq: 4, customerId: 'c6', code: 'TST0006', eta: hm(11), lines: [lines.o6a, lines.o6b] }),
      ],
    });
    const facts = factsOf([...Object.values(lines), ln('o4', 'o4-l1', 'INV-4', 3, 'R1'), ln('o5', 'o5-l1', 'INV-5', 2, 'R1'), ln('o7', 'o7-l1', 'INV-7', 6, 'R1')], {
      whole: { 'o6-l1': 25 },
      orders: [['o3', { cancelled: false, carriedTo: '2026-10-21' }]],
      pending: [{ orderId: 'o7', customerId: 'c7', customerCode: 'TST0007', branchCode: null, customerName: 'Example Mart TST0007' }],
    });
    const detail = planDetail({
      loads: [l],
      unserved: [unserved('o4', 'c4', 'TST0004', 3, { reasonCode: 'HARD_WINDOW_INFEASIBLE' }), unserved('o5', 'c5', 'TST0005', 2, { carriedTo: '2026-10-22' }), unserved('o6', 'c6', 'TST0006', 15, { partial: true })],
      pendingOrders: 1,
    });
    return dayInput({
      plans: [{ detail, facts }],
      now,
      extraOrders: [
        extraOrder({ id: 'o1', customerCode: 'TST0001', carriedFromDate: '2026-10-18', lines: [{ id: 'o1-l1', salesRoute: 'R1', salesOrderNo: 'INV-1', cases: 10 }] }),
        extraOrder({ id: 'o2', customerCode: 'TST0002', cancelled: true, cancelReason: 'CUSTOMER_CANCELLED', lines: [{ id: 'o2-l1', salesRoute: 'R1', salesOrderNo: 'INV-2', cases: 7 }] }),
        extraOrder({ id: 'o3', customerCode: 'TST0003', carriedTo: '2026-10-21', lines: [{ id: 'o3-l1', salesRoute: 'R1', salesOrderNo: 'INV-3', cases: 9 }] }),
        extraOrder({ id: 'o5', customerCode: 'TST0005', carriedTo: '2026-10-22', lines: [{ id: 'o5-l1', salesRoute: 'R1', salesOrderNo: 'INV-5', cases: 2 }] }),
        extraOrder({ id: 'o8', customerCode: 'TST0008', cancelled: true, cancelReason: 'WRONG_OR_DUPLICATE', lines: [{ id: 'o8-l1', salesRoute: 'R1', salesOrderNo: 'INV-8', cases: 1 }] }),
        extraOrder({ id: 'o9', customerCode: 'TST0009', carriedTo: '2026-10-23', lines: [{ id: 'o9-l1', salesRoute: 'R1', salesOrderNo: 'INV-9', cases: 3 }] }),
        extraOrder({ id: 'o10', customerCode: 'TST0010', depotId: 'D2', lines: [{ id: 'o10-l1', salesRoute: 'R1', salesOrderNo: 'INV-10', cases: 11 }] }),
      ],
    });
  }

  it('each kind in order, with a salesman\'s words; never the office\'s note or wording', () => {
    const v = view(input());
    expect(v.offTruck.map((o) => `${o.kind} ${o.customerCode} ${o.cases} ${o.why}`)).toEqual([
      'CANCELLED TST0002 7 Cancelled - Customer cancelled',
      'CANCELLED TST0008 1 Cancelled - Wrong or duplicate order',
      "NOT_PLANNED TST0004 3 The customer's receiving hours could not be met (the office will advise)",
      'PART_NOT_PLANNED TST0006 15 Rest of a split delivery - not on a truck today (the office will advise)',
      'ADDED_AFTER_PLAN TST0007 6 Received after planning - the next re-plan adds it',
      'NOT_PLANNED_YET TST0010 11 Not planned yet - the plan is made the evening before',
      'MOVED TST0003 9 Moved to Wed 21 Oct',
      'MOVED TST0005 2 Moved to Thu 22 Oct',
      'MOVED TST0009 3 Moved to Fri 23 Oct',
    ]);
    expect(v.counts).toMatchObject({ cancelled: 2, moved: 3, notPlanned: 4 });
    expect(JSON.stringify(v)).not.toContain('REASON-MESSAGE-SENTINEL');
  });

  it('only the deliveries really on the truck; the rest of a split order only under its own line\'s route; notes', () => {
    const day = buildSalesDay(input());
    const r1 = day.routes.get('R1')!;
    expect(r1.deliveries.map((d) => `${d.customerCode} ${d.cases}`)).toEqual(['TST0001 10', 'TST0006 10']);
    expect(r1.deliveries[0]!.notes).toEqual(['Not locked yet: times can change if the day is re-planned', 'Moved here from Sun 18 Oct']);
    expect(r1.deliveries[1]!.notes).toContain("More of this customer's cases are not on a truck on this day (the office will advise).");
    const r2x = day.routes.get('R2X')!;
    expect(r2x.deliveries.map((d) => `${d.customerCode} ${d.cases}`)).toEqual(['TST0006 5']);
    expect(r2x.offTruck).toEqual([]);
    expect(r2x.deliveries[0]!.notes).not.toContain("More of this customer's cases are not on a truck on this day (the office will advise).");
    // Lines without a route are on no page.
    expect([...day.routes.keys()]).toEqual(['R1', 'R2X']);
    expect(day.routes.has('R9')).toBe(false);
  });

  it('a route with only orders not on a truck (a depot not planned yet) is found', () => {
    const v = buildSalesDay(
      dayInput({ plans: [], now: at('05:00'), extraOrders: [extraOrder({ id: 'o20', customerCode: 'TST0020', depotId: 'D3', lines: [{ id: 'o20-l1', salesRoute: 'R10', salesOrderNo: 'INV-20', cases: 4 }] })] }),
    );
    expect(v.routes.get('R10')!.offTruck.map((o) => o.kind)).toEqual(['NOT_PLANNED_YET']);
    expect(v.routes.get('R10')!.summaryText).toBe('1 not on a truck');
  });

  it('a trip that left keeps its delivery when its order was moved since: "Rest moved to"', () => {
    const l = trip('DISPATCHED');
    const facts = factsOf(l.stops.flatMap((s) => s.orderLines.map((x) => ln(x.orderId, x.lineId, x.salesOrderNo, x.cases, 'R1'))), { orders: [['o1', { cancelled: false, carriedTo: '2026-10-20' }]] });
    const v = view(dayInput({ plans: [{ detail: planDetail({ loads: [l] }), facts }], now: at('07:30'), loadTimes: new Map([['L1', at('07:00')]]), extraOrders: [extraOrder({ id: 'o1', carriedTo: '2026-10-20', lines: [{ id: 'o1-l1', salesRoute: 'R1', salesOrderNo: 'INV-1', cases: 20 }] })] }));
    expect(v.deliveries[0]!.notes).toEqual(['Rest moved to Tue 20 Oct']);
    expect(v.offTruck).toEqual([]);
  });

  it("two depots' plans are merged into one route, each trip with its own depot's visits", () => {
    const a = load({ id: 'LA', status: 'DISPATCHED', stops: [stop({ seq: 1, customerId: 'c1', code: 'TST0001', eta: hm(8), lines: [ln('o1', 'o1-l1', 'INV-1', 5, 'R1')] })] });
    const b = load({ id: 'LB', truckId: 't6', truckCode: 'T06', status: 'DISPATCHED', stops: [stop({ seq: 1, customerId: 'c2', code: 'TST0002', eta: hm(9), lines: [ln('o2', 'o2-l1', 'INV-2', 6, 'R1')] })] });
    const v = view(
      dayInput({
        plans: [
          { detail: planDetail({ depotId: 'D1', loads: [a] }), facts: factsOf([ln('o1', 'o1-l1', 'INV-1', 5, 'R1')]) },
          { detail: planDetail({ depotId: 'D2', loads: [b] }), facts: factsOf([ln('o2', 'o2-l1', 'INV-2', 6, 'R1')]) },
        ],
        now: at('09:30'),
        loadTimes: new Map([['LA', at('07:00')], ['LB', at('07:00')]]),
        // The South depot's T06 load 1 stop 1 is delivered; the same key at the North depot is not T05's.
        visits: [delivered(1, '09:00', '09:10', { depotId: 'D2', truckId: 't6' })],
      }),
    );
    expect(statusOf(v)).toEqual(['TST0001 NEXT', 'TST0002 DELIVERED']);
    expect(v.trucks.map((t) => t.truckCode)).toEqual(['T05', 'T06']);
  });
});

// ---------------------------------------------------------------------------------------------
// The truck card and privacy
// ---------------------------------------------------------------------------------------------

describe('the truck card and what the answer never holds', () => {
  it('the position only while the trip on the road has this route\'s deliveries to make (critique 10)', () => {
    const l = load({
      id: 'L1',
      status: 'DISPATCHED',
      stops: [
        stop({ seq: 1, customerId: 'c1', code: 'TST0001', eta: hm(8), lines: [ln('o1', 'o1-l1', 'INV-1', 5, 'R10')] }),
        stop({ seq: 2, customerId: 'c2', code: 'TST0002', eta: hm(9), lines: [ln('o2', 'o2-l1', 'INV-2', 6, 'R1')] }),
      ],
    });
    const input = dayInput({
      plans: [{ detail: planDetail({ loads: [l] }), facts: factsOf([ln('o1', 'o1-l1', 'INV-1', 5, 'R10'), ln('o2', 'o2-l1', 'INV-2', 6, 'R1')]) }],
      now: at('08:40'),
      loadTimes: new Map([['L1', at('07:00')]]),
      visits: [delivered(1, '08:10', '08:25')],
      phoneSeen: new Map([['t5', at('08:25')]]),
      gps: gpsIn({ fixAt: at('08:39'), pos: east(1500), trailTo: at('08:35') }),
    });
    const day = buildSalesDay(input);
    expect(day.routes.get('R1')!.trucks[0]!.position).not.toBeNull();
    // R10's only delivery is done: no position, but the card still says where the trip is.
    expect(day.routes.get('R10')!.trucks[0]).toMatchObject({ position: null, gpsText: 'GPS: updated 08:39', trip: { text: 'On the road (trip 1) since 07:00' } });
    expect(day.routes.get('R1')!.trucks[0]!.nextYours).toBe('Example Mart TST0002 · about 09:00');
  });

  it('pins at 4 decimals; no driver, helper, phone, address, note, money, priority or internal id anywhere', () => {
    const l = load({
      id: 'LOAD-ID-SENTINEL',
      truckId: 'TRUCK-ID-SENTINEL',
      status: 'DISPATCHED',
      stops: [stop({ seq: 1, customerId: 'CUST-ID-SENTINEL', code: 'TST0001', eta: hm(8), pin: { lat: 20.123456, lng: 55.987654 }, lines: [ln('ORDER-ID-SENTINEL', 'LINE-ID-SENTINEL', 'INV-1', 5, 'R1')] })],
    });
    const detail = planDetail({ depotId: 'DEPOT-ID-SENTINEL', runId: 'RUN-ID-SENTINEL', loads: [l] });
    const v = view(
      dayInput({
        plans: [{ detail, facts: factsOf([ln('ORDER-ID-SENTINEL', 'LINE-ID-SENTINEL', 'INV-1', 5, 'R1')]) }],
        now: at('07:30'),
        loadTimes: new Map([['LOAD-ID-SENTINEL', at('07:00')]]),
        gps: gpsIn({ truckId: 'TRUCK-ID-SENTINEL', fixAt: at('07:29'), pos: east(500), depotId: 'DEPOT-ID-SENTINEL' }),
      }),
    );
    expect(v.deliveries[0]!.pin).toEqual({ lat: 20.1235, lng: 55.9877 });
    const text = JSON.stringify(v);
    for (const s of ['SENTINEL', 'DRIVER', 'HELPER', 'PHONE', 'ADDRESS', 'ACCESS', '123.45']) expect(text).not.toContain(s);
    const keys: string[] = [];
    const walk = (x: unknown) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object')
        for (const [k, val] of Object.entries(x)) {
          keys.push(k);
          walk(val);
        }
    };
    walk(v);
    expect(keys.filter((k) => /^(id|.*Id|driver.*|.*[pP]hone.*|imei|priority|salesValue|margin.*|payment.*|address|accessNotes|reasonNote|cancelNote)$/.test(k))).toEqual([]);
    // The customer's WhatsApp text carries no link.
    expect(v.deliveries[0]!.shareText).not.toMatch(/https?:|wa\.me|\/s\//);
    expect(v.deliveries[0]!.shareText).toContain('Example Mart TST0001: your delivery (invoice INV-1)');
  });
});

// ---------------------------------------------------------------------------------------------
// Parity with the printed Salesman ETA
// ---------------------------------------------------------------------------------------------

describe('parity with the printed Salesman ETA (salesmanEtaModel) on the same plan', () => {
  it("per route: the same customers, cases and windows, and the same orders not on a truck (but the cancelled ones it leaves out)", () => {
    const L = {
      a: ln('o1', 'o1-l1', 'INV-1', 20, 'R1'),
      b: ln('o1', 'o1-l2', 'INV-1', 10, 'R2X'),
      c: ln('o2', 'o2-l1', 'INV-2', 15, 'R10'),
      d: ln('o3', 'o3-l1', 'INV-3', 18, 'R1'),
      e: ln('o3', 'o3-l1', 'INV-3', 12, 'R1'),
      f: ln('o4', 'o4-l1', 'INV-4', 5, 'R1'),
      g: ln('o10', 'o10-l1', 'INV-10', 3, 'R1'),
    } satisfies Record<string, Ln>;
    const loads = [
      load({
        id: 'L1',
        status: 'LOCKED',
        stops: [
          stop({ seq: 1, customerId: 'c1', code: 'TST0001', eta: hm(8, 5), lines: [L.a, L.b] }),
          stop({ seq: 2, customerId: 'c2', code: 'TST0002', eta: hm(10), lines: [L.c], hours: [hm(10), hm(10, 30)], promised: [hm(10), hm(10, 30)] }),
        ],
      }),
      load({
        id: 'L2',
        loadNo: 2,
        status: 'PLANNED',
        departMin: hm(14),
        returnMin: hm(17),
        stops: [
          stop({ seq: 1, customerId: 'c3', code: 'TST0003', eta: hm(15), lines: [L.e] }),
          stop({ seq: 2, customerId: 'c4', code: 'TST0004', eta: hm(15, 30), lines: [L.f], cancelled: ['o4'] }),
          stop({ seq: 3, customerId: 'c10', code: 'TST0010', eta: hm(16), lines: [L.g] }),
        ],
      }),
      load({ id: 'L3', truckId: 't6', truckCode: 'T06', status: 'DISPATCHED', stops: [stop({ seq: 1, customerId: 'c3', code: 'TST0003', eta: hm(7), lines: [L.d] })] }),
    ];
    const facts = factsOf([L.a, L.b, L.c, L.d, L.e, L.f, L.g, ln('o6', 'o6-l1', 'INV-6', 9, 'R1'), ln('o8', 'o8-l1', 'INV-8', 4, 'R1'), ln('o9', 'o9-l1', 'INV-9', 6, 'R10')], {
      orders: [
        ['o8', { cancelled: false, carriedTo: '2026-10-21' }],
        ['o10', { cancelled: false, carriedTo: '2026-10-22' }],
      ],
      pending: [{ orderId: 'o9', customerId: 'c9', customerCode: 'TST0009', branchCode: null, customerName: 'Example Mart TST0009' }],
    });
    const detail = planDetail({ loads, unserved: [unserved('o6', 'c6', 'TST0006', 9), unserved('o8', 'c8', 'TST0008', 4, { carriedTo: '2026-10-21' })], pendingOrders: 1 });
    const model = salesmanEtaModel(detail, facts, { tenantName: 'Example Water Co', now: at('21:00', '2026-10-18') });
    const day = buildSalesDay(dayInput({ plans: [{ detail, facts }], now: at('21:00', '2026-10-18') }));
    for (const section of model.sections.filter((s) => s.route !== null)) {
      const route = section.route!;
      const v = day.routes.get(route)!;
      const printed = section.rows.flatMap((r) => r.parts.map((p) => `${r.customerCode} ${p.cases} ${p.window}`)).sort();
      const live = v.deliveries.map((d) => `${d.customerCode} ${d.cases} ${d.window}`).sort();
      expect([route, live]).toEqual([route, printed]);
      const offPrinted = section.notPlanned.map((n) => `${n.customerCode} ${n.cases}`).sort();
      const offLive = v.offTruck.filter((o) => o.kind !== 'CANCELLED').map((o) => `${o.customerCode} ${o.cases}`).sort();
      expect([route, offLive]).toEqual([route, offPrinted]);
    }
    expect([...day.routes.keys()]).toEqual(model.sections.filter((s) => s.route !== null).map((s) => s.route));
  });
});

describe('times past midnight and the minutes helper', () => {
  it('an expected time after midnight says +1', () => {
    expect(etaView({ expectedMin: 1450, source: 'TRIP', dueNow: false, noLive: null, detail: null }, null, 1400)).toMatchObject({ expected: '00:10 +1' });
    expect(atMin(1450).toISOString()).toBe(at('00:10', '2026-10-20').toISOString());
  });
});
