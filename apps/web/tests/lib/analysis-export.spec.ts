/**
 * The "Analysis data" Excel (owner request 19 Oct 2026; GET /api/analysis/export, lib/analysis/export.ts) on
 * an in-memory stand-in (analysis-fakes.ts): the roles (no session 401, VIEWER 403, PLANNER and up 200: the pins
 * to review are office data), the range rules (real dates, at most 92 days), another company's depot 404, only
 * the caller's company in the file even when the stand-in does not scope (every read names the company), the
 * sheets, the pins to review (2 or more visits standing 120-500 m off and never within 120 m, the median
 * standing point; a big site's second drop point is never one: review of 19 Oct 2026) and the late result
 * taps; no position anywhere but the office's standing point. Invented data only.
 */
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTruckDayFacts, type TruckDayFacts } from '@/lib/analysis/build';
import { pinsToReview } from '@/lib/analysis/export';
import { analysisDefaultRange, analysisExportUrl, analysisRangeProblem } from '@/lib/analysis/view';
import { distanceM } from '@/lib/dispatch/snapshots';
import { A, C, dayOne, dayPinOff, factDb, SETTINGS } from './analysis-fakes';

const { session, scopedTo } = vi.hoisted(() => ({
  session: { value: null as null | { user: { id: string; name: string; role: string; tenantId: string; email: string } } },
  scopedTo: [] as string[],
}));
const store = vi.hoisted(() => ({ db: null as null | Record<string, any> }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => session.value) }));
vi.mock('@/lib/db', () => ({ prisma: {} }));
// The stand-in does NOT scope by company: the route's own reads must name it.
vi.mock('@/lib/tenant', () => ({
  tenantDb: (tenantId: string) => {
    scopedTo.push(tenantId);
    return store.db;
  },
}));

const { GET } = await import('@/app/api/analysis/export/route');

const NOW = new Date('2026-10-20T00:00:00Z');
const D1 = '2026-10-17';
const D2 = '2026-10-18';
const req = (q: string) => new Request(`http://localhost/api/analysis/export?${q}`);
const as = (role: string, tenantId = 'tA') => (session.value = { user: { id: 'u1', name: 'Office Example', role, tenantId, email: 'office@example.test' } });

/**
 * Two delivery dates of company A - truck T-100 at customer 1's big site (30 min at the pin, then a second drop
 * point 350 m away) and truck T-200 standing 250 m off customer 3's pin both times - and one of company B.
 */
function seed() {
  const db = factDb({ configs: [] });
  const put = (tenantId: string, f: TruckDayFacts) => {
    db.tables.factTruckDay.push({ id: `${tenantId}-td-${db.tables.factTruckDay.length}`, tenantId, ...f.truckDay });
    for (const v of f.visits) db.tables.factVisit.push({ id: `${tenantId}-v-${db.tables.factVisit.length}`, tenantId, ...v });
    for (const l of f.legs) db.tables.factLeg.push({ id: `${tenantId}-l-${db.tables.factLeg.length}`, tenantId, ...l });
    for (const t of f.turns) db.tables.factDepotTurn.push({ id: `${tenantId}-t-${db.tables.factDepotTurn.length}`, tenantId, ...t });
  };
  for (const date of [D1, D2]) {
    const one = dayOne(date);
    put('tA', buildTruckDayFacts(one.input, SETTINGS, { kind: 'TRAIL', points: one.tr.pts, zoneMoves: [], deviceIn: [] }, { now: NOW }));
    const pinOff = dayPinOff(date);
    put('tA', buildTruckDayFacts(pinOff.input, SETTINGS, { kind: 'TRAIL', points: pinOff.tr.pts, zoneMoves: [], deviceIn: [] }, { now: NOW }));
  }
  const b = dayOne(D2);
  put('tB', buildTruckDayFacts({ ...b.input, truckCode: 'T-900' }, SETTINGS, { kind: 'TRAIL', points: b.tr.pts, zoneMoves: [], deviceIn: [] }, { now: NOW }));
  const rows = (list: Record<string, any>[]) => ({
    findMany: async (a: Record<string, any> = {}) => list.filter((r) => Object.entries(a.where ?? {}).every(([k, v]) => (typeof v === 'object' && v && 'in' in v ? (v as { in: unknown[] }).in.includes(r[k]) : r[k] === v))),
    findFirst: async (a: Record<string, any> = {}) => list.find((r) => Object.entries(a.where ?? {}).every(([k, v]) => r[k] === v)) ?? null,
  });
  Object.assign(db, {
    customer: rows([
      { id: 'cust-1', tenantId: 'tA', code: 'TST0001', branchCode: null, name: 'Shop Example One', ...A },
      { id: 'cust-2', tenantId: 'tA', code: 'TST0002', branchCode: 'B2', name: 'Shop Example Two', lat: null, lng: null },
      { id: 'cust-3', tenantId: 'tA', code: 'TST0003', branchCode: null, name: 'Shop Example Three', ...C },
      { id: 'cust-1', tenantId: 'tB', code: 'OTHER01', branchCode: null, name: 'Other company shop', ...A },
    ]),
    depot: rows([
      { id: 'dep-1', tenantId: 'tA', code: 'DEP-A' },
      { id: 'dep-b', tenantId: 'tB', code: 'DEP-B' },
    ]),
    stopVisit: rows([]),
    tenant: rows([
      { id: 'tA', name: 'Example Water Co' },
      { id: 'tB', name: 'Other Co' },
    ]),
  });
  db.tenantConfig.findFirst = async () => ({ timezone: 'Asia/Muscat' });
  store.db = db;
  return db;
}

