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
import { dayLoadingGaps } from '@/lib/dispatch/day-overview';
import {
  buildWorklist,
  cellTime,
  changeSummary,
  confirmNotesSummary,
  resolveIssuesStep,
  DATA_GATE_RULE,
  dataGaps,
  dataGateRefusal,
  deliveryTimeChangedRefusal,
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
const importCsv = async (text: string) => {
  const fd = new FormData();
  fd.set('file', new File([text], 'customers.csv', { type: 'text/csv' }));
  return answer(await customerImport(new Request('http://localhost/api/customers/import', { method: 'POST', body: fd })));
};
/** Sets cells of the row of `code` on a sheet (by header). */
const setCells = (ws: ExcelJS.Worksheet, code: string, values: Record<string, string | number | null>) => {
  const heads = (ws.getRow(1).values as unknown[]).slice(1).map(String);
  ws.eachRow((r, n) => {
    if (n === 1 || r.getCell(heads.indexOf('code') + 1).value !== code) return;
    for (const [k, v] of Object.entries(values)) r.getCell(heads.indexOf(k) + 1).value = v;
  });
};
/** Every text of the "About this file" sheet, one string. */
const aboutText = (wb: ExcelJS.Workbook) => {
  const out: string[] = [];
  wb.getWorksheet('About this file')!.eachRow((r) => r.eachCell((c) => void out.push(String(c.value))));
  return out.join('\n');
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
    expect(dataGateRefusal({ truck: 'T01', loadNo: 2 }, gaps, 'Drop the pin.')).toBe(
      `T01 L2: 2 customers on this load miss data needed before loading - A (Customer A): no delivery window; D (Corner Shop): no location and delivery window. ${DATA_GATE_RULE} Delivery window: ${windowGateRemedy()} Location: Drop the pin.`,
    );
    // Only a planned load is refused for it (frozen loads are never judged again): never "unlock".
    expect(windowGateRemedy()).toMatch(/confirmed with the customer.*then try again.*Or set a delivery time for the order under Delivery times \(step 2\), then RE-PLAN/);
    expect(windowGateRemedy()).not.toMatch(/unlock/i);
  });

  it("the day's \"Loading rule is on\" box lists only what the rule will refuse: never a customer whose orders are all on locked (or later) loads", () => {
    // Per order: 'all' = every case on locked (or later) loads, 'part' = some of it (a split part), 'open' = none.
    const day = (id: string, onLocked: ('all' | 'part' | 'open')[], over: Record<string, unknown> = {}) =>
      ({
        ...customer(id, over), customerId: id, inactive: false,
        orderTimes: onLocked.map((f, i) => ({ orderId: `${id}-${i}`, cases: 5, salesOrders: [], time: null, text: null, frozen: f !== 'open', allFrozen: f === 'all' })),
      }) as never;
    const gaps = dayLoadingGaps(
      [day('ALL_LOCKED', ['all', 'all']), day('PART', ['all', 'open']), day('OPEN', ['open']), day('NOPIN', ['all'], { lat: null, lng: null }), day('SPLIT', ['part'])],
      DEFAULT_SERVICE_AREA,
    );
    // Third review: an order only partly on a locked load has its other part on a PLANNED load, which
    // LOCK refuses (DATA_REQUIRED): its customer is listed although Set time is hidden for that order.
    expect(gaps.map((g) => g.code)).toEqual(['OPEN', 'PART', 'SPLIT']);
  });

  it('step 2 is not "done" while the loading rule is on and customers miss data, and receiving hours are not called optional then', () => {
    const base = { orders: 10, blocking: 0, blockingSummary: '', ruleOn: true, loadingGaps: 12 };
    expect(resolveIssuesStep(base)).toEqual({ done: false, warn: true, summary: '12 customer(s) miss data needed before loading' });
    expect(resolveIssuesStep({ ...base, loadingGaps: 0 })).toEqual({ done: true, warn: false, summary: 'All delivery locations known' });
    expect(resolveIssuesStep({ ...base, ruleOn: false })).toEqual({ done: true, warn: false, summary: 'All delivery locations known' });
    expect(resolveIssuesStep({ ...base, blocking: 2, blockingSummary: '2 customer(s) need a location' })).toEqual({
      done: false, warn: true, summary: '2 customer(s) need a location · 12 customer(s) miss data needed before loading',
    });
    expect(resolveIssuesStep({ ...base, orders: 0, loadingGaps: 0 })).toMatchObject({ done: false, summary: '—' });
    expect(confirmNotesSummary(40, false)).toBe('40 customer(s) to confirm (priority / type / receiving hours) — optional, defaults are used');
    expect(confirmNotesSummary(40, true)).toBe('40 customer(s) to confirm (priority / type / receiving hours) — the loading rule is on: confirmed receiving hours (or a delivery time for the order) are needed before loading');
  });

  it('a delivery time changed after planning: RE-PLAN first, naming the customers', () => {
    expect(deliveryTimeChangedRefusal({ truck: 'T01', loadNo: 2 }, 3, [{ code: 'A', branchCode: 'B2', name: 'Shop A' }, { code: 'C', branchCode: null, name: 'Shop C' }])).toBe(
      'T01 L2: the delivery times of 3 orders were set or changed after this plan was made (A / B2 (Shop A), C (Shop C)). RE-PLAN first, so the stop is planned with the new time and the plan, the Excel, the driver sheet and WhatsApp show it. Then lock the load.',
    );
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

  it('hours already shown that are right are confirmed with yes in hours_confirmed (each row and the About sheet say so); left blank, nothing changes', async () => {
    Object.assign(row('customer', 'USABLE'), { hardWindowStartMin: 360, hardWindowEndMin: 840 });
    const wb = await workbookOf(await getWorklist('?format=xlsx'));
    const ws = wb.worksheets[0]!;
    const rows = rowsOf(ws);
    expect(rows.find((x) => x.code === 'USABLE')).toMatchObject({
      hard_from: '06:00', hard_to: '14:00', hours_confirmed: null,
      what_to_do: expect.stringMatching(/Hours shown are not confirmed.*write yes in hours_confirmed/),
    });
    expect(rows.find((x) => x.code === 'NONE')!.what_to_do).toMatch(/lat and lng/);
    expect(aboutText(wb)).toMatch(/hours already shown are right, write yes in hours_confirmed/);
    expect(aboutText(wb)).not.toMatch(/confirmed by you unless hours_confirmed says no/);
    // Imported back as it is: the hours stay not confirmed (the customer stays on the list).
    expect((await importXlsx(Buffer.from(await wb.xlsx.writeBuffer()))).body.data).toMatchObject({ errorRows: 0, receivingHoursChanged: 0 });
    expect(row('customer', 'USABLE').windowConfirmedAt).toBeNull();
    // yes: confirmed by the importer.
    setCells(ws, 'USABLE', { hours_confirmed: 'yes' });
    expect((await importXlsx(Buffer.from(await wb.xlsx.writeBuffer()))).body.data).toMatchObject({ errorRows: 0, receivingHoursChanged: 1 });
    expect(row('customer', 'USABLE')).toMatchObject({ hardWindowStartMin: 360, hardWindowEndMin: 840, windowConfirmedById: 'u1' });
  });
});

