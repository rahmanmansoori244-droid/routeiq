/**
 * Links a driver can open on the phone: a Google Maps pin per stop, the whole trip as Google
 * Maps directions, and the WhatsApp message a dispatcher sends per load. Pure (no react-pdf, no
 * database) so the plan screen, the driver sheets PDF and the tests share one version.
 */
import { driverClashes } from './load-state';
import type { DetailLoad, DetailStop } from './plan-detail';
import { isSupersededRun } from './plan-status';
import { fmtHhmm } from './time';

/** A Google Maps directions URL takes at most 9 waypoints, so longer trips get several links. */
export const MAX_WAYPOINTS = 9;

type Located = { lat: number | null; lng: number | null };

/** 23.588123456 -> "23.588123": 6 decimals (~10 cm) keep links short. */
function coord(v: number): string {
  return String(Math.round(v * 1e6) / 1e6);
}

export function coordText(lat: number, lng: number): string {
  return `${coord(lat)},${coord(lng)}`;
}

function hasCoords<T extends Located>(p: T): p is T & { lat: number; lng: number } {
  return p.lat !== null && p.lng !== null && Number.isFinite(p.lat) && Number.isFinite(p.lng);
}

/** Google Maps pin for one place; null when the customer has no location. */
export function pinUrl(p: Located): string | null {
  return hasCoords(p) ? `https://www.google.com/maps/search/?api=1&query=${coordText(p.lat, p.lng)}` : null;
}

export interface RouteLink {
  part: number;
  parts: number;
  /** "Whole route" or "Part 1 of 2: depot to stop 9" */
  label: string;
  url: string;
  waypoints: number;
}

export interface RoutePlan {
  links: RouteLink[];
  /** Sequence numbers of stops left out of the links because they have no location. */
  skipped: number[];
}

/**
 * Directions from the depot through the stops in delivery order and back to the depot. Each
 * link carries at most MAX_WAYPOINTS waypoints; the next link starts where the previous one
 * ended. Stops without a location are skipped (and listed in `skipped`).
 */
export function routeLinks(depot: { lat: number; lng: number }, stops: Pick<DetailStop, 'sequence' | 'lat' | 'lng'>[]): RoutePlan {
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence);
  const located = ordered.filter(hasCoords);
  const skipped = ordered.filter((s) => !hasCoords(s)).map((s) => s.sequence);
  if (!located.length) return { links: [], skipped };
  const points = [
    { name: 'depot', at: coordText(depot.lat, depot.lng) },
    ...located.map((s) => ({ name: `stop ${s.sequence}`, at: coordText(s.lat, s.lng) })),
    { name: 'depot', at: coordText(depot.lat, depot.lng) },
  ];
  const chunks: { from: number; to: number }[] = [];
  for (let from = 0; from < points.length - 1; ) {
    const to = Math.min(from + MAX_WAYPOINTS + 1, points.length - 1);
    chunks.push({ from, to });
    from = to;
  }
  const links = chunks.map(({ from, to }, i): RouteLink => {
    const way = points.slice(from + 1, to).map((p) => p.at);
    // "|" is sent as %7C: WhatsApp and some mail apps cut a link at a raw pipe.
    const url =
      `https://www.google.com/maps/dir/?api=1&origin=${points[from].at}&destination=${points[to].at}` +
      `${way.length ? `&waypoints=${way.join('%7C')}` : ''}&travelmode=driving`;
    return {
      part: i + 1,
      parts: chunks.length,
      label: chunks.length === 1 ? 'Whole route' : `Part ${i + 1} of ${chunks.length}: ${points[from].name} to ${points[to].name}`,
      url,
      waypoints: way.length,
    };
  });
  return { links, skipped };
}

/** Loads per truck in the plan ("Trip k of n"). Trips are numbered 1..n; a gap never makes n < k. */
export function tripsByTruck(loads: Pick<DetailLoad, 'truckId' | 'loadNo'>[]): Map<string, number> {
  const out = new Map<string, number>();
  const count = new Map<string, number>();
  for (const l of loads) {
    count.set(l.truckId, (count.get(l.truckId) ?? 0) + 1);
    out.set(l.truckId, Math.max(out.get(l.truckId) ?? 0, l.loadNo, count.get(l.truckId)!));
  }
  return out;
}

export function stopTitle(s: Pick<DetailStop, 'customerName' | 'customerCode' | 'branchCode'>): string {
  return `${s.customerName} (${s.customerCode}${s.branchCode ? `/${s.branchCode}` : ''})`;
}

export interface MessagePlan {
  runDate: string;
  version: number;
  /** Plan version status: a superseded version's message says it must not be used. */
  status?: string;
  /** Set when a newer version replaced this one (superseded even if the status says otherwise). */
  supersededAt?: string | null;
  depot: { lat: number; lng: number };
}

