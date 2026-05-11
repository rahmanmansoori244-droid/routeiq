/**
 * ExcelJS-powered route sheet generator. CLAUDE.md §6 specifies:
 *   - One sheet per truck with header + table + footer
 *   - Summary sheet
 *   - Unserved sheet
 *   - When Haversine is active, all km columns read "Estimated km"
 */
import ExcelJS from 'exceljs';
import { type RouteSheet, fmtArrival, kmLabel } from './route-sheet-data';

const HEADER_FILL: ExcelJS.FillPattern = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF2563EB' }, // brand blue
};
const HEADER_FONT: Partial<ExcelJS.Font> = { color: { argb: 'FFFFFFFF' }, bold: true };
const SUBHEADER_FILL: ExcelJS.FillPattern = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF1F5F9' }, // slate-100
};
const BORDER: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FFCBD5E1' } };
const ALL_BORDERS: Partial<ExcelJS.Borders> = {
  top: BORDER,
  bottom: BORDER,
  left: BORDER,
  right: BORDER,
};

export async function buildRouteSheetExcel(sheet: RouteSheet, truckFilter?: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'RouteIQ';
  wb.created = new Date();

  const distLabel = kmLabel(sheet.run.distanceIsEstimated);

  if (truckFilter) {
    const t = sheet.routes.find((r) => r.truckId === truckFilter || r.truckCode === truckFilter);
    if (t) {
      addTruckSheet(wb, sheet, t, distLabel);
    }
  } else {
    addSummarySheet(wb, sheet, distLabel);
    for (const t of sheet.routes) addTruckSheet(wb, sheet, t, distLabel);
    addUnservedSheet(wb, sheet);
    if (sheet.baselineComparison) addBaselineSheet(wb, sheet, distLabel);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function addSummarySheet(wb: ExcelJS.Workbook, s: RouteSheet, distLabel: string): void {
  const ws = wb.addWorksheet('Summary', { properties: { defaultRowHeight: 18 } });
  ws.columns = [
    { width: 4 },
    { width: 22 },
    { width: 60 },
  ];

  ws.mergeCells('A1:C1');
  const title = ws.getCell('A1');
  title.value = `${s.tenant.name} — Route plan ${s.run.runDate}`;
  title.font = { size: 16, bold: true };
  title.alignment = { vertical: 'middle', horizontal: 'left' };
  ws.getRow(1).height = 26;

  let row = 3;
  const meta: Array<[string, string]> = [
    ['Depot', `${s.run.depotCode} — ${s.run.depotName}`],
    ['Mode', s.run.optimizationMode],
    ['Status', s.run.status + (s.run.finalizedAt ? ` (finalized ${new Date(s.run.finalizedAt).toLocaleString()})` : '')],
    ['Scenario', s.run.chosenScenarioName ?? '—'],
    ['Distance provider', `${s.run.distanceProvider}${s.run.distanceIsEstimated ? ' (estimated)' : ''}`],
  ];
  for (const [k, v] of meta) {
    ws.getCell(`B${row}`).value = k;
    ws.getCell(`B${row}`).font = { bold: true };
    ws.getCell(`C${row}`).value = v;
    row++;
  }

  row += 2;
  const fleetHeader = ws.getRow(row);
  fleetHeader.values = ['', 'Truck', 'Stops', 'Cases', 'Weight kg', distLabel, 'Last arrival', 'Util %'];
  fleetHeader.font = HEADER_FONT;
  fleetHeader.eachCell((cell, col) => {
    if (col === 1) return;
    cell.fill = HEADER_FILL;
    cell.border = ALL_BORDERS;
    cell.alignment = { horizontal: col >= 3 ? 'right' : 'left' };
  });
  ws.getRow(row).height = 22;
  row++;

  for (const t of s.routes) {
    const r = ws.getRow(row);
    r.values = [
      '',
      t.truckCode,
      t.stops.length,
      t.totalCases,
      Math.round(t.totalWeightKg * 10) / 10,
      Math.round(t.totalDistanceKm * 100) / 100,
      fmtArrival(t.finalArrivalMin),
      t.utilizationPct,
    ];
    r.eachCell((cell, col) => {
      if (col === 1) return;
      cell.border = ALL_BORDERS;
      cell.alignment = { horizontal: col >= 3 ? 'right' : 'left' };
    });
    row++;
  }

  // Totals row
  const totalsRow = ws.getRow(row);
  totalsRow.values = [
    '',
    `Total (${s.totals.trucks} trucks)`,
    s.totals.stops,
    s.totals.cases,
    Math.round(s.totals.weightKg * 10) / 10,
    Math.round(s.totals.distanceKm * 100) / 100,
    '',
    '',
  ];
  totalsRow.font = { bold: true };
  totalsRow.eachCell((cell, col) => {
    if (col === 1) return;
    cell.fill = SUBHEADER_FILL;
    cell.border = ALL_BORDERS;
    cell.alignment = { horizontal: col >= 3 ? 'right' : 'left' };
  });

  if (s.unserved.length > 0) {
    row += 2;
    ws.getCell(`B${row}`).value = `${s.unserved.length} unserved orders — see "Unserved" sheet.`;
    ws.getCell(`B${row}`).font = { italic: true, color: { argb: 'FFB91C1C' } };
  }
}

function addTruckSheet(wb: ExcelJS.Workbook, s: RouteSheet, t: RouteSheet['routes'][number], distLabel: string): void {
  const sheetName = `Truck ${t.truckCode}`.slice(0, 31); // Excel sheet name 31-char limit
  const ws = wb.addWorksheet(sheetName, { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true } });
  ws.columns = [
    { width: 4 }, // seq
    { width: 18 }, // customer code
    { width: 32 }, // customer name
    { width: 40 }, // address
    { width: 10 }, // cases
    { width: 12 }, // weight kg
    { width: 14 }, // arrival
    { width: 14 }, // dist from prev
    { width: 18 }, // signature
    { width: 28 }, // notes
  ];

  // Header
  ws.mergeCells('A1:J1');
  const title = ws.getCell('A1');
  title.value = `Route sheet — Truck ${t.truckCode}${t.truckDescription ? ` (${t.truckDescription})` : ''}`;
  title.font = { size: 14, bold: true };
  ws.getRow(1).height = 22;

  ws.mergeCells('A2:J2');
  const sub = ws.getCell('A2');
  sub.value = `${s.tenant.name} · ${s.run.depotCode} (${s.run.depotName}) · ${s.run.runDate}`;
  sub.alignment = { horizontal: 'left' };

  ws.mergeCells('A3:J3');
  const totals = ws.getCell('A3');
  totals.value = `${t.stops.length} stops · ${t.totalCases} cases / ${t.capacityCases} cap (${t.utilizationPct}%) · ${
    Math.round(t.totalWeightKg * 10) / 10
  } kg · ${Math.round(t.totalDistanceKm * 100) / 100} ${distLabel.toLowerCase()} · last arrival ${fmtArrival(
    t.finalArrivalMin,
  )}`;
  totals.alignment = { horizontal: 'left' };
  totals.font = { color: { argb: 'FF64748B' } }; // slate-500

  const headerRow = ws.getRow(5);
  headerRow.values = ['#', 'Code', 'Customer', 'Address', 'Cases', 'Weight kg', 'Arrival', `${distLabel} prev`, 'Signature', 'Notes'];
  headerRow.font = HEADER_FONT;
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.border = ALL_BORDERS;
    cell.alignment = { vertical: 'middle' };
  });
  headerRow.height = 22;

  let row = 6;
  for (const st of t.stops) {
    const r = ws.getRow(row);
    r.values = [
      st.sequence,
      `${st.customerCode}${st.branchKey !== '__MAIN__' ? ` / ${st.branchKey}` : ''}`,
      st.customerName + (st.locked ? ' (locked)' : ''),
      st.address ?? '',
      st.cases,
      Math.round(st.weightKg * 10) / 10,
      fmtArrival(st.plannedArrivalMin),
      Math.round(st.plannedDistanceFromPrevKm * 100) / 100,
      '',
      st.notes ?? '',
    ];
    r.eachCell((cell, col) => {
      cell.border = ALL_BORDERS;
      if (col === 5 || col === 6 || col === 8) cell.alignment = { horizontal: 'right' };
    });
    if (st.locked) r.font = { italic: true };
    row++;
  }

  // Footer totals
  const footer = ws.getRow(row);
  footer.values = ['', '', 'Totals', '', t.totalCases, Math.round(t.totalWeightKg * 10) / 10, '', Math.round(t.totalDistanceKm * 100) / 100, '', ''];
  footer.font = { bold: true };
  footer.eachCell((cell, col) => {
    cell.fill = SUBHEADER_FILL;
    cell.border = ALL_BORDERS;
    if (col === 5 || col === 6 || col === 8) cell.alignment = { horizontal: 'right' };
  });
}

