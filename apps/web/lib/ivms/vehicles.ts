/**
 * GET /api/runs/[id]/vehicles (IVMS live link, 16 Oct 2026, design section 8.2): the latest GPS position
 * of each truck with a load out on this plan, its next stop's live ETA and the GPS facts for the office.
 * Server only; reads only; every query names the company. PLANNER and up (the route).
 *
 * Nothing at all while the company's ivmsMode is OFF or ROUTEIQ_DISABLE_IVMS=1 (mode OFF, no vehicle),
 * for a plan of another day than today or yesterday, or for a truck without a load out (LOCKED,
 * LOADING, DISPATCHED: no off-duty positions, review M7). The positions are written by the poller
 * (TruckPosition, live map only); they are never used for times (H5).
 */
import { prisma } from '../db';
import { shownTruckCode } from '../dispatch/hire';
import { readTruckSnapshot } from '../dispatch/snapshots';
import { addDaysIso, dateOnly, DEFAULT_TZ, isoOf, todayIso, zonedDayStart } from '../dispatch/time';
import { stopsOfLoads, type PlannedStopRow } from '../delivery/day-results';
import { readIvmsEnv } from './env';
import { liveEta } from './eta';
import { gpsFactText, liveVehicleOf, type DayVehicle, type DayVehiclesResponse } from './live-map';
import { ivmsModeAtLeast, ivmsModeOf } from './settings';
import type { IvmsMode } from './types';

/** The live map's own request limit: 30 a minute per user (a 60 s refresh, some reloads). */
export const VEHICLES_RATE = { limit: 30, windowMs: 60_000 } as const;

const OUT = ['LOCKED', 'LOADING', 'DISPATCHED'] as const;
/** Which of a truck's loads out is "its" load on the map: the one on the road first. */
const RANK: Record<string, number> = { DISPATCHED: 3, LOADING: 2, LOCKED: 1 };

const empty = (mode: IvmsMode): DayVehiclesResponse => ({ mode, intervalSec: null, updatedAt: null, vehicles: [] });

