import http from 'node:http';
import https from 'node:https';
import type { DispatchRequest, DispatchResponse } from '@routeiq/shared-types';
import type { RouteGeometryReply } from '@/lib/dispatch/load-geometry';
import { QUICK_SOLVER_WAIT_MS, solverWaitMs } from '@/lib/dispatch/search-mode';
import { PLANNER_UNAVAILABLE_MESSAGE, WORKERS_UNAVAILABLE } from '@/lib/planner-unavailable';
import { TOKEN_CANNOT_BE_SENT, URL_EXPECTED, URL_NOT_USABLE, solverEnv, solverUrlUsable, tokenCanBeSent } from '@/lib/solver-env';

export class SolverError extends Error {
  readonly status: number;
  readonly responseBody: unknown;
  /** The optimizer's own refusal code, when it sent one (e.g. WORKERS_UNAVAILABLE, rule 22). */
  readonly code?: string;
  constructor(message: string, status: number, responseBody: unknown, code?: string) {
    super(message);
    this.status = status;
    this.responseBody = responseBody;
    if (code) this.code = code;
  }
}

/** The `code` of a solver answer body ({ detail, code }), if it has one. */
function answerCode(text: string): string | undefined {
  try {
    const j = JSON.parse(text) as { code?: unknown };
    return typeof j?.code === 'string' ? j.code : undefined;
  } catch {
    return undefined;
  }
}

// QUICK: the solver answers within its SOLVER_BUDGET_SEC (540 s, road routing at most 90 s of it);
// 600 s leaves the margin. THOROUGH: its cap + 2 minutes (lib/dispatch/search-mode.ts, solverWaitMs).
export const DISPATCH_TIMEOUT_MS = QUICK_SOLVER_WAIT_MS;
/** TCP keepalive on the solver connection: a 20-minute silent request must not look idle to the network. */
export const SOLVER_KEEPALIVE_MS = 30_000;

/**
 * POST JSON and wait up to `timeoutMs` for the answer. Plain `fetch` cannot be used for long
 * solves: Node's fetch (undici) gives up after 300 s without response headers, whatever the
 * AbortController says, and the solver sends nothing until the whole plan is ready. Its own
 * connection (no shared agent, so no agent idle timeout applies) with TCP keepalive every 30 s.
 */
