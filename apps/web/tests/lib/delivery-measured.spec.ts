/**
 * Measured unloading time per customer (owner request 4 Oct 2026, spec section 11.1): the median of
 * the last 10 automatically timed visits (3 needed), from the service start, the per-case part taken
 * off, unverified / late / unobserved / outlier visits left out. Synthetic customers only (ACME).
 */
import { describe, expect, it } from 'vitest';
import { eligibleForMeasured, measuredServiceValue, measuredText, measuredUnloading, median, type MeasuredVisit } from '@/lib/delivery/measured';
import { deriveVisit, type VisitEvent } from '@/lib/delivery/visit';
import { effectiveAttrs } from '@/lib/dispatch/customer-attrs';
import { zonedDayStart } from '@/lib/dispatch/time';

const visit = (day: number, minutes: number | null, over: Partial<MeasuredVisit> = {}): MeasuredVisit => ({
  outcome: 'DELIVERED',
  autoServiceMinutes: minutes,
  timingSuspect: false,
  outcomeLate: false,
  plannedServiceMin: 30,
  casesDelivered: 0,
  autoArrivedAt: new Date(Date.UTC(2026, 8, day, 6, 0)),
  deliveryDate: `2026-09-${String(day).padStart(2, '0')}`,
  ...over,
});

describe('measured unloading time (spec 11.1)', () => {
  it('the median of the last 10 eligible visits, newest first; fewer than 3 gives nothing', () => {
    expect(measuredUnloading([visit(1, 20), visit(2, 22)], 0)).toBeNull();
    const m = measuredUnloading([visit(1, 20), visit(2, 22), visit(3, 30)], 0)!;
    expect(m).toEqual({ minutes: 22, n: 3, from: '2026-09-01', to: '2026-09-03' });
    // 12 visits: the two oldest (5 and 6 min) drop out.
    const many = [visit(1, 5), visit(2, 6), ...Array.from({ length: 10 }, (_, i) => visit(10 + i, 20 + i))];
    expect(measuredUnloading(many, 0)).toEqual({ minutes: 25, n: 10, from: '2026-09-10', to: '2026-09-19' });
    expect(median([1, 3, 2, 4])).toBe(2.5);
  });

  it('takes the per-case part off (the same base as the customer unloading time)', () => {
    const vs = [visit(1, 40, { casesDelivered: 100 }), visit(2, 44, { casesDelivered: 100 }), visit(3, 50, { casesDelivered: 200 })];
    // 0.1 min per case: 30, 34, 30 -> 30.
    expect(measuredUnloading(vs, 0.1)!.minutes).toBe(30);
    // Never below 0.
    expect(measuredUnloading(vs, 10)!.minutes).toBe(0);
  });

  it('leaves out unverified, late, not delivered, untimed (not observed) and outlier visits', () => {
    expect(eligibleForMeasured(visit(1, 20))).toBe(true);
    expect(eligibleForMeasured(visit(1, 20, { outcome: 'PARTLY_DELIVERED' }))).toBe(true);
    expect(eligibleForMeasured(visit(1, 20, { outcome: 'NOT_DELIVERED' }))).toBe(false);
    expect(eligibleForMeasured(visit(1, 20, { outcome: null }))).toBe(false);
    expect(eligibleForMeasured(visit(1, 20, { timingSuspect: true }))).toBe(false);
    expect(eligibleForMeasured(visit(1, 20, { outcomeLate: true }))).toBe(false);
    // A resumed (not observed) arrival never gets autoServiceMinutes.
    expect(eligibleForMeasured(visit(1, null))).toBe(false);
    expect(eligibleForMeasured(visit(1, 0.5))).toBe(false);
    // Over the plan + 60 min, or over 240 min.
    expect(eligibleForMeasured(visit(1, 90, { plannedServiceMin: 30 }))).toBe(true);
    expect(eligibleForMeasured(visit(1, 91, { plannedServiceMin: 30 }))).toBe(false);
    expect(eligibleForMeasured(visit(1, 241, { plannedServiceMin: 300 }))).toBe(false);
    expect(eligibleForMeasured(visit(1, 200, { plannedServiceMin: null }))).toBe(true);
  });

  it('an early arrival that waits for the window is measured from the window start; a stop across the break is not measured', () => {
    const date = '2026-09-10';
    const dayStart = zonedDayStart(date, 'Asia/Muscat');
    const at = (hh: number, mm: number) => new Date(dayStart.getTime() + (hh * 60 + mm) * 60_000);
    const ev = (kind: VisitEvent['kind'], t: Date, source: VisitEvent['source'], payload: Record<string, unknown> = {}): VisitEvent => ({ kind, source, at: t, receivedAt: t, payload });
    // ACME receives from 08:00: arrives (observed) 07:40, unloads 08:00-08:20, leaves 08:21.
    const events = [ev('ARRIVED', at(7, 40), 'PHONE_AUTO'), ev('OUTCOME', at(8, 20), 'PHONE_MANUAL', { outcome: 'DELIVERED' }), ev('DEPARTED', at(8, 21), 'PHONE_AUTO')];
    const v = deriveVisit(events, { dayStart, windowStartMin: 8 * 60, breakMin: null, lines: [], pin: null, radiusM: 100 });
    expect(v.autoMinutes).toBe(41);
    expect(v.autoServiceMinutes).toBe(21);
    const across = deriveVisit(events, { dayStart, windowStartMin: 8 * 60, breakMin: { startMin: 8 * 60 + 10, endMin: 9 * 60 + 10 }, lines: [], pin: null, radiusM: 100 });
    expect(across.autoServiceMinutes).toBeNull();
  });

  it('"planned" is the effective base time (the type or Settings default for an unconfirmed customer) and the text names both', () => {
    const c = {
      priority: 3,
      priorityConfirmed: false,
      avgServiceTimeMin: 10,
      serviceTimeConfirmed: false,
      customerType: 'HYPER',
      windowConfirmedAt: null,
      hardWindowStartMin: null,
      hardWindowEndMin: null,
      prefWindowStartMin: null,
      prefWindowEndMin: null,
    };
    const profiles = new Map([['HYPER', { customerType: 'HYPER', defaultPriority: null, serviceTimeMin: 20, hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null }]]);
    const planned = effectiveAttrs(c as never, profiles, { serviceTimeMin: 15 }).serviceMin;
    expect(planned).toBe(20);
    const m = { minutes: 34, n: 7, from: '2026-09-12', to: '2026-10-03' };
    expect(measuredText(planned, m)).toBe('Unloading: 20 min planned · measured 34 min (median of 7 timed visits, 12 Sep - 3 Oct)');
    expect(measuredText(planned, null)).toBe('Unloading: 20 min planned · not measured yet (needs 3 timed visits)');
    expect(measuredServiceValue({ ...m, minutes: 0 })).toBe(1);
    expect(measuredServiceValue({ ...m, minutes: 999 })).toBe(480);
  });
});
