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
 * Third review of PR3:
 * - a failed reload of the plan keeps the plan on screen with Try again (planAfterLoad), and a plan
 *   that never loaded shows its error with Try again; the day's Try again reloads the plan too;
 * - a file check or a confirmed file that answers after another day was picked never takes the
 *   screen back to the previous day (dayAfterConfirm).
 * Fourth review of PR3:
 * - the day back after a failed load reloads the plan in place (reloadSignal), never remounting it
 *   (a remount closed a late order being typed and every opened load);
 * - only the newest plan load changes the screen (createLoadOrder), and Try again waits while a
 *   reload or an action runs;
 * - a failed driver change reloads the plan (the old driver and WhatsApp link are never shown as
 *   current), and the reload banner punctuates the server's message (planReloadErrorText).
 * The screens themselves were driven in a DOM harness outside the repository (jsdom is not a
 * dependency here); these guards keep them on the tested rules.
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

  it("the plan's onChanged returns the day's reload (the plan's action waits for it); the plan is reloaded only when the day was", () => {
    expect(dayScreen).toMatch(/onChanged=\{async \(\) => \{[^}]*if \(await refresh\(\)\) setPlanKey\(\(k\) => k \+ 1\);\s*\}\}/);
  });

  it("the day shown after a failed load reloads the plan too (the day's Try again brings Step 4 back) - in place, never a remount", () => {
    expect(dayScreen).toMatch(/show: \(d, \{ afterError \}\) => \{[^}]*if \(afterError\) setPlanReload\(\(k\) => k \+ 1\);/);
    const show = dayScreen.slice(dayScreen.indexOf('show: (d, { afterError }) => {'), dayScreen.indexOf('showError:'));
    expect(show).not.toContain('setPlanKey'); // a new key would remount the plan (fourth review of PR3)
    expect(dayScreen).toContain('reloadSignal={planReload}');
    expect(dayScreen).toContain('key={`${day.plan.id}-${planKey}`}'); // a new plan id still remounts
  });

  it('OPTIMIZE / RE-PLAN that never reached the server keeps the plan below as it is', () => {
    expect(dayScreen).toMatch(/reached = r\.status !== 0;/);
    expect(dayScreen).toMatch(/if \(reached\) setPlanKey\(\(k\) => k \+ 1\);\s*await refresh\(\);/);
  });

  it('a confirmed file never takes the screen back to the day it was added on after another day was picked', () => {
    const body = dayScreen.slice(dayScreen.indexOf('async function confirmBatch('), dayScreen.indexOf('async function optimize('));
    // The day is recorded before the request, and compared when the answer comes.
    expect(body.indexOf('const started = loader.selection();')).toBeGreaterThan(-1);
    expect(body.indexOf('const started = loader.selection();')).toBeLessThan(body.indexOf('await api<'));
    const moved = body.indexOf('if (!sameSelection(started, loader.selection())) {');
    expect(moved).toBeGreaterThan(body.indexOf('await api<'));
    // That branch only says what happened and reloads the day picked: it touches no file state.
    const branch = body.slice(moved, body.indexOf('return;', moved));
    expect(branch).toContain('await refresh();');
    expect(branch).not.toMatch(/setBatch|setFile|changeDay/);
    expect(body).toContain('dayAfterConfirm(started, loader.selection(), r.data.deliveryDates)');
    expect(body).not.toMatch(/changeDay\(d0/);
  });

  it("a file check that answers after another day was picked is not offered on the new day", () => {
    const body = dayScreen.slice(dayScreen.indexOf('async function upload('), dayScreen.indexOf('async function confirmBatch('));
    expect(body.indexOf('const started = loader.selection();')).toBeLessThan(body.indexOf('await api<'));
    const guard = body.indexOf('if (!sameSelection(started, loader.selection())) {');
    expect(guard).toBeGreaterThan(body.indexOf('await api<'));
    expect(guard).toBeLessThan(body.indexOf('setBatch('));
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

  it('a failed reload keeps the plan on screen: every load goes through planAfterLoad, and no error replaces the plan', () => {
    expect(planScreen).toContain('setPanel((shown) => planAfterLoad(shown, r));');
    expect(count(planScreen, /setPanel\(/g)).toBe(1);
    // The whole panel is the error only while no plan was ever loaded.
    expect(planScreen).not.toMatch(/if \(err\) return/);
    expect(planScreen).toMatch(/if \(!d\) \{[^]*?return err \?/);
  });

  it('the screen around the plan reloads it in place (reloadSignal): the same load, no remount (fourth review of PR3)', () => {
    expect(planScreen).toMatch(/if \(reloadSignal === seenReload\.current\) return;\s*seenReload\.current = reloadSignal;\s*void load\(\);/);
  });

  it('only the newest load changes the plan on screen, and Try again waits for a reload or an action (fourth review of PR3)', () => {
    const body = planScreen.slice(planScreen.indexOf('const load = useCallback('), planScreen.indexOf('}, [runId]);'));
    expect(body).toContain('const ticket = loadOrder.current.begin();');
    const accept = body.indexOf('if (!loadOrder.current.accept(ticket)) return null;');
    expect(accept).toBeGreaterThan(body.indexOf('await api<PlanDetail>'));
    expect(accept).toBeLessThan(body.indexOf('setPanel('));
    expect(planScreen).toContain('const retryOff = !!busy || reloading;');
    expect(count(planScreen, /onClick=\{retry\} disabled=\{retryOff\}/g)).toBe(2);
  });

  it('a driver change that failed reloads the plan, like a status change (fourth review of PR3)', () => {
    const body = planScreen.slice(planScreen.indexOf('function setDriver('), planScreen.indexOf('function lockAll('));
    const failed = body.slice(body.indexOf('if (!r.ok) {'), body.indexOf('return;', body.indexOf('if (!r.ok) {')));
    expect(failed).toContain('await load();');
  });

  it('the reload banner punctuates the server message (planReloadErrorText; fourth review of PR3)', () => {
    expect(planScreen).toContain('{planReloadErrorText(err)}');
    expect(planScreen).not.toContain('Could not reload the plan: {err}');
  });

  it('both error states offer Try again (the plan, and the driver list when it did not load)', () => {
    for (const id of ['plan-load-error', 'plan-reload-error']) {
      const at = planScreen.indexOf(`data-testid="${id}"`);
      expect(at, id).toBeGreaterThan(-1);
      const block = planScreen.slice(at, planScreen.indexOf('</div>', at));
      expect(block, id).toMatch(/onClick=\{retry\}[^]*Try again/);
    }
    expect(planScreen).toMatch(/const retry = \(\) => \{\s*void load\(\);\s*if \(!drivers\.length\) void loadDrivers\(\);/);
  });
});
