/**
 * Driver sheets ("driver pack"): one A4 portrait section per truck load, for the driver to take
 * in the cab - who to visit in which order, when, what to hand over, where the place is (link +
 * QR), and a box per stop for the customer's signature/stamp.
 *
 * Built only from PlanDetail (the same object as the plan screen and the Excel workbook), in two
 * steps: driverPackModel() (here) is pure and unit-tested; renderDriverPackPdf()
 * (driver-pack-pdf.tsx) only lays it out, in the PDF renderer process (lib/pdf-render, review M3):
 * the model is plain data, so it crosses to that process as it is.
 * The driver sheet never shows money: no cost, fuel, revenue or margin.
 *
 * Font: the PDF built-in Helvetica (no font files to ship). It prints Latin text only (WinAnsi:
 * ASCII, Latin-1 and a few extras such as "–", "—", "•"). Other characters would NOT come out
 * blank but as wrong Latin letters (Arabic "هايبر" prints as "1(J'G"), so the model passes every
 * text from the data through pdfSafe(): what cannot print becomes "[?]" and the sheet says so.
 * NMWC master data is in English today; printing Arabic needs a bundled font with Arabic glyphs
 * (e.g. Noto Sans + Noto Naskh Arabic) registered with Font.register().
 */
import type { DetailLoad, DetailStop, PlanDetail } from './plan-detail';
import { isSupersededRun } from './plan-status';
import { coordText, pinUrl, routeLinks, tripsByTruck, type RoutePlan } from './driver-links';
import { pdfTextCollector } from './pdf-text';
import { fmtHhmm } from './time';
import { carriedStopText } from './carry-view';
import { breakLine, breakTimes } from './break-text';
import { loadPallets, palletsOverBays, palletText } from './pallets';

// ---------------------------------------------------------------------------------------
// Model (pure)
// ---------------------------------------------------------------------------------------

export interface SheetStop {
  sequence: number;
  customerName: string;
  customerCode: string;
  branchCode: string | null;
  customerType: string | null;
  priority: number;
  address: string | null;
  accessNotes: string | null;
  notes: string[];
  /** Split delivery: this stop is part `part` of `parts`; `others` says where the other parts go. */
  split: { part: number; parts: number; others: string[]; restUnserved: boolean } | null;
  late: boolean;
  /**
   * PR9: "CARRIED OVER from 26 Sep" (an order of this stop was not delivered on its own day and was
   * brought forward), or "CARRIED OVER to 28 Sep - not for this trip" on a sheet of the earlier day.
   */
  carried: string | null;
  eta: string;
  /** "unload until 07:15": when unloading must be finished (the planned departure); null = not known. */
  until: string | null;
  /** The driver break taken after unloading this stop ("Break 12:40-13:40 between stop 3 and stop 4"); null = none here. */
  breakAfter: string | null;
  /** Receiving hours, one line each: "Receives 06:00–14:00", "Best 07:00–10:00" or "Any time". */
  hours: string[];
  /** The plan arrives outside the customer's hard receiving hours. */
  outsideHours: boolean;
  cases: number;
  skus: { productCode: string; productName: string; cases: number }[];
  salesOrders: string[];
  pinUrl: string | null;
  coords: string | null;
  /**
   * Review F08: customer data corrected after planning ("Location updated after planning: new pin
   * ..."). The sheet keeps the planned stop; these lines tell the driver what changed.
   */
  changeNotes: string[];
  /** The corrected pin, when the location changed after planning. */
  newPinUrl: string | null;
}

