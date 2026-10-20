/**
 * The salesman link (owner request 19 Oct 2026): its token (lib/sales-link/token.ts), the route code a salesman
 * types (lib/sales-link/route-code.ts) and the rate-limit keys (lib/sales-link/guard.ts). Pure; invented data.
 *
 *  - the key is the driver link's scheme under another HKDF salt: the same secret gives another key and keyId,
 *    and a driver token of the same id, generation and salt is another token; SALES_LINK_SECRET first; none: off;
 *  - the link works until 06:00 company time the day after the delivery date;
 *  - route codes (critique item 18): NFKC, Arabic-Indic digits, the stored rule, a compact key without spaces or
 *    hyphens (an exact match first; both routes when the compact key is shared), "R1, R2X", "Route not given"
 *    never reachable;
 *  - truck codes (owner decision of 20 Oct 2026): the exact code first, then the same compact key, then a unique
 *    digits-only match; several trucks with the compact key or the digits are offered (SEVERAL_TRUCKS: one code
 *    typed never shows two trucks a pick could tell apart); a route code that is also a truck's shows the route and
 *    offers the truck (ALSO_TRUCK); "Truck X" looks among the trucks only; "C1, 5678" mixes both; the trucks found
 *    are kept in the link's list as "T:<code>" and read apart for the office;
 *  - the limits are keyed on the link and the public client IP, never on the page's device id; an unknown or
 *    internal IP shares one larger bucket per link; unknown tokens count only for a public IP (critique item 9).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import { deriveToken as driverDerive, driverLinkKey } from '@/lib/driver-link/token';
import {
  deriveToken,
  looksLikeSalesToken,
  newSalesLinkId,
  salesDeviceHash,
  salesLinkExpiry,
  salesLinkIkm,
  salesLinkKey,
  salesLinkUrl,
  SALES_LINK_TOKEN_RE,
  tokenHash,
} from '@/lib/sales-link/token';
import { asciiDigits, codeDigits, compactRouteKey, compactTruckKey, explicitTruck, matchLookup, matchRoutes, MAX_CODES, normTypedRoute, parseRouteQuery, truckQuery } from '@/lib/sales-link/route-code';
import { salesBadTokenKey, salesDeviceFromHeader, salesIpKey, salesMissLimit, salesTokenFromHeader, salesViewLimit, SALES_HEADERS } from '@/lib/sales-link/guard';
import { salesLinkDateProblem, salesTouchPlan, seenLists, TRUCK_SEEN_PREFIX } from '@/lib/sales-link/service';
import { LIMITS } from '@/lib/rate-limit';
import { expiryText, salesLinkMessage, shortDayText } from '@/lib/sales-link/text';

const ENV = { NEXTAUTH_SECRET: 'sales-link-token-test-secret' } as unknown as NodeJS.ProcessEnv;

describe('the token', () => {
  it('another key than the driver link from the same secret: a driver token never passes as a salesman token', () => {
    const s = salesLinkKey(ENV)!;
    const d = driverLinkKey(ENV)!;
    expect(s.key.equals(d.key)).toBe(false);
    expect(s.keyId).not.toBe(d.keyId);
    expect(s.keyId).toMatch(/^[0-9a-f]{8}$/);
    const t = deriveToken(s.key, 'sl0123', 1, 'salt');
    expect(t).toMatch(SALES_LINK_TOKEN_RE);
    expect(t).not.toBe(driverDerive(d.key, 'sl0123', 1, 'salt'));
    // Deterministic, and every input counts.
    expect(deriveToken(s.key, 'sl0123', 1, 'salt')).toBe(t);
    expect(deriveToken(s.key, 'sl0123', 2, 'salt')).not.toBe(t);
    expect(deriveToken(s.key, 'sl0123', 1, 'salt2')).not.toBe(t);
    expect(tokenHash(t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('SALES_LINK_SECRET first (rotates only the salesman links), else the driver link secret; none: off', () => {
    expect(salesLinkIkm({ SALES_LINK_SECRET: ' own ', NEXTAUTH_SECRET: 'shared' } as unknown as NodeJS.ProcessEnv)).toBe('own');
    expect(salesLinkIkm({ DRIVER_LINK_SECRET: 'drv', NEXTAUTH_SECRET: 'shared' } as unknown as NodeJS.ProcessEnv)).toBe('drv');
    expect(salesLinkIkm({ AUTH_SECRET: 'auth' } as unknown as NodeJS.ProcessEnv)).toBe('auth');
    expect(salesLinkKey({} as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(salesLinkKey({ SALES_LINK_SECRET: 'a', NEXTAUTH_SECRET: 'x' } as unknown as NodeJS.ProcessEnv)!.keyId).not.toBe(salesLinkKey({ SALES_LINK_SECRET: 'b', NEXTAUTH_SECRET: 'x' } as unknown as NodeJS.ProcessEnv)!.keyId);
  });

  it('the shape, the id, the URL, the device hash', () => {
    expect(looksLikeSalesToken('A'.repeat(24))).toBe(true);
    expect(looksLikeSalesToken('A'.repeat(23))).toBe(false);
    expect(looksLikeSalesToken('A'.repeat(23) + '/')).toBe(false);
    expect(looksLikeSalesToken(null)).toBe(false);
    expect(newSalesLinkId()).toMatch(/^sl[0-9a-f]{24}$/);
    expect(salesLinkUrl('https://routeiq.example', 'tok')).toBe('https://routeiq.example/s/tok');
    expect(salesDeviceHash('0123456789abcdef0123456789abcdef')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('works until 06:00 company time the day after the delivery date', () => {
    expect(salesLinkExpiry('2026-10-19', 'Asia/Muscat').toISOString()).toBe('2026-10-20T02:00:00.000Z');
    expect(salesLinkExpiry('2026-12-31', 'Asia/Muscat').toISOString()).toBe('2027-01-01T02:00:00.000Z');
    expect(expiryText('2026-10-19', '2026-10-20', 6)).toBe('Works until Tue 20 Oct 06:00');
    expect(shortDayText('2026-10-19')).toBe('Mon 19 Oct');
  });

  it("only the company's today or tomorrow (critique item 11); a day whose link is over", () => {
    const now = new Date('2026-10-19T06:00:00Z'); // 10:00 in Muscat
    expect(salesLinkDateProblem('2026-10-19', 'Asia/Muscat', now)).toBeNull();
    expect(salesLinkDateProblem('2026-10-20', 'Asia/Muscat', now)).toBeNull();
    expect(salesLinkDateProblem('2026-10-21', 'Asia/Muscat', now)).toMatchObject({ status: 400, code: 'DATE_OUT_OF_RANGE' });
    expect(salesLinkDateProblem('2026-10-18', 'Asia/Muscat', now)).toMatchObject({ status: 400, code: 'DATE_OUT_OF_RANGE' });
    expect(salesLinkDateProblem('19/10/2026', 'Asia/Muscat', now)).toMatchObject({ status: 400 });
    // 21:30 UTC = 01:30 in Muscat the next day: "today" is the 20th already.
    expect(salesLinkDateProblem('2026-10-21', 'Asia/Muscat', new Date('2026-10-19T21:30:00Z'))).toBeNull();
  });

  it('the WhatsApp message: the day, the company, the link, its end, "do not forward"', () => {
    const m = salesLinkMessage({ dayShort: 'Mon 19 Oct', company: 'Example Water Co', url: 'https://routeiq.example/s/tok', expiryText: 'Works until Tue 20 Oct 06:00' });
    expect(m.split('\n')).toEqual([
      'RouteIQ - live deliveries for Mon 19 Oct (Example Water Co): https://routeiq.example/s/tok',
      "Open it, type your route code (as on your Salesman ETA page) and see each customer's delivery: delivered, on the way with the expected time, delayed, not delivered or cancelled. English, Arabic or Urdu.",
      'Works until Tue 20 Oct 06:00. For the sales team only - please do not forward.',
    ]);
  });
});

describe('the route code a salesman types (critique item 18)', () => {
  it('NFKC, Arabic-Indic and Eastern Arabic-Indic digits, then the stored rule', () => {
    expect(asciiDigits('٣٤')).toBe('34');
    expect(asciiDigits('۱۲')).toBe('12');
    expect(normTypedRoute(' r2x ')).toBe('R2X');
    expect(normTypedRoute('Ｒ１０')).toBe('R10'); // full-width R10
    expect(normTypedRoute('r١٠')).toBe('R10');
    expect(normTypedRoute('   ')).toBeNull();
  });

  it('the compact key leaves out spaces, hyphens, dots, slashes and underscores', () => {
    expect(compactRouteKey('r-1')).toBe('R1');
    expect(compactRouteKey('R 1')).toBe('R1');
    expect(compactRouteKey('r_1.')).toBe('R1');
    expect(compactRouteKey('R2X')).toBe('R2X');
  });

  it('"R1, R2X" (a salesman with two routes), the Arabic comma, semicolons; refused: empty, too long, too many', () => {
    expect(parseRouteQuery('r1, R2X')).toEqual({ ok: true, codes: ['R1', 'R2X'] });
    expect(parseRouteQuery('R1، R10; r1')).toEqual({ ok: true, codes: ['R1', 'R10'] });
    expect(parseRouteQuery('')).toEqual({ ok: false, code: 'ROUTE_CODE_MISSING' });
    expect(parseRouteQuery(' , ; ')).toEqual({ ok: false, code: 'ROUTE_CODE_MISSING' });
    expect(parseRouteQuery('R'.repeat(41))).toEqual({ ok: false, code: 'ROUTE_CODE_TOO_LONG' });
    expect(parseRouteQuery('R'.repeat(40))).toEqual({ ok: true, codes: ['R'.repeat(40)] });
    expect(parseRouteQuery('A,B,C,D,E,F')).toEqual({ ok: false, code: 'TOO_MANY_CODES' });
    expect(MAX_CODES).toBe(5);
  });

  it('an exact code first; else every route with the same compact key; unknown and "Route not given" match nothing', () => {
    const known = ['R1', 'R2X', 'R10', 'R 10', 'X-7'];
    expect(matchRoutes(['R10'], known)).toEqual({ routes: ['R10'], notFound: [], ambiguous: [] });
    expect(matchRoutes(['R 10'], known)).toEqual({ routes: ['R 10'], notFound: [], ambiguous: [] });
    expect(matchRoutes(['R-10'], known)).toEqual({ routes: ['R 10', 'R10'], notFound: [], ambiguous: ['R-10'] });
    expect(matchRoutes(['X7'], known)).toEqual({ routes: ['X-7'], notFound: [], ambiguous: [] });
    expect(matchRoutes(['R1', 'R9'], known)).toEqual({ routes: ['R1'], notFound: ['R9'], ambiguous: [] });
    expect(matchRoutes(['ROUTE NOT GIVEN'], known).notFound).toEqual(['ROUTE NOT GIVEN']);
    expect(matchRoutes(['R2X', 'R1'], known).routes).toEqual(['R1', 'R2X']);
  });
});

describe('the truck code a salesman types (owner decision of 20 Oct 2026)', () => {
  // Synthetic trucks of one day: ids are the server's, never sent.
  const trucks = [
    { id: 'tk1', code: '5678-XY' },
    { id: 'tk2', code: '1234-AB' },
    { id: 'tk3', code: '1234-CD' },
    { id: 'tk4', code: 'TEST-01' },
    { id: 'tk5', code: 'C-1' },
  ];
  const routes = ['C1', 'R1', 'R2X', '101'];

  it('the compact key and the digits of a truck code; the explicit form', () => {
    for (const typed of ['5678-XY', '5678xy', '5678 XY', '٥٦٧٨-xy', '۵۶۷۸ XY', '５６７８ＸＹ']) expect(compactTruckKey(typed)).toBe('5678XY');
    expect(codeDigits('5678-XY')).toBe('5678');
    expect(codeDigits('TEST-01')).toBe('01');
    expect(codeDigits('ABC')).toBe('');
    expect(truckQuery('1234-AB')).toBe('Truck 1234-AB');
    expect(explicitTruck('Truck 1234-AB')).toBe('1234-AB');
    expect(explicitTruck('truck: 1234ab')).toBe('1234AB');
    expect(explicitTruck('TRUCK   5678-xy')).toBe('5678-XY');
    expect(explicitTruck('TRUCK')).toBeNull();
    expect(explicitTruck('TRUCK1')).toBeNull();
    expect(explicitTruck('R1')).toBeNull();
  });

  it('an exact truck code (compact key) first, with Arabic-Indic digits too', () => {
    for (const typed of ['5678-XY', '5678XY', '5678 xy', '٥٦٧٨XY']) {
      const code = parseRouteQuery(typed);
      expect(code.ok).toBe(true);
      expect(matchLookup(code.ok ? code.codes : [], routes, trucks)).toEqual({ routes: [], trucks: ['tk1'], notFound: [], ambiguous: [], choices: [] });
    }
  });

  it('a unique digits-only match ("5678", "٥٦٧٨"); several trucks with the digits are offered, none shown', () => {
    expect(matchLookup(['5678'], routes, trucks)).toMatchObject({ trucks: ['tk1'], choices: [], notFound: [] });
    expect(matchLookup([normTypedRoute('٥٦٧٨')!], routes, trucks)).toMatchObject({ trucks: ['tk1'], choices: [] });
    expect(matchLookup(['1234'], routes, trucks)).toEqual({ routes: [], trucks: [], notFound: [], ambiguous: [], choices: [{ asked: '1234', why: 'SEVERAL_TRUCKS', routes: [], trucks: ['tk2', 'tk3'] }] });
    // Digits only: a code with letters never matches by its digits; other digits match nothing.
    expect(matchLookup(['5678X'], routes, trucks)).toMatchObject({ trucks: [], notFound: ['5678X'] });
    expect(matchLookup(['567'], routes, trucks)).toMatchObject({ trucks: [], notFound: ['567'] });
    expect(matchLookup(['01'], routes, trucks)).toMatchObject({ trucks: ['tk4'] });
  });

  it('a route code that is also a truck code: the route is shown, the truck offered; "Truck X" is the truck only', () => {
    expect(matchLookup(['C1'], routes, trucks)).toEqual({ routes: ['C1'], trucks: [], notFound: [], ambiguous: [], choices: [{ asked: 'C1', why: 'ALSO_TRUCK', routes: ['C1'], trucks: ['tk5'] }] });
    expect(matchLookup(['TRUCK C1'], routes, trucks)).toEqual({ routes: [], trucks: ['tk5'], notFound: [], ambiguous: [], choices: [] });
    expect(matchLookup(['TRUCK 1234'], routes, trucks).choices).toEqual([{ asked: 'TRUCK 1234', why: 'SEVERAL_TRUCKS', routes: [], trucks: ['tk2', 'tk3'] }]);
    // A truck form that names no truck is not found (never a route).
    expect(matchLookup(['TRUCK R2X'], routes, trucks)).toMatchObject({ routes: [], trucks: [], notFound: ['TRUCK R2X'] });
    // A route with no truck of that code offers nothing.
    expect(matchLookup(['R2X'], routes, trucks).choices).toEqual([]);
  });

  it('mixed "C1, 5678": routes first (natural order), then trucks by code; unknown codes listed', () => {
    const q = parseRouteQuery('5678, r2x, Truck test-01, zz9');
    expect(q).toEqual({ ok: true, codes: ['5678', 'R2X', 'TRUCK TEST-01', 'ZZ9'] });
    expect(matchLookup(q.ok ? q.codes : [], routes, trucks)).toEqual({ routes: ['R2X'], trucks: ['tk1', 'tk4'], notFound: ['ZZ9'], ambiguous: [], choices: [] });
  });

  // Truck codes may hold '.', '-' and '_' (lib/schemas.ts codeSchema), so two trucks of one fleet can share a
  // compact key (review of 20 Oct 2026): synthetic AB-1 and AB.1.
  const twins = [
    { id: 'tw1', code: 'AB-1' },
    { id: 'tw2', code: 'AB.1' },
    { id: 'tk4', code: 'TEST-01' },
  ];

  it('two trucks with one compact key: the exact code shows that truck only; the compact key offers both, none shown', () => {
    expect(matchLookup(['AB-1'], [], twins)).toEqual({ routes: [], trucks: ['tw1'], notFound: [], ambiguous: [], choices: [] });
    expect(matchLookup([normTypedRoute('ab.1')!], [], twins)).toEqual({ routes: [], trucks: ['tw2'], notFound: [], ambiguous: [], choices: [] });
    expect(matchLookup([normTypedRoute('Truck ab-1')!], [], twins)).toMatchObject({ trucks: ['tw1'], choices: [] });
    for (const typed of ['ab1', 'AB 1', 'Truck AB1']) {
      const code = normTypedRoute(typed)!;
      expect(matchLookup([code], [], twins), typed).toEqual({ routes: [], trucks: [], notFound: [], ambiguous: [], choices: [{ asked: code, why: 'SEVERAL_TRUCKS', routes: [], trucks: ['tw1', 'tw2'] }] });
    }
    // The trucks offered are picked in the explicit form, and each finds that one truck.
    for (const t of twins.slice(0, 2)) expect(matchLookup([normTypedRoute(truckQuery(t.code))!], [], twins).trucks).toEqual([t.id]);
    // A route code that is also a truck's offers the truck with that very code before the compact key's.
    expect(matchLookup(['AB1'], ['AB1'], [...twins, { id: 'tw3', code: 'AB1' }]).choices).toEqual([{ asked: 'AB1', why: 'ALSO_TRUCK', routes: ['AB1'], trucks: ['tw3'] }]);
    expect(matchLookup(['AB1'], ['AB1'], twins).choices).toEqual([{ asked: 'AB1', why: 'ALSO_TRUCK', routes: ['AB1'], trucks: ['tw1', 'tw2'] }]);
    // Only codes that differ in letter case alone cannot be told apart by a pick: each shown, the code ambiguous.
    expect(matchLookup(['X-9'], [], [{ id: 'a', code: 'X-9' }, { id: 'b', code: 'x-9' }, { id: 'c', code: 'X 9' }])).toEqual({ routes: [], trucks: ['a', 'b'], notFound: [], ambiguous: ['X-9'], choices: [] });
  });

  it('four routes and a code two trucks share: four results and the trucks offered, never six results to follow', () => {
    const q = parseRouteQuery('R1, R2, R3, R4, ab1');
    expect(q).toEqual({ ok: true, codes: ['R1', 'R2', 'R3', 'R4', 'AB1'] });
    const m = matchLookup(q.ok ? q.codes : [], ['R1', 'R2', 'R3', 'R4'], twins);
    expect(m).toEqual({ routes: ['R1', 'R2', 'R3', 'R4'], trucks: [], notFound: [], ambiguous: [], choices: [{ asked: 'AB1', why: 'SEVERAL_TRUCKS', routes: [], trucks: ['tw1', 'tw2'] }] });
    expect(m.routes.length + m.trucks.length).toBeLessThanOrEqual(MAX_CODES);
  });

  it('the trucks found are kept as "T:<code>" in the routes looked up, and read apart for the office', () => {
    expect(TRUCK_SEEN_PREFIX).toBe('T:');
    expect(seenLists(['R2X', 'T:1234-AB', 'R1', 'T:TEST-01', 'R1', 'T:'])).toEqual({ routes: ['R1', 'R2X'], trucks: ['1234-AB', 'TEST-01'] });
    expect(seenLists(null)).toEqual({ routes: [], trucks: [] });
    const now = new Date('2026-10-19T06:00:00Z');
    expect(salesTouchPlan({ lastSeenAt: now, devicesJson: [], routesJson: ['R1'] }, null, ['R1', 'T:1234-AB'], now)).toEqual({ device: null, routes: ['T:1234-AB'], seen: false });
  });
});

describe('the rate-limit keys (critique item 9) and the request parts', () => {
  it('per link and public IP; an unknown or internal IP shares one larger bucket of the link', () => {
    expect(salesViewLimit('sl1', '203.0.113.7')).toEqual({ key: 'sl-view:sl1:203.0.113.7', ...LIMITS.salesView });
    expect(salesViewLimit('sl1', '10.0.0.5')).toEqual({ key: 'sl-view:sl1:shared', ...LIMITS.salesViewShared });
    expect(salesViewLimit('sl1', '100.64.1.2')).toEqual({ key: 'sl-view:sl1:shared', ...LIMITS.salesViewShared });
    expect(salesViewLimit('sl1', null)).toEqual({ key: 'sl-view:sl1:shared', ...LIMITS.salesViewShared });
    expect(salesViewLimit('sl2', '203.0.113.7').key).not.toBe(salesViewLimit('sl1', '203.0.113.7').key);
    expect(salesMissLimit('sl1', '203.0.113.7')).toEqual({ key: 'sl-miss:sl1:203.0.113.7', ...LIMITS.salesRouteMiss });
    expect(salesMissLimit('sl1', '192.168.1.9')).toEqual({ key: 'sl-miss:sl1:shared', ...LIMITS.salesRouteMissShared });
    expect(salesIpKey('2001:db8::1')).toBe('2001:db8::1');
    expect(salesIpKey('fd00::1')).toBe('shared');
  });

  it('unknown tokens count only against a known public IP', () => {
    expect(salesBadTokenKey('203.0.113.7')).toBe('sl-bad:203.0.113.7');
    expect(salesBadTokenKey('10.1.2.3')).toBeNull();
    expect(salesBadTokenKey(null)).toBeNull();
  });

  it('the token only from "Authorization: SalesLink"; the device id only as 32 hex, hashed', () => {
    const req = (h: Record<string, string>) => new Request('https://routeiq.example/api/s/view', { headers: h });
    expect(salesTokenFromHeader(req({ authorization: 'SalesLink abc' }))).toBe('abc');
    expect(salesTokenFromHeader(req({ authorization: 'DriverLink abc' }))).toBeNull();
    expect(salesTokenFromHeader(req({}))).toBeNull();
    expect(salesDeviceFromHeader(req({ 'x-sales-device': '0123456789ABCDEF0123456789abcdef' }))).toMatch(/^[0-9a-f]{8}$/);
    expect(salesDeviceFromHeader(req({ 'x-sales-device': 'not-a-device' }))).toBeNull();
    expect(SALES_HEADERS).toEqual({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
  });

  it('what a request adds to the link: a new phone, new routes, lastSeenAt at most every 5 minutes', () => {
    const now = new Date('2026-10-19T06:00:00Z');
    const fresh = { lastSeenAt: new Date(now.getTime() - 60_000), devicesJson: ['aaaaaaaa'], routesJson: ['R1'] };
    expect(salesTouchPlan(fresh, 'aaaaaaaa', ['R1'], now)).toBeNull();
    expect(salesTouchPlan(fresh, 'bbbbbbbb', ['R1', 'R2X'], now)).toEqual({ device: 'bbbbbbbb', routes: ['R2X'], seen: false });
    expect(salesTouchPlan({ ...fresh, lastSeenAt: new Date(now.getTime() - 6 * 60_000) }, null, [], now)).toEqual({ device: null, routes: [], seen: true });
    const full = { lastSeenAt: now, devicesJson: Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(8, '0')), routesJson: [] };
    expect(salesTouchPlan(full, 'ffffffff', [], now)).toBeNull();
  });
});
