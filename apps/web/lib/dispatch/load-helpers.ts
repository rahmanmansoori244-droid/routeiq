/**
 * Helpers (truck crew), owner request 13 Oct 2026: "management asked to track helpers in each truck,
 * so add that like drivers too. We need to know who were the helpers in each truck and load." NMWC
 * trucks go out with a driver plus a helper.
 *
 * The rules, kept as the drivers' (load-state.ts) where they apply:
 *  - A truck has one usual (default) helper (Truck.defaultHelperId); a load has 0 to 3 helpers
 *    (PlanLoadHelper, position 1-3). The optimizer never reads helpers.
 *  - A plan applied (OPTIMIZE, a re-plan, "Use instead", "Use this plan"): frozen loads keep their
 *    helpers. A trip whose load in the version had helpers set by hand (the marker,
 *    PlanLoad.helpersSetById / helpersSetAt, with at least one helper) keeps them and the marker -
 *    only the ones still active. Every other trip gets the truck's usual helper when he is active and
 *    not already on a trip of the plan at an overlapping time (like pass 2 of planDrivers: a person
 *    is not given two trips at once); else no helper. "No helpers" set by hand is not kept (as "No
 *    driver"): the next plan fills the trip in again.
 *  - The dispatcher sets the helpers of a load in the same states as its driver: until it is
 *    dispatched (checkHelpersChange). Allowed on overlapping loads, as a driver picked by hand (the
 *    answer warns). Audited LOAD_HELPERS_CHANGED with the names before and after.
 *  - Every new plan version copies each load's helpers with the load (createNextVersionTx).
 *
 * Pure and browser-safe (the plan screen imports it); the database side is load-helpers-service.ts.
 */
import type { Prisma } from '@prisma/client';
import { ON_ROAD, timesOverlap, type LoadStatusName } from './load-state';

/** The Helper columns a screen or API sends. */
export const HELPER_PUBLIC_SELECT = {
  id: true,
  tenantId: true,
  code: true,
  name: true,
  phone: true,
  active: true,
} as const satisfies Prisma.HelperSelect;

/** At most this many helpers go out on one load (also lib/schemas.ts and the database CHECK). */
export const MAX_HELPERS = 3;

/** "Saif, Omar" - the helpers' names in their order; null without one. */
export function helpersText(names: readonly (string | null | undefined)[]): string | null {
  const shown = names.map((n) => (n ?? '').trim()).filter(Boolean);
  return shown.length ? shown.join(', ') : null;
}

/** The deactivation warning (as driverDeactivatedWarning): the trucks that keep him as their usual helper. */
export function helperDeactivatedWarning(defaultOfTrucks: string[]): string | null {
  if (!defaultOfTrucks.length) return null;
  const list = defaultOfTrucks.slice(0, 10).join(', ') + (defaultOfTrucks.length > 10 ? ', ...' : '');
  return `This helper is still the usual helper of ${defaultOfTrucks.length === 1 ? 'truck' : 'trucks'} ${list}. New plans do not use an inactive helper: choose another usual helper on the Helpers page, or reactivate the helper.`;
}

/** The short message after a truck's usual helper was set (`helperName`) or cleared (null). */
export function usualHelperChangedMessage(truckCode: string, helperName: string | null): string {
  if (helperName === null) return `Usual helper of ${truckCode} cleared. Re-plan days already planned to apply it.`;
  return `Usual helper of ${truckCode} is now ${helperName}. Re-plan days already planned to use him.`;
}

/** The helpers of a load were set by the dispatcher (the marker; "No helpers" too). */
export function helpersSetByDispatcher(l: { helpersSetById?: string | null; helpersSetAt?: Date | string | null }): boolean {
  return l.helpersSetAt != null || l.helpersSetById != null;
}

/** Hand-set helpers: at least one helper and the dispatcher's marker. A re-plan keeps them on this truck and trip. */
export function isHandSetHelpers(l: { helperIds: readonly string[]; helpersSetById?: string | null; helpersSetAt?: Date | string | null }): boolean {
  return l.helperIds.length > 0 && helpersSetByDispatcher(l);
}

export type HelpersChangeCheck = { ok: true; unchanged: boolean } | { ok: false; reason: string };

