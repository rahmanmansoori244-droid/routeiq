/**
 * What the salesman link page shows (owner request 19 Oct 2026; made simple on the owner's feedback of 20 Oct 2026),
 * pure and browser-safe: the status buttons and the list each one shows, the one line under a customer, the
 * WhatsApp text for the customer, the problems of the route form, and which codes the page follows. Every word comes
 * from i18n.ts in the language the salesman picked; the answer itself is language-neutral.
 */
import type { SalesChoice, SalesLookup, SalesMeta, SalesRouteView, SalesRow, SalesStatus, SalesViewKind } from '../sales-link/view-types';
import { fmtDayMonth } from '../dispatch/time';
import { explicitTruck, MAX_CODES, normTypedRoute } from '../sales-link/route-code';
import { aboutText, dayText, isRtl, st, zonedParts, type SalesKey, type SalesLang } from './i18n';

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "2026-10-19" -> "Sun 19 Oct" (English, for the office's Salesman link dialog; as the server's shortDayText). */
export function shortDayText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const wd = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).getUTCDay();
  return `${WEEKDAY_SHORT[wd]} ${fmtDayMonth(iso)}`;
}

// ---------------------------------------------------------------------------------------
// The status buttons and the list each one shows
// ---------------------------------------------------------------------------------------

/** The buttons in order: the six the owner asked for always, then "not confirmed" and "not in the plan" when there are some. */
export const STATUS_ORDER: readonly SalesStatus[] = ['DELIVERED', 'ON_THE_WAY', 'DELAYED', 'PARTLY_DELIVERED', 'NOT_DELIVERED', 'CANCELLED', 'NOT_CONFIRMED', 'NOT_IN_PLAN'];
const ALWAYS: ReadonlySet<SalesStatus> = new Set(['DELIVERED', 'ON_THE_WAY', 'DELAYED', 'PARTLY_DELIVERED', 'NOT_DELIVERED', 'CANCELLED']);

/**
 * The status chip of a customer (solid; white text reads at 4.5:1 or better: WCAG AA for 14 px text, outdoors in the
 * sun - tests/lib/sales-page.spec.ts checks it).
 */
export const STATUS_CHIP: Record<SalesStatus, string> = {
  DELIVERED: 'bg-emerald-700 text-white',
  PARTLY_DELIVERED: 'bg-amber-700 text-white',
  NOT_DELIVERED: 'bg-red-700 text-white',
  NOT_CONFIRMED: 'bg-slate-600 text-white',
  ON_THE_WAY: 'bg-sky-700 text-white',
  DELAYED: 'bg-orange-700 text-white',
  CANCELLED: 'bg-zinc-800 text-white',
  NOT_IN_PLAN: 'bg-violet-700 text-white',
};

/** The status button (light, the same hue as its chip; the count in the chip's colour). */
export const STATUS_BUTTON: Record<SalesStatus, string> = {
  DELIVERED: 'bg-emerald-50 text-emerald-900 ring-emerald-200',
  PARTLY_DELIVERED: 'bg-amber-50 text-amber-900 ring-amber-200',
  NOT_DELIVERED: 'bg-red-50 text-red-900 ring-red-200',
  NOT_CONFIRMED: 'bg-slate-50 text-slate-900 ring-slate-300',
  ON_THE_WAY: 'bg-sky-50 text-sky-900 ring-sky-200',
  DELAYED: 'bg-orange-50 text-orange-900 ring-orange-200',
  CANCELLED: 'bg-zinc-100 text-zinc-900 ring-zinc-300',
  NOT_IN_PLAN: 'bg-violet-50 text-violet-900 ring-violet-200',
};

/** The card's edge by status (a glance down the list shows what is done and what is not). */
export const STATUS_EDGE: Record<SalesStatus, string> = {
  DELIVERED: 'border-s-emerald-600',
  PARTLY_DELIVERED: 'border-s-amber-500',
  NOT_DELIVERED: 'border-s-red-700',
  NOT_CONFIRMED: 'border-s-slate-400',
  ON_THE_WAY: 'border-s-sky-500',
  DELAYED: 'border-s-orange-600',
  CANCELLED: 'border-s-zinc-500',
  NOT_IN_PLAN: 'border-s-violet-500',
};

