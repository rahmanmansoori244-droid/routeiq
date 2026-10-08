/**
 * Dispatch and Completed can never be undone (load-state.ts: DISPATCHED -> COMPLETED only, COMPLETED
 * -> nothing). Review of 8 Oct 2026 (ui-dispatch-3, M2): both were one click on small buttons next
 * to Loading and Unlock, with no question, so a mis-click froze a load for good - no unlock, no
 * re-plan, no other driver. Now the plan screen asks first, naming the truck, load, driver and stops,
 * and Cancel sends nothing. Lock, Loading and the ways back still go at once (each can be undone).
 *
 * The question itself (oneWayMoveQuestion) is checked on its own, then the REAL PlanView and its
 * LoadActions are driven through the hook host (hook-host.ts): only api(), the toasts, the maps and
 * window.confirm are replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Host, elements, textOf, typeName } from './hook-host';
import { fixture } from './plan-detail-fixture';
import type { PlanDetail } from '@/lib/dispatch/plan-detail';
import { oneWayMoveQuestion } from '@/lib/dispatch/load-state';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));

const sent: { method: string; url: string; json: unknown }[] = [];
const answers = vi.hoisted(() => ({ plan: null as unknown }));
vi.mock('@/app/t/[slug]/dispatch/client-api', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const ok = (data: unknown) => ({ ok: true, status: 200, data, error: null, errorBody: null });
  return {
    ...actual,
    api: async (url: string, init: { method?: string; json?: unknown } = {}) => {
      sent.push({ method: init.method ?? 'GET', url, json: init.json });
      if (url.endsWith('/plan')) return ok(structuredClone(answers.plan));
      if (url === '/api/drivers') return ok([]);
      if (url.endsWith('/outcomes')) return ok(null); // no delivery results read
      return ok({});
    },
  };
});
vi.mock('sonner', () => ({ toast: { success() {}, error() {}, warning() {}, info() {} } }));
vi.mock('next/dynamic', () => ({ default: () => function DynamicStub() { return null; } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace() {}, refresh() {}, push() {} }) }));

import { PlanView } from '@/app/t/[slug]/dispatch/plan-view';

let answer = true;
const asked: string[] = [];
beforeEach(() => {
  sent.length = 0;
  asked.length = 0;
  answer = true;
  vi.stubGlobal('window', {
    confirm: (m: string) => {
      asked.push(m);
      return answer;
    },
    prompt: () => null,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function mountPlan(detail: PlanDetail, today?: string) {
  answers.plan = detail;
  const host: Host<any> = new Host(PlanView as any, { slug: 'nmwc', runId: 'run1', canPlan: true, canDispatch: true, phoneCountryCode: '968', reloadSignal: 0, onBusyChange: () => {}, onChanged: async () => {}, today });
  host.render();
  await host.settle();
  return host;
}

/** A load's action buttons as the screen renders them (LoadActions is rendered on its own here). */
function buttonsOf(host: Host<any>, truckCode: string, loadNo: number) {
  const el = elements(host.tree).find((e) => typeName(e) === 'LoadActions' && e.props.l.truckCode === truckCode && e.props.l.loadNo === loadNo);
  const sub: Host<any> = new Host(el.type, el.props);
  sub.render();
  return elements(sub.tree)
    .filter((e) => String(e.props?.['data-testid'] ?? '').startsWith('act-'))
    .map((e) => ({ label: textOf(e.props.children).trim(), disabled: !!e.props.disabled, click: e.props.onClick as () => void }));
}

async function press(host: Host<any>, truckCode: string, loadNo: number, label: string) {
  const b = buttonsOf(host, truckCode, loadNo).find((x) => x.label === label);
  expect(b, label).toBeDefined();
  expect(b!.disabled, `${label} enabled`).toBe(false);
  b!.click();
  await host.settle();
}

const patches = () => sent.filter((s) => s.method === 'PATCH').map((s) => ({ url: s.url, json: s.json }));

