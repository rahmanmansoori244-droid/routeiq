/**
 * Data collection rules (owner decisions of 1 Oct 2026), the pure rules and the planner (routes in
 * data-collection-routes.spec.ts):
 *
 *  - item 1, a delivery time for one order (urgent / promised): checked and read one way
 *    (lib/dispatch/order-window.ts); a customer's visit is planned within it (it replaces the
 *    customer's hours for that visit, the customer master unchanged); conflicting times are planned
 *    with the one that ends first and warned; the plan keeps it with the stop (StopFacts.promised) so
 *    the plan screen, Excel, the driver PDF and WhatsApp say "Promised 10:00–11:00"; a change after
 *    planning is reported as such;
 *  - item 2, own confirmed window: confirmed hours (or "open all day") are the customer's own and
 *    win over the customer-type default; everything else is "(default - not confirmed)";
 *  - item 5, the location admin-lock rule (savedLocationLocked);
 *  - the Details dialog sends "open all day" and "confirmed with the customer".
 */
import { describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ prisma: {} as Record<string, any>, tdb: {} as Record<string, any> }));
vi.mock('@/lib/db', () => ({ prisma: new Proxy({}, { get: (_t, k: string) => (k === 'then' ? undefined : fake.prisma[k]) }) }));
vi.mock('@/lib/tenant', () => ({ tenantDb: () => fake.tdb }));

import {
  checkOrderTime,
  leftOutWhole,
  orderTimeFromForm,
  orderTimeOf,
  plannedVisitOrders,
  promisedText,
  readPromised,
  stopWindowFor,
} from '@/lib/dispatch/order-window';
import {
  customerIssues,
  effectiveAttrs,
  locationButtonText,
  savedLocationLocked,
  windowLabel,
  type CustomerForPlanning,
  type TypeProfileLike,
} from '@/lib/dispatch/customer-attrs';
import { stopMasterChanges, type StopSnapshot } from '@/lib/dispatch/snapshots';
import { buildDispatchRequest, planInputsOf } from '@/lib/dispatch/plan-service';
import { whatsappText } from '@/lib/dispatch/driver-links';
import { detailsFormOf, detailsPatch, type DetailsCustomer } from '@/app/t/[slug]/dispatch/customer-details';
import { orderTimeFormOf, orderTimeHint } from '@/app/t/[slug]/dispatch/delivery-times';

const times = (start: number | null, end: number | null, reason = 'URGENT', note: string | null = null) => ({
  deliveryStartMin: start,
  deliveryEndMin: end,
  deliveryTimeReason: reason,
  deliveryTimeNote: note,
});
const NONE = times(null, null, null as unknown as string);
const EFF = { hardStart: 360, hardEnd: 840, prefStart: 420, prefEnd: 600 };

