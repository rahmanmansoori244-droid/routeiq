/**
 * NMWC master dispatch workbook (Excel) for ONE plan version.
 *
 * Built only from PlanDetail - the same object the plan screen renders - so the numbers on
 * screen and on paper are identical. Pure (no DB): the export route loads the detail.
 *
 * Sheet order: SUMMARY, LOAD PLAN, TRUCK DAYS, one sheet per load ("T01 - L1"), SKU LOADING
 * SUMMARY, UNSERVED - EXCEPTIONS, RECONCILIATION, ASSUMPTIONS. Plain and printable on purpose: the
 * load sheets go to the warehouse and the drivers.
 *
 * Money (review F17): every figure is the optimizer's own (lib/dispatch/costs.ts, the driver paid
 * for the whole truck day, overtime on top) - the sheets only add loads up, so their totals equal
 * the plan screen's.
 */
import ExcelJS from 'exceljs';
import type { DetailLoad, PlanDetail } from './plan-detail';
import { COST_BASIS_TEXT, costTotals, summaryCostBasis, truckDayRows } from './costs';
import { dayFuel, FUEL_INCLUDED_NOTE } from './summary';
import { breakLine, breakPlace, breakTimes } from './break-text';
import { TIMING_TEXT } from './feasibility-view';
import { DEFAULT_TZ, fmtDayMonth, fmtHhmm, localDateIso, localMinutes } from './time';
import { carriedStopText } from './carry-view';
import { KG_ROUNDING_TOL, manifestKgDiffers, manifestKgOf } from './weights';
import { invoiceCounts } from './reconcile';
import { solverStatusText } from './solver-status';
import { loadingFromAssumption, planFromAssumption, type PlanFrom } from './plan-from';
import { searchAssumptions, searchOptionOf, searchResultText, type SearchOption, type SearchReport } from './search-mode';
import { loadPallets, manifestPalletTotals, manifestTotalText, palletLimitText, palletsExact, palletsOverBays, palletText, type LoadPallets } from './pallets';

/** The SUMMARY row with the invoices (distinct sales orders) of the day. */
export const INVOICES_LABEL = 'Invoices (sales orders)';

export interface WorkbookMeta {
  tenantName: string;
  currency: string;
  generatedAt: Date;
  generatedBy: string;
  assumptions: Record<string, string>;
  /**
   * PLAN: the settings stored with the plan in use (what it was built with). CURRENT: the plan was
   * made before settings were stored with plans, so today's settings are shown - labelled as such.
   */
  assumptionsSource?: 'PLAN' | 'CURRENT';
  /** Timezone for the "generated at" stamp; defaults to Asia/Muscat. */
  timezone?: string;
}

/** Printed on every sheet of a plan whose timetable did not pass the check (review F04). */
export const NOT_VERIFIED = 'TIMES NOT VERIFIED';

/** The plan (or one truck-day of it) did not pass the timetable check. */
function timesNotVerified(d: PlanDetail, l?: DetailLoad): boolean {
  if (l) return !!l.timing && !l.timing.ok;
  return !!d.feasibility && !d.feasibility.ok;
}

/**
 * "OK" / "OVER PAYLOAD" / "MISMATCH ..." for a load's kg: its stops add up to it and it fits the
 * payload - with the same rounding tolerance as the dispatch check (KG_ROUNDING_TOL), so a load the
 * optimizer filled to its payload never reads "OVER PAYLOAD by 0 kg". Cases planned at 0 kg whose
 * product has a case weight now can make the load over its payload (the check's CAPACITY_KG_NEW_WEIGHT).
 */
export function kgCheck(d: PlanDetail, l: DetailLoad): string {
  const stopsKg = Math.round(sum(l.stops.map((s) => s.weightKg)) * 10) / 10;
  const out: string[] = [];
  const mine = d.feasibility?.violations.filter((v) => v.loadId === l.id) ?? [];
  if (Math.abs(stopsKg - l.weightKg) > KG_ROUNDING_TOL) out.push(`MISMATCH: stops add up to ${stopsKg} kg`);
  const over = l.truckPayloadKg > 0 && l.weightKg > l.truckPayloadKg + KG_ROUNDING_TOL;
  if (over) out.push(`OVER PAYLOAD by ${Math.round(l.weightKg - l.truckPayloadKg)} kg`);
  const later = mine.find((v) => v.code === 'CAPACITY_KG_NEW_WEIGHT');
  if (!over && later) out.push(`OVER PAYLOAD at the case weights entered since planning${later.shortBy ? ` (by about ${Math.round(later.shortBy)} kg)` : ''}`);
  if (mine.some((v) => v.code === 'KG_UNKNOWN') || later) out.push('SOME CASES HAVE NO WEIGHT');
  if (out.length) return out.join('; ');
  return l.truckPayloadKg > 0 ? 'OK' : 'OK (no payload set)';
}

export const SHEETS = {
  summary: 'SUMMARY',
  loadPlan: 'LOAD PLAN',
  truckDays: 'TRUCK DAYS',
  skuSummary: 'SKU LOADING SUMMARY',
  unserved: 'UNSERVED - EXCEPTIONS',
  reconciliation: 'RECONCILIATION',
  assumptions: 'ASSUMPTIONS',
} as const;

/**
 * The cost and routing rules a plan version was made with (stabilization PR5):
 * - CURRENT: the whole-truck-day costs (cost version 2), the road time factor on road legs only,
 *   and the Settings default service time for customers whose own time was never confirmed;
 * - EARLIER: made before that release. Each load's driver cost is its own time on the road (no
 *   depot turnaround, waiting or overtime), the road time factor was applied to every leg the
 *   routing server returned (estimated ones too), and an unconfirmed customer time won over the
 *   Settings default;
 * - MIXED: made with the current rules around locked / dispatched loads kept from an earlier plan,
 *   which keep the cost they were planned with.
 * The ASSUMPTIONS sheet words its rows and NOTES by these, so an older plan's export does not
 * describe rules it was not costed with.
 */
export type PlanRules = 'CURRENT' | 'EARLIER' | 'MIXED';

export function planRules(d: Pick<PlanDetail, 'summary' | 'loads' | 'scenarios'>): PlanRules {
  const chosen = d.scenarios.find((s) => s.chosen);
  const costed = d.loads.filter((l) => l.cost !== null).length;
  // The option in use says which optimizer made it; without one, a load with a cost breakdown does.
  const current = chosen ? (chosen.costVersion ?? 0) >= 2 : costed > 0 || summaryCostBasis(d.summary) === 'TRUCK_DAY_SPAN';
  if (!current) return 'EARLIER';
  return costed === d.loads.length && summaryCostBasis(d.summary) === 'TRUCK_DAY_SPAN' ? 'CURRENT' : 'MIXED';
}

/**
 * The weight and overtime rules of the optimizer that made a plan (audit A6 review), read from the
 * option in use (else any option: a version's options come from one optimizer run). An option from
 * an optimizer before them carries neither: its route search rounded each stop up to a whole kg
 * and charged overtime already worked by locked or dispatched loads again. The ASSUMPTIONS sheet
 * states the new rules only for a plan made with them, so a re-exported older plan is described
 * by the rules it was built with.
 */
export interface SolverRules {
  /** Every kg check to 0.1 kg with no margin (audit F08). */
  weightsToTenthKg: boolean;
  /** Only new overtime counted when choosing a truck (audit E4, owner decision 14). */
  newOvertimeOnly: boolean;
  /** Unloading finished by closing (owner rule 29 Sep 2026); absent/false = it only had to start by closing. */
  finishByClosing?: boolean;
  /** The driver break the plan was made with (the solver's echo); absent/null = none planned. */
  breakRule?: { lengthMin: number; startFromMin: number; startToMin: number } | null;
  /** Trucks with bays were planned by pallets at this Pallet fill (the solver's echo); absent/null = by cases only. */
  pallets?: { fillPct: number } | null;
}