describe('oneWayMoveQuestion: only the moves that cannot be undone ask', () => {
  const l = { truckCode: 'T03', loadNo: 2, driverName: 'Rashid Al Balushi', stops: 14, cases: 412 };

  it('Dispatch names the truck, load, driver, stops and cases, and says it cannot be undone', () => {
    const q = oneWayMoveQuestion(l, 'DISPATCHED')!;
    expect(q).toMatch(/^Dispatch T03 L2 \(Rashid Al Balushi, 14 stop\(s\), 412 cases\)\?/);
    expect(q).toContain('This cannot be undone: a dispatched load can never be unlocked, re-planned or given another driver.');
    expect(q).not.toContain('not today');
  });

  it('Completed names the trip and says the results are closed for the driver', () => {
    const q = oneWayMoveQuestion(l, 'COMPLETED')!;
    expect(q).toMatch(/^Mark T03 L2 \(Rashid Al Balushi, 14 stop\(s\)\) as Completed\?/);
    expect(q).toContain("This cannot be undone: the trip is closed and the driver's phone can no longer change its results");
  });

  it('a load of a later day than the company today says so; today or no today says nothing', () => {
    expect(oneWayMoveQuestion(l, 'DISPATCHED', { runDate: '2026-10-09', today: '2026-10-08' })).toContain('This load is for 9 Oct, not today.');
    expect(oneWayMoveQuestion(l, 'DISPATCHED', { runDate: '2026-10-08', today: '2026-10-08' })).not.toContain('not today');
    expect(oneWayMoveQuestion(l, 'DISPATCHED', { runDate: '2026-10-09', today: null })).not.toContain('not today');
  });

  it('Lock, Loading, Unlock and Back to locked ask nothing (each can be undone)', () => {
    for (const to of ['LOCKED', 'LOADING', 'PLANNED']) expect(oneWayMoveQuestion(l, to), to).toBeNull();
  });

  it('a load without a driver is named so (a dispatched load from before rule 20)', () => {
    expect(oneWayMoveQuestion({ ...l, driverName: null }, 'COMPLETED')).toContain('(no driver, 14 stop(s))');
  });
});

describe('the plan screen asks before Dispatch and Completed (ui-dispatch-3)', () => {
  it('Dispatch on a locked load asks first; Cancel sends nothing (before: one click dispatched it)', async () => {
    const host = await mountPlan(fixture());
    expect(buttonsOf(host, 'T01', 1).map((b) => b.label)).toEqual(['Unlock', 'Loading', 'Dispatch']);
    answer = false;
    await press(host, 'T01', 1, 'Dispatch');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Dispatch T01 L1 \(Salim Al Harthy, 2 stop\(s\), \d+ cases\)\?/);
    expect(asked[0]).toContain('This cannot be undone');
    expect(patches()).toEqual([]);
  });

  it('OK sends the move as before', async () => {
    const host = await mountPlan(fixture());
    await press(host, 'T01', 1, 'Dispatch');
    expect(asked).toHaveLength(1);
    expect(patches()).toEqual([{ url: '/api/runs/run1/loads/L1', json: { status: 'DISPATCHED' } }]);
  });

  it("a load of tomorrow says it is not today's (the day screen opens on tomorrow in the evening)", async () => {
    const host = await mountPlan(fixture(), '2026-09-24');
    answer = false;
    await press(host, 'T01', 1, 'Dispatch');
    expect(asked[0]).toContain('This load is for 25 Sep, not today.');
  });

  it('Completed asks too; Cancel sends nothing', async () => {
    const detail = fixture();
    detail.loads[0].status = 'DISPATCHED';
    const host = await mountPlan(detail);
    expect(buttonsOf(host, 'T01', 1).map((b) => b.label)).toEqual(['Completed']);
    answer = false;
    await press(host, 'T01', 1, 'Completed');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Mark T01 L1 \(Salim Al Harthy, 2 stop\(s\)\) as Completed\?/);
    expect(patches()).toEqual([]);
    answer = true;
    await press(host, 'T01', 1, 'Completed');
    expect(patches()).toEqual([{ url: '/api/runs/run1/loads/L1', json: { status: 'COMPLETED' } }]);
  });

  it('control: Loading and Unlock go at once, with no question', async () => {
    const host = await mountPlan(fixture());
    await press(host, 'T01', 1, 'Loading');
    await press(host, 'T01', 1, 'Unlock');
    expect(asked).toEqual([]);
    expect(patches().map((p) => p.json)).toEqual([{ status: 'LOADING' }, { status: 'PLANNED' }]);
  });
});
