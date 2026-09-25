/**
 * Review F21: Settings shows only what the dispatch planner uses, within the optimizer's bounds.
 * The real buildDispatchRequest runs against a fake database:
 * - every field Settings can save (tenantConfigSchema), and every planner field of Trucks and
 *   Depots, changes the optimizer request - or is on the explicit list of fields read elsewhere
 *   (order intake), checked against their own consumer;
 * - the old controls that changed nothing are refused by the API schema (strict);
 * - the country is a pick-list: a typo can no longer switch road routing;
 * - the default service time applies to customers whose own time was never confirmed;
 * - the web's bounds are the contract copy (packages/shared-types/src/planner-bounds.json);
 * - stored values outside the bounds refuse the optimize with a clear 409, more than 600 stops 422.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ prisma: {} as Record<string, any>, tdb: {} as Record<string, any> }));
vi.mock('@/lib/db', () => ({ prisma: new Proxy({}, { get: (_t, k: string) => (k === 'then' ? undefined : fake.prisma[k]) }) }));
vi.mock('@/lib/tenant', () => ({ tenantDb: () => fake.tdb }));

import { buildDispatchRequest, PlanError } from '@/lib/dispatch/plan-service';
import { depotSchema, tenantConfigSchema, tenantSettingsSchema, truckSchema } from '@/lib/schemas';
import { CONFIG_BOUNDS, DEPOT_BOUNDS, LARGE_DAY_STOPS, MAX_DISPATCH_STOPS, TRUCK_BOUNDS } from '@/lib/planner-bounds';
import { COUNTRY_NAMES } from '@/lib/countries';
import { effectivePlannerValues } from '@/lib/dispatch/planner-config';
import { isAfterCutoff } from '@/lib/dispatch/time';
import { SETTINGS_FIELDS } from '@/lib/settings-fields';

const BASE_CFG: Record<string, any> = {
  avgSpeedKmh: 40, distanceProvider: 'OSRM', distanceMultiplier: 1.3, driverShiftMaxMinutes: 660, shiftStartMin: 360,
  reloadMinutes: 30, loadingMinPerCase: 0.04, serviceMinPerCase: 0.05, maxTripsPerTruck: 3, splitDeliveries: true,
  defaultServiceTimeMin: 10, timezone: 'Asia/Muscat', planningCutoffMin: 1080, fuelPricePerLitre: 0.26, driverCostPerHour: 2.5,
  overtimeAfterMin: 540, overtimeCostPerHour: 4, prefWindowPenaltyPerMin: 0.05, roadTimeFactor: 1.25, osrmUrl: null,
  priorityWeightsJson: null, orderColumnMapJson: null, dateOrder: 'DMY', serviceAreaJson: null,
  // Deprecated columns still in the database (read by nothing).
  labelEstimatedDistances: true, returnToDepot: true, solverTimeLimitSeconds: 30,
};
const BASE_TRUCK: Record<string, any> = {
  id: 'T1', code: 'T1', capacityCases: 1000, capacityWeightKg: 10000, fixedCostPerDay: 20, tripCost: 0, costPerKm: 0.15,
  kmPerLitre: null, availableFromMin: null, availableToMin: null, maxTripsPerDay: null,
};
const BASE_DEPOT: Record<string, any> = { id: 'D1', lat: 23.58, lng: 58.38, openMin: null, closeMin: null };

function customer(id: string, lat: number, lng: number, over: Record<string, unknown> = {}) {
  return {
    id, code: id, branchCode: null, name: id, lat, lng, priority: 3, priorityConfirmed: false, avgServiceTimeMin: 10, serviceTimeConfirmed: false,
    customerType: null, hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null, locationVerified: true,
    createdFromUpload: false, active: true, ...over,
  };
}
function order(id: string, cust: ReturnType<typeof customer>, cases: number) {
  return {
    id, customerId: cust.id, customer: cust, totalCases: cases, totalWeightKg: cases * 10, priority: 3, priorityFromFile: false, isLate: false,
    salesValue: null, marginValue: null, status: 'NEW',
    lines: [{ id: `${id}-l1`, cases, weightKg: cases * 10, weightFromMaster: false, salesValue: null, marginValue: null, product: { code: 'P', name: 'P', weightPerCaseKg: 10, active: true } }],
  };
}

let customers = [customer('C1', 23.6, 58.4), customer('C2', 23.55, 58.3)];
function wire(cfg: Record<string, any>, opts: { country?: string; truck?: Record<string, any>; depot?: Record<string, any>; orders?: unknown[] } = {}) {
  fake.tdb.runPlan = { findUniqueOrThrow: async () => ({ id: 'R1', depotId: 'D1', runDate: new Date('2026-09-26T00:00:00Z'), parentRunId: null, reason: 'INITIAL', depot: { ...BASE_DEPOT, ...opts.depot } }) };
  fake.tdb.tenantConfig = { findUniqueOrThrow: async () => ({ ...cfg }) };
  fake.tdb.customerTypeProfile = { findMany: async () => [] };
  fake.tdb.planLoad = { findMany: async () => [] };
  fake.tdb.truck = { findMany: async () => [{ ...BASE_TRUCK, ...opts.truck }] };
  fake.prisma.tenant = { findUniqueOrThrow: async () => ({ country: opts.country ?? 'Oman' }) };
  fake.prisma.depot = { count: async () => 1 };
  // O2 is bigger than the truck (1,000 cases): what "split deliveries" decides about.
  fake.prisma.order = { findMany: async () => opts.orders ?? [order('O1', customers[0]!, 50), order('O2', customers[1]!, 1500)] };
  fake.prisma.routeAssignment = { findMany: async () => [] };
}

async function build(cfg: Record<string, any>, opts: Parameters<typeof wire>[1] = {}) {
  wire(cfg, opts);
  const b = await buildDispatchRequest('TEN', 'R1');
  return JSON.stringify({ req: b.request, warnings: b.warnings });
}

/** A different valid value for each setting (inside its bounds). */
const CHANGED: Record<string, unknown> = {
  shiftStartMin: 300, driverShiftMaxMinutes: 600, overtimeAfterMin: 480, reloadMinutes: 45, loadingMinPerCase: 0.1, serviceMinPerCase: 0.2,
  defaultServiceTimeMin: 25, maxTripsPerTruck: 2, splitDeliveries: false, planningCutoffMin: 1020, dateOrder: 'MDY', fuelPricePerLitre: 0.3,
  driverCostPerHour: 3, overtimeCostPerHour: 6, prefWindowPenaltyPerMin: 0.2, distanceProvider: 'HAVERSINE', roadTimeFactor: 1.4,
  distanceMultiplier: 1.5, avgSpeedKmh: 55,
};
/** Read by the order intake, not by the optimizer request (checked against their consumer below). */
const INTAKE_ONLY = new Set(['planningCutoffMin', 'dateOrder']);

