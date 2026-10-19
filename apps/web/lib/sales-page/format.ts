/**
 * What the salesman link page shows (owner request 19 Oct 2026), pure and browser-safe: the status colours, the
 * count chips and their filters, the card lines, the share link, the map's points and the page's own words.
 * The answer's texts come ready from the server (lib/sales-link/text.ts, plain English, company time); the page
 * adds only its own labels, kept here (UI, LINK_STATE_TEXT) so an Arabic version can follow the same keys later.
 */
import type { DeliveryStatus, EtaTiming, OffTruckKind, SalesDelivery, SalesEta, SalesLinkStateCode, SalesLookup, SalesOffTruck, SalesRouteView } from '../sales-link/view-types';
import { fmtDayMonth } from '../dispatch/time';

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "2026-10-19" -> "Sun 19 Oct" (as the server's shortDayText: the weekday from the date itself). */
export function shortDayText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const wd = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).getUTCDay();
  return `${WEEKDAY_SHORT[wd]} ${fmtDayMonth(iso)}`;
}

/** The page's own words. */
export const UI = {
  title: 'Deliveries',
  routeLabel: 'Route code',
  routeHelp: 'Two routes? Type both: R1, R2X',
  show: 'Show my deliveries',
  changeRoute: 'Change route',
  refresh: 'Refresh',
  loading: 'Loading…',
  offline: 'No connection. Check your signal and try again.',
  tryAgain: 'Try again',
  readOnly: (tz: string) => `Read-only. Times are company time (${tz}).`,
  refreshes: 'Refreshes every minute while open.',
  trucks: 'Trucks',
  deliveries: 'Deliveries',
  offTruck: 'Not on a truck today',
  noDeliveries: 'No deliveries on a truck for this route.',
  filtered: (n: number, of: number) => `Showing ${n} of ${of}`,
  showAll: 'Show all',
  share: 'Send to customer',
  shareTitle: 'Send this delivery’s status to the customer on WhatsApp (no link is sent)',
  map: 'Map',
  showMap: 'Show map',
  hideMap: 'Hide map',
  mapNote: 'Numbers are the deliveries below. Truck positions are approximate (about 100 m).',
  noMap: 'The map cannot be shown on this phone.',
  openInMaps: 'Open in Maps',
  window: (w: string) => `Window ${w}`,
  planned: (t: string) => `Planned ${t}`,
  hours: (h: string) => `Receiving hours ${h}`,
  invoices: (list: readonly string[]) => (list.length === 1 ? `Invoice ${list[0]}` : `Invoices ${list.join(', ')}`),
  stale: (updated: string) => `Could not refresh - showing the data of ${updated.replace(/^Updated\s+/i, '')}. Trying again every minute.`,
  busy: (sec: number | null) => (sec ? `Too many requests. Trying again in ${sec} s.` : 'Too many requests. Trying again in a minute.'),
  codeMissing: 'Type your route code.',
  codeTooLong: 'That route code is too long.',
  tooManyCodes: 'At most 5 route codes at once.',
  ambiguous: (codes: readonly string[]) => `${codes.join(', ')} matched more than one route: each is shown.`,
} as const;

/** The full-page texts of a link that does not work (the same words as the server's SALES_STATE_TEXT). */
export const LINK_STATE_TEXT: Record<SalesLinkStateCode, string> = {
  LINK_NOT_FOUND: 'This link does not work. Ask the office for the link of the day.',
  LINK_REPLACED: 'This link was replaced by a newer one. Use the newest link in your group, or ask the office.',
  LINK_REVOKED: 'This link was turned off by the office. Ask the office for a new one.',
  LINK_EXPIRED: "This link has expired. Ask the office for today's link.",
  SALES_LINKS_OFF: 'Salesman links are not available on this server. Ask the office.',
  SIGNED_IN_OTHER_TENANT: 'You are signed in to RouteIQ for another company. Sign out to use this link.',
};