async function sheets(res: Response): Promise<Record<string, (string | number | boolean | null)[][]>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as never);
  const out: Record<string, (string | number | boolean | null)[][]> = {};
  wb.eachSheet((ws) => {
    const rows: (string | number | boolean | null)[][] = [];
    ws.eachRow((r) => rows.push((r.values as unknown[]).slice(1).map((v) => (v === undefined ? null : (v as string | number | boolean | null)))));
    out[ws.name] = rows;
  });
  return out;
}

beforeEach(() => {
  seed();
  scopedTo.length = 0;
});

describe('GET /api/analysis/export: roles and range', () => {
  it('no session 401, VIEWER 403; PLANNER, SUPERVISOR and the company admin get the workbook', async () => {
    session.value = null;
    expect((await GET(req(`from=${D1}&to=${D2}`))).status).toBe(401);
    as('VIEWER');
    expect((await GET(req(`from=${D1}&to=${D2}`))).status).toBe(403);
    for (const role of ['PLANNER', 'SUPERVISOR', 'TENANT_ADMIN']) {
      as(role);
      const res = await GET(req(`from=${D1}&to=${D2}`));
      expect(res.status, role).toBe(200);
      expect(res.headers.get('content-type')).toContain('spreadsheetml');
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="analysis-data-${D1}_${D2}.xlsx"`);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(scopedTo.every((t) => t === 'tA')).toBe(true);
  });

  it('real dates, "to" not before "from", at most 92 days; another company\'s depot is 404', async () => {
    as('PLANNER');
    const code = async (q: string) => {
      const res = await GET(req(q));
      return [res.status, ((await res.json()) as { error: { code?: string } }).error?.code];
    };
    expect(await code('from=2026-02-30&to=2026-03-01')).toEqual([400, 'INVALID_DATE']);
    expect(await code(`from=${D2}&to=${D1}`)).toEqual([400, 'INVALID_RANGE']);
    expect(await code('from=2026-07-01&to=2026-10-01')).toEqual([400, 'RANGE_TOO_LONG']); // 93 days
    expect((await GET(req('from=2026-07-02&to=2026-10-01'))).status).toBe(200); // 92 days
    expect(await code(`from=${D1}&to=${D2}&depotId=dep-b`)).toEqual([404, 'DEPOT_NOT_FOUND']);
    expect((await GET(req(`from=${D1}&to=${D2}&depotId=dep-1`))).headers.get('content-disposition')).toContain('-DEP-A.xlsx');
  });

  it('the browser-side rules agree with the route', () => {
    expect(analysisDefaultRange('2026-10-19')).toEqual({ from: '2026-09-19', to: '2026-10-18' });
    expect(analysisRangeProblem('2026-07-02', '2026-10-01')).toBeNull();
    expect(analysisRangeProblem('2026-07-01', '2026-10-01')).toMatch(/92 days/);
    expect(analysisRangeProblem(D2, D1)).toMatch(/before/);
    expect(analysisExportUrl(D1, D2, 'dep-1')).toBe(`/api/analysis/export?from=${D1}&to=${D2}&depotId=dep-1`);
  });
});

describe('the workbook', () => {
  it('the sheets, the caller\'s company only, the pins to review and the late result taps', async () => {
    as('PLANNER');
    const s = await sheets(await GET(req(`from=${D1}&to=${D2}`)));
    expect(Object.keys(s)).toEqual(['ReadMe', 'Truck days', 'Visits', 'Sub-stays', 'Legs', 'Depot turns', 'Pins to review', 'Late result taps']);
    const header = (name: string) => s[name]![0]!.map(String);
    const col = (name: string, h: string) => s[name]!.slice(1).map((r) => r[header(name).indexOf(h)]);
    // Company A only: two truck-days of T-100 and T-200 each; company B's T-900 of the same date never in the file.
    expect(col('Truck days', 'Truck')).toEqual(['T-100', 'T-200', 'T-100', 'T-200']);
    expect(col('Visits', 'Truck').every((t) => t === 'T-100' || t === 'T-200')).toBe(true);
    expect(col('Visits', 'Customer')).toEqual(['Shop Example One', 'Shop Example Two', 'Shop Example Three', 'Shop Example One', 'Shop Example Two', 'Shop Example Three']);
    expect(JSON.stringify(s)).not.toContain('Other company shop');
    expect(JSON.stringify(s)).not.toContain('T-900');
    // Customer 3: the truck stood 250 m off the pin on both days -> the one customer to review, with the median
    // standing point. Customer 1's second drop point (350 m, after 30 min at the pin) is no pin to review: its pin
    // is right, and moving it there would make the live detector miss the main drop point (review of 19 Oct 2026).
    expect(col('Pins to review', 'Customer code')).toEqual(['TST0003']);
    expect(col('Pins to review', 'Visits standing 120-500 m off')).toEqual([2]);
    const point = String(col('Pins to review', 'Median standing point (office use only)')[0]);
    const [lat, lng] = point.split(',').map(Number);
    expect(distanceM(C, { lat: lat!, lng: lng! })).toBeGreaterThan(230);
    expect(distanceM(C, { lat: lat!, lng: lng! })).toBeLessThan(270);
    expect(col('Pins to review', 'Pin now to standing point m')[0]).toBeGreaterThan(230);
    const flagsOf = (code: string) => s['Visits']!.slice(1).filter((r) => r[header('Visits').indexOf('Customer code')] === code).map((r) => String(r[header('Visits').indexOf('Flags')]));
    expect(flagsOf('TST0001').every((f) => f.includes('MULTI_DROP') && !f.includes('PIN_OFFSET'))).toBe(true);
    expect(flagsOf('TST0003').every((f) => f.includes('PIN_OFFSET'))).toBe(true);
    // B's result was saved 10 min after leaving, back at the depot: a late result tap on each day.
    expect(col('Late result taps', 'Customer code')).toEqual(['TST0002', 'TST0002']);
    expect((col('Late result taps', 'Truck m from pin at the tap') as number[]).every((m) => m > 4000)).toBe(true);
    // The sub-stays and the trips away from the pin only; the unloading columns; the frozen settings.
    expect(col('Sub-stays', 'Kind').filter((k) => k === 'STANDING').length).toBeGreaterThanOrEqual(4);
    expect(header('Visits')).toEqual(expect.arrayContaining(['Unloading on site (GPS) min', 'Unloading as RouteIQ holds it min', 'Unloading by taps min', 'Waited for the window min', 'Flags', 'Setting: unloading min per case', 'Detector']));
    expect(header('Legs')).toEqual(expect.arrayContaining(['Drive min', 'Planned drive min', 'Km (GPS)', 'Straight km', 'Hour of day']));
    expect(header('Depot turns')).toEqual(expect.arrayContaining(['Minutes (GPS)', 'Minutes (taps)', 'Cases loaded']));
    // No position anywhere but the office's standing point: no coordinate text in the other sheets.
    for (const name of Object.keys(s).filter((n) => n !== 'Pins to review')) {
      const text = JSON.stringify(s[name]);
      for (const c of [A.lat, A.lng, C.lat, C.lng]) expect(text, name).not.toContain(c.toFixed(4));
    }
  });

  it("pinsToReview: 2 or more offset visits; never a big site's second drop point; the standing point from the pin each was planned with; one visit is not enough", () => {
    const db = store.db!;
    const visits = db.tables.factVisit.filter((v: { tenantId: string }) => v.tenantId === 'tA');
    const customers = new Map([
      ['cust-1', { code: 'TST0001', branchCode: null, name: 'Shop Example One', lat: A.lat, lng: A.lng }],
      ['cust-3', { code: 'TST0003', branchCode: null, name: 'Shop Example Three', lat: C.lat, lng: C.lng }],
    ]);
    expect(pinsToReview({ visits, customers, plannedPins: new Map() }).map((r) => [r.customerCode, r.offsetVisits, r.siteVisits])).toEqual([['TST0003', 2, 2]]);
    // Customer 1 stood 350 m off at its second drop point on both days, but 30 min within 25 m of the pin first.
    const one = visits.filter((v: { customerId: string }) => v.customerId === 'cust-1');
    expect(one.map((v: { standDistM: number; pinOffset: boolean }) => [v.standDistM > 330, v.pinOffset])).toEqual([
      [true, false],
      [true, false],
    ]);
    const three = visits.filter((v: { customerId: string }) => v.customerId === 'cust-3');
    expect(pinsToReview({ visits: three.slice(0, 1), customers, plannedPins: new Map() })).toEqual([]);
    // A visit planned with another pin (111 m north of today's): its standing point is moved from that pin, so
    // it lies 250 - 111 = about 139 m from today's pin (250 m when moved from today's).
    const moved = three.map((v: Record<string, unknown>, i: number) => ({ ...v, visitId: `sv-${i}` }));
    const planned = new Map(moved.map((v: { visitId: string }) => [v.visitId, { lat: C.lat + 0.001, lng: C.lng }]));
    const row = pinsToReview({ visits: moved, customers, plannedPins: planned as never })[0]!;
    expect(row.pinNowToStandingM).toBeGreaterThan(120);
    expect(row.pinNowToStandingM).toBeLessThan(160);
    expect(row.standingPoint).not.toBeNull();
  });
});
