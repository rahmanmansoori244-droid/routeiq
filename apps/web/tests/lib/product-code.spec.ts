/**
 * Product codes as the NMWC ERP writes them ("JA1.5L(6)", "TN1.5L (6)", "SS5GB NRB",
 * "INVOMAN330(24)"): letters, digits, spaces and . ( ) - _ / + & are allowed, spaces at the ends
 * are cut and runs of spaces inside become one, matching ignores the letter case, and nothing that
 * breaks a CSV, an Excel cell or a URL (a comma, a quote, a control character, a leading + or -)
 * gets in. The rule lives in lib/product-code.ts; productSchema (create and edit) and the order
 * intake use it. Customer, depot, truck, driver and region codes keep their own rule (codeSchema).
 */
import { describe, expect, it } from 'vitest';
import { normalizeProductCode, parseProductCode, PRODUCT_CODE_MAX, productCodeProblem, productKey, twinsOf } from '@/lib/product-code';
import { customerSchema, depotSchema, driverSchema, productSchema, regionSchema, truckSchema } from '@/lib/schemas';

/** The real NMWC codes of the pilot data check (18 of 66 SKUs had a space or a bracket). */
const REAL = ['JA1.5L(6)', 'TN1.5L (6)', 'SS5GB NRB', 'INVOMAN330(24)'];

describe('normalizeProductCode', () => {
  it('cuts spaces at both ends and makes every run of spaces inside one', () => {
    expect(normalizeProductCode(' TN1.5L  (6) ')).toBe('TN1.5L (6)');
    expect(normalizeProductCode('SS5GB     NRB')).toBe('SS5GB NRB');
    expect(normalizeProductCode('   JA1.5L(6)')).toBe('JA1.5L(6)');
  });

  it('leaves a code without spaces, and the letter case, as it is', () => {
    expect(normalizeProductCode('ja1.5l(6)')).toBe('ja1.5l(6)');
    expect(normalizeProductCode('INVOMAN330(24)')).toBe('INVOMAN330(24)');
  });

  it('does not add or remove a space between a name and a bracket: TN1.5L(6) and TN1.5L (6) are two codes', () => {
    expect(normalizeProductCode('TN1.5L(6)')).toBe('TN1.5L(6)');
    expect(normalizeProductCode('TN1.5L (6)')).toBe('TN1.5L (6)');
  });

  it('reads a non-breaking space (what an ERP export often holds) as a space', () => {
    expect(normalizeProductCode('SS5GB\u00a0NRB')).toBe('SS5GB NRB');
    expect(normalizeProductCode('\u00a0SS5GB \u00a0 NRB\u00a0')).toBe('SS5GB NRB');
    expect(normalizeProductCode('SS5GB\u2003NRB')).toBe('SS5GB NRB');
  });

  it('cuts a tab or line break at the ends, but keeps one inside so the code is refused (never joined silently)', () => {
    expect(normalizeProductCode('\tJA1.5L(6)\r\n')).toBe('JA1.5L(6)');
    expect(normalizeProductCode('SS5GB\tNRB')).toBe('SS5GB\tNRB');
    expect(productCodeProblem(normalizeProductCode('SS5GB\tNRB'))).toMatch(/control characters/);
  });

  it('anything that is not text is an empty code', () => {
    for (const v of [null, undefined, 12, {}, ['A']]) expect(normalizeProductCode(v)).toBe('');
  });
});