/** The status chip's colours (Tailwind), the driver page's palette. */
export const STATUS_TONE: Record<DeliveryStatus, string> = {
  DELIVERED: 'bg-emerald-600 text-white',
  PARTLY_DELIVERED: 'bg-amber-500 text-white',
  NOT_DELIVERED: 'bg-red-700 text-white',
  NO_RESULT: 'bg-slate-500 text-white',
  VISITED: 'bg-slate-300 text-slate-900',
  AT_CUSTOMER: 'bg-blue-600 text-white',
  NEXT: 'bg-slate-900 text-white',
  ON_THE_WAY: 'bg-sky-100 text-sky-900',
  PASSED: 'bg-amber-200 text-amber-950',
  LOADING: 'bg-amber-200 text-amber-950',
  PLANNED: 'bg-slate-200 text-slate-800',
  TRUCK_DID_NOT_GO: 'bg-red-200 text-red-950',
};

/** The card's left border by status (a glance down the list shows what is done and what is not). */
export const STATUS_EDGE: Record<DeliveryStatus, string> = {
  DELIVERED: 'border-l-emerald-600',
  PARTLY_DELIVERED: 'border-l-amber-500',
  NOT_DELIVERED: 'border-l-red-700',
  NO_RESULT: 'border-l-slate-500',
  VISITED: 'border-l-slate-400',
  AT_CUSTOMER: 'border-l-blue-600',
  NEXT: 'border-l-slate-900',
  ON_THE_WAY: 'border-l-sky-400',
  PASSED: 'border-l-amber-400',
  LOADING: 'border-l-amber-300',
  PLANNED: 'border-l-slate-300',
  TRUCK_DID_NOT_GO: 'border-l-red-300',
};

/** The map pin's colour by status (hex: drawn by MapLibre, not Tailwind). */
export const PIN_COLOR: Record<DeliveryStatus, string> = {
  DELIVERED: '#059669',
  PARTLY_DELIVERED: '#f59e0b',
  NOT_DELIVERED: '#b91c1c',
  NO_RESULT: '#64748b',
  VISITED: '#94a3b8',
  AT_CUSTOMER: '#2563eb',
  NEXT: '#0f172a',
  ON_THE_WAY: '#0284c7',
  PASSED: '#d97706',
  LOADING: '#a16207',
  PLANNED: '#64748b',
  TRUCK_DID_NOT_GO: '#ef4444',
};

export const OFF_TONE: Record<OffTruckKind, string> = {
  CANCELLED: 'bg-red-100 text-red-900',
  MOVED: 'bg-purple-100 text-purple-900',
  NOT_PLANNED: 'bg-amber-100 text-amber-900',
  PART_NOT_PLANNED: 'bg-amber-100 text-amber-900',
  ADDED_AFTER_PLAN: 'bg-amber-100 text-amber-900',
  NOT_PLANNED_YET: 'bg-slate-200 text-slate-800',
};

export const TIMING_TONE: Record<EtaTiming, string> = {
  ON_TIME: 'bg-emerald-100 text-emerald-900',
  LATE: 'bg-orange-100 text-orange-800',
  EARLY: 'bg-violet-100 text-violet-900',
  DUE_NOW: 'bg-amber-100 text-amber-900',
  NO_UPDATES: 'bg-slate-100 text-slate-700',
};

/** The small chip next to the status: "Late ~20 min", "Early ~15 min", "On time", "Due now"; none without live updates. */
export function timingChip(eta: SalesEta | null): { text: string; tone: string } | null {
  if (!eta) return null;
  switch (eta.timing) {
    case 'LATE':
      return { text: eta.lateMin ? `Late ~${eta.lateMin} min` : 'Late', tone: TIMING_TONE.LATE };
    case 'EARLY':
      return { text: eta.earlyMin ? `Early ~${eta.earlyMin} min` : 'Early', tone: TIMING_TONE.EARLY };
    case 'DUE_NOW':
      return { text: 'Due now', tone: TIMING_TONE.DUE_NOW };
    case 'ON_TIME':
      return { text: 'On time', tone: TIMING_TONE.ON_TIME };
    default:
      return null;
  }
}

