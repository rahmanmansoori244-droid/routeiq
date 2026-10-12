/**
 * "Small truck only" customers (owner request after the first live night, 12 Oct 2026: "some customers
 * have an unloading area only suitable for 3-ton trucks; the plan gave them big trucks and the
 * dispatcher had to re-do it by hand").
 *
 * Owner decisions 13 Oct 2026:
 *  - one yes/no per customer, "Small truck only (3-ton)" (Customer.smallTruckOnly), set in the Details
 *    dialog, the customer import (column small_truck_only) and the two customer workbooks;
 *  - one company setting, "A small truck has at most N bays" (TenantConfig.smallTruckMaxBays, 6 by
 *    default: NMWC's 3-ton trucks have 4-6 bays, the 10-ton 11-12). A truck WITHOUT bays is never small.
 *
 * What it does:
 *  - planning (buildDispatchRequest): every stop of such a customer carries allowed_truck_ids = the day's
 *    trucks (own and hired for the day) with bays <= N, and the hire check adds the trucks it may rent of
 *    that size; split deliveries of such a customer are sized for those trucks only. The optimizer keeps
 *    the list in every engine; an order none of them can take is left out with NO_ALLOWED_TRUCK ("Needs a
 *    small truck (at most N bays): ...");
 *  - LOCK / LOADING / DISPATCH refuse a load that carries such a customer on a bigger truck (409
 *    SMALL_TRUCK_ONLY, plan-service smallTruckGate): it also covers a customer marked, or a setting
 *    lowered, after the plan was made;
 *  - the plan screen, the driver sheet and the warehouse load sheet print "SMALL TRUCK ONLY".
 *
 * Pure (no database): shared by the server, the dialog and the import.
 */
import type { DispatchStop, DispatchTruck } from '@routeiq/shared-types';

/** TenantConfig.smallTruckMaxBays until an admin changes it (the schema has the same default). */
export const SMALL_TRUCK_MAX_BAYS_DEFAULT = 6;

/** The words the plan screen and the sheets print next to such a customer. */
export const SMALL_TRUCK_BADGE = 'SMALL TRUCK ONLY';

/** The customer field's label (Details dialog, customer page, import page). */
export const SMALL_TRUCK_FIELD_LABEL = 'Small truck only (3-ton)';

/** The 409 code of LOCK / LOADING / DISPATCH on a load that has such a customer on a bigger truck. */
export const SMALL_TRUCK_GATE_CODE = 'SMALL_TRUCK_ONLY';

/** The company setting as stored, or the default (an old row, a test stub). */
export function smallTruckMaxBaysOf(cfg: { smallTruckMaxBays?: number | null } | null | undefined): number {
  const n = cfg?.smallTruckMaxBays;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : SMALL_TRUCK_MAX_BAYS_DEFAULT;
}

/** A truck with bays and at most `maxBays` of them. A truck without bays is never small (owner decision). */
export function isSmallTruck(bays: number | null | undefined, maxBays: number): boolean {
  return typeof bays === 'number' && bays > 0 && bays <= maxBays;
}

/** "a small truck (at most 6 bays)": the optimizer's reasons and the plan's messages use these words. */
export function smallTruckLabel(maxBays: number): string {
  return `a small truck (at most ${maxBays} bay${maxBays === 1 ? '' : 's'})`;
}

/** The ids of the trucks a small-truck-only customer may go on. */
export function smallTruckIds(trucks: readonly { id: string; bays?: number | null }[], maxBays: number): string[] {
  return trucks.filter((t) => isSmallTruck(t.bays, maxBays)).map((t) => t.id);
}

/**
 * The request fields of a small-truck-only customer's stop (spread into each stop and each part of a
 * split delivery); {} for any other customer, so a day without such customers sends exactly what it
 * sent before.
 */
export function smallTruckStopFields(
  smallTruckOnly: boolean,
  allowedIds: readonly string[],
  maxBays: number,
): Pick<DispatchStop, 'allowed_truck_ids' | 'allowed_trucks_label'> {
  return smallTruckOnly ? { allowed_truck_ids: [...allowedIds], allowed_trucks_label: smallTruckLabel(maxBays) } : {};
}

/**
 * The hire check's trucks to rent added to the stops that are limited (allowed_truck_ids set): a truck
 * to rent of a small size may carry them, a bigger one may not (owner request: "a suggested hire for
 * such customers must be small"). Returns new stops; the others are returned as they are.
 */