/** The same lists in the same order. */
export function sameHelpers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Can the helpers of a load in `status` change to `next`? As the driver (checkDriverChange): any time
 * until the load is dispatched; re-sending the current list is not a change.
 */
export function checkHelpersChange(load: { status: LoadStatusName; helperIds: readonly string[] }, next: readonly string[]): HelpersChangeCheck {
  if (sameHelpers(load.helperIds, next)) return { ok: true, unchanged: true };
  if (ON_ROAD.has(load.status)) return { ok: false, reason: 'Helpers cannot change after dispatch.' };
  return { ok: true, unchanged: false };
}

/** A new trip of the plan being applied. */
export interface HelperTrip {
  key: string;
  truckId: string;
  loadNo: number;
  departMin: number;
  returnMin: number;
  defaultHelperId: string | null;
}

/** A load of the version the plan is applied to, as it is right before the apply. */
export interface HelperEvidence {
  truckId: string;
  loadNo: number;
  status: LoadStatusName | string;
  departMin: number;
  returnMin: number;
  helperIds: string[];
  helpersSetById: string | null;
  helpersSetAt: Date | null;
}

export interface TripHelpers {
  helperIds: string[];
  helpersSetById: string | null;
  helpersSetAt: Date | null;
}

const NO_HELPERS: TripHelpers = { helperIds: [], helpersSetById: null, helpersSetAt: null };

/**
 * The helpers of each new trip (see the top of this file). `active`: the company's active helpers.
 * Frozen evidence loads (any status but PLANNED) stay in the plan with their helpers and their times.
 */
export function planHelpers(trips: readonly HelperTrip[], evidence: readonly HelperEvidence[], active: ReadonlySet<string>): Map<string, TripHelpers> {
  const out = new Map<string, TripHelpers>();
  const busy: { helperId: string; departMin: number; returnMin: number }[] = [];
  const take = (ids: readonly string[], t: { departMin: number; returnMin: number }) => {
    for (const helperId of ids) busy.push({ helperId, departMin: t.departMin, returnMin: t.returnMin });
  };
  const free = (helperId: string, t: { departMin: number; returnMin: number }) => !busy.some((b) => b.helperId === helperId && timesOverlap(b, t));
  for (const e of evidence) if (e.status !== 'PLANNED') take(e.helperIds, e);
  const tripKey = (x: { truckId: string; loadNo: number }) => `${x.truckId}:${x.loadNo}`;
  const planned = new Map(evidence.filter((e) => e.status === 'PLANNED').map((e) => [tripKey(e), e]));
  // Pass 1: helpers the dispatcher set by hand stay on this truck and trip (the active ones), with the marker.
  const rest: HelperTrip[] = [];
  for (const t of trips) {
    const e = planned.get(tripKey(t));
    const kept = e && isHandSetHelpers(e) ? e.helperIds.filter((id) => active.has(id)) : [];
    if (e && kept.length) {
      out.set(t.key, { helperIds: kept, helpersSetById: e.helpersSetById, helpersSetAt: e.helpersSetAt });
      take(kept, t);
    } else rest.push(t);
  }
  // Pass 2: the truck's usual helper, active and not on an overlapping trip already given out.
  for (const t of rest) {
    const h = t.defaultHelperId;
    if (h && active.has(h) && free(h, t)) {
      out.set(t.key, { helperIds: [h], helpersSetById: null, helpersSetAt: null });
      take([h], t);
    } else out.set(t.key, NO_HELPERS);
  }
  return out;
}

/** A load and its helpers' times: two loads of one helper at overlapping times (the answer's warning). */
export function helperClashes(
  loadId: string,
  loads: readonly { id: string; truckCode: string; loadNo: number; departMin: number; returnMin: number; helpers?: readonly { id: string; name: string }[] }[],
): string[] {
  const me = loads.find((l) => l.id === loadId);
  if (!me) return [];
  const out: string[] = [];
  for (const h of me.helpers ?? []) {
    for (const o of loads) {
      if (o.id === me.id || !(o.helpers ?? []).some((x) => x.id === h.id) || !timesOverlap(o, me)) continue;
      out.push(`${h.name} is also on ${o.truckCode} · L${o.loadNo} at that time.`);
    }
  }
  return out;
}
