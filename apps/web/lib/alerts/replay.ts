/**
 * Operations alerts (owner request 16 Oct 2026, design §PR-2.16): the replay. Pure: given a saved day
 * (AlertDayExport, written read-only by replay-export.ts, never kept in the repository: it holds customer
 * names and driver notes), it rebuilds the facts "as of" each time t of the day, runs the same rules
 * (rules.ts) and the same store semantics (store.ts planApply, in memory), and reports which alerts the
 * day would have produced: per rule how many were raised, kept as history, escalated and reopened, the
 * first time, a few sample texts, and the timeline. Nothing is written and nothing is e-mailed.
 *
 * "As of t" (critique L12: a visit is rebuilt from its events, so masking the stored visit's times is
 * not the state at t):
 * - a load's status and its Loading / Dispatch times come from its status moves (the LOAD_<status> audit
 *   rows of the load and of the loads it was copied from);
 * - each visit is rebuilt with deriveVisit (lib/delivery/visit.ts) from the events the server had
 *   received by t, without the GPS (AYUN) ones, as the live facts read it (facts.ts); photos, Back at
 *   depot and Leaving for next load by their receipt time too;
 * - the driver page counts as opened from its first recorded open (the link's device list) or the first
 *   thing the phone sent.
 * Known limits: the plan is the day's final plan in use (a load re-solved during the day is replayed as
 * it ended); positions are not exported, so the plausibility flags that need them (timingSuspect) are
 * not rebuilt; the "Pin may be wrong" list is the one at export time.
 *
 * GPS alerts (owner request 18 Oct 2026; ReplayOptions.gps, by default when the day was exported with GPS
 * tracking ALERTS; a day exported with TIMES can be replayed with them too, to see what ALERTS would have
 * raised): the visits are rebuilt WITH the GPS (AYUN) events the server had received by t (their
 * receivedAt is when the history pull was processed, so the trail's delay is replayed as it was), the
 * truck-days get their trail-confirmed depot moves known by t (AlertDayExport.gps: when they were confirmed,
 * whether their time is exact) and, from its suppression on, a suppressed truck-day none. Live positions
 * are never saved: in the replay no truck-day has a fresh position, so what needs one (the live ETA of R3,
 * "still at the stop" for R1 from a GPS arrival, "at the depot" for R2 from a GPS return) falls back as
 * between reads with no fix (gps.ts principle 4) - the replay shows the GPS times' effect, never the live
 * position's. A truck-day suppressed after the export's day kept no AYUN events (suppression deletes them).
 * Without the option, the AYUN events are left out, as the live facts below ALERTS (facts.ts alertVisitRow).
 */
import { deriveVisit, type EventSource, type VisitEvent } from '../delivery/visit';
import { fmtHhmm, localDateIso, zonedDayStart } from '../dispatch/time';
import { ALERT_RULE_LIST, ALERT_RULE_SPECS, ALERT_RULES, rulesOn, severityOf, thresholdsOf, type AlertConfig, type AlertRule } from './catalog';
import { gpsTruckDayFactOf, type AlertGpsConfig } from './gps';
import { evaluate, openKey, truckDayOf, type AlertFacts, type FactLoad, type FactPhoto, type FactSignal, type FactStop, type FactTruckDay, type FactVisit, type OpenRowInfo, type WindowRuleName } from './rules';
import { applyPlanInMemory, planApply, type MemAlert } from './store';
import type { AlertKind } from './catalog';

export const ALERT_EXPORT_KIND = 'routeiq-alerts-day';

export interface ExportEvent {
  kind: string;
  source: string;
  /** ISO times. */
  at: string;
  receivedAt: string;
  distanceM: number | null;
  accuracyM: number | null;
  /** The keys deriveVisit reads (outcome, reason, note, late, observed, gap, ...). */
  payload: Record<string, unknown> | null;
}

export interface ExportPhoto {
  source: string;
  positionStatus: string;
  distanceM: number | null;
  accuracyM: number | null;
  exifDistanceM: number | null;
  receivedAt: string;
  /** When it was taken (ISO) and whether it is an old (gallery) photo; absent in an older export. */
  takenAt?: string;
  oldPhoto?: boolean;
}

