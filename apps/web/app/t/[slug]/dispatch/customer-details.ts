/**
 * The Details dialog's form on the day screen (audit F07, owner decision 9). Pure (no React), so it
 * is unit-tested in tests/lib/dispatch-customer-details.spec.ts (with the dialog itself).
 *
 * - Receiving hours are read with the shared strict parser (`parseHhmm`, lib/dispatch/time.ts):
 *   "06:90" is refused. The dialog's own parser read it as 07:30.
 * - Unloading time is a whole number of minutes, 0 to 480. "10 min" or "ten" is refused (it used to
 *   become 0 minutes). Blank = no own time: the customer-type or Settings default applies, and the
 *   customer is not marked as confirmed. An explicit 0 stays allowed.
 * - Save sends only the fields the dispatcher changed. Before, every Save sent the priority and the
 *   unloading time as shown - the defaults included - and the server marked both as confirmed, so a
 *   default nobody looked at became the customer's own value.
 * - A window is one value: when either end changed, both ends are sent as shown (A2 review). One end
 *   alone was merged by the route with the other end as stored, which a form opened earlier may no
 *   longer show, so a window nobody typed could be saved (06:00-10:00 on screen, 12:00-15:00 stored
 *   since, end set to 16:00: 12:00-16:00 saved).
 * - Own confirmed window (owner decision 1 Oct 2026): hours typed here are confirmed by the server
 *   (who and when); "Open all day" confirms a customer who accepts any time (no hours, and the
 *   customer-type default no longer applies); "Hours confirmed with the customer" confirms the hours
 *   shown without changing them (sent whole). Clearing every hour leaves the customer unconfirmed.
 * - Owner request 12 Oct 2026: "Phone (for the driver to call)", optional. Checked with the server's
 *   own rule (readCustomerPhone, lib/dispatch/customer-phone.ts) and sent only when it changed (as
 *   the server would store it: "9123  4567" typed for "9123 4567" is no change); emptied = no phone.
 * - Owner request 13 Oct 2026: "Small truck only (3-ton)", a tick box, sent only when it changed
 *   (lib/dispatch/small-truck.ts: planned on small trucks only, refused at LOCK on a bigger truck).
 * - Owner request 16 Oct 2026: "Loading instruction (warehouse)", optional, at most 200 characters on one
 *   line, checked with the server's own rule (readLoadingInstruction, lib/dispatch/loading-instruction.ts)
 *   only when it changed as the server would store it (line breaks and spaces typed differently are no
 *   change), and sent only then; emptied = none (null). A stored value that breaks the rule (written to
 *   the database by hand) does not stop a save of the other fields while it is left as it is.
 * - Owner request 19 Oct 2026: "GPS site radius (m)", optional, whole metres 100-500 (readSiteRadius,
 *   lib/ivms/site-radius.ts, the server's own bounds), sent only when it changed; emptied = null (the
 *   company's stop radius). For big customers whose trucks unload at several points of one site.
 */
import { readCustomerPhone } from '@/lib/dispatch/customer-phone';
import { foldLoadingInstruction, readLoadingInstruction } from '@/lib/dispatch/loading-instruction';
import { readSiteRadius } from '@/lib/ivms/site-radius';
import { MAX_SERVICE_MIN } from '@/lib/dispatch/service-time';
import { fmtHhmm, parseHhmm } from '@/lib/dispatch/time';

/** What the dialog is opened with (the day overview's customer). */
export interface DetailsCustomer {
  customerType: string | null;
  /** The priority in use (effective). */
  priority: number;
  /** CUSTOMER = its own confirmed priority; TYPE / DEFAULT = a default nobody confirmed. Absent = own. */
  prioritySource?: string;
  /** The unloading minutes in use (effective). */
  serviceMin: number;
  /** CUSTOMER = its own confirmed time; TYPE / DEFAULT = the customer-type or Settings default. Absent = own. */
  serviceSource?: string;
  hardWindowStartMin: number | null;
  hardWindowEndMin: number | null;
  prefWindowStartMin: number | null;
  prefWindowEndMin: number | null;
  /** An own confirmed window (owner decision 1 Oct 2026): the hours were entered or confirmed by a dispatcher or admin. Absent = not confirmed. */
  windowConfirmed?: boolean;
  /** The customer's phone for the driver (owner request 12 Oct 2026). Absent or null = none. */
  phone?: string | null;
  /** Small trucks only (owner request 13 Oct 2026). Absent = false. */
  smallTruckOnly?: boolean;
  /** The warehouse's loading instruction (owner request 16 Oct 2026). Absent or null = none. */
  loadingInstruction?: string | null;
  /** The GPS site radius in metres (owner request 19 Oct 2026). Absent or null = the company's stop radius. */
  siteRadiusM?: number | null;
}

