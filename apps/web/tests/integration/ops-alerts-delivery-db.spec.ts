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
 *  4. The day's end (owner request 19 Oct 2026: yesterday's alerts looked like today's on the bell): the bell
 *     counts and lists today's open rows only, with the company's today; yesterday's (one closed as Day
 *     ended with who acknowledged it, one still open because the sweep has not run since midnight) stay on
 *     the Alerts page for that date. Review of the branch (19 Oct 2026): yesterday's Load not closed raised
 *     after midnight (finding 2) counts on the bell and is e-mailed like today's; a row closed as Day ended
 *     that was never e-mailed goes once (finding 1: a HIGH of the evening before the quiet hours), one
 *     e-mailed before, one still open from yesterday and one written closed are not claimed.
 *  5. Cause & action (owner request 20 Oct 2026, PATCH /api/alerts; needs 20261020000000_alert_notes too): the
 *     guarded save and its audit row (with the texts: the history of an edit), any state and day, another
 *     company's id, the CHECKs, the filter and the counts (Follow-up counts the dates chosen), the incident, the
 *     removal, the 90-day clean-up (rows kept only with keepUntilIso), a save's locks (a claim answers BUSY, a
 *     sweep skips the company) and the removal of the texts from the audit rows of alerts older than 90 days.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => (session.user ? { user: session.user } : null)) }));

import { GET as LIST, PATCH } from '@/app/api/alerts/route';
import { purgeOldAlertRows } from '@/lib/alerts/store';
import { REVIEW_ROW_SELECT, saveAlertReview, scrubReviewAuditTexts, type ReviewRow } from '@/lib/alerts/inbox';
import { tryLockTenantAlerts } from '@/lib/alerts/locks';
import { GET as SUMMARY } from '@/app/api/alerts/summary/route';
import { POST as ACK } from '@/app/api/alerts/ack/route';
import { prismaDigestStore, sendAlertDigest } from '@/lib/alerts/notify';
import { addDaysIso, todayIso, zonedDayStart } from '@/lib/dispatch/time';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const TZ = 'Asia/Muscat';
const today = todayIso(TZ);
const day = new Date(`${today}T00:00:00.000Z`);

interface Company {
  slug: string;
  tenantId: string;
  plannerId: string;
  depotId: string;
}
const A: Company = { slug: `oaa-${uniqueSuffix()}`.toLowerCase().slice(0, 32), tenantId: '', plannerId: '', depotId: '' };
const B: Company = { slug: `oab-${uniqueSuffix()}`.toLowerCase().slice(0, 32), tenantId: '', plannerId: '', depotId: '' };
// Both companies on the server's list of the companies that may send alert e-mail (review H1).
const ENV = { RESEND_API_KEY: 're_test_key', RESEND_FROM: 'RouteIQ <alerts@routeiq.example>', AUTH_URL: 'https://app.routeiq.example', NODE_ENV: 'test', ALERT_EMAIL_TENANTS: `${A.slug},${B.slug}` } as unknown as NodeJS.ProcessEnv;

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
    expect(await prismaDigestStore(prisma).claim(A.tenantId, new Date(now.getTime() + 60_000), { everyMin: 15, minSeverity: 'HIGH', dayStart: day, today, recipients: 1 })).toEqual({ ok: false, skip: 'TOO_SOON' });
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

