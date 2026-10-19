/**
 * The salesman link page's state (app/s/[token]/use-sales-view.ts) on the REAL hook through the hook host
 * (hook-host.ts): the browser is replaced by fakes (the request, storage, clock, timers, events, URL).
 *
 *  - The route: the link's fragment first ("/s/<token>#R1", critique 20), else the browser's saved route, else the
 *    form; a path without a token is "link does not work" without a request.
 *  - Found routes are followed every `refreshSec` while the page is visible and when it comes back; only the codes
 *    FOUND are asked again (an unknown code counts against the link's limit: never re-asked); nothing found goes
 *    back to the form with the server's words and forgets the saved code.
 *  - A link that does not work stops everything; 429 waits Retry-After; a failed refresh keeps the data shown;
 *    the newest request wins (an answer for the route left behind is dropped); Change route drops the fragment.
 */
import { describe, expect, it, vi } from 'vitest';
import { Host, deferred } from './hook-host';
import { TOKEN, answer, lookup, routeView } from './sales-page-fixture';
import type { SalesAnswer } from '@/lib/sales-page/api';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));

import { useSalesView, WAKE_MIN_MS, refreshMsOf, type SalesViewDeps, type SalesViewState } from '@/app/s/[token]/use-sales-view';

type Answerer = (route: string | null) => SalesAnswer | Promise<SalesAnswer>;

const ok = (routes: string[], over: Parameters<typeof lookup>[1] = {}): SalesAnswer => ({ kind: 'ok', answer: answer(routes.length || over.notFound ? lookup(routes.map((r) => routeView(r)), over) : null) });
const metaOnly: SalesAnswer = { kind: 'ok', answer: answer(null) };

function world(o: { path?: string; hash?: string; saved?: string; answer: Answerer }) {
  const calls: (string | null)[] = [];
  const data: Record<string, string> = o.saved ? { 'riq.s.route': o.saved } : {};
  let now = 1_000_000;
  let visible = true;
  const timers: { fn: () => void; ms: number; on: boolean }[] = [];
  const every: { fn: () => void; ms: number; on: boolean }[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const location = { pathname: o.path ?? `/s/${TOKEN}`, hash: o.hash ?? '', search: '' };
  const replaced: string[] = [];
  let answerer = o.answer;
  const deps: SalesViewDeps = {
    fetchView: async (token, device, route) => {
      expect(token).toBe(TOKEN);
      expect(device).toMatch(/^[0-9a-f]{32}$/);
      calls.push(route);
      return answerer(route);
    },
    storage: {
      getItem: (k) => (k in data ? data[k]! : null),
      setItem: (k, v) => {
        data[k] = String(v);
      },
      removeItem: (k) => {
        delete data[k];
      },
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, ms, on: true };
      timers.push(t);
      return () => {
        t.on = false;
      };
    },
    setEvery: (fn, ms) => {
      const t = { fn, ms, on: true };
      every.push(t);
      return () => {
        t.on = false;
      };
    },
    location,
    replaceUrl: (url) => {
      replaced.push(url);
      location.hash = '';
    },
    visible: () => visible,
    on: (target, event, fn) => {
      const k = `${target}:${event}`;
      if (!listeners.has(k)) listeners.set(k, new Set());
      listeners.get(k)!.add(fn);
      return () => listeners.get(k)!.delete(fn);
    },
  };
  const Probe = (p: { deps: SalesViewDeps }) => useSalesView(p.deps);
  const host = new Host(Probe as never, { deps });
  const api = () => host.tree as ReturnType<typeof useSalesView>;
  return {
    calls,
    data,
    replaced,
    timers,
    every,
    location,
    host,
    state: (): SalesViewState => api().state,
    api,
    set answer(a: Answerer) {
      answerer = a;
    },
    async mount() {
      host.render();
      await host.settle();
    },
    advance(ms: number) {
      now += ms;
    },
    setVisible(v: boolean) {
      visible = v;
    },
    /** The repeating refresh fires (as the browser's interval would). */
    async tick() {
      for (const t of every.filter((x) => x.on)) t.fn();
      await host.settle();
    },
    async fire(target: 'window' | 'document', event: string) {
      for (const fn of [...(listeners.get(`${target}:${event}`) ?? [])]) fn();
      await host.settle();
    },
    async runTimers() {
      for (const t of timers.filter((x) => x.on)) {
        t.on = false;
        t.fn();
      }
      await host.settle();
    },
    async act(fn: (a: ReturnType<typeof useSalesView>) => void) {
      fn(api());
      host.flush();
      await host.settle();
    },
  };
}

