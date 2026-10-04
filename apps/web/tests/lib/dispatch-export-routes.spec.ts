/**
 * Audit F16 (27 Sep 2026): GET /api/runs/:id/export/excel and /export/pdf pick the dispatch
 * generator by the isDispatchPlan discriminator (lib/dispatch/legacy-runs.ts), not by the load
 * count. A dispatch plan in which every order is unserved has no load: it got the legacy route
 * sheet (Summary + Unserved) instead of the dispatch workbook with its UNSERVED - EXCEPTIONS,
 * RECONCILIATION and ASSUMPTIONS sheets. The driver sheets (PDF) stay one sheet per load: none for
 * such a plan (404 NO_LOADS), never the legacy route sheet. The run lookup below evaluates the real
 * where clause (DISPATCH_PLAN_WHERE) and refuses any shape it does not model.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { fixture, ORDERS, PRODUCTS } from './plan-detail-fixture';
import type { PlanDetail } from '@/lib/dispatch/plan-detail';

interface FakeRun {
  id: string;
  tenantId: string;
  loadCount: number;
  scenarioNames: string[];
  version: number;
}
const state = vi.hoisted(() => ({ runs: [] as FakeRun[], detail: null as unknown, legacyBuilt: [] as string[], driverPacks: 0, packOpts: null as unknown }));

/** A Prisma RunPlan where clause, as far as the discriminator uses it (anything else throws). */
function matches(run: FakeRun, where: Record<string, any>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(v as Record<string, any>[]).some((w) => matches(run, w))) return false;
    } else if (k === 'id' || k === 'tenantId') {
      if (run[k] !== v) return false;
    } else if (k === 'loads' && JSON.stringify(v) === '{"some":{}}') {
      if (run.loadCount === 0) return false;
    } else if (k === 'scenarios' && typeof v?.some?.name === 'string' && Object.keys(v.some).length === 1) {
      if (!run.scenarioNames.includes(v.some.name)) return false;
    } else if (k === 'version' && typeof v?.gt === 'number' && Object.keys(v).length === 1) {
      if (!(run.version > v.gt)) return false;
    } else throw new Error(`where clause not modelled: ${k} ${JSON.stringify(v)}`);
  }
  return true;
}

const session = vi.hoisted(() => ({ role: 'VIEWER' }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: session.role, name: 'Viewer', email: 'v@a.example' } })) }));
vi.mock('@/lib/db', () => ({
  prisma: {
    runPlan: { findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) => state.runs.find((r) => matches(r, where)) ?? null) },
    tenant: { findUnique: vi.fn(async () => ({ name: 'NMWC', currency: 'OMR', country: 'Oman' })) },
  },
}));
vi.mock('@/lib/tenant', () => ({
  tenantDb: () => ({
    tenantConfig: { findUnique: vi.fn(async () => null) },
    // The old choice by load count: kept answering, so a route still asking it is caught below.
    planLoad: { count: vi.fn(async ({ where }: { where: { runId: string } }) => state.runs.find((r) => r.id === where.runId)?.loadCount ?? 0) },
  }),
}));
vi.mock('@/lib/dispatch/plan-detail', () => ({ getPlanDetail: vi.fn(async () => state.detail) }));
vi.mock('@/lib/exports/route-sheet-data', async (importActual) => ({
  ...((await importActual()) as object),
  buildRouteSheet: vi.fn(async (_t: string, runId: string) => {
    state.legacyBuilt.push(runId);
    return {
      tenant: { name: 'NMWC', currency: 'OMR' },
      run: { id: runId, runDate: '2026-05-10', depotCode: 'MCT', depotName: 'Muscat', optimizationMode: 'BALANCED', status: 'READY', finalizedAt: null, chosenScenarioName: 'BALANCED', distanceProvider: 'OSRM', distanceIsEstimated: false },
      routes: [],
      unserved: [],
      totals: { trucks: 0, stops: 0, cases: 0, weightKg: 0, distanceKm: 0 },
      baselineComparison: null,
    };
  }),
}));
vi.mock('@/lib/exports/pdf', () => ({ buildRouteSheetPdf: vi.fn(async () => Buffer.from('%PDF-legacy')) }));
// Owner request 4 Oct 2026: the driver-link QR per truck-day, ensured only for PLANNER and above.
const links = vi.hoisted(() => ({ calls: [] as string[], failFor: null as string | null, known: [] as Record<string, unknown>[] }));
vi.mock('@/lib/driver-link/service', () => ({
  listLinks: vi.fn(async () => links.known),
  ensureLink: vi.fn(async (_t: string, _r: string, truckId: string) => {
    links.calls.push(truckId);
    if (truckId === links.failFor) throw Object.assign(new Error('Plan is being saved'), { status: 409, details: { code: 'PLAN_BUSY' } });
    if (truckId === 't2') return { url: null, revoked: true };
    return { url: `https://routeiq.example/d/link-of-${truckId}`, revoked: false };
  }),
}));
vi.mock('@/lib/dispatch/driver-pack', () => ({
  driverPackModel: vi.fn((_d: unknown, opts: unknown) => {
    state.packOpts = opts;
    return {};
  }),
  renderDriverPackPdf: vi.fn(async () => {
    state.driverPacks++;
    return Buffer.from('%PDF-driver');
  }),
}));

