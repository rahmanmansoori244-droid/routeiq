/**
 * Audit of 27 Sep 2026, F24: the Customers table's inline Active / Priority change. A request
 * that never reaches the server (offline, connection reset) was not handled: the page showed its
 * error card or kept a change that was never saved. Now every outcome ends in the server's state:
 * saved (server values), refused (rolled back), no answer (reloaded from the server; if that fails
 * too, rolled back and marked "not confirmed"), never re-sent automatically, never thrown.
 * Review of audit PR 3: only the app's 4xx answer is a refusal. A 5xx (the app after it stored the
 * change, or a gateway 502 / 504 during a redeploy) or an answer that is not the app's JSON is
 * "not confirmed" like no answer: the row is reloaded, and the message never says "nothing was saved".
 */
import { describe, expect, it, vi } from 'vitest';
import {
  runInlineUpdate,
  serverErrorCause,
  unconfirmedReloaded,
  unconfirmedUnknown,
  unreadableAnswerCause,
  UNCONFIRMED_RELOADED,
  UNCONFIRMED_UNKNOWN,
} from '@/lib/customer-inline-update';

interface Row { id: string; code: string; active: boolean; priority: number; region: { code: string } | null }
const BEFORE: Row = { id: 'c1', code: 'C001', active: true, priority: 3, region: { code: 'R1' } };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (status: number, text: string) => new Response(`<html><body>${text}</body></html>`, { status, headers: { 'content-type': 'text/html' } });

function harness(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    return fetchImpl(url, init);
  });
  const rows: Row[] = [];
  const uncertain: boolean[] = [];
  const toasts: string[] = [];
  const deps = {
    fetchImpl: f as unknown as typeof fetch,
    setRow: (r: Row) => rows.push(r),
    setUncertain: (u: boolean) => uncertain.push(u),
    notify: { success: (m: string) => toasts.push(`success: ${m}`), error: (m: string) => toasts.push(`error: ${m}`), warning: (m: string) => toasts.push(`warning: ${m}`) },
  };
  return { deps, calls, rows, uncertain, toasts };
}

