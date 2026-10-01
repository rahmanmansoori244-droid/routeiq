/**
 * Data collection rules (owner decisions of 1 Oct 2026), items 3, 4 and 6. Pure: no server imports,
 * so the screens, the routes and the tests share every rule and every word.
 *
 *  - Item 3, loading gate: with the company setting "Require location and delivery window before
 *    loading" on, LOCK, LOADING and DISPATCH of a load are refused while a customer on it has no usable
 *    location (`locationBlocksDelivery`), or neither its own confirmed receiving hours nor a delivery
 *    time on one of its orders on that load (`dataGaps`). Planning is never refused by it.
 *  - Item 4, data to collect: customers with open orders from today to N days ahead that miss a usable
 *    location or their own confirmed receiving hours (`buildWorklist`), counted per depot and per day.
 *  - Item 6, daily customer master: one row per customer (`masterValues`, MASTER_COLUMNS) that the
 *    customer import reads back; what changed since a date (`changeSummary`); and the import's
 *    receiving-hours columns (`readImportedHours`).
 */
import { DEFAULT_SERVICE_AREA, type ServiceArea } from './location-input';
import {
  effectiveAttrs,
  locationBlocksDelivery,
  locationIssue,
  windowLabel,
  type AttrSource,
  type CustomerForPlanning,
  type TypeProfileLike,
} from './customer-attrs';
import { addDaysIso, fmtDayMonth, fmtHhmm, localDateIso, localMinutes, parseHhmm, zonedDayStart } from './time';

// ---------------------------------------------------------------------------------------------
// Item 3: the loading gate
// ---------------------------------------------------------------------------------------------

/** The rule a refused load is told about (and the Settings switch describes). */
export const DATA_GATE_RULE =
  'Company rule (Settings): no truck is locked, loaded or dispatched until every customer on it has a usable location and a delivery window.';

export interface GateCustomer {
  id: string;
  code: string;
  branchCode: string | null;
  name: string;
  lat: number | null;
  lng: number | null;
  locationVerified: boolean;
  geocodeConfidence?: string | null;
  /** Own confirmed receiving hours (item 2): set = confirmed by a dispatcher or admin. */
  windowConfirmedAt?: Date | string | null;
}

export interface GateOrder {
  customerId: string;
  deliveryStartMin: number | null;
  deliveryEndMin: number | null;
}

/** What a customer misses for loading: a usable location, a delivery window, or both. */
export interface DataGap {
  customerId: string;
  code: string;
  branchCode: string | null;
  name: string;
  location: boolean;
  window: boolean;
}

/** An own confirmed window (item 2): receiving hours a dispatcher or admin entered or confirmed (also "open all day"). */
export function hasOwnWindow(c: { windowConfirmedAt?: Date | string | null }): boolean {
  return c.windowConfirmedAt != null;
}

const byCode = (a: { code: string; branchCode: string | null }, b: { code: string; branchCode: string | null }) =>
  a.code.localeCompare(b.code) || (a.branchCode ?? '').localeCompare(b.branchCode ?? '');

/**
 * The customers of `orders` that miss data needed before loading: no usable location
 * (`locationBlocksDelivery`), or no delivery window - neither their own confirmed receiving hours nor
 * a delivery time (urgent / promised) on one of the orders given (all orders of a customer go in one
 * visit, which is planned inside that time). Sorted by code and branch. Company and customer-type
 * default hours do not count.
 */
export function dataGaps(customers: readonly GateCustomer[], orders: readonly GateOrder[], area: ServiceArea = DEFAULT_SERVICE_AREA): DataGap[] {
  const ordered = new Set(orders.map((o) => o.customerId));
  const timed = new Set(orders.filter((o) => o.deliveryStartMin != null || o.deliveryEndMin != null).map((o) => o.customerId));
  return customers
    .filter((c) => ordered.has(c.id))
    .map((c) => ({
      customerId: c.id,
      code: c.code,
      branchCode: c.branchCode,
      name: c.name,
      location: locationBlocksDelivery(c, area),
      window: !hasOwnWindow(c) && !timed.has(c.id),
    }))
    .filter((g) => g.location || g.window)
    .sort(byCode);
}

/** "location and delivery window" / "location" / "delivery window". */
export function gapText(g: Pick<DataGap, 'location' | 'window'>): string {
  if (g.location && g.window) return 'location and delivery window';
  return g.location ? 'location' : 'delivery window';
}

