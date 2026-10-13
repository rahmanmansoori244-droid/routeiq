/**
 * "Small truck only" customers (owner request after the first live night, 12 Oct 2026; owner decisions
 * 13 Oct 2026: one yes/no per customer, one company setting "a small truck has at most N bays", 6 by
 * default; lib/dispatch/small-truck.ts).
 * - The rule: a truck with bays entered and at most N is small; a truck without bays never is.
 * - buildDispatchRequest (on a fake database): every stop of such a customer, and every part of its
 *   split delivery, carries allowed_truck_ids = the day's small trucks (own and hired for the day) and
 *   the label the optimizer's reasons use; other stops carry nothing (a day without such customers sends
 *   what it sent before); a customer that fits a big truck but no small one is split for the small
 *   trucks; no small truck today: allowed [] and one warning.
 * - The hire check adds the small trucks it may rent to those stops, never a big one.
 * - Entry: the API schemas, the Details form, the import cell, the workbook column and row_version.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ prisma: {} as Record<string, any>, tdb: {} as Record<string, any> }));
vi.mock('@/lib/db', () => ({ prisma: new Proxy({}, { get: (_t, k: string) => (k === 'then' ? undefined : fake.prisma[k]) }) }));
vi.mock('@/lib/tenant', () => ({ tenantDb: () => fake.tdb }));

import type { DispatchStop, DispatchTruck } from '@routeiq/shared-types';
import { buildDispatchRequest } from '@/lib/dispatch/plan-service';
import {
  importedSmallTruckCell,
  isSmallTruck,
  readSmallTruckCell,
  SMALL_TRUCK_MAX_BAYS_DEFAULT,
  smallTruckBreaches,
  smallTruckGateMessage,
  smallTruckIds,
  smallTruckLabel,
  smallTruckMaxBaysOf,
  SMALL_TRUCK_SOLVER_NOTE,
  smallTruckSolverNote,
  smallTruckStopFields,
  withSmallHires,
} from '@/lib/dispatch/small-truck';
import { customerPatchSchema, customerSchema, tenantConfigSchema } from '@/lib/schemas';
import { CONFIG_BOUNDS } from '@/lib/planner-bounds';
import { detailsFormOf, detailsPatch, EMPTY_DETAILS } from '@/app/t/[slug]/dispatch/customer-details';
import { MASTER_COLUMNS, masterValues, rowVersion, type MasterCustomer } from '@/lib/dispatch/data-collection';
import { DEFAULT_SERVICE_AREA } from '@/lib/dispatch/location-input';
import { CAPACITY_REASONS } from '@/lib/dispatch/hire';
import { IDLE_TRUCK_REASONS } from '@/lib/dispatch/left-out-note';
import { REASON_TEXT } from '@/app/t/[slug]/dispatch/client-api';

// ------------------------------------------------------------------------------------------------
// The fake database for buildDispatchRequest (as pallets-request.spec.ts)
// ------------------------------------------------------------------------------------------------

const CFG: Record<string, any> = {
  avgSpeedKmh: 40, distanceProvider: 'HAVERSINE', distanceMultiplier: 1.3, driverShiftMaxMinutes: 660, shiftStartMin: 420,
  reloadMinutes: 30, loadingMinPerCase: 0, serviceMinPerCase: 0, maxTripsPerTruck: 3, splitDeliveries: true,
  defaultServiceTimeMin: 10, timezone: 'Asia/Muscat', planningCutoffMin: 1080, fuelPricePerLitre: 0, driverCostPerHour: 0,
  overtimeAfterMin: 540, overtimeCostPerHour: 0, prefWindowPenaltyPerMin: 0.05, roadTimeFactor: 1.25, osrmUrl: null,
  driverBreakMinutes: 0, driverBreakFromMin: 720, driverBreakToMin: 840, priorityWeightsJson: null, dateOrder: 'DMY',
  serviceAreaJson: null,
};
const truckRow = (id: string, over: Record<string, any> = {}) => ({
  id, code: id, capacityCases: 1140, capacityWeightKg: 0, fixedCostPerDay: 20, tripCost: 0, costPerKm: 0.15, kmPerLitre: null,
  availableFromMin: null, availableToMin: null, maxTripsPerDay: null, bays: null, ...over,
});
function customer(id: string, lat: number, lng: number, over: Record<string, unknown> = {}) {
  return {
    id, code: id, branchCode: null, name: `Shop ${id}`, lat, lng, priority: 3, priorityConfirmed: false, avgServiceTimeMin: 10, serviceTimeConfirmed: false,
    customerType: null, hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null, locationVerified: true,
    createdFromUpload: false, active: true, smallTruckOnly: false, ...over,
  };
}
/** An order of `cases` cases of a product with 95 cases per pallet. */
function order(id: string, cust: ReturnType<typeof customer>, cases: number) {
  return {
    id, customerId: cust.id, customer: cust, totalCases: cases, totalWeightKg: cases * 5, priority: 3, priorityFromFile: false, isLate: false,
    salesValue: null, marginValue: null, status: 'NEW',
    lines: [{ id: `${id}-l1`, productId: 'P', cases, weightKg: cases * 5, weightFromMaster: false, salesValue: null, marginValue: null,
      product: { code: 'TN1.5L', name: 'Tanuf 1.5L', weightPerCaseKg: 5, casesPerPallet: 95, active: true } }],
  };
}
function wire(trucks: Record<string, any>[], orders: unknown[], cfg: Record<string, any> = {}) {
  fake.tdb.runPlan = { findUniqueOrThrow: async () => ({ id: 'R1', depotId: 'D1', runDate: new Date('2026-10-14T00:00:00Z'), parentRunId: null, reason: 'INITIAL', depot: { id: 'D1', lat: 23.58, lng: 58.38, openMin: null, closeMin: null } }) };
  fake.tdb.tenantConfig = { findUniqueOrThrow: async () => ({ ...CFG, ...cfg }) };
  fake.tdb.customerTypeProfile = { findMany: async () => [] };
  fake.tdb.planLoad = { findMany: async () => [] };
  fake.tdb.truck = { findMany: async () => trucks };
  fake.prisma.tenant = { findUniqueOrThrow: async () => ({ country: 'Oman' }) };
  fake.prisma.order = { findMany: async () => orders };
  fake.prisma.routeAssignment = { findMany: async () => [] };
  fake.prisma.runPlan = { findMany: async () => [] };
}
const NOW = new Date('2026-10-13T12:00:00Z');
// NMWC's fleet (owner, 13 Oct 2026): 3-ton trucks with 4-6 bays, 10-ton trucks with 11-12, and here one truck without bays.
const FLEET = () => [
  truckRow('T03', { bays: 4, capacityCases: 380 }),
  truckRow('T05', { bays: 6, capacityCases: 570 }),
  truckRow('T10', { bays: 12, capacityCases: 1140 }),
  truckRow('T11', { bays: 11, capacityCases: 1017 }),
  truckRow('TNB', { bays: null, capacityCases: 600 }),
];

