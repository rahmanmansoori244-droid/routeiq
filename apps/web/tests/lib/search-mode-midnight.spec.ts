/**
 * The Quick / Thorough confirmation across midnight (skeptic review of the long-search PR), on the
 * REAL DispatchClient and PlanView through the hook host (hook-host.ts): only api(), the toasts, the
 * router and the maps are replaced, and the clock (Date) is set by the test.
 *
 * A dispatcher opens tomorrow's day or plan at 23:50 in Muscat and leaves it open. At 07:30 the plan
 * is for today, but nothing reloads by itself while nothing runs. The confirmation took its default
 * and its "for today" flag from the loaded data, so it pre-selected Thorough ("This plan is for a
 * later day"). Its Thorough choice also lacked the warning that a plan for today cannot be locked or
 * dispatched until the search ends - the opposite of "day re-plans quick". The confirmation now
 * reads the clock when the button is pressed (search-mode.ts, searchModeNow).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Host, elements, typeName } from './hook-host';
import { fixture } from './plan-detail-fixture';
import type { PlanDetail } from '@/lib/dispatch/plan-detail';
import { defaultModeReason, searchChoices } from '@/lib/dispatch/search-mode';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));

const requests: { url: string; json?: any }[] = [];
const answers = vi.hoisted(() => ({ day: null as any, plan: null as any }));
vi.mock('@/app/t/[slug]/dispatch/client-api', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const ok = (data: unknown) => ({ ok: true, status: 200, data, error: null, errorBody: null });
  return {
    ...actual,
    api: async (url: string, init?: { json?: unknown }) => {
      requests.push({ url, json: init?.json });
      if (url.startsWith('/api/dispatch/day')) return ok(structuredClone(answers.day));
      if (url.endsWith('/plan') && !init?.json) return ok(structuredClone(answers.plan));
      if (url === '/api/drivers') return ok([]);
      return ok({ runId: 'run1', searchMode: (init?.json as any)?.searchMode, queued: false });
    },
  };
});
vi.mock('sonner', () => ({ toast: { success() {}, error() {}, warning() {}, info() {} } }));
vi.mock('next/dynamic', () => ({ default: () => function DynamicStub() { return null; } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace() {}, refresh() {}, push() {} }) }));

import { DispatchClient } from '@/app/t/[slug]/dispatch/dispatch-client';
import { PlanView } from '@/app/t/[slug]/dispatch/plan-view';

const EVENING = new Date('2026-09-29T19:50:00Z'); // 23:50 in Muscat on the 29th
const MORNING = new Date('2026-09-30T03:30:00Z'); // 07:30 in Muscat on the 30th
const TODAY_LINE = /This plan is for today: it cannot be used before the search ends/;

beforeEach(() => {
  requests.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EVENING);
});
afterEach(() => {
  vi.useRealTimers();
});

const DEPOT = { id: 'd1', code: 'MCT', name: 'Muscat', lat: 23.58, lng: 58.4 };

/** The day as getDayOverview gave it at 23:50 on the 29th for the 30th: not optimized yet. */
function dayLoadedInTheEvening() {
  return {
    date: '2026-09-30', today: '2026-09-29', tomorrow: '2026-09-30', timezone: 'Asia/Muscat', thoroughMaxSec: 1200, searchModeDefault: 'THOROUGH',
    cutoff: '16:00', depots: [DEPOT], depot: DEPOT, orders: { count: 3, cases: 120, customers: 3, late: 0, weightKg: 1500 }, customers: [],
    productsWithoutWeight: [], weightsToApply: [], outdated: { weightCases: 0, inactiveOrders: 0, masterChanged: 0, trucksChanged: 0 },
    plan: null, pending: { count: 0, cases: 0, late: 0 }, openOrders: 3, trucks: { active: 2, capacityCases: 1200 }, batches: [],
  };
}

/** The plan as getPlanDetail gave it at 23:50 on the 29th: the version for the 30th, applied. */
function planLoadedInTheEvening(): PlanDetail {
  const d = fixture();
  return { ...d, run: { ...d.run, runDate: '2026-09-30' }, today: '2026-09-29', timezone: 'Asia/Muscat', searchModeDefault: 'THOROUGH', thoroughMaxSec: 1200 };
}

