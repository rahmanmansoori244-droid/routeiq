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
 *  - A first request that failed is asked again by itself (signal back, page back, every period); a server error
 *    is said as such, not as "no connection"; a proxy's bare 503 is ridden out (review of 19 Oct 2026).
 *  - A truck looked up (owner decision of 20 Oct 2026) is followed as "Truck X"; the trucks offered for a code are
 *    kept until the codes change, shown on the form when nothing else was found, and a pick asks for that truck.
 *  - More results than 5 (a code typed matched two routes): the refresh asks for the codes typed, never 6 codes
 *    the server refuses (review of 20 Oct 2026: the 400 sent the salesman back to the form).
 */
import { describe, expect, it, vi } from 'vitest';
import { Host, deferred } from './hook-host';
import { TOKEN, answer, lookup, routeView, truckView } from './sales-page-fixture';
import { readSalesAnswer, type SalesAnswer } from '@/lib/sales-page/api';
import { parseRouteQuery } from '@/lib/sales-link/route-code';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));

import { useSalesView, WAKE_MIN_MS, refreshMsOf, type SalesViewDeps, type SalesViewState } from '@/app/s/[token]/use-sales-view';

type Answerer = (route: string | null) => SalesAnswer | Promise<SalesAnswer>;

const ok = (routes: string[], over: Parameters<typeof lookup>[1] = {}): SalesAnswer => ({
  kind: 'ok',
  answer: answer(routes.length || over.notFound || over.choices ? lookup(routes.map((r) => (r.startsWith('Truck ') ? truckView(r.slice(6)) : routeView(r))), over) : null),
});
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
    expect(w.state().lookup?.results.map((r) => r.code)).toEqual(['R2X']);
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
    expect(w.state().lookup?.results[0]?.code).toBe('R2X');
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
    expect(w.state().formError).toBe('Type your route or truck code.');
    await w.act((a) => a.submit('R1, R2, R3, R4, R5, R6'));
    expect(w.state().formError).toBe('At most 5 codes at once.');
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

describe('a truck looked up (owner decision of 20 Oct 2026)', () => {
  const several = {
    asked: '1234',
    kind: 'SEVERAL_TRUCKS' as const,
    text: '1234 matches 2 trucks today. Pick one:',
    options: [
      { code: '1234-AB', query: 'Truck 1234-AB' },
      { code: '1234-CD', query: 'Truck 1234-CD' },
    ],
  };

  it('a truck found is followed (and saved) in the explicit form, so a refresh never turns it into a route', async () => {
    const w = world({ answer: () => metaOnly });
    await w.mount();
    w.answer = (r) => (r === 'C1, 1234' || r === 'C1, Truck 1234-AB' ? ok(['C1', 'Truck 1234-AB']) : ok([]));
    await w.act((a) => a.submit('c1, 1234'));
    expect(w.state().phase).toBe('ready');
    expect(w.state().lookup?.results.map((r) => `${r.kind} ${r.code}`)).toEqual(['ROUTE C1', 'TRUCK 1234-AB']);
    expect(w.data['riq.s.route']).toBe('C1, Truck 1234-AB');
    await w.tick();
    expect(w.calls).toEqual([null, 'C1, 1234', 'C1, Truck 1234-AB']);
    // The same codes in the link's fragment: nothing asked again.
    w.location.hash = '#c1,%20truck%201234-ab';
    await w.fire('window', 'hashchange');
    expect(w.calls).toHaveLength(3);
  });

  it('several trucks with the digits: the form offers them (no error, nothing followed); a pick asks for that truck', async () => {
    const w = world({ answer: () => metaOnly });
    await w.mount();
    w.answer = (r) => (r === '1234' ? ok([], { asked: ['1234'], choices: [several] }) : r === 'TRUCK 1234-CD' ? ok(['Truck 1234-CD']) : ok([]));
    await w.act((a) => a.submit('1234'));
    expect(w.state()).toMatchObject({ phase: 'form', formError: null, choices: [several], formText: '1234' });
    expect(w.data['riq.s.route']).toBeUndefined();
    expect(w.every.filter((e) => e.on)).toEqual([]);
    await w.act((a) => a.submit(several.options[1]!.query));
    expect(w.state().phase).toBe('ready');
    expect(w.state().choices).toEqual([]);
    expect(w.state().lookup?.results.map((r) => r.query)).toEqual(['Truck 1234-CD']);
    expect(w.calls).toEqual([null, '1234', 'TRUCK 1234-CD']);
    expect(w.data['riq.s.route']).toBe('Truck 1234-CD');
  });

  it('a route code that is also a truck code: the route with the truck offered; kept on refresh, gone on Change route', async () => {
    const also = { asked: 'R1', kind: 'ALSO_TRUCK' as const, text: 'R1 is also a truck code. Show the truck instead:', options: [{ code: 'R-1', query: 'Truck R-1' }] };
    const w = world({ saved: 'R1', answer: () => ok(['R1'], { choices: [also] }) });
    await w.mount();
    expect(w.state()).toMatchObject({ phase: 'ready', choices: [also] });
    w.answer = () => ok(['R1']);
    await w.tick();
    expect(w.state().choices).toEqual([also]);
    await w.act((a) => a.changeRoute());
    expect(w.state()).toMatchObject({ phase: 'form', choices: [] });
  });
});

