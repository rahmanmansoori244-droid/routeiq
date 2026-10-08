/**
 * The plan screen's warning when a plan leaves out priority 1-3 orders while trucks stand unused
 * (outside benchmark of 8 Oct 2026, F02 / F07; lib/dispatch/left-out-note.ts).
 */
import { describe, expect, it } from 'vitest';
import { idleTrucksNote } from '@/lib/dispatch/left-out-note';

describe('idleTrucksNote', () => {
  it('counts the priority 1-3 orders left out and the trucks without a load', () => {
    const unserved = [{ priority: 1 }, { priority: 2 }, { priority: 3 }, { priority: 4 }, { priority: 5 }];
    expect(idleTrucksNote(unserved, ['T1', 'T2', 'T3', 'T4'], ['T1', 'T3', 'T3'])).toBe(
      '3 priority 1-3 orders are left out although 2 trucks are unused. Run the search again (Thorough) or add them by hand.',
    );
  });

  it('speaks of one order and one truck in the singular', () => {
    expect(idleTrucksNote([{ priority: 2 }], ['T1', 'T2'], ['T1'])).toBe(
      '1 priority 1-3 order is left out although 1 truck is unused. Run the search again (Thorough) or add them by hand.',
    );
  });

  it('says nothing when only priority 4-5 orders are left out, or every truck has a load', () => {
    expect(idleTrucksNote([{ priority: 4 }, { priority: 5 }], ['T1', 'T2'], ['T1'])).toBeNull();
    expect(idleTrucksNote([{ priority: 1 }], ['T1', 'T2'], ['T2', 'T1'])).toBeNull();
    expect(idleTrucksNote([], ['T1', 'T2'], [])).toBeNull();
  });

  it('does not count an order brought forward to a later day (it is planned there)', () => {
    expect(idleTrucksNote([{ priority: 1, carriedTo: '2026-10-09' }], ['T1', 'T2'], ['T1'])).toBeNull();
  });

  it('counts a truck with only a locked or dispatched load as used', () => {
    // The used trucks are those of every load of the plan, frozen ones included (P02: the frozen truck).
    expect(idleTrucksNote([{ priority: 1 }], ['T1', 'T2'], ['T1', 'T2'])).toBeNull();
  });
});