beforeEach(() => {
  for (const k of Object.keys(fake.tdb)) delete fake.tdb[k];
  for (const k of Object.keys(fake.prisma)) delete fake.prisma[k];
});

describe('the rule (small-truck.ts)', () => {
  it('a truck with bays entered and at most N is small; a truck without bays never is', () => {
    expect([4, 6, 7, 12].map((b) => isSmallTruck(b, 6))).toEqual([true, true, false, false]);
    expect(isSmallTruck(null, 6)).toBe(false);
    expect(isSmallTruck(undefined, 40)).toBe(false);
    expect(isSmallTruck(0, 6)).toBe(false);
    expect(smallTruckIds([{ id: 'a', bays: 4 }, { id: 'b', bays: 12 }, { id: 'c', bays: null }, { id: 'd', bays: 6 }], 6)).toEqual(['a', 'd']);
    expect(smallTruckLabel(6)).toBe('a small truck (at most 6 bays)');
    expect(smallTruckLabel(1)).toBe('a small truck (at most 1 bay)');
  });

  it('the setting: 6 by default, 1-40 whole bays (the trucks bays range), a company admin field', () => {
    expect(SMALL_TRUCK_MAX_BAYS_DEFAULT).toBe(6);
    expect(smallTruckMaxBaysOf(null)).toBe(6);
    expect(smallTruckMaxBaysOf({ smallTruckMaxBays: 4 })).toBe(4);
    expect(smallTruckMaxBaysOf({ smallTruckMaxBays: 0 })).toBe(6);
    expect(CONFIG_BOUNDS.smallTruckMaxBays).toEqual({ solver: 'stop.allowed_truck_ids', min: 1, max: 40, int: true });
    const p = tenantConfigSchema.partial();
    expect(p.safeParse({ smallTruckMaxBays: 6 }).success).toBe(true);
    for (const bad of [0, 41, 5.5]) expect(p.safeParse({ smallTruckMaxBays: bad }).success, String(bad)).toBe(false);
  });

  it('only a small-truck-only customer gets the stop fields: other stops are sent as before', () => {
    expect(smallTruckStopFields(false, ['T03'], 6)).toEqual({});
    expect(smallTruckStopFields(true, ['T03', 'T05'], 6)).toEqual({ allowed_truck_ids: ['T03', 'T05'], allowed_trucks_label: 'a small truck (at most 6 bays)' });
  });

  it('the reason: shown as "Needs a small truck", asks for a hire check, and never blames an unused big truck', () => {
    expect(REASON_TEXT.NO_ALLOWED_TRUCK).toBe('Needs a small truck');
    expect(CAPACITY_REASONS).toContain('NO_ALLOWED_TRUCK');
    expect(IDLE_TRUCK_REASONS).not.toContain('NO_ALLOWED_TRUCK');
  });
});

