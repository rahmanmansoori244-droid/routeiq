/**
 * Audit F07 (27 Sep 2026, owner decision 9): the day screen's Details dialog must not turn broken
 * input into planning values, and must not confirm what nobody changed.
 *
 *  - "06:90" became 07:30 (the dialog's own lax parser); now the shared strict parseHhmm refuses it.
 *  - "10 min", "ten" or a blank unloading box became 0 minutes (`Number(service) || 0`) and was
 *    marked confirmed; now whole minutes only, blank = the customer-type or Settings default (not
 *    confirmed), an explicit 0 still allowed.
 *  - Every Save sent the priority and unloading time as shown, defaults included, and the server
 *    marked both confirmed; now only the fields the dispatcher changed are sent.
 *
 * The pure form helpers (customer-details.ts), the REAL CustomerDialog through the hook host
 * (hook-host.ts; only api() and the toasts replaced), and PATCH /api/customers/:id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Host, elements, textOf, typeName } from './hook-host';
import { detailsFormOf, detailsPatch, parseServiceMinutes, windowText, type DetailsCustomer } from '@/app/t/[slug]/dispatch/customer-details';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));

interface Call {
  url: string;
  init: { method?: string; json?: any };
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

// PATCH /api/customers/:id around an in-memory customer.
const route = vi.hoisted(() => ({ before: {} as Record<string, any>, updates: [] as Record<string, unknown>[] }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'PLANNER', name: 'P', email: 'p@a.example' } })) }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/dispatch/open-orders', () => ({ openOrders: vi.fn(async () => ({})), deactivateWarning: vi.fn(() => null) }));
vi.mock('@/lib/tenant', () => ({
  tenantDb: () => ({
    customer: {
      findUnique: vi.fn(async () => ({ ...route.before })),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        route.updates.push(data);
        return { ...route.before, ...data };
      }),
    },
    region: { findUnique: vi.fn(async () => null) },
  }),
}));

import { CustomerDialog } from '@/app/t/[slug]/dispatch/customer-dialog';
import { PATCH } from '@/app/api/customers/[id]/route';

beforeEach(() => {
  calls.length = 0;
  toasts.length = 0;
});

/** A customer as the day overview sends it: priority P3 and 15 min unloading are defaults nobody confirmed. */
const UNCONFIRMED = {
  customerId: 'c1',
  code: 'C001',
  branchCode: null,
  name: 'Lulu Bawshar',
  customerType: 'HYPERMARKET',
  priority: 3,
  prioritySource: 'DEFAULT',
  serviceMin: 15,
  serviceSource: 'TYPE',
  hardWindowStartMin: 360,
  hardWindowEndMin: 600,
  prefWindowStartMin: null,
  prefWindowEndMin: null,
};
const CONFIRMED = { ...UNCONFIRMED, customerId: 'c2', name: 'Carrefour Seeb', priority: 2, prioritySource: 'CUSTOMER', serviceMin: 25, serviceSource: 'CUSTOMER' };

