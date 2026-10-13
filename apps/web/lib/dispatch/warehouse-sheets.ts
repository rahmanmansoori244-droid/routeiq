/**
 * Warehouse paperwork (owner request 12 Oct 2026), two printable documents per truck load:
 *
 * - Load sheet: what the loading team puts on each vehicle. The products and cases to load (the
 *   load manifest), and every invoice with its customer, so the invoice papers go into the truck
 *   with the goods. Not the driver sheet: no route, no times to the customer, no QR codes.
 * - Return note: after the load is back, what was delivered and what came back, per customer, with
 *   the reason the driver recorded. The gate pass officer counts the returned goods against it and
 *   tells the supervisor which customers they belong to.
 *
 * Built only from PlanDetail (the plan screen's object) and, for the return note, the delivery
 * results overlay (readOutcomeOverlay, the plan screen's results), in two steps like the driver
 * pack: the models here are pure and unit-tested; warehouse-sheets-html.ts lays them out as one
 * printable HTML page (the browser prints it, so Arabic customer names print as they are).
 * Neither document shows money.
 */
import type { DetailLoad, DetailStop, PlanDetail } from './plan-detail';
import type { OutcomeOverlay, OverlayStop } from '../delivery/outcome-view';
import { isSupersededRun } from './plan-status';
import { tripsByTruck } from './driver-links';
import { fmtHhmm } from './time';
import { loadPallets, palletsOverBays } from './pallets';
import { OUTCOME_LABEL, reasonText } from '../delivery/office-text';
import { carriedStopText, carriedToDays } from './carry-view';
import { CANCELLED_STOP_TEXT } from './order-cancel-rules';

/** The loads that have left: only these have delivery results. */
export const RETURN_NOTE_STATUSES: ReadonlySet<string> = new Set(['DISPATCHED', 'COMPLETED']);

const STATUS_TEXT: Record<string, string> = {
  PLANNED: 'PLANNED - NOT LOCKED: do not load yet',
  LOCKED: 'LOCKED',
  LOADING: 'LOADING',
  DISPATCHED: 'DISPATCHED',
  COMPLETED: 'COMPLETED',
};

/** Text shown for an order line without an invoice number in the file. */
export const NO_INVOICE = 'no invoice no.';

export interface SheetHead {
  title: string;
  tenantName: string;
  runDate: string;
  version: number;
  /** A newer plan version exists: this paper is void. */
  superseded: boolean;
  depot: { code: string; name: string };
}

export interface ProductCases {
  productCode: string;
  productName: string;
  cases: number;
}

/** One invoice of one stop, as the loading team ticks it. */
export interface LoadSheetInvoice {
  /** The delivery stop number on the driver sheet. */
  stop: number;
  invoiceNo: string;
  customerName: string;
  customerCode: string;
  branchCode: string | null;
  /** "part 1 of 2": a split delivery (the rest goes on another truck or trip, or is not on a truck today). */
  split: string | null;
  /** "CARRIED OVER to 14 Oct - not delivered on this day" (the stop's mark on the driver sheet), or null. */
  carried: string | null;
  lines: ProductCases[];
  cases: number;
}

export interface LoadSheet {
  loadId: string;
  truckCode: string;
  trip: number;
  trips: number;
  status: string;
  /** The status in words; PLANNED says "do not load yet" (load only locked loads). */
  statusText: string;
  /** The load may still change: it is not locked. */
  notLocked: boolean;
  driverName: string | null;
  depart: string;
  back: string;
  /** What goes on the truck, by product (the load manifest), product code order. */
  products: ProductCases[];
  totalCases: number;
  /** "11.1 / 12" pallets over bays, for a truck loaded by pallets; null = loaded by cases. */
  pallets: string | null;
  /** The invoices to put in the truck, in delivery order. */
  invoices: LoadSheetInvoice[];
  /** The products total equals the invoices total (both come from the same plan rows). */
  matches: boolean;
  /**
   * Orders on this load brought forward to a later day (DetailLoad.carriedAway, only on a load that
   * has not left): they are planned on that day now, so they must not be loaded from this paper.
   */
  carriedAway: number;
  /** "14 Oct" / "14 Oct, 15 Oct": the days they were brought forward to. */
  carriedToDays: string;
  /**
   * Cancel order (owner request 12 Oct 2026): cancelled orders on this load (DetailLoad.cancelledHere,
   * only on a load that has not left). Their cases are still in the products to load (the plan rows),
   * so the sheet says so in a banner and marks their invoices CANCELLED.
   */
  cancelledHere: number;
  footer: string;
}

