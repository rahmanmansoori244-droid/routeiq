/**
 * One truck or driver on the plans of two depots on one day (review finding web-plan-service-1), the
 * pure part: the free time a truck has around its loads at another depot (lib/dispatch/cross-depot.ts)
 * and the drivers RouteIQ gives around another depot's loads (planDrivers in load-state.ts). The
 * database flow - planning, LOCK / DISPATCH and two depots at the same moment - is in
 * cross-depot-db.spec.ts. Synthetic data only.
 */
import { describe, expect, it } from 'vitest';
import { driveBetweenMin, freeWindow, hadTimeHere, truckHoursAround, type OtherDepotLoad } from '@/lib/dispatch/cross-depot';
import { planDrivers, type OtherDepotTrip, type PlanTrip } from '@/lib/dispatch/load-state';

const NORTH = { lat: 23.58, lng: 58.39 };
const SOUTH = { lat: 23.3, lng: 58.6 };
const CFG = { reloadMinutes: 30, loadingMinPerCase: 0.1 };

const away = (over: Partial<OtherDepotLoad> = {}): OtherDepotLoad => ({
  id: 'NL1',
  depotId: 'N',
  depotName: 'North depot',
  truckId: 'T01',
  truckCode: 'T01',
  loadNo: 1,
  status: 'DISPATCHED',
  driverId: 'D1',
  departMin: 360,
  returnMin: 600,
  cases: 100,
  driveMin: 74,
  ...over,
});
const truck = { code: 'T01', availableFromMin: null, availableToMin: null, capacityCases: 200 };

describe('the drive between two depots', () => {
  it('is the straight line x the distance multiplier at the average speed for estimates, rounded up; the same pin is no drive', () => {
    // About 37.8 km apart: x 1.3 = 49.1 km, at 40 km/h = 73.7 min.
    expect(driveBetweenMin(NORTH, SOUTH, { distanceMultiplier: 1.3, avgSpeedKmh: 40 })).toBe(74);
    expect(driveBetweenMin(NORTH, NORTH, { distanceMultiplier: 1.3, avgSpeedKmh: 40 })).toBe(0);
  });
});

describe('freeWindow: the longest free stretch around busy times', () => {
  it('keeps the longest gap, merges overlapping busy times, and counts only time after usableFrom', () => {
    const busy = [{ from: 600, to: 700 }, { from: 650, to: 800 }, { from: 1000, to: 1100 }];
    expect(freeWindow(busy, 0, 1440)).toEqual({ from: 0, to: 600 });
    // Before 06:00 is no use: 06:00-10:00 is 240 min, 11:00-24:00 is 340 min.
    expect(freeWindow(busy, 0, 1440, 360)).toEqual({ from: 1100, to: 1440 });
    // A load may be back exactly when a busy time starts, and leave exactly when one ends.
    expect(freeWindow([{ from: 600, to: 700 }], 600, 700)).toBeNull();
    expect(freeWindow([{ from: 0, to: 1440 }], 0, 1440)).toBeNull();
    // A tie keeps the earlier gap.
    expect(freeWindow([{ from: 500, to: 600 }], 400, 700)).toEqual({ from: 400, to: 500 });
  });
});