/**
 * A status's words on its button, chip and list heading. On a later delivery date (tomorrow's link opened the
 * evening before: `future`) nothing has left yet, so "On the way" reads "Planned" (review of 20 Oct 2026: the same
 * button and count, never "on the way" the night before).
 */
export const statusLabel = (lang: SalesLang, s: SalesStatus, future = false): string => st(lang, future && s === 'ON_THE_WAY' ? 'st.PLANNED' : (`st.${s}` as SalesKey));

export interface StatusButton {
  status: SalesStatus;
  n: number;
}

/**
 * The buttons of a result: the six always (a 0 is shown, not hidden), the other two only when they count something
 * - or when it is the one picked (`active`): a refresh that empties it keeps it there, pressed, with 0 (review of
 * 20 Oct 2026: else no button was pressed under "Not confirmed yet · 0").
 */
export function statusButtons(rows: readonly Pick<SalesRow, 'status'>[], active: SalesStatus | null = null): StatusButton[] {
  return STATUS_ORDER.map((status) => ({ status, n: rows.filter((r) => r.status === status).length })).filter((b) => ALWAYS.has(b.status) || b.n > 0 || b.status === active);
}

/** The rows a button shows (all of them for "All"). */
export function rowsOf<R extends Pick<SalesRow, 'status'>>(rows: readonly R[], status: SalesStatus | null): R[] {
  return status ? rows.filter((r) => r.status === status) : [...rows];
}

/** Every row is an order of a depot whose plan is not made yet (the evening before, for tomorrow's link). */
export function allNotPlannedYet(rows: readonly Pick<SalesRow, 'status' | 'off'>[]): boolean {
  return rows.length > 0 && rows.every((r) => r.status === 'NOT_IN_PLAN' && r.off === 'NOT_PLANNED_YET');
}

// ---------------------------------------------------------------------------------------
// One customer: the line under the name, and the WhatsApp text
// ---------------------------------------------------------------------------------------

/** The delivery date is after the company's today (tomorrow's link, opened the evening before): times are the plan's. */
export function isFutureDay(meta: Pick<SalesMeta, 'date' | 'serverNow' | 'tz'>): boolean {
  const today = zonedParts(meta.serverNow, meta.tz)?.date;
  return !!today && meta.date > today;
}

/** The delivery date of the page, and whether it is after the company's today (isFutureDay). */
export interface DayOf {
  future: boolean;
  date: string;
}

/**
 * The one line under a customer: "at 10:31" (delivered), "18 of 24 cases" (partly), "about 16:30 · in about 1 h 20
 * min" (on the way or delayed; "any minute" when it is close), "Being delivered now", "Moved to Tue 21 Oct", "Not
 * planned yet"; null when the status says it all (not delivered, not confirmed, cancelled, or no time to give). On a
 * later delivery date (`o.future`: tomorrow's link the evening before) a delivery still to come says its day:
 * "Wed 21 Oct, about 09:30" (review of 20 Oct 2026: a bare time read as today).
 */
export function rowLine(lang: SalesLang, r: SalesRow, o: DayOf | null = null): string | null {
  switch (r.status) {
    case 'DELIVERED':
      return r.at ? st(lang, 'deliveredAt', { time: r.at }) : null;
    case 'PARTLY_DELIVERED':
      return r.cases ? st(lang, 'casesOf', { n: r.cases.delivered, m: r.cases.of }) : null;
    case 'ON_THE_WAY':
    case 'DELAYED':
      if (r.atCustomer) return st(lang, 'beingDelivered');
      if (o?.future) {
        const day = dayText(lang, o.date);
        return r.eta ? st(lang, 'plannedAt', { day, time: r.eta }) : st(lang, 'plannedOn', { day });
      }
      if (!r.eta) return null;
      return r.inMin === null ? st(lang, 'expectedAbout', { time: r.eta }) : `${st(lang, 'expectedAbout', { time: r.eta })} · ${aboutText(lang, r.inMin)}`;
    case 'NOT_IN_PLAN':
      if (r.off === 'MOVED' && r.movedTo) return st(lang, 'movedTo', { day: dayText(lang, r.movedTo) });
      return r.off === 'NOT_PLANNED_YET' ? st(lang, 'notPlannedYet') : null;
    default:
      return null;
  }
}

/** "Example Mart (B2)": the name as stored with its branch. */
export const customerText = (r: Pick<SalesRow, 'customer' | 'branch'>): string => (r.branch ? `${r.customer} (${r.branch})` : r.customer);

