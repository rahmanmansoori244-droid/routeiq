/**
 * The IVMS live link's Railway variables (16 Oct 2026), read ONE way for every caller: the poller, the
 * webhook route, the admin's tracker picker and the startup log (in the style of lib/solver-env.ts).
 *
 * - Never throws (it runs inside instrumentation: a bad value must never take the web process down).
 * - A problem names the VARIABLE, never its value: the API key travels in the provider's query string,
 *   so neither it nor a URL built with it is ever logged, stored or put in an error.
 * - Server only: the API key must never reach a browser bundle. tests/lib/ivms-contract.spec.ts checks
 *   that no 'use client' module imports this file.
 *
 * Variables (names only; the values live in Railway, never in the repo):
 * - ROUTEIQ_DISABLE_IVMS   `1` stops all IVMS work: no call to Ayun, the webhook answers 200 and drops.
 * - AYUN_BASE_URL          the provider's origin, `https://<host>` (no user, path, query or fragment).
 *                          RouteIQ adds the fixed path AYUN_API_PATH and never follows a redirect, so
 *                          this host is the only one it ever calls. Plain http is refused (the key
 *                          would travel in clear text), except a loopback address under NODE_ENV=test.
 * - AYUN_API_KEY           the user API key: plain ASCII, no spaces, 8-128 characters.
 * - AYUN_TENANT_SLUG       the one company this Ayun account (and key) belongs to: no other company is
 *                          ever polled with it, and the webhook's secret binds to it.
 * - AYUN_WEBHOOK_SECRET    the secret in the webhook URL's path: 32-128 characters of A-Z a-z 0-9 _ -.
 * - AYUN_WEBHOOK_SECRET_PREVIOUS  optional, still accepted during a rotation; same rules.
 * - AYUN_API_TIME_OFFSET_MIN / AYUN_WEBHOOK_TIME_OFFSET_MIN  optional whole minutes (-720..720, default
 *                          0) added to the provider's times of that channel, for a provider that does
 *                          not send UTC (one per channel: critique M9). Muscat local time would be -240.
 */

export const IVMS_ENV = {
  disable: 'ROUTEIQ_DISABLE_IVMS',
  baseUrl: 'AYUN_BASE_URL',
  apiKey: 'AYUN_API_KEY',
  tenantSlug: 'AYUN_TENANT_SLUG',
  webhookSecret: 'AYUN_WEBHOOK_SECRET',
  webhookSecretPrevious: 'AYUN_WEBHOOK_SECRET_PREVIOUS',
  apiTimeOffset: 'AYUN_API_TIME_OFFSET_MIN',
  webhookTimeOffset: 'AYUN_WEBHOOK_TIME_OFFSET_MIN',
} as const;

/** The provider's user API path, added to AYUN_BASE_URL's origin. */
export const AYUN_API_PATH = '/api/api.php';

export const TIME_OFFSET_MAX_MIN = 720;

export interface IvmsEnv {
  /** ROUTEIQ_DISABLE_IVMS=1. */
  disabled: boolean;
  /** `https://host[:port]`, or null when not set or not usable. */
  origin: string | null;
  /** The API key, or null when not set or not usable. Never log it. */
  apiKey: string | null;
  /** The company the account belongs to (lower case), or null. */
  tenantSlug: string | null;
  /** The accepted webhook path secrets: the current one first, then the previous one. Never log them. */
  webhookSecrets: string[];
  apiTimeOffsetMin: number;
  webhookTimeOffsetMin: number;
  /** What is wrong, by variable name only (never a value). */
  problems: string[];
}