/** Results and finished stops: no live time, no window line, not on the map. */
export const DONE_STATUSES: ReadonlySet<DeliveryStatus> = new Set(['DELIVERED', 'PARTLY_DELIVERED', 'NOT_DELIVERED', 'NO_RESULT', 'VISITED', 'TRUCK_DID_NOT_GO']);

/** Deliveries still to come (drawn on the map). */
export function isPending(d: Pick<SalesDelivery, 'status'>): boolean {
  return !DONE_STATUSES.has(d.status);
}

/** WhatsApp with the text and no number (the salesman picks the customer's chat). The text never holds a link. */
export function shareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/** "TST0001 / B1", "TST0001". */
export function codeText(code: string, branch: string | null): string {
  return branch ? `${code} / ${branch}` : code;
}

/** "T05 · Trip 2 · stop 3 of 9 · part 1 of 2". */
export function tripText(d: Pick<SalesDelivery, 'truckCode' | 'loadNo' | 'stopNo' | 'stopsOnTrip' | 'part'>): string {
  return [d.truckCode, `Trip ${d.loadNo}`, d.stopNo > 0 ? `stop ${d.stopNo} of ${d.stopsOnTrip}` : null, d.part].filter(Boolean).join(' · ');
}

const casesOf = (n: number) => `${n} ${n === 1 ? 'case' : 'cases'}`;

/** "24 cases" (to come), "24 cases delivered", "Delivered 18 of 24 cases", "24 cases - none delivered". */
export function casesText(d: Pick<SalesDelivery, 'cases' | 'delivered'>): string {
  const r = d.delivered;
  if (!r) return casesOf(d.cases);
  if (r.cases >= r.of) return `${casesOf(r.of)} delivered`;
  if (r.cases <= 0) return `${casesOf(r.of)} - none delivered`;
  return `Delivered ${r.cases} of ${casesOf(r.of)}`;
}

/**
 * The cases line: the server's time line of a partly delivered stop already says "Delivered 12 of 20 cases", so the
 * card does not say it twice (it then shows the ordered cases).
 */
export function casesLine(d: Pick<SalesDelivery, 'cases' | 'delivered' | 'detailText'>): string {
  const r = d.delivered;
  if (r && r.cases > 0 && r.cases < r.of && (d.detailText ?? '').includes(`${r.cases} of ${r.of}`)) return `${casesOf(r.of)} ordered`;
  return casesText(d);
}

/**
 * The card's time line: the server's line (the result, the live expected time with the window, "Due now", ...),
 * else, before the day, the printed window as the Salesman ETA has it, else the planned time.
 */
export function timeLine(d: Pick<SalesDelivery, 'detailText' | 'window' | 'planned' | 'status'>): string | null {
  if (d.detailText) return d.detailText;
  if (DONE_STATUSES.has(d.status)) return null;
  if (d.window) return `Expected between ${d.window}`;
  return d.planned ? UI.planned(d.planned) : null;
}

/** The printed window as its own line, when the time line does not already name it (and the stop is still to come). */
export function windowLine(d: Pick<SalesDelivery, 'detailText' | 'window' | 'planned' | 'status'>): string | null {
  if (!d.window || DONE_STATUSES.has(d.status)) return null;
  const line = timeLine(d) ?? '';
  return line.includes(d.window) ? null : `${UI.window(d.window)} (as on the Salesman ETA)`;
}

