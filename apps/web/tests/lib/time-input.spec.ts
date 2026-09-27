/**
 * Audit of 27 Sep 2026, F25: a truck available "until midnight" (availableToMin 1440) could not be
 * saved again: the edit form showed 1440 as "00:00 +1" (the plan screen's format), which its own
 * save refused ("Enter availability as HH:MM"), so changing any other field failed. Time fields
 * now show 1440 as 00:00 in an "until" field and read 00:00 / 24:00 back as 1440, and a field left
 * as loaded sends back exactly the stored minutes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTimeInput, timeInputValue, truckAvailabilityFromForm } from '@/lib/dispatch/time-input';

const loadedFrom = (t: { availableFromMin: number | null; availableToMin: number | null }) => ({
  ...t,
  shownFrom: timeInputValue(t.availableFromMin, 'from'),
  shownTo: timeInputValue(t.availableToMin, 'until'),
});

describe('time fields round-trip (audit F25)', () => {
  it('until midnight (1440) shows 00:00 and saves as 1440', () => {
    expect(timeInputValue(1440, 'until')).toBe('00:00');
    expect(parseTimeInput('00:00', 'until')).toBe(1440);
    expect(parseTimeInput('24:00', 'until')).toBe(1440);
  });

  it('every other value of the day round-trips; a blank is not set', () => {
    for (const m of [0, 1, 359, 360, 1380, 1439]) {
      expect(parseTimeInput(timeInputValue(m, 'from'), 'from'), `from ${m}`).toBe(m);
      if (m > 0) expect(parseTimeInput(timeInputValue(m, 'until'), 'until'), `until ${m}`).toBe(m);
    }
    expect(timeInputValue(null, 'until')).toBe('');
    expect(parseTimeInput('', 'until')).toBeNull();
    expect(() => parseTimeInput('00:00 +1', 'until')).toThrow();
    expect(() => parseTimeInput('24:00', 'from')).toThrow();
  });

  it('the auditor\'s case: reopen a truck available until midnight, change another field, save: 1440 is kept', () => {
    const truck = { availableFromMin: 360, availableToMin: 1440 };
    const loaded = loadedFrom(truck);
    const form = { availableFrom: loaded.shownFrom, availableTo: loaded.shownTo };
    expect(form).toEqual({ availableFrom: '06:00', availableTo: '00:00' });
    expect(truckAvailabilityFromForm(form, loaded)).toEqual({ availableFromMin: 360, availableToMin: 1440 });
    // and when the dispatcher types it again
    expect(truckAvailabilityFromForm({ availableFrom: '06:00', availableTo: '24:00' })).toEqual({ availableFromMin: 360, availableToMin: 1440 });
  });

  it('a stored value a time field cannot show is kept unless that field is changed', () => {
    const loaded = loadedFrom({ availableFromMin: null, availableToMin: 1500 });
    expect(loaded.shownTo).toBe('');
    expect(truckAvailabilityFromForm({ availableFrom: '', availableTo: '' }, loaded)).toEqual({ availableFromMin: null, availableToMin: 1500 });
    expect(truckAvailabilityFromForm({ availableFrom: '', availableTo: '22:00' }, loaded)).toEqual({ availableFromMin: null, availableToMin: 1320 });
  });

  it('a field cleared by the dispatcher clears it', () => {
    const loaded = loadedFrom({ availableFromMin: 360, availableToMin: 1440 });
    expect(truckAvailabilityFromForm({ availableFrom: '', availableTo: '' }, loaded)).toEqual({ availableFromMin: null, availableToMin: null });
  });

  it('the truck form uses these helpers, not the plan screen format', () => {
    const src = readFileSync(path.join(__dirname, '../../app/t/[slug]/trucks/truck-form.tsx'), 'utf8');
    expect(src).toMatch(/availableTo: timeInputValue\(truck\.availableToMin, 'until'\)/);
    expect(src).toMatch(/truckAvailabilityFromForm\(/);
    expect(src).not.toMatch(/fmtHhmm\(truck\.available/);
  });
});
