/**
 * The day screen's loads (review of PR3). Every load - the first one, polling, Try again, and the
 * reload after an action (a load change, OPTIMIZE / RE-PLAN, a confirmed file, a saved dialog) -
 * is for the day selected NOW, never for the day selected when the action started. Before, an
 * action that ended after the dispatcher picked another date reloaded the date it started on: the
 * screen held that day while the pickers showed the new one, on "Loading <date>..." for good (no
 * load on its way, no error, no Try again).
 *
 * Backstop: an answer for a selection the dispatcher has left since, with no other load on its way,
 * is not shown - the selection is loaded instead, so the screen never waits for nothing.
 *
 * A day shown after a failed load says so (`afterError`), so the screen also reloads the plan below
 * it: that load most likely failed too (third review of PR3: the day's Try again brought the day
 * back, but the plan stayed replaced by its error).
 *
 * Answers go through the request gate (request-gate.ts): an answer for another day than the newest
 * load's is dropped, and an older answer never replaces a newer one. Pure (no React), so it is
 * unit-tested in tests/lib/request-gate.spec.ts.
 */
import { createRequestGate, dayKey } from './request-gate';

export interface DaySelection {
  date: string | null;
  depotId: string | null;
}

/** What a day answer must carry for the selection to follow it. */
export interface DayAnswer {
  date: string;
  depot: { id: string } | null;
}

export interface DayLoaderDeps<D extends DayAnswer> {
  fetchDay(sel: DaySelection): Promise<{ ok: boolean; data: D | null; error: string | null }>;
  /**
   * Show the day loaded for the current selection. `afterError`: the load before this one failed
   * (the screen showed its error), so what depends on the day - the plan - is loaded again too.
   */
  show(day: D, info: { afterError: boolean }): void;
  /** Show why the current selection could not be loaded (Try again). */
  showError(message: string): void;
  /**
   * The server answered another day than asked (no date yet, an invalid date, an inactive depot):
   * the selection follows the day actually loaded, so the screen never stays "loading".
   */
  selected(sel: DaySelection): void;
}

export interface DayLoader {
  /** The day selected now. */
  selection(): DaySelection;
  /** The dispatcher picked another date or depot (the caller then loads it with refresh()). */
  select(sel: DaySelection): void;
  /**
   * Load the day selected now (whoever calls, whenever the call started). True when this call
   * showed it; false when the load failed (its error is shown) or a newer load took over.
   */
  refresh(): Promise<boolean>;
  /** The key of the newest load still on its way, or null. */
  pendingKey(): string | null;
}

/** The same date and depot. */
export function sameSelection(a: DaySelection, b: DaySelection): boolean {
  return a.date === b.date && a.depotId === b.depotId;
}

/**
 * The day to show after a file was added (`started` = the day selected when "Add ... lines" was
 * clicked, `now` = the day selected when the answer came): the file's delivery date when it is
 * another date than the day it was added on; null = stay on the day selected now (reload it).
 * A dispatcher who picked another day meanwhile stays on it: the answer never takes the screen
 * back (third review of PR3: it jumped back to the file's date, URL included).
 */
export function dayAfterConfirm(started: DaySelection, now: DaySelection, deliveryDates: readonly string[]): DaySelection | null {
  if (!sameSelection(started, now)) return null;
  const fileDate = deliveryDates[0];
  return fileDate && fileDate !== started.date ? { date: fileDate, depotId: started.depotId } : null;
}

export function createDayLoader<D extends DayAnswer>(initial: DaySelection, deps: DayLoaderDeps<D>): DayLoader {
  const gate = createRequestGate();
  let current: DaySelection = { ...initial };
  // The last load of the selection ended in an error (shown with Try again).
  let failed = false;

  async function refresh(): Promise<boolean> {
    const asked = current;
    const ticket = gate.begin(dayKey(asked.date, asked.depotId));
    const r = await deps.fetchDay(asked);
    // Dropped when another day's load started meanwhile, or a newer answer for this day is shown.
    if (!gate.isCurrent(ticket)) return false;
    gate.finish(ticket);
    if (!sameSelection(asked, current)) {
      // Backstop: the dispatcher left this day and no load of the new selection is on its way.
      return gate.pendingKey() === null ? refresh() : false;
    }
    if (r.ok && r.data) {
      const afterError = failed;
      failed = false;
      deps.show(r.data, { afterError });
      const loaded: DaySelection = { date: r.data.date, depotId: r.data.depot?.id ?? asked.depotId };
      if (!sameSelection(loaded, current)) {
        current = loaded;
        deps.selected(loaded);
      }
      return true;
    }
    failed = true;
    deps.showError(r.error ?? 'Could not load the day.');
    return false;
  }

  return {
    selection: () => current,
    select(sel) {
      current = { date: sel.date, depotId: sel.depotId };
    },
    refresh,
    pendingKey: () => gate.pendingKey(),
  };
}
