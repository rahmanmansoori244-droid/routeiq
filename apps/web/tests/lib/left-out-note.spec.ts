/**
 * The plan screen's warning when a plan leaves out priority 1-3 orders while trucks stand unused
 * (outside benchmark of 8 Oct 2026, F02 / F07; lib/dispatch/left-out-note.ts), counting only the
 * orders a longer search or an unused truck could still place (review of 9 Oct 2026); and the orders
 * left out for their customer's data that a re-plan would plan now; and (review of 5614ba9) which
 * unserved orders a re-plan could place now, the ones that keep the day screen's RE-PLAN on.
 */
import { describe, expect, it } from 'vitest';
import { idleTrucksNote, replanCouldPlace, unservedNowPlannable } from '@/lib/dispatch/left-out-note';
import { DEFAULT_SERVICE_AREA } from '@/lib/dispatch/location-input';

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

describe('idleTrucksNote: only orders a search or an unused truck could place (review of 9 Oct 2026)', () => {
  const run = (reasonCode: string) => idleTrucksNote([{ priority: 2, reasonCode }], ['T1', 'T2'], ['T1']);

  it('says nothing for orders never sent to the optimizer, or proved impossible for every truck (before: "Run the search again (Thorough)")', () => {
    for (const reason of [
      'MISSING_COORDINATES', // no usable location: the dispatcher planned anyway (allowMissingLocations)
      'INVALID_LOCATION',
      'INVALID_CUSTOMER', // deactivated customer
      'EXCEEDS_ANY_TRUCK_CAPACITY',
      'UNKNOWN_CUSTOMER',
      'UNKNOWN_PRODUCT',
      'HARD_WINDOW_INFEASIBLE', // no truck, an unused one included, reaches it in its hours
      'SHIFT_LIMIT', // e.g. planned on the day after the depot closed: nothing can leave
      'LOCKED_PLAN_CONFLICT',
      'ROUTING_PROVIDER_FAILURE',
    ]) {
      expect(run(reason), reason).toBeNull();
    }
  });

  it("counts the search's own drops and late orders without room", () => {
    for (const reason of ['SOLVER_DROPPED_LOW_PRIORITY', 'LATE_ORDER_NO_CAPACITY', 'NO_AVAILABLE_TRUCK', 'TRIP_LIMIT', 'INFEASIBLE', 'UNKNOWN']) {
      expect(run(reason), reason).toBe('1 priority 1-3 order is left out although 1 truck is unused. Run the search again (Thorough) or add them by hand.');
    }
  });

  it('with mixed reasons counts only the orders a search could place (before: the location case was counted too)', () => {
    const unserved = [
      { priority: 1, reasonCode: 'MISSING_COORDINATES' },
      { priority: 1, reasonCode: 'SOLVER_DROPPED_LOW_PRIORITY' },
      { priority: 3, reasonCode: 'INVALID_CUSTOMER' },
      { priority: 2, reasonCode: 'LATE_ORDER_NO_CAPACITY' },
    ];
    expect(idleTrucksNote(unserved, ['T1', 'T2'], ['T1'])).toBe(
      '2 priority 1-3 orders are left out although 1 truck is unused. Run the search again (Thorough) or add them by hand.',
    );
  });
});

describe('unservedNowPlannable (review of 9 Oct 2026)', () => {
  const pin = { active: true, lat: 23.5859, lng: 58.3829, locationVerified: true, geocodeConfidence: 'HIGH' };
  const noPin = { ...pin, lat: null, lng: null, locationVerified: false, geocodeConfidence: 'MISSING' };

  it('a pin saved since for an order left out without a usable location: plannable now', () => {
    expect(unservedNowPlannable('MISSING_COORDINATES', pin, DEFAULT_SERVICE_AREA)).toBe(true);
    expect(unservedNowPlannable('INVALID_LOCATION', pin, DEFAULT_SERVICE_AREA)).toBe(true);
    expect(unservedNowPlannable('MISSING_COORDINATES', noPin, DEFAULT_SERVICE_AREA)).toBe(false);
    // A saved point marked LOW and never confirmed is still not usable.
    expect(unservedNowPlannable('INVALID_LOCATION', { ...pin, locationVerified: false, geocodeConfidence: 'LOW' }, DEFAULT_SERVICE_AREA)).toBe(false);
  });

  it('a customer reactivated since: plannable now, unless it still has no usable location (or is still deactivated)', () => {
    expect(unservedNowPlannable('INVALID_CUSTOMER', pin, DEFAULT_SERVICE_AREA)).toBe(true);
    expect(unservedNowPlannable('INVALID_CUSTOMER', noPin, DEFAULT_SERVICE_AREA)).toBe(false);
    expect(unservedNowPlannable('INVALID_CUSTOMER', { ...pin, active: false }, DEFAULT_SERVICE_AREA)).toBe(false);
  });

  it('other reasons are not about the customer data: never', () => {
    for (const reason of ['SOLVER_DROPPED_LOW_PRIORITY', 'EXCEEDS_ANY_TRUCK_CAPACITY', 'HARD_WINDOW_INFEASIBLE']) {
      expect(unservedNowPlannable(reason, pin, DEFAULT_SERVICE_AREA), reason).toBe(false);
    }
  });
});

describe('replanCouldPlace: the unserved orders that keep Step 3 RE-PLAN on (review of 5614ba9)', () => {
  it('customer data: only once fixed (a pin saved, the customer reactivated)', () => {
    for (const reason of ['MISSING_COORDINATES', 'INVALID_LOCATION', 'INVALID_CUSTOMER']) {
      expect(replanCouldPlace(reason, false, false), reason).toBe(false);
      expect(replanCouldPlace(reason, true, false), reason).toBe(true);
    }
  });

  it('cases heavier than any truck: only once they are not any more (a case weight corrected, a bigger payload)', () => {
    expect(replanCouldPlace('EXCEEDS_ANY_TRUCK_CAPACITY', false, true)).toBe(false);
    expect(replanCouldPlace('EXCEEDS_ANY_TRUCK_CAPACITY', false, false)).toBe(true);
  });

  it('any other reason is one a re-plan tries again (a truck added, another search, a truck free from the start of the day)', () => {
    for (const reason of ['SOLVER_DROPPED_LOW_PRIORITY', 'LATE_ORDER_NO_CAPACITY', 'NO_AVAILABLE_TRUCK', 'TRIP_LIMIT', 'HARD_WINDOW_INFEASIBLE', 'SHIFT_LIMIT', 'INFEASIBLE', 'UNKNOWN']) {
      expect(replanCouldPlace(reason, false, false), reason).toBe(true);
    }
  });
});