export interface ExportVisit {
  plannedServiceMin: number | null;
  windowStartMin: number | null;
  windowEndMin: number | null;
  casesPlanned: number;
  events: ExportEvent[];
  photos: ExportPhoto[];
}

export type ExportStop = Omit<FactStop, 'visit'> & { visit: ExportVisit | null };

export interface ExportLoad {
  id: string;
  depotId: string;
  truckId: string;
  truckCode: string;
  loadNo: number;
  departMin: number;
  returnMin: number;
  windowRule: WindowRuleName;
  breakMin: { startMin: number; endMin: number } | null;
  /** The status at export time. */
  finalStatus: string;
  stopCount: number;
  /** The status moves, oldest first. */
  history: { status: string; at: string }[];
  /** Back at depot taps (load level). */
  backEvents: ExportEvent[];
  /** Leaving for next load taps on this load (load level, rule R2); absent in an export from before 16 Oct 2026. */
  departEvents?: ExportEvent[];
  /** When the load was planned (the first plan version it was copied from: day-results.ts loadOrigins); absent in an older export. */
  plannedAt?: string | null;
  /** The planned stops with their visits (loads that left only). */
  stops: ExportStop[];
}

export interface ExportTruckDay {
  truckId: string;
  /** The first time the driver page was opened (the link's device list), and the last. */
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

/** A truck-day's GPS as the GPS alerts read it (never a position). */
export interface ExportGpsTruckDay {
  truckId: string;
  /** IvmsTruckDay.suppressedAt (ISO): from then on the truck-day has no GPS. */
  suppressedAt: string | null;
  /** The trail-confirmed depot moves: when they happened, when RouteIQ knew them confirmed (processed, else received), exact or not (gps.ts moveObserved). */
  moves: { kind: 'DEPOT_IN' | 'DEPOT_OUT'; at: string; knownAt: string; observed: boolean }[];
}

/** The day's GPS (exported with GPS tracking TIMES or ALERTS; absent below, and in an export from before 18 Oct 2026). */
export interface ExportGps {
  /** The company's GPS tracking mode at export time. */
  mode: string;
  /** The settings the GPS alerts read with (gps.ts gpsAlertConfigOf). */
  config: AlertGpsConfig;
  truckDays: ExportGpsTruckDay[];
}

/** One company's delivery day, saved for the replay (replay-export.ts). */
export interface AlertDayExport {
  v: 1;
  kind: typeof ALERT_EXPORT_KIND;
  /** YYYY-MM-DD */
  date: string;
  tz: string;
  exportedAt: string;
  /** The company's alert settings at export time (the replay may override them). */
  config: Partial<AlertConfig>;
  loads: ExportLoad[];
  truckDays: ExportTruckDay[];
  /** GPS alerts: the day's GPS (optional). */
  gps?: ExportGps;
}

/** A file that is not a saved day: a short reason. */
export function readAlertDayExport(json: unknown): AlertDayExport {
  const x = json as Partial<AlertDayExport> | null;
  if (!x || x.kind !== ALERT_EXPORT_KIND || x.v !== 1) throw new Error('Not a RouteIQ alerts day export (kind routeiq-alerts-day, v 1).');
  if (typeof x.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x.date) || typeof x.tz !== 'string' || !Array.isArray(x.loads) || !Array.isArray(x.truckDays)) throw new Error('The export is incomplete (date, tz, loads, truckDays).');
  return x as AlertDayExport;
}

const PHONE = new Set(['PHONE_AUTO', 'PHONE_MANUAL']);
const ms = (iso: string) => Date.parse(iso);
const known = (iso: string | null | undefined, t: number) => !!iso && ms(iso) <= t;

