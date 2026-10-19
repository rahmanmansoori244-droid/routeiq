/**
 * Operations alerts on the screens (owner request 16 Oct 2026; design PR-2 9.1 with the review's M11,
 * L10, H4 and the per-truck roll-up), on the REAL components through the hook host (hook-host.ts): only
 * api(), the toasts, the timers and document / window are replaced.
 * - The bell: nothing at all (no read, no timer) while alerts are off; red with a HIGH open alert, the
 *   open count; no toast for what was there when the page opened (M11), then one toast per new HIGH row
 *   allowed to toast (a row that became worse is new again), at most 3; Acknowledge sends the tier shown;
 *   switched off meanwhile: it hides.
 * - The day screen's Alerts card: one block per truck, worst first; what is over behind "Show N over";
 *   polls only for yesterday, today and tomorrow; Acknowledge all sends the open rows.
 * - No warehouse "Loaded" button next to Dispatch (removed before release, owner decision of 16 Oct 2026).
 * - The pure helpers: where, state words, the toast choice, the ack body, the settings checks.
 * - Dates (owner request 19 Oct 2026: yesterday's alerts looked like today's with the time only): the bell
 *   and the Alerts page show the day of an alert that is not today's ("Yesterday 17:20", "18 Oct 17:20"),
 *   today's keep the time only; across midnight, time zones and a summer-time change; the bell's date
 *   headers; "Day ended" with who had acknowledged it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Host, elements, textOf, typeName } from './hook-host';
import type { OpsAlertRow } from '@/lib/alerts/types';
import type { AlertSummary } from '@/lib/alerts/types';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));

const net = vi.hoisted(() => ({
  sent: [] as { method: string; url: string; json: unknown }[],
  summaries: [] as unknown[],
  list: null as unknown,
  plan: null as unknown,
  outcomes: null as unknown,
  ack: { acked: 1 } as unknown,
  /** PATCH /api/alerts answers (the cause & action dialog), in order; an { error } item is a refused request. */
  patches: [] as unknown[],
}));
vi.mock('@/app/t/[slug]/dispatch/client-api', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const ok = (data: unknown) => ({ ok: true, status: 200, data, error: null, errorBody: null });
  return {
    ...actual,
    api: async (url: string, init: { method?: string; json?: unknown } = {}) => {
      net.sent.push({ method: init.method ?? 'GET', url, json: init.json });
      if (url === '/api/alerts' && init.method === 'PATCH') {
        const a = structuredClone(net.patches.shift()) as { status?: number; error?: Record<string, unknown> } & Record<string, unknown>;
        if (a?.error) return { ok: false, status: a.status ?? 409, data: null, error: String(a.error.message ?? 'refused'), errorBody: a.error };
        return ok(a);
      }
      if (url === '/api/alerts/summary') return ok(structuredClone(net.summaries.shift() ?? null));
      if (url === '/api/alerts/ack') return ok(net.ack);
      if (url.startsWith('/api/alerts?')) return ok(structuredClone(net.list));
      if (url.endsWith('/plan')) return ok(structuredClone(net.plan));
      if (url === '/api/drivers' || url === '/api/helpers') return ok([]);
      if (url.endsWith('/outcomes')) return ok(structuredClone(net.outcomes));
      return ok({});
    },
  };
});
const toasts = vi.hoisted(() => ({ error: [] as string[], success: [] as string[], warning: [] as string[] }));
vi.mock('sonner', () => ({
  toast: {
    error: (m: string) => void toasts.error.push(m),
    success: (m: string) => void toasts.success.push(m),
    warning: (m: string) => void toasts.warning.push(m),
    info() {},
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace() {}, refresh() {}, push() {} }) }));
vi.mock('next/dynamic', () => ({ default: () => function DynamicStub() { return null; } }));

import { AlertBell } from '@/components/alert-bell';
import { AlertReviewDialog, incidentAlerts } from '@/components/alert-review-dialog';
import { AlertsCard, alertDayIsLive } from '@/app/t/[slug]/dispatch/alerts-card';
import { AlertsClient } from '@/app/t/[slug]/alerts/alerts-client';
import { PlanView } from '@/app/t/[slug]/dispatch/plan-view';
import { alertSettingsProblem, ruleMeaning } from '@/app/t/[slug]/settings/alert-settings-card';
import { ackBody, alertDayGroups, alertDayHeader, alertDayWord, alertStateText, alertWhen, alertWhere, bellTone, groupByTruck, newAlertToasts, sweepCheckText } from '@/lib/alerts/view';
import { visibleNavItems } from '@/lib/nav';
import { ALERT_POLL_MS, ALERT_RULE_SPECS, ALERT_TOAST_MAX } from '@/lib/alerts/catalog';
import { fixture } from './plan-detail-fixture';

let n = 0;
const row = (extra: Partial<OpsAlertRow> = {}): OpsAlertRow => ({
  id: `a${++n}`,
  rule: 'ETA_LATE',
  kind: 'CONDITION',
  severity: 'WARN',
  tier: 1,
  state: 'OPEN',
  depotId: 'dep1',
  deliveryDate: '2026-10-16',
  truckId: 'tr5',
  truckCode: 'T05',
  loadNo: 1,
  sequence: null,
  customerId: null,
  value: 35,
  threshold: 30,
  text: 'T05 L1 is running about 35 min late.',
  occurredAt: '2026-10-16T05:10:00.000Z',
  firstSeenAt: '2026-10-16T05:12:00.000Z',
  lastSeenAt: '2026-10-16T05:30:00.000Z',
  resolvedAt: null,
  resolvedReason: null,
  occurrences: 1,
  ackedAt: null,
  ackedByName: null,
  mayToast: true,
  review: null,
  detailsRemoved: false,
  ...extra,
});
const high = (extra: Partial<OpsAlertRow> = {}) => row({ severity: 'HIGH', tier: 2, ...extra });
const summary = (latest: OpsAlertRow[], extra: Partial<AlertSummary> = {}): AlertSummary => ({
  enabled: true,
  open: latest.length,
  high: latest.filter((r) => r.severity === 'HIGH').length,
  latest,
  emailCapReached: false,
  checkedAt: null,
  checkStale: false,
  checkFailed: false,
  ...extra,
});

