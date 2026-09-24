/**
 * A4 PDF route sheets via @react-pdf/renderer. One Page per truck + one
 * summary + one unserved + optional baseline.
 *
 * Spec §6: per-truck PDF same content as Excel but A4 print-formatted.
 */
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import * as React from 'react';
import type { RouteSheet, TruckRoute } from './route-sheet-data';
import { fmtArrival, kmLabel } from './route-sheet-data';

const palette = {
  brand: '#2563EB',
  text: '#0F172A',
  muted: '#64748B',
  border: '#CBD5E1',
  banner: '#F1F5F9',
  success: '#16A34A',
  danger: '#B91C1C',
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 28,
    paddingBottom: 32,
    paddingHorizontal: 28,
    fontSize: 9,
    color: palette.text,
    fontFamily: 'Helvetica',
  },
  title: { fontSize: 14, fontWeight: 700, color: palette.brand, marginBottom: 4 },
  subtitle: { fontSize: 9, color: palette.muted, marginBottom: 10 },
  banner: {
    backgroundColor: palette.banner,
    padding: 6,
    marginBottom: 10,
    fontSize: 9,
    color: palette.text,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  table: { display: 'flex', flexDirection: 'column', borderTop: 1, borderColor: palette.border },
  row: { flexDirection: 'row', borderBottom: 1, borderColor: palette.border, alignItems: 'stretch' },
  rowHeader: { backgroundColor: palette.brand, color: '#FFFFFF', fontWeight: 700 },
  cell: { padding: 4, borderRight: 1, borderColor: palette.border },
  cellRight: { textAlign: 'right' },
  cellLastRight: { borderRightWidth: 0 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', position: 'absolute', bottom: 18, left: 28, right: 28 },
  unservedRow: { color: palette.danger },
  notes: { fontStyle: 'italic', color: palette.muted },
});

const cols = {
  seq: 22,
  code: 70,
  customer: 110,
  address: 130,
  cases: 35,
  weight: 45,
  arrival: 40,
  distance: 50,
  signature: 60,
  notes: 80,
};

function totalWidth(): number {
  return Object.values(cols).reduce((a, b) => a + b, 0);
}

function Header(props: { sheet: RouteSheet }) {
  const s = props.sheet;
  return (
    <View>
      <Text style={styles.title}>
        {s.tenant.name} — Route plan {s.run.runDate}
      </Text>
      <Text style={styles.subtitle}>
        {s.run.depotCode} ({s.run.depotName}) · {s.run.optimizationMode} · {s.run.distanceProvider}
        {s.run.distanceIsEstimated ? ' (estimated)' : ''}
      </Text>
    </View>
  );
}

