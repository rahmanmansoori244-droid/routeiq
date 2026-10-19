/**
 * The analysis dataset's GPS rules (owner request 19 Oct 2026; lib/analysis/types.ts SITE_RULES). Pure and
 * deterministic over one truck-day's trail: no database, no clock. lib/analysis/build.ts calls it while the
 * trail still exists (the nightly job, about 03:00 for the day before); what it returns is stored as
 * distances, bearings from the customer's pin, minutes and times - never a position.
 *
 * Ported from the GPS study's prototype (d-dataset/build_dataset.py, 19 Oct 2026) with what the study's check
 * (report-check.json) corrected:
 * - the CUSTOMER SITE of a visit: inside the visit's window (from leaving the stop before to the next
 *   arrival), the first point within 300 m of the pin (or standing within 500 m) from which the truck
 *   reaches a slow point on site before going beyond 500 m starts it (a drive-past never does); the last slow
 *   point on site ends it, plus the points right after it still within 300 m (driving out). A point is on
 *   this customer's site only when it is nearer this pin than any other pin of the truck-day that is 300 m
 *   or more away (pins closer than that share a site: only the windows separate them). A standstill of 2 min
 *   or more 300-500 m from the pin is on site too: one study customer's second drop point was 353-378 m away,
 *   which the prototype's 300 m cut off ("the departure while the truck is still at the customer");
 * - TIME AWAY: beyond 500 m, or nearer another customer's pin, the truck is away; a trip away and back inside
 *   the site (the check found a 6.3 km trip to another customer's site and a 94-min park 1.2 km away, both
 *   between two stays at one customer) is kept as its own count and minutes and never counted as unloading -
 *   the guard the check asked for before any "bridging" of stays;
 * - SUB-STAYS: slow periods (under 5 km/h, one isolated faster point tolerated) of 2 min or more on site,
 *   from the pin as distance and bearing; centres within 50 m are one drop point. The prototype dropped the
 *   points beyond 500 m before finding them, so a stay before and after a trip away became one: here a trip
 *   away always ends a sub-stay;
 * - crawling alone never makes a standstill: the slow rule is the live detector's (lib/ivms/stops.ts, under
 *   5 km/h or the ignition off; the study: 0 of 71 GPS stops came from slow movement);
 * - the trail's quality is counted, never repaired: frozen-position runs (the same position for 60 s or more
 *   at 5 km/h or more), and single-point spikes found pairwise (a point more than 150 km/h from both
 *   neighbours while the neighbours agree with each other). The study's 19 "jumps" over 150 km/h were mostly
 *   timestamp jitter (1-16 s steps at 82-88 km/h): a plain speed filter would delete good points, so only a
 *   pairwise spike is left out of the km.
 * The live detector's own stays (lib/ivms/stops.ts staysAt, the 100 m radius) inside each site are counted
 * beside it, so the big-site pattern (several detector stays in one site) stays visible after the trail is gone.
 */
import { distanceM } from '../dispatch/snapshots';
import { staysAt, type PrevIndex } from '../ivms/stops';
import type { DetectorParams, TrailPoint } from '../ivms/types';
import { SITE_RULES } from './types';

type LatLng = { lat: number; lng: number };

const ms = (d: Date) => d.getTime();
const MIN = 60_000;
const minutes = (a: Date, b: Date) => (ms(b) - ms(a)) / MIN;

/** Slow: under the moving speed or the ignition off (the live detector's rule; the ignition is never sent today). */
export const isSlow = (p: TrailPoint, movingKmh: number) => p.ignition === false || (p.speedKmh ?? 0) < movingKmh;

/** The bearing (degrees, 0 = north, clockwise) from `from` to `to`. */
export function bearingDeg(from: LatLng, to: LatLng): number {
  const rad = Math.PI / 180;
  const y = Math.sin((to.lng - from.lng) * rad) * Math.cos(to.lat * rad);
  const x = Math.cos(from.lat * rad) * Math.sin(to.lat * rad) - Math.sin(from.lat * rad) * Math.cos(to.lat * rad) * Math.cos((to.lng - from.lng) * rad);
  return ((Math.atan2(y, x) / rad) % 360 + 360) % 360;
}

