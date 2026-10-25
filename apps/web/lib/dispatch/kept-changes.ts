/**
 * Kept loads planned with older customer data (the changed-data warning). A re-plan keeps every LOCKED
 * and LOADING load exactly as it is - its stops, its times and the customer data they were planned with
 * (createNextVersionTx copies them; buildDispatchRequest sends only their frozen_trips) - so a customer
 * whose receiving hours, pin, small-truck mark or orders changed after its load was locked stayed
 * planned the old way without a word on the day screen or in the re-plan dialog. This report lists
 * those stops, says what changed (planned with A, now B) and whether the planned times still keep the
 * rules with the data now, and names the loads to put back to Planned, latest first, so a re-plan can
 * plan them with the data now.
 *
 * Pure (no database, browser-safe like snapshots.ts). The one loader is kept-changes-server.ts, read by
 * the day screen, the plan screen, the re-plan and GET /api/runs/:id/kept-changes, so they never
 * disagree. A kept stop's hours are judged with keptVisitOrders (keptStopLive): the plan screen's
 * "Changed after planning" note of a frozen stop reads the same (review W3; as before it with
 * KEPT_CHANGES=off, review S2).
 *
 * Never a refusal: a re-plan never changes a kept load, so a warning seen late costs one more solve,
 * never a wrong load. The unlock is the existing per-load Unlock (PATCH /api/runs/:id/loads/:loadId),
 * offered only for LOCKED loads; DISPATCHED and COMPLETED loads are never in the report (history).
 */
import { clockText, keptVisitOrders, promisedText, stopWindowFor, type OrderPlacement, type OrderTimeColumns } from './order-window';
import { stopMasterChanges, usableWindow, type LiveStopFacts, type MasterChange, type PlanRules, type StopSnapshot } from './snapshots';
import { hardWindowMiss } from './window-rule';
import { fmtDayMonth } from './time';

/** A pin moved at least this far (m) is a CHECK: the load's times were planned for the old place. Below it, still listed (from PIN_MOVED_M). */
export const KEPT_PIN_CHECK_M = 500;

export type KeptKind = 'HOURS' | 'LOCATION' | 'SMALL_TRUCK' | 'CUSTOMER_INACTIVE' | 'ORDER' | 'NEW_ORDER';
/** BREAKS: a rule fails with the data now. CHECK: the times or the place may be wrong - a person decides. STILL_OK: still keeps every rule. */
export type KeptEffect = 'BREAKS' | 'CHECK' | 'STILL_OK';
const RANK: Record<KeptEffect, number> = { STILL_OK: 0, CHECK: 1, BREAKS: 2 };

export interface KeptChange {
  kind: KeptKind;
  effect: KeptEffect;
  /** What the stop was planned with ("15:00–18:00"); null when there is nothing to say. */
  planned: string | null;
  /** What it is now ("08:00–18:00"). */
  now: string | null;
  /** One line for the box: what changed and what it means. */
  text: string;
  /** A few words for the dialog and the toast ("hours now 08:00–18:00 (planned with 15:00–18:00): still kept"). */
  short: string;
  /** HOURS: the hard hours now start earlier or end later than planned. */
  widened?: true;
}

export interface KeptStop {
  sequence: number;
  customerId: string;
  code: string;
  branchCode: string | null;
  name: string;
  /** A split delivery: part k of n (each part is its own stop). */
  split: { part: number; parts: number } | null;
  changes: KeptChange[];
}

/** A load named in an unlock: `changed` = it is itself in the report (else only unlocked because a truck's later loads go back first). */
export interface KeptLoadRef {
  loadId: string;
  truckId: string;
  loadNo: number;
  label: string;
  status: 'LOCKED' | 'LOADING';
  changed: boolean;
}

export interface KeptLoad {
  loadId: string;
  truckId: string;
  truckCode: string;
  loadNo: number;
  /** "T05 L2" */
  label: string;
  status: 'LOCKED' | 'LOADING';
  worst: KeptEffect;
  stops: KeptStop[];
  /**
   * Put back to Planned, in this order, so this load is planned again: every later LOCKED or LOADING load
   * of the truck, latest first, then this one (checkTransition refuses an unlock while a later load is
   * frozen). `blocked`: why it is not offered here (a load of the chain is being loaded).
   */
  unlock: { loads: KeptLoadRef[]; blocked: string | null };
}