beforeEach(() => {
  customers = [customer('C1', 23.6, 58.4), customer('C2', 23.55, 58.3)];
});

describe('Settings fields drive the planner (review F21)', () => {
  it('Settings edits exactly the fields of the API schema', () => {
    expect([...SETTINGS_FIELDS].sort()).toEqual(Object.keys(tenantConfigSchema.shape).sort());
  });

  it('every saved setting changes the optimizer request, except the order-intake ones', async () => {
    const base = await build(BASE_CFG);
    for (const k of Object.keys(tenantConfigSchema.shape)) {
      expect(CHANGED, k).toHaveProperty(k);
      expect(tenantConfigSchema.partial().safeParse({ [k]: CHANGED[k] }).success, k).toBe(true);
      const changed = await build({ ...BASE_CFG, [k]: CHANGED[k] });
      if (INTAKE_ONLY.has(k)) expect(changed, k).toBe(base);
      else expect(changed, k).not.toBe(base);
    }
  });

  it('the order-intake settings change their own consumer', () => {
    // 18:30 on the 25th for a delivery on the 26th: late with an 18:00 cutoff, not with 19:00.
    const at = new Date('2026-09-25T14:30:00Z');
    expect(isAfterCutoff(at, '2026-09-26', 1080)).toBe(true);
    expect(isAfterCutoff(at, '2026-09-26', 1140)).toBe(false);
  });

  it('every planner field of Trucks and Depots changes the request', async () => {
    const base = await build(BASE_CFG);
    const truckChanges: Record<string, unknown> = {
      capacityCases: 900, capacityWeightKg: 9000, fixedCostPerDay: 25, tripCost: 2, costPerKm: 0.2, kmPerLitre: 4, maxTripsPerDay: 2,
      availableFromMin: 420, availableToMin: 1200,
    };
    for (const k of Object.keys(TRUCK_BOUNDS)) {
      expect(truckSchema.innerType().shape, k).toHaveProperty(k);
      expect(await build(BASE_CFG, { truck: { [k]: truckChanges[k] } }), k).not.toBe(base);
    }
    for (const [k, v] of Object.entries({ openMin: 300, closeMin: 1200 })) {
      expect(depotSchema.innerType().shape, k).toHaveProperty(k);
      expect(k in DEPOT_BOUNDS).toBe(true);
      expect(await build(BASE_CFG, { depot: { [k]: v } }), k).not.toBe(base);
    }
  });

  it('the old controls that changed nothing are refused by the API, and the request ignores their columns', async () => {
    const p = tenantConfigSchema.partial();
    for (const k of ['solverTimeLimitSeconds', 'labelEstimatedDistances', 'returnToDepot', 'weightObjectiveTrucks', 'costPerKmDefault', 'fixedTruckCostPerDayDefault', 'latePenaltyPerMin', 'underutilizationPenalty']) {
      expect(p.safeParse({ [k]: 1 }).success, k).toBe(false);
    }
    expect(p.safeParse({ distanceProvider: 'MAPBOX_MATRIX' }).success).toBe(false);
    const base = await build(BASE_CFG);
    expect(await build({ ...BASE_CFG, solverTimeLimitSeconds: 300, labelEstimatedDistances: false, returnToDepot: false })).toBe(base);
    expect(base).toContain('"time_limit_sec":null');
  });

  it('the country is a pick-list: a typo is refused instead of switching road routing', async () => {
    expect(tenantSettingsSchema.partial().safeParse({ country: 'Omaan' }).success).toBe(false);
    for (const c of COUNTRY_NAMES) expect(tenantSettingsSchema.partial().safeParse({ country: c }).success, c).toBe(true);
    expect(await build(BASE_CFG, { country: 'Oman' })).toContain('"distance_provider":"OSRM"');
    expect(await build(BASE_CFG, { country: 'United Arab Emirates' })).toContain('"distance_provider":"OSRM"');
    expect(await build(BASE_CFG, { country: 'Saudi Arabia' })).toContain('"distance_provider":"HAVERSINE"');
  });

  it('the default service time applies to customers whose own time was never confirmed', async () => {
    const base = await build(BASE_CFG);
    expect(await build({ ...BASE_CFG, defaultServiceTimeMin: 30 })).not.toBe(base);
    customers = [customer('C1', 23.6, 58.4, { serviceTimeConfirmed: true, avgServiceTimeMin: 12 }), customer('C2', 23.55, 58.3, { serviceTimeConfirmed: true, avgServiceTimeMin: 12 })];
    const confirmed = await build(BASE_CFG);
    expect(await build({ ...BASE_CFG, defaultServiceTimeMin: 30 })).toBe(confirmed);
  });
});