/** The point `distM` metres from `from` on `bearing` degrees (the office's standing point in the export). */
export function destinationOf(from: LatLng, distM: number, bearing: number): LatLng {
  const rad = Math.PI / 180;
  const R = 6_371_000;
  const d = distM / R;
  const b = bearing * rad;
  const lat1 = from.lat * rad;
  const lng1 = from.lng * rad;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lng2 = lng1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 / rad, lng: (((lng2 / rad) + 540) % 360) - 180 };
}

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Runs of points that `ok` accepts, as [first, last] indexes: one isolated point it refuses between two it
 * accepts does not break a run (the prototype's slow_runs); two in a row do. A run starts and ends on an
 * accepted point.
 */
export function runsOf(n: number, ok: (i: number) => boolean): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  let last = -1;
  let refused = 0;
  for (let i = 0; i < n; i++) {
    if (ok(i)) {
      if (start < 0 || refused >= 2) {
        if (start >= 0) runs.push([start, last]);
        start = i;
      }
      last = i;
      refused = 0;
    } else if (start >= 0) {
      refused++;
    }
  }
  if (start >= 0) runs.push([start, last]);
  return runs;
}

/**
 * Single-point spikes (pairwise): point i implies more than spikeKmh both from the point before and to the
 * point after, while those two agree with each other (at most spikeKmh between them). Points with the same
 * time as a neighbour are never spikes (timestamp jitter, not a position error).
 */
export function spikesOf(points: readonly TrailPoint[], spikeKmh: number = SITE_RULES.spikeKmh): Set<number> {
  const out = new Set<number>();
  const kmh = (a: TrailPoint, b: TrailPoint) => {
    const sec = (ms(b.fixAt) - ms(a.fixAt)) / 1000;
    return sec > 0 ? (distanceM(a, b) / sec) * 3.6 : null;
  };
  for (let i = 1; i + 1 < points.length; i++) {
    const a = kmh(points[i - 1]!, points[i]!);
    const b = kmh(points[i]!, points[i + 1]!);
    const ab = kmh(points[i - 1]!, points[i + 1]!);
    if (a !== null && b !== null && ab !== null && a > spikeKmh && b > spikeKmh && ab <= spikeKmh) out.add(i);
  }
  return out;
}

/** Km driven between two instants (spikes left out; null when the range is empty or reversed). */
export function kmBetween(points: readonly TrailPoint[], from: Date | null, to: Date | null, spikes: ReadonlySet<number>): number | null {
  if (!from || !to || ms(to) <= ms(from)) return null;
  let prev: TrailPoint | null = null;
  let m = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (ms(p.fixAt) < ms(from)) continue;
    if (ms(p.fixAt) > ms(to)) break;
    if (spikes.has(i)) continue;
    if (prev) m += distanceM(prev, p);
    prev = p;
  }
  return m / 1000;
}

/**
 * Frozen-position runs: consecutive points with exactly the same coordinates while the speed says 5 km/h or
 * more, lasting at least 60 s (the study: 11 such runs, 6 on one truck; an event right after one was still
 * flagged as observed). Counted for the truck-day, never deleted.
 */
export function frozenRunsOf(points: readonly TrailPoint[]): { runs: number; minutes: number } {
  let runs = 0;
  let total = 0;
  let i = 0;
  while (i < points.length) {
    let j = i;
    while (
      j + 1 < points.length &&
      points[j + 1]!.lat === points[i]!.lat &&
      points[j + 1]!.lng === points[i]!.lng &&
      (points[j + 1]!.speedKmh ?? 0) >= SITE_RULES.frozenMinKmh
    ) j++;
    if (j > i) {
      const sec = (ms(points[j]!.fixAt) - ms(points[i]!.fixAt)) / 1000;
      if (sec >= SITE_RULES.frozenRunSec) {
        runs++;
        total += sec / 60;
      }
    }
    i = j + 1;
  }
  return { runs, minutes: total };
}

