/**
 * One route on the salesman page (owner feedback of 20 Oct 2026: "first a list of statuses; when he clicks on
 * delivered he sees what is delivered, when he clicks on the way he sees what is on the way"): app/s/[token]/route-view.tsx
 * on the REAL component through the hook host (hook-host.ts). The status buttons come first; "All" is the default and
 * lists every customer in the server's order (by time); a tap shows that status only, a second tap all again; a
 * refresh keeps the status picked. No truck, trip or map anywhere. Invented data only (sales-page-fixture.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { Host, elements, textOf, typeName } from './hook-host';
import { routeView, row } from './sales-page-fixture';
import type { SalesRouteView } from '@/lib/sales-link/view-types';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));

import { RouteView } from '@/app/s/[token]/route-view';

type Props = { view: SalesRouteView; lang: 'en' | 'ar' | 'ur'; future: boolean; date: string };

function mount(view: SalesRouteView, lang: Props['lang'] = 'en') {
  const host = new Host(RouteView as never, { view, lang, future: false, date: '2026-10-19' } satisfies Props);
  host.render();
  const tree = () => host.tree;
  const byType = (name: string) => elements(tree()).filter((e) => typeName(e) === name);
  const grid = () => byType('StatusGrid')[0]!;
  return {
    host,
    tree,
    grid,
    rows: () => byType('RowCard').map((e) => e.props.r.key as string),
    heading: () => textOf(elements(tree()).find((e) => e.props?.['data-testid'] === 'list-heading')),
    pick(status: string | null) {
      grid().props.onPick(status);
      host.flush();
    },
  };
}

describe('the status buttons first, then the customers of the status picked', () => {
  it('"All" by default: every customer in the server\'s order; the buttons get the counts', () => {
    const p = mount(routeView());
    expect(p.grid().props).toMatchObject({ total: 6, active: null, lang: 'en' });
    expect(p.grid().props.buttons.map((b: { status: string; n: number }) => `${b.status}:${b.n}`)).toEqual(['DELIVERED:1', 'ON_THE_WAY:2', 'DELAYED:1', 'PARTLY_DELIVERED:1', 'NOT_DELIVERED:0', 'CANCELLED:1']);
    expect(p.heading()).toBe('All · 6');
    expect(p.rows()).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'o1']);
  });

  it('a tap shows that status only; a second tap (or All) shows every customer again', () => {
    const p = mount(routeView());
    p.pick('ON_THE_WAY');
    expect(p.grid().props.active).toBe('ON_THE_WAY');
    expect(p.heading()).toBe('On the way · 2');
    expect(p.rows()).toEqual(['d3', 'd5']);
    p.pick('DELAYED');
    expect(p.rows()).toEqual(['d4']);
    p.pick(null);
    expect(p.rows()).toHaveLength(6);
  });

  it('a refresh keeps the status picked; one emptied by it says "None."', () => {
    const p = mount(routeView());
    p.pick('DELAYED');
    const next = routeView('R1', { rows: routeView().rows.map((r) => (r.key === 'd4' ? { ...r, status: 'DELIVERED' as const, at: '11:40', eta: null, inMin: null } : r)) });
    p.host.render({ view: next });
    expect(p.grid().props.active).toBe('DELAYED');
    expect(p.rows()).toEqual([]);
    expect(textOf(elements(p.tree()).find((e) => e.props?.['data-testid'] === 'no-rows'))).toBe('None.');
  });

  it('nothing for the route yet; a route only "not planned yet" says so calmly over its list', () => {
    expect(textOf(elements(mount(routeView('R1', { rows: [] })).tree()).find((e) => e.props?.['data-testid'] === 'no-rows'))).toBe('Nothing for this route yet.');
    const notYet = mount(routeView('R1', { rows: [row({ key: 'o1', status: 'NOT_IN_PLAN', off: 'NOT_PLANNED_YET' })] }));
    expect(textOf(elements(notYet.tree()).find((e) => e.props?.['data-testid'] === 'not-planned-yet'))).toBe('Not planned yet - the plan is usually made the evening before. Check again later.');
    expect(notYet.rows()).toEqual(['o1']);
  });

  it('in Arabic and Urdu the same, in their words; a truck looked up shows its customers the same way, nothing of the truck', () => {
    expect(mount(routeView(), 'ar').heading()).toBe('الكل · 6');
    const ur = mount(routeView(), 'ur');
    ur.pick('CANCELLED');
    expect(ur.heading()).toBe('منسوخ · 1');
    const truck = mount({ ...routeView(), kind: 'TRUCK', code: '1234-AB', query: 'Truck 1234-AB' });
    expect(truck.tree().props['data-testid']).toBe('truck-view-1234-AB');
    expect(truck.rows()).toHaveLength(6);
    const names = elements(truck.tree()).map(typeName);
    for (const gone of ['TruckCard', 'MapCard', 'OffTruckList', 'SummaryBar']) expect(names).not.toContain(gone);
  });
});
