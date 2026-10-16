/**
 * Operations alerts (owner request 16 Oct 2026): "notify me when a rule I set is broken: (1) a driver's
 * unloading takes more than planned by 30 min; (2) loading in the warehouse takes more than 40 min; (3) a
 * driver's ETA changes to more than 30 min late; plus any other rule you find important, so we can track
 * with ease."
 *
 * The shared contract of lib/alerts/* (the sweep's rules, the store, the e-mail digest, the API and the
 * screens). Pure and browser-safe: Settings, the bell and the Alerts page read the same labels, defaults
 * and bounds as the server. The database repeats the bounds as CHECKs (migration 20261016180000_ops_alerts;
 * tests/lib/alert-catalog.spec.ts compares them).
 *
 * How alerts behave (design PR-2 with the adversarial review's fixes):
 * - Everything is OFF until a company admin switches `TenantConfig.alertsEnabled` on; nothing that began or
 *   happened before that moment (`alertsEnabledAt`) raises an alert (no backlog on switch-on).
 * - A sweep every ALERT_SWEEP_EVERY_MS reads what is in the database (no hook in the driver, office or
 *   load paths) and raises, escalates and closes rows of OpsAlert, one per rule and physical subject
 *   (subjectKeyOf: never a PlanLoad id, so a re-plan's copies keep their rows).
 * - Tiers start at WARN: tier 1 is WARN, tiers 2-3 are HIGH (severityOf). A higher tier is new
 *   information: it clears the acknowledgement.
 * - CONDITION rows close when the condition ends, when their load or stop is no longer in the plan that
 *   was read in full (NOT_IN_PLAN), when their date leaves the sweep's window (EXPIRED) or when their rule
 *   is switched off (RULE_OFF). EVENT rows record a fact: they stay open until acknowledged or corrected.
 * - One missing tap must not pile up alerts: the rules that follow the driver's phone (needsDriverPage)
 *   run only for truck-days whose driver page was opened; a dispatched truck-day without it gets one WARN
 *   (PAGE_NOT_OPENED) instead. ETA_LATE and the projected AFTER_CLOSING are not raised while DRIVER_SILENT
 *   is open for the load, nor after the planned return + RETURN_GRACE_MIN.
 * - Delivery: the bell, the day screen's Alerts card and the Alerts page always; a toast for new HIGH
 *   rows that may toast (deliveryOf), at most ALERT_TOAST_MAX at once, never for rows already there when
 *   the page opened; e-mail only when the server has Resend set up and the company has recipients, only
 *   from the minimum severity up (HIGH by default), never in the quiet hours (22:00-06:00 by default), at
 *   most one every `alertEmailEveryMin` and ALERT_EMAILS_PER_DAY a day.
 * - Messages never contain a phone number: runs of ALERT_REDACT_DIGITS_MIN or more digits in free text
 *   are removed, and driver notes are cut to ALERT_NOTE_MAX characters (lib/alerts/text.ts).
 */
import type { TenantConfig } from '@prisma/client';

