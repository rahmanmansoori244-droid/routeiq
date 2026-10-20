/**
 * The salesman link through its route handlers (owner request 19 Oct 2026) on the in-memory database
 * (fake-plan-db.ts) with a real rate limiter. The plan detail and its facts are fixtures (sales-day-fixture.ts);
 * everything else - the link rows, the orders, the visits - is read through the fake database as on the server.
 * Synthetic data only: "Example Water Co", trucks T05, customers TST0001.., routes R1 / R2X.
 *
 *  - the guard: the token only in the header; 404 for a bad shape or an unknown token, counted against a public
 *    IP only (the 31st from one IP gets 429 with Retry-After; an internal IP is never counted); 410 replaced,
 *    turned off, expired; 503 without a secret; 403 signed in to another company; the office's own session is
 *    never counted as a salesman's phone; no-store, no-referrer, noindex on every answer;
 *  - the limits (critique item 9): per link AND client IP, never the page's device id (rotating it changes
 *    nothing), never the whole link (one holder cannot lock the group out); route codes with no deliveries;
 *  - the answer: meta without a route, the route's customers with one (owner feedback of 20 Oct 2026: one status
 *    and one time each, no truck, trip, window, reason, invoice or customer code), 400 for an empty or too long
 *    code, the same answer for an unknown code and a code with nothing that day, nothing of another company, no
 *    private keys; one build of the day for many requests (memo and single flight); the phone and route recorded;
 *  - a truck code (owner decision of 20 Oct 2026): the truck's deliveries of the day, every route ("t05", "T-05",
 *    "Truck T05", Arabic-Indic digits), recorded as "T:T05"; a route and a truck at once; an unknown truck counted
 *    as a miss; several trucks with the digits offered, a route code that is also a truck's (the route shown, the
 *    truck offered in its place); choices never counted; two trucks sharing a compact key (AB-1, AB.1): the exact
 *    code shows one, the compact key offers both, and what the page then follows is answered (at most 5 codes);
 *  - the office: VIEWER 403; PLANNER makes the link (201, then 200, one audit row, never the token, its hash or
 *    the salt in it); only today or tomorrow; "Make a new link" (the old one answers replaced) and "Turn off"
 *    (idempotent); another company's link 404.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, rawLog, rawValues, resetDb, tables } from './fake-plan-db';
import { factsOf, hm, ln, load, planDetail, stop } from './sales-day-fixture';
import type { PlanDetail } from '@/lib/dispatch/plan-detail';
import type { SalesmanEtaFacts } from '@/lib/exports/salesman-eta';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', () => ({
  audit: vi.fn(async (input: Record<string, unknown>, tx?: typeof fakePrisma) => (tx ?? fakePrisma).auditLog.create({ data: { ...input } })),
}));
const { session, world } = vi.hoisted(() => ({
  session: { value: null as null | { user: { id: string; name: string; email: string; role: string; tenantId: string } } },
  world: { details: new Map<string, unknown>(), facts: new Map<string, unknown>() },
}));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => session.value) }));
vi.mock('@/lib/rate-limit', async (orig) => {
  const m = await orig<typeof import('@/lib/rate-limit')>();
  return { ...m, limiter: new m.RateLimiter() };
});
vi.mock('@/lib/driver-link/manifest', () => ({ memoPlanDetail: vi.fn(async (_t: string, runId: string) => world.details.get(runId) ?? null) }));
vi.mock('@/lib/exports/salesman-eta', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/salesman-eta')>()),
  loadSalesmanEtaFacts: vi.fn(async (_db: unknown, _t: string, d: { run: { id: string } }) => world.facts.get(d.run.id)),
}));

import { GET as viewGET } from '@/app/api/s/view/route';
import { GET as linksGET, POST as linksPOST } from '@/app/api/dispatch/sales-links/route';
import { PATCH as linkPATCH } from '@/app/api/dispatch/sales-links/[id]/route';
import { deriveToken, salesLinkExpiry, salesLinkKey, tokenHash } from '@/lib/sales-link/token';
import { _resetSalesDayMemo, salesDayBuilds } from '@/lib/sales-link/day-read';
import { addDaysIso, dateOnly, todayIso } from '@/lib/dispatch/time';
import type { SalesViewAnswer } from '@/lib/sales-link/view-types';
import { MAX_CODES, parseRouteQuery } from '@/lib/sales-link/route-code';
import { followQuery } from '@/lib/sales-page/format';

const TZ = 'Asia/Muscat';
const D = todayIso(TZ);
const SECRET = 'sales-link-routes-test-secret';
let prevSecret: string | undefined;
let prevSales: string | undefined;
// The link's address prefers AUTH_URL / NEXTAUTH_URL over the request's origin (driverLinkBaseUrl), and CI sets
// NEXTAUTH_URL for the whole job: the suite runs without them, as a server with neither (review of 19 Oct 2026).
const URL_VARS = ['AUTH_URL', 'NEXTAUTH_URL'] as const;
const prevUrls: Partial<Record<(typeof URL_VARS)[number], string>> = {};
const BASE = 'https://routeiq.example';

beforeAll(() => {
  prevSecret = process.env.NEXTAUTH_SECRET;
  prevSales = process.env.SALES_LINK_SECRET;
  process.env.NEXTAUTH_SECRET = SECRET;
  delete process.env.SALES_LINK_SECRET;
  for (const k of URL_VARS) {
    prevUrls[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = prevSecret;
  if (prevSales === undefined) delete process.env.SALES_LINK_SECRET;
  else process.env.SALES_LINK_SECRET = prevSales;
  for (const k of URL_VARS) {
    if (prevUrls[k] === undefined) delete process.env[k];
    else process.env[k] = prevUrls[k];
  }
});

let seq = 0;
/** A link row for tenant A's date D and its token (derived as the service does). */
function makeLink(over: Record<string, unknown> = {}): string {
  const key = salesLinkKey()!;
  const id = `sl${String(++seq).padStart(24, '0')}`;
  const salt = `salt${seq}`;
  const token = deriveToken(key.key, id, 1, salt);
  tables.salesLink!.push({
    id,
    tenantId: 'tA',
    deliveryDate: dateOnly(D),
    generation: 1,
    salt,
    keyId: key.keyId,
    tokenHash: tokenHash(token),
    prevTokenHash: null,
    expiresAt: salesLinkExpiry(D, TZ),
    issuedAt: new Date(),
    issuedById: null,
    revokedAt: null,
    revokedById: null,
    lastSeenAt: null,
    devicesJson: null,
    routesJson: null,
    ...over,
  });
  return token;
}

