/**
 * The IVMS live link end to end over one invented delivery day (tests/fixtures/ivms/day-script.json):
 * the poller's 15 s ticks from 04:59 to 23:00 against a fake Ayun that answers from the recorded day,
 * Ayun's depot webhooks, the drivers' and the office's own entries, the history pulls, the processing
 * step (trips by depot OUT/IN, GPS stop times), the day screen's live trucks and the rebuilt visits, in
 * OFF, MAP and TIMES at today's allowance of 100 calls a day (and TIMES at 3,000 a day for comparison).
 *
 * Everything below the poller and the webhook is the real code: the ingest store's Prisma queries, the
 * detector, the writer, the visit rebuild, the vehicles endpoint. The database is the in-memory
 * fake-plan-db; the call counters and the lease are the in-memory store of ivms-fakes.ts (their SQL is
 * covered by tests/integration/ivms-ingest-db.spec.ts). Invented data only (see the fixture's notes).
 *
 * Set IVMS_SIM_REPORT=<file> to write what the screens and the visits show to that file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakePrisma, resetDb, tables } from './fake-plan-db';
import { Trail, at as atMetres, T } from './ivms-trail';
import { MemoryIvmsStore, providerTime, SECRET, KEY } from './ivms-fakes';
import type { NewZoneEvent } from '@/lib/ivms/events';
import type { FleetTruck, IvmsCompany, TruckDayRow } from '@/lib/ivms/store';
import type { LiveFix, TrailPoint } from '@/lib/ivms/types';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));

const { runIvmsTick, _resetIvmsProcessState } = await import('@/lib/ivms/poll');
const { prismaIvmsStore } = await import('@/lib/ivms/store');
const { handleAyunWebhook, _resetWebhookCache } = await import('@/lib/ivms/webhook');
const { readLiveVehicles } = await import('@/lib/ivms/vehicles');
const { processGpsTimesForCompany } = await import('@/lib/ivms/stop-events');
const { readIvmsEnv } = await import('@/lib/ivms/env');
const { ivmsModeOf } = await import('@/lib/ivms/settings');
const { classShares } = await import('@/lib/ivms/budget');
const { vehiclePopupText, liveMapCaption, gpsFactText } = await import('@/lib/ivms/live-map');
const { ensureVisit, rebuildVisit } = await import('@/lib/delivery/event-service');
const { plannedStopOf } = await import('@/lib/delivery/planned-stop');
const { arrivalByText, timedByText, actualMinutes } = await import('@/lib/delivery/office-text');
const { kpiVisitOf } = await import('@/lib/delivery/day-results');
const { deliveryKpis } = await import('@/lib/delivery/kpis');
const { distanceM } = await import('@/lib/dispatch/snapshots');
const { dateOnly, zonedDayStart } = await import('@/lib/dispatch/time');

// ---------------------------------------------------------------------------------------------------
// The recorded day

type Metres = [number, number];
interface TrackStep {
  park?: number;
  stepSec?: number;
  ignition?: boolean;
  to?: string;
  kmh?: number;
  toward?: string;
  share?: number;
  silent?: number;
  jump?: string;
  toMetres?: Metres;
}
interface ScriptTruck {
  code: string;
  imei: string | null;
  loads: { loadNo: number; departAt: string; stops: string[] }[];
  track?: TrackStep[];
  late?: { from: string; to: string; receivedAt: string }[];
}
interface WorldStep {
  at: string;
  truck?: string;
  load?: number;
  status?: string;
  stop?: number;
  by?: 'driver' | 'office';
  arrived?: boolean;
  result?: string;
  reason?: string;
  back?: boolean;
  webhook?: string;
  type?: 'zone_in' | 'zone_out';
  receivedAt?: string;
  /** A webhook's position: the truck's own (default) or the depot's (a forger who knows where the depot is). */
  position?: 'depot';
}
interface Script {
  date: string;
  depotZone: string;
  shops: Record<string, { at: Metres; name: string; window?: [string, string] }>;
  trucks: ScriptTruck[];
  world: WorldStep[];
  screens: string[];
}

const SCRIPT = JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'ivms', 'day-script.json'), 'utf8')) as Script;
const TEN = 'tA';
const TZ = 'Asia/Muscat';
const DATE = SCRIPT.date;
const DAY_START = zonedDayStart(DATE, TZ);
const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
/** Local HH:MM of an instant (Muscat, UTC+4), or '-'. */
const local = (d: Date | string | null | undefined) => (d ? new Date(new Date(d).getTime() + 4 * 3600_000).toISOString().slice(11, 16) : '-');
const localS = (d: Date | string | null | undefined) => (d ? new Date(new Date(d).getTime() + 4 * 3600_000).toISOString().slice(11, 19) : '-');
const truckId = (code: string) => code.toLowerCase();
const loadId = (code: string, loadNo: number) => `L-${code}-${loadNo}`;
const shopAt = (name: string): Metres => (name === 'depot' ? [0, 0] : SCRIPT.shops[name]!.at);
/** An IMEI that is not ours (built at run time: no IMEI-like digit run in the spec). */
const FOREIGN_IMEI = '3'.repeat(15);

/** A device point as the provider holds it: the fix and when the provider received it. */
interface DevicePoint extends TrailPoint {
  serverAt: Date;
}

