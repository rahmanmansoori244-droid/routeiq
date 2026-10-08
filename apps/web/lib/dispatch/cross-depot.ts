/**
 * One truck or one driver on the plans of two depots on the same day (review finding web-plan-service-1,
 * 9 Oct 2026).
 *
 * Plans are per depot and day; trucks and drivers are the company's. A truck lent to another depot for
 * the day (its depot changed under Trucks) keeps the loads the first depot's plan gave it, and one
 * driver can be on loads of two depots. Each depot's plan used to see only its own loads, so both
 * depots could send the same truck or driver out at the same time, each with a VERIFIED timetable.
 *
 * - Planning (buildDispatchRequest): a truck is planned only in time it has free of its loads on the
 *   other depots' live plans that day - any status: a PLANNED load there is that depot's plan for the
 *   truck - counting the drive between the two depots and the loading before the next load. Its own
 *   hours (available_from_min / available_to_min, which the optimizer, its check and the timetable gate
 *   all honour) become the longest such free time; with none, an empty window: it takes no new load
 *   here. A plan warning names those loads. Only the hours change: the loads keep this depot's own load
 *   numbers, as the driver page expects (both depots' plans may give the truck a Load 1).
 * - Drivers (planDrivers in load-state.ts): RouteIQ never gives a driver who is on a load of another
 *   depot's live plan at an overlapping time, the drive between the depots included (driverTripsElsewhere).
 * - LOCK, LOADING and DISPATCH (changeStatusTx): refused with 409 TRUCK_BUSY_ELSEWHERE /
 *   DRIVER_BUSY_ELSEWHERE when the load's truck or driver is on a LOCKED, LOADING, DISPATCHED or
 *   COMPLETED load of another depot's live plan that day and both cannot be driven - their times
 *   overlap once the drive between the depots is added (otherDepotClash). A PLANNED load there does not
 *   refuse: the depot that locks first keeps the truck or driver and the other is refused when it locks,
 *   so two plans never refuse each other for good. Two such moves at the same moment are taken one after
 *   the other (lockTruckDriverDay in plan-locks.ts).
 * The drive between two depots is a straight-line estimate: the company's distance multiplier and
 * average speed for estimates, as the optimizer times a leg it cannot route; the same pin is no drive.
 * Every read carries the company (tenantId) and only reads live versions (not SUPERSEDED or ARCHIVED,
 * supersededAt unset), as driversOnOtherDepots does.
 */
import type { Prisma } from '@prisma/client';
import type { OtherDepotTrip } from './load-state';
import { distanceM } from './snapshots';
import { fmtHhmm } from './time';

type Db = Pick<Prisma.TransactionClient, 'runPlan' | 'planLoad' | 'depot' | 'truck' | 'tenantConfig'>;

const DAY_MIN = 1440;

/** A load of another depot's live plan of the day, with its depot. */
export interface OtherDepotLoad {
  id: string;
  depotId: string;
  depotName: string;
  truckId: string;
  truckCode: string;
  loadNo: number;
  status: string;
  driverId: string | null;
  departMin: number;
  returnMin: number;
  cases: number;
  /** Minutes to drive between that depot and this one (driveBetweenMin). */
  driveMin: number;
}

/** The settings the drive and the turnaround are worked out with (TenantConfig). */
export interface CrossDepotSettings {
  distanceMultiplier: number;
  avgSpeedKmh: number;
  reloadMinutes: number;
  loadingMinPerCase: number;
}

/** Minutes to drive between two depots: the straight line x the distance multiplier, at the average speed for estimates, rounded up. */
export function driveBetweenMin(a: { lat: number; lng: number }, b: { lat: number; lng: number }, cfg: Pick<CrossDepotSettings, 'distanceMultiplier' | 'avgSpeedKmh'>): number {
  const km = (distanceM(a, b) / 1000) * (cfg.distanceMultiplier > 0 ? cfg.distanceMultiplier : 1);
  return km > 0 ? Math.ceil((km / (cfg.avgSpeedKmh > 0 ? cfg.avgSpeedKmh : 40)) * 60) : 0;
}

/** Reload + loading per case of `cases`: the turnaround before a load leaves its depot. */
function turnaroundMin(cfg: Pick<CrossDepotSettings, 'reloadMinutes' | 'loadingMinPerCase'>, cases: number): number {
  return Math.max(0, cfg.reloadMinutes) + Math.ceil(Math.max(0, cfg.loadingMinPerCase) * Math.max(0, cases));
}

