/**
 * The salesman page's words (owner feedback of 20 Oct 2026: English, Arabic and Urdu, each salesman picks his):
 * lib/sales-page/i18n.ts. Every key exists in the three languages with the same {placeholders}, nothing is empty,
 * the Arabic and Urdu texts are in their own script (and Urdu is not Arabic), every status and link state has its
 * words; the language picked (stored, else the phone's), the direction, the dates and times with Western digits,
 * and the values isolated inside right-to-left text.
 */
import { describe, expect, it } from 'vitest';
import { aboutText, dayText, dirOf, isRtl, LANG_NAME, pickSalesLang, placeholders, SALES_DICT, SALES_LANGS, st, zonedParts, type SalesKey } from '@/lib/sales-page/i18n';
import type { SalesLinkStateCode, SalesStatus } from '@/lib/sales-link/view-types';

const ARABIC_SCRIPT = /[؀-ۿ]/;
const STATUSES: SalesStatus[] = ['DELIVERED', 'PARTLY_DELIVERED', 'NOT_DELIVERED', 'NOT_CONFIRMED', 'ON_THE_WAY', 'DELAYED', 'CANCELLED', 'NOT_IN_PLAN'];
const LINK_STATES: SalesLinkStateCode[] = ['LINK_NOT_FOUND', 'LINK_REPLACED', 'LINK_REVOKED', 'LINK_EXPIRED', 'SALES_LINKS_OFF', 'SIGNED_IN_OTHER_TENANT'];

describe('the dictionary', () => {
  it('English, Arabic and Urdu have exactly the same keys', () => {
    expect(SALES_LANGS).toEqual(['en', 'ar', 'ur']);
    const keys = Object.keys(SALES_DICT.en).sort();
    expect(Object.keys(SALES_DICT.ar).sort()).toEqual(keys);
    expect(Object.keys(SALES_DICT.ur).sort()).toEqual(keys);
  });

  it('nothing is empty; every Arabic and Urdu text is in their script; the Urdu is not the Arabic', () => {
    for (const lang of SALES_LANGS) for (const [k, v] of Object.entries(SALES_DICT[lang])) expect(v.trim(), `${lang}.${k}`).not.toBe('');
    for (const lang of ['ar', 'ur'] as const) for (const [k, v] of Object.entries(SALES_DICT[lang])) expect(ARABIC_SCRIPT.test(v), `${lang}.${k}: ${v}`).toBe(true);
    for (const k of Object.keys(SALES_DICT.en) as SalesKey[]) expect(SALES_DICT.ur[k], k).not.toBe(SALES_DICT.ar[k]);
  });

  it('the same {placeholders} per key in every language', () => {
    for (const k of Object.keys(SALES_DICT.en) as SalesKey[]) {
      expect(placeholders(SALES_DICT.ar[k]), `ar.${k}`).toEqual(placeholders(SALES_DICT.en[k]));
      expect(placeholders(SALES_DICT.ur[k]), `ur.${k}`).toEqual(placeholders(SALES_DICT.en[k]));
    }
  });

  it('every status button and every link state has its words in every language', () => {
    for (const lang of SALES_LANGS) {
      for (const s of STATUSES) expect(SALES_DICT[lang][`st.${s}` as SalesKey], `${lang} st.${s}`).toBeTruthy();
      for (const c of LINK_STATES) expect(SALES_DICT[lang][`link.${c}` as SalesKey], `${lang} link.${c}`).toBeTruthy();
    }
    expect(STATUSES.map((s) => st('en', `st.${s}` as SalesKey))).toEqual(['Delivered', 'Partly delivered', 'Not delivered', 'Not confirmed yet', 'On the way', 'Delayed', 'Cancelled', 'Not in the plan']);
    // "On the way" on tomorrow's link the evening before (review of 20 Oct 2026).
    expect(SALES_LANGS.map((l) => SALES_DICT[l]['st.PLANNED'])).toEqual(['Planned', 'مجدول', 'پلان شدہ']);
  });

  it('review of 20 Oct 2026: the Arabic footer says the page is updated every minute (not "the page talks"); "not confirmed yet" as a status', () => {
    expect(SALES_DICT.ar.footerTimes).toBe('الأوقات تقريبية وبتوقيت الشركة. يتم تحديث الصفحة كل دقيقة.');
    expect(Object.values(SALES_DICT.ar).join(' ')).not.toMatch(/تتحدث/);
    expect(SALES_DICT.ar['st.NOT_CONFIRMED']).toBe('لم يُؤكَّد بعد');
  });

  it('the page never says "no update", "not before" or a reason, in any language', () => {
    for (const v of Object.values(SALES_DICT.en)) expect(v).not.toMatch(/no update|not before|reason|GPS|trip \d|stop \d/i);
  });
});

