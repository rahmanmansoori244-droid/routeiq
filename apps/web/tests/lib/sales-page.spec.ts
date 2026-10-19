/**
 * The salesman link's page (owner request 19 Oct 2026): lib/sales-page/api.ts and format.ts (pure), and the cards
 * of app/s/[token] rendered as element trees (no DOM). Invented data only (sales-page-fixture.ts).
 *
 *  - The token: read from /s/<token> only, sent only in `Authorization: SalesLink`, never in the API's URL; the
 *    request is no-store, same-origin, no-referrer; a network failure or a timeout is "no answer".
 *  - The route from the link's fragment (#R1, critique 20), the browser's saved route and random id, every one
 *    surviving a browser that blocks storage.
 *  - Every answer of GET /api/s/view is read as the page needs it: ok, link states full-page (with the link's
 *    date), refused codes on the form, 429 with Retry-After, anything else an error.
 *  - Every status and kind has its colours; the timing chip against the printed window (critique 5); the count
 *    chips agree with the lists they filter; only the routes FOUND are followed (no unknown code re-asked).
 *  - The map: only deliveries still to come and the trucks the server places, no names; fitted once per route
 *    and pins; the WebGL check (critique 20: no-WebGL fallback).
 *  - The delivery card: the reason as the driver reported it, "Send to customer" as wa.me/?text= with no number
 *    and no link in the text.
 */
import { describe, expect, it, vi } from 'vitest';
import tailwindColors from 'tailwindcss/colors';

vi.mock('@/lib/db', () => ({ prisma: {} }));

import { DEVICE_KEY, ROUTE_KEY, deviceId, fetchSalesView, forgetRoute, readSalesAnswer, routeFromHash, saveRoute, savedRoute, salesHeaders, tokenFromPath, viewUrl, type KeyStore } from '@/lib/sales-page/api';
import {
  DONE_STATUSES,
  LINK_STATE_TEXT,
  OFF_TONE,
  PIN_COLOR,
  STATUS_EDGE,
  STATUS_TONE,
  TIMING_TONE,
  UI,
  casesLine,
  casesText,
  codeText,
  filterView,
  followQuery,
  hasMapContent,
  hoursLine,
  mapModel,
  noDeliveriesText,
  shareUrl,
  shortDayText,
  summaryChips,
  timeLine,
  timingChip,
  tripText,
  webglAvailable,
  windowLine,
} from '@/lib/sales-page/format';
import { SALES_STATE_TEXT } from '@/lib/sales-link/service';
import { shortDayText as serverShortDay, STATUS_TEXT, OFF_KIND_TEXT } from '@/lib/sales-link/text';
import type { DeliveryStatus, OffTruckKind } from '@/lib/sales-link/view-types';
import { DeliveryCard } from '@/app/s/[token]/delivery-card';
import { LinkState } from '@/app/s/[token]/link-state';
import { TruckCard } from '@/app/s/[token]/truck-card';
import { MapFallback } from '@/app/s/[token]/map-card';
import { elements, textOf } from './hook-host';
import { TOKEN, answer, delivery, lookup, meta, offTruck, routeView, truck } from './sales-page-fixture';

const ALL_STATUSES = Object.keys(STATUS_TEXT) as DeliveryStatus[];
const ALL_KINDS = Object.keys(OFF_KIND_TEXT) as OffTruckKind[];

function memoryStore(init: Record<string, string> = {}): KeyStore & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k]! : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}
const blocked: KeyStore = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('SecurityError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
};

