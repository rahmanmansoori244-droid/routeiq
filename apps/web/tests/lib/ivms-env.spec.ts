/**
 * IVMS live link (16 Oct 2026): the Railway variables (lib/ivms/env.ts). Read one way, never throwing,
 * and every problem names the variable, never its value (the API key travels in the provider's query
 * string). Every value here is invented: the provider host is example.test, the key and the secrets are
 * made up.
 */
import { describe, expect, it } from 'vitest';
import { ayunOrigin, ivmsApiReady, ivmsConfigProblems, ivmsEnvTouched, ivmsWebhookReady, readIvmsEnv } from '@/lib/ivms/env';
import { configProblems } from '@/lib/startup-checks';

const KEY = 'TESTKEY-ivms-only-ABCDEF';
const SECRET = 'webhook_secret_for_tests_only_abcdefghij';
const SECRET_OLD = 'previous_webhook_secret_for_tests_klmnopqrst';
const FULL = {
  AYUN_BASE_URL: 'https://ivms.example.test',
  AYUN_API_KEY: KEY,
  AYUN_TENANT_SLUG: 'demo-co',
  AYUN_WEBHOOK_SECRET: SECRET,
} as const;
const env = (over: Record<string, string | undefined> = {}) => ({ NODE_ENV: 'production', ...FULL, ...over }) as unknown as NodeJS.ProcessEnv;

