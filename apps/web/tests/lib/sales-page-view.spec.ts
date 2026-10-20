/**
 * One route on the salesman page (owner feedback of 20 Oct 2026: "first a list of statuses; when he clicks on
 * delivered he sees what is delivered, when he clicks on the way he sees what is on the way"): app/s/[token]/route-view.tsx
 * on the REAL component through the hook host (hook-host.ts). The status buttons come first; "All" is the default and
 * lists every customer in the server's order (by time); a tap shows that status only, a second tap all again; a
 * refresh keeps the status picked (also one shown only when it counts something: review of 20 Oct 2026). No truck,
 * trip or map anywhere. Tomorrow's link the evening before: "Planned", and each customer says the day. The page's
 * frame (sales-page.tsx, its hook replaced by a fixed state): the title in the language picked, the language switch
 * at the top right in every language. Invented data only (sales-page-fixture.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Host, elements, textOf, typeName } from './hook-host';
import { answer, lookup, routeView, row } from './sales-page-fixture';
import type { SalesRouteView } from '@/lib/sales-link/view-types';
import type { SalesViewState } from '@/app/s/[token]/use-sales-view';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));
const page = vi.hoisted(() => ({ state: null as unknown }));
vi.mock('@/app/s/[token]/use-sales-view', () => ({
  useSalesView: () => ({ state: page.state, submit: () => undefined, changeRoute: () => undefined, refresh: () => undefined, retry: () => undefined }),
}));

import { RouteView } from '@/app/s/[token]/route-view';
import { RowCard } from '@/app/s/[token]/row-card';
import { StatusGrid } from '@/app/s/[token]/status-grid';
import { Header, SalesPage } from '@/app/s/[token]/sales-page';

type Props = { view: SalesRouteView; lang: 'en' | 'ar' | 'ur'; future: boolean; date: string };
const plain = (s: string) => s.replace(/[⁦-⁩]/g, '');

function mount(view: SalesRouteView, lang: Props['lang'] = 'en', day: { future: boolean; date: string } = { future: false, date: '2026-10-19' }) {
  const host = new Host(RouteView as never, { view, lang, ...day } satisfies Props);
  host.render();
  const tree = () => host.tree;
  const byType = (name: string) => elements(tree()).filter((e) => typeName(e) === name);
  const grid = () => byType('StatusGrid')[0]!;
  return {
    host,
    tree,
    grid,
    rows: () => byType('RowCard').map((e) => e.props.r.key as string),
    /** The cards as they render (RowCard is a plain function of its props). */
    cards: () => byType('RowCard').map((e) => plain(textOf(RowCard(e.props)))),
    /** The status buttons as they render. */
    buttons: () => elements(StatusGrid(grid().props)).filter((e) => /^status-[A-Z_]+$/.test(e.props?.['data-testid'] ?? '')),
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