import { GET as excelGet } from '@/app/api/runs/[id]/export/excel/route';
import { GET as pdfGet } from '@/app/api/runs/[id]/export/pdf/route';
import { DISPATCH_PLAN_WHERE, isDispatchPlanShape } from '@/lib/dispatch/legacy-runs';

function allUnserved(): PlanDetail {
  const d = fixture();
  const casesOf = (o: (typeof ORDERS)[number]) => o.lines.reduce((a, l) => a + l.cases, 0);
  const kgOf = (o: (typeof ORDERS)[number]) => o.lines.reduce((a, l) => a + l.cases * PRODUCTS[l.sku].kg, 0);
  return {
    ...d,
    loads: [],
    isDispatchPlan: true,
    unserved: ORDERS.map((o) => ({
      orderId: o.id, customerId: o.customerId, customerCode: o.code, branchCode: o.branch, customerName: o.name, cases: casesOf(o), weightKg: kgOf(o),
      priority: o.priority, reasonCode: 'NO_AVAILABLE_TRUCK', reasonMessage: 'No truck available for this order.', late: o.late, salesOrders: o.lines.map((l) => l.so), partial: false,
    })) as PlanDetail['unserved'],
  };
}

const get = (handler: typeof excelGet, id: string) => handler(new Request(`http://localhost/api/runs/${id}/export/x`), { params: { id } });

async function sheetNames(res: Response): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  return wb.worksheets.map((w) => w.name);
}

beforeEach(() => {
  state.runs = [
    // Applied dispatch plan, every order unserved: a RECOMMENDED option, no load.
    { id: 'allUnserved', tenantId: 'tA', loadCount: 0, scenarioNames: ['RECOMMENDED', 'MIN_TRUCKS', 'MIN_DISTANCE'], version: 1 },
    { id: 'withLoads', tenantId: 'tA', loadCount: 3, scenarioNames: ['RECOMMENDED'], version: 1 },
    // A May-2026 legacy run.
    { id: 'legacy', tenantId: 'tA', loadCount: 0, scenarioNames: ['BALANCED', 'MIN_COST'], version: 1 },
  ];
  state.detail = allUnserved();
  state.legacyBuilt = [];
  state.driverPacks = 0;
  state.packOpts = null;
  session.role = 'VIEWER';
  links.calls = [];
  links.failFor = null;
});

describe('GET /api/runs/:id/export/excel (audit F16)', () => {
  it('a dispatch plan with every order unserved gets the dispatch workbook (before: the legacy route sheet)', async () => {
    const res = await get(excelGet, 'allUnserved');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="nmwc-dispatch-/);
    const names = await sheetNames(res);
    expect(names).toEqual(expect.arrayContaining(['SUMMARY', 'UNSERVED - EXCEPTIONS', 'RECONCILIATION', 'ASSUMPTIONS']));
    expect(state.legacyBuilt).toEqual([]);
  });

  it('a legacy run keeps the legacy route sheet', async () => {
    const res = await get(excelGet, 'legacy');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/filename="routeiq-MCT-2026-05-10\.xlsx"/);
    expect(state.legacyBuilt).toEqual(['legacy']);
  });
});

