/**
 * TRUCK CAPACITY IN PALLETS (owner decision 4 Oct 2026) - end-to-end against the running web app +
 * solver:
 *
 *  - a product of the day without cases per pallet, on a depot with trucks that have bays, refuses
 *    OPTIMIZE with 409 PALLET_FACTOR_REQUIRED (no override, also with every "optimize anyway"), and the
 *    day screen lists it; with the factor entered the day is planned;
 *  - the plan is made by pallets: every load on a truck with bays keeps its room (bays x Pallet fill) in
 *    its snapshot, stores the pallet units of each row exactly as sent, and its own units are the sum
 *    of its rows' - within the room; the case capacity is not a limit (a 300-case order rides a truck
 *    whose case capacity is 120); the independent check and the web gate verify it;
 *  - (part B) the plan detail gives each load its pallets, bays, fill and room, each manifest product
 *    its full pallets + loose cases with the planned factor (adding up to the load), the summary the
 *    day's pallets; the Excel export works; the products import's Validate only writes nothing;
 *  - a cases per pallet corrected after planning makes the plan out of date (outdated.palletFactorCases)
 *    and LOCK is refused for a load the new figure puts over its bays (CAPACITY_PALLETS_NEW_FACTOR);
 *  - LOCK is refused for a load whose stored units are over its bays (an edit in the database);
 *  - a re-plan copies a locked load's units unchanged.
 *
 * Requires: dev server (RATE_LIMITS_DISABLED=1) + solver running (the solver of this release: an
 * older one plans by cases and the plan says so).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, fetchWith, freshTenant, prisma, type TenantHandle } from './helpers';
import { palletUnits } from '@/lib/dispatch/pallets';

let t: TenantHandle;
let depotId = '';
let day = '';
let runV1 = '';

const FACTORS: Record<string, number> = { 'JA0.5L': 96, 'TN1.5L': 39, 'NEW-PAL': 84 };

function isoPlus(n: number) {
  const d = new Date(Date.now() + 4 * 3600_000); // Muscat
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dmy(iso: string) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
const j = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Upload and confirm rows [so, customer, item, cases] for the day. */
async function addOrders(date: string, rows: string[][]) {
  const head = ['SO No', 'Req. Delivery Date', 'Customer Code', 'Item Code', 'Qty (Cases)'];
  const fd = new FormData();
  fd.set('file', new Blob([[head, ...rows.map(([so, c, i, q]) => [so, dmy(date), c, i, q])].map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), `p-${date}.csv`);
  fd.set('depotId', depotId);
  fd.set('deliveryDate', date);
  const up = await fetchWith(t.cookieJar, `${BASE}/api/orders/upload`, { method: 'POST', body: fd });
  expect(up.status).toBe(200);
  const v = (await json(up)).data;
  expect(v.validation.errorRows).toBe(0);
  const c = await fetchWith(t.cookieJar, `${BASE}/api/orders/${v.batchId}/confirm`, j(v.validation.late.isLate ? { lateReason: 'Test' } : {}));
  expect(c.status).toBe(200);
}

async function waitForPlan(runId: string, max = 120) {
  for (let i = 0; i < max; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/status`));
    if (st.data.run.status !== 'OPTIMIZING' && st.data.job?.status !== 'RUNNING' && st.data.job?.status !== 'QUEUED') return st.data;
  }
  throw new Error('optimization did not finish');
}
const optimize = (extra: Record<string, unknown> = {}) => fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date: day, depotId, optimize: true, ...extra }));
const dayView = async () => (await json(await fetchWith(t.cookieJar, `${BASE}/api/dispatch/day?date=${day}&depotId=${depotId}`))).data;

/** The units a row should have: each of its order's lines (or portion lines) rounded up, added up. */
async function expectedRowUnits(a: { orderId: string; portionLinesJson: unknown }): Promise<number> {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: a.orderId }, include: { lines: { include: { product: true } } } });
  const portion = Array.isArray(a.portionLinesJson) ? (a.portionLinesJson as { lineId: string; cases: number }[]) : null;
  const lines = portion ?? o.lines.map((l) => ({ lineId: l.id, cases: l.cases }));
  return lines.reduce((s, x) => s + palletUnits(x.cases, o.lines.find((l) => l.id === x.lineId)!.product.casesPerPallet), 0);
}

beforeAll(async () => {
  t = await freshTenant('pallets');
  day = isoPlus(2);
  await prisma.tenantConfig.update({
    where: { tenantId: t.tenantId },
    data: { timezone: 'Asia/Muscat', planningCutoffMin: 18 * 60, shiftStartMin: 360, driverShiftMaxMinutes: 720, distanceProvider: 'HAVERSINE', osrmUrl: null, palletFillPct: 95 },
  });
  depotId = (await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'MCT', name: 'Muscat depot', lat: 23.568, lng: 58.392, openMin: 300, closeMin: 1380 } })).id;
  // A 12-bay truck whose case capacity (120) is far below what its bays take, and a 2-bay one.
  await prisma.truck.create({ data: { tenantId: t.tenantId, depotId, code: 'R12', capacityCases: 120, capacityWeightKg: 10_000, fixedCostPerDay: 20, costPerKm: 0.08, bays: 12 } });
  await prisma.truck.create({ data: { tenantId: t.tenantId, depotId, code: 'R02', capacityCases: 190, capacityWeightKg: 3_000, fixedCostPerDay: 15, costPerKm: 0.06, bays: 2 } });
  await prisma.product.create({ data: { tenantId: t.tenantId, code: 'JA0.5L', name: 'Jabal 0.5L', weightPerCaseKg: 6, casesPerPallet: 96 } });
  await prisma.product.create({ data: { tenantId: t.tenantId, code: 'TN1.5L', name: 'Tanuf 1.5L', weightPerCaseKg: 10, casesPerPallet: 39 } });
  await prisma.product.create({ data: { tenantId: t.tenantId, code: 'NEW-PAL', name: 'New pallet SKU', weightPerCaseKg: 5 } }); // no factor yet
  for (const [code, lat, lng] of [['C1', 23.588, 58.41], ['C2', 23.6, 58.372], ['C3', 23.555, 58.335]] as const) {
    await prisma.customer.create({
      data: { tenantId: t.tenantId, code, name: code, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 2, priorityConfirmed: true },
    });
  }
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

describe('truck capacity in pallets', () => {
  it('a product without cases per pallet refuses OPTIMIZE, no override; the day lists it; with the factor the day is planned', async () => {
    await addOrders(day, [
      ['SO-1', 'C1', 'JA0.5L', '300'], // 3.125 pallets, 1,800 kg: only the 12-bay truck, whose case capacity is 120
      ['SO-2', 'C2', 'TN1.5L', '60'],
      ['SO-2', 'C2', 'NEW-PAL', '20'],
      ['SO-3', 'C3', 'JA0.5L', '40'],
    ]);
    expect((await dayView()).productsWithoutPalletFactor.map((p: any) => p.code)).toEqual(['NEW-PAL']);
    for (const extra of [{}, { allowMissingLocations: true, allowMissingWeights: true }]) {
      const r = await optimize(extra);
      expect(r.status).toBe(409);
      const b = await json(r);
      expect(b.error.code).toBe('PALLET_FACTOR_REQUIRED');
      expect(b.error.missingPalletFactors.map((m: any) => [m.productCode, m.cases])).toEqual([['NEW-PAL', 20]]);
      expect(b.error.error).toMatch(/^Cannot plan by pallets: 1 product\(s\)/);
    }
    expect(await prisma.runJob.count({ where: { tenantId: t.tenantId } })).toBe(0);

    await prisma.product.updateMany({ where: { tenantId: t.tenantId, code: 'NEW-PAL' }, data: { casesPerPallet: FACTORS['NEW-PAL'] } });
    expect((await dayView()).productsWithoutPalletFactor).toEqual([]);
    const r = await optimize();
    expect(r.status).toBe(202);
    runV1 = (await json(r)).data.runId;
    expect((await waitForPlan(runV1)).run.status).toBe('READY');
  });

  it('every load is planned by pallets: room in the snapshot, row units as sent, load units = their sum, within the bays', async () => {
    const loads = await prisma.planLoad.findMany({ where: { runId: runV1 }, include: { truck: true, assignments: true } });
    expect(loads.length).toBeGreaterThan(0);
    for (const l of loads) {
      const snap = l.truckSnapshotJson as any;
      expect(snap.bays).toBe(l.truck.bays);
      expect(snap.palletRoomUnits).toBe((l.truck.bays as number) * 95 * 10);
      expect(snap.rules.pallets).toEqual({ fillPct: 95, unit: 0.001 });
      for (const a of l.assignments) expect(a.palletUnits).toBe(await expectedRowUnits(a));
      expect(l.palletUnits).toBe(l.assignments.reduce((s, a) => s + (a.palletUnits ?? 0), 0));
      expect(l.palletUnits).toBeLessThanOrEqual(snap.palletRoomUnits);
    }
    // The case capacity is not a limit on a truck with bays: the 300-case order rides the 12-bay truck.
    const big = loads.find((l) => l.cases >= 300)!;
    expect(big.truck.code).toBe('R12');
    expect(big.cases).toBeGreaterThan(big.truck.capacityCases);
    const run = await prisma.runPlan.findUniqueOrThrow({ where: { id: runV1 } });
    const sc = await prisma.scenarioResult.findUniqueOrThrow({ where: { id: run.chosenScenarioId! } });
    const d = sc.detailsJson as any;
    expect(d.pallet_unit).toBe(0.001);
    expect(d.pallet_fill_pct).toBe(95);
    expect(d.feasibility.status).toBe('VERIFIED');
    expect(d.inputs.palletFactors).toEqual(FACTORS);
    expect((run.feasibilityJson as any).ok).toBe(true);
  });

  it('part B: the plan, the summary and the Excel show pallets beside the cases (each product in full pallets + loose cases)', async () => {
    const loads = await prisma.planLoad.findMany({ where: { runId: runV1 }, include: { truck: true } });
    const d = (await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/plan`))).data;
    for (const dl of d.loads) {
      const stored = loads.find((l) => l.id === dl.id)!;
      expect(dl.palletUnits).toBe(stored.palletUnits);
      expect([dl.bays, dl.palletFillPct, dl.palletRoomUnits]).toEqual([stored.truck.bays, 95, (stored.truck.bays as number) * 950]);
      // Orders stay in cases; each product also in full pallets + loose cases with the planned factor.
      for (const m of dl.manifest) {
        expect(m.casesPerPallet).toBe(FACTORS[m.productCode]);
        expect(m.fullPallets * m.casesPerPallet + m.looseCases).toBe(m.cases);
      }
      expect(dl.manifest.reduce((s: number, m: any) => s + m.palletUnits, 0)).toBe(dl.palletUnits);
    }
    expect(d.summary.palletUnits).toBe(loads.reduce((s, l) => s + (l.palletUnits ?? 0), 0));
    expect(d.scenarios.find((s: any) => s.chosen).palletRule).toEqual({ fillPct: 95 });
    const xl = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/export/excel`);
    expect(xl.status).toBe(200);
  });

  it('part B: the products import sets cases per pallet (Validate only writes nothing; company admin)', async () => {
    const fd = new FormData();
    fd.set('file', new Blob(['code,cases_per_pallet\nJA0.5L,96\nTN1.5L,40\n'], { type: 'text/csv' }), 'products.csv');
    fd.set('dryRun', '1');
    const r = await fetchWith(t.cookieJar, `${BASE}/api/products/import`, { method: 'POST', body: fd });
    expect(r.status).toBe(200);
    const b = (await json(r)).data;
    expect([b.dryRun, b.updates, b.unchanged, b.errorRows]).toEqual([true, 1, 1, 0]);
    const tn = await prisma.product.findFirstOrThrow({ where: { tenantId: t.tenantId, code: 'TN1.5L' } });
    expect(tn.casesPerPallet).toBe(39);
  });

  it('pallets review: a cases per pallet corrected after planning makes the plan out of date, and LOCK is refused for a load it puts over its bays', async () => {
    // JA0.5L was planned at 96 per pallet; 10 per pallet makes its 300-case order 30 pallets on 12 bays.
    const big = await prisma.planLoad.findFirstOrThrow({ where: { runId: runV1, truck: { code: 'R12' }, cases: { gte: 300 } } });
    await prisma.product.updateMany({ where: { tenantId: t.tenantId, code: 'JA0.5L' }, data: { casesPerPallet: 10 } });
    try {
      const v = await dayView();
      expect(v.outdated.palletFactorCases).toBeGreaterThanOrEqual(300);
      const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/loads/${big.id}`, j({ status: 'LOCKED' }, 'PATCH'));
      expect(r.status).toBe(409);
      const b = await json(r);
      expect(b.error.violations.map((x: any) => x.code)).toContain('CAPACITY_PALLETS_NEW_FACTOR');
    } finally {
      await prisma.product.updateMany({ where: { tenantId: t.tenantId, code: 'JA0.5L' }, data: { casesPerPallet: FACTORS['JA0.5L'] } });
    }
    expect((await dayView()).outdated.palletFactorCases).toBe(0);
  });

  it('LOCK is refused for a load whose stored pallets are over its bays', async () => {
    const load = await prisma.planLoad.findFirstOrThrow({ where: { runId: runV1, truck: { code: 'R12' } }, include: { assignments: true }, orderBy: { loadNo: 'asc' } });
    const row = load.assignments[0];
    await prisma.routeAssignment.update({ where: { id: row.id }, data: { palletUnits: 20_000 } });
    try {
      const r = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/loads/${load.id}`, j({ status: 'LOCKED' }, 'PATCH'));
      expect(r.status).toBe(409);
      const b = await json(r);
      expect(b.error.code).toBe('TIMES_NOT_VERIFIED');
      expect(b.error.violations.map((v: any) => v.code)).toContain('CAPACITY_PALLETS');
    } finally {
      await prisma.routeAssignment.update({ where: { id: row.id }, data: { palletUnits: row.palletUnits } });
    }
  });

  it('a re-plan copies a locked load with its pallets unchanged', async () => {
    const load = await prisma.planLoad.findFirstOrThrow({ where: { runId: runV1, truck: { code: 'R12' } }, include: { assignments: true }, orderBy: { loadNo: 'asc' } });
    const lock = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/loads/${load.id}`, j({ status: 'LOCKED' }, 'PATCH'));
    expect(lock.status).toBe(200);
    const rp = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runV1}/replan`, j({ reason: 'REOPTIMIZE' }));
    expect(rp.status).toBe(202);
    const runV2 = (await json(rp)).data.runId;
    await waitForPlan(runV2);
    const copy = await prisma.planLoad.findFirstOrThrow({ where: { runId: runV2, carriedFromLoadId: load.id }, include: { assignments: true } });
    expect(copy.status).toBe('LOCKED');
    expect(copy.palletUnits).toBe(load.palletUnits);
    const [was, now] = [load.truckSnapshotJson as any, copy.truckSnapshotJson as any];
    expect([now.bays, now.palletFillPct, now.palletRoomUnits, now.rules.pallets]).toEqual([was.bays, was.palletFillPct, was.palletRoomUnits, was.rules.pallets]);
    expect(copy.assignments.map((a) => [a.orderId, a.palletUnits]).sort()).toEqual(load.assignments.map((a) => [a.orderId, a.palletUnits]).sort());
  });
});