/** The polls (setInterval at ALERT_POLL_MS), fired by the test. */
let polls: (() => void)[] = [];
let intervals: number[] = [];
beforeEach(() => {
  net.sent = [];
  net.summaries = [];
  net.list = null;
  net.plan = null;
  net.outcomes = null;
  net.ack = { acked: 1 };
  net.patches = [];
  toasts.error = [];
  toasts.success = [];
  toasts.warning = [];
  polls = [];
  intervals = [];
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
    intervals.push(ms ?? 0);
    if (ms === ALERT_POLL_MS) polls.push(fn);
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setInterval);
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
  const listeners = { addEventListener() {}, removeEventListener() {} };
  vi.stubGlobal('document', { visibilityState: 'visible', ...listeners });
  vi.stubGlobal('window', { ...listeners, confirm: () => true, prompt: () => null });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const byTestId = (tree: unknown, id: string) => elements(tree).filter((e) => e.props?.['data-testid'] === id);

describe('the bell', () => {
  async function mountBell(enabled = true, canAck = true) {
    const host: Host<any> = new Host(AlertBell as any, { slug: 'example', enabled, canAck, timezone: 'Asia/Muscat' });
    host.render();
    await host.settle();
    return host;
  }
  const poll = async (host: Host<any>) => {
    polls[0]!();
    await host.settle();
  };

  it('alerts off: renders nothing, reads nothing, starts no timer (review L10)', async () => {
    const host = await mountBell(false);
    expect(host.tree).toBeNull();
    expect(net.sent).toEqual([]);
    expect(intervals).toEqual([]);
  });

  it('red with a HIGH open alert and the open count; no toast for what was there when the page opened (M11)', async () => {
    net.summaries = [summary([high({ id: 'h1' }), row({ id: 'w1' }), high({ id: 'h2' }), high({ id: 'h3' }), high({ id: 'h4' })])];
    const host = await mountBell();
    expect(net.sent.map((s) => s.url)).toEqual(['/api/alerts/summary']);
    expect(intervals).toEqual([ALERT_POLL_MS]);
    expect(byTestId(host.tree, 'alert-bell')[0]!.props['data-tone']).toBe('high');
    expect(textOf(byTestId(host.tree, 'alert-bell-count')[0])).toBe('5');
    expect(byTestId(host.tree, 'alert-bell-row')).toHaveLength(5);
    expect(toasts.error).toEqual([]);
  });

  it('then: one toast per new HIGH row that may toast, a worse tier is news again, at most 3 at once', async () => {
    net.summaries = [summary([high({ id: 'h1' })])];
    const host = await mountBell();
    // A new HIGH, a new WARN, a new HIGH that may not toast (history), the old one unchanged.
    net.summaries.push(summary([high({ id: 'h1' }), high({ id: 'h2', text: 'T07 L2: loading for 95 min.' }), row({ id: 'w2' }), high({ id: 'hx', mayToast: false })]));
    await poll(host);
    expect(toasts.error).toEqual(['T05 L1: Running late']);
    // h1 became worse (tier 3): it toasts once more; h2 does not toast again.
    net.summaries.push(summary([high({ id: 'h1', tier: 3 }), high({ id: 'h2' })]));
    await poll(host);
    expect(toasts.error).toHaveLength(2);
    // Five new HIGH rows at once: three toasts.
    net.summaries.push(summary(['n1', 'n2', 'n3', 'n4', 'n5'].map((id) => high({ id }))));
    await poll(host);
    expect(toasts.error).toHaveLength(2 + ALERT_TOAST_MAX);
  });

  it('Acknowledge sends the row with the tier it showed; a viewer gets no button', async () => {
    net.summaries = [summary([high({ id: 'h1', tier: 2 }), row({ id: 'w1' })]), summary([row({ id: 'w1' })])];
    const host = await mountBell();
    byTestId(host.tree, 'alert-bell-ack')[0]!.props.onClick();
    await host.settle();
    expect(net.sent.find((s) => s.url === '/api/alerts/ack')).toEqual({ method: 'POST', url: '/api/alerts/ack', json: { ids: ['h1'], seen: { h1: 2 } } });
    expect(textOf(byTestId(host.tree, 'alert-bell-count')[0])).toBe('1');
    // One row left: no "Acknowledge these" button.
    expect(byTestId(host.tree, 'alert-bell-ack-all')).toHaveLength(0);
    net.summaries = [summary([high({ id: 'h9' })])];
    const viewer = await mountBell(true, false);
    expect(byTestId(viewer.tree, 'alert-bell-ack')).toHaveLength(0);
  });

  it('switched off by an admin meanwhile: the bell hides at the next read', async () => {
    net.summaries = [summary([high()]), { enabled: false, open: 0, high: 0, latest: [], emailCapReached: false, checkedAt: null, checkStale: false, checkFailed: false }];
    const host = await mountBell();
    expect(host.tree).not.toBeNull();
    await poll(host);
    expect(host.tree).toBeNull();
  });

  it('says when the e-mails of today reached their daily limit', async () => {
    net.summaries = [summary([high()], { emailCapReached: true })];
    expect(byTestId((await mountBell()).tree, 'alert-bell-email-cap')).toHaveLength(1);
  });

  it('review M2: says when the alerts were last checked, and warns when the check is overdue or failed', async () => {
    net.summaries = [summary([high()], { checkedAt: '2026-10-16T05:58:00.000Z' })];
    const ok = byTestId((await mountBell()).tree, 'alert-bell-checked');
    expect(textOf(ok[0])).toBe('Checked 09:58');
    net.summaries = [summary([], { checkedAt: '2026-10-16T05:30:00.000Z', checkStale: true })];
    expect(textOf(byTestId((await mountBell()).tree, 'alert-bell-checked')[0])).toContain('Alerts last checked 09:30: new alerts may be missing.');
    expect(sweepCheckText({ checkedAt: null, checkStale: true, checkFailed: true }, 'Asia/Muscat')).toMatchObject({ warn: true, text: expect.stringContaining('not checked yet since the server started') });
    expect(sweepCheckText({ checkedAt: '2026-10-16T05:58:00.000Z', checkStale: false, checkFailed: true }, 'Asia/Muscat')).toEqual({ warn: true, text: 'Checked 09:58; the last check failed: some alerts may be missing.' });
    expect(sweepCheckText({ checkedAt: null, checkStale: false, checkFailed: false }, 'Asia/Muscat')).toBeNull();
  });
});

describe('the Alerts menu item (review M1: merging changes nothing on screen)', () => {
  it('shows only while the company has alerts on, for every role', () => {
    for (const role of ['VIEWER', 'PLANNER', 'TENANT_ADMIN'] as const) {
      expect(visibleNavItems(role).map((i) => i.label)).not.toContain('Alerts');
      expect(visibleNavItems(role, { alerts: false }).map((i) => i.label)).not.toContain('Alerts');
      expect(visibleNavItems(role, { alerts: true }).map((i) => i.label)).toContain('Alerts');
    }
  });
});

describe("the day screen's Alerts card", () => {
  async function mountCard(props: Partial<{ date: string; today: string; enabled: boolean; canAck: boolean }> = {}) {
    const host: Host<any> = new Host(AlertsCard as any, { slug: 'example', date: '2026-10-16', depotId: 'dep1', today: '2026-10-16', timezone: 'Asia/Muscat', canAck: true, enabled: true, ...props });
    host.render();
    await host.settle();
    return host;
  }

  it('alerts off: nothing, no read', async () => {
    const host = await mountCard({ enabled: false });
    expect(host.tree).toBeNull();
    expect(net.sent).toEqual([]);
  });

  it("one block per truck with its worst state first; what is over is behind 'Show N over'", async () => {
    net.list = {
      enabled: true,
      truncated: false,
      rows: [
        row({ id: 'w', truckId: 'tr2', truckCode: 'T02' }),
        high({ id: 'h', truckId: 'tr9', truckCode: 'T09', rule: 'UNLOAD_OVER', sequence: 2 }),
        row({ id: 'over', truckId: 'tr9', truckCode: 'T09', state: 'RESOLVED', resolvedAt: '2026-10-16T06:00:00.000Z', resolvedReason: 'ENDED' }),
        row({ id: 'gone', truckId: 'tr4', truckCode: 'T04', state: 'RESOLVED', resolvedAt: '2026-10-16T06:00:00.000Z', resolvedReason: 'NOT_IN_PLAN' }),
      ],
    };
    const host = await mountCard();
    expect(net.sent[0]!.url).toBe('/api/alerts?date=2026-10-16&depotId=dep1&state=all');
    const blocks = elements(host.tree).filter((e) => String(e.props?.['data-testid'] ?? '').startsWith('alerts-truck-'));
    expect(blocks.map((b) => b.props['data-testid'])).toEqual(['alerts-truck-T09', 'alerts-truck-T02']);
    expect(byTestId(host.tree, 'alerts-card-row').map((r) => r.props['data-state'])).toEqual(['OPEN', 'OPEN']);
    expect(textOf(byTestId(host.tree, 'alerts-card-show-over')[0])).toBe('Show 2 over');
    byTestId(host.tree, 'alerts-card-show-over')[0]!.props.onClick();
    host.flush();
    expect(byTestId(host.tree, 'alerts-card-row')).toHaveLength(4);
    expect(textOf(byTestId(host.tree, 'alerts-card-open')[0])).toBe('2 open');
  });

  it('Acknowledge all sends the open rows with their tiers', async () => {
    net.list = { enabled: true, truncated: false, rows: [high({ id: 'h', tier: 3 }), row({ id: 'w' }), row({ id: 'a', state: 'ACKED' })] };
    const host = await mountCard();
    byTestId(host.tree, 'alerts-card-ack-all')[0]!.props.onClick();
    await host.settle();
    expect(net.sent.find((s) => s.url === '/api/alerts/ack')!.json).toEqual({ ids: ['h', 'w'], seen: { h: 3, w: 1 } });
  });

  it('polls only a day the sweep reads (yesterday, today, tomorrow)', async () => {
    net.list = { enabled: true, truncated: false, rows: [] };
    await mountCard({ date: '2026-10-17' });
    expect(intervals).toEqual([ALERT_POLL_MS]);
    intervals = [];
    const old = await mountCard({ date: '2026-10-12' });
    expect(intervals).toEqual([]);
    expect(byTestId(old.tree, 'alerts-card-none')).toHaveLength(1);
    expect([alertDayIsLive('2026-10-15', '2026-10-16'), alertDayIsLive('2026-10-14', '2026-10-16'), alertDayIsLive('2026-10-18', '2026-10-16')]).toEqual([true, false, false]);
  });
});

describe('no warehouse Loaded button (owner decision of 16 Oct 2026: R2 is measured from the driver taps)', () => {
  async function mountPlan(mut: (d: any) => void) {
    const d = fixture() as any;
    mut(d);
    net.plan = d;
    const host: Host<any> = new Host(PlanView as any, { slug: 'example', runId: 'run1', canPlan: true, canDispatch: true, phoneCountryCode: '968', reloadSignal: 0, onBusyChange: () => {}, onChanged: async () => {} });
    host.render();
    await host.settle();
    return host;
  }
  function buttonsOf(host: Host<any>, truckCode: string, loadNo: number) {
    const el = elements(host.tree).find((e) => typeName(e) === 'LoadActions' && e.props.l.truckCode === truckCode && e.props.l.loadNo === loadNo);
    const sub: Host<any> = new Host(el.type, el.props);
    sub.render();
    return elements(sub.tree)
      .filter((e) => String(e.props?.['data-testid'] ?? '').startsWith('act-'))
      .map((e) => ({ label: textOf(e.props.children).trim(), click: e.props.onClick as () => void, disabled: !!e.props.disabled }));
  }

  it('a Loading load offers Back to locked and Dispatch only; a Locked load Unlock, Loading and Dispatch', async () => {
    const host = await mountPlan((d) => {
      d.loads[0].status = 'LOADING';
    });
    expect(buttonsOf(host, 'T01', 1).map((b) => b.label)).toEqual(['Back to locked', 'Dispatch']);
    expect(byTestId(host.tree, 'load-loaded-T01-1')).toEqual([]);
    const locked = await mountPlan(() => {});
    expect(buttonsOf(locked, 'T01', 1).map((b) => b.label)).toEqual(['Unlock', 'Loading', 'Dispatch']);
  });
});

describe('the turnaround on the load row (owner decision 16 Oct 2026: rule R2 from the driver taps)', () => {
  const overlayWith = (turnarounds: Record<string, unknown>) => ({
    runId: 'run1', date: '2026-10-16', depotId: 'dep1', tz: 'Asia/Muscat', loads: {}, stops: {}, summary: {}, noOutcome: [], copyConflicts: {}, lockWarnings: {}, cameraExceptions: [], cameraAlerts: [], turnarounds,
  });
  async function mount(turnarounds: Record<string, unknown>) {
    const d = fixture() as any;
    d.loads[0].status = 'COMPLETED';
    d.loads[1].status = 'LOADING';
    net.plan = d;
    net.outcomes = overlayWith(turnarounds);
    const host: Host<any> = new Host(PlanView as any, { slug: 'example', runId: 'run1', canPlan: true, canDispatch: true, phoneCountryCode: '968', reloadSignal: 0, onBusyChange: () => {}, onChanged: async () => {} });
    host.render();
    await host.settle();
    // The results are read after the plan: let that answer arrive too.
    await host.settle();
    return host;
  }

  /** The rendered line of a load row (TurnaroundLine rendered on its own host), or null without one. */
  function lineOf(host: Host<any>, tag: string) {
    const el = elements(host.tree).find((e) => typeName(e) === 'TurnaroundLine' && e.props.tag === tag);
    if (!el) return null;
    const sub: Host<any> = new Host(el.type, el.props);
    sub.render();
    return elements(sub.tree).find((e) => e.props?.['data-testid'] === `load-turnaround-${tag}`) ?? null;
  }

  it('the trip after the first shows back, left and the minutes when known; a fallback is named; none on the first trip', async () => {
    const host = await mount({ L2: { afterLoadNo: 1, backAt: '2026-10-16T07:20:00.000Z', leftAt: '2026-10-16T08:08:00.000Z', how: 'TAP', tapLate: false, minutes: 48, final: true, line: 'back 11:20, left 12:08, 48 min' } });
    const el = lineOf(host, 'T01-2')!;
    expect(textOf(el)).toBe('After L1: back 11:20, left 12:08, 48 min');
    expect(el.props.title).toBe("Time at the depot between L1 and this trip: from the driver's Back at depot to the driver's Leaving for next load.");
    expect(lineOf(host, 'T01-1')).toBeNull();
    const fallback = await mount({ L2: { afterLoadNo: 1, backAt: '2026-10-16T07:20:00.000Z', leftAt: '2026-10-16T08:25:00.000Z', how: 'DISPATCH', tapLate: false, minutes: 65, final: true, line: 'back 11:20, left 12:25 (Dispatch press), 1 h 05 min' } });
    expect(lineOf(fallback, 'T01-2')!.props.title).toContain('the Dispatch press (the driver did not tap Leaving for next load)');
    // Second review of 16 Oct 2026: Back at depot tapped after the trip had started, and no leave recorded.
    const late = await mount({ L2: { afterLoadNo: 1, backAt: '2026-10-16T08:00:00.000Z', leftAt: null, how: null, tapLate: false, minutes: 0, final: false, notMeasured: 'BACK_LATE', line: 'back 12:00, tapped after this trip had started: not measured' } });
    expect(textOf(lineOf(late, 'T01-2')!)).toBe('After L1: back 12:00, tapped after this trip had started: not measured');
    expect(lineOf(late, 'T01-2')!.props.title).toBe('Not measured: the driver tapped Back at depot of L1 after this trip had already started.');
    const none = await mount({ L2: { afterLoadNo: 1, backAt: '2026-10-16T07:20:00.000Z', leftAt: null, how: null, tapLate: false, minutes: 0, final: false, notMeasured: 'NO_LEAVE', line: 'back 11:20, no leave recorded' } });
    expect(textOf(lineOf(none, 'T01-2')!)).toBe('After L1: back 11:20, no leave recorded');
    expect(lineOf(none, 'T01-2')!.props.title).toContain('nothing says when it left');
  });

  it('while the truck is still at the depot: the minutes so far; nothing when the server knows no turnaround', async () => {
    const waiting = await mount({ L2: { afterLoadNo: 1, backAt: '2026-10-16T07:20:00.000Z', leftAt: null, how: null, tapLate: false, minutes: 25, final: false, line: 'back 11:20, not left yet, 25 min so far' } });
    expect(textOf(lineOf(waiting, 'T01-2'))).toBe('After L1: back 11:20, not left yet, 25 min so far');
    const none = await mount({});
    expect(lineOf(none, 'T01-2')).toBeNull();
  });
});

describe("dates on the bell and the Alerts page (owner request 19 Oct 2026: yesterday's alerts looked like today's)", () => {
  const MCT = 'Asia/Muscat';

  it("today's alert keeps the time only; another day's says its day: Yesterday, Tomorrow, or the date", () => {
    // 16 Oct 09:30 in Muscat.
    const at = '2026-10-16T05:30:00.000Z';
    expect(alertWhen(at, '2026-10-16', MCT, '2026-10-16')).toBe('09:30');
    expect(alertWhen(at, '2026-10-16', MCT, '2026-10-17')).toBe('Yesterday 09:30');
    expect(alertWhen(at, '2026-10-16', MCT, '2026-10-18')).toBe('16 Oct 09:30');
    expect(alertWhen(at, '2026-10-16', MCT, '2026-10-15')).toBe('Tomorrow 09:30');
    expect([alertWhen(null, '2026-10-16', MCT, '2026-10-16'), alertWhen('not a time', '2026-10-16', MCT, '2026-10-16')]).toEqual(['', '']);
    expect([alertDayWord('2026-10-16', '2026-10-16'), alertDayWord('2026-10-15', '2026-10-16'), alertDayWord('2026-10-17', '2026-10-16'), alertDayWord('2026-09-30', '2026-10-16')]).toEqual([null, 'Yesterday', 'Tomorrow', '30 Sep']);
    // Across a month and a year end.
    expect(alertDayWord('2026-12-31', '2027-01-01')).toBe('Yesterday');
    expect(alertWhen('2026-12-30T10:00:00.000Z', '2026-12-30', MCT, '2027-01-01')).toBe('30 Dec 14:00');
  });

  it('across midnight: 23:59 is still the day, 00:01 is the next; a time not of today says its own day', () => {
    // 16 Oct 23:59 and 17 Oct 00:01 in Muscat.
    const late = '2026-10-16T19:59:00.000Z';
    const early = '2026-10-16T20:01:00.000Z';
    expect(alertWhen(late, '2026-10-16', MCT, '2026-10-16')).toBe('23:59');
    expect(alertWhen(late, '2026-10-16', MCT, '2026-10-17')).toBe('Yesterday 23:59');
    expect(alertWhen(early, '2026-10-17', MCT, '2026-10-17')).toBe('00:01');
    // Yesterday's alert whose time is after midnight (the day's last load), and tomorrow's seen this evening.
    expect(alertWhen(early, '2026-10-16', MCT, '2026-10-17')).toBe('Today 00:01');
    expect(alertWhen(late, '2026-10-17', MCT, '2026-10-16')).toBe('Today 23:59');
    // An alert of today whose time was yesterday evening says so.
    expect(alertWhen(late, '2026-10-17', MCT, '2026-10-17')).toBe('Yesterday 23:59');
  });

  it("the company's time zone decides, not UTC, the server or the browser; a summer-time change does not move the clock", () => {
    const instant = '2026-10-16T20:30:00.000Z';
    // Muscat (UTC+4): 17 Oct 00:30. New York (UTC-4): 16 Oct 16:30. Kolkata (UTC+5:30): 17 Oct 02:00.
    expect(alertWhen(instant, '2026-10-17', MCT, '2026-10-17')).toBe('00:30');
    expect(alertWhen(instant, '2026-10-16', 'America/New_York', '2026-10-17')).toBe('Yesterday 16:30');
    expect(alertWhen(instant, '2026-10-17', 'Asia/Kolkata', '2026-10-17')).toBe('02:00');
    // London goes back from summer time at 02:00 on 25 Oct 2026: 12:00 UTC that day is 12:00 on the clock.
    expect(alertWhen('2026-10-25T12:00:00.000Z', '2026-10-25', 'Europe/London', '2026-10-26')).toBe('Yesterday 12:00');
    expect(alertWhen('2026-10-25T00:30:00.000Z', '2026-10-25', 'Europe/London', '2026-10-25')).toBe('01:30');
  });

  it('the state words say the day of a time that is not today; a row closed at the end of its day says so, with who acknowledged it', () => {
    const acked = row({ state: 'ACKED', ackedAt: '2026-10-16T06:42:00.000Z', ackedByName: 'Sam Example' });
    expect(alertStateText(acked, MCT, '2026-10-16')).toBe('Acknowledged by Sam Example 10:42');
    expect(alertStateText(acked, MCT, '2026-10-17')).toBe('Acknowledged by Sam Example yesterday 10:42');
    const over = row({ state: 'RESOLVED', resolvedAt: '2026-10-16T06:50:00.000Z', resolvedReason: 'ENDED' });
    expect(alertStateText(over, MCT, '2026-10-16')).toBe('Over 10:50');
    expect(alertStateText(over, MCT, '2026-10-18')).toBe('Over 16 Oct 10:50');
    expect(alertStateText(row({ state: 'RESOLVED', resolvedAt: '2026-10-16T20:02:00.000Z', resolvedReason: 'ENDED' }), MCT, '2026-10-17')).toBe('Over today 00:02');
    const dayEnded = row({ state: 'RESOLVED', resolvedAt: '2026-10-16T20:02:00.000Z', resolvedReason: 'DAY_ENDED' });
    expect(alertStateText(dayEnded, MCT, '2026-10-17')).toBe('Day ended');
    expect(alertStateText({ ...dayEnded, ackedAt: '2026-10-16T06:42:00.000Z', ackedByName: 'Sam Example' }, MCT, '2026-10-17')).toBe('Day ended (acknowledged by Sam Example yesterday 10:42)');
    // Without today (the day screen's card, the truck's day: one day on screen) the time only, as before.
    expect(alertStateText(acked, MCT)).toBe('Acknowledged by Sam Example 10:42');
    expect(alertStateText({ ...dayEnded, ackedAt: '2026-10-16T06:42:00.000Z', ackedByName: null }, MCT)).toBe('Day ended (acknowledged 10:42)');
  });

  it('alertDayGroups: today first, then the days ahead, then the days before (latest first); no header when every row is today\'s', () => {
    const rows = [row({ id: 'y', deliveryDate: '2026-10-16' }), row({ id: 't1', deliveryDate: '2026-10-17' }), row({ id: 'n', deliveryDate: '2026-10-18' }), row({ id: 'o', deliveryDate: '2026-10-14' }), row({ id: 't2', deliveryDate: '2026-10-17' })];
    expect(alertDayGroups(rows, '2026-10-17').map((g) => [g.header, g.rows.map((r) => r.id)])).toEqual([
      ['Today', ['t1', 't2']],
      ['Tomorrow, 18 Oct', ['n']],
      ['Yesterday, 16 Oct', ['y']],
      ['14 Oct', ['o']],
    ]);
    expect(alertDayGroups([row({ id: 'a', deliveryDate: '2026-10-17' }), row({ id: 'b', deliveryDate: '2026-10-17' })], '2026-10-17')).toEqual([{ date: '2026-10-17', header: null, rows: [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })] }]);
    expect(alertDayGroups([], '2026-10-17')).toEqual([]);
    expect([alertDayHeader('2026-10-17', '2026-10-17'), alertDayHeader('2026-10-16', '2026-10-17'), alertDayHeader('2026-10-10', '2026-10-17')]).toEqual(['Today', 'Yesterday, 16 Oct', '10 Oct']);
  });

  async function mountBell() {
    const host: Host<any> = new Host(AlertBell as any, { slug: 'example', enabled: true, canAck: true, timezone: MCT });
    host.render();
    await host.settle();
    return host;
  }

  it("the bell: today's rows with the time only and no header, as before", async () => {
    net.summaries = [summary([high({ id: 'h1', deliveryDate: '2026-10-17', lastSeenAt: '2026-10-17T05:30:00.000Z' }), row({ id: 'w1', deliveryDate: '2026-10-17', lastSeenAt: '2026-10-17T06:10:00.000Z' })], { today: '2026-10-17' })];
    const host = await mountBell();
    expect(byTestId(host.tree, 'alert-bell-when').map(textOf)).toEqual(['09:30', '10:10']);
    expect(byTestId(host.tree, 'alert-bell-day')).toHaveLength(0);
  });

  it("the bell: a row of another day comes under its date header, a time not of today says its day (the company's today from the summary)", async () => {
    net.summaries = [
      summary(
        [
          high({ id: 'h1', deliveryDate: '2026-10-17', lastSeenAt: '2026-10-17T05:30:00.000Z' }),
          // Tomorrow's load already out this evening, and (between midnight and the sweep) one of yesterday.
          row({ id: 'n1', deliveryDate: '2026-10-18', lastSeenAt: '2026-10-17T18:40:00.000Z' }),
          row({ id: 'y1', deliveryDate: '2026-10-16', lastSeenAt: '2026-10-16T13:20:00.000Z' }),
        ],
        { today: '2026-10-17' },
      ),
    ];
    const host = await mountBell();
    expect(byTestId(host.tree, 'alert-bell-day').map(textOf)).toEqual(['Today', 'Tomorrow, 18 Oct', 'Yesterday, 16 Oct']);
    expect(byTestId(host.tree, 'alert-bell-when').map(textOf)).toEqual(['09:30', 'Today 22:40', 'Yesterday 17:20']);
    expect(byTestId(host.tree, 'alert-bell-row')).toHaveLength(3);
  });

  it('the Alerts page: Since and State say the day of another day\'s alert; today\'s keep the time only', async () => {
    net.list = {
      enabled: true,
      today: '2026-10-17',
      truncated: false,
      rows: [
        row({ id: 't1', deliveryDate: '2026-10-17', occurredAt: '2026-10-17T05:10:00.000Z' }),
        row({ id: 'y1', deliveryDate: '2026-10-16', occurredAt: '2026-10-16T13:20:00.000Z', state: 'RESOLVED', resolvedAt: '2026-10-16T20:02:00.000Z', resolvedReason: 'DAY_ENDED', ackedAt: '2026-10-16T14:00:00.000Z', ackedByName: 'Sam Example' }),
        row({ id: 'o1', deliveryDate: '2026-10-15', occurredAt: '2026-10-15T07:00:00.000Z', state: 'RESOLVED', resolvedAt: '2026-10-15T07:40:00.000Z', resolvedReason: 'ENDED' }),
      ],
    };
    const host: Host<any> = new Host(AlertsClient as any, { enabled: true, canAck: true, isAdmin: false, slug: 'example', timezone: MCT, today: '2026-10-17', depots: [], initial: { from: '2026-10-15', to: '2026-10-17', depotId: '', state: 'all' } });
    host.render();
    await host.settle();
    expect(net.sent[0]!.url).toBe('/api/alerts?from=2026-10-15&to=2026-10-17&state=all');
    expect(byTestId(host.tree, 'alerts-when').map(textOf)).toEqual(['09:10', 'Yesterday 17:20', '15 Oct 11:00']);
    expect(byTestId(host.tree, 'alerts-state').map(textOf)).toEqual(['Open', 'Day ended (acknowledged by Sam Example yesterday 18:00)', 'Over 15 Oct 11:40']);
  });
});

