/**
 * The Crew report (owner request 13 Oct 2026: management wants to know who were the driver and the
 * helpers on each truck and load), on the in-memory database (fake-plan-db.ts): the range rules, one
 * row per load of the plan in use whatever its status, the departure (the Dispatch time, followed
 * through a re-plan's copy, else planned), Back at depot, stops and cases, the company and depot
 * scope, and the workbook read back with exceljs. Also the helpers on the sheets that show the driver.
 */
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, resetDb, tables } from './fake-plan-db';

const session = vi.hoisted(() => ({ role: 'VIEWER' as string, tenantId: 'tA' }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: `u-${session.role}`, tenantId: session.tenantId, role: session.role, name: 'Manager', email: 'm@a.example' } })) }));
vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});

import { buildCrewWorkbook, crewTimeText, readCrewReport } from '@/lib/dispatch/crew-report';
import { CREW_COLUMNS, crewDefaultRange, crewRangeProblem, crewReportUrl, helperTotals, type CrewRow } from '@/lib/dispatch/crew-report-view';
import { GET as getCrewReport } from '@/app/api/dispatch/crew-report/route';
import { loadSheetModel, returnNoteModel } from '@/lib/dispatch/warehouse-sheets';
import { renderLoadSheetHtml, renderReturnNoteHtml } from '@/lib/dispatch/warehouse-sheets-html';
import { driverPackModel, helpersLine } from '@/lib/dispatch/driver-pack';
import { buildDispatchWorkbook, driverWithHelpers } from '@/lib/dispatch/workbook';
import { projectManifest } from '@/lib/driver-link/manifest';
import { helperNames } from '@/lib/driver-page/format';
import { t } from '@/lib/driver-page/i18n';
import { fixture } from './plan-detail-fixture';

const T = 'tA';
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function seed() {
  resetDb();
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, timezone: 'Asia/Muscat' }];
  tables.depot = [
    { id: 'D1', tenantId: T, code: 'MCT', name: 'Muscat' },
    { id: 'D2', tenantId: T, code: 'SOH', name: 'Sohar' },
    { id: 'DX', tenantId: 'tB', code: 'OTHER', name: 'Other company' },
  ];
  tables.truck = [
    { id: 'T1', tenantId: T, code: 'T01', onlyOnDate: null },
    { id: 'T2', tenantId: T, code: 'T02', onlyOnDate: null },
  ];
  tables.driver = [{ id: 'ALI', tenantId: T, code: 'D01', name: 'Ali' }];
  tables.helper = [
    { id: 'SAIF', tenantId: T, code: 'H01', name: 'Saif', active: true },
    { id: 'OMAR', tenantId: T, code: 'H02', name: 'Omar', active: true },
  ];
  // 13 Oct, Muscat: v1 superseded by v2. v2 keeps L1 (dispatched in v1 at 07:12, copied) and plans L2.
  // 14 Oct, Sohar: one planned load. Another company's plan the same day is never read.
  const run = (id: string, depotId: string, date: string, extra: Record<string, unknown> = {}) => ({
    id, tenantId: T, depotId, runDate: day(date), status: 'READY', version: 1, chosenScenarioId: 'sc', supersededAt: null, createdAt: new Date(), ...extra,
  });
  tables.runPlan = [
    run('P1', 'D1', '2026-10-13', { status: 'SUPERSEDED', supersededAt: new Date() }),
    run('P2', 'D1', '2026-10-13', { version: 2 }),
    run('S1', 'D2', '2026-10-14'),
    { ...run('X1', 'DX', '2026-10-13'), tenantId: 'tB' },
  ];
  const load = (id: string, runId: string, truckId: string, loadNo: number, status: string, extra: Record<string, unknown> = {}) => ({
    id, tenantId: T, runId, truckId, loadNo, status, departMin: 360 + loadNo * 180, cases: 100 * loadNo, driverId: 'ALI', carriedFromLoadId: null, truckSnapshotJson: { code: `${truckId === 'T1' ? 'T01' : 'T02'}` }, ...extra,
  });
  tables.planLoad = [
    load('A1', 'P1', 'T1', 1, 'DISPATCHED'),
    load('B1', 'P2', 'T1', 1, 'COMPLETED', { carriedFromLoadId: 'A1' }),
    load('B2', 'P2', 'T1', 2, 'PLANNED', { driverId: null }),
    load('C1', 'S1', 'T2', 1, 'LOCKED'),
    { ...load('Z1', 'X1', 'T1', 1, 'PLANNED'), tenantId: 'tB' },
  ];
  tables.planLoadHelper = [
    { id: 'h1', tenantId: T, loadId: 'B1', helperId: 'OMAR', position: 2 },
    { id: 'h2', tenantId: T, loadId: 'B1', helperId: 'SAIF', position: 1 },
    { id: 'h3', tenantId: T, loadId: 'C1', helperId: 'SAIF', position: 1 },
  ];
  tables.routeAssignment = [
    { id: 'r1', loadId: 'B1', sequenceInTruck: 1 },
    { id: 'r2', loadId: 'B1', sequenceInTruck: 1 },
    { id: 'r3', loadId: 'B1', sequenceInTruck: 2 },
    { id: 'r4', loadId: 'B2', sequenceInTruck: 1 },
  ];
  // Dispatched in v1 at 07:12 Muscat (03:12 UTC); the driver tapped Back at depot at 11:58.
  tables.auditLog = [
    { id: 'a1', tenantId: T, action: 'LOAD_DISPATCHED', entity: 'PlanLoad', entityId: 'A1', createdAt: new Date('2026-10-13T03:12:00Z') },
    // Another company's row naming the same load id is never read.
    { id: 'a2', tenantId: 'tB', action: 'LOAD_DISPATCHED', entity: 'PlanLoad', entityId: 'B1', createdAt: new Date('2026-10-13T05:00:00Z') },
  ];
  tables.stopEvent = [{ id: 'e1', tenantId: T, kind: 'BACK_AT_DEPOT', depotId: 'D1', deliveryDate: day('2026-10-13'), truckId: 'T1', loadNo: 1, at: new Date('2026-10-13T07:58:00Z') }];
}