/** The device points of a truck's recorded track (every 30 s moving, as recorded parked), with the buffered ranges. */
function devicePoints(t: ScriptTruck): DevicePoint[] {
  const tr = new Trail('05:00', 0, 0, 30);
  for (const s of t.track ?? []) {
    if (s.park !== undefined) tr.park(s.park, { stepSec: s.stepSec, ignition: s.ignition ?? true });
    else if (s.to) tr.drive(...shopAt(s.to), s.kmh ?? 40);
    else if (s.toMetres) tr.drive(...s.toMetres, s.kmh ?? 40);
    else if (s.toward) {
      const [e, n] = shopAt(s.toward);
      const f = s.share ?? 0.5;
      tr.drive(tr.pos.east + (e - tr.pos.east) * f, tr.pos.north + (n - tr.pos.north) * f, s.kmh ?? 40);
    } else if (s.silent !== undefined) {
      tr.silent(s.silent);
      if (s.jump) tr.jump(...shopAt(s.jump));
    }
  }
  return tr.pts.map((p) => {
    const late = (t.late ?? []).find((l) => p.fixAt.getTime() >= T(l.from).getTime() && p.fixAt.getTime() <= T(l.to).getTime());
    return { ...p, serverAt: late ? T(late.receivedAt) : new Date(p.fixAt.getTime() + 5_000) };
  });
}

const DEVICES = new Map<string, DevicePoint[]>();
for (const t of SCRIPT.trucks) if (t.imei && t.track) DEVICES.set(t.imei, devicePoints(t));
const IMEI_OF = new Map(SCRIPT.trucks.map((t) => [t.code, t.imei]));

/** Where the truck really was at `at` (the last device point at or before it). */
function truthAt(code: string, at: Date): { lat: number; lng: number } {
  const pts = DEVICES.get(IMEI_OF.get(code) ?? '') ?? [];
  let best = pts[0];
  for (const p of pts) if (p.fixAt.getTime() <= at.getTime()) best = p;
  return best ? { lat: best.lat, lng: best.lng } : atMetres(0);
}

/** "20261020010000" (UTC) -> the instant. */
function compact(s: string): Date {
  return new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)));
}

/**
 * The fake Ayun: answers from the recorded day in the provider's shapes (every value a string, the object
 * name and the other fields RouteIQ must never keep included), only with what it had received by `now`.
 */
