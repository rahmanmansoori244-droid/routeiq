/**
 * IVMS live link (16 Oct 2026): the link's counters for /api/health (only with the janitor token, first
 * review LOW: kind codes and counts only, never a URL, a key, an IMEI, a company or a position) and the
 * status line of the Settings card (company admin). Null - and the health answer stays exactly as it was -
 * while no IVMS variable is set, the kill switch is on, or the company's ivmsMode is OFF.
 */
import { prisma } from '../db';
import { janitorAuthorized } from '../janitor-auth';
import { clockCheck, utcDay, type ClockState } from './budget';
import { ivmsApiReady, ivmsWebhookReady, readIvmsEnv, type IvmsEnv } from './env';
import { suggestedOffsetMin } from './parse';
import { ivmsModeAtLeast, ivmsModeOf } from './settings';
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
  /** budget.ts clockCheck: anything but OK pauses the history pulls and the GPS times (first review H-1). */
  clock: ClockState;
  /** The AYUN_API_TIME_OFFSET_MIN that would put the skew right, when it is clearly off; else null. */
  suggestedOffsetMin: number | null;
}

/**
 * /api/health's GPS block: only for a caller with the janitor token (first review LOW); null - and
 * nothing read - for anyone else. The health route itself stays public.
 */
export async function ivmsHealthForCaller(req: Request | undefined, now: Date = new Date()): Promise<IvmsHealth | null> {
  if (!req || !janitorAuthorized(req)) return null;
  return ivmsHealth(now);
}

/** The link's state for the Ayun account's company (or for `slug` only when it is that company). */
export async function ivmsHealth(now: Date = new Date(), deps: { env?: IvmsEnv; slug?: string } = {}): Promise<IvmsHealth | null> {
  const env = deps.env ?? readIvmsEnv();
  if (!env.tenantSlug || (!ivmsApiReady(env) && !ivmsWebhookReady(env))) return null;
  if (deps.slug !== undefined && deps.slug.toLowerCase() !== env.tenantSlug) return null;
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
  const skewSec = s?.providerSkewSec ?? null;
  return {
    mode,
    status: backoff ? 'backoff' : failing ? 'failing' : s?.lastOkAt ? 'ok' : 'waiting',
    lastOkAgeSec: s?.lastOkAt ? Math.max(0, Math.round((now.getTime() - s.lastOkAt.getTime()) / 1000)) : null,
    lastError: s?.lastError ?? null,
    calls: { ...calls, total: calls.map + calls.route + calls.events + calls.admin, budget: t.config.ivmsDailyCallBudget },
    webhooks: { received: n(s?.webhooksToday), ignored: n(s?.webhooksIgnored), badTime: n(s?.webhooksBadTime) },
    skewSec,
    clock: clockCheck({ skewSec, skewAt: s?.providerSkewAt ?? null, skewOffsetMin: s?.providerSkewOffsetMin ?? null }, env.apiTimeOffsetMin, now),
    suggestedOffsetMin: suggestedOffsetMin(skewSec, env.apiTimeOffsetMin),
  };
}

const ago = (sec: number | null) => (sec === null ? '' : sec < 120 ? ` ${sec} s ago` : sec < 7200 ? ` ${Math.round(sec / 60)} min ago` : ` ${Math.round(sec / 3600)} h ago`);

/**
 * The Settings card's status line (company admin): the link, the calls of the provider's day and - in
 * TIMES - why GPS times are paused when the provider's clock is off, with the variable to set. Pure.
 */
export function gpsStatusText(h: IvmsHealth): { text: string; warn: boolean } {
  const link =
    h.status === 'ok' ? `working (last answer${ago(h.lastOkAgeSec)})` : h.status === 'waiting' ? 'no answer yet' : h.status === 'backoff' ? `paused after an error (${h.lastError ?? 'unknown'})` : `failing (${h.lastError ?? 'unknown'})`;
  const parts = [`Ayun link: ${link}; ${h.calls.total} of ${h.calls.budget} calls today.`];
  let warn = h.status === 'failing' || h.status === 'backoff';
  if (ivmsModeAtLeast(h.mode, 'TIMES') && h.clock !== 'OK') {
    warn = true;
    if (h.clock === 'UNKNOWN') parts.push("GPS times wait for Ayun's next live position to check its clock.");
    else {
      const hours = h.skewSec === null ? '?' : String(Math.round(Math.abs(h.skewSec) / 360) / 10);
      const fix = h.suggestedOffsetMin !== null ? ` Set the Railway variable AYUN_API_TIME_OFFSET_MIN to ${h.suggestedOffsetMin} and redeploy.` : ' Check AYUN_API_TIME_OFFSET_MIN.';
      parts.push(`Ayun's times look about ${hours} h ${h.clock === 'AHEAD' ? 'ahead of' : 'behind'} RouteIQ's clock: GPS arrival and departure times are paused (nothing is pulled or written).${fix}`);
    }
  }
  return { text: parts.join(' '), warn };
}