describe('buildDispatchRequest: the allowed trucks of a small-truck-only customer', () => {
  it('every stop of such a customer may go on the small trucks only; other stops carry nothing', async () => {
    const small = customer('SMALL1', 23.6, 58.4, { smallTruckOnly: true });
    const any = customer('ANY1', 23.55, 58.3);
    wire(FLEET(), [order('O1', small, 100), order('O2', any, 100)]);
    const b = await buildDispatchRequest('TEN', 'R1', undefined, { now: NOW });
    const byId = Object.fromEntries(b.request.stops.map((s) => [s.stop_id, s]));
    expect(byId.SMALL1).toMatchObject({ allowed_truck_ids: ['T03', 'T05'], allowed_trucks_label: 'a small truck (at most 6 bays)' });
    expect('allowed_truck_ids' in byId.ANY1!).toBe(false);
    expect('allowed_trucks_label' in byId.ANY1!).toBe(false);
    expect(b.smallTruckMaxBays).toBe(6);
    expect(b.warnings.join(' ')).not.toMatch(/Small truck only/);
  });

  it('the setting decides which trucks are small (a 4-bay limit leaves only the 4-bay truck); a hired-for-the-day truck counts by its bays', async () => {
    const small = customer('SMALL1', 23.6, 58.4, { smallTruckOnly: true });
    wire([...FLEET(), truckRow('HIRE-3T-1', { bays: 5, capacityCases: 475, hired: true, onlyOnDate: new Date('2026-10-14T00:00:00Z') })], [order('O1', small, 100)], { smallTruckMaxBays: 4 });
    const b = await buildDispatchRequest('TEN', 'R1', undefined, { now: NOW });
    expect(b.request.stops[0]).toMatchObject({ allowed_truck_ids: ['T03'], allowed_trucks_label: 'a small truck (at most 4 bays)' });
    wire([...FLEET(), truckRow('HIRE-3T-1', { bays: 5, capacityCases: 475, hired: true, onlyOnDate: new Date('2026-10-14T00:00:00Z') })], [order('O1', small, 100)]);
    expect((await buildDispatchRequest('TEN', 'R1', undefined, { now: NOW })).request.stops[0]!.allowed_truck_ids).toEqual(['T03', 'T05', 'HIRE-3T-1']);
  });

  it('an order that fits a big truck but no small one is split into parts for the small trucks, each part limited too', async () => {
    // 760 cases at 95 per pallet = 8.0 pallets: one 12-bay load, more than a 6-bay truck (6.0 pallets).
    const small = customer('MT', 23.6, 58.4, { smallTruckOnly: true });
    wire(FLEET(), [order('O1', small, 760)]);
    const b = await buildDispatchRequest('TEN', 'R1', undefined, { now: NOW });
    const parts = b.request.stops;
    expect(parts.length).toBe(2);
    expect(parts.map((p) => p.stop_id)).toEqual(['MT#1', 'MT#2']);
    for (const p of parts) {
      expect(p.allowed_truck_ids).toEqual(['T03', 'T05']);
      // Sized for the 4-bay truck: both small trucks carry such a part (more trips to choose from).
      expect(p.demand_pallet_units).toBeLessThanOrEqual(4_000);
    }
    expect(parts.reduce((a, p) => a + p.demand_cases, 0)).toBe(760);
    expect(b.warnings.join(' ')).toMatch(/MT \(760 cases, 8\.0 pallets, 3800 kg\) in 2 parts sized for T03 \(small trucks only: at most 6 bays\)/);
    // The same order for a customer that takes any truck: one stop (it fits the 12-bay truck).
    wire(FLEET(), [order('O1', customer('MT', 23.6, 58.4), 760)]);
    expect((await buildDispatchRequest('TEN', 'R1', undefined, { now: NOW })).request.stops.map((s) => s.stop_id)).toEqual(['MT']);
  });

  it('without split deliveries such an order stays one stop (the optimizer then says it needs a small truck)', async () => {
    wire(FLEET(), [order('O1', customer('MT', 23.6, 58.4, { smallTruckOnly: true }), 760)], { splitDeliveries: false });
    const b = await buildDispatchRequest('TEN', 'R1', undefined, { now: NOW });
    expect(b.request.stops.map((s) => [s.stop_id, s.allowed_truck_ids])).toEqual([['MT', ['T03', 'T05']]]);
  });

  it('no small truck at the depot today: the stop may go on none ([]), and one warning says what to do', async () => {
    wire([truckRow('T10', { bays: 12 }), truckRow('TNB', { bays: null })], [order('O1', customer('SMALL1', 23.6, 58.4, { smallTruckOnly: true }), 100)]);
    const b = await buildDispatchRequest('TEN', 'R1', undefined, { now: NOW });
    expect(b.request.stops[0]!.allowed_truck_ids).toEqual([]);
    expect(b.warnings).toContain(
      'Small truck only customer(s) today: SMALL1; but this depot has no truck with bays entered and at most 6 bays today, so their orders are left out. Hire a small truck (Check hire options), enter the bays of the small trucks under Trucks, or check Settings (Small truck = at most N bays).',
    );
  });
});

