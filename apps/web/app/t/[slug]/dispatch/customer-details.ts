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
 */
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
}

export const EMPTY_DETAILS: DetailsForm = { type: '', priority: '', service: '', hardStart: '', hardEnd: '', prefStart: '', prefEnd: '' };

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
  const nowTimes = readTimes(now);
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

  const patch: DetailsPatch = {};
  if (now.type !== initial.type) patch.customerType = now.type || null;
  // '' is offered only while the priority is a default: choosing any P (the same number included) confirms it.
  if (now.priority !== initial.priority && now.priority !== '') patch.priority = Number(now.priority);
  const before = parseServiceMinutes(initial.service);
  if (!before.ok || before.minutes !== service.minutes) patch.avgServiceTimeMin = service.minutes;
  const was = readTimes(initial);
  for (const [a, b, fa, fb] of WINDOWS) {
    if (!was.ok || was.times[a] !== t[a] || was.times[b] !== t[b]) {
      patch[fa] = t[a];
      patch[fb] = t[b];
    }
  }
  return { ok: true, patch };
}
