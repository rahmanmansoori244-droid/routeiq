/**
 * Driver sheets ("driver pack"): one A4 portrait section per truck load, for the driver to take
 * in the cab - who to visit in which order, when, what to hand over, where the place is (link +
 * QR), and a box per stop for the customer's signature/stamp.
 *
 * Built only from PlanDetail (the same object as the plan screen and the Excel workbook), in two
 * steps: driverPackModel() is pure and unit-tested; renderDriverPackPdf() only lays it out.
 * The driver sheet never shows money: no cost, fuel, revenue or margin.
 *
 * Font: the PDF built-in Helvetica (no font files to ship). It prints Latin text only (WinAnsi:
 * ASCII, Latin-1 and a few extras such as "–", "—", "•"). Other characters would NOT come out
 * blank but as wrong Latin letters (Arabic "هايبر" prints as "1(J'G"), so the model passes every
 * text from the data through pdfSafe(): what cannot print becomes "[?]" and the sheet says so.
 * NMWC master data is in English today; printing Arabic needs a bundled font with Arabic glyphs
 * (e.g. Noto Sans + Noto Naskh Arabic) registered with Font.register().
 */
import * as React from 'react';
import { Document, Link, Page, Path, StyleSheet, Svg, Text, View, renderToBuffer } from '@react-pdf/renderer';
import type { DetailLoad, DetailStop, PlanDetail } from './plan-detail';
import { qrPath } from './qr';
import { isSupersededRun } from './plan-status';
import { coordText, pinUrl, routeLinks, tripsByTruck, type RoutePlan } from './driver-links';
import { pdfTextCollector, UNPRINTABLE } from './pdf-text';
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

// ---------------------------------------------------------------------------------------
// QR codes, drawn as vectors (lib/dispatch/qr.ts: one path per code, crisp at any print size)
// ---------------------------------------------------------------------------------------

export { qrPath };

function Qr({ url, size, level = 'M', quiet = 2 }: { url: string; size: number; level?: 'L' | 'M'; quiet?: number }) {
  const q = qrPath(url, level);
  // Quiet zone in modules: 2 is enough next to text on white paper, side-by-side codes get 4.
  return (
    <Link src={url}>
      <Svg width={size} height={size} viewBox={`${-quiet} ${-quiet} ${q.size + 2 * quiet} ${q.size + 2 * quiet}`}>
        <Path d={q.d} fill="#000000" />
      </Svg>
    </Link>
  );
}

// ---------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------

// Never hyphenate: "TRUCK-02-EX-TRA" or a split customer name misleads more than a line break.
// Set per text (not Font.registerHyphenationCallback) so other PDFs keep their layout.
const whole = (word: string) => [word];
type Style = React.ComponentProps<typeof View>['style'];
function T({ style, children }: { style?: Style; children?: React.ReactNode }) {
  return (
    <Text style={style} hyphenationCallback={whole}>
      {children}
    </Text>
  );
}

const C = { ink: '#111111', mute: '#555555', line: '#9A9A9A', band: '#EEEEEE', link: '#0645AD' };
const BOLD = 'Helvetica-Bold';
const s = StyleSheet.create({
  page: { paddingTop: 22, paddingBottom: 40, paddingHorizontal: 24, fontFamily: 'Helvetica', fontSize: 8.5, color: C.ink },
  strip: { flexDirection: 'row', justifyContent: 'space-between', fontSize: 7.5, color: C.mute, borderBottomWidth: 0.5, borderColor: C.line, paddingBottom: 2, marginBottom: 4 },
  h1: { fontFamily: BOLD, fontSize: 17 },
  badge: { fontFamily: BOLD, fontSize: 8.5, borderWidth: 1, borderColor: C.ink, paddingHorizontal: 4, paddingTop: 2, paddingBottom: 1, marginRight: 6 },
  bigWarn: { fontFamily: BOLD, fontSize: 11, borderWidth: 2, borderColor: C.ink, padding: 3, marginBottom: 4, textAlign: 'center' },
  facts: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: C.band, paddingHorizontal: 5, paddingVertical: 4, marginTop: 4, fontSize: 9.5 },
  fact: { marginRight: 14 },
  b: { fontFamily: BOLD },
  small: { fontSize: 7.5, color: C.mute },
  line: { marginTop: 3, fontSize: 8 },
  link: { color: C.link, textDecoration: 'underline' },
  th: { flexDirection: 'row', borderBottomWidth: 1.2, borderTopWidth: 1.2, borderColor: C.ink, fontFamily: BOLD, fontSize: 7.5, paddingVertical: 2, marginTop: 6 },
  tr: { flexDirection: 'row', borderBottomWidth: 0.6, borderColor: C.line, paddingVertical: 3 },
  cell: { paddingHorizontal: 3 },
  seq: { fontFamily: BOLD, fontSize: 14, textAlign: 'center' },
  signBox: { borderWidth: 0.8, borderColor: C.line, marginTop: 2, height: 34 },
  signOff: { flexDirection: 'row', justifyContent: 'space-between', fontSize: 8.5, marginTop: 14 },
  footer: { position: 'absolute', left: 24, right: 24, bottom: 16, flexDirection: 'row', justifyContent: 'space-between', fontSize: 7, color: C.mute },
});
// A4 = 595 pt wide, 547 pt between the margins.
const CONTENT_WIDTH = 547;
const W = { seq: 22, cust: 160, time: 80, cases: 88, so: 58, map: 62, sign: 77 };

