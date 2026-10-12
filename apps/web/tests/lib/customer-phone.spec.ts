/**
 * The customer's phone (owner request 12 Oct 2026: "In the driver sheet add the phone number of the
 * customer, and add it to the list of data to be collected so that the driver can call the customer
 * before arrival to inform him of the delivery."). Pure, no database:
 *
 *  - the rule (lib/dispatch/customer-phone.ts readCustomerPhone): optional, trimmed, empty = none;
 *    digits, spaces and + - ( ) / only; 6 to 20 digits; Arabic-Indic digits stored as 0-9;
 *  - the API schemas (customerSchema / customerPatchSchema): '' or null clears, left out keeps, a bad
 *    one is refused with the reason;
 *  - the tel: link (driver-links.ts telUrl) with the company's calling code for a local number, the
 *    same logic as the WhatsApp links (whatsappNumber): "9123 4567" in Oman dials +968;
 *  - the import's phone cell (importedPhoneCell): phone, customer_phone, mobile, contact_phone, tel.
 *
 * The Details dialog and PATCH: dispatch-customer-details.spec.ts. The import and the workbooks:
 * data-collection-master.spec.ts. The plan, the manifest and the driver sheet: plan-feasibility-gate,
 * driver-manifest and driver-pack specs.
 */
import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_PHONE_COLUMN_TEXT,
  CUSTOMER_PHONE_HEADERS,
  CUSTOMER_PHONE_MAX_DIGITS,
  CUSTOMER_PHONE_MIN_DIGITS,
  importedPhoneCell,
  readCustomerPhone,
} from '@/lib/dispatch/customer-phone';
import { customerPatchSchema, customerSchema } from '@/lib/schemas';
import { telUrl, whatsappNumber } from '@/lib/dispatch/driver-links';
import { phoneCountryCode } from '@/lib/dispatch/customer-attrs';

describe('readCustomerPhone: the one rule', () => {
  it('keeps a phone as typed, trimmed, with runs of spaces as one; empty is no phone', () => {
    expect(readCustomerPhone('9123 4567')).toEqual({ ok: true, phone: '9123 4567' });
    expect(readCustomerPhone('  +968  9123\t4567 ')).toEqual({ ok: true, phone: '+968 9123 4567' });
    expect(readCustomerPhone('(024) 123-456')).toEqual({ ok: true, phone: '(024) 123-456' });
    expect(readCustomerPhone('9123 4567 / 2456 7890')).toEqual({ ok: true, phone: '9123 4567 / 2456 7890' });
    expect(readCustomerPhone('00968-9123-4567')).toEqual({ ok: true, phone: '00968-9123-4567' });
    for (const empty of ['', '   ', null, undefined]) expect(readCustomerPhone(empty)).toEqual({ ok: true, phone: null });
  });

  it('takes two whole numbers with country codes, each checked on its own (review of PR 66)', () => {
    expect(readCustomerPhone('+968 9123 4567 / +968 2456 7890')).toEqual({ ok: true, phone: '+968 9123 4567 / +968 2456 7890' });
    // A part that is not a number on its own falls back to the whole-string rule.
    expect(readCustomerPhone('968/9123 4567')).toEqual({ ok: true, phone: '968/9123 4567' });
    expect(readCustomerPhone(`${'1'.repeat(15)} / 12`).ok).toBe(true);
    expect(readCustomerPhone(`${'1'.repeat(21)} / ${'2'.repeat(8)}`).ok).toBe(false);
  });

  it('stores Arabic-Indic and Persian digits as 0-9 (an Arabic keyboard types them; the driver sheet prints Latin only)', () => {
    expect(readCustomerPhone('٩١٢٣ ٤٥٦٧')).toEqual({ ok: true, phone: '9123 4567' });
    expect(readCustomerPhone('+۹۶۸ ۹۱۲۳ ۴۵۶۷')).toEqual({ ok: true, phone: '+968 9123 4567' });
  });

  it('refuses anything but digits, spaces and + - ( ) /, with the reason', () => {
    for (const bad of ['9123 4567 ext 2', 'call the manager', '9123.4567', '#9123 4567', '9123*4567', '9123,4567', 'O9123 4567']) {
      const r = readCustomerPhone(bad);
      expect(r, bad).toEqual({ ok: false, error: `Phone "${bad}": use only digits, spaces and + - ( ) /.` });
    }
    // The import names its column.
    expect(readCustomerPhone('n/a', 'mobile')).toEqual({ ok: false, error: 'mobile "n/a": use only digits, spaces and + - ( ) /.' });
  });

  it('6 to 20 digits in all (separators do not count), at most 40 characters', () => {
    expect([CUSTOMER_PHONE_MIN_DIGITS, CUSTOMER_PHONE_MAX_DIGITS]).toEqual([6, 20]);
    expect(readCustomerPhone('123-456')).toEqual({ ok: true, phone: '123-456' });
    expect(readCustomerPhone('12345')).toEqual({ ok: false, error: 'Phone "12345": a phone number has 6 to 20 digits (this has 5).' });
    expect(readCustomerPhone('+ ( ) - /')).toEqual({ ok: false, error: 'Phone "+ ( ) - /": a phone number has 6 to 20 digits (this has 0).' });
    expect(readCustomerPhone('1'.repeat(20)).ok).toBe(true);
    expect(readCustomerPhone('1'.repeat(21))).toEqual({ ok: false, error: `Phone "${'1'.repeat(21)}": a phone number has 6 to 20 digits (this has 21).` });
    const long = '1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1'; // 21 digits, 41 characters: the digits are said first
    expect(readCustomerPhone(long).ok).toBe(false);
    const spaced = '(1) (2) (3) (4) (5) (6) (7) (8) (9) (0)'; // 10 digits, 39 characters
    expect(readCustomerPhone(spaced)).toEqual({ ok: true, phone: spaced });
    expect(readCustomerPhone(`${spaced} 1`)).toEqual({ ok: false, error: 'Phone: at most 40 characters.' });
  });
});