describe('productCodeProblem / parseProductCode: what is allowed', () => {
  it.each(REAL)('accepts the real NMWC code %s', (code) => {
    expect(productCodeProblem(code)).toBeNull();
    expect(parseProductCode(code)).toEqual({ ok: true, code });
  });

  it('accepts letters, digits, spaces and every one of . ( ) - _ / + &', () => {
    for (const code of ['A.B', 'A(B)', 'A-B', 'A_B', 'A/B', 'A+B', 'A&B', 'A B', 'TAN-500-24', 'BOX 12/6 (BLUE) +1 & CO_2.5', '500ML', 'a', '7']) {
      expect(parseProductCode(code), code).toEqual({ ok: true, code });
    }
  });

  it('parseProductCode returns the code as it is stored: trimmed, one space between words', () => {
    expect(parseProductCode(' TN1.5L  (6) ')).toEqual({ ok: true, code: 'TN1.5L (6)' });
    expect(parseProductCode('\u00a0SS5GB  NRB')).toEqual({ ok: true, code: 'SS5GB NRB' });
  });

  it(`takes ${PRODUCT_CODE_MAX} characters and refuses ${PRODUCT_CODE_MAX + 1}; the spaces cut do not count`, () => {
    expect(PRODUCT_CODE_MAX).toBe(40);
    expect(parseProductCode('A'.repeat(40)).ok).toBe(true);
    const r = parseProductCode('A'.repeat(41));
    expect(r).toEqual({ ok: false, message: 'Max 40 characters (this code has 41)' });
    expect(parseProductCode(`  ${'A'.repeat(40)}  `).ok).toBe(true);
    expect(parseProductCode(`${'A'.repeat(20)}      ${'B'.repeat(19)}`)).toEqual({ ok: true, code: `${'A'.repeat(20)} ${'B'.repeat(19)}` });
  });
});

