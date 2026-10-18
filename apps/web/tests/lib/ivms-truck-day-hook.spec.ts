/**
 * The truck day page's reads (owner request 18 Oct 2026; app/t/[slug]/dispatch/truck/[truckId]/use-truck-day.ts)
 * on the hook host: the day once, then every minute only while the truck can move on it (today, or a
 * load still out); a past day once and never again; an answer for a date picked before never replaces the
 * newer one. Invented data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, Host } from './hook-host';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));
const { useTruckDay } = await import('@/app/t/[slug]/dispatch/truck/[truckId]/use-truck-day');

const TODAY = '2026-10-20';
const day = (date: string) => ({ date, today: TODAY, live: null, truck: { id: 't1', code: 'T-100' }, timeline: [] });
const reply = (body: unknown) => new Response(JSON.stringify({ data: body }), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (url: string) => reply(day(new URL(url, 'https://routeiq.test').searchParams.get('date')!)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function hostOf(date: string) {
  let out: ReturnType<typeof useTruckDay> | null = null;
  const h = new Host((p: { date: string }) => {
    out = useTruckDay('t1', p.date);
    return null;
  }, { date });
  h.render();
  return { h, get: () => out! };
}

describe('useTruckDay', () => {
  it("today: the truck's day once, then every 60 s", async () => {
    const { h, get } = hostOf(TODAY);
    await h.settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`/api/ivms/trucks/t1/day?date=${TODAY}`);
    expect(get()).toMatchObject({ loading: false, error: null, data: { date: TODAY } });
    vi.advanceTimersByTime(60_000);
    await h.settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a past day: read once, never again', async () => {
    const { h } = hostOf('2026-10-15');
    await h.settle();
    vi.advanceTimersByTime(10 * 60_000);
    await h.settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the answer for a date picked before never replaces the newer one', async () => {
    const slow = deferred<Response>();
    fetchMock.mockImplementationOnce(() => slow.promise);
    const { h, get } = hostOf('2026-10-15');
    h.render({ date: '2026-10-16' });
    await h.settle();
    expect(get().data).toMatchObject({ date: '2026-10-16' });
    slow.resolve(reply(day('2026-10-15')));
    await h.settle();
    expect(get().data).toMatchObject({ date: '2026-10-16' });
  });

  it('a refused read keeps the last day and says why', async () => {
    const { h, get } = hostOf('2026-10-15');
    await h.settle();
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ data: null, error: 'Not found' }), { status: 404 }));
    get().reload();
    h.flush();
    await h.settle();
    expect(get()).toMatchObject({ error: 'Not found', data: { date: '2026-10-15' }, loading: false });
  });
});