/** "C001 / B2 (Corner Shop Seeb)". */
export function customerRef(c: { code: string; branchCode: string | null; name: string }): string {
  return `${c.code}${c.branchCode ? ` / ${c.branchCode}` : ''} (${c.name})`;
}

const CONFIRM_HOURS =
  'Enter each customer\'s receiving hours in Details (Daily dispatch or the customer page) and tick "These hours are confirmed with the customer", or tick "Open all day"';

/** What to do about a missing delivery window, for the load as it is (a locked load's orders keep their times). */
export function windowGateRemedy(status: string): string {
  if (status === 'PLANNED') {
    return `${CONFIRM_HOURS}; or set a delivery time for the order under Delivery times (step 2). If the hours differ from the ones planned, RE-PLAN. Then try again.`;
  }
  if (status === 'LOCKED') {
    return `${CONFIRM_HOURS}, then try again. To give an order a delivery time instead, unlock this load (put it back to Planned), set the time under Delivery times, then RE-PLAN.`;
  }
  return `${CONFIRM_HOURS}, then try again.`;
}

/**
 * The refusal of LOCK / LOADING / DISPATCH under the loading gate: each customer and what it misses,
 * the rule, and the remedy for each kind of gap. `locationRemedy`: what to do about a missing
 * location for this load (plan-service noLocationLoadRemedy).
 */
export function dataGateRefusal(load: { truck: string; loadNo: number; status: string }, gaps: readonly DataGap[], locationRemedy: string): string {
  const shown = gaps.slice(0, 8).map((g) => `${customerRef(g)}: no ${gapText(g)}`);
  const more = gaps.length > 8 ? `; and ${gaps.length - 8} more` : '';
  const who = gaps.length === 1 ? '1 customer on this load misses' : `${gaps.length} customers on this load miss`;
  const remedies = [
    gaps.some((g) => g.window) ? `Delivery window: ${windowGateRemedy(load.status)}` : null,
    gaps.some((g) => g.location) ? `Location: ${locationRemedy}` : null,
  ].filter(Boolean);
  return `${load.truck} L${load.loadNo}: ${who} data needed before loading - ${shown.join('; ')}${more}. ${DATA_GATE_RULE} ${remedies.join(' ')}`;
}

// ---------------------------------------------------------------------------------------------
// Item 4: data to collect
// ---------------------------------------------------------------------------------------------

/** Days ahead of today the list looks by default (Settings "Data to collect: days ahead"). */
export const DATA_COLLECT_DAYS_DEFAULT = 3;
export const DATA_COLLECT_DAYS_MAX = 14;

export interface WorklistCustomer extends GateCustomer {
  regionCode: string | null;
  regionName: string | null;
  address: string | null;
  accessNotes: string | null;
  active: boolean;
}

/** One open order: its customer, its depot and its delivery date (YYYY-MM-DD). */
export interface WorklistOrder {
  customerId: string;
  depotId: string;
  deliveryDate: string;
}

export interface DepotRef {
  id: string;
  code: string;
  name: string;
}

export interface WorklistRow {
  customerId: string;
  code: string;
  branchCode: string | null;
  name: string;
  regionCode: string | null;
  regionName: string | null;
  address: string | null;
  accessNotes: string | null;
  /** Codes of the depots its open orders are delivered from. */
  depots: string[];
  location: boolean;
  window: boolean;
  /** "Location and receiving hours" / "Location" / "Receiving hours". */
  missing: string;
  /** The first delivery date of its open orders in the period (YYYY-MM-DD). */
  firstDelivery: string;
  orders: number;
  /** Why the location is not usable (the day card's words), when it is not. */
  locationNote: string | null;
}

export interface DepotCount {
  depotId: string;
  code: string;
  name: string;
  /** Customers with open orders from this depot in the period that miss data. */
  customers: number;
  location: number;
  window: number;
}

/** Per depot and delivery day: customers with open orders, and how many of them miss data. */
export interface DayCount {
  date: string;
  depotId: string;
  depotCode: string;
  customers: number;
  missing: number;
}

export interface Worklist {
  from: string;
  to: string;
  days: number;
  rows: WorklistRow[];
  perDepot: DepotCount[];
  perDay: DayCount[];
  total: { customers: number; location: number; window: number };
}

