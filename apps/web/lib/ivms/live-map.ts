/**
 * The day screen's live truck layer (IVMS live link, 16 Oct 2026, design section 8.2): the shape of
 * GET /api/runs/[id]/vehicles and the words around it. Pure and browser-safe.
 *
 * - A truck is shown only while it has a load out on the plan (LOCKED, LOADING or DISPATCHED: review
 *   M7, no off-duty positions), only to PLANNER and up, only in ivmsMode MAP or TIMES.
 * - A fix older than STALE_FIX_SEC (or invalid, or ahead of the clock) is STALE: grey, its speed is not
 *   shown, it is never "moving" and it gives no ETA (H5).
 * - Never the tracker IMEI or any provider field; coordinates at 5 decimals (about 1 m).
 */
import { fmtHhmm, localMinutes } from '../dispatch/time';
import { FIX_FLAGS, MOVING_KMH, STALE_FIX_SEC, type FixFlag, type LiveVehicle, type LiveVehiclesResponse } from './types';

/** The next stop of a vehicle with a usable fix (lib/ivms/eta.ts). */
export interface LiveNextStop {
  sequence: number;
  customerName: string;
  plannedAt: string | null;
  etaAt: string;
  delayMin: number | null;
  /** The truck is at this stop now. */
  atStop: boolean;
}

/** A vehicle on the day screen: the contract's LiveVehicle, plus its next stop and the GPS facts for the office. */
export interface DayVehicle extends LiveVehicle {
  next: LiveNextStop | null;
  /** What GPS saw but did not record by itself (lib/ivms/stop-events.ts GpsFact), in words. */
  facts: string[];
}

export interface DayVehiclesResponse extends Omit<LiveVehiclesResponse, 'vehicles'> {
  vehicles: DayVehicle[];
}

/** A truck's latest position row (TruckPosition), as the endpoint reads it. */
export interface PositionRow {
  truckId: string;
  fixAt: Date;
  lat: number;
  lng: number;
  speedKmh: number | null;
  heading: number | null;
  flags: string[];
  movedAt: Date | null;
}

const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

/** Is a fix stale for the map (and for everything else)? */
export function fixStale(p: Pick<PositionRow, 'fixAt' | 'flags'>, now: Date): boolean {
  const age = (now.getTime() - p.fixAt.getTime()) / 1000;
  return age > STALE_FIX_SEC || p.flags.includes('INVALID_FIX') || p.flags.includes('CLOCK_AHEAD');
}

/** The vehicle a position row shows (no next stop, no facts yet). */
export function liveVehicleOf(p: PositionRow, truckCode: string, loadNo: number | null, now: Date): LiveVehicle {
  const stale = fixStale(p, now);
  const moving = !stale && (p.speedKmh ?? 0) >= MOVING_KMH;
  const parkedFrom = p.movedAt ?? null;
  return {
    truckId: p.truckId,
    truckCode,
    loadNo,
    lat: r5(p.lat),
    lng: r5(p.lng),
    fixAt: p.fixAt.toISOString(),
    ageSec: Math.max(0, Math.round((now.getTime() - p.fixAt.getTime()) / 1000)),
    // A stale truck is never shown moving: no speed, no heading.
    speedKmh: stale ? null : (p.speedKmh ?? null),
    heading: stale || !moving ? null : (p.heading ?? null),
    parkedMin: stale || moving || !parkedFrom ? null : Math.max(0, Math.floor((p.fixAt.getTime() - parkedFrom.getTime()) / 60_000)),
    stale,
    flags: p.flags.filter((f): f is FixFlag => (FIX_FLAGS as readonly string[]).includes(f)),
  };
}

const hhmm = (iso: string, tz: string) => fmtHhmm(localMinutes(new Date(iso), tz));
const ago = (sec: number) => (sec < 90 ? '1 min ago' : sec < 3600 ? `${Math.round(sec / 60)} min ago` : `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min ago`);