/** The truck's distance from the pin at `at`: the trail point nearest in time, at most pairSec away (else null). */
export function distanceAt(points: readonly TrailPoint[], at: Date, pin: LatLng, pairSec: number = SITE_RULES.resultPairSec): number | null {
  let best: TrailPoint | null = null;
  for (const p of points) {
    const dt = Math.abs(ms(p.fixAt) - ms(at));
    if (dt <= pairSec * 1000 && (!best || dt < Math.abs(ms(best.fixAt) - ms(at)))) best = p;
  }
  return best ? distanceM(best, pin) : null;
}

/** The truck's first move of the day: the first of two moving points in a row (no customer site starts before it). */
export function firstMoveOf(points: readonly TrailPoint[], movingKmh: number): Date | null {
  for (let i = 0; i + 1 < points.length; i++) if (!isSlow(points[i]!, movingKmh) && !isSlow(points[i + 1]!, movingKmh)) return points[i]!.fixAt;
  return null;
}

export interface SubStay {
  startAt: Date;
  endAt: Date;
  minutes: number;
  distM: number;
  bearingDeg: number;
  /** The drop point it belongs to (1-based): sub-stays whose centres are within 50 m share one. */
  drop: number;
}

export interface AwayPeriod {
  startAt: Date;
  endAt: Date;
  maxDistM: number;
}

/** A visit's customer site, from the trail (see the header). Times and distances only. */
export interface SiteGps {
  siteStartAt: Date;
  siteEndAt: Date;
  away: AwayPeriod[];
  substays: SubStay[];
  dropPoints: number;
  /** The furthest the truck stood (a slow point) from the pin on site. */
  maxDistM: number | null;
  /** Where it stood to unload: the sub-stay holding the result tap, else the longest. */
  standDistM: number | null;
  standBearingDeg: number | null;
  /** The live detector's stays (100 m, the dwell) inside the site. */
  detectorStays: number;
}

export interface SiteInput {
  /** The visit's window of the sorted trail (points strictly inside it). */
  window: readonly TrailPoint[];
  pin: LatLng;
  sequence: number;
  /** The other pins of the truck-day and the depots, 300 m or more from this pin (nearer ones share the site). */
  others: readonly LatLng[];
  /** The driver's result tap, to find where the truck stood to unload. */
  resultTapAt: Date | null;
  params: DetectorParams;
  /** The whole sorted trail of the truck-day and its index (the detector's gap rule needs the point before). */
  all: readonly TrailPoint[];
  prevIdx: PrevIndex;
}

/** The closest the truck came to the pin in the window (null without points). */
export function closestOf(window: readonly TrailPoint[], pin: LatLng): number | null {
  let best: number | null = null;
  for (const p of window) {
    const d = distanceM(p, pin);
    if (best === null || d < best) best = d;
  }
  return best;
}

