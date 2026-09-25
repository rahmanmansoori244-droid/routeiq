/**
 * Review F08 - pure pieces of the frozen plan facts: what counts as "changed after planning",
 * what an optimization keeps of its inputs (never the OSRM address), the notes on the plan screen,
 * the job message when the recommended timetable is not verified (F04), and the startup warning of
 * the operator switch FEASIBILITY_GATE=warn.
 */
import { describe, expect, it } from 'vitest';
import type { DispatchScenario } from '@routeiq/shared-types';
import {
  distanceM,
  PIN_MOVED_M,
  plannedLoadsMasterChanged,
  stopMasterChanges,
  truckMasterChanges,
  usableWindow,
  type StopSnapshot,
  type TruckSnapshot,
} from '@/lib/dispatch/snapshots';
import { planInputsOf, planSettingsOf, type BuiltRequest } from '@/lib/dispatch/plan-service';
import { masterChangedNotes } from '@/lib/dispatch/plan-detail';
import { jobMessage } from '@/lib/jobs/dispatch-job';
import { configProblems } from '@/lib/startup-checks';
import { fixture } from './plan-detail-fixture';

const snap: StopSnapshot = {
  v: 1, customerId: 'c1', code: 'C1', branchCode: null, name: 'Lulu Bausher', customerType: null, lat: 23.6, lng: 58.4,
  address: 'Sultan Qaboos St', accessNotes: null, hardStartMin: 360, hardEndMin: 840, prefStartMin: 420, prefEndMin: 600,
  serviceMin: 20, priority: 1, source: 'PLAN', capturedAt: '2026-09-26T12:00:00Z',
};
const live = { name: 'Lulu Bausher', address: 'Sultan Qaboos St', lat: 23.6, lng: 58.4, hardStartMin: 360, hardEndMin: 840, prefStartMin: 420, prefEndMin: 600 };

describe('stopMasterChanges', () => {
  it('nothing changed, or a pin moved less than 50 m (a re-pasted link): nothing to report', () => {
    expect(stopMasterChanges(snap, live)).toEqual([]);
    const near = { ...live, lat: 23.6 + 0.0003 }; // ~33 m
    expect(distanceM({ lat: 23.6, lng: 58.4 }, near)).toBeLessThan(PIN_MOVED_M);
    expect(stopMasterChanges(snap, near)).toEqual([]);
  });

  it('a moved pin, new hours, a new name or address are each reported once, with the new values', () => {
    const c = stopMasterChanges(snap, { ...live, lat: 23.6006, hardEndMin: 720, name: 'Lulu Hypermarket Bausher', address: null });
    expect(c.map((x) => x.kind)).toEqual(['LOCATION', 'HOURS', 'NAME', 'ADDRESS']);
    expect(c[0]).toMatchObject({ newLat: 23.6006, newLng: 58.4 });
    expect(c[0].movedM).toBeGreaterThan(60);
    expect(c[0].text).toMatch(/^Location updated after planning: new pin 23\.60060, 58\.40000 \(\d+ m from the planned one\)$/);
    expect(c[1].text).toBe('Receiving hours changed after planning: now receives 06:00–12:00 (planned with 06:00–14:00)');
    expect(c[3].text).toBe('Address removed after planning.');
  });

  it('a pin added to a customer planned without one, or removed since', () => {
    expect(stopMasterChanges({ ...snap, lat: null, lng: null }, live)[0].text).toMatch(/^Location added after planning/);
    expect(stopMasterChanges(snap, { ...live, lat: null, lng: null })[0].text).toBe('Location removed from the customer after planning.');
  });

  it('an inverted window (22:00-06:00, legacy data) was planned as any time: not a change, re-plan after re-plan', () => {
    // buildDispatchRequest sends it as null / null (usableWindow), so that is what the snapshot holds.
    const planned = { ...snap, hardStartMin: null, hardEndMin: null, prefStartMin: null, prefEndMin: null };
    const inverted = { ...live, hardStartMin: 1320, hardEndMin: 360, prefStartMin: 900, prefEndMin: 600 };
    expect(stopMasterChanges(planned, inverted)).toEqual([]);
    // A snapshot holding the inverted window itself (an option from before plan inputs) reads the same.
    expect(stopMasterChanges({ ...snap, hardStartMin: 1320, hardEndMin: 360, prefStartMin: 900, prefEndMin: 600 }, inverted)).toEqual([]);
    // Correcting it to a real window is a change.
    expect(stopMasterChanges(planned, { ...inverted, hardStartMin: 360, hardEndMin: 720 })[0].text).toBe(
      'Receiving hours changed after planning: now receives 06:00–12:00 (planned with any time)',
    );
    expect(usableWindow(1320, 360)).toEqual({ start: null, end: null, ok: false });
    expect(usableWindow(360, 1320)).toEqual({ start: 360, end: 1320, ok: true });
  });
});

