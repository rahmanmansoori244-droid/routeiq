/**
 * Cause & action of an operations alert (owner request 20 Oct 2026: "add in the alerts a place where a note /
 * reason for the alert to have happened and the solution ... entered by someone after checking and finding a
 * solution ... will help us gather data for what decisions are made when alerts are made"). Pure and
 * browser-safe: the dialog, the API, the export and the tests read the same lists and rules.
 *
 * What the office records after checking an alert (PLANNER and up; every role reads it):
 * - the main CAUSE and the ACTION taken or decided, each a code from a pick-list so the answers can be
 *   counted (the export's "Alert causes & actions" sheet). Each list depends on the rule's family (running
 *   late, unloading, depot turn, delivery result, pin, driver's page) and ends with the same codes in every
 *   family (SETTING_TOO_TIGHT, FALSE_ALARM, NOT_KNOWN, OTHER; NO_ACTION, NONE_YET, OTHER). OTHER takes a short
 *   text of its own (3-120 characters). The selects start empty: a default would skew the counts;
 * - an optional note (at most 500 characters, folded to one line, every run of 6 or more digits removed like
 *   any alert text: no phone number, and dates and times written with digits become "[number]" too);
 * - "needs follow-up", forced on with the action "Nothing yet" or the cause "Not found yet".
 * The database checks only the codes' FORMAT (an upper-case word), not the lists, so a code added here after
 * reading the Other texts needs no migration; a code taken out of a list stays valid on the rows that have it
 * ("earlier choice"). A rule that is no longer in the catalog offers the whole lists.
 */
import { isAlertRule, type AlertRule } from './catalog';
import { oneLine, redactNumbers } from './text';

/** The database CHECK on OpsAlert.reviewCause / reviewAction (migration 20261020000000_alert_notes). */
export const ALERT_REVIEW_CODE_RE = /^[A-Z][A-Z_]{1,39}$/;
export const ALERT_REVIEW_OTHER_MIN = 3;
export const ALERT_REVIEW_OTHER_MAX = 120;
export const ALERT_REVIEW_NOTE_MAX = 500;
/** One save may also fill the cause & action of at most this many other alerts of the same truck and day (one incident). */
export const ALERT_REVIEW_BULK_MAX = 50;
/** The Alerts page's "Follow-up" filter and count look back this many days, whatever dates are chosen. */
export const ALERT_FOLLOWUP_DAYS = 92;

export const ALERT_REVIEW_CAUSES = [
  'TRAFFIC',
  'EARLIER_STOPS_LONG',
  'LATE_DEPOT_START',
  'NO_CREW',
  'LOADING_DELAY',
  'STOCK_SHORT',
  'WAITING_AT_CUSTOMER',
  'CUSTOMER_NOT_READY',
  'CUSTOMER_CLOSED',
  'CUSTOMER_ASKED_OTHER_TIME',
  'CUSTOMER_REFUSED',
  'PAYMENT_ISSUE',
  'DAMAGED_GOODS',
  'LONG_UNLOADING',
  'ACCESS_PROBLEM',
  'WRONG_PIN',
  'SECOND_DROP_POINT',
  'OUT_OF_TIME',
  'DRIVER_BREAK',
  'DRIVER_DID_NOT_TAP',
  'LATE_TAP',
  'NEW_DRIVER',
  'PHONE_ISSUE',
  'OFFICE_DID_NOT_UPDATE',
  'TRUCK_BREAKDOWN',
  'PLAN_CHANGED',
  'PLAN_WRONG',
  'GPS_ISSUE',
  'SETTING_TOO_TIGHT',
  'FALSE_ALARM',
  'NOT_KNOWN',
  'OTHER',
] as const;
export type AlertReviewCause = (typeof ALERT_REVIEW_CAUSES)[number];