/** The customer site of one visit, or null when the truck was not seen on site in the window. */
export function siteOf(input: SiteInput): SiteGps | null {
  const R = SITE_RULES;
  const win = input.window;
  const n = win.length;
  if (!n) return null;
  const moving = input.params.movingKmh;
  const d = win.map((p) => distanceM(p, input.pin));
  // Nearer this pin than any other pin of the truck-day that does not share the site.
  const nearest = win.map((p, i) => input.others.every((o) => d[i]! <= distanceM(p, o) + 0.01));
  const slow = win.map((p) => isSlow(p, moving));
  const core = (i: number) => d[i]! <= R.siteRadiusM && nearest[i]!;
  const within = (i: number) => d[i]! <= R.leaveRadiusM && nearest[i]!;
  const away = (i: number) => !within(i);
  // Standstills on site: slow runs within 500 m, nearest this pin, of 2 min or more (a drop point, a pin
  // offset); a shorter halt 300-500 m away (traffic, a gate) is not on site.
  const standRuns = runsOf(n, (i) => slow[i]! && within(i)).filter(([a, b]) => minutes(win[a]!.fixAt, win[b]!.fixAt) >= R.substayMin);
  const inStand = new Array<boolean>(n).fill(false);
  for (const [a, b] of standRuns) for (let i = a; i <= b; i++) if (slow[i] && within(i)) inStand[i] = true;
  const onSiteSlow = (i: number) => slow[i]! && within(i) && (core(i) || inStand[i]!);

  // Start: the first point on site from which the truck reaches a slow point on site before going beyond 500 m.
  let start = -1;
  for (let i = 0; i < n && start < 0; ) {
    if (!(core(i) || inStand[i])) {
      i++;
      continue;
    }
    let j = i;
    for (; j < n && d[j]! <= R.leaveRadiusM; j++) {
      if (onSiteSlow(j)) {
        start = i;
        break;
      }
    }
    if (start < 0) i = j + 1;
  }
  if (start < 0) return null;
  let lastSlow = start;
  for (let k = start; k < n; k++) if (onSiteSlow(k)) lastSlow = k;
  let last = lastSlow;
  while (last + 1 < n && core(last + 1)) last++;

  // Time away inside the site: from the last point on site before it to the first point back on site.
  const awayList: AwayPeriod[] = [];
  let since: number | null = null;
  let far = 0;
  for (let k = start + 1; k <= last; k++) {
    if (away(k)) {
      if (since === null) {
        since = k - 1;
        far = 0;
      }
      far = Math.max(far, d[k]!);
    } else if (since !== null && (core(k) || onSiteSlow(k))) {
      awayList.push({ startAt: win[since]!.fixAt, endAt: win[k]!.fixAt, maxDistM: Math.round(far) });
      since = null;
    }
  }

  // Sub-stays: the standstills inside the site, as distance and bearing of their median point from the pin.
  const subs: SubStay[] = [];
  const centres: LatLng[] = [];
  for (const [a, b] of standRuns) {
    if (a < start || b > last) continue;
    const idx: number[] = [];
    for (let i = a; i <= b; i++) if (slow[i] && within(i)) idx.push(i);
    const c = { lat: median(idx.map((i) => win[i]!.lat))!, lng: median(idx.map((i) => win[i]!.lng))! };
    let drop = centres.findIndex((x) => distanceM(x, c) <= R.dropClusterM) + 1;
    if (!drop) {
      centres.push(c);
      drop = centres.length;
    }
    subs.push({
      startAt: win[a]!.fixAt,
      endAt: win[b]!.fixAt,
      minutes: minutes(win[a]!.fixAt, win[b]!.fixAt),
      distM: distanceM(c, input.pin),
      bearingDeg: bearingDeg(input.pin, c),
      drop,
    });
  }
  let maxDist: number | null = null;
  for (let k = start; k <= last; k++) if (onSiteSlow(k)) maxDist = Math.max(maxDist ?? 0, d[k]!);
  // Where it unloaded: the sub-stay holding the driver's result tap (2 min of slack), else the longest one.
  // Never the longest wait when the result says otherwise (study: "do not move a pin to a waiting spot").
  const tap = input.resultTapAt ? ms(input.resultTapAt) : null;
  const holding = tap === null ? [] : subs.filter((s) => ms(s.startAt) <= tap && tap <= ms(s.endAt) + 2 * MIN);
  const stand = (holding.length ? holding : subs).reduce<SubStay | null>((best, s) => (!best || s.minutes > best.minutes ? s : best), null);

  const span = win.slice(start, last + 1);
  const p = input.params;
  const detectorStays = staysAt(span, input.all, input.pin, input.sequence, p, input.prevIdx).filter(
    (s) => s.hasSlowPoint && (ms((s.exit ?? s.lastIn).fixAt) - ms(s.first.fixAt)) / MIN >= p.dwellMin,
  ).length;

  return {
    siteStartAt: win[start]!.fixAt,
    siteEndAt: win[last]!.fixAt,
    away: awayList,
    substays: subs,
    dropPoints: centres.length,
    maxDistM: maxDist,
    standDistM: stand ? stand.distM : null,
    standBearingDeg: stand ? stand.bearingDeg : null,
    detectorStays,
  };
}

