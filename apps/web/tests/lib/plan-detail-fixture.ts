/**
 * A realistic dispatch PlanDetail without a database, shared by the Excel workbook and driver
 * sheet tests. Built with the real reconcile() / computeSummary() so it is internally consistent.
 */
import type { DetailLoad, DetailStop, DetailUnserved, PlanDetail } from '@/lib/dispatch/plan-detail';
import { aggregateSkus, reconcile, type ReconOrder } from '@/lib/dispatch/reconcile';
import { computeSummary } from '@/lib/dispatch/summary';

// ---------------------------------------------------------------------------------------
// Fixture: 2 trucks, 3 loads, several SKUs per stop, 1 unserved order
// ---------------------------------------------------------------------------------------

export const PRODUCTS: Record<string, { name: string; kg: number }> = {
  'TAN-500-24': { name: 'Tanuf 500ml x24', kg: 12 },
  'JAB-1500-6': { name: 'Jabal 1.5L x6', kg: 9.5 },
  'TAN-5G': { name: 'Tanuf 5 gallon', kg: 20 },
};

export interface FxOrder {
  id: string;
  customerId: string;
  code: string;
  branch: string | null;
  name: string;
  priority: number;
  late: boolean;
  lines: { sku: string; cases: number; so: string }[];
  lat: number;
  lng: number;
  address: string | null;
  access?: string;
  note?: string;
}

export const ORDERS: FxOrder[] = [
  { id: 'o1', customerId: 'c1', code: 'C001', branch: 'B1', name: 'Lulu Hypermarket Bausher', priority: 1, late: false,
    lines: [{ sku: 'TAN-500-24', cases: 50, so: 'SO-1001' }, { sku: 'JAB-1500-6', cases: 20, so: 'SO-1001' }],
    lat: 23.5859, lng: 58.3829, address: 'Bausher, Sultan Qaboos St, near Muscat Grand Mall', access: 'Receiving at the back gate; forklift until 14:00' },
  { id: 'o2', customerId: 'c2', code: 'C002', branch: null, name: 'Al Fair Qurum', priority: 2, late: false,
    lines: [{ sku: 'TAN-500-24', cases: 30, so: 'SO-1002' }, { sku: 'TAN-5G', cases: 10, so: 'SO-1002' }],
    lat: 23.6139, lng: 58.4739, address: 'Qurum, Al Qurum St', note: 'Call the store manager 30 min before' },
  { id: 'o3', customerId: 'c3', code: 'C003', branch: null, name: 'Seeb Trading', priority: 3, late: true,
    lines: [{ sku: 'JAB-1500-6', cases: 60, so: 'SO-1003' }],
    lat: 23.6703, lng: 58.1889, address: null },
  { id: 'o4', customerId: 'c4', code: 'C004', branch: null, name: 'Nesto Barka', priority: 2, late: false,
    lines: [{ sku: 'TAN-500-24', cases: 100, so: 'SO-1004' }, { sku: 'JAB-1500-6', cases: 25, so: 'SO-1004' }, { sku: 'TAN-5G', cases: 5, so: 'SO-1004' }],
    lat: 23.6786, lng: 57.8859, address: 'Barka, main road roundabout' },
  { id: 'o5', customerId: 'c5', code: 'C005', branch: null, name: 'Desert Camp Catering', priority: 4, late: true,
    lines: [{ sku: 'TAN-5G', cases: 15, so: 'SO-1005' }],
    lat: 23.55, lng: 58.1, address: null },
  { id: 'o6', customerId: 'c6', code: 'C001', branch: 'B2', name: 'Lulu Hypermarket Mabela', priority: 1, late: false,
    lines: [{ sku: 'TAN-500-24', cases: 40, so: 'SO-1006' }],
    lat: 23.6421, lng: 58.1117, address: 'Mabela, Al Mawaleh South' },
];

export const LONG_TRUCK = 'MCT/TRUCK-02-EXTRA-LONG-FLEET-CODE';
const byId = new Map(ORDERS.map((o) => [o.id, o]));
const casesOf = (o: FxOrder) => o.lines.reduce((a, l) => a + l.cases, 0);
const kgOf = (o: FxOrder) => o.lines.reduce((a, l) => a + l.cases * PRODUCTS[l.sku].kg, 0);
const skusOf = (o: FxOrder) =>
  aggregateSkus(o.lines.map((l) => ({ productCode: l.sku, productName: PRODUCTS[l.sku].name, cases: l.cases, weightKg: l.cases * PRODUCTS[l.sku].kg })));

