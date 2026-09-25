/**
 * Static guards for the day screen and the plan screen (review of PR3). These screens have no DOM
 * tests; the rules they use are unit-tested (day loader: request-gate.spec.ts; api(),
 * runPlanAction and afterLateOrderSaved: plan-actions.spec.ts). These checks keep the screens on
 * those rules:
 * - the day screen loads only through the day loader, so a reload after an action that ends after
 *   another day was picked loads the day selected now (it used to close over the old date and
 *   leave the screen on "Loading <date>..." for good);
 * - OPTIMIZE / RE-PLAN clears its busy flag in a finally block, and the plan's reload returns the
 *   day's reload so the plan's action can wait for it;
 * - every plan action runs through runPlanAction (the busy state is always given back) and awaits
 *   the day's reload; a saved late order goes through afterLateOrderSaved (no reload before the
 *   re-plan).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = path.resolve(__dirname, '../../app/t/[slug]/dispatch');
const dayScreen = readFileSync(path.join(DIR, 'dispatch-client.tsx'), 'utf8');
const planScreen = readFileSync(path.join(DIR, 'plan-view.tsx'), 'utf8');
const count = (src: string, re: RegExp) => [...src.matchAll(re)].length;

describe('day screen (dispatch-client.tsx)', () => {
  it('loads only through the day loader: no reload closes over the date or depot of a render', () => {
    expect(dayScreen).toContain('createDayLoader<Day>(');
    expect(dayScreen).not.toContain('createRequestGate(');
    expect(dayScreen).not.toMatch(/\}, \[date, depotId\]\);/); // a useCallback over the selection
    expect(dayScreen).not.toMatch(/fetch\(|\/api\/dispatch\/day\?\$\{q\}`\)\.catch/);
    expect(count(dayScreen, /\/api\/dispatch\/day\?/g)).toBe(1); // inside the loader's fetchDay
  });

  it('OPTIMIZE / RE-PLAN clears its busy flag in finally, after the day shows the result', () => {
    expect(count(dayScreen, /setOptimizing\(false\)/g)).toBe(1);
    expect(dayScreen).toMatch(/await refresh\(\);\s*\} finally \{\s*setOptimizing\(false\);\s*\}/);
  });

  it("the plan's onChanged returns the day's reload (the plan's action waits for it)", () => {
    expect(dayScreen).toMatch(/onChanged=\{async \(\) => \{[^}]*await refresh\(\);\s*setPlanKey\(\(k\) => k \+ 1\);\s*\}\}/);
  });
});

describe('plan screen (plan-view.tsx)', () => {
  it('sets its busy state only through the action lock (always given back)', () => {
    expect(count(planScreen, /\bsetBusy\(/g)).toBe(1);
    expect(planScreen).toMatch(/set: \(key\) => \{\s*busyRef\.current = key;\s*setBusy\(key\);/);
    for (const action of ['setStatus', 'setDriver', 'lockAll', 'chooseScenario', 'replan']) {
      const body = planScreen.slice(planScreen.indexOf(`function ${action}(`));
      expect(body.slice(0, body.indexOf('\n  }\n')), action).toContain('runPlanAction(');
    }
  });

  it("every action awaits the day's reload before it gives the busy state back", () => {
    const calls = count(planScreen, /onChanged\?\.\(/g);
    expect(calls).toBeGreaterThanOrEqual(5);
    expect(count(planScreen, /await onChanged\?\.\(/g)).toBe(calls);
  });

  it('a saved late order: re-plan now or reload the day, never the reload first', () => {
    const onSaved = planScreen.slice(planScreen.indexOf('onSaved={'), planScreen.indexOf('/>', planScreen.indexOf('onSaved={')));
    expect(onSaved).toContain('afterLateOrderSaved(res, {');
    expect(onSaved.indexOf('afterLateOrderSaved(')).toBeLessThan(onSaved.indexOf('onChanged'));
  });
});
