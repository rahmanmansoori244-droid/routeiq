/**
 * Review F16 / new issue: rate limits and audit rows must not trust the client-controlled LEFT
 * end of X-Forwarded-For. lib/client-ip.ts counts trusted proxy hops from the right.
 */
import { describe, expect, it } from 'vitest';
import { clientIpFromHeaders } from '@/lib/client-ip';

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
