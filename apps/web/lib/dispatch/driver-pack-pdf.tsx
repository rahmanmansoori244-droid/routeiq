/**
 * The layout of the driver sheets (driver-pack.tsx has the model): one A4 portrait section per
 * truck load, drawn from a DriverPackModel with @react-pdf/renderer.
 *
 * Only the PDF renderer process runs this (lib/pdf-render/child.ts), and the tests: laying out a
 * whole day's pack takes 8-30 s of CPU for 150-400 stops and hardly gives the event loop back (the
 * web answered nothing for 4-15 s at a time, review M3), so the web process sends the model there and
 * gets the PDF's bytes back (renderDriverPackIsolated in lib/pdf-render). The model is plain data,
 * so it crosses as it is.
 */
import * as React from 'react';
import { Document, Link, Page, Path, StyleSheet, Svg, Text, View, renderToBuffer } from '@react-pdf/renderer';
import type { DriverPackModel, DriverSheet, SheetStop } from './driver-pack';
import { qrPath } from './qr';
import { UNPRINTABLE } from './pdf-text';

// ---------------------------------------------------------------------------------------
// QR codes, drawn as vectors (lib/dispatch/qr.ts: one path per code, crisp at any print size)
// ---------------------------------------------------------------------------------------

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