export const ALERT_REVIEW_CAUSE_TEXT: Record<AlertReviewCause, string> = {
  TRAFFIC: 'Traffic or road delay',
  EARLIER_STOPS_LONG: 'Earlier stops took longer (knock-on delay)',
  LATE_DEPOT_START: 'Late start from the depot (driver or helper late)',
  NO_CREW: 'No driver or helper (absent, on leave)',
  LOADING_DELAY: 'Loading delay at the depot (warehouse, queue, paperwork)',
  STOCK_SHORT: 'Stock short or wrong items loaded',
  WAITING_AT_CUSTOMER: 'Waiting at the customer (queue, receiver busy, paperwork)',
  CUSTOMER_NOT_READY: 'Customer not ready (no receiver, no space, not expecting us)',
  CUSTOMER_CLOSED: 'Customer closed',
  CUSTOMER_ASKED_OTHER_TIME: 'Customer asked for another time or day',
  CUSTOMER_REFUSED: 'Customer refused or cancelled the order',
  PAYMENT_ISSUE: 'Payment problem (cash not ready, credit hold)',
  DAMAGED_GOODS: 'Damaged or expired goods',
  LONG_UNLOADING: 'Long unloading at this stop (many cases, stairs, far door)',
  ACCESS_PROBLEM: 'No access or parking at the site',
  WRONG_PIN: 'Wrong pin or address',
  SECOND_DROP_POINT: "Delivered at another drop point of the customer's site",
  OUT_OF_TIME: 'Ran out of time on the route',
  DRIVER_BREAK: 'Driver break or prayer',
  DRIVER_DID_NOT_TAP: 'Driver did not tap (forgot, did not use the page)',
  LATE_TAP: 'Driver tapped late (after leaving)',
  NEW_DRIVER: 'New or daily driver, not shown the page yet',
  PHONE_ISSUE: "Driver's phone, page or network problem",
  OFFICE_DID_NOT_UPDATE: 'Office did not update RouteIQ (dispatch, result, times)',
  TRUCK_BREAKDOWN: 'Truck breakdown or accident',
  PLAN_CHANGED: 'Plan changed on the day (stop moved, truck swapped)',
  PLAN_WRONG: "Plan wrong (customer's hours, unloading time, trip too long)",
  GPS_ISSUE: 'GPS or tracker problem (position wrong or missing)',
  SETTING_TOO_TIGHT: 'Alert setting too tight (this is normal for us)',
  FALSE_ALARM: 'False alarm (nothing happened)',
  NOT_KNOWN: 'Not found yet (follow up)',
  OTHER: 'Other (write it)',
};

export const ALERT_REVIEW_ACTIONS = [
  'CALLED_DRIVER',
  'CALLED_CUSTOMER',
  'CALLED_WAREHOUSE',
  'INFORMED_SALES',
  'REPLANNED',
  'MOVED_TRUCK',
  'POSTPONED',
  'DELIVERED_LATER',
  'CANCELLED_ORDER',
  'FIXED_PIN',
  'CHANGED_CUSTOMER_TIMES',
  'UPDATED_ROUTEIQ',
  'REMINDED_DRIVER',
  'SHOWED_DRIVER_PAGE',
  'RESENT_LINK',
  'SENT_HELP',
  'CHANGED_SETTING',
  'ESCALATED',
  'NO_ACTION',
  'NONE_YET',
  'OTHER',
] as const;
export type AlertReviewAction = (typeof ALERT_REVIEW_ACTIONS)[number];

export const ALERT_REVIEW_ACTION_TEXT: Record<AlertReviewAction, string> = {
  CALLED_DRIVER: 'Called the driver',
  CALLED_CUSTOMER: 'Called the customer',
  CALLED_WAREHOUSE: 'Called the warehouse or loading team',
  INFORMED_SALES: 'Told the salesman or sales office',
  REPLANNED: 'Re-planned (changed the stop order or times)',
  MOVED_TRUCK: 'Moved the stop to another truck',
  POSTPONED: 'Postponed to another day',
  DELIVERED_LATER: 'Delivered later the same day',
  CANCELLED_ORDER: 'Cancelled the order',
  FIXED_PIN: 'Fixed the pin',
  CHANGED_CUSTOMER_TIMES: "Changed the customer's hours or unloading time",
  UPDATED_ROUTEIQ: 'Updated RouteIQ for the driver (times, result, dispatch)',
  REMINDED_DRIVER: 'Reminded the driver (taps, page)',
  SHOWED_DRIVER_PAGE: 'Showed the driver how to use the page',
  RESENT_LINK: 'Sent the driver link again',
  SENT_HELP: 'Sent help (mechanic, replacement truck, helper)',
  CHANGED_SETTING: 'Changed the alert setting',
  ESCALATED: 'Reported to the supervisor or manager',
  NO_ACTION: 'No action needed',
  NONE_YET: 'Nothing yet (follow up)',
  OTHER: 'Other (write it)',
};