/** The marker's popup: "T05 · L2 · 42 km/h · updated 1 min ago · next: stop 4, Shop Example C, about 11:05 (+12 min)". */
export function vehiclePopupText(v: DayVehicle, tz: string): string {
  const parts = [v.truckCode, v.loadNo !== null ? `L${v.loadNo}` : null];
  if (v.stale) parts.push(`no GPS position for ${ago(v.ageSec).replace(' ago', '')} (last ${hhmm(v.fixAt, tz)})`);
  else {
    if (v.speedKmh !== null && v.speedKmh >= MOVING_KMH) parts.push(`${Math.round(v.speedKmh)} km/h`);
    else if (v.parkedMin !== null) parts.push(`parked ${v.parkedMin} min`);
    parts.push(`updated ${ago(v.ageSec)}`);
    if (v.next) {
      const delay = v.next.delayMin === null || v.next.delayMin === 0 ? '' : ` (${v.next.delayMin > 0 ? '+' : ''}${v.next.delayMin} min)`;
      parts.push(v.next.atStop ? `at stop ${v.next.sequence}, ${v.next.customerName}` : `next: stop ${v.next.sequence}, ${v.next.customerName}, about ${hhmm(v.next.etaAt, tz)}${delay}`);
    }
  }
  return [...parts.filter((x): x is string => !!x), ...v.facts].join(' · ');
}

/** The line under the map: when the positions were last read, how many trucks, which are stale. */
export function liveMapCaption(r: Pick<DayVehiclesResponse, 'mode' | 'updatedAt' | 'vehicles'>, now: Date, tz: string): { text: string; warn: boolean } | null {
  if (r.mode === 'OFF') return null;
  const stale = r.vehicles.filter((v) => v.stale).length;
  if (!r.updatedAt) return { text: 'Live trucks (GPS): no position received yet.', warn: r.vehicles.length > 0 };
  const age = (now.getTime() - Date.parse(r.updatedAt)) / 1000;
  if (age > 2 * STALE_FIX_SEC) return { text: `Live trucks (GPS): positions delayed since ${hhmm(r.updatedAt, tz)}. Times on the screen come from the drivers' phones.`, warn: true };
  const n = r.vehicles.length;
  const trucks = `${n} truck${n === 1 ? '' : 's'}`;
  return { text: `Live trucks (GPS): positions of ${hhmm(r.updatedAt, tz)}, ${trucks}${stale ? `, ${stale} without a recent position (grey)` : ''}.`, warn: false };
}

/** A GPS fact for the office in words (IvmsTruckDay.gpsFactsJson). Unknown shapes are left out. */
export function gpsFactText(f: unknown, tz: string): string | null {
  if (!f || typeof f !== 'object') return null;
  const x = f as { kind?: unknown; loadNo?: unknown; sequences?: unknown; from?: unknown };
  const seqs = Array.isArray(x.sequences) ? x.sequences.filter((n): n is number => typeof n === 'number') : [];
  const at = typeof x.from === 'string' && Number.isFinite(Date.parse(x.from)) ? ` at ${hhmm(x.from, tz)}` : '';
  const load = typeof x.loadNo === 'number' ? `L${x.loadNo} ` : '';
  const stops = seqs.length > 1 ? `stops ${seqs.slice(0, -1).join(', ')} and ${seqs[seqs.length - 1]}` : `stop ${seqs[0] ?? '?'}`;
  switch (x.kind) {
    case 'SEVERAL_PINS':
      return `GPS: ${load}${stops} close together${at}; not timed by GPS (the driver or the office records which customer)`;
    case 'NEAR_DEPOT':
      return `GPS: ${load}${stop1(seqs)} is near the depot${at}; not timed by GPS`;
    case 'OUT_OF_SEQUENCE_SHORT':
      return `GPS: short stop at ${load}${stop1(seqs)} out of sequence${at}; not timed by GPS`;
    case 'NO_DEPOT_BOUNDARY':
      return 'GPS: depot visits not seen, so stops cannot be told apart between loads; not timed by GPS';
    default:
      return null;
  }
}
const stop1 = (seqs: number[]) => `stop ${seqs[0] ?? '?'}`;
