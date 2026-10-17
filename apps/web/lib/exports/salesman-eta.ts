/**
 * Salesman ETA (owner request 17 Oct 2026). Every evening after planning the owner prints one page per
 * SALES ROUTE (salesman) with that salesman's customers in the next day's plan and the window in which
 * the truck should reach each of them, so the salesmen can tell their customers to be ready to receive
 * and sign. Until now an offline tool made these pages from the order file and the plan; this is the
 * same as a button on the plan screen (GET /api/runs/:id/export/salesman-eta).
 *
 * Built from the plan screen's own object (getPlanDetail, as the warehouse load sheets are) plus the
 * facts it does not carry: each order line's sales route (OrderLine.salesRoute, the order file's "route"
 * column) and its product's cases per pallet, and whether an order was cancelled or brought forward to
 * another day (loadSalesmanEtaFacts, the one database read here). In two steps like the load sheets:
 * salesmanEtaModel is pure and unit-tested; salesman-eta-html.ts lays it out as one printable A4 page.
 *
 * What the pages hold, on purpose:
 *  - page 1, the day: the day's totals and one row per sales route (customers, invoices, cases, pallets,
 *    and how many trucks and loads carry the route's invoices). No per-truck table, and no driver name
 *    or phone anywhere: the pages go to the salesmen (and on to the customers), not to the drivers.
 *  - one page per route: its customers sorted by the first expected arrival, each with its invoices, its
 *    cases of THAT route only, a map link of the stop's pin and its receiving hours; a customer the plan
 *    splits over several stops has one arrival line per part. Orders of the route that are on no stop of
 *    the plan (left out, brought forward to another day, or added after the plan was made) are listed
 *    under the table; cancelled orders are left out. Lines without a route form the "Route not given" page.
 */
import type { tenantDb } from '../tenant';
import type { DetailLoad, DetailStop, PlanDetail } from '../dispatch/plan-detail';
import { compareSalesRoutes, NO_SALES_ROUTE } from '../dispatch/sales-route';
import { palletText, palletUnits, validPalletFactor } from '../dispatch/pallets';
import { dateOnly, DEFAULT_TZ, fmtDayMonth, fmtHhmm, isoOf, localDateIso, localMinutes } from '../dispatch/time';
import { carriedLoadShows } from '../dispatch/carry-view';
import { isSupersededRun } from '../dispatch/plan-status';
import { kmLabelFor } from '../dispatch/costs';
import { NO_INVOICE } from '../dispatch/warehouse-sheets';
import { NOT_CANCELLED } from '../dispatch/order-cancel-rules';
import { findInParts } from '../in-parts';

// ---------------------------------------------------------------------------------------
// The expected arrival window
// ---------------------------------------------------------------------------------------

/** The window's grid: arrival windows start and end on a quarter hour. */
export const SLOT_GRID_MIN = 15;
/** How far before the planned arrival the window opens (then down to the grid). */
export const SLOT_BEFORE_MIN = 15;
/** How far after the planned arrival the window closes (then up to the grid): traffic and earlier customers make a truck later, rarely earlier. */
export const SLOT_AFTER_MIN = 45;

/** Receiving hours (or the order's promised time) as minutes from midnight; null = open from midnight / until midnight. */
export interface EtaWindow {
  opens: number | null;
  closes: number | null;
}

/**
 * The expected arrival window of a planned arrival `eta` (minutes from midnight), as the owner's offline
 * tool worked it out:
 *   from = the quarter hour at or before eta - 15 min, to = the quarter hour at or after eta + 45 min;
 * then kept inside the stop's hours `w` (the order's promised time when it has one, else the receiving
 * hours the stop was planned with): a truck planned after opening is never announced before opening
 * (from = max(from, opens)), and a truck planned by closing is never announced after closing - but the
 * window always reaches the quarter hour at or after the planned arrival (to = min(to, max(closes,
 * that quarter hour))). An arrival planned before opening (the truck waits) or after closing is not
 * clipped on that side. Never before midnight.
 */