describe("the day's end (owner request 19 Oct 2026: yesterday's alerts looked like today's)", () => {
  const yIso = addDaysIso(today, -1);
  const yesterday = new Date(`${yIso}T00:00:00.000Z`);

  it("the bell counts and lists today's open rows only; yesterday's stay on the Alerts page with their state", async () => {
    await prisma.opsAlert.deleteMany({ where: { tenantId: A.tenantId } });
    const mine = await alert(A);
    // The sweep has not run since midnight: still open, but not on the bell.
    const stillOpen = await alert(A, { deliveryDate: yesterday });
    const ended = await alert(A, { deliveryDate: yesterday, resolvedAt: new Date(), resolvedReason: 'DAY_ENDED', ackedAt: new Date(Date.now() - 3_600_000), ackedById: A.plannerId });
    as(A, 'VIEWER');
    const bell = await call(SUMMARY, '/api/alerts/summary');
    expect(bell.body.data).toMatchObject({ enabled: true, today, open: 1, high: 1 });
    expect(bell.body.data.latest.map((r: any) => r.id)).toEqual([mine.id]);
    const list = await call(LIST, `/api/alerts?date=${yIso}`);
    expect(list.body.data.today).toBe(today);
    const by = new Map<string, any>(list.body.data.rows.map((r: any) => [r.id, r]));
    expect([...by.keys()].sort()).toEqual([stillOpen.id, ended.id].sort());
    expect(by.get(ended.id)).toMatchObject({ state: 'RESOLVED', resolvedReason: 'DAY_ENDED', ackedByName: 'Dispatcher Example', deliveryDate: yIso });
    expect(by.get(stillOpen.id)).toMatchObject({ state: 'OPEN', deliveryDate: yIso });
  });

  it("review of the branch (finding 2): yesterday's Load not closed raised after midnight counts on the bell under its day; one raised before midnight and still open (the sweep has not run) does not", async () => {
    await prisma.opsAlert.deleteMany({ where: { tenantId: A.tenantId } });
    const mine = await alert(A);
    const evening = new Date(zonedDayStart(yIso, TZ).getTime() + 21 * 3_600_000);
    const lateFollowUp = await alert(A, { deliveryDate: yesterday, rule: 'LOAD_NOT_CLOSED', firstSeenAt: new Date() });
    await alert(A, { deliveryDate: yesterday, rule: 'LOAD_NOT_CLOSED', firstSeenAt: evening });
    await alert(A, { deliveryDate: yesterday, firstSeenAt: new Date() });
    as(A, 'VIEWER');
    const bell = await call(SUMMARY, '/api/alerts/summary');
    expect(bell.body.data).toMatchObject({ enabled: true, today, open: 2, high: 2 });
    expect(bell.body.data.latest.map((r: any) => r.id).sort()).toEqual([mine.id, lateFollowUp.id].sort());
    expect(bell.body.data.latest.find((r: any) => r.id === lateFollowUp.id)).toMatchObject({ deliveryDate: yIso, rule: 'LOAD_NOT_CLOSED', state: 'OPEN' });
  });

  it("the e-mail: a day that is over is never e-mailed again; a row closed as Day ended that was never e-mailed goes once (finding 1); yesterday's follow-up raised after midnight goes like today's (finding 2)", async () => {
    await prisma.opsAlert.deleteMany({ where: { tenantId: B.tenantId } });
    await prisma.opsAlertDigest.deleteMany({ where: { tenantId: B.tenantId } });
    // The claim runs at 06:05 of the company's today (a fixed clock: the 12 h look back must not depend on when the test runs).
    const dayStart = zonedDayStart(today, TZ);
    const now = new Date(dayStart.getTime() + (6 * 60 + 5) * 60_000);
    const after = (min: number) => new Date(dayStart.getTime() + min * 60_000);
    const evening = new Date(zonedDayStart(yIso, TZ).getTime() + (21 * 60 + 50) * 60_000);
    const fresh = await alert(B);
    // A HIGH of 21:50 yesterday, closed at midnight, never e-mailed (the quiet hours began at 22:00): goes once.
    const dayEnded = await alert(B, { deliveryDate: yesterday, firstSeenAt: evening, lastSeenAt: evening, resolvedAt: after(2), resolvedReason: 'DAY_ENDED' });
    // Already e-mailed (at its tier, or at a lower one before it got worse): never again once its day ended.
    await alert(B, { deliveryDate: yesterday, firstSeenAt: evening, lastSeenAt: evening, resolvedAt: after(2), resolvedReason: 'DAY_ENDED', emailedTier: 2 });
    await alert(B, { deliveryDate: yesterday, firstSeenAt: evening, lastSeenAt: evening, resolvedAt: after(2), resolvedReason: 'DAY_ENDED', emailedTier: 1 });
    // Not seen for more than 12 h (the look back), acknowledged, or written closed after midnight (mayEmail false): not claimed.
    await alert(B, { deliveryDate: yesterday, firstSeenAt: evening, lastSeenAt: new Date(now.getTime() - 13 * 3_600_000), resolvedAt: after(2), resolvedReason: 'DAY_ENDED' });
    await alert(B, { deliveryDate: yesterday, firstSeenAt: evening, lastSeenAt: evening, resolvedAt: after(2), resolvedReason: 'DAY_ENDED', ackedAt: evening, ackedById: B.plannerId });
    await alert(B, { deliveryDate: yesterday, firstSeenAt: after(40), lastSeenAt: after(40), resolvedAt: after(40), resolvedReason: 'DAY_ENDED', mayToast: false, mayEmail: false });
    // Yesterday's, still open because the sweep has not run since midnight: not e-mailed as open.
    await alert(B, { deliveryDate: yesterday, firstSeenAt: evening, lastSeenAt: evening });
    // Yesterday's Load not closed raised after midnight (a load planned back late): like a row of today.
    const followUp = await alert(B, { deliveryDate: yesterday, rule: 'LOAD_NOT_CLOSED', firstSeenAt: after(35), lastSeenAt: after(35) });
    const store = prismaDigestStore(prisma);
    const out = await store.claim(B.tenantId, now, { everyMin: 15, minSeverity: 'HIGH', dayStart, today, recipients: 1 });
    expect(out.ok).toBe(true);
    const claimed = (out as { digestId: string; rows: { id: string; resolvedReason?: string | null; emailedTier: number }[] }).rows;
    expect(claimed.map((r) => r.id).sort()).toEqual([fresh.id, dayEnded.id, followUp.id].sort());
    expect(claimed.find((r) => r.id === dayEnded.id)).toMatchObject({ resolvedReason: 'DAY_ENDED', emailedTier: 0 });
    // Once: the claim set emailedTier = tier; after the e-mail went, the next claim finds nothing new.
    expect((await prisma.opsAlert.findUniqueOrThrow({ where: { id: dayEnded.id } })).emailedTier).toBe(2);
    await store.finish(B.tenantId, (out as { digestId: string }).digestId, claimed as never, now, { ok: true });
    expect(await store.claim(B.tenantId, new Date(now.getTime() + 16 * 60_000), { everyMin: 15, minSeverity: 'HIGH', dayStart, today, recipients: 1 })).toEqual({ ok: false, skip: 'NOTHING_NEW' });
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Cause & action (owner request 20 Oct 2026: "a place where a note / reason for the alert to have happened and
//    the solution"): PATCH /api/alerts on the real database - the guarded save, the audit row, any state and
//    day, another company's id, the CHECKs of migration 20261020000000_alert_notes, the filter, the incident,
//    the removal, and the 90-day clean-up of lib/alerts/store.ts purgeOldAlertRows.
// ---------------------------------------------------------------------------------------------

const patch = async (body: unknown) => {
  const res = await PATCH(new Request('http://localhost/api/alerts', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as { data: any; error: any } };
};
const save = (id: string, extra: Record<string, unknown> = {}) => ({ id, baseReviewedAt: null, cause: 'TRAFFIC', action: 'CALLED_DRIVER', ...extra });

describe('cause & action (owner request 20 Oct 2026)', () => {
  it('an own open alert: the columns of the cause & action only, first = last save, the user from the session, one audit row with the codes', async () => {
    const a = await alert(A, { emailedTier: 2 });
    as(A);
    const r = await patch(save(a.id, { note: 'Driver says call 9123 4567 at the gate' }));
    expect(r.status).toBe(200);
    expect(r.body.data.row.review).toMatchObject({ cause: 'TRAFFIC', byName: 'Dispatcher Example', saves: 1, note: 'Driver says call [number] at the gate' });
    const row = await prisma.opsAlert.findUniqueOrThrow({ where: { id: a.id } });
    expect(row).toMatchObject({ reviewCause: 'TRAFFIC', reviewAction: 'CALLED_DRIVER', reviewedById: A.plannerId, reviewFirstById: A.plannerId, reviewSaves: 1, reviewTier: 2, reviewOccurrences: 1 });
    expect(row.reviewFirstAt).toEqual(row.reviewedAt);
    // The alert itself as it was: still open, not acknowledged, its e-mail state kept.
    expect(row).toMatchObject({ ackedAt: null, resolvedAt: null, emailedTier: 2, text: a.text, tier: a.tier });
    const audits = await prisma.auditLog.findMany({ where: { tenantId: A.tenantId, action: 'ALERT_REVIEW_SAVED', entityId: a.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ userId: A.plannerId, entity: 'OpsAlert', beforeJson: null });
    // The texts are the history (review of the branch, finding 2), as cleaned: never the phone number.
    expect(audits[0]!.afterJson).toMatchObject({ cause: 'TRAFFIC', note: 'Driver says call [number] at the gate', noteChars: 37 });
    expect(JSON.stringify(audits[0]!.afterJson)).not.toContain('9123');
  });

  it('works on acknowledged, over and yesterday\'s Day-ended alerts; their state stays', async () => {
    as(A);
    const yesterday = new Date(`${addDaysIso(today, -1)}T00:00:00.000Z`);
    const acked = await alert(A, { ackedAt: new Date(), ackedById: A.plannerId });
    const over = await alert(A, { resolvedAt: new Date(), resolvedReason: 'ENDED' });
    const ended = await alert(A, { deliveryDate: yesterday, resolvedAt: new Date(), resolvedReason: 'DAY_ENDED' });
    for (const a of [acked, over, ended]) {
      expect((await patch(save(a.id, { cause: 'FALSE_ALARM', action: 'NO_ACTION' }))).status).toBe(200);
      const row = await prisma.opsAlert.findUniqueOrThrow({ where: { id: a.id } });
      expect(row).toMatchObject({ reviewCause: 'FALSE_ALARM', ackedAt: a.ackedAt, resolvedAt: a.resolvedAt, resolvedReason: a.resolvedReason });
    }
  });

  it('an edit names the last save: the first save stays, the audit row has before and after; a stale one is 409 and changes nothing', async () => {
    const a = await alert(A);
    as(A);
    await patch(save(a.id));
    const first = await prisma.opsAlert.findUniqueOrThrow({ where: { id: a.id } });
    const edit = await patch(save(a.id, { baseReviewedAt: first.reviewedAt!.toISOString(), cause: 'OTHER', causeOther: 'Road closed by police' }));
    expect(edit.status).toBe(200);
    const second = await prisma.opsAlert.findUniqueOrThrow({ where: { id: a.id } });
    expect(second).toMatchObject({ reviewCause: 'OTHER', reviewCauseOther: 'Road closed by police', reviewSaves: 2, reviewFirstAt: first.reviewFirstAt });
    expect(second.reviewedAt!.getTime()).toBeGreaterThan(first.reviewedAt!.getTime());
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: A.tenantId, action: 'ALERT_REVIEW_SAVED', entityId: a.id }, orderBy: { createdAt: 'desc' } });
    expect(audit.beforeJson).toMatchObject({ cause: 'TRAFFIC' });
    expect(audit.afterJson).toMatchObject({ cause: 'OTHER', causeOtherChars: 21 });
    const stale = await patch(save(a.id, { baseReviewedAt: first.reviewedAt!.toISOString(), cause: 'GPS_ISSUE' }));
    expect([stale.status, stale.body.error.code]).toEqual([409, 'REVIEW_CHANGED']);
    expect(stale.body.error.row.review).toMatchObject({ cause: 'OTHER' });
    expect((await prisma.opsAlert.findUniqueOrThrow({ where: { id: a.id } })).reviewCause).toBe('OTHER');
  });

  it("another company's id is 404 and changes nothing; a VIEWER is 403", async () => {
    const b = await alert(B);
    as(A);
    expect((await patch(save(b.id))).status).toBe(404);
    expect((await prisma.opsAlert.findUniqueOrThrow({ where: { id: b.id } })).reviewedAt).toBeNull();
    as(A, 'VIEWER');
    const own = await alert(A);
    expect((await patch(save(own.id))).status).toBe(403);
    expect(await prisma.auditLog.count({ where: { tenantId: B.tenantId, action: 'ALERT_REVIEW_SAVED' } })).toBe(0);
  });

  it('the database refuses a broken or half cause & action (the CHECKs), and takes a code the lists do not have yet', async () => {
    const a = await alert(A);
    const now = new Date();
    const whole = { reviewCause: 'TRAFFIC', reviewAction: 'CALLED_DRIVER', reviewFirstAt: now, reviewedAt: now, reviewSaves: 1, reviewTier: 2, reviewOccurrences: 1 };
    const refused = async (data: Record<string, unknown>) => expect(prisma.opsAlert.update({ where: { id: a.id }, data })).rejects.toThrow();
    await refused({ ...whole, reviewCause: 'traffic' });
    await refused({ ...whole, reviewCause: 'OTHER' });
    await refused({ ...whole, reviewCauseOther: 'Gate locked' });
    await refused({ reviewCause: 'TRAFFIC' });
    await refused({ ...whole, reviewNote: 'x'.repeat(501) });
    await refused({ ...whole, reviewNote: '' });
    await refused({ ...whole, reviewFirstAt: new Date(now.getTime() + 1000) });
    await refused({ ...whole, reviewTier: 4 });
    await prisma.opsAlert.update({ where: { id: a.id }, data: { ...whole, reviewCause: 'A_FUTURE_CODE', reviewAction: 'OTHER', reviewActionOther: 'Sent a van' } });
    expect((await prisma.opsAlert.findUniqueOrThrow({ where: { id: a.id } })).reviewCause).toBe('A_FUTURE_CODE');
  });

  it('GET filters by cause & action, counts on the server and names who saved it', async () => {
    const d = new Date(`${addDaysIso(today, -3)}T00:00:00.000Z`);
    const iso = addDaysIso(today, -3);
    const none = await alert(A, { deliveryDate: d });
    const done = await alert(A, { deliveryDate: d });
    // A follow-up of another date of the last 92 days: in the follow-up count, not in the alerts of the dates.
    const earlier = await alert(A, { deliveryDate: new Date(`${addDaysIso(today, -10)}T00:00:00.000Z`) });
    as(A);
    await patch(save(done.id, { action: 'NONE_YET' }));
    await patch(save(earlier.id, { cause: 'NOT_KNOWN' }));
    as(A, 'VIEWER');
    const missing = await call(LIST, `/api/alerts?date=${iso}&review=missing`);
    expect(missing.body.data.rows.map((r: any) => r.id)).toEqual([none.id]);
    const saved = await call(LIST, `/api/alerts?date=${iso}&review=saved`);
    expect(saved.body.data.rows.map((r: any) => [r.id, r.review.byName, r.review.followUp])).toEqual([[done.id, 'Dispatcher Example', true]]);
    // Finding 15: saved and followUp differ here (1 and 2), so two counts swapped would show.
    expect(saved.body.data.reviewCounts).toEqual({ alerts: 2, saved: 1, other: 0, followUp: 2 });
    const follow = await call(LIST, `/api/alerts?date=${today}&review=followup`);
    expect(follow.body.data.rows.map((r: any) => r.id)).toEqual(expect.arrayContaining([done.id, earlier.id]));
    // Findings 3 and 9: with Follow-up the line still counts the date chosen, not the 92 days.
    const followOfDate = await call(LIST, `/api/alerts?date=${iso}&review=followup`);
    expect(followOfDate.body.data.reviewCounts).toEqual({ alerts: 2, saved: 1, other: 0, followUp: 2 });
    expect(followOfDate.body.data.rows.map((r: any) => r.id).sort()).toEqual([done.id, earlier.id].sort());
  });

  it('one incident: the other alerts of the truck and day without one are filled, never one that has its own; remove clears it', async () => {
    const truck = { truckId: 'tr-incident', truckCode: 'T42' };
    const lead = await alert(A, { ...truck, subjectKey: `${A.depotId}|${today}|tr-incident|1` });
    const silent = await alert(A, { ...truck, rule: 'DRIVER_SILENT', subjectKey: `${A.depotId}|${today}|tr-incident|1` });
    const own = await alert(A, { ...truck, rule: 'AFTER_CLOSING', subjectKey: `${A.depotId}|${today}|tr-incident|1|2`, sequence: 2 });
    as(A);
    await patch(save(own.id, { cause: 'CUSTOMER_CLOSED' }));
    const r = await patch(save(lead.id, { cause: 'TRUCK_BREAKDOWN', action: 'SENT_HELP', alsoIds: [silent.id, own.id] }));
    expect(r.body.data).toMatchObject({ also: [silent.id], skipped: [{ id: own.id, reason: 'ALREADY_SAVED' }] });
    const rows = await prisma.opsAlert.findMany({ where: { id: { in: [lead.id, silent.id, own.id] } } });
    const by = Object.fromEntries(rows.map((x) => [x.id, x]));
    expect([by[lead.id]!.reviewGroupId, by[silent.id]!.reviewGroupId, by[silent.id]!.reviewCause, by[own.id]!.reviewCause]).toEqual([lead.id, lead.id, 'TRUCK_BREAKDOWN', 'CUSTOMER_CLOSED']);
    const gone = await patch({ id: silent.id, baseReviewedAt: by[silent.id]!.reviewedAt!.toISOString(), remove: true });
    expect(gone.status).toBe(200);
    expect(await prisma.opsAlert.findUniqueOrThrow({ where: { id: silent.id } })).toMatchObject({ reviewedAt: null, reviewCause: null, reviewSaves: 0, reviewFollowUp: false, reviewGroupId: null });
    expect(await prisma.auditLog.count({ where: { tenantId: A.tenantId, action: 'ALERT_REVIEW_REMOVED', entityId: silent.id } })).toBe(1);
  });

  it('the 90-day clean-up keeps every row until the analysis retention: text, facts and free texts removed, an open one closed first, then read-only; older rows deleted', async () => {
    const old = new Date(`${addDaysIso(today, -100)}T00:00:00.000Z`);
    const ancient = new Date(`${addDaysIso(today, -800)}T00:00:00.000Z`);
    const reviewedAt = new Date(old.getTime() + 8 * 3_600_000);
    const review = { reviewCause: 'OTHER', reviewCauseOther: 'Gate locked', reviewAction: 'CALLED_CUSTOMER', reviewNote: 'Waited 20 min', reviewFirstAt: reviewedAt, reviewedAt, reviewSaves: 1, reviewTier: 2, reviewOccurrences: 1 };
    const kept = await alert(B, { deliveryDate: old, resolvedAt: reviewedAt, resolvedReason: 'ENDED', factsJson: { gps: true, awayMin: 4 }, emailError: 'HTTP 500', ...review });
    const open = await alert(B, { deliveryDate: old, factsJson: { delayMin: 40 } });
    const gone = await alert(B, { deliveryDate: ancient, resolvedAt: ancient, resolvedReason: 'ENDED' });
    const now = new Date();
    const r = await purgeOldAlertRows(prisma, B.tenantId, addDaysIso(today, -90), new Date(now.getTime() - 90 * 86_400_000), { keepUntilIso: addDaysIso(today, -730), now });
    expect(r).toMatchObject({ alerts: 1, closed: 1 });
    expect(r.detailsRemoved).toBeGreaterThanOrEqual(2);
    expect(await prisma.opsAlert.findUnique({ where: { id: gone.id } })).toBeNull();
    expect(await prisma.opsAlert.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({
      text: '', factsJson: { gps: true }, emailError: null, reviewCause: 'OTHER', reviewCauseOther: null, reviewNote: null, reviewAction: 'CALLED_CUSTOMER', detailsRemovedAt: now,
    });
    expect(await prisma.opsAlert.findUniqueOrThrow({ where: { id: open.id } })).toMatchObject({ text: '', factsJson: null, resolvedReason: 'EXPIRED', resolvedAt: now, detailsRemovedAt: now });
    // A second run changes nothing; the row is read-only for the API.
    const again = await purgeOldAlertRows(prisma, B.tenantId, addDaysIso(today, -90), new Date(now.getTime() - 90 * 86_400_000), { keepUntilIso: addDaysIso(today, -730), now });
    expect(again).toMatchObject({ alerts: 0, closed: 0, detailsRemoved: 0 });
    as(B);
    const locked = await patch(save(kept.id, { baseReviewedAt: reviewedAt.toISOString() }));
    expect([locked.status, locked.body.error.code]).toEqual([409, 'REVIEW_LOCKED']);
  });

  it('finding 1: while a save holds its locks an e-mail claim answers BUSY and creates no digest (so an alert over by itself is never skipped past), and a sweep skips the company; both are free again after it', async () => {
    const a = await alert(A, { resolvedAt: new Date(), resolvedReason: 'ENDED' });
    const row = (await prisma.opsAlert.findUniqueOrThrow({ where: { id: a.id }, select: REVIEW_ROW_SELECT })) as unknown as ReviewRow;
    const digests = await prisma.opsAlertDigest.count({ where: { tenantId: A.tenantId } });
    const claim = () => prismaDigestStore(prisma).claim(A.tenantId, new Date(), { everyMin: 15, minSeverity: 'HIGH', dayStart: zonedDayStart(today, TZ), today, recipients: 1 });
    const sweepLock = () => prisma.$transaction((tx) => tryLockTenantAlerts(tx, A.tenantId));
    let during: unknown[] = [];
    const r = await saveAlertReview({
      tenantId: A.tenantId,
      userId: A.plannerId,
      row,
      value: { cause: 'TRAFFIC', causeOther: null, action: 'CALLED_DRIVER', actionOther: null, note: null, followUp: false },
      base: null,
      unchanged: false,
      also: [],
      // Inside the save's transaction, after its row is written: other connections try what the e-mail and the sweep do.
      afterSave: async () => {
        during = [await claim(), await sweepLock()];
      },
    });
    expect(r.result).toBe('SAVED');
    expect(during).toEqual([{ ok: false, skip: 'BUSY' }, false]);
    expect(await prisma.opsAlertDigest.count({ where: { tenantId: A.tenantId } })).toBe(digests);
    expect(await sweepLock()).toBe(true);
    const after = await claim();
    expect(after.ok ? 'CLAIMED' : after.skip).not.toBe('BUSY');
  });

  it("finding 2: an edit keeps the earlier note in the audit log; the nightly retention removes the texts of alerts older than 90 days from it, keeping the codes and lengths", async () => {
    const a = await alert(A);
    as(A);
    await patch(save(a.id, { note: 'Gate closed, sales agreed a new slot' }));
    const first = await prisma.opsAlert.findUniqueOrThrow({ where: { id: a.id } });
    await patch(save(a.id, { baseReviewedAt: first.reviewedAt!.toISOString(), note: 'Driver late' }));
    const edit = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: A.tenantId, action: 'ALERT_REVIEW_SAVED', entityId: a.id }, orderBy: { createdAt: 'desc' } });
    expect(edit.beforeJson).toMatchObject({ note: 'Gate closed, sales agreed a new slot', noteChars: 36 });
    expect(edit.afterJson).toMatchObject({ note: 'Driver late', noteChars: 11, noteChanged: true });
    // The audit rows of an alert 100 days old, as a save and a removal wrote them, and one of another company.
    const oldDate = addDaysIso(today, -100);
    const mk = (tenantId: string, action: string, beforeJson: Record<string, unknown>, afterJson: Record<string, unknown>) =>
      prisma.auditLog.create({ data: { tenantId, action, entity: 'OpsAlert', entityId: 'alert-gone', beforeJson: beforeJson as never, afterJson: afterJson as never } });
    const old = await mk(A.tenantId, 'ALERT_REVIEW_SAVED', { cause: 'TRAFFIC', note: 'old note', noteChars: 8 }, { rule: 'ETA_LATE', deliveryDate: oldDate, cause: 'OTHER', causeOther: 'Road closed', causeOtherChars: 11, actionOther: null, note: 'later note', noteChars: 10 });
    const removed = await mk(A.tenantId, 'ALERT_REVIEW_REMOVED', { cause: 'OTHER', causeOther: 'Road closed', note: 'later note', noteChars: 10 }, { rule: 'ETA_LATE', deliveryDate: oldDate });
    const foreign = await mk(B.tenantId, 'ALERT_REVIEW_SAVED', { cause: 'TRAFFIC', note: 'old note' }, { rule: 'ETA_LATE', deliveryDate: oldDate, note: 'kept' });
    expect(await scrubReviewAuditTexts(prisma, A.tenantId, addDaysIso(today, -90))).toBe(2);
    expect(await prisma.auditLog.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
      beforeJson: { cause: 'TRAFFIC', noteChars: 8 },
      afterJson: { rule: 'ETA_LATE', deliveryDate: oldDate, cause: 'OTHER', causeOtherChars: 11, noteChars: 10 },
    });
    const oldAfter = (await prisma.auditLog.findUniqueOrThrow({ where: { id: old.id } })).afterJson as Record<string, unknown>;
    expect(Object.keys(oldAfter).sort()).toEqual(['cause', 'causeOtherChars', 'deliveryDate', 'noteChars', 'rule']);
    expect((await prisma.auditLog.findUniqueOrThrow({ where: { id: removed.id } })).beforeJson).toEqual({ cause: 'OTHER', noteChars: 10 });
    expect((await prisma.auditLog.findUniqueOrThrow({ where: { id: foreign.id } })).afterJson).toMatchObject({ note: 'kept' });
    expect((await prisma.auditLog.findUniqueOrThrow({ where: { id: edit.id } })).afterJson).toMatchObject({ note: 'Driver late' });
    // Nothing left to remove: a second night changes nothing.
    expect(await scrubReviewAuditTexts(prisma, A.tenantId, addDaysIso(today, -90))).toBe(0);
  });
});
