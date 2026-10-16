/**
 * Operations alerts (owner request 16 Oct 2026): the words (lib/alerts/text.ts). A message never carries
 * a phone number: every run of 6 or more digits in free text (driver notes, customer names) becomes
 * "[number]" - spaces, "+", "-", "/", ".", brackets and Arabic-Indic digits included - before the text is
 * cut, so no part of a number survives the cut either. Notes are one line and at most 140 characters.
 * Names are invented (public repository).
 */
import { describe, expect, it } from 'vitest';
import { ALERT_NOTE_MAX } from '@/lib/alerts/catalog';
import { ALERT_NAME_MAX, REDACTED_NUMBER, clockText, cut, fmtDistance, fmtDuration, loadLabel, minutesOnDate, noteText, oneLine, redactNumbers, safeName, sequencesText, shortNote, stopLabel } from '@/lib/alerts/text';

const SIX_DIGITS = /\p{Nd}(?:[\s\-+/.()]*\p{Nd}){5,}/u;

describe('redactNumbers: no phone number survives', () => {
  it.each([
    ['call +968 8123 4567 at the gate', 'call [number] at the gate'],
    ['ring 81234567', 'ring [number]'],
    ['(968) 8123-4567', `(${REDACTED_NUMBER}`],
    ['mobile 8.1.2.3.4.5.6.7', `mobile ${REDACTED_NUMBER}`],
    ['رقم ٨١٢٣٤٥٦٧ للتواصل', `رقم ${REDACTED_NUMBER} للتواصل`],
    ['۸۱۲۳۴۵۶۷', REDACTED_NUMBER],
    ['invoice 16/10/2026 short', `invoice ${REDACTED_NUMBER} short`],
  ])('%s', (raw, want) => {
    expect(redactNumbers(raw)).toBe(want);
  });

  it('keeps short numbers: cases, shop numbers, a 5-digit code', () => {
    expect(redactNumbers('2 cases missing, shop 24, gate 12345')).toBe('2 cases missing, shop 24, gate 12345');
  });
});

describe('notes and names', () => {
  it('a note is one line, without control characters, cut to 140 characters with "…"; empty is null', () => {
    expect(shortNote('  two cases\nmissing \t\u0007 ')).toBe('two cases missing');
    expect(shortNote('')).toBeNull();
    expect(shortNote(null)).toBeNull();
    expect(shortNote('   \n ')).toBeNull();
    const long = shortNote('x'.repeat(300))!;
    expect(long.length).toBe(ALERT_NOTE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('the redaction comes before the cut: a number across the cut leaves no digits of it', () => {
    const note = `${'a'.repeat(ALERT_NOTE_MAX - 4)} 81234567 call`;
    const out = shortNote(note)!;
    expect(out).not.toMatch(/8123/);
    expect(out.length).toBeLessThanOrEqual(ALERT_NOTE_MAX);
  });

  it('a customer name loses its digit runs and is cut to 60 characters; an empty one reads "customer"', () => {
    expect(safeName('Shop Example C 88776655')).toBe('Shop Example C [number]');
    expect(safeName('n'.repeat(100)).length).toBe(ALERT_NAME_MAX);
    expect(safeName('  ')).toBe('customer');
  });

  it('labels: truck and load, stop with customer code and branch', () => {
    expect(loadLabel('T05', 1)).toBe('T05 L1');
    expect(stopLabel({ sequence: 3, customerName: 'Hyper Example B', customerCode: 'C100', branchCode: 'B2' })).toBe('stop 3 Hyper Example B (C100 / B2)');
    expect(stopLabel({ sequence: 4, customerName: 'Shop Example C', customerCode: 'C200', branchCode: null })).toBe('stop 4 Shop Example C (C200)');
    expect(noteText('door 5')).toBe(' Note: "door 5"');
    expect(noteText(null)).toBe('');
    expect(oneLine('a\r\nb')).toBe('a b');
    expect(cut('abcdef', 4)).toBe('abc…');
  });

  it('durations, distances and stop lists', () => {
    expect(fmtDuration(45)).toBe('45 min');
    expect(fmtDuration(125)).toBe('2 h 05 min');
    expect(fmtDuration(180)).toBe('3 h');
    expect(fmtDuration(-3)).toBe('0 min');
    expect(fmtDistance(450)).toBe('450 m');
    expect(fmtDistance(2400)).toBe('2.4 km');
    expect(sequencesText([6])).toBe('stop 6');
    expect(sequencesText([6, 8])).toBe('stops 6 and 8');
    expect(sequencesText([5, 6, 8])).toBe('stops 5, 6 and 8');
  });

  it('clock times of the delivery day: "+1" after midnight, the date further away (Asia/Muscat, UTC+4)', () => {
    const tz = 'Asia/Muscat';
    expect(clockText(new Date('2026-10-20T05:10:00Z'), '2026-10-20', tz)).toBe('09:10');
    expect(clockText(new Date('2026-10-20T20:40:00Z'), '2026-10-20', tz)).toBe('00:40 +1');
    expect(clockText(new Date('2026-10-19T17:10:00Z'), '2026-10-20', tz)).toBe('19 Oct 21:10');
    expect(minutesOnDate(new Date('2026-10-19T17:10:00Z'), '2026-10-20', tz)).toBe(-170);
  });
});

describe('fuzz: names and notes with numbers in every form never leave 6 digits in a row', () => {
  it('500 random notes', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const digits = ['0123456789', '٠١٢٣٤٥٦٧٨٩', '۰۱۲۳۴۵۶۷۸۹'];
    const seps = ['', ' ', '-', '/', '.', '+', '(', ')', '  '];
    for (let i = 0; i < 500; i++) {
      const d = digits[Math.floor(rnd() * digits.length)]!;
      let num = rnd() < 0.5 ? '+' : '';
      const n = 6 + Math.floor(rnd() * 8);
      for (let k = 0; k < n; k++) num += d[Math.floor(rnd() * 10)]! + (rnd() < 0.3 ? seps[Math.floor(rnd() * seps.length)]! : '');
      const text = `${'word '.repeat(Math.floor(rnd() * 40))}${num} ${'tail '.repeat(Math.floor(rnd() * 5))}`;
      expect(shortNote(text) ?? '', text).not.toMatch(SIX_DIGITS);
      expect(safeName(text), text).not.toMatch(SIX_DIGITS);
    }
  });
});
