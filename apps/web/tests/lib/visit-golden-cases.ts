/**
 * Deterministic visit cases WITHOUT any GPS (AYUN) event, for the golden test of the IVMS live link
 * (tests/lib/ivms-visit-precedence.spec.ts): the visit rebuild (lib/delivery/visit.ts deriveVisit) must
 * give exactly the same result for every visit that has no AYUN event (every visit in production
 * before the link is switched on). tests/fixtures/ivms/visit-golden.json holds the results the rebuild
 * gave BEFORE the IVMS change, for these very cases (seeded: the same cases every run).
 *
 * Invented data only: one synthetic stop with two lines and an invented pin.
 */
import { createHash } from 'node:crypto';
import type { VisitContext, VisitEvent } from '@/lib/delivery/visit';

const DAY = new Date('2026-10-05T00:00:00+04:00');
/** An invented pin in empty desert (never near a real customer). */
const PIN = { lat: 20.1, lng: 55.1 };
const LINES = [
  { orderId: 'O1', lineId: 'A', productCode: 'A', plannedCases: 30, deliveredCases: null },
  { orderId: 'O1', lineId: 'B', productCode: 'B', plannedCases: 10, deliveredCases: null },
];

/** mulberry32: a tiny seeded generator (the same sequence on every run and machine). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS: VisitEvent['kind'][] = ['ARRIVED', 'ARRIVED', 'DEPARTED', 'DEPARTED', 'OUTCOME', 'OUTCOME', 'PHOTO', 'BACK_AT_DEPOT', 'CARRY_CONFLICT'];
const SOURCES: VisitEvent['source'][] = ['PHONE_AUTO', 'PHONE_AUTO', 'PHONE_MANUAL', 'PHONE_MANUAL', 'DISPATCHER', 'SYSTEM'];
const OUTCOMES = ['DELIVERED', 'PARTLY_DELIVERED', 'NOT_DELIVERED', null] as const;

export interface GoldenCase {
  name: string;
  events: VisitEvent[];
  ctx: VisitContext;
}

/** `n` seeded cases of 0 to 8 events each (no AYUN event), with varied payloads, positions and contexts. */
export function goldenCases(n = 600, seed = 20261016): GoldenCase[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const out: GoldenCase[] = [];
  for (let c = 0; c < n; c++) {
    const count = Math.floor(r() * 9);
    const events: VisitEvent[] = [];
    for (let i = 0; i < count; i++) {
      const kind = pick(KINDS);
      const source = pick(SOURCES);
      // 08:00 to 13:00 local, whole minutes; received at the same time or up to 6 h later.
      const at = new Date(DAY.getTime() + (8 * 60 + Math.floor(r() * 300)) * 60_000);
      const receivedAt = new Date(at.getTime() + (r() < 0.7 ? 0 : Math.floor(r() * 360) * 60_000));
      const payload: Record<string, unknown> = {};
      if (kind === 'ARRIVED') {
        if (r() < 0.25) payload.observed = false;
        if (r() < 0.2) payload.when = true;
        if (r() < 0.1) payload.mode = 'OFFICE';
      }
      if (kind === 'DEPARTED' && r() < 0.25) payload.gap = true;
      if (kind === 'OUTCOME' || kind === 'CARRY_CONFLICT') {
        const outcome = pick(OUTCOMES);
        payload.outcome = outcome;
        if (outcome === 'NOT_DELIVERED') payload.reason = pick(['SHOP_CLOSED', 'OTHER', 'NO_CASH']);
        if (outcome === 'PARTLY_DELIVERED') payload.lines = [{ lineId: 'A', delivered: Math.floor(r() * 31) }];
        if (r() < 0.2) payload.late = true;
        if (r() < 0.2) payload.noPhotoReason = 'CAMERA_FAILED';
        if (r() < 0.4) payload.photoKeys = r() < 0.5 ? ['k1'] : ['k1', 'k2'];
        if (r() < 0.2) payload.note = 'note';
      }
      const positioned = r() < 0.5;
      const near = r() < 0.15 ? 0 : (r() - 0.5) * 0.004;
      events.push({
        id: `e${c}-${i}`,
        kind,
        source,
        at,
        receivedAt,
        lat: positioned ? PIN.lat + near : null,
        lng: positioned ? PIN.lng + near : null,
        accuracyM: positioned ? pick([1, 8, 12.37, 65]) : null,
        distanceM: positioned ? Math.round(Math.abs(near) * 111_000) : null,
        userId: source === 'DISPATCHER' ? 'u1' : null,
        payload: Object.keys(payload).length || r() < 0.5 ? payload : null,
      });
    }
    const ctx: VisitContext = {
      dayStart: DAY,
      windowStartMin: r() < 0.4 ? 8 * 60 + Math.floor(r() * 120) : null,
      breakMin: r() < 0.2 ? { startMin: 12 * 60, endMin: 12 * 60 + 30 } : null,
      lines: LINES,
      pin: r() < 0.9 ? PIN : null,
      radiusM: 100,
      ...(r() < 0.1 ? { maxAfterOutcomeMin: 5 } : {}),
    };
    out.push({ name: `case ${c}`, events, ctx });
  }
  return [...out, ...phoneFlows(r)];
}

/**
 * 300 realistic phone flows (the common case): an automatic arrival (seen or found), sometimes a tap or
 * a "when?" answer, a departure (sometimes after a gap), the driver's or the office's result, sometimes
 * office times, sometimes a second stay. These cover the automatic timing paths the random cases rarely hit.
 */