/** A load's status and its time as of t. */
export function statusAsOf(l: Pick<ExportLoad, 'history' | 'finalStatus'>, t: number): { status: string; statusChangedAt: Date | null } {
  if (!l.history.length) return { status: l.finalStatus, statusChangedAt: null };
  const moves = [...l.history].filter((h) => ms(h.at) <= t).sort((a, b) => ms(a.at) - ms(b.at));
  let status = 'PLANNED';
  let changed: Date | null = null;
  for (const h of moves) {
    status = h.status;
    changed = new Date(h.at);
  }
  return { status, statusChangedAt: changed };
}

function visitAsOf(v: ExportVisit, t: number, ctx: { dayStart: Date; breakMin: { startMin: number; endMin: number } | null; radiusM: number; gps?: boolean }): FactVisit | null {
  // The GPS (AYUN) events of the IVMS live link are left out, as the live facts leave out their times
  // (facts.ts alertVisitRow): a visit only GPS made is none. With the GPS alerts (`gps`) they are kept.
  const events: VisitEvent[] = v.events
    .filter((e) => ms(e.receivedAt) <= t && (ctx.gps || e.source !== 'AYUN'))
    .map((e) => ({ kind: e.kind as VisitEvent['kind'], source: e.source as EventSource, at: new Date(e.at), receivedAt: new Date(e.receivedAt), distanceM: e.distanceM, accuracyM: e.accuracyM, payload: e.payload }));
  const photos: FactPhoto[] = v.photos
    .filter((p) => ms(p.receivedAt) <= t)
    .map((p) => ({
      positionStatus: p.positionStatus,
      distanceM: p.distanceM,
      accuracyM: p.accuracyM,
      exifDistanceM: p.exifDistanceM,
      receivedAt: new Date(p.receivedAt),
      source: p.source,
      oldPhoto: p.oldPhoto ?? false,
      ...(p.takenAt ? { takenAt: new Date(p.takenAt) } : {}),
    }));
  if (!events.length && !photos.length) return null;
  const s = deriveVisit(events, { dayStart: ctx.dayStart, windowStartMin: v.windowStartMin, breakMin: ctx.breakMin, lines: [], pin: null, radiusM: ctx.radiusM });
  return {
    arrivedAt: s.arrivedAt,
    arrivalSource: s.arrivalSource,
    arrivalObserved: s.arrivalObserved,
    arrivalDistanceM: s.arrivalDistanceM,
    arrivalAccuracyM: s.arrivalAccuracyM,
    timingSuspect: s.timingSuspect,
    departedAt: s.departedAt,
    departedAtOutcome: s.departedAtOutcome,
    autoMinutes: s.autoMinutes,
    autoServiceMinutes: s.autoServiceMinutes,
    outcome: s.outcome,
    reason: s.reason,
    reasonNote: s.reasonNote,
    outcomeAt: s.outcomeAt,
    outcomeSource: s.outcomeSource,
    outcomeDistanceM: s.outcomeDistanceM,
    outcomeAccuracyM: s.outcomeAccuracyM,
    casesPlanned: v.casesPlanned,
    // The lines are not exported: "x of y cases" is left out of the replay's texts.
    casesDelivered: null,
    plannedServiceMin: v.plannedServiceMin,
    windowStartMin: v.windowStartMin,
    windowEndMin: v.windowEndMin,
    photos,
    ...(ctx.gps ? { departureSource: s.departureSource, departureObserved: !s.departureGap } : {}),
  };
}

