/**
 * Frozen plan facts (review F08). A plan is computed from master data that keeps changing: a pin
 * is corrected, receiving hours change, a truck's payload is edited, the settings are tuned. A
 * plan version - above all a locked, dispatched or superseded one - must keep showing what it was
 * planned with, and say clearly when the master data changed afterwards, never switch silently.
 *
 * Three snapshots, all plain JSON (no database access here, shared by the server and the browser):
 * - PlanInputs, in each option's ScenarioDetails.inputs: the depot, trucks, stops (pin, hours,
 *   service time, priority) and settings exactly as sent to the optimizer, plus the job id;
 * - StopSnapshot, RouteAssignment.stopSnapshotJson: one stop's facts (inputs + name, address,
 *   access notes from the customer when the plan was applied);
 * - TruckSnapshot, PlanLoad.truckSnapshotJson: the truck and the planning rules the load was timed
 *   with (turnaround, shift, depot hours, trips).
 * Rows made before the snapshots existed hold null: the live master data is shown, labelled as
 * such (snapshot: false), and nothing can be said about changes since.
 *
 * Contact details stay live, like the driver's name and phone: the customer's access notes (gate,
 * forklift, receiver phone) are printed as they are now - they do not change the timetable, and a
 * correction must reach the driver. The snapshot keeps the notes the plan was made with, for the record.
 */
import type { DispatchConfig } from '@routeiq/shared-types';

export const SNAPSHOT_VERSION = 1;

/** The rules a load's timetable was computed with (the solver's truck-day rules). */
export interface PlanRules {
  shiftStartMin: number;
  shiftMaxMin: number;
  reloadMin: number;
  loadingMinPerCase: number;
  /** Loads per day for this truck (its own limit, else the tenant's). */
  maxTrips: number;
  depotOpenMin: number;
  depotCloseMin: number;
  availableFromMin: number | null;
  availableToMin: number | null;
}

export interface TruckFacts {
  code: string;
  capacityCases: number;
  /** 0 = no payload set (kg not constrained). */
  capacityWeightKg: number;
  fixedCostPerDay: number;
  tripCost: number;
  costPerKm: number;
  kmPerLitre: number | null;
  availableFromMin: number | null;
  availableToMin: number | null;
  maxTripsPerDay: number | null;
}

export interface StopFacts {
  customerId: string;
  lat: number;
  lng: number;
  hardStartMin: number | null;
  hardEndMin: number | null;
  prefStartMin: number | null;
  prefEndMin: number | null;
  serviceMin: number;
  priority: number;
}

/**
 * Tenant settings as the plan used them, for the workbook's ASSUMPTIONS sheet (the fields of
 * workbook.AssumptionConfig; the OSRM address itself is not kept, only whether one was set).
 */
export interface PlanSettings {
  timezone: string;
  planningCutoffMin: number;
  shiftStartMin: number;
  driverShiftMaxMinutes: number;
  reloadMinutes: number;
  loadingMinPerCase: number;
  serviceMinPerCase: number;
  maxTripsPerTruck: number;
  fuelPricePerLitre: number;
  driverCostPerHour: number;
  overtimeAfterMin: number;
  overtimeCostPerHour: number;
  prefWindowPenaltyPerMin: number;
  roadTimeFactor: number;
  distanceProvider: string;
  distanceMultiplier: number;
  avgSpeedKmh: number;
  defaultServiceTimeMin: number;
  osrmConfigured: boolean;
  /** The tenant is outside the shared OSRM map (Oman + UAE) and has no OSRM of its own, so the plan
   * was built on straight-line estimates. Absent on settings stored before it was kept. */
  outsideCoverage?: boolean;
}

/** What one optimization was computed with (ScenarioDetails.inputs). */
export interface PlanInputs {
  v: number;
  jobId: string | null;
  capturedAt: string;
  depot: { id: string; lat: number; lng: number; openMin: number; closeMin: number };
  trucks: Record<string, TruckFacts>;
  stops: Record<string, StopFacts>;
  /** The optimizer's config block, without the OSRM address. */
  config: Omit<DispatchConfig, 'osrm_url'> & { osrm_configured: boolean };
  settings: PlanSettings | null;
}

export interface StopSnapshot extends Omit<StopFacts, 'lat' | 'lng' | 'serviceMin' | 'priority'> {
  v: number;
  code: string;
  branchCode: string | null;
  name: string;
  customerType: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  accessNotes: string | null;
  serviceMin: number | null;
  priority: number | null;
  /** PLAN = pin / hours / service time exactly as sent to the optimizer; MASTER = read from the
   * customer when the option was applied (an option stored before plan inputs existed). */
  source: 'PLAN' | 'MASTER';
  capturedAt: string;
}