function fakeAyun(clock: () => Date) {
  const calls: { cmd: string; at: Date }[] = [];
  const f = async (input: RequestInfo | URL): Promise<Response> => {
    const u = new URL(String(input));
    const [cmd, ...args] = (u.searchParams.get('cmd') ?? '').split(',');
    const now = clock();
    calls.push({ cmd: cmd!, at: now });
    const known = (imei: string) => (DEVICES.get(imei) ?? []).filter((p) => p.serverAt.getTime() <= now.getTime());
    if (cmd === 'OBJECT_GET_LOCATIONS') {
      const body: Record<string, unknown> = {};
      for (const imei of args[0] === '*' ? [...DEVICES.keys()] : (args[0] ?? '').split(';')) {
        const pts = known(imei);
        const p = pts[pts.length - 1];
        if (!p) continue;
        body[imei] = {
          name: 'Example object with a driver name',
          dt_server: providerTime(p.serverAt),
          dt_tracker: providerTime(p.fixAt),
          lat: p.lat.toFixed(6),
          lng: p.lng.toFixed(6),
          altitude: '10',
          angle: '90',
          speed: String(Math.round(p.speedKmh ?? 0)),
          params: { acc: p.ignition === false ? '0' : '1' },
          loc_valid: '1',
        };
      }
      return new Response(JSON.stringify(Object.keys(body).length ? body : []), { status: 200 });
    }
    if (cmd === 'OBJECT_GET_ROUTE') {
      const from = compact(args[1]!).getTime();
      const to = compact(args[2]!).getTime();
      const route = known(args[0]!)
        .filter((p) => p.fixAt.getTime() >= from && p.fixAt.getTime() <= to)
        .map((p) => [providerTime(p.fixAt), p.lat.toFixed(6), p.lng.toFixed(6), '10', '0', String(Math.round(p.speedKmh ?? 0)), { acc: p.ignition === false ? '0' : '1' }]);
      return new Response(JSON.stringify(route.length ? { route, stops: [], drives: [], events: [], route_length: '0' } : []), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  };
  return { fetch: f as unknown as typeof fetch, calls };
}

// ---------------------------------------------------------------------------------------------------
// The database: the company, the plan, and an ingest store over the same tables

const snapshot = (shop: string) => {
  const s = SCRIPT.shops[shop]!;
  const pin = atMetres(...s.at);
  return {
    v: 1,
    customerId: `C-${shop}`,
    code: `C-${shop}`,
    branchCode: null,
    name: s.name,
    customerType: null,
    lat: pin.lat,
    lng: pin.lng,
    address: null,
    accessNotes: null,
    serviceMin: 15,
    priority: 3,
    hardStartMin: s.window ? hm(s.window[0]) : 0,
    hardEndMin: s.window ? hm(s.window[1]) : 1439,
    prefStartMin: null,
    prefEndMin: null,
    source: 'PLAN',
    capturedAt: T('04:00').toISOString(),
  };
};

function seed(mode: 'OFF' | 'MAP' | 'TIMES', budget: number) {
  resetDb();
  tables.tenant = [{ id: TEN, slug: 'example-co', name: 'Synthetic Water Co', active: true }];
  tables.tenantConfig = [
    {
      id: 'cfg',
      tenantId: TEN,
      timezone: TZ,
      geofenceRadiusM: 100,
      photoProofRequired: true,
      avgSpeedKmh: 40,
      distanceMultiplier: 1.3,
      ivmsMode: mode,
      ivmsPollSec: 60,
      ivmsRoutePullMin: 60,
      ivmsFromMin: 300,
      ivmsToMin: 1380,
      ivmsDailyCallBudget: budget,
      ivmsStopRadiusM: 100,
      ivmsStopDwellMin: 3,
      ivmsDepotRadiusM: 300,
      ivmsTrailDays: 2,
    },
  ];
  tables.depot = [{ id: 'D1', tenantId: TEN, code: 'D1', name: 'Example depot', ...atMetres(0), ivmsZoneName: SCRIPT.depotZone }];
  tables.truck = SCRIPT.trucks.map((t) => ({ id: truckId(t.code), tenantId: TEN, depotId: 'D1', code: t.code, hired: false, active: true, onlyOnDate: null, ivmsImei: t.imei }));
  tables.driver = [];
  tables.runPlan = [{ id: 'R1', tenantId: TEN, depotId: 'D1', runDate: dateOnly(DATE), status: 'DISPATCHED', version: 1, supersededAt: null, chosenScenarioId: 'sc', createdAt: T('04:00') }];
  tables.planLoad = [];
  tables.order = [];
  tables.routeAssignment = [];
  for (const t of SCRIPT.trucks) {
    for (const l of t.loads) {
      const departMin = hm(l.departAt);
      tables.planLoad.push({ id: loadId(t.code, l.loadNo), tenantId: TEN, runId: 'R1', truckId: truckId(t.code), loadNo: l.loadNo, status: 'PLANNED', departMin, returnMin: departMin + 90, driverId: null, statusChangedAt: T('04:00'), breakJson: null, truckSnapshotJson: null, carriedFromLoadId: null });
      l.stops.forEach((shop, i) => {
        const seq = i + 1;
        const orderId = `O-${t.code}-${l.loadNo}-${seq}`;
        tables.order!.push({ id: orderId, tenantId: TEN, customerId: `C-${shop}`, carriedToOrderId: null, lines: [{ id: `LN-${orderId}`, cases: 20, weightKg: 200, product: { code: 'WATER-A' } }] });
        const eta = departMin + 12 * seq;
        tables.routeAssignment!.push({ id: `RA-${orderId}`, runId: 'R1', loadId: loadId(t.code, l.loadNo), truckId: truckId(t.code), orderId, loadNo: l.loadNo, sequenceInTruck: seq, orderInStop: 0, etaMin: eta, serviceStartMin: eta, departureMin: eta + 15, portionLinesJson: null, stopSnapshotJson: snapshot(shop) });
      });
    }
  }
  for (const k of ['auditLog', 'stopVisit', 'stopEvent', 'deliveryPhoto', 'ivmsEvent', 'ivmsTruckDay', 'truckTrailPoint', 'truckPosition', 'ivmsState']) tables[k] = [];
}

/** The ingest store over the fake tables: the real Prisma reads of lib/ivms/store.ts where the fake can run them. */
class SimStore extends MemoryIvmsStore {
  constructor() {
    super(null);
  }
  override async company(slug: string): Promise<IvmsCompany | null> {
    const t = (tables.tenant ?? []).find((x) => x.slug === slug);
    const c = t && (tables.tenantConfig ?? []).find((x) => x.tenantId === t.id);
    if (!t || !c) return null;
    return { tenantId: t.id, slug, timezone: c.timezone, mode: ivmsModeOf(c), pollSec: c.ivmsPollSec, routePullMin: c.ivmsRoutePullMin, fromMin: c.ivmsFromMin, toMin: c.ivmsToMin, dailyBudget: c.ivmsDailyCallBudget, trailDays: c.ivmsTrailDays };
  }
  override async fleet(c: IvmsCompany, now: Date): Promise<FleetTruck[]> {
    return prismaIvmsStore.fleet(c, now);
  }
  override async depotZones() {
    return prismaIvmsStore.depotZones(TEN);
  }
  override async truckByImei(tenantId: string, imei: string) {
    return prismaIvmsStore.truckByImei(tenantId, imei);
  }
  override async clearPositions(tenantId: string, keep: readonly string[]) {
    return prismaIvmsStore.clearPositions(tenantId, keep);
  }
  override async truckDays(tenantId: string, keys: readonly { truckId: string; date: string }[]): Promise<TruckDayRow[]> {
    return prismaIvmsStore.truckDays(tenantId, keys);
  }
  /** As the SQL upsert: only a newer fix moves a truck's latest position. */
  override async writePositions(tenantId: string, rows: readonly { truckId: string; fix: LiveFix }[], now: Date) {
    let n = 0;
    for (const { truckId: id, fix } of rows) {
      const old = tables.truckPosition!.find((p) => p.truckId === id);
      if (old && old.fixAt.getTime() >= fix.fixAt.getTime()) continue;
      const movedAt = fix.speedKmh !== null && fix.speedKmh >= 5 ? fix.fixAt : (old?.movedAt ?? null);
      const row = { tenantId, truckId: id, fixAt: fix.fixAt, serverAt: fix.serverAt, receivedAt: now, lat: fix.lat, lng: fix.lng, speedKmh: fix.speedKmh, heading: fix.heading, ignition: fix.ignition, flags: [...fix.flags], movedAt };
      if (old) Object.assign(old, row);
      else tables.truckPosition!.push({ id: `pos-${id}`, ...row });
      n++;
    }
    return n;
  }
  /** As createMany skipDuplicates on (tenantId, truckId, fixAt). */
  override async writeTrail(tenantId: string, id: string, points: readonly TrailPoint[]) {
    const have = new Set(tables.truckTrailPoint!.filter((p) => p.truckId === id).map((p) => p.fixAt.getTime()));
    let n = 0;
    for (const p of points) {
      if (have.has(p.fixAt.getTime())) continue;
      tables.truckTrailPoint!.push({ id: `tp-${id}-${p.fixAt.getTime()}`, tenantId, truckId: id, fixAt: p.fixAt, lat: p.lat, lng: p.lng, speedKmh: p.speedKmh, ignition: p.ignition, flags: [] });
      have.add(p.fixAt.getTime());
      n++;
    }
    return n;
  }
  /** As the upsert on (tenantId, truckId, deliveryDate): the processing columns are left alone. */
  override async markPulled(tenantId: string, id: string, date: string, p: { pulledTo: Date; final: boolean; now: Date }) {
    const row = tables.ivmsTruckDay!.find((r) => r.truckId === id && r.deliveryDate.getTime() === dateOnly(date).getTime());
    const data = { pulledTo: p.pulledTo, lastPullAt: p.now, finalPullAt: p.final ? p.now : null };
    if (row) Object.assign(row, data, { pulls: (row.pulls ?? 0) + 1 });
    else tables.ivmsTruckDay!.push({ id: `td-${id}-${date}`, tenantId, truckId: id, deliveryDate: dateOnly(date), pulls: 1, processedAt: null, suppressedAt: null, suppressReason: null, gpsFactsJson: null, ...data });
  }
  /** As the inserts: one row per dedupe key, at most 200 per truck per UTC day. */
  override async insertZoneEvents(tenantId: string, rows: readonly NewZoneEvent[], now: Date) {
    const out = { inserted: 0, duplicates: 0, capped: 0 };
    for (const r of rows) {
      if (tables.ivmsEvent!.some((e) => e.dedupeKey === r.dedupeKey)) {
        out.duplicates++;
        continue;
      }
      tables.ivmsEvent!.push({ id: `ev-${tables.ivmsEvent!.length + 1}`, tenantId, ...r, receivedAt: now });
      out.inserted++;
    }
    return out;
  }
  override async processTimes(tenantId: string, now: Date) {
    this.processed.push(now);
    return processGpsTimesForCompany(tenantId, now);
  }
}

// ---------------------------------------------------------------------------------------------------
// The world: load statuses, the drivers' and the office's entries, Ayun's webhooks

const loadRow = (code: string, loadNo: number) => tables.planLoad!.find((l) => l.id === loadId(code, loadNo))!;

async function stopEntry(w: WorldStep, at: Date) {
  const code = w.truck!;
  const load = loadRow(code, w.load!);
  const driver = w.by === 'driver';
  // The driver's phone: where the truck is, about 15 m off (a phone fix is never exactly the shop's pin).
  const truck = truthAt(code, at);
  const pos = driver ? { lat: truck.lat + 15 / 111_320, lng: truck.lng } : null;
  await fakePrisma.$transaction(async (tx: typeof fakePrisma) => {
    const planned = await plannedStopOf(tx as never, { id: load.id, breakJson: null }, w.stop!);
    const visit = await ensureVisit(tx as never, { tenantId: TEN, depotId: 'D1', date: DATE, truckId: truckId(code), loadNo: w.load!, sequence: w.stop! }, planned!, load.id);
    const kind = w.arrived ? 'ARRIVED' : 'OUTCOME';
    const payload = w.arrived ? { mode: 'MANUAL' } : { outcome: w.result, ...(w.reason ? { reason: w.reason } : {}), lines: [], photoKeys: driver && w.result !== 'NOT_DELIVERED' ? [`photo-${code}-${w.load}-${w.stop}`] : [] };
    await tx.stopEvent.create({
      data: {
        tenantId: TEN,
        depotId: 'D1',
        deliveryDate: dateOnly(DATE),
        truckId: truckId(code),
        loadNo: w.load,
        sequence: w.stop,
        visitId: visit.id,
        kind,
        source: driver ? 'PHONE_MANUAL' : 'DISPATCHER',
        at,
        receivedAt: at,
        lat: pos?.lat ?? null,
        lng: pos?.lng ?? null,
        accuracyM: pos ? 12 : null,
        distanceM: pos && planned?.pin ? Math.round(distanceM(pos, planned.pin)) : null,
        userId: driver ? null : 'office-user',
        idempotencyKey: `sim:${code}:${w.load}:${w.stop}:${kind}:${at.getTime()}`,
        payloadJson: payload,
      },
    });
    await rebuildVisit(tx as never, visit, { dayStart: DAY_START, radiusM: 100, breakMin: null });
  });
}

async function applyWorld(w: WorldStep, at: Date, store: SimStore, env: ReturnType<typeof readIvmsEnv>) {
  if (w.webhook) {
    const imei = w.webhook === 'other' ? FOREIGN_IMEI : IMEI_OF.get(w.webhook)!;
    const pos = w.webhook === 'other' || w.position === 'depot' ? atMetres(20, 20) : truthAt(w.webhook, T(w.at));
    const desc = w.type === 'zone_in' ? 'Depot IN' : 'Depot OUT';
    // The recorded webhook shape (webhook-depot-in.txt): the fields RouteIQ never reads are sent too.
    const qs = new URLSearchParams({
      username: 'example_user',
      name: 'Example object with a driver name',
      imei,
      type: w.type!,
      desc: `${desc} (${SCRIPT.depotZone})`,
      zone_name: SCRIPT.depotZone,
      lat: pos.lat.toFixed(6),
      lng: pos.lng.toFixed(6),
      speed: '8',
      dt_server: providerTime(new Date(T(w.at).getTime() + 20_000)),
      dt_tracker: providerTime(T(w.at)),
      plate_number: 'EXAMPLE PLATE',
      driver_name: 'Example driver',
      sim_number: 'example',
    });
    const res = await handleAyunWebhook(new Request(`https://routeiq.test/api/ivms/ayun/${SECRET}?${qs}`, { method: 'POST' }), SECRET, { env, store, now: at });
    expect(res.status).toBe(200);
    return;
  }
  const code = w.truck!;
  if (w.status) {
    const l = loadRow(code, w.load!);
    l.status = w.status;
    l.statusChangedAt = at;
    if (w.status === 'DISPATCHED') tables.auditLog!.push({ id: `au-${l.id}`, tenantId: TEN, action: 'LOAD_DISPATCHED', entity: 'PlanLoad', entityId: l.id, createdAt: at });
    return;
  }
  if (w.back) {
    // What the driver's (or the office's) Back at depot does once every stop has a result: the load completes.
    const l = loadRow(code, w.load!);
    const pos = w.by === 'driver' ? truthAt(code, at) : null;
    tables.stopEvent!.push({ id: `back-${l.id}`, tenantId: TEN, depotId: 'D1', deliveryDate: dateOnly(DATE), truckId: truckId(code), loadNo: w.load, sequence: null, visitId: null, kind: 'BACK_AT_DEPOT', source: w.by === 'driver' ? 'PHONE_MANUAL' : 'DISPATCHER', at, receivedAt: at, lat: pos?.lat ?? null, lng: pos?.lng ?? null, idempotencyKey: `sim:back:${l.id}`, payloadJson: {} });
    l.status = 'COMPLETED';
    l.statusChangedAt = at;
    return;
  }
  await stopEntry(w, at);
}

// ---------------------------------------------------------------------------------------------------
// One day

interface Screen {
  at: string;
  caption: string | null;
  intervalSec: number | null;
  vehicles: { code: string; load: number | null; stale: boolean; ageMin: number; text: string; offTruthM: number }[];
}

interface DayResult {
  mode: string;
  budget: number;
  calls: { cmd: string; at: Date }[];
  shares: Record<string, number>;
  screens: Screen[];
  visits: Record<string, unknown>[];
  ayunEvents: Record<string, unknown>[];
  ivmsEvents: Record<string, unknown>[];
  truckDays: Record<string, unknown>[];
  trail: number;
  processed: number;
  loads: { id: string; status: string; at: string }[];
  ticks: { called: number; nothingOut: number; times: number };
}

async function runDay(mode: 'OFF' | 'MAP' | 'TIMES', budget: number): Promise<DayResult> {
  seed(mode, budget);
  _resetIvmsProcessState();
  _resetWebhookCache();
  const env = readIvmsEnv();
  const store = new SimStore();
  let now = T('04:59');
  const ayun = fakeAyun(() => now);
  const timeOf = (w: WorldStep) => T(w.receivedAt ?? w.at).getTime();
  const world = [...SCRIPT.world].sort((a, b) => timeOf(a) - timeOf(b));
  const screens: Screen[] = [];
  const screenAt = SCRIPT.screens.map((s) => T(s).getTime());
  const ticks = { called: 0, nothingOut: 0, times: 0 };
  let wi = 0;
  for (const end = T('23:00').getTime(); now.getTime() <= end; now = new Date(now.getTime() + 15_000)) {
    while (wi < world.length && timeOf(world[wi]!) <= now.getTime()) {
      const w = world[wi++]!;
      // A webhook is handled when Ayun sends it; an entry happens at its own time.
      await applyWorld(w, new Date(timeOf(w)), store, env);
    }
    const before = ayun.calls.length;
    const r = await runIvmsTick(now, {}, { store, env, fetchImpl: ayun.fetch, owner: 'sim', random: () => 0.5 });
    if (ayun.calls.length > before) ticks.called++;
    if (r?.skipped === 'NOTHING_OUT') ticks.nothingOut++;
    if (r?.times) ticks.times++;
    // The counters as the vehicles endpoint reads them (IvmsState).
    if (store.state) tables.ivmsState = [{ tenantId: TEN, usageDay: dateOnly(store.state.usageDay), mapCalls: store.state.mapCalls, lastOkAt: store.state.lastOkAt }];
    store.touched.length = 0;
    if (screenAt.includes(now.getTime())) screens.push(await screen(now));
  }
  // Never a provider object name, driver name, plate or user name in what was stored.
  const stored = JSON.stringify([tables.ivmsEvent, tables.truckPosition, tables.truckTrailPoint, tables.ivmsTruckDay, tables.stopEvent]);
  expect(stored).not.toMatch(/Example object|Example driver|EXAMPLE PLATE|example_user/);
  return {
    mode,
    budget,
    calls: ayun.calls,
    shares: classShares(budget, mode === 'OFF' ? 'MAP' : mode, budget >= 1000),
    screens,
    visits: visitsTable(),
    ayunEvents: tables.stopEvent!.filter((e) => e.source === 'AYUN').map((e) => ({ truck: e.truckId, load: e.loadNo, stop: e.sequence, kind: e.kind, at: localS(e.at), observed: e.payloadJson?.observed, corrected: !!e.payloadJson?.correctedAt })),
    ivmsEvents: tables.ivmsEvent!.map((e) => ({ truck: e.truckId, kind: e.kind, origin: e.origin, at: localS(e.eventAt), outcome: e.outcome })),
    truckDays: tables.ivmsTruckDay!.map((d) => ({ truck: d.truckId, pulls: d.pulls, lastPull: local(d.lastPullAt), finalPull: local(d.finalPullAt), processed: local(d.processedAt), suppressed: d.suppressReason ?? null, facts: (Array.isArray(d.gpsFactsJson) ? d.gpsFactsJson : []).map((f: unknown) => gpsFactText(f, TZ)) })),
    trail: tables.truckTrailPoint!.length,
    processed: store.processed.length,
    loads: tables.planLoad!.map((l) => ({ id: l.id, status: l.status, at: local(l.statusChangedAt) })),
    ticks,
  };
}

async function screen(now: Date): Promise<Screen> {
  const data = await readLiveVehicles(TEN, 'R1', now);
  const caption = data ? liveMapCaption(data, now, TZ) : null;
  return {
    at: local(now),
    caption: caption?.text ?? null,
    intervalSec: data?.intervalSec ?? null,
    vehicles: (data?.vehicles ?? []).map((v) => ({
      code: v.truckCode,
      load: v.loadNo,
      stale: v.stale,
      ageMin: Math.round(v.ageSec / 60),
      text: vehiclePopupText(v, TZ),
      offTruthM: Math.round(distanceM({ lat: v.lat, lng: v.lng }, truthAt(v.truckCode, now))),
    })),
  };
}

/** Every planned stop, as the office sees it after the day (the visit, its words, its unloading). */
function visitsTable(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const t of SCRIPT.trucks) {
    for (const l of t.loads) {
      l.stops.forEach((shop, i) => {
        const v = tables.stopVisit!.find((x) => x.truckId === truckId(t.code) && x.loadNo === l.loadNo && x.sequence === i + 1);
        const dep = v?.departedAt ? tables.stopEvent!.find((e) => e.visitId === v.id && e.kind === 'DEPARTED' && e.source === v.departureSource && e.at.getTime() === v.departedAt.getTime()) : null;
        const act = v ? actualMinutes(v as never) : null;
        out.push({
          stop: `${t.code} L${l.loadNo} #${i + 1} ${shop}`,
          arrived: v ? localS(v.arrivedAt) : '-',
          arrivalBy: v?.arrivedAt ? arrivalByText(v.arrivalSource, v.arrivalObserved) : '',
          left: v ? (v.departedAtOutcome ? `${localS(v.departedAt)} (result)` : localS(v.departedAt)) : '-',
          leftBy: v?.departedAt && !v.departedAtOutcome ? `${v.departureSource}${dep?.payloadJson?.gap ? ' (not observed)' : ''}` : '',
          result: v?.outcome ? `${v.outcome} by ${v.outcomeSource} ${local(v.outcomeAt)}` : 'no result',
          timedBy: v ? timedByText(v as never) : '',
          unloadingMin: act?.min ?? null,
          measured: v ? v.autoServiceMinutes !== null : false,
        });
      });
    }
  }
  return out;
}

function kpisOf(): ReturnType<typeof deliveryKpis> {
  const stops = SCRIPT.trucks.flatMap((t) =>
    t.loads.flatMap((l) =>
      l.stops.map((_, i) => {
        const v = tables.stopVisit!.find((x) => x.truckId === truckId(t.code) && x.loadNo === l.loadNo && x.sequence === i + 1);
        return v ? kpiVisitOf(v as never, TZ) : null;
      }),
    ),
  );
  return deliveryKpis(stops);
}

// ---------------------------------------------------------------------------------------------------

const ENV_KEYS = ['AYUN_BASE_URL', 'AYUN_API_KEY', 'AYUN_TENANT_SLUG', 'AYUN_WEBHOOK_SECRET', 'ROUTEIQ_DISABLE_IVMS', 'AYUN_API_TIME_OFFSET_MIN'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const days: Record<string, DayResult & { kpis: ReturnType<typeof deliveryKpis> }> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.AYUN_BASE_URL = 'https://provider.example';
  process.env.AYUN_API_KEY = KEY;
  process.env.AYUN_TENANT_SLUG = 'example-co';
  process.env.AYUN_WEBHOOK_SECRET = SECRET;
  delete process.env.ROUTEIQ_DISABLE_IVMS;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  for (const [name, mode, budget, offset] of [
    ['OFF', 'OFF', 100, null],
    ['MAP', 'MAP', 100, null],
    ['TIMES', 'TIMES', 100, null],
    ['TIMES3000', 'TIMES', 3000, null],
    // First review H-1: Ayun sends UTC but AYUN_API_TIME_OFFSET_MIN was set to -240 by mistake.
    ['TIMES_BAD_OFFSET', 'TIMES', 3000, '-240'],
  ] as const) {
    if (offset) process.env.AYUN_API_TIME_OFFSET_MIN = offset;
    const r = await runDay(mode, budget);
    delete process.env.AYUN_API_TIME_OFFSET_MIN;
    days[name] = { ...r, kpis: kpisOf() };
  }
}, 300_000);

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  const file = process.env.IVMS_SIM_REPORT;
  if (file) writeFileSync(file, report(), 'utf8');
});