describe('data collection review: files kept for days, odd codes and case twins', () => {
  it('an old file imported after the customer was changed in RouteIQ: that row is skipped and listed (nothing undone, no hours confirmed from it); the rows filled in are imported', async () => {
    // 08:00: the list is downloaded. USABLE shows hours nobody confirmed.
    Object.assign(row('customer', 'USABLE'), { hardWindowStartMin: 480, hardWindowEndMin: 720 });
    const wb = await workbookOf(await getWorklist('?format=xlsx'));
    const ws = wb.worksheets[0]!;
    expect(rowsOf(ws).find((x) => x.code === 'USABLE')!.row_version).toMatch(/^v1-[0-9a-f]+$/);
    // 10:00: a dispatcher confirms USABLE's real hours, sets its priority and corrects its name.
    const at = new Date();
    Object.assign(row('customer', 'USABLE'), { hardWindowStartMin: 420, hardWindowEndMin: 720, windowConfirmedAt: at, windowConfirmedById: 'u2', priority: 1, priorityConfirmed: true, name: 'Customer X (Seeb)' });
    // The collector filled in only NONE, and imports the 08:00 file.
    setCells(ws, 'NONE', { open_all_day: 'yes' });
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const dry = await importXlsx(buf, true);
    expect(dry.body.data.staleRows).toEqual([{ row: 4, code: 'USABLE', branchCode: null }]);
    const r = await importXlsx(buf);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ errorRows: 0, staleRows: [{ code: 'USABLE' }] });
    expect(row('customer', 'USABLE')).toMatchObject({ name: 'Customer X (Seeb)', priority: 1, priorityConfirmed: true, hardWindowStartMin: 420, hardWindowEndMin: 720, windowConfirmedAt: at, windowConfirmedById: 'u2' });
    expect(row('customer', 'NONE')).toMatchObject({ windowConfirmedById: 'u1' });
    expect(r.body.data.warnings.join(' ')).toContain(
      '1 row(s) were not imported: the customer was changed in RouteIQ after this file was downloaded (USABLE). Nothing in those rows was saved. Download a new file and enter those changes again.',
    );
    expect(audits.filter((a) => a.entityId === 'USABLE')).toEqual([]);
  });

  it("a customer whose code the import's own format would refuse (created from an order file) is matched and imported; a new customer with such a code is refused", async () => {
    tables.customer.push(customer('AB 12', { lat: null, lng: null, geocodeConfidence: 'MISSING', locationSource: null, createdFromUpload: true }));
    tables.order.push(order('O9', 'AB 12', 'D1', 1));
    const wb = await workbookOf(await getWorklist('?format=xlsx'));
    const ws = wb.worksheets[0]!;
    expect(rowsOf(ws).map((x) => x.code)).toContain('AB 12');
    setCells(ws, 'NONE', { open_all_day: 'yes' });
    setCells(ws, 'AB 12', { open_all_day: 'yes' });
    const r = await importXlsx(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(r.body.data).toMatchObject({ errorRows: 0, receivingHoursChanged: 2 });
    expect(row('customer', 'AB 12')).toMatchObject({ windowConfirmedById: 'u1' });
    expect(row('customer', 'NONE')).toMatchObject({ windowConfirmedById: 'u1' });
    // Matched whatever its letter case; a new one still needs a plain code.
    expect((await importCsv('code,name,priority\nab 12,Customer AB 12,3\n')).body.data).toMatchObject({ errorRows: 0, creates: 0, updates: 1 });
    expect((await importCsv('code,name,priority\nNEW 1,New Shop,3\n')).body.data.errors).toEqual([{ row: 2, message: 'Invalid code "NEW 1".' }]);
  });

  it('customers whose codes differ only in letter case: the data-to-collect sheet keeps the one the import updates, and lists the other apart (the file imports)', async () => {
    // C001 has a location (the import updates it); c001, older, has none. Both have orders and miss data.
    tables.customer.push(customer('C001'), customer('c001', { lat: null, lng: null, geocodeConfidence: 'MISSING', name: 'Old twin' }));
    tables.order.push(order('O10', 'C001', 'D1', 0), order('O11', 'c001', 'D1', 1));
    let wb = await workbookOf(await getWorklist('?format=xlsx'));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Data to collect', 'Per depot and day', 'Same code, other case', 'About this file']);
    expect(rowsOf(wb.worksheets[0]!).filter((x) => String(x.code).toUpperCase() === 'C001').map((x) => x.code)).toEqual(['C001']);
    expect(rowsOf(wb.getWorksheet('Same code, other case')!).map((x) => [x.code, x.name, x.imported_as])).toEqual([['c001', 'Old twin', 'C001']]);
    expect(aboutText(wb)).toMatch(/Same code, other case.*For reading only: the import updates the customer with the code in imported_as/);
    setCells(wb.worksheets[0]!, 'C001', { open_all_day: 'yes' });
    const r = await importXlsx(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(r.body.data).toMatchObject({ errorRows: 0, receivingHoursChanged: 1 });
    expect(row('customer', 'C001').windowConfirmedById).toBe('u1');
    // Only the older twin misses data: it is listed apart, so its data is not imported onto the other.
    Object.assign(row('customer', 'C001'), { locationVerified: true });
    wb = await workbookOf(await getWorklist('?format=xlsx'));
    expect(rowsOf(wb.worksheets[0]!).some((x) => String(x.code).toUpperCase() === 'C001')).toBe(false);
    expect(rowsOf(wb.getWorksheet('Same code, other case')!).map((x) => [x.code, x.imported_as])).toEqual([['c001', 'C001']]);
  });

  it('24:00 typed in Excel as a time (stored as 1) is read as the end of the day in an end column', () => {
    expect(cellTime('1', 'hard_to')).toBe(1440);
    expect(cellTime('0.99999999', 'preferred_to')).toBe(1440);
    expect(() => cellTime('1', 'hard_from')).toThrow('hard_from must be a time like 06:30 (got "1").');
    expect(readImportedHours({ hard_from: '0.75', hard_to: '1' }, null)).toMatchObject({ ok: true, change: { hours: { hardWindowStartMin: 1080, hardWindowEndMin: 1440 } } });
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

  it('hours ending at the end of the day are written 24:00 and read back as the same hours', () => {
    const own = { hardWindowStartMin: 1080, hardWindowEndMin: 1440, prefWindowStartMin: 1200, prefWindowEndMin: 1440, windowConfirmedAt: AT };
    const v = masterValues(m(own), ctx);
    expect(v).toMatchObject({ hard_from: '18:00', hard_to: '24:00', preferred_from: '20:00', preferred_to: '24:00', hours_confirmed: 'yes' });
    const cells = Object.fromEntries(['hard_from', 'hard_to', 'preferred_from', 'preferred_to', 'open_all_day', 'hours_confirmed'].map((k) => [k, String(v[k] ?? '')]));
    expect(readImportedHours(cells, own)).toEqual({ ok: true, change: null });
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

  it('"Changed since" also lists customers deleted in the period, and changes to customers of the "Same code, other case" sheet (marked)', async () => {
    tables.customer.push(customer('usable', { name: 'Old twin', active: false }));
    const now = Date.now();
    tables.auditLog = [
      { id: 'a1', tenantId: T, entity: 'Customer', entityId: 'GONE', action: 'DELETE', createdAt: new Date(now - 60_000), beforeJson: { code: 'GONE', branchCode: 'B2', name: 'Gone Shop' }, afterJson: null, user: { name: 'Admin One' } },
      { id: 'a2', tenantId: T, entity: 'Customer', entityId: 'usable', action: 'UPDATE', createdAt: new Date(now - 120_000), beforeJson: { active: true }, afterJson: { active: false }, user: { name: 'Sara' } },
    ];
    const wb = await workbookOf(await master());
    const changed = rowsOf(wb.worksheets[1]!);
    expect(changed.map((x) => [x.code, x.branch_code, x.name, x.changed_by, x.what_changed])).toEqual([
      ['GONE', 'B2', 'Gone Shop', 'Admin One', 'Deleted'],
      ['usable', null, 'Old twin', 'Sara', 'Active (same code as USABLE in another letter case: on the "Same code, other case" sheet, not imported)'],
    ]);
    // Neither is on the Customers sheet the import reads.
    expect(rowsOf(wb.worksheets[0]!).map((x) => x.code)).not.toContain('GONE');
    expect(rowsOf(wb.worksheets[0]!).map((x) => x.code)).not.toContain('usable');
  });

  it('"Changed since" goes back at most 31 days (the audit rows are read into the web process)', async () => {
    const day = (n: number) => addDaysIso(today, -n);
    expect((await master(`?since=${day(31)}`)).status).toBe(200);
    const old = await answer(await master(`?since=${day(32)}`));
    expect(old.status).toBe(400);
    expect(JSON.stringify(old.body.error)).toMatch(/at most 31 days back/);
  });

  it('imported back as downloaded (by a dispatcher), it changes nothing: no customer written, no audit row', async () => {
    // Hours to the end of the day; an exact point saved without a source (POST /api/customers); an
    // older twin whose code differs only in letter case (listed apart, not imported).
    Object.assign(row('customer', 'DONE'), { hardWindowStartMin: 1080, hardWindowEndMin: 1440 });
    row('customer', 'USABLE').locationSource = null;
    tables.customer.push(customer('usable', { name: 'Old twin' }));
    const before = JSON.parse(JSON.stringify(tables.customer));
    const res = await master();
    const buf = Buffer.from(await res.clone().arrayBuffer());
    const wb = await workbookOf(res);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Customers', 'Changed in last 24 hours', 'Still missing', 'Same code, other case', 'About this file']);
    expect(rowsOf(wb.getWorksheet('Customers')!).filter((x) => String(x.code).toUpperCase() === 'USABLE').map((x) => x.code)).toEqual(['USABLE']);
    expect(rowsOf(wb.getWorksheet('Same code, other case')!).map((x) => [x.code, x.name, x.imported_as])).toEqual([['usable', 'Old twin', 'USABLE']]);
    expect(rowsOf(wb.getWorksheet('Customers')!).find((x) => x.code === 'DONE')).toMatchObject({ hard_from: '18:00', hard_to: '24:00' });
    const r = await importXlsx(buf);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ errorRows: 0, creates: 0, updates: 6, unchanged: 6, receivingHoursChanged: 0 });
    expect(JSON.parse(JSON.stringify(tables.customer))).toEqual(before);
    expect(audits.filter((a) => a.action === 'UPDATE')).toEqual([]);
    expect(r.body.data.warnings.join(' ')).not.toMatch(/differ from the customer's saved location/);
    // One plain count for the customers without a usable location (NONE, LOW), none per row.
    expect(r.body.data.warnings.join(' ')).not.toMatch(/geocode|missing coordinates/);
    expect(r.body.data.warnings.filter((w: string) => /have no usable location/.test(w))).toEqual([
      '2 customer(s) in the file have no usable location and no lat / lng in the file. Their orders are not planned or sent out until the pin is dropped (ADD LOCATION on Daily dispatch, or Set location on the customer page).',
    ]);
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
    // The location set for NONE has its own row (who, from what to what), for "Changed since".
    expect(audits.filter((a) => a.action === 'CUSTOMER_LOCATION_SET').map((a) => [a.entityId, a.userId, a.beforeJson.lat, a.afterJson.lat])).toEqual([['NONE', 'u1', null, 23.6001]]);
  });

  it('each customer the import creates, or whose location it sets or marks not usable, gets its own audit row', async () => {
    session.role = 'TENANT_ADMIN';
    // NEW1: created with an exact point. USABLE: the file points elsewhere, not exact (marked LOW).
    // CONFIRMED: not in the file.
    const r = await importCsv('code,name,priority,lat,lng\nNEW1,New Shop,3,23.6101,58.5101\nUSABLE,Customer USABLE,3,23.70,58.50\n');
    expect(r.body.data).toMatchObject({ errorRows: 0, creates: 1 });
    const created = tables.customer.find((c) => c.code === 'NEW1')!;
    expect(audits.find((a) => a.action === 'CREATE' && a.entityId === created.id)).toMatchObject({ userId: 'u1', afterJson: { code: 'NEW1', name: 'New Shop', lat: 23.6101, lng: 58.5101, source: 'IMPORT' } });
    expect(audits.find((a) => a.action === 'UPDATE' && a.entityId === 'USABLE' && 'geocodeConfidence' in a.afterJson)).toMatchObject({
      userId: 'u1', beforeJson: { geocodeConfidence: 'HIGH' }, afterJson: { geocodeConfidence: 'LOW', source: 'IMPORT' },
    });
    expect(row('customer', 'USABLE').geocodeConfidence).toBe('LOW');
  });
});