/** The question the confirmation shows, as SearchModeDialog renders it. */
function asked(host: Host<any>) {
  const dialog = elements(host.tree).find((e) => typeName(e) === 'SearchModeDialog');
  if (!dialog) return null;
  const q = dialog.props.question;
  const thorough = searchChoices(q.defaultMode, q.stops, q.capSec, !!q.deliveryDay).find((c) => c.mode === 'THOROUGH')!;
  return { q, reason: defaultModeReason(q.defaultMode), thoroughDetail: thorough.detail, answer: dialog.props.onDone as (m: string | null) => void };
}

describe('the day screen left open across midnight', () => {
  it('OPTIMIZE at 07:30 suggests Quick with the "for today" warning, although the day was read at 23:50; no reload was needed', async () => {
    answers.day = dayLoadedInTheEvening();
    const host: Host<any> = new Host(DispatchClient as any, { slug: 'nmwc', canPlan: true, canDispatch: true, canEditProducts: true, initialDate: '2026-09-30', initialDepot: 'd1', phoneCountryCode: '968' });
    host.render();
    await host.settle();
    const press = async () => {
      elements(host.tree).find((e) => e.props?.['data-testid'] === 'optimize-btn').props.onClick();
      await host.settle();
      return asked(host)!;
    };

    // Control, the evening before: Thorough is suggested for tomorrow, without the "for today" warning.
    const evening = await press();
    expect(evening.q).toMatchObject({ defaultMode: 'THOROUGH', deliveryDay: false });
    expect(evening.reason).toBe('This plan is for a later day, so Thorough is suggested.');
    expect(evening.thoroughDetail).not.toMatch(TODAY_LINE);
    evening.answer(null); // Cancel: nothing starts
    await host.settle();
    expect(requests.some((r) => r.json)).toBe(false);

    // 07:30 on the delivery day, the same screen (not read again).
    vi.setSystemTime(MORNING);
    const read = requests.length;
    const morning = await press();
    expect(requests.length).toBe(read);
    expect(morning.q).toMatchObject({ defaultMode: 'QUICK', deliveryDay: true });
    expect(morning.reason).toBe('This plan is for today, so Quick is suggested: the trucks are waiting.');
    expect(morning.thoroughDetail).toMatch(TODAY_LINE);
    morning.answer(morning.q.defaultMode);
    await host.settle();
    expect(requests.find((r) => r.url === '/api/dispatch/plan')?.json).toMatchObject({ date: '2026-09-30', optimize: true, searchMode: 'QUICK' });
  });
});

describe('the plan screen left open across midnight', () => {
  async function mount() {
    answers.plan = planLoadedInTheEvening();
    const host: Host<any> = new Host(PlanView as any, {
      slug: 'nmwc', runId: 'run1', canPlan: true, canDispatch: true, phoneCountryCode: '968', reloadSignal: 0, onBusyChange: () => {}, onChanged: async () => {},
      today: '2026-09-29', // the day screen's today, read at 23:50 too
    });
    host.render();
    await host.settle();
    return host;
  }

  it('"Late order saved. Re-plan now?" at 07:30 suggests Quick with the "for today" warning', async () => {
    const host = await mount();
    vi.setSystemTime(MORNING);
    const read = requests.length;
    elements(host.tree).find((e) => typeName(e) === 'LateOrderDialog').props.onSaved({ locationRequired: false });
    await host.settle();
    const a = asked(host)!;
    expect(requests.length).toBe(read);
    expect(a.q).toMatchObject({ verb: 'Re-plan', defaultMode: 'QUICK', deliveryDay: true });
    expect(a.q.note).toMatch(/^Late order saved\. Re-plan now\?/);
    expect(a.thoroughDetail).toMatch(TODAY_LINE);
    a.answer(a.q.defaultMode);
    await host.settle();
    expect(requests.find((r) => r.url === '/api/runs/run1/replan')?.json).toMatchObject({ reason: 'LATE_ORDER', searchMode: 'QUICK' });
  });

  it('Re-plan: Thorough the evening before, Quick at 07:30 on the same screen', async () => {
    const host = await mount();
    const press = async () => {
      elements(host.tree).find((e) => e.props?.['data-testid'] === 'replan-btn').props.onClick();
      await host.settle();
      return asked(host)!;
    };
    const evening = await press();
    expect(evening.q).toMatchObject({ defaultMode: 'THOROUGH', deliveryDay: false });
    evening.answer(null);
    await host.settle();
    vi.setSystemTime(MORNING);
    const morning = await press();
    expect(morning.q).toMatchObject({ defaultMode: 'QUICK', deliveryDay: true });
    expect(morning.thoroughDetail).toMatch(TODAY_LINE);
    morning.answer(null);
    await host.settle();
    expect(requests.some((r) => r.json)).toBe(false);
  });
});
