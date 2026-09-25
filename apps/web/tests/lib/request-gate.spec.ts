/**
 * Stabilization PR3 - the day screen's gate (review ADD-STALE-DAY-CLIENT): an answer for a day the
 * dispatcher already left is dropped, whatever order the answers come back in; an answer for the
 * day being loaded is shown when it is newer than the one on screen (slow polling never freezes it).
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

  it('a same-day refresh slower than the polling interval is still shown (the screen never freezes)', () => {
    // Polling every 3 s while the day overview takes longer: each answer arrives after the next
    // poll began. Before the fix every one was dropped and the screen stayed on "Optimizing...".
    const s = screen();
    const key = dayKey('2026-09-27', 'D1');
    const poll1 = s.start(key);
    const poll2 = s.start(key);
    const poll3 = s.start(key);
    expect(poll1.answer('optimizing')).toBe(true); // older, but newer than what is on screen
    expect(s.shown()).toBe('optimizing');
    expect(s.gate.pendingKey()).toBe(key); // the newest poll is still on its way
    expect(poll3.answer('ready')).toBe(true);
    expect(poll2.answer('optimizing (older)')).toBe(false); // never replaces a newer answer
    expect(s.shown()).toBe('ready');
    expect(s.gate.pendingKey()).toBeNull();
  });

  it('a slow answer for the day on screen is dropped once another day was picked', () => {
    const s = screen();
    const slow = s.start(dayKey('2026-09-27', 'D1'));
    const other = s.start(dayKey('2026-09-28', 'D1'));
    expect(slow.answer('27')).toBe(false);
    expect(other.answer('28')).toBe(true);
    expect(s.shown()).toBe('28');
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
