/**
 * Data collection rules (owner decisions of 1 Oct 2026), items 3, 4 and 6 (items 1, 2 and 5:
 * data-collection-rules.spec.ts and data-collection-routes.spec.ts; the loading gate on the load
 * lifecycle: plan-lifecycle.spec.ts):
 *
 *  - item 3: the words of the loading gate (`dataGaps`, `dataGateRefusal`);
 *  - item 4: the data to collect (`buildWorklist`, GET /api/customers/data-to-collect, JSON and Excel);
 *  - item 6: the customer master (GET /api/customers/master: every customer, changed since, still
 *    missing), and the customer import reading it back: as downloaded it changes nothing; corrected, it
 *    sets receiving hours (confirmed by the importer) and missing locations, never a dispatcher's change
 *    of a saved location.
 */
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, row, tables } from './fake-plan-db';

const session = vi.hoisted(() => ({ role: 'PLANNER' as string }));
vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'u1', tenantId: 'tA', role: session.role, name: 'Dispatcher', email: 'd@a.example' } }),
}));
vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
const audits = vi.hoisted(() => [] as Record<string, any>[]);
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async (a: Record<string, any>) => void audits.push(a)) }));
vi.mock('@/lib/dispatch/service-area', async () => {
  const { DEFAULT_SERVICE_AREA } = await import('@/lib/dispatch/location-input');
  return { tenantServiceArea: async () => DEFAULT_SERVICE_AREA };
});

import { GET as worklistGet } from '@/app/api/customers/data-to-collect/route';
import { GET as masterGet } from '@/app/api/customers/master/route';
import { POST as customerImport } from '@/app/api/customers/import/route';
import {
  buildWorklist,
  cellTime,
  changeSummary,
  DATA_GATE_RULE,
  dataGaps,
  dataGateRefusal,
  importedPriority,
  masterValues,
  readImportedHours,
  windowGateRemedy,
  yesNo,
  type MasterCustomer,
} from '@/lib/dispatch/data-collection';
import { coordCell } from '@/lib/dispatch/customer-master';
import { DEFAULT_SERVICE_AREA } from '@/lib/dispatch/location-input';
import { addDaysIso, dateOnly, todayIso } from '@/lib/dispatch/time';
import { LOCATION_ADMIN_ONLY_MESSAGE } from '@/lib/dispatch/customer-attrs';

