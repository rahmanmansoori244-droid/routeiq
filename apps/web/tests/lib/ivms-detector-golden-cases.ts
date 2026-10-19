/**
 * Deterministic truck-days for the golden test of the GPS stop detector (tests/lib/ivms-detector-golden.spec.ts):
 * the detector of the owner request of 19 Oct 2026 (frozen runs as gaps, the customer's site radius, the
 * merge of one site's stays, the held departures, the stay summary) must propose exactly what the detector
 * of 16-18 Oct proposed for every truck-day where none of those applies: no frozen run, no site radius,
 * and no return to a stop's pin within 10 minutes and 500 m. tests/fixtures/ivms/detector-golden.json holds
 * what the detector at eb59226 (before the change) proposed for these very cases (seeded: the same cases
 * every run).
 *
 * Invented data only: a depot in empty desert, pins as metre offsets from it (ivms-trail.ts), made-up loads.
 * A truck-day: 1 to 3 loads, each with 2 to 6 stops visited in order (now and then one out of order), a
 * dwell of 1 to 40 minutes (with drift, a point 200 m off, a silence, the ignition off), traffic halts and
 * drive-bys, sometimes a return to a stop after a long trip away, results before or during a stay, an
 * office arrival, and a trail that may end in the middle of a stay.
 */
import type { DetectorInput, DetectorLoad, DetectorStop, ZoneMove } from '@/lib/ivms/stops';
import { DETECTOR_FIXED, type DetectorParams } from '@/lib/ivms/types';
import { T, Trail, at } from './ivms-trail';

export const GOLDEN_PARAMS: DetectorParams = { stopRadiusM: 100, dwellMin: 3, depotRadiusM: 300, ...DETECTOR_FIXED };
const DEPOT = { depotId: 'dep1', ...at(0) };

