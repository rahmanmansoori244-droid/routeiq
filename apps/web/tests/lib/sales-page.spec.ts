/**
 * The salesman link's page (owner request 19 Oct 2026; made simple on the owner's feedback of 20 Oct 2026):
 * lib/sales-page/api.ts and format.ts (pure), and the cards of app/s/[token] rendered as element trees (no DOM).
 * Invented data only (sales-page-fixture.ts).
 *
 *  - The token: read from /s/<token> only, sent only in `Authorization: SalesLink`, never in the API's URL; the
 *    request is no-store, same-origin, no-referrer; a network failure or a timeout is "no answer".
 *  - The route from the link's fragment (#R1, critique 20), the browser's saved route, language and random id, every
 *    one surviving a browser that blocks storage.
 *  - Every answer of GET /api/s/view is read as the page needs it: ok, link states full-page (with the link's
 *    date), refused codes on the form, 429 with Retry-After, anything else an error.
 *  - The status buttons: the six the owner asked for always, "not confirmed" and "not in the plan" only when there
 *    are some; each count is what its list shows; every status has readable colours.
 *  - One line per customer: delivered at, x of y cases, "about 16:30 · in about 1 h 20 min" ("any minute" when
 *    close), being delivered now, moved to a day - nothing else (no truck, trip, window, reason, invoice).
 *  - "Send to customer": the customer, the status and the approximate time in the page's language; no link, no
 *    number; none for an order not on a truck.
 *  - Only the routes and trucks FOUND are followed, never more than 5 codes.
 *  - The cards: a customer, the status buttons, the trucks offered for a code, a link that does not work, the
 *    language switch.
 */
import { describe, expect, it } from 'vitest';
import tailwindColors from 'tailwindcss/colors';
import { DEVICE_KEY, LANG_KEY, ROUTE_KEY, deviceId, fetchSalesView, forgetRoute, readSalesAnswer, routeFromHash, saveLang, saveRoute, savedLang, savedRoute, salesHeaders, tokenFromPath, viewUrl, type KeyStore } from '@/lib/sales-page/api';
import {
  allNotPlannedYet,
  busyText,
  choiceText,
  codeText,
  customerText,
  followQuery,
  isFutureDay,
  noticeText,
  pageTitle,
  problemText,
  rowLine,
  rowsOf,
  shareText,
  shareUrl,
  shortDayText,
  staleText,
  STATUS_BUTTON,
  STATUS_CHIP,
  STATUS_EDGE,
  STATUS_ORDER,
  statusButtons,
  statusLabel,
  tabText,
  untilText,
  viewTitle,
} from '@/lib/sales-page/format';
import { aboutText, SALES_DICT, st, type SalesKey } from '@/lib/sales-page/i18n';
import { SALES_STATE_TEXT } from '@/lib/sales-link/service';
import { MAX_CODES, parseRouteQuery } from '@/lib/sales-link/route-code';
import { SALES_PAGE_HEADER, SALES_PAGE_VERSION } from '@/lib/sales-link/page-version';
import { shortDayText as serverShortDay } from '@/lib/sales-link/text';
import type { SalesLinkStateCode, SalesStatus } from '@/lib/sales-link/view-types';
import { RowCard } from '@/app/s/[token]/row-card';
import { StatusGrid } from '@/app/s/[token]/status-grid';
import { LinkState } from '@/app/s/[token]/link-state';
import { ChoiceList } from '@/app/s/[token]/choice-list';
import { LangSwitch } from '@/app/s/[token]/lang-switch';
import { elements, textOf } from './hook-host';
import { TOKEN, answer, lookup, meta, routeView, row, truckView } from './sales-page-fixture';