function addUnservedSheet(wb: ExcelJS.Workbook, s: RouteSheet): void {
  const ws = wb.addWorksheet('Unserved');
  ws.columns = [
    { width: 18 },
    { width: 32 },
    { width: 10 },
    { width: 26 },
    { width: 50 },
  ];

  ws.mergeCells('A1:E1');
  const title = ws.getCell('A1');
  title.value = `Unserved orders — ${s.unserved.length} total`;
  title.font = { size: 14, bold: true };
  ws.getRow(1).height = 22;

  const headerRow = ws.getRow(3);
  headerRow.values = ['Code', 'Customer', 'Cases', 'Reason', 'Detail'];
  headerRow.font = HEADER_FONT;
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.border = ALL_BORDERS;
  });

  s.unserved.forEach((u, idx) => {
    const r = ws.getRow(4 + idx);
    r.values = [
      `${u.customerCode}${u.branchKey !== '__MAIN__' ? ` / ${u.branchKey}` : ''}`,
      u.customerName,
      u.cases,
      u.reasonCode,
      u.reasonMessage ?? '',
    ];
    r.eachCell((cell) => {
      cell.border = ALL_BORDERS;
    });
  });

  if (s.unserved.length === 0) {
    ws.getCell('A4').value = 'No unserved orders.';
    ws.getCell('A4').font = { italic: true, color: { argb: 'FF16A34A' } };
  }
}