describe('plannedLoadsMasterChanged (the day screen: out of date, RE-PLAN)', () => {
  const truck = { v: 1, code: 'T03', capacityCases: 100, capacityWeightKg: 3000, fixedCostPerDay: 0, tripCost: 0, costPerKm: 0, kmPerLitre: null,
    availableFromMin: null, availableToMin: null, maxTripsPerDay: null, rules: null, source: 'PLAN', capturedAt: '2026-09-26T12:00:00Z' };

  it('counts customers whose pin or hours changed, and trucks whose capacity or payload changed', () => {
    const r = plannedLoadsMasterChanged(
      [
        { customerId: 'c1', stopSnapshotJson: snap, live: { ...live, lat: 23.61 } }, // pin moved ~1.1 km
        { customerId: 'c1', stopSnapshotJson: snap, live: { ...live, lat: 23.61 } }, // same customer, second order
        { customerId: 'c2', stopSnapshotJson: snap, live: { ...live, name: 'Renamed' } }, // a name only: no re-plan needed
        { customerId: 'c3', stopSnapshotJson: null, live }, // planned before snapshots
      ],
      [
        { truckId: 'T3', truckSnapshotJson: truck, live: { capacityCases: 100, capacityWeightKg: 2500 } }, // payload corrected
        { truckId: 'T3', truckSnapshotJson: truck, live: { capacityCases: 100, capacityWeightKg: 2500 } }, // its second load
        { truckId: 'T4', truckSnapshotJson: truck, live: { capacityCases: 100, capacityWeightKg: 3000 } },
        { truckId: 'T5', truckSnapshotJson: null, live: { capacityCases: 1, capacityWeightKg: 1 } },
      ],
    );
    expect(r).toEqual({ customers: 1, trucks: 1 });
    expect(plannedLoadsMasterChanged([{ customerId: 'c1', stopSnapshotJson: snap, live }], [])).toEqual({ customers: 0, trucks: 0 });
  });
});

describe('truckMasterChanges', () => {
  it('reports a changed capacity or payload only', () => {
    const t = { capacityCases: 100, capacityWeightKg: 1000 } as TruckSnapshot;
    expect(truckMasterChanges(t, { capacityCases: 100, capacityWeightKg: 1000 })).toEqual([]);
    expect(truckMasterChanges(t, { capacityCases: 100, capacityWeightKg: 0 })[0].text).toBe(
      'Truck capacity changed after planning: now 100 cases / no payload set (planned with 100 cases / 1000 kg)',
    );
  });
});