/**
 * The loads of the OTHER depots' live plan versions of the run's day that are on one of `truckIds` or
 * have one of `driverIds` ('ANY': any driver). `frozenOnly`: LOCKED, LOADING, DISPATCHED and COMPLETED
 * only. Each with its depot's name and the drive from it to the run's depot.
 */
export async function loadsOnOtherDepots(
  db: Db,
  tenantId: string,
  run: { depotId: string; runDate: Date },
  who: { truckIds?: readonly string[]; driverIds?: readonly string[] | 'ANY' },
  opts: { frozenOnly?: boolean } = {},
): Promise<OtherDepotLoad[]> {
  const or: Prisma.PlanLoadWhereInput[] = [];
  if (who.truckIds?.length) or.push({ truckId: { in: [...who.truckIds] } });
  if (who.driverIds === 'ANY') or.push({ driverId: { not: null } });
  else if (who.driverIds?.length) or.push({ driverId: { in: [...who.driverIds] } });
  if (!or.length) return [];
  const runs = await db.runPlan.findMany({
    where: { tenantId, runDate: run.runDate, depotId: { not: run.depotId }, status: { notIn: ['SUPERSEDED', 'ARCHIVED'] }, supersededAt: null },
    select: { id: true, depotId: true },
  });
  if (!runs.length) return [];
  const loads = await db.planLoad.findMany({
    where: { tenantId, runId: { in: runs.map((r) => r.id) }, OR: or, ...(opts.frozenOnly ? { status: { not: 'PLANNED' } } : {}) },
    select: { id: true, runId: true, truckId: true, loadNo: true, status: true, driverId: true, departMin: true, returnMin: true, cases: true },
    orderBy: [{ departMin: 'asc' }, { id: 'asc' }],
  });
  if (!loads.length) return [];
  const depotOfRun = new Map(runs.map((r) => [r.id, r.depotId]));
  const depots = new Map(
    (await db.depot.findMany({ where: { tenantId, id: { in: [...new Set([run.depotId, ...runs.map((r) => r.depotId)])] } }, select: { id: true, name: true, lat: true, lng: true } })).map((d) => [d.id, d]),
  );
  const codes = new Map((await db.truck.findMany({ where: { tenantId, id: { in: [...new Set(loads.map((l) => l.truckId))] } }, select: { id: true, code: true } })).map((t) => [t.id, t.code]));
  const cfg = await db.tenantConfig.findUnique({ where: { tenantId }, select: { distanceMultiplier: true, avgSpeedKmh: true } });
  const here = depots.get(run.depotId);
  return loads.map((l) => {
    const depotId = depotOfRun.get(l.runId)!;
    const there = depots.get(depotId);
    return {
      id: l.id,
      depotId,
      depotName: there?.name ?? 'another depot',
      truckId: l.truckId,
      truckCode: codes.get(l.truckId) ?? l.truckId,
      loadNo: l.loadNo,
      status: l.status,
      driverId: l.driverId,
      departMin: l.departMin,
      returnMin: l.returnMin,
      cases: l.cases,
      driveMin: here && there && cfg ? driveBetweenMin(here, there, cfg) : 0,
    };
  });
}

/**
 * The longest stretch of [from, to] that no busy time overlaps (a load may be back exactly when a busy
 * time starts, and leave exactly when one ends), measured between `usableFrom` and `usableTo` (time
 * outside is no use: before the day's first departure or the truck's own frozen loads here are back,
 * after the depot closes or the latest return); the earliest on a tie. Null: none.
 */
export function freeWindow(
  busy: readonly { from: number; to: number }[],
  from: number,
  to: number,
  usableFrom = from,
  usableTo = to,
): { from: number; to: number } | null {
  // The free stretches between the busy times (sorted, merged where they overlap), then the longest.
  const gaps: { from: number; to: number }[] = [];
  let cursor = from;
  for (const b of [...busy].sort((x, y) => x.from - y.from)) {
    if (b.to <= cursor) continue;
    if (b.from > cursor) gaps.push({ from: cursor, to: Math.min(b.from, to) });
    cursor = Math.max(cursor, b.to);
    if (cursor >= to) break;
  }
  if (cursor < to) gaps.push({ from: cursor, to });
  let best: { from: number; to: number } | null = null;
  let bestLen = 0;
  for (const g of gaps) {
    const len = Math.min(g.to, usableTo) - Math.max(g.from, usableFrom);
    if (len > bestLen) {
      best = g;
      bestLen = len;
    }
  }
  return best;
}

