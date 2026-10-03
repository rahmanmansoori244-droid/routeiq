/**
 * The driver page's words (owner request 4 Oct 2026, spec section 6.4): English and Arabic have the
 * same keys and the same {placeholders}, nothing is empty, every Arabic text has Arabic letters,
 * and every reason, load status and photo position has a label. Plus the small page helpers.
 */
import { describe, expect, it } from 'vitest';
import { DICT, fmtDate, fmtHours, hhmm, LANG_TOGGLE, pickLang, placeholders, positionLabel, reasonLabel, statusLabel, t, type Key } from '@/lib/driver-page/i18n';
import { NOT_DELIVERED_REASONS, PHOTO_POSITION_STATUSES, type LoadStatusName } from '@/lib/driver-link/manifest-types';
import { LOAD_STATUS_NAMES } from '@/lib/audit-catalog';
import { openTripIndex, stopTitle, telHref, tripLine } from '@/lib/driver-page/format';
import { readManifestAnswer, tokenFromPath, deviceId, driverHeaders } from '@/lib/driver-page/api';
import { NotDeliveredReason, PhotoPositionStatus } from '@prisma/client';

const ARABIC = /[؀-ۿ]/;

describe('the dictionary', () => {
  it('English and Arabic have identical keys', () => {
    expect(Object.keys(DICT.ar).sort()).toEqual(Object.keys(DICT.en).sort());
  });

  it('no empty text, every Arabic text has an Arabic letter', () => {
    for (const lang of ['en', 'ar'] as const) for (const [k, v] of Object.entries(DICT[lang])) expect(v.trim(), `${lang}.${k}`).not.toBe('');
    for (const [k, v] of Object.entries(DICT.ar)) expect(ARABIC.test(v), `ar.${k}: ${v}`).toBe(true);
  });

  it('placeholders match per key', () => {
    for (const k of Object.keys(DICT.en) as Key[]) expect(placeholders(DICT.ar[k]), k).toEqual(placeholders(DICT.en[k]));
  });

  it('every NotDeliveredReason, LoadStatus and PhotoPositionStatus has a label in both languages', () => {
    // The browser-safe lists match the database enums.
    expect([...NOT_DELIVERED_REASONS].sort()).toEqual(Object.values(NotDeliveredReason).sort());
    expect([...PHOTO_POSITION_STATUSES].sort()).toEqual(Object.values(PhotoPositionStatus).sort());
    for (const lang of ['en', 'ar'] as const) {
      for (const r of NOT_DELIVERED_REASONS) expect(reasonLabel(lang, r)).not.toMatch(/^r\./);
      for (const s of LOAD_STATUS_NAMES) expect(statusLabel(lang, s as LoadStatusName)).not.toMatch(/^st\./);
      for (const p of PHOTO_POSITION_STATUSES) expect(positionLabel(lang, p)).not.toMatch(/^pos\./);
    }
    expect(reasonLabel('en', 'WRONG_LOCATION')).toBe('Wrong location or could not find');
    expect(reasonLabel('en', 'NOT_ON_TRUCK')).toBe('Missing from the truck');
    expect(statusLabel('ar', 'DISPATCHED')).toBe('في الطريق');
  });

  it('fills placeholders and keeps "label: value" wording', () => {
    expect(t('en', 'stopsLabel', { n: 9 })).toBe('Stops: 9');
    expect(t('ar', 'stopsLabel', { n: 9 })).toBe('المحطات: 9');
    expect(t('en', 'tripOf', { n: 1, m: 2 })).toBe('Trip 1 of 2');
    expect(t('en', 'noTrips', { truck: 'T05' })).toBe('No trips for truck T05 on {date} (yet).');
    expect(t('en', 'locationNotice', { company: 'Synthetic Water Co', days: 90 })).toMatch(/^Location: Synthetic Water Co uses .* for 90 days .* never a track of your route\. Questions: ask your dispatcher at Synthetic Water Co\.$/);
  });

  it('the toggle names the other language in its own script', () => {
    expect(LANG_TOGGLE).toEqual({ en: 'العربية', ar: 'English' });
  });
});