describe('review of 20 Oct 2026', () => {
  it('a status shown only when it counts something ("Not confirmed yet") stays, pressed with 0, when a refresh empties it', () => {
    const rows = [...routeView().rows, row({ key: 'd6', status: 'NOT_CONFIRMED' }), row({ key: 'd7', status: 'NOT_CONFIRMED' })];
    const p = mount(routeView('R1', { rows }));
    p.pick('NOT_CONFIRMED');
    expect(p.rows()).toEqual(['d6', 'd7']);
    // The driver records both results; the next refresh has them delivered.
    p.host.render({ view: routeView('R1', { rows: rows.map((r) => (r.status === 'NOT_CONFIRMED' ? { ...r, status: 'DELIVERED' as const, at: '11:40' } : r)) }) });
    expect(p.grid().props.active).toBe('NOT_CONFIRMED');
    expect(p.grid().props.buttons.map((b: { status: string; n: number }) => `${b.status}:${b.n}`)).toContain('NOT_CONFIRMED:0');
    const kept = p.buttons().find((e) => e.props['data-testid'] === 'status-NOT_CONFIRMED')!;
    expect(kept.props['aria-pressed']).toBe(true);
    expect(kept.props.disabled).toBe(false);
    expect(p.heading()).toBe('Not confirmed yet · 0');
    // Back to All: the empty button goes.
    p.pick(null);
    expect(p.grid().props.buttons.map((b: { status: string }) => b.status)).not.toContain('NOT_CONFIRMED');
  });

  it('tomorrow\'s link the evening before: "Planned" (button, heading, chip) and each customer says the day, in every language', () => {
    const tomorrow = { future: true, date: '2026-10-21' };
    const en = mount(routeView(), 'en', tomorrow);
    expect(en.buttons().map((e) => textOf(e))).toContain('2Planned');
    expect(en.buttons().map((e) => textOf(e)).join(' ')).not.toMatch(/On the way/);
    en.pick('ON_THE_WAY');
    expect(en.heading()).toBe('Planned · 2');
    expect(en.cards()).toEqual(['Customer CPlannedBeing delivered now Send to customer', 'Customer EPlannedWed 21 Oct, about 12:30 Send to customer']);
    expect(plain(textOf(RowCard({ lang: 'en', r: row({ key: 'x', customer: 'Customer X' }), rowKey: 'R1:x', ...tomorrow })))).toBe('Customer XPlannedOn Wed 21 Oct Send to customer');
    const ar = mount(routeView(), 'ar', tomorrow);
    ar.pick('ON_THE_WAY');
    expect(plain(ar.heading())).toBe('مجدول · 2');
    expect(ar.cards()[1]).toContain('يوم الأربعاء، 21 أكتوبر حوالي الساعة 12:30');
    const ur = mount(routeView(), 'ur', tomorrow);
    ur.pick('ON_THE_WAY');
    expect(plain(ur.heading())).toBe('پلان شدہ · 2');
    expect(ur.cards()[1]).toContain('بدھ، 21 اکتوبر کو تقریباً 12:30 بجے');
    // On the delivery day itself: "On the way" and the time with how far.
    const today = mount(routeView());
    today.pick('ON_THE_WAY');
    expect(today.heading()).toBe('On the way · 2');
    expect(today.cards()[1]).toBe('Customer EOn the wayabout 12:30 · in about 2 h Send to customer');
  });
});

describe("the page's frame (review of 20 Oct 2026)", () => {
  const state = (): SalesViewState => {
    const a = answer(lookup([routeView()]));
    return { phase: 'ready', meta: a.meta, linkCode: null, linkDate: null, lookup: a.lookup, notice: null, choices: [], formText: '', formError: null, working: false, waitSec: null, staleSince: null, serverError: false };
  };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('the title above the page in the language picked (WhatsApp shows it); the language switch at the top right in every language', () => {
    page.state = state();
    const doc = { title: 'RouteIQ - deliveries' };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', { language: 'en-GB' });
    const host = new Host(SalesPage as never, {});
    host.render();
    expect(doc.title).toBe('RouteIQ - Deliveries');
    expect(host.tree.props.dir).toBe('ltr');
    const header = () => elements(host.tree).find((e) => typeName(e) === 'Header')!;
    for (const [lang, title, dir] of [
      ['ar', 'RouteIQ - التوصيلات', 'rtl'],
      ['ur', 'RouteIQ - ڈیلیوریاں', 'rtl'],
      ['en', 'RouteIQ - Deliveries', 'ltr'],
    ] as const) {
      header().props.onLang(lang);
      host.flush();
      expect(doc.title, lang).toBe(title);
      expect(host.tree.props.dir, lang).toBe(dir);
      // The header's first row (the company and the switch) is left to right whatever the page's direction.
      const top = elements(Header(header().props)).find((e) => e.props?.['data-testid'] === 'header-top')!;
      expect(top.props.dir, lang).toBe('ltr');
      expect(elements(top).map(typeName), lang).toContain('LangSwitch');
      expect(elements(top).find((e) => e.type === 'p')!.props.dir, lang).toBe('auto');
    }
  });

  it("the phone's language first: an Arabic phone gets the Arabic title", () => {
    page.state = state();
    const doc = { title: '' };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', { language: 'ar-OM' });
    new Host(SalesPage as never, {}).render();
    expect(doc.title).toBe('RouteIQ - التوصيلات');
  });
});