/** The form as typed. '' = not set / the default applies. */
export interface DetailsForm {
  type: string;
  /** '' = the default priority in use, not confirmed; '1'..'5' = a priority the dispatcher gives. */
  priority: string;
  /** '' = no own time (the customer-type or Settings default); else minutes as typed. */
  service: string;
  hardStart: string;
  hardEnd: string;
  prefStart: string;
  prefEnd: string;
  /** "Open all day": the customer accepts deliveries at any time (confirmed, no hours). Absent = false. */
  openAllDay?: boolean;
  /** "Hours confirmed with the customer" ticked. Absent = false. */
  confirmHours?: boolean;
  /** "Phone (for the driver to call)" as typed; '' = no phone. Absent = ''. */
  phone?: string;
  /** "Small truck only (3-ton)" ticked. Absent = false. */
  smallTruckOnly?: boolean;
  /** "Loading instruction (warehouse)" as typed; '' = none. Absent = ''. */
  loadingInstruction?: string;
  /** "GPS site radius (m)" as typed; '' = the company's stop radius. Absent = ''. */
  siteRadius?: string;
}

/** The PATCH /api/customers/:id body: only the fields that changed (a changed window with both ends). */
export interface DetailsPatch {
  customerType?: string | null;
  priority?: number;
  /** null = back to the customer-type or Settings default (not confirmed). */
  avgServiceTimeMin?: number | null;
  hardWindowStartMin?: number | null;
  hardWindowEndMin?: number | null;
  prefWindowStartMin?: number | null;
  prefWindowEndMin?: number | null;
  /** true = the hours as sent (or as stored) are confirmed; sent for "Open all day" and for confirming unchanged hours. */
  windowConfirmed?: boolean;
  /** The phone for the driver (owner request 12 Oct 2026); null = no phone any more. */
  phone?: string | null;
  /** Small trucks only (owner request 13 Oct 2026). */
  smallTruckOnly?: boolean;
  /** The warehouse's loading instruction (owner request 16 Oct 2026); null = none any more. */
  loadingInstruction?: string | null;
  /** The GPS site radius (owner request 19 Oct 2026); null = the company's stop radius again. */
  siteRadiusM?: number | null;
}

export const EMPTY_DETAILS: DetailsForm = { type: '', priority: '', service: '', hardStart: '', hardEnd: '', prefStart: '', prefEnd: '', openAllDay: false, confirmHours: false, phone: '', smallTruckOnly: false, loadingInstruction: '', siteRadius: '' };

const isOwn = (source: string | undefined) => source === undefined || source === 'CUSTOMER';

/**
 * A window minute as the form shows it. 1440 (end of day) is "24:00": fmtHhmm shows "00:00 +1",
 * which the form could not read back, so a customer receiving until midnight could not be saved.
 */
export function windowText(min: number | null): string {
  if (min === null) return '';
  return min === 1440 ? '24:00' : fmtHhmm(min);
}

export function detailsFormOf(c: DetailsCustomer): DetailsForm {
  return {
    type: c.customerType ?? '',
    priority: isOwn(c.prioritySource) ? String(c.priority) : '',
    service: isOwn(c.serviceSource) ? String(c.serviceMin) : '',
    hardStart: windowText(c.hardWindowStartMin),
    hardEnd: windowText(c.hardWindowEndMin),
    prefStart: windowText(c.prefWindowStartMin),
    prefEnd: windowText(c.prefWindowEndMin),
    openAllDay: !!c.windowConfirmed && [c.hardWindowStartMin, c.hardWindowEndMin, c.prefWindowStartMin, c.prefWindowEndMin].every((v) => v === null),
    confirmHours: !!c.windowConfirmed,
    phone: c.phone ?? '',
    smallTruckOnly: !!c.smallTruckOnly,
    loadingInstruction: c.loadingInstruction ?? '',
    siteRadius: c.siteRadiusM ? String(c.siteRadiusM) : '',
  };
}

export type ServiceParse = { ok: true; minutes: number | null } | { ok: false; error: string };

/** Unloading minutes as typed: blank = null (the default applies), a whole number 0..480, or why not. */
export function parseServiceMinutes(raw: string): ServiceParse {
  const s = raw.trim();
  if (!s) return { ok: true, minutes: null };
  if (!/^\d+$/.test(s)) {
    return { ok: false, error: `Unloading time "${s}": enter whole minutes, e.g. 15 (0 = no unloading time). Leave it empty to use the default.` };
  }
  const n = Number(s);
  if (n > MAX_SERVICE_MIN) return { ok: false, error: `Unloading time: at most ${MAX_SERVICE_MIN} minutes.` };
  return { ok: true, minutes: n };
}

const WINDOWS = [
  ['hardStart', 'hardEnd', 'hardWindowStartMin', 'hardWindowEndMin', 'Receiving hours (hard)'],
  ['prefStart', 'prefEnd', 'prefWindowStartMin', 'prefWindowEndMin', 'Preferred hours'],
] as const;

type Times = Record<'hardStart' | 'hardEnd' | 'prefStart' | 'prefEnd', number | null>;