describe('the pure helpers', () => {
  it('where, state words and the bell colour', () => {
    expect(alertWhere({ truckCode: 'T05', loadNo: 1, sequence: 3 })).toBe('T05 L1 stop 3');
    expect(alertWhere({ truckCode: 'T05', loadNo: null, sequence: null })).toBe('T05');
    expect(alertStateText(row(), 'Asia/Muscat')).toBe('Open');
    expect(alertStateText(row({ state: 'ACKED', ackedAt: '2026-10-16T06:42:00.000Z', ackedByName: 'Sam Example' }), 'Asia/Muscat')).toBe('Acknowledged by Sam Example 10:42');
    expect(alertStateText(row({ state: 'RESOLVED', resolvedAt: '2026-10-16T06:50:00.000Z', resolvedReason: 'NOT_IN_PLAN' }), 'Asia/Muscat')).toBe('No longer in the plan 10:50');
    expect([bellTone({ open: 2, high: 1 }), bellTone({ open: 2, high: 0 }), bellTone({ open: 0, high: 0 })]).toEqual(['high', 'warn', 'none']);
  });

  it('newAlertToasts: the first read is silent; later only new open HIGH rows that may toast', () => {
    const first = newAlertToasts(null, [high({ id: 'x' })]);
    expect(first.toasts).toEqual([]);
    const later = newAlertToasts(first.seen, [high({ id: 'x' }), high({ id: 'y' }), high({ id: 'z', state: 'ACKED' }), row({ id: 'w' })]);
    expect(later.toasts.map((r) => r.id)).toEqual(['y']);
  });

  it('ackBody: only the open rows, each with its tier; none: nothing to send', () => {
    expect(ackBody([high({ id: 'h', tier: 3 }), row({ id: 'a', state: 'ACKED' })])).toEqual({ ids: ['h'], seen: { h: 3 } });
    expect(ackBody([row({ state: 'RESOLVED' })])).toBeNull();
  });

  it('groupByTruck: worst first, all-history trucks last', () => {
    const g = groupByTruck([row({ truckId: 'a', truckCode: 'T10' }), row({ truckId: 'b', truckCode: 'T02', state: 'RESOLVED' }), high({ truckId: 'c', truckCode: 'T11' })]);
    expect(g.map((x) => [x.truckCode, x.worst])).toEqual([
      ['T11', 'HIGH'],
      ['T10', 'WARN'],
      ['T02', null],
    ]);
  });

  it('the settings card: the meaning with the threshold, and the same checks as the API', () => {
    expect(ruleMeaning(ALERT_RULE_SPECS.LOADING_OVER, 40)).toContain('has not left with its next load 40 min after the driver tapped Back at depot');
    expect(ruleMeaning(ALERT_RULE_SPECS.PRIORITY_NOT_DELIVERED, null)).toContain('priority 2 or better');
    const c = {
      alertsEnabled: true,
      alertUnloadOverMin: 30,
      alertLoadingOverMin: null,
      alertEtaLateMin: 30,
      alertDepartLateMin: 30,
      alertSilentMin: 120,
      alertPageNotOpenedMin: 30,
      alertAfterClosingMin: 15,
      alertPriorityMax: 2,
      alertDeliveredNote: true,
      alertProofFarM: 500,
      alertNotClosedMin: 120,
      alertEmails: 'owner@company.example',
      alertEmailEveryMin: 15,
      alertEmailMinSeverity: 'HIGH',
      alertQuietFromMin: 1320,
      alertQuietToMin: 360,
    };
    expect(alertSettingsProblem({ alertUnloadOverMin: 30 }, c)).toBeNull();
    expect(alertSettingsProblem({ alertUnloadOverMin: 4 }, { ...c, alertUnloadOverMin: 4 })).toBe('R1 Unloading longer than planned: a whole number from 5 to 480 min.');
    expect(alertSettingsProblem({ alertEtaLateMin: Number.NaN }, { ...c, alertEtaLateMin: Number.NaN })).toMatch(/^R3 Running late/);
    expect(alertSettingsProblem({ alertLoadingOverMin: null }, c)).toBeNull();
    expect(alertSettingsProblem({ alertEmails: 'a@x.example, nope' }, { ...c, alertEmails: 'a@x.example, nope' })).toMatch(/^Alert e-mail recipients: "nope" is not an e-mail address/);
    expect(alertSettingsProblem({ alertEmailEveryMin: 241 }, { ...c, alertEmailEveryMin: 241 })).toMatch(/0 = no e-mail/);
    expect(alertSettingsProblem({ alertQuietToMin: null }, { ...c, alertQuietToMin: null })).toMatch(/both a start and an end/);
    // A stored value that is out of bounds does not block saving another field.
    expect(alertSettingsProblem({ alertSilentMin: 120 }, { ...c, alertUnloadOverMin: 4 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Cause & action (owner request 20 Oct 2026: "a place where a note / reason for the alert to have happened and
// the solution ... entered by someone after checking"), with the critique of the design applied.
// ---------------------------------------------------------------------------------------------

const rv = (extra: Partial<NonNullable<OpsAlertRow['review']>> = {}): NonNullable<OpsAlertRow['review']> => ({
  cause: 'TRAFFIC',
  causeOther: null,
  action: 'CALLED_DRIVER',
  actionOther: null,
  note: 'Road works',
  followUp: false,
  firstAt: '2026-10-16T06:30:00.000Z',
  savedAt: '2026-10-16T07:00:00.000Z',
  byName: 'Lee Example',
  firstByName: 'Lee Example',
  saves: 1,
  groupId: null,
  tier: 1,
  occurrences: 1,
  customerId: null,
  ...extra,
});
const dialogOf = (tree: unknown) => elements(tree).find((e) => typeName(e) === 'AlertReviewDialog');

describe('cause & action on the Alerts page, the day card and the bell', () => {
  const list = (rows: OpsAlertRow[], extra: Record<string, unknown> = {}) => ({ enabled: true, today: '2026-10-16', truncated: false, rows, reviewCounts: { alerts: 3, saved: 1, other: 0, followUp: 1 }, ...extra });
  async function mountPage(props: Record<string, unknown> = {}) {
    const host: Host<any> = new Host(AlertsClient as any, { enabled: true, canAck: true, isAdmin: false, slug: 'example', timezone: 'Asia/Muscat', today: '2026-10-16', depots: [], initial: { from: '2026-10-16', to: '2026-10-16', depotId: '', state: 'all' }, ...props });
    host.render();
    await host.settle();
    return host;
  }
  const rows = () => [
    row({ id: 'o' }),
    row({ id: 'a', state: 'ACKED', ackedAt: '2026-10-16T05:40:00.000Z', ackedByName: 'Sam Example' }),
    row({ id: 'r', state: 'RESOLVED', resolvedAt: '2026-10-16T20:02:00.000Z', resolvedReason: 'DAY_ENDED', review: rv({ followUp: true, note: 'Road works near the gate' }) }),
  ];

  it("the dispatcher gets Cause & action under the text of every alert (open, acknowledged, over), the server's count line and the Excel; the dialog edits a snapshot", async () => {
    net.list = list(rows());
    const host = await mountPage();
    expect(byTestId(host.tree, 'alerts-review').map(textOf)).toEqual(['Cause & action', 'Cause & action', 'Edit cause & action']);
    const line = textOf(byTestId(host.tree, 'alerts-review-line')[0]);
    expect(line).toContain('Cause: Traffic or road delay · Action: Called the driver · Lee Example 11:00');
    expect(line).toContain('Note: Road works near the gate');
    expect(byTestId(host.tree, 'alerts-review-followup')).toHaveLength(1);
    expect(textOf(byTestId(host.tree, 'alerts-review-count')[0])).toBe('1 of 3 alerts of these dates has a cause & action · 1 to follow up (last 92 days)');
    expect(byTestId(host.tree, 'alerts-excel')[0]!.props.href).toBe('/api/analysis/export?from=2026-10-16&to=2026-10-16&only=alerts');
    expect(dialogOf(host.tree)!.props.target).toBeNull();
    byTestId(host.tree, 'alerts-review')[0]!.props.onClick();
    host.flush();
    expect(dialogOf(host.tree)!.props.target.id).toBe('o');
    expect(dialogOf(host.tree)!.props.related.map((r: OpsAlertRow) => r.id)).toEqual(['o', 'a', 'r']);
    // The 60 s poll brings new rows: the dialog keeps the snapshot it was opened with.
    net.list = list(rows().map((r) => ({ ...r, text: 'changed meanwhile' })));
    polls[0]!();
    await host.settle();
    expect(dialogOf(host.tree)!.props.target.text).toBe('T05 L1 is running about 35 min late.');
  });

  it('a viewer sees the cause & action but no button, no Excel and no dialog', async () => {
    net.list = list(rows());
    const host = await mountPage({ canAck: false });
    expect(byTestId(host.tree, 'alerts-review')).toHaveLength(0);
    expect(byTestId(host.tree, 'alerts-excel')).toHaveLength(0);
    expect(byTestId(host.tree, 'alerts-review-line')).toHaveLength(1);
    expect(dialogOf(host.tree)).toBeUndefined();
  });

  it('the filter sends review=; Follow-up says it reads the last 92 days; the Other share is in the count line', async () => {
    net.list = list([], { reviewCounts: { alerts: 10, saved: 4, other: 2, followUp: 0 } });
    const host = await mountPage();
    expect(textOf(byTestId(host.tree, 'alerts-review-count')[0])).toBe('4 of 10 alerts of these dates have a cause & action (2 say Other: worth a code of its own when it comes back often) · 0 to follow up (last 92 days)');
    byTestId(host.tree, 'alerts-review-filter')[0]!.props.onChange({ target: { value: 'missing' } });
    await host.settle();
    expect(net.sent.at(-1)!.url).toBe('/api/alerts?from=2026-10-16&to=2026-10-16&state=all&review=missing');
    byTestId(host.tree, 'alerts-review-filter')[0]!.props.onChange({ target: { value: 'followup' } });
    await host.settle();
    expect(net.sent.at(-1)!.url).toContain('review=followup');
    expect(byTestId(host.tree, 'alerts-followup-note')).toHaveLength(1);
  });

  it("the bell's link (reviewId) opens that alert's dialog once its row is read", async () => {
    net.list = list(rows());
    const host = await mountPage({ initialReviewId: 'r' });
    expect(dialogOf(host.tree)!.props.target.id).toBe('r');
  });

  it('the day card: the saved line, and a Cause & action button on each row shown for the dispatcher', async () => {
    net.list = list(rows());
    const host: Host<any> = new Host(AlertsCard as any, { slug: 'example', date: '2026-10-16', depotId: 'dep1', today: '2026-10-16', timezone: 'Asia/Muscat', canAck: true, enabled: true });
    host.render();
    await host.settle();
    expect(byTestId(host.tree, 'alerts-card-review').map(textOf)).toEqual(['Cause & action', 'Cause & action']);
    byTestId(host.tree, 'alerts-card-show-over')[0]!.props.onClick();
    host.flush();
    expect(byTestId(host.tree, 'alerts-card-review').map(textOf)).toEqual(['Cause & action', 'Cause & action', 'Edit cause']);
    expect(textOf(byTestId(host.tree, 'alerts-card-review-line')[0])).toBe('Cause: Traffic or road delay · Action: Called the driver · Lee Example 11:00 · follow-up');
    byTestId(host.tree, 'alerts-card-review')[2]!.props.onClick();
    host.flush();
    expect(dialogOf(host.tree)!.props.target.id).toBe('r');
  });

  it('the bell: who saved a cause & action (two dispatchers do not both call the driver), and a link to record one', async () => {
    net.summaries = [summary([high({ id: 'h1' }), high({ id: 'h2', review: rv() })], { today: '2026-10-16' })];
    const host: Host<any> = new Host(AlertBell as any, { slug: 'example', enabled: true, canAck: true, timezone: 'Asia/Muscat' });
    host.render();
    await host.settle();
    expect(byTestId(host.tree, 'alert-bell-review').map((l) => [l.props.href, textOf(l)])).toEqual([
      ['/t/example/alerts?date=2026-10-16&reviewId=h1', 'Cause & action'],
      ['/t/example/alerts?date=2026-10-16&reviewId=h2', 'Edit cause & action'],
    ]);
    expect(byTestId(host.tree, 'alert-bell-review-line').map(textOf)).toEqual(['Cause & action saved by Lee Example: Traffic or road delay']);
    net.summaries = [summary([high({ id: 'h2', review: rv() })])];
    const viewer: Host<any> = new Host(AlertBell as any, { slug: 'example', enabled: true, canAck: false, timezone: 'Asia/Muscat' });
    viewer.render();
    await viewer.settle();
    expect(byTestId(viewer.tree, 'alert-bell-review')).toHaveLength(0);
    expect(byTestId(viewer.tree, 'alert-bell-review-line')).toHaveLength(1);
  });
});

describe('the Cause & action dialog', () => {
  async function mount(target: OpsAlertRow, related: OpsAlertRow[] = [], canAck = true) {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    const host: Host<any> = new Host(AlertReviewDialog as any, { target, related, timezone: 'Asia/Muscat', today: '2026-10-16', canAck, onClose, onSaved });
    host.render();
    await host.settle();
    return { host, onClose, onSaved };
  }
  const pick = (host: Host<any>, id: string, value: string) => {
    byTestId(host.tree, id)[0]!.props.onChange({ target: { value } });
    host.flush();
  };
  const value = (host: Host<any>, id: string) => byTestId(host.tree, id)[0]?.props.value;
  const problem = (host: Host<any>) => textOf(byTestId(host.tree, 'alert-review-problem')[0]);
  const saveOff = (host: Host<any>) => byTestId(host.tree, 'alert-review-save')[0]!.props.disabled;
  const saved = (r: OpsAlertRow) => ({ row: r, changed: true, also: [], skipped: [] });

  it("starts empty (a default would skew the counts): the rule's own lists; Save waits for both codes; Other needs its text; Nothing yet turns follow-up on", async () => {
    const { host } = await mount(row({ id: 'a1' }));
    expect([value(host, 'alert-review-cause'), value(host, 'alert-review-action')]).toEqual(['', '']);
    const options = elements(byTestId(host.tree, 'alert-review-cause')[0]).filter((e) => e.type === 'option').map((e) => e.props.value);
    expect(options[0]).toBe('');
    expect(options.slice(1)).toEqual([
      'TRAFFIC', 'EARLIER_STOPS_LONG', 'LATE_DEPOT_START', 'NO_CREW', 'LOADING_DELAY', 'WAITING_AT_CUSTOMER', 'LONG_UNLOADING', 'CUSTOMER_NOT_READY', 'CUSTOMER_CLOSED',
      'CUSTOMER_ASKED_OTHER_TIME', 'ACCESS_PROBLEM', 'WRONG_PIN', 'OUT_OF_TIME', 'DRIVER_BREAK', 'TRUCK_BREAKDOWN', 'PLAN_CHANGED', 'PLAN_WRONG', 'DRIVER_DID_NOT_TAP',
      'NEW_DRIVER', 'GPS_ISSUE', 'SETTING_TOO_TIGHT', 'FALSE_ALARM', 'NOT_KNOWN', 'OTHER',
    ]);
    expect(problem(host)).toBe('Pick the main cause.');
    expect(saveOff(host)).toBe(true);
    pick(host, 'alert-review-cause', 'OTHER');
    expect(byTestId(host.tree, 'alert-review-cause-other')).toHaveLength(1);
    pick(host, 'alert-review-action', 'NONE_YET');
    const follow = byTestId(host.tree, 'alert-review-followup')[0]!.props;
    expect([follow.checked, follow.disabled]).toEqual([true, true]);
    expect(problem(host)).toBe('Write the other cause (at least 3 characters).');
    pick(host, 'alert-review-cause-other', 'Gate locked');
    expect(problem(host)).toBe('');
    expect(saveOff(host)).toBe(false);
  });

  it('seeded from the saved one; Save sends the codes, the texts and the last save it saw; Acknowledge it too at the tier the dialog showed', async () => {
    const target = high({ id: 'h1', tier: 2, review: rv() });
    const { host, onClose, onSaved } = await mount(target);
    expect([value(host, 'alert-review-cause'), value(host, 'alert-review-action'), value(host, 'alert-review-note')]).toEqual(['TRAFFIC', 'CALLED_DRIVER', 'Road works']);
    expect(textOf(byTestId(host.tree, 'alert-review-last')[0])).toContain('Last saved by Lee Example 11:00');
    expect(byTestId(host.tree, 'alert-review-ack')[0]!.props.checked).toBe(true);
    pick(host, 'alert-review-note', 'Road works, gate closed');
    // The alert got worse meanwhile (tier 3): the acknowledgement names the tier shown, so it stays open.
    net.patches = [saved({ ...target, tier: 3, review: rv({ note: 'Road works, gate closed', savedAt: '2026-10-16T07:30:00.000Z', saves: 2 }) })];
    byTestId(host.tree, 'alert-review-save')[0]!.props.onClick();
    await host.settle();
    expect(net.sent.find((s) => s.method === 'PATCH')!.json).toEqual({ id: 'h1', baseReviewedAt: '2026-10-16T07:00:00.000Z', cause: 'TRAFFIC', action: 'CALLED_DRIVER', note: 'Road works, gate closed', followUp: false });
    expect(net.sent.find((s) => s.url === '/api/alerts/ack')!.json).toEqual({ ids: ['h1'], seen: { h1: 2 } });
    expect(toasts.success).toContain('Cause & action saved.');
    expect([onClose.mock.calls.length, onSaved.mock.calls.length]).toEqual([1, 1]);
  });

  it('someone saved meanwhile: the draft stays, the dialog says what was saved, and the next Save replaces it', async () => {
    const target = row({ id: 'a1' });
    const { host, onClose } = await mount(target);
    pick(host, 'alert-review-cause', 'TRAFFIC');
    pick(host, 'alert-review-action', 'CALLED_DRIVER');
    pick(host, 'alert-review-note', 'mine');
    net.patches = [
      { status: 409, error: { code: 'REVIEW_CHANGED', message: 'Someone saved a cause & action for this alert meanwhile.', row: { ...target, review: rv({ cause: 'WRONG_PIN', action: 'FIXED_PIN', savedAt: '2026-10-16T07:05:00.000Z' }) } } },
      saved({ ...target, review: rv({ note: 'mine' }) }),
    ];
    byTestId(host.tree, 'alert-review-save')[0]!.props.onClick();
    await host.settle();
    expect(textOf(byTestId(host.tree, 'alert-review-notice')[0])).toBe('Saved meanwhile by Lee Example 11:05: cause "Wrong pin or address", action "Fixed the pin". Saving again replaces it.');
    expect([value(host, 'alert-review-cause'), value(host, 'alert-review-note')]).toEqual(['TRAFFIC', 'mine']);
    expect(onClose).not.toHaveBeenCalled();
    byTestId(host.tree, 'alert-review-save')[0]!.props.onClick();
    await host.settle();
    expect(net.sent.filter((s) => s.method === 'PATCH').map((s) => (s.json as { baseReviewedAt: string | null }).baseReviewedAt)).toEqual([null, '2026-10-16T07:05:00.000Z']);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the busy sweep keeps the draft and says so', async () => {
    const { host, onClose } = await mount(row({ id: 'a1' }));
    pick(host, 'alert-review-cause', 'TRAFFIC');
    pick(host, 'alert-review-action', 'CALLED_DRIVER');
    net.patches = [{ status: 409, error: { code: 'ALERT_BUSY', message: 'The alerts are being checked right now: save again in a moment.' } }];
    byTestId(host.tree, 'alert-review-save')[0]!.props.onClick();
    await host.settle();
    expect(toasts.warning).toEqual(['The alerts are being checked right now: save again in a moment.']);
    expect(value(host, 'alert-review-cause')).toBe('TRAFFIC');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('one incident: the other alerts of the truck and day without one, unticked; those whose rule does not offer the codes cannot be ticked', async () => {
    const target = row({ id: 'a1', state: 'ACKED' });
    const related = [target, row({ id: 'a2', rule: 'DRIVER_SILENT' }), row({ id: 'a3', rule: 'PROOF_FAR', kind: 'EVENT' }), row({ id: 'a4', truckId: 'tr9' }), row({ id: 'a5', review: rv() }), row({ id: 'a6', deliveryDate: '2026-10-15' })];
    expect(incidentAlerts(target, related).map((r) => r.id)).toEqual(['a2', 'a3']);
    const { host } = await mount(target, related);
    // Acknowledged already: no "Acknowledge it too".
    expect(byTestId(host.tree, 'alert-review-ack')).toHaveLength(0);
    pick(host, 'alert-review-cause', 'TRUCK_BREAKDOWN');
    pick(host, 'alert-review-action', 'SENT_HELP');
    const items = () => byTestId(host.tree, 'alert-review-also-item').map((c) => [c.props['data-id'], c.props.checked, c.props.disabled]);
    expect(items()).toEqual([
      ['a2', false, false],
      ['a3', false, true],
    ]);
    byTestId(host.tree, 'alert-review-also-item')[0]!.props.onCheckedChange(true);
    host.flush();
    net.patches = [{ row: { ...target, review: rv() }, changed: true, also: ['a2'], skipped: [] }];
    byTestId(host.tree, 'alert-review-save')[0]!.props.onClick();
    await host.settle();
    expect((net.sent.find((s) => s.method === 'PATCH')!.json as { alsoIds: string[] }).alsoIds).toEqual(['a2']);
    expect(toasts.success).toContain('Cause & action saved (also on 1 other alert).');
  });

  it('Remove (saved on the wrong alert) names the last save; an alert older than 90 days is read-only', async () => {
    const { host, onSaved } = await mount(row({ id: 'a1', review: rv() }));
    net.patches = [saved(row({ id: 'a1' }))];
    byTestId(host.tree, 'alert-review-remove')[0]!.props.onClick();
    await host.settle();
    expect(net.sent.find((s) => s.method === 'PATCH')!.json).toEqual({ id: 'a1', baseReviewedAt: '2026-10-16T07:00:00.000Z', remove: true });
    expect(toasts.success).toContain('Cause & action removed.');
    expect(onSaved).toHaveBeenCalledTimes(1);
    const old = await mount(row({ id: 'o1', text: '', detailsRemoved: true, review: rv() }));
    expect(byTestId(old.host.tree, 'alert-review-save')).toHaveLength(0);
    expect(byTestId(old.host.tree, 'alert-review-remove')).toHaveLength(0);
    expect(byTestId(old.host.tree, 'alert-review-readonly')).toHaveLength(1);
    expect(textOf(byTestId(old.host.tree, 'alert-review-alert')[0])).toContain('Details removed after 90 days');
  });
});
