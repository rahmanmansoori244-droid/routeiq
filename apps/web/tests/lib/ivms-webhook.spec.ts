/**
 * IVMS live link (16 Oct 2026): Ayun's webhook, GET or POST /api/ivms/ayun/<secret> (lib/ivms/webhook.ts,
 * lib/ivms/webhook-auth.ts, app/api/ivms/ayun/[secret]/route.ts), on the in-memory store: never a
 * database, never a real call. Checked:
 * - no secret configured: 404 (the route does not exist); a wrong secret: 404, counted per public IP, 429
 *   over the limit; the previous secret is still accepted during a rotation;
 * - the kill switch and ivmsMode OFF: 200 and nothing written, not even a counter;
 * - GET, POST with the query string, urlencoded, multipart and JSON bodies; at most 16 KB;
 * - only zone_in / zone_out of an IMEI mapped to the company's own trucks is stored, as a depot move when
 *   the zone is a depot's (and the position near it); anything else is counted and dropped;
 * - the same event twice is one row; at most 200 rows per truck per day; 300 calls a minute per company;
 * - the fields RouteIQ never reads (user name, object name, driver, plate, SIM, VIN, ...) never reach the
 *   store, and nothing of the call is ever logged.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '@/lib/rate-limit';
import { _resetWebhookCache, handleAyunWebhook, WEBHOOK_MAX_BYTES } from '@/lib/ivms/webhook';
import { ivmsWebhookAuthorized } from '@/lib/ivms/webhook-auth';
import { MAX_EVENTS_PER_TRUCK_DAY } from '@/lib/ivms/events';
import { GET as routeGet, POST as routePost } from '@/app/api/ivms/ayun/[secret]/route';
import { company, IMEI_A, IMEI_B, ivmsTestEnv, MemoryIvmsStore, SECRET } from './ivms-fakes';

const NOW = new Date('2026-10-16T06:05:00Z');
const QUERY = readFileSync(path.resolve(__dirname, '../fixtures/ivms/webhook-depot-in.txt'), 'utf8');
const PUBLIC_IP = '203.0.113.7';
const ENV = ivmsTestEnv();
const NEVER_READ = ['example_user', 'Example object', 'Example driver', '0001 EX', 'EXAMPLEVIN', 'username', 'driver', 'plate', 'sim', 'odometer', 'eng_hours'];

let logs: string[] = [];
beforeEach(() => {
  _resetWebhookCache();
  logs = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function setup(mode: 'OFF' | 'MAP' | 'TIMES' = 'MAP') {
  const store = new MemoryIvmsStore(company({ mode }));
  store.fleetOf = () => [{ truckId: 't1', imei: IMEI_A, depotId: 'd1', days: [] }];
  store.depots = [{ depotId: 'd1', zoneName: 'Example depot zone', lat: 10.5, lng: 20.5 }];
  const limiter = new RateLimiter({ now: () => NOW.getTime() });
  const call = (req: Request, secret: string = SECRET, env = ENV, now = NOW) => handleAyunWebhook(req, secret, { env, store, now, limiter });
  return { store, limiter, call };
}
const url = (q = QUERY, secret = SECRET) => `https://routeiq.example/api/ivms/ayun/${secret}${q ? `?${q}` : ''}`;
const get = (q = QUERY, headers: Record<string, string> = {}) => new Request(url(q), { method: 'GET', headers: { 'x-forwarded-for': PUBLIC_IP, ...headers } });
const post = (body: BodyInit | null, type: string | null, q = '', headers: Record<string, string> = {}) =>
  new Request(url(q), { method: 'POST', body, headers: { 'x-forwarded-for': PUBLIC_IP, ...(type ? { 'content-type': type } : {}), ...headers } });

describe('authentication (the secret in the path)', () => {
  it('constant-time against the current and the previous secret; a wrong, short or odd one is refused', () => {
    expect(ivmsWebhookAuthorized(SECRET, ENV)).toBe(true);
    const rotated = ivmsTestEnv({ AYUN_WEBHOOK_SECRET: 'N'.repeat(40), AYUN_WEBHOOK_SECRET_PREVIOUS: SECRET });
    expect(ivmsWebhookAuthorized(SECRET, rotated)).toBe(true);
    expect(ivmsWebhookAuthorized('N'.repeat(40), rotated)).toBe(true);
    for (const s of [`${SECRET}x`, SECRET.slice(0, -1), '', 'x'.repeat(300), undefined, 42]) expect(ivmsWebhookAuthorized(s, ENV), String(s)).toBe(false);
    expect(ivmsWebhookAuthorized(SECRET, ivmsTestEnv({ AYUN_WEBHOOK_SECRET: undefined }))).toBe(false);
  });

  it('no secret configured: 404, nothing read', async () => {
    const { store, call } = setup();
    const res = await call(get(), SECRET, ivmsTestEnv({ AYUN_WEBHOOK_SECRET: undefined }));
    expect(res.status).toBe(404);
    expect(store.touched).toEqual([]);
  });

  it('a wrong secret: 404 and nothing read; the 21st from one public IP in 10 min is 429; an internal IP is never counted', async () => {
    const { store, call } = setup();
    for (let i = 0; i < 20; i++) expect((await call(get(), 'W'.repeat(40))).status).toBe(404);
    const over = await call(get(), 'W'.repeat(40));
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another IP, and an internal one (a proxy: never a shared bucket), are unaffected.
    expect((await call(get(QUERY, { 'x-forwarded-for': '198.51.100.9' }), 'W'.repeat(40))).status).toBe(404);
    for (let i = 0; i < 30; i++) expect((await call(get(QUERY, { 'x-forwarded-for': '10.0.0.5' }), 'W'.repeat(40))).status).toBe(404);
    expect(store.touched).toEqual([]);
    // The right secret from the throttled IP still works (only wrong secrets are throttled).
    expect((await call(get())).status).toBe(200);
  });
});

describe('the kill switch and OFF: answered, nothing written', () => {
  it('ROUTEIQ_DISABLE_IVMS=1: 200 without reading the company or writing a counter', async () => {
    const { store, call } = setup();
    const res = await call(get(), SECRET, ivmsTestEnv({ ROUTEIQ_DISABLE_IVMS: '1' }));
    expect([res.status, await res.text()]).toEqual([200, 'ok']);
    expect(store.touched).toEqual([]);
  });

  it('ivmsMode OFF: 200, the company read once, no counter, no row', async () => {
    const { store, call } = setup('OFF');
    expect((await call(get())).status).toBe(200);
    expect(store.touched).toEqual(['company']);
    expect(store.state).toBeNull();
    expect(store.events).toEqual([]);
  });

  it('through the route: 404 while not configured, 404 for a wrong secret, 200 with the kill switch - no database involved', async () => {
    const ctx = (secret: string) => ({ params: { secret } });
    vi.stubEnv('AYUN_WEBHOOK_SECRET', '');
    expect((await routeGet(get(), ctx(SECRET))).status).toBe(404);
    vi.stubEnv('AYUN_WEBHOOK_SECRET', SECRET);
    vi.stubEnv('AYUN_TENANT_SLUG', 'example-co');
    expect((await routePost(post(null, null), ctx('W'.repeat(40)))).status).toBe(404);
    vi.stubEnv('ROUTEIQ_DISABLE_IVMS', '1');
    expect((await routePost(post(QUERY, 'application/x-www-form-urlencoded'), ctx(SECRET))).status).toBe(200);
  });
});

describe('storing a depot move', () => {
  it('GET with the query string: one DEPOT_IN row of the company\'s truck, unprocessed; the fields never read never reach the store', async () => {
    const { store, call } = setup();
    const res = await call(get());
    expect([res.status, await res.text(), res.headers.get('cache-control')]).toEqual([200, 'ok', 'no-store']);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      tenantId: 'tA',
      truckId: 't1',
      depotId: 'd1',
      kind: 'DEPOT_IN',
      origin: 'WEBHOOK',
      eventAt: new Date('2026-10-16T06:00:00Z'),
      serverAt: new Date('2026-10-16T06:00:20Z'),
      zoneName: 'Example depot zone',
      outcome: null,
      processedAt: null,
    });
    expect(store.events[0]!.dedupeKey).toMatch(/^ayun:[0-9a-f]{32}$/);
    const stored = JSON.stringify(store.events);
    for (const w of NEVER_READ) expect(stored, w).not.toContain(w);
    expect(store.state?.webhooksToday).toBe(1);
    expect(logs).toEqual([]);
  });

  it('POST: query string only (the provider\'s code), urlencoded, multipart and JSON bodies; the body wins over the query', async () => {
    const bodies: [BodyInit, string | null, string][] = [
      [QUERY, 'application/x-www-form-urlencoded', ''],
      ['', 'application/x-www-form-urlencoded', QUERY],
      [JSON.stringify(Object.fromEntries(new URLSearchParams(QUERY))), 'application/json', ''],
    ];
    for (const [body, type, q] of bodies) {
      const { store, call } = setup();
      expect((await call(post(body, type, q))).status).toBe(200);
      expect(store.events.map((e) => e.kind), String(type)).toEqual(['DEPOT_IN']);
    }
    const form = new FormData();
    for (const [k, v] of new URLSearchParams(QUERY)) form.append(k, v);
    const multi = setup();
    const req = new Request(url(''), { method: 'POST', body: form, headers: { 'x-forwarded-for': PUBLIC_IP } });
    expect((await multi.call(req)).status).toBe(200);
    expect(multi.store.events.map((e) => e.kind)).toEqual(['DEPOT_IN']);
    const over = setup();
    const out = new URLSearchParams(QUERY);
    out.set('type', 'zone_out');
    await over.call(post(out.toString(), 'application/x-www-form-urlencoded', QUERY));
    expect(over.store.events.map((e) => e.kind)).toEqual(['DEPOT_OUT']);
  });

  it('the same event twice is one row (the backstop gives the same key); another zone is a fact, not a depot move', async () => {
    const { store, call } = setup();
    await call(get());
    await call(post(QUERY, 'application/x-www-form-urlencoded'));
    expect(store.events).toHaveLength(1);
    expect(store.state?.webhooksToday).toBe(2);
    const other = new URLSearchParams(QUERY);
    other.set('zone_name', 'Example fuel zone');
    other.set('desc', 'Fuel IN (Example fuel zone)');
    await call(get(other.toString()));
    expect(store.events[1]).toMatchObject({ kind: 'ZONE_IN', depotId: null, outcome: 'NO_DEPOT' });
    // The depot's zone, but reported 2+ km from the depot pin: not trusted as a depot move.
    const far = new URLSearchParams(QUERY);
    far.set('lat', '10.6');
    far.set('dt_tracker', '2026-10-16 06:01:00');
    await call(get(far.toString()));
    expect(store.events[2]).toMatchObject({ kind: 'ZONE_IN', depotId: null, outcome: 'NO_DEPOT' });
  });
});

describe('what is not stored', () => {
  it('an IMEI that is not one of the company\'s trucks: 200, counted, no row', async () => {
    const { store, call } = setup();
    const q = new URLSearchParams(QUERY);
    q.set('imei', IMEI_B);
    expect((await call(get(q.toString()))).status).toBe(200);
    expect(store.events).toEqual([]);
    expect(store.state).toMatchObject({ webhooksIgnored: 1, webhooksToday: 0 });
  });

  it('other event types and a bad IMEI are ignored; a time outside [now - 26 h, now + 2 min] is counted apart (a wrong offset)', async () => {
    const { store, call } = setup();
    for (const [k, v] of [
      ['type', 'stopped'],
      ['type', 'overspeed'],
      ['imei', '12345'],
    ]) {
      const q = new URLSearchParams(QUERY);
      q.set(k!, v!);
      expect((await call(get(q.toString()))).status).toBe(200);
    }
    const local = new URLSearchParams(QUERY);
    local.set('dt_tracker', '2026-10-16 10:00:00'); // Muscat local time, no offset set
    await call(get(local.toString()));
    expect(store.events).toEqual([]);
    expect(store.state).toMatchObject({ webhooksIgnored: 3, webhooksBadTime: 1 });
    // With AYUN_WEBHOOK_TIME_OFFSET_MIN=-240 the same call is stored at 06:00 UTC.
    await call(get(local.toString()), SECRET, ivmsTestEnv({ AYUN_WEBHOOK_TIME_OFFSET_MIN: '-240' }));
    expect(store.events.map((e) => e.eventAt.toISOString())).toEqual(['2026-10-16T06:00:00.000Z']);
  });

  it('a body over 16 KB: 413, whatever the headers say', async () => {
    const { store, call } = setup();
    const big = `${QUERY}&pad=${'x'.repeat(WEBHOOK_MAX_BYTES)}`;
    expect((await call(post(big, 'application/x-www-form-urlencoded'))).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const chunked = new Request(url(''), { method: 'POST', body: stream, headers: { 'content-type': 'application/x-www-form-urlencoded' }, duplex: 'half' } as RequestInit);
    expect((await call(chunked)).status).toBe(413);
    expect(store.events).toEqual([]);
  });

  it('at most 200 rows per truck per day (a flood of forged moves, M6), and 300 calls a minute per company (429)', async () => {
    const { store, call } = setup();
    for (let i = 0; i < MAX_EVENTS_PER_TRUCK_DAY + 5; i++) {
      const q = new URLSearchParams(QUERY);
      q.set('dt_tracker', new Date(NOW.getTime() - (i + 1) * 60_000).toISOString().replace('T', ' ').slice(0, 19));
      await call(get(q.toString()));
    }
    expect(store.events).toHaveLength(MAX_EVENTS_PER_TRUCK_DAY);
    expect(store.state?.webhooksIgnored).toBe(5);
    let last = 0;
    for (let i = 0; i < 100; i++) last = (await call(get())).status;
    expect(last).toBe(429);
  });

  it('a database failure: 503, and only an error code in the log (never the call)', async () => {
    const { store, call } = setup();
    store.insertZoneEvents = async () => {
      throw Object.assign(new Error(`insert failed for ${IMEI_A} ${QUERY}`), { code: 'P1001' });
    };
    expect((await call(get())).status).toBe(503);
    expect(logs).toEqual(['ivms webhook: not stored P1001']);
  });

  it('the mode is read at most every 30 s: switched OFF, calls stop being stored within 30 s', async () => {
    const { store, call } = setup();
    await call(get());
    store.companyRow = company({ mode: 'OFF' });
    const q = new URLSearchParams(QUERY);
    q.set('dt_tracker', '2026-10-16 06:01:00');
    await call(get(q.toString()), SECRET, ENV, new Date(NOW.getTime() + 10_000));
    q.set('dt_tracker', '2026-10-16 06:02:00');
    await call(get(q.toString()), SECRET, ENV, new Date(NOW.getTime() + 31_000));
    expect(store.events).toHaveLength(2);
  });
});