describe('where the route comes from', () => {
  it('a path without a token: "link does not work", no request', async () => {
    const w = world({ path: '/s/short', answer: () => metaOnly });
    await w.mount();
    expect(w.state()).toMatchObject({ phase: 'link', linkCode: 'LINK_NOT_FOUND' });
    expect(w.calls).toEqual([]);
  });

  it('no fragment and nothing saved: the day\'s header, then the route form', async () => {
    const w = world({ answer: () => metaOnly });
    await w.mount();
    expect(w.calls).toEqual([null]);
    expect(w.state()).toMatchObject({ phase: 'form', formError: null });
    expect(w.state().meta?.company).toBe('Example Water Co');
    // Nothing is followed: no refresh asks for anything.
    await w.tick();
    expect(w.calls).toEqual([null]);
  });

  it('the fragment wins over the saved route; the route found is saved as the day stores it', async () => {
    const w = world({ hash: '#r%202x', saved: 'R1', answer: (r) => (r === 'r 2x' ? ok(['R2X']) : ok([])) });
    await w.mount();
    expect(w.calls).toEqual(['r 2x']);
    expect(w.state().phase).toBe('ready');
    expect(w.state().lookup?.routes.map((r) => r.route)).toEqual(['R2X']);
    expect(w.data['riq.s.route']).toBe('R2X');
  });

  it('the saved route when there is no fragment', async () => {
    const w = world({ saved: 'R1', answer: () => ok(['R1']) });
    await w.mount();
    expect(w.calls).toEqual(['R1']);
    expect(w.state().phase).toBe('ready');
  });

  it('another route\'s link opened in the same tab (#R2X) is asked for', async () => {
    const w = world({ saved: 'R1', answer: (r) => ok([r === 'R2X' ? 'R2X' : 'R1']) });
    await w.mount();
    w.location.hash = '#R2X';
    await w.fire('window', 'hashchange');
    expect(w.calls).toEqual(['R1', 'R2X']);
    expect(w.state().lookup?.routes[0]?.route).toBe('R2X');
    // The same route again: nothing asked.
    await w.fire('window', 'hashchange');
    expect(w.calls).toEqual(['R1', 'R2X']);
  });
});

describe('following the routes found', () => {
  it('refreshes every refreshSec while visible, asking only the codes found; a code not found is shown once and never asked again', async () => {
    const w = world({ answer: () => metaOnly });
    await w.mount();
    w.answer = (r) => (r === 'R1, R9' ? ok(['R1'], { asked: ['R1', 'R9'], notFound: ['R9'], notFoundText: 'No deliveries for route R9 on Mon 19 Oct. Check the code on your Salesman ETA page.' }) : ok(['R1']));
    await w.act((a) => a.submit(' r1 , r9 '));
    expect(w.calls).toEqual([null, 'R1, R9']);
    expect(w.state().phase).toBe('ready');
    expect(w.state().notice).toMatch(/No deliveries for route R9/);
    expect(w.data['riq.s.route']).toBe('R1');
    expect(w.every.filter((e) => e.on).map((e) => e.ms)).toEqual([60_000]);

    await w.tick();
    expect(w.calls).toEqual([null, 'R1, R9', 'R1']);
    // The notice of the first answer stays until the route changes.
    expect(w.state().notice).toMatch(/R9/);

    // Hidden: no refresh.
    w.setVisible(false);
    await w.tick();
    expect(w.calls).toHaveLength(3);
    // Back in front: at once, when the last request is old enough.
    w.setVisible(true);
    w.advance(WAKE_MIN_MS - 1);
    await w.fire('document', 'visibilitychange');
    expect(w.calls).toHaveLength(3);
    w.advance(1);
    await w.fire('document', 'visibilitychange');
    expect(w.calls).toHaveLength(4);
    w.advance(WAKE_MIN_MS);
    await w.fire('window', 'online');
    expect(w.calls).toHaveLength(5);
  });

  it('the refresh period follows the server, within 30 s and 10 min', () => {
    expect(refreshMsOf(null)).toBe(60_000);
    expect(refreshMsOf({ refreshSec: 60 })).toBe(60_000);
    expect(refreshMsOf({ refreshSec: 5 })).toBe(30_000);
    expect(refreshMsOf({ refreshSec: 3600 })).toBe(600_000);
  });

  it('nothing found: back to the form with the server\'s words; the saved code is forgotten and nothing is followed', async () => {
    const w = world({ saved: 'R9', answer: () => ok([], { asked: ['R9'], notFound: ['R9'], notFoundText: 'No deliveries for route R9 on Mon 19 Oct. Check the code on your Salesman ETA page.' }) });
    await w.mount();
    expect(w.state()).toMatchObject({ phase: 'form', formText: 'R9' });
    expect(w.state().formError).toMatch(/No deliveries for route R9/);
    expect(w.data['riq.s.route']).toBeUndefined();
    expect(w.every.filter((e) => e.on)).toEqual([]);
    await w.tick();
    expect(w.calls).toEqual(['R9']);
  });

  it('the form checks the code first: empty or too many codes are never sent', async () => {
    const w = world({ answer: () => metaOnly });
    await w.mount();
    await w.act((a) => a.submit('   '));
    expect(w.state().formError).toBe('Type your route code.');
    await w.act((a) => a.submit('R1, R2, R3, R4, R5, R6'));
    expect(w.state().formError).toBe('At most 5 route codes at once.');
    expect(w.calls).toEqual([null]);
    w.answer = () => ({ kind: 'badCode', code: 'ROUTE_CODE_TOO_LONG', message: 'That route code is too long.' });
    await w.act((a) => a.submit('R1'));
    expect(w.state()).toMatchObject({ phase: 'form', formError: 'That route code is too long.' });
  });

  it('Change route: back to the form with the codes, nothing kept, the fragment dropped, an answer still on its way ignored', async () => {
    const w = world({ hash: '#R1', answer: () => ok(['R1']) });
    await w.mount();
    expect(w.state().phase).toBe('ready');
    const late = deferred<SalesAnswer>();
    w.answer = () => late.promise;
    await w.act((a) => a.refresh());
    await w.act((a) => a.changeRoute());
    expect(w.state()).toMatchObject({ phase: 'form', formText: 'R1', lookup: null });
    expect(w.data['riq.s.route']).toBeUndefined();
    expect(w.replaced).toEqual([`/s/${TOKEN}`]);
    late.resolve(ok(['R1']));
    await w.host.settle();
    expect(w.state().phase).toBe('form');
    // No refresh in the form.
    await w.tick();
    expect(w.calls).toEqual(['R1', 'R1']);
  });
});

