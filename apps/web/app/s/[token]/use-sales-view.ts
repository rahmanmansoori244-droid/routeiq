'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SalesChoice, SalesLinkStateCode, SalesLookup, SalesMeta } from '@/lib/sales-link/view-types';
import { parseRouteQuery } from '@/lib/sales-link/route-code';
import { deviceId, fetchSalesView, forgetRoute, routeFromHash, safeLocalStorage, saveRoute, savedRoute, tokenFromPath, type KeyStore, type SalesAnswer } from '@/lib/sales-page/api';
import { followQuery, UI } from '@/lib/sales-page/format';

/**
 * The salesman link page's state (owner request 19 Oct 2026): which route codes it follows, the last answer, and
 * when it asks again. Read-only: it only ever sends GET /api/s/view.
 *
 * - The route (or truck) codes come from the link's fragment ("/s/<token>#R1": WhatsApp's in-app browser may not
 *   keep localStorage), else from what this browser last found (`riq.s.route`), else the route form.
 * - Found codes are followed: the page asks for exactly the routes and trucks the server found (a truck as
 *   "Truck 1234-AB"; never more than 5 codes, else the codes typed that found them: format.ts followQuery), every
 *   `meta.refreshSec` (60 s) while the page is visible, and again when it comes back to the front or the signal
 *   returns.
 * - Trucks the server offers for a code (several trucks with the digits or compact key typed; a route code that is also a
 *   truck's) are kept as `choices` until the codes change; picking one sends its whole lookup (`submit`).
 * - A code that matched nothing is never asked again by itself (each one counts against the link's limit): the
 *   form shows the server's "No deliveries for route R9 ..." and the saved code is forgotten.
 * - The newest request wins (a refresh answered after a route change is dropped); a 429 waits Retry-After; a
 *   failed refresh keeps what is shown with "Could not refresh"; a link that does not work stops everything.
 * - A first request that failed (no signal, or the server's error - said as such) is asked again by itself every
 *   refresh period while visible, and when the signal returns or the page comes back.
 */

export type SalesPhase = 'loading' | 'link' | 'form' | 'ready' | 'offline';

export interface SalesViewState {
  phase: SalesPhase;
  meta: SalesMeta | null;
  linkCode: SalesLinkStateCode | null;
  linkDate: string | null;
  /** The last answer with at least one route found. */
  lookup: SalesLookup | null;
  /** "No deliveries for route or truck R9 ..." when some of the codes typed matched nothing (the others are shown). */
  notice: string | null;
  /** Trucks offered for a code typed (on the form when nothing else was found, else above the results). */
  choices: SalesChoice[];
  /** The route form's text and its error. */
  formText: string;
  formError: string | null;
  /** A request the user asked for is on its way. */
  working: boolean;
  /** 429: the page waits this many seconds. */
  waitSec: number | null;
  /** A refresh failed after data was shown (ms): the page keeps the data with "Could not refresh". */
  staleSince: number | null;
  /** The first request failed with an answer from the server (not the signal): "the server could not answer". */
  serverError: boolean;
}

/** What the page uses of the browser (the tests give their own). */
export interface SalesViewDeps {
  fetchView: (token: string, device: string, route: string | null) => Promise<SalesAnswer>;
  storage: KeyStore | null;
  now: () => number;
  /** A one-off timer; returns its cancel. */
  setTimer: (fn: () => void, ms: number) => () => void;
  /** A repeating timer; returns its cancel. */
  setEvery: (fn: () => void, ms: number) => () => void;
  location: { pathname: string; hash: string; search: string };
  replaceUrl: (url: string) => void;
  visible: () => boolean;
  on: (target: 'window' | 'document', event: string, fn: () => void) => () => void;
}

/** A refresh on coming back to the front or online, only when the last request is at least this old. */
export const WAKE_MIN_MS = 15_000;
const REFRESH_MIN_MS = 30_000;
const REFRESH_MAX_MS = 10 * 60_000;

export function refreshMsOf(meta: Pick<SalesMeta, 'refreshSec'> | null): number {
  const ms = (meta?.refreshSec ?? 60) * 1000;
  return Number.isFinite(ms) ? Math.min(REFRESH_MAX_MS, Math.max(REFRESH_MIN_MS, ms)) : 60_000;
}

export function browserDeps(): SalesViewDeps {
  return {
    fetchView: (token, device, route) => fetchSalesView(token, device, route),
    storage: safeLocalStorage(),
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    setEvery: (fn, ms) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    },
    location: window.location,
    replaceUrl: (url) => {
      try {
        window.history.replaceState(window.history.state, '', url);
      } catch {
        // an old browser: the fragment stays
      }
    },
    visible: () => document.visibilityState !== 'hidden',
    on: (target, event, fn) => {
      const t: EventTarget = target === 'window' ? window : document;
      t.addEventListener(event, fn);
      return () => t.removeEventListener(event, fn);
    },
  };
}