const visitOf = (day: string, stop: string) => days[day]!.visits.find((v) => String(v.stop).startsWith(stop))!;
const byCmd = (day: string) => days[day]!.calls.reduce<Record<string, number>>((m, c) => ({ ...m, [c.cmd]: (m[c.cmd] ?? 0) + 1 }), {});

describe('a whole invented day: OFF changes nothing', () => {
  it('OFF: no call to Ayun, no GPS row, no live truck; the webhook stores nothing', () => {
    const d = days.OFF!;
    expect(d.calls).toEqual([]);
    expect([d.trail, d.ayunEvents.length, d.ivmsEvents.length, d.truckDays.length, d.processed]).toEqual([0, 0, 0, 0, 0]);
    expect(d.screens.every((s) => s.vehicles.length === 0 && s.caption === null)).toBe(true);
  });

  it('MAP: positions for the map only; the visits are exactly the OFF visits (no trail, no depot move, no GPS time)', () => {
    const d = days.MAP!;
    expect(Object.keys(byCmd('MAP'))).toEqual(['OBJECT_GET_LOCATIONS']);
    expect(d.calls.length).toBeLessThanOrEqual(d.shares.MAP!);
    expect([d.trail, d.ayunEvents.length, d.ivmsEvents.length, d.truckDays.length, d.processed]).toEqual([0, 0, 0, 0, 0]);
    expect(JSON.stringify(d.visits)).toBe(JSON.stringify(days.OFF!.visits));
    expect(JSON.stringify(d.kpis)).toBe(JSON.stringify(days.OFF!.kpis));
  });
});

