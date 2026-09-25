/**
 * Load lifecycle rules. Physical reality drives them: the warehouse loads a truck's Load 1
 * before Load 2, and nothing on the road can be re-planned (no trustworthy live position).
 *
 *   PLANNED  -> LOCKED        planner; all earlier loads of the truck must already be frozen
 *   LOCKED   -> PLANNED       planner (unlock); later loads of the truck must still be PLANNED
 *   LOCKED   -> LOADING       planner
 *   LOADING  -> LOCKED        planner (loading paused/cancelled)
 *   LOCKED | LOADING -> DISPATCHED   supervisor; earlier loads must be DISPATCHED/COMPLETED
 *   DISPATCHED -> COMPLETED   supervisor
 *   DISPATCHED / COMPLETED    immutable otherwise
 *
 * "Frozen" = anything but PLANNED: a re-plan keeps frozen loads exactly as they are.
 */
export type LoadStatusName = 'PLANNED' | 'LOCKED' | 'LOADING' | 'DISPATCHED' | 'COMPLETED';

export const FROZEN: ReadonlySet<LoadStatusName> = new Set(['LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED']);
export const ON_ROAD: ReadonlySet<LoadStatusName> = new Set(['DISPATCHED', 'COMPLETED']);

export function isFrozen(s: LoadStatusName) {
  return FROZEN.has(s);
}

export interface LoadRef {
  id: string;
  loadNo: number;
  status: LoadStatusName;
}

export type TransitionCheck =
  | { ok: true; role: 'PLANNER' | 'SUPERVISOR' }
  | { ok: false; reason: string };

const ALLOWED: Record<LoadStatusName, LoadStatusName[]> = {
  PLANNED: ['LOCKED'],
  LOCKED: ['PLANNED', 'LOADING', 'DISPATCHED'],
  LOADING: ['LOCKED', 'DISPATCHED'],
  DISPATCHED: ['COMPLETED'],
  COMPLETED: [],
};

export function checkTransition(load: LoadRef, sameTruckLoads: LoadRef[], to: LoadStatusName): TransitionCheck {
  if (load.status === to) return { ok: false, reason: `Load is already ${to}.` };
  if (!ALLOWED[load.status].includes(to)) {
    if (ON_ROAD.has(load.status)) {
      return { ok: false, reason: `Load ${load.loadNo} is ${load.status} and can no longer be changed.` };
    }
    return { ok: false, reason: `A ${load.status} load cannot move to ${to}.` };
  }
  const earlier = sameTruckLoads.filter((l) => l.id !== load.id && l.loadNo < load.loadNo);
  const later = sameTruckLoads.filter((l) => l.id !== load.id && l.loadNo > load.loadNo);
  if (to === 'LOCKED' && load.status === 'PLANNED') {
    const open = earlier.filter((l) => !isFrozen(l.status));
    if (open.length) {
      return { ok: false, reason: `Lock Load ${open.map((l) => l.loadNo).join(', ')} of this truck first - loads are loaded in order.` };
    }
  }
  if (to === 'PLANNED') {
    const frozenLater = later.filter((l) => isFrozen(l.status));
    if (frozenLater.length) {
      return { ok: false, reason: `Unlock Load ${frozenLater.map((l) => l.loadNo).join(', ')} of this truck first.` };
    }
  }
  if (to === 'DISPATCHED') {
    const notOut = earlier.filter((l) => !ON_ROAD.has(l.status));
    if (notOut.length) {
      return { ok: false, reason: `Dispatch Load ${notOut.map((l) => l.loadNo).join(', ')} of this truck first.` };
    }
  }
  const role = to === 'DISPATCHED' || to === 'COMPLETED' ? 'SUPERVISOR' : 'PLANNER';
  return { ok: true, role };
}

export interface DriverOnLoad {
  truckId: string;
  loadNo: number;
  driverId: string | null;
}

/**
 * Driver for a (re-)planned load of `truckId`, taken from existing loads: the same trip if it
 * had a driver, else the nearest trip of that truck (the earlier one on a tie - the driver who
 * did Load 1 usually takes Load 2). Only drivers in `usable` (active, this tenant) count.
 */
export function pickLoadDriver(loads: DriverOnLoad[], truckId: string, loadNo: number, usable: ReadonlySet<string>): string | null {
  const withDriver = loads.filter((l) => l.truckId === truckId && l.driverId !== null && usable.has(l.driverId));
  withDriver.sort((a, b) => Math.abs(a.loadNo - loadNo) - Math.abs(b.loadNo - loadNo) || a.loadNo - b.loadNo);
  return withDriver[0]?.driverId ?? null;
}
