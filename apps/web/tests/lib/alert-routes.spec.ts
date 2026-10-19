/**
 * The operations-alert API (owner request 16 Oct 2026; design PR-2 9.1 with the review's H4, L5, L10 and
 * the tenant-isolation notes) on the REAL route handlers; the session, the tenant-scoped client, the
 * acknowledgement's transaction, the audit writer and the e-mail sender are faked.
 * - GET /api/alerts (every role): today by default, real dates, at most 31 days, a known state and rule;
 *   open rows first, HIGH before WARN by rank; `enabled`.
 * - GET /api/alerts/summary (every role): alerts off answers zeros without reading an alert; on: the open
 *   count, the HIGH count and the newest rows (HIGH first) of today and tomorrow (owner request 19 Oct 2026:
 *   yesterday's no longer, but for yesterday's follow-up raised after midnight: review of the branch,
 *   finding 2), with the company's today; the e-mail cap only when the company e-mails.
 * - POST /api/alerts/ack (PLANNER+): one UPDATE naming the company, only open rows, never above the tier
 *   the screen showed; another company's ids (or none known) 404 with no audit row; one audit row
 *   ALERTS_ACKNOWLEDGED per request that changed something, its user taken from the session.
 * - POST /api/alerts/test-email (TENANT_ADMIN, 3 per 10 min): to the SAVED recipients only; 409 without
 *   e-mail on the server or without recipients; 502 with the provider's status when it refuses.
 * - PATCH /api/alerts (PLANNER+; cause & action, owner request 20 Oct 2026): any state and day; codes of the
 *   rule's lists, Other with its text; guarded by the last save the editor saw (409 REVIEW_CHANGED with the row),
 *   a lock wait (409 ALERT_BUSY); never the alert's own columns; one audit row per alert with the codes, never
 *   the texts; a no-op writes nothing; the other alerts of the incident; remove; read-only after 90 days. GET's
 *   cause & action filter (follow-up: the last 92 days) and its server-side counts.
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
  // Cause & action (owner request 20 Oct 2026): the guarded UPDATEs of a save and what they changed.
  updates: [] as Record<string, any>[],
  raw: [] as string[],
  firstFinds: [] as Record<string, any>[],
  updateError: null as null | Error,
  /** Rows the next guarded UPDATE matches no matter what (a save that lost the race). */
  updateMisses: false,
}));

/** The users' names a row is read with (the fake joins them by id). */
const NAMES: Record<string, string> = { u1: 'Sam Example', u2: 'Lee Example' };

vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: state.user, tenantId: 'tA', role: state.role, name: 'Sam Example', email: 'sam@company.example' } })) }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async (input: Record<string, any>) => void state.audits.push(input)) }));
vi.mock('@/lib/tenant', () => ({
  tenantDb: () => ({
    tenantConfig: { findFirst: async () => state.config },
    tenant: { findFirst: async () => ({ name: 'Example Water Co', slug: 'example' }) },
    opsAlert: {
      findMany: async (args: Record<string, any>) => {
        state.finds.push(args);
        const ids = args.where?.id?.in as string[] | undefined;
        if (ids) return state.rows.filter((r) => ids.includes(r.id as string)).map((r) => ({ ...r }));
        const sev = args.where?.severity;
        return state.rows.filter((r) => (sev === 'HIGH' ? r.severity === 'HIGH' : sev ? r.severity !== 'HIGH' : true));
      },
      // The tenant-scoped client adds the company: a row of another company is never found.
      findFirst: async (args: Record<string, any>) => {
        state.firstFinds.push(args);
        const r = state.rows.find((x) => x.id === args.where?.id && x.tenantId === 'tA');
        if (!r) return null;
        const name = (id: unknown) => (typeof id === 'string' && NAMES[id] ? { name: NAMES[id]! } : null);
        return { ...r, ackedBy: r.ackedBy ?? null, reviewedBy: name(r.reviewedById), reviewFirstBy: name(r.reviewFirstById) };
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
  /** Does a row match a guarded UPDATE's where (equality, null, dates by their time)? */
  const matches = (r: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (v === null ? r[k] == null : v instanceof Date ? r[k] instanceof Date && (r[k] as Date).getTime() === v.getTime() : r[k] === v));
  const tx = {
    opsAlert: {
      count: async () => state.known,
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, any> }) => {
        state.updates.push(args);
        if (state.updateError) throw state.updateError;
        if (state.updateMisses) return { count: 0 };
        const hit = state.rows.filter((r) => matches(r, args.where));
        for (const r of hit) {
          for (const [k, v] of Object.entries(args.data)) r[k] = v && typeof v === 'object' && 'increment' in v ? ((r[k] as number) ?? 0) + (v.increment as number) : v;
        }
        return { count: hit.length };
      },
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      state.sql.push({ text: strings.join('?'), values });
      return state.acked;
    },
    $executeRawUnsafe: async (sql: string) => {
      state.raw.push(sql);
      return 0;
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

import { GET as LIST, PATCH } from '@/app/api/alerts/route';
import { GET as SUMMARY } from '@/app/api/alerts/summary/route';
import { POST as ACK } from '@/app/api/alerts/ack/route';
import { POST as TEST_EMAIL } from '@/app/api/alerts/test-email/route';
import { todayIso, zonedDayStart } from '@/lib/dispatch/time';
import { bellOpenWhere, bellWindow } from '@/lib/alerts/inbox';

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
  // Cause & action (owner request 20 Oct 2026): none recorded.
  reviewCause: null,
  reviewCauseOther: null,
  reviewAction: null,
  reviewActionOther: null,
  reviewNote: null,
  reviewFollowUp: false,
  reviewFirstAt: null,
  reviewFirstById: null,
  reviewedAt: null,
  reviewedById: null,
  reviewSaves: 0,
  reviewGroupId: null,
  reviewTier: null,
  reviewOccurrences: null,
  reviewCustomerId: null,
  detailsRemovedAt: null,
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
  state.updates = [];
  state.raw = [];
  state.firstFinds = [];
  state.updateError = null;
  state.updateMisses = false;
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

  it("on: the open rows of today and tomorrow (owner request 19 Oct 2026: no longer yesterday's), the HIGH count, the newest HIGH first, the company's today", async () => {
    state.role = 'VIEWER';
    state.rows = [alert({ id: 'w1' }), alert({ id: 'h1', severity: 'HIGH', tier: 2 }), alert({ id: 'w2', lastSeenAt: new Date('2026-10-16T05:50:00Z') })];
    const { body } = await get(SUMMARY, '/api/alerts/summary');
    const today = todayIso('Asia/Muscat');
    expect(body.data).toMatchObject({ enabled: true, today, open: 3, high: 1, emailCapReached: false });
    expect(body.data.latest.map((r: any) => r.id)).toEqual(['h1', 'w2', 'w1']);
    const day = (d: number) => new Date(Date.parse(`${today}T00:00:00.000Z`) + d * 86_400_000);
    const open = {
      resolvedAt: null,
      ackedAt: null,
      OR: [
        { deliveryDate: { gte: day(0), lte: day(1) } },
        // Review of the branch (finding 2): yesterday's Load not closed raised since the company's midnight.
        { deliveryDate: day(-1), rule: { in: ['LOAD_NOT_CLOSED'] }, firstSeenAt: { gte: zonedDayStart(today, 'Asia/Muscat') } },
      ],
    };
    expect(state.counts[0].where).toEqual(open);
    // Every read of the bell has the same rows (the counts and both lists).
    for (const q of [...state.counts, ...state.finds]) expect({ resolvedAt: q.where.resolvedAt, ackedAt: q.where.ackedAt, OR: q.where.OR }).toEqual(open);
  });

  it("review of the branch (finding 2): bellOpenWhere - today's and tomorrow's open rows, and only the day's follow-up of yesterday raised since the company's midnight", () => {
    const start = zonedDayStart('2026-10-21', 'Asia/Muscat');
    expect(start).toEqual(new Date('2026-10-20T20:00:00.000Z'));
    expect(bellOpenWhere('2026-10-21', start)).toEqual({
      resolvedAt: null,
      ackedAt: null,
      OR: [
        { deliveryDate: { gte: new Date('2026-10-21T00:00:00.000Z'), lte: new Date('2026-10-22T00:00:00.000Z') } },
        { deliveryDate: new Date('2026-10-20T00:00:00.000Z'), rule: { in: ['LOAD_NOT_CLOSED'] }, firstSeenAt: { gte: start } },
      ],
    });
    // Across a year end.
    expect((bellOpenWhere('2027-01-01', zonedDayStart('2027-01-01', 'Asia/Muscat')).OR as unknown[])[1]).toMatchObject({ deliveryDate: new Date('2026-12-31T00:00:00.000Z') });
  });

  it("bellWindow: today and tomorrow in the company's time zone, across midnight", () => {
    expect(bellWindow('2026-10-17')).toEqual({ from: new Date('2026-10-17T00:00:00.000Z'), to: new Date('2026-10-18T00:00:00.000Z') });
    expect(bellWindow('2026-12-31')).toEqual({ from: new Date('2026-12-31T00:00:00.000Z'), to: new Date('2027-01-01T00:00:00.000Z') });
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

// ---------------------------------------------------------------------------------------------
// Cause & action (owner request 20 Oct 2026: "a place where a note / reason for the alert to have happened and
// the solution"): PATCH /api/alerts (PLANNER+), and GET's filter and counts.
// ---------------------------------------------------------------------------------------------

const patch = async (body: unknown) => {
  const res = await PATCH(new Request('http://localhost/api/alerts', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as { data: any; error: any } };
};
const save = (id: string, extra: Record<string, unknown> = {}) => ({ id, baseReviewedAt: null, cause: 'TRAFFIC', action: 'CALLED_DRIVER', ...extra });
/** A row whose cause & action was saved by u2 at 07:00 (first at 06:30). */
const reviewed = (extra: Record<string, unknown> = {}) =>
  alert({
    reviewCause: 'TRAFFIC',
    reviewCauseOther: null,
    reviewAction: 'CALLED_DRIVER',
    reviewActionOther: null,
    reviewNote: 'Road works near the roundabout',
    reviewFollowUp: false,
    reviewFirstAt: new Date('2026-10-16T06:30:00.000Z'),
    reviewFirstById: 'u2',
    reviewedAt: new Date('2026-10-16T07:00:00.000Z'),
    reviewedById: 'u2',
    reviewSaves: 1,
    reviewGroupId: null,
    reviewTier: 1,
    reviewOccurrences: 1,
    reviewCustomerId: null,
    ...extra,
  });

describe('PATCH /api/alerts: the cause & action of an alert', () => {
  it('a VIEWER may not record one (403); an unknown id or another company\'s is 404; nothing is written', async () => {
    state.rows = [alert({ id: 'a1' }), alert({ id: 'b1', tenantId: 'tB' })];
    state.role = 'VIEWER';
    expect((await patch(save('a1'))).status).toBe(403);
    state.role = 'PLANNER';
    expect((await patch(save('nope'))).status).toBe(404);
    expect((await patch(save('b1'))).status).toBe(404);
    expect([state.updates, state.audits]).toEqual([[], []]);
  });

  it('refuses a malformed body (400): a code that is no code, extra fields, a missing base, a long note', async () => {
    state.rows = [alert({ id: 'a1' })];
    for (const body of [save('a1', { cause: 'traffic' }), save('a1', { userId: 'u2' }), { id: 'a1', cause: 'TRAFFIC', action: 'CALLED_DRIVER' }, save('a1', { note: 'x'.repeat(2001) }), save('a1', { alsoIds: Array.from({ length: 51 }, (_, i) => `x${i}`) })]) {
      expect((await patch(body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(state.updates).toEqual([]);
  });

  it('refuses Other without its text and a code not offered for the rule (400 with the code and the field)', async () => {
    state.rows = [alert({ id: 'a1' }), alert({ id: 'p1', rule: 'PROOF_FAR', kind: 'EVENT' })];
    const other = await patch(save('a1', { cause: 'OTHER', causeOther: ' a ' }));
    expect([other.status, other.body.error.code, other.body.error.field]).toEqual([400, 'REVIEW_OTHER_REQUIRED', 'cause']);
    const notForRule = await patch(save('p1', { cause: 'TRAFFIC', action: 'FIXED_PIN' }));
    expect([notForRule.status, notForRule.body.error.code, notForRule.body.error.field]).toEqual([400, 'REVIEW_CODE_NOT_FOR_RULE', 'cause']);
    expect(state.updates).toEqual([]);
  });

  it('the first save, on an alert of a day that ended: one guarded UPDATE of the cause & action only, with a lock wait; one audit row with the codes, never the texts', async () => {
    state.rows = [alert({ id: 'a1', resolvedAt: new Date('2026-10-16T20:01:00Z'), resolvedReason: 'DAY_ENDED', tier: 2, occurrences: 2, customerId: 'cust1' })];
    const { status, body } = await patch(save('a1', { cause: 'OTHER', causeOther: 'Road closed by police', note: 'Call 9123 4567 next time', followUp: true }));
    expect(status).toBe(200);
    expect(state.raw).toEqual([`SET LOCAL lock_timeout = '5000ms'`]);
    expect(state.updates).toHaveLength(1);
    const u = state.updates[0]!;
    expect(u.where).toEqual({ tenantId: 'tA', id: 'a1', reviewedAt: null, detailsRemovedAt: null });
    expect(u.data).toMatchObject({
      reviewCause: 'OTHER',
      reviewCauseOther: 'Road closed by police',
      reviewAction: 'CALLED_DRIVER',
      reviewActionOther: null,
      reviewNote: 'Call [number] next time',
      reviewFollowUp: true,
      reviewedById: 'u1',
      reviewFirstById: 'u1',
      reviewSaves: { increment: 1 },
      reviewGroupId: null,
      reviewTier: 2,
      reviewOccurrences: 2,
      reviewCustomerId: 'cust1',
    });
    expect(u.data.reviewFirstAt).toEqual(u.data.reviewedAt);
    // Never the alert itself: its state, acknowledgement and e-mail stay as the sweep left them.
    expect(Object.keys(u.data).filter((k) => !k.startsWith('review'))).toEqual([]);
    expect(body.data).toMatchObject({ changed: true, also: [], skipped: [] });
    expect(body.data.row).toMatchObject({ state: 'RESOLVED', resolvedReason: 'DAY_ENDED', review: { cause: 'OTHER', causeOther: 'Road closed by police', byName: 'Sam Example', firstByName: 'Sam Example', saves: 1, followUp: true } });
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      tenantId: 'tA',
      userId: 'u1',
      action: 'ALERT_REVIEW_SAVED',
      entity: 'OpsAlert',
      entityId: 'a1',
      beforeJson: null,
      afterJson: { rule: 'ETA_LATE', deliveryDate: '2026-10-16', truckCode: 'T05', loadNo: 1, cause: 'OTHER', action: 'CALLED_DRIVER', followUp: true, causeOtherChars: 21, noteChars: 23, noteChanged: true, groupId: null },
    });
    expect(JSON.stringify(state.audits)).not.toMatch(/Road closed|next time/);
  });

  it('an edit names the last save it saw: the first save stays, the time only grows, the audit row has before and after', async () => {
    state.rows = [reviewed({ id: 'a1' })];
    const { status, body } = await patch(save('a1', { baseReviewedAt: '2026-10-16T07:00:00.000Z', action: 'NONE_YET' }));
    expect(status).toBe(200);
    const u = state.updates[0]!;
    expect(u.where).toEqual({ tenantId: 'tA', id: 'a1', reviewedAt: new Date('2026-10-16T07:00:00.000Z'), detailsRemovedAt: null });
    expect(u.data).not.toHaveProperty('reviewFirstAt');
    expect(u.data).not.toHaveProperty('reviewFirstById');
    expect((u.data.reviewedAt as Date).getTime()).toBeGreaterThan(new Date('2026-10-16T07:00:00.000Z').getTime());
    // "Nothing yet" always needs follow-up; the note was not sent: it is removed.
    expect(u.data).toMatchObject({ reviewAction: 'NONE_YET', reviewFollowUp: true, reviewNote: null });
    expect(body.data.row.review).toMatchObject({ byName: 'Sam Example', firstByName: 'Lee Example', saves: 2, firstAt: '2026-10-16T06:30:00.000Z' });
    expect(state.audits[0]).toMatchObject({
      action: 'ALERT_REVIEW_SAVED',
      beforeJson: { cause: 'TRAFFIC', action: 'CALLED_DRIVER', followUp: false, noteChars: 30, savedAt: '2026-10-16T07:00:00.000Z', byId: 'u2' },
      afterJson: { action: 'NONE_YET', followUp: true, noteChars: null, noteChanged: true },
    });
  });

  it('someone saved meanwhile: 409 REVIEW_CHANGED with the alert as it is now, nothing written', async () => {
    state.rows = [reviewed({ id: 'a1' })];
    const stale = await patch(save('a1', { baseReviewedAt: null }));
    expect([stale.status, stale.body.error.code]).toEqual([409, 'REVIEW_CHANGED']);
    expect(stale.body.error.row.review).toMatchObject({ cause: 'TRAFFIC', byName: 'Lee Example', savedAt: '2026-10-16T07:00:00.000Z' });
    expect(state.updates).toEqual([]);
    // ... and when the save loses the race between the read and the UPDATE.
    state.rows = [alert({ id: 'a2' })];
    state.updateMisses = true;
    const race = await patch(save('a2'));
    expect([race.status, race.body.error.code]).toEqual([409, 'REVIEW_CHANGED']);
    expect(state.audits).toEqual([]);
  });

  it('the sweep holds the alert rows longer than the lock wait: 409 ALERT_BUSY, the dialog keeps the draft', async () => {
    state.rows = [alert({ id: 'a1' })];
    state.updateError = Object.assign(new Error('canceling statement due to lock timeout'), { code: 'P2010', meta: { code: '55P03' } });
    const r = await patch(save('a1'));
    expect([r.status, r.body.error.code]).toEqual([409, 'ALERT_BUSY']);
    expect(state.audits).toEqual([]);
  });

  it('a save that changes nothing writes and audits nothing', async () => {
    state.rows = [reviewed({ id: 'a1' })];
    const r = await patch(save('a1', { baseReviewedAt: '2026-10-16T07:00:00.000Z', note: 'Road works near the roundabout' }));
    expect(r.status).toBe(200);
    expect(r.body.data.changed).toBe(false);
    expect([state.updates, state.audits, state.raw]).toEqual([[], [], []]);
  });

  it('one incident (critique item 1): the other alerts of the same truck and day without one get the same cause & action, one audit row each; the rest is skipped and said', async () => {
    state.rows = [
      alert({ id: 'a1', rule: 'ETA_LATE' }),
      alert({ id: 'a2', rule: 'DRIVER_SILENT' }),
      reviewed({ id: 'a3', rule: 'AFTER_CLOSING' }),
      alert({ id: 'a4', truckId: 'tr2', truckCode: 'T07' }),
      alert({ id: 'a5', rule: 'PROOF_FAR', kind: 'EVENT' }),
    ];
    const r = await patch(save('a1', { cause: 'TRUCK_BREAKDOWN', action: 'SENT_HELP', alsoIds: ['a2', 'a3', 'a4', 'a5', 'gone', 'a1'] }));
    expect(r.status).toBe(200);
    expect(r.body.data.also).toEqual(['a2']);
    expect(r.body.data.skipped).toEqual([
      { id: 'a3', reason: 'ALREADY_SAVED' },
      { id: 'a4', reason: 'OTHER_TRUCK_OR_DAY' },
      { id: 'a5', reason: 'NOT_FOR_RULE' },
      { id: 'gone', reason: 'NOT_FOUND' },
    ]);
    expect(state.updates.map((u) => [u.where.id, u.where.reviewedAt, u.data.reviewGroupId])).toEqual([
      ['a1', null, 'a1'],
      ['a2', null, 'a1'],
    ]);
    expect(state.audits.map((a) => [a.entityId, a.afterJson.groupId, a.afterJson.savedWith ?? null])).toEqual([
      ['a1', 'a1', null],
      ['a2', 'a1', 'a1'],
    ]);
    // a3 kept its own cause & action.
    expect(state.rows.find((x) => x.id === 'a3')).toMatchObject({ reviewCause: 'TRAFFIC' });
  });

  it('remove (saved on the wrong alert): every column back to none with the last save named; audited; a stale one is 409', async () => {
    state.rows = [reviewed({ id: 'a1' })];
    const stale = await patch({ id: 'a1', baseReviewedAt: '2026-10-16T06:00:00.000Z', remove: true });
    expect([stale.status, stale.body.error.code]).toEqual([409, 'REVIEW_CHANGED']);
    const r = await patch({ id: 'a1', baseReviewedAt: '2026-10-16T07:00:00.000Z', remove: true });
    expect(r.status).toBe(200);
    expect(r.body.data.row.review).toBeNull();
    expect(state.updates[0]!.data).toEqual({
      reviewCause: null, reviewCauseOther: null, reviewAction: null, reviewActionOther: null, reviewNote: null, reviewFollowUp: false, reviewFirstAt: null,
      reviewFirstById: null, reviewedAt: null, reviewedById: null, reviewSaves: 0, reviewGroupId: null, reviewTier: null, reviewOccurrences: null, reviewCustomerId: null,
    });
    expect(state.audits).toEqual([
      expect.objectContaining({ action: 'ALERT_REVIEW_REMOVED', entityId: 'a1', beforeJson: expect.objectContaining({ cause: 'TRAFFIC', byId: 'u2' }), afterJson: expect.objectContaining({ rule: 'ETA_LATE', truckCode: 'T05' }) }),
    ]);
  });

  it('an alert older than 90 days (details removed) is read-only: 409 REVIEW_LOCKED', async () => {
    state.rows = [alert({ id: 'a1', text: '', detailsRemovedAt: new Date('2026-10-16T00:00:00Z') })];
    const r = await patch(save('a1'));
    expect([r.status, r.body.error.code]).toEqual([409, 'REVIEW_LOCKED']);
    expect(state.updates).toEqual([]);
  });
});

describe('GET /api/alerts: the cause & action filter and counts', () => {
  it('missing, saved and follow-up filter the rows; follow-up reads the last 92 days whatever the dates; an unknown filter is 400', async () => {
    await get(LIST, '/api/alerts?date=2026-10-15&review=missing');
    expect(state.finds[0].where).toMatchObject({ reviewedAt: null });
    await get(LIST, '/api/alerts?date=2026-10-15&review=saved');
    expect(state.finds[1].where).toMatchObject({ reviewedAt: { not: null } });
    const { body } = await get(LIST, '/api/alerts?date=2026-10-15&review=followup');
    const today = todayIso('Asia/Muscat');
    const day = (d: number) => new Date(Date.parse(`${today}T00:00:00.000Z`) + d * 86_400_000);
    expect(state.finds[2].where).toMatchObject({ reviewFollowUp: true, deliveryDate: { gte: day(-91), lte: day(1) } });
    expect(body.data.review).toBe('followup');
    expect((await get(LIST, '/api/alerts?review=bad')).status).toBe(400);
  });

  it('the count line is counted on the server (the alerts of the dates whatever the filter, with one, Other, follow-up of 92 days); the rows carry their cause & action', async () => {
    state.rows = [reviewed({ id: 'r1' }), alert({ id: 'n1' })];
    const { body } = await get(LIST, '/api/alerts?from=2026-10-14&to=2026-10-16&review=missing&depotId=dep1');
    expect(body.data.reviewCounts).toEqual({ alerts: 2, saved: 2, other: 2, followUp: 2 });
    const range = { gte: new Date('2026-10-14T00:00:00.000Z'), lte: new Date('2026-10-16T00:00:00.000Z') };
    expect(state.counts.map((c) => c.where)).toEqual([
      { deliveryDate: range, depotId: 'dep1' },
      { deliveryDate: range, depotId: 'dep1', reviewedAt: { not: null } },
      { deliveryDate: range, depotId: 'dep1', OR: [{ reviewCause: 'OTHER' }, { reviewAction: 'OTHER' }] },
      { reviewFollowUp: true, deliveryDate: expect.any(Object), depotId: 'dep1' },
    ]);
    expect(body.data.rows.find((r: any) => r.id === 'r1').review).toMatchObject({ cause: 'TRAFFIC', note: 'Road works near the roundabout' });
    expect(body.data.rows.find((r: any) => r.id === 'n1').review).toBeNull();
  });
});