const T = 'tA';
const AT = new Date('2026-09-30T08:00:00.000Z');
const customer = (id: string, over: Record<string, unknown> = {}) => ({
  id, tenantId: T, code: id, branchCode: null, branchKey: '__MAIN__', name: `Customer ${id}`, active: true, regionId: null, address: null, accessNotes: null,
  lat: 23.5859, lng: 58.4059, geocodeConfidence: 'HIGH', locationSource: 'IMPORT', locationInput: null,
  locationVerified: false, locationVerifiedById: null, locationVerifiedAt: null, createdFromUpload: false, customerType: null, paymentType: 'CREDIT',
  hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null,
  windowConfirmedAt: null, windowConfirmedById: null, priority: 3, priorityConfirmed: false, avgServiceTimeMin: 10, serviceTimeConfirmed: false,
  createdAt: null, updatedAt: null,
  ...over,
});
const today = todayIso('Asia/Muscat');
const order = (id: string, customerId: string, depotId: string, inDays: number, status = 'UPLOADED') => ({
  id, tenantId: T, customerId, depotId, deliveryDate: dateOnly(addDaysIso(today, inDays)), status, carriedToOrderId: null, deliveryStartMin: null, deliveryEndMin: null,
});
const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as { data: any; error: any } });
const getWorklist = async (q = '') => worklistGet(new Request(`http://localhost/api/customers/data-to-collect${q}`));
const workbookOf = async (res: Response) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as never);
  return wb;
};
/** A sheet's rows as objects by header. */
const rowsOf = (ws: ExcelJS.Worksheet) => {
  const heads = (ws.getRow(1).values as unknown[]).slice(1).map(String);
  const out: Record<string, unknown>[] = [];
  ws.eachRow((r, n) => {
    if (n === 1) return;
    out.push(Object.fromEntries(heads.map((h, i) => [h, r.getCell(i + 1).value])));
  });
  return out;
};
const importXlsx = async (buf: Buffer, dryRun = false) => {
  const fd = new FormData();
  fd.set('file', new File([new Uint8Array(buf)], 'customer-master.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  if (dryRun) fd.set('dryRun', '1');
  return answer(await customerImport(new Request('http://localhost/api/customers/import', { method: 'POST', body: fd })));
};

beforeEach(() => {
  resetDb();
  audits.length = 0;
  session.role = 'PLANNER';
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, timezone: 'Asia/Muscat', dataCollectDays: 3, defaultServiceTimeMin: 10, requireDataBeforeLoading: false, serviceAreaJson: null }];
  tables.depot = [
    { id: 'D1', tenantId: T, code: 'D1', name: 'Muscat', active: true },
    { id: 'D2', tenantId: T, code: 'D2', name: 'Sohar', active: true },
  ];
  tables.customer = [
    customer('USABLE'), // exact imported point, never confirmed; no confirmed hours
    customer('CONFIRMED', { locationVerified: true, locationSource: 'MAP_PIN', locationVerifiedAt: AT }),
    customer('NONE', { lat: null, lng: null, geocodeConfidence: 'MISSING', locationSource: null }),
    customer('LOW', { geocodeConfidence: 'LOW', lat: 23, lng: 58 }), // not usable
    customer('DONE', { locationVerified: true, hardWindowStartMin: 360, hardWindowEndMin: 600, windowConfirmedAt: AT, windowConfirmedById: 'u1', priorityConfirmed: true, serviceTimeConfirmed: true, avgServiceTimeMin: 20 }),
    customer('OPEN', { locationVerified: true, windowConfirmedAt: AT, windowConfirmedById: 'u1' }), // open all day (confirmed, no hours)
  ];
  tables.order = [
    order('O1', 'NONE', 'D1', 0),
    order('O2', 'LOW', 'D2', 1),
    order('O3', 'USABLE', 'D1', 2),
    order('O4', 'CONFIRMED', 'D1', 10), // after the period
    order('O5', 'CONFIRMED', 'D1', 0, 'DISPATCHED'), // out for delivery: not open
    order('O6', 'DONE', 'D1', 0), // nothing missing
  ];
});

describe('item 3: the loading gate words', () => {
  const c = (id: string, over: Record<string, unknown> = {}) => customer(id, over) as never;

  it('a customer misses a delivery window without its own confirmed hours, unless an order given has a delivery time; defaults never count', () => {
    const gaps = dataGaps([c('A'), c('B', { windowConfirmedAt: AT }), c('C'), c('D', { lat: null, lng: null })], [
      { customerId: 'A', deliveryStartMin: null, deliveryEndMin: null },
      { customerId: 'B', deliveryStartMin: null, deliveryEndMin: null },
      { customerId: 'C', deliveryStartMin: null, deliveryEndMin: 600 },
      { customerId: 'D', deliveryStartMin: null, deliveryEndMin: null },
    ]);
    expect(gaps.map((g) => [g.code, g.location, g.window])).toEqual([
      ['A', false, true],
      ['D', true, true],
    ]);
  });

  it('the refusal lists each customer and what it misses, the rule, and the remedy for each kind', () => {
    const gaps = dataGaps([c('A'), c('D', { lat: null, lng: null, name: 'Corner Shop' })], [
      { customerId: 'A', deliveryStartMin: null, deliveryEndMin: null },
      { customerId: 'D', deliveryStartMin: null, deliveryEndMin: null },
    ]);
    expect(dataGateRefusal({ truck: 'T01', loadNo: 2, status: 'PLANNED' }, gaps, 'Drop the pin.')).toBe(
      `T01 L2: 2 customers on this load miss data needed before loading - A (Customer A): no delivery window; D (Corner Shop): no location and delivery window. ${DATA_GATE_RULE} Delivery window: ${windowGateRemedy('PLANNED')} Location: Drop the pin.`,
    );
    // A locked load's orders keep their times: confirming the hours is the way, or unlock first.
    expect(windowGateRemedy('LOCKED')).toMatch(/then try again\. To give an order a delivery time instead, unlock this load/);
    expect(windowGateRemedy('LOADING')).not.toMatch(/unlock/);
  });
});

