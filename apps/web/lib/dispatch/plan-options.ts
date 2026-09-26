/**
 * The plan options table (plan screen and the Excel SUMMARY), stabilization PR7.
 *
 * - B3: an option's trucks are the PHYSICAL trucks of the day with that option: the trucks of its
 *   new loads plus the trucks of the locked, loading and dispatched loads it was planned around.
 *   (Before PR7 the optimizer counted only the trucks of the new loads, so after a re-plan the
 *   options and the job message showed fewer trucks than the day uses.) Counted here from the
 *   stored loads, so options saved by an older optimizer are shown right too.
 * - N1: what each option gains over the others. RECOMMENDED also values early delivery of the
 *   high priorities (P1/P2) and preferred receiving hours, which MIN TRUCKS and MIN DISTANCE
 *   ignore; that is why it often costs more. Each option says what it gains and what it gives up,
 *   in minutes and OMR, or that it is the same plan.
 *
 * Pure: no database. plan-detail.ts builds the facts, the screen and the workbook print the text.
 */
import type { PlannedLoad, PreferencePenalties } from '@routeiq/shared-types';

/** Distinct physical trucks: the new loads' trucks + the trucks of the frozen loads (B3). */
export function physicalTruckCount(newLoads: readonly { truck_id: string }[], frozenTruckIds: Iterable<string>): number {
  return new Set([...newLoads.map((l) => l.truck_id), ...frozenTruckIds]).size;
}

/** The locked / loading / dispatched loads a dispatch request was built around (its trucks' frozen trips). */
export function frozenOfRequest(trucks: readonly { id: string; frozen_trips?: readonly unknown[] | null }[]): { truckIds: string[]; loads: number } {
  const withFrozen = trucks.filter((t) => (t.frozen_trips?.length ?? 0) > 0);
  return { truckIds: withFrozen.map((t) => t.id), loads: withFrozen.reduce((a, t) => a + (t.frozen_trips?.length ?? 0), 0) };
}

/** An option's preference figures, in OMR-equivalent (not money). */
export interface PreferenceFigures {
  /**
   * What the RECOMMENDED objective adds on top of money: minutes outside preferred hours, the
   * early-delivery push for high priorities and orders moved to another truck on a late-order
   * re-plan. Null when the option was saved by an optimizer that did not report the parts
   * (`preference_penalties`, before stabilization PR5 - every plan made on main).
   */
  total: number | null;
  /**
   * The preferred-hours part alone: `preference_penalties.window`, or for an older option the
   * objective's `window_penalty` (the only part it reports). Null when neither is known.
   */
  preferredHours: number | null;
}

/**
 * The preference cost of an option. An older option (no `preference_penalties`) has only its
 * preferred-hours part: its total is unknown, never the preferred-hours part under the total's
 * name (PR7 review: "preference cost 11.6 OMR lower" on a plan that delivers P1/P2 68 min later).
 */
export function preferenceFigures(pp: PreferencePenalties | null | undefined, windowPenalty?: number | null): PreferenceFigures {
  if (pp) return { total: round2(pp.window + pp.early + pp.continuity), preferredHours: round2(pp.window) };
  return { total: null, preferredHours: typeof windowPenalty === 'number' ? round2(windowPenalty) : null };
}

/** Same trucks carrying the same loads, stops in the same order = the same plan. */
export function planSignature(loads: readonly Pick<PlannedLoad, 'truck_id' | 'load_no' | 'stops'>[]): string {
  return loads
    .map((l) => `${l.truck_id}#${l.load_no}:${l.stops.map((s) => s.stop_id).join(',')}`)
    .sort()
    .join('|');
}

/** Priorities RECOMMENDED pushes to be delivered early: those with an early preference above 0 (default P1, P2). */
export function earlyPriorities(earlyPreferencePerMin: Record<string, number> | null | undefined): number[] {
  if (!earlyPreferencePerMin) return [1, 2];
  return Object.entries(earlyPreferencePerMin)
    .filter(([, v]) => typeof v === 'number' && v > 0)
    .map(([p]) => Number(p))
    .filter((p) => Number.isInteger(p))
    .sort((a, b) => a - b);
}

