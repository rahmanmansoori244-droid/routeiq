/**
 * Audit F15 (owner decision 5): /api/health is dispatch READINESS, /api/health/live is liveness.
 * - a missing SOLVER_URL / SOLVER_TOKEN on web, a 401 from the solver or a solver without its own
 *   token (500 "Solver not configured") is a definite misconfiguration: 503 not_ready (the deploy
 *   gate fails);
 * - an unreachable or older solver is only degraded: HTTP 200, ok false (alert, do not block);
 * - the check is one authenticated GET /ready: it never calls /optimize-dispatch;
 * - liveness answers without the database or the solver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ up: true }));
vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: vi.fn(async () => {
      if (!db.up) throw new Error('database down (simulated)');
      return [{ '?column?': 1 }];
    }),
  },
}));

import { checkDispatchReadiness, overallReadiness } from '@/lib/health';
import { GET as health } from '@/app/api/health/route';
import { GET as live } from '@/app/api/health/live/route';

type Reply = { status: number; body?: unknown } | 'network-error' | 'hang';
const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;
const ENV = env({ SOLVER_URL: 'http://solver.test', SOLVER_TOKEN: 'web-token' });

function fakeFetch(reply: Reply) {
  const calls: { url: string; token: string | null; method: string }[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), token: headers.get('X-Solver-Token'), method: init?.method ?? 'GET' });
    if (reply === 'network-error') throw new TypeError('fetch failed');
    if (reply === 'hang') {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  });
  return { f: f as unknown as typeof fetch, calls };
}

const READY_BODY = { ok: true, service: 'routeiq-solver', routing: { provider: 'OSRM', status: 'up' } };

describe('checkDispatchReadiness', () => {
  it('ready: one authenticated GET /ready with the web token, nothing else', async () => {
    const { f, calls } = fakeFetch({ status: 200, body: READY_BODY });
    const r = await checkDispatchReadiness(ENV, f);
    expect(r).toMatchObject({ status: 'ready', reason: 'OK', routing: { provider: 'OSRM', status: 'up' } });
    expect(calls).toEqual([{ url: 'http://solver.test/ready', token: 'web-token', method: 'GET' }]);
  });

  it('SOLVER_TOKEN missing on web: misconfigured, and the solver is not even called', async () => {
    const { f, calls } = fakeFetch({ status: 200, body: READY_BODY });
    const r = await checkDispatchReadiness(env({ SOLVER_URL: 'http://solver.test' }), f);
    expect(r).toMatchObject({ status: 'misconfigured', reason: 'SOLVER_TOKEN_MISSING' });
    expect(calls).toHaveLength(0);
    expect((await checkDispatchReadiness(env({ SOLVER_URL: 'http://solver.test', SOLVER_TOKEN: '  ' }), f)).reason).toBe('SOLVER_TOKEN_MISSING');
  });

  it('SOLVER_URL missing: misconfigured', async () => {
    const { f } = fakeFetch({ status: 200, body: READY_BODY });
    expect(await checkDispatchReadiness(env({ SOLVER_TOKEN: 'x' }), f)).toMatchObject({ status: 'misconfigured', reason: 'SOLVER_URL_MISSING' });
  });

  it('the solver refuses the token (401): misconfigured', async () => {
    const { f } = fakeFetch({ status: 401, body: { detail: 'Invalid solver token' } });
    expect(await checkDispatchReadiness(ENV, f)).toMatchObject({ status: 'misconfigured', reason: 'SOLVER_TOKEN_REJECTED' });
  });

  it('the solver has no token itself (500 "Solver not configured"): misconfigured', async () => {
    const { f } = fakeFetch({ status: 500, body: { detail: 'Solver not configured' } });
    expect(await checkDispatchReadiness(ENV, f)).toMatchObject({ status: 'misconfigured', reason: 'SOLVER_NOT_CONFIGURED' });
  });

  it('unreachable, timed out, an older solver or another error: only degraded', async () => {
    expect((await checkDispatchReadiness(ENV, fakeFetch('network-error').f)).reason).toBe('SOLVER_UNREACHABLE');
    const t0 = Date.now();
    const hung = await checkDispatchReadiness(ENV, fakeFetch('hang').f, 50);
    expect(hung).toMatchObject({ status: 'degraded', reason: 'SOLVER_UNREACHABLE' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect((await checkDispatchReadiness(ENV, fakeFetch({ status: 404, body: { detail: 'Not Found' } }).f)).reason).toBe('SOLVER_READY_UNSUPPORTED');
    expect(await checkDispatchReadiness(ENV, fakeFetch({ status: 502 }).f)).toMatchObject({ status: 'degraded', reason: 'SOLVER_ERROR' });
    expect((await checkDispatchReadiness(ENV, fakeFetch({ status: 200, body: { ok: false } }).f)).status).toBe('degraded');
  });

  it('overall: a misconfiguration or a database down is 503, degraded is 200', () => {
    const d = (status: 'ready' | 'degraded' | 'misconfigured') => ({ status, reason: 'OK' as const, message: '', routing: null });
    expect(overallReadiness('up', d('ready'))).toEqual({ status: 'ready', httpStatus: 200 });
    expect(overallReadiness('up', d('degraded'))).toEqual({ status: 'degraded', httpStatus: 200 });
    expect(overallReadiness('up', d('misconfigured'))).toEqual({ status: 'not_ready', httpStatus: 503 });
    expect(overallReadiness('down', d('ready'))).toEqual({ status: 'not_ready', httpStatus: 503 });
  });
});

describe('GET /api/health (readiness) and /api/health/live', () => {
  const saved = { url: process.env.SOLVER_URL, token: process.env.SOLVER_TOKEN };
  let calls: { url: string; token: string | null }[] = [];
  function solverAnswers(reply: Reply) {
    const fake = fakeFetch(reply);
    calls = fake.calls;
    vi.spyOn(globalThis, 'fetch').mockImplementation(fake.f);
  }
  beforeEach(() => {
    db.up = true;
    process.env.SOLVER_URL = 'http://solver.test';
    process.env.SOLVER_TOKEN = 'web-token';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved.url === undefined) delete process.env.SOLVER_URL;
    else process.env.SOLVER_URL = saved.url;
    if (saved.token === undefined) delete process.env.SOLVER_TOKEN;
    else process.env.SOLVER_TOKEN = saved.token;
  });

  it('the auditor case: SOLVER_TOKEN missing on web with a healthy solver is 503, not ok', async () => {
    delete process.env.SOLVER_TOKEN;
    solverAnswers({ status: 200, body: READY_BODY });
    const res = await health();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body).toMatchObject({ ok: false, status: 'not_ready', db: 'up', solver: 'misconfigured', dispatch: { reason: 'SOLVER_TOKEN_MISSING' } });
  });

  it('a mismatched token (401 from the solver) is 503', async () => {
    solverAnswers({ status: 401, body: { detail: 'Invalid solver token' } });
    const res = await health();
    expect(res.status).toBe(503);
    expect((await res.json()).dispatch.reason).toBe('SOLVER_TOKEN_REJECTED');
  });

  it('matched and healthy: 200 ok, routing passed through, no optimization called', async () => {
    solverAnswers({ status: 200, body: READY_BODY });
    const res = await health();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: 'ready', db: 'up', solver: 'up', routing: { provider: 'OSRM', status: 'up' } });
    expect(calls.map((c) => c.url)).toEqual(['http://solver.test/ready']);
    expect(calls.some((c) => /optimize/.test(c.url))).toBe(false);
  });

  it('an unreachable solver is degraded: 200 (deploy not blocked) but ok false', async () => {
    solverAnswers('network-error');
    const res = await health();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: false, status: 'degraded', solver: 'down', dispatch: { reason: 'SOLVER_UNREACHABLE' } });
  });

  it('the database down is 503 whatever the solver says', async () => {
    db.up = false;
    solverAnswers({ status: 200, body: READY_BODY });
    const res = await health();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, status: 'not_ready', db: 'down' });
  });

  it('never returns the solver URL or the token', async () => {
    solverAnswers({ status: 401, body: { detail: 'Invalid solver token' } });
    const text = JSON.stringify(await (await health()).json());
    expect(text).not.toContain('solver.test');
    expect(text).not.toContain('web-token');
  });

  it('liveness answers 200 without asking the database or the solver', async () => {
    db.up = false;
    solverAnswers('network-error');
    const res = live();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'web' });
    expect(calls).toHaveLength(0);
  });
});