/** The rule families whose cause and action lists differ. */
export const REVIEW_FAMILIES = ['LATENESS', 'UNLOADING', 'DEPOT', 'DELIVERY', 'PIN', 'DRIVER_APP'] as const;
export type ReviewFamily = (typeof REVIEW_FAMILIES)[number];

export const REVIEW_FAMILY_LABEL: Record<ReviewFamily, string> = {
  LATENESS: 'Running late',
  UNLOADING: 'Unloading',
  DEPOT: 'Depot turn and dispatch',
  DELIVERY: 'Delivery result',
  PIN: 'Pin and proof',
  DRIVER_APP: "Driver's page and taps",
};

/** Every rule has a family (a Record over AlertRule: tsc fails when a rule is added without one). */
export const REVIEW_FAMILY_OF: Record<AlertRule, ReviewFamily> = {
  ETA_LATE: 'LATENESS',
  AFTER_CLOSING: 'LATENESS',
  UNLOAD_OVER: 'UNLOADING',
  LOADING_OVER: 'DEPOT',
  DEPART_LATE: 'DEPOT',
  PRIORITY_NOT_DELIVERED: 'DELIVERY',
  DELIVERED_WITH_NOTE: 'DELIVERY',
  PROOF_FAR: 'PIN',
  DRIVER_SILENT: 'DRIVER_APP',
  LOAD_NOT_CLOSED: 'DRIVER_APP',
  PAGE_NOT_OPENED: 'DRIVER_APP',
};

/** The codes every family ends with. */
export const REVIEW_CAUSE_TAIL = ['SETTING_TOO_TIGHT', 'FALSE_ALARM', 'NOT_KNOWN', 'OTHER'] as const satisfies readonly AlertReviewCause[];
export const REVIEW_ACTION_TAIL = ['NO_ACTION', 'NONE_YET', 'OTHER'] as const satisfies readonly AlertReviewAction[];

/** The causes of each family, in the order the dialog lists them (the tail last). */
export const REVIEW_FAMILY_CAUSES: Record<ReviewFamily, readonly AlertReviewCause[]> = {
  LATENESS: [
    'TRAFFIC',
    'EARLIER_STOPS_LONG',
    'LATE_DEPOT_START',
    'NO_CREW',
    'LOADING_DELAY',
    'WAITING_AT_CUSTOMER',
    'LONG_UNLOADING',
    'CUSTOMER_NOT_READY',
    'CUSTOMER_CLOSED',
    'CUSTOMER_ASKED_OTHER_TIME',
    'ACCESS_PROBLEM',
    'WRONG_PIN',
    'OUT_OF_TIME',
    'DRIVER_BREAK',
    'TRUCK_BREAKDOWN',
    'PLAN_CHANGED',
    'PLAN_WRONG',
    'DRIVER_DID_NOT_TAP',
    'NEW_DRIVER',
    'GPS_ISSUE',
    ...REVIEW_CAUSE_TAIL,
  ],
  UNLOADING: [
    'WAITING_AT_CUSTOMER',
    'CUSTOMER_NOT_READY',
    'LONG_UNLOADING',
    'PAYMENT_ISSUE',
    'ACCESS_PROBLEM',
    'DAMAGED_GOODS',
    'STOCK_SHORT',
    'CUSTOMER_REFUSED',
    'DRIVER_BREAK',
    'DRIVER_DID_NOT_TAP',
    'LATE_TAP',
    'NEW_DRIVER',
    'SECOND_DROP_POINT',
    'WRONG_PIN',
    'PLAN_WRONG',
    'GPS_ISSUE',
    ...REVIEW_CAUSE_TAIL,
  ],
  DEPOT: [
    'LOADING_DELAY',
    'STOCK_SHORT',
    'LATE_DEPOT_START',
    'NO_CREW',
    'DRIVER_BREAK',
    'TRUCK_BREAKDOWN',
    'PLAN_CHANGED',
    'PLAN_WRONG',
    'OFFICE_DID_NOT_UPDATE',
    'DRIVER_DID_NOT_TAP',
    'NEW_DRIVER',
    'GPS_ISSUE',
    ...REVIEW_CAUSE_TAIL,
  ],
  DELIVERY: [
    'CUSTOMER_CLOSED',
    'CUSTOMER_NOT_READY',
    'CUSTOMER_ASKED_OTHER_TIME',
    'CUSTOMER_REFUSED',
    'PAYMENT_ISSUE',
    'STOCK_SHORT',
    'DAMAGED_GOODS',
    'OUT_OF_TIME',
    'ACCESS_PROBLEM',
    'WRONG_PIN',
    'TRUCK_BREAKDOWN',
    'PLAN_WRONG',
    ...REVIEW_CAUSE_TAIL,
  ],
  PIN: ['WRONG_PIN', 'SECOND_DROP_POINT', 'LATE_TAP', 'GPS_ISSUE', 'PHONE_ISSUE', 'NEW_DRIVER', ...REVIEW_CAUSE_TAIL],
  DRIVER_APP: [
    'DRIVER_DID_NOT_TAP',
    'NEW_DRIVER',
    'PHONE_ISSUE',
    'OFFICE_DID_NOT_UPDATE',
    'DRIVER_BREAK',
    'TRUCK_BREAKDOWN',
    'PLAN_CHANGED',
    'LATE_DEPOT_START',
    'NO_CREW',
    'GPS_ISSUE',
    ...REVIEW_CAUSE_TAIL,
  ],
};

