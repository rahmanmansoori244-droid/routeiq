/**
 * Audit F15 (owner decision 5): /api/health is dispatch READINESS, /api/health/live is liveness.
 * - a missing SOLVER_URL / SOLVER_TOKEN on web, a 401 from the solver or a solver without its own
 *   token (500 "Solver not configured") is a definite misconfiguration: 503 not_ready (the deploy
 *   gate fails);
 * - an unreachable or older solver, a 5xx, or a 403 (never the solver's own answer: a proxy or a
 *   wrong host in front of it, the token was never checked) is only degraded: HTTP 200, ok false
 *   (alert, do not block);
 * - the check is one authenticated GET /ready: it never calls /optimize-dispatch;
 * - liveness answers without the database or the solver.
 * Third review of audit PR4:
 * - a SOLVER_TOKEN with a character outside plain ASCII (a hidden zero-width space, a curly quote,
 *   a non-breaking space, a line break inside it) is misconfigured: the calls cannot send it, or
 *   send it differently from the check;
 * - a redirect is never ready: the optimize call does not follow one, so the check does not either;
 * - the 4 s timeout covers the whole answer, body included: a body that stops half-way is degraded.
 * Fourth review of audit PR4:
 * - a SOLVER_URL no call can use (no http:// in front, http// without the colon, a hidden
 *   character or a space in it, another scheme, a user name and password, a ? or #) is
 *   misconfigured SOLVER_URL_INVALID (503): it used to read as "unreachable" (200, deploy allowed)
 *   while every optimization failed.
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
import { solverEnv, solverUrlUsable } from '@/lib/solver-env';
import { GET as health } from '@/app/api/health/route';
import { GET as live } from '@/app/api/health/live/route';

type Reply = { status: number; body?: unknown } | 'network-error' | 'hang' | 'stall-body';
const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;
const ENV = env({ SOLVER_URL: 'http://solver.test', SOLVER_TOKEN: 'web-token' });

function fakeFetch(reply: Reply) {
  const calls: { url: string; token: string | null; method: string; redirect: RequestRedirect | undefined }[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), token: headers.get('X-Solver-Token'), method: init?.method ?? 'GET', redirect: init?.redirect });
    if (reply === 'network-error') throw new TypeError('fetch failed');
    if (reply === 'hang') {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    if (reply === 'stall-body') {
      // The headers and the first bytes of the body arrive, then nothing (a wedged proxy or worker).
      // Like Node's fetch, aborting the request's signal errors the body that is still being read.
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"ok":tr'));
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('This operation was aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  });
  return { f: f as unknown as typeof fetch, calls };
}

/** Resolves with `'still pending'` if `p` has not settled after `ms` (a hang must fail the test, not time it out). */
function within<T>(p: Promise<T>, ms: number): Promise<T | 'still pending'> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<'still pending'>((r) => {
    timer = setTimeout(() => r('still pending'), ms);
  });
  return Promise.race([p, cap]).finally(() => clearTimeout(timer));
}

/** Characters no HTTP client sends the same way as plain ASCII (the solver compares bytes). */
const UNSENDABLE_TOKENS = [
  'web-token\u200b', // a zero-width space pasted after it (trim keeps it)
  '\u201cweb-token\u201d', // curly quotes from a document or a chat
  'web\u00a0token', // a non-breaking space: fetch sends 1 byte, the optimize call 2 (UTF-8)
  'web\ntoken', // a line break inside it
  'web\u0001token', // a control character
];

/**
 * SOLVER_URL values no call can use (fourth review of audit PR4). Before the fix the check said
 * "unreachable" (200 degraded, deploy allowed) for each, while every optimization failed before
 * anything was sent ("Protocol not supported", "Invalid URL"), or never reached the solver's paths.
 */
const UNUSABLE_URLS = [
  'routeiq-solver.railway.internal:8000', // Railway's private domain without http:// (read as the scheme "routeiq-solver.railway.internal:")
  '127.0.0.1:8000', // an address and port without http://
  'solver.test', // a bare host
  'http//solver.test:8000', // the colon missing
  'http://solver.test:8000​', // a zero-width space pasted after it (trimming keeps it)
  'http://solver.test:8000/​', // the same after a slash: parsed as a path, so every call went to /%E2%80%8B/...
  'http://solver test:8000', // a space inside it
  'ftp://solver.test:8000', // neither http nor https
  'http://user:secret@solver.test:8000', // a user name and password: fetch refuses the URL
  'http://solver.test:8000?x=1', // a query: the paths the calls add would go into it
  'http://solver.test:8000#top', // a fragment: the same
];