/**
 * The WhatsApp text for the customer, in the page's language: the customer, the status and the approximate time,
 * nothing else (no link, no invoice, no truck); null for an order not on a truck (no button). The customer's name is
 * always isolated (U+2068 ... U+2069; i18n.ts does it in Arabic and Urdu): an English text that starts with a name
 * stored in Arabic would else read right to left in WhatsApp, its direction taken from the name (review of 20 Oct 2026).
 */
export function shareText(lang: SalesLang, r: SalesRow, o: DayOf): string | null {
  const customer = isRtl(lang) ? customerText(r) : `⁨${customerText(r)}⁩`;
  switch (r.status) {
    case 'DELIVERED':
      return r.at ? st(lang, 'msg.DELIVERED', { customer, time: r.at }) : st(lang, 'msg.DELIVERED_NO_TIME', { customer });
    case 'PARTLY_DELIVERED':
      return r.cases ? st(lang, 'msg.PARTLY', { customer, n: r.cases.delivered, m: r.cases.of }) : st(lang, 'msg.PARTLY_NO_CASES', { customer });
    case 'NOT_DELIVERED':
      return st(lang, 'msg.NOT_DELIVERED', { customer });
    case 'NOT_CONFIRMED':
      return st(lang, 'msg.NOT_CONFIRMED', { customer });
    case 'ON_THE_WAY':
    case 'DELAYED':
      if (r.atCustomer) return st(lang, 'msg.AT_CUSTOMER', { customer });
      if (o.future) {
        const day = dayText(lang, o.date);
        return r.eta ? st(lang, 'msg.PLANNED', { customer, day, time: r.eta }) : st(lang, 'msg.PLANNED_NO_TIME', { customer, day });
      }
      return r.eta ? st(lang, 'msg.COMING', { customer, time: r.eta }) : st(lang, 'msg.COMING_NO_TIME', { customer });
    default:
      return null;
  }
}

/** WhatsApp with the text and no number (the salesman picks the customer's chat). The text never holds a link. */
export function shareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

// ---------------------------------------------------------------------------------------
// The header, the route form and the notices
// ---------------------------------------------------------------------------------------

/**
 * The page's title in its language ("RouteIQ - Deliveries", "RouteIQ - التوصيلات"): WhatsApp's in-app browser and
 * Chrome Custom Tabs show it above the page (review of 20 Oct 2026). Set by the page in the browser only: a link
 * previewer runs no script and gets layout.tsx's generic English one.
 */
export const pageTitle = (lang: SalesLang): string => `RouteIQ - ${st(lang, 'appTitle')}`;

/** The heading and tab of a result: "Route R1", "Truck 1234-AB" (the code the salesman typed, as the day names it). */
export function viewTitle(lang: SalesLang, v: { kind: SalesViewKind; code: string }): string {
  return st(lang, v.kind === 'TRUCK' ? 'truckTitle' : 'routeTitle', { code: v.code });
}

/** "Works until Tue 20 Oct 06:00 ..." from the link's end, in the company's time. */
export function untilText(lang: SalesLang, meta: Pick<SalesMeta, 'expiresAt' | 'tz'>): string | null {
  const p = zonedParts(meta.expiresAt, meta.tz);
  return p ? st(lang, 'footerUntil', { day: dayText(lang, p.date), time: p.time }) : null;
}

/** What is wrong on the route form (said in the page's language). */
export type FormProblem =
  | { kind: 'CODE'; code: 'ROUTE_CODE_MISSING' | 'ROUTE_CODE_TOO_LONG' | 'TOO_MANY_CODES' }
  | { kind: 'NOT_FOUND'; codes: string[] }
  | { kind: 'OFFLINE' }
  | { kind: 'SERVER' };

/**
 * A code of the server's lookup lists in the page's language: a route code as it is ("R9"); a truck asked for
 * explicitly - the server's "TRUCK 1234-AB", which the page itself sends for a truck it follows - as the page's own
 * words for a truck ("Truck 1234-AB", "الشاحنة 1234-AB", "ٹرک 1234-AB"; review of 20 Oct 2026: the English word
 * "TRUCK" showed inside Arabic and Urdu messages).
 */
