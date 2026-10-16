/**
 * IVMS live link (16 Oct 2026): Ayun's webhook, GET or POST /api/ivms/ayun/<AYUN_WEBHOOK_SECRET>
 * (app/api/ivms/ayun/[secret]/route.ts). Ayun calls it for the events it is told to (Depot IN and Depot
 * OUT only), at most once, about a minute late, without retries, and ignores the answer. Its documentation
 * says GET; its code sends POST with the parameters in the query string; so both methods are taken and the
 * parameters are read from the query string AND the form body (urlencoded, multipart or JSON).
 *
 * Order of the checks, each answered at once (no processing here: the processing step reads the rows):
 * 1. No secret configured: 404, as if the route did not exist.
 * 2. A wrong secret: 404, counted per IP (LIMITS.ivmsBadSecret; never an internal or unknown IP: that
 *    would be a proxy, as for the driver links); over the limit 429 with Retry-After.
 * 3. The kill switch (ROUTEIQ_DISABLE_IVMS=1), the company unknown or its ivmsMode OFF: 200, nothing read,
 *    nothing written - not even a counter.
 * 4. Per company at most LIMITS.ivmsWebhook a minute (Ayun sends up to 150 a run): over it 429 (the event
 *    is lost; the backstop may still find it).
 * 5. The body: at most 16 KB (413). Only imei, type, desc, zone_name, lat, lng, dt_tracker and dt_server
 *    are read; the user name, object name, driver, SIM, VIN, plate, trailer, odometer and engine hours the
 *    provider adds are never read, stored or logged, and neither is the payload.
 * 6. Only zone_in / zone_out (Depot IN / OUT) are kept; anything else is counted as ignored. A time
 *    outside [now - 26 h, now + 2 min] (usually a wrong AYUN_WEBHOOK_TIME_OFFSET_MIN) is counted apart.
 * 7. The IMEI is looked up among the company's own active trucks only; an unknown IMEI is counted and
 *    nothing is stored (another vehicle's data never lands here).
 * 8. One IvmsEvent row (events.ts: depot or not; dedupe.ts: the same key as the backstop's), at most
 *    200 per truck per day (M6). The same event again is a 200 with no new row.
 * Never logged: the URL (it holds the secret), the parameters, the body.
 */
import { clientIp, isInternalIp } from '../client-ip';
import { limiter as processLimiter, LIMITS, type RateLimiter } from '../rate-limit';
import { ivmsWebhookReady, readIvmsEnv, type IvmsEnv } from './env';
import { zoneEventRow } from './events';
import { zoneEventOf } from './parse';
import { prismaIvmsStore, type IvmsCompany, type IvmsStore } from './store';
import { ivmsWebhookAuthorized } from './webhook-auth';

export const WEBHOOK_MAX_BYTES = 16 * 1024;
/** The only parameters ever read from a webhook call. */
export const WEBHOOK_FIELDS = ['imei', 'type', 'desc', 'zone_name', 'lat', 'lng', 'dt_tracker', 'dt_server'] as const;
export type WebhookFields = Partial<Record<(typeof WEBHOOK_FIELDS)[number], string>>;

const HEADERS = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
const answer = (body: string, status: number, extra: Record<string, string> = {}) => new Response(body, { status, headers: { ...HEADERS, ...extra } });
const ok = () => answer('ok', 200);
const notFound = () => answer('Not found', 404);
const tooMany = (resetAt: number, nowMs: number) => answer('Too many requests', 429, { 'Retry-After': String(Math.max(1, Math.ceil((resetAt - nowMs) / 1000))) });

/** The body as text, cut at `max` bytes whatever the headers say; null = too large. */
async function readBodyCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function pick(into: WebhookFields, get: (k: string) => unknown): void {
  for (const k of WEBHOOK_FIELDS) {
    const v = get(k);
    if (typeof v === 'string') into[k] = v.slice(0, 200);
    else if (typeof v === 'number' && Number.isFinite(v)) into[k] = String(v);
  }
}

/**
 * The webhook's fields from the query string and the body (the body wins where both carry one). Null =
 * the body is larger than WEBHOOK_MAX_BYTES. A body that cannot be read as a form or JSON adds nothing.
 */