/** The actions of each family (the tail last). */
export const REVIEW_FAMILY_ACTIONS: Record<ReviewFamily, readonly AlertReviewAction[]> = {
  LATENESS: [
    'CALLED_DRIVER',
    'CALLED_CUSTOMER',
    'CALLED_WAREHOUSE',
    'INFORMED_SALES',
    'REPLANNED',
    'MOVED_TRUCK',
    'POSTPONED',
    'DELIVERED_LATER',
    'CANCELLED_ORDER',
    'CHANGED_CUSTOMER_TIMES',
    'FIXED_PIN',
    'SENT_HELP',
    'CHANGED_SETTING',
    'ESCALATED',
    ...REVIEW_ACTION_TAIL,
  ],
  UNLOADING: [
    'CALLED_DRIVER',
    'CALLED_CUSTOMER',
    'INFORMED_SALES',
    'CHANGED_CUSTOMER_TIMES',
    'FIXED_PIN',
    'UPDATED_ROUTEIQ',
    'REMINDED_DRIVER',
    'SHOWED_DRIVER_PAGE',
    'CHANGED_SETTING',
    'ESCALATED',
    ...REVIEW_ACTION_TAIL,
  ],
  DEPOT: [
    'CALLED_DRIVER',
    'CALLED_WAREHOUSE',
    'REPLANNED',
    'MOVED_TRUCK',
    'POSTPONED',
    'SENT_HELP',
    'UPDATED_ROUTEIQ',
    'REMINDED_DRIVER',
    'SHOWED_DRIVER_PAGE',
    'CHANGED_SETTING',
    'ESCALATED',
    ...REVIEW_ACTION_TAIL,
  ],
  DELIVERY: [
    'CALLED_DRIVER',
    'CALLED_CUSTOMER',
    'INFORMED_SALES',
    'DELIVERED_LATER',
    'MOVED_TRUCK',
    'POSTPONED',
    'CANCELLED_ORDER',
    'FIXED_PIN',
    'CHANGED_CUSTOMER_TIMES',
    'ESCALATED',
    ...REVIEW_ACTION_TAIL,
  ],
  PIN: ['FIXED_PIN', 'CALLED_DRIVER', 'CALLED_CUSTOMER', 'REMINDED_DRIVER', 'SHOWED_DRIVER_PAGE', 'CHANGED_SETTING', ...REVIEW_ACTION_TAIL],
  DRIVER_APP: [
    'CALLED_DRIVER',
    'REMINDED_DRIVER',
    'SHOWED_DRIVER_PAGE',
    'UPDATED_ROUTEIQ',
    'RESENT_LINK',
    'REPLANNED',
    'SENT_HELP',
    'CHANGED_SETTING',
    'ESCALATED',
    ...REVIEW_ACTION_TAIL,
  ],
};