export function etaSlot(eta: number, w: EtaWindow | null = null): { from: number; to: number } {
  const g = SLOT_GRID_MIN;
  let from = Math.floor((eta - SLOT_BEFORE_MIN) / g) * g;
  let to = Math.ceil((eta + SLOT_AFTER_MIN) / g) * g;
  if (w && w.opens !== null && w.opens <= eta) from = Math.max(from, w.opens);
  if (w && w.closes !== null && eta <= w.closes) to = Math.min(to, Math.max(w.closes, Math.ceil(eta / g) * g));
  return { from: Math.max(0, from), to };
}

/** "07:45-09:00": an ASCII hyphen, so the page reads the same printed, copied or sent on. */
export function hhmmRange(from: number | null, to: number | null): string {
  return `${from === null ? '00:00' : fmtHhmm(from)}-${to === null ? '24:00' : fmtHhmm(to)}`;
}

/** The hours a stop's window is kept inside: the order's promised time when it has one, else the hard receiving hours it was planned with. */
export function stopWindow(s: Pick<DetailStop, 'promisedWindow' | 'plannedHours'>): EtaWindow | null {
  if (s.promisedWindow && (s.promisedWindow.startMin !== null || s.promisedWindow.endMin !== null)) {
    return { opens: s.promisedWindow.startMin, closes: s.promisedWindow.endMin };
  }
  const h = s.plannedHours;
  if (h && (h.hardStart !== null || h.hardEnd !== null)) return { opens: h.hardStart, closes: h.hardEnd };
  return null;
}

// ---------------------------------------------------------------------------------------
// The facts the plan detail does not carry
// ---------------------------------------------------------------------------------------

/** One order line, by its id (DetailOrderLine.lineId). */
export interface EtaLineFacts {
  orderId: string;
  /** OrderLine.salesRoute (already normalised); null = no route given. */
  salesRoute: string | null;
  /** The product's cases per pallet as it is now (Products); null / invalid = unknown. */
  casesPerPallet: number | null;
  /** The whole line's cases (an order on no stop is listed with these). */
  cases: number;
  salesOrderNo: string | null;
}

export interface EtaOrderFacts {
  cancelled: boolean;
  /** Brought forward (or postponed) to this day since (YYYY-MM-DD); null = not. */
  carriedTo: string | null;
}

/** An order of the day the plan does not hold yet (uploaded or recorded after the plan was made). */
export interface EtaPendingOrder {
  orderId: string;
  customerId: string;
  customerCode: string;
  branchCode: string | null;
  customerName: string;
}

export interface SalesmanEtaFacts {
  lines: ReadonlyMap<string, EtaLineFacts>;
  orders: ReadonlyMap<string, EtaOrderFacts>;
  pending: readonly EtaPendingOrder[];
}

/** The reads loadSalesmanEtaFacts makes: the request's tenant-scoped client (a type-only import: this module loads no database code). */
export type EtaDb = Pick<ReturnType<typeof tenantDb>, 'order' | 'orderLine'>;

/**
 * The facts of every order of the plan (on its stops or left unserved) and of the day's orders added
 * after it, through `db` (tenantDb(tenantId): every Order read is the company's; OrderLine has no
 * tenantId of its own, so its reads name the company through its order). Read after getPlanDetail, not
 * in its snapshot: an order cancelled or added in between shows as it is now, which is what a salesman
 * should be told. The lists are asked for in parts (IN_LIST_PART), however many orders the day has.
 */