describe('a whole invented day at 100 calls a day: the allowance', () => {
  it('stays inside the allowance and each class inside its share; nothing before the first load is out or after the last final pull', () => {
    const d = days.TIMES!;
    const n = byCmd('TIMES');
    expect(d.calls.length).toBeLessThanOrEqual(100);
    expect(n.OBJECT_GET_LOCATIONS ?? 0).toBeLessThanOrEqual(d.shares.MAP!);
    expect(n.OBJECT_GET_ROUTE ?? 0).toBeLessThanOrEqual(d.shares.ROUTE!);
    expect(n.OBJECT_GET_LAST_EVENTS ?? 0).toBe(0); // no backstop below 1,000 a day
    expect(d.calls[0]!.at.getTime()).toBeGreaterThanOrEqual(T('05:30').getTime());
    expect(d.calls[d.calls.length - 1]!.at.getTime()).toBeLessThan(T('10:30').getTime());
  });

  it('every truck-day with a tracker gets its final pull; the truck without one is never asked about', () => {
    const d = days.TIMES!;
    expect(d.truckDays.map((x) => x.truck).sort()).toEqual(['t05', 't06']);
    expect(d.truckDays.every((x) => x.finalPull !== '-')).toBe(true);
    expect(d.ayunEvents.some((e) => e.truck === 't07')).toBe(false);
  });
});