export interface TruckSnapshot extends TruckFacts {
  v: number;
  rules: PlanRules | null;
  source: 'PLAN' | 'MASTER';
  capturedAt: string;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

export function readStopSnapshot(json: unknown): StopSnapshot | null {
  return isObj(json) && typeof json.v === 'number' && typeof json.customerId === 'string' ? (json as unknown as StopSnapshot) : null;
}

export function readTruckSnapshot(json: unknown): TruckSnapshot | null {
  return isObj(json) && typeof json.v === 'number' && typeof json.capacityCases === 'number' ? (json as unknown as TruckSnapshot) : null;
}

export function readPlanInputs(json: unknown): PlanInputs | null {
  return isObj(json) && typeof json.v === 'number' && isObj(json.config) && isObj(json.stops) && isObj(json.trucks) ? (json as unknown as PlanInputs) : null;
}

/** The planning rules of a load on `truck`, from the optimizer config and depot it was planned with. */
export function rulesFrom(
  config: Pick<DispatchConfig, 'shift_start_min' | 'shift_max_min' | 'reload_min' | 'loading_min_per_case' | 'max_trips_per_truck'>,
  depot: { openMin?: number | null; closeMin?: number | null; open_min?: number | null; close_min?: number | null },
  truck: { availableFromMin?: number | null; availableToMin?: number | null; maxTripsPerDay?: number | null },
): PlanRules {
  const close = depot.closeMin ?? depot.close_min ?? 1440;
  return {
    shiftStartMin: config.shift_start_min ?? 360,
    shiftMaxMin: config.shift_max_min ?? 660,
    reloadMin: config.reload_min ?? 30,
    loadingMinPerCase: config.loading_min_per_case ?? 0,
    maxTrips: truck.maxTripsPerDay || config.max_trips_per_truck || 3,
    depotOpenMin: depot.openMin ?? depot.open_min ?? 0,
    depotCloseMin: close > 0 ? close : 1440,
    availableFromMin: truck.availableFromMin ?? null,
    availableToMin: truck.availableToMin ?? null,
  };
}

// ---------------------------------------------------------------------------------------
// "Changed after planning"
// ---------------------------------------------------------------------------------------

export type MasterChangeKind = 'LOCATION' | 'HOURS' | 'NAME' | 'ADDRESS' | 'CAPACITY';

export interface MasterChange {
  kind: MasterChangeKind;
  /** One line for the dispatcher / driver, e.g. "Location updated after planning: new pin 23.61234, 58.45678 (moved 420 m)". */
  text: string;
  /** LOCATION: the new pin (the plan and the sheet keep the planned one). */
  newLat?: number | null;
  newLng?: number | null;
  movedM?: number | null;
}

/** A pin corrected by less than this is the same place (GPS noise, a re-pasted link). */
export const PIN_MOVED_M = 50;

export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const hhmm = (m: number | null) => (m === null ? '--:--' : `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
const win = (s: number | null, e: number | null) => (s === null && e === null ? 'any time' : `${hhmm(s)}–${hhmm(e)}`);
const norm = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ');

/**
 * A window ending before it starts cannot be planned (the solver would reject the whole day):
 * buildDispatchRequest drops it for the plan (null / null, with a "Time window ignored" warning).
 * The same rule is applied wherever a window is compared with what was planned, so such legacy
 * data never reads as "changed after planning" or as a missed window.
 */
export function usableWindow(start: number | null, end: number | null): { start: number | null; end: number | null; ok: boolean } {
  if (start != null && end != null && end < start) return { start: null, end: null, ok: false };
  return { start, end, ok: true };
}

/** The customer as it is now (effective receiving hours: own, else type, else default). */
export interface LiveStopFacts {
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  hardStartMin: number | null;
  hardEndMin: number | null;
  prefStartMin: number | null;
  prefEndMin: number | null;
}

/**
 * What changed in the customer master since the stop was planned (empty = nothing that matters).
 * Both sides' windows go through usableWindow first: an inverted window was planned as "any time",
 * so the same inverted window today is no change (it would otherwise keep the day out of date
 * after every re-plan).
 */
export function stopMasterChanges(snapIn: StopSnapshot, liveIn: LiveStopFacts): MasterChange[] {
  const out: MasterChange[] = [];
  const hardThenW = usableWindow(snapIn.hardStartMin, snapIn.hardEndMin);
  const prefThenW = usableWindow(snapIn.prefStartMin, snapIn.prefEndMin);
  const hardNowW = usableWindow(liveIn.hardStartMin, liveIn.hardEndMin);
  const prefNowW = usableWindow(liveIn.prefStartMin, liveIn.prefEndMin);
  const snap = { ...snapIn, hardStartMin: hardThenW.start, hardEndMin: hardThenW.end, prefStartMin: prefThenW.start, prefEndMin: prefThenW.end };
  const live = { ...liveIn, hardStartMin: hardNowW.start, hardEndMin: hardNowW.end, prefStartMin: prefNowW.start, prefEndMin: prefNowW.end };
  if (live.lat !== null && live.lng !== null) {
    if (snap.lat === null || snap.lng === null) {
      out.push({ kind: 'LOCATION', text: `Location added after planning: pin ${live.lat.toFixed(5)}, ${live.lng.toFixed(5)}`, newLat: live.lat, newLng: live.lng, movedM: null });
    } else {
      const moved = distanceM({ lat: snap.lat, lng: snap.lng }, { lat: live.lat, lng: live.lng });
      if (moved > PIN_MOVED_M) {
        out.push({
          kind: 'LOCATION',
          text: `Location updated after planning: new pin ${live.lat.toFixed(5)}, ${live.lng.toFixed(5)} (${moved >= 1000 ? `${(moved / 1000).toFixed(1)} km` : `${Math.round(moved)} m`} from the planned one)`,
          newLat: live.lat,
          newLng: live.lng,
          movedM: Math.round(moved),
        });
      }
    }
  } else if (snap.lat !== null && snap.lng !== null) {
    out.push({ kind: 'LOCATION', text: 'Location removed from the customer after planning.', newLat: null, newLng: null, movedM: null });
  }
  const hardNow = win(live.hardStartMin, live.hardEndMin);
  const hardThen = win(snap.hardStartMin, snap.hardEndMin);
  const prefNow = win(live.prefStartMin, live.prefEndMin);
  const prefThen = win(snap.prefStartMin, snap.prefEndMin);
  if (hardNow !== hardThen || prefNow !== prefThen) {
    const parts = [hardNow !== hardThen ? `receives ${hardNow} (planned with ${hardThen})` : null, prefNow !== prefThen ? `best ${prefNow} (planned with ${prefThen})` : null];
    out.push({ kind: 'HOURS', text: `Receiving hours changed after planning: now ${parts.filter(Boolean).join(', ')}` });
  }
  if (norm(live.name) !== norm(snap.name)) out.push({ kind: 'NAME', text: `Customer name changed after planning: now "${norm(live.name)}"` });
  if (norm(live.address) !== norm(snap.address)) {
    out.push({ kind: 'ADDRESS', text: live.address ? `Address changed after planning: now "${norm(live.address)}"` : 'Address removed after planning.' });
  }
  return out;
}

/**
 * Why the plan in use is out of date on its PLANNED loads because master data was corrected since
 * it was made (the day screen's "out of date, RE-PLAN", review F08): customers whose pin or
 * receiving hours changed, and trucks whose capacity or payload changed. Rows without a snapshot
 * (planned before snapshots existed) say nothing.
 */
export function plannedLoadsMasterChanged(
  stops: { customerId: string; stopSnapshotJson: unknown; live: LiveStopFacts }[],
  loads: { truckId: string; truckSnapshotJson: unknown; live: { capacityCases: number; capacityWeightKg: number } | null }[],
): { customers: number; trucks: number } {
  const customers = new Set<string>();
  for (const s of stops) {
    const snap = readStopSnapshot(s.stopSnapshotJson);
    if (!snap || customers.has(s.customerId)) continue;
    if (stopMasterChanges(snap, s.live).some((c) => c.kind === 'LOCATION' || c.kind === 'HOURS')) customers.add(s.customerId);
  }
  const trucks = new Set<string>();
  for (const l of loads) {
    const snap = readTruckSnapshot(l.truckSnapshotJson);
    if (snap && l.live && truckMasterChanges(snap, l.live).length) trucks.add(l.truckId);
  }
  return { customers: customers.size, trucks: trucks.size };
}

/** What changed on the truck since the load was planned (capacity / payload only). */
export function truckMasterChanges(snap: TruckSnapshot, live: { capacityCases: number; capacityWeightKg: number }): MasterChange[] {
  const out: MasterChange[] = [];
  if (live.capacityCases !== snap.capacityCases || Math.abs(live.capacityWeightKg - snap.capacityWeightKg) > 0.05) {
    out.push({
      kind: 'CAPACITY',
      text: `Truck capacity changed after planning: now ${live.capacityCases} cases / ${live.capacityWeightKg ? `${Math.round(live.capacityWeightKg)} kg` : 'no payload set'} (planned with ${snap.capacityCases} cases / ${snap.capacityWeightKg ? `${Math.round(snap.capacityWeightKg)} kg` : 'no payload set'})`,
    });
  }
  return out;
}