export function solverRules(d: Pick<PlanDetail, 'scenarios'>): SolverRules {
  const option = d.scenarios.find((s) => s.chosen) ?? d.scenarios[0];
  return {
    weightsToTenthKg: option?.weightUnitKg === 0.1,
    newOvertimeOnly: option?.newOvertimeOnly === true,
    finishByClosing: option?.windowRule === 'FINISH',
    breakRule: option?.breakRule ?? null,
    pallets: option?.palletRule ?? null,
  };
}

/** The pallets of a load planned by pallets (pallets.ts loadPallets); null = cases only. */
const palletsOf = (l: DetailLoad): LoadPallets | null => loadPallets(l);

/** "11.1 / 12 (limit 12.0 at 100% fill)" - a load's pallets on the sheets; '' for a load planned by cases. */
export function loadPalletsCell(l: DetailLoad): string {
  const p = palletsOf(l);
  return p ? `${palletsOverBays(p)} (${palletLimitText(p)})` : '';
}

const WHOLE_DAY_NOTE =
  "Driver cost: the driver is paid for the whole truck day - first departure (or first locked departure) to last return, depot turnaround and waiting included - with overtime after the configured hours on top. Each load carries the paid time from its truck's previous return to its own return; the fixed truck cost is on the truck's first load (see TRUCK DAYS).";

const DRIVER_NOTE: Record<PlanRules, string> = {
  CURRENT: WHOLE_DAY_NOTE,
  MIXED: `${WHOLE_DAY_NOTE} Loads kept from an earlier plan (locked, loading or dispatched) keep the cost they were planned with: their own time on the road only, no depot time or overtime (marked on SUMMARY and TRUCK DAYS).`,
  EARLIER:
    "Driver cost: this plan was costed the earlier way (before the whole-truck-day costs). Each load's driver cost is its own time on the road, departure to return; depot turnaround, waiting between loads and overtime are not in the load costs or the operating cost. Plans made since are costed for the whole truck day.",
};

/** The NOTES of the ASSUMPTIONS sheet, worded by the rules the plan was made with. */
export function workbookNotes(rules: PlanRules = 'CURRENT'): string[] {
  return [
    'Distances are road distances from OSRM unless a column or figure is labelled "Estimated km" (straight-line distance x multiplier).',
    'This is an OPTIMIZED plan from a heuristic, time-limited solver - a good plan, not a proven optimum.',
    'Priorities: P1 = HIGHEST, P5 = LOWEST.',
    'Hard delivery windows are enforced. Preferred windows are soft: they carry a penalty and may be missed.',
    'Fuel litres = km / truck km-per-litre; fuel cost = litres x fuel price. Fuel is counted once in operating cost (not also inside the per-km cost).',
    DRIVER_NOTE[rules],
    'Every uploaded order is either on a load or listed as unserved with a reason; cases reconcile exactly (uploaded = planned + unserved) per SKU and per sales order.',
  ];
}

// ----------------------------------------------------------------------------------------
// Formatting
// ----------------------------------------------------------------------------------------