export interface DriverSheet {
  loadId: string;
  truckId: string;
  truckCode: string;
  trip: number;
  trips: number;
  status: string;
  carried: boolean;
  /** LOCKED / LOADING / DISPATCHED ..., plus KEPT FROM PREVIOUS VERSION for carried loads. */
  badges: string[];
  driverName: string | null;
  driverPhone: string | null;
  depart: string;
  back: string;
  /** The load's driver break ("12:40-13:40"); null = none on this load. */
  breakTimes: string | null;
  /** A break before the first stop (at the depot, or on the way to stop 1), printed above the stops; null = none. */
  breakBefore: string | null;
  cases: number;
  capacityCases: number;
  /**
   * A load planned by pallets (a truck with bays): its pallets over the truck's bays ("11.1 / 12") and
   * the pallets alone ("11.1"), printed beside the cases; null = planned by cases (cases / capacity).
   */
  pallets: { overBays: string; total: string } | null;
  kmLabel: 'Estimated km' | 'Road km';
  km: number;
  /** From the load manifest: what the driver counts before leaving. */
  loadCheck: { items: { productCode: string; productName: string; cases: number }[]; total: number; matchesLoad: boolean };
  route: RoutePlan;
  stops: SheetStop[];
  returnText: string;
  footerText: string;
  /** Some text of this sheet could not be printed and shows as "[?]" (pdf-text.ts). */
  unprintable: boolean;
  /** Review F04: this truck-day's times did not pass the timetable check. */
  timesNotVerified: boolean;
  /**
   * The QR codes printed at the top right, in print order (owner request 4 Oct 2026): the driver
   * link first (76 pt), then at most 2 route codes; without any driver-link line, up to 3 route codes
   * as before. Route parts beyond them stay the text links above.
   */
  qrCodes: SheetQr[];
  /** In the driver link's place when there is no QR: "Driver link stopped - ask the dispatcher" or "Driver link: ask the dispatcher". */
  driverLinkNote: string | null;
}

/** One printed QR code: the driver link (opens the driver's phone page) or a Google Maps route part. */
export interface SheetQr {
  kind: 'DRIVER_LINK' | 'ROUTE';
  url: string;
  caption: string;
  /** Printed size in pt. */
  size: number;
}

/**
 * The driver link of a sheet's truck-day: its link (QR), STOPPED (revoked: no QR), or ASK (no link
 * for this reader - a VIEWER - or it could not be made). Absent from the map with the map given, or
 * null: print nothing (the truck-day's link is past its expiry).
 */
export type SheetDriverLink = { kind: 'QR'; url: string } | { kind: 'STOPPED' } | { kind: 'ASK' };

/** The caption under the driver-link QR (the PDF font is Latin only). */
export const DRIVER_LINK_CAPTION = 'Scan with the phone camera - opens in Chrome/Safari';
export const DRIVER_LINK_STOPPED_TEXT = 'Driver link stopped - ask the dispatcher';
export const DRIVER_LINK_ASK_TEXT = 'Driver link: ask the dispatcher';

export interface DriverPackModel {
  title: string;
  tenantName: string;
  runDate: string;
  version: number;
  superseded: boolean;
  depot: { code: string; name: string };
  sheets: DriverSheet[];
  /** At least one sheet's times are not verified. */
  timesNotVerified: boolean;
}

export interface DriverPackOptions {
  tenantName: string;
  /** Only these loads (kept in plan order); all loads when omitted. */
  loadIds?: string[];
  /**
   * The driver link per truck id (the export route ensures one per truck-day for PLANNER and above).
   * Omitted: every sheet says "Driver link: ask the dispatcher". A truck missing from the map says
   * the same; a truck mapped to null prints nothing (its link's day is over).
   */
  driverLinks?: ReadonlyMap<string, SheetDriverLink | null>;
}

/** The QR codes and the driver-link note of one sheet (pure: the layout only draws them). */
export function sheetQrCodes(route: RoutePlan, link: SheetDriverLink | null): { qrCodes: SheetQr[]; driverLinkNote: string | null } {
  const routeShown = route.links.slice(0, link ? 2 : 3);
  const routeSize = link || routeShown.length > 1 ? 64 : 76;
  const qrCodes: SheetQr[] = [
    ...(link?.kind === 'QR' ? [{ kind: 'DRIVER_LINK' as const, url: link.url, caption: DRIVER_LINK_CAPTION, size: 76 }] : []),
    ...routeShown.map((r) => ({
      kind: 'ROUTE' as const,
      url: r.url,
      caption: routeShown.length > 1 || route.links.length > 1 ? `Route ${r.part}/${r.parts}` : 'Scan: whole route',
      size: routeSize,
    })),
  ];
  const driverLinkNote = link?.kind === 'STOPPED' ? DRIVER_LINK_STOPPED_TEXT : link?.kind === 'ASK' ? DRIVER_LINK_ASK_TEXT : null;
  return { qrCodes, driverLinkNote };
}