const ALL: SalesStatus[] = ['DELIVERED', 'PARTLY_DELIVERED', 'NOT_DELIVERED', 'NOT_CONFIRMED', 'ON_THE_WAY', 'DELAYED', 'CANCELLED', 'NOT_IN_PLAN'];
const ARABIC = /[؀-ۿ]/;
const ISOLATES = /[⁦-⁩]/g;
const plain = (s: string | null) => (s ?? '').replace(ISOLATES, '');

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

  it("reads the route of the link's fragment: #R1, encoded spaces and commas, nothing for an empty or a too long one", () => {
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

  it("keeps the route found, the language and the random id under its own keys (never the driver page's), and works when storage is blocked", () => {
    const s = memoryStore();
    expect(savedRoute(s)).toBeNull();
    saveRoute('R1, R2X', s);
    expect(s.data[ROUTE_KEY]).toBe('R1, R2X');
    expect(savedRoute(s)).toBe('R1, R2X');
    forgetRoute(s);
    expect(savedRoute(s)).toBeNull();
    expect([ROUTE_KEY, DEVICE_KEY, LANG_KEY]).toEqual(['riq.s.route', 'riq.s.device', 'riq.s.lang']);
    expect(savedLang(s)).toBeNull();
    saveLang('ur', s);
    expect(savedLang(s)).toBe('ur');

    const id = deviceId(s);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(deviceId(s)).toBe(id);
    s.data[DEVICE_KEY] = 'not-hex';
    expect(deviceId(s)).not.toBe('not-hex');

    expect(() => saveRoute('R1', blocked)).not.toThrow();
    expect(() => forgetRoute(blocked)).not.toThrow();
    expect(() => saveLang('ar', blocked)).not.toThrow();
    expect(savedRoute(blocked)).toBeNull();
    expect(savedLang(blocked)).toBeNull();
    const a = deviceId(blocked);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(deviceId(blocked)).toBe(a);
    expect(deviceId(null)).toBe(a);
  });

  it('asks a token-free path; the token travels only in the header', () => {
    expect(viewUrl(null)).toBe('/api/s/view');
    expect(viewUrl('R1, R2X')).toBe('/api/s/view?route=R1%2C%20R2X');
    expect(salesHeaders(TOKEN, 'ab'.repeat(16))).toEqual({ Authorization: `SalesLink ${TOKEN}`, 'X-Sales-Device': 'ab'.repeat(16), 'X-Sales-Page': '2', Accept: 'application/json' });
    // The page's version (review of 20 Oct 2026): an older page open since before a deploy is told to reopen the link.
    expect([SALES_PAGE_HEADER, SALES_PAGE_VERSION]).toEqual(['X-Sales-Page', 2]);
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
    expect(a.kind === 'ok' && a.answer.lookup?.results[0]?.code).toBe('R1');
    expect(readSalesAnswer(200, { data: {}, error: null }, null).kind).toBe('error');
  });

  it("the link states are full-page, with the link's date when the server gives it", () => {
    expect(readSalesAnswer(404, fail('LINK_NOT_FOUND'), null)).toEqual({ kind: 'link', status: 404, code: 'LINK_NOT_FOUND', date: null });
    expect(readSalesAnswer(410, fail('LINK_REPLACED', { date: '2026-10-19' }), null)).toEqual({ kind: 'link', status: 410, code: 'LINK_REPLACED', date: '2026-10-19' });
    expect(readSalesAnswer(410, fail('LINK_REVOKED', { date: '2026-10-19' }), null)).toMatchObject({ code: 'LINK_REVOKED' });
    expect(readSalesAnswer(410, fail('LINK_EXPIRED', { date: '2026-10-18' }), null)).toMatchObject({ code: 'LINK_EXPIRED', date: '2026-10-18' });
    expect(readSalesAnswer(503, fail('SALES_LINKS_OFF'), null)).toMatchObject({ kind: 'link', code: 'SALES_LINKS_OFF' });
    expect(readSalesAnswer(403, fail('SIGNED_IN_OTHER_TENANT'), null)).toMatchObject({ kind: 'link', code: 'SIGNED_IN_OTHER_TENANT' });
    // A proxy's or the platform's own 404 / 410 / 503 page (no code: a restart, a deploy): an error the page rides out.
    expect(readSalesAnswer(404, '<html>', null)).toEqual({ kind: 'error', status: 404 });
    expect(readSalesAnswer(503, null, null)).toEqual({ kind: 'error', status: 503 });
    expect(readSalesAnswer(410, { data: null, error: { code: 'SOMETHING_ELSE' } }, null)).toEqual({ kind: 'error', status: 410 });
    expect(readSalesAnswer(410, fail('LINK_EXPIRED', { date: 'yesterday' }), null)).toMatchObject({ date: null });
  });

  it('refused codes go to the route form (said by code in the page\'s language)', () => {
    expect(readSalesAnswer(400, { data: null, error: { code: 'ROUTE_CODE_MISSING', message: 'Type your route or truck code.' } }, null)).toMatchObject({ kind: 'badCode', code: 'ROUTE_CODE_MISSING' });
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

  it("the page's English link texts are the server's; the office dialog's day is the server's", () => {
    for (const [code, text] of Object.entries(SALES_STATE_TEXT)) expect(st('en', `link.${code}` as SalesKey)).toBe(text);
    for (const d of ['2026-10-19', '2026-10-20', '2026-12-31', '2027-01-01']) expect(shortDayText(d)).toBe(serverShortDay(d));
  });
});

describe('the status buttons and their colours', () => {
  it('every status has a chip, a button and an edge', () => {
    expect([...STATUS_ORDER].sort()).toEqual([...ALL].sort());
    for (const s of ALL) {
      expect(STATUS_CHIP[s], s).toMatch(/bg-.* text-/);
      expect(STATUS_BUTTON[s], s).toMatch(/bg-.* text-/);
      expect(STATUS_EDGE[s], s).toMatch(/^border-s-/);
    }
  });

  it('every chip and button reads at 4.5:1 or better (WCAG AA for 14 px text, outdoors in the sun)', () => {
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
    for (const [s, tone] of [...Object.entries(STATUS_CHIP), ...Object.entries(STATUS_BUTTON)]) expect(contrast(tone), `${s}: ${tone}`).toBeGreaterThanOrEqual(4.5);
  });

  it('the six the owner asked for always (0 shown), the other two only when they count something; each count is what its list shows', () => {
    const v = routeView();
    expect(statusButtons(v.rows).map((b) => `${b.status}:${b.n}`)).toEqual(['DELIVERED:1', 'ON_THE_WAY:2', 'DELAYED:1', 'PARTLY_DELIVERED:1', 'NOT_DELIVERED:0', 'CANCELLED:1']);
    const more = [...v.rows, row({ key: 'd9', status: 'NOT_CONFIRMED' }), row({ key: 'o2', status: 'NOT_IN_PLAN', off: 'MOVED', movedTo: '2026-10-21' })];
    const buttons = statusButtons(more);
    expect(buttons.map((b) => b.status)).toEqual(['DELIVERED', 'ON_THE_WAY', 'DELAYED', 'PARTLY_DELIVERED', 'NOT_DELIVERED', 'CANCELLED', 'NOT_CONFIRMED', 'NOT_IN_PLAN']);
    for (const b of buttons) expect(rowsOf(more, b.status).length, b.status).toBe(b.n);
    expect(rowsOf(more, null)).toEqual(more);
    expect(buttons.reduce((t, b) => t + b.n, 0)).toBe(more.length);
  });

  it('the one picked stays even at 0 (review of 20 Oct 2026: a refresh emptied "Not confirmed yet" and no button was pressed)', () => {
    const v = routeView();
    expect(statusButtons(v.rows, 'NOT_CONFIRMED').map((b) => `${b.status}:${b.n}`)).toEqual(['DELIVERED:1', 'ON_THE_WAY:2', 'DELAYED:1', 'PARTLY_DELIVERED:1', 'NOT_DELIVERED:0', 'CANCELLED:1', 'NOT_CONFIRMED:0']);
    expect(statusButtons(v.rows, 'NOT_IN_PLAN').map((b) => b.status)).toContain('NOT_IN_PLAN');
    expect(statusButtons(v.rows, 'DELAYED')).toEqual(statusButtons(v.rows));
    expect(statusButtons(v.rows, null)).toEqual(statusButtons(v.rows));
  });

  it("tomorrow's link (the evening before): the On the way button and chip read Planned, in every language; nothing else changes", () => {
    expect(statusLabel('en', 'ON_THE_WAY', true)).toBe('Planned');
    expect(statusLabel('en', 'ON_THE_WAY')).toBe('On the way');
    expect([statusLabel('ar', 'ON_THE_WAY', true), statusLabel('ur', 'ON_THE_WAY', true)]).toEqual(['مجدول', 'پلان شدہ']);
    for (const s of ALL.filter((x) => x !== 'ON_THE_WAY')) for (const lang of ['en', 'ar', 'ur'] as const) expect(statusLabel(lang, s, true)).toBe(statusLabel(lang, s));
  });

  it('a route only "not planned yet" (its depot plans the evening before) says so calmly', () => {
    const notYet = row({ key: 'o1', status: 'NOT_IN_PLAN', off: 'NOT_PLANNED_YET' });
    expect(allNotPlannedYet([notYet, { ...notYet, key: 'o2' }])).toBe(true);
    expect(allNotPlannedYet([notYet, row({ key: 'o2', status: 'CANCELLED' })])).toBe(false);
    expect(allNotPlannedYet([])).toBe(false);
  });
});

describe('one line per customer, in the page\'s language', () => {
  const v = routeView();
  const r = (key: string) => v.rows.find((x) => x.key === key)!;

  it('delivered at, x of y cases, being delivered now, about when and how far; nothing for the rest', () => {
    expect(rowLine('en', r('d1'))).toBe('at 08:10');
    expect(rowLine('en', r('d2'))).toBe('18 of 24 cases');
    expect(rowLine('en', r('d3'))).toBe('Being delivered now');
    expect(rowLine('en', r('d4'))).toBe('about 11:50 · in about 1 h 20 min');
    expect(rowLine('en', r('d5'))).toBe('about 12:30 · in about 2 h');
    expect(rowLine('en', r('o1'))).toBeNull();
    expect(rowLine('en', row({ key: 'x', status: 'NOT_DELIVERED' }))).toBeNull();
    expect(rowLine('en', row({ key: 'x', status: 'NOT_CONFIRMED' }))).toBeNull();
    // The evening before: the planned time without minutes; no time to give: nothing.
    expect(rowLine('en', row({ key: 'x', eta: '08:05', inMin: null }))).toBe('about 08:05');
    expect(rowLine('en', row({ key: 'x', status: 'DELAYED' }))).toBeNull();
    expect(rowLine('en', row({ key: 'x', status: 'NOT_IN_PLAN', off: 'MOVED', movedTo: '2026-10-21' }))).toBe('Moved to Wed 21 Oct');
    expect(rowLine('en', row({ key: 'x', status: 'NOT_IN_PLAN', off: 'NOT_PLANNED_YET' }))).toBe('Not planned yet');
    expect(rowLine('en', row({ key: 'x', status: 'NOT_IN_PLAN', off: 'NOT_IN_PLAN' }))).toBeNull();
    expect(customerText(r('d4'))).toBe('Customer D (B2)');
  });

  it("tomorrow's link (the evening before): a delivery still to come says its day with the time (review of 20 Oct 2026: a bare time read as today)", () => {
    const tomorrow = { future: true, date: '2026-10-21' };
    const planned = row({ key: 'x', eta: '09:30' });
    expect(rowLine('en', planned, tomorrow)).toBe('Wed 21 Oct, about 09:30');
    expect(rowLine('en', row({ key: 'x' }), tomorrow)).toBe('On Wed 21 Oct');
    expect(plain(rowLine('ar', planned, tomorrow))).toBe('يوم الأربعاء، 21 أكتوبر حوالي الساعة 09:30');
    expect(plain(rowLine('ur', planned, tomorrow))).toBe('بدھ، 21 اکتوبر کو تقریباً 09:30 بجے');
    for (const lang of ['ar', 'ur'] as const) expect(rowLine(lang, planned, tomorrow), lang).toContain('⁨09:30⁩');
    // On the delivery day: the time (and how far) as before; results never change with the day.
    expect(rowLine('en', planned, { future: false, date: '2026-10-21' })).toBe('about 09:30');
    expect(rowLine('en', r('d1'), tomorrow)).toBe('at 08:10');
    expect(rowLine('en', r('d3'), tomorrow)).toBe('Being delivered now');
  });

  it('how far: "any minute" under 10 min, to 5 min under an hour, then to 10 min', () => {
    expect([0, 9, 10, 23, 58, 80, 124, 125, 600].map((m) => aboutText('en', m))).toEqual([
      'any minute',
      'any minute',
      'in about 10 min',
      'in about 25 min',
      'in about 1 h',
      'in about 1 h 20 min',
      'in about 2 h',
      'in about 2 h 10 min',
      'in about 10 h',
    ]);
    expect(rowLine('en', row({ key: 'x', eta: '10:35', inMin: 4 }))).toBe('about 10:35 · any minute');
  });

  it('Arabic and Urdu: their own words, the time kept left to right inside right-to-left text (Western digits)', () => {
    for (const lang of ['ar', 'ur'] as const) {
      const line = rowLine(lang, r('d4'))!;
      expect(line, lang).toMatch(ARABIC);
      expect(line, lang).toContain('⁨11:50⁩');
      expect(plain(line), lang).not.toMatch(/[٠-٩۰-۹]/);
      expect(plain(line), lang).toMatch(/1.*20/);
    }
    expect(plain(rowLine('ar', r('d4')))).toBe('حوالي الساعة 11:50 · بعد حوالي 1 س 20 د');
    expect(plain(rowLine('ur', r('d4')))).toBe('تقریباً 11:50 بجے · تقریباً 1 گھنٹہ 20 منٹ میں');
    expect(plain(rowLine('ur', r('d5')))).toBe('تقریباً 12:30 بجے · تقریباً 2 گھنٹے میں');
    expect(plain(rowLine('ar', r('d2')))).toBe('الكراتين: 18 من 24');
  });
});

describe('"Send to customer": the customer, the status and the approximate time', () => {
  const v = routeView();
  const r = (key: string) => v.rows.find((x) => x.key === key)!;
  const today = { future: false, date: '2026-10-19' };

  it('one short text per status; never a link, an invoice, a truck or a reason; none for an order not on a truck', () => {
    const en = (x: Parameters<typeof shareText>[1], o = today) => plain(shareText('en', x, o));
    expect(en(r('d1'))).toBe('Customer A: your order was delivered at 08:10.');
    expect(en(r('d2'))).toBe('Customer B: part of your order was delivered (18 of 24 cases). We will contact you about the rest.');
    expect(en(r('d3'))).toBe('Customer C: your order is being delivered now.');
    // Delayed or not, the customer is told the approximate time only (the owner: no reason).
    expect(en(r('d4'))).toBe('Customer D (B2): your order is on the way, expected at about 11:50.');
    expect(en(r('d5'), { future: true, date: '2026-10-19' })).toBe('Customer E: your order is planned for Mon 19 Oct, at about 12:30.');
    expect(en(row({ key: 'x', customer: 'Customer X', status: 'NOT_DELIVERED' }))).toBe('Customer X: your order could not be delivered. We will contact you.');
    expect(en(row({ key: 'x', customer: 'Customer X', status: 'NOT_CONFIRMED' }))).toBe('Customer X: we are checking your delivery and will contact you.');
    expect(en(row({ key: 'x', customer: 'Customer X', status: 'DELAYED' }))).toBe('Customer X: your order is on the way.');
    expect(shareText('en', r('o1'), today)).toBeNull();
    expect(shareText('en', row({ key: 'o2', status: 'NOT_IN_PLAN', off: 'MOVED', movedTo: '2026-10-21' }), today)).toBeNull();
    for (const x of v.rows) for (const lang of ['en', 'ar', 'ur'] as const) expect(shareText(lang, x, today) ?? '').not.toMatch(/https?:|wa\.me|\/s\/|invoice|INV-|truck|late|delay/i);
  });

  it('in Arabic and Urdu, with the customer\'s name and the time isolated', () => {
    const ar = shareText('ar', r('d4'), today)!;
    expect(ar).toMatch(ARABIC);
    expect(ar).toContain('⁨Customer D (B2)⁩');
    expect(ar).toContain('⁨11:50⁩');
    expect(plain(shareText('ur', r('d1'), today))).toBe('Customer A: آپ کا آرڈر 08:10 بجے ڈیلیور ہو گیا۔');
  });

  it('in English the name is isolated too: a name stored in Arabic never turns the message right to left (review of 20 Oct 2026)', () => {
    const arabicName = row({ key: 'x', customer: 'مؤسسة النور', status: 'ON_THE_WAY', eta: '13:05', inMin: 30 });
    const text = shareText('en', arabicName, today)!;
    expect(text).toBe('⁨مؤسسة النور⁩: your order is on the way, expected at about 13:05.');
    // The paragraph's direction is its first strong letter outside an isolate (Unicode bidi P2): Latin, so left to right.
    const firstStrong = text.replace(/⁨[^⁩]*⁩/g, '').match(/[A-Za-z\u0590-\u08FF]/)?.[0];
    expect(firstStrong).toMatch(/[A-Za-z]/);
    for (const x of v.rows) expect(shareText('en', x, today) ?? '⁨', x.key).toMatch(/^⁨/);
    // Arabic and Urdu isolate it once (i18n.ts), not twice.
    expect(shareText('ar', arabicName, today)).toMatch(/^⁨مؤسسة النور⁩:/);
  });

  it('opens WhatsApp with the text and no number', () => {
    const text = shareText('en', r('d4'), today)!;
    const url = shareUrl(text);
    expect(url.startsWith('https://wa.me/?text=')).toBe(true);
    expect(decodeURIComponent(url.slice('https://wa.me/?text='.length))).toBe(text);
  });
});

describe('the header, the form and the notices', () => {
  it('titles, the date ahead of the company\'s today, the link\'s end, busy and stale lines', () => {
    expect(viewTitle('en', routeView('C1'))).toBe('Route C1');
    expect(viewTitle('en', truckView('1234-AB'))).toBe('Truck 1234-AB');
    expect(plain(viewTitle('ar', truckView('1234-AB')))).toBe('الشاحنة 1234-AB');
    expect(tabText('en', routeView('R2X'))).toBe('Route R2X · 6');
    expect(isFutureDay(meta())).toBe(false);
    expect(isFutureDay(meta({ date: '2026-10-20' }))).toBe(true);
    // 21:30 company time the evening before is still the day before.
    expect(isFutureDay(meta({ date: '2026-10-20', serverNow: '2026-10-19T17:30:00.000Z' }))).toBe(true);
    expect(untilText('en', meta())).toBe('Works until Tue 20 Oct 06:00. For the sales team only - please do not forward.');
    expect(busyText('en', 30)).toBe('Too many requests. Trying again in 30 s.');
    expect(busyText('en', null)).toBe('Too many requests. Trying again in a minute.');
    expect(staleText('en', '10:30')).toBe('Could not refresh - showing the data of 10:30. Trying again every minute.');
  });

  it('every problem of the route form and the notice above the results', () => {
    expect(problemText('en', { kind: 'CODE', code: 'ROUTE_CODE_MISSING' }, null)).toBe('Type your route code.');
    expect(problemText('en', { kind: 'CODE', code: 'TOO_MANY_CODES' }, null)).toBe('At most 5 codes at once.');
    expect(problemText('en', { kind: 'CODE', code: 'ROUTE_CODE_TOO_LONG' }, null)).toBe('That code is too long.');
    expect(problemText('en', { kind: 'NOT_FOUND', codes: ['R9', 'TRUCK 9999'] }, '2026-10-19')).toBe('No deliveries for R9, Truck 9999 on Mon 19 Oct. Check the code on your Salesman ETA page.');
    expect(problemText('en', { kind: 'OFFLINE' }, null)).toBe('No connection. Check your signal and try again.');
    expect(problemText('en', { kind: 'SERVER' }, null)).toBe('The server could not answer just now. Try again in a minute.');
    expect(noticeText('en', { notFound: ['R9'], ambiguous: ['R-10'] }, '2026-10-19')).toBe('No deliveries for R9 on Mon 19 Oct. Check the code on your Salesman ETA page. R-10: more than one route or truck has this code - each is shown.');
    expect(noticeText('en', { notFound: [], ambiguous: [] }, null)).toBeNull();
    expect(choiceText('en', { kind: 'SEVERAL_TRUCKS', asked: '1234' })).toBe('1234: more than one truck has this code. Pick one:');
    expect(choiceText('en', { kind: 'ALSO_TRUCK', asked: 'C1' })).toBe('C1 is also a truck code. Show the truck instead:');
    expect(plain(problemText('ur', { kind: 'NOT_FOUND', codes: ['R9'] }, '2026-10-19'))).toMatch(/^پیر، 19 اکتوبر کو R9 کی/);
  });

  it('a truck asked for explicitly is said in the page\'s words, never the server\'s English "TRUCK" (review of 20 Oct 2026)', () => {
    expect(codeText('en', 'TRUCK 1234-AB')).toBe('Truck 1234-AB');
    expect(plain(codeText('ar', 'TRUCK 1234-AB'))).toBe('الشاحنة 1234-AB');
    expect(plain(codeText('ur', 'TRUCK 1234-AB'))).toBe('ٹرک 1234-AB');
    expect(codeText('ar', 'R9')).toBe('R9');
    for (const lang of ['ar', 'ur'] as const) {
      const texts = [
        problemText(lang, { kind: 'NOT_FOUND', codes: ['TRUCK 1234-AB'] }, '2026-10-19'),
        noticeText(lang, { notFound: ['R9', 'TRUCK 1234-AB'], ambiguous: ['TRUCK AB-1'] }, '2026-10-19')!,
        choiceText(lang, { kind: 'SEVERAL_TRUCKS', asked: 'TRUCK 56' }),
      ];
      for (const t of texts) {
        expect(t, lang).not.toMatch(/TRUCK/i);
        expect(t, lang).toContain(lang === 'ar' ? 'الشاحنة' : 'ٹرک');
      }
      expect(plain(texts[0]!), lang).toContain('1234-AB');
    }
    expect(plain(problemText('ar', { kind: 'NOT_FOUND', codes: ['TRUCK 1234-AB'] }, '2026-10-19'))).toBe('لا توجد توصيلات لـ الشاحنة 1234-AB يوم الاثنين، 19 أكتوبر. تحقق من الرمز في ورقة Salesman ETA.');
    expect(choiceText('en', { kind: 'SEVERAL_TRUCKS', asked: 'TRUCK 56' })).toBe('Truck 56: more than one truck has this code. Pick one:');
  });

  it('the title above the page in its language (WhatsApp\'s in-app browser shows it)', () => {
    expect(['en', 'ar', 'ur'].map((l) => pageTitle(l as 'en'))).toEqual(['RouteIQ - Deliveries', 'RouteIQ - التوصيلات', 'RouteIQ - ڈیلیوریاں']);
  });
});

describe('the codes followed', () => {
  it('only the routes found are followed: an unknown code is never asked again', () => {
    expect(followQuery(lookup([routeView('R1'), routeView('R2X')], { asked: ['R1', 'R2X', 'R9'], notFound: ['R9'] }))).toBe('R1, R2X');
    expect(followQuery(lookup([], { asked: ['R9'], notFound: ['R9'] }))).toBeNull();
    expect(followQuery(null)).toBeNull();
    // A truck is followed in the explicit form (owner decision of 20 Oct 2026): a refresh never turns it into a route.
    expect(followQuery(lookup([routeView('C1'), truckView('1234-AB')], { asked: ['C1', '1234'] }))).toBe('C1, Truck 1234-AB');
  });

  it('never more than 5 codes to follow (the server answers 400 TOO_MANY_CODES): with more results, the codes typed that found them', () => {
    // One code typed matched two routes ("R-10": "R 10" and "R10"): six results from five codes.
    const six = lookup(['R1', 'R2', 'R3', 'R4', 'R 10', 'R10'].map((r) => routeView(r)), { asked: ['R1', 'R2', 'R3', 'R4', 'R-10'], ambiguous: ['R-10'] });
    expect(followQuery(six)).toBe('R1, R2, R3, R4, R-10');
    // A code that matched nothing, or only offered trucks (none shown), is not followed.
    const several = { asked: 'AB1', kind: 'SEVERAL_TRUCKS' as const, options: [{ code: 'AB-1', query: 'Truck AB-1' }, { code: 'AB.1', query: 'Truck AB.1' }] };
    const mixed = lookup(['R 10', 'R10', 'R 20', 'R20', 'R 30', 'R30'].map((r) => routeView(r)), { asked: ['R-10', 'R-20', 'R9', 'R-30', 'AB1'], notFound: ['R9'], ambiguous: ['R-10', 'R-20', 'R-30'], choices: [several] });
    expect(followQuery(mixed)).toBe('R-10, R-20, R-30');
    // The same code twice (two trucks whose codes differ in letter case: "Truck ab-1" is "Truck AB-1") is asked once.
    const twice = lookup([routeView('R1'), truckView('ab-1'), truckView('AB-1')], { asked: ['R1', 'AB-1'], ambiguous: ['AB-1'] });
    expect(followQuery(twice)).toBe('R1, Truck ab-1');
    for (const l of [six, mixed, twice, lookup([routeView('R1'), truckView('1234-AB')])]) {
      const q = parseRouteQuery(followQuery(l));
      expect(q.ok).toBe(true);
      expect(q.ok && q.codes.length).toBeLessThanOrEqual(MAX_CODES);
    }
  });
});

describe('the cards', () => {
  const v = routeView();
  const r = (key: string) => v.rows.find((x) => x.key === key)!;

  it('a customer: the name and branch, one status, one line, and Send to customer', () => {
    const tree = RowCard({ lang: 'en', r: r('d4'), rowKey: 'R1:d4', future: false, date: '2026-10-19' });
    expect(textOf(tree)).toBe('Customer D (B2)Delayedabout 11:50 · in about 1 h 20 min Send to customer');
    expect(tree.props['data-status']).toBe('DELAYED');
    const share = elements(tree).find((e) => e.props?.['data-testid'] === 'row-share');
    expect(share?.props.href).toBe(shareUrl('⁨Customer D (B2)⁩: your order is on the way, expected at about 11:50.'));
    // The name: no direction of its own on the paragraph (a long name wraps on the page's start side, review of 20
    // Oct 2026); <bdi> keeps the name in its own direction.
    const name = elements(tree).find((e) => e.props?.['data-testid'] === 'row-customer')!;
    expect(name.props.dir).toBeUndefined();
    expect(elements(name).map((e) => e.type)).toEqual(['p', 'bdi']);
    expect(share?.props.target).toBe('_blank');
    expect(share?.props.rel).toMatch(/noreferrer/);
    // A cancelled order: its status only, nothing to send.
    const cancelled = RowCard({ lang: 'en', r: r('o1'), rowKey: 'R1:o1', future: false, date: '2026-10-19' });
    expect(textOf(cancelled)).toBe('Customer ZCancelled');
    expect(elements(cancelled).some((e) => e.props?.['data-testid'] === 'row-share')).toBe(false);
    // In Urdu.
    expect(plain(textOf(RowCard({ lang: 'ur', r: r('d1'), rowKey: 'R1:d1', future: false, date: '2026-10-19' })))).toContain('ڈیلیور ہو گیا08:10 بجے');
  });

  it('the status buttons: "All" with every customer, then each status with its count; a tap picks it, a second tap shows all; 0 cannot be picked', () => {
    const picked: (SalesStatus | null)[] = [];
    const buttons = statusButtons(v.rows);
    const tree = StatusGrid({ lang: 'en', buttons, total: v.rows.length, active: null, onPick: (s) => picked.push(s) });
    const all = elements(tree).find((e) => e.props?.['data-testid'] === 'status-all')!;
    expect(textOf(all)).toBe('All6');
    expect(all.props['aria-pressed']).toBe(true);
    const els = elements(tree).filter((e) => /^status-[A-Z_]+$/.test(e.props?.['data-testid'] ?? ''));
    expect(els.map((e) => textOf(e))).toEqual(['1Delivered', '2On the way', '1Delayed', '1Partly delivered', '0Not delivered', '1Cancelled']);
    expect(els.find((e) => e.props['data-testid'] === 'status-NOT_DELIVERED')!.props.disabled).toBe(true);
    els.find((e) => e.props['data-testid'] === 'status-DELAYED')!.props.onClick();
    const on = StatusGrid({ lang: 'en', buttons, total: v.rows.length, active: 'DELAYED', onPick: (s) => picked.push(s) });
    const delayed = elements(on).find((e) => e.props?.['data-testid'] === 'status-DELAYED')!;
    expect(delayed.props['aria-pressed']).toBe(true);
    delayed.props.onClick();
    expect(picked).toEqual(['DELAYED', null]);
    expect(textOf(StatusGrid({ lang: 'ar', buttons, total: 6, active: null, onPick: () => undefined }))).toMatch(/الكل6.*تم التسليم.*في الطريق.*متأخر.*تسليم جزئي.*لم يتم التسليم.*ملغى/);
  });

  it('the trucks offered for a code: one button each, sending its whole lookup', () => {
    const picked: string[] = [];
    const choices = [
      { asked: '1234', kind: 'SEVERAL_TRUCKS' as const, options: [{ code: '1234-AB', query: 'Truck 1234-AB' }, { code: '1234-CD', query: 'Truck 1234-CD' }] },
      { asked: 'C1', kind: 'ALSO_TRUCK' as const, options: [{ code: 'C-1', query: 'R2X, Truck C-1' }] },
    ];
    const tree = ChoiceList({ lang: 'en', choices, working: false, onPick: (q) => picked.push(q) })!;
    expect(textOf(tree)).toMatch(/1234: more than one truck has this code\. Pick one:.*Truck 1234-AB.*Truck 1234-CD.*C1 is also a truck code/);
    const buttons = elements(tree).filter((e) => e.props?.['data-testid'] === 'choice-option');
    expect(buttons.map((b) => b.props['data-query'])).toEqual(['Truck 1234-AB', 'Truck 1234-CD', 'R2X, Truck C-1']);
    for (const b of buttons) b.props.onClick();
    expect(picked).toEqual(['Truck 1234-AB', 'Truck 1234-CD', 'R2X, Truck C-1']);
    expect(ChoiceList({ lang: 'en', choices: [], working: false, onPick: () => undefined })).toBeNull();
    expect(textOf(ChoiceList({ lang: 'ar', choices, working: false, onPick: () => undefined }))).toMatch(ARABIC);
  });

  it("a link that does not work: its own words in the page's language, and the link's day", () => {
    for (const code of Object.keys(SALES_STATE_TEXT) as SalesLinkStateCode[]) {
      for (const lang of ['en', 'ar', 'ur'] as const) {
        const tree = LinkState({ lang, code, date: null });
        expect(textOf(tree)).toBe(SALES_DICT[lang][`link.${code}` as SalesKey]);
        expect(tree.props['data-code']).toBe(code);
      }
    }
    expect(textOf(LinkState({ lang: 'en', code: 'LINK_EXPIRED', date: '2026-10-18' }))).toMatch(/Link of Sun 18 Oct/);
    expect(plain(textOf(LinkState({ lang: 'ar', code: 'LINK_EXPIRED', date: '2026-10-18' })))).toMatch(/رابط يوم الأحد، 18 أكتوبر/);
  });

  it('the language switch: English, Arabic and Urdu each in its own script, the one in use pressed', () => {
    const picked: string[] = [];
    const tree = LangSwitch({ lang: 'ur', onPick: (l) => picked.push(l) });
    const buttons = elements(tree).filter((e) => e.type === 'button');
    expect(buttons.map((b) => [textOf(b), b.props.lang, b.props.dir, b.props['aria-pressed']])).toEqual([
      ['English', 'en', 'ltr', false],
      ['العربية', 'ar', 'rtl', false],
      ['اردو', 'ur', 'rtl', true],
    ]);
    for (const b of buttons) b.props.onClick();
    expect(picked).toEqual(['en', 'ar', 'ur']);
    // 44 px at least, like every button of the page (review of 20 Oct 2026), and apart enough for a thumb.
    for (const b of buttons) expect(String(b.props.className).split(/\s+/)).toEqual(expect.arrayContaining(['min-h-11', 'min-w-11']));
    expect(String(tree.props.className).split(/\s+/)).toContain('gap-1.5');
    expect(tree.props.dir).toBe('ltr');
  });
});