describe('when things go wrong', () => {
  it('a link that does not work (replaced, revoked, expired) stops everything', async () => {
    const w = world({ saved: 'R1', answer: () => ok(['R1']) });
    await w.mount();
    w.answer = () => ({ kind: 'link', status: 410, code: 'LINK_REPLACED', date: '2026-10-19' });
    await w.tick();
    expect(w.state()).toMatchObject({ phase: 'link', linkCode: 'LINK_REPLACED', linkDate: '2026-10-19' });
    await w.tick();
    w.advance(WAKE_MIN_MS);
    await w.fire('document', 'visibilitychange');
    await w.act((a) => a.submit('R1'));
    expect(w.calls).toEqual(['R1', 'R1']);
  });

  it('429 at the start: waits Retry-After, then asks again by itself', async () => {
    const w = world({ saved: 'R1', answer: () => ({ kind: 'busy', retryAfterSec: 30 }) });
    await w.mount();
    expect(w.state()).toMatchObject({ phase: 'loading', waitSec: 30 });
    expect(w.timers.filter((t) => t.on).map((t) => t.ms)).toEqual([30_000]);
    w.answer = () => ok(['R1']);
    w.advance(30_000);
    await w.runTimers();
    expect(w.calls).toEqual(['R1', 'R1']);
    expect(w.state()).toMatchObject({ phase: 'ready', waitSec: null });
  });

  it('429 on a refresh: no request until the wait is over', async () => {
    const w = world({ saved: 'R1', answer: () => ok(['R1']) });
    await w.mount();
    w.answer = () => ({ kind: 'busy', retryAfterSec: 120 });
    await w.tick();
    expect(w.state()).toMatchObject({ phase: 'ready', waitSec: 120 });
    w.answer = () => ok(['R1']);
    w.advance(60_000);
    await w.tick();
    expect(w.calls).toEqual(['R1', 'R1']);
    w.advance(60_000);
    await w.tick();
    expect(w.calls).toEqual(['R1', 'R1', 'R1']);
    expect(w.state().waitSec).toBeNull();
  });

  it('a failed refresh keeps the data shown with "could not refresh"; the next answer clears it', async () => {
    const w = world({ saved: 'R1', answer: () => ok(['R1']) });
    await w.mount();
    w.answer = () => ({ kind: 'error', status: 0 });
    w.advance(1000);
    await w.tick();
    expect(w.state().phase).toBe('ready');
    expect(w.state().staleSince).toBe(1_001_000);
    expect(w.state().lookup?.routes[0]?.route).toBe('R1');
    w.advance(60_000);
    await w.tick();
    expect(w.state().staleSince).toBe(1_001_000);
    w.answer = () => ok(['R1']);
    await w.tick();
    expect(w.state().staleSince).toBeNull();
  });

  it('no connection at the start: Try again asks the same again', async () => {
    const w = world({ saved: 'R1', answer: () => ({ kind: 'error', status: 0 }) });
    await w.mount();
    expect(w.state().phase).toBe('offline');
    w.answer = () => ok(['R1']);
    await w.act((a) => a.retry());
    expect(w.calls).toEqual(['R1', 'R1']);
    expect(w.state().phase).toBe('ready');
  });

  it('no connection on the form: the form says so and keeps the text', async () => {
    const w = world({ answer: () => metaOnly });
    await w.mount();
    w.answer = () => ({ kind: 'error', status: 0 });
    await w.act((a) => a.submit('r1'));
    expect(w.state()).toMatchObject({ phase: 'form', formText: 'R1', formError: 'No connection. Check your signal and try again.' });
  });
});
