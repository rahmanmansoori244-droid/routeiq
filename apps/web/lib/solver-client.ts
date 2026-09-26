import http from 'node:http';
import https from 'node:https';
import type { DispatchRequest, DispatchResponse } from '@routeiq/shared-types';
import type { RouteGeometryReply } from '@/lib/dispatch/load-geometry';

export class SolverError extends Error {
  readonly status: number;
  readonly responseBody: unknown;
  constructor(message: string, status: number, responseBody: unknown) {
    super(message);
    this.status = status;
    this.responseBody = responseBody;
  }
}

// The solver answers within its SOLVER_BUDGET_SEC (540 s, road routing at most 90 s of it); 600 s
// leaves the margin (budget 540 s < this wait < the janitor 15 min).
export const DISPATCH_TIMEOUT_MS = 600_000;

/**
 * POST JSON and wait up to `timeoutMs` for the answer. Plain `fetch` cannot be used for long
 * solves: Node's fetch (undici) gives up after 300 s without response headers, whatever the
 * AbortController says, and the solver sends nothing until the whole plan is ready.
 */
export function postJsonLong(
  urlStr: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    let timer: NodeJS.Timeout | undefined;
    const req = mod.request(
      u,
      { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
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
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end(body);
  });
}

/** NMWC dispatch planner (OR-Tools): POST /optimize-dispatch. */
export async function callDispatchSolver(req: DispatchRequest): Promise<DispatchResponse> {
  const url = process.env.SOLVER_URL;
  const token = process.env.SOLVER_TOKEN;
  if (!url) throw new SolverError('SOLVER_URL not set', 0, null);
  if (!token) throw new SolverError('SOLVER_TOKEN not set', 0, null);
  const res = await postJsonLong(`${url}/optimize-dispatch`, { 'X-Solver-Token': token }, JSON.stringify(req), DISPATCH_TIMEOUT_MS);
  if (res.status === 404) {
    // Web and solver deploy independently: a new web briefly talking to the previous solver.
    throw new SolverError('The route optimizer is being updated. Try again in a minute.', 404, res.text);
  }
  if (res.status === 503) {
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
  const url = process.env.SOLVER_URL;
  const token = process.env.SOLVER_TOKEN;
  if (!url || !token) return { kind: 'not_configured' };
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
