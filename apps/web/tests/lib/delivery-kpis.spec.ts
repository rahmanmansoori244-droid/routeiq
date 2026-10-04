/**
 * Delivery outcome KPIs (owner request 4 Oct 2026, spec section 11.4): delivered in full, cases
 * delivered, not delivered by reason, arrivals inside the window (observed, verified arrivals only;
 * an early arrival counts as inside; an open end is unbounded), the unloading delta, the scope from
 * the feature's start. Synthetic data only.
 */
import { describe, expect, it } from 'vitest';
import { arrivedInsideWindow, deliveryKpis, inOutcomeScope, kpiHeadline, kpiOnTimeText, type KpiVisit } from '@/lib/delivery/kpis';
import { zonedDayStart } from '@/lib/dispatch/time';

const DAY = '2026-10-05';
const dayStart = zonedDayStart(DAY, 'Asia/Muscat');
const at = (min: number) => new Date(dayStart.getTime() + min * 60_000);

const v = (over: Partial<KpiVisit> = {}): KpiVisit => ({
  outcome: 'DELIVERED',
  reason: null,
  casesPlanned: 10,
  casesDelivered: 10,
  arrivedAt: at(600),
  arrivalSource: 'PHONE_AUTO',
  arrivalObserved: true,
  timingSuspect: false,
  windowStartMin: 480,
  windowEndMin: 660,
  autoServiceMinutes: 25,
  plannedServiceMin: 20,
  outcomeLate: false,
  noPhotoReason: null,
  autoArrivedAt: at(600),
  deliveryDate: DAY,
  dayStart,
  ...over,
});

describe('delivery KPIs (spec 11.4)', () => {
  it('every formula on a small day', () => {
    const k = deliveryKpis([
      v(),
      v({ outcome: 'PARTLY_DELIVERED', reason: 'DAMAGED_GOODS', casesDelivered: 4 }),
      v({ outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', casesDelivered: 0, autoServiceMinutes: null }),
      v({ outcome: 'NOT_DELIVERED', reason: 'SHOP_CLOSED', casesDelivered: 0, casesPlanned: 30, arrivedAt: at(700), autoServiceMinutes: null }),
      null,
      v({ outcome: null, casesDelivered: null }),
      // "Camera not working" is read from the driver's own result (an office correction keeps it).
      v({ noPhotoReason: 'CAMERA_FAILED', outcomeLate: true, driverResultOutcome: 'DELIVERED', driverNoPhotoReason: 'CAMERA_FAILED' }),
    ]);
    expect(k).toMatchObject({ stops: 7, withResult: 5, delivered: 2, partly: 1, notDelivered: 2, noResult: 2, cameraFailed: 1, withoutPhoto: 1, late: 1 });
    expect(k.deliveredInFullPct).toBe(40);
    expect(k.casesPlanned).toBe(70);
    expect(k.casesDelivered).toBe(24);
    expect(k.casesDeliveredPct).toBe(34.3);
    expect(k.byReason).toEqual([
      { reason: 'SHOP_CLOSED', stops: 2, cases: 40 },
      { reason: 'DAMAGED_GOODS', stops: 1, cases: 6 },
    ]);
    // Arrivals: six visits with an observed arrival at a stop with a window (the no-result visit too); one at 11:40 is after 11:00.
    expect(k.timedArrivals).toBe(6);
    expect(k.insideWindow).toBe(5);
    expect(k.insideWindowPct).toBe(83.3);
    // The unloading delta: delivered / partly visits that feed measured times (the late one does not): +5 twice.
    expect(k.unloadSample).toBe(2);
    expect(k.avgUnloadDeltaMin).toBe(5);
    expect(kpiHeadline(k)).toBe('5 of 7 stops have a result · 2 delivered in full · 1 partly · 2 not delivered · 2 no result yet');
    expect(kpiOnTimeText(k)).toBe('Arrived inside the window 83.3 % (of 6 observed arrivals)');
  });

  it('an empty day', () => {
    const k = deliveryKpis([]);
    expect(k).toMatchObject({ stops: 0, withResult: 0, deliveredInFullPct: null, insideWindowPct: null, avgUnloadDeltaMin: null, byReason: [] });
    expect(kpiHeadline(k)).toBe('No dispatched stops yet.');
    expect(kpiOnTimeText(k)).toBeNull();
  });

  it('on time: an early arrival is inside, an open end is unbounded, no window or an unobserved / unverified arrival does not count', () => {
    expect(arrivedInsideWindow(v({ arrivedAt: at(400) }))).toBe(true);
    expect(arrivedInsideWindow(v({ arrivedAt: at(661) }))).toBe(false);
    expect(arrivedInsideWindow(v({ windowEndMin: null, arrivedAt: at(1300) }))).toBe(true);
    expect(arrivedInsideWindow(v({ windowStartMin: null, windowEndMin: null }))).toBeNull();
    // Resumed (found when the page came back): never in the KPI.
    expect(arrivedInsideWindow(v({ arrivalObserved: false }))).toBeNull();
    expect(arrivedInsideWindow(v({ timingSuspect: true }))).toBeNull();
    // Manual, office and (later) Ayun arrivals count.
    expect(arrivedInsideWindow(v({ arrivalSource: 'PHONE_MANUAL', arrivalObserved: true }))).toBe(true);
    expect(arrivedInsideWindow(v({ arrivalSource: 'DISPATCHER' }))).toBe(true);
    expect(arrivedInsideWindow(v({ arrivalSource: 'AYUN' }))).toBe(true);
    expect(arrivedInsideWindow(v({ arrivedAt: null, arrivalSource: null }))).toBeNull();
  });

  it('days before outcomesSince are out of scope unless the truck-day has a link or a visit', () => {
    expect(inOutcomeScope('2026-10-04', '2026-10-04', false)).toBe(false);
    expect(inOutcomeScope('2026-10-03', '2026-10-04', false)).toBe(false);
    expect(inOutcomeScope('2026-10-05', '2026-10-04', false)).toBe(true);
    expect(inOutcomeScope('2026-10-04', '2026-10-04', true)).toBe(true);
    expect(inOutcomeScope('2026-10-01', null, false)).toBe(true);
  });
});