function TruckPage({ sheet, truck }: { sheet: RouteSheet; truck: TruckRoute }) {
  const distLabel = kmLabel(sheet.run.distanceIsEstimated);
  return (
    <Page size="A4" style={styles.page}>
      <Header sheet={sheet} />
      <Text style={{ fontSize: 12, fontWeight: 700, marginTop: 4 }}>
        Truck {truck.truckCode}
        {truck.truckDescription ? ` — ${truck.truckDescription}` : ''}
      </Text>
      <View style={styles.banner}>
        <Text>Stops: {truck.stops.length}</Text>
        <Text>
          Cases: {truck.totalCases} / {truck.capacityCases} ({truck.utilizationPct}%)
        </Text>
        <Text>Weight: {Math.round(truck.totalWeightKg * 10) / 10} kg</Text>
        <Text>
          {distLabel}: {Math.round(truck.totalDistanceKm * 100) / 100}
        </Text>
        <Text>Final arrival: {fmtArrival(truck.finalArrivalMin)}</Text>
      </View>

      <View style={styles.table} wrap>
        <View style={[styles.row, styles.rowHeader]} fixed>
          <Text style={[styles.cell, { width: cols.seq }]}>#</Text>
          <Text style={[styles.cell, { width: cols.code }]}>Code</Text>
          <Text style={[styles.cell, { width: cols.customer }]}>Customer</Text>
          <Text style={[styles.cell, { width: cols.address }]}>Address</Text>
          <Text style={[styles.cell, styles.cellRight, { width: cols.cases }]}>Cases</Text>
          <Text style={[styles.cell, styles.cellRight, { width: cols.weight }]}>Kg</Text>
          <Text style={[styles.cell, styles.cellRight, { width: cols.arrival }]}>Arr.</Text>
          <Text style={[styles.cell, styles.cellRight, { width: cols.distance }]}>{distLabel}</Text>
          <Text style={[styles.cell, { width: cols.signature }]}>Signature</Text>
          <Text style={[styles.cell, styles.cellLastRight, { width: cols.notes }]}>Notes</Text>
        </View>
        {truck.stops.map((st) => (
          <View
            key={`${st.sequence}-${st.customerCode}-${st.branchKey}`}
            style={styles.row}
          >
            <Text style={[styles.cell, { width: cols.seq }]}>{st.sequence}</Text>
            <Text style={[styles.cell, { width: cols.code }]}>
              {st.customerCode}
              {st.branchKey !== '__MAIN__' ? ` / ${st.branchKey}` : ''}
            </Text>
            <Text style={[styles.cell, { width: cols.customer }]}>
              {st.customerName}
              {st.locked ? ' 🔒' : ''}
            </Text>
            <Text style={[styles.cell, { width: cols.address }]}>{st.address ?? ''}</Text>
            <Text style={[styles.cell, styles.cellRight, { width: cols.cases }]}>{st.cases}</Text>
            <Text style={[styles.cell, styles.cellRight, { width: cols.weight }]}>
              {Math.round(st.weightKg * 10) / 10}
            </Text>
            <Text style={[styles.cell, styles.cellRight, { width: cols.arrival }]}>
              {fmtArrival(st.plannedArrivalMin)}
            </Text>
            <Text style={[styles.cell, styles.cellRight, { width: cols.distance }]}>
              {Math.round(st.plannedDistanceFromPrevKm * 100) / 100}
            </Text>
            <Text style={[styles.cell, { width: cols.signature }]}> </Text>
            <Text style={[styles.cell, styles.cellLastRight, styles.notes, { width: cols.notes }]}>
              {st.notes ?? ''}
            </Text>
          </View>
        ))}
        <View style={[styles.row, { backgroundColor: palette.banner }]}>
          <Text style={[styles.cell, { width: cols.seq + cols.code + cols.customer + cols.address }]}>Totals</Text>
          <Text style={[styles.cell, styles.cellRight, { width: cols.cases, fontWeight: 700 }]}>{truck.totalCases}</Text>
          <Text style={[styles.cell, styles.cellRight, { width: cols.weight }]}>
            {Math.round(truck.totalWeightKg * 10) / 10}
          </Text>
          <Text style={[styles.cell, { width: cols.arrival }]}> </Text>
          <Text style={[styles.cell, styles.cellRight, { width: cols.distance }]}>
            {Math.round(truck.totalDistanceKm * 100) / 100}
          </Text>
          <Text style={[styles.cell, { width: cols.signature }]}> </Text>
          <Text style={[styles.cell, styles.cellLastRight, { width: cols.notes }]}> </Text>
        </View>
      </View>

      <View style={styles.footer} fixed>
        <Text>
          {sheet.run.depotCode} · {sheet.run.runDate}
        </Text>
        <Text
          render={({ pageNumber, totalPages }: any) => `Page ${pageNumber} / ${totalPages}`}
        />
      </View>
    </Page>
  );
}

function SummaryPage({ sheet }: { sheet: RouteSheet }) {
  const distLabel = kmLabel(sheet.run.distanceIsEstimated);
  const widths = { code: 60, stops: 40, cases: 50, kg: 60, dist: 70, arr: 50, util: 50 };
  return (
    <Page size="A4" style={styles.page}>
      <Header sheet={sheet} />
      <Text style={{ fontSize: 12, fontWeight: 700, marginTop: 4 }}>Plan summary</Text>
      <View style={styles.banner}>
        <Text>Trucks: {sheet.totals.trucks}</Text>
        <Text>Stops: {sheet.totals.stops}</Text>
        <Text>Cases: {sheet.totals.cases}</Text>
        <Text>Weight: {Math.round(sheet.totals.weightKg * 10) / 10} kg</Text>
        <Text>
          {distLabel}: {Math.round(sheet.totals.distanceKm * 100) / 100}
        </Text>
        <Text>Unserved: {sheet.unserved.length}</Text>
      </View>
      <View style={styles.table}>
        <View style={[styles.row, styles.rowHeader]}>
          <Text style={[styles.cell, { width: widths.code }]}>Truck</Text>
          <Text style={[styles.cell, styles.cellRight, { width: widths.stops }]}>Stops</Text>
          <Text style={[styles.cell, styles.cellRight, { width: widths.cases }]}>Cases</Text>
          <Text style={[styles.cell, styles.cellRight, { width: widths.kg }]}>Kg</Text>
          <Text style={[styles.cell, styles.cellRight, { width: widths.dist }]}>{distLabel}</Text>
          <Text style={[styles.cell, styles.cellRight, { width: widths.arr }]}>Last arr.</Text>
          <Text style={[styles.cell, styles.cellLastRight, styles.cellRight, { width: widths.util }]}>Util %</Text>
        </View>
        {sheet.routes.map((t) => (
          <View key={t.truckId} style={styles.row}>
            <Text style={[styles.cell, { width: widths.code }]}>{t.truckCode}</Text>
            <Text style={[styles.cell, styles.cellRight, { width: widths.stops }]}>{t.stops.length}</Text>
            <Text style={[styles.cell, styles.cellRight, { width: widths.cases }]}>{t.totalCases}</Text>
            <Text style={[styles.cell, styles.cellRight, { width: widths.kg }]}>
              {Math.round(t.totalWeightKg * 10) / 10}
            </Text>
            <Text style={[styles.cell, styles.cellRight, { width: widths.dist }]}>
              {Math.round(t.totalDistanceKm * 100) / 100}
            </Text>
            <Text style={[styles.cell, styles.cellRight, { width: widths.arr }]}>
              {fmtArrival(t.finalArrivalMin)}
            </Text>
            <Text style={[styles.cell, styles.cellLastRight, styles.cellRight, { width: widths.util }]}>
              {t.utilizationPct}
            </Text>
          </View>
        ))}
      </View>

      {sheet.baselineComparison ? (
        <View style={{ marginTop: 16 }}>
          <Text style={{ fontSize: 12, fontWeight: 700 }}>Manual baseline comparison</Text>
          <Text style={{ fontSize: 9, color: palette.muted, marginBottom: 6 }}>
            File: {sheet.baselineComparison.baselineFileName ?? '—'}
          </Text>
          <Text>
            Truck delta:{' '}
            {sheet.baselineComparison.truckDelta === null
              ? '—'
              : `${sheet.baselineComparison.truckDelta > 0 ? '+' : ''}${sheet.baselineComparison.truckDelta}${
                  sheet.baselineComparison.truckPct !== null ? ` (${sheet.baselineComparison.truckPct.toFixed(1)}%)` : ''
                }`}
          </Text>
          <Text>
            {distLabel} delta:{' '}
            {sheet.baselineComparison.distanceDelta === null
              ? '—'
              : `${sheet.baselineComparison.distanceDelta > 0 ? '+' : ''}${Math.round(
                  sheet.baselineComparison.distanceDelta * 100,
                ) / 100}${
                  sheet.baselineComparison.distancePct !== null
                    ? ` (${sheet.baselineComparison.distancePct.toFixed(1)}%)`
                    : ''
                }`}
          </Text>
        </View>
      ) : null}

      <View style={styles.footer} fixed>
        <Text>
          {sheet.run.depotCode} · {sheet.run.runDate}
        </Text>
        <Text render={({ pageNumber, totalPages }: any) => `Page ${pageNumber} / ${totalPages}`} />
      </View>
    </Page>
  );
}