const KEY_RE = /^[\x21-\x7e]{8,128}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{32,128}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function trimmed(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The origin RouteIQ may call, or a reason it may not. Only `https:` with a host and nothing else; plain
 * `http:` only to a loopback address and only under NODE_ENV=test (the integration tests' fake provider).
 */
export function ayunOrigin(raw: string, nodeEnv: string | undefined): { origin: string } | { problem: string } {
  const name = IVMS_ENV.baseUrl;
  if (!/^[\x21-\x7e]+$/.test(raw)) return { problem: `${name} has a space or a character that is not plain ASCII` };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { problem: `${name} is not an address (expected https://<host>)` };
  }
  const loopbackTest = u.protocol === 'http:' && nodeEnv === 'test' && LOOPBACK.has(u.hostname);
  if (u.protocol !== 'https:' && !loopbackTest) return { problem: `${name} must start with https:// (the API key must never travel in clear text)` };
  if (u.username || u.password) return { problem: `${name} must not contain a user name or password` };
  if (u.search || u.hash || raw.includes('?') || raw.includes('#')) return { problem: `${name} must not contain ? or #` };
  if (u.pathname !== '/' && u.pathname !== '') return { problem: `${name} must be the address only, without a path (RouteIQ adds ${AYUN_API_PATH})` };
  return { origin: u.origin };
}

function offset(env: NodeJS.ProcessEnv, name: string, problems: string[]): number {
  const raw = trimmed(env, name);
  if (raw === '') return 0;
  if (!/^[+-]?\d{1,4}$/.test(raw) || Math.abs(Number(raw)) > TIME_OFFSET_MAX_MIN) {
    problems.push(`${name} must be a whole number of minutes from -${TIME_OFFSET_MAX_MIN} to ${TIME_OFFSET_MAX_MIN}`);
    return 0;
  }
  return Number(raw);
}

/** Every IVMS variable, checked. Never throws, never returns a value inside a problem. */
export function readIvmsEnv(env: NodeJS.ProcessEnv = process.env): IvmsEnv {
  const problems: string[] = [];
  const disabled = trimmed(env, IVMS_ENV.disable) === '1';

  let origin: string | null = null;
  const rawUrl = trimmed(env, IVMS_ENV.baseUrl);
  if (rawUrl) {
    const o = ayunOrigin(rawUrl, env.NODE_ENV);
    if ('origin' in o) origin = o.origin;
    else problems.push(o.problem);
  }

  let apiKey: string | null = null;
  const rawKey = trimmed(env, IVMS_ENV.apiKey);
  if (rawKey) {
    if (KEY_RE.test(rawKey)) apiKey = rawKey;
    else problems.push(`${IVMS_ENV.apiKey} must be 8-128 plain ASCII characters without spaces (copy it again as plain text)`);
  }

  let tenantSlug: string | null = null;
  const rawSlug = trimmed(env, IVMS_ENV.tenantSlug).toLowerCase();
  if (rawSlug) {
    if (SLUG_RE.test(rawSlug)) tenantSlug = rawSlug;
    else problems.push(`${IVMS_ENV.tenantSlug} is not a company slug`);
  }

  const webhookSecrets: string[] = [];
  for (const name of [IVMS_ENV.webhookSecret, IVMS_ENV.webhookSecretPrevious]) {
    const raw = trimmed(env, name);
    if (!raw) continue;
    if (SECRET_RE.test(raw)) webhookSecrets.push(raw);
    else problems.push(`${name} must be 32-128 characters of A-Z, a-z, 0-9, _ and -`);
  }
  if (trimmed(env, IVMS_ENV.webhookSecretPrevious) && !trimmed(env, IVMS_ENV.webhookSecret)) {
    problems.push(`${IVMS_ENV.webhookSecretPrevious} is set without ${IVMS_ENV.webhookSecret}`);
  }

  const apiTimeOffsetMin = offset(env, IVMS_ENV.apiTimeOffset, problems);
  const webhookTimeOffsetMin = offset(env, IVMS_ENV.webhookTimeOffset, problems);

  return { disabled, origin, apiKey, tenantSlug, webhookSecrets, apiTimeOffsetMin, webhookTimeOffsetMin, problems };
}

/** Is any IVMS variable (other than the kill switch) set? Nothing set = the feature was never configured. */
export function ivmsEnvTouched(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.values(IVMS_ENV).some((name) => name !== IVMS_ENV.disable && trimmed(env, name) !== '');
}

/**
 * May RouteIQ call the provider at all? Not disabled, origin, key and company set and usable, and no
 * problem with the time offsets (a wrong offset would shift every time). The company's ivmsMode decides
 * the rest.
 */
export function ivmsApiReady(e: IvmsEnv): boolean {
  return !e.disabled && !!e.origin && !!e.apiKey && !!e.tenantSlug && !e.problems.some((p) => p.startsWith(IVMS_ENV.apiTimeOffset));
}

/** May the webhook route store anything? Not disabled, a secret and the company set, the offset usable. */
export function ivmsWebhookReady(e: IvmsEnv): boolean {
  return !e.disabled && e.webhookSecrets.length > 0 && !!e.tenantSlug && !e.problems.some((p) => p.startsWith(IVMS_ENV.webhookTimeOffset));
}

/**
 * The startup log's lines (lib/startup-checks.ts), by variable name only. Nothing at all while no IVMS
 * variable is set (the feature was never configured: the log stays as it was).
 */
export function ivmsConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!ivmsEnvTouched(env)) return [];
  const e = readIvmsEnv(env);
  const out = e.problems.map((p) => `GPS tracking (Ayun): ${p}.`);
  const missing = [
    [IVMS_ENV.baseUrl, e.origin],
    [IVMS_ENV.apiKey, e.apiKey],
    [IVMS_ENV.tenantSlug, e.tenantSlug],
  ].filter(([name, v]) => !v && !e.problems.some((p) => p.startsWith(name as string)));
  if (missing.length) {
    out.push(`GPS tracking (Ayun): ${missing.map(([name]) => name).join(', ')} not set: no call is made to Ayun whatever the company's GPS setting.`);
  }
  if (e.disabled) out.push(`GPS tracking (Ayun): ${IVMS_ENV.disable}=1: all GPS tracking work is stopped.`);
  return out;
}