describe('bounds (review F21)', () => {
  it('the web bounds are the contract copy in shared-types', () => {
    const json = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../packages/shared-types/src/planner-bounds.json'), 'utf8'));
    const strip = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { solver: v.solver, min: v.min, max: v.max, ...(v.int ? { int: true } : {}) }]));
    expect(strip(CONFIG_BOUNDS)).toEqual(strip(json.config));
    expect(strip(TRUCK_BOUNDS)).toEqual(strip(json.truck));
    expect(strip(DEPOT_BOUNDS)).toEqual(strip(json.depot));
    expect(MAX_DISPATCH_STOPS).toBe(json.maxStops);
  });

  it('the schema accepts each bound and refuses just outside it', () => {
    const p = tenantConfigSchema.partial();
    for (const [k, b] of Object.entries(CONFIG_BOUNDS)) {
      expect(p.safeParse({ [k]: b.min }).success, `${k} min`).toBe(true);
      expect(p.safeParse({ [k]: b.max }).success, `${k} max`).toBe(true);
      expect(p.safeParse({ [k]: b.max + 1 }).success, `${k} above`).toBe(false);
      expect(p.safeParse({ [k]: b.min - 1 }).success, `${k} below`).toBe(false);
    }
  });

  it('a stored value outside the bounds refuses the optimize with a clear 409 (not a solver 422)', async () => {
    wire({ ...BASE_CFG, roadTimeFactor: 5 });
    const e = await buildDispatchRequest('TEN', 'R1').catch((x) => x);
    expect(e).toBeInstanceOf(PlanError);
    expect(e.status).toBe(409);
    expect(e.details.code).toBe('SETTINGS_OUT_OF_RANGE');
    expect(e.message).toContain('Road time factor');
  });

  it('a truck value the optimizer refuses (a database edit) is named: 409 MASTER_DATA_OUT_OF_RANGE', async () => {
    wire(BASE_CFG, { truck: { kmPerLitre: 0 } });
    const e = await buildDispatchRequest('TEN', 'R1').catch((x) => x);
    expect(e).toBeInstanceOf(PlanError);
    expect(e.status).toBe(409);
    expect(e.details.code).toBe('MASTER_DATA_OUT_OF_RANGE');
    expect(e.message).toContain('Truck T1: km per litre 0');
  });

  it('more stops than one optimization supports: 422 TOO_MANY_STOPS', async () => {
    const many = Array.from({ length: MAX_DISPATCH_STOPS + 1 }, (_, i) => order(`O${i}`, customer(`C${i}`, 23.5 + i * 0.0001, 58.3), 1));
    wire(BASE_CFG, { orders: many });
    const e = await buildDispatchRequest('TEN', 'R1').catch((x) => x);
    expect(e).toBeInstanceOf(PlanError);
    expect(e.status).toBe(422);
    expect(e.details.code).toBe('TOO_MANY_STOPS');
  });

  it('a large day gets one "Large day" warning - the optimizer\'s, not a second one from the web', async () => {
    const many = Array.from({ length: LARGE_DAY_STOPS + 1 }, (_, i) => order(`O${i}`, customer(`C${i}`, 23.5 + i * 0.0001, 58.3), 1));
    wire(BASE_CFG, { orders: many });
    const b = await buildDispatchRequest('TEN', 'R1');
    expect(b.request.stops.length).toBe(LARGE_DAY_STOPS + 1);
    expect(b.warnings.filter((w) => /large day/i.test(w))).toEqual([]);
  });

  it('the effective values panel names every setting source and says when overtime can never apply', () => {
    const rows = effectivePlannerValues({ ...BASE_CFG, overtimeAfterMin: 660 } as never, 'Oman', 'OMR');
    expect(rows.find((r) => r.label === 'Driver cost')!.note).toMatch(/whole truck day/);
    expect(rows.find((r) => r.label === 'Overtime')!.note).toMatch(/never reached/);
    expect(rows.find((r) => r.label === 'Timezone')!.source).toBe('OPERATIONS');
    expect(rows.find((r) => r.label === 'Search time')!.source).toBe('PLANNER');
  });
});