describe('productCodeProblem / parseProductCode: what is refused, in plain words', () => {
  const refused = (raw: unknown) => {
    const r = parseProductCode(raw);
    if (r.ok) throw new Error(`${JSON.stringify(raw)} was accepted as ${r.code}`);
    return r.message;
  };

  it('empty, only spaces, or not text: Required', () => {
    for (const v of ['', '   ', '\t', '\u00a0', null, undefined, 5]) expect(refused(v)).toBe('Required');
  });

  it('control characters inside the code (tab, line break, NUL, DEL, NEL): named as such', () => {
    for (const v of ['A\tB', 'A\nB', 'A\rB', 'A\u0000B', 'A\u007fB', 'A\u0085B', 'A\u2028B']) {
      expect(refused(v), JSON.stringify(v)).toBe('A product code cannot contain tabs, line breaks or other control characters');
    }
  });

  it('characters that break a CSV, an Excel formula or a URL: the message names each one', () => {
    expect(refused('A,B')).toBe('A product code can have only letters, digits, spaces and . ( ) - _ / + & (not ",")');
    expect(refused('A"B')).toMatch(/not """\)$/);
    expect(refused('A;B')).toMatch(/not ";"\)$/);
    expect(refused('A#B?C')).toMatch(/not "#", "\?"\)$/);
    expect(refused('A%20B')).toMatch(/not "%"\)$/);
    expect(refused('A\\B')).toMatch(/not "\\"\)$/);
    for (const ch of ["'", '=', '@', '[', ']', '{', '}', '<', '>', '*', '|', ':', '!', '$', '^', '~', '`']) {
      expect(parseProductCode(`A${ch}B`).ok, ch).toBe(false);
    }
  });

  it('a character outside ASCII (Arabic, an accented letter, a zero-width space, a curly quote) is refused and shown by its code point when it is invisible', () => {
    expect(refused('هايبر')).toMatch(/^A product code can have only letters, digits, spaces/);
    expect(refused('CAFÉ')).toMatch(/not "É"\)$/);
    expect(refused('A\u200bB')).toMatch(/not U\+200B\)$/);
    expect(refused('A\u2019B')).toMatch(/not "\u2019"\)$/);
  });

  it('lists a repeated bad character once and at most five of them', () => {
    expect(refused('A,,B,')).toMatch(/not ","\)$/);
    expect(refused('#%?,;:!')).toMatch(/not "#", "%", "\?", ",", ";", \.\.\.\)$/);
  });

  it('a code cannot start with + or -: a spreadsheet would read it as a formula', () => {
    expect(refused('+1')).toBe('A product code cannot start with + or -');
    expect(refused('-A')).toBe('A product code cannot start with + or -');
    expect(refused('  -A  ')).toBe('A product code cannot start with + or -');
    expect(parseProductCode('A-1').ok).toBe(true);
    expect(parseProductCode('1+1').ok).toBe(true);
    expect(parseProductCode('(6)JA-1').ok).toBe(true);
  });

  it('a code of only brackets, dots or dashes has nothing to identify the product by', () => {
    for (const v of ['()', '...', '_', '(.)', '/ /']) expect(refused(v), v).toBe('A product code needs at least one letter or digit');
  });
});

describe('productKey: the identity two codes are matched by', () => {
  it('ignores the letter case: JA1.5L(6) and ja1.5l(6) are one product', () => {
    expect(productKey('ja1.5l(6)')).toBe(productKey('JA1.5L(6)'));
    expect(productKey('ja1.5l(6)')).toBe('JA1.5L(6)');
  });

  it('ignores spaces at the ends and runs of spaces: " TN1.5L  (6) " is TN1.5L (6)', () => {
    expect(productKey(' TN1.5L  (6) ')).toBe(productKey('TN1.5L (6)'));
    expect(productKey(' tn1.5l  (6) ')).toBe('TN1.5L (6)');
    expect(productKey('SS5GB\u00a0NRB')).toBe(productKey('ss5gb nrb'));
  });

  it('keeps a space that is there: TN1.5L(6) and TN1.5L (6) are two products', () => {
    expect(productKey('TN1.5L(6)')).not.toBe(productKey('TN1.5L (6)'));
    expect(productKey('SS5GB NRB')).not.toBe(productKey('SS5GBNRB'));
  });

  it('does not treat _ or other characters as a pattern: A_B is not AxB', () => {
    expect(productKey('A_B')).not.toBe(productKey('AxB'));
    expect(productKey('A.B')).not.toBe(productKey('AxB'));
    expect(productKey('A(B)')).not.toBe(productKey('AB'));
  });
});

describe('twinsOf: the master rows a code means', () => {
  const master = [
    { id: 'p1', code: 'JA1.5L(6)' },
    { id: 'p2', code: 'TN1.5L (6)' },
    { id: 'p3', code: 'TN1.5L(6)' },
    { id: 'p4', code: 'A_B' },
    { id: 'p5', code: 'AxB' },
    { id: 'p6', code: 'SS5GB  NRB' }, // saved before spaces were tidied: two spaces
  ];
  const ids = (code: string) => twinsOf(master, code).map((p) => p.id);

  it('finds the row whatever the letter case and spacing of the code it is asked for', () => {
    expect(ids('JA1.5L(6)')).toEqual(['p1']);
    expect(ids('ja1.5l(6)')).toEqual(['p1']);
    expect(ids(' TN1.5L  (6) ')).toEqual(['p2']);
    expect(ids('tn1.5l(6)')).toEqual(['p3']);
  });

  it('finds a row saved with two spaces by the tidy code (and the other way round)', () => {
    expect(ids('SS5GB NRB')).toEqual(['p6']);
    expect(twinsOf([{ id: 'x', code: 'SS5GB NRB' }], 'SS5GB   NRB').map((p) => p.id)).toEqual(['x']);
  });

  it('matches exactly, not as a pattern: A_B finds only A_B (the database ILIKE read _ as "any character")', () => {
    expect(ids('A_B')).toEqual(['p4']);
    expect(ids('a_b')).toEqual(['p4']);
    expect(ids('AxB')).toEqual(['p5']);
    expect(ids('A%')).toEqual([]);
    expect(ids('')).toEqual([]);
  });

  it('keeps every twin (rows that differ only in case) in the list order', () => {
    expect(twinsOf([{ code: 'x1', id: 'a' }, { code: 'X1', id: 'b' }, { code: 'y', id: 'c' }], 'X1').map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('productSchema (create and edit)', () => {
  const valid = { code: 'P1', name: 'Water', weightPerCaseKg: 12, volumePerCaseL: 12 };

  it.each(REAL)('accepts the real code %s', (code) => {
    const r = productSchema.safeParse({ ...valid, code });
    expect(r.success).toBe(true);
    expect(r.success && r.data.code).toBe(code);
  });

  it('stores the tidy code: " TN1.5L  (6) " becomes "TN1.5L (6)"', () => {
    const r = productSchema.parse({ ...valid, code: ' TN1.5L  (6) ' });
    expect(r.code).toBe('TN1.5L (6)');
  });

  it('keeps the letter case it is given (matching ignores it; the master shows what was typed)', () => {
    expect(productSchema.parse({ ...valid, code: 'ja1.5l(6)' }).code).toBe('ja1.5l(6)');
  });

  it('refuses a bad code on the code field, with the reason in words', () => {
    for (const [code, text] of [
      ['A,B', /only letters, digits, spaces/],
      ['A\tB', /control characters/],
      ['-A', /cannot start with/],
      ['', /Required/],
      ['A'.repeat(41), /Max 40/],
    ] as const) {
      const r = productSchema.safeParse({ ...valid, code });
      expect(r.success, JSON.stringify(code)).toBe(false);
      if (!r.success) {
        expect(r.error.issues).toHaveLength(1);
        expect(r.error.issues[0]!.path).toEqual(['code']);
        expect(r.error.issues[0]!.message).toMatch(text);
      }
    }
  });

  it('a code that is not text is refused, a missing code is refused on create', () => {
    expect(productSchema.safeParse({ ...valid, code: 5 }).success).toBe(false);
    expect(productSchema.safeParse({ ...valid, code: null }).success).toBe(false);
    const { code: _code, ...noCode } = valid;
    expect(productSchema.safeParse(noCode).success).toBe(false);
  });

  it('an edit can leave the code out (the weight alone), or send a valid one', () => {
    const edit = productSchema.partial();
    expect(edit.parse({ weightPerCaseKg: 17 })).toEqual({ weightPerCaseKg: 17 });
    expect(edit.parse({ code: 'JA1.5L(6)', weightPerCaseKg: 17 })).toEqual({ code: 'JA1.5L(6)', weightPerCaseKg: 17 });
    expect(edit.safeParse({ code: 'A#B' }).success).toBe(false);
  });

  it('the rest of the product is checked as before', () => {
    expect(productSchema.safeParse({ ...valid, weightPerCaseKg: -1 }).success).toBe(false);
    expect(productSchema.safeParse({ ...valid, name: '' }).success).toBe(false);
  });
});

describe('the other codes keep their own rule (customer behaviour unchanged)', () => {
  it('a customer, depot, truck, driver or region code still takes letters, digits and . _ - only (32 characters)', () => {
    const customer = { name: 'Shop', priority: 3 };
    for (const code of ['JA1.5L(6)', 'TN1.5L (6)', 'has space', 'A/B', 'A+B', 'A&B', 'A'.repeat(33)]) {
      expect(customerSchema.safeParse({ ...customer, code }).success, `customer ${code}`).toBe(false);
      expect(depotSchema.safeParse({ code, name: 'D', lat: 23.6, lng: 58.4 }).success, `depot ${code}`).toBe(false);
      expect(driverSchema.safeParse({ code, name: 'Salim' }).success, `driver ${code}`).toBe(false);
      expect(regionSchema.safeParse({ code, name: 'R' }).success, `region ${code}`).toBe(false);
    }
    expect(truckSchema.safeParse({ code: 'T 1', description: '', depotId: 'd', capacityCases: 100, capacityWeightKg: 1000, capacityVolumeL: 0, fixedCostPerDay: 0, costPerKm: 0 }).success).toBe(false);
    for (const code of ['C001', 'C-001', 'C.001', 'C_001', 'a'.repeat(32)]) {
      expect(customerSchema.safeParse({ ...customer, code }).success, `customer ${code}`).toBe(true);
    }
  });
});