describe('truckHoursAround: a truck lent between depots is planned around its loads there', () => {
  // The day as the optimizer plans it: first departure 06:00, back by 24:00 at the latest.
  const DAY = { from: 360, to: 1440 };

  it('after a morning load there: new loads here leave once it is back, has driven over and is loaded (a full truck)', () => {
    const h = truckHoursAround(truck, [away()], CFG, DAY)!;
    // Back at North 10:00, + 74 min drive = 11:14, + 30 min reload + 0.1 min x 200 cases = 12:04.
    expect(h).toMatchObject({ availableFromMin: 600 + 74 + 30 + 20, availableToMin: null, none: false });
    expect(h.note).toBe('Truck T01 is on another depot\'s plan this day (North depot: L1 06:00–10:00 dispatched): new loads here leave from 12:04, with the drive between the depots and the loading.');
  });

  it('before an afternoon load there: new loads here are back in time to drive over and load it', () => {
    const h = truckHoursAround(truck, [away({ departMin: 900, returnMin: 1080, status: 'PLANNED', cases: 50 })], CFG, DAY)!;
    // That load leaves North at 15:00: loaded there from 14:25 (30 + 5 min), so back here by 13:11
    // (06:00-13:11 is longer than what is left after it: 20:04-24:00).
    expect(h).toMatchObject({ availableFromMin: null, availableToMin: 900 - 74 - 35, none: false });
    expect(h.note).toContain('North depot: L1 15:00–18:00 planned');
    expect(h.note).toContain('new loads here are back by 13:11');
  });

  it('busy all day there: an empty window (no new load here), said so', () => {
    const h = truckHoursAround(truck, [away({ departMin: 300, returnMin: 1400 })], CFG, DAY)!;
    expect(h).toMatchObject({ availableFromMin: 1440, availableToMin: 1440, none: true });
    expect(h.note).toBe('Truck T01 is on another depot\'s plan this day (North depot: L1 05:00–23:20 dispatched): it takes no new load here.');
    // Such a truck is not "unused" by the plan (the plan screen's idle-trucks note); any other is.
    expect(hadTimeHere(h)).toBe(false);
    expect(hadTimeHere({ availableFromMin: null, availableToMin: null })).toBe(true);
    expect(hadTimeHere({ availableFromMin: 724, availableToMin: null })).toBe(true);
  });

  it('a load there that does not limit the truck\'s own hours changes nothing; no load there is nothing', () => {
    expect(truckHoursAround({ ...truck, availableToMin: 600 }, [away({ departMin: 1200, returnMin: 1300 })], CFG, DAY)).toBeNull();
    expect(truckHoursAround(truck, [], CFG, DAY)).toBeNull();
  });
});

describe('planDrivers: never a driver who is on another depot\'s load at an overlapping time', () => {
  const trip = (over: Partial<PlanTrip> = {}): PlanTrip => ({ key: 'S1:1', truckId: 'S1', loadNo: 1, departMin: 360, returnMin: 600, defaultDriverId: 'D1', ...over });
  // North's T01 L1 06:00-10:00 with D1, widened by the 74-min drive.
  const north: OtherDepotTrip = { truckId: 'T01', driverId: 'D1', loadNo: 1, departMin: 360 - 74, returnMin: 600 + 74, truckCode: 'T01 (North depot)' };
  const usable = new Set(['D1', 'D2']);

  it('the truck\'s default driver is not given while he drives there; he is once the drive back is done', () => {
    expect(planDrivers([trip()], [], usable, undefined, undefined, [north]).drivers.get('S1:1')?.driverId).toBeNull();
    expect(planDrivers([trip({ departMin: 674, returnMin: 900 })], [], usable, undefined, undefined, [north]).drivers.get('S1:1')?.driverId).toBe('D1');
    // Without other depots' loads, as before.
    expect(planDrivers([trip()], [], usable).drivers.get('S1:1')?.driverId).toBe('D1');
  });

  it('a trip that loses its driver to another depot gets a CLASH note naming that load with its depot', () => {
    const evidence = [{ truckId: 'S1', loadNo: 1, status: 'PLANNED', driverId: 'D1', departMin: 360, returnMin: 600, driverSetById: null, driverSetAt: null }];
    const { drivers, notes } = planDrivers([trip({ defaultDriverId: 'D2' })], evidence, usable, undefined, undefined, [north]);
    expect(drivers.get('S1:1')?.driverId).toBe('D2');
    expect(notes).toEqual([
      expect.objectContaining({ fromDriverId: 'D1', toDriverId: 'D2', reason: 'CLASH', other: { truckId: 'T01', loadNo: 1, truckCode: 'T01 (North depot)' } }),
    ]);
  });
});
