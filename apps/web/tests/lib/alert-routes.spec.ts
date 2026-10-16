/**
 * The operations-alert API (owner request 16 Oct 2026; design PR-2 9.1 with the review's H4, L5, L10 and
 * the tenant-isolation notes) on the REAL route handlers; the session, the tenant-scoped client, the
 * acknowledgement's transaction, the audit writer and the e-mail sender are faked.
 * - GET /api/alerts (every role): today by default, real dates, at most 31 days, a known state and rule;
 *   open rows first, HIGH before WARN by rank; `enabled`.
 * - GET /api/alerts/summary (every role): alerts off answers zeros without reading an alert; on: the open
 *   count, the HIGH count and the newest rows (HIGH first) of yesterday, today and tomorrow; the e-mail cap
 *   only when the company e-mails.
 * - POST /api/alerts/ack (PLANNER+): one UPDATE naming the company, only open rows, never above the tier
 *   the screen showed; another company's ids (or none known) 404 with no audit row; one audit row
 *   ALERTS_ACKNOWLEDGED per request that changed something, its user taken from the session.
 * - POST /api/alerts/test-email (TENANT_ADMIN, 3 per 10 min): to the SAVED recipients only; 409 without
 *   e-mail on the server or without recipients; 502 with the provider's status when it refuses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const state = vi.hoisted(() => ({
  role: 'PLANNER' as string,
  user: 'u1',
  config: null as null | Record<string, unknown>,
  rows: [] as Record<string, unknown>[],
  known: 0,
  acked: [] as { id: string; rule: string; deliveryDate: Date }[],
  sql: [] as { text: string; values: unknown[] }[],
  audits: [] as Record<string, any>[],
  finds: [] as Record<string, any>[],
  counts: [] as Record<string, any>[],
  digests: 0,
  emailOn: true,
  sends: [] as Record<string, any>[],
  sendResult: { ok: true } as Record<string, unknown>,
}));

vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: state.user, tenantId: 'tA', role: state.role, name: 'Sam Example', email: 'sam@company.example' } })) }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async (input: Record<string, any>) => void state.audits.push(input)) }));
vi.mock('@/lib/tenant', () => ({
  tenantDb: () => ({
    tenantConfig: { findFirst: async () => state.config },
    tenant: { findFirst: async () => ({ name: 'Example Water Co', slug: 'example' }) },
    opsAlert: {
      findMany: async (args: Record<string, any>) => {
        state.finds.push(args);
        const sev = args.where?.severity;
        return state.rows.filter((r) => (sev === 'HIGH' ? r.severity === 'HIGH' : sev ? r.severity !== 'HIGH' : true));
      },
      count: async (args: Record<string, any>) => {
        state.counts.push(args);
        return state.rows.filter((r) => (args.where?.severity === 'HIGH' ? r.severity === 'HIGH' : true)).length;
      },
    },
    opsAlertDigest: { count: async () => state.digests },
  }),
}));
vi.mock('@/lib/db', () => {
  const tx = {
    opsAlert: { count: async () => state.known },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      state.sql.push({ text: strings.join('?'), values });
      return state.acked;
    },
  };
  return { prisma: { ...tx, $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } };
});
vi.mock('@/lib/email', () => ({
  plainEmailConfigured: () => state.emailOn,
  sendPlainEmail: async (msg: Record<string, unknown>) => {
    state.sends.push(msg);
    return state.sendResult;
  },
}));

import { GET as LIST } from '@/app/api/alerts/route';
import { GET as SUMMARY } from '@/app/api/alerts/summary/route';
import { POST as ACK } from '@/app/api/alerts/ack/route';
import { POST as TEST_EMAIL } from '@/app/api/alerts/test-email/route';
import { todayIso } from '@/lib/dispatch/time';

const cfg = (extra: Record<string, unknown> = {}) => ({
  alertsEnabled: true,
  timezone: 'Asia/Muscat',
  alertEmails: 'owner@company.example',
  alertEmailEveryMin: 15,
  alertEmailMinSeverity: 'HIGH',
  alertQuietFromMin: 1320,
  alertQuietToMin: 360,
  ...extra,
});

let n = 0;
const alert = (extra: Record<string, unknown> = {}) => ({
  id: `a${++n}`,
  tenantId: 'tA',
  depotId: 'dep1',
  deliveryDate: new Date('2026-10-16T00:00:00.000Z'),
  rule: 'ETA_LATE',
  subjectKey: `dep1|2026-10-16|tr1|${n}`,
  truckId: 'tr1',
  truckCode: 'T05',
  loadNo: 1,
  sequence: null,
  customerId: null,
  kind: 'CONDITION',
  severity: 'WARN',
  tier: 1,
  value: 35,
  threshold: 30,
  text: 'T05 L1 is running about 35 min late.',
  factsJson: { secret: 'never sent' },
  mayToast: true,
  mayEmail: true,
  occurredAt: new Date('2026-10-16T05:10:00.000Z'),
  firstSeenAt: new Date('2026-10-16T05:12:00.000Z'),
  lastSeenAt: new Date('2026-10-16T05:30:00.000Z'),
  resolvedAt: null,
  resolvedReason: null,
  occurrences: 1,
  ackedAt: null,
  ackedById: null,
  ackedBy: null,
  emailedTier: 0,
  emailedAt: null,
  digestId: null,
  emailAttempts: 0,
  emailError: null,
  ...extra,
});

const get = async (handler: (r: Request) => Promise<Response>, url: string) => {
  const res = await handler(new Request(`http://localhost${url}`));
  return { status: res.status, body: (await res.json()) as { data: any; error: any } };
};
const post = async (handler: (r: Request) => Promise<Response>, url: string, body?: unknown) => {
  const res = await handler(new Request(`http://localhost${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as { data: any; error: any } };
};

beforeEach(() => {
  state.role = 'PLANNER';
  state.user = 'u1';
  state.config = cfg();
  state.rows = [];
  state.known = 0;
  state.acked = [];
  state.sql = [];
  state.audits = [];
  state.finds = [];
  state.counts = [];
  state.digests = 0;
  state.emailOn = true;
  state.sends = [];
  state.sendResult = { ok: true };
});

describe('GET /api/alerts', () => {
  it('every role reads it: today in the company time zone by default; open first, HIGH before WARN; no facts or e-mail state', async () => {
    state.role = 'VIEWER';
    state.rows = [
      alert({ id: 'over', resolvedAt: new Date('2026-10-16T05:40:00Z'), resolvedReason: 'ENDED', severity: 'HIGH', tier: 2 }),
      alert({ id: 'warn' }),
      alert({ id: 'acked', ackedAt: new Date('2026-10-16T05:35:00Z'), ackedBy: { name: 'Sam Example' }, severity: 'HIGH', tier: 2 }),
      alert({ id: 'high', severity: 'HIGH', tier: 2 }),
    ];
    const { status, body } = await get(LIST, '/api/alerts');
    expect(status).toBe(200);
    const today = todayIso('Asia/Muscat');
    expect(body.data).toMatchObject({ enabled: true, today, from: today, to: today, state: 'all', depotId: null, rule: null, truncated: false });
    expect(body.data.rows.map((r: any) => [r.id, r.state])).toEqual([
      ['high', 'OPEN'],
      ['warn', 'OPEN'],
      ['acked', 'ACKED'],
      ['over', 'RESOLVED'],
    ]);
    expect(body.data.rows[2].ackedByName).toBe('Sam Example');
    expect(JSON.stringify(body)).not.toMatch(/never sent|emailedTier|digestId/);
    expect(state.finds[0].where).toMatchObject({ deliveryDate: { gte: new Date(`${today}T00:00:00.000Z`), lte: new Date(`${today}T00:00:00.000Z`) } });
    expect(state.finds[0].orderBy[0]).toEqual({ resolvedAt: { sort: 'desc', nulls: 'first' } });
  });

  it('filters by dates, depot, state and rule', async () => {
    await get(LIST, '/api/alerts?from=2026-10-14&to=2026-10-16&depotId=dep2&state=open&rule=UNLOAD_OVER');
    expect(state.finds[0].where).toEqual({
      deliveryDate: { gte: new Date('2026-10-14T00:00:00.000Z'), lte: new Date('2026-10-16T00:00:00.000Z') },
      depotId: 'dep2',
      rule: 'UNLOAD_OVER',
      resolvedAt: null,
      ackedAt: null,
    });
    await get(LIST, '/api/alerts?date=2026-10-15&state=resolved');
    expect(state.finds[1].where).toEqual({ deliveryDate: { gte: new Date('2026-10-15T00:00:00.000Z'), lte: new Date('2026-10-15T00:00:00.000Z') }, resolvedAt: { not: null } });
  });

  it('refuses unreal dates, a reversed or too long range, an unknown state or rule (400)', async () => {
    for (const q of ['from=2026-02-30', 'from=2026-10-16&to=2026-10-15', 'from=2026-09-01&to=2026-10-16', 'state=new', 'rule=SPEEDING']) {
      expect((await get(LIST, `/api/alerts?${q}`)).status, q).toBe(400);
    }
    expect(state.finds).toEqual([]);
  });
});

describe('GET /api/alerts/summary (the bell)', () => {
  it('alerts off: zeros, and no alert is read', async () => {
    state.config = cfg({ alertsEnabled: false });
    state.rows = [alert()];
    expect((await get(SUMMARY, '/api/alerts/summary')).body.data).toEqual({ enabled: false, open: 0, high: 0, latest: [], emailCapReached: false, checkedAt: null, checkStale: false, checkFailed: false });
    expect(state.finds).toEqual([]);
    expect(state.counts).toEqual([]);
  });

  it('on: the open rows of yesterday to tomorrow, the HIGH count, the newest HIGH first', async () => {
    state.role = 'VIEWER';
    state.rows = [alert({ id: 'w1' }), alert({ id: 'h1', severity: 'HIGH', tier: 2 }), alert({ id: 'w2', lastSeenAt: new Date('2026-10-16T05:50:00Z') })];
    const { body } = await get(SUMMARY, '/api/alerts/summary');
    expect(body.data).toMatchObject({ enabled: true, open: 3, high: 1, emailCapReached: false });
    expect(body.data.latest.map((r: any) => r.id)).toEqual(['h1', 'w2', 'w1']);
    const today = todayIso('Asia/Muscat');
    const day = (d: number) => new Date(Date.parse(`${today}T00:00:00.000Z`) + d * 86_400_000);
    expect(state.counts[0].where).toEqual({ deliveryDate: { gte: day(-1), lte: day(1) }, resolvedAt: null, ackedAt: null });
  });

  it('says when the e-mails of today reached the daily cap, only when the company e-mails', async () => {
    state.digests = 40;
    expect((await get(SUMMARY, '/api/alerts/summary')).body.data.emailCapReached).toBe(true);
    state.config = cfg({ alertEmails: null });
    expect((await get(SUMMARY, '/api/alerts/summary')).body.data.emailCapReached).toBe(false);
  });
});

describe('POST /api/alerts/ack', () => {
  it('a VIEWER may not acknowledge (403); nothing runs', async () => {
    state.role = 'VIEWER';
    expect((await post(ACK, '/api/alerts/ack', { ids: ['a1'] })).status).toBe(403);
    expect(state.sql).toEqual([]);
  });

  it('acknowledges in one UPDATE naming the company, open rows only, never above the tier shown; one audit row from the session', async () => {
    state.known = 2;
    state.acked = [
      { id: 'a1', rule: 'ETA_LATE', deliveryDate: new Date('2026-10-16T00:00:00Z') },
      { id: 'a2', rule: 'UNLOAD_OVER', deliveryDate: new Date('2026-10-16T00:00:00Z') },
    ];
    const { status, body } = await post(ACK, '/api/alerts/ack', { ids: ['a1', 'a2', 'a1'], seen: { a1: 2 } });
    expect(status).toBe(200);
    expect(body.data).toEqual({ acked: 2, ids: ['a1', 'a2'] });
    const q = state.sql[0]!;
    expect(q.text).toMatch(/UPDATE "OpsAlert" AS a SET "ackedAt" = \?, "ackedById" = \?/);
    expect(q.text).toMatch(/a\."tenantId" = \? AND a\."ackedAt" IS NULL AND a\."resolvedAt" IS NULL AND a\."tier" <= s\."seen"/);
    expect(q.values).toEqual([expect.any(Date), 'u1', ['a1', 'a2'], [2, 3], 'tA']);
    expect(state.audits).toEqual([
      {
        tenantId: 'tA',
        userId: 'u1',
        action: 'ALERTS_ACKNOWLEDGED',
        entity: 'OpsAlert',
        entityId: null,
        afterJson: { count: 2, ids: ['a1', 'a2'], rules: ['ETA_LATE', 'UNLOAD_OVER'], dates: ['2026-10-16'] },
      },
    ]);
  });

  it("another company's ids, or ids nobody knows: 404, nothing changed, no audit row", async () => {
    state.known = 0;
    expect((await post(ACK, '/api/alerts/ack', { ids: ['foreign1'] })).status).toBe(404);
    expect(state.sql).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it('a mix of own and foreign ids acknowledges only the own ones (the UPDATE names the company)', async () => {
    state.known = 1;
    state.acked = [{ id: 'own', rule: 'ETA_LATE', deliveryDate: new Date('2026-10-16T00:00:00Z') }];
    const { body } = await post(ACK, '/api/alerts/ack', { ids: ['own', 'foreign1'] });
    expect(body.data).toEqual({ acked: 1, ids: ['own'] });
    expect(state.sql[0]!.values).toContain('tA');
    expect(state.audits[0]).toMatchObject({ entityId: 'own', afterJson: { count: 1, ids: ['own'] } });
  });

  it('nothing left to acknowledge (already done, or worse since): 200 with 0 and no audit row', async () => {
    state.known = 1;
    state.acked = [];
    expect((await post(ACK, '/api/alerts/ack', { ids: ['a1'], seen: { a1: 1 } })).body.data).toEqual({ acked: 0, ids: [] });
    expect(state.audits).toEqual([]);
  });

  it('{ all: { date, depotId } } acknowledges every open row of that day and depot', async () => {
    state.acked = [{ id: 'a9', rule: 'PAGE_NOT_OPENED', deliveryDate: new Date('2026-10-16T00:00:00Z') }];
    const { body } = await post(ACK, '/api/alerts/ack', { all: { date: '2026-10-16', depotId: 'dep1' } });
    expect(body.data).toEqual({ acked: 1, ids: ['a9'] });
    expect(state.sql[0]!.text).toMatch(/WHERE "tenantId" = \? AND "ackedAt" IS NULL AND "resolvedAt" IS NULL AND "deliveryDate" = \?::date/);
    expect(state.audits[0]!.afterJson).toMatchObject({ count: 1, all: { date: '2026-10-16', depotId: 'dep1' } });
  });

  it('refuses a malformed body (400): no ids, over 200, a tier of 4, an unreal date, extra fields', async () => {
    // { all } needs a date (review L10: never every open row of the company at once).
    for (const body of [{ ids: [] }, { ids: Array.from({ length: 201 }, (_, i) => `a${i}`) }, { ids: ['a1'], seen: { a1: 4 } }, { all: { date: '2026-13-01' } }, { all: {} }, { all: { depotId: 'dep1' } }, { ids: ['a1'], userId: 'u2' }, {}]) {
      expect((await post(ACK, '/api/alerts/ack', body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(state.sql).toEqual([]);
  });
});

describe('POST /api/alerts/test-email', () => {
  beforeEach(() => {
    vi.stubEnv('ALERT_EMAIL_TENANTS', 'example');
    return () => vi.unstubAllEnvs();
  });

  it('company admin only (a dispatcher gets 403)', async () => {
    state.role = 'PLANNER';
    expect((await post(TEST_EMAIL, '/api/alerts/test-email')).status).toBe(403);
    expect(state.sends).toEqual([]);
  });

  it('409 when the server has no e-mail set up, or no recipients are saved', async () => {
    state.role = 'TENANT_ADMIN';
    state.emailOn = false;
    const off = await post(TEST_EMAIL, '/api/alerts/test-email');
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('EMAIL_NOT_CONFIGURED');
    state.emailOn = true;
    state.config = cfg({ alertEmails: null });
    const none = await post(TEST_EMAIL, '/api/alerts/test-email');
    expect([none.status, none.body.error.code]).toEqual([409, 'NO_RECIPIENTS']);
    expect(state.sends).toEqual([]);
  });

  it('review H1: 409 when the company is not on the server\'s ALERT_EMAIL_TENANTS list (open signup cannot send through our sender)', async () => {
    state.role = 'TENANT_ADMIN';
    vi.stubEnv('ALERT_EMAIL_TENANTS', 'someone-else');
    const res = await post(TEST_EMAIL, '/api/alerts/test-email');
    expect([res.status, res.body.error.code]).toEqual([409, 'EMAIL_NOT_ALLOWED']);
    vi.stubEnv('ALERT_EMAIL_TENANTS', '');
    expect((await post(TEST_EMAIL, '/api/alerts/test-email')).status).toBe(409);
    expect(state.sends).toEqual([]);
  });

  it('sends to the saved recipients only (an address in the request is ignored), whether alerts are on or not', async () => {
    state.role = 'TENANT_ADMIN';
    state.config = cfg({ alertsEnabled: false, alertEmails: 'owner@company.example, ops@company.example' });
    const { status, body } = await post(TEST_EMAIL, '/api/alerts/test-email', { to: 'someone@else.example' });
    expect(status).toBe(200);
    expect(body.data).toEqual({ sent: true, recipients: 2 });
    expect(state.sends[0]!.to).toEqual(['owner@company.example', 'ops@company.example']);
    // No name a user typed (the company, the user): review H1.
    expect(state.sends[0]!.subject).toBe('RouteIQ alerts: test e-mail');
    expect(state.sends[0]!.text).not.toMatch(/Example Water Co|Sam Example/);
    expect(state.sends[0]!.text).toContain('Operations alerts are OFF.');
    expect(state.sends[0]!.text).toContain('high alerts only, at most one every 15 min, none from 22:00 to 06:00.');
  });

  it("502 with the provider's status when it refuses", async () => {
    state.role = 'TENANT_ADMIN';
    state.sendResult = { ok: false, reason: 'REJECTED', status: 403, error: 'provider answered 403' };
    const res = await post(TEST_EMAIL, '/api/alerts/test-email');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({ code: 'EMAIL_FAILED' });
    expect(res.body.error.message).toContain('provider answered 403');
  });

  it('is limited to 3 per 10 min per user (the limiter is off under NODE_ENV=test, so the options are read)', () => {
    const src = readFileSync(path.resolve(__dirname, '../../app/api/alerts/test-email/route.ts'), 'utf8');
    expect(src).toMatch(/\{ role: 'TENANT_ADMIN', rateLimitKey: 'alerts-test-email', rateLimitLimit: 3, rateLimitWindowMs: 10 \* 60_000 \}/);
  });
});
