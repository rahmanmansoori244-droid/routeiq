/**
 * Review of PR3 - the day screen and plan screen, one action at a time, never stuck:
 * - api() never rejects: a request that does not reach the server answers ok:false, status 0, so
 *   no caller skips its clean-up (one network error disabled OPTIMIZE and every plan action);
 * - runPlanAction holds the plan's busy state until the action - including the day's reload - is
 *   done, and always gives it back;
 * - after a late order, "Re-plan now?" re-plans without reloading the day first (that dropped the
 *   re-plan's busy state, so Step 3's RE-PLAN stayed clickable during it), otherwise the day reloads;
 * - a failed reload of the plan keeps the plan on screen with the error (planAfterLoad).
 * The screens use these (static guards: tests/lib/dispatch-screen-guards.spec.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/app/t/[slug]/dispatch/client-api';
import { afterLateOrderSaved, createLoadOrder, planAfterLoad, planReloadErrorText, runPlanAction, type ActionLock } from '@/app/t/[slug]/dispatch/plan-actions';

describe('api(): a request that does not reach the server never rejects', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers ok:false, status 0 with a plain message when fetch fails (offline, connection reset)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const r = await api('/api/runs/R1/replan', { method: 'POST', json: { reason: 'REOPTIMIZE' } });
    expect(r).toEqual({
      ok: false,
      status: 0,
      data: null,
      error: 'The server could not be reached (Failed to fetch). Check the connection and try again.',
      errorBody: null,
    });
  });

  it('still reads a refusal from the server as before', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'SUPERSEDED', message: 'Replaced by a newer version.' } }), { status: 409 })));
    const r = await api('/api/runs/R1/replan', { method: 'POST', json: {} });
    expect(r).toMatchObject({ ok: false, status: 409, error: 'Replaced by a newer version.', errorBody: { code: 'SUPERSEDED' } });
  });
});

function lockOf(external = false) {
  let key: string | null = null;
  const seen: (string | null)[] = [];
  const lock: ActionLock = {
    current: () => key ?? (external ? 'external' : null),
    set: (k) => {
      key = k;
      seen.push(k);
    },
  };
  return { lock, seen, key: () => key };
}

describe('runPlanAction: one action at a time, never stuck', () => {
  it('holds the busy state until the day shows the result (the awaited reload), then gives it back', async () => {
    const { lock, key } = lockOf();
    let reloadDone!: () => void;
    const reload = new Promise<void>((r) => (reloadDone = r));
    const onError = vi.fn();
    const first = runPlanAction(lock, 'L1', async () => {
      await Promise.resolve(); // the PATCH
      await reload; // onChanged: the day screen's reload
    }, onError);
    await Promise.resolve();
    expect(key()).toBe('L1');
    // Another action (or Step 3, which follows this busy state) meanwhile: refused, nothing sent.
    const second = vi.fn(async () => {});
    expect(await runPlanAction(lock, 'L2', second, onError)).toBe(false);
    expect(second).not.toHaveBeenCalled();
    reloadDone();
    expect(await first).toBe(true);
    expect(key()).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('gives the busy state back when the action throws, and says so', async () => {
    const { lock, key } = lockOf();
    const onError = vi.fn();
    await runPlanAction(lock, 'replan', async () => {
      throw new TypeError('Failed to fetch');
    }, onError);
    expect(key()).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch'));
    // The next action runs.
    const next = vi.fn(async () => {});
    expect(await runPlanAction(lock, 'L1', next, onError)).toBe(true);
    expect(next).toHaveBeenCalled();
  });

  it("waits for the day screen's OPTIMIZE / RE-PLAN request (external busy)", async () => {
    const { lock } = lockOf(true);
    const action = vi.fn(async () => {});
    expect(await runPlanAction(lock, 'L1', action, vi.fn())).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });
});

describe('after a late order is saved (review of PR3: Step 3 RE-PLAN clickable during the re-plan)', () => {
  function deps(answer: boolean) {
    const calls: string[] = [];
    return {
      calls,
      d: {
        warn: (m: string) => calls.push(`warn: ${m}`),
        weightFix: 'add the case weight under Products',
        confirmReplan: () => {
          calls.push('asked');
          return answer;
        },
        replan: async () => {
          calls.push('replan');
        },
        refresh: async () => {
          calls.push('reload day');
        },
      },
    };
  }

  it('"Re-plan now?" yes: re-plans without reloading the day first (the re-plan reloads it when it ends)', async () => {
    const { calls, d } = deps(true);
    await afterLateOrderSaved({ locationRequired: false }, d);
    expect(calls).toEqual(['asked', 'replan']);
  });

  it('no: reloads the day, so the late order shows as waiting', async () => {
    const { calls, d } = deps(false);
    await afterLateOrderSaved({ locationRequired: false }, d);
    expect(calls).toEqual(['asked', 'reload day']);
  });

  it('a new customer without a location: no re-plan offered, a warning and the day reloaded', async () => {
    const { calls, d } = deps(true);
    await afterLateOrderSaved({ locationRequired: true, productsWithoutWeight: ['W-19'] }, d);
    expect(calls).toEqual([
      'warn: No case weight for W-19: add the case weight under Products, or the re-plan will ask before counting it as 0 kg.',
      'warn: New customer has no location yet — add it in step 2 before re-planning.',
      'reload day',
    ]);
  });
});

describe('a failed reload keeps the plan on screen (third review of PR3: the plan was replaced by the error for good)', () => {
  const unreachable = { ok: false, data: null, error: 'The server could not be reached (Failed to fetch). Check the connection and try again.' };
  const plan = (v: number) => ({ version: v });

  it('a network error after an action: the plan stays, with the error (the screen offers Try again)', () => {
    const shown = { plan: plan(1), error: null };
    expect(planAfterLoad(shown, unreachable)).toEqual({ plan: plan(1), error: unreachable.error });
  });

  it('Try again that gets an answer: the new plan, and the error is gone', () => {
    const failed = planAfterLoad({ plan: plan(1), error: null }, unreachable);
    expect(planAfterLoad(failed, { ok: true, data: plan(2), error: null })).toEqual({ plan: plan(2), error: null });
  });

  it('a plan that never loaded: the error alone (with Try again), and a refusal says why', () => {
    expect(planAfterLoad({ plan: null, error: null }, unreachable)).toEqual({ plan: null, error: unreachable.error });
    expect(planAfterLoad({ plan: null, error: null }, { ok: false, data: null, error: null })).toEqual({ plan: null, error: 'Could not load the plan.' });
  });
});

describe('the plan screen shows the newest answer only (fourth review of PR3)', () => {
  it('a slow Try again read before a Lock, landing after the Lock\'s own reload, is dropped', () => {
    const order = createLoadOrder();
    const tryAgain = order.begin(); // slow
    const afterLock = order.begin();
    expect(order.pending()).toBe(true);
    expect(order.accept(afterLock)).toBe(true); // LOCKED shown
    expect(order.pending()).toBe(false);
    expect(order.accept(tryAgain)).toBe(false); // the PLANNED read before the lock never comes back
  });

  it('two Try again clicks: the second worked, the first fails later - the fresh plan stays without the banner', () => {
    const order = createLoadOrder();
    const first = order.begin();
    const second = order.begin();
    expect(order.accept(second)).toBe(true);
    expect(order.accept(first)).toBe(false);
  });

  it('answers slower than the polling still land in order (the screen never freezes)', () => {
    const order = createLoadOrder();
    const a = order.begin();
    const b = order.begin();
    expect(order.accept(a)).toBe(true); // older, but newer than the one on screen
    expect(order.pending()).toBe(true); // b is still on its way: Try again waits
    expect(order.accept(b)).toBe(true);
    expect(order.pending()).toBe(false);
  });
});

describe('the reload banner reads as sentences (fourth review of PR3)', () => {
  it('ends the server message with a period before "The plan below may be out of date."', () => {
    expect(planReloadErrorText('Not found')).toBe('Could not reload the plan: Not found. The plan below may be out of date.');
    expect(planReloadErrorText('HTTP 502')).toBe('Could not reload the plan: HTTP 502. The plan below may be out of date.');
    expect(planReloadErrorText('Too many requests ')).toBe('Could not reload the plan: Too many requests. The plan below may be out of date.');
    expect(planReloadErrorText('The server could not be reached (Failed to fetch). Check the connection and try again.')).toBe(
      'Could not reload the plan: The server could not be reached (Failed to fetch). Check the connection and try again. The plan below may be out of date.',
    );
  });
});
