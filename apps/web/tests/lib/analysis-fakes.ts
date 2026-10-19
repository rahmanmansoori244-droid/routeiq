/**
 * Invented truck-days for the analysis dataset's specs (analysis-build, analysis-job, analysis-export): a
 * depot and shops in empty desert near 20.1, 55.1, trucks T-100 and T-200, customers TST0001..., a trail
 * written step by step (parked at 0 km/h or driving straight, a fix every 30 s), and a small in-memory
 * stand-in for the four fact tables (where: equality, null, not null, in, lt/lte/gte; a transaction runs in
 * place) whose trail read can fail a given number of times (a deadlock, a connection reset).
 */
import type { AnalysisSettings, EventIn, LoadIn, StopIn, TruckDayIn, VisitIn } from '@/lib/analysis/build';
import { distanceM } from '@/lib/dispatch/snapshots';
import { DETECTOR_FIXED, DETECTOR_VERSION, type TrailPoint } from '@/lib/ivms/types';

export type LatLng = { lat: number; lng: number };

/** Local HH:MM in Muscat (UTC+4) on `date` as an instant. */
export const atOn = (date: string, hhmm: string, sec = 0) => new Date(Date.parse(`${date}T${hhmm}:00+04:00`) + sec * 1000);
export const DEPOT: LatLng = { lat: 20.1, lng: 55.1 };
export const off = (p: LatLng, northM: number, eastM: number): LatLng => ({ lat: p.lat + northM / 111_320, lng: p.lng + eastM / (111_320 * Math.cos((p.lat * Math.PI) / 180)) });
export const A = off(DEPOT, 3000, 0);
export const B = off(A, 0, 3000);

export const SETTINGS: AnalysisSettings = {
  tz: 'Asia/Muscat',
  overtimeAfterMin: 540,
  serviceMinPerCase: 0.25,
  reloadMinutes: 30,
  loadingMinPerCase: 0.04,
  distanceMultiplier: 1.3,
  avgSpeedKmh: 40,
  roadTimeFactor: 1.25,
  params: { stopRadiusM: 100, dwellMin: 3, depotRadiusM: 300, ...DETECTOR_FIXED },
  detectorVersion: DETECTOR_VERSION,
};

/** A trail written step by step: parked (0 km/h) or driving straight to a point, a fix every 30 s. */
export class Trail {
  pts: TrailPoint[] = [];
  t: number;
  pos: LatLng;
  constructor(start: Date, pos: LatLng) {
    this.t = start.getTime();
    this.pos = pos;
  }
  get at(): Date {
    return new Date(this.t);
  }
  park(min: number): this {
    for (const end = this.t + min * 60_000; this.t < end; this.t += 30_000) this.pts.push({ fixAt: new Date(this.t), ...this.pos, speedKmh: 0, ignition: null });
    return this;
  }
  drive(to: LatLng, kmh = 30): this {
    const dur = (distanceM(this.pos, to) / (kmh / 3.6)) * 1000;
    const from = this.pos;
    for (let dt = 30_000; dt < dur; dt += 30_000) {
      const f = dt / dur;
      this.pts.push({ fixAt: new Date(this.t + dt), lat: from.lat + (to.lat - from.lat) * f, lng: from.lng + (to.lng - from.lng) * f, speedKmh: kmh, ignition: null });
    }
    this.t += Math.ceil(dur / 30_000) * 30_000;
    this.pos = to;
    return this;
  }
}

export const stop = (sequence: number, pin: LatLng, extra: Partial<StopIn> = {}): StopIn => ({
  sequence,
  customerId: `cust-${sequence}`,
  customerCode: `TST000${sequence}`,
  customerType: 'GROCERY',
  baseServiceMin: 10,
  etaMin: null,
  departureMin: null,
  plannedServiceMin: 20,
  windowStartMin: 360,
  windowEndMin: 1080,
  plannedKmFromPrev: 3.9,
  casesPlanned: 40,
  pin,
  ...extra,
});

export const load = (loadNo: number, stops: StopIn[], extra: Partial<LoadIn> = {}): LoadIn => ({
  depotId: 'dep-1',
  loadNo,
  status: 'COMPLETED',
  departMin: 420,
  returnMin: 540,
  distanceKm: 12,
  returnLegKm: 4.5,
  cases: stops.reduce((a, s) => a + s.casesPlanned, 0),
  dispatchedAt: null,
  origin: DEPOT,
  stops,
  ...extra,
});

export const visit = (loadNo: number, sequence: number, v: Partial<VisitIn>): VisitIn => ({
  id: `visit-${loadNo}-${sequence}`,
  depotId: 'dep-1',
  loadNo,
  sequence,
  arrivedAt: null,
  arrivalSource: null,
  arrivalDistanceM: null,
  arrivalAccuracyM: null,
  arrivalObserved: true,
  departedAt: null,
  departureSource: null,
  departedAtOutcome: false,
  outcome: null,
  reason: null,
  outcomeAt: null,
  outcomeSource: null,
  casesDelivered: null,
  plannedLat: null,
  plannedLng: null,
  ...v,
});