export interface KeptReport {
  v: 1;
  /** Of the changes (not of times of day or names): the dialog sends it back (keptSeen) and the re-plan says when the list changed meanwhile. */
  fingerprint: string;
  loads: KeptLoad[];
  counts: { loads: number; stops: number; breaks: number; check: number };
}

/** One stop of a kept load, as the loader read it. */
export interface KeptStopInput {
  sequence: number;
  customerId: string;
  snapshot: StopSnapshot;
  split: { part: number; parts: number } | null;
  /** The stop's planned unloading (its first row). */
  serviceStartMin: number | null;
  departureMin: number | null;
  /**
   * A late arrival allowed by hand on this stop (moves by hand, allow anyway: the LATE allowance of its load whose
   * rows cover the stop's): the hours now are judged against what was agreed, never only against the hours.
   */
  allowance?: { maxLateMin: number; windowEndMin: number; reason: string; rule?: 'START' | 'FINISH' };
  /** The customer as the stop is judged now (keptStopLive). */
  live: LiveStopFacts;
  /**
   * `pinReplaced`: the stop is still planned at a point that was not usable when a new pin replaced it -
   * Loading and Dispatch of its load are refused (409 STOP_PIN_REPLACED, replaced-pin.ts) until a re-plan.
   */
  customer: { code: string; branchCode: string | null; name: string; active: boolean; smallTruckOnly: boolean; locationUsable: boolean; pinReplaced?: boolean };
  /** The stop's orders: cancelled since, or moved to a later day since (YYYY-MM-DD). */
  orders: { id: string; cancelled: boolean; carriedTo: string | null }[];
  /** Orders of the customer for the day that came after the stop was planned and are not on it, with where they are now. */
  newOrders: { id: string; cases: number; where: string }[];
}

export interface KeptLoadInput {
  loadId: string;
  truckId: string;
  truckCode: string;
  loadNo: number;
  status: 'LOCKED' | 'LOADING';
  /** The rules the load was planned with (its truck snapshot); null = before they were kept. */
  rules: PlanRules | null;
  /** The truck as it is now is a small truck (isSmallTruck with the company's setting now). */
  truckSmallNow: boolean;
  stops: KeptStopInput[];
}

/** Every load of the version, for the unlock chains. */
export interface TruckLoadRef {
  loadId: string;
  truckId: string;
  truckCode: string;
  loadNo: number;
  status: string;
}

export const keptLoadLabel = (truckCode: string, loadNo: number) => `${truckCode} L${loadNo}`;