describe('the Details form helpers (customer-details.ts)', () => {
  it('opens with defaults shown as defaults (blank), and own values as typed values', () => {
    expect(detailsFormOf(UNCONFIRMED)).toEqual({ type: 'HYPERMARKET', priority: '', service: '', hardStart: '06:00', hardEnd: '10:00', prefStart: '', prefEnd: '' });
    expect(detailsFormOf(CONFIRMED)).toMatchObject({ priority: '2', service: '25' });
    // A customer without the sources (older callers) is shown as before.
    const plain: DetailsCustomer = { ...UNCONFIRMED, prioritySource: undefined, serviceSource: undefined };
    expect(detailsFormOf(plain)).toMatchObject({ priority: '3', service: '15' });
  });

  it('shows the end of the day as 24:00, which reads back (fmtHhmm shows "00:00 +1")', () => {
    expect(windowText(1440)).toBe('24:00');
    expect(windowText(390)).toBe('06:30');
    expect(windowText(null)).toBe('');
    const midnight = detailsFormOf({ ...CONFIRMED, hardWindowStartMin: 1080, hardWindowEndMin: 1440 });
    expect(midnight).toMatchObject({ hardStart: '18:00', hardEnd: '24:00' });
    expect(detailsPatch(midnight, midnight)).toEqual({ ok: true, patch: {} });
    expect(detailsPatch(midnight, { ...midnight, hardStart: '17:00' })).toEqual({ ok: true, patch: { hardWindowStartMin: 1020 } });
  });

  it('unloading time: whole minutes 0..480, blank = the default', () => {
    expect(parseServiceMinutes('')).toEqual({ ok: true, minutes: null });
    expect(parseServiceMinutes('  ')).toEqual({ ok: true, minutes: null });
    expect(parseServiceMinutes('0')).toEqual({ ok: true, minutes: 0 });
    expect(parseServiceMinutes(' 25 ')).toEqual({ ok: true, minutes: 25 });
    expect(parseServiceMinutes('480')).toEqual({ ok: true, minutes: 480 });
    for (const bad of ['ten', '10 min', '1.5', '-5', '1e2', '0x10', '481']) {
      expect(parseServiceMinutes(bad).ok, bad).toBe(false);
    }
  });

  it('sends nothing when nothing changed - the defaults on screen are not confirmed', () => {
    const f = detailsFormOf(UNCONFIRMED);
    expect(detailsPatch(f, { ...f })).toEqual({ ok: true, patch: {} });
    // Retyping a time the same way is no change.
    expect(detailsPatch(f, { ...f, hardStart: '6:00', hardEnd: '1000' })).toEqual({ ok: true, patch: {} });
  });

  it('sends only the fields that changed', () => {
    const f = detailsFormOf(UNCONFIRMED);
    expect(detailsPatch(f, { ...f, hardEnd: '11:00' })).toEqual({ ok: true, patch: { hardWindowEndMin: 660 } });
    expect(detailsPatch(f, { ...f, type: 'GROCERY' })).toEqual({ ok: true, patch: { customerType: 'GROCERY' } });
    expect(detailsPatch(f, { ...f, type: '' })).toEqual({ ok: true, patch: { customerType: null } });
    expect(detailsPatch(f, { ...f, prefStart: '07:00', prefEnd: '09:00' })).toEqual({ ok: true, patch: { prefWindowStartMin: 420, prefWindowEndMin: 540 } });
    expect(detailsPatch(f, { ...f, hardStart: '', hardEnd: '' })).toEqual({ ok: true, patch: { hardWindowStartMin: null, hardWindowEndMin: null } });
  });

  it('confirming a default priority: choosing a P - the same number included - is sent', () => {
    const f = detailsFormOf(UNCONFIRMED);
    expect(detailsPatch(f, { ...f, priority: '3' })).toEqual({ ok: true, patch: { priority: 3 } });
    expect(detailsPatch(f, { ...f, priority: '1' })).toEqual({ ok: true, patch: { priority: 1 } });
    expect(detailsPatch(f, { ...f, priority: '9' }).ok).toBe(false);
  });

  it('unloading time: blank = back to the default (null), an explicit 0 is kept', () => {
    const own = detailsFormOf(CONFIRMED);
    expect(detailsPatch(own, { ...own, service: '' })).toEqual({ ok: true, patch: { avgServiceTimeMin: null } });
    expect(detailsPatch(own, { ...own, service: '0' })).toEqual({ ok: true, patch: { avgServiceTimeMin: 0 } });
    const dflt = detailsFormOf(UNCONFIRMED);
    // Typing the default's own number confirms it as the customer's time.
    expect(detailsPatch(dflt, { ...dflt, service: '15' })).toEqual({ ok: true, patch: { avgServiceTimeMin: 15 } });
    expect(detailsPatch(dflt, { ...dflt, service: '0' })).toEqual({ ok: true, patch: { avgServiceTimeMin: 0 } });
  });

  it('refuses malformed times and unloading text; nothing is sent', () => {
    const f = detailsFormOf(UNCONFIRMED);
    for (const [key, v, msg] of [
      ['hardStart', '06:90', /Receiving hours \(hard\) start "06:90" is not a time/],
      ['hardEnd', '25:00', /end "25:00" is not a time/],
      ['prefStart', '7pm', /Preferred hours start "7pm"/],
      ['hardEnd', '10:5', /is not a time/],
    ] as const) {
      const r = detailsPatch(f, { ...f, [key]: v, ...(key === 'prefStart' ? { prefEnd: '09:00' } : {}) });
      expect(r.ok, v).toBe(false);
      if (!r.ok) expect(r.error).toMatch(msg);
    }
    for (const v of ['ten', '10 min', '1.5']) {
      const r = detailsPatch(f, { ...f, service: v });
      expect(r, v).toMatchObject({ ok: false, error: expect.stringMatching(/whole minutes/) });
    }
    expect(detailsPatch(f, { ...f, hardEnd: '' })).toMatchObject({ ok: false, error: expect.stringMatching(/give both the start and the end/) });
    expect(detailsPatch(f, { ...f, hardEnd: '05:00' })).toMatchObject({ ok: false, error: expect.stringMatching(/the end must be after the start/) });
  });
});