/**
 * Service start (min) of each served stop of the early priorities, by stop id, from an option's
 * new loads. `priorityOf` gives a stop's priority (the plan inputs, or its orders' priorities).
 */
export function earlyStarts(
  loads: readonly Pick<PlannedLoad, 'stops'>[],
  priorities: readonly number[],
  priorityOf: (stop: PlannedLoad['stops'][number]) => number | null,
): Record<string, number> {
  const want = new Set(priorities);
  const out: Record<string, number> = {};
  for (const l of loads) {
    for (const s of l.stops) {
      const p = priorityOf(s);
      if (p !== null && want.has(p)) out[s.stop_id] = s.service_start_min;
    }
  }
  return out;
}

export interface OptionFacts {
  name: string;
  /** The option has a plan (OPTIMIZED); options without one get no trade-off text. */
  usable: boolean;
  /** Physical trucks of the day with this option (B3). */
  trucks: number;
  /** Loads of the day with this option (kept + new). */
  loads: number;
  /** The whole day's km with this option: the kept loads' + its new loads' (the kept part is the same for every option). */
  km: number;
  /** The whole day's operating cost with this option (OMR). */
  dayCost: number;
  /** preferenceFigures().total: null when unknown (an option saved before the optimizer reported the parts). */
  preferenceCost: number | null;
  /** preferenceFigures().preferredHours: compared instead when a total is unknown. */
  preferredHoursCost: number | null;
  /** Unserved orders. */
  unserved: number;
  signature: string;
  /** earlyStarts(): stop id -> service start of the early priorities. */
  earlyStarts: Record<string, number>;
}

export interface OptionTradeoff {
  /** One line for the table: "Same plan as RECOMMENDED", or "vs MIN TRUCKS: <gains>; but <what it gives up>". */
  text: string;
  /** The option this one is compared with (null: same plan everywhere, or nothing to compare). */
  versus: string | null;
  gains: string[];
  givesUp: string[];
}

export const label = (name: string) => name.replace('_', ' ');
const round2 = (x: number) => Math.round(x * 100) / 100;
const omr = (x: number) => `${Math.abs(x).toFixed(1)} OMR`;
/** "2 fewer trucks", "1 more load". */
const count = (n: number, more: boolean, one: string) => `${Math.abs(n)} ${more ? 'more' : 'fewer'} ${Math.abs(n) === 1 ? one : `${one}s`}`;

/** Average minutes by which `a` delivers the early priorities LATER than `b`, over the stops both serve. */
function laterBy(a: OptionFacts, b: OptionFacts): number | null {
  const common = Object.keys(a.earlyStarts).filter((k) => k in b.earlyStarts);
  if (!common.length) return null;
  return common.reduce((s, k) => s + (a.earlyStarts[k] - b.earlyStarts[k]), 0) / common.length;
}