describe('the hire check: only small trucks to rent are added for such stops', () => {
  const stop = (id: string, allowed?: string[]): DispatchStop => ({
    stop_id: id, order_ids: [id], customer_id: id, lat: 23.6, lng: 58.4, demand_cases: 10, ...(allowed ? { allowed_truck_ids: allowed } : {}),
  });
  const hire = (id: string, bays: number | null): DispatchTruck => ({ id, code: id, capacity_cases: 500, hire_candidate: true, ...(bays !== null ? { bays } : {}) });

  it('a 3-ton (6 bays) to rent is allowed, a 10-ton (12 bays) and one without bays are not; other stops are untouched', () => {
    const out = withSmallHires([stop('A', ['T03']), stop('B')], [hire('H3', 6), hire('H10', 12), hire('HX', null)], 6);
    expect(out[0]!.allowed_truck_ids).toEqual(['T03', 'H3']);
    expect('allowed_truck_ids' in out[1]!).toBe(false);
    // No small truck to rent: the stops as they were.
    expect(withSmallHires([stop('A', ['T03'])], [hire('H10', 12)], 6)[0]!.allowed_truck_ids).toEqual(['T03']);
    // A stop no truck may take yet ([]) may take the small truck to rent.
    expect(withSmallHires([stop('A', [])], [hire('H3', 6)], 6)[0]!.allowed_truck_ids).toEqual(['H3']);
  });
});