describe('item 4: the data to collect (buildWorklist)', () => {
  it('active customers with open orders in the period missing a location or confirmed hours, soonest first, counted per depot and per day', () => {
    const list = buildWorklist(
      [customer('A'), customer('B', { lat: null, lng: null }), customer('C', { windowConfirmedAt: AT, locationVerified: true }), customer('X', { active: false })].map((x) => ({ ...x, regionCode: null, regionName: null })) as never,
      [
        { customerId: 'A', depotId: 'D1', deliveryDate: '2026-10-03' },
        { customerId: 'A', depotId: 'D2', deliveryDate: '2026-10-02' },
        { customerId: 'B', depotId: 'D1', deliveryDate: '2026-10-02' },
        { customerId: 'C', depotId: 'D1', deliveryDate: '2026-10-02' },
        { customerId: 'X', depotId: 'D1', deliveryDate: '2026-10-02' },
      ],
      [{ id: 'D1', code: 'D1', name: 'Muscat' }, { id: 'D2', code: 'D2', name: 'Sohar' }, { id: 'D3', code: 'D3', name: 'Nizwa' }],
      { from: '2026-10-01', to: '2026-10-04', days: 3 },
    );
    expect(list.rows.map((r) => [r.code, r.missing, r.firstDelivery, r.depots.join('+'), r.orders])).toEqual([
      ['A', 'Receiving hours', '2026-10-02', 'D1+D2', 2],
      ['B', 'Location and receiving hours', '2026-10-02', 'D1', 1],
    ]);
    expect(list.perDepot.map((d) => [d.code, d.customers, d.location, d.window])).toEqual([
      ['D1', 2, 1, 2],
      ['D2', 1, 0, 1],
      ['D3', 0, 0, 0],
    ]);
    expect(list.perDay.map((d) => [d.date, d.depotCode, d.customers, d.missing])).toEqual([
      ['2026-10-02', 'D1', 2, 1],
      ['2026-10-02', 'D2', 1, 1],
      ['2026-10-03', 'D1', 1, 1],
    ]);
    expect(list.total).toEqual({ customers: 2, location: 1, window: 2 });
  });
});

describe('item 4: GET /api/customers/data-to-collect', () => {
  it('JSON: the period from Settings, counts per depot, rows soonest first; depotId keeps only that depot\'s rows', async () => {
    const r = await answer(await getWorklist());
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ from: today, to: addDaysIso(today, 3), days: 3, gateOn: false });
    expect(r.body.data.rows.map((x: any) => [x.code, x.missing])).toEqual([
      ['NONE', 'Location and receiving hours'],
      ['LOW', 'Location and receiving hours'],
      ['USABLE', 'Receiving hours'],
    ]);
    expect(r.body.data.perDepot.map((d: any) => [d.code, d.customers])).toEqual([['D1', 2], ['D2', 1]]);
    const d2 = await answer(await getWorklist('?depotId=D2'));
    expect(d2.body.data.rows.map((x: any) => x.code)).toEqual(['LOW']);
    expect(d2.body.data.perDepot).toHaveLength(2);
    expect((await answer(await getWorklist('?days=1'))).body.data.rows.map((x: any) => x.code)).toEqual(['NONE', 'LOW']);
  });

  it('refuses days outside 0-14 and an unknown depot; a viewer is refused', async () => {
    expect((await getWorklist('?days=15')).status).toBe(400);
    expect((await getWorklist('?days=x')).status).toBe(400);
    expect((await getWorklist('?depotId=NOPE')).status).toBe(404);
    session.role = 'VIEWER';
    expect((await getWorklist()).status).toBe(403);
  });

  it('Excel: the rows with the master columns (importable back), per depot and day, and what the file is', async () => {
    const res = await getWorklist('?format=xlsx');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/spreadsheetml/);
    expect(res.headers.get('content-disposition')).toContain(`data-to-collect-${today}.xlsx`);
    const wb = await workbookOf(res);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Data to collect', 'Per depot and day', 'About this file']);
    const rows = rowsOf(wb.worksheets[0]!);
    expect(rows.map((x) => [x.code, x.missing, x.first_delivery, x.depots])).toEqual([
      ['NONE', 'Location and receiving hours', today, 'D1'],
      ['LOW', 'Location and receiving hours', addDaysIso(today, 1), 'D2'],
      ['USABLE', 'Receiving hours', addDaysIso(today, 2), 'D1'],
    ]);
    expect(rows[1]).toMatchObject({ lat: null, location_status: expect.stringMatching(/^Not usable: /), hours_confirmed: null, priority: 3, priority_confirmed: null });
  });
});

