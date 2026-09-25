import { fail, ok } from '../api';
import type { StartResult } from './start-optimize';

/**
 * The HTTP answer for an optimize / re-plan start: the { data, error } envelope with the start's
 * status, plus its headers (Retry-After when the solve admission refused or queued nothing).
 * `extra` is merged into the body on success, `extraOnError` on an error.
 */
export function startResponse(res: StartResult, extra: Record<string, unknown> = {}, extraOnError: Record<string, unknown> = {}) {
  const out = res.status >= 400 ? fail({ ...res.body, ...extraOnError }, res.status) : ok({ ...res.body, ...extra }, res.status);
  for (const [k, v] of Object.entries(res.headers ?? {})) out.headers.set(k, v);
  return out;
}
