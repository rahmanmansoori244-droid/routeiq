/**
 * Audit of 27 Sep 2026, F24: the Customers table's inline Active / Priority change. A request
 * that never reaches the server (offline, connection reset) was not handled: the page showed its
 * error card or kept a change that was never saved. Now every outcome ends in the server's state:
 * saved (server values), refused (rolled back), no answer (reloaded from the server; if that fails
 * too, rolled back and marked "not confirmed"), never re-sent automatically, never thrown.
 */
import { describe, expect, it, vi } from 'vitest';
import { runInlineUpdate, UNCONFIRMED_RELOADED, UNCONFIRMED_UNKNOWN } from '@/lib/customer-inline-update';

interface Row { id: string; code: string; active: boolean; priority: number; region: { code: string } | null }
const BEFORE: Row = { id: 'c1', code: 'C001', active: true, priority: 3, region: { code: 'R1' } };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
    expect(h.rows.at(-1)).toEqual(BEFORE);
    expect(h.toasts).toEqual(['error: Forbidden']);
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
    await expect(runInlineUpdate(BEFORE, { active: false }, h.deps)).resolves.toBe('REFUSED');
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