function seed() {
  resetDb();
  _resetSalesDayMemo();
  session.value = null;
  tables.tenant = [
    { id: 'tA', name: 'Example Water Co', active: true },
    { id: 'tB', name: 'Other Example Co', active: true },
  ];
  tables.tenantConfig = [
    { id: 'cfgA', tenantId: 'tA', timezone: TZ, ivmsMode: 'OFF' },
    { id: 'cfgB', tenantId: 'tB', timezone: TZ, ivmsMode: 'OFF' },
  ];
  tables.salesLink = [];
  tables.runPlan = [
    { id: 'run-A', tenantId: 'tA', depotId: 'D1', runDate: dateOnly(D), status: 'READY', version: 1, supersededAt: null, chosenScenarioId: 'sc', createdAt: new Date() },
    { id: 'run-B', tenantId: 'tB', depotId: 'DB', runDate: dateOnly(D), status: 'READY', version: 1, supersededAt: null, chosenScenarioId: 'sc', createdAt: new Date() },
  ];
  tables.planLoad = [{ id: 'L1', tenantId: 'tA', runId: 'run-A', statusChangedAt: null }];
  const lines = [ln('o1', 'o1-l1', 'INV-1', 20, 'R1'), ln('o1', 'o1-l2', 'INV-1', 10, 'R2X'), ln('o2', 'o2-l1', 'INV-2', 12, 'R1')];
  const l1 = load({
    id: 'L1',
    status: 'LOCKED',
    departMin: hm(23, 30),
    returnMin: hm(23, 59),
    stops: [stop({ seq: 1, customerId: 'c1', code: 'TST0001', eta: hm(23, 40), lines: [lines[0]!, lines[1]!] }), stop({ seq: 2, customerId: 'c2', code: 'TST0002', eta: hm(23, 50), lines: [lines[2]!] })],
  });
  const detailA: PlanDetail = { ...planDetail({ loads: [l1], date: D, runId: 'run-A' }) };
  const otherLoad = load({ id: 'LB', status: 'LOCKED', stops: [stop({ seq: 1, customerId: 'cb', code: 'TSTB01', name: 'Other company shop', eta: hm(8), lines: [ln('ob', 'ob-l1', 'INV-B', 5, 'R1')] })] });
  world.details = new Map<string, unknown>([
    ['run-A', detailA],
    ['run-B', planDetail({ loads: [otherLoad], date: D, runId: 'run-B', depotId: 'DB' })],
  ]);
  world.facts = new Map<string, SalesmanEtaFacts>([
    ['run-A', factsOf(lines)],
    ['run-B', factsOf([ln('ob', 'ob-l1', 'INV-B', 5, 'R1')])],
  ]);
  // A cancelled order of each company on the day (route R1).
  tables.order = [
    { id: 'oc', tenantId: 'tA', depotId: 'D1', deliveryDate: dateOnly(D), cancelledAt: new Date(), cancelReason: 'CUSTOMER_CANCELLED', cancelNote: 'OFFICE-NOTE-SENTINEL', carriedFromDate: null, carriedToOrderId: null, carriedFromOrderId: null, carriedTo: null, customer: { code: 'TST0009', branchCode: null, name: 'Example Mart TST0009' }, lines: [{ id: 'oc-l1', salesRoute: 'R1', salesOrderNo: 'INV-9', cases: 3 }] },
    { id: 'ocb', tenantId: 'tB', depotId: 'DB', deliveryDate: dateOnly(D), cancelledAt: new Date(), cancelReason: 'OTHER', carriedFromDate: null, carriedToOrderId: null, carriedFromOrderId: null, carriedTo: null, customer: { code: 'TSTB09', branchCode: null, name: 'Other company cancelled' }, lines: [{ id: 'ocb-l1', salesRoute: 'R1', salesOrderNo: 'INV-B9', cases: 1 }] },
  ];
  tables.stopVisit = [];
  tables.deliveryPhoto = [];
  tables.stopEvent = [];
}