/** First line of a message sent from a plan version that a newer version replaced. */
export const REPLACED_LINE = '*REPLACED BY A NEWER PLAN - DO NOT USE. Ask the dispatcher for the new trip.*';

export type MessageLoad = Pick<DetailLoad, 'truckCode' | 'loadNo' | 'departMin' | 'returnMin' | 'cases'> & {
  stops: Pick<DetailStop, 'sequence' | 'etaMin' | 'customerName' | 'customerCode' | 'branchCode' | 'cases' | 'lat' | 'lng' | 'split'>[];
};

/**
 * WhatsApp text for one load: the trip header, then each stop in delivery order with its pin,
 * then the route link(s). Kept short - it is read on a phone in the truck.
 */
export function whatsappText(plan: MessagePlan, load: MessageLoad, trips: number, opts: { tenantName?: string } = {}): string {
  const stops = [...load.stops].sort((a, b) => a.sequence - b.sequence);
  const route = routeLinks(plan.depot, stops);
  const lines = [
    ...(isSupersededRun({ status: plan.status ?? '', supersededAt: plan.supersededAt }) ? [REPLACED_LINE] : []),
    `*Truck ${load.truckCode} - Trip ${load.loadNo} of ${trips}*`,
    `${opts.tenantName ? `${opts.tenantName} · ` : ''}Delivery ${plan.runDate} · Plan v${plan.version}`,
    `Depart ${fmtHhmm(load.departMin)} · ${stops.length} stops · ${load.cases} cases`,
    '',
  ];
  for (const s of stops) {
    const part = s.split ? ` · part ${s.split.part}/${s.split.parts}` : '';
    lines.push(`${s.sequence}. ${fmtHhmm(s.etaMin)} ${stopTitle(s)} · ${s.cases} cs${part}`);
    lines.push(pinUrl(s) ?? 'No location - call dispatcher');
  }
  lines.push('');
  for (const r of route.links) lines.push(`${route.links.length === 1 ? 'Route' : `Route ${r.part}/${r.parts}`}: ${r.url}`);
  if (route.skipped.length) lines.push(`Not in the route link (no location): stop ${route.skipped.join(', ')}`);
  lines.push(`Back at depot ~${fmtHhmm(load.returnMin)}`);
  return lines.join('\n');
}

/**
 * The number wa.me needs (country code + number, digits only), or null when it cannot be told.
 * "+968 9123 4567", "00968 9123 4567" and "96891234567" already carry the country code. A local
 * number ("9123 4567" in Oman, "050 123 4567" in the UAE) gets `callingCode` - the tenant's
 * country, see phoneCountryCode() - after dropping its leading 0. Without a calling code a local
 * number gives null: wa.me would read "91234567" as +91 (India) and open no chat at all.
 */
export function whatsappNumber(phone: string | null | undefined, callingCode: string | null = null): string | null {
  const raw = (phone ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (raw.startsWith('+')) return digits;
  if (digits.startsWith('00')) return digits.slice(2) || null;
  // Longer than any local number (Oman 8 digits, UAE 9-10 with its 0): the country code is in it.
  if (digits.length > 10 && !digits.startsWith('0')) return digits;
  const local = digits.replace(/^0+/, '');
  return callingCode && local ? `${callingCode}${local}` : null;
}

/** wa.me link: opens the driver's chat when the number is known (see whatsappNumber), else lets
 * the dispatcher pick the chat. */
export function whatsappUrl(phone: string | null | undefined, text: string, callingCode: string | null = null): string {
  return `https://wa.me/${whatsappNumber(phone, callingCode) ?? ''}?text=${encodeURIComponent(text)}`;
}

export interface DriverClashNote {
  driverId: string;
  loadIds: [string, string];
  text: string;
}

/**
 * One driver on loads of two trucks at overlapping planned times - set by hand, or kept from an
 * earlier version. Shown as a warning on the plan: the dispatcher decides who drives which.
 */
export function driverClashNotes(
  loads: Pick<DetailLoad, 'id' | 'truckId' | 'truckCode' | 'loadNo' | 'driverId' | 'driverName' | 'departMin' | 'returnMin'>[],
): DriverClashNote[] {
  const at = (l: (typeof loads)[number]) => `${l.truckCode} · L${l.loadNo} (${fmtHhmm(l.departMin)}–${fmtHhmm(l.returnMin)})`;
  return driverClashes(loads).map(({ driverId, a, b }) => ({
    driverId,
    loadIds: [a.id, b.id],
    text: `${a.driverName ?? b.driverName ?? 'One driver'} is on ${at(a)} and ${at(b)} at the same time.`,
  }));
}

/** Order notes as separate, de-duplicated remarks: upload joins every line's note with " | ", so
 * one remark repeated on 8 SKU lines would otherwise print 8 times on the driver sheet. */
export function noteParts(notes: string | null | undefined): string[] {
  return [...new Set((notes ?? '').split(' | ').map((n) => n.trim()).filter(Boolean))];
}