describe('item 6: the master row reads back as the same customer', () => {
  const ctx = { area: DEFAULT_SERVICE_AREA, profiles: new Map(), serviceTimeMin: 10, timezone: 'Asia/Muscat' };
  const m = (over: Record<string, unknown> = {}) =>
    ({ ...customer('C', over), regionCode: 'R1', regionName: 'North', depotCode: 'D1', locationVerifiedBy: null, windowConfirmedBy: null, ...over }) as unknown as MasterCustomer;

  it('lat / lng only for an exact or confirmed usable point; a point that is not usable or not exact is left blank (the import never makes it usable)', () => {
    expect(masterValues(m(), ctx)).toMatchObject({ lat: 23.5859, lng: 58.4059, location_status: 'Usable - not confirmed by a dispatcher' });
    expect(masterValues(m({ geocodeConfidence: 'LOW', locationVerified: true }), ctx)).toMatchObject({ lat: 23.5859, location_status: 'Confirmed' });
    expect(masterValues(m({ geocodeConfidence: 'LOW' }), ctx)).toMatchObject({ lat: null, lng: null, location_status: expect.stringMatching(/^Not usable: /) });
    expect(masterValues(m({ geocodeConfidence: 'MEDIUM' }), ctx)).toMatchObject({ lat: null, location_status: 'Usable - not exact, not confirmed by a dispatcher' });
    expect(masterValues(m({ lat: null, lng: null }), ctx)).toMatchObject({ lat: null, google_maps: null, location_status: 'Missing' });
    expect(coordCell(23.585)).toBe('23.5850');
    expect(coordCell(23.5859123)).toBe('23.5859123');
  });

  it("the customer's own hours (never a default), open all day, whether confirmed; the priority with whether confirmed; the unloading time only when confirmed", () => {
    const profiles = new Map([['GROCERY', { customerType: 'GROCERY', defaultPriority: 2, serviceTimeMin: 15, hardWindowStartMin: 420, hardWindowEndMin: 720, prefWindowStartMin: null, prefWindowEndMin: null }]]);
    const typed = masterValues(m({ customerType: 'GROCERY' }), { ...ctx, profiles });
    expect(typed).toMatchObject({
      hard_from: null, hard_to: null, open_all_day: null, hours_confirmed: null, receiving_hours: 'hard 07:00–12:00 (default - not confirmed)',
      priority: 3, priority_confirmed: null, priority_in_use: 'P2 (customer type default)', avg_service_time_min: null, unloading_time: '15 min (customer type default)',
    });
    expect(masterValues(m({ hardWindowStartMin: 360, hardWindowEndMin: 600, windowConfirmedAt: AT, windowConfirmedBy: 'Sara' }), ctx)).toMatchObject({
      hard_from: '06:00', hard_to: '10:00', hours_confirmed: 'yes', hours_confirmed_by: 'Sara', hours_confirmed_at: '2026-09-30 12:00',
    });
    expect(masterValues(m({ windowConfirmedAt: AT }), ctx)).toMatchObject({ open_all_day: 'yes', hours_confirmed: 'yes', receiving_hours: 'Open all day (confirmed)' });
    expect(masterValues(m({ serviceTimeConfirmed: true, avgServiceTimeMin: 25 }), ctx)).toMatchObject({ avg_service_time_min: 25, payment_type: 'credit' });
  });
});