export interface LoadSheetModel extends SheetHead {
  sheets: LoadSheet[];
}

export interface ReturnLine {
  productCode: string;
  productName: string;
  planned: number;
  /** null: no result recorded for the stop. */
  delivered: number | null;
  returned: number | null;
}

export interface ReturnStop {
  stop: number;
  customerName: string;
  customerCode: string;
  branchCode: string | null;
  invoices: string[];
  /** "Delivered", "Partly delivered", "Not delivered", or "NO RESULT". */
  result: string;
  /** No result recorded: the driver must say what happened before the truck leaves the gate. */
  noResult: boolean;
  /** "Shop closed", "Damaged goods", "Other - gate locked"; null when delivered in full. */
  reason: string | null;
  lines: ReturnLine[];
  planned: number;
  delivered: number | null;
  returned: number | null;
}

export interface ReturnNote {
  loadId: string;
  truckCode: string;
  trip: number;
  trips: number;
  status: string;
  driverName: string | null;
  depart: string;
  /** "Back at depot 15:58" (the driver's tap), else null. */
  backAt: string | null;
  /**
   * Back at depot is not recorded (no tap and not Completed): the truck may still be out, so the
   * results may still change. Many drivers never tap it, so the note says so without claiming more.
   */
  notBack: boolean;
  stops: ReturnStop[];
  /** The stops with goods to come back (part or all), and the stops without a result. */
  returnStops: ReturnStop[];
  /** Returned cases by product (what the gate counts). */
  returnedByProduct: ProductCases[];
  totalPlanned: number;
  totalDelivered: number;
  totalReturned: number;
  noResultStops: number;
  footer: string;
}

export interface ReturnNoteModel extends SheetHead {
  notes: ReturnNote[];
}

function head(d: PlanDetail, tenantName: string, title: string): SheetHead {
  return {
    title: `${title} ${d.run.runDate} v${d.run.version}`,
    tenantName,
    runDate: d.run.runDate,
    version: d.run.version,
    superseded: isSupersededRun(d.run),
    depot: { code: d.run.depot.code, name: d.run.depot.name },
  };
}

const byCode = (a: { productCode: string }, b: { productCode: string }) => a.productCode.localeCompare(b.productCode);

/** Sum cases per product code (the first name seen for a code is kept). */
function sumByProduct(rows: ProductCases[]): ProductCases[] {
  const out = new Map<string, ProductCases>();
  for (const r of rows) {
    const p = out.get(r.productCode);
    if (p) p.cases += r.cases;
    else out.set(r.productCode, { ...r });
  }
  return [...out.values()].sort(byCode);
}

function splitText(s: DetailStop): string | null {
  if (!s.split) return null;
  // The rest of the customer's cases is on the unserved list ("part 1 of 1" alone would say all of it).
  return `part ${s.split.part} of ${s.split.parts}${s.split.restUnserved ? ' - the rest is NOT on a truck today' : ''}`;
}

/**
 * One stop's invoices: its order lines grouped by invoice number, in the order first seen. Cancel
 * order (owner request 12 Oct 2026): only the invoices of the stop's cancelled orders are marked
 * CANCELLED (a stop can hold several orders of its customer); their lines are grouped apart.
 */