describe('the token, the fragment and what the browser keeps', () => {
  it('reads the token from /s/<24 characters> only', () => {
    expect(tokenFromPath(`/s/${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromPath(`/s/${TOKEN}/`)).toBe(TOKEN);
    expect(tokenFromPath(`/s/${TOKEN}x`)).toBeNull();
    expect(tokenFromPath(`/d/${TOKEN}`)).toBeNull();
    expect(tokenFromPath(`/s/${TOKEN.slice(1)}`)).toBeNull();
    expect(tokenFromPath(`/s/${TOKEN}/more`)).toBeNull();
  });

  it('reads the route of the link\'s fragment: #R1, encoded spaces and commas, nothing for an empty or a too long one', () => {
    expect(routeFromHash('#R1')).toBe('R1');
    expect(routeFromHash('#r%201')).toBe('r 1');
    expect(routeFromHash('#R1,%20R2X')).toBe('R1, R2X');
    expect(routeFromHash('#R1+R2X')).toBe('R1 R2X');
    expect(routeFromHash('#%E0%A4%A')).toBe('%E0%A4%A');
    expect(routeFromHash('')).toBeNull();
    expect(routeFromHash('#')).toBeNull();
    expect(routeFromHash('#%20%20')).toBeNull();
    expect(routeFromHash(`#${'R'.repeat(500)}`)).toBeNull();
    expect(routeFromHash(null)).toBeNull();
  });

  it('keeps the route found and the random id under its own keys (never the driver page\'s), and works when storage is blocked', () => {
    const s = memoryStore();
    expect(savedRoute(s)).toBeNull();
    saveRoute('R1, R2X', s);
    expect(s.data[ROUTE_KEY]).toBe('R1, R2X');
    expect(savedRoute(s)).toBe('R1, R2X');
    forgetRoute(s);
    expect(savedRoute(s)).toBeNull();
    expect(ROUTE_KEY).toBe('riq.s.route');
    expect(DEVICE_KEY).toBe('riq.s.device');

    const id = deviceId(s);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(deviceId(s)).toBe(id);
    s.data[DEVICE_KEY] = 'not-hex';
    expect(deviceId(s)).not.toBe('not-hex');

    expect(() => saveRoute('R1', blocked)).not.toThrow();
    expect(() => forgetRoute(blocked)).not.toThrow();
    expect(savedRoute(blocked)).toBeNull();
    const a = deviceId(blocked);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(deviceId(blocked)).toBe(a);
    expect(deviceId(null)).toBe(a);
  });

  it('asks a token-free path; the token travels only in the header', () => {
    expect(viewUrl(null)).toBe('/api/s/view');
    expect(viewUrl('R1, R2X')).toBe('/api/s/view?route=R1%2C%20R2X');
    expect(salesHeaders(TOKEN, 'ab'.repeat(16))).toEqual({ Authorization: `SalesLink ${TOKEN}`, 'X-Sales-Device': 'ab'.repeat(16), Accept: 'application/json' });
  });

  it('fetches no-store, same-origin, without a Referer; a network failure or a stall is "no answer"', async () => {
    const calls: [string, RequestInit][] = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ data: answer(null), error: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const a = await fetchSalesView(TOKEN, 'cd'.repeat(16), 'R1', ok);
    expect(a.kind).toBe('ok');
    const [url, init] = calls[0]!;
    expect(url).toBe('/api/s/view?route=R1');
    expect(url).not.toContain(TOKEN);
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer' });
    expect((init.headers as Record<string, string>).Authorization).toBe(`SalesLink ${TOKEN}`);

    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await fetchSalesView(TOKEN, 'cd'.repeat(16), null, down)).toEqual({ kind: 'error', status: 0 });
    const stall = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    expect(await fetchSalesView(TOKEN, 'cd'.repeat(16), null, stall, 10)).toEqual({ kind: 'error', status: 0 });
  });
});

describe('every answer of GET /api/s/view as the page reads it', () => {
  const fail = (code: string, extra: Record<string, unknown> = {}) => ({ data: null, error: { code, message: 'm', ...extra } });

  it('200 with meta (and a lookup or none)', () => {
    const body = { data: answer(lookup([routeView()])), error: null };
    const a = readSalesAnswer(200, body, null);
    expect(a.kind).toBe('ok');
    expect(a.kind === 'ok' && a.answer.lookup?.routes[0]?.route).toBe('R1');
    expect(readSalesAnswer(200, { data: {}, error: null }, null).kind).toBe('error');
  });

  it('the link states are full-page, with the link\'s date when the server gives it', () => {
    expect(readSalesAnswer(404, fail('LINK_NOT_FOUND'), null)).toEqual({ kind: 'link', status: 404, code: 'LINK_NOT_FOUND', date: null });
    expect(readSalesAnswer(410, fail('LINK_REPLACED', { date: '2026-10-19' }), null)).toEqual({ kind: 'link', status: 410, code: 'LINK_REPLACED', date: '2026-10-19' });
    expect(readSalesAnswer(410, fail('LINK_REVOKED', { date: '2026-10-19' }), null)).toMatchObject({ code: 'LINK_REVOKED' });
    expect(readSalesAnswer(410, fail('LINK_EXPIRED', { date: '2026-10-18' }), null)).toMatchObject({ code: 'LINK_EXPIRED', date: '2026-10-18' });
    expect(readSalesAnswer(503, fail('SALES_LINKS_OFF'), null)).toMatchObject({ kind: 'link', code: 'SALES_LINKS_OFF' });
    expect(readSalesAnswer(403, fail('SIGNED_IN_OTHER_TENANT'), null)).toMatchObject({ kind: 'link', code: 'SIGNED_IN_OTHER_TENANT' });
    // A proxy's or the platform's own 404 / 410 / 503 page (no code: a restart, a deploy): an error the page rides out
    // (it keeps polling), never "the link does not work" for good.
    expect(readSalesAnswer(404, '<html>', null)).toEqual({ kind: 'error', status: 404 });
    expect(readSalesAnswer(503, null, null)).toEqual({ kind: 'error', status: 503 });
    expect(readSalesAnswer(410, { data: null, error: { code: 'SOMETHING_ELSE' } }, null)).toEqual({ kind: 'error', status: 410 });
    expect(readSalesAnswer(410, fail('LINK_EXPIRED', { date: 'yesterday' }), null)).toMatchObject({ date: null });
  });

  it('refused codes go to the route form with the server\'s words', () => {
    expect(readSalesAnswer(400, { data: null, error: { code: 'ROUTE_CODE_MISSING', message: 'Type your route code.' } }, null)).toEqual({ kind: 'badCode', code: 'ROUTE_CODE_MISSING', message: 'Type your route code.' });
    expect(readSalesAnswer(400, fail('TOO_MANY_CODES'), null)).toMatchObject({ kind: 'badCode', code: 'TOO_MANY_CODES' });
    expect(readSalesAnswer(400, fail('ROUTE_CODE_TOO_LONG'), null)).toMatchObject({ kind: 'badCode' });
    expect(readSalesAnswer(400, fail('BAD_REQUEST'), null)).toEqual({ kind: 'error', status: 400 });
  });

  it('429 waits Retry-After; anything else is an error', () => {
    expect(readSalesAnswer(429, fail('RATE_LIMITED'), '37')).toEqual({ kind: 'busy', retryAfterSec: 37 });
    expect(readSalesAnswer(429, fail('RATE_LIMITED'), null)).toEqual({ kind: 'busy', retryAfterSec: null });
    expect(readSalesAnswer(429, null, 'soon')).toEqual({ kind: 'busy', retryAfterSec: null });
    expect(readSalesAnswer(500, fail('ERROR'), null)).toEqual({ kind: 'error', status: 500 });
    expect(readSalesAnswer(502, null, null)).toEqual({ kind: 'error', status: 502 });
  });

  it('the page\'s link texts are the server\'s, and its day is the server\'s', () => {
    expect(LINK_STATE_TEXT).toEqual(SALES_STATE_TEXT);
    for (const d of ['2026-10-19', '2026-10-20', '2026-12-31', '2027-01-01']) expect(shortDayText(d)).toBe(serverShortDay(d));
  });
});

describe('colours, chips and lines', () => {
  it('every status and every kind not on a truck has its colours', () => {
    for (const s of ALL_STATUSES) {
      expect(STATUS_TONE[s], s).toMatch(/bg-/);
      expect(STATUS_EDGE[s], s).toMatch(/border-l-/);
      expect(PIN_COLOR[s], s).toMatch(/^#[0-9a-f]{6}$/);
    }
    for (const k of ALL_KINDS) expect(OFF_TONE[k], k).toMatch(/bg-/);
  });

  it('every chip reads at 4.5:1 or better (WCAG AA for 14 px text, outdoors in the sun): "Partly delivered" above all', () => {
    const palette = tailwindColors as unknown as Record<string, Record<string, string> | string>;
    const hexOf = (cls: string, prefix: 'bg-' | 'text-'): string => {
      const name = cls.split(/\s+/).find((c) => c.startsWith(prefix))!.slice(prefix.length);
      if (name === 'white') return '#ffffff';
      const m = /^([a-z]+)-(\d+)$/.exec(name)!;
      return (palette[m[1]!] as Record<string, string>)[m[2]!]!;
    };
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const contrast = (tone: string) => {
      const [a, b] = [lum(hexOf(tone, 'bg-')), lum(hexOf(tone, 'text-'))].sort((x, y) => y - x);
      return (a! + 0.05) / (b! + 0.05);
    };
    for (const [s, tone] of [...Object.entries(STATUS_TONE), ...Object.entries(OFF_TONE), ...Object.entries(TIMING_TONE)]) expect(contrast(tone), `${s}: ${tone}`).toBeGreaterThanOrEqual(4.5);
  });

  it('the timing chip is against the printed window: late and early with minutes, due now without, nothing without live updates', () => {
    const eta = (timing: 'ON_TIME' | 'LATE' | 'EARLY' | 'DUE_NOW' | 'NO_UPDATES', lateMin: number | null = null, earlyMin: number | null = null) => ({ expected: '10:45', source: 'GPS' as const, timing, lateMin, earlyMin, text: '' });
    expect(timingChip(eta('LATE', 20))?.text).toBe('Late ~20 min');
    expect(timingChip(eta('EARLY', null, 15))?.text).toBe('Early ~15 min');
    expect(timingChip(eta('ON_TIME'))?.text).toBe('On time');
    expect(timingChip(eta('DUE_NOW'))?.text).toBe('Due now');
    expect(timingChip(eta('NO_UPDATES'))).toBeNull();
    expect(timingChip(null)).toBeNull();
  });

  it('the card\'s lines: code and branch, trip and stop, cases x of y, the time, the window once, the hours', () => {
    expect(codeText('TST0001', 'B1')).toBe('TST0001 / B1');
    expect(codeText('TST0001', null)).toBe('TST0001');
    expect(tripText(delivery({ no: 3, loadNo: 2, stopNo: 3, stopsOnTrip: 9, part: 'part 1 of 2' }))).toBe('T05 · Trip 2 · stop 3 of 9 · part 1 of 2');
    expect(casesText(delivery({ no: 1, cases: 24, delivered: { cases: 18, of: 24 } }))).toBe('Delivered 18 of 24 cases');
    expect(casesText(delivery({ no: 1, cases: 24, delivered: { cases: 24, of: 24 } }))).toBe('24 cases delivered');
    expect(casesText(delivery({ no: 1, cases: 24, delivered: { cases: 0, of: 24 } }))).toBe('24 cases - none delivered');
    expect(casesText(delivery({ no: 1, cases: 1 }))).toBe('1 case');
    // Partly delivered: the time line already says "Delivered 12 of 20 cases", so the cases line does not repeat it.
    expect(casesLine(delivery({ no: 2, cases: 20, delivered: { cases: 12, of: 20 }, detailText: 'Delivered 12 of 20 cases at 08:40' }))).toBe('20 cases ordered');
    expect(casesLine(delivery({ no: 2, cases: 20, delivered: { cases: 12, of: 20 }, detailText: 'Partly delivered' }))).toBe('Delivered 12 of 20 cases');
    expect(casesLine(delivery({ no: 1, cases: 24, delivered: { cases: 24, of: 24 }, detailText: 'Delivered 08:10' }))).toBe('24 cases delivered');

    // Before the day (no live time): the printed window, as on the Salesman ETA page.
    const planned = delivery({ no: 1 });
    expect(timeLine(planned)).toBe('Expected between 07:45-09:00');
    expect(windowLine(planned)).toBeNull();
    // A live time that already names the window: not twice.
    const v = routeView();
    expect(windowLine(v.deliveries[2]!)).toBeNull();
    // A live time without it ("Due now"): the window under it.
    expect(windowLine(delivery({ no: 2, status: 'NEXT', detailText: 'Due now - no update from the truck yet' }))).toBe('Window 07:45-09:00 (as on the Salesman ETA)');
    // Done: the result's line, no window.
    expect(timeLine(v.deliveries[0]!)).toBe('Delivered 08:10');
    expect(windowLine(v.deliveries[0]!)).toBeNull();
    expect(timeLine(delivery({ no: 1, window: null }))).toBe('Planned 08:05');
    expect(hoursLine(delivery({ no: 1, orderTime: 'this order: 10:00-11:00' }))).toBe('Receiving hours 06:00-14:00 · this order: 10:00-11:00');
    expect(hoursLine(delivery({ no: 1, hours: null }))).toBeNull();
  });

  it('the five chips always, the others when they count something; each count is what its filter shows', () => {
    const v = routeView('R1', {
      deliveries: [
        ...routeView().deliveries,
        delivery({ no: 5, status: 'NOT_DELIVERED', statusText: 'Not delivered', reason: 'Shop closed (as reported by the driver)' }),
        delivery({ no: 6, status: 'VISITED', statusText: 'Truck was there' }),
        delivery({ no: 7, status: 'PARTLY_DELIVERED', statusText: 'Partly delivered', delivered: { cases: 4, of: 70 } }),
      ],
      offTruck: [offTruck(), offTruck({ kind: 'MOVED', kindText: 'Moved', why: 'Moved to Tue 20 Oct' }), offTruck({ kind: 'NOT_PLANNED_YET', kindText: 'Not planned yet' })],
    });
    const chips = summaryChips(v);
    expect(chips.map((c) => `${c.key}:${c.n}`)).toEqual(['delivered:2', 'onTheWay:2', 'delayed:1', 'notDelivered:1', 'cancelled:1', 'planned:1', 'noResult:1', 'moved:1', 'notOnTruck:1']);
    for (const c of chips) {
      const f = filterView(v, c.key);
      expect(f.deliveries.length + f.offTruck.length, c.key).toBe(c.n);
    }
    expect(filterView(v, null)).toEqual({ deliveries: v.deliveries, offTruck: v.offTruck });
    const quiet = summaryChips(routeView('R1', { deliveries: [delivery({ no: 1 })], offTruck: [] }));
    expect(quiet.map((c) => c.key)).toEqual(['delivered', 'onTheWay', 'delayed', 'notDelivered', 'cancelled', 'planned']);
    // A delivery done is never "delayed", whatever its last time said.
    const done = delivery({ no: 1, status: 'DELIVERED', eta: { expected: '10:00', source: 'TRIP', timing: 'LATE', lateMin: 30, earlyMin: null, text: '' } });
    expect(summaryChips(routeView('R1', { deliveries: [done], offTruck: [] })).find((c) => c.key === 'delayed')?.n).toBe(0);
  });

  it('never "today" over the orders not on a truck (the link may be tomorrow\'s); a route only "not planned yet" says so calmly', () => {
    expect(UI.offTruck).toBe('Not on a truck');
    const notYet = offTruck({ kind: 'NOT_PLANNED_YET', kindText: 'Not planned yet', why: 'Not planned yet - the plan is made the evening before' });
    expect(noDeliveriesText(routeView('R1', { deliveries: [], offTruck: [notYet, notYet] }))).toBe('Not planned yet - the plan is usually made the evening before. Check again later.');
    expect(noDeliveriesText(routeView('R1', { deliveries: [], offTruck: [notYet, offTruck()] }))).toBe('No deliveries on a truck for this route.');
    expect(noDeliveriesText(routeView('R1', { deliveries: [], offTruck: [] }))).toBe('No deliveries on a truck for this route.');
  });

  it('only the routes found are followed: an unknown code is never asked again', () => {
    expect(followQuery(lookup([routeView('R1'), routeView('R2X')], { asked: ['R1', 'R2X', 'R9'], notFound: ['R9'] }))).toBe('R1, R2X');
    expect(followQuery(lookup([], { asked: ['R9'], notFound: ['R9'] }))).toBeNull();
    expect(followQuery(null)).toBeNull();
  });

  it('"Send to customer" opens WhatsApp with the text and no number', () => {
    const text = 'Customer A: your delivery (invoice INV-1) is on the way, expected about 10:45 today.';
    const url = shareUrl(text);
    expect(url.startsWith('https://wa.me/?text=')).toBe(true);
    expect(decodeURIComponent(url.slice('https://wa.me/?text='.length))).toBe(text);
  });
});

describe('the map', () => {
  it('draws the deliveries still to come with a pin, numbered, no names, and the trucks the server places', () => {
    const v = routeView();
    const m = mapModel(v);
    expect(m.pins.map((p) => p.no)).toEqual([2, 3]);
    for (const p of m.pins) expect(p.text).not.toMatch(/Customer/);
    expect(m.pins[1]!.text).toBe('No. 3 · On the way · about 10:50');
    expect(m.trucks).toEqual([{ key: 'R1:t1', label: 'T05', lat: 20.101, lng: 55.102, stale: false, moving: true, text: 'T05 · Updated 10:29' }]);
    for (const s of DONE_STATUSES) expect(mapModel(routeView('R1', { deliveries: [delivery({ no: 1, status: s })] })).pins).toEqual([]);
    expect(mapModel(routeView('R1', { deliveries: [delivery({ no: 1, pin: { lat: 95, lng: 55 } })] })).pins).toEqual([]);
  });

  it('a refresh that only moves a truck keeps the fit; another route or other pins fit again', () => {
    const a = mapModel(routeView());
    const moved = mapModel(routeView('R1', { trucks: [truck({ position: { ...truck().position!, lat: 20.2, lng: 55.3 } })] }));
    expect(moved.fitKey).toBe(a.fitKey);
    expect(mapModel(routeView('R2X')).fitKey).not.toBe(a.fitKey);
    const fewer = routeView();
    fewer.deliveries = fewer.deliveries.filter((d) => d.no !== 3);
    expect(mapModel(fewer).fitKey).not.toBe(a.fitKey);
  });

  it('no map card without a truck position and without a delivery to come on the map', () => {
    expect(hasMapContent(routeView())).toBe(true);
    expect(hasMapContent(routeView('R1', { trucks: [truck({ position: null })], deliveries: [delivery({ no: 1, status: 'DELIVERED' })] }))).toBe(false);
  });

  it('checks WebGL before loading MapLibre, and lets the test context go', () => {
    const lose = vi.fn();
    const ctx = { getExtension: (n: string) => (n === 'WEBGL_lose_context' ? { loseContext: lose } : null) };
    expect(webglAvailable({ createElement: () => ({ getContext: (k: string) => (k === 'webgl' ? ctx : null) }) as unknown as HTMLCanvasElement })).toBe(true);
    expect(lose).toHaveBeenCalledTimes(1);
    expect(webglAvailable({ createElement: () => ({ getContext: () => null }) as unknown as HTMLCanvasElement })).toBe(false);
    expect(
      webglAvailable({
        createElement: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe(false);
    expect(webglAvailable(null)).toBe(false);
  });

  it('without WebGL: the truck positions as text with an Open in Maps link', () => {
    const tree = MapFallback({ trucks: mapModel(routeView()).trucks, pins: 2 });
    expect(textOf(tree)).toMatch(/The map cannot be shown on this phone/);
    expect(textOf(tree)).toMatch(/T05 · Updated 10:29/);
    expect(textOf(tree)).toMatch(/2 deliveries still to come/);
    const link = elements(tree).find((e) => e.type === 'a');
    expect(link?.props.href).toBe('https://www.google.com/maps/search/?api=1&query=20.101,55.102');
    expect(link?.props.rel).toMatch(/noreferrer/);
  });
});

describe('the cards', () => {
  it('a delivery not delivered: the reason as the driver reported it, the cases, the trip and stop, and Send to customer', () => {
    const d = delivery({
      no: 5,
      status: 'NOT_DELIVERED',
      statusText: 'Not delivered',
      detailText: 'Not delivered (10:31)',
      at: '10:31',
      delivered: { cases: 0, of: 50 },
      reason: 'Shop closed (as reported by the driver)',
      loadNo: 2,
      stopNo: 3,
      stopsOnTrip: 9,
      shareText: 'Customer E: your delivery (invoice INV-5) could not be delivered on Mon 19 Oct. We will contact you.',
    });
    const tree = DeliveryCard({ d, rowKey: 'R1:d5' });
    const text = textOf(tree);
    expect(text).toMatch(/Not delivered \(10:31\)/);
    expect(text).toMatch(/Reason: Shop closed \(as reported by the driver\)/);
    expect(text).toMatch(/50 cases - none delivered · T05 · Trip 2 · stop 3 of 9/);
    expect(text).toMatch(/TST0005 · Invoice INV-5/);
    const share = elements(tree).find((e) => e.props?.['data-testid'] === 'delivery-share');
    expect(share?.props.href).toBe(`https://wa.me/?text=${encodeURIComponent(d.shareText)}`);
    expect(share?.props.target).toBe('_blank');
    expect(share?.props.rel).toMatch(/noreferrer/);
    expect(textOf(share)).toMatch(/Send to customer/);
    expect(tree.props['data-status']).toBe('NOT_DELIVERED');
  });

  it('a delivery on the way: the live time against the window, the late chip, stops before', () => {
    const tree = DeliveryCard({ d: routeView().deliveries[2]!, rowKey: 'R1:d3' });
    const text = textOf(tree);
    expect(text).toMatch(/Late ~20 min/);
    expect(text).toMatch(/Expected about 10:50 \(GPS\) - about 20 min after the window 09:15-10:30 · 1 stop before/);
    expect(text).not.toMatch(/Reason/);
  });

  it('a truck card: its code, the trip, how late, the route\'s next customer, the GPS line', () => {
    const text = textOf(TruckCard({ t: truck({ lateText: 'Running about 20 min behind plan' }), rowKey: 'R1:t1' }));
    expect(text).toMatch(/T05/);
    expect(text).toMatch(/On the road \(trip 1\) since 07:10/);
    expect(text).toMatch(/Running about 20 min behind plan/);
    expect(text).toMatch(/Your next: Customer B · about 09:10 · 1 stop before it/);
    expect(text).toMatch(/GPS: updated 10:29 · on the map below/);
  });

  it('a link that does not work: its own words, and the link\'s day', () => {
    for (const code of Object.keys(LINK_STATE_TEXT) as (keyof typeof LINK_STATE_TEXT)[]) {
      const tree = LinkState({ code, date: code === 'LINK_EXPIRED' ? '2026-10-18' : null });
      expect(textOf(tree)).toContain(LINK_STATE_TEXT[code]);
      expect(tree.props['data-code']).toBe(code);
    }
    expect(textOf(LinkState({ code: 'LINK_EXPIRED', date: '2026-10-18' }))).toMatch(/Link of Sun 18 Oct/);
  });

  it('the answer the page shows carries the day and the company (meta) for the header', () => {
    expect(meta().dayText).toBe('Monday 19 October 2026');
    expect(shortDayText(meta().date)).toBe('Mon 19 Oct');
  });
});