export function stop(orderId: string, sequence: number, legKm: number, cumulativeKm: number, etaMin: number): DetailStop {
  const o = byId.get(orderId)!;
  return {
    sequence,
    customerId: o.customerId,
    customerCode: o.code,
    branchCode: o.branch,
    customerName: o.name,
    customerType: 'HYPERMARKET',
    lat: o.lat,
    lng: o.lng,
    priority: o.priority,
    etaMin,
    serviceStartMin: etaMin + 5,
    departureMin: etaMin + 25,
    waitMin: 5,
    window: 'hard 06:00–14:00, preferred 07:00–10:00',
    hardWindow: '06:00–14:00',
    serviceMin: 20,
    cases: casesOf(o),
    weightKg: kgOf(o),
    legKm,
    cumulativeKm,
    hardWindowOk: true,
    prefWindowOk: sequence === 1,
    late: o.late,
    orderIds: [o.id],
    salesOrders: [...new Set(o.lines.map((l) => l.so))],
    skus: skusOf(o),
    mapsUrl: `https://www.google.com/maps/search/?api=1&query=${o.lat},${o.lng}`,
    address: o.address,
    notes: o.note ? [o.note] : [],
    accessNotes: o.access ?? null,
    split: null,
    snapshot: true,
    masterChanged: [],
  };
}

/** Driver rate of the fixture (OMR per hour of the whole truck day). */
export const DRIVER_RATE = 2.5;

export function load(id: string, truckId: string, truckCode: string, loadNo: number, stops: DetailStop[], estimated: boolean): DetailLoad {
  const cases = stops.reduce((a, s) => a + s.cases, 0);
  const km = (stops.at(-1)?.cumulativeKm ?? 0) + 8.4;
  // The one cost model (review F17): load 1 is paid from its departure, later loads from the
  // previous return (load n-1 returns at 360 + (n-2) x 240 + 205), so the turnaround is paid.
  const depart = 360 + (loadNo - 1) * 240;
  const paidFrom = loadNo === 1 ? depart : 360 + (loadNo - 2) * 240 + 205;
  const paidMin = depart + 205 - paidFrom;
  const cost = {
    v: 2 as const,
    policy: 'TRUCK_DAY_SPAN' as const,
    fixed: loadNo === 1 ? 20 : 0,
    trip: 0,
    distance: Math.round(km * 0.15 * 1000) / 1000,
    fuel: Math.round((km / 4) * 0.25 * 1000) / 1000,
    driver: Math.round((paidMin / 60) * DRIVER_RATE * 1000) / 1000,
    overtime: 0,
    total: 0,
    driverPaidMin: paidMin,
    paidFromMin: paidFrom,
    overtimeMin: 0,
    estimatedLegs: estimated ? stops.length + 1 : 0,
  };
  cost.total = Math.round((cost.fixed + cost.trip + cost.distance + cost.fuel + cost.driver + cost.overtime) * 1000) / 1000;
  return {
    id,
    truckId,
    truckCode,
    truckCapacityCases: 600,
    truckPayloadKg: 12000,
    driverId: loadNo === 1 ? 'drv1' : null,
    driverName: loadNo === 1 ? 'Salim Al Harthy' : null,
    driverPhone: loadNo === 1 ? '+968 9123 4567' : null,
    loadNo,
    status: loadNo === 1 ? 'LOCKED' : 'PLANNED',
    carried: false,
    departMin: 360 + (loadNo - 1) * 240,
    returnMin: 360 + (loadNo - 1) * 240 + 205,
    distanceKm: km,
    durationMin: 205,
    cases,
    weightKg: stops.reduce((a, s) => a + s.weightKg, 0),
    utilizationPct: Math.round((1000 * cases) / 600) / 10,
    fuelLitres: km / 4,
    fuelCost: cost.fuel,
    operatingCost: cost.total,
    cost,
    returnLegKm: 8.4,
    distanceIsEstimated: estimated,
    stops,
    manifest: aggregateSkus(stops.flatMap((s) => s.skus)),
    truckSnapshot: true,
    masterChanged: [],
    timing: { status: 'VERIFIED', ok: true },
  };
}

