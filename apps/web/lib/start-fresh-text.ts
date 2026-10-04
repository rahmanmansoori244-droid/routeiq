/**
 * "Start fresh (remove test data)" (owner request 4 Oct 2026, before the pilot): the words the
 * Settings panel and the API share. Pure (no server imports): the panel is a client component.
 * The server side (what is removed, in which order, under which locks) is lib/start-fresh.ts.
 */

/** What Start fresh removes, in the order the panel lists it. `sub`: a part of the line above (not added to the total). */
export const START_FRESH_REMOVED = [
  { key: 'uploadBatches', label: 'Order files' },
  { key: 'orders', label: 'Orders' },
  { key: 'lateOrders', label: 'of which late orders', sub: true },
  { key: 'broughtForward', label: 'of which brought forward from an earlier day', sub: true },
  { key: 'deliveryTimes', label: 'of which with a delivery time of their own', sub: true },
  { key: 'orderLines', label: 'Order lines' },
  { key: 'planVersions', label: 'Plan versions' },
  { key: 'planOptions', label: 'Plan options' },
  { key: 'optimizationJobs', label: 'Optimization runs' },
  { key: 'loads', label: 'Loads' },
  { key: 'stops', label: 'Stops on the loads' },
  { key: 'unserved', label: 'Unserved list rows' },
  { key: 'driverLinks', label: 'Driver links (QR codes)' },
  { key: 'stopVisits', label: 'Delivery results (stops)' },
  { key: 'stopEvents', label: 'Arrivals, departures and result records' },
  { key: 'deliveryPhotos', label: 'Delivery photos' },
  { key: 'dailyDrivers', label: 'Daily drivers with no load left' },
  { key: 'baselines', label: 'Manual comparison baselines' },
  { key: 'oldDriverApp', label: 'Old driver app records (retired app)' },
] as const;

/** What Start fresh never touches, with a count so the owner sees it is there. */
export const START_FRESH_KEPT = [
  { key: 'customers', label: 'Customers (with their locations and confirmed hours)' },
  { key: 'products', label: 'Products' },
  { key: 'trucks', label: 'Trucks' },
  { key: 'drivers', label: 'Drivers (regular)' },
  { key: 'dailyDrivers', label: 'Daily drivers still on a kept load' },
  { key: 'depots', label: 'Depots' },
  { key: 'regions', label: 'Regions' },
  { key: 'users', label: 'Users' },
  { key: 'auditRows', label: 'Audit log rows (never deleted)' },
] as const;

export type StartFreshRemovedKey = (typeof START_FRESH_REMOVED)[number]['key'];
export type StartFreshKeptKey = (typeof START_FRESH_KEPT)[number]['key'];
export type StartFreshRemoved = Record<StartFreshRemovedKey, number>;
export type StartFreshKept = Record<StartFreshKeptKey, number>;

/** Why Start fresh cannot run now. */
export type StartFreshBlockerCode = 'OPTIMIZATION_RUNNING' | 'CARRIED_ACROSS_DATE' | 'PLAN_ACROSS_DATE';

export interface StartFreshBlocker {
  code: StartFreshBlockerCode;
  message: string;
}

/** The preview (GET) and, after a run, the summary (POST): the same shape. */
export interface StartFreshReport {
  /** null = everything; else only data with a delivery date before this day (YYYY-MM-DD). */
  before: string | null;
  removed: StartFreshRemoved;
  kept: StartFreshKept;
  /** The delivery dates of the orders removed (null: no order). */
  orderDates: { from: string; to: string } | null;
  blockers: StartFreshBlocker[];
}

/** Settings and the settings that come with it (customer type defaults) are always kept. */
export const START_FRESH_ALSO_KEPT = 'Settings (and the customer type defaults) are kept as they are.';

/** The reminder on screen, before anything can be removed. */
export const START_FRESH_BACKUP_REMINDER =
  'Take a Railway backup of the database first (Railway: Postgres, Backups, New backup). Removed data cannot be brought back from RouteIQ; only that backup has it.';

/** The total of the removed rows, the "of which" lines not counted twice. */
export function startFreshTotal(removed: Partial<StartFreshRemoved>): number {
  return START_FRESH_REMOVED.reduce((sum, r) => sum + ('sub' in r && r.sub ? 0 : (removed[r.key] ?? 0)), 0);
}

/** The typed confirmation: the company code (its slug), case and spaces around it ignored. */
export function startFreshConfirmMatches(typed: string | null | undefined, slug: string): boolean {
  return (typed ?? '').trim().toLowerCase() === slug.trim().toLowerCase() && slug.trim() !== '';
}

/** "everything" or "with a delivery date before 2026-10-05": what the run covered. */
export function startFreshScopeText(before: string | null): string {
  return before ? `data with a delivery date before ${before}` : 'everything';
}