/** The facts of the saved day as of `at` (the rows open in `rows` are the open alerts); `opts.gps`: with the GPS alerts (see the file comment). */
export function factsAsOf(exp: AlertDayExport, at: Date, rows: readonly MemAlert[], radiusM = 100, opts: { gps?: boolean } = {}): AlertFacts {
  const t = at.getTime();
  const dayStart = zonedDayStart(exp.date, exp.tz);
  const gps = opts.gps && exp.gps ? exp.gps : null;
  const gpsDayOf = new Map((gps?.truckDays ?? []).map((d) => [d.truckId, d]));
  /** The truck-day keeps its GPS as of t: GPS alerts, and not suppressed by then. */
  const gpsOn = (truckId: string) => !!gps && !known(gpsDayOf.get(truckId)?.suppressedAt, t);
  const signals = new Map<string, FactSignal>();
  const take = (truckId: string, s: FactSignal) => {
    const k = truckDayOf(exp.date, truckId);
    const cur = signals.get(k);
    if (!cur || s.at > cur.at) signals.set(k, s);
  };
  const loads: FactLoad[] = exp.loads.map((l) => {
    const st = statusAsOf(l, t);
    const back = l.backEvents.filter((e) => known(e.receivedAt, t)).map((e) => new Date(e.at));
    const departs = (l.departEvents ?? [])
      .filter((e) => known(e.receivedAt, t))
      .map((e) => new Date(e.at))
      .sort((a, b) => a.getTime() - b.getTime());
    // The Dispatch press as of t, whatever the status became after it (completing a load keeps it).
    const pressed = l.history.filter((h) => h.status === 'DISPATCHED' && ms(h.at) <= t).map((h) => ms(h.at));
    for (const e of [...l.backEvents, ...(l.departEvents ?? [])]) if (PHONE.has(e.source) && known(e.receivedAt, t)) take(l.truckId, { at: new Date(e.receivedAt), kind: e.kind, depotId: l.depotId, loadNo: l.loadNo, sequence: null });
    const left = st.status === 'DISPATCHED' || st.status === 'COMPLETED';
    const stops: FactStop[] = left
      ? l.stops.map((s) => {
          if (s.visit) {
            for (const e of s.visit.events) if (PHONE.has(e.source) && known(e.receivedAt, t)) take(l.truckId, { at: new Date(e.receivedAt), kind: e.kind, depotId: l.depotId, loadNo: l.loadNo, sequence: s.sequence });
            for (const p of s.visit.photos) if (PHONE.has(p.source) && known(p.receivedAt, t)) take(l.truckId, { at: new Date(p.receivedAt), kind: 'PHOTO', depotId: l.depotId, loadNo: l.loadNo, sequence: s.sequence });
          }
          return { ...s, visit: s.visit ? visitAsOf(s.visit, t, { dayStart, breakMin: l.breakMin, radiusM, gps: gpsOn(l.truckId) }) : null };
        })
      : [];
    return {
      id: l.id,
      depotId: l.depotId,
      date: exp.date,
      truckId: l.truckId,
      truckCode: l.truckCode,
      loadNo: l.loadNo,
      status: st.status,
      departMin: l.departMin,
      returnMin: l.returnMin,
      statusChangedAt: st.statusChangedAt,
      windowRule: l.windowRule,
      breakMin: l.breakMin,
      backAt: back.length ? new Date(Math.min(...back.map((d) => d.getTime()))) : null,
      // The latest tap counts (a tap made too early is corrected by tapping again); none on a Planned load.
      leftTapAt: st.status !== 'PLANNED' && departs.length ? departs[departs.length - 1]! : null,
      leftTaps: st.status !== 'PLANNED' ? departs : [],
      dispatchedAt: pressed.length ? new Date(Math.max(...pressed)) : null,
      existedAt: l.plannedAt ? new Date(l.plannedAt) : null,
      stopCount: l.stopCount,
      stops,
    };
  });
  const tdOf = new Map(exp.truckDays.map((d) => [d.truckId, d]));
  const truckDays: FactTruckDay[] = [...new Set(exp.loads.map((l) => l.truckId))].map((truckId) => {
    const d = tdOf.get(truckId);
    const sig = signals.get(truckDayOf(exp.date, truckId)) ?? null;
    const seen = [d?.firstSeenAt, d?.lastSeenAt].filter((x): x is string => known(x, t)).map((x) => ms(x));
    if (sig) seen.push(sig.at.getTime());
    // GPS alerts: the depot moves confirmed by t; never a live position (none is saved).
    const g = gps && gpsOn(truckId) ? gpsDayOf.get(truckId) : undefined;
    const gpsFact = g
      ? gpsTruckDayFactOf({
          position: null,
          moves: g.moves.filter((m) => known(m.knownAt, t) && ms(m.at) <= t).map((m) => ({ kind: m.kind, at: new Date(m.at), observed: m.observed })),
          trailTo: null,
          now: at,
        })
      : null;
    return { date: exp.date, truckId, linkSeenAt: seen.length ? new Date(Math.max(...seen)) : null, pageOpened: known(d?.firstSeenAt, t) || !!sig, lastSignal: sig, ...(gps ? { gps: gpsFact } : {}) };
  });
  const open = new Map<string, OpenRowInfo>();
  for (const r of rows) if (!r.resolvedAt) open.set(openKey(r.rule, r.subjectKey), { kind: r.kind as AlertKind, tier: r.tier, depotId: r.depotId, deliveryDate: r.deliveryDate });
  return { tz: exp.tz, today: localDateIso(at, exp.tz), dates: [exp.date], loads, truckDays, open, ...(gps ? { gps: { ...gps.config, depots: new Map() } } : {}) };
}