/** The cause and the action that turn "needs follow-up" on by themselves. */
export const REVIEW_FOLLOWUP_CAUSES: readonly string[] = ['NOT_KNOWN'];
export const REVIEW_FOLLOWUP_ACTIONS: readonly string[] = ['NONE_YET'];

/** What the dialog sends (and the API reads). */
export interface AlertReviewInput {
  cause: string;
  causeOther?: string | null;
  action: string;
  actionOther?: string | null;
  note?: string | null;
  followUp?: boolean;
}

/** A cause & action as stored: codes, the cleaned texts, follow-up. */
export interface AlertReviewValue {
  cause: string;
  causeOther: string | null;
  action: string;
  actionOther: string | null;
  note: string | null;
  followUp: boolean;
}

export type AlertReviewProblemCode = 'REVIEW_CAUSE_REQUIRED' | 'REVIEW_ACTION_REQUIRED' | 'REVIEW_CODE_NOT_FOR_RULE' | 'REVIEW_OTHER_REQUIRED';

export type NormalisedReview = { ok: true; value: AlertReviewValue } | { ok: false; code: AlertReviewProblemCode; field: 'cause' | 'action'; message: string };

export function reviewFamilyOf(rule: string): ReviewFamily | null {
  return isAlertRule(rule) ? REVIEW_FAMILY_OF[rule] : null;
}

/** The codes offered for a rule: its family's lists, or the whole lists for a rule no longer in the catalog. */
export function reviewCodesFor(rule: string): { causes: readonly string[]; actions: readonly string[] } {
  const f = reviewFamilyOf(rule);
  return f ? { causes: REVIEW_FAMILY_CAUSES[f], actions: REVIEW_FAMILY_ACTIONS[f] } : { causes: ALERT_REVIEW_CAUSES, actions: ALERT_REVIEW_ACTIONS };
}

export function causeLabel(code: string): string {
  return (ALERT_REVIEW_CAUSE_TEXT as Record<string, string>)[code] ?? code;
}

export function actionLabel(code: string): string {
  return (ALERT_REVIEW_ACTION_TEXT as Record<string, string>)[code] ?? code;
}

export interface ReviewOption {
  code: string;
  label: string;
  /** A code stored on the row that is no longer offered for its rule: kept so the row stays editable. */
  earlier?: true;
}

/** The dialog's two lists for a rule; a code the row already has that is no longer offered comes last as "(earlier choice)". */
export function reviewOptions(rule: string, current?: { cause?: string | null; action?: string | null } | null): { causes: ReviewOption[]; actions: ReviewOption[] } {
  const codes = reviewCodesFor(rule);
  const list = (offered: readonly string[], stored: string | null | undefined, label: (c: string) => string): ReviewOption[] => {
    const out: ReviewOption[] = offered.map((code) => ({ code, label: label(code) }));
    if (stored && !offered.includes(stored)) out.push({ code: stored, label: `${label(stored)} (earlier choice)`, earlier: true });
    return out;
  };
  return { causes: list(codes.causes, current?.cause, causeLabel), actions: list(codes.actions, current?.action, actionLabel) };
}