/** What `a` gains over `b` and what it gives up (thresholds: 0.05 OMR, 0.5 km, 1 min). */
function compare(a: OptionFacts, b: OptionFacts, early: string): { gains: string[]; givesUp: string[] } {
  const gains: string[] = [];
  const givesUp: string[] = [];
  const put = (better: boolean, text: string) => (better ? gains : givesUp).push(text);
  if (a.unserved !== b.unserved) put(a.unserved < b.unserved, `${count(a.unserved - b.unserved, a.unserved < b.unserved, 'order')} served`);
  const late = laterBy(a, b);
  if (late !== null && Math.abs(late) >= 1) put(late < 0, `${early} delivered on average ${Math.round(Math.abs(late))} min ${late < 0 ? 'earlier' : 'later'}`);
  // The whole preference cost only when both options report it; an older option has only the
  // preferred-hours part, which is then compared under its own name.
  const [pa, pb, what] =
    a.preferenceCost !== null && b.preferenceCost !== null
      ? [a.preferenceCost, b.preferenceCost, 'preference cost']
      : [a.preferredHoursCost, b.preferredHoursCost, 'preferred-hours cost'];
  if (pa !== null && pb !== null && Math.abs(pa - pb) >= 0.05) put(pa < pb, `${what} ${omr(pa - pb)} ${pa < pb ? 'lower' : 'higher'}`);
  if (Math.abs(a.dayCost - b.dayCost) >= 0.05) put(a.dayCost < b.dayCost, a.dayCost < b.dayCost ? `${omr(a.dayCost - b.dayCost)} cheaper` : `costs ${omr(a.dayCost - b.dayCost)} more`);
  if (Math.abs(a.km - b.km) >= 0.5) put(a.km < b.km, `${Math.round(Math.abs(a.km - b.km))} km ${a.km < b.km ? 'less' : 'more'}`);
  if (a.trucks !== b.trucks) put(a.trucks < b.trucks, count(a.trucks - b.trucks, a.trucks > b.trucks, 'truck'));
  if (a.loads !== b.loads) put(a.loads < b.loads, count(a.loads - b.loads, a.loads > b.loads, 'load'));
  return { gains, givesUp };
}

function sentence(versus: string, gains: string[], givesUp: string[]): string {
  const g = gains.length ? gains.join(', ') : 'no gain';
  return `vs ${label(versus)}: ${g}${givesUp.length ? `; but ${givesUp.join(', ')}` : ''}`;
}

/**
 * The trade-off line of every option, by name (N1). RECOMMENDED is compared with the cheapest
 * option that is a different plan; each alternative with RECOMMENDED. Identical plans say so.
 * `early` names the early priorities ("P1/P2").
 */
export function optionTradeoffs(options: readonly OptionFacts[], early = 'P1/P2'): Record<string, OptionTradeoff> {
  const out: Record<string, OptionTradeoff> = {};
  const usable = options.filter((o) => o.usable);
  const rec = usable.find((o) => o.name === 'RECOMMENDED') ?? null;
  const same = (o: OptionFacts) => (x: OptionFacts) => x !== o && x.signature === o.signature;
  if (usable.length > 1 && usable.every((o) => o.signature === usable[0].signature)) {
    for (const o of usable) out[o.name] = { text: 'Same plan as the other options', versus: null, gains: [], givesUp: [] };
    return out;
  }
  for (const o of usable) {
    if (!rec) {
      out[o.name] = { text: '', versus: null, gains: [], givesUp: [] };
      continue;
    }
    if (o === rec) {
      const others = usable.filter((x) => x !== rec && x.signature !== rec.signature);
      if (!others.length) {
        out[o.name] = { text: '', versus: null, gains: [], givesUp: [] };
        continue;
      }
      // The cheapest different plan: what the dispatcher would otherwise pick on cost.
      const ref = others.reduce((a, b) => (b.dayCost < a.dayCost - 1e-9 || (Math.abs(b.dayCost - a.dayCost) < 1e-9 && b.km < a.km) ? b : a));
      const c = compare(rec, ref, early);
      out[o.name] = { text: sentence(ref.name, c.gains, c.givesUp), versus: ref.name, ...c };
      continue;
    }
    if (o.signature === rec.signature) {
      out[o.name] = { text: 'Same plan as RECOMMENDED', versus: rec.name, gains: [], givesUp: [] };
      continue;
    }
    // Same plan as an alternative listed before it: that row explains it.
    const twin = usable.slice(0, usable.indexOf(o)).find(same(o));
    if (twin) {
      out[o.name] = { text: `Same plan as ${label(twin.name)}`, versus: twin.name, gains: [], givesUp: [] };
      continue;
    }
    const c = compare(o, rec, early);
    out[o.name] = { text: sentence(rec.name, c.gains, c.givesUp), versus: rec.name, ...c };
  }
  return out;
}
