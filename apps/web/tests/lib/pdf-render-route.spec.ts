/**
 * Review M3 (scenario findings s8-scale-1, s1-happy-day-4, web-exports-3), at the route: the plan
 * screen's "Driver sheets (PDF)" (GET /api/runs/:id/export/pdf) no longer freezes the web process
 * while a whole day's pack is laid out. Before, the route ran renderDriverPackPdf itself: a pack of 12
 * loads of 12 stops blocked the event loop for about 2.5 s in one go (8-42 s packs and 4-15 s freezes
 * at NMWC's 150-400 stops), so every other request of every user waited. Now the route builds the
 * model and the PDF renderer process (lib/pdf-render) lays it out. Only the database, the session and
 * the driver links are stand-ins here; the route, the model, the renderer process and the layout are
 * the real ones.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlanDetail } from '@/lib/dispatch/plan-detail';
import { fixture, load, ORDERS, stop } from './plan-detail-fixture';
import { longestStall } from './upload-parse-helpers';

const plan = vi.hoisted(() => ({ detail: null as unknown }));
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', tenantId: 'tA', role: 'PLANNER', name: 'Planner', email: 'p@a.example' } })) }));
vi.mock('@/lib/db', () => ({ prisma: { tenant: { findUnique: vi.fn(async () => ({ name: 'NMWC' })) } } }));
vi.mock('@/lib/tenant', () => ({ tenantDb: () => ({}) }));
vi.mock('@/lib/dispatch/legacy-runs', () => ({ isDispatchPlan: vi.fn(async () => true) }));
vi.mock('@/lib/dispatch/plan-detail', () => ({ getPlanDetail: vi.fn(async () => plan.detail) }));
vi.mock('@/lib/driver-link/service', () => ({
  listLinks: vi.fn(async () => []),
  ensureLink: vi.fn(async (_t: string, _r: string, truckId: string) => ({ url: `https://routeiq.example/d/${'x'.repeat(43)}${truckId}`, revoked: false })),
}));

import { GET as pdfGet } from '@/app/api/runs/[id]/export/pdf/route';

/** A plan of `loads` loads of `stops` stops each, one truck per load (the fixture's customers in turn). */
function day(loads: number, stops: number): PlanDetail {
  const d = fixture();
  const ids = ORDERS.map((o) => o.id);
  d.loads = Array.from({ length: loads }, (_, li) =>
    load(`L${li}`, `t${li}`, `T${String(li + 1).padStart(2, '0')}`, 1, Array.from({ length: stops }, (_, i) => stop(ids[i % ids.length]!, i + 1, 4, 4 * (i + 1), 380 + 20 * i)), false),
  );
  return d;
}

// The real renderer process (tests/setup.ts makes packs in this process unless a spec says otherwise).
const g = globalThis as { __routeiqPdfRenderInProcess?: unknown };
let saved: unknown;
beforeAll(() => {
  saved = g.__routeiqPdfRenderInProcess;
  g.__routeiqPdfRenderInProcess = undefined;
});
afterAll(() => {
  g.__routeiqPdfRenderInProcess = saved;
});

describe('GET /api/runs/:id/export/pdf keeps the web process answering while the driver sheets are made (review M3)', () => {
  it('a day of 12 loads x 12 stops: the PDF of every load, and the event loop never blocked for long', async () => {
    plan.detail = day(12, 12);
    // (The first pack of a test run also builds the renderer's development bundle: in the renderer
    // process, scripts/pdf-renderer-dev.cjs, so that does not block this one either.)
    const { result: res, stallMs, elapsedMs } = await longestStall(() => pdfGet(new Request('http://localhost/api/runs/r1/export/pdf'), { params: { id: 'r1' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const pdf = Buffer.from(await res.arrayBuffer());
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect((pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length).toBeGreaterThanOrEqual(12);
    expect(elapsedMs).toBeGreaterThan(1_000);
    // In the route (before) one stretch of the layout blocked the loop for about 2.5 s of the 4 s.
    // Starting a process blocks the caller briefly (a few ms on Linux; up to several hundred on a
    // busy Windows PC).
    expect(stallMs).toBeLessThan(Math.min(1_000, elapsedMs / 2));
  });
});