export const INITIAL_SALES_STATE: SalesViewState = {
  phase: 'loading',
  meta: null,
  linkCode: null,
  linkDate: null,
  lookup: null,
  notice: null,
  choices: [],
  formText: '',
  formError: null,
  working: false,
  waitSec: null,
  staleSince: null,
  serverError: false,
};

type Why = 'start' | 'submit' | 'poll' | 'refresh';

/** The form's message for a code the page itself refuses (the server's rule, lib/sales-link/route-code.ts). */
function codeProblem(code: 'ROUTE_CODE_MISSING' | 'ROUTE_CODE_TOO_LONG' | 'TOO_MANY_CODES'): string {
  return code === 'ROUTE_CODE_MISSING' ? UI.codeMissing : code === 'TOO_MANY_CODES' ? UI.tooManyCodes : UI.codeTooLong;
}

export function useSalesView(deps?: SalesViewDeps) {
  const [state, setState] = useState<SalesViewState>(INITIAL_SALES_STATE);
  const dep = useRef<SalesViewDeps | null>(null);
  const token = useRef<string | null>(null);
  const device = useRef('');
  // Bumped by every request and by Change route: an answer to an older one is dropped.
  const seq = useRef(0);
  /** The codes followed (the routes and trucks found, as the server names them): what every refresh asks for. */
  const follow = useRef<string | null>(null);
  /** The link does not work: nothing more is asked. */
  const stopped = useRef(false);
  const pauseUntil = useRef(0);
  const lastAsk = useRef(0);
  const cancelRetry = useRef<(() => void) | null>(null);
  /** The last request the user started (Try again repeats it). */
  const lastStart = useRef<{ route: string | null; why: Why }>({ route: null, why: 'start' });

  const patch = useCallback((p: Partial<SalesViewState>) => setState((prev) => ({ ...prev, ...p })), []);

  const ask = useCallback(
    async (route: string | null, why: Why): Promise<void> => {
      const d = dep.current;
      const tok = token.current;
      if (!d || !tok || stopped.current) return;
      if ((why === 'poll' || why === 'refresh') && d.now() < pauseUntil.current) return;
      cancelRetry.current?.();
      cancelRetry.current = null;
      if (why === 'start' || why === 'submit') lastStart.current = { route, why };
      const my = ++seq.current;
      lastAsk.current = d.now();
      if (why !== 'poll') patch({ working: true });
      const a = await d.fetchView(tok, device.current, route);
      if (my !== seq.current || stopped.current) return;

      if (a.kind === 'ok') {
        const { meta, lookup } = a.answer;
        if (!lookup) {
          patch({ phase: 'form', meta, working: false, waitSec: null, staleSince: null });
          return;
        }
        if (!lookup.results.length) {
          // Nothing found: never asked again (each unknown code counts against the link and this network). Trucks
          // offered for a code (several with its digits) are shown on the form to pick from.
          follow.current = null;
          forgetRoute(d.storage);
          const choices = lookup.choices ?? [];
          patch({
            phase: 'form',
            meta,
            lookup: null,
            notice: null,
            choices,
            formText: route ?? '',
            formError: lookup.notFoundText ?? (choices.length ? null : 'No deliveries for that code. Check the route code on your Salesman ETA page, or the truck code.'),
            working: false,
            waitSec: null,
            staleSince: null,
          });
          return;
        }
        const q = followQuery(lookup)!;
        follow.current = q;
        saveRoute(q, d.storage);
        const notice = [lookup.notFoundText, lookup.ambiguous.length ? UI.ambiguous(lookup.ambiguous) : null].filter(Boolean).join(' ') || null;
        setState((prev) => ({
          ...prev,
          phase: 'ready',
          meta,
          lookup,
          // A refresh asks only for what was found: the first answer's notice and choices stay until the codes change.
          notice: why === 'poll' || why === 'refresh' ? prev.notice : notice,
          choices: why === 'poll' || why === 'refresh' ? prev.choices : (lookup.choices ?? []),
          formError: null,
          working: false,
          waitSec: null,
          staleSince: null,
        }));
        return;
      }
      if (a.kind === 'link') {
        stopped.current = true;
        follow.current = null;
        patch({ phase: 'link', linkCode: a.code, linkDate: a.date, working: false, waitSec: null });
        return;
      }
      if (a.kind === 'badCode') {
        follow.current = null;
        forgetRoute(d.storage);
        patch({ phase: 'form', choices: [], formText: route ?? '', formError: a.message, working: false, waitSec: null });
        return;
      }
      if (a.kind === 'busy') {
        const sec = a.retryAfterSec ?? 60;
        pauseUntil.current = d.now() + sec * 1000;
        patch({ waitSec: sec, working: false });
        // What the salesman asked for is asked again after the wait; a refresh simply waits for the next one.
        if (why === 'start' || why === 'submit') {
          cancelRetry.current = d.setTimer(() => {
            cancelRetry.current = null;
            void ask(route, why);
          }, sec * 1000);
        }
        return;
      }
      // No answer (no signal, a timeout: status 0) or a server error (any other status): said as what it is.
      const server = a.status !== 0;
      setState((prev) => {
        if (prev.phase === 'ready') return { ...prev, staleSince: prev.staleSince ?? d.now(), working: false };
        if (why === 'submit') return { ...prev, phase: 'form', formText: route ?? prev.formText, formError: server ? UI.serverErrorForm : UI.offline, working: false };
        return { ...prev, phase: 'offline', serverError: server, working: false };
      });
    },
    [patch],
  );

  // Start: the token from the path, the route from the fragment or this browser.
  useEffect(() => {
    const d = deps ?? browserDeps();
    dep.current = d;
    stopped.current = false;
    token.current = tokenFromPath(d.location.pathname);
    if (!token.current) {
      stopped.current = true;
      patch({ phase: 'link', linkCode: 'LINK_NOT_FOUND' });
      return;
    }
    device.current = deviceId(d.storage);
    const route = routeFromHash(d.location.hash) ?? savedRoute(d.storage);
    void ask(route, 'start');
    // Another route's link opened in the same tab ("/s/<token>#R2X").
    const offHash = d.on('window', 'hashchange', () => {
      const r = routeFromHash(d.location.hash);
      const q = r ? parseRouteQuery(r) : null;
      const now = follow.current ? parseRouteQuery(follow.current) : null;
      if (q?.ok && q.codes.join(', ') !== (now?.ok ? now.codes.join(', ') : null)) void ask(q.codes.join(', '), 'submit');
    });
    return () => {
      offHash();
      cancelRetry.current?.();
      // Unmounted (or React's development double start): answers still on their way are dropped.
      stopped.current = true;
    };
    // Once per page: the dependencies are fixed for the page's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh while the route is shown and the page is visible; at once when it comes back (not more than every 15 s).
  const live = state.phase === 'ready';
  const refreshMs = refreshMsOf(state.meta);
  useEffect(() => {
    const d = dep.current;
    if (!live || !d) return;
    const tick = () => {
      if (d.visible() && follow.current) void ask(follow.current, 'poll');
    };
    const wake = () => {
      if (d.visible() && follow.current && d.now() - lastAsk.current >= WAKE_MIN_MS) void ask(follow.current, 'poll');
    };
    const stopEvery = d.setEvery(tick, refreshMs);
    const offVisible = d.on('document', 'visibilitychange', wake);
    const offOnline = d.on('window', 'online', wake);
    return () => {
      stopEvery();
      offVisible();
      offOnline();
    };
  }, [live, refreshMs, ask]);

  // The first request failed (often a weak signal when WhatsApp opens the link): ask the same again every
  // refresh period while visible, and at once when the signal returns or the page comes back (not more than every 15 s).
  const offline = state.phase === 'offline';
  useEffect(() => {
    const d = dep.current;
    if (!offline || !d) return;
    const again = () => {
      if (d.visible() && d.now() - lastAsk.current >= WAKE_MIN_MS) void ask(lastStart.current.route, lastStart.current.why);
    };
    const stopEvery = d.setEvery(again, refreshMs);
    const offVisible = d.on('document', 'visibilitychange', again);
    const offOnline = d.on('window', 'online', again);
    return () => {
      stopEvery();
      offVisible();
      offOnline();
    };
  }, [offline, refreshMs, ask]);

  /** The route form: "r1", "R1, R2X", "C1, 5678"; a truck picked from the choices sends its lookup here too (checked first with the server's rule). */
  const submit = useCallback(
    (text: string) => {
      const q = parseRouteQuery(text);
      if (!q.ok) {
        patch({ formText: text, formError: codeProblem(q.code) });
        return;
      }
      patch({ formText: text, formError: null });
      void ask(q.codes.join(', '), 'submit');
    },
    [ask, patch],
  );

  /** Back to the route form: nothing is followed or kept, and the link's #route is dropped (a reload asks again). */
  const changeRoute = useCallback(() => {
    const d = dep.current;
    seq.current++;
    cancelRetry.current?.();
    cancelRetry.current = null;
    const was = follow.current;
    follow.current = null;
    if (d) {
      forgetRoute(d.storage);
      if (d.location.hash) d.replaceUrl(`${d.location.pathname}${d.location.search}`);
    }
    setState((prev) => ({ ...prev, phase: 'form', lookup: null, notice: null, choices: [], formText: was ?? prev.formText, formError: null, working: false, staleSince: null }));
  }, []);

  /** The Refresh button. */
  const refresh = useCallback(() => {
    if (follow.current) void ask(follow.current, 'refresh');
  }, [ask]);

  /** Try again after no connection. */
  const retry = useCallback(() => {
    void ask(lastStart.current.route, lastStart.current.why);
  }, [ask]);

  return { state, submit, changeRoute, refresh, retry };
}
