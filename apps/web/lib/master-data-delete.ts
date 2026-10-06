/**
 * What "Delete" does to a depot or a driver (audit F03 / F20, owner decisions 7 and 8), shared by
 * the API and the confirmation dialogs so both always say the same thing.
 *
 * - A depot that anything refers to (trucks, trucks to hire, regions, plans, orders, order files) is DEACTIVATED,
 *   never deleted: before this rule a depot with orders but no trucks was deleted and its orders
 *   lost their depot (they fell into another depot's plan, or out of every plan). The database
 *   refuses such a delete too (migration 20260930093000_master_data_no_orphans).
 * - A driver is ALWAYS deactivated, never deleted: a delete raced with dispatch and removed the
 *   driver from a dispatched load, and cleared every truck's default driver without a word.
 */

/**
 * Everything that refers to a depot, as a Prisma `_count` select (the API and the Depots page). The
 * trucks it can hire (HireOption, the hire suggestion: its depot key is RESTRICT) too - review of the
 * hire branch: a depot with only hire options was promised a delete, the database refused it, and
 * the toast said "deactivated" without the reason.
 */
export const DEPOT_REF_COUNT = { trucks: true, regions: true, runs: true, orders: true, uploadBatches: true, hireOptions: true } as const;

export interface DepotRefCounts {
  trucks: number;
  regions?: number;
  runs?: number;
  orders?: number;
  uploadBatches?: number;
  /** Trucks to hire (hire options) of the depot. */
  hireOptions?: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 trucks, 1 region and 120 orders": what refers to the depot (empty when nothing does). */
export function depotReferenceText(c: DepotRefCounts): string {
  const parts = [
    c.trucks ? plural(c.trucks, 'truck', 'trucks') : '',
    c.hireOptions ? plural(c.hireOptions, 'truck to hire', 'trucks to hire') : '',
    c.regions ? plural(c.regions, 'region', 'regions') : '',
    c.runs ? plural(c.runs, 'plan', 'plans') : '',
    c.orders ? plural(c.orders, 'order', 'orders') : '',
    c.uploadBatches ? plural(c.uploadBatches, 'order file', 'order files') : '',
  ].filter(Boolean);
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** DEACTIVATE once anything refers to the depot; DELETE only a depot nothing refers to. */
export function depotDeleteOutcome(c: DepotRefCounts): 'DEACTIVATE' | 'DELETE' {
  return depotReferenceText(c) ? 'DEACTIVATE' : 'DELETE';
}

/**
 * The confirmation dialog's text. `c` must hold every reference (the page counts trucks, trucks to
 * hire, regions, plans, orders and order files; null = not known); the API decides again on the
 * database's own counts, and the answer's toast says what it did.
 */
export function depotDeleteDialogText(code: string, c: DepotRefCounts | null): string {
  if (!c) {
    return `Depot ${code} is deactivated, not deleted, if anything refers to it (trucks, trucks to hire, regions, plans, orders or order files); otherwise it is deleted, which cannot be undone.`;
  }
  const refs = depotReferenceText(c);
  if (!refs) return `Nothing refers to depot ${code} yet, so it will be deleted. This cannot be undone.`;
  return `Depot ${code} has ${refs}, so it will be deactivated, not deleted: they keep their depot, and it is no longer offered for new order files and plans. Reactivate it any time with Edit.`;
}

/** The dialog title and button: what will happen ("Delete / deactivate" when the counts are not known). */
export function depotDeleteActionLabel(c: DepotRefCounts | null): string {
  if (!c) return 'Delete / deactivate';
  return depotDeleteOutcome(c) === 'DELETE' ? 'Delete' : 'Deactivate';
}

/** The answer's toast after a depot "delete". */
export function depotDeletedToast(code: string, outcome: { softDeleted?: boolean; references?: string | null }): string {
  if (!outcome.softDeleted) return `Depot ${code} deleted.`;
  return `Depot ${code} deactivated${outcome.references ? ` (it has ${outcome.references})` : ''}. Reactivate it any time with Edit.`;
}

/**
 * The history-only depot (audit PR A5, `Depot.historyOnly`): migration 20260930120000 put the
 * orders and order files that had no depot on it (code NO-DEPOT). It stays inactive: the Depots
 * screen and PATCH /api/depots/:id refuse to switch it on, and no truck or region can use it.
 */
export function historyOnlyDepotMessage(code: string): string {
  return `Depot ${code} only keeps old orders and order files that had no depot. It cannot be made active. Add a new depot instead.`;
}

/** The refusal when a truck or region is put on the history-only depot. */
export function historyOnlyDepotLinkMessage(code: string, what: 'truck' | 'region'): string {
  return `Depot ${code} only keeps old orders and order files that had no depot. Choose an active depot for this ${what}.`;
}

/**
 * The warning when a driver is deactivated (from the Drivers screen or the Active switch): the
 * trucks that still have them as default driver keep that setting - never cleared silently -
 * and new plans skip an inactive driver. Null when no truck has them as default.
 */
export function driverDeactivatedWarning(defaultOfTrucks: string[]): string | null {
  if (!defaultOfTrucks.length) return null;
  const list = defaultOfTrucks.slice(0, 10).join(', ') + (defaultOfTrucks.length > 10 ? ', ...' : '');
  return `This driver is still the default driver of ${defaultOfTrucks.length === 1 ? 'truck' : 'trucks'} ${list}. New plans do not use an inactive driver: choose another default driver under Trucks, or reactivate the driver.`;
}
