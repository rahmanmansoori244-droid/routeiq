/**
 * IVMS live link (16 Oct 2026): with the link not in use, nothing existing changes - proved on the real
 * route handlers with their dependencies faked (no database, no solver, no call to Ayun):
 * - the cron route's answer and /api/health's answer are byte-identical with and without the AYUN_*
 *   variables while the company's ivmsMode is OFF; only the setting (and one EXISTS) is read;
 * - with the link in use the health answer gains an `ivms` block (counts and kind codes only) and never
 *   changes its status; the cron answer gains `ivms`;
 * - the in-process janitor starts the IVMS timer only after its own off switch, and every IVMS step has
 *   its own try (source checks);
 * - the GPS retention (lib/ivms/retention.ts): nothing but one EXISTS while no GPS data exists; the trail
 *   after ivmsTrailDays, positions when OFF or a day old, event positions erased, rows after the
 *   location retention;
 * - Sentry never sees the webhook secret or the Ayun key (lib/observability-scrub.ts), and strings without
 *   them are unchanged.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ mode: 'OFF', gpsData: false, calls: [] as string[], state: null as Record<string, unknown> | null }));
vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (/EXISTS/.test(sql)) {
        db.calls.push('exists');
        return [{ any: db.gpsData }];
      }
      return [{ '?column?': 1 }];
    }),
    tenant: {
      findUnique: vi.fn(async () => {
        db.calls.push('tenant');
        return {
          id: 'tA',
          slug: 'example-co',
          active: true,
          config: { timezone: 'Asia/Muscat', ivmsMode: db.mode, ivmsPollSec: 60, ivmsRoutePullMin: 60, ivmsFromMin: 300, ivmsToMin: 1380, ivmsDailyCallBudget: 100, ivmsTrailDays: 2 },
          ivmsState: db.state,
        };
      }),
    },
    tenantConfig: { findMany: vi.fn(async () => []) },
    truck: {
      findMany: vi.fn(async () => {
        db.calls.push('trucks');
        return [];
      }),
    },
    truckPosition: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  },
}));
vi.mock('@/lib/janitor-auth', () => ({ janitorAuthorized: (r: Request) => r.headers.get('x-janitor-token') === 'x' }));
vi.mock('@/lib/jobs/optimize-job', () => ({ reapStuckJobs: async () => ({ reaped: 0, repaired: 0 }) }));
vi.mock('@/lib/jobs/shift-janitor', () => ({ reapStaleShifts: async () => ({ reaped: 0 }) }));
vi.mock('@/lib/delivery/event-service', () => ({ completeReturnedLoads: async () => ({ completed: 0, checked: 2 }) }));
vi.mock('@/lib/jobs/delivery-janitor', () => ({ runDeliveryJanitor: async () => ({ photos: { count: 0 }, locations: { events: 0, visits: 0, photos: 0, links: 0 }, casual: null }) }));
vi.mock('@/lib/dispatch/hire-whatif', () => ({ failLostHireChecks: async () => 0, retireOneDayTrucks: async () => 0 }));

import { prisma } from '@/lib/db';
import { GET as cronGet } from '@/app/api/cron/janitor/route';
import { GET as healthGet } from '@/app/api/health/route';
import { _resetIvmsProcessState } from '@/lib/ivms/poll';
import { purgeIvmsData } from '@/lib/ivms/retention';
import { resetAlertSweepClock } from '@/lib/alerts/sweep';
import { driverTracesSampler, scrubBreadcrumb, scrubDriverToken, scrubIvmsSecrets, scrubSentryEvent } from '@/lib/observability-scrub';
import { KEY, SECRET } from './ivms-fakes';

const WEB = path.resolve(__dirname, '../..');
const AYUN = { AYUN_BASE_URL: 'https://provider.example', AYUN_API_KEY: KEY, AYUN_TENANT_SLUG: 'example-co', AYUN_WEBHOOK_SECRET: SECRET };
const setAyun = () => {
  for (const [k, v] of Object.entries(AYUN)) vi.stubEnv(k, v);
};
const req = (p: string) => new Request(`http://localhost${p}`, { headers: { 'x-janitor-token': 'x' } });

beforeEach(() => {
  db.mode = 'OFF';
  db.gpsData = false;
  db.calls = [];
  db.state = null;
  _resetIvmsProcessState();
  for (const k of [...Object.keys(AYUN), 'ROUTEIQ_DISABLE_IVMS', 'SOLVER_URL', 'SOLVER_TOKEN']) vi.stubEnv(k, '');
  // The operations-alert sweep (main, merged 16 Oct 2026) has its own spec (alert-sweep.spec.ts): off here, so
  // the cron answer stays the same bytes (the sweep's report carries its duration). `alerts` is then null.
  vi.stubEnv('ROUTEIQ_DISABLE_ALERTS', '1');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('OFF: the existing answers are byte-identical', () => {
  it('the cron route: the same bytes without the variables and with them while ivmsMode is OFF; only the setting and one EXISTS read', async () => {
    const before = await (await cronGet(req('/api/cron/janitor'))).text();
    expect(JSON.parse(before)).toEqual({
      data: {
        jobs: { reaped: 0, repaired: 0 },
        shifts: { reaped: 0 },
        returnedLoads: { completed: 0, checked: 2 },
        deliveryRetention: { photos: { count: 0 }, locations: { events: 0, visits: 0, photos: 0, links: 0 }, casual: null },
        hire: { lostChecks: 0, oneDayTrucksRetired: 0 },
        alerts: null,
      },
      error: null,
    });
    expect(db.calls).toEqual(['exists']);
    setAyun();
    db.calls = [];
    const after = await (await cronGet(req('/api/cron/janitor'))).text();
    expect(after).toBe(before);
    expect(db.calls).toEqual(['tenant', 'exists']);
  });

  it('/api/health: the same status and bytes with the variables set while ivmsMode is OFF', async () => {
    const r0 = await healthGet();
    const before = await r0.text();
    setAyun();
    const r1 = await healthGet();
    expect(r1.status).toBe(r0.status);
    expect(await r1.text()).toBe(before);
    expect(JSON.parse(before)).not.toHaveProperty('ivms');
  });

  it('the kill switch: no IVMS field and no IVMS read, whatever the mode', async () => {
    setAyun();
    vi.stubEnv('ROUTEIQ_DISABLE_IVMS', '1');
    db.mode = 'TIMES';
    const body = JSON.parse(await (await healthGet()).text());
    expect(body).not.toHaveProperty('ivms');
    expect(db.calls).toEqual([]);
  });
});

describe('in use: the counters, never a secret', () => {
  it('/api/health gains `ivms` (counts and kind codes) with the same HTTP status', async () => {
    const r0 = await healthGet();
    setAyun();
    db.mode = 'MAP';
    const today = new Date();
    db.state = {
      usageDay: new Date(`${today.toISOString().slice(0, 10)}T00:00:00Z`),
      mapCalls: 12,
      routeCalls: 0,
      eventCalls: 0,
      adminCalls: 1,
      lastOkAt: new Date(today.getTime() - 30_000),
      lastError: 'TIMEOUT',
      lastErrorAt: new Date(today.getTime() - 3600_000),
      nextTryAt: null,
      webhooksToday: 4,
      webhooksIgnored: 1,
      webhooksBadTime: 0,
      providerSkewSec: 3,
    };
    // The public answer (no janitor token) never shows the GPS block (first review LOW), and reads nothing for it.
    db.calls = [];
    const open = JSON.parse(await (await healthGet(new Request('http://localhost/api/health'))).text());
    expect(open).not.toHaveProperty('ivms');
    expect(db.calls).toEqual([]);
    const r1 = await healthGet(req('/api/health'));
    expect(r1.status).toBe(r0.status);
    const body = JSON.parse(await r1.text());
    expect(body.ivms).toMatchObject({
      mode: 'MAP',
      status: 'ok',
      lastError: 'TIMEOUT',
      calls: { map: 12, route: 0, events: 0, admin: 1, total: 13, budget: 100 },
      webhooks: { received: 4, ignored: 1, badTime: 0 },
      skewSec: 3,
      clock: 'UNKNOWN',
      suggestedOffsetMin: null,
    });
    const text = JSON.stringify(body);
    for (const s of [KEY, SECRET, 'provider.example', 'example-co']) expect(text).not.toContain(s);
  });

  it("the Settings status line: the link, the calls, and in TIMES why GPS times are paused with the offset to set", async () => {
    const { gpsStatusText } = await import('@/lib/ivms/status');
    const h = { mode: 'TIMES' as const, status: 'ok' as const, lastOkAgeSec: 40, lastError: null, calls: { map: 30, route: 6, events: 0, admin: 1, total: 37, budget: 100 }, webhooks: { received: 0, ignored: 0, badTime: 0 }, skewSec: 14_395, clock: 'AHEAD' as const, suggestedOffsetMin: -240 };
    expect(gpsStatusText(h)).toEqual({
      text: "Ayun link: working (last answer 40 s ago); 37 of 100 calls today. Ayun's times look about 4 h ahead of RouteIQ's clock: GPS arrival and departure times are paused (nothing is pulled or written). Set the Railway variable AYUN_API_TIME_OFFSET_MIN to -240 and redeploy.",
      warn: true,
    });
    expect(gpsStatusText({ ...h, clock: 'OK', skewSec: 2, suggestedOffsetMin: null })).toEqual({ text: 'Ayun link: working (last answer 40 s ago); 37 of 100 calls today.', warn: false });
    // MAP never pauses anything for the clock.
    expect(gpsStatusText({ ...h, mode: 'MAP' }).warn).toBe(false);
  });

  it('the cron route gains `ivms` once the mode is on (nothing out: no call)', async () => {
    setAyun();
    db.mode = 'MAP';
    const body = JSON.parse(await (await cronGet(req('/api/cron/janitor'))).text());
    expect(body.data.ivms).toEqual({ tick: { mode: 'MAP', skipped: 'NOTHING_OUT' }, retention: null });
  });

  it('merge with the operations alerts (16 Oct 2026): the alert sweep has its own try; its database error never hides the IVMS answer', async () => {
    setAyun();
    db.mode = 'MAP';
    vi.stubEnv('ROUTEIQ_DISABLE_ALERTS', '');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(prisma.tenantConfig.findMany).mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: 'P1001' }));
    const res = await cronGet(req('/api/cron/janitor'));
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.data.alerts).toEqual({ error: 'P1001' });
    expect(body.data.ivms).toEqual({ tick: { mode: 'MAP', skipped: 'NOTHING_OUT' }, retention: null });
    expect(errors).toHaveBeenCalledWith('janitor: alerts failed', 'P1001');
    // Alerts on and nothing wrong: the sweep's report (no company has them on here) beside the IVMS answer.
    _resetIvmsProcessState();
    const ok = JSON.parse(await (await cronGet(req('/api/cron/janitor'))).text());
    expect(ok.data.alerts).toMatchObject({ tenants: 0, failed: 0, raised: 0 });
    expect(ok.data.ivms).toEqual({ tick: { mode: 'MAP', skipped: 'NOTHING_OUT' }, retention: null });
    resetAlertSweepClock();
  });
});

describe('the hooks', () => {
  const src = (f: string) => readFileSync(path.join(WEB, f), 'utf8');
  it('the janitor starts the IVMS timer after its own off switch; the GPS retention has its own try', () => {
    const loop = src('lib/jobs/janitor-loop.ts');
    const start = loop.slice(loop.indexOf('export function startJanitor'));
    expect(start.indexOf("ROUTEIQ_DISABLE_JANITOR === '1'")).toBeLessThan(start.indexOf('startIvmsTimer()'));
    expect(loop).toMatch(/try \{\s+const gps = await runIvmsRetention\(\);[\s\S]*?\} catch \(err\) \{\s+console\.error\('janitor: GPS tracking retention not run'/);
  });

  it('the shutdown stops the IVMS calls; the cron route adds `ivms` only when there is something to say', () => {
    expect(src('lib/jobs/shutdown.ts')).toMatch(/started = true;\s+\/\/[^\n]*\n\s+stopIvms\(\);/);
    expect(src('app/api/cron/janitor/route.ts')).toContain('...(ivms ? { ivms } : {})');
    expect(src('app/api/health/route.ts')).toContain('...(ivms ? { ivms } : {})');
    expect(src('app/api/ivms/ayun/[secret]/route.ts')).toContain("export const dynamic = 'force-dynamic';");
  });
});

describe('the GPS retention', () => {
  const DAY = 24 * 3600_000;
  function fakeDb(configs: Record<string, unknown>[], any = true) {
    const calls: { op: string; where: Record<string, any>; data?: unknown }[] = [];
    const del = (op: string) => ({ deleteMany: async (a: { where: Record<string, unknown> }) => (calls.push({ op, where: a.where }), { count: 1 }) });
    return {
      calls,
      db: {
        $queryRaw: async () => [{ any }],
        tenantConfig: { findMany: async () => configs },
        truckTrailPoint: del('trail'),
        truckPosition: del('positions'),
        ivmsTruckDay: del('days'),
        ivmsEvent: {
          ...del('events'),
          updateMany: async (a: { where: Record<string, unknown>; data: unknown }) => (calls.push({ op: 'erase', where: a.where, data: a.data }), { count: 1 }),
        },
      },
    };
  }
  const now = new Date('2026-10-16T06:00:00Z');
  const cfg = (extra: Record<string, unknown> = {}) => ({ tenantId: 'tA', ivmsMode: 'MAP', ivmsTrailDays: 2, locationRetentionDays: 90, photoRetentionDays: 90, timezone: 'Asia/Muscat', ...extra });

  it('nothing but one EXISTS while no GPS data exists', async () => {
    const f = fakeDb([cfg()], false);
    expect(await purgeIvmsData(now, f.db as never)).toBeNull();
    expect(f.calls).toEqual([]);
  });

  it('trail after ivmsTrailDays; positions a day old (all of them when OFF); event positions erased, rows after the location retention', async () => {
    const f = fakeDb([cfg(), cfg({ tenantId: 'tB', ivmsMode: 'OFF', ivmsTrailDays: 7, locationRetentionDays: 30 })]);
    expect(await purgeIvmsData(now, f.db as never)).toEqual({ trailPoints: 2, positions: 2, eventsErased: 2, eventsDeleted: 2, truckDays: 2 });
    const of = (t: string, op: string) => f.calls.find((c) => c.where.tenantId === t && c.op === op)!;
    expect(of('tA', 'trail').where.fixAt.lt).toEqual(new Date(now.getTime() - 2 * DAY));
    expect(of('tB', 'trail').where.fixAt.lt).toEqual(new Date(now.getTime() - 7 * DAY));
    expect(of('tA', 'positions').where).toEqual({ tenantId: 'tA', receivedAt: { lt: new Date(now.getTime() - DAY) } });
    expect(of('tB', 'positions').where).toEqual({ tenantId: 'tB' });
    expect(of('tA', 'erase')).toMatchObject({ where: { eventAt: { lt: new Date(now.getTime() - 2 * DAY) } }, data: { lat: null, lng: null } });
    expect(of('tA', 'events').where.eventAt.lt).toEqual(new Date(now.getTime() - 90 * DAY));
    expect(of('tB', 'events').where.eventAt.lt).toEqual(new Date(now.getTime() - 30 * DAY));
    expect(of('tA', 'days').where.deliveryDate.lt).toEqual(new Date('2026-07-18T00:00:00Z'));
  });
});

describe('Sentry never sees the webhook secret or the Ayun key', () => {
  const apiUrl = `https://provider.example/api/api.php?api=user&key=${KEY}&cmd=OBJECT_GET_LOCATIONS,1`;
  it('the key in an api.php address or a bare query string; the webhook path secret', () => {
    expect(scrubIvmsSecrets(apiUrl)).toBe('https://provider.example/api/api.php?api=user&key=[redacted]&cmd=OBJECT_GET_LOCATIONS,1');
    expect(scrubIvmsSecrets(`api=user&key=${KEY}&cmd=X`)).toBe('api=user&key=[redacted]&cmd=X');
    expect(scrubIvmsSecrets(`POST /api/ivms/ayun/${SECRET}?imei=1`)).toBe('POST /api/ivms/ayun/[secret]?imei=1');
    expect(scrubDriverToken(`https://routeiq.example/api/ivms/ayun/${SECRET}`)).toBe('https://routeiq.example/api/ivms/ayun/[secret]');
  });

  it('in events, spans and breadcrumbs; the webhook is never traced', () => {
    const ev = scrubSentryEvent({ request: { url: `https://routeiq.example/api/ivms/ayun/${SECRET}` }, spans: [{ data: { 'url.full': apiUrl, 'http.query': `api=user&key=${KEY}&cmd=X` } }] });
    const crumb = scrubBreadcrumb({ category: 'fetch', data: { url: apiUrl } });
    expect(JSON.stringify([ev, crumb])).not.toContain(KEY);
    expect(JSON.stringify([ev, crumb])).not.toContain(SECRET);
    const sampler = driverTracesSampler(0.5);
    expect(sampler({ name: `POST /api/ivms/ayun/${SECRET}` })).toBe(0);
    expect(sampler({ request: { url: `https://routeiq.example/api/ivms/ayun/${SECRET}` } })).toBe(0);
    expect(sampler({ name: 'GET /api/health' })).toBe(0.5);
  });

  it('strings without those markers are unchanged (every existing event as before)', () => {
    for (const s of ['https://maps.example/x?key=abc', 'GET /api/runs/1?key=abc', '/d/abc', '/api/d/manifest', 'monkey=1', 'plain text']) {
      expect(scrubIvmsSecrets(s), s).toBe(s);
    }
    expect(scrubDriverToken('/d/abcdef')).toBe('/d/[token]');
  });
});

describe('the public repo: invented data only', () => {
  it('no run of 10 or more digits in the fake answers, the ingest integration spec or the webhook route, except the vendor dummies', () => {
    const dir = path.join(WEB, 'tests', 'fixtures', 'ivms');
    const files = [...readdirSync(dir).map((f) => path.join(dir, f)), path.join(WEB, 'tests', 'integration', 'ivms-ingest-db.spec.ts'), path.join(WEB, 'app', 'api', 'ivms', 'ayun', '[secret]', 'route.ts')];
    const DUMMIES = new Set(['111111111111111', '222222222222222']);
    const hits = files.flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/(?<![\d.])\d{10,}(?![\d.])/g)].filter((m) => !DUMMIES.has(m[0]) && !/^20\d{12}$/.test(m[0])).map((m) => `${path.basename(f)}: ${m[0]}`),
    );
    expect(hits).toEqual([]);
  });
});