describe('a whole invented day in TIMES: what the visits show', () => {
  it('GPS fills the gaps only: a stop nobody timed gets the GPS arrival and departure', () => {
    expect(visitOf('TIMES', 'T05 L1 #1 A')).toMatchObject({ arrivalBy: 'GPS (Ayun)', leftBy: 'AYUN', result: 'DELIVERED by PHONE_MANUAL 07:15' });
    expect(visitOf('OFF', 'T05 L1 #1 A')).toMatchObject({ arrived: '-', result: 'DELIVERED by PHONE_MANUAL 07:15' });
  });

  it("the driver's tap stays the arrival; GPS only adds the departure the phone did not have", () => {
    expect(visitOf('TIMES', 'T05 L1 #2 B')).toMatchObject({ arrived: '07:27:00', arrivalBy: 'Manual', leftBy: 'AYUN' });
    expect(visitOf('TIMES', 'T06 L1 #1 F')).toMatchObject({ arrived: '07:24:00', arrivalBy: 'Manual', leftBy: 'AYUN' });
  });

  it('a coverage gap before the stop: the GPS arrival is marked not observed and never measured or counted on time', () => {
    const c = visitOf('TIMES', 'T05 L2 #1 C');
    expect(c).toMatchObject({ arrivalBy: 'GPS (Ayun), not observed', measured: false });
  });

  it('points the provider received late are picked up by the final pull and correct the unobserved arrival', () => {
    const g = visitOf('TIMES', 'T06 L1 #2 G');
    expect(g).toMatchObject({ arrivalBy: 'GPS (Ayun)', result: 'DELIVERED by DISPATCHER 09:00' });
    expect(days.TIMES!.ayunEvents.filter((e) => e.truck === 't06' && e.stop === 2 && e.kind === 'ARRIVED')).toEqual([expect.objectContaining({ observed: true, corrected: true })]);
  });

  it('two shops in one mall, the kiosk next to the depot and the same customer on the other load get nothing from GPS (H3/H4)', () => {
    for (const stop of ['T05 L2 #2 D1', 'T05 L2 #3 D2', 'T05 L2 #4 E', 'T05 L2 #5 A']) expect(visitOf('TIMES', stop)).toEqual(visitOf('OFF', stop));
    const facts = days.TIMES!.truckDays.find((x) => x.truck === 't05')!.facts as string[];
    expect(facts.some((f) => /stops 2 and 3 close together/.test(f))).toBe(true);
  });

  it('GPS never writes a result, a Back at depot or a load status; the driver and the office entries are unchanged', () => {
    const d = days.TIMES!;
    expect(d.ayunEvents.every((e) => e.kind === 'ARRIVED' || e.kind === 'DEPARTED')).toBe(true);
    expect(d.loads).toEqual(days.OFF!.loads);
    for (const [i, v] of d.visits.entries()) {
      const off = days.OFF!.visits[i]!;
      expect(v.result).toBe(off.result);
      if (off.arrived !== '-') expect([v.arrived, v.arrivalBy]).toEqual([off.arrived, off.arrivalBy]);
    }
  });

  it('GPS-timed visits never feed the measured unloading times; a GPS arrival counts on time only where goods were handed over', () => {
    expect(days.TIMES!.kpis.unloadSample).toBe(days.OFF!.kpis.unloadSample);
    // Shop A and shop G are timed by GPS alone: an unloading time is shown (arrival to departure, not "auto"),
    // never fed to "Use measured time" (second review H-2: the automatic timing is the phone's only).
    for (const stop of ['T05 L1 #1 A', 'T06 L1 #2 G']) expect(visitOf('TIMES', stop)).toMatchObject({ timedBy: 'GPS (Ayun)', measured: false });
    // A (observed, delivered) and G (observed, delivered by the office, after its 07:30 window) join the on-time KPI; C (not observed) never.
    expect(days.TIMES!.kpis.timedArrivals).toBe(days.OFF!.kpis.timedArrivals + 2);
    expect(days.TIMES!.kpis.insideWindow).toBe(days.OFF!.kpis.insideWindow + 1);
  });

  it("Ayun's depot webhooks: confirmed by the trail they are trip boundaries; a forged one never; a repeat and a foreign tracker store nothing", () => {
    const ev = days.TIMES!.ivmsEvents.filter((e) => e.origin === 'WEBHOOK');
    expect(ev.map((e) => `${e.kind} ${e.outcome}`)).toEqual(['DEPOT_OUT USED', 'DEPOT_IN UNCONFIRMED', 'DEPOT_IN USED']);
  });

  it('at 3,000 calls a day the GPS times are the same; the map is fresh except while a tracker itself is silent', () => {
    expect(days.TIMES3000!.visits).toEqual(days.TIMES!.visits);
    const stale = days.TIMES3000!.screens.flatMap((s) => s.vehicles.filter((v) => v.stale).map((v) => `${s.at} ${v.code}`));
    // T06's points of 07:40-07:52 reach Ayun only later (buffered): at 07:46 its newest known fix is older than 5 min.
    expect(stale).toEqual(['07:46 T06']);
    expect(days.TIMES!.screens.flatMap((s) => s.vehicles).some((v) => v.stale)).toBe(true);
  });
});

