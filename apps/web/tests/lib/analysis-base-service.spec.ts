/**
 * The base unloading time of the analysis facts (FactVisit.baseServiceMin) is the one the planner used, and the
 * per-case rate takes it off (fix of 19 Oct 2026). The first facts (17-18 Oct 2026) stored the customer's stored
 * time: 10 min, the column default, for customers never confirmed, while the plan gave them the company default
 * (15) + the time per case. Invented customers only.
 * - lib/analysis/job.ts baseServiceOf is the planner's rule (lib/dispatch/customer-attrs.ts effectiveServiceTime,
 *   what effectiveAttrs uses): a confirmed time, else the customer type's, else the company default;
 * - lib/analysis/build.ts: minPerCase = (unloading - base) / cases delivered, 0 when shorter than the base (the
 *   database CHECKs it is never negative); without a base the visit is not usable for the rate.
 */
import { describe, expect, it } from 'vitest';
import { buildTruckDayFacts } from '@/lib/analysis/build';
import { baseServiceOf } from '@/lib/analysis/job';
import { effectiveAttrs, type CustomerForPlanning, type TypeProfileLike } from '@/lib/dispatch/customer-attrs';
import { A, atOn, load, SETTINGS, stop, truckDayOf, visit } from './analysis-fakes';

const COMPANY_DEFAULT = 15;
const profile = (customerType: string, serviceTimeMin: number | null): TypeProfileLike => ({
  customerType, defaultPriority: null, serviceTimeMin, hardWindowStartMin: null, hardWindowEndMin: null, prefWindowStartMin: null, prefWindowEndMin: null,
});
const PROFILES = new Map([profile('HYPERMARKET', 25), profile('KIOSK', null)].map((p) => [p.customerType, p]));
const customer = (over: Partial<CustomerForPlanning>): CustomerForPlanning => ({
  id: 'cust-1', code: 'TST0001', branchCode: null, name: 'Shop Example One', lat: 20.12, lng: 55.1, priority: 3, priorityConfirmed: false,
  avgServiceTimeMin: 10, serviceTimeConfirmed: false, customerType: null, hardWindowStartMin: null, hardWindowEndMin: null,
  prefWindowStartMin: null, prefWindowEndMin: null, locationVerified: true, createdFromUpload: false, ...over,
});

describe('the base unloading of the facts is the planner\'s (baseServiceOf)', () => {
  const cases: [string, Partial<CustomerForPlanning>, number][] = [
    ['not confirmed, stored 10, no type: the company default 15', { avgServiceTimeMin: 10, serviceTimeConfirmed: false }, 15],
    ['confirmed at 10: 10', { avgServiceTimeMin: 10, serviceTimeConfirmed: true }, 10],
    ['confirmed at 10 with a typed profile of 25: still 10 (a confirmed time wins)', { avgServiceTimeMin: 10, serviceTimeConfirmed: true, customerType: 'HYPERMARKET' }, 10],
    ['not confirmed, a customer type with its own time: the type\'s 25', { avgServiceTimeMin: 10, serviceTimeConfirmed: false, customerType: 'HYPERMARKET' }, 25],
    ['not confirmed, a customer type without a time: the company default 15', { avgServiceTimeMin: 10, serviceTimeConfirmed: false, customerType: 'KIOSK' }, 15],
    ['not confirmed, a type with no profile: the company default 15', { avgServiceTimeMin: 10, serviceTimeConfirmed: false, customerType: 'UNKNOWN' }, 15],
  ];
  it.each(cases)('%s', (_name, over, expected) => {
    const c = customer(over);
    expect(baseServiceOf(c, PROFILES, COMPANY_DEFAULT)).toBe(expected);
    // The same number the plan was made with (plan-service.ts: effectiveAttrs(...).serviceMin + per case x cases).
    expect(baseServiceOf(c, PROFILES, COMPANY_DEFAULT)).toBe(effectiveAttrs(c, PROFILES, { serviceTimeMin: COMPANY_DEFAULT }).serviceMin);
  });

  it('a customer not found has no base', () => {
    expect(baseServiceOf(undefined, PROFILES, COMPANY_DEFAULT)).toBeNull();
  });
});

describe('the per-case rate takes the base off (buildTruckDayFacts)', () => {
  const D = '2026-10-18';
  const L = (hhmm: string) => atOn(D, hhmm);
  const NOW = new Date('2026-10-19T00:00:00Z');
  /** One stop of 40 planned cases, unloaded 07:00-07:35 (35 min, as RouteIQ holds it: no GPS), 40 delivered. */
  const rowWith = (baseServiceMin: number | null) => {
    const v = visit(1, 1, {
      arrivedAt: L('07:00'), arrivalSource: 'PHONE_MANUAL', departedAt: L('07:35'), departureSource: 'PHONE_MANUAL', departedAtOutcome: true,
      outcome: 'DELIVERED', outcomeAt: L('07:35'), outcomeSource: 'PHONE_MANUAL', casesDelivered: 40,
    });
    const input = truckDayOf(D, [load(1, [stop(1, A, { baseServiceMin })])], [v], []);
    return buildTruckDayFacts(input, SETTINGS, { kind: 'NONE' }, { now: NOW }).visits[0]!;
  };

  it('base 15 (the plan\'s, not the stored 10): (35 - 15) / 40 = 0.5 min per case', () => {
    expect(rowWith(15)).toMatchObject({ baseServiceMin: 15, unloadMin: 35, usableForRate: true, minPerCase: 0.5 });
    // The stored 10 would have read 0.63; unloading / cases (the first builder) 0.88.
    expect(rowWith(10).minPerCase).toBe(0.63);
  });

  it('unloaded in less than the base: 0 per case, still usable, never negative', () => {
    expect(rowWith(40)).toMatchObject({ baseServiceMin: 40, unloadMin: 35, usableForRate: true, minPerCase: 0 });
  });

  it('no base known: not usable for the rate', () => {
    expect(rowWith(null)).toMatchObject({ baseServiceMin: null, unloadMin: 35, usableForRate: false, minPerCase: null });
  });
});