describe('the plan warning when the optimizer did not apply the allowed trucks (an older solver)', () => {
  it('a limited stop and no echo: the warning; with the echo, or a day without limited stops: none', () => {
    const limited = [{ allowed_truck_ids: ['T03'] }, {}];
    expect(smallTruckSolverNote(limited, {})).toEqual([SMALL_TRUCK_SOLVER_NOTE]);
    expect(smallTruckSolverNote(limited, { allowed_trucks_rule: null })).toEqual([SMALL_TRUCK_SOLVER_NOTE]);
    expect(smallTruckSolverNote([{ allowed_truck_ids: [] }], {})).toEqual([SMALL_TRUCK_SOLVER_NOTE]); // no small truck today: still limited
    expect(smallTruckSolverNote(limited, { allowed_trucks_rule: true })).toEqual([]);
    expect(smallTruckSolverNote([{}, {}], {})).toEqual([]);
    expect(SMALL_TRUCK_SOLVER_NOTE).toMatch(/did not apply "Small truck only".*LOCK refuses those loads/);
  });
});

describe('the gate words (LOCK / LOADING / DISPATCH)', () => {
  const marked = (id: string, smallTruckOnly = true) => ({ customerId: id, code: id, branchCode: null, name: `Shop ${id}`, smallTruckOnly });

  it('breaches: marked customers on a truck that is not small (or has no bays); none on a small truck', () => {
    expect(smallTruckBreaches({ bays: 12 }, [marked('A'), marked('B', false), marked('A')], 6).map((b) => b.code)).toEqual(['A']);
    expect(smallTruckBreaches({ bays: null }, [marked('A')], 6).map((b) => b.code)).toEqual(['A']);
    expect(smallTruckBreaches({ bays: 6 }, [marked('A')], 6)).toEqual([]);
  });

  it('names the load, the truck, the customers and the remedy; a locked load goes back to Planned first', () => {
    const b = smallTruckBreaches({ bays: 12 }, [marked('C1')], 6);
    expect(smallTruckGateMessage({ truckCode: 'T10', loadNo: 2, bays: 12, from: 'PLANNED', to: 'LOCKED' }, b, 6)).toBe(
      'T10 L2: cannot lock this load. T10 (12 bays) is not a small truck, but this customer takes small trucks only (at most 6 bays): C1 Shop C1. RE-PLAN: RouteIQ puts them on a small truck. If the customer accepts this truck today, untick "Small truck only (3-ton)" on the customer until this load is dispatched, then tick it again.',
    );
    expect(smallTruckGateMessage({ truckCode: 'TNB', loadNo: 1, bays: null, from: 'LOCKED', to: 'LOADING' }, b, 6)).toMatch(
      /^TNB L1: cannot start loading this load\. TNB \(no bays entered\) is not a small truck, .* Put this load back to Planned, then RE-PLAN: /,
    );
  });
});

