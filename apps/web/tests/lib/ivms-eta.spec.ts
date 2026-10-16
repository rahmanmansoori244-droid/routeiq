/**
 * Live ETA and the live truck layer of the IVMS live link (lib/ivms/eta.ts, lib/ivms/live-map.ts; design
 * section 8 with the binding review's H5/M7): the plan's own legs scaled by what is left, a straight-line
 * floor, a truck at its stop leaving after its planned unloading, and no ETA, no speed and no "moving"
 * from a stale, invalid or clock-ahead fix. Invented pins in empty desert, trucks T05/T06.
 */
import { describe, expect, it } from 'vitest';
import { fixUsable, liveEta, straightMin, type EtaInput, type EtaStop } from '@/lib/ivms/eta';
import { fixStale, gpsFactText, liveMapCaption, liveVehicleOf, vehiclePopupText, type DayVehicle, type PositionRow } from '@/lib/ivms/live-map';
import { STALE_FIX_SEC } from '@/lib/ivms/types';
import { T, at } from './ivms-trail';

const TZ = 'Asia/Muscat';
const DAY_START = T('00:00');
const NOW = T('09:00');
const min = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const stop = (sequence: number, east: number, eta: string, over: Partial<EtaStop> = {}): EtaStop => ({ sequence, pin: at(east), etaMin: min(eta), plannedServiceMin: 15, done: false, arrivedAt: null, ...over });
const input = (over: Partial<EtaInput>): EtaInput => ({
  now: NOW,
  fix: { fixAt: new Date(NOW.getTime() - 60_000), ...at(5000) },
  dayStart: DAY_START,
  departMin: min('08:00'),
  depot: at(0),
  stops: [stop(1, 10_000, '08:30'), stop(2, 20_000, '09:15')],
  avgSpeedKmh: 40,
  distanceMultiplier: 1.3,
  ...over,
});
const hhmm = (d: Date) => new Date(d.getTime() + 4 * 3600_000).toISOString().slice(11, 16);

describe('live ETA', () => {
  it('half way along the first leg: half the planned leg, never under the straight-line drive', () => {
    const [first, second] = liveEta(input({}));
    // Leg 08:00 -> 08:30 = 30 min, half left = 15 min; straight 5 km x 1.3 at 40 km/h = 9.75 min.
    expect(first).toMatchObject({ sequence: 1, atStop: false, delayMin: 45 });
    expect(hhmm(first!.etaAt)).toBe('09:15');
    // Then 15 min unloading and the planned leg 08:45 -> 09:15 (30 min).
    expect(hhmm(second!.etaAt)).toBe('10:00');
    expect(second!.delayMin).toBe(45);
  });

  it('the straight-line floor wins when the planned leg is too short', () => {
    const [first] = liveEta(input({ stops: [stop(1, 10_000, '08:05')] }));
    expect(Math.round((first!.etaAt.getTime() - NOW.getTime()) / 60_000)).toBe(Math.round(straightMin(at(5000), at(10_000), 40, 1.3)));
  });

  it('at a stop now: that stop is "at stop", the next one follows its planned unloading and leg', () => {
    const etas = liveEta(input({ stops: [stop(1, 10_000, '08:30', { arrivedAt: T('08:55') }), stop(2, 20_000, '09:15')] }));
    expect(etas[0]).toMatchObject({ sequence: 1, atStop: true });
    expect(hhmm(etas[1]!.etaAt)).toBe('09:40'); // leaves 09:10 (08:55 + 15), leg 30 min
  });

  it('done stops are behind the truck; nothing left gives no ETA', () => {
    expect(liveEta(input({ stops: [stop(1, 10_000, '08:30', { done: true }), stop(2, 20_000, '09:15')] })).map((e) => e.sequence)).toEqual([2]);
    expect(liveEta(input({ stops: [stop(1, 10_000, '08:30', { done: true })] }))).toEqual([]);
  });

  it('no ETA from a stale, invalid or clock-ahead fix (H5), or without a fix', () => {
    expect(liveEta(input({ fix: { fixAt: new Date(NOW.getTime() - (STALE_FIX_SEC + 1) * 1000), ...at(5000) } }))).toEqual([]);
    expect(liveEta(input({ fix: { fixAt: NOW, ...at(5000), flags: ['INVALID_FIX'] } }))).toEqual([]);
    expect(liveEta(input({ fix: { fixAt: NOW, ...at(5000), flags: ['CLOCK_AHEAD'] } }))).toEqual([]);
    expect(liveEta(input({ fix: null }))).toEqual([]);
    expect(fixUsable({ fixAt: new Date(NOW.getTime() - 60_000), ...at(0) }, NOW)).toBe(true);
  });
});

