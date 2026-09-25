/**
 * The plan screen's actions, one at a time (review F07; review of PR3). Pure (no React), so the
 * rules are unit-tested in tests/lib/plan-actions.spec.ts.
 *
 * - runPlanAction: an action (a load change, Lock all, Use instead, Re-plan) holds the plan's busy
 *   state from its request until the day screen shows its result - the action awaits the day's
 *   reload (onChanged) - so neither the plan's buttons nor Step 3's OPTIMIZE / RE-PLAN can start
 *   another request on the previous data. The busy state is always given back, also when
 *   something throws, so one error never leaves the buttons disabled until the page is reloaded.
 * - afterLateOrderSaved: after a late order is saved, either re-plan now - the re-plan takes the
 *   busy state and reloads the day when it ends - or reload the day. Reloading the day first
 *   replaced the plan screen before the re-plan took the busy state, so Step 3's RE-PLAN stayed
 *   clickable while that re-plan ran (a second click: "superseded").
 * - planAfterLoad: a failed reload of the plan keeps the plan on screen, with the error and Try
 *   again. It used to replace the whole plan (every load button) by the error, with no way back
 *   but reloading the page - after any network error during an action (third review of PR3).
 */

/** The plan screen's busy state: the running action's key, or null. */
export interface ActionLock {
  current(): string | null;
  set(key: string | null): void;
}

/**
 * Run `action` when nothing else runs; returns false (and runs nothing) while another action or the
 * screen around the plan is busy.
 */
export async function runPlanAction(lock: ActionLock, key: string, action: () => Promise<void>, onError: (message: string) => void): Promise<boolean> {
  if (lock.current() !== null) return false;
  lock.set(key);
  try {
    await action();
  } catch (e) {
    onError(`Something went wrong (${e instanceof Error ? e.message : String(e)}). The plan below may be out of date: reload the page.`);
  } finally {
    lock.set(null);
  }
  return true;
}

/** What the plan screen shows: the plan last loaded, and why the last load failed (Try again). */
export interface PlanPanel<D> {
  plan: D | null;
  error: string | null;
}

/**
 * The plan screen after a load of the plan: an answer replaces the plan and clears the error; a
 * failure keeps the plan already on screen and adds the error (the screen offers Try again). Only
 * a plan that never loaded shows the error alone, also with Try again.
 */
export function planAfterLoad<D>(shown: PlanPanel<D>, r: { ok: boolean; data: D | null; error: string | null }): PlanPanel<D> {
  if (r.ok && r.data) return { plan: r.data, error: null };
  return { plan: shown.plan, error: r.error ?? 'Could not load the plan.' };
}

export interface LateOrderSaved {
  locationRequired: boolean;
  productsWithoutWeight?: string[];
}

export interface AfterLateOrderDeps {
  warn(message: string): void;
  /** Where a missing case weight gets fixed, for the user's role (weightFixText). */
  weightFix: string;
  /** Asks "Re-plan now?"; true = yes. */
  confirmReplan(): boolean;
  /** Re-plan with the late order (reloads the day when it ends, also after a refusal). */
  replan(): Promise<void>;
  /** Reload the plan and the day, so the late order shows as waiting. */
  refresh(): Promise<void>;
}

export async function afterLateOrderSaved(res: LateOrderSaved, deps: AfterLateOrderDeps): Promise<void> {
  if (res.productsWithoutWeight?.length) {
    deps.warn(`No case weight for ${res.productsWithoutWeight.join(', ')}: ${deps.weightFix}, or the re-plan will ask before counting it as 0 kg.`);
  }
  if (res.locationRequired) {
    deps.warn('New customer has no location yet — add it in step 2 before re-planning.');
    await deps.refresh();
    return;
  }
  if (deps.confirmReplan()) {
    await deps.replan();
    return;
  }
  await deps.refresh();
}