describe('GET /api/runs/:id/export/pdf stays driver sheets only (audit F16)', () => {
  it('a dispatch plan without loads has no driver sheets: 404 NO_LOADS, never the legacy route sheet', async () => {
    const res = await get(pdfGet, 'allUnserved');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatchObject({ code: 'NO_LOADS', message: expect.stringMatching(/no loads, so there are no driver sheets/) });
    expect(state.legacyBuilt).toEqual([]);
    expect(state.driverPacks).toBe(0);
  });

  it('a dispatch plan with loads gets its driver sheets; a legacy run its route sheet', async () => {
    state.detail = fixture();
    const res = await get(pdfGet, 'withLoads');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^inline; filename="driver-sheets-/);
    expect(state.driverPacks).toBe(1);
    const legacy = await get(pdfGet, 'legacy');
    expect(legacy.status).toBe(200);
    expect(state.legacyBuilt).toEqual(['legacy']);
  });
});

describe('isDispatchPlanShape is DISPATCH_PLAN_WHERE for a plan already read', () => {
  it('agrees with the where clause on every combination', () => {
    for (const loadCount of [0, 2]) {
      for (const scenarioNames of [[], ['RECOMMENDED'], ['BALANCED'], ['MIN_TRUCKS', 'RECOMMENDED']]) {
        for (const version of [1, 2]) {
          const run = { id: 'r', tenantId: 't', loadCount, scenarioNames, version };
          expect(isDispatchPlanShape(run), JSON.stringify(run)).toBe(matches(run, DISPATCH_PLAN_WHERE));
        }
      }
    }
  });
});

describe('GET /api/runs/:id/export/pdf prints the driver link for PLANNER and above only (owner request 4 Oct 2026)', () => {
  it('a VIEWER: no link is made, the sheets say "ask the dispatcher"', async () => {
    state.detail = fixture();
    const res = await get(pdfGet, 'withLoads');
    expect(res.status).toBe(200);
    expect(links.calls).toEqual([]);
    expect((state.packOpts as { driverLinks?: unknown }).driverLinks).toBeUndefined();
  });

  it('a PLANNER: one ensure per truck-day; a revoked link prints "stopped"; a failure prints the placeholder and never fails the pack', async () => {
    session.role = 'PLANNER';
    state.detail = fixture();
    links.failFor = 'tX';
    const res = await get(pdfGet, 'withLoads');
    expect(res.status).toBe(200);
    expect(links.calls).toEqual(['t1', 't2']);
    const m = (state.packOpts as { driverLinks: Map<string, unknown> }).driverLinks;
    expect(m.get('t1')).toEqual({ kind: 'QR', url: 'https://routeiq.example/d/link-of-t1' });
    expect(m.get('t2')).toEqual({ kind: 'STOPPED' });
    links.failFor = 't1';
    links.calls = [];
    const again = await get(pdfGet, 'withLoads');
    expect(again.status).toBe(200);
    expect((state.packOpts as { driverLinks: Map<string, unknown> }).driverLinks.get('t1')).toEqual({ kind: 'ASK' });
    expect(state.driverPacks).toBe(2);
    // Links that already work are read in one batch: no transaction per truck for them.
    links.failFor = null;
    links.calls = [];
    links.known = [{ truckId: 't1', url: 'https://routeiq.example/d/known-t1', revoked: false, driverIdAtIssue: 'd1' }];
    try {
      expect((await get(pdfGet, 'withLoads')).status).toBe(200);
      expect(links.calls).toEqual(['t2']);
      expect((state.packOpts as { driverLinks: Map<string, unknown> }).driverLinks.get('t1')).toEqual({ kind: 'QR', url: 'https://routeiq.example/d/known-t1' });
    } finally {
      links.known = [];
    }
  });
});
