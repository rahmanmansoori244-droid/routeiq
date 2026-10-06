/**
 * Links a driver can open on the phone: a Google Maps pin per stop, the whole trip as Google
 * Maps directions, and the WhatsApp message a dispatcher sends per load. Pure (no react-pdf, no
 * database) so the plan screen, the driver sheets PDF and the tests share one version.
 */
import { breakLine } from './break-text';
import { driverClashes } from './load-state';
import type { DetailLoad, DetailStop } from './plan-detail';
import { loadPallets, palletText } from './pallets';
import { isSupersededRun } from './plan-status';
import type { DriverChangeNote } from './summary';
import { fmtDayMonth, fmtHhmm } from './time';

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
  /** The truck-day's timetable check (review F04); not ok = the message says TIMES NOT VERIFIED. */
  timing?: DetailLoad['timing'];
  /** Audit E1: the depot pin the load was planned from (the route starts and ends there); absent = the plan's depot. */
  origin?: DetailLoad['origin'];
  /** Load-level changes after planning: a DEPOT change is printed (the depot moved since planning). */
  masterChanged?: DetailLoad['masterChanged'];
  /** The driver break planned with this load; absent / null = none on this load. */
  break?: DetailLoad['break'];
  /** Pallets of a load planned by pallets (the header adds "· 11.1 pallets"); absent / null = cases only. */
  palletUnits?: DetailLoad['palletUnits'];
  palletRoomUnits?: DetailLoad['palletRoomUnits'];
  bays?: DetailLoad['bays'];
  stops: (Pick<DetailStop, 'sequence' | 'etaMin' | 'customerName' | 'customerCode' | 'branchCode' | 'cases' | 'lat' | 'lng' | 'split'> & {
    /** Customer data corrected after planning (review F08): printed under the stop, like the PDF sheet. */
    masterChanged?: DetailStop['masterChanged'];
    /** When unloading is finished (the planned departure from the stop); absent = not shown. */
    departureMin?: DetailStop['departureMin'];
    /** "Promised 10:00–11:00": an urgent / promised delivery time (owner decision 1 Oct 2026); absent / null = none. */
    promised?: DetailStop['promised'];
  })[];
};

/** Words before the driver link in a WhatsApp message (the driver's phone page: trips and delivery results). */
export const DRIVER_LINK_LINE = 'Your trips and delivery results';

/**
 * The Driver link dialog's own WhatsApp message (owner request 4 Oct 2026): the link in English and
 * Arabic, for a casual driver or a hired truck's driver who reads either. `dayLabel`: "Sun 5 Oct".
 */
export function driverLinkMessage(dayLabel: string, truckCode: string, url: string): string {
  return `RouteIQ - your trips for ${dayLabel}, truck ${truckCode}: ${url}\nRouteIQ - رحلاتك ليوم ${dayLabel}، الشاحنة ${truckCode}: ${url}`;
}

/** Line of a message whose truck-day did not pass the timetable check (the PDF sheet's banner). */
export const TIMES_NOT_VERIFIED_LINE = '*TIMES NOT VERIFIED - check with the dispatcher before leaving*';

/**
 * WhatsApp text for one load: the trip header, then each stop in delivery order with its pin,
 * then the route link(s). Kept short - it is read on a phone in the truck. It carries the same
 * warnings as the driver sheet (driverPackModel): TIMES NOT VERIFIED when the truck-day fails the
 * timetable check, and under a stop each change made after planning, with the corrected pin (the
 * pin and route links stay the planned ones, never switched silently).
 */
