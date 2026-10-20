/**
 * Builders for the salesman link's day (lib/sales-link/day.ts) in unit tests. Invented data only: customers
 * TST0001.., shops "Example Mart", routes R1 / R2X / R10, trucks T05 / T06, depot pins in empty desert
 * (tests/lib/ivms-trail.ts style), "Example Water Co". Times are minutes of the delivery day (Asia/Muscat).
 */
import type { DetailLoad, DetailStop, DetailUnserved, PlanDetail } from '@/lib/dispatch/plan-detail';
import type { SalesmanEtaFacts } from '@/lib/exports/salesman-eta';
import type { SalesDayInput, SalesExtraOrderIn, SalesGpsIn, SalesPlanIn, SalesVisitIn } from '@/lib/sales-link/day';
import { gpsReadConfigOf } from '@/lib/alerts/gps';

export const TZ = 'Asia/Muscat';
export const DAY = '2026-10-19';
export const hm = (h: number, m = 0) => h * 60 + m;
/** An instant at local HH:MM on `date` (Muscat is UTC+4, no DST). */
export const at = (hhmm: string, date = DAY) => new Date(`${date}T${hhmm}:00+04:00`);
/** An instant `min` minutes after the local midnight of `date` (may pass 1440). */
export const atMin = (min: number, date = DAY) => new Date(new Date(`${date}T00:00:00+04:00`).getTime() + min * 60_000);

/** A desert origin; east of it in metres. */
export const ORIGIN = { lat: 20.1, lng: 55.1 };
export const east = (m: number) => ({ lat: ORIGIN.lat, lng: ORIGIN.lng + m / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180)) });

export interface Ln {
  orderId: string;
  lineId: string;
  so: string | null;
  cases: number;
  route: string | null;
}
export const ln = (orderId: string, lineId: string, so: string | null, cases: number, route: string | null): Ln => ({ orderId, lineId, so, cases, route });

export function stop(o: {
  seq: number;
  customerId: string;
  code: string;
  name?: string;
  eta: number | null;
  lines: Ln[];
  hours?: [number | null, number | null] | null;
  promised?: [number | null, number | null] | null;
  pin?: { lat: number; lng: number } | null;
  cancelled?: string[];
  service?: number;
}): DetailStop {
  const hours = o.hours === undefined ? [hm(6), hm(18)] : o.hours;
  const pin = o.pin === undefined ? east(1000 * o.seq) : o.pin;
  const service = o.service ?? 15;
  return {
    sequence: o.seq,
    customerId: o.customerId,
    customerCode: o.code,
    branchCode: null,
    customerName: o.name ?? `Example Mart ${o.code}`,
    customerType: null,
    lat: pin ? pin.lat : null,
    lng: pin ? pin.lng : null,
    priority: 3,
    etaMin: o.eta,
    serviceStartMin: o.eta,
    departureMin: o.eta === null ? null : o.eta + service,
    waitMin: 0,
    window: 'any',
    hardWindow: null,
    promised: null,
    serviceMin: service,
    cases: o.lines.reduce((t, l) => t + l.cases, 0),
    weightKg: 0,
    legKm: 1,
    cumulativeKm: 1,
    hardWindowOk: true,
    prefWindowOk: true,
    late: false,
    orderIds: [...new Set(o.lines.map((l) => l.orderId))],
    salesOrders: [...new Set(o.lines.map((l) => l.so).filter((x): x is string => !!x))],
    skus: [],
    mapsUrl: null,
    address: 'ADDRESS-SENTINEL',
    notes: ['ORDER-NOTE-SENTINEL'],
    accessNotes: 'ACCESS-NOTE-SENTINEL',
    customerPhone: 'CUSTOMER-PHONE-SENTINEL',
    split: null,
    snapshot: true,
    masterChanged: [],
    carriedFrom: null,
    carriedTo: null,
    cancelled: !!o.cancelled?.length,
    cancelledOrderIds: o.cancelled ?? [],
    orderLines: o.lines.map((l) => ({ orderId: l.orderId, lineId: l.lineId, salesOrderNo: l.so, productCode: 'PRD-A', productName: 'Product A', cases: l.cases })),
    plannedHours: hours ? { hardStart: hours[0], hardEnd: hours[1], prefStart: null, prefEnd: null } : null,
    promisedWindow: o.promised ? { startMin: o.promised[0], endMin: o.promised[1] } : null,
  };
}