/** "Location and receiving hours" / "Location" / "Receiving hours": what a customer misses in the master. */
export function missingText(m: { location: boolean; window: boolean }): string {
  if (m.location && m.window) return 'Location and receiving hours';
  return m.location ? 'Location' : 'Receiving hours';
}

/** The period of the list: today to `days` days ahead (whole days, 0 to DATA_COLLECT_DAYS_MAX). */
export function worklistPeriod(today: string, days: number): { from: string; to: string; days: number } {
  const d = Number.isInteger(days) ? Math.min(Math.max(days, 0), DATA_COLLECT_DAYS_MAX) : DATA_COLLECT_DAYS_DEFAULT;
  return { from: today, to: addDaysIso(today, d), days: d };
}

/**
 * Item 4: the active customers with open orders in the period (`orders`: already only open orders of
 * that period) that miss a usable location or their own confirmed receiving hours. A delivery time on
 * an order lets that order be loaded, but the customer master still misses the hours, so the customer
 * stays on the list. Soonest delivery first, then code. Counts per depot (every depot given, also with
 * none) and per depot and day (customers with orders, and of them missing data).
 */
export function buildWorklist(
  customers: readonly WorklistCustomer[],
  orders: readonly WorklistOrder[],
  depots: readonly DepotRef[],
  opts: { from: string; to: string; days: number; area?: ServiceArea },
): Worklist {
  const area = opts.area ?? DEFAULT_SERVICE_AREA;
  const byId = new Map(customers.map((c) => [c.id, c]));
  const depotById = new Map(depots.map((d) => [d.id, d]));
  const gapOf = new Map<string, { location: boolean; window: boolean }>();
  for (const c of customers) {
    if (!c.active) continue;
    const location = locationBlocksDelivery(c, area);
    const window = !hasOwnWindow(c);
    if (location || window) gapOf.set(c.id, { location, window });
  }
  const mine = new Map<string, WorklistOrder[]>();
  for (const o of orders) {
    if (!byId.get(o.customerId)?.active) continue;
    mine.set(o.customerId, [...(mine.get(o.customerId) ?? []), o]);
  }
  const rows: WorklistRow[] = [];
  for (const [customerId, list] of mine) {
    const gap = gapOf.get(customerId);
    const c = byId.get(customerId);
    if (!gap || !c) continue;
    const depotCodes = [...new Set(list.map((o) => depotById.get(o.depotId)?.code ?? '?'))].sort();
    rows.push({
      customerId,
      code: c.code,
      branchCode: c.branchCode,
      name: c.name,
      regionCode: c.regionCode,
      regionName: c.regionName,
      address: c.address,
      accessNotes: c.accessNotes,
      depots: depotCodes,
      location: gap.location,
      window: gap.window,
      missing: missingText(gap),
      firstDelivery: list.map((o) => o.deliveryDate).sort()[0]!,
      orders: list.length,
      locationNote: gap.location ? (locationIssue(c, area)?.message ?? null) : null,
    });
  }
  rows.sort((a, b) => a.firstDelivery.localeCompare(b.firstDelivery) || byCode(a, b));
  const perDepot: DepotCount[] = depots.map((d) => {
    const ids = new Set(orders.filter((o) => o.depotId === d.id && gapOf.has(o.customerId) && byId.get(o.customerId)?.active).map((o) => o.customerId));
    const gaps = [...ids].map((id) => gapOf.get(id)!);
    return { depotId: d.id, code: d.code, name: d.name, customers: ids.size, location: gaps.filter((g) => g.location).length, window: gaps.filter((g) => g.window).length };
  });
  const perDay: DayCount[] = [];
  const cells = new Map<string, { all: Set<string>; missing: Set<string> }>();
  for (const o of orders) {
    if (!byId.get(o.customerId)?.active) continue;
    const key = `${o.deliveryDate}\u0000${o.depotId}`;
    const cell = cells.get(key) ?? { all: new Set<string>(), missing: new Set<string>() };
    cell.all.add(o.customerId);
    if (gapOf.has(o.customerId)) cell.missing.add(o.customerId);
    cells.set(key, cell);
  }
  for (const [key, cell] of cells) {
    const [date, depotId] = key.split('\u0000') as [string, string];
    perDay.push({ date, depotId, depotCode: depotById.get(depotId)?.code ?? '?', customers: cell.all.size, missing: cell.missing.size });
  }
  perDay.sort((a, b) => a.date.localeCompare(b.date) || a.depotCode.localeCompare(b.depotCode));
  return {
    from: opts.from,
    to: opts.to,
    days: opts.days,
    rows,
    perDepot,
    perDay,
    total: { customers: rows.length, location: rows.filter((r) => r.location).length, window: rows.filter((r) => r.window).length },
  };
}

