/**
 * Text for the PDF built-in fonts (Helvetica). They can print only the WinAnsi character set:
 * ASCII, Latin-1 (é ü ñ × · ...) and a few extras (– — ‘ ’ “ ” • … € ™ Œ œ Š š Ž ž Ÿ ƒ).
 * Anything else does NOT come out blank: react-pdf writes the low byte of the character code,
 * so the Arabic "هايبر" prints as "1(J'G" and "Łódź" as other Latin letters - a wrong-looking
 * name, address or note on a driver's sheet, with nothing to say so.
 *
 * pdfSafe() keeps what prints, swaps a few look-alikes (→ as ->, ł as l, ź as z), and replaces
 * each run of text it cannot print (Arabic, emoji, ...) with UNPRINTABLE, so the sheet can say
 * that something is missing. Pure: no react-pdf import.
 */

/** Stands for text the sheet cannot print (explained on the sheet itself). */
export const UNPRINTABLE = '[?]';

// WinAnsi characters outside Latin-1 (0x80-0x9F in the WinAnsi table).
const WIN_ANSI_EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ']);

// Common characters Helvetica has no glyph for, written with ones it has.
const LOOKALIKE: Record<string, string> = {
  '→': '->',
  '←': '<-',
  '↔': '<->',
  '⇒': '=>',
  '≤': '<=',
  '≥': '>=',
  '≠': '!=',
  '≈': '~',
  '−': '-',
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '―': '—',
  '′': "'",
  '″': '"',
  '✓': 'OK',
  '✔': 'OK',
  Ł: 'L',
  ł: 'l',
  Đ: 'D',
  đ: 'd',
  Ħ: 'H',
  ħ: 'h',
  ı: 'i',
};

const within = (c: number, ranges: [number, number][]) => ranges.some(([lo, hi]) => c >= lo && c <= hi);
// Other widths of space (tab, line break, thin space ...) print as a space.
const SPACES: [number, number][] = [[0x09, 0x0a], [0x0d, 0x0d], [0x2000, 0x200a], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000]];
// Invisible marks are dropped: control characters, soft hyphen, stray combining accents,
// zero-width and text-direction marks, byte-order mark.
const INVISIBLE: [number, number][] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x300, 0x36f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
const HOLE = ''; // stands for one character that cannot print, until runs are merged

function printable(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff && c !== 0xad) || WIN_ANSI_EXTRA.has(ch);
}

function charFor(ch: string): string {
  if (printable(ch)) return ch;
  const c = ch.codePointAt(0)!;
  if (within(c, SPACES)) return ' ';
  if (within(c, INVISIBLE)) return '';
  if (LOOKALIKE[ch]) return LOOKALIKE[ch];
  // Arabic-Indic digits (٠-٩, ۰-۹) as 0-9: a building or phone number stays readable.
  if (c >= 0x660 && c <= 0x669) return String(c - 0x660);
  if (c >= 0x6f0 && c <= 0x6f9) return String(c - 0x6f0);
  // An accented Latin letter outside Latin-1 (ź, ş, ğ, ...) or a compatibility form (ﬁ, Ａ): its plain letters.
  const plain = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  if (plain && [...plain].every(printable)) return plain;
  return HOLE;
}

/** `text` as Helvetica can print it; `lost` = some of it could not be printed (see UNPRINTABLE). */
export function pdfSafe(text: string): { text: string; lost: boolean } {
  const out = [...text.normalize('NFC')].map(charFor).join('');
  if (!out.includes(HOLE)) return { text: out.replace(/ {2,}/g, ' ').trim(), lost: false };
  // One marker per run of unprintable words, with the spaces and punctuation between them.
  const marked = out.replace(new RegExp(`${HOLE}(?:[\\s.,;:'"()/\\-–—]*${HOLE})*`, 'g'), UNPRINTABLE);
  return { text: marked.replace(/ {2,}/g, ' ').trim(), lost: true };
}

/** Collects pdfSafe() results: `lost` is true once any text given to it could not be printed. */
export function pdfTextCollector() {
  let lost = false;
  const text = (s: string) => {
    const r = pdfSafe(s);
    lost ||= r.lost;
    return r.text;
  };
  return {
    text,
    maybe: (s: string | null | undefined) => (s === null || s === undefined ? null : text(s)),
    get lost() {
      return lost;
    },
  };
}
