/**
 * The plan screen's Salesman link (owner request 19 Oct 2026): app/t/[slug]/dispatch/sales-link-dialog.tsx on the
 * REAL component through the hook host (hook-host.ts); only api() and the toasts are replaced.
 *
 *  - Opening the dialog only reads the date's link (GET): a link is made by pressing Make the link (POST { date }).
 *  - With a link: the address, Copy, Send on WhatsApp (the server's wa.me link without a number: the dispatcher
 *    picks the group), the message, "Opened on N phones · last HH:MM · routes looked up: R1, R2X".
 *  - Make a new link and Turn off are asked first and send the optional reason; a refusal reads the link again.
 *  - Turned off, over, or made with an older server key: what the office can do then.
 *  - The plan screen shows the button for the company's today or tomorrow only, with the plan's own today on the
 *    standalone version page (critique 19: `today ?? d.today`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Host, elements, textOf } from './hook-host';
import type { SalesLinkView } from '@/lib/sales-link/view-types';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));

const net = vi.hoisted(() => ({
  calls: [] as { url: string; method: string; json: unknown }[],
  reply: (() => ({ ok: true, status: 200, data: null, error: null })) as (url: string, method: string, json: unknown) => { ok: boolean; status: number; data: unknown; error: string | null },
}));
vi.mock('@/app/t/[slug]/dispatch/client-api', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    api: async (url: string, init?: { method?: string; json?: unknown }) => {
      const method = init?.method ?? 'GET';
      net.calls.push({ url, method, json: init?.json });
      const r = net.reply(url, method, init?.json);
      return { ...r, data: r.data === null ? null : structuredClone(r.data), errorBody: null };
    },
  };
});
const toasts = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock('sonner', () => ({ toast: { success: (m: string) => toasts.list.push(m), error: (m: string) => toasts.list.push(m), warning() {}, info() {} } }));

import { SalesLinkDialog, salesLinkDayOk, salesLinkSeenText } from '@/app/t/[slug]/dispatch/sales-link-dialog';

afterEach(() => {
  net.calls = [];
  toasts.list = [];
});

const URL_ = 'https://routeiq.example/s/AbCdEfGhIjKlMnOpQrStUv12';
const MESSAGE = `RouteIQ - live deliveries for Mon 19 Oct (Example Water Co): ${URL_}\nOpen it, type your route code ...\nWorks until Tue 20 Oct 06:00. For the sales team only - please do not forward.`;

const view = (over: Partial<SalesLinkView> = {}): SalesLinkView => ({
  id: 'sl0123456789abcdef01234567',
  date: '2026-10-19',
  dayShort: 'Mon 19 Oct',
  url: URL_,
  expiresAt: '2026-10-20T02:00:00.000Z',
  expiryText: 'Works until Tue 20 Oct 06:00',
  generation: 1,
  revoked: false,
  expired: false,
  keyChanged: false,
  issuedAt: '2026-10-18T16:00:00.000Z',
  lastSeenAt: null,
  phones: 0,
  routesSeen: [],
  message: MESSAGE,
  whatsappUrl: `https://wa.me/?text=${encodeURIComponent(MESSAGE)}`,
  ...over,
});

async function mount(reply: typeof net.reply) {
  net.reply = reply;
  const host: Host<any> = new Host(SalesLinkDialog as any, { open: true, onOpenChange() {}, date: '2026-10-19', timezone: 'Asia/Muscat' });
  host.render();
  await host.settle();
  const text = () => textOf(host.tree);
  const byId = (id: string) => elements(host.tree).find((e) => e.props?.['data-testid'] === id);
  const click = async (id: string) => {
    const el = byId(id);
    if (!el) throw new Error(`no ${id}`);
    el.props.onClick();
    host.flush();
    await host.settle();
  };
  return { host, text, byId, click };
}

describe('the Salesman link dialog', () => {
  it('opening only reads; Make the link makes it for the plan\'s date', async () => {
    let made = false;
    const d = await mount((url, method) => {
      if (method === 'POST') {
        made = true;
        return { ok: true, status: 201, data: { ...view(), created: true }, error: null };
      }
      return { ok: true, status: 200, data: made ? view() : null, error: null };
    });
    expect(net.calls).toEqual([{ url: '/api/dispatch/sales-links?date=2026-10-19', method: 'GET', json: undefined }]);
    expect(d.text()).toMatch(/No salesman link for Mon 19 Oct yet/);
    expect(d.text()).toMatch(/Anyone with the link can look up any route of Mon 19 Oct until 06:00 the next day/);
    await d.click('sales-link-make');
    expect(net.calls[1]).toEqual({ url: '/api/dispatch/sales-links', method: 'POST', json: { date: '2026-10-19' } });
    expect(textOf(d.byId('sales-link-url'))).toBe(URL_);
    expect(d.byId('sales-link-whatsapp')?.props.href).toBe(view().whatsappUrl);
    expect(d.byId('sales-link-whatsapp')?.props.href).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(textOf(d.byId('sales-link-message'))).toBe(MESSAGE);
    expect(textOf(d.byId('sales-link-seen'))).toBe('Not opened by a salesman yet · no route looked up yet');
    expect(d.text()).toMatch(/Works until Tue 20 Oct 06:00 \(06:00 the day after delivery\)/);
    expect(toasts.list).toEqual(["Salesman link for Mon 19 Oct ready: send it to the salesmen's group."]);
  });

  it('a refused Make the link says why (today or tomorrow only, links off)', async () => {
    const d = await mount((url, method) =>
      method === 'POST' ? { ok: false, status: 503, data: null, error: 'Salesman links are off: the server has no secret to make them (SALES_LINK_SECRET or NEXTAUTH_SECRET).' } : { ok: true, status: 200, data: null, error: null },
    );
    await d.click('sales-link-make');
    expect(textOf(d.byId('sales-link-error'))).toMatch(/Salesman links are off/);
  });

  it('Make a new link is asked first and sends the reason; the new link is shown', async () => {
    const d = await mount((url, method) => (method === 'PATCH' ? { ok: true, status: 200, data: view({ generation: 2, url: `${URL_.slice(0, -2)}zz` }), error: null } : { ok: true, status: 200, data: view({ phones: 3 }), error: null }));
    await d.click('sales-link-reissue');
    expect(net.calls.filter((c) => c.method === 'PATCH')).toEqual([]);
    expect(d.text()).toMatch(/Make a new salesman link\?/);
    expect(d.text()).toMatch(/salesmen who open it see "replaced"/);
    const reason = elements(d.host.tree).find((e) => e.props?.['aria-label'] === 'Why (optional)');
    reason.props.onChange({ target: { value: '  forwarded to a customer  ' } });
    d.host.flush();
    await d.click('sales-link-confirm-action');
    expect(net.calls.at(-1)).toEqual({ url: '/api/dispatch/sales-links/sl0123456789abcdef01234567', method: 'PATCH', json: { action: 'REISSUE', reason: 'forwarded to a customer' } });
    expect(textOf(d.byId('sales-link-url'))).toMatch(/zz$/);
    expect(textOf(d.byId('sales-link-seen'))).toMatch(/link #2/);
  });

  it('Turn off is asked first; a refusal (changed at the same moment) reads the link again', async () => {
    let reads = 0;
    const d = await mount((url, method) => {
      if (method === 'PATCH') return { ok: false, status: 409, data: null, error: 'The link was changed at the same moment. Try again.' };
      reads++;
      return { ok: true, status: 200, data: reads > 1 ? view({ revoked: true, url: null, message: null, whatsappUrl: null }) : view(), error: null };
    });
    await d.click('sales-link-revoke');
    expect(d.text()).toMatch(/Turn off the salesman link\?/);
    await d.click('sales-link-confirm-action');
    expect(net.calls.find((c) => c.method === 'PATCH')?.json).toEqual({ action: 'REVOKE' });
    expect(textOf(d.byId('sales-link-error'))).toMatch(/changed at the same moment/);
    // The read again answers after the refusal was shown.
    await d.host.settle();
    expect(reads).toBe(2);
    expect(d.byId('sales-link-revoked')).toBeTruthy();
    // Turned off: Make a new link starts again, Turn off is gone.
    expect(d.byId('sales-link-reissue')).toBeTruthy();
    expect(d.byId('sales-link-revoke')).toBeUndefined();
  });

  it('a link whose day is over: no address, no actions', async () => {
    const d = await mount(() => ({ ok: true, status: 200, data: view({ expired: true, url: null, message: null, whatsappUrl: null }), error: null }));
    expect(textOf(d.byId('sales-link-expired'))).toMatch(/This link's day is over: it worked until Tue 20 Oct 06:00/);
    expect(d.byId('sales-link-reissue')).toBeUndefined();
    expect(d.byId('sales-link-revoke')).toBeUndefined();
    expect(d.byId('sales-link-whatsapp')).toBeUndefined();
  });

  it('a link made with an older server key: Make the link makes it work again', async () => {
    const d = await mount((url, method) => (method === 'POST' ? { ok: true, status: 200, data: { ...view(), created: false }, error: null } : { ok: true, status: 200, data: view({ keyChanged: true, url: null, message: null, whatsappUrl: null }), error: null }));
    expect(d.byId('sales-link-key-changed')).toBeTruthy();
    const make = elements(d.byId('sales-link-key-changed')).find((e) => typeof e.props?.onClick === 'function');
    make.props.onClick();
    d.host.flush();
    await d.host.settle();
    expect(net.calls.at(-1)).toEqual({ url: '/api/dispatch/sales-links', method: 'POST', json: { date: '2026-10-19' } });
    expect(textOf(d.byId('sales-link-url'))).toBe(URL_);
  });
});

describe('what the office reads', () => {
  it('"Opened on N phones · last HH:MM (company time) · routes looked up"', () => {
    expect(salesLinkSeenText(view({ phones: 1, lastSeenAt: '2026-10-19T06:32:00.000Z', routesSeen: ['R1'] }), 'Asia/Muscat')).toBe('Opened on 1 phone · last 10:32 · routes looked up: R1');
    expect(salesLinkSeenText(view({ phones: 14, lastSeenAt: '2026-10-19T06:32:00.000Z', routesSeen: ['R1', 'R2X'], generation: 3 }), 'Asia/Muscat')).toBe(
      'Opened on 14 phones · last 10:32 · routes looked up: R1, R2X · link #3',
    );
    const many = Array.from({ length: 33 }, (_, i) => `R${i + 1}`);
    expect(salesLinkSeenText(view({ phones: 40, routesSeen: many }), 'Asia/Muscat')).toMatch(/R30 and 3 more$/);
  });

  it('the button is for the company\'s today or tomorrow only', () => {
    expect(salesLinkDayOk('2026-10-19', '2026-10-19')).toBe(true);
    expect(salesLinkDayOk('2026-10-20', '2026-10-19')).toBe(true);
    expect(salesLinkDayOk('2026-10-18', '2026-10-19')).toBe(false);
    expect(salesLinkDayOk('2026-10-21', '2026-10-19')).toBe(false);
    expect(salesLinkDayOk('2026-11-01', '2026-10-31')).toBe(true);
    expect(salesLinkDayOk('2026-10-19', undefined)).toBe(false);
  });

  it('the plan screen: the button next to Salesman ETA for a planner, on a plan in use, with the plan\'s own today on the version page', () => {
    const src = readFileSync(path.join(__dirname, '..', '..', 'app', 't', '[slug]', 'dispatch', 'plan-view.tsx'), 'utf8');
    const eta = src.indexOf('data-testid="export-salesman-eta"');
    const button = src.indexOf('data-testid="salesman-link"');
    expect(eta).toBeGreaterThan(0);
    expect(button).toBeGreaterThan(eta);
    expect(src).toContain('{canPlan && !superseded && salesLinkDayOk(d.run.runDate, today ?? d.today) ? (');
    expect(src).toMatch(/<SalesLinkDialog open onOpenChange=\{\(o\) => !o && setSalesLinkOpen\(false\)\} date=\{d\.run\.runDate\}/);
  });
});
