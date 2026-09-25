/**
 * NMWC master dispatch workbook (Excel) for ONE plan version.
 *
 * Built only from PlanDetail - the same object the plan screen renders - so the numbers on
 * screen and on paper are identical. Pure (no DB): the export route loads the detail.
 *
 * Sheet order: SUMMARY, LOAD PLAN, one sheet per load ("T01 - L1"), SKU LOADING SUMMARY,
 * UNSERVED - EXCEPTIONS, RECONCILIATION, ASSUMPTIONS. Plain and printable on purpose: the
 * load sheets go to the warehouse and the drivers.
 */
import ExcelJS from 'exceljs';
import type { DetailLoad, PlanDetail } from './plan-detail';
import { DEFAULT_TZ, fmtHhmm, localDateIso, localMinutes } from './time';

export interface WorkbookMeta {
  tenantName: string;
  currency: string;
  generatedAt: Date;
  generatedBy: string;
  assumptions: Record<string, string>;
  /** Timezone for the "generated at" stamp; defaults to Asia/Muscat. */
  timezone?: string;
}

export const SHEETS = {
  summary: 'SUMMARY',
  loadPlan: 'LOAD PLAN',
  skuSummary: 'SKU LOADING SUMMARY',
  unserved: 'UNSERVED - EXCEPTIONS',
  reconciliation: 'RECONCILIATION',
  assumptions: 'ASSUMPTIONS',
} as const;

export const FIXED_NOTES = [
  'Distances are road distances from OSRM unless a column or figure is labelled "Estimated km" (straight-line distance x multiplier).',
  'This is an OPTIMIZED plan from a heuristic, time-limited solver - a good plan, not a proven optimum.',
  'Priorities: P1 = HIGHEST, P5 = LOWEST.',
  'Hard delivery windows are enforced. Preferred windows are soft: they carry a penalty and may be missed.',
  'Fuel litres = km / truck km-per-litre; fuel cost = litres x fuel price. Fuel is counted once in operating cost (not also inside the per-km cost).',
  'Every uploaded order is either on a load or listed as unserved with a reason; cases reconcile exactly (uploaded = planned + unserved) per SKU and per sales order.',
];

// ----------------------------------------------------------------------------------------
// Formatting
// ----------------------------------------------------------------------------------------

const FMT_KM = '0.0';
const FMT_MONEY = '0.000';
const FMT_KG = '#,##0.0';
const FMT_INT = '#,##0';
const FMT_PCT = '0.0';

const THIN: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FFBFBFBF' } };
const BOX: Partial<ExcelJS.Borders> = { top: THIN, bottom: THIN, left: THIN, right: THIN };
// Light grey only - prints cleanly on a black-and-white warehouse printer.
const HEAD_FILL: ExcelJS.FillPattern = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };
const GREY: Partial<ExcelJS.Font> = { color: { argb: 'FF595959' } };

const LANDSCAPE: Partial<ExcelJS.PageSetup> = {
  paperSize: 9, // A4
  orientation: 'landscape',
  fitToPage: true,
  fitToWidth: 1,
  fitToHeight: 0, // as many pages tall as needed
  margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.5, header: 0.2, footer: 0.2 },
};
const PORTRAIT: Partial<ExcelJS.PageSetup> = { ...LANDSCAPE, orientation: 'portrait' };

