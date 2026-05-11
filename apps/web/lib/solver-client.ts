import type { OptimizeRequest, OptimizeResponse } from '@routeiq/shared-types';

const SOLVER_TIMEOUT_MS = 240_000; // 4 min — hard ceiling > solver auto-scaling cap of 120s

export class SolverError extends Error {
  readonly status: number;
  readonly responseBody: unknown;
  constructor(message: string, status: number, responseBody: unknown) {
    super(message);
    this.status = status;
    this.responseBody = responseBody;
  }
}

export async function callSolver(req: OptimizeRequest): Promise<OptimizeResponse> {
  const url = process.env.SOLVER_URL;
  const token = process.env.SOLVER_TOKEN;
  if (!url) throw new SolverError('SOLVER_URL not set', 0, null);
  if (!token) throw new SolverError('SOLVER_TOKEN not set', 0, null);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SOLVER_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/optimize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Solver-Token': token,
      },
      body: JSON.stringify(req),
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      const body = await res.text();
      throw new SolverError(`Solver returned HTTP ${res.status}`, res.status, body);
    }
    return (await res.json()) as OptimizeResponse;
  } finally {
    clearTimeout(timer);
  }
}
