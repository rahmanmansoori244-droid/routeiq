/**
 * Truck capacity in pallets (owner decision 4 Oct 2026): the request builder (buildDispatchRequest)
 * on a fake database.
 * - A depot with a truck with bays: every truck with bays is sent with them, every stop with its pallet
 *   need (each line's cases / its product's cases per pallet, rounded up per line, added up), the
 *   Pallet fill in the config, and each optimizer order ref's units in the scope (stored on the rows).
 * - Products without a usable cases per pallet are listed (missingPalletFactors): the request is built,
 *   never sent (the start gate refuses it).
 * - A customer bigger than one truck in pallets is split by pallets (every part within the room).
 * - Without a truck with bays nothing changes: no pallet field is sent.
 * - planInputsOf keeps the bays, fill and room of each truck and the factors of the day.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ prisma: {} as Record<string, any>, tdb: {} as Record<string, any> }));
vi.mock('@/lib/db', () => ({ prisma: new Proxy({}, { get: (_t, k: string) => (k === 'then' ? undefined : fake.prisma[k]) }) }));
vi.mock('@/lib/tenant', () => ({ tenantDb: () => fake.tdb }));

import { buildDispatchRequest, planInputsOf } from '@/lib/dispatch/plan-service';
import { palletUnits } from '@/lib/dispatch/pallets';

const CFG: Record<string, any> = {
  avgSpeedKmh: 40, distanceProvider: 'HAVERSINE', distanceMultiplier: 1.3, driverShiftMaxMinutes: 660, shiftStartMin: 420,
  reloadMinutes: 30, loadingMinPerCase: 0, serviceMinPerCase: 0, maxTripsPerTruck: 3, splitDeliveries: true,
  defaultServiceTimeMin: 10, timezone: 'Asia/Muscat', planningCutoffMin: 1080, fuelPricePerLitre: 0, driverCostPerHour: 0,
  overtimeAfterMin: 540, overtimeCostPerHour: 0, prefWindowPenaltyPerMin: 0.05, roadTimeFactor: 1.25, osrmUrl: null,
  driverBreakMinutes: 0, driverBreakFromMin: 720, driverBreakToMin: 840, priorityWeightsJson: null, dateOrder: 'DMY',
  // No palletFillPct: a company that never saved one plans at PALLET_FILL_DEFAULT (100%, owner decision 4 Oct 2026).
  serviceAreaJson: null,
};
const truckRow = (id: string, over: Record<string, any> = {}) => ({
  id, code: id, capacityCases: 1140, capacityWeightKg: 10_000, fixedCostPerDay: 20, tripCost: 0, costPerKm: 0.15, kmPerLitre: null,
  availableFromMin: null, availableToMin: null, maxTripsPerDay: null, bays: null, ...over,
});
const PRODUCTS: Record<string, { code: string; cpp: number | null }> = {
  JA05: { code: 'JA0.5L', cpp: 96 },
  TN15: { code: 'TN1.5L', cpp: 39 },
  EFF: { code: 'EFF24', cpp: 160 },
  NEW: { code: 'NEW-SKU', cpp: null },
  BAD: { code: 'BAD-SKU', cpp: 84.5 },
  P84: { code: 'SS0.5L', cpp: 84 },
};

function customer(id: string, lat: number, lng: number) {
  return {
    id, code: id, branchCode: null, name: id, lat, lng, priority: 3, priorityConfirmed: false, avgServiceTimeMin: 10, serviceTimeConfirmed: false,
    customerType: null, hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null, locationVerified: true,
    createdFromUpload: false, active: true,
  };
}
function order(id: string, cust: ReturnType<typeof customer>, lines: [string, number][]) {
  const total = lines.reduce((a, [, c]) => a + c, 0);
  return {
    id, customerId: cust.id, customer: cust, totalCases: total, totalWeightKg: total * 5, priority: 3, priorityFromFile: false, isLate: false,
    salesValue: null, marginValue: null, status: 'NEW',
    lines: lines.map(([p, cases], i) => ({
      id: `${id}-l${i + 1}`, productId: p, cases, weightKg: cases * 5, weightFromMaster: false, salesValue: null, marginValue: null,
      product: { code: PRODUCTS[p].code, name: PRODUCTS[p].code, weightPerCaseKg: 5, casesPerPallet: PRODUCTS[p].cpp, active: true },
    })),
  };
}

const C1 = customer('C1', 23.6, 58.4);
const C2 = customer('C2', 23.55, 58.3);

function wire(trucks: Record<string, any>[], orders: unknown[]) {
  fake.tdb.runPlan = { findUniqueOrThrow: async () => ({ id: 'R1', depotId: 'D1', runDate: new Date('2026-10-05T00:00:00Z'), parentRunId: null, reason: 'INITIAL', depot: { id: 'D1', lat: 23.58, lng: 58.38, openMin: null, closeMin: null } }) };
  fake.tdb.tenantConfig = { findUniqueOrThrow: async () => ({ ...CFG }) };
  fake.tdb.customerTypeProfile = { findMany: async () => [] };
  fake.tdb.planLoad = { findMany: async () => [] };
  fake.tdb.truck = { findMany: async () => trucks };
  fake.prisma.tenant = { findUniqueOrThrow: async () => ({ country: 'Oman' }) };
  fake.prisma.order = { findMany: async () => orders };
  fake.prisma.routeAssignment = { findMany: async () => [] };
}

const NOW = new Date('2026-10-04T12:00:00Z');

beforeEach(() => {
  for (const k of Object.keys(fake.tdb)) delete fake.tdb[k];
  for (const k of Object.keys(fake.prisma)) delete fake.prisma[k];
});

describe('buildDispatchRequest with trucks that have bays', () => {
  it('sends bays, the Pallet fill, every stop pallet need, and keeps each order ref units', async () => {
    wire([truckRow('R1', { bays: 12 }), truckRow('C2')], [order('O1', C1, [['JA05', 100], ['TN15', 50], ['EFF', 30]]), order('O2', C2, [['P84', 84]])]);
    const b = await buildDispatchRequest('TEN', 'R1', undefined, { now: NOW });
    expect(b.request.trucks.map((t) => [t.id, t.bays])).toEqual([['R1', 12], ['C2', undefined]]);
    expect(b.request.config.pallet_fill_pct).toBe(100);
    const units = Object.fromEntries(b.request.stops.map((s) => [s.stop_id, s.demand_pallet_units]));
    // The spec's worked example: 1,042 + 1,283 + 188 = 2,513 units = 2.5 pallets.
    expect(units).toEqual({ C1: 2513, C2: 1000 });
    expect(b.scope.palletUnits).toEqual({ O1: 2513, O2: 1000 });
    expect(b.missingPalletFactors).toEqual([]);
    expect(b.palletFactors).toEqual({ 'JA0.5L': 96, 'TN1.5L': 39, EFF24: 160, 'SS0.5L': 84 });
    const inputs = planInputsOf(b, 'J1', NOW)!;
    expect(inputs.trucks.R1).toMatchObject({ bays: 12, palletFillPct: 100, palletRoomUnits: 12_000 });
    expect(inputs.trucks.C2).not.toHaveProperty('bays');
    expect(inputs.palletFactors).toEqual({ 'JA0.5L': 96, 'TN1.5L': 39, EFF24: 160, 'SS0.5L': 84 });
    // A company that keeps a margin sends its own figure.
    fake.tdb.tenantConfig = { findUniqueOrThrow: async () => ({ ...CFG, palletFillPct: 95 }) };
    const b95 = await buildDispatchRequest('TEN', 'R1', undefined, { now: NOW });
    expect(b95.request.config.pallet_fill_pct).toBe(95);
    expect(planInputsOf(b95, 'J1', NOW)!.trucks.R1).toMatchObject({ palletFillPct: 95, palletRoomUnits: 11_400 });
  });

  it('lists the products without a usable cases per pallet (missing, or not a whole number); the request is still built', async () => {
    wire([truckRow('R1', { bays: 12 })], [order('O1', C1, [['JA05', 10], ['NEW', 120]]), order('O2', C2, [['BAD', 40], ['NEW', 5]])]);
    const b = await buildDispatchRequest('TEN', 'R1', undefined, { now: NOW });
    expect(b.missingPalletFactors).toEqual([
      { productId: 'NEW', productCode: 'NEW-SKU', productName: 'NEW-SKU', lines: 2, cases: 125 },
      { productId: 'BAD', productCode: 'BAD-SKU', productName: 'BAD-SKU', lines: 1, cases: 40 },
    ]);
    // Their lines count 0 units (never sent: OPTIMIZE refuses first).
    expect(b.request.stops.find((s) => s.stop_id === 'C1')?.demand_pallet_units).toBe(palletUnits(10, 96));
  });

  it('splits a customer bigger than one truck by pallets, every part within the room', async () => {
    // 2,000 cases of an 84-per-pallet product: 23.8 pallets on 12 bays at the default 100% (12.0) - and only 1,000 kg.
    wire([truckRow('R1', { bays: 12, capacityCases: 5000 })], [order('O1', C1, [['P84', 2000]])]);
    const b = await buildDispatchRequest('TEN', 'R1', undefined, { now: NOW });
    const parts = b.request.stops.filter((s) => s.stop_id.startsWith('C1#'));
    expect(parts.length).toBe(2);
    for (const p of parts) expect(p.demand_pallet_units).toBeLessThanOrEqual(12_000);
    expect(parts.reduce((a, p) => a + p.demand_cases, 0)).toBe(2000);
    expect(b.warnings.join(' ')).toMatch(/C1 \(2000 cases, 23\.8 pallets, 10000 kg\) in 2 parts sized for R1/);
    // Each part's portion keeps the factor it was cut with; its units are the part's.
    const portion = Object.values(b.scope.portions ?? {})[0];
    expect(portion.lines[0]).toMatchObject({ casesPerPallet: 84 });
    for (const p of parts) expect(p.demand_pallet_units).toBe(p.order_ids.reduce((a, id) => a + (b.scope.palletUnits?.[id] ?? 0), 0));
  });

  it('a customer that fits one truck in pallets is never split, whatever its cases', async () => {
    wire([truckRow('R1', { bays: 12, capacityCases: 1140 })], [order('O1', C1, [['EFF', 1400]])]); // 1,400 cases = 8.75 pallets
    const b = await buildDispatchRequest('TEN', 'R1', undefined, { now: NOW });
    expect(b.request.stops.map((s) => [s.stop_id, s.demand_cases, s.demand_pallet_units])).toEqual([['C1', 1400, 8750]]);
  });

  it('without a truck with bays nothing changes: no pallet field anywhere', async () => {
    wire([truckRow('C1'), truckRow('C2')], [order('O1', C1, [['NEW', 100]])]);
    const b = await buildDispatchRequest('TEN', 'R1', undefined, { now: NOW });
    expect(b.request.trucks.every((t) => !('bays' in t))).toBe(true);
    expect(b.request.stops.every((s) => !('demand_pallet_units' in s))).toBe(true);
    expect(b.scope).not.toHaveProperty('palletUnits');
    expect(b.missingPalletFactors).toBeUndefined();
    expect(planInputsOf(b, 'J1', NOW)).not.toHaveProperty('palletFactors');
  });
});