/** "Receiving hours 06:00-14:00 · this order: 10:00-11:00". */
export function hoursLine(d: Pick<SalesDelivery, 'hours' | 'orderTime'>): string | null {
  const parts = [d.hours ? UI.hours(d.hours) : null, d.orderTime].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

// ---------------------------------------------------------------------------------------
// The count chips at the top, and the list each one filters to
// ---------------------------------------------------------------------------------------

export type SummaryKey = 'delivered' | 'onTheWay' | 'delayed' | 'notDelivered' | 'cancelled' | 'planned' | 'noResult' | 'didNotGo' | 'moved' | 'notOnTruck';

interface SummaryDef {
  key: SummaryKey;
  label: string;
  tone: string;
  /** Shown even at 0 (the five the owner asked for). */
  always: boolean;
  delivery?: (d: SalesDelivery) => boolean;
  off?: (o: SalesOffTruck) => boolean;
}

const SUMMARY: readonly SummaryDef[] = [
  { key: 'delivered', label: 'Delivered', tone: 'bg-emerald-50 text-emerald-900 ring-emerald-200', always: true, delivery: (d) => d.status === 'DELIVERED' || d.status === 'PARTLY_DELIVERED' },
  { key: 'onTheWay', label: 'On the way', tone: 'bg-sky-50 text-sky-900 ring-sky-200', always: true, delivery: (d) => ['AT_CUSTOMER', 'NEXT', 'ON_THE_WAY', 'PASSED'].includes(d.status) },
  { key: 'delayed', label: 'Delayed', tone: 'bg-orange-50 text-orange-900 ring-orange-200', always: true, delivery: (d) => !DONE_STATUSES.has(d.status) && d.eta?.timing === 'LATE' },
  { key: 'notDelivered', label: 'Not delivered', tone: 'bg-red-50 text-red-900 ring-red-200', always: true, delivery: (d) => d.status === 'NOT_DELIVERED' },
  { key: 'cancelled', label: 'Cancelled', tone: 'bg-red-50 text-red-900 ring-red-200', always: true, off: (o) => o.kind === 'CANCELLED' },
  { key: 'planned', label: 'Planned', tone: 'bg-slate-50 text-slate-800 ring-slate-200', always: false, delivery: (d) => d.status === 'PLANNED' || d.status === 'LOADING' },
  // The truck was there (or the trip is over) and the driver's result is not in: neither done nor on the way.
  { key: 'noResult', label: 'No result yet', tone: 'bg-slate-50 text-slate-800 ring-slate-200', always: false, delivery: (d) => d.status === 'NO_RESULT' || d.status === 'VISITED' },
  { key: 'didNotGo', label: 'Truck did not go', tone: 'bg-red-50 text-red-900 ring-red-200', always: false, delivery: (d) => d.status === 'TRUCK_DID_NOT_GO' },
  { key: 'moved', label: 'Moved', tone: 'bg-purple-50 text-purple-900 ring-purple-200', always: false, off: (o) => o.kind === 'MOVED' },
  { key: 'notOnTruck', label: 'Not on a truck', tone: 'bg-amber-50 text-amber-900 ring-amber-200', always: false, off: (o) => o.kind !== 'CANCELLED' && o.kind !== 'MOVED' },
];

export interface SummaryChip {
  key: SummaryKey;
  label: string;
  n: number;
  tone: string;
}

/** The chips of a route: the five always, the others when they count something. Counted from the lists the chips filter. */
export function summaryChips(view: Pick<SalesRouteView, 'deliveries' | 'offTruck'>): SummaryChip[] {
  return SUMMARY.map((s) => ({
    key: s.key,
    label: s.label,
    tone: s.tone,
    always: s.always,
    n: s.delivery ? view.deliveries.filter(s.delivery).length : view.offTruck.filter(s.off!).length,
  }))
    .filter((c) => c.always || c.n > 0)
    .map(({ key, label, n, tone }) => ({ key, label, n, tone }));
}

/** The deliveries and the not-on-a-truck entries a chip shows (all without a filter). */
export function filterView(view: Pick<SalesRouteView, 'deliveries' | 'offTruck'>, key: SummaryKey | null): { deliveries: SalesDelivery[]; offTruck: SalesOffTruck[] } {
  const def = key ? SUMMARY.find((s) => s.key === key) : null;
  if (!def) return { deliveries: view.deliveries, offTruck: view.offTruck };
  return { deliveries: def.delivery ? view.deliveries.filter(def.delivery) : [], offTruck: def.off ? view.offTruck.filter(def.off) : [] };
}

// ---------------------------------------------------------------------------------------
// Several routes, the poll, the map
// ---------------------------------------------------------------------------------------

/**
 * What the page asks for on each refresh: the routes the lookup FOUND, as the day stores them ("R1, R2X").
 * A code that matched nothing is never asked again (each one counts against the link's limit); null = none found.
 */
export function followQuery(lookup: Pick<SalesLookup, 'routes'> | null): string | null {
  const codes = lookup?.routes.map((r) => r.route) ?? [];
  return codes.length ? codes.join(', ') : null;
}

/** A key unique on a page that shows several routes (the answer's keys are unique per route only). */
export const rowKey = (route: string, key: string) => `${route}:${key}`;

export interface MapTruck {
  key: string;
  label: string;
  lat: number;
  lng: number;
  stale: boolean;
  moving: boolean;
  text: string;
}

export interface MapPin {
  key: string;
  no: number;
  lat: number;
  lng: number;
  color: string;
  text: string;
}

const isPoint = (lat: number, lng: number) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** What the map draws for a route: the trucks the server gives a position for, and the deliveries still to come (numbered, no names). */
export function mapModel(view: Pick<SalesRouteView, 'route' | 'trucks' | 'deliveries'>): { trucks: MapTruck[]; pins: MapPin[]; fitKey: string } {
  const trucks: MapTruck[] = view.trucks
    .filter((t) => t.position && isPoint(t.position.lat, t.position.lng))
    .map((t) => ({ key: rowKey(view.route, t.key), label: t.truckCode, lat: t.position!.lat, lng: t.position!.lng, stale: t.position!.stale, moving: t.position!.moving, text: `${t.truckCode} · ${t.position!.updatedText}` }));
  const pins: MapPin[] = view.deliveries
    .filter((d) => isPending(d) && d.pin && isPoint(d.pin.lat, d.pin.lng))
    .map((d) => ({ key: rowKey(view.route, d.key), no: d.no, lat: d.pin!.lat, lng: d.pin!.lng, color: PIN_COLOR[d.status], text: [`No. ${d.no}`, d.statusText, d.eta?.expected ? `about ${d.eta.expected}` : d.window].filter(Boolean).join(' · ') }));
  // The view is fitted once per route and set of pins: a refresh that only moves a truck never moves the map.
  const fitKey = `${view.route}|${pins.map((p) => `${p.no}@${p.lat},${p.lng}`).join(';')}|${trucks.length > 0}`;
  return { trucks, pins, fitKey };
}

/** The map is worth showing: a truck position or a delivery still to come with a pin. */
export function hasMapContent(view: Pick<SalesRouteView, 'route' | 'trucks' | 'deliveries'>): boolean {
  const m = mapModel(view);
  return m.trucks.length > 0 || m.pins.length > 0;
}

/** An "Open in Maps" link for a point (the map fallback without WebGL). */
export function mapsHref(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

/**
 * The phone can draw a MapLibre map (WebGL). Some older phones and locked-down in-app browsers cannot: the page
 * then shows the positions as text instead of a broken map. The test context is released at once.
 */
export function webglAvailable(doc: { createElement(tag: 'canvas'): HTMLCanvasElement } | null = typeof document !== 'undefined' ? document : null): boolean {
  if (!doc) return false;
  try {
    const canvas = doc.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl' as 'webgl')) as WebGLRenderingContext | null;
    if (!gl) return false;
    gl.getExtension?.('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}