beforeEach(() => {
  seed();
  session.role = 'VIEWER';
});

describe('the range and the URL', () => {
  it('the last 7 days by default; at most 31 days; "to" not before "from"', () => {
    expect(crewDefaultRange('2026-10-13')).toEqual({ from: '2026-10-07', to: '2026-10-13' });
    expect(crewRangeProblem('2026-10-01', '2026-10-31')).toBeNull();
    expect(crewRangeProblem('2026-10-01', '2026-11-01')).toBe('At most 31 days at a time.');
    expect(crewRangeProblem('2026-10-02', '2026-10-01')).toBe('"To" must not be before "From".');
    expect(crewRangeProblem('', '2026-10-01')).toBe('Choose both dates.');
    expect(crewReportUrl('2026-10-01', '2026-10-07', 'D1')).toBe('/api/dispatch/crew-report?from=2026-10-01&to=2026-10-07&depotId=D1');
    expect(crewReportUrl('2026-10-01', '2026-10-07', null)).toBe('/api/dispatch/crew-report?from=2026-10-01&to=2026-10-07');
  });

  it('a time on the delivery day is HH:MM, on another day with its date (Muscat time)', () => {
    expect(crewTimeText(new Date('2026-10-13T03:12:00Z'), '2026-10-13', 'Asia/Muscat')).toBe('07:12');
    expect(crewTimeText(new Date('2026-10-12T17:40:00Z'), '2026-10-13', 'Asia/Muscat')).toBe('2026-10-12 21:40');
  });
});