/** Cut to at most `max` characters (whole characters: an emoji is never split, unlike text.ts cut). */
export function cutChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…` : text;
}

/** Characters as the database counts them (char_length: code points). */
export const charCount = (text: string | null | undefined) => (text ? Array.from(text).length : 0);

/** A free text as stored: one line, every run of 6 or more digits removed, cut; null when empty. */
export function cleanReviewText(text: string | null | undefined, max: number): string | null {
  const t = redactNumbers(oneLine(text));
  return t ? cutChars(t, max) : null;
}

/** Whether a cause or an action needs follow-up by itself. */
export function forcesFollowUp(v: { cause?: string | null; action?: string | null }): boolean {
  return (!!v.cause && REVIEW_FOLLOWUP_CAUSES.includes(v.cause)) || (!!v.action && REVIEW_FOLLOWUP_ACTIONS.includes(v.action));
}

/**
 * The cause & action to store for an alert of `rule`, or why not. A code is accepted when its rule's family
 * offers it, or when it is the one the row already has (an earlier choice stays editable). The Other texts are
 * kept only with OTHER, which needs one of at least 3 characters (after cleaning); an empty note is none.
 */
export function normaliseReview(rule: string, input: AlertReviewInput, current: { cause?: string | null; action?: string | null } | null): NormalisedReview {
  const codes = reviewCodesFor(rule);
  const cause = (input.cause ?? '').trim();
  const action = (input.action ?? '').trim();
  if (!cause) return { ok: false, code: 'REVIEW_CAUSE_REQUIRED', field: 'cause', message: 'Pick the main cause.' };
  if (!action) return { ok: false, code: 'REVIEW_ACTION_REQUIRED', field: 'action', message: 'Pick the action taken or decided.' };
  if (!codes.causes.includes(cause) && cause !== current?.cause) {
    return { ok: false, code: 'REVIEW_CODE_NOT_FOR_RULE', field: 'cause', message: `"${causeLabel(cause)}" is not a cause offered for this alert.` };
  }
  if (!codes.actions.includes(action) && action !== current?.action) {
    return { ok: false, code: 'REVIEW_CODE_NOT_FOR_RULE', field: 'action', message: `"${actionLabel(action)}" is not an action offered for this alert.` };
  }
  const causeOther = cause === 'OTHER' ? cleanReviewText(input.causeOther, ALERT_REVIEW_OTHER_MAX) : null;
  if (cause === 'OTHER' && charCount(causeOther) < ALERT_REVIEW_OTHER_MIN) {
    return { ok: false, code: 'REVIEW_OTHER_REQUIRED', field: 'cause', message: `Write the other cause (at least ${ALERT_REVIEW_OTHER_MIN} characters).` };
  }
  const actionOther = action === 'OTHER' ? cleanReviewText(input.actionOther, ALERT_REVIEW_OTHER_MAX) : null;
  if (action === 'OTHER' && charCount(actionOther) < ALERT_REVIEW_OTHER_MIN) {
    return { ok: false, code: 'REVIEW_OTHER_REQUIRED', field: 'action', message: `Write the other action (at least ${ALERT_REVIEW_OTHER_MIN} characters).` };
  }
  return {
    ok: true,
    value: {
      cause,
      causeOther,
      action,
      actionOther,
      note: cleanReviewText(input.note, ALERT_REVIEW_NOTE_MAX),
      followUp: !!input.followUp || forcesFollowUp({ cause, action }),
    },
  };
}

/** Whether a stored value (cleaned) fits another alert's rule: both codes offered for it (a bulk save skips the rest). */
export function reviewFitsRule(rule: string, v: Pick<AlertReviewValue, 'cause' | 'action'>): boolean {
  const codes = reviewCodesFor(rule);
  return codes.causes.includes(v.cause) && codes.actions.includes(v.action);
}

/** Two cause & actions are the same (a save that changes nothing writes and audits nothing). */
export function sameReview(a: AlertReviewValue | null, b: AlertReviewValue | null): boolean {
  if (!a || !b) return a === b;
  return a.cause === b.cause && a.causeOther === b.causeOther && a.action === b.action && a.actionOther === b.actionOther && a.note === b.note && a.followUp === b.followUp;
}

/** The part of an alert row these flags read (types.ts OpsAlertRow). */
interface ReviewedAlert {
  tier: number;
  occurrences: number;
  customerId: string | null;
  review: { tier: number; occurrences: number; customerId: string | null } | null;
}

/** The alert came back (closed and raised again) after the cause & action was saved: check it still fits. */
export function reviewCameBack(r: ReviewedAlert): boolean {
  return !!r.review && r.occurrences > r.review.occurrences;
}

/** The alert got worse (a higher tier) after the cause & action was saved. */
export function reviewGotWorse(r: ReviewedAlert): boolean {
  return !!r.review && r.tier > r.review.tier;
}

/** The alert's stop now has another customer than when the cause & action was saved (a re-plan moved another stop to its place). */
export function reviewOtherStop(r: ReviewedAlert): boolean {
  return !!r.review && (r.customerId ?? null) !== (r.review.customerId ?? null);
}