const BADGE: Record<string, string> = {
  PLANNED: 'PLANNED - not locked yet',
  LOCKED: 'LOCKED',
  LOADING: 'LOADING',
  DISPATCHED: 'DISPATCHED',
  COMPLETED: 'COMPLETED',
};

/**
 * "hard 06:00–14:00, preferred 07:00–10:00" (describeWindows) -> driver wording, one per line. An
 * order's own delivery time reads "Promised 10:00–11:00" (DetailStop.window) and is printed as it is.
 */
function hoursLines(window: string): string[] {
  if (!window || window === 'Any time') return ['Any time'];
  return window.split(', ').map((w) => w.replace(/^hard /, 'Receives ').replace(/^preferred /, 'Best '));
}

type Txt = ReturnType<typeof pdfTextCollector>;

function sheetStop(d: PlanDetail, l: DetailLoad, s: DetailStop, t: Txt): SheetStop {
  let split: SheetStop['split'] = null;
  if (s.split) {
    // Where the customer's other parts are: truck + trip, in part order.
    const others = d.loads
      .flatMap((x) => x.stops.filter((y) => y.customerId === s.customerId && y.split && !(x.id === l.id && y.sequence === s.sequence)).map((y) => ({ x, y })))
      .sort((a, b) => a.y.split!.part - b.y.split!.part)
      .map(({ x, y }) => `part ${y.split!.part} on ${t.text(x.truckCode)} trip ${x.loadNo}`);
    split = { part: s.split.part, parts: s.split.parts, others, restUnserved: s.split.restUnserved };
  }
  const moved = s.masterChanged.find((c) => c.kind === 'LOCATION' && c.newLat != null && c.newLng != null);
  return {
    sequence: s.sequence,
    customerName: t.text(s.customerName),
    customerCode: t.text(s.customerCode),
    branchCode: t.maybe(s.branchCode),
    customerType: t.maybe(s.customerType),
    priority: s.priority,
    address: t.maybe(s.address) || null,
    accessNotes: t.maybe(s.accessNotes) || null,
    notes: s.notes.map((n) => t.text(n)).filter(Boolean),
    split,
    late: s.late,
    carried: carriedStopText(s),
    eta: fmtHhmm(s.etaMin),
    until: s.departureMin !== null ? `unload until ${fmtHhmm(s.departureMin)}` : null,
    breakAfter:
      l.break && l.break.where === 'ROAD' && (l.break.afterSequence ?? 0) === s.sequence && s.sequence > 0 ? breakLine(l.break, l.stops.length) : null,
    hours: hoursLines(s.window),
    outsideHours: s.hardWindowOk === false,
    cases: s.cases,
    skus: s.skus.map((k) => ({ productCode: t.text(k.productCode), productName: t.text(k.productName), cases: k.cases })),
    salesOrders: s.salesOrders.map((so) => t.text(so)),
    pinUrl: pinUrl(s),
    coords: s.lat !== null && s.lng !== null ? coordText(s.lat, s.lng) : null,
    changeNotes: s.masterChanged.map((c) => t.text(c.text)),
    newPinUrl: moved ? pinUrl({ lat: moved.newLat ?? null, lng: moved.newLng ?? null }) : null,
  };
}