export function postJsonLong(
  urlStr: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledSolve());
      return;
    }
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    let timer: NodeJS.Timeout | undefined;
    const req = mod.request(
      u,
      {
        method: 'POST',
        agent: false,
        headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
      },
    );
    timer = setTimeout(() => req.destroy(new Error(`no answer after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    // Cancelled by the caller (the hire suggestion's what-if when a dispatcher's solve needs its slot):
    // the connection closes and the solver cancels that solve within about a second.
    const onAbort = () => req.destroy(new CancelledSolve());
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    req.on('socket', (s) => s.setKeepAlive(true, SOLVER_KEEPALIVE_MS));
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end(body);
  });
}

/** The caller cancelled the optimizer call (postJsonLong's signal). */
export class CancelledSolve extends Error {
  constructor() {
    super('cancelled by the caller');
  }
}

/**
 * A failed solver call (no HTTP answer) in plain words: a reset connection is the optimizer being
 * restarted or updated mid-search; a refused one is the optimizer not up; our own timer is no answer
 * in time. Nothing was saved in every case, and the plan can be optimized again.
 */
export function solverCallFailure(err: unknown, waitMs: number): SolverError {
  if (err instanceof SolverError) return err;
  if (err instanceof CancelledSolve) return new SolverError('The optimization was cancelled.', 0, null, 'CANCELLED');
  const e = err as { code?: string; message?: string } | null;
  const code = String(e?.code ?? '');
  const msg = String(e?.message ?? err ?? '');
  if (/^no answer after/.test(msg)) {
    return new SolverError(
      `The route optimizer did not answer within ${Math.round(waitMs / 60_000)} minutes. Nothing was saved - optimize again (Quick takes less time).`,
      0,
      { cause: msg },
    );
  }
  if (code === 'ECONNRESET' || code === 'EPIPE' || /socket hang up/i.test(msg)) {
    return new SolverError(
      'The route optimizer stopped during the search (it was restarted or updated). Nothing was saved - optimize again.',
      0,
      { cause: code || msg },
    );
  }
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new SolverError('The route optimizer cannot be reached right now (it may be restarting). Nothing was saved - try again in a minute.', 0, {
      cause: code,
    });
  }
  return new SolverError(`Solver call failed: ${msg}`, 0, null);
}

/**
 * NMWC dispatch planner (OR-Tools): POST /optimize-dispatch. SOLVER_URL and SOLVER_TOKEN are read
 * by solverEnv (lib/solver-env.ts), exactly as /api/health checks them (review of audit PR4).
 * A redirect is never followed (node:http), and /api/health does not follow one either (third
 * review of audit PR4).
 */
export async function callDispatchSolver(req: DispatchRequest, opts: { signal?: AbortSignal } = {}): Promise<DispatchResponse> {
  const { url, token } = solverEnv();
  if (!url) throw new SolverError('SOLVER_URL not set', 0, null);
  // Fourth review of audit PR4: say why, instead of node:http's "Protocol not supported" or
  // "Invalid URL" (lib/solver-env.ts); /api/health says SOLVER_URL_INVALID.
  if (!solverUrlUsable(url)) throw new SolverError(`${URL_NOT_USABLE}. An administrator must set it to ${URL_EXPECTED}.`, 0, null);
  if (!token) throw new SolverError('SOLVER_TOKEN not set', 0, null);
  // Third review of audit PR4: say why, instead of node:http's "Invalid character in header
  // content" or a 401 for a token sent as other bytes than the solver holds (lib/solver-env.ts).
  if (!tokenCanBeSent(token)) throw new SolverError(`${TOKEN_CANNOT_BE_SENT}. An administrator must copy it again as plain text.`, 0, null);
  // THOROUGH waits for its cap + 2 minutes; QUICK 600 s as before.
  const waitMs = solverWaitMs(req.config?.search_mode, req.config?.max_search_sec);
  let res: { status: number; text: string };
  try {
    res = await postJsonLong(`${url}/optimize-dispatch`, { 'X-Solver-Token': token }, JSON.stringify(req), waitMs, opts.signal);
  } catch (err) {
    throw solverCallFailure(err, waitMs);
  }
  if (res.status >= 300 && res.status < 400) {
    // An http-to-https edge or a proxy in front of the solver: /api/health says SOLVER_URL_REDIRECTS.
    throw new SolverError(
      "The route optimizer address (SOLVER_URL) answers with a redirect, which is not followed. An administrator must set SOLVER_URL to the solver's own address.",
      res.status,
      res.text,
    );
  }
  if (res.status === 404) {
    // Web and solver deploy independently: a new web briefly talking to the previous solver.
    throw new SolverError('The route optimizer is being updated. Try again in a minute.', 404, res.text);
  }
  if (res.status === 503) {
    // Rule 22: the optimizer could not start its worker processes (it refuses instead of freezing).
    if (answerCode(res.text) === WORKERS_UNAVAILABLE) throw new SolverError(PLANNER_UNAVAILABLE_MESSAGE, 503, res.text, WORKERS_UNAVAILABLE);
    // The solver runs at most MAX_CONCURRENT_DISPATCH solves at once (apps/solver/main.py).
    throw new SolverError('The route optimizer is busy with other plans right now. Optimize again in a minute.', 503, res.text);
  }
  if (res.status < 200 || res.status >= 300) {
    // The solver explains aborted solves in FastAPI's { detail } (e.g. 504: out of time / worker died).
    let detail: string | undefined;
    try {
      const j = JSON.parse(res.text) as { detail?: unknown };
      if (typeof j?.detail === 'string') detail = j.detail;
    } catch {
      /* not JSON */
    }
    throw new SolverError(detail ?? `Solver returned HTTP ${res.status}`, res.status, res.text);
  }
  return JSON.parse(res.text) as DispatchResponse;
}

/** What the optimizer said to "use the best plan found so far". */
export type StopSearchReply = 'STOPPING' | 'NOT_RUNNING' | 'NOT_STOPPABLE' | 'FAILED';

/**
 * "Use the best plan found so far" (THOROUGH): POST /optimize-dispatch/stop. The running solve ends
 * its search at the next plan it finds, skips the alternatives and re-checks the loads with QUICK's
 * time; the job then saves that plan as usual. Never throws.
 */
export async function callStopSearch(runId: string, tenantId: string): Promise<StopSearchReply> {
  const { url, token } = solverEnv();
  if (!url || !token || !solverUrlUsable(url) || !tokenCanBeSent(token)) return 'FAILED';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${url}/optimize-dispatch/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Solver-Token': token },
      body: JSON.stringify({ run_id: runId, tenant_id: tenantId }),
      signal: ctrl.signal,
      cache: 'no-store',
      redirect: 'manual',
    });
    if (res.ok) return 'STOPPING';
    if (res.status === 404) return 'NOT_RUNNING';
    if (res.status === 409) return 'NOT_STOPPABLE';
    return 'FAILED';
  } catch {
    return 'FAILED';
  } finally {
    clearTimeout(timer);
  }
}

const GEOMETRY_TIMEOUT_MS = 15_000;

/**
 * Road polyline for one load via the solver's configured OSRM. Never throws: the reply says whether
 * the solver answered (road shape, or its straight-line fallback with a warning), was not configured,
 * timed out (15 s, or `signal` aborted: the caller's deadline) or failed. See
 * `resolveLoadGeometries` in `lib/dispatch/load-geometry.ts` for how the plan map uses it.
 */
export async function callRouteGeometry(
  coords: [number, number][],
  osrmUrl?: string | null,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RouteGeometryReply> {
  const { url, token } = solverEnv();
  if (!url || !token) return { kind: 'not_configured' };
  // Third and fourth review of audit PR4: the same rules as the optimize call and /api/health - a
  // URL no call can use and a token that is not plain ASCII are not sent, and a redirect is not
  // followed (with the token) but failed.
  if (!solverUrlUsable(url) || !tokenCanBeSent(token)) return { kind: 'failed' };
  if (opts.signal?.aborted) return { kind: 'timeout' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? GEOMETRY_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(`${url}/route-geometry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Solver-Token': token },
      body: JSON.stringify({ coords, osrm_url: osrmUrl ?? null }),
      signal: ctrl.signal,
      cache: 'no-store',
      redirect: 'manual',
    });
    if (!res.ok) return { kind: 'failed', status: res.status };
    const b = (await res.json()) as { provider?: string; is_estimated?: boolean; coordinates?: [number, number][]; warning?: string | null };
    return {
      kind: 'answer',
      provider: String(b.provider ?? ''),
      isEstimated: b.is_estimated !== false,
      coordinates: Array.isArray(b.coordinates) ? b.coordinates : [],
      warning: b.warning ?? null,
    };
  } catch {
    return ctrl.signal.aborted ? { kind: 'timeout' } : { kind: 'failed' };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
