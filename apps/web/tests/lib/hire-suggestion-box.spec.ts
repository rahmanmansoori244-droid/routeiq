/**
 * The Hire suggestion box (review of the hire branch) on the REAL component through the hook host
 * (hook-host.ts): only api(), the toasts and the timers of its polling are replaced.
 *  - A failed read while a check runs never stops the polling (the box kept spinning for good).
 *  - "Checking which trucks to hire" only while a check runs or is on its way; otherwise it says that
 *    no check ran, and "Press Check hire options" only to someone who has that button.
 *  - One button label, the one every text names: "Check hire options".
 *  - A suggestion computed for another plan option is not offered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Host, elements, textOf } from './hook-host';
import type { HireView } from '@/lib/dispatch/hire-whatif';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));

const answers = vi.hoisted(() => ({ list: [] as ({ ok: true; view: unknown } | { ok: false })[], reads: 0 }));
vi.mock('@/app/t/[slug]/dispatch/client-api', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    api: async () => {
      const a = answers.list[Math.min(answers.reads, answers.list.length - 1)]!;
      answers.reads++;
      return a.ok ? { ok: true, status: 200, data: structuredClone(a.view), error: null, errorBody: null } : { ok: false, status: 502, data: null, error: 'Bad gateway', errorBody: null };
    },
  };
});
vi.mock('sonner', () => ({ toast: { success() {}, error() {}, warning() {}, info() {} } }));

import { HireSuggestionBox } from '@/app/t/[slug]/dispatch/hire-suggestion';

/** The box's polls (4 s timers), fired by the test; every other timer runs as usual. */
let polls: (() => void)[] = [];
const realSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  answers.list = [];
  answers.reads = 0;
  polls = [];
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === 4_000) {
      polls.push(fn);
      return 0 as unknown as NodeJS.Timeout;
    }
    return realSetTimeout(fn, ms, ...(rest as []));
  }) as typeof setTimeout);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const view = (extra: Partial<HireView> = {}): HireView => ({
  options: 2, short: true, canCheck: true, dayOver: false, checkExpected: false, skipNote: null, lowLeftOut: 0, lowNote: null, suggestion: null, ...extra,
});
const suggestion = (extra: Partial<NonNullable<HireView['suggestion']>> = {}): NonNullable<HireView['suggestion']> => ({
  id: 'HS1', status: 'SUCCEEDED', trigger: 'AFTER_PLAN', message: null, createdAt: '', finishedAt: null, usedAt: null, usedRunId: null,
  headline: '2 orders (160 cases) cannot be delivered with your fleet. To deliver them, hire 1 x 10-ton (12 bays): extra about 50 OMR. Still left out: none.',
  details: [], summary: { status: 'HIRE', hires: [{ label: '10-ton', count: 1 }] } as never, forOtherOption: false, note: null, optionNote: null, usable: true, ...extra,
});

async function mount(canPlan = true) {
  const host: Host<any> = new Host(HireSuggestionBox as any, { runId: 'P1', planKey: 'k', canPlan, superseded: false, busy: false, expect: null, canEditProducts: false, onUsed() {} });
  host.render();
  await host.settle();
  const text = () => textOf(host.tree);
  const button = (label: string) => elements(host.tree).find((e) => textOf(e).includes(label) && typeof e.props?.onClick === 'function');
  const fire = async () => {
    const p = polls.shift();
    if (!p) throw new Error('no poll scheduled');
    p();
    await host.settle();
  };
  return { host, text, button, fire };
}