/** The driver break between two stop rows (or before the first stop). */
function BreakRow({ text }: { text: string }) {
  return (
    <View style={s.tr} wrap={false}>
      <T style={[s.cell, { width: CONTENT_WIDTH, fontFamily: BOLD, fontSize: 9 }]}>{`${text} - driver break, never while unloading`}</T>
    </View>
  );
}

function StopRow({ st }: { st: SheetStop }) {
  const meta = [st.customerCode, st.branchCode ? `branch ${st.branchCode}` : null, st.customerType, `P${st.priority}`].filter(Boolean).join(' · ');
  return (
    <View style={s.tr} wrap={false}>
      <T style={[s.cell, s.seq, { width: W.seq }]}>{st.sequence}</T>
      <View style={[s.cell, { width: W.cust }]}>
        <T style={{ fontFamily: BOLD, fontSize: 9.5 }}>{st.customerName}</T>
        <T style={s.small}>{meta}</T>
        {st.address ? <T style={{ fontSize: 7.5 }}>{st.address}</T> : null}
        {st.split ? (
          <T style={{ fontFamily: BOLD, fontSize: 8 }}>
            {`SPLIT DELIVERY - part ${st.split.part} of ${st.split.parts}`}
            {st.split.others.length ? ` (${st.split.others.join(', ')})` : ''}
            {st.split.restUnserved ? '; the rest is NOT on a truck today' : ''}
          </T>
        ) : null}
        {st.late ? <T style={{ fontFamily: BOLD, fontSize: 8 }}>LATE ORDER</T> : null}
        {st.carried ? <T style={{ fontFamily: BOLD, fontSize: 8 }}>{st.carried}</T> : null}
        {st.accessNotes ? <T style={{ fontSize: 7.5, fontFamily: 'Helvetica-Oblique' }}>Access: {st.accessNotes}</T> : null}
        {st.changeNotes.map((n) => (
          <T key={n} style={{ fontFamily: BOLD, fontSize: 7.5 }}>
            {n}
          </T>
        ))}
        {st.newPinUrl ? (
          <Link src={st.newPinUrl} style={[s.link, { fontSize: 7.5 }]}>
            Open the new pin - ask the dispatcher which one to use
          </Link>
        ) : null}
        {st.notes.map((n) => (
          <T key={n} style={{ fontSize: 7.5, fontFamily: 'Helvetica-Oblique' }}>
            Note: {n}
          </T>
        ))}
      </View>
      <View style={[s.cell, { width: W.time }]}>
        <T style={{ fontFamily: BOLD, fontSize: 11 }}>{st.eta}</T>
        {st.until ? <T style={[s.small, { fontSize: 7.5 }]}>{st.until}</T> : null}
        {st.hours.map((h) => (
          <T key={h} style={[s.small, { fontSize: 7 }]}>
            {h}
          </T>
        ))}
        {st.outsideHours ? <T style={{ fontFamily: BOLD, fontSize: 7.5 }}>Outside receiving hours - call ahead</T> : null}
      </View>
      <View style={[s.cell, { width: W.cases }]}>
        <T style={{ fontFamily: BOLD, fontSize: 10 }}>{st.cases} cases</T>
        {st.skus.map((k) => (
          <T key={k.productCode} style={{ fontSize: 7.5 }}>
            {`${k.productCode} ×${k.cases}`}
          </T>
        ))}
      </View>
      <View style={[s.cell, { width: W.so }]}>
        {st.salesOrders.length ? (
          st.salesOrders.map((so) => (
            <T key={so} style={{ fontSize: 7.5 }}>
              {so}
            </T>
          ))
        ) : (
          <T style={s.small}>-</T>
        )}
      </View>
      <View style={[s.cell, { width: W.map }]}>
        {st.pinUrl ? (
          <>
            <Qr url={st.pinUrl} size={42} />
            <Link src={st.pinUrl} style={[s.link, { fontSize: 7.5 }]}>
              Open map
            </Link>
            <T style={{ fontSize: 6, color: C.mute }}>{st.coords!.replace(',', ',\n')}</T>
          </>
        ) : (
          <T style={{ fontFamily: BOLD, fontSize: 7.5 }}>No location - call dispatcher</T>
        )}
      </View>
      <View style={[s.cell, { width: W.sign }]}>
        <T style={{ fontSize: 6.5, color: C.mute }}>Cases received: ____</T>
        <View style={s.signBox} />
        <T style={{ fontSize: 6, color: C.mute }}>name · sign · stamp</T>
      </View>
    </View>
  );
}