describe('more results than codes (review of 20 Oct 2026)', () => {
  it('six results from five codes typed: the refresh asks for the five codes typed and the page stays', async () => {
    const typed = 'R1, R2, R3, R4, R-10';
    const six = ['R1', 'R2', 'R3', 'R4', 'R 10', 'R10'];
    const w = world({ answer: () => metaOnly });
    await w.mount();
    // As the server: more than 5 codes is 400 TOO_MANY_CODES.
    w.answer = (r) => {
      const q = parseRouteQuery(r);
      if (!q.ok) return { kind: 'badCode', code: q.code, message: 'At most 5 codes at once.' };
      return q.codes.join(', ') === typed ? ok(six, { asked: q.codes, ambiguous: ['R-10'] }) : ok([]);
    };
    await w.act((a) => a.submit('r1, r2, r3, r4, r-10'));
    expect(w.state().phase).toBe('ready');
    expect(w.state().lookup?.results).toHaveLength(6);
    expect(w.data['riq.s.route']).toBe(typed);
    await w.tick();
    expect(w.calls).toEqual([null, typed, typed]);
    expect(w.state()).toMatchObject({ phase: 'ready', formError: null });
    expect(w.state().lookup?.results).toHaveLength(6);
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
    expect(w.state().lookup?.results[0]?.code).toBe('R1');
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
    // A server error is not the signal.
    w.answer = () => ({ kind: 'error', status: 500 });
    await w.act((a) => a.submit('r1'));
    expect(w.state().formError).toBe('The server could not answer just now. Try again in a minute.');
  });

  it('no connection at the start: asked again by itself when the signal returns, when the page comes back and every refresh period', async () => {
    const w = world({ saved: 'R1', answer: () => ({ kind: 'error', status: 0 }) });
    await w.mount();
    expect(w.state()).toMatchObject({ phase: 'offline', serverError: false });
    // Not more than every 15 s.
    await w.fire('window', 'online');
    expect(w.calls).toEqual(['R1']);
    w.advance(WAKE_MIN_MS);
    await w.fire('window', 'online');
    expect(w.calls).toEqual(['R1', 'R1']);
    // Hidden: nothing; back in front: asked again.
    w.advance(WAKE_MIN_MS);
    w.setVisible(false);
    await w.tick();
    expect(w.calls).toHaveLength(2);
    w.setVisible(true);
    await w.fire('document', 'visibilitychange');
    expect(w.calls).toHaveLength(3);
    // The refresh period while visible; the answer comes: the page shows the route and stops retrying as offline.
    w.answer = () => ok(['R1']);
    w.advance(60_000);
    await w.tick();
    expect(w.calls).toHaveLength(4);
    expect(w.state().phase).toBe('ready');
    expect(w.every.filter((t) => t.on)).toHaveLength(1);
  });

  it('a server error at the start says so (not "no connection") and is asked again by itself', async () => {
    const w = world({ saved: 'R1', answer: () => ({ kind: 'error', status: 500 }) });
    await w.mount();
    expect(w.state()).toMatchObject({ phase: 'offline', serverError: true });
    w.answer = () => ok(['R1']);
    w.advance(60_000);
    await w.tick();
    expect(w.state().phase).toBe('ready');
  });

  it("a proxy's bare 503 during a refresh (a restart) keeps the data and the polling, never 'links not available'", async () => {
    const w = world({ saved: 'R1', answer: () => ok(['R1']) });
    await w.mount();
    w.answer = () => readSalesAnswer(503, null, null);
    w.advance(60_000);
    await w.tick();
    expect(w.state()).toMatchObject({ phase: 'ready', linkCode: null });
    expect(w.state().staleSince).not.toBeNull();
    w.answer = () => ok(['R1']);
    w.advance(60_000);
    await w.tick();
    expect(w.state()).toMatchObject({ phase: 'ready', staleSince: null });
  });
});
