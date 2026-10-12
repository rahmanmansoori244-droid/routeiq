/**
 * The customer's phone (owner request 12 Oct 2026: "In the driver sheet add the phone number of the
 * customer, and add it to the list of data to be collected so that the driver can call the customer
 * before arrival to inform him of the delivery."). Pure, no imports: the Details dialog (browser), the
 * API schema, the customer import and the workbooks share one rule and its words.
 *
 *  - Optional free text: trimmed, runs of spaces as one; empty = no phone (null).
 *  - Only digits, spaces and + - ( ) / (a "/" separates a second number: "9123 4567 / 2456 7890").
 *    Arabic-Indic digits (٠-٩, ۰-۹: an Arabic keyboard types them) are stored as 0-9, so the driver
 *    sheet (Latin font only) prints them and the tel: link dials them.
 *  - 6 to 20 digits in all, at most 40 characters (as a driver's phone, lib/schemas.ts).
 *  - Not a loading-rule requirement: a customer without a phone is planned, locked and sent out as
 *    before, and is not put on the Data to collect list for it (the phone is collected with the rest).
 *
 * The tel: link (with the company's calling code for a local number, as the WhatsApp links) is
 * telUrl in driver-links.ts.
 */

export const CUSTOMER_PHONE_MIN_DIGITS = 6;
export const CUSTOMER_PHONE_MAX_DIGITS = 20;
export const CUSTOMER_PHONE_MAX_LENGTH = 40;

/** The rule in words: the dialog's hint, the import page and the workbooks' About sheet. */
export const CUSTOMER_PHONE_RULE = 'Digits, spaces and + - ( ) / only, 6 to 20 digits. Optional.';

/** The short instruction of the phone column in the customer master and the data-to-collect Excel. */
export const CUSTOMER_PHONE_COLUMN_TEXT = "customer's phone, for the driver to call before arrival - optional";

/**
 * The headers the customer import reads the phone from (any letter case, like every header), in the
 * order they are looked at: the first one with a value wins. `phone` is what the downloaded master and
 * data-to-collect files have; the others are what customer lists from other systems call it.
 */
export const CUSTOMER_PHONE_HEADERS = ['phone', 'customer_phone', 'mobile', 'contact_phone', 'tel'] as const;

export type CustomerPhoneRead = { ok: true; phone: string | null } | { ok: false; error: string };

/** Arabic-Indic (U+0660-0669) and Persian / Urdu (U+06F0-06F9) digits as 0-9 (as the driver page's cases box). */
function westernDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (c) => String(c.charCodeAt(0) & 0xf));
}

/**
 * A phone as typed (Details, the API, an import cell): the text to store, null for none, or why it is
 * refused, in plain words starting with `label` ("Phone", or the import's column name).
 */
export function readCustomerPhone(raw: string | null | undefined, label = 'Phone'): CustomerPhoneRead {
  const s = westernDigits(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return { ok: true, phone: null };
  if (!/^[0-9 +\-()/]+$/.test(s)) return { ok: false, error: `${label} "${s}": use only digits, spaces and + - ( ) /.` };
  const digits = s.replace(/\D/g, '').length;
  if (digits < CUSTOMER_PHONE_MIN_DIGITS || digits > CUSTOMER_PHONE_MAX_DIGITS) {
    return { ok: false, error: `${label} "${s}": a phone number has ${CUSTOMER_PHONE_MIN_DIGITS} to ${CUSTOMER_PHONE_MAX_DIGITS} digits (this has ${digits}).` };
  }
  if (s.length > CUSTOMER_PHONE_MAX_LENGTH) return { ok: false, error: `${label}: at most ${CUSTOMER_PHONE_MAX_LENGTH} characters.` };
  return { ok: true, phone: s };
}

/**
 * The phone cell of an import row (keys in small letters, values trimmed: lib/csv normalizeKeys): the
 * first of CUSTOMER_PHONE_HEADERS that has a value, with its header for the row's message. Null when
 * the file has none of them or every such cell is blank (a blank cell keeps the saved phone).
 */
export function importedPhoneCell(row: Record<string, string>): { column: string; value: string } | null {
  for (const column of CUSTOMER_PHONE_HEADERS) {
    const value = (row[column] ?? '').toString().trim();
    if (value) return { column, value };
  }
  return null;
}