function UnservedPage({ sheet }: { sheet: RouteSheet }) {
  return (
    <Page size="A4" style={styles.page}>
      <Header sheet={sheet} />
      <Text style={{ fontSize: 12, fontWeight: 700, marginTop: 4 }}>
        Unserved orders — {sheet.unserved.length}
      </Text>
      {sheet.unserved.length === 0 ? (
        <Text style={{ color: palette.success, marginTop: 6 }}>No unserved orders. </Text>
      ) : (
        <View style={[styles.table, { marginTop: 8 }]}>
          <View style={[styles.row, styles.rowHeader]}>
            <Text style={[styles.cell, { width: 70 }]}>Code</Text>
            <Text style={[styles.cell, { width: 130 }]}>Customer</Text>
            <Text style={[styles.cell, styles.cellRight, { width: 40 }]}>Cases</Text>
            <Text style={[styles.cell, { width: 110 }]}>Reason</Text>
            <Text style={[styles.cell, styles.cellLastRight, { width: 180 }]}>Detail</Text>
          </View>
          {sheet.unserved.map((u, idx) => (
            <View
              key={`${u.customerCode}-${u.branchKey}-${idx}`}
              style={[styles.row, styles.unservedRow]}
            >
              <Text style={[styles.cell, { width: 70 }]}>
                {u.customerCode}
                {u.branchKey !== '__MAIN__' ? ` / ${u.branchKey}` : ''}
              </Text>
              <Text style={[styles.cell, { width: 130 }]}>{u.customerName}</Text>
              <Text style={[styles.cell, styles.cellRight, { width: 40 }]}>{u.cases}</Text>
              <Text style={[styles.cell, { width: 110 }]}>{u.reasonCode}</Text>
              <Text style={[styles.cell, styles.cellLastRight, { width: 180 }]}>
                {u.reasonMessage ?? ''}
              </Text>
            </View>
          ))}
        </View>
      )}
      <View style={styles.footer} fixed>
        <Text>
          {sheet.run.depotCode} · {sheet.run.runDate}
        </Text>
        <Text render={({ pageNumber, totalPages }: any) => `Page ${pageNumber} / ${totalPages}`} />
      </View>
    </Page>
  );
}

export async function buildRouteSheetPdf(sheet: RouteSheet, truckFilter?: string): Promise<Buffer> {
  const pages: React.ReactNode[] = [];
  if (truckFilter) {
    const t = sheet.routes.find((r) => r.truckId === truckFilter || r.truckCode === truckFilter);
    if (t) pages.push(<TruckPage key={t.truckId} sheet={sheet} truck={t} />);
  } else {
    pages.push(<SummaryPage key="summary" sheet={sheet} />);
    for (const t of sheet.routes) pages.push(<TruckPage key={t.truckId} sheet={sheet} truck={t} />);
    pages.push(<UnservedPage key="unserved" sheet={sheet} />);
  }
  // Use renderToBuffer (server-side stream → Buffer). Bound to Node runtime.
  const buf = await renderToBuffer(<Document>{pages}</Document> as any);
  return buf as Buffer;
}

// Width hint kept for layout testing.
void totalWidth;
