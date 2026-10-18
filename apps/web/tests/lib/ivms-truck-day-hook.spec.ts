/**
 * The truck day page's reads (owner request 18 Oct 2026; app/t/[slug]/dispatch/truck/[truckId]/use-truck-day.ts)
 * on the hook host: the day once, then every minute only while the truck can move on it (today, or a
 * load still out); a past day once and never again; an answer for a date picked before never replaces the
 * newer one. A date picked whose read fails (review of 18 Oct 2026): the REAL page (truck-day-client.tsx,
 * only fetch, the router and the map replaced) stops "Loading...", shows the error with "Try again", and
 * never the old date's loads, map or timeline under the date picked. Invented data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, elements, Host, textOf, typeName } from './hook-host';
import { truckDayScreen } from '@/lib/ivms/truck-day';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));
vi.mock('next/dynamic', () => ({ default: () => function DynamicStub() { return null; } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace() {}, refresh() {}, push() {} }) }));
const { useTruckDay } = await import('@/app/t/[slug]/dispatch/truck/[truckId]/use-truck-day');
const { TruckDayClient } = await import('@/app/t/[slug]/dispatch/truck/[truckId]/truck-day-client');

const TODAY = '2026-10-20';
const day = (date: string) => ({ date, today: TODAY, live: null, truck: { id: 't1', code: 'T-100' }, timeline: [] });
const reply = (body: unknown) => new Response(JSON.stringify({ data: body }), { status: 200, headers: { 'content-type': 'application/json' } });
const refused = (status: number, error: string) => async () => new Response(JSON.stringify({ data: null, error }), { status, headers: { 'content-type': 'application/json' } });
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

  it('a date picked whose read fails: no longer loading, its error, the last day held; a failure of another date never shows under it', async () => {
    const { h, get } = hostOf('2026-10-15');
    await h.settle();
    fetchMock.mockImplementationOnce(refused(429, 'Too many requests'));
    h.render({ date: '2026-10-16' });
    // Before the read of the new date answers: loading, no error.
    expect(get()).toMatchObject({ loading: true, error: null, data: { date: '2026-10-15' } });
    await h.settle();
    expect(get()).toMatchObject({ loading: false, error: 'Too many requests', data: { date: '2026-10-15' } });
    expect(truckDayScreen(get(), '2026-10-16')).toEqual({ show: 'HELD', loading: false, message: 'Too many requests', retry: true });
    // Back to the date held: its day, without the other date's error.
    h.render({ date: '2026-10-15' });
    await h.settle();
    expect(get()).toMatchObject({ loading: false, error: null, data: { date: '2026-10-15' } });
  });
});

describe('the truck day page after a failed read of a date picked (review of 18 Oct 2026)', () => {
  it("the picker, the error and Try again; never the old date's loads, map or timeline; Try again shows the day", async () => {
    const h = new Host(TruckDayClient as (p: { slug: string; truckId: string; initialDate: string }) => unknown, { slug: 'example', truckId: 't1', initialDate: '2026-10-15' });
    h.render();
    await h.settle();
    const els = () => elements(h.tree);
    const header = () => els().find((e) => typeName(e) === 'Header')!;
    const has = (name: string) => els().some((e) => typeName(e) === name);
    expect(header().props).toMatchObject({ date: '2026-10-15', dayShown: true, loading: false });
    expect(has('Timeline')).toBe(true);

    fetchMock.mockImplementationOnce(refused(429, 'Too many requests'));
    header().props.onPick('2026-10-16');
    h.flush();
    await h.settle();
    expect(header().props).toMatchObject({ date: '2026-10-16', dayShown: false, loading: false });
    expect(has('Timeline') || has('DynamicStub') || has('MapLegend')).toBe(false);
    const box = els().find((e) => e.props?.['data-testid'] === 'truck-day-error')!;
    expect(textOf(box)).toContain('Too many requests');
    expect(textOf(box)).not.toMatch(/from the last read/);
    const retry = els().find((e) => e.props?.['data-testid'] === 'truck-day-retry')!;
    expect(textOf(retry)).toContain('Try again');

    retry.props.onClick();
    h.flush();
    await h.settle();
    expect(header().props).toMatchObject({ date: '2026-10-16', dayShown: true, loading: false });
    expect(has('Timeline')).toBe(true);
    expect(els().some((e) => e.props?.['data-testid'] === 'truck-day-error')).toBe(false);
  });
});
