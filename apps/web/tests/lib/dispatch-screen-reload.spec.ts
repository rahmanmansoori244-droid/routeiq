/**
 * The day screen after a customer correction (audit F13) and the plan's exports when every order is
 * unserved (audit F16), on the REAL DispatchClient and PlanView through the hook host
 * (hook-host.ts): only api(), the toasts, the router and the maps are replaced.
 *
 *  - F13: saving a pin or the details refreshed the day but not the plan below it. A READY plan does
 *    not poll, so its "changed after planning" notes, badge and the WhatsApp "New pin" line appeared
 *    only after a page reload - also for LOCKED loads, which the day banner does not count. Now the
 *    plan is read again in place (reloadSignal; never a remount, which would close an open late
 *    order). The stop itself keeps the planned pin (its link, the route link, the map) until the load
 *    is re-planned; only the notes and the "New pin" line are new.
 *  - F16: a dispatch plan with no load (every order unserved) offered no Excel export at all; now the
 *    dispatch workbook is offered by the isDispatchPlan discriminator. The driver sheets (PDF) still
 *    need loads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Host, elements, typeName } from './hook-host';
import { fixture, ORDERS, PRODUCTS } from './plan-detail-fixture';
import type { PlanDetail } from '@/lib/dispatch/plan-detail';
import { pinUrl } from '@/lib/dispatch/driver-links';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));

const requests: string[] = [];
const answers = vi.hoisted(() => ({ day: null as any, plan: null as any }));
vi.mock('@/app/t/[slug]/dispatch/client-api', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const ok = (data: unknown) => ({ ok: true, status: 200, data, error: null, errorBody: null });
  return {
    ...actual,
    api: async (url: string) => {
      requests.push(url);
      if (url.startsWith('/api/dispatch/day')) return ok(structuredClone(answers.day));
      if (url.endsWith('/plan')) return ok(structuredClone(answers.plan));
      if (url === '/api/drivers') return ok([]);
      return ok({});
    },
  };
});
vi.mock('sonner', () => ({ toast: { success() {}, error() {}, warning() {}, info() {} } }));
vi.mock('next/dynamic', () => ({ default: () => function DynamicStub() { return null; } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace() {}, refresh() {}, push() {} }) }));

import { DispatchClient } from '@/app/t/[slug]/dispatch/dispatch-client';
import { PlanView } from '@/app/t/[slug]/dispatch/plan-view';

beforeEach(() => {
  requests.length = 0;
});

const DEPOT = { id: 'd1', code: 'MCT', name: 'Muscat', lat: 23.58, lng: 58.4 };
const customer = {
  customerId: 'c1', code: 'C001', branchCode: 'B1', name: 'Lulu Hypermarket Bausher', customerType: 'HYPERMARKET', priority: 1, prioritySource: 'CUSTOMER',
  serviceMin: 20, serviceSource: 'CUSTOMER', hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null, window: 'Any time',
  lat: 23.5859, lng: 58.3829, locationVerified: true, orders: 1, cases: 70, issues: [{ code: 'TYPE_MISSING', blocking: false, message: 'x' }], blocking: false,
};
const day = (loadStatus: 'PLANNED' | 'LOCKED') => ({
  date: '2026-09-28', today: '2026-09-27', tomorrow: '2026-09-28', cutoff: '16:00', depots: [DEPOT], depot: DEPOT,
  orders: { count: 1, cases: 70, customers: 1, late: 0, weightKg: 800 }, customers: [customer], productsWithoutWeight: [], weightsToApply: [],
  outdated: { weightCases: 0, inactiveOrders: 0, masterChanged: 0, trucksChanged: 0 },
  plan: { id: 'run1', version: 1, status: 'READY', chosen: true, job: null, loadsByStatus: { [loadStatus]: 1 } },
  pending: { count: 0, cases: 0, late: 0 }, openOrders: loadStatus === 'PLANNED' ? 1 : 0, trucks: { active: 2, capacityCases: 1200 }, batches: [],
});

async function mountDay(loadStatus: 'PLANNED' | 'LOCKED') {
  answers.day = day(loadStatus);
  const host: Host<any> = new Host(DispatchClient as any, { slug: 'nmwc', canPlan: true, canDispatch: true, canEditProducts: true, initialDate: '2026-09-28', initialDepot: 'd1', phoneCountryCode: '968' });
  host.render();
  await host.settle();
  const els = () => elements(host.tree);
  const planView = () => els().find((e) => typeName(e) === 'PlanView');
  const dialog = (name: string) => els().find((e) => typeName(e) === name);
  return { host, planView, dialog };
}

describe('F13: a customer saved on the day screen reloads the plan below in place', () => {
  for (const loadStatus of ['PLANNED', 'LOCKED'] as const) {
    for (const which of ['LocationDialog', 'CustomerDialog'] as const) {
      it(`${which} saved, the stop on a ${loadStatus} load: the day and the plan are read again`, async () => {
        const t = await mountDay(loadStatus);
        const before = { key: t.planView().key, reloadSignal: t.planView().props.reloadSignal };
        requests.length = 0;
        t.dialog(which).props.onSaved();
        await t.host.settle();
        expect(requests.some((u) => u.startsWith('/api/dispatch/day'))).toBe(true);
        // In place: the same PlanView (key), told to load again (before: reloadSignal unchanged).
        expect(t.planView().key).toBe(before.key);
        expect(t.planView().props.reloadSignal).toBe(before.reloadSignal + 1);
      });
    }
  }
});

function whatsappOf(tree: unknown, truckCode: string, loadNo: number): string {
  const row = elements(tree).find((e) => typeName(e) === 'LoadDriver' && e.props.l.truckCode === truckCode && e.props.l.loadNo === loadNo);
  return 'url' in row.props.whatsapp ? decodeURIComponent(row.props.whatsapp.url) : row.props.whatsapp.off;
}

function mountPlan(detail: PlanDetail) {
  answers.plan = detail;
  const props = { slug: 'nmwc', runId: 'run1', canPlan: true, canDispatch: true, phoneCountryCode: '968', reloadSignal: 0, onBusyChange: () => {}, onChanged: async () => {} };
  const host: Host<any> = new Host(PlanView as any, props);
  host.render();
  return host;
}

describe('F13: the reloaded plan brings the fresh WhatsApp text', () => {
  it('a pin corrected after planning shows in the driver message once the plan is read again', async () => {
    const onScreen = fixture();
    const host = mountPlan(onScreen);
    await host.settle();
    expect(whatsappOf(host.tree, 'T01', 1)).not.toContain('New pin');
    const fresh = structuredClone(onScreen);
    fresh.loads[0].stops[0].masterChanged = [{ kind: 'LOCATION', text: 'Location updated after planning: new pin 23.60120, 58.41010 (moved 2.1 km)', newLat: 23.6012, newLng: 58.4101, movedM: 2100 }];
    answers.plan = fresh;
    const loadsBefore = requests.filter((u) => u.endsWith('/plan')).length;
    host.render({ reloadSignal: 1 });
    await host.settle();
    expect(requests.filter((u) => u.endsWith('/plan')).length).toBe(loadsBefore + 1);
    expect(whatsappOf(host.tree, 'T01', 1)).toContain('New pin - ask the dispatcher which one to use');
  });

  it('the reload does not move the stop: its pin link, the route link and the map stay the planned ones (A2 review, docs)', async () => {
    const onScreen = fixture();
    const host = mountPlan(onScreen);
    await host.settle();
    const planned = { lat: onScreen.loads[0].stops[0].lat!, lng: onScreen.loads[0].stops[0].lng! };
    const moved = { lat: 23.6012, lng: 58.4101 };
    const routeLines = (msg: string) => msg.split('\n').filter((l) => /^Route( \d+\/\d+)?: /.test(l));
    const before = whatsappOf(host.tree, 'T01', 1);
    // The plan as getPlanDetail gives it after the pin was saved: the stop keeps its snapshot point, the note has the new pin.
    const fresh = structuredClone(onScreen);
    fresh.loads[0].stops[0].masterChanged = [{ kind: 'LOCATION', text: 'Location updated after planning: new pin 23.60120, 58.41010 (2.1 km from the planned one)', newLat: moved.lat, newLng: moved.lng, movedM: 2100 }];
    answers.plan = fresh;
    host.render({ reloadSignal: 1 });
    await host.settle();
    const lines = whatsappOf(host.tree, 'T01', 1).split('\n');
    const at = lines.findIndex((l) => l.startsWith('1. '));
    expect(lines[at + 1]).toBe(pinUrl(planned)); // the stop's own link: the planned pin
    expect(lines[at + 3]).toBe(`New pin - ask the dispatcher which one to use: ${pinUrl(moved)}`);
    expect(lines.filter((l) => l.includes(pinUrl(moved)!))).toHaveLength(1); // only on the "New pin" line
    expect(routeLines(lines.join('\n'))).toEqual(routeLines(before)); // the route link: unchanged
    const map = elements(host.tree).find((e) => typeName(e) === 'DynamicStub' && Array.isArray(e.props?.loads));
    expect(map.props.loads[0].stops[0]).toMatchObject(planned); // the map: the planned pin
  });
});

/** An applied dispatch plan in which every order is unserved (no truck could take them): no load. */
function allUnserved(): PlanDetail {
  const d = fixture();
  const casesOf = (o: (typeof ORDERS)[number]) => o.lines.reduce((a, l) => a + l.cases, 0);
  const kgOf = (o: (typeof ORDERS)[number]) => o.lines.reduce((a, l) => a + l.cases * PRODUCTS[l.sku].kg, 0);
  return {
    ...d,
    loads: [],
    isDispatchPlan: true,
    unserved: ORDERS.map((o) => ({
      orderId: o.id, customerId: o.customerId, customerCode: o.code, branchCode: o.branch, customerName: o.name, cases: casesOf(o), weightKg: kgOf(o),
      priority: o.priority, reasonCode: 'NO_AVAILABLE_TRUCK', reasonMessage: 'No truck available for this order.', late: o.late, salesOrders: o.lines.map((l) => l.so), partial: false,
    })) as PlanDetail['unserved'],
  };
}

describe('F16: the exports offered for a plan without loads', () => {
  const links = (host: Host<any>) => {
    const els = elements(host.tree);
    return { excel: els.find((e) => e.props?.['data-testid'] === 'export-excel')?.props.href ?? null, pdf: els.find((e) => e.props?.['data-testid'] === 'export-driver-pdf')?.props.href ?? null };
  };

  it('every order unserved: the dispatch Excel is offered, the driver sheets are not (before: neither)', async () => {
    const host = mountPlan(allUnserved());
    await host.settle();
    expect(links(host)).toEqual({ excel: '/api/runs/run1/export/excel', pdf: null });
  });

  it('a plan with loads offers both; a plan not optimized yet (no load, no option) offers neither', async () => {
    const withLoads = mountPlan({ ...fixture(), isDispatchPlan: true });
    await withLoads.settle();
    expect(links(withLoads)).toEqual({ excel: '/api/runs/run1/export/excel', pdf: '/api/runs/run1/export/pdf' });
    const draft = mountPlan({ ...allUnserved(), isDispatchPlan: false });
    await draft.settle();
    expect(links(draft)).toEqual({ excel: null, pdf: null });
  });
});