export interface ReplayOptions {
  /** Minutes of the export's date (may be negative: the evening before; or pass 1440). Default 05:00-23:59. */
  fromMin?: number;
  toMin?: number;
  /** Default 5 min (the sweep runs every 2 min; 5 is close enough to count alerts). */
  stepMin?: number;
  /** Alerts switched on at this minute of the date (no backlog before it); default: on all day. */
  switchOnMin?: number | null;
  /** Settings to try instead of the exported ones (thresholds; null = the rule off). */
  overrides?: Partial<AlertConfig>;
  radiusM?: number;
  /**
   * With the GPS alerts (GPS tracking ALERTS: see the file comment). Default: the day was exported with
   * ALERTS. True on a day exported without GPS (below TIMES, or before 18 Oct 2026) throws.
   */
  gps?: boolean;
}

export type ReplayEventKind = 'RAISED' | 'HISTORY' | 'ESCALATED' | 'REOPENED' | 'CLOSED';

export interface ReplayEvent {
  /** hh:mm of the date ("+1" past midnight). */
  at: string;
  kind: ReplayEventKind;
  rule: AlertRule;
  tier: number;
  severity: string;
  /** Would go in an e-mail of HIGH alerts (catalog deliveryOf and the default minimum severity). */
  emailHigh: boolean;
  text: string;
}

export interface ReplayRuleSummary {
  rule: AlertRule;
  no: number;
  label: string;
  /** The threshold replayed (null = the rule was off). */
  threshold: number | null;
  raised: number;
  history: number;
  escalated: number;
  reopened: number;
  /** Raises, escalations and reopens a HIGH-only e-mail would have carried. */
  emailHigh: number;
  first: string | null;
  samples: string[];
}

export interface ReplayReport {
  date: string;
  from: string;
  to: string;
  steps: number;
  /** Replayed with the GPS alerts. */
  gps: boolean;
  rules: ReplayRuleSummary[];
  timeline: ReplayEvent[];
  rows: MemAlert[];
}

/** Minutes of the saved date as the report shows them: "05:00", "21:45 -1" (the evening before), "00:30 +1". */
export function dayClock(min: number): string {
  return min < 0 ? `${fmtHhmm(min + 1440)} -1` : fmtHhmm(min);
}

