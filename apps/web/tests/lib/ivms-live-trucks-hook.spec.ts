/**
 * The day screen's live trucks (IVMS live link, app/t/[slug]/dispatch/live-trucks.tsx) on the hook host:
 * while the company's GPS tracking is OFF (enabled false) nothing is ever fetched; when on, the plan's
 * vehicles are read once and then every 60 s while the tab is visible; switched off, nothing more is read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Host } from './hook-host';

vi.mock('react', async (importActual) => (await import('./hook-host')).mockReactHooks(importActual));
const { useLiveTrucks } = await import('@/app/t/[slug]/dispatch/live-trucks');

const answer = { mode: 'MAP', intervalSec: null, updatedAt: null, vehicles: [] };
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: answer }), { status: 200, headers: { 'content-type': 'application/json' } }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => undefined } });
  fetchMock.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function hostOf(enabled: boolean) {
  let out: ReturnType<typeof useLiveTrucks> | null = null;
  const h = new Host((p: { enabled: boolean }) => {
    out = useLiveTrucks('R1', p.enabled);
    return null;
  }, { enabled });
  h.render();
  return { h, get: () => out! };
}

describe('useLiveTrucks', () => {
  it('OFF: nothing is fetched, ever', async () => {
    const { h } = hostOf(false);
    await h.settle();
    vi.advanceTimersByTime(5 * 60_000);
    await h.settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('on: the vehicles of the plan once, then every 60 s; switched off: no more reads', async () => {
    const { h, get } = hostOf(true);
    await h.settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/api/runs/R1/vehicles');
    expect(get().data).toEqual(answer);
    vi.advanceTimersByTime(60_000);
    await h.settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    get().setOn(false);
    h.flush();
    await h.settle();
    vi.advanceTimersByTime(5 * 60_000);
    await h.settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(get().data).toBeNull();
  });
});