/** The live vehicles of a plan, or null when the plan is not this company's. */
export async function readLiveVehicles(tenantId: string, runId: string, now: Date = new Date()): Promise<DayVehiclesResponse | null> {
  const run = await prisma.runPlan.findFirst({ where: { id: runId, tenantId }, select: { id: true, runDate: true } });
  if (!run) return null;
  const cfg = await prisma.tenantConfig.findFirst({ where: { tenantId }, select: { ivmsMode: true, timezone: true, avgSpeedKmh: true, distanceMultiplier: true, ivmsPollSec: true } });
  const mode: IvmsMode = readIvmsEnv().disabled ? 'OFF' : ivmsModeOf(cfg);
  if (!ivmsModeAtLeast(mode, 'MAP')) return empty(mode);
  const tz = cfg?.timezone || DEFAULT_TZ;
  const date = isoOf(run.runDate);
  const today = todayIso(tz, now);
  if (date !== today && date !== addDaysIso(today, -1)) return empty(mode);

  const loads = await prisma.planLoad.findMany({
    where: { tenantId, runId, status: { in: [...OUT] } },
    select: { id: true, truckId: true, loadNo: true, status: true, departMin: true, breakJson: true, truckSnapshotJson: true },
  });
  const state = await prisma.ivmsState.findFirst({ where: { tenantId }, select: { lastOkAt: true } });
  const base: DayVehiclesResponse = { mode, intervalSec: null, updatedAt: state?.lastOkAt ? state.lastOkAt.toISOString() : null, vehicles: [] };
  if (!loads.length) return base;
  const loadOf = new Map<string, (typeof loads)[number]>();
  for (const l of loads) {
    const cur = loadOf.get(l.truckId);
    if (!cur || (RANK[l.status] ?? 0) > (RANK[cur.status] ?? 0) || ((RANK[l.status] ?? 0) === (RANK[cur.status] ?? 0) && l.loadNo > cur.loadNo)) loadOf.set(l.truckId, l);
  }
  const truckIds = [...loadOf.keys()];
  const [positions, trucks, days] = await Promise.all([
    prisma.truckPosition.findMany({ where: { tenantId, truckId: { in: truckIds } }, select: { truckId: true, fixAt: true, lat: true, lng: true, speedKmh: true, heading: true, flags: true, movedAt: true } }),
    prisma.truck.findMany({ where: { tenantId, id: { in: truckIds } }, select: { id: true, code: true, onlyOnDate: true } }),
    prisma.ivmsTruckDay.findMany({ where: { tenantId, truckId: { in: truckIds }, deliveryDate: dateOnly(date) }, select: { truckId: true, gpsFactsJson: true } }),
  ]);
  if (!positions.length) return base;

  // The next stops of the trucks on the road with a usable fix (ETA from the plan's own legs).
  const onRoad = positions.map((p) => loadOf.get(p.truckId)!).filter((l) => l.status === 'DISPATCHED');
  let stops = new Map<string, PlannedStopRow[]>();
  let visits: { truckId: string; loadNo: number; sequence: number; outcome: string | null; arrivedAt: Date | null; departedAt: Date | null; depotId: string }[] = [];
  let depot: { id: string; lat: number; lng: number } | null = null;
  if (onRoad.length) {
    const [s, v, r] = await Promise.all([
      stopsOfLoads(prisma, onRoad.map((l) => ({ id: l.id, breakJson: l.breakJson }))),
      prisma.stopVisit.findMany({
        where: { tenantId, truckId: { in: onRoad.map((l) => l.truckId) }, deliveryDate: dateOnly(date) },
        select: { truckId: true, loadNo: true, sequence: true, outcome: true, arrivedAt: true, departedAt: true, depotId: true },
      }),
      prisma.runPlan.findFirst({ where: { id: runId, tenantId }, select: { depotId: true } }),
    ]);
    stops = s;
    visits = v;
    depot = r ? await prisma.depot.findFirst({ where: { id: r.depotId, tenantId }, select: { id: true, lat: true, lng: true } }) : null;
  }
  const dayStart = zonedDayStart(date, tz);

  base.vehicles = positions.map((p): DayVehicle => {
    const load = loadOf.get(p.truckId)!;
    const truck = trucks.find((t) => t.id === p.truckId);
    const code = truck ? shownTruckCode(readTruckSnapshot(load.truckSnapshotJson)?.code ?? null, truck) : '';
    const v = liveVehicleOf({ ...p, flags: p.flags ?? [] }, code, load.loadNo, now);
    let next: DayVehicle['next'] = null;
    if (load.status === 'DISPATCHED' && !v.stale) {
      const planned = stops.get(load.id) ?? [];
      const mine = visits.filter((x) => x.truckId === p.truckId && x.loadNo === load.loadNo && (!depot || x.depotId === depot.id));
      const etas = liveEta({
        now,
        fix: { fixAt: p.fixAt, lat: p.lat, lng: p.lng, flags: v.flags },
        dayStart,
        departMin: load.departMin,
        depot: depot ? { lat: depot.lat, lng: depot.lng } : null,
        stops: planned.map((s) => {
          const vis = mine.find((x) => x.sequence === s.sequence);
          return {
            sequence: s.sequence,
            pin: s.pin,
            etaMin: s.etaMin,
            plannedServiceMin: s.plannedServiceMin,
            done: !!vis && (!!vis.outcome || !!vis.departedAt),
            arrivedAt: vis && !vis.outcome && !vis.departedAt ? vis.arrivedAt : null,
          };
        }),
        avgSpeedKmh: cfg?.avgSpeedKmh ?? 40,
        distanceMultiplier: cfg?.distanceMultiplier ?? 1.3,
      });
      const first = etas[0];
      if (first) {
        const s = planned.find((x) => x.sequence === first.sequence);
        next = { sequence: first.sequence, customerName: s?.customerName ?? '', plannedAt: first.plannedAt?.toISOString() ?? null, etaAt: first.etaAt.toISOString(), delayMin: first.delayMin, atStop: first.atStop };
      }
    }
    const factsJson = days.find((d) => d.truckId === p.truckId)?.gpsFactsJson;
    const facts = (Array.isArray(factsJson) ? factsJson : []).map((f) => gpsFactText(f, tz)).filter((x): x is string => !!x).slice(0, 5);
    return { ...v, next, facts };
  });
  base.vehicles.sort((a, b) => a.truckCode.localeCompare(b.truckCode));
  return base;
}
