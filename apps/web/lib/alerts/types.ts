/**
 * Operations alerts (owner request 16 Oct 2026): the types the engine, the store, the API and the screens
 * share (lib/alerts/catalog.ts has the rules). Pure and browser-safe.
 *
 * Data flow: the sweep reads the facts of yesterday, today and tomorrow (facts.ts), the pure rules turn
 * them into an Evaluation (rules.ts: Candidate rows that are true now, Ended rows whose condition ended or
 * whose event was corrected, and the SweepScopes that were read in full), the store applies it to OpsAlert
 * (store.ts), the e-mail digest claims what is new (notify.ts), and the API answers OpsAlertRow /
 * AlertSummary to the bell, the day screen and the Alerts page.
 */
import type { OpsAlert } from '@prisma/client';
import { isoOf } from '../dispatch/time';
import type { AlertKind, AlertRule, AlertSeverity, AlertTier, ResolvedReason } from './catalog';
import type { AlertReviewValue } from './review';

/** One rule that is true now for one physical subject (rules.ts -> store.ts). */
export interface Candidate {
  rule: AlertRule;
  /** The rule's kind, except AFTER_CLOSING, which is an EVENT once the arrival actually happened. */
  kind: AlertKind;
  /** subjectKeyOf(...): depot|date|truck[|loadNo[|sequence]]. */
  subjectKey: string;
  depotId: string;
  /** The load's delivery date, YYYY-MM-DD. */
  deliveryDate: string;
  truckId: string;
  /** As shown (shownTruckCode: a hired truck's plate). */
  truckCode: string;
  loadNo: number | null;
  sequence: number | null;
  customerId: string | null;
  /** 1-3; the severity follows from it (catalog.ts severityOf). */
  tier: AlertTier;
  /** Minutes, metres or the priority, as the rule measures it. */
  value: number;
  /** The setting it was compared with. */
  threshold: number;
  /** Plain English (text.ts): truck code + L<n>, stop and customer where they apply; digit runs removed. */
  text: string;
  /** When the condition began or the event happened: no new row when before TenantConfig.alertsEnabledAt. */
  occurredAt: Date;
  /** Raise it already resolved, as history only (no toast, no e-mail): DEPART_LATE found after the Dispatch press. */
  history?: boolean;
  /** Kept as OpsAlert.factsJson for support: small, never a phone number. */
  facts?: Record<string, unknown>;
}

/** A subject checked this sweep whose condition ended, or whose event was corrected. */
export interface Ended {
  rule: AlertRule;
  subjectKey: string;
  reason: Extract<ResolvedReason, 'ENDED' | 'CORRECTED' | 'NOT_FOLLOWED'>;
  /** The final words ("Loading took 52 min, 02:10-03:02"; "corrected to Delivered 15:10"). */
  text: string;
}

/**
 * A depot and date whose facts were read in full this sweep, and the rules that were on. In it, an open
 * CONDITION row that is neither a Candidate nor Ended closes as NOT_IN_PLAN (its load or stop left the plan:
 * a re-plan, another plan version, Start fresh), and one of a rule that is off closes as RULE_OFF. A date
 * whose facts could not be read has no scope, so none of its rows closes.
 */
export interface SweepScope {
  depotId: string;
  deliveryDate: string;
  rulesOn: AlertRule[];
}

export interface Evaluation {
  active: Candidate[];
  ended: Ended[];
  scopes: SweepScope[];
  /**
   * Subjects checked this sweep whose open row stays exactly as it is: ETA_LATE and the projected
   * AFTER_CLOSING while DRIVER_SILENT is open for the load (the delay cannot be worked out then; closing
   * and reopening them would page again), ETA_LATE and the projected AFTER_CLOSING while UNLOAD_OVER is
   * raised for the stop being unloaded, and every open row of a rule that failed on a load (`failures`).
   * Never closed as NOT_IN_PLAN.
   */
  held?: { rule: AlertRule; subjectKey: string }[];
  /**
   * A rule that threw on a load: its open rows of that load are held, the other rules and loads still
   * answer (the sweep logs the rule and the error's message, never a text of the facts).
   */
  failures?: { rule: AlertRule; message: string }[];
}

/**
 * Open: needs someone to look (it counts on the bell). Acked: a CONDITION still true that someone has
 * seen, or an EVENT someone dealt with. Resolved: over (a CONDITION that ended, an EVENT corrected, or a
 * row closed as not in the plan, expired, rule off or at the end of its day): history, it needs no
 * acknowledgement.
 */
export type AlertState = 'OPEN' | 'ACKED' | 'RESOLVED';

type StateFields = Pick<OpsAlert, 'resolvedAt' | 'ackedAt'>;

export function alertStateOf(row: StateFields): AlertState {
  if (row.resolvedAt) return 'RESOLVED';
  return row.ackedAt ? 'ACKED' : 'OPEN';
}

/** Counts on the bell: an open CONDITION or EVENT row nobody acknowledged. A higher tier clears the acknowledgement. */
export function needsAttention(row: StateFields): boolean {
  return alertStateOf(row) === 'OPEN';
}

/**
 * The cause & action the office recorded after checking an alert (owner request 20 Oct 2026, lib/alerts/review.ts):
 * the codes (a code no longer offered stays as it was saved), the cleaned texts, follow-up, who and when, and the
 * alert as it was at the last save (its tier, occurrences and customer: it came back, got worse or names another
 * stop since). Never the users' ids.
 */