export function fixture(opts: { estimated?: boolean; revenue?: boolean; noUnserved?: boolean } = {}): PlanDetail {
  const estimated = opts.estimated ?? false;
  const loads = [
    load('L1', 't1', 'T01', 1, [stop('o1', 1, 12.3, 12.3, 400), stop('o2', 2, 4.1, 16.4, 450)], estimated),
    load('L2', 't1', 'T01', 2, [stop('o3', 1, 20.5, 20.5, 640), stop('o6', 2, 7.2, 27.7, 700)], estimated),
    load('L3', 't2', LONG_TRUCK, 1, [stop('o4', 1, 35.0, 35.0, 420)], estimated),
  ];
  const unservedIds = opts.noUnserved ? [] : ['o5'];
  const scope = ORDERS.filter((o) => !opts.noUnserved || o.id !== 'o5');
  const planned = loads.flatMap((l) => l.stops.map((s) => ({ orderId: s.orderIds[0], customerId: s.customerId, truckId: l.truckId, loadNo: l.loadNo })));
  const reconOrders: ReconOrder[] = scope.map((o) => ({
    id: o.id,
    customerId: o.customerId,
    customerKey: `${o.code}::${o.branch ?? '__MAIN__'}`,
    lines: o.lines.map((l) => ({ productCode: l.sku, productName: PRODUCTS[l.sku].name, salesOrderNo: l.so, cases: l.cases })),
  }));
  const reconciliation = reconcile(reconOrders, planned, unservedIds.map((orderId) => ({ orderId, reasonCode: 'MISSING_COORDINATES' })));
  const summary = computeSummary({
    orders: scope.map((o) => ({
      id: o.id,
      customerId: o.customerId,
      priority: o.priority,
      cases: casesOf(o),
      weightKg: kgOf(o),
      salesValue: opts.revenue ? casesOf(o) * 1.2 : null,
      marginValue: opts.revenue ? casesOf(o) * 0.3 : null,
      isLate: o.late,
    })),
    plannedOrderIds: new Set(planned.map((p) => p.orderId)),
    unserved: unservedIds.map((orderId) => ({ orderId, reasonCode: 'MISSING_COORDINATES' })),
    loads: loads.map((l) => ({ ...l })),
    warnings: estimated ? ['OSRM unavailable - distances estimated (Haversine x 1.3).'] : [],
    distanceIsEstimated: estimated,
    distanceProvider: estimated ? 'HAVERSINE' : 'OSRM',
    solver: { engine: 'OR-Tools', scenario: 'RECOMMENDED', status: 'OPTIMIZED', timeSec: 12.4 },
  });
  const o5 = byId.get('o5')!;
  const unserved: DetailUnserved[] = unservedIds.map(() => ({
    orderId: o5.id,
    customerId: o5.customerId,
    customerCode: o5.code,
    branchCode: o5.branch,
    customerName: o5.name,
    cases: casesOf(o5),
    weightKg: kgOf(o5),
    priority: o5.priority,
    reasonCode: 'MISSING_COORDINATES',
    reasonMessage: 'Customer C005 has no delivery location - capture it on the Locations screen.',
    late: o5.late,
    salesOrders: ['SO-1005'],
    partial: false,
  }));
  return {
    run: {
      id: 'run1',
      version: 2,
      status: 'READY',
      reason: 'LATE_ORDER',
      reasonNote: 'Lulu Mabela late order',
      runDate: '2026-09-25',
      depot: { id: 'd1', code: 'MCT', name: 'Muscat Depot', lat: 23.58, lng: 58.4 },
      parentRunId: 'run0',
      createdAt: '2026-09-24T14:00:00.000Z',
      supersededAt: null,
      chosenScenario: 'RECOMMENDED',
    },
    summary,
    reconciliation,
    change: {
      parentVersion: 1, ordersAdded: 1, assignmentsChanged: 0, assignmentsUnchanged: 4, newlyPlanned: 0, newlyUnserved: 0,
      trucksUnchanged: 1, trucksChanged: 1, lockedLoadsPreserved: 1,
      text: '1 order added, 0 assignments changed, 1 truck unchanged, 1 locked/dispatched load preserved',
    },
    scenarios: [],
    loads,
    unserved,
    versions: [],
    job: null,
    warnings: [],
  };
}