export function codeText(lang: SalesLang, code: string): string {
  const truck = explicitTruck(code);
  return truck ? st(lang, 'truckTitle', { code: truck }) : code;
}

/** The codes as a list in the page's language ("R9, Truck 9999"). */
const codesText = (lang: SalesLang, codes: readonly string[]) => codes.map((c) => codeText(lang, c)).join(', ');

export function problemText(lang: SalesLang, p: FormProblem, date: string | null): string {
  switch (p.kind) {
    case 'CODE':
      return st(lang, p.code === 'ROUTE_CODE_MISSING' ? 'codeMissing' : p.code === 'TOO_MANY_CODES' ? 'tooManyCodes' : 'codeTooLong');
    case 'NOT_FOUND':
      return st(lang, 'notFound', { codes: p.codes.length ? codesText(lang, p.codes) : '?', day: date ? dayText(lang, date) : '' });
    case 'OFFLINE':
      return st(lang, 'offline');
    default:
      return st(lang, 'serverErrorForm');
  }
}

/** The notice above the results: codes that found nothing, and codes that found several routes or trucks. */
export interface LookupNotice {
  notFound: string[];
  ambiguous: string[];
}

export function noticeText(lang: SalesLang, n: LookupNotice, date: string | null): string | null {
  const parts = [n.notFound.length ? problemText(lang, { kind: 'NOT_FOUND', codes: n.notFound }, date) : null, n.ambiguous.length ? st(lang, 'ambiguous', { codes: codesText(lang, n.ambiguous) }) : null];
  const text = parts.filter(Boolean).join(' ');
  return text || null;
}

/** The line above the trucks offered for a code. */
export function choiceText(lang: SalesLang, c: Pick<SalesChoice, 'kind' | 'asked'>): string {
  return st(lang, c.kind === 'SEVERAL_TRUCKS' ? 'severalTrucks' : 'alsoTruck', { code: codeText(lang, c.asked) });
}

/** "Too many requests. Trying again in 30 s." */
export function busyText(lang: SalesLang, sec: number | null): string {
  return sec ? st(lang, 'busy', { n: sec }) : st(lang, 'busySoon');
}

/** "Could not refresh - showing the data of 10:30 ..." */
export function staleText(lang: SalesLang, updated: string): string {
  return st(lang, 'stale', { time: updated });
}

// ---------------------------------------------------------------------------------------
// Several routes and the poll
// ---------------------------------------------------------------------------------------

/**
 * What the page asks for on each refresh: the routes and trucks the lookup FOUND, as the day names them
 * ("R1, R2X", "C1, Truck 1234-AB": a truck in the explicit form, so a refresh never turns it into a route).
 * A code that matched nothing is never asked again (each one counts against the link's limit); null = none found.
 * Never more than MAX_CODES codes (the server refuses more with 400 TOO_MANY_CODES, which would send the salesman
 * back to the form): when the results are more than that (a code typed matched two routes, "R-10" both "R 10" and
 * "R10"), the codes TYPED that found something are followed instead, at most MAX_CODES by the server's own rule.
 */
export function followQuery(lookup: Pick<SalesLookup, 'results' | 'asked' | 'notFound' | 'choices'> | null): string | null {
  if (!lookup) return null;
  const found: string[] = [];
  const seen = new Set<string>();
  for (const r of lookup.results) {
    const key = normTypedRoute(r.query);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    found.push(r.query);
  }
  if (!found.length) return null;
  if (found.length <= MAX_CODES) return found.join(', ');
  // A code that only offered trucks (none shown) found nothing to follow.
  const offeredOnly = new Set((lookup.choices ?? []).filter((c) => c.kind === 'SEVERAL_TRUCKS').map((c) => c.asked));
  const typed = lookup.asked.filter((c) => !lookup.notFound.includes(c) && !offeredOnly.has(c)).slice(0, MAX_CODES);
  return typed.length ? typed.join(', ') : found.slice(0, MAX_CODES).join(', ');
}

/** A key unique on a page that shows several results (the answer's keys are unique per result only): the result's query and the key. */
export const rowKey = (query: string, key: string) => `${query}:${key}`;

/** The tab of a result: its title and its customers. */
export function tabText(lang: SalesLang, v: Pick<SalesRouteView, 'kind' | 'code' | 'rows'>): string {
  return `${viewTitle(lang, v)} · ${v.rows.length}`;
}