describe('item 1: a delivery time for one order', () => {
  it('is checked one way: a start or an end, the end after the start, 00:00-24:00, a known reason, a note for "Other"', () => {
    expect(checkOrderTime({ startMin: 600, endMin: 660, reason: 'PROMISED' })).toEqual({ ok: true, time: { startMin: 600, endMin: 660, reason: 'PROMISED', note: null } });
    expect(checkOrderTime({ endMin: 600, reason: 'URGENT', note: '  ' })).toEqual({ ok: true, time: { startMin: null, endMin: 600, reason: 'URGENT', note: null } });
    expect(checkOrderTime({ startMin: 600, endMin: 600, reason: 'URGENT' })).toMatchObject({ ok: false, error: 'The end must be after the start.' });
    expect(checkOrderTime({ reason: 'URGENT' })).toMatchObject({ ok: false, error: 'Give a start or an end time (or both).' });
    expect(checkOrderTime({ startMin: -1, reason: 'URGENT' })).toMatchObject({ ok: false });
    expect(checkOrderTime({ startMin: 600, reason: 'LATER' })).toMatchObject({ ok: false, error: expect.stringMatching(/Choose a reason/) });
    expect(checkOrderTime({ startMin: 600, reason: 'OTHER' })).toMatchObject({ ok: false, error: expect.stringMatching(/write a short note/) });
    expect(checkOrderTime({ startMin: 600, reason: 'OTHER', note: 'x'.repeat(201) })).toMatchObject({ ok: false });
  });

  it('the dialog reads HH:MM strictly (24:00 is the end of the day)', () => {
    expect(orderTimeFromForm({ start: '10:00', end: '24:00', reason: 'URGENT', note: '' })).toMatchObject({ ok: true, time: { startMin: 600, endMin: 1440 } });
    expect(orderTimeFromForm({ start: '10:70', end: '', reason: 'URGENT', note: '' })).toMatchObject({ ok: false, error: expect.stringMatching(/^Start "10:70" is not a time/) });
  });

  it('reads as "Promised 10:00–11:00", "Promised by 10:00" or "Promised from 14:00"', () => {
    expect(promisedText({ startMin: 600, endMin: 660 })).toBe('Promised 10:00–11:00');
    expect(promisedText({ startMin: null, endMin: 600 })).toBe('Promised by 10:00');
    expect(promisedText({ startMin: 840, endMin: null })).toBe('Promised from 14:00');
    expect(promisedText({ startMin: 1200, endMin: 1440 })).toBe('Promised 20:00–24:00');
    expect(orderTimeOf(NONE)).toBeNull();
    expect(orderTimeOf(times(600, 660, 'nonsense'))).toMatchObject({ reason: 'OTHER' });
  });

  it("a visit with no timed order is planned with the customer's hours", () => {
    expect(stopWindowFor(EFF, [NONE, NONE])).toEqual({ ...EFF, promised: null, conflict: false, outsideHours: false });
  });

  it("a timed order replaces the customer's hours (hard and preferred) for the whole visit; several overlap: within all", () => {
    expect(stopWindowFor(EFF, [NONE, times(300, 420, 'URGENT', 'shop opens early')])).toEqual({
      hardStart: 300, hardEnd: 420, prefStart: null, prefEnd: null, conflict: false, outsideHours: false,
      promised: { startMin: 300, endMin: 420, reason: 'URGENT', note: 'shop opens early' },
    });
    const both = stopWindowFor(EFF, [times(600, 720, 'PROMISED'), times(null, 660, 'URGENT')]);
    expect(both).toMatchObject({ hardStart: 600, hardEnd: 660, conflict: false, promised: { startMin: 600, endMin: 660, reason: 'URGENT' } });
  });

  it("a time with one end only keeps the customer's opening or closing time on the other side (and its preferred hours inside)", () => {
    // Customer 06:00-14:00 (preferred 07:00-10:00). "Promised from 09:00": 09:00-14:00, never after closing.
    expect(stopWindowFor(EFF, [times(540, null, 'PROMISED')])).toMatchObject({
      hardStart: 540, hardEnd: 840, prefStart: 540, prefEnd: 600, outsideHours: false, promised: { startMin: 540, endMin: null },
    });
    // "Promised by 10:00": 06:00-10:00, never before opening.
    expect(stopWindowFor(EFF, [times(null, 600, 'URGENT')])).toMatchObject({ hardStart: 360, hardEnd: 600, prefStart: 420, prefEnd: 600, outsideHours: false });
    // The promised end itself is the dispatcher's (agreed with the customer): "from 05:00" at a shop opening at 06:00.
    expect(stopWindowFor(EFF, [times(300, null, 'URGENT')])).toMatchObject({ hardStart: 300, hardEnd: 840, prefStart: 420, prefEnd: 600, outsideHours: false });
    // Preferred hours outside what is left are dropped.
    expect(stopWindowFor(EFF, [times(660, null, 'PROMISED')])).toMatchObject({ hardStart: 660, hardEnd: 840, prefStart: null, prefEnd: null });
    // "Promised from 15:00" after a 14:00 closing: planned with the promised time, and flagged.
    expect(stopWindowFor(EFF, [times(900, null, 'PROMISED')])).toMatchObject({ hardStart: 900, hardEnd: null, prefStart: null, prefEnd: null, outsideHours: true });
    expect(stopWindowFor({ hardStart: 480, hardEnd: null, prefStart: null, prefEnd: null }, [times(null, 420, 'URGENT')])).toMatchObject({ hardStart: null, hardEnd: 420, outsideHours: true });
  });

  it('times that do not overlap: planned with the one that ends first, and flagged', () => {
    const w = stopWindowFor(EFF, [times(840, 900, 'PROMISED', 'afternoon'), times(480, 540, 'URGENT', 'morning')]);
    expect(w).toMatchObject({ hardStart: 480, hardEnd: 540, conflict: true, promised: { startMin: 480, endMin: 540, reason: 'URGENT', note: 'morning' } });
  });

  it('reads back what the plan kept (StopFacts.promised); anything else is none', () => {
    expect(readPromised({ startMin: 600, endMin: 660, reason: 'PROMISED', note: 'x' })).toEqual({ startMin: 600, endMin: 660, reason: 'PROMISED', note: 'x' });
    expect(readPromised({ startMin: null, endMin: null, reason: 'URGENT' })).toBeNull();
    expect(readPromised('Promised')).toBeNull();
  });

  it('a change after planning reads "Delivery time changed after planning" (not "Receiving hours")', () => {
    const snap = {
      v: 1, customerId: 'c1', code: 'C1', branchCode: null, name: 'C1', customerType: null, lat: 23.6, lng: 58.4, address: null, accessNotes: null,
      hardStartMin: 360, hardEndMin: 840, prefStartMin: null, prefEndMin: null, serviceMin: 10, priority: 3, source: 'PLAN', capturedAt: '2026-10-01T10:00:00Z',
    } as StopSnapshot;
    const live = { name: 'C1', address: null, lat: 23.6, lng: 58.4, hardStartMin: 360, hardEndMin: 840, prefStartMin: null, prefEndMin: null };
    expect(stopMasterChanges(snap, live)).toEqual([]);
    expect(stopMasterChanges(snap, { ...live, hardStartMin: 600, hardEndMin: 660, promised: { startMin: 600, endMin: 660, reason: 'URGENT', note: null } })).toEqual([
      { kind: 'HOURS', text: 'Delivery time changed after planning: now Promised 10:00–11:00 (planned with 06:00–14:00)' },
    ]);
    const promisedSnap = { ...snap, hardStartMin: 600, hardEndMin: 660, promised: { startMin: 600, endMin: 660, reason: 'URGENT', note: null } };
    expect(stopMasterChanges(promisedSnap, { ...live, hardStartMin: 600, hardEndMin: 660, promised: promisedSnap.promised })).toEqual([]);
    expect(stopMasterChanges(promisedSnap, live)[0]!.text).toBe('Delivery time changed after planning: now receives 06:00–14:00 (planned with Promised 10:00–11:00)');
    // The same hours as a promised time (prefilled from the customer's hours, "Promised to customer"):
    // the hours do not move, but the stop was not planned with a promised time, so the plan is out of
    // date - as LOCK says (RE-PLAN first). Another reason or note only is no change.
    expect(stopMasterChanges(snap, { ...live, promised: { startMin: 360, endMin: 840, reason: 'PROMISED', note: null } })).toEqual([
      { kind: 'HOURS', text: 'Delivery time changed after planning: now Promised 06:00–14:00 (planned with 06:00–14:00)' },
    ]);
    const sameHoursSnap = { ...snap, promised: { startMin: 360, endMin: 840, reason: 'PROMISED', note: null } };
    expect(stopMasterChanges(sameHoursSnap, live)).toEqual([{ kind: 'HOURS', text: 'Delivery time changed after planning: now receives 06:00–14:00 (planned with Promised 06:00–14:00)' }]);
    expect(stopMasterChanges(sameHoursSnap, { ...live, promised: { startMin: 360, endMin: 840, reason: 'URGENT', note: 'call first' } })).toEqual([]);
  });

  it("a stop is judged with all of its customer's orders of the day (one visit), except those on a load locked before its plan was made", () => {
    const o = (id: string) => ({ id, lines: [{ id: `${id}-l1`, cases: 10 }] });
    const orders = [o('A'), o('B'), o('C'), o('D')];
    const at = '2026-10-01T10:00:00.000Z';
    const placements = [
      { orderId: 'A', frozen: true, lines: null, capturedAt: at }, // locked after this plan was made: counts
      { orderId: 'B', frozen: false, lines: [{ lineId: 'B-l1', cases: 10 }], capturedAt: at }, // the other part of a split customer
      { orderId: 'C', frozen: true, lines: null, capturedAt: '2026-10-01T06:00:00.000Z' }, // locked in an earlier plan
      // D: left unserved (no placement): counts
    ];
    expect(plannedVisitOrders(orders, placements, at).map((x) => x.id)).toEqual(['A', 'B', 'D']);
    // Not known when the stop was planned: as a re-plan now (frozen orders left out).
    expect(plannedVisitOrders(orders, placements, null).map((x) => x.id)).toEqual(['B', 'D']);
    // A split portion on a frozen load: its open rest was planned with the others.
    expect(plannedVisitOrders(orders, [{ orderId: 'C', frozen: true, lines: [{ lineId: 'C-l1', cases: 4 }], capturedAt: '2026-10-01T06:00:00.000Z' }], at).map((x) => x.id)).toEqual(['A', 'B', 'C', 'D']);
  });

  // Third review: a split customer stores every order of every part as a portion, so "whole" was never
  // true there. An order whose cases are all on a load locked before the stop was planned is not in that
  // plan (buildDispatchRequest leaves it out): the stop never carried its time, and no RE-PLAN changes that.
  it('a split customer: an order with every case on a load locked before the stop was planned is left out; one with cases still open counts', () => {
    const orders = [
      { id: 'O1', lines: [{ id: 'l1', cases: 10 }, { id: 'l2', cases: 5 }] },
      { id: 'O2', lines: [{ id: 'l3', cases: 20 }] },
    ];
    const at = '2026-10-01T10:00:00.000Z';
    const earlier = '2026-10-01T06:00:00.000Z';
    const part2 = { orderId: 'O2', frozen: false, lines: [{ lineId: 'l3', cases: 20 }], capturedAt: at };
    // Part 1 (locked in an earlier plan) holds all of O1: the re-plan did not see it.
    const part1 = { orderId: 'O1', frozen: true, lines: [{ lineId: 'l1', cases: 10 }, { lineId: 'l2', cases: 5 }], capturedAt: earlier };
    expect(plannedVisitOrders(orders, [part1, part2], at).map((x) => x.id)).toEqual(['O2']);
    // Spread over two locked loads: the same.
    const twoLoads = [
      { orderId: 'O1', frozen: true, lines: [{ lineId: 'l1', cases: 6 }], capturedAt: earlier },
      { orderId: 'O1', frozen: true, lines: [{ lineId: 'l1', cases: 4 }, { lineId: 'l2', cases: 5 }], capturedAt: earlier },
      part2,
    ];
    expect(plannedVisitOrders(orders, twoLoads, at).map((x) => x.id)).toEqual(['O2']);
    // A case of O1 still open (planned again with the others): O1 counts.
    expect(plannedVisitOrders(orders, [{ ...part1, lines: [{ lineId: 'l1', cases: 10 }, { lineId: 'l2', cases: 4 }] }, part2], at).map((x) => x.id)).toEqual(['O1', 'O2']);
    // Part 1 locked after this plan was made (the same optimization planned both parts): O1 counts.
    expect(plannedVisitOrders(orders, [{ ...part1, capturedAt: at }, part2], at).map((x) => x.id)).toEqual(['O1', 'O2']);
    // Part 1 still PLANNED: counts.
    expect(plannedVisitOrders(orders, [{ ...part1, frozen: false }, part2], at).map((x) => x.id)).toEqual(['O1', 'O2']);
  });

  it('an order the plan left out whole as heavier than any truck is not in the visit (as the planner leaves it out); a part of an order left out is', () => {
    const orders = [{ id: 'O1', lines: [{ id: 'l1', cases: 10 }] }, { id: 'O2', lines: [{ id: 'l2', cases: 10 }] }];
    const unserved = [
      { orderId: 'O1', reasonCode: 'EXCEEDS_ANY_TRUCK_CAPACITY', portionLinesJson: null },
      { orderId: 'O2', reasonCode: 'EXCEEDS_ANY_TRUCK_CAPACITY', portionLinesJson: [{ lineId: 'l2', cases: 4 }] },
      { orderId: 'O2', reasonCode: 'NO_AVAILABLE_TRUCK', portionLinesJson: null },
    ];
    expect([...leftOutWhole(unserved)]).toEqual(['O1']);
    expect(plannedVisitOrders(orders, [], '2026-10-01T10:00:00.000Z', leftOutWhole(unserved)).map((x) => x.id)).toEqual(['O2']);
  });

  it('the WhatsApp message marks the stop "Promised ..."', () => {
    const load = {
      truckCode: 'T1', loadNo: 1, departMin: 360, returnMin: 600, cases: 10,
      stops: [{ sequence: 1, etaMin: 610, customerName: 'Shop', customerCode: 'C1', branchCode: null, cases: 10, lat: 23.6, lng: 58.4, split: null, promised: 'Promised 10:00–11:00' }],
    };
    expect(whatsappText({ runDate: '2026-10-02', version: 1, depot: { lat: 23.5, lng: 58.3 } }, load, 1)).toContain('1. 10:10 Shop (C1) · 10 cs · *Promised 10:00–11:00*');
  });
});