describe('entry: the API, the Details dialog, the import cell, the workbooks', () => {
  it('the customer API accepts a JSON boolean only, on create and on PATCH', () => {
    expect(customerSchema.safeParse({ code: 'C1', name: 'Shop', smallTruckOnly: true }).success).toBe(true);
    expect(customerSchema.parse({ code: 'C1', name: 'Shop' }).smallTruckOnly).toBeUndefined();
    expect(customerPatchSchema.safeParse({ smallTruckOnly: false }).success).toBe(true);
    expect(customerPatchSchema.safeParse({ smallTruckOnly: 'yes' }).success).toBe(false);
  });

  it('Details: the tick box opens as saved, and Save sends it only when it changed', () => {
    const base = { customerType: null, priority: 3, serviceMin: 10, hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null };
    expect(detailsFormOf({ ...base, smallTruckOnly: true }).smallTruckOnly).toBe(true);
    expect(detailsFormOf(base).smallTruckOnly).toBe(false);
    expect(EMPTY_DETAILS.smallTruckOnly).toBe(false);
    const was = detailsFormOf(base);
    expect(detailsPatch(was, { ...was, smallTruckOnly: true })).toEqual({ ok: true, patch: { smallTruckOnly: true } });
    const on = detailsFormOf({ ...base, smallTruckOnly: true });
    expect(detailsPatch(on, { ...on, smallTruckOnly: false })).toEqual({ ok: true, patch: { smallTruckOnly: false } });
    expect(detailsPatch(on, { ...on })).toEqual({ ok: true, patch: {} });
  });

  it('the import column: small_truck_only and its aliases (any letter case, spaces or underscores); the first one with a value wins', () => {
    expect(importedSmallTruckCell({ code: 'C1', small_truck_only: 'yes' })).toEqual({ column: 'small_truck_only', value: 'yes' });
    expect(importedSmallTruckCell({ 'small truck only': 'no' })).toEqual({ column: 'small truck only', value: 'no' });
    expect(importedSmallTruckCell({ 'small truck': 'Y' })).toEqual({ column: 'small truck', value: 'Y' });
    expect(importedSmallTruckCell({ small_truck: 'x' })).toEqual({ column: 'small_truck', value: 'x' });
    expect(importedSmallTruckCell({ 'small truck only (3-ton)': '1' })).toEqual({ column: 'small truck only (3-ton)', value: '1' });
    expect(importedSmallTruckCell({ small_truck_only: '', 'small truck': 'yes' })).toEqual({ column: 'small truck', value: 'yes' });
    expect(importedSmallTruckCell({ small_truck_only: '  ' })).toBeNull();
    expect(importedSmallTruckCell({ truck: 'small' })).toBeNull();
  });

  it('the import cell: yes / no as every yes/no column, blank keeps, anything else is an error of the row', () => {
    for (const v of ['yes', 'Y', 'TRUE', '1', 'x']) expect(readSmallTruckCell(v), v).toEqual({ ok: true, value: true });
    for (const v of ['no', 'N', 'false', '0']) expect(readSmallTruckCell(v), v).toEqual({ ok: true, value: false });
    expect(readSmallTruckCell('')).toEqual({ ok: true, value: null });
    expect(readSmallTruckCell(' 3-ton ', 'small truck')).toEqual({ ok: false, error: 'small truck must be yes or no (got "3-ton").' });
  });

  it('both workbooks have the column (imported back), with yes / no as saved', () => {
    const col = MASTER_COLUMNS.find((c) => c.key === 'small_truck_only')!;
    expect(col).toMatchObject({ imported: true });
    expect(col.text).toMatch(/^yes = the unloading area takes small trucks only \(3-ton\)/);
    expect(MASTER_COLUMNS.findIndex((c) => c.key === 'small_truck_only')).toBe(MASTER_COLUMNS.findIndex((c) => c.key === 'phone') + 1);
    const m = (over: Record<string, unknown>) =>
      ({ ...customer('C', 23.6, 58.4), paymentType: 'CREDIT', address: null, regionCode: null, regionName: null, depotCode: null, locationVerifiedBy: null, windowConfirmedBy: null, ...over }) as unknown as MasterCustomer;
    const ctx = { area: DEFAULT_SERVICE_AREA, profiles: new Map(), serviceTimeMin: 10, timezone: 'Asia/Muscat' };
    expect(masterValues(m({ smallTruckOnly: true }), ctx)).toMatchObject({ small_truck_only: 'yes' });
    expect(masterValues(m({ smallTruckOnly: false }), ctx)).toMatchObject({ small_truck_only: 'no' });
  });

  it('row_version: unchanged for a customer that takes any truck (files from before this release still import); a mark set since is a change', () => {
    // The pinned version of data-collection-master.spec.ts (computed with the code before the phone).
    const fixed = {
      name: 'Corner Shop', regionId: 'R1', address: 'Seeb', priority: 2, priorityConfirmed: true, avgServiceTimeMin: 15, serviceTimeConfirmed: true, paymentType: 'CASH',
      lat: 23.5859, lng: 58.4059, locationVerified: true, geocodeConfidence: 'HIGH', hardWindowStartMin: 360, hardWindowEndMin: 840, prefWindowStartMin: null, prefWindowEndMin: null,
      windowConfirmedAt: '2026-10-01T08:00:00.000Z',
    };
    expect(rowVersion({ ...fixed, smallTruckOnly: false })).toBe('v1-19197a5740cafc');
    expect(rowVersion({ ...fixed, smallTruckOnly: true })).not.toBe('v1-19197a5740cafc');
    expect(rowVersion({ ...fixed, phone: '9123 4567', smallTruckOnly: true })).not.toBe(rowVersion({ ...fixed, phone: '9123 4567' }));
  });
});