function setup(first: typeof UNCONFIRMED = UNCONFIRMED) {
  const saved = vi.fn();
  const host: Host<any> = new Host(CustomerDialog as any, { open: false, customer: null, onSaved: saved, onOpenChange: (v: boolean) => host.render({ open: v }) });
  host.render();
  host.render({ open: true, customer: first });
  const els = () => elements(host.tree);
  // Found by id, or (for the code before the fix) by placeholder / text.
  const PLACEHOLDER: Record<string, string> = { 'cd-hs': '06:00', 'cd-he': '10:00', 'cd-ps': '07:00', 'cd-pe': '09:00' };
  const field = (id: string) => els().find((e) => e.props?.id === id || (PLACEHOLDER[id] && e.props?.placeholder === PLACEHOLDER[id]));
  const type = (id: string, value: string) => {
    field(id).props.onChange({ target: { value } });
    host.flush();
  };
  const saveBtn = () => els().find((e) => e.props?.['data-testid'] === 'save-customer-details' || (typeName(e) === 'Button' && textOf(e).trim() === 'Save'));
  const save = () => {
    void saveBtn().props.onClick();
    host.flush();
  };
  const patches = () => calls.filter((c) => c.init.method === 'PATCH');
  return { host, field, type, save, patches, saved };
}

