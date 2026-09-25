/**
 * Stabilization PR3 - the day screen's gate (review ADD-STALE-DAY-CLIENT): an answer for a day the
 * dispatcher already left is dropped, whatever order the answers come back in; an answer for the
 * day being loaded is shown when it is newer than the one on screen (slow polling never freezes it).
 */
import { describe, expect, it } from 'vitest';
import { createDayLoader } from '@/app/t/[slug]/dispatch/day-loader';
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

describe('day loader: every load is for the day selected now (review of PR3: stuck on "Loading <date>...")', () => {
  interface FakeDay {
    date: string;
    depot: { id: string } | null;
  }
  /** A day screen around the loader: answers resolve when the test says so, in any order. */
  function screen(initial: { date: string | null; depotId: string | null }) {
    const asked: { sel: { date: string | null; depotId: string | null }; answer: (d: FakeDay | null, error?: string) => Promise<void> }[] = [];
    const state = { shown: null as FakeDay | null, error: null as string | null, selected: { ...initial } };
    const loader = createDayLoader<FakeDay>(initial, {
      fetchDay: (sel) =>
        new Promise((resolve) => {
          asked.push({
            sel,
            answer: async (d, error) => {
              resolve(d ? { ok: true, data: d, error: null } : { ok: false, data: null, error: error ?? 'HTTP 500' });
              for (let i = 0; i < 10; i++) await Promise.resolve();
            },
          });
        }),
      show: (d) => {
        state.shown = d;
        state.error = null;
      },
      showError: (m) => (state.error = m),
      selected: (sel) => (state.selected = sel),
    });
    /** The dispatcher picks another day: the screen selects it and loads it (its effect). */
    const pick = (date: string, depotId = 'D1') => {
      loader.select({ date, depotId });
      state.selected = { date, depotId };
      void loader.refresh();
    };
    const day = (date: string): FakeDay => ({ date, depot: { id: 'D1' } });
    const stuck = () => state.shown?.date !== state.selected.date && loader.pendingKey() === null && state.error === null;
    return { loader, asked, state, pick, day, stuck };
  }

  for (const order of ['new day answers first', 'late reload answers first'] as const) {
    it(`an action that ends after another day was picked reloads the new day (${order})`, async () => {
      const s = screen({ date: '2026-09-26', depotId: 'D1' });
      void s.loader.refresh();
      await s.asked[0]!.answer(s.day('2026-09-26'));
      expect(s.state.shown?.date).toBe('2026-09-26');
      // A lock on the 26th is on its way; the dispatcher picks the 27th; then the lock returns and
      // its handler reloads the day - the reference it holds is from before the switch.
      const reloadAfterAction = s.loader.refresh;
      s.pick('2026-09-27');
      const late = reloadAfterAction();
      expect(s.asked.map((a) => a.sel.date)).toEqual(['2026-09-26', '2026-09-27', '2026-09-27']); // never the 26th again
      if (order === 'new day answers first') {
        await s.asked[1]!.answer(s.day('2026-09-27'));
        await s.asked[2]!.answer(s.day('2026-09-27'));
      } else {
        await s.asked[2]!.answer(s.day('2026-09-27'));
        await s.asked[1]!.answer(s.day('2026-09-27'));
      }
      await late;
      expect(s.state.shown?.date).toBe('2026-09-27');
      expect(s.state.selected.date).toBe('2026-09-27');
      expect(s.loader.pendingKey()).toBeNull();
      expect(s.stuck()).toBe(false);
    });
  }

  it('backstop: an answer for a day left since, with nothing else loading, is not shown - the selection is loaded', async () => {
    const s = screen({ date: '2026-09-26', depotId: 'D1' });
    void s.loader.refresh();
    // Another day is selected, but its load has not started yet when the old answer arrives.
    s.loader.select({ date: '2026-09-27', depotId: 'D1' });
    s.state.selected = { date: '2026-09-27', depotId: 'D1' };
    await s.asked[0]!.answer(s.day('2026-09-26'));
    expect(s.state.shown).toBeNull(); // the 26th is never shown under the 27th's pickers
    expect(s.asked.map((a) => a.sel.date)).toEqual(['2026-09-26', '2026-09-27']);
    await s.asked[1]!.answer(s.day('2026-09-27'));
    expect(s.state.shown?.date).toBe('2026-09-27');
    expect(s.stuck()).toBe(false);
  });

  it('the selection follows the day the server answered (no date yet, an inactive depot)', async () => {
    const s = screen({ date: null, depotId: 'OLD' });
    void s.loader.refresh();
    await s.asked[0]!.answer({ date: '2026-09-26', depot: { id: 'D2' } });
    expect(s.state.selected).toEqual({ date: '2026-09-26', depotId: 'D2' });
    expect(s.loader.selection()).toEqual({ date: '2026-09-26', depotId: 'D2' });
    expect(s.asked).toHaveLength(1); // no reload loop
  });

  it('a failed load of the selected day shows the error (Try again), not the previous day', async () => {
    const s = screen({ date: '2026-09-26', depotId: 'D1' });
    void s.loader.refresh();
    await s.asked[0]!.answer(s.day('2026-09-26'));
    s.pick('2026-09-27');
    await s.asked[1]!.answer(null, 'The server could not be reached (Failed to fetch). Check the connection and try again.');
    expect(s.state.error).toMatch(/could not be reached/);
    expect(s.state.selected.date).toBe('2026-09-27');
  });
});