// ---------------------------------------------------------------------------------------------
// Item 6: the daily customer master
// ---------------------------------------------------------------------------------------------

export interface MasterColumn {
  /** The header, as the customer import reads it (any case). */
  key: string;
  width: number;
  /** The customer import reads this column back (the others are for reading only). */
  imported: boolean;
  /** What it holds, for the "About this file" sheet. */
  text: string;
}

/**
 * The customer master's columns, in order. The `imported` ones are the customer import's own columns
 * (code, name and priority are required), so the downloaded file can be corrected and imported back;
 * a blank cell keeps what the customer has.
 */
export const MASTER_COLUMNS: readonly MasterColumn[] = [
  { key: 'code', width: 12, imported: true, text: 'Customer code (with branch_code: the customer).' },
  { key: 'branch_code', width: 10, imported: true, text: 'Branch. Blank = the main branch.' },
  { key: 'name', width: 32, imported: true, text: 'Customer name.' },
  { key: 'region_code', width: 10, imported: true, text: 'Region code (must exist).' },
  { key: 'region', width: 18, imported: false, text: 'Region name.' },
  { key: 'depot', width: 10, imported: false, text: "The region's depot." },
  { key: 'customer_type', width: 14, imported: false, text: 'Customer type (hypermarket, grocery, ...). Changed in Details.' },
  { key: 'priority', width: 8, imported: true, text: '1 (highest) to 5 (lowest). Required.' },
  { key: 'priority_confirmed', width: 9, imported: true, text: 'yes = confirmed. Blank = not confirmed yet: an unchanged priority stays as it is, a changed one is confirmed by you. no = store it without confirming.' },
  { key: 'priority_in_use', width: 26, imported: false, text: 'The priority planning uses, and where it comes from.' },
  { key: 'lat', width: 12, imported: true, text: 'Latitude of a usable location (at least 4 decimals). Blank when the location is missing or not usable: drop the pin.' },
  { key: 'lng', width: 12, imported: true, text: 'Longitude, as lat.' },
  { key: 'google_maps', width: 40, imported: false, text: 'The saved point on Google Maps.' },
  { key: 'location_status', width: 44, imported: false, text: 'Confirmed / usable, not confirmed / not usable (why) / missing.' },
  { key: 'location_source', width: 14, imported: false, text: 'Where the saved point came from.' },
  { key: 'location_confirmed_by', width: 16, imported: false, text: 'Who confirmed the location.' },
  { key: 'location_confirmed_at', width: 17, imported: false, text: 'When (company time).' },
  { key: 'hard_from', width: 9, imported: true, text: "The customer's own receiving hours - HARD (never outside): from, HH:MM." },
  { key: 'hard_to', width: 9, imported: true, text: 'HARD hours: to, HH:MM.' },
  { key: 'preferred_from', width: 9, imported: true, text: 'Preferred hours (soft): from, HH:MM.' },
  { key: 'preferred_to', width: 9, imported: true, text: 'Preferred hours: to, HH:MM.' },
  { key: 'open_all_day', width: 9, imported: true, text: 'yes = the customer accepts deliveries at any time (confirmed, no hours).' },
  { key: 'hours_confirmed', width: 9, imported: true, text: 'yes = the hours are confirmed with the customer. Blank = not confirmed yet: hours you enter or change are confirmed by you. no = store them without confirming.' },
  { key: 'receiving_hours', width: 40, imported: false, text: 'The hours planning uses, and where they come from.' },
  { key: 'hours_confirmed_by', width: 16, imported: false, text: 'Who confirmed the receiving hours.' },
  { key: 'hours_confirmed_at', width: 17, imported: false, text: 'When (company time).' },
  { key: 'avg_service_time_min', width: 10, imported: true, text: "Unloading minutes confirmed for this customer. Blank = the customer-type or Settings default." },
  { key: 'unloading_time', width: 30, imported: false, text: 'The unloading time planning uses, and where it comes from.' },
  { key: 'payment_type', width: 10, imported: true, text: 'cash / credit / prepaid.' },
  { key: 'address', width: 36, imported: true, text: 'Address.' },
  { key: 'active', width: 7, imported: false, text: 'yes / no. Changed on the Customers page.' },
  { key: 'created_at', width: 17, imported: false, text: 'When the customer was created (blank: before this was recorded).' },
  { key: 'updated_at', width: 17, imported: false, text: 'When the customer last changed (blank: not since this was recorded).' },
];