const FMT_KM = '0.0';
const FMT_MONEY = '0.000';
const FMT_KG = '#,##0.0';
const FMT_INT = '#,##0';
const FMT_PCT = '0.0';
/** Pallets: the cells hold the exact pallets (palletsExact), shown to 0.1, so a column adds up to its TOTAL. */
const FMT_PALLETS = '0.0';

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
  addTruckDaysSheet(wb, detail, meta);
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
  if (timesNotVerified(d)) {
    put(ws, r, 1, `${NOT_VERIFIED} - some departure or delivery times of this plan break a planning rule (see TIMETABLE CHECK). Re-plan before loading.`).font = { bold: true, size: 12 };
    r++;
  }
  watermark(ws, d);
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
    // Invoices (sales orders) first, then the delivery orders RouteIQ plans (one per customer branch
    // and day, all its invoices together) and the stops on the trucks (scenario tests S01-S05).
    const inv = d.reconciliation ? invoiceCounts(d.reconciliation) : null;
    if (inv) {
      const noSo = inv.ordersWithoutSo ? `; plus ${inv.ordersWithoutSo} customer branch${inv.ordersWithoutSo === 1 ? '' : 'es'} with lines without a sales-order number` : '';
      kv(INVOICES_LABEL, inv.invoices, FMT_INT, `${inv.planned} fully on trucks${inv.partial ? `, ${inv.partial} partly (split delivery)` : ''}, ${inv.unserved} not planned${noSo}`);
    } else {
      kv(INVOICES_LABEL, 'not available', undefined, 'no reconciliation for this plan version');
    }
    kv('Delivery orders (one per customer branch)', s.totalOrders, FMT_INT, "each is one customer branch's invoices for the day, delivered together");
    kv('Stops on trucks', sum(d.loads.map((l) => l.stops.length)), FMT_INT, 'customer visits on the loads (a split delivery is one stop on each truck)');
    kv('Customers', s.totalCustomers, FMT_INT);
    kv('Total cases', s.totalCases, FMT_INT);
    kv('Total weight (kg)', s.totalWeightKg, FMT_KG);
    kv('Delivery orders served', s.ordersServed, FMT_INT, `${s.casesServed} cases`);
    if (s.ordersPartial) kv('Delivery orders part served (split)', s.ordersPartial, FMT_INT, 'bigger than one truck: some parts planned, the rest unserved');
    kv('Delivery orders unserved', s.ordersUnserved, FMT_INT, `${s.casesUnserved} cases${s.ordersPartial ? ' (incl. rest of split orders)' : ''}${reasons ? ` - ${reasons}` : ''}`);
    for (let p = 1; p <= 5; p++) {
      const x = s.serviceByPriority[`P${p}`];
      if (!x || x.orders === 0) kv(`P${p} service %`, '—', undefined, 'no delivery orders');
      else kv(`P${p} service %`, x.pct ?? 0, FMT_PCT, `${x.served} of ${x.orders} delivery orders served`);
    }
    kv('Physical trucks used', s.trucksUsed, FMT_INT);
    kv('Total trips (loads)', s.trips, FMT_INT);
    const legs = s.estimatedLegs ?? 0;
    kv(
      s.distanceIsEstimated ? 'Estimated km' : legs > 0 ? `Total road km (${legs} leg${legs === 1 ? '' : 's'} estimated)` : 'Total road km',
      s.totalKm,
      FMT_KM,
      s.distanceIsEstimated
        ? `ESTIMATED (${s.distanceProvider}) - not road distances`
        : legs > 0
          ? `road distances (${s.distanceProvider}); ${legs} leg(s) could not be routed on roads and use straight-line estimates`
          : `road distances (${s.distanceProvider})`,
    );
    kv('Hours on the road (loads)', s.onRoadHours ?? s.totalHours, FMT_KM, 'departure to return of each load, added up');
    if (s.driverPaidHours !== undefined) {
      kv('Paid driver hours (truck days)', s.driverPaidHours, FMT_KM, 'first departure to last return of each truck, depot turnaround and waiting included; a driver paid by the day (a hired truck) adds none');
    }
    kv('Average utilization %', s.avgUtilizationPct, FMT_PCT);
    // Pallets (owner decision 4 Oct 2026): only when loads were planned by pallets (trucks with bays).
    if (typeof s.palletUnits === 'number') {
      const n = s.palletLoads ?? 0;
      kv('Pallets planned', palletsExact(s.palletUnits), FMT_PALLETS, `on ${n} load${n === 1 ? '' : 's'} of trucks with bays (mixed pallets: each product's cases / its cases per pallet, added up); orders stay in cases`);
      if (typeof s.avgBayFillPct === 'number') kv('Average bay fill %', s.avgBayFillPct, FMT_PCT, 'pallets / bays of each of those loads, averaged');
    }
    // A truck rented for the day has its fuel in the hire (owner answer 3; sixth review of the hire branch).
    const fuel = dayFuel(s, d.loads);
    const rentedFuel = fuel.included ? `own trucks only; ${FUEL_INCLUDED_NOTE} in the hire` : undefined;
    kv('Estimated fuel (litres)', fuel.litres ?? 'not calculated', FMT_KM, fuel.litres === null ? 'trucks have no km-per-litre' : rentedFuel);
    kv(`Fuel cost (${cur})`, s.fuelCost, FMT_MONEY);
    const basis = summaryCostBasis(s);
    kv(
      `Operating cost (${cur})`,
      s.operatingCost,
      FMT_MONEY,
      `fixed + trip + distance + fuel + driver (whole truck day) + overtime${basis === 'MIXED_LEGACY' ? ` - NOTE: ${COST_BASIS_TEXT.MIXED_LEGACY}` : ''}`,
    );
    const c = s.costs ?? costTotals(d.loads);
    kv('  of which fixed truck cost', c.fixed, FMT_MONEY, 'once per truck day');
    kv('  of which trip cost', c.trip, FMT_MONEY, 'per load');
    kv('  of which distance cost', c.distance, FMT_MONEY, 'km x truck cost per km (fuel excluded)');
    kv('  of which fuel', c.fuel, FMT_MONEY);
    kv('  of which driver (whole truck day)', c.driver, FMT_MONEY, COST_BASIS_TEXT.TRUCK_DAY_SPAN);
    kv('  of which overtime', c.overtime, FMT_MONEY, 'paid time after the overtime threshold, on top of the driver rate');
    if (c.earlier > 0) kv('  loads costed the earlier way', c.earlier, FMT_MONEY, COST_BASIS_TEXT.MIXED_LEGACY);
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
    // The search's own status code in plain words (never "ROUTING_PARTIAL_SUCCESS_..."). The time is
    // the option's optimizer time (its search, and the load re-check when that re-planned it), not its
    // search: the next row says how it was searched (skeptic review of the long-search PR).
    if (s.solver) kv('Route search', solverStatusText(s.solver.status), undefined, `${s.solver.scenario} option · optimizer time ${s.solver.timeSec} s`);
    // Quick / Thorough: how the plan in use was searched and why it stopped (never "optimal"); an
    // alternative in use: its own search, after the recommended plan's.
    const searched = searchOfPlan(d);
    const how = searchResultText(searched.report, searched.option);
    if (how) kv('Search time', how);
  }

  if (d.scenarios.length > 1) {
    // PR7 (B3, N1): the options as the plan screen shows them - the whole day with each option
    // (physical trucks, kept + new loads, km and day cost with the new loads' part when they
    // differ), the preference cost RECOMMENDED also values (only its preferred-hours part for an
    // option made by an older optimizer, said so), and what each option gains or gives up.
    head('PLAN OPTIONS');
    put(ws, r, 1, 'RECOMMENDED also values delivering P1/P2 early and inside preferred hours (preference cost); the other options ignore both.').font = GREY;
    r++;
    for (const sc of d.scenarios) {
      const name = `${sc.name.replace('_', ' ')}${sc.chosen ? ' (in use)' : ''}`;
      if (sc.status !== 'OPTIMIZED') {
        kv(name, 'no plan');
        continue;
      }
      const loadsText = sc.frozenLoads ? `${sc.trips + sc.frozenLoads} loads (${sc.trips} new)` : `${sc.trips} loads`;
      const kmText = `${sc.dayKm.toFixed(1)} km${Math.abs(sc.dayKm - sc.totalKm) >= 0.05 ? ` (new ${sc.totalKm.toFixed(1)})` : ''}`;
      const costText = `day cost ${sc.dayOperatingCost.toFixed(1)} ${cur}${Math.abs(sc.dayOperatingCost - sc.operatingCost) >= 0.05 ? ` (new ${sc.operatingCost.toFixed(1)})` : ''}`;
      const prefText =
        sc.preferenceCost !== null
          ? `preference cost ${sc.preferenceCost.toFixed(1)}`
          : sc.preferredHoursCost !== null
            ? `preferred hours only ${sc.preferredHoursCost.toFixed(1)} (older optimizer: early delivery not reported)`
            : 'preference cost —';
      // Audit F22: the option's own timing check, so an option that breaks the rules reads as such.
      const timingText = sc.feasibility ? ` · timing ${sc.feasibility.status}` : '';
      kv(name, `${sc.trucksUsed} trucks · ${loadsText}`, undefined, `${kmText} · ${costText} · ${prefText} · ${sc.unservedOrders} unserved${timingText}`);
      if (sc.tradeoff) {
        put(ws, r, 3, sc.tradeoff);
        r++;
      }
    }
  }

  head('TIMETABLE CHECK');
  const f = d.feasibility;
  if (!f) {
    kv('Timetable', 'not checked', undefined, 'no optimized plan applied');
  } else {
    kv('Timetable', f.ok ? (f.status === 'STRUCTURAL_ONLY' ? 'CHECKED (without optimizer report)' : 'VERIFIED') : NOT_VERIFIED, undefined,
      f.solverStatus === 'UNKNOWN' ? 'this plan was made before the optimizer checked its own times; the loads, windows and turnarounds were checked here' : `optimizer check: ${f.solverStatus}${f.solverTiming ? ` (${f.solverTiming.toLowerCase()} timing)` : ''}`);
    const shown = f.violations.slice(0, 20);
    for (const v of shown) {
      put(ws, r, 2, v.severity === 'BLOCK' ? v.code : `${v.code} (warning)`);
      put(ws, r, 3, v.message);
      r++;
    }
    if (f.violations.length > shown.length) {
      put(ws, r, 3, `... and ${f.violations.length - shown.length} more`);
      r++;
    }
  }

  // PR9: orders brought forward from earlier days (not delivered on their own day) and, on an
  // earlier day's plan, the orders brought forward from it since (planned on the later day now).
  const carryRows = carriedOverRows(d);
  if (carryRows.length) {
    head('CARRIED OVER');
    for (const [label, value, note] of carryRows) kv(label, value, undefined, note);
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
  // Pallets (owner decision 4 Oct 2026): a "Pallets / bays" column after the case capacity, only when
  // a load of the plan was planned by pallets (a plan without bays keeps its columns).
  const withPallets = d.loads.some((l) => !!palletsOf(l));
  const at = 9;
  const ins = <T>(xs: T[], v: T): T[] => (withPallets ? [...xs.slice(0, at), v, ...xs.slice(at)] : xs);
  const heads = ins([
    'Truck', 'Load', 'Status', 'Driver', 'Departure', 'Return', 'Stops (customers)', 'Cases', 'Capacity (cases)', 'Weight kg', 'Payload kg', 'Kg check',
    'Utilization %', est ? 'Estimated km' : 'Route km', 'Est. time (h:mm)', 'Paid time (h:mm)', 'Est. fuel (l)', `Fuel cost (${cur})`,
    `Driver + overtime (${cur})`, `Operating cost (${cur})`, 'Timing', 'Sheet',
  ], 'Pallets / bays');
  const fmts = ins<string | undefined>([undefined, FMT_INT, undefined, undefined, undefined, undefined, FMT_INT, FMT_INT, FMT_INT, FMT_KG, FMT_KG, undefined, FMT_PCT, FMT_KM, undefined, undefined, FMT_KM, FMT_MONEY, FMT_MONEY, FMT_MONEY], undefined);
  ws.columns = ins([12, 6, 16, 20, 10, 10, 10, 9, 10, 11, 11, 18, 11, 11, 10, 10, 10, 12, 14, 14, 18, 22], 22).map((width) => ({ width }));
  titleRows(ws, 'LOAD PLAN', `Depot ${d.run.depot.code} · Delivery ${d.run.runDate} · Plan v${d.run.version} (${d.run.status})${est ? ' · km are ESTIMATED' : ''}${timesNotVerified(d) ? ` · ${NOT_VERIFIED}` : ''}`);
  watermark(ws, d);
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
      ins<ExcelJS.CellValue>([
        l.truckCode, l.loadNo, l.status + (l.carried ? ' (kept from previous version)' : ''), l.driverName ?? 'Not assigned',
        fmtHhmm(l.departMin), fmtHhmm(l.returnMin), l.stops.length, l.cases, palletsOf(l) ? 'by pallets' : l.truckCapacityCases, l.weightKg, l.truckPayloadKg || null, kgCheck(d, l),
        l.utilizationPct, l.distanceKm, fmtDuration(l.durationMin), paidTimeCell(l), l.fuelLitres, l.fuelCost,
        l.cost ? Math.round((l.cost.driver + l.cost.overtime) * 1000) / 1000 : null, l.operatingCost,
        l.timing ? (l.timing.ok ? TIMING_TEXT[l.timing.status] : NOT_VERIFIED) : '—', names.get(l.id) ?? '',
      ], loadPalletsCell(l) || 'by cases'),
      fmts,
    );
  }
  const fuelKnown = d.loads.some((l) => l.fuelLitres !== null);
  const palletTotal = sum(d.loads.map((l) => palletsOf(l)?.units ?? 0));
  totalRow(
    ws,
    r,
    ins<ExcelJS.CellValue>([
      'TOTAL', `${d.loads.length} loads`, `${new Set(d.loads.map((l) => l.truckId)).size} trucks`, '', '', '',
      sum(d.loads.map((l) => l.stops.length)), sum(d.loads.map((l) => l.cases)), '', sum(d.loads.map((l) => l.weightKg)), '', '', '',
      sum(d.loads.map((l) => l.distanceKm)), fmtDuration(sum(d.loads.map((l) => l.durationMin))),
      fmtDuration(sum(d.loads.map((l) => (typeof l.driverDayRate === 'number' ? 0 : l.cost ? l.cost.driverPaidMin : l.durationMin)))),
      fuelKnown ? sum(d.loads.map((l) => l.fuelLitres ?? 0)) : null, sum(d.loads.map((l) => l.fuelCost)),
      sum(d.loads.map((l) => (l.cost ? l.cost.driver + l.cost.overtime : 0))), sum(d.loads.map((l) => l.operatingCost)), '', '',
    ], `${palletText(palletTotal)} pallets`),
    fmts,
  );
}