/** 205 -> "3:25" (a duration, not a clock time). */
export function fmtDuration(min: number | null | undefined): string {
  if (min === null || min === undefined || Number.isNaN(min)) return '—';
  const m = Math.max(0, Math.round(min));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** "T01-L1" - the short load label used in matrix headers. */
export function loadLabel(l: Pick<DetailLoad, 'truckCode' | 'loadNo'>): string {
  return `${l.truckCode}-L${l.loadNo}`;
}

/**
 * Excel sheet name for a load: "<truck> - L<n>", max 31 chars, none of []:*?/\ , no leading or
 * trailing apostrophe, unique case-insensitively within `used` (which it updates).
 */
export function loadSheetName(truckCode: string, loadNo: number, used: Set<string>): string {
  const suffix = ` - L${loadNo}`;
  let base = truckCode.replace(/[[\]:*?/\\]/g, '-').replace(/\s+/g, ' ').trim().replace(/^'+/, '');
  if (!base) base = 'Truck';
  const make = (tag: string) => `${base.slice(0, Math.max(1, 31 - suffix.length - tag.length)).trimEnd()}${suffix}${tag}`;
  let name = make('');
  for (let n = 2; used.has(name.toLowerCase()); n++) name = make(` (${n})`);
  used.add(name.toLowerCase());
  return name;
}

const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const skuText = (skus: { productCode: string; cases: number }[]) => skus.map((k) => `${k.productCode} x${k.cases}`).join('; ');
// Excel header/footer codes start with "&" - a literal ampersand must be doubled.
const hfSafe = (s: string) => s.replace(/&/g, '&&');

function put(ws: ExcelJS.Worksheet, row: number, col: number, value: ExcelJS.CellValue, fmt?: string): ExcelJS.Cell {
  const c = ws.getCell(row, col);
  c.value = value;
  if (fmt && typeof value === 'number') c.numFmt = fmt;
  return c;
}

function headRow(ws: ExcelJS.Worksheet, row: number, labels: string[], startCol = 1) {
  labels.forEach((t, i) => {
    const c = put(ws, row, startCol + i, t);
    c.font = { bold: true };
    c.fill = HEAD_FILL;
    c.border = BOX;
    c.alignment = { vertical: 'middle', wrapText: true };
  });
}

function tableRow(ws: ExcelJS.Worksheet, row: number, values: ExcelJS.CellValue[], fmts: (string | undefined)[] = [], startCol = 1) {
  values.forEach((v, i) => {
    const c = put(ws, row, startCol + i, v, fmts[i]);
    c.border = BOX;
    c.alignment = { vertical: 'top', wrapText: true };
  });
}

function totalRow(ws: ExcelJS.Worksheet, row: number, values: ExcelJS.CellValue[], fmts: (string | undefined)[] = [], startCol = 1) {
  tableRow(ws, row, values, fmts, startCol);
  values.forEach((_, i) => {
    const c = ws.getCell(row, startCol + i);
    c.font = { bold: true };
    c.border = { ...BOX, top: { style: 'medium', color: { argb: 'FF404040' } } };
  });
}

function titleRows(ws: ExcelJS.Worksheet, title: string, subtitle: string) {
  put(ws, 1, 1, title).font = { bold: true, size: 14 };
  put(ws, 2, 1, subtitle).font = GREY;
}

function section(ws: ExcelJS.Worksheet, row: number, text: string) {
  put(ws, row, 1, text).font = { bold: true, size: 12 };
}

// ----------------------------------------------------------------------------------------
// Cross-checks: the workbook itself must agree with the stored reconciliation
// ----------------------------------------------------------------------------------------

interface ReconView {
  status: 'OK' | 'FAILED' | 'NOT AVAILABLE';
  problems: string[];
  manifestCases: number;
  unservedSheetCases: number;
}

function reconView(d: PlanDetail): ReconView {
  const manifestCases = sum(d.loads.map((l) => sum(l.manifest.map((m) => m.cases))));
  const unservedSheetCases = sum(d.unserved.map((u) => u.cases));
  const r = d.reconciliation;
  if (!r) return { status: 'NOT AVAILABLE', problems: ['Reconciliation has not been computed for this plan version.'], manifestCases, unservedSheetCases };
  const problems = [...r.problems];
  for (const l of d.loads) {
    const m = sum(l.manifest.map((x) => x.cases));
    if (m !== l.cases) problems.push(`Load ${loadLabel(l)}: manifest totals ${m} cases but the load records ${l.cases} cases.`);
  }
  if (manifestCases !== r.plannedCases) {
    problems.push(`Load sheets carry ${manifestCases} cases but reconciliation counts ${r.plannedCases} planned cases.`);
  }
  if (unservedSheetCases !== r.unservedCases) {
    problems.push(`Unserved sheet lists ${unservedSheetCases} cases but reconciliation counts ${r.unservedCases} unserved cases.`);
  }
  return { status: r.ok && problems.length === 0 ? 'OK' : 'FAILED', problems, manifestCases, unservedSheetCases };
}

// ----------------------------------------------------------------------------------------
// Workbook
// ----------------------------------------------------------------------------------------

export async function buildDispatchWorkbook(detail: PlanDetail, meta: WorkbookMeta): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'RouteIQ';
  wb.created = meta.generatedAt;
  wb.title = `NMWC Daily Dispatch Plan ${detail.run.depot.code} ${detail.run.runDate} v${detail.run.version}`;

  // Names first: the LOAD PLAN sheet refers to each load sheet by name.
  const used = new Set<string>(Object.values(SHEETS).map((s) => s.toLowerCase()));
  const names = new Map(detail.loads.map((l) => [l.id, loadSheetName(l.truckCode, l.loadNo, used)]));
  const recon = reconView(detail);

  addSummarySheet(wb, detail, meta, recon);
  addLoadPlanSheet(wb, detail, meta, names);
  for (const l of detail.loads) addLoadSheet(wb, detail, meta, l, names.get(l.id)!);
  addSkuSummarySheet(wb, detail);
  addUnservedSheet(wb, detail);
  addReconciliationSheet(wb, detail, recon);
  addAssumptionsSheet(wb, detail, meta);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function addSummarySheet(wb: ExcelJS.Workbook, d: PlanDetail, m: WorkbookMeta, recon: ReconView) {
  const ws = wb.addWorksheet(SHEETS.summary, { views: [{ state: 'frozen', ySplit: 2 }], pageSetup: PORTRAIT });
  ws.columns = [{ width: 40 }, { width: 24 }, { width: 80 }];
  put(ws, 1, 1, 'NMWC Daily Dispatch Plan').font = { bold: true, size: 16 };
  put(ws, 2, 1, `${m.tenantName} · Depot ${d.run.depot.code} · Delivery ${d.run.runDate} · Plan v${d.run.version}`).font = GREY;

  let r = 3;
  if (d.run.status === 'SUPERSEDED' || d.run.supersededAt) {
    put(ws, r, 1, 'SUPERSEDED - a newer plan version exists. Do not load or dispatch from this workbook.').font = { bold: true, size: 12 };
  }
  r++;
  const cur = m.currency;
  const kv = (label: string, value: ExcelJS.CellValue, fmt?: string, note?: string) => {
    put(ws, r, 1, label).font = { bold: true };
    const c = put(ws, r, 2, value, fmt);
    c.alignment = { horizontal: 'left' };
    if (note) put(ws, r, 3, note).font = GREY;
    r++;
  };
  const head = (text: string) => {
    r++;
    section(ws, r, text);
    ws.getCell(r, 1).border = { bottom: THIN };
    r++;
  };

  head('PLAN');
  kv('Depot', `${d.run.depot.code} - ${d.run.depot.name}`);
  kv('Delivery date', d.run.runDate);
  kv('Plan version', `v${d.run.version}`, undefined, d.change ? `re-plan of v${d.change.parentVersion}` : undefined);
  kv('Plan status', d.run.status);
  kv('Plan reason', d.run.reason, undefined, d.run.reasonNote ?? undefined);
  kv('Scenario', d.run.chosenScenario ?? '—');
  const tz = m.timezone || DEFAULT_TZ;
  kv('Generated at', `${localDateIso(m.generatedAt, tz)} ${fmtHhmm(localMinutes(m.generatedAt, tz))}`, undefined, tz);
  kv('Generated by', m.generatedBy);

  const s = d.summary;
  head('DAILY SUMMARY');
  if (!s) {
    kv('Daily summary', 'not available', undefined, 'The plan has no computed summary yet (no scenario applied).');
  } else {
    const reasons = Object.entries(s.unservedByReason)
      .map(([k, v]) => `${k} x${v}`)
      .join('; ');
    kv('Total orders', s.totalOrders, FMT_INT);
    kv('Customers', s.totalCustomers, FMT_INT);
    kv('Total cases', s.totalCases, FMT_INT);
    kv('Total weight (kg)', s.totalWeightKg, FMT_KG);
    kv('Orders served', s.ordersServed, FMT_INT, `${s.casesServed} cases`);
    if (s.ordersPartial) kv('Orders part served (split)', s.ordersPartial, FMT_INT, 'bigger than one truck: some parts planned, the rest unserved');
    kv('Orders unserved', s.ordersUnserved, FMT_INT, `${s.casesUnserved} cases${s.ordersPartial ? ' (incl. rest of split orders)' : ''}${reasons ? ` - ${reasons}` : ''}`);
    for (let p = 1; p <= 5; p++) {
      const x = s.serviceByPriority[`P${p}`];
      if (!x || x.orders === 0) kv(`P${p} service %`, '—', undefined, 'no orders');
      else kv(`P${p} service %`, x.pct ?? 0, FMT_PCT, `${x.served} of ${x.orders} orders served`);
    }
    kv('Physical trucks used', s.trucksUsed, FMT_INT);
    kv('Total trips (loads)', s.trips, FMT_INT);
    kv(
      s.distanceIsEstimated ? 'Estimated km' : 'Total road km',
      s.totalKm,
      FMT_KM,
      s.distanceIsEstimated ? `ESTIMATED (${s.distanceProvider}) - not road distances` : `road distances (${s.distanceProvider})`,
    );
    kv('Planned hours', s.totalHours, FMT_KM);
    kv('Average utilization %', s.avgUtilizationPct, FMT_PCT);
    kv('Estimated fuel (litres)', s.fuelLitres ?? 'not calculated', FMT_KM, s.fuelLitres === null ? 'trucks have no km-per-litre' : undefined);
    kv(`Fuel cost (${cur})`, s.fuelCost, FMT_MONEY);
    kv(`Operating cost (${cur})`, s.operatingCost, FMT_MONEY, 'fixed + distance + fuel + driver time');
    kv(`Revenue served (${cur})`, s.revenueServed ?? 'not supplied', FMT_MONEY, s.revenueServed === null ? 'sales value missing on one or more orders' : undefined);
    kv(
      `Contribution margin served (${cur})`,
      s.marginServed ?? 'not supplied',
      FMT_MONEY,
      s.marginServed === null ? 'margin missing on one or more orders - no profit figure is claimed' : 'sum of supplied order margins on served orders; delivery cost not deducted',
    );
    kv('Late orders (served / total)', `${s.lateOrdersServed} / ${s.lateOrders}`);
    const byStatus = Object.entries(s.loadsByStatus)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    kv('Loads by status', byStatus || '—');
    if (s.solver) kv('Solver', `${s.solver.engine} · ${s.solver.scenario} · ${s.solver.status}`, undefined, `${s.solver.timeSec}s`);
  }

  head('RECONCILIATION');
  const rc = d.reconciliation;
  kv('Status', recon.status, undefined, rc ? `uploaded ${rc.uploadedCases} = planned ${rc.plannedCases} + unserved ${rc.unservedCases} cases` : undefined);
  for (const p of recon.status === 'OK' ? [] : recon.problems) {
    put(ws, r, 3, p);
    r++;
  }

  head('WARNINGS');
  const warnings = uniq([...(s?.warnings ?? []), ...d.warnings]);
  if (!warnings.length) kv('Warnings', 'None');
  for (const w of warnings) {
    put(ws, r, 1, '•');
    put(ws, r, 2, w);
    r++;
  }

  if (d.change?.text) {
    head('CHANGES VS PREVIOUS VERSION');
    kv(`Since v${d.change.parentVersion}`, d.change.text);
  }
}

function addLoadPlanSheet(wb: ExcelJS.Workbook, d: PlanDetail, m: WorkbookMeta, names: Map<string, string>) {
  const ws = wb.addWorksheet(SHEETS.loadPlan, { views: [{ state: 'frozen', ySplit: 4 }], pageSetup: LANDSCAPE });
  const est = d.loads.some((l) => l.distanceIsEstimated) || !!d.summary?.distanceIsEstimated;
  const cur = m.currency;
  const heads = [
    'Truck', 'Load', 'Status', 'Driver', 'Departure', 'Return', 'Stops (customers)', 'Cases', 'Capacity (cases)', 'Weight kg',
    'Utilization %', est ? 'Estimated km' : 'Route km', 'Est. time (h:mm)', 'Est. fuel (l)', `Fuel cost (${cur})`, `Operating cost (${cur})`, 'Sheet',
  ];
  const fmts = [undefined, FMT_INT, undefined, undefined, undefined, undefined, FMT_INT, FMT_INT, FMT_INT, FMT_KG, FMT_PCT, FMT_KM, undefined, FMT_KM, FMT_MONEY, FMT_MONEY];
  ws.columns = [12, 6, 16, 20, 10, 10, 10, 9, 10, 11, 11, 11, 10, 10, 12, 14, 22].map((width) => ({ width }));
  titleRows(ws, 'LOAD PLAN', `Depot ${d.run.depot.code} · Delivery ${d.run.runDate} · Plan v${d.run.version} (${d.run.status})${est ? ' · km are ESTIMATED' : ''}`);
  ws.pageSetup.printTitlesRow = '4:4';
  headRow(ws, 4, heads);
  let r = 5;
  if (!d.loads.length) {
    put(ws, r, 1, 'No loads in this plan version.').font = { italic: true };
    return;
  }
  for (const l of d.loads) {
    tableRow(
      ws,
      r++,
      [
        l.truckCode, l.loadNo, l.status + (l.carried ? ' (kept from previous version)' : ''), l.driverName ?? 'Not assigned',
        fmtHhmm(l.departMin), fmtHhmm(l.returnMin), l.stops.length, l.cases, l.truckCapacityCases, l.weightKg, l.utilizationPct,
        l.distanceKm, fmtDuration(l.durationMin), l.fuelLitres, l.fuelCost, l.operatingCost, names.get(l.id) ?? '',
      ],
      fmts,
    );
  }
  const fuelKnown = d.loads.some((l) => l.fuelLitres !== null);
  totalRow(
    ws,
    r,
    [
      'TOTAL', `${d.loads.length} loads`, `${new Set(d.loads.map((l) => l.truckId)).size} trucks`, '', '', '',
      sum(d.loads.map((l) => l.stops.length)), sum(d.loads.map((l) => l.cases)), '', sum(d.loads.map((l) => l.weightKg)), '',
      sum(d.loads.map((l) => l.distanceKm)), fmtDuration(sum(d.loads.map((l) => l.durationMin))),
      fuelKnown ? sum(d.loads.map((l) => l.fuelLitres ?? 0)) : null, sum(d.loads.map((l) => l.fuelCost)), sum(d.loads.map((l) => l.operatingCost)), '',
    ],
    fmts,
  );
}

// Delivery-route table columns (1-based), shared by the header block and the route rows.
const ROUTE_HEADS = [
  'Seq', 'Customer code', 'Branch', 'Customer name', 'Priority', 'Type', 'ETA', 'Service start', 'Window', 'Service min',
  'Cases', 'Kg', 'SKUs', 'Sales orders', 'Km from prev', 'Cumulative km', 'Map', 'Notes', 'Received by (sign)',
];
const ROUTE_WIDTHS = [5, 13, 10, 30, 8, 12, 8, 9, 24, 8, 8, 10, 44, 20, 9, 10, 8, 24, 18];

function addLoadSheet(wb: ExcelJS.Workbook, d: PlanDetail, m: WorkbookMeta, l: DetailLoad, name: string) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 2 }], pageSetup: { ...LANDSCAPE } });
  ws.columns = ROUTE_WIDTHS.map((width) => ({ width }));
  const kmWord = l.distanceIsEstimated ? 'Estimated km' : 'Route km';
  titleRows(
    ws,
    `Truck ${l.truckCode} - Load ${l.loadNo}`,
    `${m.tenantName} · NMWC Daily Dispatch Plan · Depot ${d.run.depot.code} - ${d.run.depot.name} · Delivery ${d.run.runDate} · Plan v${d.run.version} (${d.run.status})`,
  );

  // Header block: two label/value groups side by side (labels overflow into the empty cells).
  const left: [string, ExcelJS.CellValue, string?][] = [
    ['Truck', l.truckCode],
    ['Load no', l.loadNo, FMT_INT],
    ['Driver', l.driverName ?? 'Not assigned'],
    ['Departure', fmtHhmm(l.departMin)],
    ['Return', fmtHhmm(l.returnMin)],
    ['Status', l.status + (l.carried ? ' (kept from previous version)' : '')],
  ];
  const right: [string, ExcelJS.CellValue, string?][] = [
    ['Cases / capacity', `${l.cases} / ${l.truckCapacityCases}`],
    ['Weight / payload kg', `${Math.round(l.weightKg * 10) / 10} / ${l.truckPayloadKg}`],
    ['Utilization %', l.utilizationPct, FMT_PCT],
    [kmWord, l.distanceKm, FMT_KM],
    ['Estimated time (h:mm)', fmtDuration(l.durationMin)],
    ['Stops', l.stops.length, FMT_INT],
  ];
  left.forEach(([k, v, f], i) => {
    put(ws, 4 + i, 1, k).font = { bold: true };
    put(ws, 4 + i, 4, v, f).alignment = { horizontal: 'left' };
  });
  right.forEach(([k, v, f], i) => {
    put(ws, 4 + i, 6, k).font = { bold: true };
    put(ws, 4 + i, 9, v, f).alignment = { horizontal: 'left' };
  });

  // LOADING MANIFEST - what the warehouse puts on the truck.
  let r = 11;
  section(ws, r, 'LOADING MANIFEST');
  put(ws, r, 4, 'Load exactly these cases; tick each line when loaded.').font = GREY;
  r++;
  headRow(ws, r, ['#', 'SKU code', 'Description', '', 'Cases', 'Kg', 'Loaded']);
  ws.mergeCells(r, 3, r, 4);
  r++;
  l.manifest.forEach((x, i) => {
    tableRow(ws, r, [i + 1, x.productCode, x.productName, '', x.cases, x.weightKg, ''], [FMT_INT, undefined, undefined, undefined, FMT_INT, FMT_KG]);
    ws.mergeCells(r, 3, r, 4);
    r++;
  });
  const manifestCases = sum(l.manifest.map((x) => x.cases));
  totalRow(
    ws,
    r,
    ['', 'TOTAL', `${l.manifest.length} SKUs`, '', manifestCases, sum(l.manifest.map((x) => x.weightKg)), ''],
    [undefined, undefined, undefined, undefined, FMT_INT, FMT_KG],
  );
  ws.mergeCells(r, 3, r, 4);
  if (manifestCases !== l.cases) put(ws, r, 8, `MISMATCH: load records ${l.cases} cases`).font = { bold: true };
  r += 2;

  // DELIVERY ROUTE - driver's sequence.
  section(ws, r, 'DELIVERY ROUTE');
  if (l.distanceIsEstimated) put(ws, r, 4, 'km are ESTIMATED (not road distances)').font = GREY;
  r++;
  const heads = ROUTE_HEADS.map((h) => (h === 'Km from prev' || h === 'Cumulative km') && l.distanceIsEstimated ? `${h} (est.)` : h);
  headRow(ws, r, heads);
  ws.pageSetup.printTitlesRow = `${r}:${r}`;
  r++;
  const depot = d.run.depot;
  const depotMap = `https://www.google.com/maps/search/?api=1&query=${depot.lat},${depot.lng}`;
  const fmts = [FMT_INT, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, FMT_INT, FMT_INT, FMT_KG, undefined, undefined, FMT_KM, FMT_KM];
  tableRow(
    ws,
    r++,
    ['', 'DEPOT', '', `${depot.code} - ${depot.name} (depart)`, '', '', fmtHhmm(l.departMin), '', '', null, null, null, '', '', null, 0,
      { text: 'Map', hyperlink: depotMap }, `Departure ${fmtHhmm(l.departMin)}`, ''],
    fmts,
  );
  let running = 0;
  for (const s of l.stops) {
    running += s.legKm;
    const notes = [
      s.late ? 'LATE ORDER' : null,
      s.split ? `SPLIT DELIVERY part ${s.split.part} of ${s.split.parts}${s.split.restUnserved ? ' (rest unserved)' : ''}` : null,
      s.hardWindowOk === false ? 'HARD WINDOW MISSED' : null,
      s.prefWindowOk === false ? 'Outside preferred window' : null,
      s.waitMin ? `Wait ${Math.round(s.waitMin)} min` : null,
      s.mapsUrl ? null : 'No coordinates',
    ].filter(Boolean);
    tableRow(
      ws,
      r++,
      [
        s.sequence, s.customerCode, s.branchCode ?? '', s.customerName, `P${s.priority}`, s.customerType ?? '', fmtHhmm(s.etaMin),
        fmtHhmm(s.serviceStartMin), s.window, s.serviceMin, s.cases, s.weightKg, skuText(s.skus), uniq(s.salesOrders).join(', '),
        s.legKm, s.cumulativeKm ?? running, s.mapsUrl ? { text: 'Map', hyperlink: s.mapsUrl } : '', notes.join('; '), '',
      ],
      fmts,
    );
  }
  tableRow(
    ws,
    r++,
    ['', 'DEPOT', '', `${depot.code} - ${depot.name} (return)`, '', '', fmtHhmm(l.returnMin), '', '', null, null, null, '', '',
      l.returnLegKm, l.distanceKm, { text: 'Map', hyperlink: depotMap }, `Back at depot ${fmtHhmm(l.returnMin)} · return leg ${l.returnLegKm.toFixed(1)} km`, ''],
    fmts,
  );
  const stopCases = sum(l.stops.map((s) => s.cases));
  totalRow(
    ws,
    r,
    ['', 'TOTAL', '', `${l.stops.length} stops`, '', '', '', '', '', '', stopCases, sum(l.stops.map((s) => s.weightKg)), '', '', '', l.distanceKm, '',
      stopCases !== l.cases ? `MISMATCH: load records ${l.cases} cases` : `Total time ${fmtDuration(l.durationMin)}`, ''],
    fmts,
  );
  r += 3;

  // Sign-off: the physical load leaves the depot only against signatures.
  const sig = [
    [1, 'Loaded by (name / sign): ______________________'],
    [6, 'Driver (name / sign): ______________________'],
    [11, 'Time out: __________'],
    [16, 'Time back: __________'],
  ] as const;
  for (const [col, text] of sig) put(ws, r, col, text).font = { bold: true };
  ws.getRow(r).height = 28;
  ws.headerFooter.oddFooter = `&L${hfSafe(`${name} · ${d.run.runDate} · v${d.run.version}`)}&RPage &P of &N`;
}