export const ev = (loadNo: number, sequence: number | null, kind: string, at: Date, extra: Partial<EventIn> = {}): EventIn => ({
  depotId: 'dep-1',
  loadNo,
  sequence,
  kind,
  source: 'PHONE_MANUAL',
  at,
  receivedAt: at,
  distanceM: null,
  payload: kind === 'OUTCOME' ? { outcome: 'DELIVERED' } : null,
  ...extra,
});

export const truckDayOf = (date: string, loads: LoadIn[], visits: VisitIn[], events: EventIn[], extra: Partial<TruckDayIn> = {}): TruckDayIn => ({
  date,
  truckId: 'truck-1',
  truckCode: 'T-100',
  tracked: true,
  suppressed: false,
  depots: [{ depotId: 'dep-1', ...DEPOT }],
  loads,
  visits,
  events,
  ...extra,
});

/**
 * Truck-day 1 on `date`: depot -> A (stands 25 m from the pin 30 min, then 18 min at a second drop point
 * 350 m away, where the driver saves the result) -> B (20 min) -> depot. The driver saves B's result 10 min
 * after leaving it.
 */
export function dayOne(date: string) {
  const L = (hhmm: string, sec = 0) => atOn(date, hhmm, sec);
  const tr = new Trail(L('06:40'), DEPOT).park(20).drive(off(A, 0, 25));
  const arriveA = tr.at;
  tr.park(30).drive(off(A, 0, 350), 12);
  const drop2 = tr.at;
  tr.park(18).drive(off(B, 20, 0));
  const arriveB = tr.at;
  tr.park(20);
  const leaveB = tr.at;
  tr.drive(DEPOT).park(40);
  const resultA = new Date(drop2.getTime() + 10 * 60_000);
  const resultB = new Date(leaveB.getTime() + 10 * 60_000);
  const visits = [
    visit(1, 1, { arrivedAt: new Date(arriveA.getTime() + 120_000), arrivalSource: 'PHONE_MANUAL', departedAt: resultA, departureSource: 'PHONE_MANUAL', departedAtOutcome: true, outcome: 'DELIVERED', outcomeAt: resultA, outcomeSource: 'PHONE_MANUAL', casesDelivered: 40 }),
    visit(1, 2, { arrivedAt: new Date(arriveB.getTime() + 60_000), arrivalSource: 'PHONE_MANUAL', departedAt: resultB, departureSource: 'PHONE_MANUAL', departedAtOutcome: true, outcome: 'DELIVERED', outcomeAt: resultB, outcomeSource: 'PHONE_MANUAL', casesDelivered: 40 }),
  ];
  const events = [
    ev(1, 1, 'ARRIVED', visits[0]!.arrivedAt!),
    ev(1, 1, 'OUTCOME', resultA),
    ev(1, 2, 'ARRIVED', visits[1]!.arrivedAt!),
    ev(1, 2, 'OUTCOME', resultB),
    ev(1, 2, 'PHOTO', new Date(resultB.getTime() - 60_000), { distanceM: 4200, payload: null }),
  ];
  const input = truckDayOf(date, [load(1, [stop(1, A, { etaMin: 430, departureMin: 460 }), stop(2, B, { etaMin: 470, departureMin: 490 })], { dispatchedAt: L('06:50') })], visits, events);
  return { tr, input, arriveA, drop2, arriveB, leaveB, resultA, resultB };
}

/** Customer 3's pin, 3 km west of the depot (a pin the truck never stands at: dayPinOff). */
export const C = off(DEPOT, 0, -3000);

/**
 * Truck-day of truck T-200 on `date`: depot -> customer TST0003, where the truck unloads 25 min 250 m south of
 * the pin (a pin offset, the office's data fix) and the driver saves the result there -> depot. With
 * `gateHaltMin`, it first halts that long 30 m from the pin (a study customer's pin to fix: a 2-min halt at the
 * gate, then the unloading 200 m away).
 */
