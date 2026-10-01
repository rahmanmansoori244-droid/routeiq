/**
 * Data collection (owner decisions of 1 Oct 2026), server side: the data-to-collect list (item 4) and
 * the daily customer master workbook (item 6). The rules and words are in ./data-collection (pure).
 */
import ExcelJS from 'exceljs';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { OPEN } from './open-orders';
import { tenantServiceArea } from './service-area';
import { dateOnly, isoOf, todayIso } from './time';
import type { TypeProfileLike } from './customer-attrs';
import {
  buildWorklist,
  changedSince,
  changeSummary,
  localStamp,
  MASTER_COLUMNS,
  masterValues,
  worklistPeriod,
  type CustomerAudit,
  type MasterContext,
  type MasterCustomer,
  type MasterValue,
  type Worklist,
} from './data-collection';

const CUSTOMER_SELECT = {
  id: true,
  code: true,
  branchCode: true,
  name: true,
  lat: true,
  lng: true,
  priority: true,
  priorityConfirmed: true,
  avgServiceTimeMin: true,
  serviceTimeConfirmed: true,
  customerType: true,
  hardWindowStartMin: true,
  hardWindowEndMin: true,
  prefWindowStartMin: true,
  prefWindowEndMin: true,
  locationVerified: true,
  createdFromUpload: true,
  geocodeConfidence: true,
  windowConfirmedAt: true,
  address: true,
  accessNotes: true,
  paymentType: true,
  active: true,
  locationSource: true,
  locationVerifiedAt: true,
  createdAt: true,
  updatedAt: true,
  region: { select: { code: true, name: true, depot: { select: { code: true } } } },
  locationVerifiedBy: { select: { name: true } },
  windowConfirmedBy: { select: { name: true } },
} satisfies Prisma.CustomerSelect;

type CustomerRow = Prisma.CustomerGetPayload<{ select: typeof CUSTOMER_SELECT }>;

function toMaster(c: CustomerRow): MasterCustomer & { accessNotes: string | null } {
  return {
    ...c,
    regionCode: c.region?.code ?? null,
    regionName: c.region?.name ?? null,
    depotCode: c.region?.depot?.code ?? null,
    paymentType: c.paymentType,
    locationSource: c.locationSource ?? null,
    locationVerifiedBy: c.locationVerifiedBy?.name ?? null,
    windowConfirmedBy: c.windowConfirmedBy?.name ?? null,
  };
}

async function context(tenantId: string): Promise<MasterContext & { dataCollectDays: number; requireDataBeforeLoading: boolean }> {
  const [cfg, profiles, area] = await Promise.all([
    prisma.tenantConfig.findUnique({ where: { tenantId }, select: { timezone: true, defaultServiceTimeMin: true, dataCollectDays: true, requireDataBeforeLoading: true } }),
    prisma.customerTypeProfile.findMany({ where: { tenantId } }),
    tenantServiceArea(tenantId),
  ]);
  return {
    area,
    profiles: new Map<string, TypeProfileLike>(profiles.map((p) => [p.customerType, p])),
    serviceTimeMin: cfg?.defaultServiceTimeMin ?? 10,
    timezone: cfg?.timezone ?? 'Asia/Muscat',
    dataCollectDays: cfg?.dataCollectDays ?? 3,
    requireDataBeforeLoading: cfg?.requireDataBeforeLoading ?? false,
  };
}

export interface LoadedWorklist extends Worklist {
  /** Settings: the loading gate is on. */
  gateOn: boolean;
  today: string;
  /** The customers of the rows, as the master shows them (for the Excel). */
  master: Map<string, Record<string, MasterValue>>;
}

/**
 * Item 4: customers with open orders (not out for delivery, not brought forward) from today to
 * `days` days ahead (Settings "Data to collect: days ahead" when not given) that miss a usable location
 * or their own confirmed receiving hours. Counted over every active depot.
 */
export async function loadWorklist(tenantId: string, opts: { days?: number | null; now?: Date } = {}): Promise<LoadedWorklist> {
  const ctx = await context(tenantId);
  const today = todayIso(ctx.timezone, opts.now ?? new Date());
  const period = worklistPeriod(today, opts.days ?? ctx.dataCollectDays);
  const [orders, depots] = await Promise.all([
    prisma.order.findMany({
      where: { tenantId, status: { in: OPEN }, deliveryDate: { gte: dateOnly(period.from), lte: dateOnly(period.to) }, carriedToOrderId: null },
      select: { customerId: true, depotId: true, deliveryDate: true },
    }),
    prisma.depot.findMany({ where: { tenantId, active: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } }),
  ]);
  const ids = [...new Set(orders.map((o) => o.customerId))];
  const rows = ids.length ? await prisma.customer.findMany({ where: { tenantId, id: { in: ids } }, select: CUSTOMER_SELECT }) : [];
  const customers = rows.map(toMaster);
  const list = buildWorklist(
    customers,
    orders.map((o) => ({ customerId: o.customerId, depotId: o.depotId, deliveryDate: isoOf(o.deliveryDate) })),
    depots,
    { ...period, area: ctx.area },
  );
  const wanted = new Set(list.rows.map((r) => r.customerId));
  const master = new Map(customers.filter((c) => wanted.has(c.id)).map((c) => [c.id, masterValues(c, ctx)]));
  return { ...list, gateOn: ctx.requireDataBeforeLoading, today, master };
}