export function driverPackModel(detail: PlanDetail, opts: DriverPackOptions): DriverPackModel {
  const d = detail;
  const wanted = opts.loadIds ? new Set(opts.loadIds) : null;
  const trips = tripsByTruck(d.loads);
  const v = d.run.version;
  // Every text from the data goes through pdfSafe (see the top of this file).
  const head = pdfTextCollector();
  const tenantName = head.text(opts.tenantName);
  const depot = { code: head.text(d.run.depot.code), name: head.text(d.run.depot.name) };
  const sheets = d.loads
    .filter((l) => !wanted || wanted.has(l.id))
    .map((l): DriverSheet => {
      const t = pdfTextCollector();
      const truckCode = t.text(l.truckCode);
      const n = trips.get(l.truckId) ?? 1;
      const next = d.loads.filter((x) => x.truckId === l.truckId && x.loadNo > l.loadNo).sort((a, b) => a.loadNo - b.loadNo)[0];
      const stops = [...l.stops].sort((a, b) => a.sequence - b.sequence);
      const total = l.manifest.reduce((a, m) => a + m.cases, 0);
      const route = routeLinks(l.origin ?? d.run.depot, stops);
      // The driver link of this truck-day (owner request 4 Oct 2026): see DriverPackOptions.driverLinks.
      const link: SheetDriverLink | null = !opts.driverLinks
        ? { kind: 'ASK' }
        : opts.driverLinks.has(l.truckId)
          ? (opts.driverLinks.get(l.truckId) ?? null)
          : { kind: 'ASK' };
      const sheet: Omit<DriverSheet, 'unprintable' | 'timesNotVerified'> = {
        loadId: l.id,
        truckId: l.truckId,
        truckCode,
        trip: l.loadNo,
        trips: n,
        status: l.status,
        carried: l.carried,
        badges: [
          BADGE[l.status] ?? l.status,
          ...(l.carried ? ['KEPT FROM PREVIOUS VERSION'] : []),
          ...(l.timing && !l.timing.ok ? ['TIMES NOT VERIFIED'] : []),
          // Audit E1: the route below starts and ends at the depot pin the load was planned from.
          ...(l.masterChanged.some((c) => c.kind === 'DEPOT') ? ['DEPOT MOVED SINCE PLANNING: ROUTE FROM THE PLANNED DEPOT PIN'] : []),
          ...(l.hired ? ['HIRED TRUCK'] : []),
        ],
        driverName: t.maybe(l.driverName),
        driverPhone: t.maybe(l.driverPhone),
        depart: fmtHhmm(l.departMin),
        back: fmtHhmm(l.returnMin),
        breakTimes: l.break ? breakTimes(l.break) : null,
        breakBefore: l.break && (l.break.where === 'DEPOT' || (l.break.afterSequence ?? 0) === 0) ? breakLine(l.break, stops.length) : null,
        cases: l.cases,
        capacityCases: l.truckCapacityCases,
        pallets: (() => {
          const p = loadPallets(l);
          return p ? { overBays: palletsOverBays(p), total: palletText(p.units) } : null;
        })(),
        kmLabel: l.distanceIsEstimated ? 'Estimated km' : 'Road km',
        km: Math.round(l.distanceKm),
        loadCheck: {
          items: l.manifest.map((m) => ({ productCode: t.text(m.productCode), productName: t.text(m.productName), cases: m.cases })),
          total,
          matchesLoad: total === l.cases,
        },
        route,
        ...sheetQrCodes(route, link),
        stops: stops.map((s) => sheetStop(d, l, s, t)),
        returnText:
          `Return to depot ${depot.code} ~${fmtHhmm(l.returnMin)}` +
          (next
            ? ` - load trip ${next.loadNo} (${next.break?.where === 'DEPOT' ? `driver break ${breakTimes(next.break)} at the depot, ` : ''}planned departure ${fmtHhmm(next.departMin)}).`
            : ' - last trip of the day.'),
        footerText: `${truckCode} trip ${l.loadNo} of ${n} · delivery ${d.run.runDate} · plan v${v} - this sheet is void if a newer plan version is issued`,
      };
      return { ...sheet, unprintable: head.lost || t.lost, timesNotVerified: !!l.timing && !l.timing.ok };
    });
  return {
    title: `Driver sheets ${d.run.runDate} v${v}`,
    tenantName,
    runDate: d.run.runDate,
    version: v,
    superseded: isSupersededRun(d.run),
    depot,
    sheets,
    timesNotVerified: sheets.some((sh) => sh.timesNotVerified),
  };
}
