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

/**
 * What Start fresh never touches, with a count so the owner sees it is there. `dateOnly`: only
 * meaningful with "only before a date" (the panel hides the line for Everything, where it is 0).
 */
export const START_FRESH_KEPT = [
  { key: 'customers', label: 'Customers (with their locations and confirmed hours)' },
  { key: 'products', label: 'Products' },
  { key: 'trucks', label: 'Trucks' },
  { key: 'drivers', label: 'Drivers (regular)' },
  { key: 'dailyDrivers', label: "Daily drivers still on a kept load, a truck's usual driver, or named in driver leave" },
  { key: 'depots', label: 'Depots' },
  { key: 'regions', label: 'Regions' },
  { key: 'users', label: 'Users' },
  { key: 'auditRows', label: 'Audit log rows (never deleted)' },
  { key: 'orderFiles', label: 'Order files with a delivery date on or after the chosen day', dateOnly: true },
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

/**
 * What in the removal may already be real (the pilot started, or the button is pressed during a
 * working day): shown in red, and the run needs one more tick (LIVE_DATA_CONFIRM without it).
 */
export interface StartFreshLive {
  /** The company's today (its time zone), YYYY-MM-DD. */
  today: string;
  /** Loads locked, loading, dispatched or completed (frozen loads: they may really have left). */
  frozenLoads: number;
  /** Orders with a delivery date of today or later. */
  ordersFromToday: number;
  /** Driver links (QR codes) for today or later. */
  driverLinksFromToday: number;
}

/** The preview (GET) and, after a run, the summary (POST): the same shape. */
export interface StartFreshReport {
  /** null = everything; else only data with a delivery date before this day (YYYY-MM-DD). */
  before: string | null;
  removed: StartFreshRemoved;
  kept: StartFreshKept;
  /** The delivery dates of the orders removed (null: no order). */
  orderDates: { from: string; to: string } | null;
  live: StartFreshLive;
  blockers: StartFreshBlocker[];
}

/** The preview is dropped from the screen after this long: "Check" again before removing. */
export const START_FRESH_PREVIEW_MAX_AGE_MS = 5 * 60_000;

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** True when the removal includes data that may already be real (see StartFreshLive). */
export function startFreshHasLive(live: Pick<StartFreshLive, 'frozenLoads' | 'ordersFromToday' | 'driverLinksFromToday'>): boolean {
  return live.frozenLoads > 0 || live.ordersFromToday > 0 || live.driverLinksFromToday > 0;
}

/** The red line of the preview, or with `done` of the summary after a run (null: nothing live-looking). */
export function startFreshLiveText(live: StartFreshLive, done = false): string | null {
  if (!startFreshHasLive(live)) return null;
  const parts = [
    live.frozenLoads ? `${plural(live.frozenLoads, 'load', 'loads')} already locked, loading, dispatched or completed` : '',
    live.ordersFromToday ? `${plural(live.ordersFromToday, 'order', 'orders')} dated today (${live.today}) or later` : '',
    live.driverLinksFromToday ? `${plural(live.driverLinksFromToday, 'driver link', 'driver links')} (QR codes) for today or later` : '',
  ].filter(Boolean);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  if (done) return `This included ${list}.`;
  return `This includes ${list}. If the pilot has started, these may be real: choose "Only data with a delivery date before" instead.`;
}

/** The extra tick, when the preview shows live-looking data. */
export const START_FRESH_LIVE_TICK = 'These loads, orders and driver links are test data too: remove them.';

/** What the admin was shown by the preview; the run is refused (PREVIEW_STALE) when it would remove more. */
export interface StartFreshShown {
  removed: Partial<Record<StartFreshRemovedKey, number>>;
  orderDates: { from: string; to: string } | null;
  live: { frozenLoads: number; ordersFromToday: number; driverLinksFromToday: number };
}

export function startFreshShown(r: StartFreshReport): StartFreshShown {
  return {
    removed: { ...r.removed },
    orderDates: r.orderDates ? { ...r.orderDates } : null,
    live: { frozenLoads: r.live.frozenLoads, ordersFromToday: r.live.ordersFromToday, driverLinksFromToday: r.live.driverLinksFromToday },
  };
}

const LIVE_LABELS = {
  frozenLoads: 'Loads already locked, loading, dispatched or completed',
  ordersFromToday: 'Orders dated today or later',
  driverLinksFromToday: 'Driver links for today or later',
} as const;

/**
 * What a run would remove now beyond what the admin was shown ([] = nothing more): a count that grew
 * (a count that fell is fine: less is removed than shown), or other order dates.
 */
export function startFreshStale(shown: StartFreshShown, fresh: StartFreshReport): string[] {
  const out: string[] = [];
  for (const r of START_FRESH_REMOVED) {
    const was = shown.removed[r.key] ?? 0;
    const now = fresh.removed[r.key];
    if (now > was) out.push(`${r.label}: ${was.toLocaleString('en-US')} shown, now ${now.toLocaleString('en-US')}`);
  }
  const dates = (d: { from: string; to: string } | null) => (d ? `${d.from} to ${d.to}` : 'none');
  if (dates(shown.orderDates) !== dates(fresh.orderDates)) out.push(`Order dates: ${dates(shown.orderDates)} shown, now ${dates(fresh.orderDates)}`);
  for (const k of Object.keys(LIVE_LABELS) as (keyof typeof LIVE_LABELS)[]) {
    if (fresh.live[k] > shown.live[k]) out.push(`${LIVE_LABELS[k]}: ${shown.live[k].toLocaleString('en-US')} shown, now ${fresh.live[k].toLocaleString('en-US')}`);
  }
  return out;
}

/** The run's answer when the data changed after the check (409 PREVIEW_STALE). */
export function startFreshStaleText(reasons: readonly string[]): string {
  return `Something changed since you checked (${reasons.join('; ')}). Nothing was removed: check the new numbers, then press Remove again.`;
}

/** The answer to too many attempts (429): the plain words the panel shows. */
export function startFreshTooManyText(waitMs: number): string {
  const min = Math.max(1, Math.ceil(waitMs / 60_000));
  return `Too many attempts. Wait ${min} minute${min === 1 ? '' : 's'}, then check again. Nothing was removed.`;
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

/** "every order, plan and delivery result of this company, all dates" or "data with a delivery date before 2026-10-05": what the run covered. */
export function startFreshScopeText(before: string | null): string {
  return before ? `data with a delivery date before ${before}` : 'every order, plan and delivery result of this company, all dates';
}
