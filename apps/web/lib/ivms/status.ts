/**
 * IVMS live link (16 Oct 2026): the link's counters for /api/health (public: kind codes and counts only,
 * never a URL, a key, an IMEI, a company or a position) and for the Settings card. Null - and the health
 * answer stays exactly as it was - while no IVMS variable is set, the kill switch is on, or the company's
 * ivmsMode is OFF.
 */
import { prisma } from '../db';
import { utcDay } from './budget';
import { ivmsApiReady, ivmsWebhookReady, readIvmsEnv, type IvmsEnv } from './env';
import { ivmsModeOf } from './settings';
import type { IvmsMode } from './types';

export interface IvmsHealth {
  mode: IvmsMode;
  /** ok: the last call worked; waiting: no call yet; failing: the last call failed; backoff: calls paused (LIMIT, AUTH or repeated failures). */
  status: 'ok' | 'waiting' | 'failing' | 'backoff';
  /** Seconds since the last successful call, or null. */
  lastOkAgeSec: number | null;
  /** The last error's kind (types.ts AYUN_ERROR_KINDS), or null. */
  lastError: string | null;
  /** Calls of the provider's day (UTC) per class, and the daily allowance. */
  calls: { map: number; route: number; events: number; admin: number; total: number; budget: number };
  /** Webhooks of the provider's day: stored (or a repeat), ignored (unknown IMEI or type, a truck off duty, mode below TIMES), refused for their time. */
  webhooks: { received: number; ignored: number; badTime: number };
  /** The provider's clock as RouteIQ sees it (seconds; about +-14400 = times not in UTC: set the offset). */
  skewSec: number | null;
}

export async function ivmsHealth(now: Date = new Date(), deps: { env?: IvmsEnv } = {}): Promise<IvmsHealth | null> {
  const env = deps.env ?? readIvmsEnv();
  if (!env.tenantSlug || (!ivmsApiReady(env) && !ivmsWebhookReady(env))) return null;
  const t = await prisma.tenant.findUnique({
    where: { slug: env.tenantSlug },
    select: { config: { select: { ivmsMode: true, ivmsDailyCallBudget: true } }, ivmsState: true },
  });
  if (!t?.config) return null;
  const mode = ivmsModeOf(t.config);
  if (mode === 'OFF') return null;
  const s = t.ivmsState;
  const today = !!s && s.usageDay.toISOString().slice(0, 10) === utcDay(now);
  const n = (v: number | undefined) => (today ? (v ?? 0) : 0);
  const calls = { map: n(s?.mapCalls), route: n(s?.routeCalls), events: n(s?.eventCalls), admin: n(s?.adminCalls) };
  const backoff = !!s?.nextTryAt && s.nextTryAt.getTime() > now.getTime();
  const failing = !!s?.lastErrorAt && (!s.lastOkAt || s.lastErrorAt.getTime() > s.lastOkAt.getTime());
  return {
    mode,
    status: backoff ? 'backoff' : failing ? 'failing' : s?.lastOkAt ? 'ok' : 'waiting',
    lastOkAgeSec: s?.lastOkAt ? Math.max(0, Math.round((now.getTime() - s.lastOkAt.getTime()) / 1000)) : null,
    lastError: s?.lastError ?? null,
    calls: { ...calls, total: calls.map + calls.route + calls.events + calls.admin, budget: t.config.ivmsDailyCallBudget },
    webhooks: { received: n(s?.webhooksToday), ignored: n(s?.webhooksIgnored), badTime: n(s?.webhooksBadTime) },
    skewSec: s?.providerSkewSec ?? null,
  };
}
