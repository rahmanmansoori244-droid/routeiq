/**
 * The kept-load warning on the screens: the REAL DispatchClient, PlanView and SearchModeDialog through the
 * hook host (hook-host.ts); only api(), the toasts, the router and the maps are replaced. Synthetic data only.
 *
 * - The RE-PLAN dialog lists the locked loads planned with older customer data, read fresh right before it
 *   opens, with one "Unlock ... first" choice per changed load, unticked (owner decision); a load being
 *   loaded has no choice, only what to do.
 * - Ticked: the loads go back to Planned first (latest first, `via`), then the re-plan starts as a manual
 *   adjustment naming them (review W6), with the dialog's fingerprint (`keptSeen`). Not ticked: nothing is
 *   unlocked, the re-plan is as before.
 * - A refused unlock stops there (no re-plan); an unlock that worked followed by a refused re-plan (429)
 *   says both (review W7).
 * - Two changed loads, one ticked: the re-plan's answer never says "changed meanwhile" for the other one
 *   (review S1 / W-2: `keptSeen` leaves out the loads just unlocked).
 * - The day screen's RE-PLAN does the same; with only on-time orders waiting it is still a manual
 *   adjustment, never a full re-optimize (review W-1).
 * - Step 3 shows the box also when RE-PLAN is off; the plan below does not repeat it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Host, elements, textOf, typeName } from './hook-host';
import { fixture } from './plan-detail-fixture';
import { keptEcho, keptFingerprint, keptReport, type KeptLoadInput, type KeptReport } from '@/lib/dispatch/kept-changes';
import type { PlanDetail } from '@/lib/dispatch/plan-detail';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));

type Answer = { ok: boolean; status: number; data: unknown; error: string | null; errorBody: Record<string, unknown> | null };
const io = vi.hoisted(() => ({
  requests: [] as { url: string; method?: string; json?: any }[],
  toasts: [] as [string, string][],
  day: null as any,
  plan: null as any,
  kept: null as any,
  patch: null as null | ((url: string) => Answer),
  replan: null as null | ((json: any) => Answer),
}));
vi.mock('@/app/t/[slug]/dispatch/client-api', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const ok = (data: unknown): Answer => ({ ok: true, status: 200, data, error: null, errorBody: null });
  return {
    ...actual,
    api: async (url: string, init?: { method?: string; json?: unknown }) => {
      io.requests.push({ url, method: init?.method, json: init?.json });
      if (url.startsWith('/api/dispatch/day')) return ok(structuredClone(io.day));
      if (url.endsWith('/kept-changes')) return ok(structuredClone(io.kept));
      if (url.endsWith('/plan') && !init?.json) return ok(structuredClone(io.plan));
      if (url.includes('/loads/') && init?.method === 'PATCH') return io.patch ? io.patch(url) : ok({});
      if (url.endsWith('/replan')) return io.replan ? io.replan(init?.json) : ok({ runId: 'run2', version: 2, reason: (init?.json as any)?.reason, queued: false, searchMode: 'QUICK' });
      if (url === '/api/drivers' || url === '/api/helpers') return ok([]);
      return ok({});
    },
  };
});
vi.mock('sonner', () => ({
  toast: {
    success: (t: string) => io.toasts.push(['success', t]),
    error: (t: string) => io.toasts.push(['error', t]),
    warning: (t: string) => io.toasts.push(['warning', t]),
    info: (t: string) => io.toasts.push(['info', t]),
  },
}));
vi.mock('next/dynamic', () => ({ default: () => function DynamicStub() { return null; } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace() {}, refresh() {}, push() {} }) }));

import { DispatchClient } from '@/app/t/[slug]/dispatch/dispatch-client';
import { PlanView } from '@/app/t/[slug]/dispatch/plan-view';
import { SearchModeDialog } from '@/app/t/[slug]/dispatch/search-mode-dialog';

const RULES = { shiftStartMin: 360, shiftMaxMin: 660, reloadMin: 30, loadingMinPerCase: 0, maxTrips: 3, depotOpenMin: 0, depotCloseMin: 1440, availableFromMin: null, availableToMin: null };

/** T05 L2 (C007, hours now 08:00-18:00, planned with 15:00-18:00) LOCKED, and T05 L3 LOCKED without a change. */
function report(l2Status: 'LOCKED' | 'LOADING' = 'LOCKED'): KeptReport {
  const load: KeptLoadInput = {
    loadId: 'L2', truckId: 't5', truckCode: 'T05', loadNo: 2, status: l2Status, rules: RULES, truckSmallNow: false,
    stops: [{
      sequence: 1, customerId: 'c7', serviceStartMin: 900, departureMin: 918, split: null,
      snapshot: { v: 1, customerId: 'c7', code: 'C007', branchCode: null, name: 'Shop 7', customerType: null, lat: 23.6, lng: 58.4, address: null, accessNotes: null, hardStartMin: 900, hardEndMin: 1080, prefStartMin: null, prefEndMin: null, serviceMin: 18, priority: 2, source: 'PLAN', capturedAt: '2026-09-27T12:00:00.000Z' },
      live: { name: 'Shop 7', address: null, lat: 23.6, lng: 58.4, hardStartMin: 480, hardEndMin: 1080, prefStartMin: null, prefEndMin: null, promised: null },
      customer: { code: 'C007', branchCode: null, name: 'Shop 7', active: true, smallTruckOnly: false, locationUsable: true },
      orders: [{ id: 'o7', cancelled: false, carriedTo: null }],
      newOrders: [],
    }],
  };
  return keptReport([load], [
    { loadId: 'L1', truckId: 't5', truckCode: 'T05', loadNo: 1, status: 'DISPATCHED' },
    { loadId: 'L2', truckId: 't5', truckCode: 'T05', loadNo: 2, status: l2Status },
    { loadId: 'L3', truckId: 't5', truckCode: 'T05', loadNo: 3, status: 'LOCKED' },
  ]);
}