/** mulberry32: a tiny seeded generator (the same sequence on every run and machine). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

export interface DetectorGoldenCase {
  name: string;
  input: DetectorInput;
}

const hhmmOf = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.floor(min % 60)).padStart(2, '0')}`;

/** `n` seeded truck-days (none with a frozen run, a site radius or a return to a pin within 10 min and 500 m). */
export function detectorGoldenCases(n = 160, seed = 2026_10_19): DetectorGoldenCase[] {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const out: DetectorGoldenCase[] = [];
  for (let c = 0; c < n; c++) {
    const step = [10, 20, 30][int(0, 2)]!;
    const startMin = 5 * 60 + int(0, 90);
    const trail = new Trail(hhmmOf(startMin), 0, 0, step);
    trail.park(int(20, 50));
    const loads: DetectorLoad[] = [];
    const zoneMoves: ZoneMove[] = [];
    const nLoads = int(1, 3);
    let pinNo = 0;
    for (let L = 1; L <= nLoads; L++) {
      const departAt = new Date(trail.t);
      // Pins on a ring around the depot, each at least ~1.5 km from the others of the day.
      const nStops = int(2, 6);
      const stops: DetectorStop[] = [];
      for (let s = 1; s <= nStops; s++) {
        pinNo++;
        const angle = (pinNo * 2.399963) % (2 * Math.PI);
        const radius = 2500 + (pinNo % 7) * 1500;
        const pin = { east: Math.round(radius * Math.cos(angle)), north: Math.round(radius * Math.sin(angle)) };
        stops.push({ sequence: s, pin: at(pin.east, pin.north), resultAt: null, officeArrival: false });
        (stops[s - 1] as DetectorStop & { _m: { east: number; north: number } })._m = pin;
      }
      const order = stops.map((s) => s.sequence);
      if (nStops > 2 && r() < 0.2) [order[0], order[1]] = [order[1]!, order[0]!];
      const kmh = int(25, 60);
      for (const seq of order) {
        const s = stops[seq - 1]! as DetectorStop & { _m: { east: number; north: number } };
        const m = s._m;
        // Now and then a drive-by of the pin first, or a traffic halt near it.
        if (r() < 0.1) trail.drive(m.east + 600, m.north, kmh).drive(m.east - 600, m.north, kmh);
        trail.drive(m.east, m.north, kmh);
        const arrivedAt = trail.t;
        const dwell = r() < 0.15 ? int(1, 2) : int(3, 40);
        const kind = r();
        if (kind < 0.15) trail.park(Math.max(1, Math.floor(dwell / 2)), { jitterM: 70 }).point(m.east + 200, m.north).park(Math.ceil(dwell / 2));
        else if (kind < 0.25) trail.park(Math.min(dwell, 4)).silent(int(2, 12)).park(Math.max(1, dwell - 4), { ignition: false });
        else trail.park(dwell);
        // Results: none, before the stay, during it; or an office arrival.
        const res = r();
        if (res < 0.15) s.resultAt = new Date(arrivedAt - int(5, 60) * 60_000);
        else if (res < 0.45) s.resultAt = new Date(arrivedAt + int(1, dwell) * 60_000);
        else if (res < 0.5) s.officeArrival = true;
        // A return to the stop after a long trip away (beyond 500 m and over 10 min: never one site visit).
        if (r() < 0.08) {
          trail.drive(m.east + 2500, m.north, kmh).park(int(12, 30)).drive(m.east, m.north, kmh).park(int(3, 15));
        }
      }
      for (const s of stops) delete (s as Partial<DetectorStop & { _m: unknown }>)._m;
      // Back to the depot (the last load of some days ends with the trail in the middle of a stay).
      const endsOut = L === nLoads && r() < 0.15;
      if (!endsOut) {
        trail.drive(0, 0, kmh).park(int(10, 40));
        if (r() < 0.3) zoneMoves.push({ id: `z${c}-${L}`, kind: 'DEPOT_IN', at: new Date(trail.t - int(1, 8) * 60_000), depotId: 'dep1' });
      }
      const pressed = r() < 0.85 ? new Date(departAt.getTime() - int(0, 20) * 60_000) : null;
      loads.push({ depotId: 'dep1', loadNo: L, status: r() < 0.5 ? 'COMPLETED' : 'DISPATCHED', dispatchedAt: pressed, plannedDepartAt: new Date(departAt.getTime() + int(-15, 15) * 60_000), stops });
      if (r() < 0.1) trail.drive(1500, 0, 30).park(5).drive(0, 0, 30).park(10); // a fuel run
    }
    // Now and then the trail is read before the day is over.
    const now = r() < 0.2 ? new Date(T(hhmmOf(startMin)).getTime() + int(60, 400) * 60_000) : undefined;
    out.push({
      name: `day ${c}`,
      input: { points: now ? trail.pts.filter((p) => p.fixAt <= now) : trail.pts, depots: [DEPOT], zoneMoves, loads, params: GOLDEN_PARAMS, ...(now ? { now } : {}) },
    });
  }
  return out;
}

/** What the golden file keeps of a detector run (dates as ISO strings): the fields the detector of 16 Oct had. */
export function goldenOutput(out: {
  trips: { outAt: Date; inAt: Date | null; loadNo: number | null; loadDepotId: string | null; depotId: string | null; openStart: boolean }[];
  trailMoves: { kind: string; at: Date; depotId: string; observed: boolean }[];
  zoneOutcomes: { id: string; outcome: string }[];
  candidates: { depotId: string; loadNo: number; sequence: number; kind: string; at: Date; observed: boolean; segmentStartAt: Date; lat: number; lng: number; distanceM: number }[];
  ambiguities: { reason: string; loadNo: number; sequences: number[]; from: Date; to: Date | null }[];
  notes: string[];
}): unknown {
  return JSON.parse(
    JSON.stringify({
      trips: out.trips.map((t) => ({ outAt: t.outAt, inAt: t.inAt, loadNo: t.loadNo, loadDepotId: t.loadDepotId, depotId: t.depotId, openStart: t.openStart })),
      trailMoves: out.trailMoves.map((m) => ({ kind: m.kind, at: m.at, depotId: m.depotId, observed: m.observed })),
      zoneOutcomes: out.zoneOutcomes,
      candidates: out.candidates.map((c) => ({ depotId: c.depotId, loadNo: c.loadNo, sequence: c.sequence, kind: c.kind, at: c.at, observed: c.observed, segmentStartAt: c.segmentStartAt, lat: c.lat, lng: c.lng, distanceM: c.distanceM })),
      // SHORT_DWELL is new (owner request 19 Oct 2026): a fact only, never a time.
      ambiguities: out.ambiguities.filter((a) => a.reason !== 'SHORT_DWELL'),
      notes: out.notes,
    }),
  );
}
