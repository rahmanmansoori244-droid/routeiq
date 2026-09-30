/**
 * Service-token and startup configuration checks (review L7 / new issues):
 * - the janitor endpoint never accepts SOLVER_TOKEN in production (its own JANITOR_TOKEN only);
 * - startup warnings name the missing production settings (email, public URL, janitor token,
 *   RATE_LIMITS_DISABLED).
 */
import { describe, expect, it } from 'vitest';
import { expectedJanitorToken, janitorAuthorized } from '@/lib/janitor-auth';
import { configProblems } from '@/lib/startup-checks';
import { constantTimeEqual } from '@/lib/crypto';

const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;
const call = (headers: Record<string, string>) => new Request('http://localhost/api/cron/janitor', { method: 'POST', headers });

describe('janitor token', () => {
  it('production: only JANITOR_TOKEN, never the solver secret', () => {
    expect(expectedJanitorToken(env({ NODE_ENV: 'production', SOLVER_TOKEN: 'solver-secret' }))).toBe('');
    expect(janitorAuthorized(call({ 'x-janitor-token': 'solver-secret' }), env({ NODE_ENV: 'production', SOLVER_TOKEN: 'solver-secret' }))).toBe(false);
    const e = env({ NODE_ENV: 'production', SOLVER_TOKEN: 'solver-secret', JANITOR_TOKEN: 'janitor-secret' });
    expect(janitorAuthorized(call({ 'x-janitor-token': 'solver-secret' }), e)).toBe(false);
    expect(janitorAuthorized(call({ 'x-janitor-token': 'janitor-secret' }), e)).toBe(true);
    expect(janitorAuthorized(call({ authorization: 'Bearer janitor-secret' }), e)).toBe(true);
  });

  it('local development falls back to SOLVER_TOKEN', () => {
    expect(janitorAuthorized(call({ 'x-janitor-token': 'dev-token' }), env({ NODE_ENV: 'development', SOLVER_TOKEN: 'dev-token' }))).toBe(true);
  });

  it('refuses a missing or empty token', () => {
    expect(janitorAuthorized(call({}), env({ NODE_ENV: 'development', JANITOR_TOKEN: 'x' }))).toBe(false);
    expect(janitorAuthorized(call({ 'x-janitor-token': '' }), env({ NODE_ENV: 'development' }))).toBe(false);
  });

  it('constantTimeEqual compares exactly', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('tök', 'tök')).toBe(true);
  });
});

describe('startup configuration checks', () => {
  it('flags the missing production settings', () => {
    const msgs = configProblems(env({ NODE_ENV: 'production' })).map((p) => p.message).join('\n');
    expect(msgs).toMatch(/RESEND_API_KEY/);
    expect(msgs).toMatch(/AUTH_URL/);
    expect(msgs).toMatch(/JANITOR_TOKEN/);
  });

  it('audit F15: a production server without SOLVER_URL or SOLVER_TOKEN logs an error (no plan can be optimized)', () => {
    const base = { NODE_ENV: 'production', RESEND_API_KEY: 're_x', AUTH_URL: 'https://r.example', JANITOR_TOKEN: 'j' };
    const p = configProblems(env({ ...base, SOLVER_URL: 'http://solver' }));
    expect(p).toEqual([{ level: 'error', message: expect.stringMatching(/^SOLVER_TOKEN is not set/) }]);
    expect(configProblems(env(base)).map((x) => x.message.split(' ')[0])).toEqual(['SOLVER_URL', 'SOLVER_TOKEN']);
  });

  it('is quiet for a fully configured production server and outside production', () => {
    const ok = env({ NODE_ENV: 'production', RESEND_API_KEY: 're_x', AUTH_URL: 'https://r.example', JANITOR_TOKEN: 'j', SOLVER_URL: 'http://solver', SOLVER_TOKEN: 's' });
    expect(configProblems(ok)).toEqual([]);
    expect(configProblems(env({ NODE_ENV: 'development' }))).toEqual([]);
  });

  it('audit P5: an upload parser setting that is not usable is named (its default is used), in production and outside it', () => {
    const ok = { NODE_ENV: 'production', RESEND_API_KEY: 're_x', AUTH_URL: 'https://r.example', JANITOR_TOKEN: 'j', SOLVER_URL: 'http://solver', SOLVER_TOKEN: 's' };
    expect(configProblems(env({ ...ok, UPLOAD_WORKER_MAX_HEAP_MB: '768', UPLOAD_PARSE_TIMEOUT_MS: '20000', UPLOAD_PARSE_CONCURRENCY: '1' }))).toEqual([]);
    expect(configProblems(env({ ...ok, UPLOAD_PARSE_TIMEOUT_MS: '15s' }))).toEqual([
      { level: 'warn', message: 'UPLOAD_PARSE_TIMEOUT_MS="15s" is not a whole number from 250 to 600000: the default 15000 is used.' },
    ]);
    expect(configProblems(env({ NODE_ENV: 'development', UPLOAD_WORKER_MAX_HEAP_MB: '32' })).map((p) => p.message)).toEqual([
      'UPLOAD_WORKER_MAX_HEAP_MB="32" is not a whole number from 64 to 16384: the default 512 is used.',
    ]);
  });

  it('reports RATE_LIMITS_DISABLED on a production server as an error', () => {
    const p = configProblems(env({ NODE_ENV: 'production', RATE_LIMITS_DISABLED: '1', RESEND_API_KEY: 'k', AUTH_URL: 'u', JANITOR_TOKEN: 'j', SOLVER_URL: 'http://solver', SOLVER_TOKEN: 's' }));
    expect(p).toHaveLength(1);
    expect(p[0]!.level).toBe('error');
  });
});