function phoneFlows(r: () => number): GoldenCase[] {
  const out: GoldenCase[] = [];
  const m = (min: number) => new Date(DAY.getTime() + min * 60_000);
  for (let c = 0; c < 300; c++) {
    const events: VisitEvent[] = [];
    let id = 0;
    const add = (kind: VisitEvent['kind'], source: VisitEvent['source'], atMin: number, payload: Record<string, unknown> | null, recvMin = atMin) =>
      events.push({ id: `p${c}-${id++}`, kind, source, at: m(atMin), receivedAt: m(recvMin), lat: null, lng: null, accuracyM: null, distanceM: null, userId: source === 'DISPATCHER' ? 'u1' : null, payload });
    const t0 = 8 * 60 + Math.floor(r() * 240);
    const stays = r() < 0.15 ? 2 : 1;
    let t = t0;
    for (let s = 0; s < stays; s++) {
      const auto = r() < 0.85;
      if (auto) add('ARRIVED', 'PHONE_AUTO', t, { mode: 'AUTO', ...(r() < 0.2 ? { observed: false, resumed: true } : {}) });
      if (!auto || r() < 0.15) add('ARRIVED', 'PHONE_MANUAL', t + Math.floor(r() * 4) - 2, { mode: 'MANUAL', ...(r() < 0.4 ? { when: true } : {}) });
      const dwell = 3 + Math.floor(r() * 40);
      if (r() < 0.75) add('DEPARTED', 'PHONE_AUTO', t + dwell, { reason: r() < 0.8 ? 'LEFT' : 'NEXT_STOP', ...(r() < 0.2 ? { gap: true } : {}) });
      t += dwell + 20 + Math.floor(r() * 60);
    }
    const resAt = t0 + Math.floor(r() * 50);
    const by = r() < 0.8 ? 'PHONE_MANUAL' : 'DISPATCHER';
    if (r() < 0.9) add('OUTCOME', by, resAt, { outcome: r() < 0.8 ? 'DELIVERED' : 'NOT_DELIVERED', ...(r() < 0.1 ? { late: true } : {}) }, by === 'DISPATCHER' ? resAt + 300 : resAt);
    if (r() < 0.15) add('ARRIVED', 'DISPATCHER', t0 - 5 + Math.floor(r() * 10), { mode: 'OFFICE' }, t0 + 400);
    if (r() < 0.15) add('DEPARTED', 'DISPATCHER', t0 + 15 + Math.floor(r() * 30), { mode: 'OFFICE' }, t0 + 400);
    const ctx: VisitContext = {
      dayStart: DAY,
      windowStartMin: r() < 0.4 ? t0 - 30 + Math.floor(r() * 60) : null,
      breakMin: r() < 0.15 ? { startMin: t0 + 10, endMin: t0 + 40 } : null,
      lines: LINES,
      pin: PIN,
      radiusM: 100,
    };
    out.push({ name: `flow ${c}`, events, ctx });
  }
  return out;
}

/** A visit result as JSON (dates as ISO strings), the form the golden file stores. */
export function goldenJson(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v));
}

/** A row's fingerprint: the first 16 hex of its SHA-256 with the digits written as letters g-p (no digit runs in the file). */
export function goldenHash(row: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(row))
    .digest('hex')
    .slice(0, 16)
    .replace(/[0-9]/g, (d) => String.fromCharCode(103 + Number(d)));
}

/** The functions a golden row is made with (passed in, so the generator and the test share one shape). */
export interface GoldenFns {
  deriveVisit: typeof import('@/lib/delivery/visit').deriveVisit;
  arrivalByText: typeof import('@/lib/delivery/office-text').arrivalByText;
  arrivalNote: typeof import('@/lib/delivery/office-text').arrivalNote;
  timedByText: typeof import('@/lib/delivery/office-text').timedByText;
  actualMinutes: typeof import('@/lib/delivery/office-text').actualMinutes;
  departureNote: typeof import('@/lib/delivery/office-text').departureNote;
  arrivalIsObserved: typeof import('@/lib/delivery/kpis').arrivalIsObserved;
  arrivedInsideWindow: typeof import('@/lib/delivery/kpis').arrivedInsideWindow;
}

/** One case's golden row: the visit, its office texts and its KPI facts (and the KPI row it feeds). */
export function goldenRow(c: GoldenCase, f: GoldenFns): { row: unknown; kv: import('@/lib/delivery/kpis').KpiVisit } {
  const v = f.deriveVisit(c.events, c.ctx);
  const kv = {
    ...v,
    casesPlanned: 40,
    windowStartMin: c.ctx.windowStartMin,
    windowEndMin: c.ctx.windowStartMin !== null ? c.ctx.windowStartMin + 120 : null,
    dayStart: c.ctx.dayStart,
    plannedServiceMin: 15,
    deliveryDate: '2026-10-05',
    truckId: 't1',
  };
  return {
    kv,
    row: goldenJson({
      visit: v,
      text: {
        arrivalBy: f.arrivalByText(v.arrivalSource, v.arrivalObserved),
        arrivalNote: f.arrivalNote(v.arrivalSource, v.arrivalObserved),
        departureNote: f.departureNote(v.departedAtOutcome, v.departureGap),
        timedBy: f.timedByText(v),
        actual: f.actualMinutes(v),
      },
      kpi: { observed: f.arrivalIsObserved(kv), inside: f.arrivedInsideWindow(kv) },
    }),
  };
}