// ---------------------------------------------------------------------------------------------
// Workbooks
// ---------------------------------------------------------------------------------------------

interface LeadColumn {
  key: string;
  width: number;
}

const IMPORTED_HEAD = { bold: true } as const;
const INFO_HEAD = { bold: true, color: { argb: 'FF666666' } } as const;
const INFO_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
const TEXT_COLUMNS = new Set(['lat', 'lng', 'hard_from', 'hard_to', 'preferred_from', 'preferred_to', 'branch_code', 'code']);

/**
 * A coordinate as the customer import reads it back as the same point: every decimal the number has,
 * and at least 4 (a stored 23.585 came from an exact "23.5850"; one trailing zero counts).
 */
export function coordCell(v: MasterValue): MasterValue {
  if (typeof v !== 'number') return v;
  const s = String(v);
  if (/e/i.test(s)) return v.toFixed(7);
  const decimals = s.split('.')[1]?.length ?? 0;
  return decimals >= 4 ? s : v.toFixed(4);
}

/** One sheet of customers: the lead columns, then the master's columns (headers as the import reads them). */
function customerSheet(wb: ExcelJS.Workbook, name: string, lead: readonly LeadColumn[], rows: readonly Record<string, MasterValue>[]) {
  const columns = [...lead.map((c) => ({ ...c, imported: false })), ...MASTER_COLUMNS];
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.key, key: c.key, width: c.width, ...(TEXT_COLUMNS.has(c.key) ? { style: { numFmt: '@' } } : {}) }));
  columns.forEach((c, i) => {
    const cell = ws.getRow(1).getCell(i + 1);
    cell.font = c.imported ? IMPORTED_HEAD : INFO_HEAD;
    if (!c.imported) cell.fill = INFO_FILL;
  });
  for (const r of rows) {
    const values = Object.fromEntries(columns.map((c) => [c.key, c.key === 'lat' || c.key === 'lng' ? coordCell(r[c.key] ?? null) : (r[c.key] ?? null)]));
    const row = ws.addRow(values);
    const link = r.google_maps;
    if (typeof link === 'string') row.getCell('google_maps').value = { text: link, hyperlink: link };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

function aboutSheet(wb: ExcelJS.Workbook, lines: readonly string[]) {
  const ws = wb.addWorksheet('About this file');
  ws.getColumn(1).width = 26;
  ws.getColumn(2).width = 110;
  let r = 1;
  for (const l of lines) {
    ws.getCell(r, 1).value = l;
    if (r === 1) ws.getCell(r, 1).font = { bold: true, size: 13 };
    r++;
  }
  r++;
  ws.getCell(r, 1).value = 'Column';
  ws.getCell(r, 2).value = 'What it holds';
  ws.getRow(r).font = { bold: true };
  r++;
  for (const c of MASTER_COLUMNS) {
    ws.getCell(r, 1).value = c.key;
    ws.getCell(r, 2).value = `${c.imported ? 'Imported back. ' : 'For reading only (not imported). '}${c.text}`;
    r++;
  }
}

const IMPORT_RULES = [
  'Correct the first sheet and import it on Customers > Import: the columns marked "Imported back" are read; the others are for reading only.',
  'A blank cell keeps what the customer has. Only an admin can change a saved location: a dispatcher\'s import only fills in missing or unusable locations.',
  'Receiving hours: when any of hard_from, hard_to, preferred_from, preferred_to is filled in, the four together are the customer\'s own hours (a blank one = no limit); they are confirmed by you unless hours_confirmed says no. open_all_day yes = any time (confirmed).',
  'Locations: at least 4 decimals, inside the delivery area; a location that is not exact is not saved (drop the pin on Daily dispatch or the customer page).',
];

const WORKLIST_LEAD: readonly LeadColumn[] = [
  { key: 'missing', width: 26 },
  { key: 'first_delivery', width: 12 },
  { key: 'open_orders', width: 8 },
  { key: 'depots', width: 10 },
];

function worklistRows(list: LoadedWorklist): Record<string, MasterValue>[] {
  return list.rows.map((r) => ({
    missing: r.missing,
    first_delivery: r.firstDelivery,
    open_orders: r.orders,
    depots: r.depots.join(', '),
    ...(list.master.get(r.customerId) ?? {}),
  }));
}

function perDaySheet(wb: ExcelJS.Workbook, list: LoadedWorklist) {
  const ws = wb.addWorksheet('Per depot and day', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'depot', key: 'depot', width: 10 },
    { header: 'delivery_date', key: 'date', width: 13 },
    { header: 'customers_with_orders', key: 'customers', width: 22 },
    { header: 'customers_missing_data', key: 'missing', width: 22 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const d of list.perDay) ws.addRow({ depot: d.depotCode, date: d.date, customers: d.customers, missing: d.missing });
  ws.addRow({});
  ws.addRow({ depot: 'Depot', date: 'Missing data', customers: 'No location', missing: 'No receiving hours' }).font = { bold: true };
  for (const d of list.perDepot) ws.addRow({ depot: d.code, date: d.customers, customers: d.location, missing: d.window });
}

/** Item 4: the data-to-collect workbook for the people who collect the data (importable back). */
export async function buildWorklistWorkbook(list: LoadedWorklist, meta: { generatedBy: string; generatedAt: Date; timezone: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'RouteIQ';
  wb.created = meta.generatedAt;
  customerSheet(wb, 'Data to collect', WORKLIST_LEAD, worklistRows(list));
  perDaySheet(wb, list);
  aboutSheet(wb, [
    'Data to collect',
    `Customers with open orders from ${list.from} to ${list.to} that miss a usable location or their own confirmed receiving hours, soonest delivery first.`,
    `Made by ${meta.generatedBy} on ${localStamp(meta.generatedAt, meta.timezone)} (company time).`,
    ...IMPORT_RULES,
  ]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * Item 6: the customer master - every customer (sheet 1, importable back), the customers changed since
 * `sinceIso` (default the last 24 hours: from the audit log and the customers' change times), and the
 * customers still missing data (the data-to-collect list).
 */
export async function buildMasterWorkbook(
  tenantId: string,
  opts: { sinceIso?: string | null; now?: Date; generatedBy: string },
): Promise<{ buffer: Buffer; fileName: string; changed: number; customers: number; missing: number }> {
  const now = opts.now ?? new Date();
  const ctx = await context(tenantId);
  const { since, label } = changedSince(opts.sinceIso, now, ctx.timezone);
  const [rows, audits, list] = await Promise.all([
    prisma.customer.findMany({ where: { tenantId }, select: CUSTOMER_SELECT, orderBy: [{ active: 'desc' }, { code: 'asc' }, { branchCode: 'asc' }] }),
    prisma.auditLog.findMany({
      where: { tenantId, entity: 'Customer', entityId: { not: null }, createdAt: { gte: since } },
      select: { entityId: true, action: true, createdAt: true, beforeJson: true, afterJson: true, user: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    loadWorklist(tenantId, { now }),
  ]);
  const auditsOf = new Map<string, CustomerAudit[]>();
  for (const a of audits) {
    if (!a.entityId) continue;
    auditsOf.set(a.entityId, [...(auditsOf.get(a.entityId) ?? []), { action: a.action, createdAt: a.createdAt, userName: a.user?.name ?? null, beforeJson: a.beforeJson, afterJson: a.afterJson }]);
  }
  const customers = rows.map(toMaster);
  const values = customers.map((c) => masterValues(c, ctx));
  const changed = customers
    .map((c, i) => ({ c, v: values[i]!, s: changeSummary(c, auditsOf.get(c.id) ?? [], since) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => b.s!.at.getTime() - a.s!.at.getTime())
    .map(({ v, s }) => ({ changed_at: localStamp(s!.at, ctx.timezone), changed_by: s!.by || null, what_changed: s!.what, ...v }));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'RouteIQ';
  wb.created = now;
  customerSheet(wb, 'Customers', [], values);
  customerSheet(wb, label, [{ key: 'changed_at', width: 17 }, { key: 'changed_by', width: 18 }, { key: 'what_changed', width: 36 }], changed);
  customerSheet(wb, 'Still missing', WORKLIST_LEAD, worklistRows(list));
  aboutSheet(wb, [
    'Customer master',
    `Every customer (${customers.length}), made by ${opts.generatedBy} on ${localStamp(now, ctx.timezone)} (company time).`,
    `"${label}": customers created or changed since ${localStamp(since, ctx.timezone)} (${changed.length}), newest first.`,
    `"Still missing": customers with open orders from ${list.from} to ${list.to} that miss a usable location or their own confirmed receiving hours (${list.rows.length}).`,
    ...IMPORT_RULES,
  ]);
  const today = todayIso(ctx.timezone, now);
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), fileName: `customer-master-${today}.xlsx`, changed: changed.length, customers: customers.length, missing: list.rows.length };
}