/** A truck's hours for NEW loads at this depot around its loads at other depots (truckHoursAround). */
export interface TruckHoursAround {
  availableFromMin: number | null;
  availableToMin: number | null;
  /** No free time left: an empty window (the optimizer then gives the truck no new load). */
  none: boolean;
  /** The plan warning that says why. */
  note: string;
}

/**
 * The hours a truck can take new loads at this depot, around its loads at other depots (`away`, any
 * status). A load there keeps the truck from when it must leave here - back here, the drive over, and
 * that load's own reload and loading there - until it can leave here again: back there, the drive back
 * and the reload and loading of a full truck here (its case capacity; the optimizer's own turnaround
 * then counts from the truck's hours, not from a return). The truck's own hours stay the outer bounds;
 * the longest free stretch inside `usable` is kept: from the day's first departure or the return of the
 * truck's own frozen loads here (the optimizer plans new loads after them anyway), to the depot's
 * closing or the latest return. Null: those loads leave the truck's own hours as they are.
 */
export function truckHoursAround(
  t: { code: string; availableFromMin: number | null; availableToMin: number | null; capacityCases: number },
  away: readonly OtherDepotLoad[],
  cfg: Pick<CrossDepotSettings, 'reloadMinutes' | 'loadingMinPerCase'>,
  usable: { from: number; to: number },
): TruckHoursAround | null {
  if (!away.length) return null;
  const lo = t.availableFromMin ?? 0;
  const hi = t.availableToMin ?? DAY_MIN * 2;
  const busy = away.map((f) => ({
    from: f.departMin - f.driveMin - turnaroundMin(cfg, f.cases),
    to: f.returnMin + f.driveMin + turnaroundMin(cfg, t.capacityCases),
  }));
  const w = freeWindow(busy, lo, hi, usable.from, usable.to);
  const loads = describeLoads(away);
  // available_from_min is at most the end of the day (the optimizer's bound): later is no time left.
  if (!w || w.from > DAY_MIN) {
    return { availableFromMin: DAY_MIN, availableToMin: DAY_MIN, none: true, note: `Truck ${t.code} is on another depot's plan this day (${loads}): it takes no new load here.` };
  }
  const from = w.from > lo ? w.from : t.availableFromMin;
  const to = w.to < hi ? w.to : t.availableToMin;
  if (from === t.availableFromMin && to === t.availableToMin) return null;
  const hours =
    from !== t.availableFromMin && to !== t.availableToMin
      ? `new loads here leave from ${fmtHhmm(from)} and are back by ${fmtHhmm(to)}`
      : from !== t.availableFromMin
        ? `new loads here leave from ${fmtHhmm(from)}`
        : `new loads here are back by ${fmtHhmm(to)}`;
  return {
    availableFromMin: from,
    availableToMin: to,
    none: false,
    note: `Truck ${t.code} is on another depot's plan this day (${loads}): ${hours}, with the drive between the depots and the loading.`,
  };
}

/**
 * The truck was given time for new loads (its hours as sent; false only for the empty window of a truck
 * on another depot's plan all day, truckHoursAround): such a truck is not "unused" by the plan.
 */
export function hadTimeHere(t: { availableFromMin: number | null; availableToMin: number | null }): boolean {
  return t.availableFromMin === null || t.availableToMin === null || t.availableToMin > t.availableFromMin;
}

/** "North depot: L1 08:30–10:00 dispatched, L2 11:00–12:30 planned". */
function describeLoads(away: readonly OtherDepotLoad[]): string {
  const byDepot = new Map<string, OtherDepotLoad[]>();
  for (const f of away) byDepot.set(f.depotName, [...(byDepot.get(f.depotName) ?? []), f]);
  return [...byDepot]
    .map(([name, list]) => `${name}: ${list.map((f) => `L${f.loadNo} ${fmtHhmm(f.departMin)}–${fmtHhmm(f.returnMin)} ${f.status.toLowerCase()}`).join(', ')}`)
    .join('; ');
}