export async function loadSalesmanEtaFacts(db: EtaDb, tenantId: string, d: PlanDetail): Promise<SalesmanEtaFacts> {
  const inPlan = new Set<string>([...d.loads.flatMap((l) => l.stops.flatMap((s) => s.orderIds)), ...d.unserved.map((u) => u.orderId)]);
  // The day's orders the plan does not hold yet: only for the version in use that says it has some
  // (PlanDetail.pendingOrders: 0 on a replaced version). Read as the plan screen counts them (the day's
  // orders of the depot not brought forward and not cancelled), then the plan's own left out in the program.
  let pending: EtaPendingOrder[] = [];
  if ((d.pendingOrders ?? 0) > 0 && !isSupersededRun(d.run)) {
    const day = await db.order.findMany({
      where: { tenantId, depotId: d.run.depot.id, deliveryDate: dateOnly(d.run.runDate), carriedToOrderId: null, ...NOT_CANCELLED },
      select: { id: true, customerId: true, customer: { select: { code: true, branchCode: true, name: true } } },
    });
    pending = day
      .filter((o) => !inPlan.has(o.id))
      .map((o) => ({ orderId: o.id, customerId: o.customerId, customerCode: o.customer.code, branchCode: o.customer.branchCode, customerName: o.customer.name }));
  }
  const ids = [...new Set([...inPlan, ...pending.map((p) => p.orderId)])];
  const lineRows = await findInParts(ids, (part) =>
    db.orderLine.findMany({
      where: { orderId: { in: part }, order: { tenantId } },
      select: { id: true, orderId: true, cases: true, salesOrderNo: true, salesRoute: true, product: { select: { casesPerPallet: true } } },
    }),
  );
  const orderRows = await findInParts(ids, (part) =>
    db.order.findMany({
      where: { tenantId, id: { in: part } },
      select: { id: true, cancelledAt: true, carriedTo: { select: { deliveryDate: true } } },
    }),
  );
  return {
    lines: new Map(
      lineRows.map((l) => [l.id, { orderId: l.orderId, salesRoute: l.salesRoute ?? null, casesPerPallet: l.product?.casesPerPallet ?? null, cases: l.cases, salesOrderNo: l.salesOrderNo }]),
    ),
    orders: new Map(orderRows.map((o) => [o.id, { cancelled: !!o.cancelledAt, carriedTo: o.carriedTo ? isoOf(o.carriedTo.deliveryDate) : null }])),
    pending,
  };
}

// ---------------------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------------------

/** One delivery of a customer (a stop of the plan) with the route's cases on it. */
export interface EtaPart {
  /** "07:45-09:00"; null when the plan has no time for the stop. */
  window: string | null;
  /** "08:05", the planned arrival; null = not planned. */
  planned: string | null;
  cases: number;
  /** "part 1 of 2" when the customer has more than one delivery in the plan; null = one. */
  part: string | null;
}

export interface EtaRow {
  no: number;
  customerName: string;
  customerCode: string;
  branchCode: string | null;
  /** The route's invoice numbers on these deliveries (NO_INVOICE for lines without one). */
  invoices: string[];
  /** The route's cases only (a customer can buy from two salesmen). */
  cases: number;
  parts: EtaPart[];
  /** "Open map" of the stop's pin (https://www.google.com/maps?q=lat,lng); null = no location. */
  mapUrl: string | null;
  /**
   * The receiving hours the stop was planned with, "06:00-14:00", or "any time" (none, open all day);
   * null when the only hours known are the order's own time (`orderTime`).
   */
  hours: string | null;
  /** "this order: 10:00-11:00" when an order of the stop has its own delivery time; else null. */
  orderTime: string | null;
  /** More of the customer's cases are on no truck today (a split delivery's rest); else null. */
  note: string | null;
}

/** An order of the route on no stop of the plan. */
export interface EtaNotPlanned {
  customerName: string;
  customerCode: string;
  branchCode: string | null;
  invoices: string[];
  cases: number;
  /** "left out of the plan", "moved to 19 Oct", "added after this plan was made". */
  why: string;
}

/** Pallets as the pages print them: one decimal, "+" when some lines have no cases per pallet. */
export interface EtaPallets {
  /** 1/1000 pallet (pallets.ts units), the lines with a cases per pallet only. */
  units: number;
  /** Some lines' products have no cases per pallet: their cases are not in `units`. */
  partial: boolean;
}