describe('language choice and formats', () => {
  it('the stored choice, else the phone language, else English', () => {
    expect(pickLang('ar', 'en-US')).toBe('ar');
    expect(pickLang('en', 'ar-OM')).toBe('en');
    expect(pickLang(null, 'ar-OM')).toBe('ar');
    expect(pickLang('xx', 'fr-FR')).toBe('en');
    expect(pickLang(undefined, undefined)).toBe('en');
  });

  it('24 h times and dates with Western digits in both languages', () => {
    expect(hhmm(390)).toBe('06:30');
    expect(hhmm(1450)).toBe('00:10 +1');
    expect(hhmm(null)).toBe('--:--');
    expect(fmtDate('en')('2026-10-04')).toBe('Sun 4 Oct');
    const ar = fmtDate('ar')('2026-10-04');
    expect(ar).toMatch(/4/);
    expect(ar).not.toMatch(/[٠-٩]/); // no Arabic-Indic digits
  });

  it('hours: the promised time wins, then the receiving and best hours, else any time', () => {
    expect(fmtHours('en', { hardStart: 360, hardEnd: 840, prefStart: 420, prefEnd: 600 }, null)).toBe('Receives 06:00-14:00 · Best 07:00-10:00');
    expect(fmtHours('en', { hardStart: 360, hardEnd: 840, prefStart: null, prefEnd: null }, { startMin: 600, endMin: 660 })).toBe('Promised 10:00-11:00');
    expect(fmtHours('en', { hardStart: null, hardEnd: 600, prefStart: null, prefEnd: null }, null)).toBe('Receives 00:00-10:00');
    expect(fmtHours('en', null, null)).toBe('Any time');
    expect(fmtHours('ar', null, null)).toBe('أي وقت');
    // Arabic is right to left: the range is one isolated left-to-right run, so 07:00-12:00 never reads 12:00-07:00.
    expect(fmtHours('ar', { hardStart: 420, hardEnd: 720, prefStart: null, prefEnd: null }, null)).toBe('الاستلام ⁦07:00-12:00⁩');
    expect(fmtHours('en', { hardStart: 420, hardEnd: 720, prefStart: null, prefEnd: null }, null)).not.toMatch(/[⁦⁩]/);
  });
});

describe('page helpers', () => {
  const load = { loadNo: 1, trips: 2, status: 'DISPATCHED' as const, actionable: true, departMin: 430, returnMin: 700, driverName: 'Salim', cases: 412, backAtDepotAt: null, stops: Array.from({ length: 9 }, () => ({}) as never) };
  it('the trip line', () => {
    expect(tripLine('en', load)).toBe('Trip 1 of 2 · Depart 07:10 · Stops: 9 · Cases: 412');
    expect(tripLine('ar', load)).toBe('الرحلة 1 من 2 · المغادرة 07:10 · المحطات: 9 · الكراتين: 412');
  });

  it('opens the trip on the road first, else the first not done', () => {
    const l = (status: string) => ({ ...load, status }) as never;
    expect(openTripIndex({ loads: [l('COMPLETED'), l('DISPATCHED'), l('LOCKED')] })).toBe(1);
    expect(openTripIndex({ loads: [l('COMPLETED'), l('LOCKED')] })).toBe(1);
    expect(openTripIndex({ loads: [l('COMPLETED')] })).toBe(0);
    expect(openTripIndex({ loads: [] })).toBe(-1);
  });

  it('stop title and the dispatcher phone link', () => {
    expect(stopTitle({ customerName: 'ACME', customerCode: 'C1', branchCode: 'B2' })).toBe('ACME (C1/B2)');
    expect(telHref('+968 9000 0000')).toBe('tel:+96890000000');
    expect(telHref('')).toBeNull();
    expect(telHref(null)).toBeNull();
  });
});

describe('the page API helpers', () => {
  it('reads the token only from a /d/<token> path', () => {
    expect(tokenFromPath('/d/Ab3_dE5-gH7iJ9kL1mN3oP5q')).toBe('Ab3_dE5-gH7iJ9kL1mN3oP5q');
    expect(tokenFromPath('/d/short')).toBeNull();
    expect(tokenFromPath('/t/nmwc/dispatch')).toBeNull();
  });

  it('sends the token in a header, with the browser id', () => {
    expect(driverHeaders('tok', 'dev')).toMatchObject({ Authorization: 'DriverLink tok', 'X-Driver-Device': 'dev' });
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const id = deviceId(store);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(deviceId(store)).toBe(id);
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(deviceId(throwing)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('reads the answers: the manifest, the link states, 429 and errors', () => {
    expect(readManifestAnswer(200, { data: { loads: [] }, error: null }, null)).toMatchObject({ kind: 'ok' });
    expect(readManifestAnswer(410, { data: null, error: { code: 'LINK_EXPIRED', uploadOnly: true, date: '2026-10-05' } }, null)).toEqual({
      kind: 'link', status: 410, code: 'LINK_EXPIRED', uploadOnly: true, date: '2026-10-05',
    });
    expect(readManifestAnswer(404, { data: null, error: { code: 'LINK_NOT_FOUND' } }, null)).toMatchObject({ kind: 'link', code: 'LINK_NOT_FOUND' });
    expect(readManifestAnswer(429, null, '30')).toEqual({ kind: 'busy', retryAfterSec: 30 });
    expect(readManifestAnswer(500, null, null)).toEqual({ kind: 'error', status: 500 });
    // Part 2 (found in the browser check): another company's RouteIQ session in this browser is a
    // clear state, not "No signal" for ever.
    expect(readManifestAnswer(403, { data: null, error: { code: 'SIGNED_IN_OTHER_TENANT' } }, null)).toEqual({ kind: 'link', status: 403, code: 'SIGNED_IN_OTHER_TENANT', uploadOnly: false, date: null });
    expect(readManifestAnswer(403, { data: null, error: { code: 'SOMETHING_ELSE' } }, null)).toEqual({ kind: 'error', status: 403 });
  });
});
