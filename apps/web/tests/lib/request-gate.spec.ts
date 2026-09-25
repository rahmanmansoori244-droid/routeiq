/**
 * Stabilization PR3 - the day screen's latest-only gate (review ADD-STALE-DAY-CLIENT): an answer
 * that arrives after a newer load started is dropped, whatever order the answers come back in.
 */
import { describe, expect, it } from 'vitest';
import { createRequestGate, dayKey } from '@/app/t/[slug]/dispatch/request-gate';

/** Simulates the screen: loads resolve in any order; only a current ticket may show its day. */
function screen() {
  const gate = createRequestGate();
  let shown: string | null = null;
  return {
    gate,
    shown: () => shown,
    start(key: string) {
      const t = gate.begin(key);
      return {
        answer(day: string) {
          if (!gate.isCurrent(t)) return false;
          gate.finish(t);
          shown = day;
          return true;
        },
      };
    },
  };
}

describe('request gate', () => {
  it('drops an out-of-order answer for a day the dispatcher already left', () => {
    const s = screen();
    const d26 = s.start(dayKey('2026-09-26', 'D1'));
    const d27 = s.start(dayKey('2026-09-27', 'D1'));
    expect(d27.answer('27')).toBe(true);
    expect(d26.answer('26')).toBe(false); // late answer for the old day
    expect(s.shown()).toBe('27');
  });

  it('typing a year fires several dates: only the last one is shown', () => {
    const s = screen();
    const loads = ['0002-09-27', '0020-09-27', '0202-09-27', '2026-09-27'].map((d) => s.start(dayKey(d, 'D1')));
    loads[3]!.answer('2026');
    for (const l of loads.slice(0, 3)) expect(l.answer('old')).toBe(false);
    expect(s.shown()).toBe('2026');
  });

  it('a newer load makes an older one stale even if the newer one has not answered yet', () => {
    const s = screen();
    const a = s.start('x|D1');
    s.start('y|D1');
    expect(a.answer('x')).toBe(false);
    expect(s.shown()).toBeNull();
    expect(s.gate.pendingKey()).toBe('y|D1');
  });

  it('knows which day is loading until its answer arrives', () => {
    const g = createRequestGate();
    expect(g.pendingKey()).toBeNull();
    const t = g.begin(dayKey('2026-09-27', 'D2'));
    expect(g.pendingKey()).toBe('2026-09-27|D2');
    g.finish(t);
    expect(g.pendingKey()).toBeNull();
    expect(dayKey(null, undefined)).toBe('|');
  });
});