describe("item 6: the import's receiving-hours columns (readImportedHours)", () => {
  const stored = (over: Record<string, unknown> = {}) => ({ hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null, windowConfirmedAt: null, ...over });

  it('a file without them changes nothing; new hours are confirmed by the importer unless hours_confirmed says no', () => {
    expect(readImportedHours({}, stored())).toEqual({ ok: true, change: null });
    expect(readImportedHours({ hard_from: '06:00', hard_to: '10:00', preferred_from: '', preferred_to: '' }, stored())).toEqual({
      ok: true,
      change: { hours: { hardWindowStartMin: 360, hardWindowEndMin: 600, prefWindowStartMin: null, prefWindowEndMin: null }, confirm: 'SET' },
    });
    expect(readImportedHours({ hard_from: '06:00', hard_to: '10:00', hours_confirmed: 'no' }, stored())).toMatchObject({ change: { confirm: 'CLEAR' } });
    expect(readImportedHours({ open_all_day: 'yes', hard_from: '' }, stored())).toMatchObject({ change: { hours: { hardWindowStartMin: null }, confirm: 'SET' } });
  });

  it('unchanged hours: yes confirms them, nothing un-confirms them; blank cells keep the hours', () => {
    const own = stored({ hardWindowStartMin: 360, hardWindowEndMin: 600 });
    expect(readImportedHours({ hard_from: '06:00', hard_to: '10:00', hours_confirmed: 'no' }, own)).toEqual({ ok: true, change: null });
    expect(readImportedHours({ hard_from: '06:00', hard_to: '10:00', hours_confirmed: 'yes' }, own)).toMatchObject({ change: { confirm: 'SET' } });
    expect(readImportedHours({ hard_from: '06:00', hard_to: '10:00', hours_confirmed: 'no' }, { ...own, windowConfirmedAt: AT })).toEqual({ ok: true, change: null });
    expect(readImportedHours({ hard_from: '', hard_to: '', open_all_day: '', hours_confirmed: 'no' }, own)).toEqual({ ok: true, change: null });
    expect(readImportedHours({ open_all_day: 'yes', hours_confirmed: 'yes' }, stored({ windowConfirmedAt: AT }))).toEqual({ ok: true, change: null });
  });

  it('refuses what cannot be meant, in plain words', () => {
    const err = (cells: Record<string, string>) => {
      const r = readImportedHours(cells, stored());
      return r.ok ? null : r.error;
    };
    expect(err({ open_all_day: 'yes', hard_from: '06:00' })).toMatch(/open_all_day is yes but receiving hours are filled in/);
    expect(err({ open_all_day: 'yes', hours_confirmed: 'no' })).toMatch(/which is a confirmation/);
    expect(err({ hours_confirmed: 'yes' })).toMatch(/no receiving hours are filled in/);
    expect(err({ hard_from: '10:00', hard_to: '06:00' })).toBe('hard_to must be after hard_from.');
    expect(err({ hard_from: 'morning' })).toBe('hard_from must be a time like 06:30 (got "morning").');
    expect(err({ open_all_day: 'maybe' })).toMatch(/open_all_day must be yes or no/);
  });

  it('priority_confirmed: without the column every priority is confirmed (as before); blank confirms only a changed one; no never confirms; nothing un-confirms', () => {
    const unconfirmed = { priority: 3, priorityConfirmed: false };
    expect(importedPriority(3, 'ABSENT', unconfirmed)).toEqual({ priority: null, confirm: true });
    expect(importedPriority(3, 'BLANK', unconfirmed)).toEqual({ priority: null, confirm: false });
    expect(importedPriority(2, 'BLANK', unconfirmed)).toEqual({ priority: 2, confirm: true });
    expect(importedPriority(3, 'YES', unconfirmed)).toEqual({ priority: null, confirm: true });
    expect(importedPriority(2, 'NO', unconfirmed)).toEqual({ priority: 2, confirm: false });
    expect(importedPriority(3, 'NO', { priority: 3, priorityConfirmed: true })).toEqual({ priority: null, confirm: false });
    expect(importedPriority(4, 'BLANK', null)).toEqual({ priority: 4, confirm: true });
    expect(importedPriority(4, 'NO', null)).toEqual({ priority: 4, confirm: false });
  });

  it('times as people and Excel write them; yes / no as people write them', () => {
    expect(['06:30', '6:30', '0630', '06:30:00', '6:30 AM', '0.2708333333'].map((s) => cellTime(s, 'x'))).toEqual([390, 390, 390, 390, 390, 390]);
    expect(cellTime('2:15 pm', 'x')).toBe(855);
    expect(cellTime('', 'x')).toBeNull();
    expect(['yes', 'Y', 'TRUE', '1', 'x', 'no', 'N', '0', '', 'perhaps'].map(yesNo)).toEqual([true, true, true, true, true, false, false, false, null, undefined]);
  });
});

