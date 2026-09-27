/**
 * Audit F15 (owner decision 5): /api/health is dispatch READINESS, /api/health/live is liveness.
 * - a missing SOLVER_URL / SOLVER_TOKEN on web, a 401 from the solver or a solver without its own
 *   token (500 "Solver not configured") is a definite misconfiguration: 503 not_ready (the deploy
 *   gate fails);
 * - an unreachable or older solver is only degraded: HTTP 200, ok false (alert, do not block);
 * - the check is one authenticated GET /ready: it never calls /optimize-dispatch;
 * - liveness answers without the database or the solver.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ up: true }));
vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: vi.fn(async () => {
      if (!db.up) throw new Error('database down (simulated)');
      return [{ '?column?': 1 }];
    }),
  },
}));

import http from 'node:http';
import { checkDispatchReadiness, overallReadiness } from '@/lib/health';
import { configProblems } from '@/lib/startup-checks';
import { callDispatchSolver, callRouteGeometry } from '@/lib/solver-client';
import { solverEnv } from '@/lib/solver-env';
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

/**
 * Review of audit PR4: the readiness check trimmed SOLVER_URL / SOLVER_TOKEN and dropped a trailing
 * slash, while the optimize and road-line calls sent them as they were. `http://solver:8000/` was
 * `ready` while every optimization posted `//optimize-dispatch` (404), and a token with a newline
 * was `ready` while no call could even be sent. All of them now read the values through solverEnv:
 * the check below runs the real readiness check and the real calls against one HTTP server that
 * matches paths exactly, as the solver (FastAPI) does.
 */
describe('the readiness check and the real solver calls read SOLVER_URL / SOLVER_TOKEN the same way', () => {
  const saved = { url: process.env.SOLVER_URL, token: process.env.SOLVER_TOKEN };
  const seen: { call: string; token: string | undefined }[] = [];
  let server: http.Server;
  let base = '';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const token = req.headers['x-solver-token'] as string | undefined;
      seen.push({ call: `${req.method} ${req.url}`, token });
      req.resume();
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const known = ['GET /ready', 'POST /optimize-dispatch', 'POST /route-geometry'];
      if (!known.includes(`${req.method} ${req.url}`)) return reply(404, { detail: 'Not Found' });
      if (token !== 'solver-token') return reply(401, { detail: 'Invalid solver token' });
      if (req.url === '/ready') return reply(200, { ok: true, routing: { provider: 'OSRM', status: 'up' } });
      if (req.url === '/optimize-dispatch') return reply(200, { run_id: 'r1', engine: 'test', scenarios: [], warnings: [] });
      return reply(200, { provider: 'OSRM', is_estimated: false, coordinates: [[58.39, 23.58], [58.45, 23.6]], warning: null });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    seen.length = 0;
  });
  afterEach(() => {
    if (saved.url === undefined) delete process.env.SOLVER_URL;
    else process.env.SOLVER_URL = saved.url;
    if (saved.token === undefined) delete process.env.SOLVER_TOKEN;
    else process.env.SOLVER_TOKEN = saved.token;
  });

  /** The readiness check, then an optimization and a road line, with the web's SOLVER_URL / SOLVER_TOKEN set to these. */
  async function allThree(url: string, token: string) {
    process.env.SOLVER_URL = url;
    process.env.SOLVER_TOKEN = token;
    const ready = await checkDispatchReadiness(process.env);
    const optimize = await callDispatchSolver({ run_id: 'r1', stops: [], trucks: [] } as never).then(
      (r) => ({ ok: true as const, runId: r.run_id }),
      (e: { status?: number; message?: string }) => ({ ok: false as const, status: e.status, message: e.message }),
    );
    const geometry = await callRouteGeometry([
      [58.39, 23.58],
      [58.45, 23.6],
    ]);
    return { ready, optimize, geometry };
  }

  it('SOLVER_URL with a trailing slash: ready, and the optimize and road-line calls reach /optimize-dispatch and /route-geometry (never //...)', async () => {
    const r = await allThree(`${base}/`, 'solver-token');
    expect(r.ready).toMatchObject({ status: 'ready', reason: 'OK' });
    expect(r.optimize).toEqual({ ok: true, runId: 'r1' });
    expect(r.geometry).toMatchObject({ kind: 'answer', provider: 'OSRM', isEstimated: false });
    expect(seen.map((s) => s.call)).toEqual(['GET /ready', 'POST /optimize-dispatch', 'POST /route-geometry']);
  });

  it('spaces or a line break around SOLVER_URL and SOLVER_TOKEN: every call sends the same trimmed token to the same paths', async () => {
    const r = await allThree(`  ${base}//\n`, ' solver-token\n');
    expect(r.ready.status).toBe('ready');
    expect(r.optimize).toEqual({ ok: true, runId: 'r1' });
    expect(r.geometry).toMatchObject({ kind: 'answer' });
    expect(seen).toEqual([
      { call: 'GET /ready', token: 'solver-token' },
      { call: 'POST /optimize-dispatch', token: 'solver-token' },
      { call: 'POST /route-geometry', token: 'solver-token' },
    ]);
  });

  it('a token the solver refuses is refused for the check and the optimization alike (503 not ready, never ready)', async () => {
    const r = await allThree(`${base}/`, 'another-token');
    expect(r.ready).toMatchObject({ status: 'misconfigured', reason: 'SOLVER_TOKEN_REJECTED' });
    expect(r.optimize).toMatchObject({ ok: false, status: 401 });
    expect(r.geometry).toEqual({ kind: 'failed', status: 401 });
  });

  it('solverEnv: empty after trimming is not set - for the check, the calls and the startup log alike', async () => {
    expect(solverEnv(env({ SOLVER_URL: ' http://solver:8000/ ', SOLVER_TOKEN: 'tok\r\n' }))).toEqual({ url: 'http://solver:8000', token: 'tok' });
    expect(solverEnv(env({ SOLVER_URL: ' / ', SOLVER_TOKEN: ' \n' }))).toEqual({ url: null, token: null });
    expect(solverEnv(env({}))).toEqual({ url: null, token: null });
    const odd = { SOLVER_URL: '/', SOLVER_TOKEN: '\n' };
    expect((await checkDispatchReadiness(env(odd), fakeFetch({ status: 200, body: READY_BODY }).f)).reason).toBe('SOLVER_URL_MISSING');
    const prod = { NODE_ENV: 'production', RESEND_API_KEY: 'k', AUTH_URL: 'u', JANITOR_TOKEN: 'j' };
    expect(configProblems(env({ ...prod, ...odd })).map((p) => p.message.split(' ')[0])).toEqual(['SOLVER_URL', 'SOLVER_TOKEN']);
    process.env.SOLVER_URL = '/';
    process.env.SOLVER_TOKEN = 'solver-token';
    await expect(callDispatchSolver({} as never)).rejects.toThrow('SOLVER_URL not set');
    expect(await callRouteGeometry([])).toEqual({ kind: 'not_configured' });
    expect(seen).toHaveLength(0);
  });
});