describe('the Hire suggestion box', () => {
  it('a failed read while a check runs never stops the polling', async () => {
    answers.list = [{ ok: true, view: view({ suggestion: suggestion({ status: 'RUNNING', headline: null }) }) }, { ok: false }, { ok: false }, { ok: true, view: view({ suggestion: suggestion() }) }];
    const b = await mount();
    expect(b.text()).toMatch(/Checking which trucks to hire \(Quick search/);
    await b.fire(); // 502
    expect(polls.length).toBe(1);
    await b.fire(); // 502 again
    expect(polls.length).toBe(1);
    await b.fire(); // finished
    expect(b.text()).toMatch(/hire 1 x 10-ton/);
    expect(polls.length).toBe(0);
  });

  it('never says "checking" when no check exists; the button is named in every text, only for someone who has it', async () => {
    answers.list = [{ ok: true, view: view() }];
    const b = await mount();
    expect(b.text()).not.toMatch(/Checking which trucks/);
    expect(b.text()).toMatch(/No hire check has run for this plan yet\. Press Check hire options to see which trucks to hire\./);
    expect(b.button('Check hire options')).toBeTruthy();
    expect(polls.length).toBe(0);
    // A viewer: no button, no "press".
    answers.reads = 0;
    const v = await mount(false);
    expect(v.text()).not.toMatch(/Press Check hire options/);
    expect(v.text()).toMatch(/A dispatcher can check which trucks to hire\./);
    expect(v.button('Check hire options')).toBeFalsy();
  });

  it('a check on its way (a plan just saved): "checking", polling, no button meanwhile; the reason when none started', async () => {
    answers.list = [{ ok: true, view: view({ checkExpected: true }) }, { ok: true, view: view({ skipNote: 'These products have no cases per pallet: P-1.' }) }];
    const b = await mount();
    expect(b.text()).toMatch(/Checking which trucks to hire…/);
    expect(b.button('Check hire options')).toBeFalsy();
    await b.fire();
    expect(b.text()).toMatch(/No hire check has run for this plan yet\. These products have no cases per pallet: P-1\. Press Check hire options/);
  });

  it('after a suggestion the button keeps its name, and a stopped check says it to a viewer without the button', async () => {
    answers.list = [{ ok: true, view: view({ suggestion: suggestion() }) }];
    const b = await mount();
    expect(b.button('Check hire options')).toBeTruthy();
    expect(b.button('Check again')).toBeFalsy();
    answers.list = [{ ok: true, view: view({ suggestion: suggestion({ status: 'CANCELLED', headline: null, usable: false, message: "Stopped so that a dispatcher's optimization could start at once. Press Check hire options to run it again." }) }) }];
    answers.reads = 0;
    const v = await mount(false);
    expect(v.text()).toMatch(/Stopped so that a dispatcher's optimization could start at once\. A dispatcher can check again\./);
  });

  it('a viewer never reads "press Check hire options", also mid-sentence and lowercase (review)', async () => {
    // Review of the hire branch: the not-backed texts say "... stayed unused - press Check hire options
    // to search again." in lowercase, which the case-sensitive filter let through to a viewer.
    const headline =
      '2 orders (160 cases, 2.4 pallets) cannot be delivered with your fleet. The hire check placed none of them although trucks you can rent stayed unused - press Check hire options to search again.';
    answers.list = [{ ok: true, view: view({ suggestion: suggestion({ headline, usable: false, summary: { status: 'NO_HELP', hires: [] } as never }) }) }];
    const v = await mount(false);
    expect(v.text()).not.toMatch(/press Check hire options/i);
    expect(v.text()).toMatch(/stayed unused\. A dispatcher can check again\./);
    // Someone with the button reads it as it is.
    answers.reads = 0;
    const b = await mount(true);
    expect(b.text()).toMatch(/stayed unused - press Check hire options to search again\./);
  });

  it('only P4/P5 orders left out: the box says plainly that renting is not suggested for them, with no button (owner answer 1)', async () => {
    answers.list = [{ ok: true, view: view({ short: false, lowLeftOut: 3, lowNote: 'Left out: 3 orders, all P4/P5 - renting is not suggested for them.' }) }];
    const b = await mount();
    expect(b.text()).toMatch(/Hire suggestion/);
    expect(b.text()).toMatch(/Left out: 3 orders, all P4\/P5 - renting is not suggested for them\./);
    expect(b.button('Check hire options')).toBeFalsy();
    expect(b.button('Use this plan')).toBeFalsy();
    expect(polls.length).toBe(0);
  });

  it('a failed first read never leaves the box out for good: it keeps trying and says so (third review)', async () => {
    // Review: the first GET failed (a deploy, a timeout), the box had no view, rendered nothing and never
    // polled - the automatic check finished unseen until the page was reloaded.
    answers.list = [{ ok: false }, { ok: false }, { ok: false }, { ok: true, view: view({ suggestion: suggestion() }) }];
    const b = await mount();
    expect(polls.length).toBe(1);
    await b.fire();
    expect(b.text()).not.toMatch(/Could not refresh/);
    await b.fire(); // the third failure in a row: said, still trying
    expect(b.text()).toMatch(/Hire suggestion/);
    expect(b.text()).toMatch(/Could not refresh the hire check \(still trying\)\./);
    expect(polls.length).toBe(1);
    await b.fire();
    expect(b.text()).toMatch(/hire 1 x 10-ton/);
    expect(b.text()).not.toMatch(/Could not refresh/);
    expect(polls.length).toBe(0);
  });

  it('a suggestion whose hire option was switched off says so, with no Use this plan (third review)', async () => {
    const optionNote = 'The 10-ton hire option was switched off or deleted since this check. Press Check hire options to check again.';
    answers.list = [{ ok: true, view: view({ suggestion: suggestion({ usable: false, optionNote }) }) }];
    const b = await mount();
    expect(b.text()).toMatch(/The 10-ton hire option was switched off or deleted since this check\. Press Check hire options to check again\./);
    expect(b.button('Use this plan')).toBeFalsy();
    answers.reads = 0;
    const v = await mount(false);
    expect(v.text()).toMatch(/switched off or deleted since this check\. A dispatcher can check again\./);
  });

  it('a suggestion computed for another plan option is not offered; an option that leaves nothing out shows no box', async () => {
    answers.list = [{ ok: true, view: view({ suggestion: suggestion({ forOtherOption: true, usable: false }) }) }];
    const b = await mount();
    expect(b.text()).toMatch(/computed for another plan option than the one in use/);
    expect(b.text()).not.toMatch(/hire 1 x 10-ton/);
    expect(b.button('Use this plan')).toBeFalsy();
    answers.list = [{ ok: true, view: view({ short: false, suggestion: suggestion() }) }];
    answers.reads = 0;
    const n = await mount();
    expect(n.host.tree).toBeNull();
  });
});