describe('item 6: what changed (changeSummary)', () => {
  const since = new Date('2026-09-30T00:00:00Z');
  it('from the audit rows of the period (who, what), its creation and its last change time', () => {
    const s = changeSummary({ createdAt: null, updatedAt: new Date('2026-09-30T09:00:00Z'), createdFromUpload: false }, [
      { action: 'UPDATE', createdAt: new Date('2026-09-30T08:00:00Z'), userName: 'Sara', beforeJson: { hardWindowStartMin: null, name: 'A' }, afterJson: { hardWindowStartMin: 360, name: 'A' } },
      { action: 'CUSTOMER_LOCATION_SET', createdAt: new Date('2026-09-30T08:30:00Z'), userName: 'Ali', beforeJson: {}, afterJson: {} },
      { action: 'UPDATE', createdAt: new Date('2026-09-29T08:00:00Z'), userName: 'Old', beforeJson: { name: 'X' }, afterJson: { name: 'A' } },
    ], since);
    expect(s).toEqual({ at: new Date('2026-09-30T09:00:00Z'), by: 'Sara, Ali', what: 'Receiving hours, Location' });
    expect(changeSummary({ createdAt: new Date('2026-09-30T05:00:00Z'), updatedAt: null, createdFromUpload: true }, [], since)).toEqual({
      at: new Date('2026-09-30T05:00:00Z'), by: 'Order file', what: 'New customer (from an order file)',
    });
    expect(changeSummary({ createdAt: null, updatedAt: new Date('2026-09-29T05:00:00Z'), createdFromUpload: false }, [], since)).toBeNull();
  });
});

