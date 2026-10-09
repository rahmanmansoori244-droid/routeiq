/**
 * The Add product dialog and the "0 kg per case = unknown" rule (weights.ts; review of 8 Oct 2026,
 * ui-rest-6). The dialog opened at 12 kg per case and 15 L, required: a product saved with only its
 * code and name got a made-up weight, so the day screen's "No weight" list left it out and Optimize
 * never asked for it (WEIGHT_REQUIRED), while every other way a product is made (file intake, late
 * order, import) starts at 0 = unknown. Now both fields start empty ("unknown"), and an empty field
 * is sent as 0. Edit shows a stored 0 as empty too, never as a weight of 0.
 *
 * Review of da76343: Edit of a product that HAS a case weight keeps the field required, so emptying
 * it no longer saves 0 (unknown) by accident; clearing it is its own choice ("Weight not known",
 * sent as clearWeight, which PATCH /api/products/[id] needs - product-code-routes.spec.ts).
 *
 * The REAL ProductFormDialog is driven through the hook host (hook-host.ts): only fetch and the
 * toasts are replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Host, elements } from './hook-host';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));
vi.mock('sonner', () => ({ toast: { success() {}, error() {}, warning() {}, info() {} } }));

import { ProductFormDialog, type ProductRow } from '@/app/t/[slug]/products/product-form';

const bodies: { url: string; method: string; body: Record<string, unknown> }[] = [];
beforeEach(() => {
  bodies.length = 0;
  vi.stubGlobal('fetch', async (url: string, init: { method: string; body: string }) => {
    bodies.push({ url, method: init.method, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ data: { id: 'p1' } }), { status: 201 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(mode: 'create' | 'edit', product?: ProductRow) {
  const host: Host<any> = new Host(ProductFormDialog as any, { open: true, mode, product, onOpenChange: () => {}, onSaved: () => {} });
  host.render();
  const field = (id: string) => elements(host.tree).find((e) => e.props?.id === id);
  const type = (id: string, value: string) => {
    field(id).props.onChange({ target: { value } });
    host.flush();
  };
  const tick = (id: string, checked: boolean) => {
    field(id).props.onChange({ target: { checked } });
    host.flush();
  };
  const submit = async () => {
    elements(host.tree).find((e) => e.type === 'form').props.onSubmit({ preventDefault() {} });
    await host.settle();
  };
  return { field, type, tick, submit };
}

describe('ProductFormDialog: weight and volume start unknown (ui-rest-6)', () => {
  it('Add product: weight and volume open empty with "unknown", and are not required', () => {
    const t = setup('create');
    for (const id of ['weightPerCaseKg', 'volumePerCaseL']) {
      // Before: "12" and "15", required.
      expect(t.field(id).props.value, id).toBe('');
      expect(t.field(id).props.placeholder, id).toBe('unknown');
      expect(t.field(id).props.required, id).toBeFalsy();
    }
  });

  it('a product saved with only its code and name is sent with 0 kg and 0 L (unknown), not 12 kg / 15 L', async () => {
    const t = setup('create');
    t.type('code', 'SS5GB NRB');
    t.type('name', '5 gallon bottle');
    await t.submit();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ url: '/api/products', method: 'POST' });
    expect(bodies[0].body).toMatchObject({ code: 'SS5GB NRB', name: '5 gallon bottle', weightPerCaseKg: 0, volumePerCaseL: 0, casesPerPallet: null, active: true });
  });

  it('a weight typed in is sent as typed', async () => {
    const t = setup('create');
    t.type('code', 'SS5GB');
    t.type('name', '5 gallon');
    t.type('weightPerCaseKg', '19.2');
    await t.submit();
    expect(bodies[0].body).toMatchObject({ weightPerCaseKg: 19.2, volumePerCaseL: 0 });
  });

  it('Edit: a stored 0 (unknown) shows empty with "unknown" and is saved as 0 again; a known weight shows as it is', async () => {
    const unknown: ProductRow = { id: 'p1', code: 'JA1.5L(6)', name: 'Jabal 1.5L', weightPerCaseKg: 0, volumePerCaseL: 0, casesPerPallet: null, active: true };
    const t = setup('edit', unknown);
    expect(t.field('weightPerCaseKg').props.value).toBe('');
    expect(t.field('volumePerCaseL').props.value).toBe('');
    t.type('name', 'Jabal 1.5L x6');
    await t.submit();
    expect(bodies[0]).toMatchObject({ url: '/api/products/p1', method: 'PATCH' });
    expect(bodies[0].body).toMatchObject({ name: 'Jabal 1.5L x6', weightPerCaseKg: 0, volumePerCaseL: 0 });

    const known = setup('edit', { ...unknown, weightPerCaseKg: 9.6, volumePerCaseL: 9 });
    expect(known.field('weightPerCaseKg').props.value).toBe('9.6');
    expect(known.field('volumePerCaseL').props.value).toBe('9');
  });
});

describe('ProductFormDialog: a known case weight is never cleared by accident (review of da76343)', () => {
  // A product with a case weight. Before: the field was not required on Edit, so emptying it saved
  // 0 (unknown) with no warning; with payload 0 on every truck OPTIMIZE never asks for it again.
  const weighed: ProductRow = { id: 'p1', code: 'JA1.5L(6)', name: 'Jabal 1.5L', weightPerCaseKg: 9.6, volumePerCaseL: 9, casesPerPallet: 84, active: true };

  it('Edit: the weight is required (at least 0.01 kg) and "Weight not known" is offered; not for a product without a weight', () => {
    const t = setup('edit', weighed);
    expect(t.field('weightPerCaseKg').props.required).toBe(true);
    expect(t.field('weightPerCaseKg').props.min).toBe('0.01');
    expect(t.field('clearWeight').props.checked).toBe(false);
    // A product without a weight: as before (empty, not required, no "Weight not known").
    const none = setup('edit', { ...weighed, weightPerCaseKg: 0 });
    expect(none.field('weightPerCaseKg').props.required).toBeFalsy();
    expect(none.field('weightPerCaseKg').props.min).toBe('0');
    expect(none.field('clearWeight')).toBeUndefined();
    // Add product: unchanged (not required).
    expect(setup('create').field('weightPerCaseKg').props.required).toBeFalsy();
  });

  it('the weight emptied or typed as 0, then Save: nothing is sent (before: PATCH with weightPerCaseKg 0)', async () => {
    for (const typed of ['', '0']) {
      bodies.length = 0;
      const t = setup('edit', weighed);
      t.type('weightPerCaseKg', typed);
      await t.submit();
      expect(bodies, JSON.stringify(typed)).toEqual([]);
    }
  });

  it('"Weight not known" ticked: the field is emptied and off, and Save sends 0 with clearWeight; unticked, the weight is back', async () => {
    const t = setup('edit', weighed);
    t.tick('clearWeight', true);
    expect(t.field('weightPerCaseKg').props).toMatchObject({ value: '', disabled: true, required: false, min: '0' });
    await t.submit();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ url: '/api/products/p1', method: 'PATCH', body: { weightPerCaseKg: 0, clearWeight: true } });

    const again = setup('edit', weighed);
    again.tick('clearWeight', true);
    again.tick('clearWeight', false);
    expect(again.field('weightPerCaseKg').props).toMatchObject({ value: '9.6', disabled: false, required: true });
  });

  it('a corrected weight is sent as typed, without clearWeight (the control)', async () => {
    const t = setup('edit', weighed);
    t.type('weightPerCaseKg', '9.2');
    await t.submit();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].body).toMatchObject({ weightPerCaseKg: 9.2 });
    expect('clearWeight' in bodies[0].body).toBe(false);
  });
});