export function stopInvoices(s: DetailStop): LoadSheetInvoice[] {
  const gone = new Set(s.cancelledOrderIds ?? []);
  const by = new Map<string, { invoiceNo: string; cancelled: boolean; rows: ProductCases[] }>();
  for (const ln of s.orderLines) {
    const invoiceNo = ln.salesOrderNo?.trim() || NO_INVOICE;
    const cancelled = gone.has(ln.orderId);
    const key = `${invoiceNo}|${cancelled ? 'C' : ''}`;
    const g = by.get(key) ?? { invoiceNo, cancelled, rows: [] };
    g.rows.push({ productCode: ln.productCode, productName: ln.productName, cases: ln.cases });
    by.set(key, g);
  }
  return [...by.values()].map(({ invoiceNo, cancelled, rows }) => {
    const lines = sumByProduct(rows);
    return {
      stop: s.sequence,
      invoiceNo,
      customerName: s.customerName,
      customerCode: s.customerCode,
      branchCode: s.branchCode,
      split: splitText(s),
      carried: cancelled ? CANCELLED_STOP_TEXT : carriedStopText({ carriedFrom: s.carriedFrom, carriedTo: s.carriedTo }),
      lines,
      cases: lines.reduce((a, l) => a + l.cases, 0),
    };
  });
}

function footer(l: DetailLoad, trips: number, d: PlanDetail, what: string): string {
  return `${what} · ${l.truckCode} trip ${l.loadNo} of ${trips} · delivery ${d.run.runDate} · plan v${d.run.version} - void if a newer plan version is issued`;
}

function wanted<T extends { id: string }>(loads: T[], loadIds?: string[]): T[] {
  if (!loadIds) return loads;
  const set = new Set(loadIds);
  return loads.filter((l) => set.has(l.id));
}

export function loadSheetModel(d: PlanDetail, opts: { tenantName: string; loadIds?: string[] }): LoadSheetModel {
  const trips = tripsByTruck(d.loads);
  const sheets = wanted(d.loads, opts.loadIds).map((l): LoadSheet => {
    const n = trips.get(l.truckId) ?? 1;
    const stops = [...l.stops].sort((a, b) => a.sequence - b.sequence);
    const invoices = stops.flatMap(stopInvoices);
    const products = sumByProduct(l.manifest.map((m) => ({ productCode: m.productCode, productName: m.productName, cases: m.cases })));
    const totalCases = products.reduce((a, p) => a + p.cases, 0);
    const p = loadPallets(l);
    return {
      loadId: l.id,
      truckCode: l.truckCode,
      trip: l.loadNo,
      trips: n,
      status: l.status,
      statusText: STATUS_TEXT[l.status] ?? l.status,
      notLocked: l.status === 'PLANNED',
      driverName: l.driverName,
      depart: fmtHhmm(l.departMin),
      back: fmtHhmm(l.returnMin),
      products,
      totalCases,
      pallets: p ? palletsOverBays(p) : null,
      invoices,
      matches: invoices.reduce((a, i) => a + i.cases, 0) === totalCases,
      carriedAway: l.carriedAway,
      cancelledHere: l.cancelledHere ?? 0,
      carriedToDays: carriedToDays(stops.map((s) => s.carriedTo).filter((x): x is string => !!x)),
      footer: footer(l, n, d, 'Load sheet'),
    };
  });
  return { ...head(d, opts.tenantName, 'Load sheets'), sheets };
}

/** "15:58" in the company's time zone, from an ISO instant. */
function localHhmm(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const h = parts.find((x) => x.type === 'hour')?.value ?? '00';
  const m = parts.find((x) => x.type === 'minute')?.value ?? '00';
  return `${h}:${m}`;
}

