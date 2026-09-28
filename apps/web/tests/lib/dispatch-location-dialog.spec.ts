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
 *  3. (A2 review, .dev/scratch-a2-v1/ui-v1/a2-residual.spec.tsx) Read text A, replace it by text B
 *     and Save without reading again: the green "Found A" box stayed next to B and Save stored A's
 *     point. Text never read did the same with the pin already on the map.
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
// An exact saved point (a HIGH import, not confirmed yet): it can be saved again as it is.
const B_PINNED = { ...B, lat: 23.6786, lng: 57.8859, locationVerified: false, geocodeConfidence: 'HIGH' };
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
  const previewBox = () => els().find((e) => e.props?.['data-testid'] === 'location-preview');
  const unreadNote = () => textOf(els().find((e) => e.props?.['data-testid'] === 'location-text-unread') ?? null);
  // The dispatcher dropping or moving the pin on the map (PinMap is the stub below).
  const dropPin = (lat: number, lng: number) => {
    els().find((e) => typeName(e) === 'PinMapStub').props.onChange(lat, lng);
    host.flush();
  };
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
  return { host, input, readBtn, saveBtn, pinText, found, previewBox, unreadNote, dropPin, type, enter, read, save, openFor, cancel, puts, saved };
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

  it("text changed while reading: the old answer is dropped; Save sends the new text's point and text", async () => {
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
    t.save();
    expect(t.puts()[0].init.json).toMatchObject({ lat: 23.61, lng: 58.41, source: 'MANUAL_LATLNG', input: '23.6100, 58.4100' });
  });

  it('scenario 3: text changed after a Read - the preview is out of date and Save waits for a Read of the new text', async () => {
    const t = setup();
    t.openFor(A);
    t.type('23.600100, 58.400200');
    t.read();
    calls[0].resolve(parsed(23.6001, 58.4002, 'MANUAL_LATLNG'));
    await t.host.settle();
    expect(t.previewBox().props['data-out-of-date']).toBeUndefined();
    expect(t.saveBtn().props.disabled).toBe(false);
    t.type('23.700300, 58.500400');
    // Before: the green "Found 23.600100, 58.400200" box stayed, Save was on and stored that point.
    expect(t.previewBox().props['data-out-of-date']).toBe(true);
    expect(t.previewBox().props.className).not.toContain('green');
    expect(t.unreadNote()).toMatch(/^Text changed - press Read/);
    expect(t.saveBtn().props.disabled).toBe(true);
    t.save();
    expect(t.puts()).toEqual([]);
    // The text the point was read from, back in the box: the preview is current again.
    t.type(' 23.600100, 58.400200 ');
    expect(t.previewBox().props['data-out-of-date']).toBeUndefined();
    expect(t.unreadNote()).toBe('');
    expect(t.saveBtn().props.disabled).toBe(false);
    // Emptied after a Read: out of date too (Read is off for an empty box).
    t.type('');
    expect(t.saveBtn().props.disabled).toBe(true);
    expect(t.unreadNote()).toMatch(/^Text cleared/);
    // The new text read: its point is the one saved, with its text.
    t.type('23.700300, 58.500400');
    t.read();
    // While that Read runs: still out of date and Save off, but no "press Read".
    expect(t.saveBtn().props.disabled).toBe(true);
    expect(t.previewBox().props['data-out-of-date']).toBe(true);
    expect(t.unreadNote()).toBe('');
    calls[1].resolve(parsed(23.7003, 58.5004, 'MANUAL_LATLNG'));
    await t.host.settle();
    expect(t.found()).toContain('23.700300, 58.500400');
    expect(t.previewBox().props['data-out-of-date']).toBeUndefined();
    expect(t.saveBtn().props.disabled).toBe(false);
    t.save();
    expect(t.puts()).toHaveLength(1);
    expect(t.puts()[0].init.json).toMatchObject({ lat: 23.7003, lng: 58.5004, source: 'MANUAL_LATLNG', input: '23.700300, 58.500400' });
  });

  it('scenario 3: a Read of the new text that fails leaves Save off (the earlier point is not saved instead)', async () => {
    const t = setup();
    t.openFor(A);
    t.type(A_LINK);
    t.read();
    calls[0].resolve(parsed(23.6703, 58.1889));
    await t.host.settle();
    t.type('https://maps.app.goo.gl/BBBBshortB');
    t.read();
    calls[1].resolve({ ok: false, status: 502, data: null, error: 'Could not open that link.', errorBody: null });
    await t.host.settle();
    expect(toasts.at(-1)).toBe('error: Could not open that link.');
    expect(t.previewBox().props['data-out-of-date']).toBe(true);
    expect(t.saveBtn().props.disabled).toBe(true);
    t.save();
    expect(t.puts()).toEqual([]);
  });

  it("scenario 3 without a Read: text typed but never read does not save the customer's old pin under it", () => {
    const t = setup();
    t.openFor(B_PINNED);
    // Nothing typed: the pin already on the map can be confirmed as it is (no input text sent).
    expect(t.saveBtn().props.disabled).toBe(false);
    expect(t.unreadNote()).toBe('');
    t.type('23.700300, 58.500400');
    // Before: Save was on and sent B's old pin as MAP_PIN with this unread text as its input.
    expect(t.saveBtn().props.disabled).toBe(true);
    expect(t.unreadNote()).toMatch(/^Press Read/);
    t.save();
    expect(t.puts()).toEqual([]);
    t.type('');
    t.save();
    expect(t.puts()).toHaveLength(1);
    expect(t.puts()[0].init.json).toMatchObject({ lat: 23.6786, lng: 57.8859, source: 'MAP_PIN' });
    expect(t.puts()[0].init.json.input).toBeUndefined();
  });

  it('a pin dropped by hand is still saved after the text changed, with the text it was read from (never unread text)', async () => {
    const t = setup();
    t.openFor(A);
    t.type(A_LINK);
    t.read();
    calls[0].resolve(parsed(23.6703, 58.1889));
    await t.host.settle();
    t.type('https://maps.app.goo.gl/BBBBshortB');
    expect(t.saveBtn().props.disabled).toBe(true);
    t.dropPin(23.6711, 58.1899);
    expect(t.saveBtn().props.disabled).toBe(false);
    expect(t.unreadNote()).toMatch(/Save keeps the pin you set on the map/);
    t.save();
    expect(t.puts()[0].init.json).toMatchObject({ lat: 23.6711, lng: 58.1899, source: 'MAP_PIN', input: A_LINK });

    // Nothing read at all: a hand pin is saved as a map pin, not under text nobody read.
    const u = setup();
    u.openFor(B);
    u.type('https://maps.app.goo.gl/CCCCshortC');
    u.dropPin(23.68, 57.89);
    expect(u.saveBtn().props.disabled).toBe(false);
    u.save();
    const put = u.puts().at(-1)!;
    expect(put.url).toBe('/api/customers/cust-B/location');
    expect(put.init.json).toMatchObject({ lat: 23.68, lng: 57.89, source: 'MAP_PIN' });
    // Before: the unread link was stored as the location's input.
    expect(put.init.json.input).toBeUndefined();
  });

  it('"Confirm & save" confirms only the point it was asked for: a new Read or a hand pin asks again', async () => {
    const t = setup();
    t.openFor(A);
    t.type('19.0760, 72.8777');
    t.read();
    calls[0].resolve(parsed(19.076, 72.8777, 'MANUAL_LATLNG'));
    await t.host.settle();
    t.save();
    t.puts()[0].resolve({ ok: false, status: 422, data: null, error: 'outside', errorBody: { code: 'OUTSIDE_AREA' } });
    await t.host.settle();
    expect(textOf(t.saveBtn())).toBe('Confirm & save');
    // Another point read: the confirmation was for the earlier one.
    t.type('24.8607, 67.0011');
    t.read();
    calls[2].resolve(parsed(24.8607, 67.0011, 'MANUAL_LATLNG'));
    await t.host.settle();
    // Before: still "Confirm & save", and Save sent confirmOutsideArea for the new point unasked.
    expect(textOf(t.saveBtn())).toBe('Save location');
    t.save();
    expect(t.puts()[1].init.json.confirmOutsideArea).toBeUndefined();
    t.puts()[1].resolve({ ok: false, status: 422, data: null, error: 'outside', errorBody: { code: 'OUTSIDE_AREA' } });
    await t.host.settle();
    expect(textOf(t.saveBtn())).toBe('Confirm & save');
    t.dropPin(24.87, 67.01);
    expect(textOf(t.saveBtn())).toBe('Save location');
    t.save();
    expect(t.puts()[2].init.json).toMatchObject({ lat: 24.87, lng: 67.01, source: 'MAP_PIN' });
    expect(t.puts()[2].init.json.confirmOutsideArea).toBeUndefined();
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

describe("LocationDialog: the owner's location rule (audit PR A5)", () => {
  const notExact = (lat: number, lng: number, confidence: 'MEDIUM' | 'LOW', warning: string, extra: Record<string, unknown> = {}) =>
    ok({ ok: true, lat, lng, source: 'GOOGLE_MAPS_URL', confidence, needsPin: true, warnings: [warning], ...extra });
  const pinRequired = (t: ReturnType<typeof setup>) => textOf(elements(t.host.tree).find((e) => e.props?.['data-testid'] === 'location-pin-required') ?? null);

  it.each([
    ['LOW (whole degrees)', 'LOW', "23°N 58°E"],
    ['MEDIUM (fewer than 4 decimals)', 'MEDIUM', '23.58, 58.40'],
    ['MEDIUM (map centre only)', 'MEDIUM', 'https://www.google.com/maps/@23.5859,58.4059,17z'],
  ] as const)('a reading that is not exact, %s: Save stays off until the pin is placed by hand', async (_what, confidence, text) => {
    const t = setup();
    t.openFor(A);
    t.type(text);
    t.read();
    calls[0].resolve(notExact(23.58, 58.4, confidence, 'Confirm the pin.'));
    await t.host.settle();
    expect(t.found()).toContain('23.580000, 58.400000');
    // Before: Save was on and stored the reading as read (source GOOGLE_MAPS_URL), marked verified.
    expect(t.saveBtn().props.disabled).toBe(true);
    expect(pinRequired(t)).toBe("This reading is not exact. Drop the pin on the customer's exact location, then save.");
    t.save();
    expect(t.puts()).toEqual([]);
    // The dispatcher drops the pin on the customer: that point is saved, as a hand pin, with the text it came from.
    t.dropPin(23.581234, 58.401234);
    expect(pinRequired(t)).toBe('');
    expect(t.saveBtn().props.disabled).toBe(false);
    t.save();
    expect(t.puts()).toHaveLength(1);
    expect(t.puts()[0].init.json).toMatchObject({ lat: 23.581234, lng: 58.401234, source: 'MAP_PIN', input: text });
  });

  it('a reading that could not be read also needs a hand pin', async () => {
    const t = setup();
    t.openFor(B_PINNED);
    t.type('https://www.google.com/maps/place/Lulu+Hypermarket');
    t.read();
    calls[0].resolve(ok({ ok: false, needsPin: true, warnings: [], error: 'This Google Maps link does not contain coordinates (it only names a place). Drop a pin on the map instead.' }));
    await t.host.settle();
    expect(t.saveBtn().props.disabled).toBe(true);
    expect(pinRequired(t)).toBe("This could not be read. Drop the pin on the customer's exact location, then save.");
    t.dropPin(23.6787, 57.886);
    expect(t.saveBtn().props.disabled).toBe(false);
  });

  it.each([
    ['a MEDIUM import', { locationVerified: false, geocodeConfidence: 'MEDIUM' }],
    ['a LOW reading', { locationVerified: false, geocodeConfidence: 'LOW' }],
    ['a point of unknown quality', { locationVerified: false, geocodeConfidence: null }],
    ['labelled HIGH but with 2 decimals (stored before the rule)', { locationVerified: false, geocodeConfidence: 'HIGH', lat: 23.68, lng: 57.89 }],
  ])("the customer's saved pin is not saved again as it is when it is not exact (%s)", (_what, quality) => {
    const t = setup();
    const c = { ...B_PINNED, ...quality };
    t.openFor(c);
    expect(t.pinText()).toContain(`${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`);
    // Before: Save stored this point as a hand pin, verified HIGH, although nobody placed it.
    expect(t.saveBtn().props.disabled).toBe(true);
    expect(pinRequired(t)).toBe("This saved location is not exact. Drop the pin on the customer's exact location, then save.");
    t.save();
    expect(t.puts()).toEqual([]);
    t.dropPin(23.6788, 57.8861);
    expect(t.saveBtn().props.disabled).toBe(false);
    t.save();
    expect(t.puts()[0].init.json).toMatchObject({ lat: 23.6788, lng: 57.8861, source: 'MAP_PIN' });
  });

  it.each([
    ['HIGH, not confirmed yet', { locationVerified: false, geocodeConfidence: 'HIGH' }],
    ['confirmed by a dispatcher', { locationVerified: true, geocodeConfidence: 'HIGH' }],
  ])("control: an exact saved pin (%s) can be saved again as it is", (_what, quality) => {
    const t = setup();
    t.openFor({ ...B_PINNED, ...quality });
    expect(t.saveBtn().props.disabled).toBe(false);
    expect(pinRequired(t)).toBe('');
  });

  it('Save sends the address a short link led to at the Read, so the server reads the same text again without opening it', async () => {
    const t = setup();
    t.openFor(A);
    t.type(A_LINK);
    t.read();
    const resolvedUrl = 'https://www.google.com/maps/place/A/data=!3d23.6703!4d58.1889';
    calls[0].resolve(ok({ ok: true, lat: 23.6703, lng: 58.1889, source: 'GOOGLE_MAPS_URL', confidence: 'HIGH', needsPin: false, warnings: [], resolvedUrl }));
    await t.host.settle();
    t.save();
    expect(t.puts()[0].init.json).toMatchObject({ lat: 23.6703, lng: 58.1889, source: 'GOOGLE_MAPS_URL', input: A_LINK, resolvedUrl });
    // A hand pin with no Read sends neither text nor address.
    const u = setup();
    u.openFor(B);
    u.dropPin(23.68, 57.89);
    u.save();
    expect(u.puts().at(-1)!.init.json.resolvedUrl).toBeUndefined();
  });
});
