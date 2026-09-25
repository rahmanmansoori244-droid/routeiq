/**
 * Driver sheets ("driver pack"): one A4 portrait section per truck load, for the driver to take
 * in the cab - who to visit in which order, when, what to hand over, where the place is (link +
 * QR), and a box per stop for the customer's signature/stamp.
 *
 * Built only from PlanDetail (the same object as the plan screen and the Excel workbook), in two
 * steps: driverPackModel() is pure and unit-tested; renderDriverPackPdf() only lays it out.
 * The driver sheet never shows money: no cost, fuel, revenue or margin.
 *
 * Font: the PDF built-in Helvetica (no font files to ship). It covers Latin text only (WinAnsi:
 * letters, digits, "·", "×", "–", "—"). NMWC master data is in English today; Arabic customer
 * names would print as blanks - that needs a bundled font with Arabic glyphs (e.g. Noto Naskh
 * Arabic) registered with Font.register().
 */
import * as React from 'react';
import { Document, Link, Page, Path, StyleSheet, Svg, Text, View, renderToBuffer } from '@react-pdf/renderer';
import { create as createQr } from 'qrcode';
import type { DetailLoad, DetailStop, PlanDetail } from './plan-detail';
import { coordText, pinUrl, routeLinks, tripsByTruck, type RoutePlan } from './driver-links';
import { fmtHhmm } from './time';

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
  eta: string;
  /** Receiving hours, one line each: "Receives 06:00–14:00", "Best 07:00–10:00" or "Any time". */
  hours: string[];
  /** The plan arrives outside the customer's hard receiving hours. */
  outsideHours: boolean;
  cases: number;
  skus: { productCode: string; productName: string; cases: number }[];
  salesOrders: string[];
  pinUrl: string | null;
  coords: string | null;
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
  cases: number;
  capacityCases: number;
  kmLabel: 'Estimated km' | 'Road km';
  km: number;
  /** From the load manifest: what the driver counts before leaving. */
  loadCheck: { items: { productCode: string; productName: string; cases: number }[]; total: number; matchesLoad: boolean };
  route: RoutePlan;
  stops: SheetStop[];
  returnText: string;
  footerText: string;
}

export interface DriverPackModel {
  title: string;
  tenantName: string;
  runDate: string;
  version: number;
  superseded: boolean;
  depot: { code: string; name: string };
  sheets: DriverSheet[];
}

export interface DriverPackOptions {
  tenantName: string;
  /** Only these loads (kept in plan order); all loads when omitted. */
  loadIds?: string[];
}

const BADGE: Record<string, string> = {
  PLANNED: 'PLANNED - not locked yet',
  LOCKED: 'LOCKED',
  LOADING: 'LOADING',
  DISPATCHED: 'DISPATCHED',
  COMPLETED: 'COMPLETED',
};

/** "hard 06:00–14:00, preferred 07:00–10:00" (describeWindows) -> driver wording, one per line. */
function hoursLines(window: string): string[] {
  if (!window || window === 'Any time') return ['Any time'];
  return window.split(', ').map((w) => w.replace(/^hard /, 'Receives ').replace(/^preferred /, 'Best '));
}

function sheetStop(d: PlanDetail, l: DetailLoad, s: DetailStop): SheetStop {
  let split: SheetStop['split'] = null;
  if (s.split) {
    // Where the customer's other parts are: truck + trip, in part order.
    const others = d.loads
      .flatMap((x) => x.stops.filter((y) => y.customerId === s.customerId && y.split && !(x.id === l.id && y.sequence === s.sequence)).map((y) => ({ x, y })))
      .sort((a, b) => a.y.split!.part - b.y.split!.part)
      .map(({ x, y }) => `part ${y.split!.part} on ${x.truckCode} trip ${x.loadNo}`);
    split = { part: s.split.part, parts: s.split.parts, others, restUnserved: s.split.restUnserved };
  }
  return {
    sequence: s.sequence,
    customerName: s.customerName,
    customerCode: s.customerCode,
    branchCode: s.branchCode,
    customerType: s.customerType,
    priority: s.priority,
    address: s.address?.trim() || null,
    accessNotes: s.accessNotes?.trim() || null,
    notes: s.notes.map((n) => n.trim()).filter(Boolean),
    split,
    late: s.late,
    eta: fmtHhmm(s.etaMin),
    hours: hoursLines(s.window),
    outsideHours: s.hardWindowOk === false,
    cases: s.cases,
    skus: s.skus.map((k) => ({ productCode: k.productCode, productName: k.productName, cases: k.cases })),
    salesOrders: s.salesOrders,
    pinUrl: pinUrl(s),
    coords: s.lat !== null && s.lng !== null ? coordText(s.lat, s.lng) : null,
  };
}