/** The same, plus T06 L1 (C003) LOCKED with its hours narrowed: two changed loads. */
function twoLoads(): { shown: KeptReport; afterL2: KeptReport } {
  const m1: KeptLoadInput = {
    loadId: 'M1', truckId: 't6', truckCode: 'T06', loadNo: 1, status: 'LOCKED', rules: RULES, truckSmallNow: false,
    stops: [{
      sequence: 1, customerId: 'c3', serviceStartMin: 900, departureMin: 918, split: null,
      snapshot: { v: 1, customerId: 'c3', code: 'C003', branchCode: null, name: 'Shop 3', customerType: null, lat: 23.6, lng: 58.4, address: null, accessNotes: null, hardStartMin: 900, hardEndMin: 1080, prefStartMin: null, prefEndMin: null, serviceMin: 18, priority: 2, source: 'PLAN', capturedAt: '2026-09-27T12:00:00.000Z' },
      live: { name: 'Shop 3', address: null, lat: 23.6, lng: 58.4, hardStartMin: 1020, hardEndMin: 1080, prefStartMin: null, prefEndMin: null, promised: null },
      customer: { code: 'C003', branchCode: null, name: 'Shop 3', active: true, smallTruckOnly: false, locationUsable: true },
      orders: [{ id: 'o3', cancelled: false, carriedTo: null }],
      newOrders: [],
    }],
  };
  const t5Input: KeptLoadInput = {
    loadId: 'L2', truckId: 't5', truckCode: 'T05', loadNo: 2, status: 'LOCKED', rules: RULES, truckSmallNow: false,
    stops: [{
      sequence: 1, customerId: 'c7', serviceStartMin: 900, departureMin: 918, split: null,
      snapshot: { v: 1, customerId: 'c7', code: 'C007', branchCode: null, name: 'Shop 7', customerType: null, lat: 23.6, lng: 58.4, address: null, accessNotes: null, hardStartMin: 900, hardEndMin: 1080, prefStartMin: null, prefEndMin: null, serviceMin: 18, priority: 2, source: 'PLAN', capturedAt: '2026-09-27T12:00:00.000Z' },
      live: { name: 'Shop 7', address: null, lat: 23.6, lng: 58.4, hardStartMin: 480, hardEndMin: 1080, prefStartMin: null, prefEndMin: null, promised: null },
      customer: { code: 'C007', branchCode: null, name: 'Shop 7', active: true, smallTruckOnly: false, locationUsable: true },
      orders: [{ id: 'o7', cancelled: false, carriedTo: null }],
      newOrders: [],
    }],
  };
  const all = [
    { loadId: 'L1', truckId: 't5', truckCode: 'T05', loadNo: 1, status: 'DISPATCHED' },
    { loadId: 'L2', truckId: 't5', truckCode: 'T05', loadNo: 2, status: 'LOCKED' },
    { loadId: 'L3', truckId: 't5', truckCode: 'T05', loadNo: 3, status: 'LOCKED' },
    { loadId: 'M1', truckId: 't6', truckCode: 'T06', loadNo: 1, status: 'LOCKED' },
  ];
  // After T05 L3 and T05 L2 went back to Planned, the re-plan reads T06 L1 only.
  const after = all.map((l) => (l.truckId === 't5' && l.loadNo > 1 ? { ...l, status: 'PLANNED' } : l));
  return { shown: keptReport([t5Input, m1], all), afterL2: keptReport([m1], after) };
}