describe('the live truck layer', () => {
  const pos = (over: Partial<PositionRow> = {}): PositionRow => ({ truckId: 't5', fixAt: new Date(NOW.getTime() - 60_000), ...at(5000.123456), speedKmh: 42, heading: 90, flags: [], movedAt: new Date(NOW.getTime() - 60_000), ...over });

  it('a fresh moving fix: speed and heading, 5 decimals, never the IMEI', () => {
    const v = liveVehicleOf(pos(), 'T05', 2, NOW);
    expect(v).toMatchObject({ truckId: 't5', truckCode: 'T05', loadNo: 2, ageSec: 60, speedKmh: 42, heading: 90, parkedMin: null, stale: false });
    expect(String(v.lat).split('.')[1]!.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(v)).not.toMatch(/imei/i);
  });

  it('a stale fix is grey: no speed, no heading, never moving', () => {
    const v = liveVehicleOf(pos({ fixAt: new Date(NOW.getTime() - 25 * 60_000) }), 'T05', 2, NOW);
    expect(v).toMatchObject({ stale: true, speedKmh: null, heading: null, parkedMin: null });
    expect(fixStale({ fixAt: NOW, flags: ['INVALID_FIX'] }, NOW)).toBe(true);
    expect(vehiclePopupText({ ...v, next: null, facts: [] }, TZ)).toBe('T05 · L2 · no GPS position for 25 min (last 08:35)');
  });

  it('a parked truck says for how long; the popup gives the next stop and the delay', () => {
    const v = liveVehicleOf(pos({ speedKmh: 0, movedAt: new Date(NOW.getTime() - 13 * 60_000) }), 'T05', 2, NOW);
    expect(v).toMatchObject({ parkedMin: 12, heading: null });
    const withNext: DayVehicle = { ...v, next: { sequence: 4, customerName: 'Shop Example C', plannedAt: T('10:53').toISOString(), etaAt: T('11:05').toISOString(), delayMin: 12, atStop: false }, facts: [] };
    expect(vehiclePopupText(withNext, TZ)).toBe('T05 · L2 · parked 12 min · updated 1 min ago · next: stop 4, Shop Example C, about 11:05 (+12 min)');
  });

  it('the caption: when the positions are from, how many trucks, which are stale; delayed positions warn', () => {
    const fresh = liveVehicleOf(pos(), 'T05', 1, NOW);
    const old = liveVehicleOf(pos({ truckId: 't6', fixAt: new Date(NOW.getTime() - 40 * 60_000) }), 'T06', 1, NOW);
    const vs = [fresh, old].map((v) => ({ ...v, next: null, facts: [] }));
    expect(liveMapCaption({ mode: 'MAP', updatedAt: new Date(NOW.getTime() - 60_000).toISOString(), vehicles: vs }, NOW, TZ)).toEqual({ text: 'Live trucks (GPS): positions of 08:59, 2 trucks, 1 without a recent position (grey).', warn: false });
    expect(liveMapCaption({ mode: 'MAP', updatedAt: T('08:30').toISOString(), vehicles: vs }, NOW, TZ)?.warn).toBe(true);
    expect(liveMapCaption({ mode: 'OFF', updatedAt: null, vehicles: [] }, NOW, TZ)).toBeNull();
  });

  it('the GPS facts for the office in words (never a time)', () => {
    expect(gpsFactText({ kind: 'SEVERAL_PINS', loadNo: 1, sequences: [4, 5], from: T('10:12').toISOString(), to: null }, TZ)).toBe('GPS: L1 stops 4 and 5 close together at 10:12; not timed by GPS (the driver or the office records which customer)');
    expect(gpsFactText({ kind: 'NEAR_DEPOT', loadNo: 2, sequences: [1], from: T('07:00').toISOString(), to: null }, TZ)).toBe('GPS: L2 stop 1 is near the depot at 07:00; not timed by GPS');
    expect(gpsFactText({ kind: 'NO_DEPOT_BOUNDARY' }, TZ)).toMatch(/cannot be told apart/);
    expect(gpsFactText({ kind: 'SOMETHING_ELSE' }, TZ)).toBeNull();
    expect(gpsFactText('nonsense', TZ)).toBeNull();
  });
});