describe('readCrewReport: one row per load of the plan in use', () => {
  it('every status, the helpers in order, the Dispatch time through the re-plan copy, Back at depot, stops, cases', async () => {
    const { rows, depot } = await readCrewReport(T, { from: '2026-10-13', to: '2026-10-14' }, null, { db: fakePrisma as never });
    expect(depot).toBeNull();
    expect(rows).toEqual<CrewRow[]>([
      {
        date: '2026-10-13', depot: 'MCT', truck: 'T01', trip: 1, status: 'COMPLETED', driver: 'Ali (D01)', helper1: 'Saif (H01)', helper2: 'Omar (H02)', helper3: '',
        departed: '07:12', departedBasis: 'Dispatched in RouteIQ', backAtDepot: '11:58', stops: 2, cases: 100,
        crew: [{ id: 'SAIF', code: 'H01', name: 'Saif' }, { id: 'OMAR', code: 'H02', name: 'Omar' }],
      },
      {
        date: '2026-10-13', depot: 'MCT', truck: 'T01', trip: 2, status: 'PLANNED', driver: 'Not assigned', helper1: '', helper2: '', helper3: '',
        departed: '12:00', departedBasis: 'Planned', backAtDepot: '', stops: 1, cases: 200, crew: [],
      },
      {
        // A locked load has not left: its planned departure.
        date: '2026-10-14', depot: 'SOH', truck: 'T02', trip: 1, status: 'LOCKED', driver: 'Ali (D01)', helper1: 'Saif (H01)', helper2: '', helper3: '',
        departed: '09:00', departedBasis: 'Planned', backAtDepot: '', stops: 0, cases: 100, crew: [{ id: 'SAIF', code: 'H01', name: 'Saif' }],
      },
    ]);
  });

  it('one depot only, and a range without plans is empty', async () => {
    const { rows, depot } = await readCrewReport(T, { from: '2026-10-13', to: '2026-10-14' }, 'D2', { db: fakePrisma as never });
    expect(depot).toBe('SOH');
    expect(rows.map((r) => `${r.depot} ${r.truck} L${r.trip}`)).toEqual(['SOH T02 L1']);
    expect((await readCrewReport(T, { from: '2026-09-01', to: '2026-09-02' }, null, { db: fakePrisma as never })).rows).toEqual([]);
    await expect(readCrewReport(T, { from: '2026-10-01', to: '2026-11-15' }, null, { db: fakePrisma as never })).rejects.toThrow('range');
  });

  it('the Helpers sheet totals: loads, days and trucks per helper', async () => {
    const { rows } = await readCrewReport(T, { from: '2026-10-13', to: '2026-10-14' }, null, { db: fakePrisma as never });
    expect(helperTotals(rows)).toEqual([
      { code: 'H02', helper: 'Omar', loads: 1, days: 1, trucks: 'T01' },
      { code: 'H01', helper: 'Saif', loads: 2, days: 2, trucks: 'T01, T02' },
    ]);
  });

  it('two helpers who share a name stay two people: the code in every cell, two lines on the Helpers sheet', async () => {
    tables.helper!.push({ id: 'SAIF2', tenantId: T, code: 'H07', name: 'Saif', active: true });
    tables.planLoadHelper = [
      { id: 'h2', tenantId: T, loadId: 'B1', helperId: 'SAIF', position: 1 },
      { id: 'h3', tenantId: T, loadId: 'C1', helperId: 'SAIF2', position: 1 },
    ];
    const { rows } = await readCrewReport(T, { from: '2026-10-13', to: '2026-10-14' }, null, { db: fakePrisma as never });
    expect(rows.map((r) => r.helper1)).toEqual(['Saif (H01)', '', 'Saif (H07)']);
    expect(helperTotals(rows)).toEqual([
      { code: 'H01', helper: 'Saif', loads: 1, days: 1, trucks: 'T01' },
      { code: 'H07', helper: 'Saif', loads: 1, days: 1, trucks: 'T02' },
    ]);
  });

  it('the workbook: a title, the columns asked for, one row per load and the Helpers sheet', async () => {
    const { rows } = await readCrewReport(T, { from: '2026-10-13', to: '2026-10-14' }, null, { db: fakePrisma as never });
    const buf = await buildCrewWorkbook(rows, { tenantName: 'NMWC', from: '2026-10-13', to: '2026-10-14', depot: null, generatedAt: new Date('2026-10-14T10:00:00Z'), generatedBy: 'Manager' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet('Loads')!;
    expect(ws.getCell(1, 1).text).toBe('NMWC · Crew report · 2026-10-13 to 2026-10-14 · every depot');
    const heads = CREW_COLUMNS.map((_, i) => ws.getCell(3, i + 1).text);
    expect(heads).toEqual(['Date', 'Depot', 'Truck', 'Trip', 'Load status', 'Driver', 'Helper 1', 'Helper 2', 'Helper 3', 'Departed', 'Departed from', 'Back at depot', 'Stops', 'Cases']);
    expect(CREW_COLUMNS.map((_, i) => ws.getCell(4, i + 1).value)).toEqual(['2026-10-13', 'MCT', 'T01', 1, 'COMPLETED', 'Ali (D01)', 'Saif (H01)', 'Omar (H02)', '', '07:12', 'Dispatched in RouteIQ', '11:58', 2, 100]);
    expect(ws.getCell(6, 1).text).toBe('2026-10-14');
    expect(ws.getCell(7, 1).text).toBe('');
    const hs = wb.getWorksheet('Helpers')!;
    expect([1, 2, 3, 4, 5].map((c) => hs.getCell(1, c).text)).toEqual(['Code', 'Helper', 'Loads', 'Days', 'Trucks']);
    expect([hs.getCell(2, 1).text, hs.getCell(2, 2).text, hs.getCell(2, 3).value, hs.getCell(3, 2).text, hs.getCell(3, 5).text]).toEqual(['H02', 'Omar', 1, 'Saif', 'T01, T02']);
  });
});

describe('the route: every role, real dates, 31 days at most, the company\'s own depot', () => {
  it('VIEWER downloads it (an .xlsx named by the range and depot); bad ranges 400, another company\'s depot 404', async () => {
    const res = await getCrewReport(new Request('http://localhost/api/dispatch/crew-report?from=2026-10-13&to=2026-10-14&depotId=D1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="crew-report-2026-10-13_2026-10-14-MCT.xlsx"');
    const bad = async (q: string) => (await getCrewReport(new Request(`http://localhost/api/dispatch/crew-report?${q}`))).status;
    expect(await bad('from=2026-10-13&to=2026-11-20')).toBe(400);
    expect(await bad('from=2026-10-14&to=2026-10-13')).toBe(400);
    expect(await bad('from=13-10-2026')).toBe(400);
    // The fake client does not scope by company: the route's depot check runs on the scoped client in production.
    expect(await bad('from=2026-10-13&depotId=NOPE')).toBe(404);
  });
});

describe('the helpers wherever the driver is shown (sheet texts)', () => {
  const withHelpers = () => {
    const d = fixture();
    d.loads[0] = { ...d.loads[0], helpers: [{ id: 'SAIF', code: 'H01', name: 'Saif', phone: null, active: true }, { id: 'OMAR', code: 'H02', name: 'Omar', phone: null, active: true }] };
    d.loads[1] = { ...d.loads[1], helpers: [{ id: 'SAIF', code: 'H01', name: 'Saif', phone: null, active: true }] };
    return d;
  };

  it('the warehouse load sheet and return note have a Helper(s) head cell', () => {
    const d = withHelpers();
    const sheets = loadSheetModel(d, { tenantName: 'NMWC' }).sheets;
    expect(sheets.map((s) => s.helpers)).toEqual(['Saif, Omar', 'Saif', null]);
    const html = renderLoadSheetHtml(loadSheetModel(d, { tenantName: 'NMWC' }));
    expect(html).toContain('<span><b>Helper(s):</b> Saif, Omar</span>');
    expect(html).toContain('<span><b>Helper(s):</b> none</span>');
    // A return note is for a load that left.
    d.loads[0] = { ...d.loads[0], status: 'DISPATCHED' };
    const notes = returnNoteModel(d, { loads: {}, stops: {}, tz: 'Asia/Muscat' } as never, { tenantName: 'NMWC' });
    expect(notes.notes[0]!.helpers).toBe('Saif, Omar');
    expect(renderReturnNoteHtml(notes)).toContain('<span><b>Helper(s):</b> Saif, Omar</span>');
  });

  it('the driver sheet: "Helpers: Saif, Omar" / "Helper: Saif", nothing without one; Latin only', () => {
    const d = withHelpers();
    d.loads[1] = { ...d.loads[1], helpers: [{ id: 'X', code: 'H05', name: 'سالم', phone: null, active: true }] };
    const [s1, s2, s3] = driverPackModel(d, { tenantName: 'NMWC' }).sheets;
    expect(s1!.helpersLine).toBe('Helpers: Saif, Omar');
    expect(s2!.helpersLine).toBe('Helper: [?]');
    expect(s2!.unprintable).toBe(true);
    expect(s3!.helpersLine).toBeNull();
    expect(helpersLine(['Saif'])).toBe('Helper: Saif');
    expect(helpersLine([])).toBeNull();
  });

  it('the Excel workbook: a Helper(s) column beside Driver on LOAD PLAN, and the load sheet\'s Driver cell', async () => {
    const d = withHelpers();
    const buf = await buildDispatchWorkbook(d, { tenantName: 'NMWC', currency: 'OMR', generatedAt: new Date('2026-09-24T13:05:00Z'), generatedBy: 'P', assumptions: {} });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet('LOAD PLAN')!;
    expect([ws.getCell(4, 4).text, ws.getCell(4, 5).text]).toEqual(['Driver', 'Helper(s)']);
    expect([ws.getCell(5, 5).text, ws.getCell(6, 5).text, ws.getCell(7, 5).text]).toEqual(['Saif, Omar', 'Saif', 'None']);
    expect(driverWithHelpers(d.loads[0]!)).toBe('Salim Al Harthy · Helper(s): Saif, Omar');
    expect(driverWithHelpers({ driverName: null, helpers: [] })).toBe('Not assigned');
  });

  it('the driver page header: the truck-day\'s helpers once each, in English and Arabic', () => {
    const d = withHelpers();
    const m = projectManifest([d], {
      truckId: 't1',
      date: '2026-09-25',
      tz: 'Asia/Muscat',
      serverNow: new Date('2026-09-25T04:00:00Z'),
      tenantName: 'NMWC',
      link: { expiresAt: new Date('2026-09-26T00:00:00Z'), uploadUntil: new Date('2026-09-27T00:00:00Z'), generation: 1 },
      truck: { code: 'T01', hired: false },
      casualOf: new Map(),
      settings: { radiusM: 100, photoRequired: true, locationRetentionDays: 30, photoRetentionDays: 90, dispatcherPhone: null },
      office: null,
    });
    expect(m.helpers).toEqual(['Saif', 'Omar']);
    expect(helperNames(m)).toBe('Saif, Omar');
    expect(helperNames({})).toBeNull();
    expect(t('en', 'helpersLabel', { names: 'Saif, Omar' })).toBe('Helper: Saif, Omar');
    expect(t('ar', 'helpersLabel', { names: 'Saif' })).toBe('المساعد: Saif');
  });
});