/**
 * A load's paid driver time: h:mm, "earlier costing" - or "day rate" for a hired truck's casual driver
 * paid by the day (third review of the hire branch: its paid hours read as hourly pay).
 */
function paidTimeCell(l: DetailLoad): string {
  if (typeof l.driverDayRate === 'number') return 'day rate';
  return l.cost ? fmtDuration(l.cost.driverPaidMin) : 'earlier costing';
}

/**
 * TRUCK DAYS (review F17): one row per truck, each the sum of its loads - when it leaves first and
 * is back last, the paid driver time (the whole truck day), and the money by kind. A truck whose
 * loads were costed the earlier way (plans saved before the cost update) says so.
 */
function addTruckDaysSheet(wb: ExcelJS.Workbook, d: PlanDetail, m: WorkbookMeta) {
  const ws = wb.addWorksheet(SHEETS.truckDays, { views: [{ state: 'frozen', ySplit: 4 }], pageSetup: LANDSCAPE });
  const cur = m.currency;
  ws.columns = [16, 7, 10, 10, 11, 11, 11, 12, 12, 12, 12, 12, 12, 13, 50].map((width) => ({ width }));
  titleRows(
    ws,
    'TRUCK DAYS',
    `Cost per truck day · Depot ${d.run.depot.code} · Delivery ${d.run.runDate} · Plan v${d.run.version} · ${
      planRules(d) === 'EARLIER'
        ? "costed the earlier way: driver cost is each load's time on the road (no depot time or overtime)"
        : 'driver paid from first departure to last return (turnaround and waiting included), overtime on top'
    }`,
  );
  watermark(ws, d);
  headRow(ws, 4, [
    'Truck', 'Loads', 'First departure', 'Last return', 'Truck day (h:mm)', 'Paid time (h:mm)', 'On the road (h:mm)',
    `Driver (${cur})`, `Overtime (${cur})`, `Fixed (${cur})`, `Trip (${cur})`, `Distance (${cur})`, `Fuel (${cur})`, `Total (${cur})`, 'Note',
  ]);
  ws.pageSetup.printTitlesRow = '4:4';
  const rows = truckDayRows(d.loads);
  const fmts = [undefined, FMT_INT, undefined, undefined, undefined, undefined, undefined, FMT_MONEY, FMT_MONEY, FMT_MONEY, FMT_MONEY, FMT_MONEY, FMT_MONEY, FMT_MONEY];
  let r = 5;
  if (!rows.length) {
    put(ws, r, 1, 'No loads in this plan version.').font = { italic: true };
    return;
  }
  for (const t of rows) {
    const withBreak = d.loads.find((x) => x.truckId === t.truckId && x.break);
    const note = [
      withBreak?.break
        ? `driver break ${breakTimes(withBreak.break)} ${withBreak.break.where === 'DEPOT' ? `at the depot before load ${withBreak.loadNo}` : `on the road, load ${withBreak.loadNo}`} (inside the truck day, paid)`
        : '',
      t.basis === 'MIXED_LEGACY' ? `${t.earlier.toFixed(3)} ${cur} from loads costed the earlier way (no depot time or overtime)` : '',
      t.paidVsSpanMin ? `paid time differs from the truck day by ${t.paidVsSpanMin} min: a locked load keeps the share it was planned with` : '',
      t.dayRate !== null ? `driver at the day rate of ${t.dayRate} ${cur} (paid with its first load; no hours, no overtime)` : '',
    ]
      .filter(Boolean)
      .join('; ');
    tableRow(
      ws,
      r++,
      [t.truckCode, t.loads, fmtHhmm(t.firstDepartMin), fmtHhmm(t.lastReturnMin), fmtDuration(t.spanMin), t.dayRate !== null ? 'day rate' : fmtDuration(t.paidMin), fmtDuration(t.onRoadMin),
        t.driver, t.overtime, t.fixed, t.trip, t.distance, t.fuel, t.total, note],
      fmts,
    );
  }
  const tot = costTotals(d.loads);
  totalRow(
    ws,
    r,
    ['TOTAL', sum(rows.map((t) => t.loads)), '', '', fmtDuration(sum(rows.map((t) => t.spanMin))), fmtDuration(sum(rows.map((t) => t.paidMin))),
      fmtDuration(sum(rows.map((t) => t.onRoadMin))), tot.driver, tot.overtime, tot.fixed, tot.trip, tot.distance, tot.fuel, tot.total,
      tot.earlier > 0 ? `incl. ${tot.earlier.toFixed(3)} ${cur} costed the earlier way` : ''],
    fmts,
  );
}