/** Minutes of `periods` that fall inside [from, to]. */
export function overlapMin(periods: readonly { startAt: Date; endAt: Date }[], from: Date, to: Date): number {
  let m = 0;
  for (const a of periods) {
    const s = Math.max(ms(a.startAt), ms(from));
    const e = Math.min(ms(a.endAt), ms(to));
    if (e > s) m += (e - s) / MIN;
  }
  return m;
}

/** The truck-day's totals from the trail between the first depot OUT and the last depot IN (or the trail's end). */
export interface DayTrailFacts {
  kmGps: number | null;
  movingMin: number | null;
  atSitesMin: number | null;
  idleStops: number;
  idleMin: number;
  maxGapMin: number | null;
  gapMinOver5: number | null;
}

/**
 * Km, moving minutes, time at customer sites (overlaps once), and standstills of 3 min or more away from every
 * site and the depot (a count and minutes only: no location is kept for them).
 */
export function dayTrailFacts(
  points: readonly TrailPoint[],
  from: Date,
  to: Date,
  sites: readonly { start: Date; end: Date }[],
  depots: readonly LatLng[],
  params: DetectorParams,
  spikes: ReadonlySet<number>,
): DayTrailFacts {
  const idx: number[] = [];
  points.forEach((p, i) => {
    if (ms(p.fixAt) >= ms(from) && ms(p.fixAt) <= ms(to)) idx.push(i);
  });
  const dp = idx.map((i) => points[i]!);
  const out: DayTrailFacts = { kmGps: null, movingMin: null, atSitesMin: null, idleStops: 0, idleMin: 0, maxGapMin: null, gapMinOver5: null };
  if (!dp.length) return out;
  out.kmGps = kmBetween(points, from, to, spikes) ?? 0;
  let moving = 0;
  let maxGap = 0;
  let over5 = 0;
  for (let i = 0; i + 1 < dp.length; i++) {
    const g = minutes(dp[i]!.fixAt, dp[i + 1]!.fixAt);
    if (!isSlow(dp[i]!, params.movingKmh)) moving += g;
    maxGap = Math.max(maxGap, g);
    if (g > 5) over5 += g;
  }
  out.movingMin = moving;
  out.maxGapMin = maxGap;
  out.gapMinOver5 = over5;
  // Customer sites, overlaps counted once, inside [from, to].
  const clipped = sites
    .map((s) => [Math.max(ms(s.start), ms(from)), Math.min(ms(s.end), ms(to))] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let at = 0;
  let cur: [number, number] | null = null;
  for (const s of clipped) {
    if (cur && s[0] <= cur[1]) cur[1] = Math.max(cur[1], s[1]);
    else {
      if (cur) at += cur[1] - cur[0];
      cur = [s[0], s[1]];
    }
  }
  if (cur) at += cur[1] - cur[0];
  out.atSitesMin = at / MIN;
  // Idle elsewhere: slow runs of 3 min or more, not inside the customer sites (1 min of slack; two sites
  // that touch are one, so a standstill at a shared site between two stops is never "idle") and not at a depot.
  const merged: [number, number][] = [];
  for (const s of [...sites].map((x) => [ms(x.start), ms(x.end)] as [number, number]).sort((x, y) => x[0] - y[0])) {
    const lastM = merged[merged.length - 1];
    if (lastM && s[0] <= lastM[1] + MIN) lastM[1] = Math.max(lastM[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  const nearDepot = (c: LatLng) => depots.some((dpt) => distanceM(c, dpt) <= params.depotRadiusM + params.exitExtraM);
  for (const [a, b] of runsOf(dp.length, (i) => isSlow(dp[i]!, params.movingKmh))) {
    const s = dp[a]!.fixAt;
    const e = dp[b]!.fixAt;
    const m = minutes(s, e);
    if (m < SITE_RULES.idleMin) continue;
    if (merged.some(([x0, x1]) => ms(s) >= x0 - MIN && ms(e) <= x1 + MIN)) continue;
    const run = dp.slice(a, b + 1);
    const c = { lat: median(run.map((p) => p.lat))!, lng: median(run.map((p) => p.lng))! };
    if (nearDepot(c)) continue;
    out.idleStops++;
    out.idleMin += m;
  }
  return out;
}
