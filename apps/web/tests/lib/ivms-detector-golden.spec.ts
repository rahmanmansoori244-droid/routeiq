/**
 * The GPS stop detector after the owner request of 19 Oct 2026 (frozen runs as gaps, the customer's site
 * radius, the merge of one site's stays, the held departures, the stay summary, SHORT_DWELL facts) proposes
 * exactly what it proposed before for every truck-day where none of those applies: the same trips, depot
 * moves, arrivals and departures (times, observed flags, positions, distances) and the same facts for the
 * office. tests/fixtures/ivms/detector-golden.json was written by lib/ivms/stops.ts at eb59226 for the same
 * seeded truck-days (tests/lib/ivms-detector-golden-cases.ts: invented depot, pins and loads). Every
 * departure of those days is final (the truck drove on, beyond 500 m), so the writer writes it as before.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectTruckDay } from '@/lib/ivms/stops';
import { detectorGoldenCases, goldenOutput } from './ivms-detector-golden-cases';
import { goldenHash } from './visit-golden-cases';

const golden = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/ivms/detector-golden.json'), 'utf8')) as {
  cases: number;
  candidates: number;
  ambiguities: number;
  full: unknown[];
  hashes: string[];
};

describe('the detector without frozen runs, site radius or a return within 10 min and 500 m is unchanged (golden, 160 seeded truck-days)', () => {
  const cases = detectorGoldenCases();
  const runs = cases.map((c) => detectTruckDay(c.input));
  const made = runs.map((o) => goldenOutput(o) as { candidates: unknown[]; ambiguities: unknown[] });

  it('the cases are the ones the golden file was written for, with as many arrivals, departures and facts', () => {
    expect(cases).toHaveLength(golden.cases);
    expect(made.reduce((a, o) => a + o.candidates.length, 0)).toBe(golden.candidates);
    expect(made.reduce((a, o) => a + o.ambiguities.length, 0)).toBe(golden.ambiguities);
  });

  it('the first truck-days are equal field by field (readable diff)', () => {
    expect(made.slice(0, golden.full.length)).toEqual(golden.full);
  });

  it('every truck-day has the same fingerprint as before', () => {
    const differing = made.map((m, i) => (goldenHash(m) === golden.hashes[i] ? null : cases[i]!.name)).filter((x) => x !== null);
    expect(differing).toEqual([]);
  });

  it('nothing was merged, nothing frozen, and every departure the truck drove away from is final (written as before)', () => {
    const all = runs.flatMap((o) => o.candidates);
    expect(all.every((c) => c.stay && c.stay.merged === 0 && c.stay.frozenRuns === 0 && c.stay.radiusM === 100)).toBe(true);
    const departures = all.filter((c) => c.kind === 'DEPARTED');
    expect(departures.length).toBeGreaterThan(500);
    // Only a departure whose trail ends within 10 min of it (a day read early) may still be held.
    const held = runs.flatMap((o, i) => o.candidates.filter((c) => c.kind === 'DEPARTED' && c.final === false).map((c) => ({ c, last: Math.max(...cases[i]!.input.points.map((p) => p.fixAt.getTime())) })));
    expect(held.every(({ c, last }) => last - c.at.getTime() < 10 * 60_000)).toBe(true);
  });
});