// Delivery-route table columns (1-based), shared by the header block and the route rows.
const ROUTE_HEADS = [
  'Seq', 'Customer code', 'Branch', 'Customer name', 'Priority', 'Type', 'ETA', 'Unloading', 'Window', 'Service min',
  'Cases', 'Kg', 'SKUs', 'Sales orders', 'Km from prev', 'Cumulative km', 'Map', 'Notes', 'Changed after planning', 'Received by (sign)',
];
const ROUTE_WIDTHS = [5, 13, 10, 30, 8, 12, 8, 12, 24, 8, 8, 10, 44, 20, 9, 10, 8, 40, 30, 18];

function addLoadSheet(wb: ExcelJS.Workbook, d: PlanDetail, m: WorkbookMeta, l: DetailLoad, name: string) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 2 }], pageSetup: { ...LANDSCAPE } });
  ws.columns = ROUTE_WIDTHS.map((width) => ({ width }));
  const kmWord = l.distanceIsEstimated ? 'Estimated km' : 'Route km';
  titleRows(
    ws,
    `Truck ${l.truckCode} - Load ${l.loadNo}`,
    `${m.tenantName} · NMWC Daily Dispatch Plan · Depot ${d.run.depot.code} - ${d.run.depot.name} · Delivery ${d.run.runDate} · Plan v${d.run.version} (${d.run.status})`,
  );
  const notVerified = timesNotVerified(d, l);
  if (notVerified) {
    put(ws, 3, 1, `${NOT_VERIFIED} - this truck's times break a planning rule (see SUMMARY, TIMETABLE CHECK). Re-plan before loading.`).font = { bold: true, size: 12 };
  }
  watermark(ws, d, l);

  // Header block: two label/value groups side by side (labels overflow into the empty cells).
  const left: [string, ExcelJS.CellValue, string?][] = [
    ['Truck', l.truckCode],
    ['Load no', l.loadNo, FMT_INT],
    ['Driver', l.driverName ?? 'Not assigned'],
    ['Departure', fmtHhmm(l.departMin)],
    ['Return', fmtHhmm(l.returnMin)],
    ['Status', l.status + (l.carried ? ' (kept from previous version)' : '')],
  ];
  const pallets = palletsOf(l);
  const right: [string, ExcelJS.CellValue, string?][] = [
    // A truck with bays is loaded by pallets (its case capacity is not used): its cases and its pallets
    // over its bays in one row, so the block stays on rows 4-9 and row 10 is free for the driver break
    // (pallets review: a 7th row landed on row 10 and cut the break's text off).
    pallets
      ? ['Cases · pallets / bays', `${l.cases.toLocaleString('en-US')} · ${loadPalletsCell(l)}`]
      : ['Cases / capacity', `${l.cases} / ${l.truckCapacityCases}`],
    // A payload of 0 is no weight limit (owner decisions of 4 Oct 2026: NMWC's trucks have none): never "/ 0".
    ['Weight / payload kg', `${Math.round(l.weightKg * 10) / 10} / ${l.truckPayloadKg > 0 ? l.truckPayloadKg : 'no limit'}${kgCheck(d, l).startsWith('OK') ? '' : ` - ${kgCheck(d, l)}`}`],
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
  if (l.break) {
    put(ws, 10, 1, 'Driver break').font = { bold: true };
    put(ws, 10, 4, `${breakTimes(l.break)} ${breakPlace(l.break, l.stops.length)} (${l.break.lengthMin} min, never while unloading)`);
  }

  // LOADING MANIFEST - what the warehouse puts on the truck.
  let r = 11;
  section(ws, r, 'LOADING MANIFEST');
  put(ws, r, 4, `Load exactly these cases; tick each line when loaded.${
    l.break?.where === 'DEPOT' ? ` The driver's break is ${breakTimes(l.break)} at the depot; loading continues meanwhile.` : ''
  }`).font = GREY;
  r++;
  // A load planned by pallets: each product's cases per pallet, full pallets + loose cases and its
  // pallets, so the warehouse builds the pallets (mixed pallets for the loose cases). Cases stay first.
  const palletHeads = pallets ? ['Cases per pallet', 'Full pallets', 'Loose cases', 'Pallets'] : [];
  const palletFmts = pallets ? [FMT_INT, FMT_INT, FMT_INT, FMT_PALLETS] : [];
  const kgCol = 6 + palletHeads.length;
  headRow(ws, r, ['#', 'SKU code', 'Description', '', 'Cases', ...palletHeads, 'Kg', 'Loaded']);
  ws.mergeCells(r, 3, r, 4);
  r++;
  l.manifest.forEach((x, i) => {
    const palletCells = pallets ? [x.casesPerPallet ?? 'not set', x.fullPallets ?? 0, x.looseCases ?? x.cases, palletsExact(x.palletUnits ?? 0)] : [];
    tableRow(ws, r, [i + 1, x.productCode, x.productName, '', x.cases, ...palletCells, x.weightKg, ''], [FMT_INT, undefined, undefined, undefined, FMT_INT, ...palletFmts, FMT_KG]);
    ws.mergeCells(r, 3, r, 4);
    r++;
  });
  const manifestCases = sum(l.manifest.map((x) => x.cases));
  const manifestKg = manifestKgOf(l.manifest);
  const totals = manifestPalletTotals(l.manifest);
  totalRow(
    ws,
    r,
    ['', 'TOTAL', `${l.manifest.length} SKUs`, '', manifestCases, ...(pallets ? ['', totals.full, totals.loose, palletsExact(pallets.units)] : []), manifestKg, ''],
    [undefined, undefined, undefined, undefined, FMT_INT, ...palletFmts, FMT_KG],
  );
  ws.mergeCells(r, 3, r, 4);
  // Audit E3: the sheet's kg is the load's kg (the lines share the kg each order was planned with).
  // Only a plan whose orders were re-weighed after it was made (an older version) can differ: say so.
  const manifestProblems = [
    ...(manifestCases !== l.cases ? [`MISMATCH: load records ${l.cases} cases`] : []),
    ...(manifestKgDiffers(manifestKg, l.weightKg) ? [`MISMATCH: load records ${l.weightKg} kg (order weights changed since planning)`] : []),
  ];
  if (manifestProblems.length) put(ws, r, kgCol + 2, manifestProblems.join('; ')).font = { bold: true };
  if (pallets) {
    // "1,045 cases = 11.1 pallets (8 full pallets + 293 loose cases on mixed pallets)", and any cases
    // per pallet changed under Products since planning (the load keeps its pallets).
    r++;
    put(ws, r, 2, manifestTotalText(manifestCases, pallets.units, totals)).font = { bold: true };
    for (const n of l.palletNotes ?? []) put(ws, ++r, 2, n).font = GREY;
  }
  r += 2;

  // DELIVERY ROUTE - driver's sequence.
  section(ws, r, 'DELIVERY ROUTE');
  if (l.distanceIsEstimated) put(ws, r, 4, 'km are ESTIMATED (not road distances)').font = GREY;
  if (l.stops.some((s) => !s.snapshot)) put(ws, r, 9, 'Stops planned before their details were kept: current customer data shown').font = GREY;
  r++;
  const heads = ROUTE_HEADS.map((h) => (h === 'Km from prev' || h === 'Cumulative km') && l.distanceIsEstimated ? `${h} (est.)` : h);
  headRow(ws, r, heads);
  ws.pageSetup.printTitlesRow = `${r}:${r}`;
  r++;
  const depot = d.run.depot;
  // Audit E1: the depot pin this load was planned from (a load kept from before the depot moved keeps it).
  const from = l.origin ?? depot;
  const depotMap = `https://www.google.com/maps/search/?api=1&query=${from.lat},${from.lng}`;
  const fmts = [FMT_INT, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, FMT_INT, FMT_INT, FMT_KG, undefined, undefined, FMT_KM, FMT_KM];
  tableRow(
    ws,
    r++,
    ['', 'DEPOT', '', `${depot.code} - ${depot.name} (depart)`, '', '', fmtHhmm(l.departMin), '', '', null, null, null, '', '', null, 0,
      { text: 'Map', hyperlink: depotMap },
      `Departure ${fmtHhmm(l.departMin)}${(l.masterChanged ?? []).filter((c) => c.kind === 'DEPOT').map((c) => ` · ${c.text}`).join('')}`, '', ''],
    fmts,
  );
  // The driver break as its own row, where it is taken (never while unloading).
  const breakRow = (row: number) =>
    tableRow(ws, row, ['', 'BREAK', '', `Driver break ${l.break!.lengthMin} min`, '', '', fmtHhmm(l.break!.startMin), breakTimes(l.break!), '', null, null, null, '', '', null, null, '',
      breakLine(l.break!, l.stops.length), '', ''], fmts);
  if (l.break && (l.break.where === 'DEPOT' || (l.break.afterSequence ?? 0) === 0)) breakRow(r++);
  let running = 0;
  for (const s of l.stops) {
    running += s.legKm;
    const notes = [
      s.late ? 'LATE ORDER' : null,
      carriedStopText(s),
      s.split ? `SPLIT DELIVERY part ${s.split.part} of ${s.split.parts}${s.split.restUnserved ? ' (rest unserved)' : ''}` : null,
      s.hardWindowOk === false ? 'HARD WINDOW MISSED' : null,
      s.prefWindowOk === false ? 'Outside preferred window' : null,
      s.waitMin ? `Wait ${Math.round(s.waitMin)} min` : null,
      s.mapsUrl ? null : 'No coordinates',
      // What the PDF driver sheet prints too: the customer's access / receiving notes and the
      // notes on the orders of this stop (scenario test S01: the Excel sheet had flags only).
      s.accessNotes?.trim() ? `Access: ${s.accessNotes.trim()}` : null,
      ...s.notes.map((n) => n.trim()).filter(Boolean).map((n) => `Note: ${n}`),
    ].filter(Boolean);
    tableRow(
      ws,
      r++,
      [
        s.sequence, s.customerCode, s.branchCode ?? '', s.customerName, `P${s.priority}`, s.customerType ?? '', fmtHhmm(s.etaMin),
        s.departureMin !== null ? `${fmtHhmm(s.serviceStartMin)}-${fmtHhmm(s.departureMin)}` : fmtHhmm(s.serviceStartMin), s.window, s.serviceMin, s.cases, s.weightKg, skuText(s.skus), uniq(s.salesOrders).join(', '),
        s.legKm, s.cumulativeKm ?? running, s.mapsUrl ? { text: 'Map', hyperlink: s.mapsUrl } : '', notes.join('; '),
        s.masterChanged.map((c) => c.text).join('; '), '',
      ],
      fmts,
    );
    if (l.break && l.break.where === 'ROAD' && (l.break.afterSequence ?? 0) === s.sequence) breakRow(r++);
  }
  tableRow(
    ws,
    r++,
    ['', 'DEPOT', '', `${depot.code} - ${depot.name} (return)`, '', '', fmtHhmm(l.returnMin), '', '', null, null, null, '', '',
      l.returnLegKm, l.distanceKm, { text: 'Map', hyperlink: depotMap }, `Back at depot ${fmtHhmm(l.returnMin)} · return leg ${l.returnLegKm.toFixed(1)} km`, '', ''],
    fmts,
  );
  const stopCases = sum(l.stops.map((s) => s.cases));
  totalRow(
    ws,
    r,
    ['', 'TOTAL', '', `${l.stops.length} stops`, '', '', '', '', '', '', stopCases, sum(l.stops.map((s) => s.weightKg)), '', '', '', l.distanceKm, '',
      stopCases !== l.cases ? `MISMATCH: load records ${l.cases} cases` : `Total time ${fmtDuration(l.durationMin)}`, '', ''],
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
  // The SKU code column holds ERP codes such as "INVOMAN330(24)" or "SS5GB NRB" (up to 40 characters).
  ws.columns = [{ width: 24 }, { width: 34 }, ...d.loads.map(() => ({ width: 11 })), { width: 12 }, { width: 12 }];
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
  const kgPerLoad = d.loads.map((l) => manifestKgOf(l.manifest));
  const skuKg = Math.round(sum([...skus.values()].map((e) => e.kg)) * 10) / 10;
  const loadsKg = Math.round(sum(d.loads.map((l) => l.weightKg)) * 10) / 10;
  totalRow(ws, r++, ['TOTAL', `${skus.size} SKUs`, ...perLoad, sum(perLoad), skuKg], intFmts);
  tableRow(ws, r++, ['Load cases (plan)', 'from the load record (kg: the loads\' kg)', ...d.loads.map((l) => l.cases), sum(d.loads.map((l) => l.cases)), loadsKg], intFmts);
  // Audit E3: kg checked too, per load and in total (the same words as the cases check).
  const check = (casesOk: boolean, kgOk: boolean) => (casesOk && kgOk ? 'OK' : casesOk ? 'MISMATCH (kg)' : 'MISMATCH');
  tableRow(ws, r, [
    'Check',
    '',
    ...d.loads.map((l, i) => check(perLoad[i] === l.cases, !manifestKgDiffers(kgPerLoad[i], l.weightKg))),
    sum(perLoad) === sum(d.loads.map((l) => l.cases)) ? 'OK' : 'MISMATCH',
    manifestKgDiffers(skuKg, loadsKg) ? 'MISMATCH' : 'OK',
  ]);
  // Pallets of each load planned by pallets (blank for a load planned by cases), and their bays.
  if (d.loads.some((l) => !!palletsOf(l))) {
    const pFmts = [undefined, undefined, ...d.loads.map(() => FMT_PALLETS), FMT_PALLETS];
    r++;
    tableRow(ws, r++, ['Pallets (plan)', 'mixed pallets: cases / cases per pallet, added up', ...d.loads.map((l) => (palletsOf(l) ? palletsExact(palletsOf(l)!.units) : null)), palletsExact(sum(d.loads.map((l) => palletsOf(l)?.units ?? 0)))], pFmts);
    tableRow(ws, r, ['Bays', 'pallet positions of the truck', ...d.loads.map((l) => palletsOf(l)?.bays ?? null), null], [undefined, undefined, ...d.loads.map(() => FMT_INT)]);
  }
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
      [
        u.customerCode,
        u.branchCode ?? '',
        u.customerName,
        `P${u.priority}`,
        u.cases,
        u.weightKg,
        uniq(u.salesOrders).join(', '),
        u.late ? 'LATE' : '',
        u.reasonCode,
        `${u.carriedTo ? `CARRIED OVER to ${fmtDayMonth(u.carriedTo)}: planned on that day now. ` : ''}${u.carriedFrom ? `CARRIED OVER from ${fmtDayMonth(u.carriedFrom)}. ` : ''}${u.partial ? 'Rest of a split delivery (the other part is on a truck). ' : ''}${u.reasonMessage ?? ''}`,
      ],
      fmts,
    );
  }
  totalRow(ws, r, ['TOTAL', '', `${orders} order${orders === 1 ? '' : 's'}`, '', sum(d.unserved.map((u) => u.cases)), sum(d.unserved.map((u) => u.weightKg)), '', '', '', ''], fmts);
}