export interface MasterCustomer extends CustomerForPlanning {
  regionCode: string | null;
  regionName: string | null;
  depotCode: string | null;
  address: string | null;
  paymentType: string;
  active: boolean;
  locationSource: string | null;
  locationVerifiedAt: Date | null;
  locationVerifiedBy: string | null;
  windowConfirmedBy: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface MasterContext {
  area: ServiceArea;
  profiles: Map<string, TypeProfileLike>;
  serviceTimeMin: number;
  timezone: string;
}

export type MasterValue = string | number | null;

/** "2026-10-01 14:05" in the company's timezone; null stays null. */
export function localStamp(d: Date | null | undefined, tz: string): string | null {
  if (!d) return null;
  return `${localDateIso(d, tz)} ${fmtHhmm(localMinutes(d, tz))}`;
}

const SOURCE_WORDS: Record<AttrSource, string> = { CUSTOMER: 'confirmed for this customer', TYPE: 'customer type default', DEFAULT: 'company default' };

/** A usable location the import reads back as the same point: confirmed, or an exact (HIGH) one. */
function writesPoint(c: MasterCustomer, area: ServiceArea): boolean {
  if (c.lat === null || c.lng === null || locationBlocksDelivery(c, area)) return false;
  return c.locationVerified || c.geocodeConfidence === 'HIGH';
}

/** "Confirmed" / "Usable - not confirmed by a dispatcher" / "Not usable: ..." / "Missing". */
export function locationStatusText(c: Pick<MasterCustomer, 'lat' | 'lng' | 'locationVerified' | 'geocodeConfidence'>, area: ServiceArea): string {
  if (c.lat === null || c.lng === null) return 'Missing';
  const issue = locationIssue(c, area);
  if (!issue) return 'Confirmed';
  if (issue.blocking) return `Not usable: ${issue.message}`;
  return c.geocodeConfidence === 'HIGH' ? 'Usable - not confirmed by a dispatcher' : 'Usable - not exact, not confirmed by a dispatcher';
}

const hhmm = (v: number | null) => (v === null ? null : fmtHhmm(v));

/**
 * One customer as the master shows it (keys = MASTER_COLUMNS). Round trip: imported back unchanged,
 * nothing changes - lat / lng only for a usable exact or confirmed point (a point that is not usable
 * is left blank, so the import never makes it usable), the customer's own hours (never a default),
 * the unloading time only when confirmed, the priority with whether it is confirmed.
 */
export function masterValues(c: MasterCustomer, ctx: MasterContext): Record<string, MasterValue> {
  const eff = effectiveAttrs(c, ctx.profiles, { serviceTimeMin: ctx.serviceTimeMin });
  const point = writesPoint(c, ctx.area);
  const own = [c.hardWindowStartMin, c.hardWindowEndMin, c.prefWindowStartMin, c.prefWindowEndMin];
  return {
    code: c.code,
    branch_code: c.branchCode,
    name: c.name,
    region_code: c.regionCode,
    region: c.regionName,
    depot: c.depotCode,
    customer_type: c.customerType,
    priority: c.priority,
    // Blank, not "no", when not confirmed: a priority or hours someone corrects in the file are then
    // confirmed by the importer (a forgotten "no" would leave them unconfirmed); unchanged, they stay as they are.
    priority_confirmed: c.priorityConfirmed ? 'yes' : null,
    priority_in_use: `P${eff.priority} (${SOURCE_WORDS[eff.prioritySource]})`,
    lat: point ? c.lat : null,
    lng: point ? c.lng : null,
    google_maps: c.lat !== null && c.lng !== null ? `https://www.google.com/maps/search/?api=1&query=${c.lat.toFixed(6)},${c.lng.toFixed(6)}` : null,
    location_status: locationStatusText(c, ctx.area),
    location_source: c.locationSource,
    location_confirmed_by: c.locationVerified ? c.locationVerifiedBy : null,
    location_confirmed_at: c.locationVerified ? localStamp(c.locationVerifiedAt, ctx.timezone) : null,
    hard_from: hhmm(c.hardWindowStartMin),
    hard_to: hhmm(c.hardWindowEndMin),
    preferred_from: hhmm(c.prefWindowStartMin),
    preferred_to: hhmm(c.prefWindowEndMin),
    open_all_day: hasOwnWindow(c) && own.every((v) => v === null) ? 'yes' : null,
    hours_confirmed: hasOwnWindow(c) ? 'yes' : null,
    receiving_hours: windowLabel(eff),
    hours_confirmed_by: hasOwnWindow(c) ? c.windowConfirmedBy : null,
    hours_confirmed_at: localStamp(c.windowConfirmedAt ? new Date(c.windowConfirmedAt) : null, ctx.timezone),
    avg_service_time_min: c.serviceTimeConfirmed ? c.avgServiceTimeMin : null,
    unloading_time: `${eff.serviceMin} min (${SOURCE_WORDS[eff.serviceSource]})`,
    payment_type: c.paymentType.toLowerCase(),
    address: c.address,
    active: c.active ? 'yes' : 'no',
    created_at: localStamp(c.createdAt, ctx.timezone),
    updated_at: localStamp(c.updatedAt, ctx.timezone),
  };
}

/** The start of "changed since": the company's midnight of `dateIso`, or 24 hours before `now`. */
export function changedSince(dateIso: string | null | undefined, now: Date, tz: string): { since: Date; label: string } {
  if (dateIso && /^\d{4}-\d{2}-\d{2}$/.test(dateIso) && !Number.isNaN(Date.parse(`${dateIso}T00:00:00Z`))) {
    return { since: zonedDayStart(dateIso, tz), label: `Changed since ${fmtDayMonth(dateIso)}` };
  }
  return { since: new Date(now.getTime() - 24 * 3_600_000), label: 'Changed in last 24 hours' };
}

/** A customer's audit row (entity Customer), with the name of who wrote it. */
export interface CustomerAudit {
  action: string;
  createdAt: Date;
  userName: string | null;
  beforeJson: unknown;
  afterJson: unknown;
}

/** Customer fields, by what a person calls them, for "what changed". */
const FIELD_WORDS: Record<string, string> = {
  code: 'Code',
  branchCode: 'Branch',
  name: 'Name',
  regionId: 'Region',
  address: 'Address',
  lat: 'Location',
  lng: 'Location',
  locationVerified: 'Location',
  geocodeConfidence: 'Location',
  priority: 'Priority',
  priorityConfirmed: 'Priority',
  avgServiceTimeMin: 'Unloading time',
  serviceTimeConfirmed: 'Unloading time',
  paymentType: 'Payment type',
  accessNotes: 'Access notes',
  active: 'Active',
  customerType: 'Customer type',
  hardWindowStartMin: 'Receiving hours',
  hardWindowEndMin: 'Receiving hours',
  prefWindowStartMin: 'Receiving hours',
  prefWindowEndMin: 'Receiving hours',
  windowConfirmedAt: 'Receiving hours',
};

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The fields an UPDATE row changed, in plain words (only fields both sides name). */
function changedWords(before: unknown, after: unknown): string[] {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [];
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  return Object.keys(FIELD_WORDS).filter((k) => k in a && !sameValue(b[k], a[k])).map((k) => FIELD_WORDS[k]!);
}

/**
 * When a customer last changed since `since`, who changed it and what: from its audit rows of the
 * period, its creation and its last change time. Null = not changed since then. A change that left no
 * row of its own (an order file creating the customer, for example) still counts, with what is known.
 */
export function changeSummary(
  c: { createdAt: Date | null; updatedAt: Date | null; createdFromUpload: boolean },
  audits: readonly CustomerAudit[],
  since: Date,
): { at: Date; by: string; what: string } | null {
  const rows = audits.filter((r) => r.createdAt >= since).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
  const created = c.createdAt && c.createdAt >= since ? c.createdAt : null;
  const updated = c.updatedAt && c.updatedAt >= since ? c.updatedAt : null;
  if (!rows.length && !created && !updated) return null;
  const words: string[] = [];
  if (created || rows.some((r) => r.action === 'CREATE')) words.push(c.createdFromUpload ? 'New customer (from an order file)' : 'New customer');
  for (const r of rows) {
    if (r.action === 'CUSTOMER_LOCATION_SET') words.push('Location');
    else if (r.action === 'UPDATE') words.push(...changedWords(r.beforeJson, r.afterJson));
  }
  const times = [...rows.map((r) => r.createdAt), ...(created ? [created] : []), ...(updated ? [updated] : [])];
  const at = new Date(Math.max(...times.map((t) => t.getTime())));
  const by = [...new Set(rows.map((r) => r.userName).filter((n): n is string => !!n))].join(', ');
  const what = [...new Set(words)].join(', ') || 'Changed (no details recorded)';
  return { at, by: by || (created && c.createdFromUpload ? 'Order file' : ''), what };
}

// ---------------------------------------------------------------------------------------------
// Item 6: the import's receiving-hours and priority columns
// ---------------------------------------------------------------------------------------------

/** priority_confirmed as the import reads it; ABSENT = the file has no such column. */
export type PriorityConfirm = 'YES' | 'NO' | 'BLANK' | 'ABSENT';

/**
 * What a row's priority does to a customer (item 6): the priority to store (null = unchanged) and
 * whether it becomes confirmed (false = left as it is). ABSENT (a file without the column, as before
 * the master): confirmed. YES: confirmed. BLANK (the master's "not confirmed yet"): a changed priority
 * is confirmed by the importer, an unchanged one stays as it is. NO: stored without confirming.
 * Nothing un-confirms a priority. `stored` null: a new customer.
 */
export function importedPriority(
  priority: number,
  flag: PriorityConfirm,
  stored: { priority: number; priorityConfirmed: boolean } | null,
): { priority: number | null; confirm: boolean } {
  if (!stored) return { priority, confirm: flag !== 'NO' };
  const changed = priority !== stored.priority;
  const confirm = !stored.priorityConfirmed && (flag === 'YES' || flag === 'ABSENT' || (flag === 'BLANK' && changed));
  return { priority: changed ? priority : null, confirm };
}

/** The import's own-hours columns (MASTER_COLUMNS); a file without any of them leaves hours alone. */
export const HOURS_COLUMNS = ['hard_from', 'hard_to', 'preferred_from', 'preferred_to', 'open_all_day', 'hours_confirmed'] as const;

/** yes / no as a person writes it in a cell: true, false, null (blank), or undefined (not readable). */
export function yesNo(raw: string | null | undefined): boolean | null | undefined {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (['yes', 'y', 'true', '1', 'x'].includes(s)) return true;
  if (['no', 'n', 'false', '0'].includes(s)) return false;
  return undefined;
}

/**
 * A time cell: "06:00", "6:00", "0600", "06:00:00", "6:00 AM", or an Excel time (a fraction of a day,
 * 0.25 = 06:00). Null for blank; throws with a plain message on anything else.
 */
export function cellTime(raw: string | null | undefined, column: string): number | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const ampm = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])\.?m\.?$/i.exec(s);
  if (ampm) {
    const h = Number(ampm[1]);
    if (h >= 1 && h <= 12 && Number(ampm[2]) <= 59) return ((h % 12) + (ampm[3]!.toLowerCase() === 'p' ? 12 : 0)) * 60 + Number(ampm[2]);
  }
  const secs = /^(\d{1,2}:\d{2}):\d{2}$/.exec(s);
  if (/^(0(\.\d+)?|\.\d+)$/.test(s)) {
    const min = Math.round(Number(s) * 1440);
    if (min >= 0 && min < 1440) return min;
  }
  try {
    const v = parseHhmm(secs ? secs[1] : s);
    if (v !== null) return v;
  } catch {
    // fall through to the plain message
  }
  throw new Error(`${column} must be a time like 06:30 (got "${s}").`);
}