function addSkuSummarySheet(wb: ExcelJS.Workbook, d: PlanDetail) {
  const nLoads = d.loads.length;
  const ws = wb.addWorksheet(SHEETS.skuSummary, { views: [{ state: 'frozen', ySplit: 4, xSplit: 2 }], pageSetup: LANDSCAPE });
  ws.columns = [{ width: 16 }, { width: 34 }, ...d.loads.map(() => ({ width: 11 })), { width: 12 }, { width: 12 }];
  titleRows(ws, 'SKU LOADING SUMMARY', `Cases per SKU per load · Depot ${d.run.depot.code} · Delivery ${d.run.runDate} · Plan v${d.run.version}`);
  headRow(ws, 4, ['SKU code', 'Description', ...d.loads.map(loadLabel), 'Total cases', 'Total kg']);
  ws.pageSetup.printTitlesRow = '4:4';

  const skus = new Map<string, { name: string; perLoad: number[]; kg: number }>();
  d.loads.forEach((l, i) => {
    for (const x of l.manifest) {
      const e = skus.get(x.productCode) ?? { name: x.productName, perLoad: new Array<number>(nLoads).fill(0), kg: 0 };
      e.perLoad[i] += x.cases;
      e.kg += x.weightKg;
      skus.set(x.productCode, e);
    }
  });
  const intFmts = [undefined, undefined, ...d.loads.map(() => FMT_INT), FMT_INT, FMT_KG];
  let r = 5;
  for (const [code, e] of [...skus.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Blank instead of 0 keeps the matrix readable for pickers.
    tableRow(ws, r++, [code, e.name, ...e.perLoad.map((v) => (v ? v : null)), sum(e.perLoad), e.kg], intFmts);
  }
  const perLoad = d.loads.map((l) => sum(l.manifest.map((x) => x.cases)));
  totalRow(ws, r++, ['TOTAL', `${skus.size} SKUs`, ...perLoad, sum(perLoad), sum([...skus.values()].map((e) => e.kg))], intFmts);
  tableRow(ws, r++, ['Load cases (plan)', 'from the load record', ...d.loads.map((l) => l.cases), sum(d.loads.map((l) => l.cases)), null], intFmts);
  tableRow(ws, r, ['Check', '', ...d.loads.map((l, i) => (perLoad[i] === l.cases ? 'OK' : 'MISMATCH')), sum(perLoad) === sum(d.loads.map((l) => l.cases)) ? 'OK' : 'MISMATCH', '']);
}

function addUnservedSheet(wb: ExcelJS.Workbook, d: PlanDetail) {
  const ws = wb.addWorksheet(SHEETS.unserved, { views: [{ state: 'frozen', ySplit: 4 }], pageSetup: LANDSCAPE });
  ws.columns = [14, 10, 30, 8, 8, 10, 22, 8, 28, 60].map((width) => ({ width }));
  const orders = new Set(d.unserved.map((u) => u.orderId)).size;
  titleRows(ws, `UNSERVED - EXCEPTIONS (${orders})`, 'Orders (or parts of split orders) NOT on any truck, with the reason. These cases are not loaded.');
  headRow(ws, 4, ['Customer code', 'Branch', 'Customer name', 'Priority', 'Cases', 'Kg', 'Sales orders', 'Late order', 'Reason code', 'Reason']);
  ws.pageSetup.printTitlesRow = '4:4';
  if (!d.unserved.length) {
    put(ws, 5, 1, 'All orders planned').font = { bold: true };
    return;
  }
  const fmts = [undefined, undefined, undefined, undefined, FMT_INT, FMT_KG];
  let r = 5;
  for (const u of d.unserved) {
    tableRow(
      ws,
      r++,
      [u.customerCode, u.branchCode ?? '', u.customerName, `P${u.priority}`, u.cases, u.weightKg, uniq(u.salesOrders).join(', '), u.late ? 'LATE' : '', u.reasonCode, `${u.partial ? 'Rest of a split delivery (the other part is on a truck). ' : ''}${u.reasonMessage ?? ''}`],
      fmts,
    );
  }
  totalRow(ws, r, ['TOTAL', '', `${orders} order${orders === 1 ? '' : 's'}`, '', sum(d.unserved.map((u) => u.cases)), sum(d.unserved.map((u) => u.weightKg)), '', '', '', ''], fmts);
}

function addReconciliationSheet(wb: ExcelJS.Workbook, d: PlanDetail, recon: ReconView) {
  const ws = wb.addWorksheet(SHEETS.reconciliation, { views: [{ state: 'frozen', ySplit: 6 }], pageSetup: PORTRAIT });
  ws.columns = [34, 34, 11, 11, 11, 12].map((width) => ({ width }));
  titleRows(ws, 'RECONCILIATION', 'Uploaded cases = planned cases + unserved cases - in total, per SKU and per sales order.');
  const rc = d.reconciliation;
  if (!rc) {
    put(ws, 4, 1, 'Status').font = { bold: true };
    put(ws, 4, 2, 'NOT AVAILABLE');
    put(ws, 5, 1, 'Reconciliation has not been computed for this plan version.');
    return;
  }
  const f = [undefined, undefined, FMT_INT, FMT_INT, FMT_INT];
  headRow(ws, 3, ['', '', 'Uploaded', 'Planned', 'Unserved', 'Status']);
  tableRow(ws, 4, ['Cases', `${rc.uploadedCases} = ${rc.plannedCases} + ${rc.unservedCases}`, rc.uploadedCases, rc.plannedCases, rc.unservedCases,
    rc.uploadedCases === rc.plannedCases + rc.unservedCases ? 'OK' : 'MISMATCH'], f);
  // A split order with some parts planned and the rest unserved is counted in both columns.
  const partial = rc.partialOrders ?? 0;
  tableRow(ws, 5, ['Orders', `${rc.orders} = ${rc.plannedOrders} + ${rc.unservedOrders}${partial ? ` - ${partial} split (in both)` : ''}`, rc.orders, rc.plannedOrders, rc.unservedOrders,
    rc.orders === rc.plannedOrders + rc.unservedOrders - partial ? 'OK' : 'MISMATCH'], f);
  put(ws, 6, 1, 'Overall').font = { bold: true };
  put(ws, 6, 2, recon.status).font = { bold: true };

  let r = 8;
  section(ws, r++, 'CROSS-CHECK AGAINST THIS WORKBOOK');
  headRow(ws, r++, ['Check', '', 'Workbook', 'Reconciliation', '', 'Status']);
  tableRow(ws, r++, ['Cases on load sheets (manifests)', '', recon.manifestCases, rc.plannedCases, '', recon.manifestCases === rc.plannedCases ? 'OK' : 'MISMATCH'], f);
  tableRow(ws, r++, ['Cases on UNSERVED sheet', '', recon.unservedSheetCases, rc.unservedCases, '', recon.unservedSheetCases === rc.unservedCases ? 'OK' : 'MISMATCH'], f);

  r++;
  section(ws, r++, 'BY SKU');
  headRow(ws, r++, ['SKU code', 'Description', 'Uploaded', 'Planned', 'Unserved', 'Status']);
  for (const x of rc.bySku) tableRow(ws, r++, [x.key, x.label, x.uploaded, x.planned, x.unserved, x.ok ? 'OK' : 'MISMATCH'], f);

  r++;
  section(ws, r++, 'BY SALES ORDER');
  headRow(ws, r++, ['Sales order', '', 'Uploaded', 'Planned', 'Unserved', 'Status']);
  for (const x of rc.bySalesOrder) tableRow(ws, r++, [x.key, x.label === x.key ? '' : x.label, x.uploaded, x.planned, x.unserved, x.ok ? 'OK' : 'MISMATCH'], f);

  r++;
  section(ws, r++, 'PROBLEMS');
  if (!recon.problems.length) put(ws, r, 1, 'None');
  for (const p of recon.problems) put(ws, r++, 1, p);
}

function addAssumptionsSheet(wb: ExcelJS.Workbook, d: PlanDetail, m: WorkbookMeta) {
  const ws = wb.addWorksheet(SHEETS.assumptions, { views: [{ state: 'frozen', ySplit: 3 }], pageSetup: PORTRAIT });
  ws.columns = [{ width: 48 }, { width: 90 }];
  titleRows(ws, 'ASSUMPTIONS', `Settings this plan (v${d.run.version}) was built and costed with.`);
  headRow(ws, 3, ['Setting', 'Value']);
  let r = 4;
  const entries = Object.entries(m.assumptions);
  if (!entries.length) put(ws, r++, 1, 'No settings supplied.');
  for (const [k, v] of entries) tableRow(ws, r++, [k, v]);
  r++;
  section(ws, r++, 'NOTES');
  FIXED_NOTES.forEach((n, i) => {
    // Merged + wrapped so long notes stay inside the printed page.
    put(ws, r, 1, `${i + 1}. ${n}`).alignment = { wrapText: true, vertical: 'top' };
    ws.mergeCells(r, 1, r, 2);
    ws.getRow(r).height = 30;
    r++;
  });
}

// ----------------------------------------------------------------------------------------
// Assumptions from the tenant configuration (used by the export route)
// ----------------------------------------------------------------------------------------

/** The TenantConfig fields the workbook reports; a Prisma TenantConfig row satisfies it. */
export interface AssumptionConfig {
  timezone: string;
  planningCutoffMin: number;
  shiftStartMin: number;
  driverShiftMaxMinutes: number;
  reloadMinutes: number;
  loadingMinPerCase?: number;
  serviceMinPerCase?: number;
  maxTripsPerTruck: number;
  fuelPricePerLitre: number;
  driverCostPerHour: number;
  overtimeAfterMin: number;
  overtimeCostPerHour: number;
  prefWindowPenaltyPerMin: number;
  roadTimeFactor: number;
  distanceProvider: string;
  distanceMultiplier: number;
  avgSpeedKmh: number;
  defaultServiceTimeMin: number;
  osrmUrl: string | null;
  priorityWeightsJson: unknown;
}

export function tenantAssumptions(
  cfg: AssumptionConfig | null,
  opts: {
    currency: string;
    providerUsed: string | null;
    distanceIsEstimated: boolean | null;
    osrmEnvConfigured: boolean;
    /** Tenant outside the shared OSRM map (Oman + UAE) without its own OSRM: planned on straight lines. */
    outsideCoverage?: boolean;
  },
): Record<string, string> {
  if (!cfg) return { 'Tenant configuration': 'not set - system defaults were used' };
  const cur = opts.currency;
  const out: Record<string, string> = {
    Timezone: cfg.timezone,
    'Planning cutoff (day before delivery)': `${fmtHhmm(cfg.planningCutoffMin)} - orders received later are LATE`,
    'Shift start (earliest departure)': fmtHhmm(cfg.shiftStartMin),
    'Driver shift maximum (h:mm)': fmtDuration(cfg.driverShiftMaxMinutes),
    'Depot reload time between loads': `${cfg.reloadMinutes} min`,
    'Loading time per case': cfg.loadingMinPerCase ? `${cfg.loadingMinPerCase} min per case of the next load, on top of the reload time` : 'not set (0)',
    'Unloading time per case': cfg.serviceMinPerCase ? `${cfg.serviceMinPerCase} min per case delivered, on top of the service time` : 'not set (0)',
    'Max trips per truck per day': String(cfg.maxTripsPerTruck),
    'Fuel price': cfg.fuelPricePerLitre > 0 ? `${cfg.fuelPricePerLitre} ${cur} per litre` : '0 - fuel not costed separately',
    'Driver cost': `${cfg.driverCostPerHour} ${cur} per hour`,
    Overtime: cfg.overtimeCostPerHour > 0 ? `after ${fmtDuration(cfg.overtimeAfterMin)} at ${cfg.overtimeCostPerHour} ${cur} per hour` : 'not costed',
    'Preferred window penalty': `${cfg.prefWindowPenaltyPerMin} per minute outside the preferred window (soft)`,
    'Road time factor (truck vs car)': `x${cfg.roadTimeFactor}`,
    'Default service time': `${cfg.defaultServiceTimeMin} min per stop (customer / customer-type values override)`,
    Priorities: 'strict - one higher-priority order always wins over any number of lower ones (P1 > P2 > P3 > P4 > P5)',
    'Distance provider (configured)':
      cfg.distanceProvider === 'HAVERSINE'
        ? 'HAVERSINE (estimated distances)'
        : opts.outsideCoverage
          ? `${cfg.distanceProvider} configured - straight-line estimates used (outside the Oman + UAE routing map)`
          : `${cfg.distanceProvider} (the dispatch planner uses OSRM road distances)`,
    'Distance provider (this plan)': `${opts.providerUsed ?? 'unknown'}${opts.distanceIsEstimated ? ' - ESTIMATED distances' : ''}`,
    'OSRM server configured': cfg.osrmUrl ? 'yes (tenant setting)' : opts.osrmEnvConfigured ? 'yes (OSRM_URL environment)' : 'no tenant setting (the solver uses its own OSRM_URL if set)',
  };
  if (cfg.distanceProvider === 'HAVERSINE' || opts.distanceIsEstimated) {
    out['Estimated-distance multiplier'] = `x${cfg.distanceMultiplier} on straight-line distance`;
    out['Average speed for estimates'] = `${cfg.avgSpeedKmh} km/h`;
  }
  return out;
}