function returnStop(s: DetailStop, o: OverlayStop | undefined): ReturnStop {
  const names = new Map(s.orderLines.map((ln) => [ln.productCode, ln.productName]));
  const invoices = [...new Set(s.orderLines.map((ln) => ln.salesOrderNo?.trim() || NO_INVOICE))];
  const base = {
    stop: s.sequence,
    customerName: s.customerName,
    customerCode: s.customerCode,
    branchCode: s.branchCode,
    invoices,
  };
  // No result yet (or no visit at all): the planned lines, nothing known about what came back.
  if (!o || !o.outcome) {
    const lines = sumByProduct(s.orderLines.map((ln) => ({ productCode: ln.productCode, productName: ln.productName, cases: ln.cases }))).map(
      (p): ReturnLine => ({ productCode: p.productCode, productName: p.productName, planned: p.cases, delivered: null, returned: null }),
    );
    return { ...base, result: 'NO RESULT', noResult: true, reason: null, lines, planned: s.cases, delivered: null, returned: null };
  }
  // The visit's lines say what was planned and delivered per order line (readVisitLines). A line
  // without a delivered figure counts as delivered, as Bring forward counts it (notDeliveredOf);
  // Not delivered is nothing delivered.
  const per = new Map<string, ReturnLine>();
  for (const vl of o.lines) {
    const planned = vl.plannedCases;
    const delivered = o.outcome === 'NOT_DELIVERED' ? 0 : Math.min(planned, Math.max(0, vl.deliveredCases ?? planned));
    const row = per.get(vl.productCode) ?? { productCode: vl.productCode, productName: names.get(vl.productCode) ?? vl.productCode, planned: 0, delivered: 0, returned: 0 };
    row.planned += planned;
    row.delivered = (row.delivered ?? 0) + delivered;
    row.returned = (row.returned ?? 0) + Math.max(0, planned - delivered);
    per.set(vl.productCode, row);
  }
  const lines = [...per.values()].sort(byCode);
  const planned = lines.reduce((a, l) => a + l.planned, 0) || o.casesPlanned;
  const delivered = lines.length ? lines.reduce((a, l) => a + (l.delivered ?? 0), 0) : (o.casesDelivered ?? 0);
  const returned = Math.max(0, planned - delivered);
  return {
    ...base,
    result: OUTCOME_LABEL[o.outcome] ?? o.outcome,
    noResult: false,
    reason: o.outcome === 'DELIVERED' ? null : o.reasonText || reasonText(o.reason, o.note) || null,
    lines,
    planned,
    delivered,
    returned,
  };
}

export function returnNoteModel(d: PlanDetail, overlay: OutcomeOverlay, opts: { tenantName: string; loadIds?: string[] }): ReturnNoteModel {
  const trips = tripsByTruck(d.loads);
  const notes = wanted(
    d.loads.filter((l) => RETURN_NOTE_STATUSES.has(l.status)),
    opts.loadIds,
  ).map((l): ReturnNote => {
    const n = trips.get(l.truckId) ?? 1;
    const stops = [...l.stops].sort((a, b) => a.sequence - b.sequence).map((s) => returnStop(s, overlay.stops[`${l.id}:${s.sequence}`]));
    const ol = overlay.loads[l.id];
    const backAtIso = ol?.backAtDepotAt ?? null;
    const returnedByProduct = sumByProduct(
      stops.flatMap((s) => s.lines.filter((x) => (x.returned ?? 0) > 0).map((x) => ({ productCode: x.productCode, productName: x.productName, cases: x.returned ?? 0 }))),
    );
    return {
      loadId: l.id,
      truckCode: l.truckCode,
      trip: l.loadNo,
      trips: n,
      status: l.status,
      driverName: l.driverName,
      depart: fmtHhmm(l.departMin),
      backAt: backAtIso ? localHhmm(backAtIso, overlay.tz) : null,
      notBack: !backAtIso && l.status !== 'COMPLETED',
      stops,
      returnStops: stops.filter((s) => s.noResult || (s.returned ?? 0) > 0),
      returnedByProduct,
      totalPlanned: stops.reduce((a, s) => a + s.planned, 0),
      totalDelivered: stops.reduce((a, s) => a + (s.delivered ?? 0), 0),
      totalReturned: returnedByProduct.reduce((a, p) => a + p.cases, 0),
      noResultStops: stops.filter((s) => s.noResult).length,
      footer: footer(l, n, d, 'Return note'),
    };
  });
  return { ...head(d, opts.tenantName, 'Return notes'), notes };
}
