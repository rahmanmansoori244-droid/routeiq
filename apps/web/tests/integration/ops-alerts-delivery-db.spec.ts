/**
 * OPERATIONS ALERTS, delivery side (owner request 16 Oct 2026) on real PostgreSQL, library level: the
 * real route handlers (GET /api/alerts, GET /api/alerts/summary, POST /api/alerts/ack), the real e-mail
 * digest store (lib/alerts/notify.ts prismaDigestStore: the advisory lock, the claim SQL with FOR UPDATE
 * SKIP LOCKED, the digest rows), Prisma and the database; only the session (vi.mock of auth) and Resend
 * (an injected fetch) are faked. Needs DATABASE_URL (migrated with 20261016180000_ops_alerts); the web
 * server and the solver are not used. The sweep that raises the rows is lib/alerts/sweep.ts (its own
 * spec): here the rows are written directly.
 *  1. Two companies with alerts on. The list and the bell of each company show only its own rows.
 *  2. Acknowledge: own ids change (one ALERTS_ACKNOWLEDGED audit row, the user from the session); another
 *     company's ids answer 404 and change nothing; a row shown at tier 1 that is tier 2 now stays open;
 *     resolved rows never change.
 *  3. The digest: two sends at once (a deploy overlap) give ONE e-mail and one digest row; the claimed
 *     rows carry emailedTier = tier; a WARN row, an acknowledged row, a history row (mayEmail false) and
 *     a row closed as not in the plan are not e-mailed; the next send within 15 min is TOO_SOON; a failed
 *     e-mail puts every row back to the tier it had and counts the attempt.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => (session.user ? { user: session.user } : null)) }));

import { GET as LIST } from '@/app/api/alerts/route';
import { GET as SUMMARY } from '@/app/api/alerts/summary/route';
import { POST as ACK } from '@/app/api/alerts/ack/route';
import { prismaDigestStore, sendAlertDigest } from '@/lib/alerts/notify';
import { todayIso } from '@/lib/dispatch/time';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const TZ = 'Asia/Muscat';
const today = todayIso(TZ);
const day = new Date(`${today}T00:00:00.000Z`);
const ENV = { RESEND_API_KEY: 're_test_key', RESEND_FROM: 'RouteIQ <alerts@routeiq.example>', AUTH_URL: 'https://app.routeiq.example', NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv;

interface Company {
  slug: string;
  tenantId: string;
  plannerId: string;
  depotId: string;
}
const A: Company = { slug: `oaa-${uniqueSuffix()}`.toLowerCase().slice(0, 32), tenantId: '', plannerId: '', depotId: '' };
const B: Company = { slug: `oab-${uniqueSuffix()}`.toLowerCase().slice(0, 32), tenantId: '', plannerId: '', depotId: '' };

const as = (c: Company, role = 'PLANNER') => {
  session.user = { id: c.plannerId, tenantId: c.tenantId, role, name: 'Dispatcher Example', email: `planner@${c.slug}.test` };
};
const call = async (handler: (r: Request) => Promise<Response>, url: string, body?: unknown) => {
  const res = await handler(new Request(`http://localhost${url}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as { data: any; error: any } };
};

let seq = 0;
async function alert(c: Company, extra: Record<string, unknown> = {}) {
  seq++;
  return prisma.opsAlert.create({
    data: {
      tenantId: c.tenantId,
      depotId: c.depotId,
      deliveryDate: day,
      rule: 'ETA_LATE',
      subjectKey: `${c.depotId}|${today}|tr${seq}|1`,
      truckId: `tr${seq}`,
      truckCode: `T${String(seq).padStart(2, '0')}`,
      loadNo: 1,
      kind: 'CONDITION',
      severity: 'HIGH',
      tier: 2,
      value: 65,
      threshold: 30,
      text: `T${String(seq).padStart(2, '0')} L1 is running about 65 min late.`,
      occurredAt: new Date(),
      ...extra,
    },
  });
}

async function seed(c: Company) {
  const t = await prisma.tenant.create({ data: { slug: c.slug, name: `Alerts ${c.slug}`, country: 'Oman' } });
  c.tenantId = t.id;
  await prisma.tenantConfig.create({
    data: { tenantId: t.id, timezone: TZ, alertsEnabled: true, alertsEnabledAt: new Date(Date.now() - 3_600_000), alertEmails: `owner@${c.slug}.test`, alertQuietFromMin: null, alertQuietToMin: null },
  });
  c.plannerId = (await prisma.user.create({ data: { tenantId: t.id, email: `planner@${c.slug}.test`, passwordHash: 'x', name: 'Dispatcher Example', role: 'PLANNER' } })).id;
  c.depotId = (await prisma.depot.create({ data: { tenantId: t.id, code: 'MCT', name: 'Example Depot', lat: 23.568, lng: 58.392 } })).id;
}

beforeAll(async () => {
  await seed(A);
  await seed(B);
});
afterAll(async () => {
  await cleanupTenant(A.slug);
  await cleanupTenant(B.slug);
  await prisma.$disconnect();
});

describe('each company sees only its own alerts', () => {
  it('the list and the bell', async () => {
    const a = await alert(A);
    const b = await alert(B);
    as(A, 'VIEWER');
    const list = await call(LIST, '/api/alerts');
    expect(list.status).toBe(200);
    expect(list.body.data.rows.map((r: any) => r.id)).toContain(a.id);
    expect(list.body.data.rows.map((r: any) => r.id)).not.toContain(b.id);
    const bell = await call(SUMMARY, '/api/alerts/summary');
    expect(bell.body.data.latest.map((r: any) => r.id)).not.toContain(b.id);
    await prisma.opsAlert.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  });
});

describe('acknowledge', () => {
  it("own ids change with one audit row; another company's ids 404 and change nothing", async () => {
    const own = await alert(A);
    const foreign = await alert(B);
    as(A);
    expect((await call(ACK, '/api/alerts/ack', { ids: [foreign.id] })).status).toBe(404);
    expect((await prisma.opsAlert.findUnique({ where: { id: foreign.id } }))!.ackedAt).toBeNull();
    const mixed = await call(ACK, '/api/alerts/ack', { ids: [own.id, foreign.id] });
    expect(mixed.body.data).toEqual({ acked: 1, ids: [own.id] });
    const row = await prisma.opsAlert.findUnique({ where: { id: own.id } });
    expect(row!.ackedById).toBe(A.plannerId);
    expect((await prisma.opsAlert.findUnique({ where: { id: foreign.id } }))!.ackedAt).toBeNull();
    const audits = await prisma.auditLog.findMany({ where: { tenantId: A.tenantId, action: 'ALERTS_ACKNOWLEDGED' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ userId: A.plannerId, entity: 'OpsAlert', entityId: own.id });
    expect(audits[0]!.afterJson).toMatchObject({ count: 1, ids: [own.id], rules: ['ETA_LATE'], dates: [today] });
    expect(await prisma.auditLog.count({ where: { tenantId: B.tenantId, action: 'ALERTS_ACKNOWLEDGED' } })).toBe(0);
  });

  it('a row that became worse since the screen showed it stays open; a resolved row never changes', async () => {
    const worse = await alert(A, { tier: 2 });
    const over = await alert(A, { resolvedAt: new Date(), resolvedReason: 'ENDED' });
    as(A);
    const r = await call(ACK, '/api/alerts/ack', { ids: [worse.id, over.id], seen: { [worse.id]: 1, [over.id]: 2 } });
    expect(r.body.data).toEqual({ acked: 0, ids: [] });
    expect((await prisma.opsAlert.findUnique({ where: { id: worse.id } }))!.ackedAt).toBeNull();
    expect((await prisma.opsAlert.findUnique({ where: { id: over.id } }))!.ackedAt).toBeNull();
    const ok = await call(ACK, '/api/alerts/ack', { ids: [worse.id], seen: { [worse.id]: 2 } });
    expect(ok.body.data.acked).toBe(1);
  });

  it('{ all: { date, depotId } } acknowledges the open rows of that day and depot only', async () => {
    await prisma.opsAlert.updateMany({ where: { tenantId: A.tenantId }, data: { ackedAt: new Date() } });
    const open1 = await alert(A);
    const open2 = await alert(A, { severity: 'WARN', tier: 1 });
    const otherDay = await alert(A, { deliveryDate: new Date(day.getTime() + 86_400_000) });
    as(A);
    const r = await call(ACK, '/api/alerts/ack', { all: { date: today, depotId: A.depotId } });
    expect(r.body.data.ids.sort()).toEqual([open1.id, open2.id].sort());
    expect((await prisma.opsAlert.findUnique({ where: { id: otherDay.id } }))!.ackedAt).toBeNull();
  });
});

describe('the e-mail digest on PostgreSQL', () => {
  it('two sends at once give one e-mail; only HIGH, unacknowledged, e-mailable, open-or-over rows are claimed', async () => {
    await prisma.opsAlert.deleteMany({ where: { tenantId: A.tenantId } });
    const h1 = await alert(A);
    const h2 = await alert(A, { tier: 3, emailedTier: 2 });
    const over = await alert(A, { resolvedAt: new Date(), resolvedReason: 'ENDED' });
    const warn = await alert(A, { severity: 'WARN', tier: 1 });
    const acked = await alert(A, { ackedAt: new Date() });
    const history = await alert(A, { mayEmail: false });
    const notInPlan = await alert(A, { resolvedAt: new Date(), resolvedReason: 'NOT_IN_PLAN' });
    const fetches: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      fetches.push(JSON.parse(init.body as string));
      return new Response('{}', { status: 200 });
    }) as never;
    const now = new Date();
    const [x, y] = await Promise.all([sendAlertDigest(A.tenantId, now, { env: ENV, fetchImpl }), sendAlertDigest(A.tenantId, now, { env: ENV, fetchImpl })]);
    expect([x.sent, y.sent].filter(Boolean)).toHaveLength(1);
    expect([x.skip, y.skip].filter(Boolean)[0]).toMatch(/^(BUSY|TOO_SOON)$/);
    expect(fetches).toHaveLength(1);
    expect(await prisma.opsAlertDigest.count({ where: { tenantId: A.tenantId } })).toBe(1);
    const rows = await prisma.opsAlert.findMany({ where: { tenantId: A.tenantId } });
    const by = new Map(rows.map((r) => [r.id, r]));
    for (const r of [h1, h2, over]) expect([r.id, by.get(r.id)!.emailedTier]).toEqual([r.id, r.tier]);
    for (const r of [warn, acked, history, notInPlan]) expect([r.id, by.get(r.id)!.emailedTier]).toEqual([r.id, r.emailedTier]);
    expect((fetches[0] as { to: string[] }).to).toEqual([`owner@${A.slug}.test`]);
    expect(await prismaDigestStore(prisma).claim(A.tenantId, new Date(now.getTime() + 60_000), { everyMin: 15, minSeverity: 'HIGH', dayStart: day, recipients: 1 })).toEqual({ ok: false, skip: 'TOO_SOON' });
  });

  it('a failed e-mail puts every row back to the tier it had, counts the attempt, and the digest is FAILED', async () => {
    await prisma.opsAlert.deleteMany({ where: { tenantId: B.tenantId } });
    const fresh = await alert(B);
    const escalated = await alert(B, { tier: 3, emailedTier: 2 });
    const out = await sendAlertDigest(B.tenantId, new Date(), { env: ENV, fetchImpl: (async () => new Response('', { status: 403 })) as never });
    expect(out).toMatchObject({ sent: false, error: 'provider answered 403', alerts: 2 });
    const a = await prisma.opsAlert.findUnique({ where: { id: fresh.id } });
    const b = await prisma.opsAlert.findUnique({ where: { id: escalated.id } });
    expect([a!.emailedTier, a!.emailAttempts, a!.emailError]).toEqual([0, 1, 'provider answered 403']);
    expect([b!.emailedTier, b!.emailAttempts]).toEqual([2, 1]);
    const digest = await prisma.opsAlertDigest.findFirst({ where: { tenantId: B.tenantId } });
    expect(digest).toMatchObject({ status: 'FAILED', alertCount: 2, highCount: 2, recipientCount: 1, error: 'provider answered 403' });
  });
});