export interface AlertReviewView extends AlertReviewValue {
  /** ISO times of the first and the last save. */
  firstAt: string;
  savedAt: string;
  /** The names of who saved it last and first (null: the user was deleted). */
  byName: string | null;
  firstByName: string | null;
  /** How many saves (1: never edited). */
  saves: number;
  /** The alert whose save also filled this one (one incident), or null. */
  groupId: string | null;
  tier: number;
  occurrences: number;
  customerId: string | null;
}

/** One alert as the API sends it to the screens (never factsJson or the e-mail state). */
export interface OpsAlertRow {
  id: string;
  rule: AlertRule;
  kind: AlertKind;
  severity: AlertSeverity;
  tier: AlertTier;
  state: AlertState;
  depotId: string;
  /** YYYY-MM-DD. */
  deliveryDate: string;
  truckId: string;
  truckCode: string;
  loadNo: number | null;
  sequence: number | null;
  customerId: string | null;
  value: number;
  threshold: number;
  text: string;
  /** ISO times. */
  occurredAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolvedReason: ResolvedReason | null;
  occurrences: number;
  ackedAt: string | null;
  /** The name of the user who acknowledged it (null: nobody, or the user was deleted). */
  ackedByName: string | null;
  mayToast: boolean;
  /** The cause & action recorded for it (null: none yet). */
  review: AlertReviewView | null;
  /** The 90-day clean-up removed its text and free texts: read-only (its cause & action codes stay). */
  detailsRemoved: boolean;
}

/** GET /api/alerts/summary: the bell. */
export interface AlertSummary {
  /** TenantConfig.alertsEnabled: the bell hides itself when false. */
  enabled: boolean;
  /**
   * The company's today (YYYY-MM-DD in its time zone; absent while alerts are off): the bell shows the day of
   * a row of another day from it (view.ts alertWhen, owner request 19 Oct 2026), not from the browser's clock.
   */
  today?: string;
  /** Rows that need attention (needsAttention): today's and tomorrow's (inbox.ts bellWindow). */
  open: number;
  /** Of them, HIGH. */
  high: number;
  /** The newest rows that need attention, HIGH first (at most ALERT_LATEST_COUNT). */
  latest: OpsAlertRow[];
  /** Today's e-mails reached ALERT_EMAILS_PER_DAY: alerts show in RouteIQ only until tomorrow. */
  emailCapReached: boolean;
  /** The company's last good sweep (ISO; null: none since the server started), and whether the check is overdue or failed (lib/alerts/sweep.ts alertSweepStatus). */
  checkedAt: string | null;
  checkStale: boolean;
  checkFailed: boolean;
}

/** The "Checked" part of a summary or a list answer. */
export type SweepCheck = Pick<AlertSummary, 'checkedAt' | 'checkStale' | 'checkFailed'>;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

type UserName = { name: string } | null | undefined;

/** The users' names a row is read with (Prisma include): who acknowledged it, who saved its cause & action last and first. */
export const ALERT_ROW_USERS = { ackedBy: { select: { name: true } }, reviewedBy: { select: { name: true } }, reviewFirstBy: { select: { name: true } } } as const;

/** The cause & action of a row, or null (none recorded: reviewedAt is NULL; the database keeps it whole). */
export function reviewViewOf(row: OpsAlert & { reviewedBy?: UserName; reviewFirstBy?: UserName }): AlertReviewView | null {
  if (!row.reviewedAt || !row.reviewCause || !row.reviewAction) return null;
  return {
    cause: row.reviewCause,
    causeOther: row.reviewCauseOther ?? null,
    action: row.reviewAction,
    actionOther: row.reviewActionOther ?? null,
    note: row.reviewNote ?? null,
    followUp: !!row.reviewFollowUp,
    firstAt: (row.reviewFirstAt ?? row.reviewedAt).toISOString(),
    savedAt: row.reviewedAt.toISOString(),
    byName: row.reviewedBy?.name ?? null,
    firstByName: row.reviewFirstBy?.name ?? null,
    saves: Math.max(1, row.reviewSaves ?? 1),
    groupId: row.reviewGroupId ?? null,
    tier: row.reviewTier ?? row.tier,
    occurrences: row.reviewOccurrences ?? row.occurrences,
    customerId: row.reviewCustomerId ?? null,
  };
}

/**
 * An OpsAlert row (with the names of the users who acknowledged it and saved its cause & action, when read) as
 * the API sends it.
 */
export function toOpsAlertRow(row: OpsAlert & { ackedBy?: UserName; reviewedBy?: UserName; reviewFirstBy?: UserName }): OpsAlertRow {
  return {
    id: row.id,
    rule: row.rule as AlertRule,
    kind: row.kind as AlertKind,
    severity: row.severity as AlertSeverity,
    tier: row.tier as AlertTier,
    state: alertStateOf(row),
    depotId: row.depotId,
    deliveryDate: isoOf(row.deliveryDate),
    truckId: row.truckId,
    truckCode: row.truckCode,
    loadNo: row.loadNo,
    sequence: row.sequence,
    customerId: row.customerId,
    value: row.value,
    threshold: row.threshold,
    text: row.text,
    occurredAt: row.occurredAt.toISOString(),
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    resolvedAt: iso(row.resolvedAt),
    resolvedReason: (row.resolvedReason as ResolvedReason | null) ?? null,
    occurrences: row.occurrences,
    ackedAt: iso(row.ackedAt),
    ackedByName: row.ackedBy?.name ?? null,
    mayToast: row.mayToast,
    review: reviewViewOf(row),
    detailsRemoved: !!row.detailsRemovedAt,
  };
}