describe('a whole invented day with a wrong time offset (first review H-1)', () => {
  it('-240 set on UTC times: no history pull, no trail, no GPS time; the visits and KPIs are exactly the OFF ones', () => {
    const d = days.TIMES_BAD_OFFSET!;
    expect(d.calls.some((c) => c.cmd === 'OBJECT_GET_ROUTE')).toBe(false);
    expect([d.trail, d.ayunEvents.length]).toEqual([0, 0]);
    expect(JSON.stringify(d.visits)).toBe(JSON.stringify(days.OFF!.visits));
    expect(JSON.stringify(d.kpis)).toBe(JSON.stringify(days.OFF!.kpis));
  });
});

describe('a whole invented day: what the day screen shows', () => {
  it('only trucks with a tracker and a load out; never off duty; the positions are cleared once nothing is out', () => {
    for (const day of ['MAP', 'TIMES', 'TIMES3000']) {
      const s = days[day]!.screens;
      expect(s.find((x) => x.at === '06:00')!.vehicles.map((v) => v.code)).toEqual(['T05', 'T06']);
      expect(s.find((x) => x.at === '10:30')!.vehicles).toEqual([]);
      expect(s.flatMap((x) => x.vehicles).some((v) => v.code === 'T07')).toBe(false);
    }
  });

  it('at 100 a day the caption says how often positions come; a fix older than 5 min is grey with no speed and no ETA', () => {
    const s = days.TIMES!.screens.find((x) => x.at === '07:22')!;
    expect(s.intervalSec).toBeGreaterThan(600);
    expect(s.caption).toMatch(/Positions about every \d+ min/);
    for (const v of s.vehicles) if (v.stale) expect(v.text).toMatch(/no GPS position for/);
  });
});

