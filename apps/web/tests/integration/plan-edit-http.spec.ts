/**
 * MOVES BY HAND, PART 2 - end-to-end against the running web app and the real solver (design 12.4): a synthetic
 * day optimized through the routes, then changes by hand through POST /api/runs/:id/edit/check and /edit:
 *  - SWAP_LOADS checked and saved; several stops at their best place checked, then the resolved list saved;
 *  - stops exchanged between two loads as a list of two operations (F11);
 *  - a late arrival made on purpose: Check returns HARD_WINDOW that can be allowed with `overrides.ok`; a
 *    SUPERVISOR saves it with a reason from a best-place check (the hashes agree, F16); Lock of that load 200;
 *  - a PLANNER saving with new overrides: 403; a v1 `{ move }` body: 200.
 *
 * Requires: the web server with PLAN_EDIT=on (RATE_LIMITS_DISABLED=1) and the solver with /retime-truck-days v2
 * (the solver part of this change), so it runs only with PLAN_EDIT_HTTP=1 (skipped otherwise).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, cleanupTenant, fetchWith, freshTenant, inviteUser, prisma, withDriver, type InvitedUser, type TenantHandle } from './helpers';

const ON = process.env.PLAN_EDIT_HTTP === '1';

let t: TenantHandle;
let supervisor: InvitedUser;
let planner: InvitedUser;
let depotId = '';
let day = '';
let runId = '';

function isoPlus(days: number) {
  const d = new Date(Date.now() + 4 * 3600_000); // Muscat
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const dmy = (iso: string) => iso.split('-').reverse().join('/');
const j = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const json = async <T = any>(res: Response): Promise<T> => (await res.json()) as T;
const expectDay = () => ({ date: day, depotId });

async function plan(id = runId) {
  return (await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${id}/plan`))).data;
}
async function check(jar: TenantHandle['cookieJar'], body: Record<string, unknown>, id = runId) {
  const r = await fetchWith(jar, `${BASE}/api/runs/${id}/edit/check`, j({ ...body, expect: expectDay() }));
  return { status: r.status, body: await json(r) };
}
async function save(jar: TenantHandle['cookieJar'], body: Record<string, unknown>, id = runId) {
  const r = await fetchWith(jar, `${BASE}/api/runs/${id}/edit`, j({ ...body, expect: expectDay() }));
  return { status: r.status, body: await json(r) };
}

beforeAll(async () => {
  if (!ON) return;
  t = await freshTenant('pedit');
  supervisor = await inviteUser(t, 'SUPERVISOR');
  planner = await inviteUser(t, 'PLANNER');
  day = isoPlus(2);
  await prisma.tenantConfig.update({ where: { tenantId: t.tenantId }, data: { timezone: 'Asia/Muscat', distanceProvider: 'HAVERSINE', osrmUrl: null, windowRule: 'START' } });
  const depot = await prisma.depot.create({ data: { tenantId: t.tenantId, code: 'MCT', name: 'Muscat depot', lat: 23.568, lng: 58.392, openMin: 300, closeMin: 1380 } });
  depotId = depot.id;
  for (const code of ['T01', 'T02']) await prisma.truck.create({ data: { tenantId: t.tenantId, depotId, code, capacityCases: 300, capacityWeightKg: 0, fixedCostPerDay: 20, costPerKm: 0.08 } });
  await prisma.product.create({ data: { tenantId: t.tenantId, code: 'TAN-500-24', name: 'Tanuf 500ml x24', weightPerCaseKg: 12.8 } });
  for (let i = 1; i <= 6; i++) {
    await prisma.customer.create({
      data: { tenantId: t.tenantId, code: `C${i}`, branchKey: '__MAIN__', name: `Customer ${i}`, lat: 23.55 + i * 0.01, lng: 58.35 + (i % 3) * 0.02, geocodeConfidence: 'HIGH', locationVerified: true, priority: 3, priorityConfirmed: true, avgServiceTimeMin: 20, serviceTimeConfirmed: true },
    });
  }
  const head = ['SO No', 'SO Date', 'Req. Delivery Date', 'Customer Code', 'Branch', 'Customer Name', 'Item Code', 'Item Description', 'Qty (Cases)', 'Net Value', 'CM'];
  const rows = [1, 2, 3, 4, 5, 6].map((i) => [`SO-${i}`, dmy(day), dmy(day), `C${i}`, '', `Customer ${i}`, 'TAN-500-24', '', '80', '200', '30']);
  const fd = new FormData();
  fd.set('file', new Blob([[head, ...rows].map((r) => r.join(',')).join('\n')], { type: 'text/csv' }), `pedit-${day}.csv`);
  fd.set('depotId', depotId);
  expect((await fetchWith(t.cookieJar, `${BASE}/api/orders/upload`, { method: 'POST', body: fd })).status).toBe(200);
  const batch = await prisma.uploadBatch.findFirstOrThrow({ where: { tenantId: t.tenantId }, orderBy: { uploadedAt: 'desc' } });
  expect((await fetchWith(t.cookieJar, `${BASE}/api/orders/${batch.id}/confirm`, j({}))).status).toBe(200);
  const r = await fetchWith(t.cookieJar, `${BASE}/api/dispatch/plan`, j({ date: day, depotId, optimize: true }));
  expect(r.status).toBe(202);
  runId = (await json(r)).data.runId;
  for (let i = 0; i < 120; i++) {
    await new Promise((res) => setTimeout(res, 1500));
    const st = await json(await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/status`));
    if (st.data.run.status !== 'OPTIMIZING' && st.data.job?.status !== 'RUNNING' && st.data.job?.status !== 'QUEUED') break;
  }
}, 300_000);

afterAll(async () => {
  if (t) await cleanupTenant(t.slug);
  await prisma.$disconnect();
});

describe.skipIf(!ON)('moves by hand, part 2, through the routes and the real solver', () => {
  it('a swap of two loads checks and saves; a v1 { move } body still answers', async () => {
    const p = await plan();
    const [a, b] = p.loads.filter((l: any) => l.status === 'PLANNED');
    expect(a && b).toBeTruthy();
    const order = (l: any) => l.stops.map((s: any) => s.customerId).join(',');
    const c = await check(t.cookieJar, { ops: [{ kind: 'SWAP_LOADS', a: a.id, b: b.id }] });
    expect(c.status).toBe(200);
    expect(c.body.data.ok).toBe(true);
    const s = await save(t.cookieJar, { ops: c.body.data.ops, previewHash: c.body.data.previewHash, builtAt: c.body.data.builtAt });
    expect(s.status).toBe(200);
    runId = s.body.data.runId;
    const q = await plan();
    // Each load keeps its stop order and takes the other's place.
    expect(q.loads.find((x: any) => order(x) === order(a))).toMatchObject({ truckId: b.truckId, loadNo: b.loadNo });
    expect(q.loads.find((x: any) => order(x) === order(b))).toMatchObject({ truckId: a.truckId, loadNo: a.loadNo });
    const l = q.loads.find((x: any) => x.status === 'PLANNED' && x.stops.length > 1);
    const v1 = await check(t.cookieJar, { move: { kind: 'MOVE', from: { loadId: l.id, sequence: 1 }, to: { truckId: l.truckId, loadId: l.id, position: l.stops.length - 1 } } });
    expect(v1.status).toBe(200);
    expect(v1.body.data.move).toBeTruthy();
  });

  it('several stops at their best place: Check resolves them to an order; the resolved list saves', async () => {
    const p = await plan();
    // The day's loads are full (3 x 80 cases of 300): the two stops go to a new load of T02, at its best place.
    const from = p.loads.filter((l: any) => l.status === 'PLANNED').sort((x: any, y: any) => y.stops.length - x.stops.length)[0];
    const t02 = await prisma.truck.findFirstOrThrow({ where: { tenantId: t.tenantId, code: 'T02' }, select: { id: true } });
    const moved = from.stops.slice(0, 2);
    const stops = moved.map((s: any) => ({ loadId: from.id, sequence: s.sequence }));
    const c = await check(t.cookieJar, { ops: [{ kind: 'MOVE_STOPS', stops, to: { truckId: t02.id, loadId: null, before: 'BEST' } }] });
    expect(c.status).toBe(200);
    expect(c.body.data.ok).toBe(true);
    expect(c.body.data.ops[0].to.order).toHaveLength(2);
    expect(c.body.data.ops[0].to.before).not.toBe('BEST');
    const s = await save(t.cookieJar, { ops: c.body.data.ops, previewHash: c.body.data.previewHash, builtAt: c.body.data.builtAt });
    expect(s.status).toBe(200);
    runId = s.body.data.runId;
    const q = await plan();
    const onT02 = q.loads.filter((l: any) => l.truckId === t02.id).flatMap((l: any) => l.stops.map((x: any) => x.customerId));
    expect(onT02.sort()).toEqual(moved.map((x: any) => x.customerId).sort());
  });

  it('stops exchanged between two loads as a list of two (F11)', async () => {
    const p = await plan();
    const [a, b] = p.loads.filter((l: any) => l.status === 'PLANNED' && l.stops.length >= 2);
    const one = await check(t.cookieJar, { ops: [{ kind: 'MOVE_STOPS', stops: [{ loadId: a.id, sequence: 1 }], to: { truckId: b.truckId, loadId: b.id, position: 0 } }] });
    expect(one.body.data.draftable).toBe(true);
    const both = await check(t.cookieJar, { ops: [...one.body.data.ops, { kind: 'MOVE_STOPS', stops: [{ loadId: b.id, sequence: 1 }], to: { truckId: a.truckId, loadId: a.id, position: 0 } }] });
    expect(both.status).toBe(200);
    expect(both.body.data.ok).toBe(true);
    const s = await save(t.cookieJar, { ops: both.body.data.ops, previewHash: both.body.data.previewHash, builtAt: both.body.data.builtAt });
    expect(s.status).toBe(200);
    runId = s.body.data.runId;
    const q = await plan();
    expect(q.loads.find((l: any) => l.truckId === b.truckId && l.loadNo === b.loadNo).stops[0].customerId).toBe(a.stops[0].customerId);
    expect(q.loads.find((l: any) => l.truckId === a.truckId && l.loadNo === a.loadNo).stops[0].customerId).toBe(b.stops[0].customerId);
  });

  it('a late arrival: allowed by a supervisor from a best-place check (the hashes agree); a planner gets 403; Lock answers 200', async () => {
    const p = await plan();
    const target = p.loads.filter((l: any) => l.status === 'PLANNED').sort((x: any, y: any) => y.stops.length - x.stops.length)[0];
    const last = target.stops[target.stops.length - 1];
    // Its last customer must now be served before the planned arrival: a stop moved in front makes it late.
    await prisma.customer.update({ where: { id: last.customerId }, data: { hardWindowStartMin: 0, hardWindowEndMin: Math.max(1, (last.etaMin ?? 600) - 1) } });
    // A stop of ANOTHER truck: one taken from an earlier load of the same truck could let the target leave earlier
    // (that load shorter or gone) and arrive on time.
    const other = p.loads.find((l: any) => l.status === 'PLANNED' && l.truckId !== target.truckId) ?? p.loads.find((l: any) => l.status === 'PLANNED' && l.id !== target.id);
    const c = await check(supervisor.jar, { ops: [{ kind: 'MOVE_STOPS', stops: [{ loadId: other.id, sequence: 1 }], to: { truckId: target.truckId, loadId: target.id } }] });
    expect(c.status).toBe(200);
    const pv = c.body.data;
    expect(pv.ok).toBe(false);
    expect(pv.issues.some((i: any) => i.code === 'HARD_WINDOW' && i.overridable)).toBe(true);
    expect(pv.overrides.ok).toBe(true);
    const overrides = pv.overrides.needed.filter((n: any) => !n.carried).map((n: any) => ({ id: n.id, reason: 'agreed with the customer' }));
    const refused = await save(planner.jar, { ops: pv.ops, previewHash: pv.overrides.previewHash, builtAt: pv.builtAt, overrides });
    expect(refused.status).toBe(403);
    const s = await save(supervisor.jar, { ops: pv.ops, previewHash: pv.overrides.previewHash, builtAt: pv.builtAt, overrides });
    expect(s.status).toBe(200);
    runId = s.body.data.runId;
    const q = await plan();
    const l = q.loads.find((x: any) => x.truckId === target.truckId && x.stops.some((st: any) => st.handAllowed));
    expect(l).toBeTruthy();
    // Loads are locked in order: the truck's earlier loads first.
    const earlier = q.loads.filter((x: any) => x.truckId === l.truckId && x.loadNo < l.loadNo).sort((x: any, y: any) => x.loadNo - y.loadNo);
    await withDriver(t.tenantId, [...earlier.map((x: any) => x.id), l.id]);
    for (const e of [...earlier, l]) {
      const lock = await fetchWith(t.cookieJar, `${BASE}/api/runs/${runId}/loads/${e.id}`, j({ status: 'LOCKED' }, 'PATCH'));
      expect(lock.status).toBe(200);
    }
  });
});
