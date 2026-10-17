/**
 * IVMS live link (16 Oct 2026): the one client of Ayun (lib/ivms/ayun-client.ts), on an injected fake
 * fetch: never a real call. Checked: the address is the configured origin + the fixed path with only
 * api / key / cmd; the command allow-list and digits-only parameters (a refused request is never sent);
 * redirects never followed; one deadline for headers and body; the body cap; the provider's "ERROR: ..."
 * texts (HTTP 200) classified before any JSON parse; `[]` is an answer; never a throw; and the key or the
 * address never appears in a result, an error, or any console line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ayunCommandText, callAyun, classifyAyunBody, classifyAyunError, ROUTE_MAX_WINDOW_MS, type AyunRequest } from '@/lib/ivms/ayun-client';
import { IMEI_A, IMEI_B, ivmsTestEnv, KEY } from './ivms-fakes';

const ENV = ivmsTestEnv();
const LOC: AyunRequest = { cmd: 'OBJECT_GET_LOCATIONS', imeis: [IMEI_B, IMEI_A] };

type Reply = { status?: number; body?: string | null; type?: ResponseType } | 'throw' | 'hang' | 'stall';
function fake(reply: Reply) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (reply === 'throw') throw new TypeError(`fetch failed for ${String(input)}`);
    if (reply === 'hang') return new Promise<Response>(() => undefined); // ignores its signal on purpose
    if (reply === 'stall') {
      const body = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode('{"1111')) }); // never closes, ignores the abort
      return new Response(body, { status: 200 });
    }
    const res = new Response(reply.body ?? null, { status: reply.status ?? 200 });
    if (reply.type) Object.defineProperty(res, 'type', { value: reply.type });
    return res;
  });
  return { f: f as unknown as typeof fetch, calls, spy: f };
}

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the request', () => {
  it('GET <origin>/api/api.php?api=user&key=...&cmd=..., no redirect followed, not cached', async () => {
    const { f, calls } = fake({ body: '[]' });
    expect(await callAyun(ENV, LOC, { fetchImpl: f })).toEqual({ ok: true, data: [] });
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0]!.url);
    expect(u.origin).toBe('https://provider.example');
    expect(u.pathname).toBe('/api/api.php');
    expect([...u.searchParams.keys()]).toEqual(['api', 'key', 'cmd']);
    expect(u.searchParams.get('api')).toBe('user');
    expect(u.searchParams.get('key')).toBe(KEY);
    expect(u.searchParams.get('cmd')).toBe(`OBJECT_GET_LOCATIONS,${IMEI_A};${IMEI_B}`);
    expect(calls[0]!.init).toMatchObject({ method: 'GET', redirect: 'manual', cache: 'no-store' });
  });

  it('the commands: digits-only parameters, the API offset taken off the history window', () => {
    const from = new Date('2026-10-16T01:00:00Z');
    const to = new Date('2026-10-16T02:30:00Z');
    expect(ayunCommandText({ cmd: 'OBJECT_GET_ROUTE', imei: IMEI_A, from, to, minStopMin: 60 })).toBe(`OBJECT_GET_ROUTE,${IMEI_A},20261016010000,20261016023000,60`);
    expect(ayunCommandText({ cmd: 'OBJECT_GET_ROUTE', imei: IMEI_A, from, to, minStopMin: 60 }, -240)).toBe(`OBJECT_GET_ROUTE,${IMEI_A},20261016050000,20261016063000,60`);
    expect(ayunCommandText({ cmd: 'OBJECT_GET_LOCATIONS', imeis: '*' })).toBe('OBJECT_GET_LOCATIONS,*');
    expect(ayunCommandText({ cmd: 'OBJECT_GET_LAST_EVENTS' })).toBe('OBJECT_GET_LAST_EVENTS');
    expect(ayunCommandText({ cmd: 'USER_GET_OBJECTS' })).toBe('USER_GET_OBJECTS');
  });

  it('refuses - and never sends - anything outside the allow-list or with a parameter that is not digits', async () => {
    const t = new Date('2026-10-16T01:00:00Z');
    const refused: AyunRequest[] = [
      { cmd: 'OBJECT_GET_LOCATIONS', imeis: [] },
      { cmd: 'OBJECT_GET_LOCATIONS', imeis: [`${IMEI_A},USER_GET_API_KEY`] },
      { cmd: 'OBJECT_GET_LOCATIONS', imeis: ['1234;5678'] },
      { cmd: 'OBJECT_GET_LOCATIONS', imeis: Array.from({ length: 101 }, (_, i) => `${'5'.repeat(12)}${String(i).padStart(3, '0')}`) },
      { cmd: 'OBJECT_GET_ROUTE', imei: 'abc', from: t, to: new Date(t.getTime() + 60_000), minStopMin: 60 },
      { cmd: 'OBJECT_GET_ROUTE', imei: IMEI_A, from: t, to: t, minStopMin: 60 },
      { cmd: 'OBJECT_GET_ROUTE', imei: IMEI_A, from: t, to: new Date(t.getTime() + ROUTE_MAX_WINDOW_MS + 1), minStopMin: 60 },
      { cmd: 'OBJECT_GET_ROUTE', imei: IMEI_A, from: t, to: new Date(t.getTime() + 60_000), minStopMin: 7 as 60 },
      { cmd: 'USER_GET_API_KEY' } as unknown as AyunRequest,
    ];
    const { f, spy } = fake({ body: '[]' });
    for (const r of refused) {
      expect(ayunCommandText(r), JSON.stringify(r)).toBeNull();
      expect(await callAyun(ENV, r, { fetchImpl: f })).toEqual({ ok: false, kind: 'PROVIDER_ERROR' });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('not configured, or the kill switch: nothing is sent', async () => {
    const { f, spy } = fake({ body: '[]' });
    expect(await callAyun(ivmsTestEnv({ ROUTEIQ_DISABLE_IVMS: '1' }), LOC, { fetchImpl: f })).toEqual({ ok: false, kind: 'DISABLED' });
    expect(await callAyun(ivmsTestEnv({ AYUN_API_KEY: undefined }), LOC, { fetchImpl: f })).toEqual({ ok: false, kind: 'NOT_CONFIGURED' });
    expect(await callAyun(ivmsTestEnv({ AYUN_BASE_URL: 'http://provider.example' }), LOC, { fetchImpl: f })).toEqual({ ok: false, kind: 'NOT_CONFIGURED' });
    expect(await callAyun(ivmsTestEnv({ AYUN_TENANT_SLUG: undefined }), LOC, { fetchImpl: f })).toEqual({ ok: false, kind: 'NOT_CONFIGURED' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the answer', () => {
  it('the provider\'s plain-text errors (HTTP 200) are classified before any JSON parse', async () => {
    const cases: [string, string][] = [
      ['ERROR: wrong API key', 'AUTH'],
      ['ERROR: API call limit exceeded', 'LIMIT'],
      ['ERROR: no permission to access this IMEI', 'NO_PERMISSION'],
      ['ERROR: missing command parameters', 'PROVIDER_ERROR'],
      ['ERROR: unknown command', 'PROVIDER_ERROR'],
      ['error:wrong api key', 'AUTH'],
      ['﻿  ERROR: API call limit exceeded\n', 'LIMIT'],
    ];
    for (const [body, kind] of cases) {
      const { f } = fake({ body });
      expect(await callAyun(ENV, LOC, { fetchImpl: f }), body).toEqual({ ok: false, kind });
    }
    expect(classifyAyunError('ERROR: IMEI is not valid')).toBe('PROVIDER_ERROR');
  });

  it('an empty body, an HTML page, broken JSON or a bare value are not answers; [] and objects are', () => {
    expect(classifyAyunBody('')).toEqual({ ok: false, kind: 'EMPTY' });
    expect(classifyAyunBody('  \n')).toEqual({ ok: false, kind: 'EMPTY' });
    expect(classifyAyunBody('<html><body>502 Bad Gateway</body></html>')).toEqual({ ok: false, kind: 'PARSE' });
    expect(classifyAyunBody('{"a":')).toEqual({ ok: false, kind: 'PARSE' });
    expect(classifyAyunBody('"text"')).toEqual({ ok: false, kind: 'PARSE' });
    expect(classifyAyunBody('null')).toEqual({ ok: false, kind: 'PARSE' });
    expect(classifyAyunBody('[]')).toEqual({ ok: true, data: [] });
    expect(classifyAyunBody('{"a":"1"}')).toEqual({ ok: true, data: { a: '1' } });
  });

  it('a redirect is never followed (REDIRECT); another status is HTTP_ERROR', async () => {
    const r302 = fake({ status: 302, body: null });
    expect(await callAyun(ENV, LOC, { fetchImpl: r302.f })).toEqual({ ok: false, kind: 'REDIRECT', status: 302 });
    expect(r302.calls).toHaveLength(1);
    const opaque = fake({ status: 200, body: null, type: 'opaqueredirect' });
    expect((await callAyun(ENV, LOC, { fetchImpl: opaque.f })).ok).toBe(false);
    expect(await callAyun(ENV, LOC, { fetchImpl: fake({ status: 500, body: 'oops' }).f })).toEqual({ ok: false, kind: 'HTTP_ERROR', status: 500 });
    expect(await callAyun(ENV, LOC, { fetchImpl: fake({ status: 404, body: '' }).f })).toEqual({ ok: false, kind: 'HTTP_ERROR', status: 404 });
  });

  it('one deadline for headers and body: a fetch or a body that never ends is a TIMEOUT, never a hang', async () => {
    const t0 = Date.now();
    expect(await callAyun(ENV, LOC, { fetchImpl: fake('hang').f, timeoutMs: 50 })).toEqual({ ok: false, kind: 'TIMEOUT' });
    expect(await callAyun(ENV, LOC, { fetchImpl: fake('stall').f, timeoutMs: 50 })).toEqual({ ok: false, kind: 'TIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('the shutdown aborts a call in flight: TIMEOUT', async () => {
    const ctrl = new AbortController();
    const p = callAyun(ENV, LOC, { fetchImpl: fake('hang').f, signal: ctrl.signal, timeoutMs: 60_000 });
    ctrl.abort();
    expect(await p).toEqual({ ok: false, kind: 'TIMEOUT' });
    const pre = new AbortController();
    pre.abort();
    expect(await callAyun(ENV, LOC, { fetchImpl: fake({ body: '[]' }).f, signal: pre.signal })).toEqual({ ok: false, kind: 'TIMEOUT' });
  });

  it('an answer over the cap is TOO_LARGE (read in a stream, cut at the cap)', async () => {
    expect(await callAyun(ENV, LOC, { fetchImpl: fake({ body: `[${'1,'.repeat(2000)}1]` }).f, maxBytes: 1024 })).toEqual({ ok: false, kind: 'TOO_LARGE' });
    expect((await callAyun(ENV, LOC, { fetchImpl: fake({ body: '[1,2]' }).f, maxBytes: 1024 })).ok).toBe(true);
  });

  it('a network error is NETWORK - its message (which names the address, key included) never comes out', async () => {
    const r = await callAyun(ENV, LOC, { fetchImpl: fake('throw').f });
    expect(r).toEqual({ ok: false, kind: 'NETWORK' });
  });
});

describe('the key and the address never leak', () => {
  it('no result and no console line ever holds the key, the address or the answer', async () => {
    const replies: Reply[] = [{ body: '[]' }, { body: 'ERROR: wrong API key' }, { status: 302 }, { status: 500, body: KEY }, 'throw', { body: '<html>' }, { body: '' }];
    const results: unknown[] = [];
    for (const r of replies) results.push(await callAyun(ENV, LOC, { fetchImpl: fake(r).f }));
    results.push(await callAyun(ENV, LOC, { fetchImpl: fake('hang').f, timeoutMs: 20 }));
    const text = JSON.stringify(results);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('provider.example');
    expect(text).not.toContain('api.php');
    expect(logs).toEqual([]);
  });
});
