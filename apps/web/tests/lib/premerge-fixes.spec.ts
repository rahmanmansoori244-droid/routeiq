import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorMessage } from '../../lib/error-message';
import { WHOLE_WORLD, coordStatus, isOmanUae, parseServiceArea, routingProviderFor } from '../../lib/dispatch/customer-attrs';
import { DEFAULT_SERVICE_AREA } from '../../lib/dispatch/location-input';
import { postJsonLong } from '../../lib/solver-client';

describe('errorMessage', () => {
  it('uses a plain string error', () => {
    expect(errorMessage({ error: 'Depot is inactive' }, 'fallback')).toBe('Depot is inactive');
  });
  it('reads structured errors instead of falling back', () => {
    expect(errorMessage({ error: { code: 'LATE_REASON_REQUIRED', message: 'Enter the reason.' } }, 'Confirm failed.')).toBe('Enter the reason.');
    expect(errorMessage({ error: { error: 'Legacy plan.', code: 'LEGACY_PLAN' } }, 'Optimize failed.')).toBe('Legacy plan.');
    expect(errorMessage({ error: { fieldErrors: { name: ['Name is required'] }, formErrors: [] } }, 'Save failed.')).toBe('Name is required');
    expect(errorMessage({ error: { formErrors: ['Bad request'] } }, 'x')).toBe('Bad request');
  });
  it('falls back when there is nothing readable', () => {
    expect(errorMessage({}, 'Save failed.')).toBe('Save failed.');
    expect(errorMessage(null, 'Save failed.')).toBe('Save failed.');
    expect(errorMessage({ error: { code: 'X' } }, 'Save failed.')).toBe('Save failed.');
  });
});

describe('parseServiceArea', () => {
  const riyadh: [number, number] = [24.71, 46.68];
  it('keeps the Oman + UAE box for Omani / UAE tenants and when the country is unknown', () => {
    for (const c of ['Oman', ' oman ', 'OM', 'UAE', 'United Arab Emirates', undefined, null, '']) {
      expect(parseServiceArea(null, c)).toEqual(DEFAULT_SERVICE_AREA);
    }
    expect(coordStatus(riyadh[0], riyadh[1], parseServiceArea(null, 'Oman'))).toBe('OUTSIDE_AREA');
  });
  it('does not flag every customer of a tenant in another country as outside', () => {
    expect(parseServiceArea(null, 'Saudi Arabia')).toEqual(WHOLE_WORLD);
    expect(coordStatus(riyadh[0], riyadh[1], parseServiceArea(null, 'Saudi Arabia'))).toBe('OK');
  });
  it('recognises Oman / UAE however the country is written', () => {
    for (const c of ['Oman', 'Sultanate of Oman', 'OM', 'OMN', 'UAE', 'U.A.E.', 'United Arab Emirates', 'Dubai, UAE', 'عمان', 'سلطنة عمان', 'الإمارات', 'الامارات العربية المتحدة', 'Émirats arabes unis', 'Vereinigte Arabische Emirate', 'Emiratos Árabes Unidos']) {
      expect(isOmanUae(c), c).toBe(true);
    }
    for (const c of ['Saudi Arabia', 'Qatar', 'Kuwait', 'Rome', 'Germany', 'Romania', 'India']) {
      expect(isOmanUae(c), c).toBe(false);
    }
  });
  it('plans outside the OSRM map on straight lines unless the tenant has its own OSRM', () => {
    expect(routingProviderFor({ distanceProvider: 'OSRM' }, 'Oman')).toEqual({ provider: 'OSRM', outsideCoverage: false });
    expect(routingProviderFor({ distanceProvider: 'OSRM' }, 'Saudi Arabia')).toEqual({ provider: 'HAVERSINE', outsideCoverage: true });
    expect(routingProviderFor({ distanceProvider: 'OSRM', osrmUrl: 'http://ksa-osrm:5000' }, 'Saudi Arabia').provider).toBe('OSRM');
    expect(routingProviderFor({ distanceProvider: 'HAVERSINE' }, 'Oman')).toEqual({ provider: 'HAVERSINE', outsideCoverage: false });
    expect(routingProviderFor({ distanceProvider: 'MAPBOX_MATRIX' }, 'Oman').provider).toBe('OSRM');
  });
  it('a configured box always wins', () => {
    const box = { minLat: 20, maxLat: 30, minLng: 40, maxLng: 50 };
    expect(parseServiceArea(box, 'Oman')).toEqual(box);
    expect(parseServiceArea(box, 'Saudi Arabia')).toEqual(box);
  });
});

describe('postJsonLong (solver call without fetch 300 s limit)', () => {
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const delay = req.url === '/slow' ? 1500 : 0;
        setTimeout(() => {
          res.writeHead(req.url === '/missing' ? 404 : 200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ echo: JSON.parse(body || 'null'), token: req.headers['x-solver-token'] ?? null }));
        }, delay);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('posts JSON with the headers and returns status + body', async () => {
    const res = await postJsonLong(`${base}/ok`, { 'X-Solver-Token': 't' }, JSON.stringify({ a: 1 }), 5_000);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ echo: { a: 1 }, token: 't' });
  });
  it('waits for a slow answer within the timeout', async () => {
    const res = await postJsonLong(`${base}/slow`, {}, '{}', 5_000);
    expect(res.status).toBe(200);
  });
  it('returns non-2xx statuses to the caller', async () => {
    expect((await postJsonLong(`${base}/missing`, {}, '{}', 5_000)).status).toBe(404);
  });
  it('gives up after its own timeout', async () => {
    await expect(postJsonLong(`${base}/slow`, {}, '{}', 200)).rejects.toThrow(/no answer after/);
  });
});
