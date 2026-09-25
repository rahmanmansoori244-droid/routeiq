/**
 * Review F16 / new issue: rate limits and audit rows must not trust the client-controlled LEFT
 * end of X-Forwarded-For. lib/client-ip.ts counts trusted proxy hops from the right.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetClientIpWarnings, clientIpFromHeaders } from '@/lib/client-ip';

const h = (init: Record<string, string>) => new Headers(init);
const env = (e: Record<string, string> = {}) => e as NodeJS.ProcessEnv;

describe('clientIpFromHeaders', () => {
  it('takes the right-most X-Forwarded-For entry by default (one trusted proxy)', () => {
    expect(clientIpFromHeaders(h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), env())).toBe('203.0.113.9');
  });
  it('a spoofed left-most entry does not change the result', () => {
    const a = clientIpFromHeaders(h({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }), env());
    const b = clientIpFromHeaders(h({ 'x-forwarded-for': '9.9.9.9, 203.0.113.9' }), env());
    expect(a).toBe(b);
  });
  it('a single entry (proxy overwrote the header) is the client', () => {
    expect(clientIpFromHeaders(h({ 'x-forwarded-for': '203.0.113.9' }), env())).toBe('203.0.113.9');
  });
  it('TRUSTED_PROXY_HOPS=2 skips the right-most proxy', () => {
    const headers = h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2' });
    expect(clientIpFromHeaders(headers, env({ TRUSTED_PROXY_HOPS: '2' }))).toBe('203.0.113.9');
  });
  it('fewer entries than hops: the left-most (written by a trusted proxy)', () => {
    expect(clientIpFromHeaders(h({ 'x-forwarded-for': '203.0.113.9' }), env({ TRUSTED_PROXY_HOPS: '3' }))).toBe('203.0.113.9');
  });
  it('TRUSTED_PROXY_HOPS=0 ignores forwarding headers', () => {
    const headers = h({ 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' });
    expect(clientIpFromHeaders(headers, env({ TRUSTED_PROXY_HOPS: '0' }))).toBeNull();
  });
  it('CLIENT_IP_HEADER names a single-value header set by the edge', () => {
    const headers = h({ 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '198.51.100.7' });
    expect(clientIpFromHeaders(headers, env({ CLIENT_IP_HEADER: 'X-Real-IP' }))).toBe('198.51.100.7');
  });
  it('falls back to X-Real-IP, then null', () => {
    expect(clientIpFromHeaders(h({ 'x-real-ip': '198.51.100.7' }), env())).toBe('198.51.100.7');
    expect(clientIpFromHeaders(h({}), env())).toBeNull();
  });
  it('accepts IPv6 and strips ports; rejects junk so a header cannot grow limiter keys', () => {
    expect(clientIpFromHeaders(h({ 'x-forwarded-for': '2001:db8::1' }), env())).toBe('2001:db8::1');
    expect(clientIpFromHeaders(h({ 'x-forwarded-for': '[2001:db8::1]:443' }), env())).toBe('2001:db8::1');
    expect(clientIpFromHeaders(h({ 'x-forwarded-for': '203.0.113.9:5555' }), env())).toBe('203.0.113.9');
    expect(clientIpFromHeaders(h({ 'x-forwarded-for': 'not-an-ip<script>' }), env())).toBeNull();
    expect(clientIpFromHeaders(h({ 'x-forwarded-for': '1'.repeat(200) }), env())).toBeNull();
  });
});

describe('internal-address warning', () => {
  beforeEach(() => _resetClientIpWarnings());
  it('warns once in production when the resolved client IP is internal (a proxy)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prod = { NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv;
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '203.0.113.9, 10.1.2.3' }), prod)).toBe('10.1.2.3');
    clientIpFromHeaders(new Headers({ 'x-forwarded-for': '172.20.0.5' }), prod);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/TRUSTED_PROXY_HOPS/);
    warn.mockRestore();
  });
});

describe('unresolved-address warning (the shared "unknown" sign-in bucket)', () => {
  const prod = (e: Record<string, string> = {}) => ({ NODE_ENV: 'production', ...e }) as unknown as NodeJS.ProcessEnv;
  beforeEach(() => _resetClientIpWarnings());

  it('a CLIENT_IP_HEADER the edge does not send gives null and one production warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.9' });
    expect(clientIpFromHeaders(headers, prod({ CLIENT_IP_HEADER: 'cf-connecting-ip' }))).toBeNull();
    expect(clientIpFromHeaders(headers, prod({ CLIENT_IP_HEADER: 'cf-connecting-ip' }))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/could not be resolved.*cf-connecting-ip/);
    warn.mockRestore();
  });

  it('TRUSTED_PROXY_HOPS=0 and a request without forwarding headers warn (once) in production', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '203.0.113.9' }), prod({ TRUSTED_PROXY_HOPS: '0' }))).toBeNull();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/TRUSTED_PROXY_HOPS=0/);
    _resetClientIpWarnings();
    expect(clientIpFromHeaders(new Headers({}), prod())).toBeNull();
    expect(String(warn.mock.calls[1]?.[0])).toMatch(/no X-Forwarded-For/);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('no warning outside production, and none when the address resolves', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(clientIpFromHeaders(new Headers({}), env())).toBeNull();
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '203.0.113.9' }), prod())).toBe('203.0.113.9');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