export interface StoredHours {
  hardWindowStartMin: number | null;
  hardWindowEndMin: number | null;
  prefWindowStartMin: number | null;
  prefWindowEndMin: number | null;
  windowConfirmedAt: Date | string | null;
}

/** What a row's hour cells do to a customer: nothing, or new hours and / or a confirmation. */
export type HoursChange =
  | { ok: true; change: null }
  | {
      ok: true;
      change: {
        hours: Pick<StoredHours, 'hardWindowStartMin' | 'hardWindowEndMin' | 'prefWindowStartMin' | 'prefWindowEndMin'>;
        /** SET = confirmed by the importer now; CLEAR = not confirmed; KEEP = as it was. */
        confirm: 'SET' | 'CLEAR' | 'KEEP';
      };
    }
  | { ok: false; error: string };

/**
 * The customer import's receiving-hours columns (owner decision 1 Oct 2026, items 2 and 6), on one
 * row. `cells`: the row's values by column, undefined when the file has no such column (a file
 * without any of HOURS_COLUMNS leaves the hours as they are). `stored`: the customer (null: new).
 *
 *  - open_all_day yes: no hours, confirmed (the hour cells must be blank).
 *  - any hour cell filled: the four cells are the customer's own hours (a blank one = no limit). New
 *    hours are confirmed by the importer unless hours_confirmed says no (as in Details: hours a
 *    dispatcher or admin enters are confirmed).
 *  - hours unchanged: hours_confirmed yes confirms them; nothing un-confirms them (a no, or a blank,
 *    leaves the customer as it is), so importing the master back changes nothing.
 *  - no hour cell and no open_all_day: the hours stay as they are (hours_confirmed yes alone is refused:
 *    there are no hours to confirm).
 */
