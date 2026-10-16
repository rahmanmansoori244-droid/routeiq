/**
 * IVMS live link (16 Oct 2026): with no GPS (AYUN) event the visit rebuild, its office texts and its KPI
 * facts are byte-identical to what they were before the link (tests/fixtures/ivms/visit-golden.json was
 * written by the code at 9008d81 for the same seeded cases, tests/lib/visit-golden-cases.ts). Every visit
 * in production has no AYUN event while ivmsMode is OFF, so nothing a user sees changes.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deriveVisit } from '@/lib/delivery/visit';
import { actualMinutes, arrivalByText, arrivalNote, departureNote, timedByText } from '@/lib/delivery/office-text';
import { arrivalIsObserved, arrivedInsideWindow, deliveryKpis, type KpiVisit } from '@/lib/delivery/kpis';
import { goldenCases, goldenHash, goldenRow } from './visit-golden-cases';

const golden = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/ivms/visit-golden.json'), 'utf8')) as {
  cases: number;
  full: unknown[];
  hashes: string[];
  kpis: unknown;
};

describe('visits without GPS events are unchanged (golden, 900 seeded cases)', () => {
  const cases = goldenCases();
  const fns = { deriveVisit, arrivalByText, arrivalNote, timedByText, actualMinutes, departureNote, arrivalIsObserved, arrivedInsideWindow };
  const made = cases.map((c) => goldenRow(c, fns));

  it('the cases are the ones the golden file was written for, and none has an AYUN event', () => {
    expect(cases).toHaveLength(golden.cases);
    expect(cases.flatMap((c) => c.events).some((e) => e.source === 'AYUN')).toBe(false);
  });

  it('the first rows of each family are equal field by field (readable diff)', () => {
    const shown = made.slice(0, 20).concat(made.slice(600, 620)).map((m) => m.row);
    expect(shown).toEqual(golden.full);
  });

  it('every row has the same fingerprint as before', () => {
    const differing = made.map((m, i) => (goldenHash(m.row) === golden.hashes[i] ? null : cases[i]!.name)).filter((x) => x !== null);
    expect(differing).toEqual([]);
  });

  it('the KPIs over all of them are equal', () => {
    expect(JSON.parse(JSON.stringify(deliveryKpis(made.map((m) => m.kv as KpiVisit))))).toEqual(golden.kpis);
  });
});