describe('the API schemas: left out keeps, empty clears, a bad one is refused', () => {
  const base = { code: 'C001', name: 'Corner Shop' };

  it('customerSchema (POST /api/customers)', () => {
    expect(customerSchema.parse({ ...base, phone: ' 9123  4567 ' }).phone).toBe('9123 4567');
    expect(customerSchema.parse({ ...base, phone: '' }).phone).toBeNull();
    expect(customerSchema.parse({ ...base }).phone).toBeUndefined();
    const bad = customerSchema.safeParse({ ...base, phone: 'abc def' });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues.map((i) => [i.path.join('.'), i.message])).toEqual([['phone', 'Phone "abc def": use only digits, spaces and + - ( ) /.']]);
    // A JSON number is not text (a leading 0 would be lost on the way): refused, never coerced.
    expect(customerSchema.safeParse({ ...base, phone: 91234567 }).success).toBe(false);
  });

  it('customerPatchSchema (PATCH /api/customers/:id, the Details dialog)', () => {
    expect(customerPatchSchema.parse({ phone: '+968 9123 4567' })).toEqual({ phone: '+968 9123 4567' });
    expect(customerPatchSchema.parse({ phone: null })).toEqual({ phone: null });
    expect(customerPatchSchema.parse({ phone: '   ' })).toEqual({ phone: null });
    expect('phone' in customerPatchSchema.parse({ priority: 2 })).toBe(false);
    expect(customerPatchSchema.safeParse({ phone: '123' }).success).toBe(false);
  });
});

describe('telUrl: the driver page\'s "Call customer" dials with the country code, as the WhatsApp links', () => {
  it('a local number gets the company\'s calling code: "9123 4567" in Oman dials +968', () => {
    const oman = phoneCountryCode('Oman');
    expect(telUrl('9123 4567', oman)).toBe('tel:+96891234567');
    // The same number WhatsApp gets (whatsappNumber), with the + a phone dials.
    expect(telUrl('9123 4567', oman)).toBe(`tel:+${whatsappNumber('9123 4567', oman)}`);
    expect(telUrl('(024) 123-456', '968')).toBe('tel:+96824123456');
    expect(telUrl('050 123 4567', phoneCountryCode('UAE'))).toBe('tel:+971501234567');
  });

  it('a number with its country code keeps it', () => {
    expect(telUrl('+968 9123 4567', '971')).toBe('tel:+96891234567');
    expect(telUrl('00968-9123-4567', '971')).toBe('tel:+96891234567');
    expect(telUrl('96891234567', '971')).toBe('tel:+96891234567');
  });

  it('two numbers: the first one is dialled; "968/9123 4567" is one number', () => {
    expect(telUrl('9123 4567 / 2456 7890', '968')).toBe('tel:+96891234567');
    expect(telUrl('+971 50 123 4567/9123 4567', '968')).toBe('tel:+971501234567');
    expect(telUrl('968/9123 4567', '968')).toBe('tel:+96891234567');
  });

  it('no calling code (a company outside Oman and the UAE): a local number is dialled as written, never a guessed country', () => {
    expect(phoneCountryCode('Germany')).toBeNull();
    expect(telUrl('030 1234567', null)).toBe('tel:0301234567');
    expect(telUrl('+49 30 1234567', null)).toBe('tel:+49301234567');
  });

  it('no link without a phone', () => {
    for (const none of [null, undefined, '', '   ', '12345']) expect(telUrl(none, '968')).toBeNull();
  });
});

describe('the import reads the phone from phone, customer_phone, mobile, contact_phone or tel', () => {
  it('the first header with a value wins; blank cells are no phone (the saved one is kept)', () => {
    expect([...CUSTOMER_PHONE_HEADERS]).toEqual(['phone', 'customer_phone', 'mobile', 'contact_phone', 'tel']);
    expect(importedPhoneCell({ code: 'C1', mobile: '9123 4567' })).toEqual({ column: 'mobile', value: '9123 4567' });
    expect(importedPhoneCell({ tel: '2456 7890', phone: '9123 4567' })).toEqual({ column: 'phone', value: '9123 4567' });
    expect(importedPhoneCell({ phone: ' ', contact_phone: '2456 7890' })).toEqual({ column: 'contact_phone', value: '2456 7890' });
    expect(importedPhoneCell({ phone: '', mobile: '  ' })).toBeNull();
    expect(importedPhoneCell({ code: 'C1' })).toBeNull();
  });

  it("the workbooks' instruction for the column", () => {
    expect(CUSTOMER_PHONE_COLUMN_TEXT).toBe("customer's phone, for the driver to call before arrival - optional");
  });
});