/** Replays the saved day (see the file comment). */
export function replayDay(exp: AlertDayExport, opts: ReplayOptions = {}): ReplayReport {
  const from = opts.fromMin ?? 5 * 60;
  const to = opts.toMin ?? 23 * 60 + 59;
  const step = Math.max(1, Math.round(opts.stepMin ?? 5));
  if (opts.gps && !exp.gps) throw new Error('This export has no GPS (it was saved with GPS tracking below TIMES, or before 18 Oct 2026): it cannot be replayed with the GPS alerts.');
  const gps = opts.gps ?? exp.gps?.mode === 'ALERTS';
  const cfg: Partial<AlertConfig> = { ...exp.config, ...(opts.overrides ?? {}), alertsEnabled: true };
  const thresholds = thresholdsOf(cfg);
  const on = rulesOn(cfg);
  const dayStart = zonedDayStart(exp.date, exp.tz).getTime();
  const at = (min: number) => new Date(dayStart + min * 60_000);
  const switchOn = opts.switchOnMin != null ? at(opts.switchOnMin) : null;
  const rows: MemAlert[] = [];
  const timeline: ReplayEvent[] = [];
  let steps = 0;
  for (let m = from; m <= to; m += step) {
    steps++;
    const now = at(m);
    const facts = factsAsOf(exp, now, rows, opts.radiusM, { gps });
    const ev = evaluate(facts, now, thresholds);
    const plan = planApply(rows, ev, { now, alertsEnabledAt: switchOn, windowFrom: exp.date, rulesOn: on });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const before = new Map(rows.map((r) => [r.id, { tier: r.tier, resolved: !!r.resolvedAt }]));
    const added = applyPlanInMemory(rows, plan, now);
    const stamp = dayClock(m);
    const push = (r: MemAlert, kind: ReplayEventKind) =>
      timeline.push({ at: stamp, kind, rule: r.rule, tier: r.tier, severity: severityOf(r.tier), emailHigh: kind !== 'HISTORY' && kind !== 'CLOSED' && r.mayEmail && severityOf(r.tier) === 'HIGH', text: r.text });
    for (const r of added) push(r, r.resolvedAt ? 'HISTORY' : 'RAISED');
    for (const e of plan.escalations) {
      const r = byId.get(e.id);
      if (r && before.get(r.id)!.tier < r.tier) push(r, 'ESCALATED');
    }
    for (const o of plan.reopens) {
      const r = byId.get(o.id);
      if (r && before.get(r.id)!.resolved && !r.resolvedAt) push(r, 'REOPENED');
    }
    for (const c of plan.resolves) {
      const r = byId.get(c.id);
      if (r && !before.get(r.id)!.resolved && r.resolvedAt) push(r, 'CLOSED');
    }
  }
  const rules: ReplayRuleSummary[] = ALERT_RULE_LIST.map((s) => {
    const mine = timeline.filter((e) => e.rule === s.rule);
    const raised = mine.filter((e) => e.kind === 'RAISED');
    return {
      rule: s.rule,
      no: s.no,
      label: s.label,
      threshold: thresholds[s.rule],
      raised: raised.length,
      history: mine.filter((e) => e.kind === 'HISTORY').length,
      escalated: mine.filter((e) => e.kind === 'ESCALATED').length,
      reopened: mine.filter((e) => e.kind === 'REOPENED').length,
      emailHigh: mine.filter((e) => e.emailHigh).length,
      first: mine.find((e) => e.kind !== 'CLOSED')?.at ?? null,
      samples: [...new Set([...raised, ...mine.filter((e) => e.kind === 'HISTORY')].map((e) => e.text))].slice(0, 3),
    };
  });
  return { date: exp.date, from: dayClock(from), to: dayClock(to), steps, gps, rules, timeline, rows };
}

/** The replay as plain text (the script prints it): one block per rule, then the e-mail count. */
export function replayText(r: ReplayReport): string {
  const lines = [`Alerts replay of ${r.date}, ${r.from}-${r.to}, ${r.steps} steps (no writes, no e-mail).`];
  if (r.gps) lines.push('With the GPS alerts (GPS tracking ALERTS): the GPS times and depot moves as RouteIQ received them; live positions are not saved, so the live ETA and the "still at the stop / at the depot" checks are not replayed.');
  lines.push('');
  for (const s of r.rules) {
    const setting = s.threshold === null ? 'off' : ALERT_RULE_SPECS[s.rule].unit === null ? 'on' : `threshold ${s.threshold}`;
    const head = `R${s.no} ${s.label} (${setting}): ${s.raised} raised, ${s.history} history, ${s.escalated} escalated, ${s.reopened} reopened${s.first ? `, first ${s.first}` : ''}`;
    lines.push(head);
    for (const t of s.samples) lines.push(`    - ${t}`);
  }
  const mails = r.timeline.filter((e) => e.emailHigh).length;
  lines.push('', `HIGH alerts a HIGH-only e-mail would carry: ${mails}. Rules: ${ALERT_RULES.length}.`);
  return lines.join('\n');
}
