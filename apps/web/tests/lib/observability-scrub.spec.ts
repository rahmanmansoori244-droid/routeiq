/**
 * Driver-link tokens never reach Sentry (owner request 4 Oct 2026, spec section 16.1): the landing
 * path /d/<token> is rewritten in URLs, transaction names and breadcrumbs, the Authorization header
 * is dropped, the driver page and the driver API are never traced, and all four Sentry inits use
 * these hooks (a source scan). The salesman link (owner request 19 Oct 2026): /s/<token> likewise, whatever
 * follows the token (critique item 15), and /s and /api/s are never traced.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { driverTracesSampler, isDriverPath, isSalesPath, scrubBreadcrumb, scrubDriverToken, scrubSalesToken, scrubSentryEvent, sentryScrubOptions } from '@/lib/observability-scrub';

const T = 'Ab3_dE5-gH7iJ9kL1mN3oP5q';

describe('scrubDriverToken', () => {
  it('rewrites /d/<token> in paths and full URLs, and leaves /api/d/... alone', () => {
    expect(scrubDriverToken(`/d/${T}`)).toBe('/d/[token]');
    expect(scrubDriverToken(`https://routeiq.example/d/${T}?x=1`)).toBe('https://routeiq.example/d/[token]?x=1');
    expect(scrubDriverToken(`GET /d/${T}`)).toBe('GET /d/[token]');
    expect(scrubDriverToken('/api/d/manifest')).toBe('/api/d/manifest');
    expect(scrubDriverToken('/t/nmwc/dispatch')).toBe('/t/nmwc/dispatch');
    expect(scrubDriverToken('/d/[token]')).toBe('/d/[token]');
    expect(scrubDriverToken(`opened /d/${T} then /d/${T}`)).toBe('opened /d/[token] then /d/[token]');
  });

  it('knows a driver path', () => {
    for (const p of [`/d/${T}`, '/api/d/manifest', `https://x.example/d/${T}`, 'GET /api/d/actions', '/d']) expect(isDriverPath(p), p).toBe(true);
    for (const p of ['/dispatch', '/t/nmwc/d/x', '/api/drivers', '/api/dispatch/day', '', null]) expect(isDriverPath(p as string), String(p)).toBe(false);
  });
});

describe('the salesman link: /s/<token> (owner request 19 Oct 2026, critique item 15)', () => {
  it('rewrites the token in paths and URLs whatever follows it, before the driver check returns early; /api/s/view stays', () => {
    expect(scrubDriverToken(`/s/${T}`)).toBe('/s/[token]');
    expect(scrubDriverToken(`https://routeiq.example/s/${T}#R1`)).toBe('https://routeiq.example/s/[token]#R1');
    expect(scrubDriverToken(`see https://routeiq.example/s/${T}.`)).toBe('see https://routeiq.example/s/[token].');
    expect(scrubDriverToken(`a=1&u=/s/${T}&b=2`)).toBe('a=1&u=/s/[token]&b=2');
    expect(scrubDriverToken(`(/s/${T}), "/s/${T}"`)).toBe('(/s/[token]), "/s/[token]"');
    expect(scrubDriverToken('/api/s/view?route=R1')).toBe('/api/s/view?route=R1');
    expect(scrubSalesToken(`/s/${T}`)).toBe('/s/[token]');
    // Both kinds in one text.
    expect(scrubDriverToken(`/d/${T} and /s/${T}`)).toBe('/d/[token] and /s/[token]');
  });

  it('knows a salesman path; the sampler never traces one; the Authorization header is dropped', () => {
    for (const p of [`/s/${T}`, '/api/s/view', `https://x.example/s/${T}`, 'GET /api/s/view', '/s']) expect(isSalesPath(p), p).toBe(true);
    for (const p of ['/settings', '/t/nmwc/s/x', '/api/sales', '/api/dispatch/sales-links', '', null]) expect(isSalesPath(p as string), String(p)).toBe(false);
    const sampler = driverTracesSampler(0.5);
    expect(sampler({ name: `GET /s/${T}` })).toBe(0);
    expect(sampler({ name: 'GET /api/s/view' })).toBe(0);
    expect(sampler({ name: 'GET /api/dispatch/sales-links' })).toBe(0.5);
    const out = scrubSentryEvent({ request: { url: `https://routeiq.example/s/${T}`, headers: { Authorization: `SalesLink ${T}`, referer: `https://routeiq.example/s/${T}` } } });
    expect(JSON.stringify(out)).not.toContain(T);
    expect(out.request.headers).not.toHaveProperty('Authorization');
  });
});

describe('tracesSampler', () => {
  const sampler = driverTracesSampler(0.1);
  it('returns 0 for /d/ and /api/d/ and the configured rate otherwise', () => {
    expect(sampler({ name: `GET /d/${T}` })).toBe(0);
    expect(sampler({ name: 'GET /api/d/manifest' })).toBe(0);
    expect(sampler({ request: { url: `https://routeiq.example/d/${T}` } })).toBe(0);
    expect(sampler({ normalizedRequest: { url: 'https://routeiq.example/api/d/photos' } })).toBe(0);
    expect(sampler({ attributes: { 'http.target': '/api/d/manifest' } })).toBe(0);
    expect(sampler({ name: 'GET /api/runs/[id]/plan' })).toBe(0.1);
    expect(sampler({})).toBe(0.1);
    expect(sampler(undefined)).toBe(0.1);
  });
});

describe('beforeSend, beforeSendTransaction and beforeBreadcrumb', () => {
  it('drop the Authorization header, redact credentials and rewrite the token everywhere in the event', () => {
    const event = {
      transaction: `GET /d/${T}`,
      request: {
        url: `https://routeiq.example/d/${T}`,
        headers: { Authorization: `DriverLink ${T}`, cookie: 'session=1', referer: `https://routeiq.example/d/${T}`, 'user-agent': 'x' },
      },
      breadcrumbs: [{ category: 'navigation', data: { from: '/', to: `/d/${T}` } }],
      spans: [{ description: `GET https://routeiq.example/d/${T}` }],
    };
    const out = scrubSentryEvent(event);
    const json = JSON.stringify(out);
    expect(json).not.toContain(T);
    expect(out.request.headers).not.toHaveProperty('Authorization');
    expect(out.request.headers.cookie).toBe('[redacted]');
    expect(out.request.url).toBe('https://routeiq.example/d/[token]');
    expect(out.transaction).toBe('GET /d/[token]');
  });

  it('a breadcrumb keeps the path, never the token', () => {
    const b = scrubBreadcrumb({ category: 'fetch', message: `opened /d/${T}`, data: { url: `/d/${T}`, method: 'GET' } });
    expect(b.data.url).toBe('/d/[token]');
    expect(b.message).toBe('opened /d/[token]');
  });

  it('the options carry all four hooks', () => {
    const o = sentryScrubOptions(0.1);
    expect(Object.keys(o).sort()).toEqual(['beforeBreadcrumb', 'beforeSend', 'beforeSendTransaction', 'tracesSampler']);
  });
});

describe('every Sentry init uses the hooks (source scan)', () => {
  const WEB = path.resolve(__dirname, '../..');
  it.each(['sentry.client.config.ts', 'sentry.server.config.ts', 'sentry.edge.config.ts', 'lib/observability.ts'])('%s', (f) => {
    const src = readFileSync(path.join(WEB, f), 'utf8');
    expect(src).toMatch(/sentryScrubOptions\(/);
    expect(src).not.toMatch(/tracesSampleRate/);
  });
});
