/**
 * Review of PR3 - the day screen and plan screen, one action at a time, never stuck:
 * - api() never rejects: a request that does not reach the server answers ok:false, status 0, so
 *   no caller skips its clean-up (one network error disabled OPTIMIZE and every plan action);
 * - runPlanAction holds the plan's busy state until the action - including the day's reload - is
 *   done, and always gives it back;
 * - after a late order, "Re-plan now?" re-plans without reloading the day first (that dropped the
 *   re-plan's busy state, so Step 3's RE-PLAN stayed clickable during it), otherwise the day reloads.
 * The screens use these (static guards: tests/lib/dispatch-screen-guards.spec.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/app/t/[slug]/dispatch/client-api';
import { afterLateOrderSaved, runPlanAction, type ActionLock } from '@/app/t/[slug]/dispatch/plan-actions';

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