export function readImportedHours(cells: Partial<Record<(typeof HOURS_COLUMNS)[number], string>>, stored: StoredHours | null): HoursChange {
  if (!HOURS_COLUMNS.some((k) => cells[k] !== undefined)) return { ok: true, change: null };
  const openAllDay = yesNo(cells.open_all_day);
  const confirmed = yesNo(cells.hours_confirmed);
  if (openAllDay === undefined) return { ok: false, error: `open_all_day must be yes or no (got "${cells.open_all_day}").` };
  if (confirmed === undefined) return { ok: false, error: `hours_confirmed must be yes or no (got "${cells.hours_confirmed}").` };
  let hours: [number | null, number | null, number | null, number | null];
  try {
    hours = [cellTime(cells.hard_from, 'hard_from'), cellTime(cells.hard_to, 'hard_to'), cellTime(cells.preferred_from, 'preferred_from'), cellTime(cells.preferred_to, 'preferred_to')];
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const anyHours = hours.some((v) => v !== null);
  const was = stored ?? { hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null, windowConfirmedAt: null };
  const wasConfirmed = hasOwnWindow(was);
  let target: typeof hours;
  if (openAllDay === true) {
    if (anyHours) return { ok: false, error: 'open_all_day is yes but receiving hours are filled in: leave the hours blank, or write no in open_all_day.' };
    if (confirmed === false) return { ok: false, error: 'open_all_day yes means the customer accepts deliveries at any time, which is a confirmation: write yes in hours_confirmed, or leave it blank.' };
    target = [null, null, null, null];
  } else if (anyHours) {
    if (hours[0] !== null && hours[1] !== null && hours[1] <= hours[0]) return { ok: false, error: 'hard_to must be after hard_from.' };
    if (hours[2] !== null && hours[3] !== null && hours[3] <= hours[2]) return { ok: false, error: 'preferred_to must be after preferred_from.' };
    target = hours;
  } else {
    if (confirmed === true) {
      return { ok: false, error: 'hours_confirmed is yes but no receiving hours are filled in: fill them in, or write yes in open_all_day for a customer that accepts deliveries at any time.' };
    }
    return { ok: true, change: null };
  }
  const before = [was.hardWindowStartMin, was.hardWindowEndMin, was.prefWindowStartMin, was.prefWindowEndMin];
  const changed = target.some((v, i) => v !== before[i]);
  const next = { hardWindowStartMin: target[0], hardWindowEndMin: target[1], prefWindowStartMin: target[2], prefWindowEndMin: target[3] };
  if (changed) return { ok: true, change: { hours: next, confirm: openAllDay === true || confirmed !== false ? 'SET' : 'CLEAR' } };
  if ((openAllDay === true || confirmed === true) && !wasConfirmed) return { ok: true, change: { hours: next, confirm: 'SET' } };
  return { ok: true, change: null };
}