export function load(o: { id: string; truckId?: string; truckCode?: string; loadNo?: number; status: string; departMin?: number; returnMin?: number; stops: DetailStop[] }): DetailLoad {
  return {
    id: o.id,
    truckId: o.truckId ?? 't5',
    truckCode: o.truckCode ?? 'T05',
    truckCapacityCases: 500,
    truckPayloadKg: 0,
    driverId: 'drv',
    driverName: 'DRIVER-NAME-SENTINEL',
    driverPhone: 'DRIVER-PHONE-SENTINEL',
    driverHandSet: false,
    helpers: [{ id: 'h1', code: 'H1', name: 'HELPER-NAME-SENTINEL', phone: 'HELPER-PHONE-SENTINEL', active: true }],
    loadNo: o.loadNo ?? 1,
    status: o.status,
    carried: false,
    departMin: o.departMin ?? hm(7),
    returnMin: o.returnMin ?? hm(13),
    distanceKm: 30,
    durationMin: 360,
    cases: o.stops.reduce((t, s) => t + s.cases, 0),
    weightKg: 0,
    utilizationPct: 50,
    fuelLitres: null,
    fuelCost: 0,
    operatingCost: 123.45,
    cost: null,
    returnLegKm: 1,
    distanceIsEstimated: false,
    stops: o.stops,
    manifest: [],
    truckSnapshot: true,
    origin: east(0),
    masterChanged: [],
    timing: null,
    carriedAway: 0,
    cancelledHere: 0,
    break: null,
  };
}

export const unserved = (orderId: string, customerId: string, code: string, cases: number, over: Partial<DetailUnserved> = {}): DetailUnserved => ({
  orderId,
  customerId,
  customerCode: code,
  branchCode: null,
  customerName: `Example Mart ${code}`,
  cases,
  weightKg: 0,
  priority: 3,
  reasonCode: 'NO_AVAILABLE_TRUCK',
  reasonMessage: 'REASON-MESSAGE-SENTINEL',
  late: false,
  salesOrders: [],
  partial: false,
  carriedFrom: null,
  carriedTo: null,
  cancelled: false,
  ...over,
});

export function planDetail(o: { depotId?: string; date?: string; loads: DetailLoad[]; unserved?: DetailUnserved[]; pendingOrders?: number; runId?: string }): PlanDetail {
  const depotId = o.depotId ?? 'D1';
  return {
    run: {
      id: o.runId ?? `run-${depotId}`,
      version: 1,
      status: 'READY',
      reason: 'INITIAL',
      reasonNote: null,
      runDate: o.date ?? DAY,
      depot: { id: depotId, code: depotId, name: `Example depot ${depotId}`, ...east(0) },
      parentRunId: null,
      createdAt: '2026-10-18T15:00:00.000Z',
      supersededAt: null,
      chosenScenario: 'RECOMMENDED',
    },
    summary: null,
    reconciliation: null,
    change: null,
    scenarios: [],
    loads: o.loads,
    unserved: o.unserved ?? [],
    isDispatchPlan: true,
    versions: [],
    job: null,
    warnings: [],
    pendingOrders: o.pendingOrders ?? 0,
    timezone: TZ,
  };
}