function SheetPage({ m, sh }: { m: DriverPackModel; sh: DriverSheet }) {
  const lastStop = sh.stops[sh.stops.length - 1];
  // The driver link first (its QR, or the note in its place), then the route codes (sheetQrCodes).
  const NOTE_WIDTH = 76;
  // Fixed widths, not flex-shrink: react-pdf lays text out once, at the first width it measures.
  const headWidth = CONTENT_WIDTH - (sh.driverLinkNote ? NOTE_WIDTH + 12 : 0) - sh.qrCodes.reduce((a, q) => a + q.size + 12, 0);
  return (
    <Page size="A4" style={s.page}>
      {/* Compact header on every page (the only header on continuation pages). Fixed widths so a
          long tenant name or truck code wraps instead of running into the other side. */}
      <View style={s.strip} fixed>
        <T style={{ width: CONTENT_WIDTH * 0.6 }}>
          {m.tenantName ? `${m.tenantName} · ` : ''}Driver sheet · Truck {sh.truckCode} · Trip {sh.trip} of {sh.trips}
        </T>
        <T style={{ width: CONTENT_WIDTH * 0.4, textAlign: 'right' }}>
          Delivery {m.runDate} · Plan v{m.version} · Depot {m.depot.code}
          {m.superseded ? ' · SUPERSEDED - DO NOT USE' : ''}
          {sh.timesNotVerified ? ' · TIMES NOT VERIFIED' : ''}
        </T>
      </View>

      {m.superseded ? <T style={s.bigWarn}>This plan version was replaced. Do not use this sheet - ask the dispatcher for the new one.</T> : null}
      {sh.timesNotVerified ? (
        <T style={s.bigWarn}>TIMES NOT VERIFIED - the departure or delivery times of this truck break a planning rule. Check with the dispatcher before leaving.</T>
      ) : null}
      <View style={{ flexDirection: 'row' }}>
        <View style={{ width: headWidth }}>
          {/* A block of its own so a long truck code wraps at spaces instead of running under the QR. */}
          <T style={s.h1}>
            Truck {sh.truckCode} — Trip {sh.trip} of {sh.trips}
          </T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginVertical: 2 }}>
            {sh.badges.map((b) => (
              <T key={b} style={s.badge}>
                {b}
              </T>
            ))}
          </View>
          <T style={s.small}>
            {m.tenantName ? `${m.tenantName} · ` : ''}Depot {m.depot.code} - {m.depot.name} · Delivery {m.runDate} · Plan v{m.version}
          </T>
          <View style={s.facts}>
            <T style={s.fact}>
              <T style={s.b}>Driver </T>
              {sh.driverName ? `${sh.driverName}${sh.driverPhone ? ` · ${sh.driverPhone}` : ''}` : '______________________  Phone ______________'}
            </T>
            <T style={s.fact}>
              <T style={s.b}>Depart </T>
              {sh.depart}
              <T style={s.b}>{'  '}Back ~</T>
              {sh.back}
              {sh.breakTimes ? <T style={s.b}>{'  '}Break </T> : null}
              {sh.breakTimes ?? ''}
            </T>
            <T style={s.fact}>
              <T style={s.b}>{sh.stops.length}</T> {sh.stops.length === 1 ? 'stop' : 'stops'} ·{' '}
              {sh.pallets ? (
                <>
                  <T style={s.b}>{sh.cases}</T> cases · <T style={s.b}>{sh.pallets.overBays}</T> pallets
                </>
              ) : (
                <>
                  <T style={s.b}>{sh.cases}</T> / {sh.capacityCases} cases
                </>
              )}{' '}
              · {sh.kmLabel} {sh.km}
            </T>
          </View>
          <T style={s.line}>
            <T style={s.b}>Load check: </T>
            {sh.loadCheck.items.map((k) => `${k.productCode} ×${k.cases}`).join(' · ')}
            <T style={s.b}> = {sh.loadCheck.total} cases{sh.pallets ? ` (${sh.pallets.total} pallets)` : ''}</T>
            {sh.loadCheck.matchesLoad ? '' : ` - the plan says ${sh.cases}: check with the dispatcher before loading`}
          </T>
          <T style={s.line}>
            <T style={s.b}>Route in Google Maps: </T>
            {sh.route.links.length
              ? sh.route.links.map((r, i) => (
                  <React.Fragment key={r.url}>
                    {i ? '  ·  ' : ''}
                    <Link src={r.url} style={s.link}>
                      {r.label}
                    </Link>
                  </React.Fragment>
                ))
              : 'no stop has a location - call the dispatcher'}
            {sh.route.links.length && sh.route.skipped.length ? `  (stop ${sh.route.skipped.join(', ')} not in the link: no location)` : ''}
          </T>
          {sh.unprintable ? <T style={[s.line, s.b]}>{`${UNPRINTABLE} = text this sheet cannot print (for example Arabic letters) - ask the dispatcher.`}</T> : null}
        </View>
        {sh.qrCodes.length || sh.driverLinkNote ? (
          <View style={{ flexDirection: 'row', marginLeft: 6 }}>
            {sh.driverLinkNote ? (
              <View style={{ marginLeft: 12, width: NOTE_WIDTH, borderWidth: 1, borderColor: C.ink, padding: 3 }}>
                <T style={{ fontFamily: BOLD, fontSize: 8 }}>{sh.driverLinkNote}</T>
              </View>
            ) : null}
            {sh.qrCodes.map((q) => (
              <View key={`${q.kind}-${q.url}`} style={{ alignItems: 'center', marginLeft: 12, width: q.size }}>
                {q.kind === 'DRIVER_LINK' ? <T style={{ fontFamily: BOLD, fontSize: 7 }}>DRIVER PAGE</T> : null}
                <Qr url={q.url} size={q.size} level={q.kind === 'DRIVER_LINK' ? 'M' : 'L'} quiet={4} />
                <T style={{ fontSize: 6.5, color: q.kind === 'DRIVER_LINK' ? C.ink : C.mute, textAlign: 'center' }}>{q.caption}</T>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      <View style={s.th} fixed>
        <T style={[s.cell, { width: W.seq }]}>#</T>
        <T style={[s.cell, { width: W.cust }]}>Customer · address · notes</T>
        <T style={[s.cell, { width: W.time }]}>ETA · hours</T>
        <T style={[s.cell, { width: W.cases }]}>Cases (per SKU)</T>
        <T style={[s.cell, { width: W.so }]}>Sales order</T>
        <T style={[s.cell, { width: W.map }]}>Location</T>
        <T style={[s.cell, { width: W.sign }]}>Received</T>
      </View>
      {sh.breakBefore ? <BreakRow text={sh.breakBefore} /> : null}
      {sh.stops.slice(0, -1).map((st) => (
        <React.Fragment key={st.sequence}>
          <StopRow st={st} />
          {st.breakAfter ? <BreakRow text={st.breakAfter} /> : null}
        </React.Fragment>
      ))}
      {/* The last stop, the return line and the sign-off stay together: they never start a page alone. */}
      <View wrap={false}>
        {lastStop ? <StopRow st={lastStop} /> : null}
        {lastStop?.breakAfter ? <BreakRow text={lastStop.breakAfter} /> : null}
        <T style={{ marginTop: 5, fontSize: 9, fontFamily: BOLD }}>{sh.returnText}</T>
        <View style={s.signOff}>
          <T>Loaded by: ________________</T>
          <T>Driver: ________________</T>
          <T>Time out: ________</T>
          <T>Time back: ________</T>
        </View>
      </View>

      <View style={s.footer} fixed>
        <T style={{ width: CONTENT_WIDTH - 70 }}>{sh.footerText}</T>
        <Text style={{ width: 70, textAlign: 'right' }} render={({ subPageNumber, subPageTotalPages }) => `Page ${subPageNumber} / ${subPageTotalPages}`} />
      </View>
    </Page>
  );
}

/** One section per load, each starting on a new page. */
export async function renderDriverPackPdf(m: DriverPackModel): Promise<Buffer> {
  const doc = (
    <Document title={m.title} author={m.tenantName || 'RouteIQ'} creator="RouteIQ">
      {m.sheets.map((sh) => (
        <SheetPage key={sh.loadId} m={m} sh={sh} />
      ))}
    </Document>
  );
  return (await renderToBuffer(doc)) as Buffer;
}