export function driverPackModel(detail: PlanDetail, opts: DriverPackOptions): DriverPackModel {
  const d = detail;
  const wanted = opts.loadIds ? new Set(opts.loadIds) : null;
  const trips = tripsByTruck(d.loads);
  const v = d.run.version;
  const sheets = d.loads
    .filter((l) => !wanted || wanted.has(l.id))
    .map((l): DriverSheet => {
      const n = trips.get(l.truckId) ?? 1;
      const next = d.loads.filter((x) => x.truckId === l.truckId && x.loadNo > l.loadNo).sort((a, b) => a.loadNo - b.loadNo)[0];
      const stops = [...l.stops].sort((a, b) => a.sequence - b.sequence);
      const total = l.manifest.reduce((a, m) => a + m.cases, 0);
      return {
        loadId: l.id,
        truckId: l.truckId,
        truckCode: l.truckCode,
        trip: l.loadNo,
        trips: n,
        status: l.status,
        carried: l.carried,
        badges: [BADGE[l.status] ?? l.status, ...(l.carried ? ['KEPT FROM PREVIOUS VERSION'] : [])],
        driverName: l.driverName,
        driverPhone: l.driverPhone,
        depart: fmtHhmm(l.departMin),
        back: fmtHhmm(l.returnMin),
        cases: l.cases,
        capacityCases: l.truckCapacityCases,
        kmLabel: l.distanceIsEstimated ? 'Estimated km' : 'Road km',
        km: Math.round(l.distanceKm),
        loadCheck: {
          items: l.manifest.map((m) => ({ productCode: m.productCode, productName: m.productName, cases: m.cases })),
          total,
          matchesLoad: total === l.cases,
        },
        route: routeLinks(d.run.depot, stops),
        stops: stops.map((s) => sheetStop(d, l, s)),
        returnText:
          `Return to depot ${d.run.depot.code} ~${fmtHhmm(l.returnMin)}` +
          (next ? ` - load trip ${next.loadNo} (planned departure ${fmtHhmm(next.departMin)}).` : ' - last trip of the day.'),
        footerText: `${l.truckCode} trip ${l.loadNo} of ${n} · delivery ${d.run.runDate} · plan v${v} - this sheet is void if a newer plan version is issued`,
      };
    });
  return {
    title: `Driver sheets ${d.run.runDate} v${v}`,
    tenantName: opts.tenantName,
    runDate: d.run.runDate,
    version: v,
    superseded: d.run.status === 'SUPERSEDED',
    depot: { code: d.run.depot.code, name: d.run.depot.name },
    sheets,
  };
}

// ---------------------------------------------------------------------------------------
// QR codes, drawn as vectors (one path per code: crisp at any print size, tiny file)
// ---------------------------------------------------------------------------------------

export function qrPath(text: string, level: 'L' | 'M' = 'M'): { size: number; d: string } {
  const m = createQr(text, { errorCorrectionLevel: level }).modules;
  const parts: string[] = [];
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; ) {
      if (!m.get(r, c)) {
        c++;
        continue;
      }
      const c0 = c;
      while (c < m.size && m.get(r, c)) c++;
      parts.push(`M${c0} ${r}H${c}V${r + 1}H${c0}Z`);
    }
  }
  return { size: m.size, d: parts.join('') };
}

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
        {st.accessNotes ? <T style={{ fontSize: 7.5, fontFamily: 'Helvetica-Oblique' }}>Access: {st.accessNotes}</T> : null}
        {st.notes.map((n) => (
          <T key={n} style={{ fontSize: 7.5, fontFamily: 'Helvetica-Oblique' }}>
            Note: {n}
          </T>
        ))}
      </View>
      <View style={[s.cell, { width: W.time }]}>
        <T style={{ fontFamily: BOLD, fontSize: 11 }}>{st.eta}</T>
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
  const routeQrs = sh.route.links.slice(0, 3);
  const qrSize = routeQrs.length > 1 ? 64 : 76;
  // Fixed widths, not flex-shrink: react-pdf lays text out once, at the first width it measures.
  const headWidth = CONTENT_WIDTH - routeQrs.length * (qrSize + 12);
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
        </T>
      </View>

      {m.superseded ? <T style={s.bigWarn}>This plan version was replaced. Do not use this sheet - ask the dispatcher for the new one.</T> : null}
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
            </T>
            <T style={s.fact}>
              <T style={s.b}>{sh.stops.length}</T> {sh.stops.length === 1 ? 'stop' : 'stops'} · <T style={s.b}>{sh.cases}</T> / {sh.capacityCases} cases · {sh.kmLabel} {sh.km}
            </T>
          </View>
          <T style={s.line}>
            <T style={s.b}>Load check: </T>
            {sh.loadCheck.items.map((k) => `${k.productCode} ×${k.cases}`).join(' · ')}
            <T style={s.b}> = {sh.loadCheck.total} cases</T>
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
        </View>
        {routeQrs.length ? (
          <View style={{ flexDirection: 'row', marginLeft: 6 }}>
            {routeQrs.map((r) => (
              <View key={r.url} style={{ alignItems: 'center', marginLeft: 12 }}>
                <Qr url={r.url} size={qrSize} level="L" quiet={4} />
                <T style={{ fontSize: 6.5, color: C.mute }}>{routeQrs.length > 1 ? `Route ${r.part}/${r.parts}` : 'Scan: whole route'}</T>
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
      {sh.stops.slice(0, -1).map((st) => (
        <StopRow key={st.sequence} st={st} />
      ))}
      {/* The last stop, the return line and the sign-off stay together: they never start a page alone. */}
      <View wrap={false}>
        {lastStop ? <StopRow st={lastStop} /> : null}
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