export async function webhookFields(req: Request): Promise<WebhookFields | null> {
  const out: WebhookFields = {};
  const query = new URL(req.url).searchParams;
  pick(out, (k) => query.get(k) ?? undefined);
  if (req.method !== 'POST') return out;
  const body = await readBodyCapped(req, WEBHOOK_MAX_BYTES);
  if (body === null) return null;
  if (!body.trim()) return out;
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  try {
    if (type.includes('application/json')) {
      const j: unknown = JSON.parse(body);
      if (j && typeof j === 'object' && !Array.isArray(j)) pick(out, (k) => (j as Record<string, unknown>)[k]);
    } else if (type.includes('multipart/form-data')) {
      const form = await new Response(body, { headers: { 'content-type': req.headers.get('content-type') ?? '' } }).formData();
      pick(out, (k) => form.get(k) ?? undefined);
    } else {
      const form = new URLSearchParams(body);
      pick(out, (k) => form.get(k) ?? undefined);
    }
  } catch {
    // Not a form or JSON: only the query string counts.
  }
  return out;
}

/** The company and its mode, read at most every 30 s (the webhook answers fast; a mode change shows within 30 s). */
const cache = new Map<string, { at: number; company: IvmsCompany | null }>();
async function companyOf(store: IvmsStore, slug: string, nowMs: number): Promise<IvmsCompany | null> {
  const hit = cache.get(slug);
  if (hit && nowMs - hit.at < 30_000 && nowMs >= hit.at) return hit.company;
  const company = await store.company(slug);
  cache.set(slug, { at: nowMs, company });
  return company;
}

/** Tests only. */
export function _resetWebhookCache(): void {
  cache.clear();
}

export interface WebhookDeps {
  env?: IvmsEnv;
  store?: IvmsStore;
  now?: Date;
  limiter?: Pick<RateLimiter, 'consume'>;
}

/** One webhook call (see the header). Never throws; a database failure answers 503 and logs its code only. */
export async function handleAyunWebhook(req: Request, secret: unknown, deps: WebhookDeps = {}): Promise<Response> {
  const env = deps.env ?? readIvmsEnv();
  const now = deps.now ?? new Date();
  const lim = deps.limiter ?? processLimiter;
  if (!env.webhookSecrets.length) return notFound();
  if (!ivmsWebhookAuthorized(secret, env)) {
    const ip = clientIp(req);
    if (ip && !isInternalIp(ip)) {
      const r = lim.consume(`ivms-bad:${ip}`, LIMITS.ivmsBadSecret.limit, LIMITS.ivmsBadSecret.windowMs);
      if (!r.ok) return tooMany(r.resetAt, now.getTime());
    }
    return notFound();
  }
  if (!ivmsWebhookReady(env) || !env.tenantSlug) return ok();
  const store = deps.store ?? prismaIvmsStore;
  try {
    const c = await companyOf(store, env.tenantSlug, now.getTime());
    if (!c || c.mode === 'OFF') return ok();
    const r = lim.consume(`ivms-wh:${c.tenantId}`, LIMITS.ivmsWebhook.limit, LIMITS.ivmsWebhook.windowMs);
    if (!r.ok) return tooMany(r.resetAt, now.getTime());
    const fields = await webhookFields(req);
    if (fields === null) return answer('Too large', 413);
    const parsed = zoneEventOf(fields, now, env.webhookTimeOffsetMin);
    if (!parsed.ok) {
      await store.bumpWebhookCounter(c.tenantId, parsed.problem === 'TIME' ? 'webhooksBadTime' : 'webhooksIgnored', now);
      return ok();
    }
    const truck = await store.truckByImei(c.tenantId, parsed.event.imei);
    if (!truck) {
      await store.bumpWebhookCounter(c.tenantId, 'webhooksIgnored', now);
      return ok();
    }
    const row = zoneEventRow(parsed.event, truck, await store.depotZones(c.tenantId), 'WEBHOOK', now);
    const ins = await store.insertZoneEvents(c.tenantId, [row], now);
    await store.bumpWebhookCounter(c.tenantId, ins.inserted || ins.duplicates ? 'webhooksToday' : 'webhooksIgnored', now);
    return ok();
  } catch (err) {
    console.error('ivms webhook: not stored', (err as { code?: string } | null)?.code ?? (err as Error)?.name ?? 'error');
    return answer('Unavailable', 503);
  }
}