let ipSeq = 0;
/** A fresh public test address per test (the limiter is shared by the file). */
const freshIp = () => `198.51.100.${(++ipSeq % 250) + 1}`;

function view(token: string | null, o: { route?: string; ip?: string; device?: string; auth?: string } = {}) {
  const url = new URL(`${BASE}/api/s/view`);
  if (o.route !== undefined) url.searchParams.set('route', o.route);
  const headers: Record<string, string> = { 'x-forwarded-for': o.ip ?? freshIp() };
  if (token !== null) headers.authorization = o.auth ?? `SalesLink ${token}`;
  if (o.device) headers['x-sales-device'] = o.device;
  return viewGET(new Request(url, { headers }));
}

const body = async (r: Response) => (await r.json()) as { data: SalesViewAnswer | null; error: { code: string; message: string; date?: string } | null };

beforeEach(seed);

describe('the guard', () => {
  it('a bad shape and an unknown token: 404 LINK_NOT_FOUND; counted per public IP (the 31st gets 429 with Retry-After)', async () => {
    const ip = freshIp();
    const r1 = await view('short', { ip });
    expect(r1.status).toBe(404);
    expect((await body(r1)).error!.code).toBe('LINK_NOT_FOUND');
    for (let i = 0; i < 29; i++) expect((await view('A'.repeat(24), { ip })).status).toBe(404);
    const r31 = await view('B'.repeat(24), { ip });
    expect(r31.status).toBe(429);
    expect(Number(r31.headers.get('retry-after'))).toBeGreaterThan(0);
    // A good token from that IP still passes: a token that resolves is never IP-throttled.
    expect((await view(makeLink(), { ip })).status).toBe(200);
    // An internal (proxy) address is never counted.
    for (let i = 0; i < 40; i++) expect((await view('C'.repeat(24), { ip: '10.0.0.7' })).status).toBe(404);
    // No token in the header: 404 too, no database work needed.
    expect((await view(null)).status).toBe(404);
    expect((await view('x', { auth: 'DriverLink ' + 'A'.repeat(24) })).status).toBe(404);
  });

  it('410 replaced, turned off, expired (with the date); 503 without a secret', async () => {
    const key = salesLinkKey()!;
    const old = deriveToken(key.key, 'slold', 1, 'oldsalt');
    makeLink({ id: 'slold', generation: 2, salt: 'new', tokenHash: tokenHash(deriveToken(key.key, 'slold', 2, 'new')), prevTokenHash: tokenHash(old) });
    const replaced = await body(await view(old));
    expect(replaced.error).toMatchObject({ code: 'LINK_REPLACED', date: D });
    const revoked = makeLink({ revokedAt: new Date(), deliveryDate: dateOnly(addDaysIso(D, 1)) });
    expect((await body(await view(revoked))).error!.code).toBe('LINK_REVOKED');
    const expired = makeLink({ expiresAt: new Date(Date.now() - 1000), deliveryDate: dateOnly(addDaysIso(D, -1)) });
    const e = await view(expired);
    expect(e.status).toBe(410);
    expect((await body(e)).error).toMatchObject({ code: 'LINK_EXPIRED', date: addDaysIso(D, -1), message: "This link has expired. Ask the office for today's link." });
    const rotated = makeLink({ keyId: 'deadbeef', deliveryDate: dateOnly('2026-01-01') });
    expect((await body(await view(rotated))).error!.code).toBe('LINK_REPLACED');
    const token = makeLink({ deliveryDate: dateOnly('2026-01-02') });
    const saved = process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    try {
      const off = await view(token);
      expect(off.status).toBe(503);
      expect((await body(off)).error!.code).toBe('SALES_LINKS_OFF');
    } finally {
      process.env.NEXTAUTH_SECRET = saved;
    }
  });

  it("another company's session: 403; the link's company's own session is the office: never counted", async () => {
    const token = makeLink();
    session.value = { user: { id: 'uB', name: 'B', email: 'b@b.example', role: 'PLANNER', tenantId: 'tB' } };
    const r = await view(token);
    expect(r.status).toBe(403);
    expect((await body(r)).error!.code).toBe('SIGNED_IN_OTHER_TENANT');
    session.value = { user: { id: 'uA', name: 'A', email: 'a@a.example', role: 'VIEWER', tenantId: 'tA' } };
    rawLog.length = 0;
    expect((await view(token, { device: 'a'.repeat(32), route: 'R1' })).status).toBe(200);
    expect(rawLog.filter((s) => s.includes('"SalesLink"'))).toEqual([]);
    expect(tables.salesLink![0]!.lastSeenAt).toBeNull();
  });

  it('every answer: no-store, no-referrer, noindex', async () => {
    for (const r of [await view(makeLink()), await view('A'.repeat(24))]) {
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
      expect(r.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
    }
  });
});

describe('the limits: per link and client IP (critique item 9)', () => {
  it('rotating the device id changes nothing; another IP is not locked out; no limit for the whole link', async () => {
    const token = makeLink();
    const ip = freshIp();
    for (let i = 0; i < 240; i++) expect((await view(token, { ip, device: i.toString(16).padStart(32, '0') })).status).toBe(200);
    const over = await view(token, { ip, device: 'f'.repeat(32) });
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    // The other salesmen (another address) still see the page.
    expect((await view(token, { ip: freshIp() })).status).toBe(200);
  });

  it('route codes with no deliveries: 40 per link and IP, then 429; codes that are found are not counted', async () => {
    const token = makeLink();
    const ip = freshIp();
    for (let i = 0; i < 40; i++) {
      const r = await body(await view(token, { ip, route: `ZZ${i}` }));
      expect(r.data!.lookup!.notFound).toEqual([`ZZ${i}`]);
    }
    expect((await view(token, { ip, route: 'ZZ99' })).status).toBe(429);
    expect((await view(token, { ip: freshIp(), route: 'ZZ99' })).status).toBe(200);
  });
});

describe('the answer', () => {
  it("without a route: the day's header only; the phone is recorded once (atomic append), never the office", async () => {
    const token = makeLink();
    rawLog.length = 0;
    const r = await body(await view(token, { device: 'ab'.repeat(16) }));
    expect(r.error).toBeNull();
    expect(r.data!.lookup).toBeNull();
    expect(r.data!.meta).toMatchObject({ date: D, company: 'Example Water Co', tz: TZ, refreshSec: 60 });
    // Language-neutral: the page says the day and the link's end itself, in English, Arabic or Urdu.
    expect(Object.keys(r.data!.meta).sort()).toEqual(['company', 'date', 'expiresAt', 'refreshSec', 'serverNow', 'tz']);
    const touch = rawLog.filter((s) => s.includes('UPDATE "SalesLink"'));
    expect(touch).toHaveLength(1);
    expect(touch[0]).toContain('"devicesJson" = COALESCE("devicesJson", \'[]\'::jsonb) || jsonb_build_array(?::text)');
    expect(touch[0]).toContain('NOT (COALESCE("devicesJson", \'[]\'::jsonb) @> jsonb_build_array(?::text))');
  });

  it("a route: its customers, one status each (the cancelled order too); nothing of another company; the route found is recorded", async () => {
    const token = makeLink();
    rawLog.length = 0;
    const r = await body(await view(token, { route: ' r1 ' }));
    const lookup = r.data!.lookup!;
    expect(lookup.asked).toEqual(['R1']);
    expect(lookup.notFound).toEqual([]);
    const v = lookup.results[0]!;
    expect(v).toMatchObject({ kind: 'ROUTE', code: 'R1', query: 'R1' });
    expect(v.updated).toMatch(/^\d{2}:\d{2}$/);
    expect(v.rows.map((d) => `${d.key} ${d.customer} ${d.status}`)).toEqual(['d1 Example Mart TST0001 ON_THE_WAY', 'd2 Example Mart TST0002 ON_THE_WAY', 'o1 Example Mart TST0009 CANCELLED']);
    for (const d of v.rows.slice(0, 2)) expect(d.eta).toMatch(/^\d{2}:\d{2}( \+1)?$/);
    const text = JSON.stringify(r);
    for (const s of ['TSTB', 'Other company', 'INV-', 'OFFICE-NOTE-SENTINEL', 'DRIVER-NAME-SENTINEL', 'CUSTOMER-PHONE-SENTINEL', 'CUSTOMER_CANCELLED', 'T05', 'Trip']) expect(text).not.toContain(s);
    expect(rawLog.some((s) => s.includes('"routesJson" = COALESCE("routesJson"'))).toBe(true);
    // Two routes at once ("R1, R2X"), and an unknown code next to them.
    const both = await body(await view(token, { route: 'R2X, r1, R9' }));
    expect(both.data!.lookup!.results.map((x) => x.code)).toEqual(['R1', 'R2X']);
    expect(both.data!.lookup!.notFound).toEqual(['R9']);
    expect(Object.keys(both.data!.lookup!).sort()).toEqual(['ambiguous', 'asked', 'choices', 'notFound', 'results']);
  });

  it('an unknown code and "Route not given": the same answer as a code with nothing that day', async () => {
    const token = makeLink();
    const a = (await body(await view(token, { route: 'R77' }))).data!.lookup!;
    const b = (await body(await view(token, { route: 'Route not given' }))).data!.lookup!;
    expect(a.results).toEqual([]);
    expect(b.results).toEqual([]);
    expect([a.notFound, b.notFound]).toEqual([['R77'], ['ROUTE NOT GIVEN']]);
  });

  it('a truck code (owner decision of 20 Oct 2026): the customers of the truck that day, every route - nothing of the truck but the code typed; recorded as "T:<code>"', async () => {
    const token = makeLink();
    rawLog.length = 0;
    rawValues.length = 0;
    for (const typed of ['t05', 'T-05', 'Truck T05', '٠٥']) {
      const l = (await body(await view(token, { route: typed }))).data!.lookup!;
      expect(l.notFound).toEqual([]);
      expect(l.results.map((x) => `${x.kind} ${x.code} ${x.query}`)).toEqual(['TRUCK T05 Truck T05']);
      const t = l.results[0]!;
      // Every stop of the truck (one row for the stop with R1 and R2X lines); the cancelled order is not the truck's.
      expect(t.rows.map((d) => `${d.customer} ${d.status}`)).toEqual(['Example Mart TST0001 ON_THE_WAY', 'Example Mart TST0002 ON_THE_WAY']);
      // No trip, route, invoice or truck card; nothing of the other company (its truck has the same code).
      expect(JSON.stringify(t.rows)).not.toMatch(/T05|R2X|INV-|loadNo|trip/i);
      expect(JSON.stringify(l)).not.toMatch(/TSTB|Other company|INV-B/);
    }
    expect(rawValues.some((v) => v.includes('T:T05'))).toBe(true);
    // A route and a truck at once; an unknown code counts against the limit like an unknown route.
    const mixed = (await body(await view(token, { route: 'T05, r2x, 9999' }))).data!.lookup!;
    expect(mixed.results.map((x) => `${x.kind} ${x.code}`)).toEqual(['ROUTE R2X', 'TRUCK T05']);
    expect(mixed.notFound).toEqual(['9999']);
    const unknownTruck = (await body(await view(token, { route: 'Truck 9999' }))).data!.lookup!;
    expect(unknownTruck).toMatchObject({ results: [], notFound: ['TRUCK 9999'] });
  });

  it('several trucks with the digits typed: offered, none shown; a route code that is also a truck code: the route, the truck offered', async () => {
    const base = [ln('o1', 'o1-l1', 'INV-1', 20, 'R1'), ln('o1', 'o1-l2', 'INV-1', 10, 'R2X'), ln('o2', 'o2-l1', 'INV-2', 12, 'R1')];
    const more = [ln('o5', 'o5-l1', 'INV-5', 4, 'R1'), ln('o6', 'o6-l1', 'INV-6', 6, null), ln('o7', 'o7-l1', 'INV-7', 3, 'R2X')];
    const d = world.details.get('run-A') as PlanDetail;
    const late = { status: 'LOCKED', departMin: hm(23, 30), returnMin: hm(23, 59) };
    d.loads.push(
      load({ ...late, id: 'L5', truckId: 't6', truckCode: '1234-AB', stops: [stop({ seq: 1, customerId: 'c5', code: 'TST0005', eta: hm(23, 40), lines: [more[0]!] })] }),
      load({ ...late, id: 'L6', truckId: 't7', truckCode: '1234-CD', stops: [stop({ seq: 1, customerId: 'c6', code: 'TST0006', eta: hm(23, 45), lines: [more[1]!] })] }),
      load({ ...late, id: 'L7', truckId: 't8', truckCode: 'R-1', stops: [stop({ seq: 1, customerId: 'c7', code: 'TST0007', eta: hm(23, 50), lines: [more[2]!] })] }),
    );
    world.facts.set('run-A', factsOf([...base, ...more]));
    const token = makeLink();
    const ip = freshIp();
    const several = (await body(await view(token, { ip, route: '1234' }))).data!.lookup!;
    expect(several).toMatchObject({ results: [], notFound: [] });
    expect(several.choices).toEqual([
      {
        asked: '1234',
        kind: 'SEVERAL_TRUCKS',
        options: [
          { code: '1234-AB', query: 'Truck 1234-AB' },
          { code: '1234-CD', query: 'Truck 1234-CD' },
        ],
      },
    ]);
    // A truck picked: its deliveries, also a line without a route.
    const picked = (await body(await view(token, { ip, route: 'Truck 1234-CD' }))).data!.lookup!;
    expect(picked.results.map((x) => `${x.kind} ${x.code}`)).toEqual(['TRUCK 1234-CD']);
    expect(picked.results[0]!.rows.map((x) => `${x.customer} ${x.status}`)).toEqual(['Example Mart TST0006 ON_THE_WAY']);
    // R1 is a route and also truck R-1's code: the route is shown, the truck offered in its place.
    const also = (await body(await view(token, { ip, route: 'R2X, r1' }))).data!.lookup!;
    expect(also.results.map((x) => `${x.kind} ${x.code}`)).toEqual(['ROUTE R1', 'ROUTE R2X']);
    expect(also.choices).toEqual([{ asked: 'R1', kind: 'ALSO_TRUCK', options: [{ code: 'R-1', query: 'R2X, Truck R-1' }] }]);
    const truckR1 = (await body(await view(token, { ip, route: 'R2X, Truck R-1' }))).data!.lookup!;
    expect(truckR1.results.map((x) => `${x.kind} ${x.code}`)).toEqual(['ROUTE R2X', 'TRUCK R-1']);
    expect(truckR1.choices).toEqual([]);
    // None of it counted as a miss: the 40 misses of this link and address are all still there.
    for (let i = 0; i < 40; i++) expect((await view(token, { ip, route: `ZZ${i}` })).status).toBe(200);
    expect((await view(token, { ip, route: 'ZZ99' })).status).toBe(429);
  });

  it('two trucks sharing a compact key (review of 20 Oct 2026): the exact code shows one; with four routes the trucks are offered, and the refresh is answered', async () => {
    const base = [ln('o1', 'o1-l1', 'INV-1', 20, 'R1'), ln('o1', 'o1-l2', 'INV-1', 10, 'R2X'), ln('o2', 'o2-l1', 'INV-2', 12, 'R1')];
    const more = [ln('o5', 'o5-l1', 'INV-5', 4, 'R3'), ln('o6', 'o6-l1', 'INV-6', 6, 'R4'), ln('o7', 'o7-l1', 'INV-7', 3, 'R 10'), ln('o8', 'o8-l1', 'INV-8', 2, 'R10')];
    const d = world.details.get('run-A') as PlanDetail;
    const late = { status: 'LOCKED', departMin: hm(23, 30), returnMin: hm(23, 59) };
    d.loads.push(
      load({ ...late, id: 'L5', truckId: 't9', truckCode: 'AB-1', stops: [stop({ seq: 1, customerId: 'c5', code: 'TST0005', eta: hm(23, 40), lines: [more[0]!] }), stop({ seq: 2, customerId: 'c7', code: 'TST0007', eta: hm(23, 45), lines: [more[2]!] })] }),
      load({ ...late, id: 'L6', truckId: 't10', truckCode: 'AB.1', stops: [stop({ seq: 1, customerId: 'c6', code: 'TST0006', eta: hm(23, 40), lines: [more[1]!] }), stop({ seq: 2, customerId: 'c8', code: 'TST0008', eta: hm(23, 45), lines: [more[3]!] })] }),
    );
    world.facts.set('run-A', factsOf([...base, ...more]));
    const token = makeLink();
    const ip = freshIp();
    const ask = async (route: string) => body(await view(token, { ip, route }));
    // The exact code: that truck only.
    for (const [typed, code] of [['ab-1', 'AB-1'], ['Truck AB.1', 'AB.1']] as const) {
      expect((await ask(typed)).data!.lookup!.results.map((x) => `${x.kind} ${x.code}`), typed).toEqual([`TRUCK ${code}`]);
    }
    // Four routes and the shared compact key: four results, both trucks offered (each pick at most 5 codes).
    const five = (await ask('R1, R2X, R3, R4, ab1')).data!.lookup!;
    expect(five.results.map((x) => `${x.kind} ${x.code}`)).toEqual(['ROUTE R1', 'ROUTE R2X', 'ROUTE R3', 'ROUTE R4']);
    expect(five.choices).toEqual([
      {
        asked: 'AB1',
        kind: 'SEVERAL_TRUCKS',
        options: [
          { code: 'AB-1', query: 'R1, R2X, R3, R4, Truck AB-1' },
          { code: 'AB.1', query: 'R1, R2X, R3, R4, Truck AB.1' },
        ],
      },
    ]);
    // A code that matched two routes ("R-10": "R 10" and "R10") makes six results from five codes typed.
    const six = (await ask('R1, R2X, R3, R4, r-10')).data!.lookup!;
    expect(six.results).toHaveLength(6);
    // What the page follows on its next refresh is never refused (400 TOO_MANY_CODES sent it back to the form).
    for (const l of [five, six]) {
      const follow = followQuery(l)!;
      const q = parseRouteQuery(follow);
      expect(q.ok && q.codes.length).toBeLessThanOrEqual(MAX_CODES);
      const again = await view(token, { ip, route: follow });
      expect(again.status, follow).toBe(200);
      expect((await body(again)).data!.lookup!.results.map((x) => x.query)).toEqual(l.results.map((x) => x.query));
    }
    for (const o of five.choices[0]!.options) {
      const picked = (await ask(o.query)).data!.lookup!;
      expect(picked.results.map((x) => `${x.kind} ${x.code}`)).toEqual(['ROUTE R1', 'ROUTE R2X', 'ROUTE R3', 'ROUTE R4', `TRUCK ${o.code}`]);
      expect((await view(token, { ip, route: followQuery(picked)! })).status).toBe(200);
    }
  });

  it('truck lookups that miss count against the per-link and IP limit like route codes', async () => {
    const token = makeLink();
    const ip = freshIp();
    for (let i = 0; i < 40; i++) expect((await body(await view(token, { ip, route: `Truck ZZ${i}` }))).data!.lookup!.notFound).toEqual([`TRUCK ZZ${i}`]);
    expect((await view(token, { ip, route: 'T05' })).status).toBe(200);
    expect((await view(token, { ip, route: '9999' })).status).toBe(429);
  });

  it('400 for an empty or too long code', async () => {
    const token = makeLink();
    const empty = await view(token, { route: '  ' });
    expect(empty.status).toBe(400);
    expect((await body(empty)).error!.code).toBe('ROUTE_CODE_MISSING');
    const long = await view(token, { route: 'R'.repeat(41) });
    expect(long.status).toBe(400);
    expect((await body(long)).error!.code).toBe('ROUTE_CODE_TOO_LONG');
  });

  it('one build of the day for many salesmen at once, and none again within 30 s (memo and single flight)', async () => {
    const token = makeLink();
    const before = salesDayBuilds();
    const all = await Promise.all(Array.from({ length: 8 }, () => view(token, { route: 'R1' })));
    expect(all.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(salesDayBuilds()).toBe(before + 1);
    await view(token, { route: 'R2X' });
    expect(salesDayBuilds()).toBe(before + 1);
  });

  it('no private key anywhere in the answer', async () => {
    const r = await body(await view(makeLink(), { route: 'R1, R2X' }));
    const keys: string[] = [];
    const walk = (x: unknown) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object')
        for (const [k, val] of Object.entries(x)) {
          keys.push(k);
          walk(val);
        }
    };
    walk(r);
    expect(keys.filter((k) => /^(id|.*Id|driver.*|.*[pP]hone.*|imei|priority|salesValue|margin.*|payment.*|address|accessNotes|reasonNote|cancelNote|tokenHash|salt|truck.*|trips?|loadNo|stop.*|pin|lat|lng|position|window|reason|invoices?|customerCode|notes?|deliveries|offTruck)$/.test(k))).toEqual([]);
    // Each customer: exactly these, nothing more.
    for (const v of r.data!.lookup!.results) for (const row of v.rows) expect(Object.keys(row).sort()).toEqual(['at', 'atCustomer', 'branch', 'cases', 'customer', 'eta', 'inMin', 'key', 'movedTo', 'off', 'status']);
  });
});

describe('the office side', () => {
  const as = (role: string, tenantId = 'tA') => {
    session.value = { user: { id: `u-${role}`, name: role, email: `${role}@a.example`, role, tenantId } };
  };
  const post = (json: unknown) => linksPOST(new Request(`${BASE}/api/dispatch/sales-links`, { method: 'POST', body: JSON.stringify(json), headers: { 'content-type': 'application/json' } }));
  const patch = (id: string, json: unknown) => linkPATCH(new Request(`${BASE}/api/dispatch/sales-links/${id}`, { method: 'PATCH', body: JSON.stringify(json), headers: { 'content-type': 'application/json' } }), { params: { id } });
  const get = (q = '') => linksGET(new Request(`${BASE}/api/dispatch/sales-links${q}`));

  it('VIEWER: 403 everywhere', async () => {
    as('VIEWER');
    expect((await post({ date: D })).status).toBe(403);
    expect((await get(`?date=${D}`)).status).toBe(403);
    expect((await patch('x', { action: 'REVOKE' })).status).toBe(403);
  });

  it('PLANNER makes the link: 201 then 200, one audit row without the token, its hash or the salt; the link works', async () => {
    as('PLANNER');
    const r1 = await post({ date: D });
    expect(r1.status).toBe(201);
    const v1 = (await r1.json()).data;
    expect(v1.url).toMatch(new RegExp(`^${BASE}/s/[A-Za-z0-9_-]{24}$`));
    expect(v1).toMatchObject({ date: D, generation: 1, revoked: false, expired: false, phones: 0, routesSeen: [], created: true });
    expect(v1.message).toContain(v1.url);
    expect(v1.whatsappUrl).toMatch(/^https:\/\/wa\.me\/\?text=/);
    const r2 = await post({ date: D });
    expect(r2.status).toBe(200);
    expect((await r2.json()).data.url).toBe(v1.url);
    const rows = tables.auditLog!.filter((a) => a.action === 'SALES_LINK_ISSUED');
    expect(rows).toHaveLength(1);
    const token = v1.url.split('/s/')[1] as string;
    const audit = JSON.stringify(rows);
    for (const secret of [token, tokenHash(token), tables.salesLink![0]!.salt]) expect(audit).not.toContain(secret);
    session.value = null;
    expect((await view(token)).status).toBe(200);
    as('PLANNER');
    expect((await (await get(`?date=${D}`)).json()).data.url).toBe(v1.url);
    expect((await (await get()).json()).data).toMatchObject({ dates: [D, addDaysIso(D, 1)], links: [{ url: v1.url }] });
  });

  it('only today or tomorrow: 400 DATE_OUT_OF_RANGE (critique item 11); a bad body 400', async () => {
    as('PLANNER');
    const far = await post({ date: addDaysIso(D, 2) });
    expect(far.status).toBe(400);
    expect((await far.json()).error).toMatchObject({ code: 'DATE_OUT_OF_RANGE' });
    expect((await post({ date: addDaysIso(D, -1) })).status).toBe(400);
    expect((await post({ date: D, extra: 1 })).status).toBe(400);
    expect((await post({ date: addDaysIso(D, 1) })).status).toBe(201);
  });

  it('make a new link: the old one answers "replaced", the new one works; turn off: idempotent; another company: 404', async () => {
    as('PLANNER');
    const v1 = (await (await post({ date: D })).json()).data;
    const old = v1.url.split('/s/')[1];
    const r = await patch(v1.id, { action: 'REISSUE', reason: 'sent to the wrong group' });
    expect(r.status).toBe(200);
    const v2 = (await r.json()).data;
    expect(v2.generation).toBe(2);
    const fresh = v2.url.split('/s/')[1];
    expect(fresh).not.toBe(old);
    session.value = null;
    expect((await body(await view(old))).error!.code).toBe('LINK_REPLACED');
    expect((await view(fresh)).status).toBe(200);
    as('PLANNER', 'tB');
    expect((await patch(v1.id, { action: 'REVOKE' })).status).toBe(404);
    as('PLANNER');
    const off = (await (await patch(v1.id, { action: 'REVOKE' })).json()).data;
    expect(off).toMatchObject({ revoked: true, url: null, message: null });
    expect((await patch(v1.id, { action: 'REVOKE' })).status).toBe(200);
    expect(tables.auditLog!.filter((a) => a.action === 'SALES_LINK_REVOKED')).toHaveLength(1);
    expect(tables.auditLog!.filter((a) => a.action === 'SALES_LINK_REISSUED')).toHaveLength(1);
    session.value = null;
    expect((await body(await view(fresh))).error!.code).toBe('LINK_REVOKED');
    // A link turned off stays off when the dialog asks again.
    as('PLANNER');
    expect((await (await post({ date: D })).json()).data).toMatchObject({ revoked: true, url: null });
  });
});