describe('item 6: GET /api/customers/master and the import reading it back', () => {
  const master = async (q = '') => masterGet(new Request(`http://localhost/api/customers/master${q}`));

  it('every customer, the ones changed since (default the last 24 hours), the ones still missing, and what the file is', async () => {
    row('customer', 'USABLE').updatedAt = new Date();
    row('customer', 'CONFIRMED').updatedAt = new Date(Date.now() - 3 * 86_400_000);
    tables.auditLog = [{ id: 'a1', tenantId: T, entity: 'Customer', entityId: 'DONE', action: 'UPDATE', createdAt: new Date(), beforeJson: { priority: 4 }, afterJson: { priority: 3 }, user: { name: 'Sara' } }];
    const res = await master();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(`customer-master-${today}.xlsx`);
    const wb = await workbookOf(res);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Customers', 'Changed in last 24 hours', 'Still missing', 'About this file']);
    expect(rowsOf(wb.worksheets[0]!).map((x) => x.code)).toEqual(['CONFIRMED', 'DONE', 'LOW', 'NONE', 'OPEN', 'USABLE']);
    const changed = rowsOf(wb.worksheets[1]!);
    expect(changed.map((x) => [x.code, x.changed_by, x.what_changed])).toEqual([
      ['DONE', 'Sara', 'Priority'],
      ['USABLE', null, 'Changed (no details recorded)'],
    ]);
    expect(rowsOf(wb.worksheets[2]!).map((x) => x.code)).toEqual(['NONE', 'LOW', 'USABLE']);
    // A date chooser: from the company's midnight of that day.
    const since = await workbookOf(await master('?since=2026-09-20'));
    expect(since.worksheets[1]!.name).toBe('Changed since 20 Sep');
    expect(rowsOf(since.worksheets[1]!).map((x) => x.code)).toEqual(['DONE', 'USABLE', 'CONFIRMED']);
    expect((await master('?since=2026-13-45')).status).toBe(400);
    session.role = 'VIEWER';
    expect((await master()).status).toBe(403);
  });

  it('imported back as downloaded (by a dispatcher), it changes nothing: no customer written, no audit row', async () => {
    const before = JSON.parse(JSON.stringify(tables.customer));
    const buf = Buffer.from(await (await master()).arrayBuffer());
    const r = await importXlsx(buf);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ errorRows: 0, creates: 0, updates: 6, unchanged: 6, receivingHoursChanged: 0 });
    expect(JSON.parse(JSON.stringify(tables.customer))).toEqual(before);
    expect(audits.filter((a) => a.action === 'UPDATE')).toEqual([]);
    expect(r.body.data.warnings.join(' ')).not.toMatch(/differ from the customer's saved location/);
    // The admin's import of the same file changes nothing either.
    session.role = 'TENANT_ADMIN';
    expect((await importXlsx(buf)).body.data).toMatchObject({ unchanged: 6 });
    expect(JSON.parse(JSON.stringify(tables.customer))).toEqual(before);
  });

  it("corrected and imported back by a dispatcher: hours set and confirmed by them, open all day, a missing location set; a usable saved location kept (admin only); each change audited", async () => {
    const wb = await workbookOf(await master());
    const ws = wb.getWorksheet('Customers')!;
    const heads = (ws.getRow(1).values as unknown[]).slice(1).map(String);
    const set = (code: string, values: Record<string, string | number | null>) => {
      ws.eachRow((r, n) => {
        if (n === 1 || r.getCell(heads.indexOf('code') + 1).value !== code) return;
        for (const [k, v] of Object.entries(values)) r.getCell(heads.indexOf(k) + 1).value = v;
      });
    };
    set('NONE', { lat: '23.6001', lng: '58.5001', hard_from: '07:00', hard_to: '11:00' });
    set('LOW', { open_all_day: 'yes', hours_confirmed: null });
    set('USABLE', { lat: '23.7001', lng: '58.5001', priority: 2 });
    const r = await importXlsx(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ errorRows: 0, receivingHoursChanged: 2 });
    expect(row('customer', 'NONE')).toMatchObject({ lat: 23.6001, lng: 58.5001, hardWindowStartMin: 420, hardWindowEndMin: 660, windowConfirmedById: 'u1' });
    expect(row('customer', 'NONE').windowConfirmedAt).toBeInstanceOf(Date);
    expect(row('customer', 'LOW')).toMatchObject({ hardWindowStartMin: null, windowConfirmedById: 'u1' });
    // priority_confirmed blank (not confirmed, as downloaded) with a new priority: stored and confirmed by the importer.
    expect(row('customer', 'USABLE')).toMatchObject({ lat: 23.5859, lng: 58.4059, priority: 2, priorityConfirmed: true });
    expect(r.body.data.warnings.join(' ')).toContain(LOCATION_ADMIN_ONLY_MESSAGE);
    expect(audits.filter((a) => a.action === 'UPDATE').map((a) => [a.entityId, Object.keys(a.afterJson).sort().join(',')])).toEqual([
      ['LOW', 'fileName,source,windowConfirmedAt'],
      ['NONE', 'fileName,hardWindowEndMin,hardWindowStartMin,source,windowConfirmedAt'],
      ['USABLE', 'fileName,priority,priorityConfirmed,source'],
    ]);
  });
});