beforeEach(() => {
  io.requests.length = 0;
  io.toasts.length = 0;
  io.patch = null;
  io.replan = null;
  io.kept = report();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function mountPlan() {
  const d: PlanDetail = fixture();
  io.plan = { ...d, kept: io.kept };
  const host: Host<any> = new Host(PlanView as any, { slug: 'nmwc', runId: 'run1', canPlan: true, canDispatch: true, phoneCountryCode: '968', reloadSignal: 0, onBusyChange: () => {}, onChanged: async () => {}, today: '2026-09-27' });
  host.render();
  await host.settle();
  const press = async () => {
    elements(host.tree).find((e) => e.props?.['data-testid'] === 'replan-btn').props.onClick();
    await host.settle();
    const dialog = elements(host.tree).find((e) => typeName(e) === 'SearchModeDialog');
    return dialog.props as { question: any; onDone: (a: { mode: string; unlock: unknown[] } | null) => void };
  };
  return { host, press };
}

const sent = (pred: (r: (typeof io.requests)[number]) => boolean) => io.requests.filter(pred);
const patches = () => sent((r) => r.method === 'PATCH');
const replans = () => sent((r) => r.url.endsWith('/replan'));

describe('the RE-PLAN dialog of the plan screen', () => {
  it('lists the kept load, read fresh, with its unlock chain naming the unchanged later load; the plan screen shows the box', async () => {
    const { host, press } = await mountPlan();
    const box = elements(host.tree).find((e) => typeName(e) === 'KeptChangesBox');
    expect(box.props).toMatchObject({ testId: 'kept-changed-box', canPlan: true });
    const before = io.requests.length;
    const { question, onDone } = await press();
    expect(io.requests.slice(before).map((r) => r.url)).toEqual(['/api/runs/run1/kept-changes']);
    expect(question.note).toBe('Locked, loading and dispatched loads stay exactly as they are; you can unlock the locked ones listed below first.');
    expect(question.kept.lines).toEqual(['T05 L2 (locked): C007 - hours now 08:00–18:00 (planned with 15:00–18:00): still kept']);
    expect(question.kept.offers).toEqual([
      expect.objectContaining({ id: 'L2', label: "Unlock T05 L3 and T05 L2 first (no change on T05 L3: a truck's later loads go back to Planned before its earlier ones)", blocked: null }),
    ]);
    onDone(null);
    await host.settle();
    expect(patches()).toEqual([]);
    expect(replans()).toEqual([]);
  });

  it('ticked: T05 L3 then T05 L2 back to Planned from the warning, then a manual adjustment naming them, with the fingerprint', async () => {
    const { host, press } = await mountPlan();
    const { question, onDone } = await press();
    onDone({ mode: 'QUICK', unlock: [question.kept.offers[0].loads] });
    await host.settle();
    expect(patches().map((r) => [r.url, r.json])).toEqual([
      ['/api/runs/run1/loads/L3', { status: 'PLANNED', via: 'KEPT_DATA_CHANGED' }],
      ['/api/runs/run1/loads/L2', { status: 'PLANNED', via: 'KEPT_DATA_CHANGED' }],
    ]);
    expect(replans().map((r) => r.json)).toEqual([
      // The dialog's list without the loads now back to Planned (here: nothing left).
      expect.objectContaining({ reason: 'MANUAL_ADJUSTMENT', note: 'Unlocked for changed customer data: T05 L3, T05 L2', searchMode: 'QUICK', keptSeen: keptFingerprint([]) }),
    ]);
    expect(io.toasts.find(([k]) => k === 'success')?.[1]).toContain(
      'T05 L3 and T05 L2 are back to Planned and are being re-planned with the data now; print their sheets again when the new plan is ready.',
    );
  });

  it('not ticked: nothing is unlocked; the re-plan is as before, with the fingerprint', async () => {
    const { host, press } = await mountPlan();
    const { onDone } = await press();
    onDone({ mode: 'QUICK', unlock: [] });
    await host.settle();
    expect(patches()).toEqual([]);
    expect(replans().map((r) => r.json)).toEqual([expect.objectContaining({ reason: 'REOPTIMIZE', keptSeen: io.kept.fingerprint })]);
    expect(replans()[0]!.json).not.toHaveProperty('note');
  });

  it('a refused unlock stops there: what went back is said, and no re-plan starts', async () => {
    io.patch = (url) =>
      url.endsWith('/L2') ? { ok: false, status: 409, data: null, error: 'An optimization is running for this plan.', errorBody: null } : { ok: true, status: 200, data: {}, error: null, errorBody: null };
    const { host, press } = await mountPlan();
    const { question, onDone } = await press();
    onDone({ mode: 'QUICK', unlock: [question.kept.offers[0].loads] });
    await host.settle();
    expect(patches()).toHaveLength(2);
    expect(replans()).toEqual([]);
    expect(io.toasts).toContainEqual(['error', 'T05 L3 is back to Planned. T05 L2 could not be unlocked: An optimization is running for this plan. Re-plan not started.']);
  });

  it('review W7: the unlock worked, the re-plan was refused (429): the toast says both, and the plan is read again', async () => {
    io.replan = () => ({ ok: false, status: 429, data: null, error: 'Too many optimizations right now. Try again in a minute.', errorBody: { error: 'Too many optimizations right now. Try again in a minute.', code: 'SOLVE_QUOTA' } });
    const { host, press } = await mountPlan();
    const { question, onDone } = await press();
    const reads = sent((r) => r.url.endsWith('/plan')).length;
    onDone({ mode: 'QUICK', unlock: [question.kept.offers[0].loads] });
    await host.settle();
    expect(replans()).toHaveLength(1);
    expect(io.toasts).toContainEqual([
      'error',
      'T05 L3 and T05 L2 are back to Planned; re-plan not started: Too many optimizations right now. Try again in a minute. Press RE-PLAN again, or Lock the load again to keep it as it was.',
    ]);
    expect(sent((r) => r.url.endsWith('/plan')).length).toBeGreaterThan(reads);
  });

  it('review S1 / W-2: two changed loads, only T05 L2 ticked - no "changed meanwhile" warning for T06 L1, which stays kept', async () => {
    const { shown, afterL2 } = twoLoads();
    io.kept = shown;
    // The server reads the list again after the unlock (T06 L1 only) and compares it with keptSeen.
    io.replan = (json) => ({ ok: true, status: 202, data: { runId: 'run2', version: 2, reason: json.reason, queued: false, searchMode: 'QUICK', kept: keptEcho(afterL2, json.keptSeen) }, error: null, errorBody: null });
    const { host, press } = await mountPlan();
    const { question, onDone } = await press();
    // T06 L1 breaks a rule now, so it is listed first.
    expect(question.kept.offers.map((o: { id: string }) => o.id)).toEqual(['M1', 'L2']);
    onDone({ mode: 'QUICK', unlock: [question.kept.offers[1].loads] });
    await host.settle();
    expect(patches().map((r) => r.url)).toEqual(['/api/runs/run1/loads/L3', '/api/runs/run1/loads/L2']);
    expect(replans()[0]!.json).toMatchObject({ reason: 'MANUAL_ADJUSTMENT', keptSeen: afterL2.fingerprint });
    expect(io.toasts.filter(([k]) => k === 'warning')).toEqual([]);
    expect(io.toasts.find(([k]) => k === 'success')?.[1]).toContain('Kept as planned, with older customer data: T06 L1.');
  });

  it('a load being loaded: no choice in the dialog, only what to do; nothing is unlocked', async () => {
    io.kept = report('LOADING');
    const { host, press } = await mountPlan();
    const { question, onDone } = await press();
    expect(question.kept.offers[0].blocked).toMatch(/^T05 L2 is being loaded/);
    // Nothing can be ticked: the note does not point to an unlock below (review W-7).
    expect(question.note).toBe('Locked, loading and dispatched loads stay exactly as they are.');
    onDone({ mode: 'QUICK', unlock: [] });
    await host.settle();
    expect(patches()).toEqual([]);
  });
});

describe('the dialog itself (SearchModeDialog)', () => {
  it('every unlock choice starts unticked (owner decision); ticked, Start answers its loads; a blocked one has no tick box', async () => {
    const answers: unknown[] = [];
    const kept = { lines: ['line'], more: 2, offers: [
      { id: 'L2', label: 'Unlock T05 L2 first', loads: [{ loadId: 'L2', truckId: 't5', loadNo: 2, label: 'T05 L2', status: 'LOCKED', changed: true }], blocked: null },
      { id: 'M1', label: 'Unlock T06 L1 first', loads: [], blocked: 'T06 L1 is being loaded: ...' },
    ] };
    const host: Host<any> = new Host(SearchModeDialog as any, { question: { verb: 'Re-plan', defaultMode: 'QUICK', stops: 3, capSec: 1200, kept }, onDone: (a: unknown) => answers.push(a) });
    host.render();
    const box = () => elements(host.tree).find((e) => e.type === 'input' && e.props?.type === 'checkbox');
    expect(elements(host.tree).filter((e) => e.type === 'input' && e.props?.type === 'checkbox')).toHaveLength(1);
    expect(box().props.checked).toBe(false);
    expect(textOf(elements(host.tree).find((e) => e.props?.['data-testid'] === 'kept-in-dialog'))).toContain('and 2 more on the plan screen');
    elements(host.tree).find((e) => e.props?.['data-testid'] === 'search-mode-start').props.onClick();
    box().props.onChange();
    host.flush();
    expect(box().props.checked).toBe(true);
    elements(host.tree).find((e) => e.props?.['data-testid'] === 'search-mode-start').props.onClick();
    expect(answers).toEqual([{ mode: 'QUICK', unlock: [] }, { mode: 'QUICK', unlock: [kept.offers[0]!.loads] }]);
  });
});

describe('Step 3 on the day screen', () => {
  const DEPOT = { id: 'd1', code: 'D01', name: 'Depot', lat: 23.58, lng: 58.4 };
  const day = () => ({
    date: '2026-09-28', today: '2026-09-27', tomorrow: '2026-09-28', cutoff: '16:00', depots: [DEPOT], depot: DEPOT,
    orders: { count: 1, cases: 12, customers: 1, late: 0, weightKg: 120 }, customers: [], productsWithoutWeight: [], weightsToApply: [],
    outdated: { weightCases: 0, inactiveOrders: 0, masterChanged: 0, trucksChanged: 0 },
    plan: { id: 'run1', version: 1, status: 'READY', chosen: true, job: null, loadsByStatus: { LOCKED: 2 } },
    pending: { count: 0, cases: 0, late: 0 }, openOrders: 0, trucks: { active: 2, capacityCases: 1200 }, batches: [], serviceArea: { minLat: 20, maxLat: 26, minLng: 55, maxLng: 60 },
    kept: io.kept,
  });

  async function mountDay(pending = { count: 1, cases: 12, late: 0, carried: 0 }) {
    io.day = { ...day(), pending };
    io.plan = { ...fixture(), kept: io.kept };
    const host: Host<any> = new Host(DispatchClient as any, { slug: 'nmwc', canPlan: true, canDispatch: true, canEditProducts: true, initialDate: '2026-09-28', initialDepot: 'd1', phoneCountryCode: '968' });
    host.render();
    await host.settle();
    const press = async () => {
      elements(host.tree).find((e) => e.props?.['data-testid'] === 'optimize-btn').props.onClick();
      await host.settle();
      return elements(host.tree).find((e) => typeName(e) === 'SearchModeDialog').props as { question: any; onDone: (a: { mode: string; unlock: unknown[] } | null) => void };
    };
    return { host, press };
  }

  it('RE-PLAN with an on-time order waiting, T05 L2 ticked: unlocked latest first, then a manual adjustment - never a full re-optimize (review W-1)', async () => {
    const { host, press } = await mountDay();
    expect(elements(host.tree).find((e) => e.props?.['data-testid'] === 'optimize-btn').props.disabled).toBe(false);
    const { question, onDone } = await press();
    expect(io.requests.filter((r) => r.url.endsWith('/kept-changes'))).toHaveLength(1);
    expect(question.note).toBe('Locked, loading and dispatched loads stay exactly as they are; you can unlock the locked ones listed below first.');
    onDone({ mode: 'QUICK', unlock: [question.kept.offers[0].loads] });
    await host.settle();
    expect(patches().map((r) => [r.url, r.json])).toEqual([
      ['/api/runs/run1/loads/L3', { status: 'PLANNED', via: 'KEPT_DATA_CHANGED' }],
      ['/api/runs/run1/loads/L2', { status: 'PLANNED', via: 'KEPT_DATA_CHANGED' }],
    ]);
    expect(replans().map((r) => r.json)).toEqual([
      expect.objectContaining({ reason: 'MANUAL_ADJUSTMENT', note: 'Unlocked for changed customer data: T05 L3, T05 L2', searchMode: 'QUICK', keptSeen: keptFingerprint([]) }),
    ]);
    expect(io.toasts.find(([k]) => k === 'success')?.[1]).toContain('T05 L3 and T05 L2 are back to Planned and are being re-planned with the data now');
  });

  it('the day screen: a late order waiting keeps the late-order re-plan; not ticked, nothing is unlocked and the re-plan is as before', async () => {
    const { host, press } = await mountDay({ count: 1, cases: 12, late: 1, carried: 0 });
    const first = await press();
    first.onDone({ mode: 'QUICK', unlock: [first.question.kept.offers[0].loads] });
    await host.settle();
    expect(replans().at(-1)!.json).toMatchObject({ reason: 'LATE_ORDER', note: 'Unlocked for changed customer data: T05 L3, T05 L2' });
    io.requests.length = 0;
    const second = await press();
    second.onDone({ mode: 'QUICK', unlock: [] });
    await host.settle();
    expect(patches()).toEqual([]);
    expect(replans().map((r) => r.json)).toEqual([expect.objectContaining({ reason: 'LATE_ORDER', keptSeen: io.kept.fingerprint })]);
    expect(replans()[0]!.json).not.toHaveProperty('note');
  });

  it('the day screen, review W7: the unlock worked, the re-plan was refused (429): the toast says both; a refused unlock starts no re-plan', async () => {
    io.replan = () => ({ ok: false, status: 429, data: null, error: 'Too many optimizations right now. Try again in a minute.', errorBody: { error: 'Too many optimizations right now. Try again in a minute.', code: 'SOLVE_QUOTA' } });
    const { host, press } = await mountDay();
    const a = await press();
    a.onDone({ mode: 'QUICK', unlock: [a.question.kept.offers[0].loads] });
    await host.settle();
    expect(io.toasts).toContainEqual([
      'error',
      'T05 L3 and T05 L2 are back to Planned; re-plan not started: Too many optimizations right now. Try again in a minute. Press RE-PLAN again, or Lock the load again to keep it as it was.',
    ]);
    io.requests.length = 0;
    io.toasts.length = 0;
    io.patch = (url) => (url.endsWith('/L3') ? { ok: false, status: 409, data: null, error: 'Load 3 is LOADING and can no longer be changed.', errorBody: null } : { ok: true, status: 200, data: {}, error: null, errorBody: null });
    const b = await press();
    b.onDone({ mode: 'QUICK', unlock: [b.question.kept.offers[0].loads] });
    await host.settle();
    expect(patches().map((r) => r.url)).toEqual(['/api/runs/run1/loads/L3']);
    expect(replans()).toEqual([]);
    expect(io.toasts).toContainEqual(['error', 'T05 L3 could not be unlocked: Load 3 is LOADING and can no longer be changed. Re-plan not started.']);
  });

  it('shows the box also with RE-PLAN off (every order on a locked load); the plan below does not repeat it; Unlock asks, then unlocks latest first', async () => {
    io.day = day();
    io.plan = { ...fixture(), kept: io.kept };
    const host: Host<any> = new Host(DispatchClient as any, { slug: 'nmwc', canPlan: true, canDispatch: true, canEditProducts: true, initialDate: '2026-09-28', initialDepot: 'd1', phoneCountryCode: '968' });
    host.render();
    await host.settle();
    const els = () => elements(host.tree);
    expect(els().find((e) => e.props?.['data-testid'] === 'optimize-btn').props.disabled).toBe(true);
    const box = els().find((e) => typeName(e) === 'KeptChangesBox');
    expect(box.props).toMatchObject({ testId: 'kept-changed', canPlan: true, busy: false });
    expect(box.props.report.loads.map((l: { label: string }) => l.label)).toEqual(['T05 L2']);
    expect(els().find((e) => typeName(e) === 'PlanView').props.showKeptBox).toBe(false);
    const asked: string[] = [];
    vi.stubGlobal('window', { confirm: (q: string) => (asked.push(q), true) });
    box.props.onUnlock(box.props.report.loads[0].unlock.loads);
    await host.settle();
    expect(asked[0]).toMatch(/^Put T05 L3 and T05 L2 back to Planned\?/);
    expect(patches().map((r) => r.url)).toEqual(['/api/runs/run1/loads/L3', '/api/runs/run1/loads/L2']);
    expect(io.toasts.find(([k]) => k === 'success')?.[1]).toMatch(/^T05 L3 and T05 L2 are back to Planned\. RE-PLAN to plan them with the customer data now/);
  });
});
