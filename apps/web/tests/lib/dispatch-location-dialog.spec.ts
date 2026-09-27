/**
 * Audit F06 (27 Sep 2026): the ADD LOCATION dialog must never save one customer's point onto
 * another. The request guard (location-requests.ts) is checked on its own, then the REAL
 * LocationDialog is driven through the hook host (hook-host.ts): only api(), the toasts and the map
 * are replaced. The scenarios are the verifiers' (.dev/audit-verify/ui-v1 and ui-v2, f06-*):
 *
 *  1. Read for A (a slow short link), Cancel, open B, A answers: B's dialog showed A's point and
 *     Save wrote it onto B.
 *  2. The Enter key started a Read while one was running (the Read button was disabled, Enter was
 *     not), so A's late answer replaced B's own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Host, deferred, elements, textOf, typeName } from './hook-host';
import { createLocationRequests } from '@/app/t/[slug]/dispatch/location-requests';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));

interface Call {
  url: string;
  init: { method?: string; json?: any; signal?: AbortSignal };
  resolve: (v: unknown) => void;
}
const calls: Call[] = [];
vi.mock('@/app/t/[slug]/dispatch/client-api', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, api: (url: string, init: Call['init']) => new Promise((resolve) => calls.push({ url, init, resolve })) };
});
const toasts: string[] = [];
vi.mock('sonner', () => ({
  toast: {
    success: (m: string) => toasts.push(`success: ${m}`),
    error: (m: string) => toasts.push(`error: ${m}`),
    warning: (m: string) => toasts.push(`warning: ${m}`),
    info: (m: string) => toasts.push(`info: ${m}`),
  },
}));
vi.mock('next/dynamic', () => ({ default: () => function PinMapStub() { return null; } }));

import { LocationDialog } from '@/app/t/[slug]/dispatch/location-dialog';

const A = { customerId: 'cust-A', code: 'A001', branchCode: null, name: 'Customer A (Seeb)', lat: null, lng: null };
const B = { customerId: 'cust-B', code: 'B001', branchCode: null, name: 'Customer B (Barka)', lat: null, lng: null };
const B_PINNED = { ...B, lat: 23.6786, lng: 57.8859 };
const A_LINK = 'https://maps.app.goo.gl/AAAAshortA';
const ok = (data: unknown) => ({ ok: true, status: 200, data, error: null, errorBody: null });
const parsed = (lat: number, lng: number, source = 'GOOGLE_MAPS_URL') => ok({ ok: true, lat, lng, source, confidence: 'HIGH', needsPin: false, warnings: [] });

beforeEach(() => {
  calls.length = 0;
  toasts.length = 0;
});

function setup() {
  const saved = vi.fn();
  const host: Host<any> = new Host(LocationDialog as any, {
    open: false,
    customer: null,
    depot: { lat: 23.58, lng: 58.4 },
    onSaved: saved,
    onOpenChange: (v: boolean) => host.render({ open: v }),
  });
  host.render();
  const els = () => elements(host.tree);
  const input = () => els().find((e) => e.props?.id === 'loc-input');
  // The Read button (found by its variant too, so the control below also runs on the code before the fix).
  const readBtn = () => els().find((e) => e.props?.['data-testid'] === 'read-location' || (typeName(e) === 'Button' && e.props?.variant === 'secondary'));
  const saveBtn = () => els().find((e) => e.props?.['data-testid'] === 'save-location');
  const cancelBtn = () => els().find((e) => typeName(e) === 'Button' && textOf(e).trim() === 'Cancel');
  const pinText = () => textOf(els().find((e) => e.type === 'p' && /Pin:|Click the map/.test(textOf(e))));
  const found = () => textOf(els().find((e) => e.type === 'p' && textOf(e).startsWith('Found')) ?? null);
  const type = (v: string) => {
    input().props.onChange({ target: { value: v } });
    host.flush();
  };
  const enter = () => {
    void input().props.onKeyDown({ key: 'Enter', preventDefault() {} });
    host.flush();
  };
  const read = () => {
    void readBtn().props.onClick();
    host.flush();
  };
  const save = () => {
    void saveBtn().props.onClick();
    host.flush();
  };
  const openFor = (customer: unknown) => host.render({ open: true, customer });
  const cancel = () => cancelBtn().props.onClick();
  const puts = () => calls.filter((c) => c.init.method === 'PUT');
  return { host, input, readBtn, saveBtn, pinText, found, type, enter, read, save, openFor, cancel, puts, saved };
}

describe('the request guard (location-requests.ts)', () => {
  it('an answer after the dialog changed (closed, reopened, another customer) is dropped, and the Read aborted', () => {
    const g = createLocationRequests();
    const r = g.beginRead()!;
    g.dialogChanged();
    expect(r.signal.aborted).toBe(true);
    expect(g.answered(r.ticket)).toBe(false);
    // The new dialog is not blocked by the old Read.
    expect(g.busy()).toBe(false);
    const r2 = g.beginRead()!;
    expect(g.answered(r2.ticket)).toBe(true);
  });

  it('one request at a time: no Read while a Read or a Save runs (the Enter key included)', () => {
    const g = createLocationRequests();
    const r = g.beginRead()!;
    expect(g.beginRead()).toBeNull();
    expect(g.beginSave()).toBeNull();
    expect(g.answered(r.ticket)).toBe(true);
    const s = g.beginSave()!;
    expect(g.beginRead()).toBeNull();
    expect(g.answered(s)).toBe(true);
    expect(g.beginRead()).not.toBeNull();
  });

  it('other text or a hand-dropped pin makes a running Read out of date, not a running Save', () => {
    const g = createLocationRequests();
    const r = g.beginRead()!;
    g.inputChanged();
    expect(r.signal.aborted).toBe(true);
    expect(g.answered(r.ticket)).toBe(false);
    const s = g.beginSave()!;
    g.inputChanged();
    expect(g.busy()).toBe(true);
    expect(g.answered(s)).toBe(true);
    // A Save is out of date only when the dialog changed.
    const s2 = g.beginSave()!;
    g.dialogChanged();
    expect(g.answered(s2)).toBe(false);
  });
});

describe('LocationDialog (audit F06)', () => {
  it("scenario 1: A's late answer never reaches B's dialog, and Save cannot write A's point onto B", async () => {
    const t = setup();
    t.openFor(A);
    t.type(A_LINK);
    t.read();
    expect(calls.map((c) => c.url)).toEqual(['/api/locations/parse']);
    t.cancel();
    t.openFor(B);
    calls[0].resolve(parsed(23.6703, 58.1889));
    await t.host.settle();
    // Before: "Found 23.670300, 58.188900", "Pin: 23.670300, 58.188900" and Save enabled on B.
    expect(t.found()).toBe('');
    expect(t.pinText()).toContain('Click the map');
    expect(t.saveBtn().props.disabled).toBe(true);
    expect(calls[0].init.signal?.aborted).toBe(true);
    t.save();
    expect(t.puts()).toEqual([]);
  });

  it("scenario 1 with B already located: B keeps its own pin and Save writes B's point", async () => {
    const t = setup();
    t.openFor(A);
    t.type(A_LINK);
    t.read();
    t.cancel();
    t.openFor(B_PINNED);
    calls[0].resolve(parsed(23.6703, 58.1889));
    await t.host.settle();
    expect(t.pinText()).toContain('23.678600, 57.885900');
    t.save();
    expect(t.puts()).toHaveLength(1);
    expect(t.puts()[0].url).toBe('/api/customers/cust-B/location');
    expect(t.puts()[0].init.json).toMatchObject({ lat: 23.6786, lng: 57.8859 });
  });

  it('the Enter key starts no second Read while one is running', () => {
    const t = setup();
    t.openFor(A);
    t.type(A_LINK);
    t.read();
    expect(t.readBtn().props.disabled).toBe(true);
    t.enter();
    t.enter();
    // Before: every Enter sent another request.
    expect(calls).toHaveLength(1);
  });

  it("scenario 2: B's own answer is kept when A's slow one arrives last (Enter on B)", async () => {
    const t = setup();
    t.openFor(A);
    t.type(A_LINK);
    t.read();
    t.cancel();
    t.openFor(B);
    t.type('23.6786, 57.8859');
    t.enter(); // B's own Read (the dialog's old Read belongs to A and does not block it)
    expect(calls.map((c) => c.url)).toEqual(['/api/locations/parse', '/api/locations/parse']);
    calls[1].resolve(parsed(23.6786, 57.8859, 'MANUAL_LATLNG'));
    await t.host.settle();
    calls[0].resolve(parsed(23.6703, 58.1889));
    await t.host.settle();
    // Before: A's point replaced B's, and Save sent it with B's text.
    expect(t.pinText()).toContain('23.678600, 57.885900');
    expect(t.found()).toContain('23.678600, 57.885900');
    t.save();
    expect(t.puts()[0].url).toBe('/api/customers/cust-B/location');
    expect(t.puts()[0].init.json).toMatchObject({ lat: 23.6786, lng: 57.8859, source: 'MANUAL_LATLNG', input: '23.6786, 57.8859' });
  });

  it('text changed while reading: the old answer is dropped; Save sends the text the point was read from', async () => {
    const t = setup();
    t.openFor(A);
    t.type(A_LINK);
    t.read();
    t.type('23.6100, 58.4100');
    expect(calls[0].init.signal?.aborted).toBe(true);
    expect(t.readBtn().props.disabled).toBe(false);
    calls[0].resolve(parsed(23.6703, 58.1889));
    await t.host.settle();
    expect(t.found()).toBe('');
    t.read();
    calls[1].resolve(parsed(23.61, 58.41, 'MANUAL_LATLNG'));
    await t.host.settle();
    t.type('something typed after the Read');
    t.save();
    expect(t.puts()[0].init.json).toMatchObject({ lat: 23.61, lng: 58.41, source: 'MANUAL_LATLNG', input: '23.6100, 58.4100' });
  });

  it("a Save answer for A after B was opened: reported for A, B's dialog stays open and unchanged", async () => {
    const t = setup();
    t.openFor(A);
    t.type('23.6703, 58.1889');
    t.read();
    calls[0].resolve(parsed(23.6703, 58.1889, 'MANUAL_LATLNG'));
    await t.host.settle();
    t.save();
    expect(t.puts()[0].url).toBe('/api/customers/cust-A/location');
    t.cancel();
    t.openFor(B_PINNED);
    t.puts()[0].resolve({ ok: false, status: 422, data: null, error: 'outside', errorBody: { code: 'OUTSIDE_AREA' } });
    await t.host.settle();
    // Before: B's Save turned into "Confirm & save", sending confirmOutsideArea for B's point.
    expect(textOf(t.saveBtn())).toBe('Save location');
    expect(t.host.props.open).toBe(true);
    expect(toasts.at(-1)).toMatch(/^warning: The location of Customer A \(Seeb\) was not saved/);
    // A successful late Save: the day is refreshed, B's dialog is not closed.
    t.save();
    const bSave = t.puts()[1];
    expect(bSave.url).toBe('/api/customers/cust-B/location');
    t.cancel();
    t.openFor(A);
    bSave.resolve(ok({ id: 'cust-B' }));
    await t.host.settle();
    expect(t.saved).toHaveBeenCalledTimes(1);
    expect(t.host.props.open).toBe(true);
    expect(toasts.at(-1)).toBe('success: Location saved for Customer B (Barka).');
  });

  it('control: a normal Read and Save goes to the customer the dialog is open for', async () => {
    const t = setup();
    t.openFor(A);
    t.type(A_LINK);
    t.read();
    calls[0].resolve(parsed(23.6703, 58.1889));
    await t.host.settle();
    expect(t.found()).toContain('23.670300, 58.188900');
    t.save();
    expect(t.puts()[0].url).toBe('/api/customers/cust-A/location');
    expect(t.puts()[0].init.json).toMatchObject({ lat: 23.6703, lng: 58.1889, source: 'GOOGLE_MAPS_URL', input: A_LINK });
    t.puts()[0].resolve(ok({ id: 'cust-A' }));
    await t.host.settle();
    expect(t.host.props.open).toBe(false);
    expect(t.saved).toHaveBeenCalledTimes(1);
  });
});