describe('readIvmsEnv', () => {
  it('reads a complete configuration: the origin only, the key, the company, the secret, offsets 0', () => {
    const e = readIvmsEnv(env());
    expect(e).toEqual({
      disabled: false,
      origin: 'https://ivms.example.test',
      apiKey: KEY,
      tenantSlug: 'demo-co',
      webhookSecrets: [SECRET],
      apiTimeOffsetMin: 0,
      webhookTimeOffsetMin: 0,
      problems: [],
    });
    expect(ivmsApiReady(e)).toBe(true);
    expect(ivmsWebhookReady(e)).toBe(true);
  });

  it('nothing set: not ready, no problem, and the startup log is unchanged', () => {
    const blank = { NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv;
    const e = readIvmsEnv(blank);
    expect(e.origin).toBeNull();
    expect(e.apiKey).toBeNull();
    expect(e.problems).toEqual([]);
    expect(ivmsApiReady(e)).toBe(false);
    expect(ivmsWebhookReady(e)).toBe(false);
    expect(ivmsEnvTouched(blank)).toBe(false);
    expect(ivmsConfigProblems(blank)).toEqual([]);
    // The kill switch alone does not make the feature "configured".
    expect(ivmsConfigProblems({ ...blank, ROUTEIQ_DISABLE_IVMS: '1' } as NodeJS.ProcessEnv)).toEqual([]);
    expect(configProblems({ NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv).filter((p) => /Ayun|AYUN|GPS/.test(p.message))).toEqual([]);
  });

  it('trims spaces and line breaks around every value', () => {
    const e = readIvmsEnv(env({ AYUN_BASE_URL: '  https://ivms.example.test/ \n', AYUN_API_KEY: ` ${KEY}\n`, AYUN_TENANT_SLUG: ' Demo-Co ' }));
    expect(e.origin).toBe('https://ivms.example.test');
    expect(e.apiKey).toBe(KEY);
    expect(e.tenantSlug).toBe('demo-co');
    expect(e.problems).toEqual([]);
  });

  it('ROUTEIQ_DISABLE_IVMS=1 stops everything, whatever else is set', () => {
    const e = readIvmsEnv(env({ ROUTEIQ_DISABLE_IVMS: '1' }));
    expect(e.disabled).toBe(true);
    expect(ivmsApiReady(e)).toBe(false);
    expect(ivmsWebhookReady(e)).toBe(false);
    expect(ivmsConfigProblems(env({ ROUTEIQ_DISABLE_IVMS: '1' }))).toEqual(['GPS tracking (Ayun): ROUTEIQ_DISABLE_IVMS=1: all GPS tracking work is stopped.']);
    expect(readIvmsEnv(env({ ROUTEIQ_DISABLE_IVMS: '0' })).disabled).toBe(false);
  });

  it('the previous webhook secret is accepted during a rotation, after the current one', () => {
    const e = readIvmsEnv(env({ AYUN_WEBHOOK_SECRET_PREVIOUS: SECRET_OLD }));
    expect(e.webhookSecrets).toEqual([SECRET, SECRET_OLD]);
    const onlyOld = readIvmsEnv(env({ AYUN_WEBHOOK_SECRET: '', AYUN_WEBHOOK_SECRET_PREVIOUS: SECRET_OLD }));
    expect(onlyOld.problems).toContain('AYUN_WEBHOOK_SECRET_PREVIOUS is set without AYUN_WEBHOOK_SECRET');
  });

  it('refuses a short or unusual secret, an unusual key and an unusual company slug', () => {
    const e = readIvmsEnv(env({ AYUN_WEBHOOK_SECRET: 'short', AYUN_API_KEY: 'has space inside', AYUN_TENANT_SLUG: 'not a slug!' }));
    expect(e.webhookSecrets).toEqual([]);
    expect(e.apiKey).toBeNull();
    expect(e.tenantSlug).toBeNull();
    expect(e.problems).toEqual([
      'AYUN_API_KEY must be 8-128 plain ASCII characters without spaces (copy it again as plain text)',
      'AYUN_TENANT_SLUG is not a company slug',
      'AYUN_WEBHOOK_SECRET must be 32-128 characters of A-Z, a-z, 0-9, _ and -',
    ]);
    expect(ivmsApiReady(e)).toBe(false);
    expect(ivmsWebhookReady(e)).toBe(false);
  });

  it('never puts a value in a problem or in the startup log (only the variable names)', () => {
    const marker = 'MARKER-VALUE-9f3a';
    const bad = env({
      AYUN_BASE_URL: `http://${marker}.example.test/x?key=${marker}`,
      AYUN_API_KEY: `${marker} with spaces`,
      AYUN_TENANT_SLUG: `${marker} slug`,
      AYUN_WEBHOOK_SECRET: `${marker}!`,
      AYUN_API_TIME_OFFSET_MIN: `${marker}`,
    });
    const text = JSON.stringify([readIvmsEnv(bad).problems, ivmsConfigProblems(bad), configProblems(bad)]);
    expect(text).not.toContain(marker);
    expect(text).not.toContain(KEY);
    // A good key is never in the log either (only a problem about another variable is).
    const good = env({ AYUN_TENANT_SLUG: '' });
    const log = JSON.stringify(configProblems(good));
    expect(log).toContain('AYUN_TENANT_SLUG not set');
    expect(log).not.toContain(KEY);
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain('ivms.example.test');
  });

  it('time offsets: whole minutes -720..720, one per channel; a bad API offset stops the calls (it would shift every time)', () => {
    const e = readIvmsEnv(env({ AYUN_API_TIME_OFFSET_MIN: '-240', AYUN_WEBHOOK_TIME_OFFSET_MIN: '+0' }));
    expect([e.apiTimeOffsetMin, e.webhookTimeOffsetMin, e.problems]).toEqual([-240, 0, []]);
    for (const bad of ['721', '-721', '1.5', 'four', '4h']) {
      const b = readIvmsEnv(env({ AYUN_API_TIME_OFFSET_MIN: bad }));
      expect(b.apiTimeOffsetMin, bad).toBe(0);
      expect(b.problems, bad).toEqual(['AYUN_API_TIME_OFFSET_MIN must be a whole number of minutes from -720 to 720']);
      expect(ivmsApiReady(b), bad).toBe(false);
      expect(ivmsWebhookReady(b), bad).toBe(true);
    }
    const w = readIvmsEnv(env({ AYUN_WEBHOOK_TIME_OFFSET_MIN: '9999' }));
    expect(ivmsApiReady(w)).toBe(true);
    expect(ivmsWebhookReady(w)).toBe(false);
  });

  it('startup log: names what is missing, once, and never throws on any input', () => {
    expect(ivmsConfigProblems(env({ AYUN_API_KEY: '', AYUN_BASE_URL: '' }))).toEqual([
      'GPS tracking (Ayun): AYUN_BASE_URL, AYUN_API_KEY not set: no call is made to Ayun whatever the company\'s GPS setting.',
    ]);
    expect(ivmsConfigProblems(env({ AYUN_BASE_URL: 'http://ivms.example.test' }))).toEqual([
      'GPS tracking (Ayun): AYUN_BASE_URL must start with https:// (the API key must never travel in clear text).',
    ]);
    for (const weird of ['​', '%%%', '://', 'https://', 'https://[::1', '\n\n']) {
      expect(() => readIvmsEnv(env({ AYUN_BASE_URL: weird, AYUN_API_KEY: weird, AYUN_WEBHOOK_SECRET: weird }))).not.toThrow();
    }
  });
});

describe('ayunOrigin: the one host RouteIQ calls', () => {
  const ok = (raw: string, nodeEnv = 'production') => ayunOrigin(raw, nodeEnv);
  it('https only, the origin only (a port is kept)', () => {
    expect(ok('https://ivms.example.test')).toEqual({ origin: 'https://ivms.example.test' });
    expect(ok('https://ivms.example.test:8443/')).toEqual({ origin: 'https://ivms.example.test:8443' });
    expect(ok('HTTPS://IVMS.Example.Test')).toEqual({ origin: 'https://ivms.example.test' });
  });
  it('refuses http, a user, a path, a query or a fragment, and anything that is not an address', () => {
    for (const raw of [
      'http://ivms.example.test',
      'https://user:pw@ivms.example.test',
      'https://ivms.example.test/api/api.php',
      'https://ivms.example.test/?api=user',
      'https://ivms.example.test/#x',
      'ftp://ivms.example.test',
      'ivms.example.test',
      'https://ivms.example.test​',
    ]) {
      expect('problem' in ok(raw), raw).toBe(true);
    }
  });
  it('plain http only to a loopback address, and only under NODE_ENV=test (the integration tests\' fake provider)', () => {
    expect(ok('http://127.0.0.1:4010', 'test')).toEqual({ origin: 'http://127.0.0.1:4010' });
    expect('problem' in ok('http://127.0.0.1:4010', 'production')).toBe(true);
    expect('problem' in ok('http://ivms.example.test', 'test')).toBe(true);
  });
});