describe('runInlineUpdate (audit F24)', () => {
  it('no answer to the PATCH: the row is reloaded from the server (a GET), the PATCH is not sent again', async () => {
    const h = harness(async (_url, init) => {
      if (init?.method === 'PATCH') throw new TypeError('Failed to fetch');
      return json(200, { data: { id: 'c1', active: true, priority: 3, updatedAt: 'x' } }); // it was not saved
    });
    const result = await runInlineUpdate(BEFORE, { active: false }, h.deps);
    expect(result).toBe('RECONCILED');
    expect(h.calls.map((c) => c.method)).toEqual(['PATCH', 'GET']);
    expect(h.rows.at(-1)).toEqual(BEFORE); // the server still has it active; the region name stays
    expect(h.uncertain).toEqual([false]);
    expect(h.toasts).toEqual([`error: ${UNCONFIRMED_RELOADED}`]);
  });

  it('no answer, but the PATCH had been saved: the reload shows the saved value', async () => {
    const h = harness(async (_url, init) => {
      if (init?.method === 'PATCH') throw new TypeError('connection reset');
      return json(200, { data: { id: 'c1', active: false, priority: 3 } });
    });
    await runInlineUpdate(BEFORE, { active: false }, h.deps);
    expect(h.rows.at(-1)).toMatchObject({ active: false, region: { code: 'R1' } });
  });

  it('no answer and the reload fails too: rolled back, marked "not confirmed", an error says so', async () => {
    const h = harness(async () => {
      throw new TypeError('Failed to fetch');
    });
    const result = await runInlineUpdate(BEFORE, { priority: 1 }, h.deps);
    expect(result).toBe('UNKNOWN');
    expect(h.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(h.rows.at(-1)).toEqual(BEFORE);
    expect(h.uncertain).toEqual([true]);
    expect(h.toasts).toEqual([`error: ${UNCONFIRMED_UNKNOWN}`]);
  });

  it('refused by the server: rolled back with its message', async () => {
    const h = harness(async () => json(403, { data: null, error: 'Forbidden' }));
    expect(await runInlineUpdate(BEFORE, { active: false }, h.deps)).toBe('REFUSED');
    expect(h.calls.map((c) => c.method)).toEqual(['PATCH']); // a refusal is definite: no reload
    expect(h.rows.at(-1)).toEqual(BEFORE);
    expect(h.uncertain).toEqual([false]);
    expect(h.toasts).toEqual(['error: Forbidden']);
  });

  it('a conflict (409) or an invalid value (400) is a refusal too', async () => {
    for (const [status, error, message] of [
      [409, 'Customer C001 already exists.', 'Customer C001 already exists.'],
      [400, { fieldErrors: { priority: ['Number must be less than or equal to 5'] } }, 'Number must be less than or equal to 5'],
    ] as const) {
      const h = harness(async () => json(status, { data: null, error }));
      expect(await runInlineUpdate(BEFORE, { priority: 9 }, h.deps)).toBe('REFUSED');
      expect(h.calls).toHaveLength(1);
      expect(h.rows.at(-1)).toEqual(BEFORE);
      expect(h.toasts).toEqual([`error: ${message}`]);
    }
  });

  it("saved: the row takes the server's values and its warning is shown", async () => {
    const h = harness(async () => json(200, { data: { id: 'c1', active: false, priority: 3, warning: '2 open order(s) ...' } }));
    expect(await runInlineUpdate(BEFORE, { active: false }, h.deps)).toBe('SAVED');
    expect(h.calls).toEqual([{ url: '/api/customers/c1', method: 'PATCH', body: '{"active":false}' }]);
    expect(h.rows.at(-1)).toEqual({ ...BEFORE, active: false });
    expect(h.toasts).toEqual(['success: Customer updated', 'warning: 2 open order(s) ...']);
  });

  it('never throws, whatever the answer (an error card was shown before)', async () => {
    const h = harness(async () => new Response('<html>502</html>', { status: 502 }));
    await expect(runInlineUpdate(BEFORE, { active: false }, h.deps)).resolves.toBe('UNKNOWN'); // the reload got a 502 too
  });
});

describe('runInlineUpdate: a server error is not a refusal (review of audit PR 3, F24)', () => {
  /** The PATCH reached the app and was stored, then the answer was an error. */
  function savedThen(answer: () => Response) {
    const server = { id: 'c1', active: true, priority: 3 };
    const h = harness(async (_url, init) => {
      if (init?.method === 'PATCH') {
        Object.assign(server, JSON.parse(String(init.body)));
        return answer();
      }
      return json(200, { data: { ...server, region: { id: 'r1', code: 'R1', name: 'Seeb' } } });
    });
    return { h, server };
  }

  const cases: [string, () => Response, string][] = [
    ['a 502 from the gateway (HTML body)', () => html(502, 'Bad Gateway'), serverErrorCause(502)],
    ['a 504 from the gateway (HTML body)', () => html(504, 'Gateway Timeout'), serverErrorCause(504)],
    ['a 500 from the app after it stored the change (the audit write failed)', () => json(500, { data: null, error: 'Internal server error' }), serverErrorCause(500)],
    ['a 503 with an empty body (a redeploy)', () => new Response(null, { status: 503 }), serverErrorCause(503)],
  ];
  for (const [label, answer, cause] of cases) {
    it(`${label}: the row is reloaded and shows the saved change, never "nothing was saved"`, async () => {
      const { h, server } = savedThen(answer);
      const result = await runInlineUpdate(BEFORE, { active: false }, h.deps);
      expect(server.active).toBe(false);
      expect(result).toBe('RECONCILED');
      expect(h.calls.map((c) => c.method)).toEqual(['PATCH', 'GET']); // never re-sent
      expect(h.rows.at(-1)).toEqual({ ...BEFORE, active: false }); // what the server has; the region stays
      expect(h.uncertain).toEqual([false]);
      expect(h.toasts).toEqual([`error: ${unconfirmedReloaded(cause)}`]);
      expect(h.toasts[0]).not.toMatch(/nothing was saved/);
    });
  }

  it('a 5xx and the reload fails too: rolled back, marked "not confirmed", never "nothing was saved"', async () => {
    const h = harness(async (_url, init) => (init?.method === 'PATCH' ? html(502, 'Bad Gateway') : html(503, 'Service Unavailable')));
    expect(await runInlineUpdate(BEFORE, { priority: 1 }, h.deps)).toBe('UNKNOWN');
    expect(h.calls.map((c) => c.method)).toEqual(['PATCH', 'GET']);
    expect(h.rows.at(-1)).toEqual(BEFORE);
    expect(h.uncertain).toEqual([true]);
    expect(h.toasts).toEqual([`error: ${unconfirmedUnknown(serverErrorCause(502))}`]);
    expect(h.toasts[0]).not.toMatch(/nothing was saved/);
  });

  it('a 5xx and the reload answers without the row: "not confirmed", not a guess', async () => {
    const h = harness(async (_url, init) => (init?.method === 'PATCH' ? json(500, { data: null, error: 'Internal server error' }) : json(200, { data: null })));
    expect(await runInlineUpdate(BEFORE, { active: false }, h.deps)).toBe('UNKNOWN');
    expect(h.rows.at(-1)).toEqual(BEFORE);
    expect(h.uncertain).toEqual([true]);
  });

  it("an OK answer that is not the app's JSON (a proxy's page) is not taken as saved: the row is reloaded", async () => {
    const h = harness(async (_url, init) => (init?.method === 'PATCH' ? html(200, 'Please sign in') : json(200, { data: { id: 'c1', active: true, priority: 3 } })));
    expect(await runInlineUpdate(BEFORE, { active: false }, h.deps)).toBe('RECONCILED');
    expect(h.rows.at(-1)).toEqual(BEFORE); // the server still has it active
    expect(h.toasts).toEqual([`error: ${unconfirmedReloaded(unreadableAnswerCause(200))}`]);
  });

  it("a 4xx that is not the app's JSON (a proxy's page) is reloaded too, not called a refusal", async () => {
    const h = harness(async (_url, init) => (init?.method === 'PATCH' ? html(408, 'Request Timeout') : json(200, { data: { id: 'c1', active: false, priority: 3 } })));
    expect(await runInlineUpdate(BEFORE, { active: false }, h.deps)).toBe('RECONCILED');
    expect(h.rows.at(-1)).toEqual({ ...BEFORE, active: false });
    expect(h.toasts).toEqual([`error: ${unconfirmedReloaded(unreadableAnswerCause(408))}`]);
  });
});

describe('the Customers page uses it (audit F24)', () => {
  it('customers-client.tsx sends inline changes only through runInlineUpdate and re-syncs rows from the server data', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(path.join(__dirname, '../../app/t/[slug]/customers/customers-client.tsx'), 'utf8');
    expect(src).toMatch(/runInlineUpdate\(before, patch,/);
    expect(src).not.toMatch(/fetch\(`\/api\/customers/);
    expect(src).toMatch(/useEffect\(\(\) => \{\s*setRows\(initial\);/);
    expect(src).toMatch(/not confirmed/);
  });
});
