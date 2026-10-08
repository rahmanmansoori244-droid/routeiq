/**
 * The late order dialog's priority (review of 8 Oct 2026, ui-dispatch-1). It opened at "P1 -
 * highest" and always sent it, so a late order saved as it opened was planned as P1 whatever the
 * customer's own priority: under strict priority it beat any number of P2-P5 orders, and its re-plan
 * left a whole P2 order out to fit it (live repro: CC, a P5 customer, sent as P1 pushed out CA, P2).
 * Now the dialog opens at "Customer's own priority" and sends no priority for it (the late-order
 * route then uses the customer's own: `input.priority ?? customer.priority`, priorityFromFile false);
 * only a priority the dispatcher picks is sent.
 *
 * The REAL LateOrderDialog is driven through the hook host (hook-host.ts): only api() and the toasts
 * are replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Host, elements, textOf } from './hook-host';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));

const posts: { url: string; json: Record<string, unknown> }[] = [];
vi.mock('@/app/t/[slug]/dispatch/client-api', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    api: async (url: string, init: { json?: Record<string, unknown> } = {}) => {
      posts.push({ url, json: init.json ?? {} });
      return { ok: true, status: 200, data: { orderId: 'o9', replanNeeded: true, locationRequired: false, planId: 'run1' }, error: null, errorBody: null };
    },
  };
});
vi.mock('sonner', () => ({ toast: { success() {}, error() {}, warning() {}, info() {} } }));

import { LateOrderDialog } from '@/app/t/[slug]/dispatch/late-order-dialog';

beforeEach(() => {
  posts.length = 0;
});

function setup() {
  const host: Host<any> = new Host(LateOrderDialog as any, {
    open: true,
    date: '2026-10-09',
    depotId: 'd1',
    onSaved: () => {},
    onOpenChange: (v: boolean) => host.render({ open: v }),
  });
  host.render();
  const els = () => elements(host.tree);
  const byId = (id: string) => els().find((e) => e.props?.id === id);
  const byPlaceholder = (p: RegExp) => els().find((e) => typeof e.props?.placeholder === 'string' && p.test(e.props.placeholder));
  const type = (el: any, value: string) => {
    el.props.onChange({ target: { value } });
    host.flush();
  };
  /** What a dispatcher types for a phoned-in order, leaving Priority as it opens. */
  const fill = () => {
    type(byId('lo-code'), 'CC');
    type(byPlaceholder(/^Item code/), 'W500');
    type(byPlaceholder(/^Cases$/), '50');
    type(byId('lo-reason'), 'Customer phoned after cutoff');
  };
  const save = async () => {
    const btn = els().find((e) => textOf(e).trim() === 'Save late order' && typeof e.props?.onClick === 'function');
    await btn.props.onClick();
    await host.settle();
  };
  const prio = () => byId('lo-prio');
  return { host, fill, save, prio, type };
}

describe('LateOrderDialog: priority (ui-dispatch-1)', () => {
  it("opens at the customer's own priority, and an order saved that way sends no priority (before: P1, sent as 1)", async () => {
    const t = setup();
    expect(t.prio().props.value).toBe('');
    const options = elements(t.prio().props.children).filter((e) => e.type === 'option');
    expect(textOf(options[0])).toBe("Customer's own priority");
    expect(options.map((o) => String(o.props.value))).toEqual(['', '1', '2', '3', '4', '5']);
    t.fill();
    await t.save();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('/api/dispatch/late-order');
    expect(posts[0].json).toMatchObject({ date: '2026-10-09', depotId: 'd1', customerCode: 'CC', lines: [{ productCode: 'W500', cases: 50 }] });
    expect('priority' in posts[0].json).toBe(false);
  });

  it('a priority the dispatcher picks is sent; picking the first option again sends none', async () => {
    const t = setup();
    t.fill();
    t.type(t.prio(), '2');
    expect(t.prio().props.value).toBe(2);
    await t.save();
    expect(posts[0].json.priority).toBe(2);

    const u = setup();
    u.fill();
    u.type(u.prio(), '1');
    u.type(u.prio(), '');
    await u.save();
    expect('priority' in posts[1].json).toBe(false);
  });

  it('after a save the next late order opens at the customer\'s own priority again (the dialog stays mounted)', async () => {
    const t = setup();
    t.fill();
    t.type(t.prio(), '1');
    await t.save();
    expect(posts[0].json.priority).toBe(1);
    t.host.render({ open: true });
    expect(t.prio().props.value).toBe('');
    t.fill();
    await t.save();
    expect('priority' in posts[1].json).toBe(false);
  });
});