/**
 * The drivers' loads on the other depots' live plans of the run's day (any status), as planDrivers takes
 * them: the times widened by the drive between the depots, the truck named with its depot.
 */
export async function driverTripsElsewhere(db: Db, tenantId: string, run: { depotId: string; runDate: Date }): Promise<OtherDepotTrip[]> {
  return (await loadsOnOtherDepots(db, tenantId, run, { driverIds: 'ANY' })).flatMap((f) =>
    f.driverId
      ? [{ truckId: f.truckId, driverId: f.driverId, loadNo: f.loadNo, departMin: f.departMin - f.driveMin, returnMin: f.returnMin + f.driveMin, truckCode: `${f.truckCode} (${f.depotName})` }]
      : [],
  );
}

/** Both loads cannot be driven by one truck or driver: their times overlap once the drive between the depots is added. */
function clashes(a: { departMin: number; returnMin: number }, f: OtherDepotLoad): boolean {
  return a.departMin < f.returnMin + f.driveMin && f.departMin < a.returnMin + f.driveMin;
}

/** The refusal of a gated move (409 TRUCK_BUSY_ELSEWHERE / DRIVER_BUSY_ELSEWHERE), or null. */
export interface OtherDepotRefusal {
  message: string;
  body: Record<string, unknown>;
}

/**
 * LOCK, LOADING and DISPATCH of `load` (with the driver it has after the driver step of the request):
 * the first LOCKED / LOADING / DISPATCHED / COMPLETED load of another depot's live plan that day that
 * its truck, then its driver, cannot also drive. Called under lockTruckDriverDay.
 */
export async function otherDepotClash(
  db: Db & Pick<Prisma.TransactionClient, 'driver'>,
  tenantId: string,
  run: { depotId: string; runDate: Date },
  load: { truckId: string; loadNo: number; status: string; driverId: string | null; departMin: number; returnMin: number },
): Promise<OtherDepotRefusal | null> {
  const away = await loadsOnOtherDepots(db, tenantId, run, { truckIds: [load.truckId], driverIds: load.driverId ? [load.driverId] : [] }, { frozenOnly: true });
  const truckClash = away.find((f) => f.truckId === load.truckId && clashes(load, f));
  const driverClash = truckClash ? undefined : away.find((f) => load.driverId !== null && f.driverId === load.driverId && clashes(load, f));
  const f = truckClash ?? driverClash;
  if (!f) return null;
  const code = (await db.truck.findFirst({ where: { id: load.truckId, tenantId }, select: { code: true } }))?.code ?? 'Truck';
  const trip = `${code} L${load.loadNo} (${fmtHhmm(load.departMin)}–${fmtHhmm(load.returnMin)})`;
  const when = `${fmtHhmm(f.departMin)}–${fmtHhmm(f.returnMin)} (${f.status.toLowerCase()})${f.driveMin > 0 ? `, about ${f.driveMin} min drive from this depot` : ''}`;
  const facts = { depotId: f.depotId, depotName: f.depotName, otherLoadId: f.id, otherTruckCode: f.truckCode, otherLoadNo: f.loadNo, otherStatus: f.status, departMin: f.departMin, returnMin: f.returnMin, driveMin: f.driveMin };
  if (truckClash) {
    // A locked or loading load here is kept as it is by a re-plan: it goes back to Planned first.
    const remedy = load.status === 'PLANNED' ? 'Re-plan this depot' : 'Put this load back to Planned and re-plan this depot';
    return {
      message: `${trip}: this truck is also on L${f.loadNo} of the ${f.depotName} plan of this day, ${when}, and cannot do both. ${remedy}: its new loads are then planned around that load.`,
      body: { code: 'TRUCK_BUSY_ELSEWHERE', truckId: load.truckId, ...facts },
    };
  }
  const name = (await db.driver.findFirst({ where: { id: load.driverId!, tenantId }, select: { name: true } }))?.name ?? 'This driver';
  return {
    message: `${trip}: ${name} drives ${f.truckCode} L${f.loadNo} on the ${f.depotName} plan of this day, ${when}, and cannot drive both. Pick another driver for this load.`,
    body: { code: 'DRIVER_BUSY_ELSEWHERE', truckId: load.truckId, driverId: load.driverId, name, ...facts },
  };
}