const at = (m: number | null) => (m === null ? '--:--' : clockText(m));
/** The gate's tolerance (feasibility.ts TOL_MIN): the solver rounds seconds to minutes. */
const KEPT_TOL_MIN = 1;
const windowText = (s: number | null, e: number | null) => (s === null && e === null ? 'any time' : `${at(s)}–${at(e)}`);
const far = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
const list = (names: string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const noPeriod = (t: string) => t.trim().replace(/[.!?]+$/, '');

/**
 * The customer as a kept stop is judged now: its pin, name and address, and the hours of the orders it
 * was planned with (keptVisitOrders: never an order that came after it). The plan screen's frozen-stop
 * note (plan-detail.ts) and the loader both build it here.
 */
export function keptStopLive<T extends OrderTimeColumns & { id: string; lines: readonly { id: string; cases: number }[]; uploadedAt?: Date | string | null }>(
  customer: { name: string; address: string | null; lat: number | null; lng: number | null },
  eff: { hardStart: number | null; hardEnd: number | null; prefStart: number | null; prefEnd: number | null },
  visitOrders: readonly T[],
  placements: readonly OrderPlacement[],
  capturedAt: string | null,
): LiveStopFacts {
  const sw = stopWindowFor(eff, keptVisitOrders(visitOrders, placements, capturedAt));
  return {
    name: customer.name,
    address: customer.address,
    lat: customer.lat,
    lng: customer.lng,
    hardStartMin: sw.hardStart,
    hardEndMin: sw.hardEnd,
    prefStartMin: sw.prefStart,
    prefEndMin: sw.prefEnd,
    promised: sw.promised,
  };
}

function hoursChange(m: MasterChange, stop: KeptStopInput, load: KeptLoadInput): KeptChange {
  const snap = stop.snapshot;
  const then = usableWindow(snap.hardStartMin, snap.hardEndMin);
  const now = usableWindow(stop.live.hardStartMin, stop.live.hardEndMin);
  const planned = snap.promised ? promisedText(snap.promised) : windowText(then.start, then.end);
  const nowText = stop.live.promised ? promisedText(stop.live.promised) : windowText(now.start, now.end);
  const hardSame = then.start === now.start && then.end === now.end && planned === nowText;
  const widened =
    (then.start !== null && (now.start === null || now.start < then.start)) || (then.end !== null && (now.end === null || now.end > then.end));
  const start = stop.serviceStartMin;
  let effect: KeptEffect;
  let means: string;
  if (hardSame) {
    effect = 'STILL_OK';
    means = 'Only the preferred hours changed: the planned unloading keeps the receiving hours.';
  } else if (start === null) {
    effect = 'CHECK';
    means = 'The planned unloading time is not known: check it with these hours.';
  } else if (!hardWindowMiss(start, stop.departureMin, now.start, now.end, load.rules?.windowRule ?? null)) {
    effect = 'STILL_OK';
    means = `The planned unloading at ${at(start)} still keeps them.`;
  } else if (stop.allowance && now.end !== null && !(now.start !== null && start < now.start)) {
    // A late arrival was allowed by hand (agreed with the customer): judged against what was agreed.
    const a = stop.allowance;
    const atMin = a.rule === 'FINISH' && stop.departureMin !== null ? stop.departureMin : start;
    const late = Math.max(1, Math.round(atMin - now.end));
    const agreed = `Allowed by hand to arrive up to ${a.maxLateMin} min late (${a.reason}); with the hours now it is ${late} min late`;
    if (late <= a.maxLateMin + KEPT_TOL_MIN) {
      effect = 'CHECK';
      means = `${agreed}: check with the customer.`;
    } else {
      effect = 'BREAKS';
      means = `${agreed}, more than the ${a.maxLateMin} min allowed by hand.`;
    }
  } else if ((now.start !== null && start < now.start) || (now.end !== null && start > now.end)) {
    effect = 'BREAKS';
    means = `The planned unloading at ${at(start)} is outside them.`;
  } else {
    effect = 'BREAKS';
    means = `The planned unloading ends at ${at(stop.departureMin)}, after they end (${at(now.end)}): this load was planned with unloading finished by closing.`;
  }
  return {
    kind: 'HOURS',
    effect,
    planned,
    now: nowText,
    text: `${noPeriod(m.text)}. ${means}`,
    short: hardSame
      ? 'preferred hours changed: still kept'
      : `hours now ${nowText} (planned with ${planned}): ${effect === 'STILL_OK' ? 'still kept' : effect === 'BREAKS' ? 'the planned unloading is outside them' : 'check the time'}`,
    ...(widened && !hardSame ? { widened: true as const } : {}),
  };
}

const STILL_THE_PLANNED_PIN = 'The load still goes to the pin it was planned with (its sheets add "New pin - ask the dispatcher which one to use" with the new pin).';
const NO_LOCATION = 'No usable location now: Loading and Dispatch of this load are refused until the location is fixed (a re-plan after an unlock leaves the stop unserved).';
/** The location gate's STOP_PIN_REPLACED in the box's words (review W-4 of the warning). */
const OLD_POINT_NOT_USABLE =
  'The stop still goes to its old point, which was not usable when the new pin replaced it: Loading and Dispatch of this load are refused until it is unlocked and re-planned.';

function locationChange(m: MasterChange | undefined, stop: KeptStopInput): KeptChange | null {
  if (!stop.customer.locationUsable) {
    return { kind: 'LOCATION', effect: 'BREAKS', planned: null, now: null, text: m ? `${noPeriod(m.text)}. ${NO_LOCATION}` : NO_LOCATION, short: 'no usable location now' };
  }
  if (stop.customer.pinReplaced) {
    // The location gate refuses this load (STOP_PIN_REPLACED): never "still OK" or only "check".
    const moved = m?.movedM ?? null;
    return {
      kind: 'LOCATION',
      effect: 'BREAKS',
      planned: null,
      now: moved === null ? null : far(moved),
      text: m ? `${noPeriod(m.text)}. ${OLD_POINT_NOT_USABLE}` : OLD_POINT_NOT_USABLE,
      short: 'new pin, but planned at the old point that was not usable: Loading and Dispatch refused',
    };
  }
  if (!m) return null;
  const moved = m.movedM ?? null;
  const check = moved === null || moved >= KEPT_PIN_CHECK_M;
  return {
    kind: 'LOCATION',
    effect: check ? 'CHECK' : 'STILL_OK',
    planned: null,
    now: moved === null ? null : far(moved),
    text: `${noPeriod(m.text)}. ${STILL_THE_PLANNED_PIN}${check ? ' Its times were planned for the old place: check them, or unlock and re-plan.' : ''}`,
    short: moved === null ? 'pin added after planning (still planned without it)' : `pin moved ${far(moved)} (still planned at the old pin)`,
  };
}

/** What changed on one kept stop since it was planned, hours first (empty = nothing that matters). */
export function keptStopChanges(stop: KeptStopInput, load: KeptLoadInput): KeptChange[] {
  const out: KeptChange[] = [];
  const master = stopMasterChanges(stop.snapshot, stop.live);
  const hours = master.find((c) => c.kind === 'HOURS');
  if (hours) out.push(hoursChange(hours, stop, load));
  const loc = locationChange(
    master.find((c) => c.kind === 'LOCATION'),
    stop,
  );
  if (loc) out.push(loc);
  if (stop.customer.smallTruckOnly && !load.truckSmallNow) {
    out.push({
      kind: 'SMALL_TRUCK',
      effect: 'BREAKS',
      planned: null,
      now: null,
      text: `Small truck only now, and ${load.truckCode} is not a small truck: Loading and Dispatch of this load are refused (SMALL_TRUCK_ONLY). Unlock and re-plan to put the stop on a small truck.`,
      short: 'small truck only, on a truck that is not small',
    });
  }
  if (!stop.customer.active) {
    out.push({
      kind: 'CUSTOMER_INACTIVE',
      effect: 'CHECK',
      planned: null,
      now: null,
      text: 'Customer deactivated after planning: check this delivery should still go.',
      short: 'customer deactivated',
    });
  }
  const cancelled = stop.orders.filter((o) => o.cancelled).length;
  const carried = [...new Set(stop.orders.filter((o) => !o.cancelled && o.carriedTo).map((o) => o.carriedTo!))].sort();
  const carriedN = stop.orders.filter((o) => !o.cancelled && o.carriedTo).length;
  if (cancelled || carriedN) {
    const parts = [
      cancelled ? `${cancelled === 1 ? 'an order' : `${cancelled} orders`} of this stop ${cancelled === 1 ? 'was' : 'were'} cancelled` : '',
      carriedN ? `${carriedN === 1 ? 'an order' : `${carriedN} orders`} of this stop ${carriedN === 1 ? 'was' : 'were'} moved to ${carried.map(fmtDayMonth).join(', ')}` : '',
    ].filter(Boolean);
    const said = parts.join(', and ');
    out.push({
      kind: 'ORDER',
      effect: 'BREAKS',
      planned: null,
      now: null,
      text: `${said.charAt(0).toUpperCase()}${said.slice(1)} after planning: Loading and Dispatch of this load are refused until it is unlocked and re-planned.`,
      short: [cancelled ? 'order cancelled' : '', carriedN ? 'order moved to a later day' : ''].filter(Boolean).join(', '),
    });
  }
  if (stop.newOrders.length) {
    const n = stop.newOrders.length;
    const cases = stop.newOrders.reduce((a, o) => a + o.cases, 0);
    const where = [...new Set(stop.newOrders.map((o) => o.where))];
    out.push({
      kind: 'NEW_ORDER',
      effect: 'STILL_OK',
      planned: null,
      now: null,
      text: `${n === 1 ? 'A new order' : `${n} new orders`} of this customer (${cases} cases) came after this load was planned: ${n === 1 ? 'it is' : 'they are'} another visit (${where.join('; ')}).`,
      short: 'new order: another visit',
    });
  }
  return out;
}

function blockedText(self: KeptLoadRef, chain: KeptLoadRef[]): string | null {
  const loading = chain.find((x) => x.status === 'LOADING');
  if (!loading) return null;
  if (loading.loadId === self.loadId) {
    return `${self.label} is being loaded: RouteIQ does not unlock a loading load from here. If its cases can still come off, press Back to locked on it first.`;
  }
  return `${loading.label} is being loaded, and a truck's later loads go back to Planned first. If its cases can still come off, press Back to locked on ${loading.label} first.`;
}

/**
 * The report of the version's kept loads (`loads`: its LOCKED and LOADING loads with their stops; any
 * other status is ignored). `allLoads`: every load of the version (the unlock chains). Loads with BREAKS
 * first, then by truck and load.
 */
export function keptReport(loads: readonly KeptLoadInput[], allLoads: readonly TruckLoadRef[]): KeptReport {
  const found: Omit<KeptLoad, 'unlock'>[] = [];
  for (const l of loads) {
    if (l.status !== 'LOCKED' && l.status !== 'LOADING') continue;
    const stops: KeptStop[] = [];
    for (const s of l.stops) {
      const changes = keptStopChanges(s, l);
      if (!changes.length) continue;
      stops.push({ sequence: s.sequence, customerId: s.customerId, code: s.customer.code, branchCode: s.customer.branchCode, name: s.customer.name, split: s.split, changes });
    }
    if (!stops.length) continue;
    stops.sort((a, b) => a.sequence - b.sequence);
    const worst = stops.flatMap((s) => s.changes).reduce<KeptEffect>((w, c) => (RANK[c.effect] > RANK[w] ? c.effect : w), 'STILL_OK');
    found.push({ loadId: l.loadId, truckId: l.truckId, truckCode: l.truckCode, loadNo: l.loadNo, label: keptLoadLabel(l.truckCode, l.loadNo), status: l.status, worst, stops });
  }
  const changedIds = new Set(found.map((l) => l.loadId));
  const ref = (x: TruckLoadRef): KeptLoadRef => ({
    loadId: x.loadId,
    truckId: x.truckId,
    loadNo: x.loadNo,
    label: keptLoadLabel(x.truckCode, x.loadNo),
    status: x.status === 'LOADING' ? 'LOADING' : 'LOCKED',
    changed: changedIds.has(x.loadId),
  });
  const out: KeptLoad[] = found.map((l) => {
    const later = allLoads
      .filter((x) => x.truckId === l.truckId && x.loadNo > l.loadNo && (x.status === 'LOCKED' || x.status === 'LOADING'))
      .sort((a, b) => b.loadNo - a.loadNo)
      .map(ref);
    const self: KeptLoadRef = { loadId: l.loadId, truckId: l.truckId, loadNo: l.loadNo, label: l.label, status: l.status, changed: true };
    const chain = [...later, self];
    return { ...l, unlock: { loads: chain, blocked: blockedText(self, chain) } };
  });
  out.sort((a, b) => Number(b.worst === 'BREAKS') - Number(a.worst === 'BREAKS') || a.truckCode.localeCompare(b.truckCode) || a.loadNo - b.loadNo);
  return {
    v: 1,
    fingerprint: keptFingerprint(out),
    loads: out,
    counts: {
      loads: out.length,
      stops: out.reduce((a, l) => a + l.stops.length, 0),
      breaks: out.filter((l) => l.worst === 'BREAKS').length,
      check: out.filter((l) => l.worst === 'CHECK').length,
    },
  };
}

/** FNV-1a (32 bit) of the sorted changes - load, stop, kind, planned, now - the same in the browser and the server. */
export function keptFingerprint(loads: readonly Pick<KeptLoad, 'loadId' | 'stops'>[]): string {
  const keys = loads.flatMap((l) => l.stops.flatMap((s) => s.changes.map((c) => `${l.loadId}|${s.sequence}|${c.kind}|${c.planned ?? ''}|${c.now ?? ''}`))).sort();
  let h = 0x811c9dc5;
  const text = keys.join('\n');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const statusWord = (s: 'LOCKED' | 'LOADING') => (s === 'LOADING' ? 'being loaded' : 'locked');
const stopName = (s: KeptStop) => `${s.branchCode ? `${s.code}/${s.branchCode}` : s.code}${s.split ? ` (part ${s.split.part} of ${s.split.parts})` : ''}`;

/** One line per changed stop, for the re-plan dialog and its answer: "T05 L2 (locked): C007 - hours now ...". At most `max`, and how many more. */
export function keptLines(r: KeptReport | null | undefined, max = 6): { lines: string[]; more: number } {
  const all = (r?.loads ?? []).flatMap((l) => l.stops.map((s) => `${l.label} (${statusWord(l.status)}): ${stopName(s)} - ${s.changes.map((c) => c.short).join('; ')}`));
  return { lines: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/** The box's Unlock button: every load that goes back to Planned ("Unlock T05 L3 and T05 L2"). */
export function unlockButtonText(l: Pick<KeptLoad, 'unlock'>): string {
  return `Unlock ${list(l.unlock.loads.map((x) => x.label))}`;
}

/**
 * Why loads without a change go back too (review W5) - they may be loaded trucks too: "No change on
 * T05 L3: a truck's later loads go back to Planned before its earlier ones." Null: every load changed.
 */
export function unlockAlsoText(l: Pick<KeptLoad, 'unlock'>): string | null {
  const others = l.unlock.loads.filter((x) => !x.changed).map((x) => x.label);
  return others.length ? `No change on ${list(others)}: a truck's later loads go back to Planned before its earlier ones.` : null;
}

/**
 * The dialog's choice (review W5, W-6): "Unlock T05 L3 and T05 L2 first (no change on T05 L3: a truck's
 * later loads go back to Planned before its earlier ones)".
 */
export function unlockOfferText(l: Pick<KeptLoad, 'unlock'>): string {
  const also = unlockAlsoText(l);
  return `${unlockButtonText(l)} first${also ? ` (${also.charAt(0).toLowerCase()}${noPeriod(also).slice(1)})` : ''}`;
}

/** The ticked offers of the dialog as one list of loads: each once, a truck's later loads first. */
export function mergeUnlocks(offers: readonly (readonly KeptLoadRef[])[]): KeptLoadRef[] {
  const byId = new Map<string, KeptLoadRef>();
  const trucks: string[] = [];
  for (const o of offers) {
    for (const x of o) {
      if (!trucks.includes(x.truckId)) trucks.push(x.truckId);
      const seen = byId.get(x.loadId);
      byId.set(x.loadId, seen ? { ...seen, changed: seen.changed || x.changed } : x);
    }
  }
  return [...byId.values()].sort((a, b) => trucks.indexOf(a.truckId) - trucks.indexOf(b.truckId) || b.loadNo - a.loadNo);
}

/** The audit's record of a report (PLAN_VERSION_CREATED keptChanged, LOAD_PLANNED keptChanges): codes and kinds only, no names, addresses or pins; at most `max` stops. */
export interface KeptAuditRow {
  load: string;
  status: 'LOCKED' | 'LOADING';
  customer: string;
  kinds: KeptKind[];
  effect: KeptEffect;
  /** HOURS only: the hours planned with and now. */
  planned?: string;
  now?: string;
}

export function keptAudit(r: KeptReport | null | undefined, max = 50): { rows: KeptAuditRow[]; truncated: number } {
  const all: KeptAuditRow[] = (r?.loads ?? []).flatMap((l) =>
    l.stops.map((s) => {
      const hours = s.changes.find((c) => c.kind === 'HOURS');
      const effect = s.changes.reduce<KeptEffect>((w, c) => (RANK[c.effect] > RANK[w] ? c.effect : w), 'STILL_OK');
      return {
        load: l.label,
        status: l.status,
        customer: s.branchCode ? `${s.code}/${s.branchCode}` : s.code,
        kinds: s.changes.map((c) => c.kind),
        effect,
        ...(hours?.planned ? { planned: hours.planned } : {}),
        ...(hours?.now ? { now: hours.now } : {}),
      };
    }),
  );
  return { rows: all.slice(0, max), truncated: Math.max(0, all.length - max) };
}

/**
 * The `keptSeen` a re-plan sends after unlocking some of the listed loads (review S1 / W-2): the
 * fingerprint of the dialog's report without the loads now back to Planned - the re-plan reads the
 * report again after the unlock, where they are no longer listed, so the dialog's own fingerprint would
 * always read as "changed meanwhile". Undefined: no report was shown (nothing to compare).
 */
export function keptSeenAfter(r: Pick<KeptReport, 'loads' | 'fingerprint'> | null | undefined, unlocked: readonly Pick<KeptLoadRef, 'loadId'>[]): string | undefined {
  if (!r) return undefined;
  if (!unlocked.length) return r.fingerprint;
  const gone = new Set(unlocked.map((l) => l.loadId));
  return keptFingerprint(r.loads.filter((l) => !gone.has(l.loadId)));
}

/** The 202 answer of a re-plan (`kept`): what stays kept with older data; `unseen` = the list changed since the dialog showed it (keptSeen). */
export interface KeptEcho {
  loads: number;
  breaks: number;
  labels: string[];
  lines: string[];
  more: number;
  fingerprint: string;
  unseen: boolean;
}

export function keptEcho(r: KeptReport | null | undefined, seen: string | null | undefined): KeptEcho | null {
  if (!r?.loads.length) return null;
  const { lines, more } = keptLines(r);
  return { loads: r.loads.length, breaks: r.counts.breaks, labels: r.loads.map((l) => l.label), lines, more, fingerprint: r.fingerprint, unseen: !!seen && seen !== r.fingerprint };
}

/** The re-plan toast's line for the loads still kept with older data ("Kept as planned, with older customer data: T05 L2."). */
export function keptEchoText(e: Pick<KeptEcho, 'labels'> | null | undefined): string | null {
  return e?.labels.length ? `Kept as planned, with older customer data: ${list(e.labels)}.` : null;
}

// ---------------------------------------------------------------------------------------
// The unlock from the warning (the screens; client side, one load at a time)
// ---------------------------------------------------------------------------------------

/** checkTransition's answer when the load is Planned already (load-state.ts): another dispatcher unlocked it meanwhile. */
const ALREADY_PLANNED = /^Load is already PLANNED\b/;

/**
 * Put `loads` back to Planned in their order (latest first), stopping at the first refusal - another
 * dispatcher moved one to Loading, the plan is optimizing, a later load was locked meanwhile. What was
 * unlocked stays unlocked: a PLANNED load loses nothing and can be locked again. A load already Planned
 * (another dispatcher unlocked it meanwhile) is where it should be: counted as unlocked, and the chain
 * goes on (review N2).
 */
export async function unlockKeptLoads(
  loads: readonly KeptLoadRef[],
  unlock: (l: KeptLoadRef) => Promise<{ ok: boolean; error: string | null }>,
): Promise<{ unlocked: KeptLoadRef[]; failed: { load: KeptLoadRef; error: string } | null }> {
  const unlocked: KeptLoadRef[] = [];
  for (const l of loads) {
    const r = await unlock(l);
    if (!r.ok && !ALREADY_PLANNED.test(r.error ?? '')) return { unlocked, failed: { load: l, error: r.error ?? 'refused' } };
    unlocked.push(l);
  }
  return { unlocked, failed: null };
}

/** "T05 L2 is back to Planned", "T05 L3 and T05 L2 are back to Planned". */
export function backToPlannedText(loads: readonly Pick<KeptLoadRef, 'label'>[]): string {
  return `${list(loads.map((l) => l.label))} ${loads.length === 1 ? 'is' : 'are'} back to Planned`;
}

/** The started re-plan's toast after an unlock (review W-8): the new plan is only being optimized yet, and can still fail. */
export function unlockedReplanText(unlocked: readonly Pick<KeptLoadRef, 'label'>[]): string {
  const one = unlocked.length === 1;
  return `${backToPlannedText(unlocked)} and ${one ? 'is' : 'are'} being re-planned with the data now; print ${one ? 'its sheet' : 'their sheets'} again when the new plan is ready.`;
}

/** An unlock stopped at a refusal: what was unlocked, what was refused and why; `beforeReplan`: and that no re-plan was started. */
export function unlockStoppedText(res: { unlocked: readonly KeptLoadRef[]; failed: { load: KeptLoadRef; error: string } }, beforeReplan = true): string {
  return `${res.unlocked.length ? `${backToPlannedText(res.unlocked)}. ` : ''}${res.failed.load.label} could not be unlocked: ${noPeriod(res.failed.error)}.${beforeReplan ? ' Re-plan not started.' : ''}`;
}

/** The unlock worked, then the re-plan was refused (busy, optimizing, a quota): the loads stay Planned (review W7). */
export function replanNotStartedText(unlocked: readonly Pick<KeptLoadRef, 'label'>[], reason: string | null): string {
  return `${backToPlannedText(unlocked)}; re-plan not started: ${noPeriod(reason ?? 'refused') || 'refused'}. Press RE-PLAN again, or Lock the load again to keep it as it was.`;
}

/**
 * The re-plan after an unlock (review W6): a manual adjustment, so the unlocked stops prefer the truck
 * they were on (plan continuity), with a note naming the loads - unless the late-order re-plan was asked,
 * which has continuity too. Never a REOPTIMIZE (review W-1): the server turns REOPTIMIZE into LATE_ORDER
 * only for a late or brought-forward order, so with only on-time orders waiting it stayed a full
 * re-optimize, and the unlocked stops (maybe on the truck already) could move to other trucks. The server
 * keeps any other reason as sent, and plans waiting late orders all the same. Nothing unlocked: as asked.
 */
export function keptReplanBody<R extends string>(asked: R, unlocked: readonly Pick<KeptLoadRef, 'label'>[]): { reason: R | 'MANUAL_ADJUSTMENT'; note?: string } {
  if (!unlocked.length) return { reason: asked };
  const note = `Unlocked for changed customer data: ${unlocked.map((l) => l.label).join(', ')}`.slice(0, 500);
  return { reason: asked === 'LATE_ORDER' ? asked : 'MANUAL_ADJUSTMENT', note };
}

/** The re-plan dialog's part about kept loads (SearchModeQuestion.kept). */
export interface KeptQuestion {
  lines: string[];
  more: number;
  offers: { id: string; label: string; loads: KeptLoadRef[]; blocked: string | null }[];
}

/** The dialog's list and offers from a report: one offer per changed load (its own unlock chain only, no join - owner decision). Null = nothing kept with older data. */
export function keptQuestion(r: KeptReport | null | undefined): KeptQuestion | null {
  if (!r?.loads.length) return null;
  const { lines, more } = keptLines(r);
  return { lines, more, offers: r.loads.map((l) => ({ id: l.loadId, label: unlockOfferText(l), loads: l.unlock.loads, blocked: l.unlock.blocked })) };
}

/** The box's lead (Step 3 and the plan screen). */
export const KEPT_BOX_LEAD =
  'RE-PLAN keeps locked and loading loads exactly as they are, with the data they were planned with. To plan a stop with the data now, put its load back to Planned (Unlock) and re-plan. Unlock only a load whose cases are not on the truck yet, or can come off.';

/**
 * The re-plan dialog's line about what a re-plan keeps (review W-7): as before when no kept load is
 * listed; with kept loads, loading loads too, and the unlock below only when one can be ticked.
 */
export function keptReplanNote(q: Pick<KeptQuestion, 'offers'> | null | undefined): string {
  if (!q) return 'Locked and dispatched loads stay exactly as they are.';
  return q.offers.some((o) => !o.blocked)
    ? 'Locked, loading and dispatched loads stay exactly as they are; you can unlock the locked ones listed below first.'
    : 'Locked, loading and dispatched loads stay exactly as they are.';
}

/** The dialog's words above its unlock choices. */
export const KEPT_DIALOG_LEAD =
  'A re-plan keeps these loads as they are. Tick a load to put it back to Planned first, so the re-plan plans it with the data now - only if its cases are not on the truck yet, or can come off.';

/** Asked before the box's Unlock (several loads may go back, possibly loaded the night before). */
export function unlockConfirmText(loads: readonly Pick<KeptLoadRef, 'label' | 'changed'>[]): string {
  const others = loads.filter((x) => !x.changed).map((x) => x.label);
  return `Put ${list(loads.map((l) => l.label))} back to Planned?${others.length ? ` ${list(others)} ${others.length === 1 ? 'goes' : 'go'} back too, although nothing changed on ${others.length === 1 ? 'it' : 'them'}: a truck's later loads go back to Planned first.` : ''} Do this only if the cases are not on the truck yet, or can come off. Then RE-PLAN.`;
}

/** After an unlock from the box: what next. */
export function unlockedNextText(unlocked: readonly Pick<KeptLoadRef, 'label'>[]): string {
  return `${backToPlannedText(unlocked)}. RE-PLAN to plan ${unlocked.length === 1 ? 'it' : 'them'} with the customer data now; if cases are on the truck already, unload only what the new plan moves, and print the sheets again.`;
}