export function withSmallHires(stops: readonly DispatchStop[], hires: readonly DispatchTruck[], maxBays: number): DispatchStop[] {
  const small = smallTruckIds(hires.map((t) => ({ id: t.id, bays: t.bays ?? null })), maxBays);
  if (!small.length) return [...stops];
  return stops.map((s) => (Array.isArray(s.allowed_truck_ids) ? { ...s, allowed_truck_ids: [...new Set([...s.allowed_truck_ids, ...small])] } : s));
}

/**
 * The customer import's small-truck column: `small_truck_only` (as the downloaded master and
 * data-to-collect files have it), or `small truck only`, `small_truck`, `small truck`, `small truck only
 * (3-ton)` (any letter case; spaces, dashes and brackets count as one "_"). The first such column with a
 * value wins. Null when the file has none or every such cell is blank (a blank cell keeps the saved value).
 */
export function importedSmallTruckCell(row: Record<string, string>): { column: string; value: string } | null {
  for (const [key, raw] of Object.entries(row)) {
    const norm = key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!SMALL_TRUCK_HEADERS.has(norm)) continue;
    const value = (raw ?? '').toString().trim();
    if (value) return { column: key, value };
  }
  return null;
}
const SMALL_TRUCK_HEADERS = new Set(['small_truck_only', 'small_truck', 'small_truck_only_3_ton', 'small_truck_3_ton', 'small_trucks_only']);

/** The column's words in the workbooks (the master and the data-to-collect sheet). */
export const SMALL_TRUCK_COLUMN_TEXT =
  'yes = the unloading area takes small trucks only (3-ton): the planner never sends a bigger truck. no = any truck. A blank cell keeps the saved value.';

/**
 * A yes / no cell of the import: true, false, null (blank: keep), or why it is refused. Same words as
 * every yes / no column (yes, y, true, 1, x / no, n, false, 0).
 */
export function readSmallTruckCell(raw: string | null | undefined, column = 'small_truck_only'): { ok: true; value: boolean | null } | { ok: false; error: string } {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return { ok: true, value: null };
  if (['yes', 'y', 'true', '1', 'x'].includes(s)) return { ok: true, value: true };
  if (['no', 'n', 'false', '0'].includes(s)) return { ok: true, value: false };
  return { ok: false, error: `${column} must be yes or no (got "${(raw ?? '').trim()}").` };
}

/** One small-truck-only customer on a load whose truck is too big (or has no bays). */
export interface SmallTruckBreach {
  customerId: string;
  code: string;
  branchCode: string | null;
  name: string;
}

/**
 * The customers of a load that may not go on its truck: marked small truck only (as they are now) while
 * the truck (as it is now) has no bays or more than `maxBays`. Empty: the load may go.
 */
export function smallTruckBreaches(
  truck: { bays: number | null | undefined },
  customers: readonly (SmallTruckBreach & { smallTruckOnly: boolean })[],
  maxBays: number,
): SmallTruckBreach[] {
  if (isSmallTruck(truck.bays, maxBays)) return [];
  const seen = new Set<string>();
  const out: SmallTruckBreach[] = [];
  for (const c of customers) {
    if (!c.smallTruckOnly || seen.has(c.customerId)) continue;
    seen.add(c.customerId);
    out.push({ customerId: c.customerId, code: c.code, branchCode: c.branchCode, name: c.name });
  }
  return out;
}

const GATE_TARGET: Record<string, string> = { LOCKED: 'lock', LOADING: 'start loading', DISPATCHED: 'dispatch' };

/**
 * The 409 message of the gate: the load, the truck, the customers and the remedy. `from`: the load's
 * status now (a LOCKED or LOADING load goes back to Planned before a re-plan can move its orders).
 */
export function smallTruckGateMessage(
  load: { truckCode: string; loadNo: number; bays: number | null | undefined; from: string; to: string },
  breaches: readonly SmallTruckBreach[],
  maxBays: number,
): string {
  const names = breaches.map((b) => `${b.code}${b.branchCode ? `/${b.branchCode}` : ''} ${b.name}`).join(', ');
  const size = typeof load.bays === 'number' ? `${load.bays} bays` : 'no bays entered';
  const replan = load.from === 'PLANNED' ? 'RE-PLAN' : 'Put this load back to Planned, then RE-PLAN';
  return (
    `${load.truckCode} L${load.loadNo}: cannot ${GATE_TARGET[load.to] ?? 'move'} this load. ${load.truckCode} (${size}) is not a small truck, ` +
    `but ${breaches.length === 1 ? 'this customer takes' : 'these customers take'} small trucks only (at most ${maxBays} bays): ${names}. ` +
    `${replan}: RouteIQ puts them on a small truck. If the customer accepts this truck today, untick "${SMALL_TRUCK_FIELD_LABEL}" on the customer first.`
  );
}