export function whatsappText(plan: MessagePlan, load: MessageLoad, trips: number, opts: { tenantName?: string; driverLinkUrl?: string | null } = {}): string {
  const stops = [...load.stops].sort((a, b) => a.sequence - b.sequence);
  // Audit E1: from and back to the depot pin the load was planned from, with the note when it moved.
  const route = routeLinks(load.origin ?? plan.depot, stops);
  const depotMoved = (load.masterChanged ?? []).find((c) => c.kind === 'DEPOT');
  const pallets = loadPallets(load);
  const lines = [
    ...(isSupersededRun({ status: plan.status ?? '', supersededAt: plan.supersededAt }) ? [REPLACED_LINE] : []),
    ...(load.timing && !load.timing.ok ? [TIMES_NOT_VERIFIED_LINE] : []),
    `*Truck ${load.truckCode} - Trip ${load.loadNo} of ${trips}*`,
    `${opts.tenantName ? `${opts.tenantName} · ` : ''}Delivery ${plan.runDate} · Plan v${plan.version}`,
    // Pallets in addition to the cases, only for a load planned by pallets (a truck with bays).
    `Depart ${fmtHhmm(load.departMin)} · ${stops.length} stops · ${load.cases} cases${pallets ? ` · ${palletText(pallets.units)} pallets` : ''}`,
    ...(depotMoved ? [`! ${depotMoved.text}`] : []),
    // The truck-day's driver link (owner request 4 Oct 2026): only an active link (not revoked or expired).
    ...(opts.driverLinkUrl ? [`${DRIVER_LINK_LINE}: ${opts.driverLinkUrl}`] : []),
    '',
  ];
  const brk = load.break ?? null;
  if (brk && (brk.where === 'DEPOT' || (brk.afterSequence ?? 0) === 0)) lines.push(breakLine(brk, stops.length));
  for (const s of stops) {
    const part = s.split ? ` · part ${s.split.part}/${s.split.parts}` : '';
    const until = s.departureMin !== null && s.departureMin !== undefined ? ` (unload until ${fmtHhmm(s.departureMin)})` : '';
    lines.push(`${s.sequence}. ${fmtHhmm(s.etaMin)}${until} ${stopTitle(s)} · ${s.cases} cs${part}${s.promised ? ` · *${s.promised}*` : ''}`);
    lines.push(pinUrl(s) ?? 'No location - call dispatcher');
    for (const c of s.masterChanged ?? []) {
      lines.push(`! ${c.text}`);
      const moved = c.kind === 'LOCATION' ? pinUrl({ lat: c.newLat ?? null, lng: c.newLng ?? null }) : null;
      if (moved) lines.push(`New pin - ask the dispatcher which one to use: ${moved}`);
    }
    if (brk && brk.where === 'ROAD' && brk.afterSequence === s.sequence) lines.push(breakLine(brk, stops.length));
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

/** A driver note of the applied plan, in words ("Ali -> Sam, because ..."). */
export function driverChangeText(c: DriverChangeNote): string {
  const hours = c.departMin !== null && c.returnMin !== null ? ` (${fmtHhmm(c.departMin)}–${fmtHhmm(c.returnMin)})` : '';
  const trip = `${c.truckCode} · L${c.loadNo}${hours}`;
  const from = c.from.name;
  if (c.reason === 'TRIP_GONE') {
    return `Driver picked by hand, not in this plan: you picked ${from} for ${trip}, and this plan has no such trip. If a later plan has that trip again, pick the driver again.`;
  }
  const to = c.to?.name ?? 'no driver';
  const other = c.other ? `${c.other.truckCode}${c.other.loadNo !== null ? ` · L${c.other.loadNo}` : ''}` : 'another trip';
  const why =
    c.reason === 'INACTIVE'
      ? `${from} is no longer active`
      : c.reason === 'ON_LEAVE'
        ? `${from} is on leave${c.leaveUntil ? ` until ${fmtDayMonth(c.leaveUntil)}` : ''}`
        : c.reason === 'COVER'
          ? coverWhyText(from, to, other, c.cover ?? null)
          : `${from} is on ${other} at that time`;
  return `Driver changed by this plan: ${trip} ${from} → ${to}, because ${why}.`;
}

/** Why a cover does not drive the trip he covered again (a COVER note; review of 6 Oct 2026). */
function coverWhyText(from: string, to: string, other: string, why: DriverChangeNote['cover']): string {
  if (why === 'OTHER_TRUCK') return `${from}, the cover, drives ${other} that day`;
  if (why === 'OTHER_DEPOT') return `${from}, the cover, drives a truck of another depot that day`;
  if (why === 'TRUCK_DRIVER') return `${to} drives this truck's other trip that day`;
  return `${from} is no longer the cover of this truck's usual driver (the leave ended or changed, or the truck has another usual driver)`;
}

/**
 * The plan warnings for the applied plan's driver notes (summary `driverChanges`). A note on a trip
 * of the plan is listed until the dispatcher sets that trip's driver, and never again after: any
 * driver, the same one with Keep, or "No driver" (`driverSet`: the load row's marker, which the plan
 * detail reads with driverSetByDispatcher). A TRIP_GONE note is listed while the plan has no load
 * for that truck and trip. A note without a driver it lost (only written before the simplified
 * driver rules, when filling an empty trip was a note) is left out.
 */
export function driverChangeWarnings(
  changes: readonly DriverChangeNote[],
  loads: readonly { truckId: string; loadNo: number; driverId: string | null; driverSet: boolean }[],
): string[] {
  return changes
    .filter((c) => {
      if (!c.from) return false;
      const trip = loads.filter((l) => l.truckId === c.truckId && l.loadNo === c.loadNo);
      if (c.reason === 'TRIP_GONE') return trip.length === 0;
      return trip.some((l) => l.driverId === (c.to?.id ?? null) && !l.driverSet);
    })
    .map(driverChangeText);
}

/** Order notes as separate, de-duplicated remarks: upload joins every line's note with " | ", so
 * one remark repeated on 8 SKU lines would otherwise print 8 times on the driver sheet. */
export function noteParts(notes: string | null | undefined): string[] {
  return [...new Set((notes ?? '').split(' | ').map((n) => n.trim()).filter(Boolean))];
}