/** The facts of every line given (whole-line cases = the cases given unless `whole` says otherwise). */
export function factsOf(lines: readonly Ln[], o: { whole?: Record<string, number>; orders?: [string, { cancelled: boolean; carriedTo: string | null }][]; pending?: SalesmanEtaFacts['pending'] } = {}): SalesmanEtaFacts {
  const m = new Map<string, { orderId: string; salesRoute: string | null; casesPerPallet: number | null; cases: number; salesOrderNo: string | null }>();
  for (const l of lines) {
    const cur = m.get(l.lineId);
    m.set(l.lineId, { orderId: l.orderId, salesRoute: l.route, casesPerPallet: 50, cases: o.whole?.[l.lineId] ?? (cur ? cur.cases + l.cases : l.cases), salesOrderNo: l.so });
  }
  return { lines: m, orders: new Map(o.orders ?? []), pending: o.pending ?? [] };
}

export function visit(o: {
  seq: number;
  loadNo?: number;
  truckId?: string;
  depotId?: string;
  date?: string;
  arrivedAt?: Date | null;
  departedAt?: Date | null;
  outcome?: 'DELIVERED' | 'PARTLY_DELIVERED' | 'NOT_DELIVERED' | null;
  reason?: string | null;
  outcomeAt?: Date | null;
  outcomeSource?: string | null;
  arrivalSource?: string | null;
  lines?: { orderId: string; lineId: string; plannedCases: number; deliveredCases: number | null }[];
  photos?: SalesVisitIn['photos'];
}): SalesVisitIn {
  return {
    depotId: o.depotId ?? 'D1',
    date: o.date ?? DAY,
    truckId: o.truckId ?? 't5',
    loadNo: o.loadNo ?? 1,
    sequence: o.seq,
    arrivedAt: o.arrivedAt ?? null,
    arrivalSource: o.arrivedAt ? (o.arrivalSource ?? 'PHONE_AUTO') : null,
    departedAt: o.departedAt ?? null,
    departureSource: o.departedAt ? 'PHONE_AUTO' : null,
    outcome: o.outcome ?? null,
    reason: o.reason ?? null,
    outcomeAt: o.outcomeAt ?? null,
    outcomeSource: o.outcome ? (o.outcomeSource ?? 'PHONE_MANUAL') : null,
    casesPlanned: (o.lines ?? []).reduce((t, l) => t + l.plannedCases, 0),
    casesDelivered: null,
    linesJson: (o.lines ?? []).map((l) => ({ ...l, productCode: 'PRD-A' })),
    plannedServiceMin: null,
    windowStartMin: null,
    photos: o.photos ?? [],
  };
}

export const extraOrder = (o: Partial<SalesExtraOrderIn> & { id: string; lines: SalesExtraOrderIn['lines'] }): SalesExtraOrderIn => ({
  depotId: 'D1',
  customerCode: `TST-${o.id}`,
  branchCode: null,
  customerName: `Example Mart ${o.id}`,
  cancelled: false,
  cancelReason: null,
  carriedFromDate: null,
  carriedTo: null,
  ...o,
});

/** GPS input with one truck's fix (fresh by default) and its history pulled to `trailTo`. */
export function gpsIn(o: { truckId?: string; fixAt: Date; pos: { lat: number; lng: number }; trailTo?: Date | null; speedKmh?: number; depotId?: string }): SalesGpsIn {
  const truckId = o.truckId ?? 't5';
  return {
    settings: { ...gpsReadConfigOf({ ivmsStopRadiusM: 100, ivmsDepotRadiusM: 300, avgSpeedKmh: 40, distanceMultiplier: 1.3 }), depots: new Map([[o.depotId ?? 'D1', east(0)]]) },
    positions: new Map([[truckId, { fixAt: o.fixAt, lat: o.pos.lat, lng: o.pos.lng, speedKmh: o.speedKmh ?? 40, flags: [], movedAt: null }]]),
    trailTo: new Map([[truckId, o.trailTo === undefined ? o.fixAt : o.trailTo]]),
    moves: new Map(),
  };
}

export function dayInput(o: Partial<SalesDayInput> & { plans: SalesPlanIn[]; now: Date }): SalesDayInput {
  return {
    date: DAY,
    tz: TZ,
    extraOrders: [],
    visits: [],
    loadTimes: new Map(),
    backAt: new Map(),
    phoneSeen: new Map(),
    gps: null,
    siteRadius: new Map(),
    ...o,
  };
}
