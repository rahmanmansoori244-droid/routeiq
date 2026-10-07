/**
 * THE HIRE SUGGESTION (owner request 6 Oct 2026) - end-to-end against the running web app + solver:
 *
 *  - a company admin enters the trucks the depot can hire (a 10-ton, 12 bays, 50 a day, at most 3; a
 *    3-ton, 6 bays, 30 a day, at most 2); a PLANNER or VIEWER cannot;
 *  - the day's orders are more than the fleet can carry (one 12-bay truck, one load a day, about 20
 *    pallets): OPTIMIZE leaves orders out for the fleet's capacity, and the what-if runs on its own
 *    (Quick) and says which trucks to hire ("... cannot be delivered with your fleet. To deliver them,
 *    hire ..."); the plan in use is never changed by it; everyone reads it;
 *  - "Use this plan": a VIEWER is refused; the dispatcher (PLANNER) gets a new plan version with the
 *    hired trucks as one-day trucks of that date (hired, onlyOnDate, codes HIRE-...), the orders
 *    delivered; a second press is refused (ALREADY_USED);
 *  - the dispatcher enters a hired truck's real plate (the plan shows it); an own truck is refused;
 *  - the one-day trucks are not planned on another day.
 *
 * Requires: dev server (RATE_LIMITS_DISABLED=1) + solver running (the solver of this release: an
 * older one ignores hire_candidate and may rent a truck instead of using the own one).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, fetchWith, freshTenant, inviteUser, prisma, type InvitedUser, type TenantHandle } from './helpers';

let t: TenantHandle;
let planner: InvitedUser;
let viewer: InvitedUser;
let depotId = '';
let day = '';
let runV1 = '';
let runV2 = '';
let suggestionId = '';

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

async function addOrders(date: string, rows: string[][]) {
  const head = ['SO No', 'Req. Delivery Date', 'Customer Code', 'Item Code', 'Qty (Cases)'];
  const fd = new FormData();
  fd.set('file', new Blob([[head, ...rows.map(([so, c, i, q]) => [so, dmy(date), c, i, q])].map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), `h-${date}.csv`);
  fd.set('depotId', depotId);
  fd.set('deliveryDate', date);
  const up = await fetchWith(t.cookieJar, `${BASE}/api/orders/upload`, { method: 'POST', body: fd });
  expect(up.status).toBe(200);
  const v = (await json(up)).data;
  expect(v.validation.errorRows).toBe(0);
  const c = await fetchWith(t.cookieJar, `${BASE}/api/orders/${v.batchId}/confirm`, j(v.validation.late.isLate ? { lateReason: 'Test' } : {}));
  expect(c.status).toBe(200);
}

async function waitForPlan(runId: string, max = 160) {
  for (let i = 0; i < max; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/status`));
    if (st.data.run.status !== 'OPTIMIZING' && st.data.job?.status !== 'RUNNING' && st.data.job?.status !== 'QUEUED') return st.data;
  }
  throw new Error('optimization did not finish');
}

async function waitForSuggestion(runId: string, max = 160) {
  for (let i = 0; i < max; i++) {
    const v = (await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/hire-suggestion`))).data;
    const s = v?.suggestion;
    if (s && s.status !== 'QUEUED' && s.status !== 'RUNNING') return v;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('the hire check did not finish');
}

beforeAll(async () => {
  t = await freshTenant('hire');
  day = isoPlus(2);
  await prisma.tenantConfig.update({
    where: { tenantId: t.tenantId },
    data: { timezone: 'Asia/Muscat', planningCutoffMin: 18 * 60, shiftStartMin: 360, driverShiftMaxMinutes: 720, distanceProvider: 'HAVERSINE', osrmUrl: null, maxTripsPerTruck: 1 },
  });
  depotId = (await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'MCT', name: 'Muscat depot', lat: 23.568, lng: 58.392, openMin: 300, closeMin: 1380 } })).id;
  // The fleet: ONE 10-ton with 12 bays, one load a day. Its day costs more than a hired 10-ton: it is used first anyway.
  await prisma.truck.create({ data: { tenantId: t.tenantId, depotId, code: 'R1', capacityCases: 1140, capacityWeightKg: 0, fixedCostPerDay: 60, costPerKm: 0.1, bays: 12, maxTripsPerDay: 1 } });
  await prisma.product.create({ data: { tenantId: t.tenantId, code: 'JA1.5L', name: 'Jabal 1.5L', weightPerCaseKg: 17, casesPerPallet: 50 } });
  const pts: [string, number, number][] = [
    ['C1', 23.588, 58.41], ['C2', 23.6, 58.372], ['C3', 23.555, 58.335], ['C4', 23.61, 58.45], ['C5', 23.57, 58.44], ['C6', 23.6, 58.3], ['C7', 23.62, 58.39],
  ];
  for (const [code, lat, lng] of pts) {
    await prisma.customer.create({
      data: { tenantId: t.tenantId, code, name: code, branchKey: '__MAIN__', lat, lng, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true },
    });
  }
  planner = await inviteUser(t, 'PLANNER');
  viewer = await inviteUser(t, 'VIEWER');
});

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

describe('the hire suggestion', () => {
  it('a company admin enters the trucks to hire; a dispatcher or a viewer cannot', async () => {
    const ten = { depotId, label: '10-ton', bays: 12, payloadKg: 0, costPerDay: 50, maxPerDay: 3 };
    for (const u of [planner, viewer]) expect((await fetchWith(u.jar, `${BASE}/api/hire-options`, j(ten))).status).toBe(403);
    expect((await fetchWith(t.cookieJar, `${BASE}/api/hire-options`, j(ten))).status).toBe(201);
    expect((await fetchWith(t.cookieJar, `${BASE}/api/hire-options`, j({ depotId, label: '3-ton', bays: 6, costPerDay: 30, maxPerDay: 2 }))).status).toBe(201);
    // Bays or a case capacity, and a hire above 0.
    expect((await fetchWith(t.cookieJar, `${BASE}/api/hire-options`, j({ depotId, label: 'x', costPerDay: 10 }))).status).toBe(400);
    expect((await fetchWith(t.cookieJar, `${BASE}/api/hire-options`, j({ depotId, label: 'y', bays: 4, costPerDay: 0 }))).status).toBe(400);
    const list = (await json(await fetchWith(viewer.jar, `${BASE}/api/hire-options`))).data;
    expect(list.map((o: any) => o.label).sort()).toEqual(['10-ton', '3-ton']);
  });

  it('orders the fleet cannot carry: the plan leaves them out, and the hire check says what to hire', async () => {
    // 7 customers x 150 cases / 3 pallets = 21 pallets; the fleet carries 12.
    await addOrders(day, ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'].map((c, i) => [`SO-${i + 1}`, c, 'JA1.5L', '150']));
    const r = await fetchWith(planner.jar, `${BASE}/api/dispatch/plan`, j({ date: day, depotId, optimize: true }));
    expect(r.status).toBe(202);
    runV1 = (await json(r)).data.runId;
    expect((await waitForPlan(runV1)).run.status).toBe('READY');
    const unserved = await prisma.unservedOrder.count({ where: { scenario: { runId: runV1 } } });
    expect(unserved).toBeGreaterThan(0);
    const v = await waitForSuggestion(runV1);
    expect(v).toMatchObject({ options: 2, short: true, suggestion: { status: 'SUCCEEDED', usable: true } });
    suggestionId = v.suggestion.id;
    expect(v.suggestion.headline).toMatch(/^\d+ orders \([\d,]+ cases, [\d.]+ pallets\) cannot be delivered with your fleet\. To deliver them, hire .+: extra about \d+ OMR\. Still left out: none\.$/);
    expect(v.suggestion.summary.hires.length).toBeGreaterThan(0);
    // The plan in use did not change.
    const run = await prisma.runPlan.findUniqueOrThrow({ where: { id: runV1 } });
    expect(run.status).toBe('READY');
    expect(await prisma.truck.count({ where: { tenantId: t.tenantId, onlyOnDate: { not: null } } })).toBe(0);
    // Everyone reads it; the audit has its start and end.
    expect((await fetchWith(viewer.jar, `${BASE}/api/runs/${runV1}/hire-suggestion`)).status).toBe(200);
    const actions = (await prisma.auditLog.findMany({ where: { tenantId: t.tenantId, entity: 'HireSuggestion' } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['HIRE_CHECK_STARTED', 'HIRE_CHECK_FINISHED']));
  });

  it('"Use this plan": a viewer is refused; the dispatcher gets the next version with one-day hired trucks', async () => {
    expect((await fetchWith(viewer.jar, `${BASE}/api/runs/${runV1}/hire-suggestion/use`, j({ suggestionId }))).status).toBe(403);
    const r = await fetchWith(planner.jar, `${BASE}/api/runs/${runV1}/hire-suggestion/use`, j({ suggestionId, expect: { date: day, depotId } }));
    const body = await json(r);
    expect(r.status).toBe(200);
    expect(body.data.applied).toBe('PLAN');
    runV2 = body.data.runId;
    const hired = await prisma.truck.findMany({ where: { tenantId: t.tenantId, onlyOnDate: { not: null } } });
    expect(hired.length).toBeGreaterThan(0);
    for (const h of hired) {
      expect(h.hired).toBe(true);
      expect(h.onlyOnDate?.toISOString().slice(0, 10)).toBe(day);
      expect(h.code).toMatch(/^HIRE-(10|3)T-\d{4}-\d+$/);
    }
    const plan = (await json(await fetchWith(planner.jar, `${BASE}/api/runs/${runV2}/plan`))).data;
    expect(plan.run.version).toBe(2);
    const hiredLoads = plan.loads.filter((l: any) => l.oneDay === day);
    expect(hiredLoads.length).toBeGreaterThan(0);
    expect(hiredLoads.every((l: any) => l.hired)).toBe(true);
    expect(plan.unserved).toEqual([]);
    // The own truck still carries its load.
    expect(plan.loads.some((l: any) => l.truckCode === 'R1')).toBe(true);
    const v1 = await prisma.runPlan.findUniqueOrThrow({ where: { id: runV1 } });
    expect(v1.status).toBe('SUPERSEDED');
    expect((await fetchWith(planner.jar, `${BASE}/api/runs/${runV1}/hire-suggestion/use`, j({ suggestionId }))).status).toBe(409);
    const actions = (await prisma.auditLog.findMany({ where: { tenantId: t.tenantId } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['HIRED_TRUCKS_ADDED', 'HIRE_SUGGESTION_USED', 'PLAN_VERSION_CREATED', 'SCENARIO_CHOSEN']));
  });

  it("the dispatcher enters a hired truck's plate; an own truck cannot be changed that way", async () => {
    const plan = (await json(await fetchWith(planner.jar, `${BASE}/api/runs/${runV2}/plan`))).data;
    const l = plan.loads.find((x: any) => x.oneDay === day);
    const r = await fetchWith(planner.jar, `${BASE}/api/dispatch/hired-trucks/${l.truckId}`, j({ code: 'PLATE-777' }, 'PATCH'));
    expect(r.status).toBe(200);
    const after = (await json(await fetchWith(planner.jar, `${BASE}/api/runs/${runV2}/plan`))).data;
    expect(after.loads.find((x: any) => x.id === l.id).truckCode).toBe('PLATE-777');
    const own = await prisma.truck.findFirstOrThrow({ where: { tenantId: t.tenantId, code: 'R1' } });
    expect((await fetchWith(planner.jar, `${BASE}/api/dispatch/hired-trucks/${own.id}`, j({ code: 'X1' }, 'PATCH'))).status).toBe(403);
    expect((await fetchWith(viewer.jar, `${BASE}/api/dispatch/hired-trucks/${l.truckId}`, j({ code: 'X2' }, 'PATCH'))).status).toBe(403);
  });

  it('a one-day truck is not planned on another day', async () => {
    const next = isoPlus(3);
    await addOrders(next, [['SO-N1', 'C1', 'JA1.5L', '50']]);
    const r = await fetchWith(planner.jar, `${BASE}/api/dispatch/plan`, j({ date: next, depotId, optimize: true }));
    expect(r.status).toBe(202);
    const runId = (await json(r)).data.runId;
    await waitForPlan(runId);
    const job = await prisma.runJob.findFirstOrThrow({ where: { runId }, orderBy: { attemptNo: 'desc' } });
    const sent = (job.requestJson as any).trucks.map((x: any) => x.code);
    expect(sent).toEqual(['R1']);
  });
});