/**
 * PR9: the SUMMARY's CARRIED OVER rows ([label, value, note]): orders of this plan brought forward
 * from earlier days, per first-due day with the customers, and orders brought forward from this
 * plan to later days since. Empty when neither.
 */
export function carriedOverRows(d: Pick<PlanDetail, 'loads' | 'unserved' | 'carriedIn' | 'carriedOut'>): [string, string, string | undefined][] {
  const rows: [string, string, string | undefined][] = [];
  if (d.carriedIn?.orders) {
    const byDay = new Map<string, Set<string>>();
    const add = (date: string | null, who: string) => {
      if (!date) return;
      byDay.set(date, (byDay.get(date) ?? new Set()).add(who));
    };
    for (const l of d.loads) for (const s of l.stops) add(s.carriedFrom, `${s.customerCode}${s.branchCode ? `/${s.branchCode}` : ''} (${l.truckCode} L${l.loadNo})`);
    for (const u of d.unserved) add(u.carriedFrom, `${u.customerCode}${u.branchCode ? `/${u.branchCode}` : ''} (unserved)`);
    rows.push([
      'Brought forward from earlier days',
      `${d.carriedIn.orders} order${d.carriedIn.orders === 1 ? '' : 's'} · ${d.carriedIn.cases} cases`,
      'not delivered on the day they were due; their priority is kept as it was',
    ]);
    for (const [day, who] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
      rows.push([`  from ${fmtDayMonth(day)}`, [...who].join(', '), undefined]);
    }
  }
  if (d.carriedOut?.orders) {
    rows.push([
      'Brought forward to later days',
      `${d.carriedOut.orders} order${d.carriedOut.orders === 1 ? '' : 's'} · ${d.carriedOut.cases} cases`,
      `to ${d.carriedOut.dates.map(fmtDayMonth).join(', ')}: not delivered on this day, planned there - do not load them from this plan`,
    ]);
  }
  return rows;
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
  // Review F08: the settings stored with the plan, never today's settings under a "built with" title.
  titleRows(
    ws,
    'ASSUMPTIONS',
    m.assumptionsSource === 'CURRENT'
      ? `Current settings, at export time. Plan v${d.run.version} was made before its settings were stored with it: it may have been built with other values.`
      : `Settings this plan (v${d.run.version}) was built and costed with.`,
  );
  headRow(ws, 3, ['Setting', 'Value']);
  let r = 4;
  const entries = Object.entries(m.assumptions);
  if (!entries.length) put(ws, r++, 1, 'No settings supplied.');
  for (const [k, v] of entries) tableRow(ws, r++, [k, v]);
  r++;
  section(ws, r++, 'NOTES');
  workbookNotes(planRules(d)).forEach((n, i) => {
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

/**
 * The page header of a sheet whose times are not verified (review F04): printed on every page, so
 * a page separated from the workbook still carries it.
 */
function watermark(ws: ExcelJS.Worksheet, d: PlanDetail, l?: DetailLoad) {
  if (timesNotVerified(d, l)) ws.headerFooter.oddHeader = `&C&"-,Bold"&14${NOT_VERIFIED} - check with the dispatcher before loading`;
}

/**
 * The fields the workbook reports: a Prisma TenantConfig row satisfies it, and so do the settings
 * stored with a plan (snapshots.PlanSettings: osrmConfigured instead of the OSRM address).
 */
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
  /** Stored with a plan (PlanSettings): a truck hired for the day pays its casual driver this per day (owner answer 4). */
  dailyDriverDayRate?: number;
  overtimeAfterMin: number;
  overtimeCostPerHour: number;
  prefWindowPenaltyPerMin: number;
  roadTimeFactor: number;
  distanceProvider: string;
  distanceMultiplier: number;
  avgSpeedKmh: number;
  defaultServiceTimeMin: number;
  osrmUrl?: string | null;
  /** Whether the tenant set its own OSRM server (the address itself is not kept with plans). */
  osrmConfigured?: boolean;
  /** Stored with a plan (PlanSettings): the routing decision made when it was built. */
  outsideCoverage?: boolean;
  /** Stored with a plan (PlanSettings, PR8): built on its own delivery day, new loads from now + preparation. */
  planFrom?: PlanFrom | null;
  /** Stored with a plan (PlanSettings, PR8 review): made on its delivery day at this time; loading starts then. */
  loadingFromMin?: number | null;
  /** Stored with a plan (PlanSettings): a same-day THOROUGH search counted before the loads (minutes). */
  searchLeadMin?: number | null;
  priorityWeightsJson?: unknown;
}

/**
 * How the plan in use was searched: the search report (always the recommended plan's search) and,
 * when an alternative is in use, that option with its own search limit - from the stored summary
 * (the option applied), else the plan data. Skeptic review of the long-search PR: an alternative in
 * use was described with the recommended plan's search.
 */
export function searchOfPlan(d: Pick<PlanDetail, 'search' | 'searchOption' | 'summary'>): { report: SearchReport | null; option: SearchOption | null } {
  const solver = d.summary?.solver;
  if (solver?.search) return { report: solver.search, option: searchOptionOf(solver.scenario, solver.limitSec) };
  return { report: d.search ?? null, option: d.searchOption ?? null };
}

/**
 * The ASSUMPTIONS rows plus how the plan in use was searched (Quick / Thorough, how long, why it
 * stopped, what that means - search-mode.ts), when the plan has a search report.
 */
export function withSearchAssumptions(d: Pick<PlanDetail, 'search' | 'searchOption' | 'summary'>, rows: Record<string, string>): Record<string, string> {
  const { report, option } = searchOfPlan(d);
  return { ...rows, ...searchAssumptions(report, option) };
}

/**
 * The ASSUMPTIONS rows. Everything comes from `cfg` (the settings stored with the plan, or today's
 * for a plan from before they were stored) and from the plan itself (`providerUsed`,
 * `distanceIsEstimated`) - never from the web server's environment: the web does no routing (since
 * stabilization PR5 even the legacy Map tab goes through the solver, which has its own OSRM_URL).
 */
export function tenantAssumptions(
  cfg: AssumptionConfig | null,
  opts: {
    currency: string;
    providerUsed: string | null;
    distanceIsEstimated: boolean | null;
    /** Tenant outside the shared OSRM map (Oman + UAE) without its own OSRM: planned on straight
     * lines. Used only when `cfg` does not carry it (today's settings, or settings stored before it was kept). */
    outsideCoverage?: boolean;
    /** The rules the plan was made with (planRules); default CURRENT. */
    rules?: PlanRules;
    /** The optimizer's weight and overtime rules the plan was made with (solverRules); default: today's. */
    solverRules?: SolverRules;
    /** Legs of the plan on straight-line estimates although it used road routing (review F18). */
    estimatedLegs?: number;
    /** Whether any load of the plan has a fuel figure (its truck has a km per litre); undefined = unknown. */
    fuelCosted?: boolean;
  },
): Record<string, string> {
  if (!cfg) return { 'Tenant configuration': 'not set - system defaults were used' };
  const cur = opts.currency;
  const rules = opts.rules ?? 'CURRENT';
  const earlier = rules === 'EARLIER';
  const solver = opts.solverRules ?? { weightsToTenthKg: true, newOvertimeOnly: true };
  const outsideCoverage = cfg.outsideCoverage ?? opts.outsideCoverage ?? false;
  // A plan with no road leg at all (straight-line provider, or every leg estimated) never used the
  // road time factor: it is timed at the estimate speed (scenario tests: HAVERSINE plans still
  // printed "x1.25"). Under the earlier rule an OSRM plan whose legs all fell back to estimates
  // did have the factor applied, so that one keeps the earlier wording.
  const straightLine = (opts.providerUsed ?? '').toUpperCase() === 'HAVERSINE';
  const noRoadLegs = straightLine || (!!opts.distanceIsEstimated && !earlier);
  const estimatesUsed = cfg.distanceProvider === 'HAVERSINE' || !!opts.distanceIsEstimated || straightLine || (opts.estimatedLegs ?? 0) > 0;
  const out: Record<string, string> = {
    Timezone: cfg.timezone,
    'Planning cutoff (day before delivery)': `${fmtHhmm(cfg.planningCutoffMin)} - orders received later are LATE`,
    'Shift start (earliest departure)': cfg.planFrom
      ? `${fmtHhmm(cfg.shiftStartMin)} (the setting; this plan was made on the delivery day, see "Planned from")`
      : fmtHhmm(cfg.shiftStartMin),
    ...(cfg.planFrom
      ? { 'Planned from (plan made on the delivery day)': planFromAssumption(cfg.planFrom, cfg.loadingMinPerCase) }
      : typeof cfg.loadingFromMin === 'number' && (cfg.loadingMinPerCase ?? 0) > 0
        ? { 'Loading from (plan made on the delivery day)': loadingFromAssumption(cfg.loadingFromMin, cfg.reloadMinutes, cfg.loadingMinPerCase ?? 0, cfg.searchLeadMin ?? 0) }
        : {}),
    'Driver shift maximum (h:mm)': fmtDuration(cfg.driverShiftMaxMinutes),
    'Depot reload time between loads': `${cfg.reloadMinutes} min`,
    'Loading time per case': cfg.loadingMinPerCase ? `${cfg.loadingMinPerCase} min per case of the next load, on top of the reload time` : 'not set (0)',
    'Unloading time per case': cfg.serviceMinPerCase ? `${cfg.serviceMinPerCase} min per case delivered, on top of the service time` : 'not set (0)',
    'Max trips per truck per day': String(cfg.maxTripsPerTruck),
    'Fuel price':
      cfg.fuelPricePerLitre > 0
        ? opts.fuelCosted === false
          ? `${cfg.fuelPricePerLitre} ${cur} per litre - not used in this plan: its trucks have no km per litre, so no fuel was costed`
          : `${cfg.fuelPricePerLitre} ${cur} per litre`
        : '0 - fuel not costed separately',
    'Driver cost': earlier
      ? `${cfg.driverCostPerHour} ${cur} per hour of each load's time on the road, departure to return (costed the earlier way: depot turnaround and waiting not included)`
      : `${cfg.driverCostPerHour} ${cur} per hour of the whole truck day (first departure to last return, depot turnaround and waiting included)${
          rules === 'MIXED' ? '; loads kept from an earlier plan keep their earlier cost (time on the road only)' : ''
        }`,
    // The hire suggestion (owner answers 3 and 4, 6 Oct 2026): a plan stored with the setting says it.
    ...(typeof cfg.dailyDriverDayRate === 'number'
      ? { 'Trucks hired for the day': `driver ${cfg.dailyDriverDayRate} ${cur} a day each (no hourly pay or overtime); fuel included in the hire` }
      : {}),
    Overtime:
      cfg.overtimeCostPerHour > 0
        ? `after ${fmtDuration(cfg.overtimeAfterMin)} from the first departure, +${cfg.overtimeCostPerHour} ${cur} per hour${
            earlier ? " (priced in the optimizer's search only; not included in this plan's load costs or operating cost)" : ' on top of the driver cost'
          }${cfg.overtimeAfterMin >= cfg.driverShiftMaxMinutes ? ' (never reached: at or after the shift maximum)' : ''}${
            // Audit E4 (owner decision 14): only new cost counts when choosing a truck - stated
            // only for a plan whose optimizer says it chose that way (A6 review).
            !earlier && solver.newOvertimeOnly ? '; overtime already worked by locked or dispatched loads is not counted again for new loads' : ''
          }`
        : 'not costed',
    // Audit F08 (owner decision 15): how weights are compared, with no hidden margin; an older
    // optimizer's plan keeps the rule it was made with (A6 review).
    Weights: solver.weightsToTenthKg
      ? "each order to the nearest 0.1 kg, checked against each truck's payload with no margin (a load may weigh exactly the payload)"
      : 'earlier rule: the route search rounded each stop up to a whole kg and each payload down to a whole kg (a small margin below the payload)',
    // Pallets (owner decision 4 Oct 2026), worded by the rule the solver REPORTED (its echo).
    'Truck capacity': solver.pallets
      ? `trucks with bays: pallets up to bays x ${solver.pallets.fillPct}% (Pallet fill) and the payload - their case capacity is not used; trucks without bays: cases and payload; a payload of 0 is no weight limit. A load's pallets = each product's cases / its cases per pallet, added up (mixed pallets; each order line rounded up to 0.001 pallet). Orders, invoices and the stops stay in cases`
      : 'cases and payload (no truck of this plan was planned by pallets); a payload of 0 is no weight limit',
    // Worded by the rules the solver REPORTED this plan was made with (review FIX 9), never by the settings.
    'Receiving hours': solver.finishByClosing
      ? 'unloading must be finished by the end of the receiving hours'
      : 'earlier rule: unloading had to start by closing and could run past it',
    'Driver break': solver.breakRule
      ? `${solver.breakRule.lengthMin} min, starting between ${fmtHhmm(solver.breakRule.startFromMin)} and ${fmtHhmm(solver.breakRule.startToMin)}, between stops or at the depot (it may overlap reloading and loading), never while unloading; inside the ${fmtDuration(cfg.driverShiftMaxMinutes)} shift maximum; paid driver time. Truck-days back for good by ${fmtHhmm(solver.breakRule.startToMin)}, or leaving for the first time at ${fmtHhmm(solver.breakRule.startFromMin)} or later, have none`
      : 'not planned',
    'Preferred window penalty': `${cfg.prefWindowPenaltyPerMin} ${cur} per minute outside the preferred window (soft)`,
    'Road time factor (truck vs car)': noRoadLegs
      ? `not used in this plan: every distance is a straight-line estimate, timed at the average speed for estimates (the x${cfg.roadTimeFactor} setting applies to road legs only)`
      : earlier
        ? `x${cfg.roadTimeFactor} on every travel time from the routing server, including legs it could not route (earlier rule)`
        : `x${cfg.roadTimeFactor} on road travel times (not on estimated legs)`,
    'Default service time': earlier
      ? `${cfg.defaultServiceTimeMin} min per stop for customers with no service time of their own (earlier rule: a confirmed customer time, then the customer type's, then the customer's stored time won)`
      : `${cfg.defaultServiceTimeMin} min per stop for customers whose own time was never confirmed (a confirmed customer time, then the customer type's, wins)`,
    Priorities: 'strict - one higher-priority order always wins over any number of lower ones (P1 > P2 > P3 > P4 > P5)',
    'Distance provider (configured)':
      cfg.distanceProvider === 'HAVERSINE'
        ? 'HAVERSINE (estimated distances)'
        : outsideCoverage
          ? `${cfg.distanceProvider} configured - straight-line estimates used (outside the Oman + UAE routing map)`
          : `${cfg.distanceProvider} (the dispatch planner uses OSRM road distances)`,
    'Distance provider (this plan)': `${opts.providerUsed ?? 'unknown'}${opts.distanceIsEstimated ? ' - ESTIMATED distances' : ''}`,
    'OSRM server configured': (cfg.osrmConfigured ?? !!cfg.osrmUrl) ? 'yes (tenant setting)' : 'no tenant setting (the solver uses its own OSRM_URL if set)',
  };
  if (estimatesUsed) {
    const some = !noRoadLegs && !opts.distanceIsEstimated && (opts.estimatedLegs ?? 0) > 0 ? ` (on the ${opts.estimatedLegs} leg(s) that could not be routed on roads)` : '';
    out['Estimated-distance multiplier'] = `x${cfg.distanceMultiplier} on straight-line distance${some}`;
    out['Average speed for estimates'] = `${cfg.avgSpeedKmh} km/h${some}`;
  }
  return out;
}