export interface EtaRouteRow {
  route: string | null;
  label: string;
  customers: number;
  invoices: number;
  cases: number;
  pallets: EtaPallets;
  trucks: number;
  loads: number;
}

export interface EtaSection {
  route: string | null;
  /** "Route R1 · deliveries Sunday 18 October 2026". */
  heading: string;
  customers: number;
  cases: number;
  /** A load with this route's customers is not locked yet: times can change if the day is re-planned. */
  notLocked: boolean;
  rows: EtaRow[];
  notPlanned: EtaNotPlanned[];
}

export interface SalesmanEtaModel {
  title: string;
  tenantName: string;
  depot: { code: string; name: string };
  runDate: string;
  /** "Sunday 18 October 2026". */
  dayText: string;
  version: number;
  /** "17 Oct 2026 21:40" in the company's time zone. */
  printedAt: string;
  /** A newer plan version exists: these pages are void. */
  superseded: boolean;
  /** Not every load with stops is locked, loading, dispatched or completed. */
  notLocked: boolean;
  day: {
    trucks: number;
    loads: number;
    customers: number;
    invoices: number;
    cases: number;
    pallets: EtaPallets;
    avgUtilizationPct: number;
    km: number;
    kmLabel: string;
  };
  routes: EtaRouteRow[];
  total: { customers: number; invoices: number; cases: number; pallets: EtaPallets; trucks: number; loads: number };
  sections: EtaSection[];
}

/** Loads that can no longer change when the day is re-planned. */
const FIXED_STATUSES: ReadonlySet<string> = new Set(['LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED']);

export const NOT_LOCKED_NOTE = 'Not locked yet: times can change if the day is re-planned';
export const NOT_PLANNED_HEADING = 'Not in the plan for this day (the office will advise)';
export const ARRIVAL_NOTE =
  'Expected arrival = the window in which the truck should reach the customer (planned time minus 15 minutes to plus 45 minutes, within the receiving hours). Traffic and waiting at earlier customers can make it later. Please inform each customer and make sure someone is there to receive and sign the invoice.';