/** Forms the URL parser reads as an http(s) address, the same way for every call: usable. */
const USABLE_URLS = [
  'http://solver.test:8000',
  'https://solver.test',
  'HTTP://solver.test:8000',
  'http:solver.test:8000',
  'http://solver.test:8000/base',
  'http://[::1]:8000',
];

const READY_BODY = { ok: true, service: 'routeiq-solver', routing: { provider: 'OSRM', status: 'up' } };

describe('checkDispatchReadiness', () => {
  it('ready: one authenticated GET /ready with the web token, nothing else', async () => {
    const { f, calls } = fakeFetch({ status: 200, body: READY_BODY });
    const r = await checkDispatchReadiness(ENV, f);
    expect(r).toMatchObject({ status: 'ready', reason: 'OK', routing: { provider: 'OSRM', status: 'up' } });
    expect(calls).toEqual([{ url: 'http://solver.test/ready', token: 'web-token', method: 'GET', redirect: 'manual' }]);
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

  it('second review of audit PR4: a 403 is only degraded (the solver never answers 403: a proxy or wrong host did, the token was never checked)', async () => {
    const json = await checkDispatchReadiness(ENV, fakeFetch({ status: 403, body: { detail: 'Forbidden' } }).f);
    expect(json).toMatchObject({ status: 'degraded', reason: 'SOLVER_ERROR' });
    expect(overallReadiness('up', json)).toEqual({ status: 'degraded', httpStatus: 200 });
    const html = vi.fn(async () => new Response('<html>403 Forbidden</html>', { status: 403, headers: { 'content-type': 'text/html' } }));
    expect(await checkDispatchReadiness(ENV, html as unknown as typeof fetch)).toMatchObject({ status: 'degraded', reason: 'SOLVER_ERROR' });
    // The solver's own refusal stays a definite misconfiguration.
    expect(await checkDispatchReadiness(ENV, fakeFetch({ status: 401, body: { detail: 'Invalid solver token' } }).f)).toMatchObject({ status: 'misconfigured' });
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

  it('third review of audit PR4: a SOLVER_TOKEN with a character outside plain ASCII is misconfigured, and the solver is not called', async () => {
    for (const token of UNSENDABLE_TOKENS) {
      const { f, calls } = fakeFetch({ status: 200, body: READY_BODY });
      const r = await checkDispatchReadiness(env({ SOLVER_URL: 'http://solver.test', SOLVER_TOKEN: token }), f);
      expect(r, JSON.stringify(token)).toMatchObject({ status: 'misconfigured', reason: 'SOLVER_TOKEN_INVALID' });
      expect(overallReadiness('up', r)).toEqual({ status: 'not_ready', httpStatus: 503 });
      expect(calls).toHaveLength(0);
    }
    // Letters, digits, punctuation, and a space or a tab inside it are sent the same way by every call.
    const plain = await checkDispatchReadiness(env({ SOLVER_URL: 'http://solver.test', SOLVER_TOKEN: 'a b\tc~!{}' }), fakeFetch({ status: 200, body: READY_BODY }).f);
    expect(plain.status).toBe('ready');
    // The startup log says the same.
    const prod = { NODE_ENV: 'production', RESEND_API_KEY: 'k', AUTH_URL: 'u', JANITOR_TOKEN: 'j', SOLVER_URL: 'http://solver.test' };
    expect(configProblems(env({ ...prod, SOLVER_TOKEN: 'web-token\u200b' })).map((p) => p.message.split(' ')[0])).toEqual(['SOLVER_TOKEN']);
    expect(configProblems(env({ ...prod, SOLVER_TOKEN: 'web-token' }))).toEqual([]);
  });

  it('third review of audit PR4: a redirect is never ready (the optimize call does not follow one): degraded SOLVER_URL_REDIRECTS', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { f, calls } = fakeFetch({ status });
      const r = await checkDispatchReadiness(ENV, f);
      expect(r, String(status)).toMatchObject({ status: 'degraded', reason: 'SOLVER_URL_REDIRECTS' });
      expect(overallReadiness('up', r)).toEqual({ status: 'degraded', httpStatus: 200 });
      // Asked without following it: the token never goes to the address the redirect names.
      expect(calls.map((c) => c.redirect)).toEqual(['manual']);
    }
    // What a browser-style fetch returns for redirect: 'manual'.
    const opaque = vi.fn(async () => ({ status: 0, type: 'opaqueredirect', ok: false, body: null, json: async () => null }) as unknown as Response);
    expect(await checkDispatchReadiness(ENV, opaque as unknown as typeof fetch)).toMatchObject({ status: 'degraded', reason: 'SOLVER_URL_REDIRECTS' });
  });

  it('third review of audit PR4: the timeout covers the body too - a body that stops half-way is degraded, never a hang', async () => {
    const t0 = Date.now();
    const r = await within(checkDispatchReadiness(ENV, fakeFetch('stall-body').f, 50), 2000);
    expect(r).toMatchObject({ status: 'degraded', reason: 'SOLVER_UNREACHABLE' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('fourth review of audit PR4: a SOLVER_URL no call can use is misconfigured SOLVER_URL_INVALID (503), and the solver is not called', async () => {
    for (const url of UNUSABLE_URLS) {
      const { f, calls } = fakeFetch({ status: 200, body: READY_BODY });
      const r = await checkDispatchReadiness(env({ SOLVER_URL: url, SOLVER_TOKEN: 'web-token' }), f);
      expect(r, JSON.stringify(url)).toMatchObject({ status: 'misconfigured', reason: 'SOLVER_URL_INVALID' });
      // Says what to set, not "did not answer" (which sent the admin to the solver service).
      expect(r.message).toMatch(/^SOLVER_URL on the web service is not a usable address: .*http:\/\/<solver private address>:<port>/);
      expect(overallReadiness('up', r)).toEqual({ status: 'not_ready', httpStatus: 503 });
      expect(calls).toHaveLength(0);
      expect(solverUrlUsable(solverEnv(env({ SOLVER_URL: url })).url ?? ''), JSON.stringify(url)).toBe(false);
    }
    for (const url of USABLE_URLS) {
      const r = await checkDispatchReadiness(env({ SOLVER_URL: url, SOLVER_TOKEN: 'web-token' }), fakeFetch({ status: 200, body: READY_BODY }).f);
      expect(r.status, url).toBe('ready');
    }
    // The startup log says the same.
    const prod = { NODE_ENV: 'production', RESEND_API_KEY: 'k', AUTH_URL: 'u', JANITOR_TOKEN: 'j', SOLVER_TOKEN: 'web-token' };
    const bad = configProblems(env({ ...prod, SOLVER_URL: 'routeiq-solver.railway.internal:8000' }));
    expect(bad).toEqual([{ level: 'error', message: expect.stringMatching(/^SOLVER_URL on the web service is not a usable address: .*503/) }]);
    expect(configProblems(env({ ...prod, SOLVER_URL: 'http://routeiq-solver.railway.internal:8000' }))).toEqual([]);
  });

  it('rule 22: the solver reports a recent failed worker start - degraded SOLVER_WORKERS_FAILED, routing kept; ready again once its workers start', async () => {
    const failed = { ...READY_BODY, ok: false, workers: { status: 'failed', failed_at: '2026-09-30T02:00:00+00:00', cause: 'OSError: test' } };
    const r = await checkDispatchReadiness(ENV, fakeFetch({ status: 200, body: failed }).f);
    expect(r).toMatchObject({ status: 'degraded', reason: 'SOLVER_WORKERS_FAILED', routing: { provider: 'OSRM', status: 'up' } });
    expect(r.message).toMatch(/^The route optimizer could not start its worker processes recently/);
    expect(overallReadiness('up', r)).toEqual({ status: 'degraded', httpStatus: 200 });
    const recovered = await checkDispatchReadiness(ENV, fakeFetch({ status: 200, body: { ...READY_BODY, workers: { status: 'ok' } } }).f);
    expect(recovered).toMatchObject({ status: 'ready', reason: 'OK' });
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

  it('a 403 from something in front of the solver is degraded: 200 (deploy not blocked) but ok false', async () => {
    solverAnswers({ status: 403, body: { detail: 'Forbidden' } });
    const res = await health();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, status: 'degraded', solver: 'down', dispatch: { status: 'degraded', reason: 'SOLVER_ERROR' } });
  });

  it('rule 22: a solver whose worker processes could not start recently is 200 degraded SOLVER_WORKERS_FAILED (the administrator is alerted), never its details', async () => {
    solverAnswers({ status: 200, body: { ...READY_BODY, ok: false, workers: { status: 'failed', failed_at: '2026-09-30T02:00:00+00:00', cause: 'OSError: [Errno 11] Resource temporarily unavailable' } } });
    const res = await health();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: false, status: 'degraded', solver: 'down', dispatch: { status: 'degraded', reason: 'SOLVER_WORKERS_FAILED' } });
    expect(body.dispatch.message).toMatch(/could not start its worker processes/);
    expect(JSON.stringify(body)).not.toContain('Errno');
  });

  it('third review of audit PR4: a SOLVER_TOKEN that cannot be sent is 503 not_ready, and the answer never shows it', async () => {
    process.env.SOLVER_TOKEN = 'web-token\u200b';
    solverAnswers({ status: 200, body: READY_BODY });
    const res = await health();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body).toMatchObject({ ok: false, status: 'not_ready', solver: 'misconfigured', dispatch: { status: 'misconfigured', reason: 'SOLVER_TOKEN_INVALID' } });
    expect(JSON.stringify(body)).not.toContain('web-token');
    expect(calls).toHaveLength(0);
  });

  it('third review of audit PR4: a SOLVER_URL that redirects is 200 degraded with ok false, never ready', async () => {
    solverAnswers({ status: 308 });
    const res = await health();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, status: 'degraded', solver: 'down', dispatch: { status: 'degraded', reason: 'SOLVER_URL_REDIRECTS' } });
  });

  it('fourth review of audit PR4: a SOLVER_URL without http:// is 503 not_ready SOLVER_URL_INVALID (it was 200 "unreachable"), and the answer never shows it', async () => {
    process.env.SOLVER_URL = 'routeiq-solver.railway.internal:8000';
    solverAnswers({ status: 200, body: READY_BODY });
    const res = await health();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body).toMatchObject({ ok: false, status: 'not_ready', solver: 'misconfigured', dispatch: { status: 'misconfigured', reason: 'SOLVER_URL_INVALID' } });
    expect(JSON.stringify(body)).not.toContain('railway.internal');
    expect(calls).toHaveLength(0);
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
  /** The solver's own SOLVER_TOKEN. Node reads header bytes as Latin-1, as the solver (Starlette) does. */
  let solverToken = 'solver-token';

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
      // main.py _check_token compares the UTF-8 bytes of the header as Starlette decoded it (Latin-1).
      if (Buffer.compare(Buffer.from(token ?? '', 'utf8'), Buffer.from(solverToken, 'utf8')) !== 0) return reply(401, { detail: 'Invalid solver token' });
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
    solverToken = 'solver-token';
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

  /** Another in-process HTTP server for one test (an edge in front of the solver, a stalled proxy). */
  async function listen(handler: http.RequestListener): Promise<{ base: string; close: () => Promise<void> }> {
    const s = http.createServer(handler);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    return {
      base: `http://127.0.0.1:${(s.address() as { port: number }).port}`,
      close: () =>
        new Promise<void>((r) => {
          s.closeAllConnections();
          s.close(() => r());
        }),
    };
  }

  it('third review of audit PR4: a token outside plain ASCII is refused before anything is sent - by the check and by every call', async () => {
    for (const webToken of UNSENDABLE_TOKENS) {
      seen.length = 0;
      // Both services were given the same pasted value. Before the fix the check was "ready" for the
      // non-breaking space (fetch sends it as 1 byte) while the optimize call sent 2 bytes (UTF-8) and
      // got 401; for the others the check said "unreachable" while no call could be sent at all.
      const token = webToken.replace('web', 'solver');
      solverToken = token;
      const r = await allThree(base, token);
      expect(r.ready, JSON.stringify(token)).toMatchObject({ status: 'misconfigured', reason: 'SOLVER_TOKEN_INVALID' });
      expect(r.optimize).toEqual({ ok: false, status: 0, message: expect.stringMatching(/^SOLVER_TOKEN .*cannot be sent/) });
      expect(r.geometry).toEqual({ kind: 'failed' });
      expect(seen).toEqual([]);
    }
  });

  it('fourth review of audit PR4: a SOLVER_URL no call can use is refused by the check and by every call before anything is sent, with a message that names SOLVER_URL', async () => {
    const hostPort = base.replace(/^http:\/\//, ''); // 127.0.0.1:<port>
    const port = hostPort.split(':')[1];
    const unusable = [
      `localhost:${port}`, // read as the scheme "localhost:": the check said "unreachable", the optimize call "Protocol not supported"
      hostPort, // "Invalid URL" for every call
      `http//${hostPort}`, // the colon missing
      `${base}​`, // a zero-width space pasted after it
      `http://user:secret@${hostPort}`, // fetch refuses it (the check said "unreachable"), while the optimize call sent it
      `${base}?x=1`, // every call reached "/" with the path in the query: 404, "The route optimizer is being updated"
    ];
    for (const url of unusable) {
      seen.length = 0;
      const r = await allThree(url, 'solver-token');
      expect(r.ready, JSON.stringify(url)).toMatchObject({ status: 'misconfigured', reason: 'SOLVER_URL_INVALID' });
      expect(r.optimize).toEqual({ ok: false, status: 0, message: expect.stringMatching(/^SOLVER_URL on the web service is not a usable address/) });
      expect(r.geometry).toEqual({ kind: 'failed' });
      expect(seen).toEqual([]);
    }
    // Forms the URL parser reads as http://host:port for every call still work.
    for (const url of [`HTTP://${hostPort}`, `http:${hostPort}`]) {
      seen.length = 0;
      const r = await allThree(url, 'solver-token');
      expect(r.ready, url).toMatchObject({ status: 'ready', reason: 'OK' });
      expect(r.optimize).toEqual({ ok: true, runId: 'r1' });
      expect(r.geometry).toMatchObject({ kind: 'answer' });
      expect(seen.map((s) => s.call)).toEqual(['GET /ready', 'POST /optimize-dispatch', 'POST /route-geometry']);
    }
  });

  it('third review of audit PR4: a SOLVER_URL that answers with a redirect (an http-to-https edge) is never ready, and no call follows it', async () => {
    for (const code of [301, 302, 307, 308]) {
      seen.length = 0;
      const edgeCalls: string[] = [];
      const edge = await listen((req, res) => {
        edgeCalls.push(`${req.method} ${req.url}`);
        req.resume();
        res.writeHead(code, { location: `${base}${req.url}` });
        res.end();
      });
      try {
        const r = await allThree(edge.base, 'solver-token');
        expect(r.ready, String(code)).toMatchObject({ status: 'degraded', reason: 'SOLVER_URL_REDIRECTS' });
        expect(r.optimize).toEqual({ ok: false, status: code, message: expect.stringMatching(/redirect/i) });
        expect(r.geometry).toEqual({ kind: 'failed', status: code });
        expect(edgeCalls).toEqual(['GET /ready', 'POST /optimize-dispatch', 'POST /route-geometry']);
        // The token never went on to the address the redirect names.
        expect(seen).toEqual([]);
      } finally {
        await edge.close();
      }
    }
  });

  it('third review of audit PR4: a /ready answer whose body stops half-way is degraded within the timeout, never a hang', async () => {
    const stalled = await listen((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '60' });
      res.write('{"ok":tr');
    });
    try {
      const t0 = Date.now();
      const r = await within(checkDispatchReadiness(env({ SOLVER_URL: stalled.base, SOLVER_TOKEN: 'solver-token' }), fetch, 300), 3000);
      expect(r).toMatchObject({ status: 'degraded', reason: 'SOLVER_UNREACHABLE' });
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      await stalled.close();
    }
  });
});