export function dayPinOff(date: string, opts: { gateHaltMin?: number } = {}) {
  const L = (hhmm: string, sec = 0) => atOn(date, hhmm, sec);
  const tr = new Trail(L('06:40'), DEPOT).park(20);
  if (opts.gateHaltMin) tr.drive(off(C, 0, 30)).park(opts.gateHaltMin).drive(off(C, -250, 0), 12);
  else tr.drive(off(C, -250, 0));
  const arrive = tr.at;
  tr.park(25).drive(DEPOT).park(20);
  const result = new Date(arrive.getTime() + 20 * 60_000);
  const visits = [
    visit(1, 1, { arrivedAt: new Date(arrive.getTime() + 60_000), arrivalSource: 'PHONE_MANUAL', departedAt: result, departureSource: 'PHONE_MANUAL', departedAtOutcome: true, outcome: 'DELIVERED', outcomeAt: result, outcomeSource: 'PHONE_MANUAL', casesDelivered: 30 }),
  ];
  const events = [ev(1, 1, 'ARRIVED', visits[0]!.arrivedAt!), ev(1, 1, 'OUTCOME', result)];
  const input = truckDayOf(date, [load(1, [stop(1, C, { customerId: 'cust-3', customerCode: 'TST0003', casesPlanned: 30, etaMin: 430, departureMin: 450 })], { dispatchedAt: L('06:50') })], visits, events, {
    truckId: 'truck-2',
    truckCode: 'T-200',
  });
  return { tr, input, arrive, result };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** The stand-in: the four fact tables as arrays, and the models lib/analysis/job.ts calls. */
export interface FactDb {
  tables: Record<string, Row[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [model: string]: any;
}

/** Does a row match a Prisma-like where (equality, null, not null, in, lt/lte/gte on dates and numbers)? */
export function matches(row: Row, where: Row = {}): boolean {
  // Dates compare by their time, everything else as it is (the fake compares numbers, strings and dates only).
  const val = (x: unknown): any => (x instanceof Date ? x.getTime() : x);
  for (const [k, cond] of Object.entries(where)) {
    const v = row[k];
    if (cond === null) {
      if (v !== null && v !== undefined) return false;
    } else if (cond instanceof Date || typeof cond !== 'object') {
      if (val(v) !== val(cond)) return false;
    } else {
      const c = cond as Row;
      if ('not' in c && c.not === null && (v === null || v === undefined)) return false;
      if ('in' in c && !(c.in as unknown[]).map(val).includes(val(v))) return false;
      if ('lt' in c && !(val(v) < val(c.lt))) return false;
      if ('lte' in c && !(val(v) <= val(c.lte))) return false;
      if ('gte' in c && !(val(v) >= val(c.gte))) return false;
    }
  }
  return true;
}

/** An in-memory stand-in for the fact tables, the trail and the settings (what lib/analysis/job.ts touches). */
export function factDb(opts: { configs: Row[]; trail?: Row[]; moves?: Row[]; failTrailOf?: string; failTimes?: number }): FactDb {
  let failsLeft = opts.failTimes ?? Infinity;
  const tables: Record<string, Row[]> = { factTruckDay: [], factVisit: [], factLeg: [], factDepotTurn: [] };
  let id = 0;
  const model = (name: string) => ({
    findMany: async (a: Row = {}) => tables[name]!.filter((r) => matches(r, a.where)).map((r) => ({ ...r })),
    findFirst: async (a: Row = {}) => {
      const r = tables[name]!.find((x) => matches(x, a.where));
      return r ? { ...r } : null;
    },
    create: async (a: Row) => {
      const r = { id: `${name}-${++id}`, ...a.data };
      tables[name]!.push(r);
      return r;
    },
    createMany: async (a: Row) => {
      // Prisma.DbNull (an object, never an array) is stored as null, as the database does.
      const unNull = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? null : x);
      for (const d of a.data as Row[]) tables[name]!.push({ id: `${name}-${++id}`, ...d, ...('awayJson' in d ? { awayJson: unNull(d.awayJson), substaysJson: unNull(d.substaysJson) } : {}) });
      return { count: (a.data as Row[]).length };
    },
    deleteMany: async (a: Row = {}) => {
      const before = tables[name]!.length;
      tables[name] = tables[name]!.filter((r) => !matches(r, a.where));
      return { count: before - tables[name]!.length };
    },
    updateMany: async (a: Row) => {
      let n = 0;
      for (const r of tables[name]!) if (matches(r, a.where)) {
        Object.assign(r, a.data);
        n++;
      }
      return { count: n };
    },
  });
  const db: FactDb = {
    tables,
    factTruckDay: model('factTruckDay'),
    factVisit: model('factVisit'),
    factLeg: model('factLeg'),
    factDepotTurn: model('factDepotTurn'),
    tenantConfig: { findMany: async (a: Row = {}) => opts.configs.filter((c) => matches(c, a.where)) },
    truckTrailPoint: {
      findMany: async (a: Row) => {
        if (opts.failTrailOf && a.where.truckId === opts.failTrailOf && failsLeft-- > 0) throw Object.assign(new Error('connection lost'), { code: 'P1001' });
        return (opts.trail ?? []).filter((p) => matches(p, a.where)).sort((x, y) => x.fixAt.getTime() - y.fixAt.getTime());
      },
    },
    ivmsEvent: { findMany: async (a: Row) => (opts.moves ?? []).filter((m) => matches(m, { tenantId: a.where.tenantId, truckId: a.where.truckId })) },
  };
  db.$transaction = async (fn: (tx: Row) => Promise<unknown>) => fn(db);
  return db;
}