export const PALLETS_FOOTNOTE = '+ = some products have no cases per pallet under Products: their cases are not counted in the pallets shown.';
export const REST_NOT_PLANNED_NOTE = 'More of this customer\'s cases are not on a truck on this day (the office will advise).';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-10-18" -> "Sunday 18 October 2026". */
export function longDayText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  return `${WEEKDAYS[day]} ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** "12.4", or "12.4+" when some lines have no cases per pallet. */
export function etaPalletsText(p: EtaPallets): string {
  return `${palletText(p.units)}${p.partial ? '+' : ''}`;
}

const addPallets = (a: EtaPallets, b: EtaPallets): EtaPallets => ({ units: a.units + b.units, partial: a.partial || b.partial });
const routeLabel = (route: string | null) => route ?? NO_SALES_ROUTE;
const invoiceText = (so: string | null | undefined) => so?.trim() || NO_INVOICE;
/** One invoice: its number (letter case aside), or the order for lines without one. */
const invoiceKey = (so: string | null | undefined, orderId: string) => (so?.trim() ? `so:${so.trim().toUpperCase()}` : `order:${orderId}`);
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A customer of one route while its rows are gathered. */
interface RowAcc {
  customerId: string;
  customerName: string;
  customerCode: string;
  branchCode: string | null;
  invoices: Set<string>;
  parts: { stop: DetailStop; load: DetailLoad; cases: number }[];
}

interface RouteAcc {
  rows: Map<string, RowAcc>;
  invoiceKeys: Set<string>;
  pallets: EtaPallets;
  loads: Set<string>;
  trucks: Set<string>;
  notLocked: boolean;
  notPlanned: Map<string, EtaNotPlanned>;
}

export function salesmanEtaModel(d: PlanDetail, facts: SalesmanEtaFacts, opts: { tenantName: string; now: Date }): SalesmanEtaModel {
  const routes = new Map<string | null, RouteAcc>();
  const accOf = (route: string | null): RouteAcc => {
    let a = routes.get(route);
    if (!a) {
      a = { rows: new Map(), invoiceKeys: new Set(), pallets: { units: 0, partial: false }, loads: new Set(), trucks: new Set(), notLocked: false, notPlanned: new Map() };
      routes.set(route, a);
    }
    return a;
  };
  /** Lines of an order on no stop, listed under the route's table (one entry per order and route). */
  const listNotPlanned = (
    orderId: string,
    who: { customerName: string; customerCode: string; branchCode: string | null },
    lines: { salesRoute: string | null; salesOrderNo: string | null; cases: number }[],
    why: string,
  ) => {
    for (const ln of lines) {
      const a = accOf(ln.salesRoute);
      const key = `${orderId}|${why}`;
      const e = a.notPlanned.get(key) ?? { customerName: who.customerName, customerCode: who.customerCode, branchCode: who.branchCode, invoices: [], cases: 0, why };
      const inv = invoiceText(ln.salesOrderNo);
      if (!e.invoices.includes(inv)) e.invoices.push(inv);
      e.cases += ln.cases;
      a.notPlanned.set(key, e);
    }
  };
  const linesByOrder = new Map<string, EtaLineFacts[]>();
  for (const l of facts.lines.values()) {
    const list = linesByOrder.get(l.orderId);
    if (list) list.push(l);
    else linesByOrder.set(l.orderId, [l]);
  }
  const linesOfOrder = (orderId: string) => linesByOrder.get(orderId) ?? [];

  // The stops: each order line of each stop goes to its route's customer, except lines of a cancelled
  // order (left out) and of an order brought forward to another day from a load that has not left (it is
  // not delivered on this day: listed under the table).
  const stopOrderIds = new Set<string>();
  const loadsWithStops = d.loads.filter((l) => l.stops.length > 0);
  for (const load of loadsWithStops) {
    for (const stop of load.stops) {
      for (const id of stop.orderIds) stopOrderIds.add(id);
      const cancelled = new Set(stop.cancelledOrderIds ?? []);
      const byRoute = new Map<string | null, number>();
      const movedOrders = new Map<string, { salesRoute: string | null; salesOrderNo: string | null; cases: number }[]>();
      for (const ln of stop.orderLines) {
        const order = facts.orders.get(ln.orderId);
        // Cancelled as the plan read it, or since (the facts are read after it); only a load that never
        // left can hold a cancelled order (the plan detail's rule).
        if (cancelled.has(ln.orderId) || (order?.cancelled && carriedLoadShows(load.status))) continue;
        const f = facts.lines.get(ln.lineId);
        const route = f?.salesRoute ?? null;
        if (order?.carriedTo && carriedLoadShows(load.status)) {
          movedOrders.set(ln.orderId, [...(movedOrders.get(ln.orderId) ?? []), { salesRoute: route, salesOrderNo: ln.salesOrderNo, cases: ln.cases }]);
          continue;
        }
        const a = accOf(route);
        let row = a.rows.get(stop.customerId);
        if (!row) {
          row = { customerId: stop.customerId, customerName: stop.customerName, customerCode: stop.customerCode, branchCode: stop.branchCode, invoices: new Set(), parts: [] };
          a.rows.set(stop.customerId, row);
        }
        row.invoices.add(invoiceText(ln.salesOrderNo));
        a.invoiceKeys.add(invoiceKey(ln.salesOrderNo, ln.orderId));
        const cpp = validPalletFactor(f?.casesPerPallet ?? null);
        a.pallets = addPallets(a.pallets, { units: palletUnits(ln.cases, cpp), partial: cpp === null && ln.cases > 0 });
        a.loads.add(load.id);
        a.trucks.add(load.truckId);
        if (!FIXED_STATUSES.has(load.status)) a.notLocked = true;
        byRoute.set(route, (byRoute.get(route) ?? 0) + ln.cases);
      }
      for (const [route, cases] of byRoute) {
        const row = routes.get(route)!.rows.get(stop.customerId)!;
        row.parts.push({ stop, load, cases });
      }
      for (const [orderId, lines] of movedOrders) {
        listNotPlanned(orderId, stop, lines, `moved to ${fmtDayMonth(facts.orders.get(orderId)!.carriedTo!)}`);
      }
    }
  }

  // Orders the plan left out (unserved) and that are on no stop; cancelled ones are left out.
  for (const u of d.unserved) {
    if (u.cancelled || stopOrderIds.has(u.orderId) || facts.orders.get(u.orderId)?.cancelled) continue;
    const carriedTo = u.carriedTo ?? facts.orders.get(u.orderId)?.carriedTo ?? null;
    listNotPlanned(u.orderId, u, linesOfOrder(u.orderId), carriedTo ? `moved to ${fmtDayMonth(carriedTo)}` : 'left out of the plan');
  }
  // Orders of the day added after the plan was made (the plan screen's "pending" orders).
  for (const p of facts.pending) {
    if (facts.orders.get(p.orderId)?.cancelled) continue;
    listNotPlanned(p.orderId, p, linesOfOrder(p.orderId), 'added after this plan was made');
  }

  const dayText = longDayText(d.run.runDate);
  const order = [...routes.keys()].sort(compareSalesRoutes);
  const sections: EtaSection[] = [];
  const routeRows: EtaRouteRow[] = [];
  const allCustomers = new Set<string>();
  const allInvoices = new Set<string>();
  for (const route of order) {
    const a = routes.get(route)!;
    const rows = [...a.rows.values()].map((r) => buildRow(r));
    rows.sort(
      (x, y) =>
        (x.firstEta ?? Number.POSITIVE_INFINITY) - (y.firstEta ?? Number.POSITIVE_INFINITY) ||
        byText(x.row.customerCode, y.row.customerCode) ||
        byText(x.row.branchCode ?? '', y.row.branchCode ?? ''),
    );
    const cases = rows.reduce((s, r) => s + r.row.cases, 0);
    for (const r of a.rows.keys()) allCustomers.add(r);
    for (const k of a.invoiceKeys) allInvoices.add(k);
    routeRows.push({ route, label: routeLabel(route), customers: rows.length, invoices: a.invoiceKeys.size, cases, pallets: a.pallets, trucks: a.trucks.size, loads: a.loads.size });
    sections.push({
      route,
      heading: `${route === null ? NO_SALES_ROUTE : `Route ${route}`} · deliveries ${dayText}`,
      customers: rows.length,
      cases,
      notLocked: a.notLocked,
      rows: rows.map((r, i) => ({ ...r.row, no: i + 1 })),
      notPlanned: [...a.notPlanned.values()].sort((x, y) => byText(x.customerCode, y.customerCode) || byText(x.branchCode ?? '', y.branchCode ?? '') || byText(x.why, y.why)),
    });
  }

  const dayTrucks = new Set(loadsWithStops.map((l) => l.truckId)).size;
  const dayPallets = routeRows.reduce((p, r) => addPallets(p, r.pallets), { units: 0, partial: false } as EtaPallets);
  const s = d.summary;
  const mean = loadsWithStops.length ? Math.round((loadsWithStops.reduce((t, l) => t + l.utilizationPct, 0) / loadsWithStops.length) * 10) / 10 : 0;
  const km = Math.round(loadsWithStops.reduce((t, l) => t + l.distanceKm, 0) * 10) / 10;
  const tz = d.timezone || DEFAULT_TZ;
  const printedIso = localDateIso(opts.now, tz);
  return {
    title: `Salesman ETA ${d.run.runDate} v${d.run.version}`,
    tenantName: opts.tenantName,
    depot: { code: d.run.depot.code, name: d.run.depot.name },
    runDate: d.run.runDate,
    dayText,
    version: d.run.version,
    printedAt: `${fmtDayMonth(printedIso)} ${printedIso.slice(0, 4)} ${fmtHhmm(localMinutes(opts.now, tz))}`,
    superseded: isSupersededRun(d.run),
    notLocked: loadsWithStops.some((l) => !FIXED_STATUSES.has(l.status)),
    day: {
      trucks: dayTrucks,
      loads: loadsWithStops.length,
      customers: allCustomers.size,
      invoices: allInvoices.size,
      cases: routeRows.reduce((t, r) => t + r.cases, 0),
      pallets: dayPallets,
      // As the plan screen shows the day (its KPI row reads the plan summary); counted from the loads
      // for a plan without one.
      avgUtilizationPct: s ? s.avgUtilizationPct : mean,
      km: s ? s.totalKm : km,
      kmLabel: kmLabelFor({
        distanceIsEstimated: s ? !!s.distanceIsEstimated : loadsWithStops.some((l) => l.distanceIsEstimated),
        estimatedLegs: s?.estimatedLegs,
        estimatedLoads: s?.estimatedLoads,
      }),
    },
    routes: routeRows,
    total: {
      customers: routeRows.reduce((t, r) => t + r.customers, 0),
      invoices: routeRows.reduce((t, r) => t + r.invoices, 0),
      cases: routeRows.reduce((t, r) => t + r.cases, 0),
      pallets: dayPallets,
      // The day's own counts: a truck carrying two routes is one truck.
      trucks: dayTrucks,
      loads: loadsWithStops.length,
    },
    sections,
  };
}

/** A customer's row of one route: its deliveries in arrival order, each with its window. */
function buildRow(r: RowAcc): { row: Omit<EtaRow, 'no'>; firstEta: number | null } {
  const parts = [...r.parts].sort(
    (a, b) =>
      (a.stop.etaMin ?? Number.POSITIVE_INFINITY) - (b.stop.etaMin ?? Number.POSITIVE_INFINITY) ||
      byText(a.load.truckCode, b.load.truckCode) ||
      a.load.loadNo - b.load.loadNo ||
      a.stop.sequence - b.stop.sequence,
  );
  const first = parts[0]!.stop;
  const promised = parts.map((p) => p.stop.promisedWindow).find((w) => w && (w.startMin !== null || w.endMin !== null)) ?? null;
  const hard = first.plannedHours && (first.plannedHours.hardStart !== null || first.plannedHours.hardEnd !== null) ? hhmmRange(first.plannedHours.hardStart, first.plannedHours.hardEnd) : null;
  const orderTime = promised ? hhmmRange(promised.startMin, promised.endMin) : null;
  return {
    firstEta: first.etaMin,
    row: {
      customerName: r.customerName,
      customerCode: r.customerCode,
      branchCode: r.branchCode,
      invoices: [...r.invoices],
      cases: parts.reduce((t, p) => t + p.cases, 0),
      parts: parts.map((p, i) => {
        const eta = p.stop.etaMin;
        const slot = eta === null ? null : etaSlot(eta, stopWindow(p.stop));
        return {
          window: slot ? hhmmRange(slot.from, slot.to) : null,
          planned: eta === null ? null : fmtHhmm(eta),
          cases: p.cases,
          part: parts.length > 1 ? `part ${i + 1} of ${parts.length}` : null,
        };
      }),
      mapUrl: first.lat !== null && first.lng !== null ? `https://www.google.com/maps?q=${first.lat},${first.lng}` : null,
      // With a promised time the stop was planned with that time as its hours (plannedHours): only the
      // order's own line is printed then; "any time" when there are no hours and no time of the order.
      hours: hard && hard !== orderTime ? hard : orderTime ? null : 'any time',
      orderTime: orderTime ? `this order: ${orderTime}` : null,
      note: parts.some((p) => p.stop.split?.restUnserved) ? REST_NOT_PLANNED_NOTE : null,
    },
  };
}