describe('CustomerDialog (audit F07)', () => {
  it('Save without a change confirms nothing (before: priority 3 and 15 min were sent and marked confirmed)', () => {
    const t = setup();
    expect(t.field('cd-prio').props.value).toBe('');
    expect(t.field('cd-svc').props.value).toBe('');
    expect(t.field('cd-svc').props.placeholder).toBe('15 (customer type default)');
    t.save();
    expect(t.patches()).toEqual([]);
    expect(toasts).toEqual(['info: Nothing changed.']);
    expect(t.host.props.open).toBe(false);
  });

  it('a changed receiving hour alone is sent alone', async () => {
    const t = setup();
    t.type('cd-he', '11:00');
    t.save();
    expect(t.patches()).toHaveLength(1);
    expect(t.patches()[0].url).toBe('/api/customers/c1');
    expect(t.patches()[0].init.json).toEqual({ hardWindowEndMin: 660 });
    t.patches()[0].resolve({ ok: true, status: 200, data: {}, error: null, errorBody: null });
    await t.host.settle();
    expect(t.saved).toHaveBeenCalledTimes(1);
    expect(t.host.props.open).toBe(false);
  });

  it('"06:90" is refused, nothing is saved (before: saved as 07:30)', () => {
    const t = setup();
    t.type('cd-hs', '06:90');
    t.save();
    expect(t.patches()).toEqual([]);
    expect(toasts.at(-1)).toMatch(/^error: Receiving hours \(hard\) start "06:90" is not a time/);
    expect(t.host.props.open).toBe(true);
  });

  it('"10 min" or "ten" as unloading time is refused (before: 0 minutes, confirmed)', () => {
    const t = setup();
    for (const v of ['10 min', 'ten', '1.5']) {
      t.type('cd-svc', v);
      t.save();
    }
    expect(t.patches()).toEqual([]);
    expect(toasts.filter((m) => /whole minutes/.test(m))).toHaveLength(3);
  });

  it('a confirmed unloading time cleared goes back to the default (null); 0 stays an explicit 0', () => {
    const t = setup(CONFIRMED);
    expect(t.field('cd-svc').props.value).toBe('25');
    t.type('cd-svc', '');
    t.save();
    expect(t.patches()[0].init.json).toEqual({ avgServiceTimeMin: null });
    const u = setup(CONFIRMED);
    u.type('cd-svc', '0');
    u.save();
    expect(calls.at(-1)!.init.json).toEqual({ avgServiceTimeMin: 0 });
  });

  it('the default priority is offered as "not confirmed"; picking P3 confirms it', () => {
    const t = setup();
    const options = elements(t.field('cd-prio').props.children).filter((e) => e.type === 'option');
    expect(textOf(options[0])).toBe('P3 - default, not confirmed');
    t.type('cd-prio', '3');
    t.save();
    expect(t.patches()[0].init.json).toEqual({ priority: 3 });
  });

  it("a Save answer after the dialog was opened for another customer does not close that dialog", async () => {
    const t = setup();
    t.type('cd-he', '11:00');
    t.save();
    const first = t.patches()[0];
    t.host.render({ open: false });
    t.host.render({ open: true, customer: CONFIRMED });
    first.resolve({ ok: true, status: 200, data: {}, error: null, errorBody: null });
    await t.host.settle();
    expect(t.host.props.open).toBe(true);
    expect(t.saved).toHaveBeenCalledTimes(1);
    expect(toasts.at(-1)).toBe('success: Details saved for Lulu Bawshar.');
    // The other customer's form is untouched.
    expect(t.field('cd-he').props.value).toBe('10:00');
    expect(t.field('cd-svc').props.value).toBe('25');
  });
});

describe('PATCH /api/customers/:id - unloading time and confirmation (audit F07)', () => {
  const patch = (body: unknown) =>
    PATCH(new Request('http://localhost/api/customers/c1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: { id: 'c1' } });

  beforeEach(() => {
    route.before = {
      id: 'c1', code: 'C001', branchKey: '__MAIN__', active: true, avgServiceTimeMin: 25, serviceTimeConfirmed: true, priority: 2, priorityConfirmed: true,
      hardWindowStartMin: 360, hardWindowEndMin: 600, prefWindowStartMin: null, prefWindowEndMin: null,
    };
    route.updates = [];
  });

  it('null = no own time: the default applies again, not confirmed (the column default is stored)', async () => {
    const res = await patch({ avgServiceTimeMin: null });
    expect(res.status).toBe(200);
    expect(route.updates).toEqual([{ avgServiceTimeMin: 10, serviceTimeConfirmed: false }]);
  });

  it('a number (0 included) is the customer\'s own confirmed time', async () => {
    expect((await patch({ avgServiceTimeMin: 0 })).status).toBe(200);
    expect(route.updates.at(-1)).toEqual({ avgServiceTimeMin: 0, serviceTimeConfirmed: true });
    expect((await patch({ avgServiceTimeMin: 45 })).status).toBe(200);
    expect(route.updates.at(-1)).toEqual({ avgServiceTimeMin: 45, serviceTimeConfirmed: true });
  });

  it('only the fields sent: a receiving-hours change confirms neither priority nor unloading time', async () => {
    expect((await patch({ hardWindowEndMin: 660 })).status).toBe(200);
    expect(route.updates).toEqual([{ hardWindowEndMin: 660 }]);
  });

  it('refuses text, fractions and blanks instead of turning them into 0 (400, nothing saved)', async () => {
    for (const body of [{ avgServiceTimeMin: '' }, { avgServiceTimeMin: '10 min' }, { avgServiceTimeMin: 1.5 }, { avgServiceTimeMin: 481 }, { hardWindowStartMin: '', hardWindowEndMin: 600 }, { prefWindowStartMin: '420', prefWindowEndMin: 540 }]) {
      expect((await patch(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(route.updates).toEqual([]);
  });
});