describe('planInputsOf', () => {
  const built = {
    request: {
      run_id: 'r', tenant_id: 't',
      depot: { id: 'D1', lat: 23.58, lng: 58.39, open_min: 300, close_min: 1380 },
      trucks: [{ id: 'T1', code: 'T01', capacity_cases: 600, capacity_kg: 8000, fixed_cost: 25, max_trips: 2, available_from_min: 420 }],
      stops: [{ stop_id: 'c1#1', order_ids: ['o1~1'], customer_id: 'c1', lat: 23.6, lng: 58.4, demand_cases: 40, service_min: 22, priority: 1, hard_start_min: 360, hard_end_min: 840 }],
      config: { shift_start_min: 390, reload_min: 20, loading_min_per_case: 0.04, osrm_url: 'http://osrm.internal:5000' },
    },
    settings: planSettingsOf({
      timezone: 'Asia/Muscat', planningCutoffMin: 1080, shiftStartMin: 390, driverShiftMaxMinutes: 600, reloadMinutes: 20, loadingMinPerCase: 0.04,
      serviceMinPerCase: 0.05, maxTripsPerTruck: 3, fuelPricePerLitre: 0.25, driverCostPerHour: 1.5, overtimeAfterMin: 540, overtimeCostPerHour: 0,
      prefWindowPenaltyPerMin: 0.05, roadTimeFactor: 1.25, distanceProvider: 'OSRM', distanceMultiplier: 1.3, avgSpeedKmh: 40, defaultServiceTimeMin: 10,
      osrmUrl: 'http://osrm.internal:5000',
    }),
  } as unknown as BuiltRequest;

  it('keeps the depot, trucks, stops and config the optimizer got - never the OSRM address', () => {
    const inputs = planInputsOf(built, 'J7', new Date('2026-09-26T12:00:00Z'))!;
    expect(inputs).toMatchObject({ v: 1, jobId: 'J7', capturedAt: '2026-09-26T12:00:00.000Z', depot: { id: 'D1', openMin: 300, closeMin: 1380 } });
    expect(inputs.trucks.T1).toMatchObject({ code: 'T01', capacityCases: 600, capacityWeightKg: 8000, maxTripsPerDay: 2, availableFromMin: 420, tripCost: 0 });
    expect(inputs.stops['c1#1']).toEqual({ customerId: 'c1', lat: 23.6, lng: 58.4, hardStartMin: 360, hardEndMin: 840, prefStartMin: null, prefEndMin: null, serviceMin: 22, priority: 1 });
    expect(inputs.config).toMatchObject({ reload_min: 20, loading_min_per_case: 0.04, osrm_configured: true });
    expect(JSON.stringify(inputs)).not.toContain('osrm.internal');
    expect(inputs.settings).toMatchObject({ shiftStartMin: 390, serviceMinPerCase: 0.05, osrmConfigured: true, outsideCoverage: false });
  });

  it('the settings keep the routing decision made when the plan was built (ASSUMPTIONS never re-derives it)', () => {
    const cfg = {
      timezone: 'Asia/Riyadh', planningCutoffMin: 1080, shiftStartMin: 390, driverShiftMaxMinutes: 600, reloadMinutes: 20, loadingMinPerCase: 0,
      serviceMinPerCase: 0, maxTripsPerTruck: 3, fuelPricePerLitre: 0.25, driverCostPerHour: 1.5, overtimeAfterMin: 540, overtimeCostPerHour: 0,
      prefWindowPenaltyPerMin: 0.05, roadTimeFactor: 1.25, distanceProvider: 'OSRM', distanceMultiplier: 1.3, avgSpeedKmh: 40, defaultServiceTimeMin: 10,
      osrmUrl: null,
    };
    expect(planSettingsOf(cfg, { outsideCoverage: true })).toMatchObject({ osrmConfigured: false, outsideCoverage: true });
    expect(planSettingsOf(cfg).outsideCoverage).toBe(false);
  });

  it('an incomplete request keeps no inputs', () => {
    expect(planInputsOf({ request: {} } as unknown as BuiltRequest, null)).toBeNull();
  });
});

describe('masterChangedNotes', () => {
  it('tells planned loads to re-plan, and frozen ones to unlock first', () => {
    const d = fixture();
    const change = [{ kind: 'LOCATION' as const, text: 'Location updated after planning: new pin 1, 2' }];
    d.loads[0].stops[0] = { ...d.loads[0].stops[0], masterChanged: change }; // L1 is LOCKED in the fixture
    d.loads[1].stops[0] = { ...d.loads[1].stops[0], masterChanged: change }; // L2 is PLANNED
    const notes = masterChangedNotes(d.loads);
    expect(notes[0]).toBe('Location or receiving hours changed after this plan was made: C003 (T01 L2). The plan still uses what it was planned with - re-plan to use the new data.');
    expect(notes[1]).toMatch(/^Location or receiving hours changed after these locked or dispatched loads were planned: C001\/B1 \(T01 L1\)/);
    expect(masterChangedNotes(fixture().loads)).toEqual([]);
  });
});

describe('jobMessage', () => {
  const sc = { trips: 5, trucks_used: 3, unserved: [{}], feasibility: { status: 'VERIFIED', timing: 'EXACT', violations: [] } } as unknown as DispatchScenario;

  it('says when the recommended timetable is not verified', () => {
    expect(jobMessage(sc, 1)).toBe('5 loads on 3 trucks, 2 stop(s) unserved');
    const bad = { ...sc, feasibility: { status: 'VIOLATED', timing: 'ESTIMATED', violations: [{ code: 'TURNAROUND', message: 'x' }, { code: 'TURNAROUND', message: 'y' }] } } as unknown as DispatchScenario;
    expect(jobMessage(bad, 0)).toBe('5 loads on 3 trucks, 1 stop(s) unserved. Timetable NOT verified: 2 rule(s) broken (TURNAROUND) - re-plan before locking.');
    expect(jobMessage({ ...sc, feasibility: undefined }, 0)).toMatch(/Timetable not checked by the optimizer \(older optimizer version\)\.$/);
  });
});

describe('FEASIBILITY_GATE startup warning', () => {
  it('warns whenever the emergency switch is on', () => {
    expect(configProblems({ NODE_ENV: 'development', FEASIBILITY_GATE: 'warn' } as NodeJS.ProcessEnv).some((p) => p.message.startsWith('FEASIBILITY_GATE=warn'))).toBe(true);
    expect(configProblems({ NODE_ENV: 'development' } as NodeJS.ProcessEnv).some((p) => p.message.includes('FEASIBILITY_GATE'))).toBe(false);
  });
});