// ---------------------------------------------------------------------------------------------------
// The report (IVMS_SIM_REPORT)

function report(): string {
  const lines: string[] = [];
  const table = (rows: Record<string, unknown>[]) => {
    if (!rows.length) return ['(none)'];
    const keys = Object.keys(rows[0]!);
    const w = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length)));
    const fmt = (vals: string[]) => vals.map((v, i) => v.padEnd(w[i]!)).join(' | ');
    return [fmt(keys), w.map((n) => '-'.repeat(n)).join('-|-'), ...rows.map((r) => fmt(keys.map((k) => String(r[k] ?? ''))))];
  };
  for (const [name, d] of Object.entries(days)) {
    lines.push('', `=== ${name}: ivmsMode ${d.mode}, ${d.budget} calls a day ===`);
    const n = byCmd(name);
    const perHour = d.calls.reduce<Record<string, number>>((m, c) => ({ ...m, [local(c.at).slice(0, 2)]: (m[local(c.at).slice(0, 2)] ?? 0) + 1 }), {});
    lines.push(`Ayun calls: ${d.calls.length} (${Object.entries(n).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}); shares ${JSON.stringify(d.shares)}`);
    lines.push(`Calls per local hour: ${Object.entries(perHour).map(([h, v]) => `${h}h ${v}`).join(', ') || '-'}`);
    lines.push(`Ticks that called: ${d.ticks.called}; processing runs: ${d.processed} (${d.ticks.times} did something); trail points stored: ${d.trail}`);
    lines.push('Loads: ' + d.loads.map((l) => `${l.id} ${l.status} ${l.at}`).join('; '));
    lines.push('', 'Day screen, live trucks:');
    for (const s of d.screens) {
      lines.push(`  ${s.at}  ${s.caption ?? '(no live-truck layer: GPS tracking OFF)'}${s.intervalSec ? ` [interval ${s.intervalSec}s]` : ''}`);
      for (const v of s.vehicles) lines.push(`         ${v.text}  [shown ${v.offTruthM} m from where the truck really is]`);
    }
    lines.push('', 'Visits (the office view):', ...table(d.visits));
    lines.push('', 'GPS stop events (AYUN):', ...table(d.ayunEvents));
    lines.push('', 'Depot moves (IvmsEvent):', ...table(d.ivmsEvents));
    lines.push('', 'Truck-days (IvmsTruckDay):', ...table(d.truckDays.map((x) => ({ ...x, facts: (x.facts as string[]).join(' / ') }))));
    const k = d.kpis;
    lines.push('', `KPIs: stops ${k.stops}, with result ${k.withResult}, timed arrivals ${k.timedArrivals}, inside window ${k.insideWindow}, measured unloading sample ${k.unloadSample}`);
  }
  return lines.join('\n') + '\n';
}