export const ALERT_KINDS = ['CONDITION', 'EVENT'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_SEVERITIES = ['WARN', 'HIGH'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** Tiers 1-3 (OpsAlert.tier, CHECKed). */
export const ALERT_MAX_TIER = 3;
export type AlertTier = 1 | 2 | 3;

/** Why a row closed (OpsAlert.resolvedReason). */
export const RESOLVED_REASONS = ['ENDED', 'CORRECTED', 'NOT_IN_PLAN', 'EXPIRED', 'RULE_OFF'] as const;
export type ResolvedReason = (typeof RESOLVED_REASONS)[number];
export const RESOLVED_REASON_TEXT: Record<ResolvedReason, string> = {
  ENDED: 'Over',
  CORRECTED: 'Corrected',
  NOT_IN_PLAN: 'No longer in the plan',
  EXPIRED: 'Date passed',
  RULE_OFF: 'Rule switched off',
};

/** The rule codes stored in OpsAlert.rule (checked here, not by the database: a new rule needs no migration). */
export const ALERT_RULES = [
  'UNLOAD_OVER',
  'LOADING_OVER',
  'ETA_LATE',
  'DEPART_LATE',
  'DRIVER_SILENT',
  'AFTER_CLOSING',
  'PRIORITY_NOT_DELIVERED',
  'DELIVERED_WITH_NOTE',
  'PROOF_FAR',
  'LOAD_NOT_CLOSED',
  'PAGE_NOT_OPENED',
] as const;
export type AlertRule = (typeof ALERT_RULES)[number];

export function isAlertRule(v: unknown): v is AlertRule {
  return typeof v === 'string' && (ALERT_RULES as readonly string[]).includes(v);
}

/** The TenantConfig column of each rule with a threshold (NULL = the rule is off). */
export const ALERT_THRESHOLD_COLUMNS = [
  'alertUnloadOverMin',
  'alertLoadingOverMin',
  'alertEtaLateMin',
  'alertDepartLateMin',
  'alertSilentMin',
  'alertAfterClosingMin',
  'alertPriorityMax',
  'alertProofFarM',
  'alertNotClosedMin',
  'alertPageNotOpenedMin',
] as const satisfies readonly (keyof TenantConfig)[];
export type AlertThresholdColumn = (typeof ALERT_THRESHOLD_COLUMNS)[number];
/** The on/off-only rules (no threshold). */
export type AlertSwitchColumn = 'alertDeliveredNote';

export interface AlertRuleSpec {
  rule: AlertRule;
  /** R1-R11: the number the design, the docs and Settings use. */
  no: number;
  /** One of the owner's three rules of 16 Oct 2026. */
  owner: boolean;
  /** Short name (Settings, the Alerts page filter, the e-mail). */
  label: string;
  /** The one-line meaning on Settings ("N" is the threshold). */
  meaning: string;
  /** CONDITION: stays open while true. EVENT: a fact, open until acknowledged or corrected. */
  kind: AlertKind;
  /** What one row is about: a stop, a load, or a truck-day (subjectKeyOf). */
  subject: 'STOP' | 'LOAD' | 'TRUCK_DAY';
  /** The threshold's unit; null for an on/off rule. */
  unit: 'min' | 'm' | 'priority' | null;
  /** The TenantConfig column that holds the threshold (or the on/off switch). */
  setting: AlertThresholdColumn | AlertSwitchColumn;
  /** On for a company that never changed it (the column default). */
  defaultOn: boolean;
  /** The threshold Settings fills in when the rule is switched on (the column default when defaultOn); null for an on/off rule. */
  threshold: number | null;
  /** The allowed thresholds (Settings, the API and a database CHECK); null for an on/off rule. */
  bounds: { min: number; max: number } | null;
  /** The highest tier the rule reaches. */
  maxTier: AlertTier;
  /**
   * Follows the driver's phone: checked only on truck-days whose driver page was opened (else
   * PAGE_NOT_OPENED). AFTER_CLOSING: only its projected part (an arrival actually recorded, by the phone or
   * the office, is a fact and is always checked: critique H3).
   */
  needsDriverPage: boolean;
}

const spec = (s: AlertRuleSpec) => s;

/** The rules, R1-R11. */
export const ALERT_RULE_SPECS: Record<AlertRule, AlertRuleSpec> = {
  UNLOAD_OVER: spec({
    rule: 'UNLOAD_OVER',
    no: 1,
    owner: true,
    label: 'Unloading longer than planned',
    meaning: 'No result or departure tapped more than N min after the planned unloading time (counted from arrival, or from the window start when early). Tier 1 shows in RouteIQ only.',
    kind: 'CONDITION',
    subject: 'STOP',
    unit: 'min',
    setting: 'alertUnloadOverMin',
    defaultOn: true,
    threshold: 30,
    bounds: { min: 5, max: 480 },
    maxTier: 3,
    needsDriverPage: true,
  }),
  LOADING_OVER: spec({
    rule: 'LOADING_OVER',
    no: 2,
    owner: true,
    label: 'Loading in the warehouse too long',
    meaning: 'A truck has been loading for more than N min: from the Loading press to Loaded (or Dispatch). Switch it on only when the warehouse presses Loading as it starts each truck and Loaded when it is done.',
    kind: 'CONDITION',
    subject: 'LOAD',
    unit: 'min',
    setting: 'alertLoadingOverMin',
    defaultOn: false,
    threshold: 40,
    bounds: { min: 5, max: 480 },
    maxTier: 3,
    needsDriverPage: false,
  }),
  ETA_LATE: spec({
    rule: 'ETA_LATE',
    no: 3,
    owner: true,
    label: 'Running late',
    meaning: 'The expected arrival at the next stop is more than N min after its planned time (worked out from the driver\'s taps and the plan; there is no GPS).',
    kind: 'CONDITION',
    subject: 'LOAD',
    unit: 'min',
    setting: 'alertEtaLateMin',
    defaultOn: true,
    threshold: 30,
    bounds: { min: 10, max: 480 },
    maxTier: 3,
    needsDriverPage: true,
  }),
  DEPART_LATE: spec({
    rule: 'DEPART_LATE',
    no: 4,
    owner: false,
    label: 'Not dispatched on time',
    meaning: 'A Locked or Loading load of today is still not dispatched N min after its planned departure.',
    kind: 'CONDITION',
    subject: 'LOAD',
    unit: 'min',
    setting: 'alertDepartLateMin',
    defaultOn: true,
    threshold: 30,
    bounds: { min: 5, max: 480 },
    maxTier: 3,
    needsDriverPage: false,
  }),
  DRIVER_SILENT: spec({
    rule: 'DRIVER_SILENT',
    no: 5,
    owner: false,
    label: 'Driver silent',
    meaning: 'Nothing from the driver\'s phone for N min while stops are left, no stop is being unloaded and the next stop is overdue (a planned break inside the gap is added).',
    kind: 'CONDITION',
    subject: 'LOAD',
    unit: 'min',
    setting: 'alertSilentMin',
    defaultOn: true,
    threshold: 120,
    bounds: { min: 30, max: 600 },
    maxTier: 2,
    needsDriverPage: true,
  }),
  AFTER_CLOSING: spec({
    rule: 'AFTER_CLOSING',
    no: 6,
    owner: false,
    label: 'After the delivery window',
    meaning: 'A truck arrived, or the next stop is expected, more than N min after the stop\'s delivery window ends.',
    kind: 'CONDITION',
    subject: 'STOP',
    unit: 'min',
    setting: 'alertAfterClosingMin',
    defaultOn: true,
    threshold: 15,
    bounds: { min: 0, max: 240 },
    maxTier: 2,
    needsDriverPage: true,
  }),
  PRIORITY_NOT_DELIVERED: spec({
    rule: 'PRIORITY_NOT_DELIVERED',
    no: 7,
    owner: false,
    label: 'Priority stop not delivered',
    meaning: 'The driver recorded Not delivered or Partly delivered at a stop of priority N or better (1 = highest).',
    kind: 'EVENT',
    subject: 'STOP',
    unit: 'priority',
    setting: 'alertPriorityMax',
    defaultOn: true,
    threshold: 2,
    bounds: { min: 1, max: 5 },
    maxTier: 2,
    needsDriverPage: false,
  }),
  DELIVERED_WITH_NOTE: spec({
    rule: 'DELIVERED_WITH_NOTE',
    no: 8,
    owner: false,
    label: 'Delivered with a note',
    meaning: 'The driver marked a stop Delivered and wrote a note: check everything was delivered. A note that only confirms the delivery ("delivered", "received at 11:25") is not reported.',
    kind: 'EVENT',
    subject: 'STOP',
    unit: null,
    setting: 'alertDeliveredNote',
    defaultOn: true,
    threshold: null,
    bounds: null,
    maxTier: 1,
    needsDriverPage: false,
  }),
  PROOF_FAR: spec({
    rule: 'PROOF_FAR',
    no: 9,
    owner: false,
    label: 'Proof far from the pin',
    meaning: 'A delivery photo or result was recorded more than N m from the customer\'s verified pin: the pin or the place of the photo is wrong.',
    kind: 'EVENT',
    subject: 'STOP',
    unit: 'm',
    setting: 'alertProofFarM',
    defaultOn: true,
    threshold: 500,
    bounds: { min: 150, max: 20000 },
    maxTier: 2,
    needsDriverPage: false,
  }),
  LOAD_NOT_CLOSED: spec({
    rule: 'LOAD_NOT_CLOSED',
    no: 10,
    owner: false,
    label: 'Load not closed',
    meaning: 'A dispatched load is still not Completed N min after its planned return (no Back at depot, or stops without a result).',
    kind: 'CONDITION',
    subject: 'LOAD',
    unit: 'min',
    setting: 'alertNotClosedMin',
    defaultOn: true,
    threshold: 120,
    bounds: { min: 30, max: 720 },
    maxTier: 2,
    needsDriverPage: true,
  }),
  PAGE_NOT_OPENED: spec({
    rule: 'PAGE_NOT_OPENED',
    no: 11,
    owner: false,
    label: 'Driver page not opened',
    meaning: 'A truck was dispatched but its driver page was not opened N min after the planned departure. RouteIQ cannot follow that truck: unloading, running late, silent, expected-after-the-window and not-closed alerts are not checked for it.',
    kind: 'CONDITION',
    subject: 'TRUCK_DAY',
    unit: 'min',
    setting: 'alertPageNotOpenedMin',
    defaultOn: true,
    threshold: 30,
    bounds: { min: 10, max: 240 },
    maxTier: 1,
    needsDriverPage: false,
  }),
};

/** The rules in R-number order. */
export const ALERT_RULE_LIST: readonly AlertRuleSpec[] = ALERT_RULES.map((r) => ALERT_RULE_SPECS[r]);

/** The bounds of each threshold column (Settings, lib/schemas.ts and the database CHECKs). */
export const ALERT_THRESHOLD_BOUNDS = Object.fromEntries(
  ALERT_RULE_LIST.filter((s) => s.bounds).map((s) => [s.setting, s.bounds]),
) as Record<AlertThresholdColumn, { min: number; max: number }>;

/** Tier 1 is WARN; tiers 2 and 3 are HIGH. */
export function severityOf(tier: number): AlertSeverity {
  return tier >= 2 ? 'HIGH' : 'WARN';
}

/**
 * The tier of a measured value against threshold T, for the rules whose tiers are multiples of T: above T
 * tier 1, above 2T tier 2, above 3T tier 3 (capped at maxTier); 0 when not above T. A rule fires at T + 1,
 * never at T. A threshold of 0 or less gives tier 1 for any value above it.
 */
export function tierAt(value: number, threshold: number, maxTier: AlertTier = ALERT_MAX_TIER as AlertTier): 0 | AlertTier {
  if (!(value > threshold)) return 0;
  if (threshold <= 0) return 1;
  return Math.min(maxTier, Math.ceil(value / threshold) - 1) as AlertTier;
}

/** HIGH sorts before WARN (never by the strings: 'HIGH' < 'WARN' is only an accident of the alphabet). */
export const SEVERITY_RANK: Record<AlertSeverity, number> = { HIGH: 0, WARN: 1 };
/** The same order in SQL (the e-mail claim's ORDER BY). */
export const SEVERITY_ORDER_SQL = `CASE "severity" WHEN 'HIGH' THEN 0 ELSE 1 END`;
export const SEVERITY_LABEL: Record<AlertSeverity, string> = { WARN: 'Warning', HIGH: 'High' };

/**
 * Where a row's current tier may go besides the bell and the lists (stored as OpsAlert.mayToast /
 * mayEmail at each raise or escalation):
 * - `history`: a row raised already over (DEPART_LATE found only after Dispatch): lists only;
 * - UNLOAD_OVER tier 1: lists only (a bad arrival tap must not page anyone; tier 2 does);
 * - DELIVERED_WITH_NOTE: never a toast, may be e-mailed (when the company e-mails WARN alerts).
 * The toast is further limited to HIGH rows; the e-mail to the company's minimum severity.
 */
export function deliveryOf(rule: AlertRule, tier: number, opts: { history?: boolean } = {}): { mayToast: boolean; mayEmail: boolean } {
  if (opts.history) return { mayToast: false, mayEmail: false };
  if (rule === 'UNLOAD_OVER' && tier <= 1) return { mayToast: false, mayEmail: false };
  if (rule === 'DELIVERED_WITH_NOTE') return { mayToast: false, mayEmail: true };
  return { mayToast: true, mayEmail: true };
}

/** The company's alert settings the rules read (TenantConfig). */
export type AlertConfig = Pick<TenantConfig, 'alertsEnabled' | 'alertsEnabledAt' | AlertThresholdColumn | AlertSwitchColumn>;

/** Each rule's threshold, or null when the rule is off (an on/off rule that is on gives 0). All null while alerts are off. */
export function thresholdsOf(cfg: Partial<AlertConfig> | null | undefined): Record<AlertRule, number | null> {
  const out = {} as Record<AlertRule, number | null>;
  for (const s of ALERT_RULE_LIST) {
    if (!cfg?.alertsEnabled) out[s.rule] = null;
    else if (s.setting === 'alertDeliveredNote') out[s.rule] = cfg.alertDeliveredNote ? 0 : null;
    else {
      const v = cfg[s.setting];
      out[s.rule] = typeof v === 'number' && Number.isFinite(v) ? v : null;
    }
  }
  return out;
}

/** The rules that are on. */
export function rulesOn(cfg: Partial<AlertConfig> | null | undefined): AlertRule[] {
  const t = thresholdsOf(cfg);
  return ALERT_RULES.filter((r) => t[r] !== null);
}

/**
 * No backlog on switch-on: a condition that began, or an event that happened, before alerts were switched
 * on raises no new row (rows already there keep being updated and closed as usual).
 */
export function beforeSwitchOn(occurredAt: Date, alertsEnabledAt: Date | null | undefined): boolean {
  return alertsEnabledAt != null && occurredAt.getTime() < alertsEnabledAt.getTime();
}

/**
 * The physical subject of a row: depot|date|truck for a truck-day, + |loadNo for a load, + |sequence for a
 * stop. Frozen loads keep their truck, load number and stop order across re-plans; a load re-solved under
 * another key leaves its old rows to be closed as NOT_IN_PLAN.
 */
export function subjectKeyOf(s: { depotId: string; date: string; truckId: string; loadNo?: number | null; sequence?: number | null }): string {
  const parts = [s.depotId, s.date, s.truckId];
  if (s.loadNo != null) {
    parts.push(String(s.loadNo));
    if (s.sequence != null) parts.push(String(s.sequence));
  } else if (s.sequence != null) {
    throw new Error('subjectKeyOf: a stop needs its load number');
  }
  return parts.join('|');
}

// --- Timing and limits of the engine (not settings) ---

/** The sweep runs at most this often (the janitor ticks every 60 s). */
export const ALERT_SWEEP_EVERY_MS = 120_000;
/** A sweep slower than this is logged (counts only). */
export const ALERT_SWEEP_SLOW_MS = 2_000;
/** Hysteresis: ETA_LATE and the projected AFTER_CLOSING close only when back under the threshold by this much. */
export const ALERT_HYSTERESIS_MIN = 10;
/** A value or text change of the same tier is written only when the value moved this much (or the text changed). */
export const ALERT_VALUE_STEP = 5;
/** LOADING_OVER only for a load whose Loading press is this recent (and not Loaded). */
export const LOADING_START_MAX_AGE_MIN = 12 * 60;
/** DEPART_LATE expires this long after the planned departure (the load is then history; R3 follows the truck). */
export const DEPART_LATE_EXPIRE_MIN = 4 * 60;
/** DEPART_LATE found only after the Dispatch press, within this long of it: one history row (no toast, no e-mail). */
export const DEPART_LATE_HISTORY_MIN = 6 * 60;
/**
 * ETA_LATE and the projected AFTER_CLOSING stop this long after the planned return (the delivery screens
 * count a DISPATCHED load as back then: lib/delivery/day-results.ts BACK_AFTER_RETURN_MIN).
 */
export const RETURN_GRACE_MIN = 60;
/** DRIVER_SILENT also needs the projected arrival at the next stop to be this far behind (a long leg is not silence). */
export const SILENT_AFTER_NEXT_ETA_MIN = 30;
/** UNLOAD_OVER skips an arrival tapped this far from the pin with good accuracy (a tap at the depot is not unloading). */
export const UNLOAD_ARRIVAL_FAR_M = 1000;
/** A position counts as evidence at this accuracy or better (lib/delivery/pin-check.ts EVIDENCE_MAX_ACCURACY_M). */
export const ALERT_EVIDENCE_MAX_ACCURACY_M = 100;
/** PROOF_FAR is tier 2 (HIGH) beyond this multiple of its threshold. */
export const PROOF_FAR_HIGH_FACTOR = 4;
/** The sweep reads yesterday, today and tomorrow in the company's time zone; open condition rows of older dates close as EXPIRED. */
export const ALERT_DAYS_BACK = 1;
export const ALERT_DAYS_AHEAD = 1;
/** Rows are deleted this long after their delivery date (they hold customer names and notes). */
export const ALERT_RETENTION_DAYS = 90;

// --- Texts ---

/** Free text (driver notes, names) loses every run of this many digits or more (spaces, + - / inside the run). */
export const ALERT_REDACT_DIGITS_MIN = 6;
/** A driver note in an alert is cut to this many characters. */
export const ALERT_NOTE_MAX = 140;

// --- In the app ---

/** The bell's dropdown and the summary list this many rows. */
export const ALERT_LATEST_COUNT = 10;
/** At most this many toasts at once; only HIGH rows that may toast and were not already there when the page opened. */
export const ALERT_TOAST_MAX = 3;
/** The bell and the day screen's card poll this often while the tab is visible. */
export const ALERT_POLL_MS = 60_000;
/** One acknowledge request takes at most this many ids. */
export const ALERT_ACK_MAX_IDS = 200;

// --- E-mail ---

/** 'HIGH': HIGH alerts only (the default). 'WARN': WARN and HIGH. */
export const ALERT_EMAIL_SEVERITIES = ['HIGH', 'WARN'] as const;
export type AlertEmailSeverity = (typeof ALERT_EMAIL_SEVERITIES)[number];
export const ALERT_EMAIL_DEFAULTS = { everyMin: 15, minSeverity: 'HIGH' as AlertEmailSeverity, quietFromMin: 22 * 60, quietToMin: 6 * 60 };
export const ALERT_EMAIL_EVERY_BOUNDS = { min: 0, max: 240 } as const;
export const ALERT_QUIET_BOUNDS = { min: 0, max: 1439 } as const;
export const ALERT_EMAILS_MAX = 5;
export const ALERT_EMAILS_MAX_LENGTH = 500;
/** E-mails per company per local day (a check against the e-mail provider's free plan). */
export const ALERT_EMAILS_PER_DAY = 40;
/** A row whose e-mail failed this many times is not tried again. */
export const ALERT_EMAIL_MAX_ATTEMPTS = 3;
/** Only rows seen within this many hours are e-mailed (lastSeenAt, so a reopened or escalated row counts). */
export const ALERT_EMAIL_LOOKBACK_H = 12;

/** Whether a row of this severity goes in the company's e-mail. */
export function emailSeverityPasses(severity: AlertSeverity, minSeverity: string | null | undefined): boolean {
  return minSeverity === 'WARN' ? true : severity === 'HIGH';
}

/**
 * Whether the local minute of the day is inside the quiet hours [from, to) (they may pass midnight:
 * 22:00-06:00). No quiet hours when either end is null or both are equal.
 */
export function inQuietHours(nowMin: number, fromMin: number | null | undefined, toMin: number | null | undefined): boolean {
  if (fromMin == null || toMin == null || fromMin === toMin) return false;
  const m = ((Math.floor(nowMin) % 1440) + 1440) % 1440;
  return fromMin < toMin ? m >= fromMin && m < toMin : m >= fromMin || m < toMin;
}

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

/**
 * The recipients setting: addresses separated by commas, semicolons or spaces; '' = none. Stored as
 * "a@x.example, b@y.example" (duplicates dropped, case-insensitive), at most ALERT_EMAILS_MAX addresses and
 * ALERT_EMAILS_MAX_LENGTH characters.
 */
export function readAlertEmails(raw: string | null | undefined): { ok: true; value: string | null; emails: string[] } | { ok: false; error: string } {
  const parts = (raw ?? '').split(/[\s,;]+/).map((p) => p.trim()).filter(Boolean);
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const p of parts) {
    if (!EMAIL_RE.test(p) || p.length > 254) return { ok: false, error: `"${p.slice(0, 60)}" is not an e-mail address.` };
    const k = p.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      emails.push(p);
    }
  }
  if (emails.length > ALERT_EMAILS_MAX) return { ok: false, error: `At most ${ALERT_EMAILS_MAX} e-mail addresses.` };
  const value = emails.length ? emails.join(', ') : null;
  if (value && value.length > ALERT_EMAILS_MAX_LENGTH) return { ok: false, error: `The e-mail addresses are longer than ${ALERT_EMAILS_MAX_LENGTH} characters.` };
  return { ok: true, value, emails };
}