describe('the language, the direction and the formats', () => {
  it('the stored choice, else the phone: Arabic, Urdu, else English', () => {
    expect(pickSalesLang('ur', 'ar-OM')).toBe('ur');
    expect(pickSalesLang('en', 'ur-PK')).toBe('en');
    expect(pickSalesLang(null, 'ar-OM')).toBe('ar');
    expect(pickSalesLang(null, 'AR')).toBe('ar');
    expect(pickSalesLang(null, 'ur-PK')).toBe('ur');
    expect(pickSalesLang(null, 'ur')).toBe('ur');
    expect(pickSalesLang(null, 'en-GB')).toBe('en');
    expect(pickSalesLang(null, 'hi-IN')).toBe('en');
    expect(pickSalesLang('fr', 'ur-PK')).toBe('ur');
    expect(pickSalesLang(undefined, null)).toBe('en');
  });

  it('Arabic and Urdu right to left; each language named in its own script', () => {
    expect(SALES_LANGS.map((l) => [isRtl(l), dirOf(l)])).toEqual([
      [false, 'ltr'],
      [true, 'rtl'],
      [true, 'rtl'],
    ]);
    expect(LANG_NAME).toEqual({ en: 'English', ar: 'العربية', ur: 'اردو' });
  });

  it('the date in each language with Western digits; a bad date as it is', () => {
    expect(dayText('en', '2026-10-19')).toBe('Mon 19 Oct');
    expect(dayText('ar', '2026-10-19')).toMatch(/^الاثنين، 19 أكتوبر$/);
    expect(dayText('ur', '2026-10-19')).toMatch(/19/);
    expect(dayText('ur', '2026-10-19')).toMatch(ARABIC_SCRIPT);
    for (const l of SALES_LANGS) expect(dayText(l, '2026-10-19')).not.toMatch(/[٠-٩۰-۹]/);
    expect(dayText('en', 'soon')).toBe('soon');
  });

  it("an instant's date and time in the company's time zone", () => {
    expect(zonedParts('2026-10-20T02:00:00.000Z', 'Asia/Muscat')).toEqual({ date: '2026-10-20', time: '06:00' });
    expect(zonedParts('2026-10-19T20:30:00.000Z', 'Asia/Muscat')).toEqual({ date: '2026-10-20', time: '00:30' });
    expect(zonedParts('not a date', 'Asia/Muscat')).toBeNull();
  });

  it('values isolated in right-to-left text only; a missing value stays visible', () => {
    expect(st('en', 'updated', { time: '10:30' })).toBe('Updated 10:30');
    expect(st('ar', 'updated', { time: '10:30' })).toBe('آخر تحديث ⁨10:30⁩');
    expect(st('ur', 'routeTitle', { code: 'R2X' })).toBe('روٹ ⁨R2X⁩');
    expect(st('en', 'updated')).toBe('Updated {time}');
  });

  it('how far, in each language', () => {
    expect([5, 25, 80].map((m) => aboutText('en', m))).toEqual(['any minute', 'in about 25 min', 'in about 1 h 20 min']);
    const strip = (s: string) => s.replace(/[⁦-⁩]/g, '');
    expect([5, 25, 80, 120].map((m) => strip(aboutText('ar', m)))).toEqual(['خلال دقائق', 'بعد حوالي 25 د', 'بعد حوالي 1 س 20 د', 'بعد حوالي 2 س']);
    expect([5, 25, 80, 120].map((m) => strip(aboutText('ur', m)))).toEqual(['چند منٹ میں', 'تقریباً 25 منٹ میں', 'تقریباً 1 گھنٹہ 20 منٹ میں', 'تقریباً 2 گھنٹے میں']);
  });
});