describe('item 1: the planner plans the visit with the order time, and keeps it with the stop', () => {
  const cfg = {
    avgSpeedKmh: 40, distanceProvider: 'HAVERSINE', distanceMultiplier: 1.3, driverShiftMaxMinutes: 660, shiftStartMin: 360, reloadMinutes: 30,
    loadingMinPerCase: 0.04, serviceMinPerCase: 0.05, maxTripsPerTruck: 3, splitDeliveries: true, defaultServiceTimeMin: 10, timezone: 'Asia/Muscat',
    planningCutoffMin: 1080, fuelPricePerLitre: 0.26, driverCostPerHour: 2.5, overtimeAfterMin: 540, overtimeCostPerHour: 4, prefWindowPenaltyPerMin: 0.05,
    roadTimeFactor: 1.25, osrmUrl: null, priorityWeightsJson: null, orderColumnMapJson: null, dateOrder: 'DMY', serviceAreaJson: null,
  };
  const cust = (id: string, over: Record<string, unknown> = {}) => ({
    id, code: id, branchCode: null, name: id, lat: 23.5859, lng: 58.4059, priority: 3, priorityConfirmed: true, avgServiceTimeMin: 10, serviceTimeConfirmed: true,
    customerType: 'GROCERY', hardWindowStartMin: 360, hardWindowEndMin: 840, prefWindowStartMin: 420, prefWindowEndMin: 600, locationVerified: true,
    createdFromUpload: false, geocodeConfidence: 'HIGH', active: true, windowConfirmedAt: new Date(), ...over,
  });
  const order = (id: string, c: ReturnType<typeof cust>, t = NONE) => ({
    id, customerId: c.id, customer: c, totalCases: 10, totalWeightKg: 100, priority: 3, priorityFromFile: false, isLate: false, salesValue: null, marginValue: null,
    status: 'NEW', ...t,
    lines: [{ id: `${id}-l1`, cases: 10, weightKg: 100, weightFromMaster: false, salesValue: null, marginValue: null, product: { code: 'P', name: 'P', weightPerCaseKg: 10, active: true } }],
  });
  function wire(orders: unknown[]) {
    fake.tdb.runPlan = { findUniqueOrThrow: async () => ({ id: 'R1', depotId: 'D1', runDate: new Date('2026-10-02T00:00:00Z'), parentRunId: null, reason: 'INITIAL', depot: { id: 'D1', lat: 23.58, lng: 58.38, openMin: null, closeMin: null } }) };
    fake.tdb.tenantConfig = { findUniqueOrThrow: async () => ({ ...cfg }) };
    fake.tdb.customerTypeProfile = { findMany: async () => [] };
    fake.tdb.planLoad = { findMany: async () => [] };
    fake.tdb.truck = { findMany: async () => [{ id: 'T1', code: 'T1', capacityCases: 1000, capacityWeightKg: 10000, fixedCostPerDay: 20, tripCost: 0, costPerKm: 0.15, kmPerLitre: null, availableFromMin: null, availableToMin: null, maxTripsPerDay: null }] };
    fake.prisma.tenant = { findUniqueOrThrow: async () => ({ country: 'Oman' }) };
    fake.prisma.depot = { count: async () => 1 };
    fake.prisma.order = { findMany: async () => orders };
    fake.prisma.routeAssignment = { findMany: async () => [] };
    // No other depot has a plan this day (buildDispatchRequest reads them: cross-depot.ts).
    fake.prisma.runPlan = { findMany: async () => [] };
  }

  it("an urgent order: its customer's visit goes within the order's time; the others keep their hours; the plan inputs keep it", async () => {
    const a = cust('A');
    const b = cust('B', { lat: 23.6, lng: 58.42 });
    wire([order('O1', a), order('O2', a, times(300, 420, 'URGENT')), order('O3', b)]);
    const built = await buildDispatchRequest('TEN', 'R1', ['MIN_TRUCKS'] as never, { now: new Date('2026-10-01T10:00:00Z') });
    const stop = (id: string) => built.request.stops.find((s) => s.customer_id === id)!;
    expect(stop('A')).toMatchObject({ hard_start_min: 300, hard_end_min: 420, pref_start_min: null, pref_end_min: null });
    expect(stop('A').order_ids.sort()).toEqual(['O1', 'O2']);
    expect(stop('B')).toMatchObject({ hard_start_min: 360, hard_end_min: 840, pref_start_min: 420, pref_end_min: 600 });
    expect(built.promised).toEqual({ A: { startMin: 300, endMin: 420, reason: 'URGENT', note: null } });
    const inputs = planInputsOf(built, 'J1', new Date('2026-10-01T10:00:00Z'))!;
    expect(inputs.stops.A).toMatchObject({ hardStartMin: 300, hardEndMin: 420, promised: { startMin: 300, endMin: 420, reason: 'URGENT' } });
    expect(inputs.stops.B!.promised).toBeUndefined();
  });

  // Third review: the screens and LOCK judge a planned stop by plannedVisitOrders; it must leave out
  // exactly what the planner left out, or a RE-PLAN that builds the same stop never clears "changed".
  it('a split customer with part 1 locked before a re-plan: the new stop is planned without the locked order, and judged so', async () => {
    const a = cust('A');
    const o1 = order('O1', a, times(600, 660, 'PROMISED'));
    const o2 = order('O2', a);
    const frozenPart = (cases: number) => ({
      planLoad: {
        findMany: async () => [
          { id: 'L1', truckId: 'T1', loadNo: 1, status: 'LOCKED', departMin: 360, returnMin: 480, cases, breakJson: null, assignments: [{ orderId: 'O1', portionLinesJson: [{ lineId: 'O1-l1', cases }] }] },
        ],
      },
    });
    const earlier = '2026-10-01T06:00:00.000Z';
    // All of O1 (promised 10:00-11:00) is on the locked part: the re-plan plans O2 alone, with the customer's hours.
    wire([o1, o2]);
    Object.assign(fake.tdb, frozenPart(10));
    const built = await buildDispatchRequest('TEN', 'R1', ['MIN_TRUCKS'] as never, { now: new Date('2026-10-01T10:00:00Z') });
    expect(built.request.stops.find((s) => s.customer_id === 'A')!.order_ids).toEqual(['O2']);
    expect(built.promised?.A).toBeUndefined();
    // The new stop was planned when the re-plan read the orders (its capturedAt).
    const at = built.builtAt ?? null;
    const placements = (lockedCases: number) => [
      { orderId: 'O1', frozen: true, lines: [{ lineId: 'O1-l1', cases: lockedCases }], capturedAt: earlier },
      { orderId: 'O2', frozen: false, lines: [{ lineId: 'O2-l1', cases: 10 }], capturedAt: at },
    ];
    expect(stopWindowFor(EFF, plannedVisitOrders([o1, o2], placements(10), at)).promised).toBeNull();
    // Only 4 cases of O1 locked: its open rest goes with O2 and the visit is planned with O1's time; judged so.
    wire([o1, o2]);
    Object.assign(fake.tdb, frozenPart(4));
    const rest = await buildDispatchRequest('TEN', 'R1', ['MIN_TRUCKS'] as never, { now: new Date('2026-10-01T10:00:00Z') });
    expect(rest.promised?.A).toMatchObject({ startMin: 600, endMin: 660 });
    expect(stopWindowFor(EFF, plannedVisitOrders([o1, o2], placements(4), rest.builtAt ?? null)).promised).toMatchObject({ startMin: 600, endMin: 660 });
  });

  it('an order of the customer heavier than any truck is left out of the visit by the planner, and judged so', async () => {
    const a = cust('A');
    const heavy = { ...order('O3', a, times(480, 540, 'URGENT')), totalWeightKg: 200_000 };
    heavy.lines = [{ ...heavy.lines[0]!, weightKg: 200_000, product: { code: 'BRICK', name: 'Brick', weightPerCaseKg: 20_000, active: true } }];
    const o2 = order('O2', a);
    wire([heavy, o2]);
    const built = await buildDispatchRequest('TEN', 'R1', ['MIN_TRUCKS'] as never, { now: new Date('2026-10-01T10:00:00Z') });
    expect(built.preDrops).toMatchObject([{ orderId: 'O3', reasonCode: 'EXCEEDS_ANY_TRUCK_CAPACITY', portion: undefined }]);
    expect(built.promised?.A).toBeUndefined();
    const left = leftOutWhole(built.preDrops.map((d) => ({ orderId: d.orderId, reasonCode: d.reasonCode, portionLinesJson: d.portion?.lines ?? null })));
    expect(stopWindowFor(EFF, plannedVisitOrders([heavy, o2], [{ orderId: 'O2', frozen: false, lines: null, capturedAt: built.builtAt ?? null }], built.builtAt ?? null, left)).promised).toBeNull();
  });

  it('the plan keeps when the orders were read, not when the optimization was saved: a time set while it ran is after the plan (LOCK refuses it)', async () => {
    const a = cust('A');
    wire([order('O1', a)]);
    const built = await buildDispatchRequest('TEN', 'R1', ['MIN_TRUCKS'] as never, { now: new Date('2026-10-01T10:00:00Z') });
    expect(built.builtAt).toBe('2026-10-01T10:00:00.000Z');
    // A THOROUGH search saves its plan 15 minutes later: the inputs still say 10:00.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T10:15:00Z'));
    try {
      expect(planInputsOf(built, 'J1')!.capturedAt).toBe('2026-10-01T10:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('two orders of one customer with times that do not overlap: the earliest is used, and the plan warns', async () => {
    const a = cust('A');
    wire([order('O1', a, times(840, 900, 'PROMISED', 'afternoon')), order('O2', a, times(480, 540))]);
    const built = await buildDispatchRequest('TEN', 'R1', ['MIN_TRUCKS'] as never, { now: new Date('2026-10-01T10:00:00Z') });
    expect(built.request.stops[0]).toMatchObject({ hard_start_min: 480, hard_end_min: 540 });
    expect(built.warnings.join(' ')).toMatch(/Orders of one customer have delivery times that do not overlap: A\. .*planned within the time that ends first/);
  });

  it("a time with one end only: the visit keeps the customer's closing time; a time outside the customer's hours is planned as promised, and the plan warns", async () => {
    const a = cust('A');
    const b = cust('B', { lat: 23.6, lng: 58.42 });
    wire([order('O1', a, times(600, null, 'PROMISED')), order('O2', b, times(900, null, 'PROMISED'))]);
    const built = await buildDispatchRequest('TEN', 'R1', ['MIN_TRUCKS'] as never, { now: new Date('2026-10-01T10:00:00Z') });
    const stop = (id: string) => built.request.stops.find((s) => s.customer_id === id)!;
    expect(stop('A')).toMatchObject({ hard_start_min: 600, hard_end_min: 840 });
    expect(stop('B')).toMatchObject({ hard_start_min: 900, hard_end_min: null });
    expect(built.warnings.join(' ')).toMatch(/Delivery time outside the customer's receiving hours: B\. /);
    expect(built.warnings.join(' ')).not.toMatch(/receiving hours: A/);
  });
});

describe('item 2: own confirmed window', () => {
  const C = (over: Partial<CustomerForPlanning> = {}): CustomerForPlanning => ({
    id: 'c1', code: 'C1', branchCode: null, name: 'C1', lat: 23.5859, lng: 58.4059, priority: 3, priorityConfirmed: true, avgServiceTimeMin: 10,
    serviceTimeConfirmed: true, customerType: 'HYPERMARKET', hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null,
    locationVerified: true, createdFromUpload: false, ...over,
  });
  const HYPER: TypeProfileLike = { customerType: 'HYPERMARKET', defaultPriority: 1, serviceTimeMin: 40, hardWindowStartMin: 300, hardWindowEndMin: 660, prefWindowStartMin: null, prefWindowEndMin: null };
  const P = new Map([['HYPERMARKET', HYPER]]);
  const eff = (c: CustomerForPlanning) => effectiveAttrs(c, P, { serviceTimeMin: 10 });
  const windowCodes = (c: CustomerForPlanning) => customerIssues(c, eff(c)).map((i) => i.code).filter((x) => x === 'NO_RECEIVING_WINDOW' || x === 'WINDOW_UNCONFIRMED');

  it('a customer-type default is used but is not the customer\'s own window: "(default - not confirmed)"', () => {
    const e = eff(C());
    expect(e).toMatchObject({ windowSource: 'TYPE', windowConfirmed: false, hardStart: 300, hardEnd: 660 });
    expect(windowLabel(e)).toBe('hard 05:00–11:00 (default - not confirmed)');
    expect(windowCodes(C())).toEqual(['WINDOW_UNCONFIRMED']);
    expect(customerIssues(C(), e).find((i) => i.code === 'WINDOW_UNCONFIRMED')?.message).toBe(
      'Receiving hours (hard 05:00–11:00) are the customer-type default - not confirmed. Confirm them in Details.',
    );
  });

  it('stored hours nobody confirmed are used, marked "(not confirmed)"', () => {
    const c = C({ hardWindowStartMin: 420, hardWindowEndMin: 720 });
    expect(eff(c)).toMatchObject({ windowSource: 'CUSTOMER', windowConfirmed: false });
    expect(windowLabel(eff(c))).toBe('hard 07:00–12:00 (not confirmed)');
    expect(windowCodes(c)).toEqual(['WINDOW_UNCONFIRMED']);
  });

  it('confirmed hours are its own; "open all day" (confirmed, no hours) wins over the type default', () => {
    const c = C({ hardWindowStartMin: 420, hardWindowEndMin: 720, windowConfirmedAt: new Date() });
    expect(windowLabel(eff(c))).toBe('hard 07:00–12:00 (confirmed)');
    expect(windowCodes(c)).toEqual([]);
    const open = C({ windowConfirmedAt: '2026-10-01T08:00:00Z' });
    expect(eff(open)).toMatchObject({ windowSource: 'CUSTOMER', windowConfirmed: true, hardStart: null, hardEnd: null, prefStart: null, prefEnd: null });
    expect(windowLabel(eff(open))).toBe('Open all day (confirmed)');
    expect(windowCodes(open)).toEqual([]);
  });

  it('no hours anywhere: "Any time (default - not confirmed)" and the note says what to do', () => {
    const c = C({ customerType: null });
    expect(windowLabel(eff(c))).toBe('Any time (default - not confirmed)');
    expect(customerIssues(c, eff(c)).find((i) => i.code === 'NO_RECEIVING_WINDOW')?.message).toMatch(/Ask the customer and enter them in Details \(or tick "Open all day"\)/);
  });

  it('the Details dialog sends "open all day" and "confirmed with the customer" (hours sent whole)', () => {
    const base: DetailsCustomer = { customerType: 'HYPERMARKET', priority: 3, serviceMin: 10, hardWindowStartMin: 420, hardWindowEndMin: 720, prefWindowStartMin: null, prefWindowEndMin: null };
    const f = detailsFormOf(base);
    expect(f).toMatchObject({ openAllDay: false, confirmHours: false });
    const all = { hardWindowStartMin: 420, hardWindowEndMin: 720, prefWindowStartMin: null, prefWindowEndMin: null };
    expect(detailsPatch(f, { ...f, confirmHours: true })).toEqual({ ok: true, patch: { ...all, windowConfirmed: true } });
    // Open all day: the boxes are not read (a half-typed time there does not stop it).
    expect(detailsPatch(f, { ...f, openAllDay: true, hardEnd: '1' })).toEqual({
      ok: true, patch: { hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null, windowConfirmed: true },
    });
    // Already open all day, switched off with no hours: sent empty (the server then marks it not confirmed).
    const open = detailsFormOf({ ...base, hardWindowStartMin: null, hardWindowEndMin: null, windowConfirmed: true });
    expect(open).toMatchObject({ openAllDay: true, confirmHours: true });
    expect(detailsPatch(open, open)).toEqual({ ok: true, patch: {} });
    expect(detailsPatch(open, { ...open, openAllDay: false })).toEqual({ ok: true, patch: { hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null } });
  });

  it("an order's Set time opens prefilled from the customer's own confirmed hours only, with no reason chosen (its own time when it has one)", () => {
    const c = { customerId: 'c1', code: 'C1', branchCode: null, name: 'C1', windowConfirmed: true, effWindow: { hardStart: 360, hardEnd: 840, prefStart: 420, prefEnd: 600 } };
    const o = { orderId: 'O1', cases: 5, salesOrders: ['SO1'], time: null, text: null, frozen: false };
    expect(orderTimeFormOf(c, o)).toEqual({ start: '06:00', end: '14:00', reason: '', note: '' });
    expect(orderTimeFormOf({ ...c, effWindow: { hardStart: null, hardEnd: null, prefStart: 420, prefEnd: 600 } }, o)).toMatchObject({ start: '07:00', end: '10:00' });
    expect(orderTimeFormOf(c, { ...o, time: { startMin: 600, endMin: 1440, reason: 'PROMISED', note: 'x' } })).toEqual({ start: '10:00', end: '24:00', reason: 'PROMISED', note: 'x' });
    // A customer-type or company default (or hours nobody confirmed) never counts as a delivery window:
    // nothing is prefilled from it, so one Save cannot turn it into "Urgent 06:00-14:00".
    expect(orderTimeFormOf({ ...c, windowConfirmed: false }, o)).toEqual({ start: '', end: '', reason: '', note: '' });
    expect(orderTimeFormOf({ ...c, windowConfirmed: undefined }, o)).toEqual({ start: '', end: '', reason: '', note: '' });
    // Saving that form as it opens is refused: a time and a reason must be given.
    expect(orderTimeFromForm(orderTimeFormOf(c, o))).toMatchObject({ ok: false, error: expect.stringMatching(/^Choose a reason/) });
    expect(orderTimeFromForm(orderTimeFormOf({ ...c, windowConfirmed: false }, o))).toMatchObject({ ok: false, error: 'Give a start or an end time (or both).' });
    // The dialog says why nothing is prefilled, naming the hours in use.
    expect(orderTimeHint({ ...c, windowConfirmed: false, windowLabel: 'hard 06:00–14:00 (default - not confirmed)' })).toBe(
      "The customer's hours in use (hard 06:00–14:00 (default - not confirmed)) are not its own confirmed hours, so they do not count as a delivery window. Type the time agreed for this order.",
    );
    expect(orderTimeHint(c)).toBeNull();
  });
});

describe('item 5: the location admin-lock rule', () => {
  const at = (over: Record<string, unknown>) => ({ lat: 23.5859, lng: 58.4059, locationVerified: false, geocodeConfidence: 'HIGH', ...over });
  it('a dispatcher is locked out of a usable location only; an admin never', () => {
    expect(savedLocationLocked(false, at({}))).toBe(true); // imported, exact, in the area: usable
    expect(savedLocationLocked(false, at({ locationVerified: true }))).toBe(true);
    expect(savedLocationLocked(false, at({ lat: null, lng: null }))).toBe(false); // none
    expect(savedLocationLocked(false, at({ lat: 0, lng: 0 }))).toBe(false); // not valid
    expect(savedLocationLocked(false, at({ geocodeConfidence: 'LOW' }))).toBe(false); // LOW, never confirmed
    expect(savedLocationLocked(false, at({ lat: 51.5, lng: -0.12 }))).toBe(false); // outside the area, never confirmed
    expect(savedLocationLocked(true, at({ locationVerified: true }))).toBe(false);
  });

  it("the day card's location button never offers a dispatcher to confirm a saved point that is not exact", () => {
    expect(locationButtonText({ needsLocation: true, isAdmin: false, notExact: false })).toEqual({ label: 'ADD LOCATION', title: undefined });
    expect(locationButtonText({ needsLocation: false, isAdmin: true, notExact: true })).toEqual({ label: 'Location', title: undefined });
    expect(locationButtonText({ needsLocation: false, isAdmin: false, notExact: false })).toEqual({
      label: 'Location (admin changes)',
      title: 'Only an admin can change a saved location. You can confirm it as it is.',
    });
    const notExact = locationButtonText({ needsLocation: false, isAdmin: false, notExact: true });
    expect(notExact.title).toBe("This saved location is not exact and only an admin can change it. Ask your company admin to drop the pin on the customer's exact location.");
    expect(notExact.title).not.toMatch(/confirm it/);
  });
});