function readTimes(f: DetailsForm): { ok: true; times: Times } | { ok: false; error: string } {
  const times = {} as Times;
  for (const [a, b, , , label] of WINDOWS) {
    for (const [key, end] of [[a, 'start'], [b, 'end']] as const) {
      try {
        times[key] = parseHhmm(f[key]);
      } catch {
        return { ok: false, error: `${label} ${end} "${f[key].trim()}" is not a time. Use HH:MM, e.g. 06:30 (24:00 = midnight at the end of the day).` };
      }
    }
  }
  return { ok: true, times };
}

export type DetailsResult = { ok: true; patch: DetailsPatch } | { ok: false; error: string };

/**
 * What Save sends: the fields whose value differs from the form as it opened (`initial`), after
 * every field was checked. Nothing is sent when one of them is wrong. An empty patch = nothing
 * changed. A window whose start or end changed is sent whole (both ends as on screen), never one
 * end alone.
 */
export function detailsPatch(initial: DetailsForm, now: DetailsForm): DetailsResult {
  // "Open all day": the hours on screen are not used (the boxes are off), so they are not checked.
  const nowTimes = now.openAllDay ? readTimes(EMPTY_DETAILS) : readTimes(now);
  if (!nowTimes.ok) return nowTimes;
  const t = nowTimes.times;
  for (const [a, b, , , label] of WINDOWS) {
    if ((t[a] === null) !== (t[b] === null)) return { ok: false, error: `${label}: give both the start and the end (or leave both empty).` };
    const s = t[a];
    const e = t[b];
    if (s !== null && e !== null && e <= s) return { ok: false, error: `${label}: the end must be after the start.` };
  }
  const service = parseServiceMinutes(now.service);
  if (!service.ok) return service;
  if (now.priority !== '' && !/^[1-5]$/.test(now.priority)) return { ok: false, error: 'Priority: P1 to P5.' };
  const phone = readCustomerPhone(now.phone);
  if (!phone.ok) return phone;
  // The loading instruction is checked only when it changed (compared as the server stores it: one line,
  // trimmed, so typed differently is no change). A value written to the database by hand that breaks the
  // rule (over 200 characters) never stops a save of the customer's other fields (review of 16 Oct).
  const instructionNow = foldLoadingInstruction(now.loadingInstruction ?? '');
  const instruction = instructionNow !== foldLoadingInstruction(initial.loadingInstruction ?? '') ? readLoadingInstruction(instructionNow) : null;
  if (instruction && !instruction.ok) return instruction;
  // The GPS site radius: checked with the server's bounds; sent only when it changed.
  const site = readSiteRadius(now.siteRadius);
  if (!site.ok) return site;

  const patch: DetailsPatch = {};
  if (now.type !== initial.type) patch.customerType = now.type || null;
  // '' is offered only while the priority is a default: choosing any P (the same number included) confirms it.
  if (now.priority !== initial.priority && now.priority !== '') patch.priority = Number(now.priority);
  const before = parseServiceMinutes(initial.service);
  if (!before.ok || before.minutes !== service.minutes) patch.avgServiceTimeMin = service.minutes;
  // The phone as the server stores it: spaces typed differently are no change.
  const phoneWas = readCustomerPhone(initial.phone);
  if (!phoneWas.ok || phoneWas.phone !== phone.phone) patch.phone = phone.phone;
  if (!!now.smallTruckOnly !== !!initial.smallTruckOnly) patch.smallTruckOnly = !!now.smallTruckOnly;
  if (instruction?.ok) patch.loadingInstruction = instruction.text;
  const siteWas = readSiteRadius(initial.siteRadius);
  if (!siteWas.ok || siteWas.radiusM !== site.radiusM) patch.siteRadiusM = site.radiusM;
  // Receiving hours (owner decision 1 Oct 2026, "own confirmed window"): hours the dispatcher enters
  // are confirmed by the server; "Open all day" is confirmed with no hours; ticking "confirmed with
  // the customer" confirms the hours as shown (sent whole, so what is confirmed is what was seen).
  const all = (patchTimes: Times) => {
    for (const [a, b, fa, fb] of WINDOWS) {
      patch[fa] = patchTimes[a];
      patch[fb] = patchTimes[b];
    }
  };
  if (now.openAllDay) {
    if (!initial.openAllDay) {
      all(t);
      patch.windowConfirmed = true;
    }
    return { ok: true, patch };
  }
  const was = readTimes(initial);
  let changed = false;
  for (const [a, b, fa, fb] of WINDOWS) {
    if (!was.ok || was.times[a] !== t[a] || was.times[b] !== t[b]) {
      patch[fa] = t[a];
      patch[fb] = t[b];
      changed = true;
    }
  }
  const anyHours = Object.values(t).some((v) => v !== null);
  // "Open all day" switched off: the hours as on screen (none = not confirmed any more).
  if (initial.openAllDay && !changed) all(t);
  else if (!changed && now.confirmHours && !initial.confirmHours && anyHours) {
    all(t);
    patch.windowConfirmed = true;
  }
  return { ok: true, patch };
}