function addBaselineSheet(wb: ExcelJS.Workbook, s: RouteSheet, distLabel: string): void {
  const c = s.baselineComparison!;
  const ws = wb.addWorksheet('Baseline');
  ws.columns = [{ width: 24 }, { width: 18 }];

  ws.getCell('A1').value = 'Manual baseline comparison';
  ws.getCell('A1').font = { size: 14, bold: true };

  ws.getCell('A2').value = `File: ${c.baselineFileName ?? '—'}`;

  const rows: Array<[string, string]> = [
    ['', ''],
    ['Trucks delta', c.truckDelta === null ? '—' : `${c.truckDelta > 0 ? '+' : ''}${c.truckDelta}${c.truckPct !== null ? ` (${c.truckPct.toFixed(1)}%)` : ''}`],
    [`${distLabel} delta`, c.distanceDelta === null ? '—' : `${c.distanceDelta > 0 ? '+' : ''}${Math.round(c.distanceDelta * 100) / 100}${c.distancePct !== null ? ` (${c.distancePct.toFixed(1)}%)` : ''}`],
  ];
  rows.forEach(([k, v], i) => {
    ws.getCell(`A${4 + i}`).value = k;
    ws.getCell(`A${4 + i}`).font = { bold: true };
    ws.getCell(`B${4 + i}`).value = v;
  });
}
