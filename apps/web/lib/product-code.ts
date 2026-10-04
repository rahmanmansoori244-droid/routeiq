/**
 * Product codes. One rule for the Products page, the Products API, the order file intake, the
 * late order and the sample file; pure (no imports), so every one of them can use it.
 *
 * The codes are the NMWC ERP's own: "JA1.5L(6)", "TN1.5L (6)", "SS5GB NRB", "INVOMAN330(24)".
 *  - Allowed: letters (A-Z), digits, spaces and the characters . ( ) - _ / + & , up to 40 long.
 *  - Spaces at both ends are cut and every run of spaces inside becomes one ("TN1.5L  (6) " is
 *    "TN1.5L (6)"). A non-breaking space (what an ERP export often holds) is a space.
 *  - Matching ignores the letter case ("ja1.5l(6)" is "JA1.5L(6)") but nothing else: a space that is
 *    there counts ("TN1.5L(6)" and "TN1.5L (6)" are two products).
 *  - Refused: anything that breaks a CSV, an Excel cell or a URL - a comma, a quote, a semicolon,
 *    # ? % \ = @ [ ] and so on - tabs, line breaks and other control characters, text outside
 *    ASCII, and a code that starts with + or - (a spreadsheet reads that as a formula).
 *
 * Customer, depot, truck, driver and region codes keep their own rule (codeSchema in
 * lib/schemas.ts): letters, digits and . _ - only.
 *
 * Codes are compared in the program (productKey / twinsOf), never with a database pattern: Prisma's
 * `equals` with `mode: 'insensitive'` is an ILIKE on PostgreSQL, which reads `_` as "any one
 * character" (so "A_B" matched "AxB") and a trailing `\` as an error.
 */

/** Longest product code, after the spaces are tidied. */
export const PRODUCT_CODE_MAX = 40;

/** What the rule allows, in words (for hints next to a code field). */
export const PRODUCT_CODE_HINT = 'Letters, digits, spaces and . ( ) - _ / + & (up to 40 characters).';

// Spaces inside a code: the plain space and the Unicode space separators (non-breaking, en, em, thin ...).
const INNER_SPACES = /[ \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const NOT_ALLOWED = /[^A-Za-z0-9 ._()/+&-]/gu;

/** The code as it is stored: spaces at both ends cut, each run of spaces inside one space. Not text: ''. */
export function normalizeProductCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(INNER_SPACES, ' ') : '';
}

/** A character as it is shown in a message: in quotes, or U+XXXX when it cannot be seen. */
function shown(ch: string): string {
  const cp = ch.codePointAt(0)!;
  return /^[\p{L}\p{N}\p{P}\p{S}]$/u.test(ch) ? `"${ch}"` : `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Why a tidy code (normalizeProductCode) cannot be a product code, in plain words; null when it can. */
export function productCodeProblem(code: string): string | null {
  if (code === '') return 'Required';
  if (code.length > PRODUCT_CODE_MAX) return `Max ${PRODUCT_CODE_MAX} characters (this code has ${code.length})`;
  if (CONTROL.test(code)) return 'A product code cannot contain tabs, line breaks or other control characters';
  const bad = [...new Set(code.match(NOT_ALLOWED) ?? [])];
  if (bad.length) {
    const list = bad.slice(0, 5).map(shown).join(', ');
    return `A product code can have only letters, digits, spaces and . ( ) - _ / + & (not ${list}${bad.length > 5 ? ', ...' : ''})`;
  }
  if (/^[+-]/.test(code)) return 'A product code cannot start with + or -';
  if (!/[A-Za-z0-9]/.test(code)) return 'A product code needs at least one letter or digit';
  return null;
}

export type ParsedProductCode = { ok: true; code: string } | { ok: false; message: string };

/** The tidy code, or the reason it is refused. */
export function parseProductCode(raw: unknown): ParsedProductCode {
  const code = normalizeProductCode(raw);
  const message = productCodeProblem(code);
  return message === null ? { ok: true, code } : { ok: false, message };
}

/**
 * The identity two codes are matched by: tidy, in upper case. "ja1.5l(6)", "JA1.5L(6)" and
 * " JA1.5L(6) " are one product; "TN1.5L(6)" and "TN1.5L (6)" are two.
 */
export function productKey(code: string): string {
  return normalizeProductCode(code).toUpperCase();
}

/** The rows of `list` (master products) that `code` means, in the list's order. */
export function twinsOf<T extends { code: string }>(list: readonly T[], code: string): T[] {
  const key = productKey(code);
  return key === '' ? [] : list.filter((p) => productKey(p.code) === key);
}
