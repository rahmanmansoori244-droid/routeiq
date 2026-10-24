/**
 * The kept-load warning (lib/dispatch/kept-changes.ts, kept-changes-server.ts): locked and loading loads
 * planned with customer data that changed since. A re-plan keeps those loads exactly as they are, so the
 * day screen, the plan screen and the re-plan dialog list them, say whether the planned times still keep
 * the rules with the data now, and offer the existing Unlock (latest first) so a re-plan can use the data
 * now. Synthetic data only (trucks T05/T06, customers C001/C003/C007).
 *
 * - the pure report: receiving hours by the load's own rule (START / FINISH), the pin, the small-truck
 *   mark, a deactivated customer, cancelled or moved orders, new orders of the customer; the unlock chains
 *   naming every load that goes back (review W5); no "join" offer (owner decision, review W4); the
 *   fingerprint, the dialog lines, the audit rows (codes only), the re-plan body after an unlock (W6) and
 *   the words when the unlock or the re-plan is refused (W7);
 * - hardWindowMiss gives the timetable check's answer (feasibility.ts HARD_WINDOW);
 * - on the in-memory database (fake-plan-db.ts): the loader, the plan screen's report and its
 *   "Changed after planning" note agree on the hours (one rule, review W3: a new order of the customer
 *   never reads as the kept stop's hours), the unlock's LOAD_PLANNED row records what changed - read
 *   before the load moves (review W2) - and KEPT_CHANGES=off answers as before the warning.
 * The real-PostgreSQL path is in tests/integration/kept-changes-db.spec.ts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakePrisma, resetDb, row, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/tenant', async () => {
  const m = await import('./fake-plan-db');
  return { tenantDb: () => m.fakePrisma };
});
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return { audit: vi.fn(async (input: Record<string, unknown>) => m.fakePrisma.auditLog.create({ data: { ...input } })) };
});

import {
  backToPlannedText,
  keptAudit,
  keptEcho,
  keptEchoText,
  keptFingerprint,
  keptLines,
  keptQuestion,
  keptReplanBody,
  keptReplanNote,
  keptReport,
  keptSeenAfter,
  keptStopChanges,
  mergeUnlocks,
  replanNotStartedText,
  unlockAlsoText,
  unlockButtonText,
  unlockConfirmText,
  unlockKeptLoads,
  unlockOfferText,
  unlockStoppedText,
  unlockedReplanText,
  type KeptLoadInput,
  type KeptLoadRef,
  type KeptStopInput,
  type TruckLoadRef,
} from '@/lib/dispatch/kept-changes';
import { keptChangesConfigProblem, keptChangesMode, keptChangesOf, keptDayOrdersWhere } from '@/lib/dispatch/kept-changes-server';
import { hardWindowMiss } from '@/lib/dispatch/window-rule';
import { keptVisitOrders } from '@/lib/dispatch/order-window';
import { checkPlanFeasibility, type FeasLoad } from '@/lib/dispatch/feasibility';
import type { PlanRules, StopSnapshot } from '@/lib/dispatch/snapshots';
import { configProblems } from '@/lib/startup-checks';
import { ordersInScopeWhere, updateLoad } from '@/lib/dispatch/plan-service';
import { getPlanDetail } from '@/lib/dispatch/plan-detail';

const RULES: PlanRules = { shiftStartMin: 360, shiftMaxMin: 660, reloadMin: 30, loadingMinPerCase: 0, maxTrips: 3, depotOpenMin: 0, depotCloseMin: 1440, availableFromMin: null, availableToMin: null };
const CAPTURED = '2026-10-23T12:00:00.000Z';

function snap(over: Partial<StopSnapshot> = {}): StopSnapshot {
  return {
    v: 1, customerId: 'c7', code: 'C007', branchCode: null, name: 'Shop 7', customerType: null, lat: 23.6, lng: 58.4, address: 'Seeb', accessNotes: null,
    hardStartMin: 900, hardEndMin: 1080, prefStartMin: null, prefEndMin: null, serviceMin: 18, priority: 2, source: 'PLAN', capturedAt: CAPTURED, ...over,
  };
}

function stopIn(over: Partial<KeptStopInput> = {}, live: Partial<KeptStopInput['live']> = {}, customer: Partial<KeptStopInput['customer']> = {}): KeptStopInput {
  return {
    sequence: 1, customerId: 'c7', snapshot: snap(), split: null, serviceStartMin: 900, departureMin: 918,
    live: { name: 'Shop 7', address: 'Seeb', lat: 23.6, lng: 58.4, hardStartMin: 900, hardEndMin: 1080, prefStartMin: null, prefEndMin: null, promised: null, ...live },
    customer: { code: 'C007', branchCode: null, name: 'Shop 7', active: true, smallTruckOnly: false, locationUsable: true, ...customer },
    orders: [{ id: 'o7', cancelled: false, carriedTo: null }],
    newOrders: [],
    ...over,
  };
}

function loadIn(over: Partial<KeptLoadInput> = {}, stops: KeptStopInput[] = [stopIn()]): KeptLoadInput {
  return { loadId: 'L2', truckId: 't5', truckCode: 'T05', loadNo: 2, status: 'LOCKED', rules: RULES, truckSmallNow: false, stops, ...over };
}

const truckLoads = (statuses: Record<number, string>): TruckLoadRef[] => Object.entries(statuses).map(([n, status]) => ({ loadId: `L${n}`, truckId: 't5', truckCode: 'T05', loadNo: Number(n), status }));

describe('what changed on a kept stop (keptStopChanges)', () => {
  it('hours widened 15:00-18:00 -> 08:00-18:00: the planned unloading at 15:00 still keeps them (STILL_OK, widened)', () => {
    const [c] = keptStopChanges(stopIn({}, { hardStartMin: 480 }), loadIn());
    expect(c).toMatchObject({ kind: 'HOURS', effect: 'STILL_OK', planned: '15:00–18:00', now: '08:00–18:00', widened: true });
    expect(c!.text).toContain('The planned unloading at 15:00 still keeps them.');
  });

  it('hours narrowed to 17:00-18:00: the planned 15:00 is outside them (BREAKS); moved to 08:00-12:00 too (it starts earlier: widened)', () => {
    const [c] = keptStopChanges(stopIn({}, { hardStartMin: 1020, hardEndMin: 1080 }), loadIn());
    expect(c).toMatchObject({ kind: 'HOURS', effect: 'BREAKS', now: '17:00–18:00' });
    expect(c!.widened).toBeUndefined();
    expect(c!.text).toContain('The planned unloading at 15:00 is outside them.');
    expect(keptStopChanges(stopIn({}, { hardStartMin: 480, hardEndMin: 720 }), loadIn())[0]).toMatchObject({ effect: 'BREAKS', now: '08:00–12:00', widened: true });
  });

  it("by the load's own rule: unloading 15:00-15:18 against a 15:15 close breaks FINISH, keeps START", () => {
    const narrowed = stopIn({}, { hardEndMin: 915 });
    expect(keptStopChanges(narrowed, loadIn({ rules: { ...RULES, windowRule: 'FINISH' } }))[0]).toMatchObject({ effect: 'BREAKS' });
    expect(keptStopChanges(narrowed, loadIn({ rules: { ...RULES, windowRule: 'START' } }))[0]).toMatchObject({ effect: 'STILL_OK' });
    // A load planned before the rule was echoed: checked like START (unloading had to start by closing).
    expect(keptStopChanges(narrowed, loadIn({ rules: RULES }))[0]).toMatchObject({ effect: 'STILL_OK' });
  });

  it('only the preferred hours changed: STILL_OK; the planned time not known: CHECK', () => {
    expect(keptStopChanges(stopIn({}, { prefStartMin: 1000, prefEndMin: 1100 }), loadIn())[0]).toMatchObject({ kind: 'HOURS', effect: 'STILL_OK', short: 'preferred hours changed: still kept' });
    expect(keptStopChanges(stopIn({ serviceStartMin: null }, { hardStartMin: 480 }), loadIn())[0]).toMatchObject({ kind: 'HOURS', effect: 'CHECK' });
  });

  it('an inverted window on both sides is no change (usableWindow), and nothing changed lists nothing', () => {
    expect(keptStopChanges(stopIn({ snapshot: snap({ hardStartMin: 900, hardEndMin: 600 }) }, { hardStartMin: 900, hardEndMin: 600 }), loadIn())).toEqual([]);
    expect(keptStopChanges(stopIn(), loadIn())).toEqual([]);
  });

  it('the pin: 40 m nothing, 120 m listed (STILL_OK), 800 m CHECK; the load still goes to the planned pin', () => {
    const moved = (dLat: number) => keptStopChanges(stopIn({}, { lat: 23.6 + dLat }), loadIn());
    expect(moved(0.00036)).toEqual([]);
    expect(moved(0.0011)[0]).toMatchObject({ kind: 'LOCATION', effect: 'STILL_OK' });
    const far = moved(0.0072)[0]!;
    expect(far).toMatchObject({ kind: 'LOCATION', effect: 'CHECK' });
    expect(far.text).toContain('The load still goes to the pin it was planned with (its sheets add "New pin - ask the dispatcher which one to use" with the new pin).');
    expect(far.text).not.toMatch(/driver gets the new pin|uses? the new pin/i);
  });

  it('no usable location now (removed, or not usable): BREAKS - Loading and Dispatch are refused', () => {
    const c = keptStopChanges(stopIn({}, { lat: null, lng: null }, { locationUsable: false }), loadIn());
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: 'LOCATION', effect: 'BREAKS' });
    expect(keptStopChanges(stopIn({}, {}, { locationUsable: false }), loadIn())[0]).toMatchObject({ kind: 'LOCATION', effect: 'BREAKS', short: 'no usable location now' });
  });

  it('review W-4: a new pin over a point that was not usable is BREAKS, never STILL_OK or CHECK - the location gate refuses Loading and Dispatch', () => {
    for (const dLat of [0.0011, 0.0072]) {
      const [c] = keptStopChanges(stopIn({}, { lat: 23.6 + dLat }, { pinReplaced: true }), loadIn());
      expect(c).toMatchObject({ kind: 'LOCATION', effect: 'BREAKS' });
      expect(c!.text).toContain('The stop still goes to its old point, which was not usable when the new pin replaced it: Loading and Dispatch of this load are refused');
      // The same fingerprint key as the plain pin move (kind, planned, now): only the effect differs.
      expect(c!.now).toBe(keptStopChanges(stopIn({}, { lat: 23.6 + dLat }), loadIn())[0]!.now);
    }
  });

  it('small truck only on a truck that is not small: BREAKS; a deactivated customer: CHECK', () => {
    expect(keptStopChanges(stopIn({}, {}, { smallTruckOnly: true }), loadIn())[0]).toMatchObject({ kind: 'SMALL_TRUCK', effect: 'BREAKS' });
    expect(keptStopChanges(stopIn({}, {}, { smallTruckOnly: true }), loadIn({ truckSmallNow: true }))).toEqual([]);
    expect(keptStopChanges(stopIn({}, {}, { active: false }), loadIn())[0]).toMatchObject({ kind: 'CUSTOMER_INACTIVE', effect: 'CHECK' });
  });

  it('an order cancelled, or moved to a later day, since: BREAKS (its gate refuses Loading and Dispatch)', () => {
    const c = keptStopChanges(stopIn({ orders: [{ id: 'o7', cancelled: true, carriedTo: null }, { id: 'o8', cancelled: false, carriedTo: '2026-10-25' }] }), loadIn());
    expect(c).toEqual([expect.objectContaining({ kind: 'ORDER', effect: 'BREAKS', short: 'order cancelled, order moved to a later day' })]);
    expect(c[0]!.text).toBe('An order of this stop was cancelled, and an order of this stop was moved to 25 Oct after planning: Loading and Dispatch of this load are refused until it is unlocked and re-planned.');
  });

  it('a new order of the customer: STILL_OK, another visit, and where it is now', () => {
    const c = keptStopChanges(stopIn({ newOrders: [{ id: 'o9', cases: 12, where: 'on T06 L1 (planned)' }] }), loadIn());
    expect(c).toEqual([expect.objectContaining({ kind: 'NEW_ORDER', effect: 'STILL_OK' })]);
    expect(c[0]!.text).toBe('A new order of this customer (12 cases) came after this load was planned: it is another visit (on T06 L1 (planned)).');
  });
});

describe('the report of a version (keptReport)', () => {
  const widened = stopIn({}, { hardStartMin: 480 });

  it('one load, its unlock chain (itself), no join offer (owner decision; review W4)', () => {
    const r = keptReport([loadIn({}, [widened])], truckLoads({ 1: 'LOCKED', 2: 'LOCKED' }));
    expect(r.counts).toEqual({ loads: 1, stops: 1, breaks: 0, check: 0 });
    const l = r.loads[0]!;
    expect(l).toMatchObject({ label: 'T05 L2', worst: 'STILL_OK', unlock: { loads: [{ loadId: 'L2', label: 'T05 L2', changed: true }], blocked: null } });
    expect('join' in l).toBe(false);
    expect(unlockButtonText(l)).toBe('Unlock T05 L2');
    expect(unlockOfferText(l)).toBe('Unlock T05 L2 first');
    expect(unlockAlsoText(l)).toBeNull();
  });

  it('a later LOCKED load goes back first and is named as unchanged (review W5)', () => {
    const r = keptReport([loadIn({}, [widened])], truckLoads({ 1: 'DISPATCHED', 2: 'LOCKED', 3: 'LOCKED' }));
    const l = r.loads[0]!;
    expect(l.unlock.loads.map((x) => [x.label, x.changed])).toEqual([['T05 L3', false], ['T05 L2', true]]);
    // Review W-6: "first" once; the box's button short, with the reason under it.
    expect(unlockOfferText(l)).toBe("Unlock T05 L3 and T05 L2 first (no change on T05 L3: a truck's later loads go back to Planned before its earlier ones)");
    expect(unlockButtonText(l)).toBe('Unlock T05 L3 and T05 L2');
    expect(unlockAlsoText(l)).toBe("No change on T05 L3: a truck's later loads go back to Planned before its earlier ones.");
    expect(unlockConfirmText(l.unlock.loads)).toMatch(/^Put T05 L3 and T05 L2 back to Planned\? T05 L3 goes back too, although nothing changed on it/);
  });

  it('a later load being loaded, or the load itself being loaded: no unlock offered, and why', () => {
    const later = keptReport([loadIn({}, [widened])], truckLoads({ 2: 'LOCKED', 3: 'LOADING' })).loads[0]!;
    expect(later.unlock.blocked).toBe("T05 L3 is being loaded, and a truck's later loads go back to Planned first. If its cases can still come off, press Back to locked on T05 L3 first.");
    const self = keptReport([loadIn({ status: 'LOADING' }, [widened])], truckLoads({ 2: 'LOADING' })).loads[0]!;
    expect(self.unlock.blocked).toBe('T05 L2 is being loaded: RouteIQ does not unlock a loading load from here. If its cases can still come off, press Back to locked on it first.');
    expect(keptQuestion(keptReport([loadIn({ status: 'LOADING' }, [widened])], truckLoads({ 2: 'LOADING' })))!.offers[0]!.blocked).toBe(self.unlock.blocked);
  });

  it('PLANNED, DISPATCHED and COMPLETED loads are never in it; a load without changes neither', () => {
    for (const status of ['PLANNED', 'DISPATCHED', 'COMPLETED']) {
      expect(keptReport([loadIn({ status: status as 'LOCKED' }, [widened])], truckLoads({ 2: status })).loads).toEqual([]);
    }
    expect(keptReport([loadIn({}, [stopIn()])], truckLoads({ 2: 'LOCKED' })).loads).toEqual([]);
  });

  it('BREAKS first; the fingerprint does not depend on the order of the input, and changes with a change', () => {
    const a = loadIn({ loadId: 'A1', truckId: 't1', truckCode: 'T01', loadNo: 1 }, [widened]);
    const b = loadIn({ loadId: 'B1', truckId: 't9', truckCode: 'T09', loadNo: 1 }, [stopIn({}, { hardStartMin: 480, hardEndMin: 720 })]);
    const all: TruckLoadRef[] = [
      { loadId: 'A1', truckId: 't1', truckCode: 'T01', loadNo: 1, status: 'LOCKED' },
      { loadId: 'B1', truckId: 't9', truckCode: 'T09', loadNo: 1, status: 'LOCKED' },
    ];
    const r1 = keptReport([a, b], all);
    const r2 = keptReport([b, a], all);
    expect(r1.loads.map((l) => l.label)).toEqual(['T09 L1', 'T01 L1']);
    expect(r1.fingerprint).toBe(r2.fingerprint);
    expect(r1.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    const more = keptReport([a, loadIn({ loadId: 'B1', truckId: 't9', truckCode: 'T09', loadNo: 1 }, [stopIn({ newOrders: [{ id: 'x', cases: 1, where: 'unserved' }] }, { hardStartMin: 480, hardEndMin: 720 })])], all);
    expect(more.fingerprint).not.toBe(r1.fingerprint);
    expect(keptFingerprint(r1.loads)).toBe(r1.fingerprint);
  });

  it('the dialog lines, the audit rows (codes and hours only, at most 50) and the 202 echo', () => {
    const r = keptReport([loadIn({}, [widened])], truckLoads({ 2: 'LOCKED' }));
    expect(keptLines(r)).toEqual({ lines: ['T05 L2 (locked): C007 - hours now 08:00–18:00 (planned with 15:00–18:00): still kept'], more: 0 });
    expect(keptAudit(r)).toEqual({ rows: [{ load: 'T05 L2', status: 'LOCKED', customer: 'C007', kinds: ['HOURS'], effect: 'STILL_OK', planned: '15:00–18:00', now: '08:00–18:00' }], truncated: 0 });
    expect(JSON.stringify(keptAudit(r))).not.toContain('Shop 7');
    const many = keptReport([loadIn({}, Array.from({ length: 60 }, (_, i) => stopIn({ sequence: i + 1 }, { hardStartMin: 480 })))], truckLoads({ 2: 'LOCKED' }));
    expect(keptAudit(many).rows).toHaveLength(50);
    expect(keptAudit(many).truncated).toBe(10);
    expect(keptLines(many)).toMatchObject({ more: 54 });
    expect(keptEcho(r, r.fingerprint)).toMatchObject({ loads: 1, breaks: 0, labels: ['T05 L2'], unseen: false });
    expect(keptEcho(r, 'deadbeef')!.unseen).toBe(true);
    expect(keptEcho(keptReport([], []), null)).toBeNull();
    expect(keptEchoText(keptEcho(r, null))).toBe('Kept as planned, with older customer data: T05 L2.');
  });

  it('review S1 / W-2: two changed loads, one unlocked - the re-plan reads the other one only, and that is no change "meanwhile"', () => {
    const a = loadIn({ loadId: 'A1', truckId: 't1', truckCode: 'T01', loadNo: 1 }, [widened]);
    const b = loadIn({ loadId: 'B1', truckId: 't9', truckCode: 'T09', loadNo: 1 }, [stopIn({}, { hardStartMin: 480, hardEndMin: 720 })]);
    const all: TruckLoadRef[] = [
      { loadId: 'A1', truckId: 't1', truckCode: 'T01', loadNo: 1, status: 'LOCKED' },
      { loadId: 'B1', truckId: 't9', truckCode: 'T09', loadNo: 1, status: 'LOCKED' },
    ];
    const shown = keptReport([a, b], all);
    const unlocked = shown.loads.find((l) => l.loadId === 'A1')!.unlock.loads;
    // After the unlock A1 is Planned: the re-plan's own read lists B1 only.
    const after = keptReport([b], [{ ...all[0]!, status: 'PLANNED' }, all[1]!]);
    // Before the fix the dialog's fingerprint was sent: "changed meanwhile" although nothing changed.
    expect(keptEcho(after, shown.fingerprint)!.unseen).toBe(true);
    expect(keptEcho(after, keptSeenAfter(shown, unlocked))!.unseen).toBe(false);
    // A real change meanwhile on B1 is still said.
    const changed = keptReport([loadIn({ loadId: 'B1', truckId: 't9', truckCode: 'T09', loadNo: 1 }, [stopIn({}, { hardStartMin: 1020, hardEndMin: 1080 })])], all);
    expect(keptEcho(changed, keptSeenAfter(shown, unlocked))!.unseen).toBe(true);
    // Nothing unlocked: the dialog's own fingerprint; no report shown: nothing to compare.
    expect(keptSeenAfter(shown, [])).toBe(shown.fingerprint);
    expect(keptSeenAfter(null, unlocked)).toBeUndefined();
  });
});

describe('the unlock and the re-plan after it (the screens)', () => {
  const ref = (loadNo: number, truckId = 't5', changed = true): KeptLoadRef => ({ loadId: `${truckId}-L${loadNo}`, truckId, loadNo, label: `${truckId === 't5' ? 'T05' : 'T06'} L${loadNo}`, status: 'LOCKED', changed });

  it('ticked offers become one list: each load once, a truck latest first', () => {
    expect(mergeUnlocks([[ref(3, 't5', false), ref(2)], [ref(3)], [ref(1, 't6')]]).map((x) => [x.label, x.changed])).toEqual([['T05 L3', true], ['T05 L2', true], ['T06 L1', true]]);
  });

  it('one load at a time, stopping at the first refusal; the words say what was unlocked and that no re-plan started', async () => {
    const seen: string[] = [];
    const res = await unlockKeptLoads([ref(3), ref(2)], async (l) => {
      seen.push(l.label);
      return l.loadNo === 3 ? { ok: true, error: null } : { ok: false, error: 'An optimization is running for this plan.' };
    });
    expect(seen).toEqual(['T05 L3', 'T05 L2']);
    expect(res.unlocked.map((l) => l.label)).toEqual(['T05 L3']);
    expect(unlockStoppedText({ unlocked: res.unlocked, failed: res.failed! })).toBe('T05 L3 is back to Planned. T05 L2 could not be unlocked: An optimization is running for this plan. Re-plan not started.');
    expect(backToPlannedText([ref(3), ref(2)])).toBe('T05 L3 and T05 L2 are back to Planned');
    // From the box (no re-plan asked): the same without "Re-plan not started".
    expect(unlockStoppedText({ unlocked: [], failed: res.failed! }, false)).toBe('T05 L2 could not be unlocked: An optimization is running for this plan.');
  });

  it('review N2: a load another dispatcher already put back to Planned counts as unlocked, and the chain goes on', async () => {
    const res = await unlockKeptLoads([ref(3), ref(2)], async (l) => (l.loadNo === 3 ? { ok: false, error: 'Load is already PLANNED.' } : { ok: true, error: null }));
    expect(res.failed).toBeNull();
    expect(res.unlocked.map((l) => l.label)).toEqual(['T05 L3', 'T05 L2']);
  });

  it('review W-8: the toast after an unlock says the new plan is being made, not made', () => {
    expect(unlockedReplanText([ref(2)])).toBe('T05 L2 is back to Planned and is being re-planned with the data now; print its sheet again when the new plan is ready.');
    expect(unlockedReplanText([ref(3), ref(2)])).toBe('T05 L3 and T05 L2 are back to Planned and are being re-planned with the data now; print their sheets again when the new plan is ready.');
  });

  it('review W-7: the dialog note names dispatched loads too, and points below only when a load can be ticked', () => {
    const offer = (blocked: string | null) => ({ offers: [{ id: 'L2', label: 'x', loads: [], blocked }] });
    expect(keptReplanNote(null)).toBe('Locked and dispatched loads stay exactly as they are.');
    expect(keptReplanNote(offer(null))).toBe('Locked, loading and dispatched loads stay exactly as they are; you can unlock the locked ones listed below first.');
    expect(keptReplanNote(offer('T05 L2 is being loaded: ...'))).toBe('Locked, loading and dispatched loads stay exactly as they are.');
  });

  it('review W7: the unlock went through, the re-plan was refused (429, 409 OPTIMIZING, 503): both are said', () => {
    expect(replanNotStartedText([ref(2)], 'Too many optimizations right now. Try again in a minute.')).toBe(
      'T05 L2 is back to Planned; re-plan not started: Too many optimizations right now. Try again in a minute. Press RE-PLAN again, or Lock the load again to keep it as it was.',
    );
    expect(replanNotStartedText([ref(2)], null)).toMatch(/re-plan not started: refused\./);
  });

  it('review W6 / W-1: after an unlock the re-plan is a manual adjustment naming the loads, never a full re-optimize; the late-order re-plan keeps its reason; nothing unlocked: as asked', () => {
    // Also with on-time orders waiting (review W-1): the server keeps MANUAL_ADJUSTMENT (plan continuity),
    // where a REOPTIMIZE would stay a full re-optimize and could move the unlocked stops to other trucks.
    expect(keptReplanBody('REOPTIMIZE', [ref(2)])).toEqual({ reason: 'MANUAL_ADJUSTMENT', note: 'Unlocked for changed customer data: T05 L2' });
    expect(keptReplanBody('LATE_ORDER', [ref(3), ref(2)])).toEqual({ reason: 'LATE_ORDER', note: 'Unlocked for changed customer data: T05 L3, T05 L2' });
    expect(keptReplanBody('REOPTIMIZE', [])).toEqual({ reason: 'REOPTIMIZE' });
  });
});

describe('hardWindowMiss reads a window as the timetable check does (feasibility.ts HARD_WINDOW)', () => {
  const feasMiss = (start: number, departure: number, hs: number | null, he: number | null, rule?: 'START' | 'FINISH') => {
    const l: FeasLoad = {
      id: 'L1', truckId: 't1', truckCode: 'T01', loadNo: 1, onRoad: false, departMin: start - 30, returnMin: departure + 30, cases: 10, weightKg: 10,
      capacity: { cases: 100, kg: 0 }, rules: { ...RULES, ...(rule ? { windowRule: rule } : {}) },
      stops: [{ orderId: 'o1', sequence: 1, label: 'C001', cases: 10, kg: 10, kgUnknown: false, etaMin: start, serviceStartMin: start, departureMin: departure, hardWindowOk: true, hardStartMin: hs, hardEndMin: he }],
    };
    return checkPlanFeasibility({ scenarioId: 's', solver: { status: 'VERIFIED', timing: 'EXACT', violations: [] }, loads: [l] }).violations.some((v) => v.code === 'HARD_WINDOW');
  };
  const CASES: [number, number, number | null, number | null, ('START' | 'FINISH')?][] = [
    [900, 918, 900, 1080], [899, 918, 900, 1080], [1080, 1098, 900, 1080], [1081, 1099, 900, 1080],
    [900, 916, 480, 915, 'FINISH'], [900, 917, 480, 915, 'FINISH'], [900, 918, 480, 915, 'FINISH'], [900, 918, 480, 915, 'START'],
    [600, 620, null, 700], [600, 620, 650, null], [600, 620, null, null, 'FINISH'], [1000, 1020, 480, 1000, 'FINISH'],
  ];
  it.each(CASES)('start %i, departure %i, window %s-%s, rule %s', (start, departure, hs, he, rule) => {
    expect(hardWindowMiss(start, departure, hs, he, rule ?? null)).toBe(feasMiss(start, departure, hs, he, rule));
  });
});

describe('the orders a kept stop is judged with (keptVisitOrders, review W3)', () => {
  it('never an order received after the stop was planned; one received before, or not known, still counts', () => {
    const orders = [
      { id: 'old', lines: [{ id: 'old-1', cases: 5 }], uploadedAt: new Date('2026-10-23T10:00:00Z') },
      { id: 'new', lines: [{ id: 'new-1', cases: 5 }], uploadedAt: new Date('2026-10-23T13:00:00Z') },
      { id: 'unknown', lines: [{ id: 'u-1', cases: 5 }], uploadedAt: null },
    ];
    expect(keptVisitOrders(orders, [], CAPTURED).map((o) => o.id)).toEqual(['old', 'unknown']);
    expect(keptVisitOrders(orders, [], null).map((o) => o.id)).toEqual(['old', 'new', 'unknown']);
  });
});

describe('KEPT_CHANGES (kill switch) and the startup line', () => {
  const env = (KEPT_CHANGES?: string) => ({ NODE_ENV: 'test', ...(KEPT_CHANGES === undefined ? {} : { KEPT_CHANGES }) }) as NodeJS.ProcessEnv;
  it('off only for off / 0 / false / no; anything else is on; a value it does not read is said', () => {
    for (const v of ['off', ' OFF ', '0', 'false', 'No']) expect(keptChangesMode(env(v))).toBe('off');
    for (const v of [undefined, '', 'on', '1', 'maybe']) expect(keptChangesMode(env(v))).toBe('on');
    expect(keptChangesConfigProblem(env())).toBeNull();
    expect(keptChangesConfigProblem(env('on'))).toBeNull();
    expect(keptChangesConfigProblem(env('maybe'))).toMatch(/does not read.*stays on/);
    const lines = configProblems({ NODE_ENV: 'development', KEPT_CHANGES: 'off' } as NodeJS.ProcessEnv);
    expect(lines.some((p) => p.level === 'warn' && p.message.startsWith('KEPT_CHANGES=off'))).toBe(true);
    expect(configProblems({ NODE_ENV: 'development' } as NodeJS.ProcessEnv).some((p) => p.message.includes('KEPT_CHANGES'))).toBe(false);
  });

  it("the loader's day orders are ordersInScopeWhere's (it cannot import plan-service)", async () => {
    const day = new Date('2026-10-24T00:00:00Z');
    expect(keptDayOrdersWhere('tA', 'D1', day)).toEqual(await ordersInScopeWhere('tA', 'D1', day));
  });

  it('review W-5: the routes pass it on - POST /replan its keptSeen, GET /plan asks for the report (the plan screen box)', () => {
    const route = (p: string) => readFileSync(path.resolve(__dirname, '../../app/api/runs/[id]', p, 'route.ts'), 'utf8');
    expect(route('replan')).toContain('keptSeen: z.string().trim().max(32).optional()');
    expect(route('replan')).toMatch(/input\.searchMode,\s*\{ keptSeen: input\.keptSeen \},?\s*\)/);
    expect(route('plan')).toContain('getPlanDetail(user.tenantId, params.id, {}, { kept: true })');
  });
});

// ---------------------------------------------------------------------------------------
// On the in-memory database
// ---------------------------------------------------------------------------------------

const T = 'tA';
const DAY = new Date('2026-10-24T00:00:00Z');
const NOW = new Date('2026-10-23T18:00:00Z'); // 22:00 in Muscat, the evening before
const user = { id: 'u1', role: 'TENANT_ADMIN' };
const allow = () => true;

const truckSnap = (code: string) => ({
  v: 1, code, capacityCases: 600, capacityWeightKg: 0, fixedCostPerDay: 20, tripCost: 0, costPerKm: 0.1, kmPerLitre: null,
  availableFromMin: null, availableToMin: null, maxTripsPerDay: null, rules: { ...RULES, windowRule: 'START' }, source: 'PLAN', capturedAt: CAPTURED,
});
const customer = (id: string, code: string, over: Record<string, unknown> = {}) => ({
  id, tenantId: T, code, branchCode: null, branchKey: '__MAIN__', name: `Shop ${code.slice(-1)}`, customerType: null, address: 'Seeb', accessNotes: null,
  lat: 23.6, lng: 58.4, priority: 2, priorityConfirmed: true, avgServiceTimeMin: 18, serviceTimeConfirmed: true,
  hardWindowStartMin: 900, hardWindowEndMin: 1080, prefWindowStartMin: null, prefWindowEndMin: null, active: true, locationVerified: true, createdFromUpload: false,
  geocodeConfidence: 'HIGH', smallTruckOnly: false, ...over,
});
const stopSnapOf = (c: ReturnType<typeof customer>) => snap({ customerId: c.id, code: c.code, name: c.name, hardStartMin: c.hardWindowStartMin, hardEndMin: c.hardWindowEndMin });
const linesOf = (id: string) => [{ id: `${id}-l1`, cases: 12, weightKg: 120, weightFromMaster: false, salesOrderNo: `INV-${id}`, product: { code: 'W05', name: 'Water', weightPerCaseKg: 10 } }];
const order = (id: string, c: ReturnType<typeof customer>, over: Record<string, unknown> = {}) => ({
  id, tenantId: T, customerId: c.id, customer: c, lines: linesOf(id), totalCases: 12, totalWeightKg: 120, priority: 2, salesValue: null, marginValue: null, isLate: false,
  status: 'ASSIGNED', notes: null, depotId: 'D1', deliveryDate: DAY, uploadedAt: new Date('2026-10-23T09:00:00Z'), ...over,
});
function planLoad(id: string, truckId: string, loadNo: number, status: string) {
  return {
    id, tenantId: T, runId: 'P', truckId, loadNo, status, driverId: null, departMin: 420 + (loadNo - 1) * 480, returnMin: 600 + (loadNo - 1) * 480, distanceKm: 10, durationMin: 180,
    cases: 12, weightKg: 120, utilizationPct: 2, fuelLitres: null, fuelCost: 1, operatingCost: 5, returnLegKm: 2, distanceIsEstimated: true, carriedFromLoadId: null,
    truckSnapshotJson: truckSnap(truckId === 't5' ? 'T05' : 'T06'), statusChangedAt: null, statusChangedById: null, createdAt: new Date(),
  };
}
function assignment(id: string, loadId: string, truckId: string, orderId: string, c: ReturnType<typeof customer>, startMin: number) {
  return {
    id, runId: 'P', truckId, orderId, sequenceInTruck: 1, plannedArrivalMin: 20, plannedDistanceFromPrevKm: 5, plannedLoadCases: 12, lockedByUserId: null,
    manualOverrideReason: null, loadId, loadNo: 1, orderInStop: 0, etaMin: startMin, serviceStartMin: startMin, departureMin: startMin + 18, waitMin: 0,
    cumulativeKm: 5, hardWindowOk: true, prefWindowOk: true, portionCases: null, portionWeightKg: null, portionLinesJson: null, stopSnapshotJson: stopSnapOf(c),
  };
}

/** Plan P of 24 Oct: T05 L1 (C001) and T05 L2 (C007) LOCKED, T06 L1 (C003) PLANNED; C007 unloads at 15:00 within 15:00-18:00. */
function seed() {
  const c1 = customer('c1', 'C001', { hardWindowStartMin: 420, hardWindowEndMin: 720 });
  const c7 = customer('c7', 'C007');
  const c3 = customer('c3', 'C003', { hardWindowStartMin: 420, hardWindowEndMin: 720 });
  tables.depot = [{ id: 'D1', tenantId: T, code: 'D1', name: 'Depot', active: true, lat: 23.58, lng: 58.39, openMin: 0, closeMin: 1440 }];
  tables.truck = [
    { id: 't5', tenantId: T, code: 'T05', defaultDriverId: null, capacityCases: 600, capacityWeightKg: 0, bays: 12, active: true },
    { id: 't6', tenantId: T, code: 'T06', defaultDriverId: null, capacityCases: 600, capacityWeightKg: 0, bays: 12, active: true },
  ];
  tables.customer = [c1, c7, c3];
  tables.order = [order('o1', c1), order('o7', c7), order('o3', c3)];
  tables.runPlan = [{
    id: 'P', tenantId: T, depotId: 'D1', runDate: DAY, status: 'READY', version: 1, reason: 'INITIAL', optimizationMode: 'BALANCED', chosenScenarioId: 'sc1', parentRunId: null,
    supersededAt: null, currentJobId: null, finalizedAt: null, totalOrders: 3, unservedCount: 0, summaryJson: null, reconciliationJson: { ok: true }, changeSummaryJson: null,
    feasibilityJson: null, createdById: 'u1', createdAt: new Date(),
  }];
  tables.planLoad = [planLoad('L1', 't5', 1, 'LOCKED'), planLoad('L2', 't5', 2, 'LOCKED'), planLoad('M1', 't6', 1, 'PLANNED')];
  tables.routeAssignment = [assignment('A1', 'L1', 't5', 'o1', c1, 480), assignment('A7', 'L2', 't5', 'o7', c7, 900), assignment('A3', 'M1', 't6', 'o3', c3, 480)];
  tables.scenarioResult = [{
    id: 'sc1', runId: 'P', name: 'RECOMMENDED', trucksUsed: 2, totalDistanceKm: 20, totalTimeMin: 200, totalCost: 40, avgUtilizationPct: 2, unservedCount: 0, createdAt: new Date(),
    detailsJson: {
      name: 'RECOMMENDED', status: 'OPTIMIZED', solver_status: 'ROUTING_SUCCESS', solver_time_sec: 1, trucks_used: 2, trips: 1, total_distance_km: 20, total_duration_min: 200,
      operating_cost: 40, avg_utilization_pct: 2, loads: [], unserved: [], warnings: [], objective: null, engine: 'OR-Tools', matrix_provider: 'HAVERSINE', distance_is_estimated: true,
      response_warnings: [], scope: { orderIds: ['o3'], frozenOrderIds: ['o1', 'o7'], orderPriority: {}, frozenLoadIds: ['L1', 'L2'], frozenLoadOrderIds: [] },
      feasibility: { status: 'VERIFIED', timing: 'EXACT', violations: [] },
    },
  }];
  tables.unservedOrder = [];
  tables.runJob = [];
  tables.auditLog = [];
  tables.driver = [];
  tables.stopEvent = [];
  tables.tenantConfig = [{ id: 'cfg', tenantId: T, defaultServiceTimeMin: 10, timezone: 'Asia/Muscat' }];
  tables.customerTypeProfile = [];
}

const hoursOf = (d: Awaited<ReturnType<typeof getPlanDetail>>, loadId: string) => d!.loads.find((l) => l.id === loadId)!.stops[0]!.masterChanged.filter((c) => c.kind === 'HOURS');

beforeEach(() => {
  resetDb();
  delete process.env.KEPT_CHANGES;
});
afterEach(() => {
  delete process.env.KEPT_CHANGES;
});

describe('the loader, the plan screen and the unlock on the in-memory database', () => {
  it("C007's hours widened after T05 L2 was locked: listed with its unlock; the plan screen's report and its stop note agree (review W3)", async () => {
    seed();
    row('customer', 'c7').hardWindowStartMin = 480;
    const report = await keptChangesOf(fakePrisma as never, T, 'P', { now: NOW });
    expect(report!.loads.map((l) => [l.label, l.worst, l.unlock.loads.map((x) => x.label)])).toEqual([['T05 L2', 'STILL_OK', ['T05 L2']]]);
    expect(report!.loads[0]!.stops[0]!.changes).toEqual([expect.objectContaining({ kind: 'HOURS', planned: '15:00–18:00', now: '08:00–18:00', widened: true })]);
    const d = await getPlanDetail(T, 'P', { now: NOW }, { kept: true });
    expect(d!.kept).toEqual(report);
    // One rule: the stop note of every kept stop says "hours changed" exactly when the report lists hours.
    for (const l of d!.loads.filter((x) => x.status !== 'PLANNED')) {
      const listed = !!report!.loads.find((k) => k.loadId === l.id)?.stops.some((s) => s.changes.some((c) => c.kind === 'HOURS'));
      expect([l.id, hoursOf(d, l.id).length > 0]).toEqual([l.id, listed]);
    }
    // Not asked for (the driver and salesman pages): no report, no extra reads.
    expect((await getPlanDetail(T, 'P', { now: NOW }))!.kept).toBeUndefined();
  });

  it('review W3: a new order of C007 with a promised time, on a PLANNED load, is another visit - neither the note nor the report reads it as the kept stop\'s hours', async () => {
    seed();
    const c7 = row('customer', 'c7');
    tables.order.push(order('o9', c7 as never, { uploadedAt: new Date('2026-10-23T15:00:00Z'), deliveryStartMin: 600, deliveryEndMin: 660, deliveryTimeReason: 'PROMISED' }));
    tables.routeAssignment.push({ ...assignment('A9', 'M1', 't6', 'o9', c7 as never, 600), sequenceInTruck: 2, stopSnapshotJson: { ...stopSnapOf(c7 as never), capturedAt: '2026-10-23T16:00:00.000Z', hardStartMin: 600, hardEndMin: 660, promised: { startMin: 600, endMin: 660, reason: 'PROMISED', note: null } } });
    const d = await getPlanDetail(T, 'P', { now: NOW }, { kept: true });
    expect(hoursOf(d, 'L2')).toEqual([]);
    const changes = d!.kept!.loads.find((l) => l.loadId === 'L2')!.stops[0]!.changes;
    expect(changes.map((c) => c.kind)).toEqual(['NEW_ORDER']);
    expect(changes[0]!.text).toContain('on T06 L1 (planned)');
  });

  it('review W-4: C007 planned at a point that was not usable, a new pin placed since: BREAKS in the report, and Loading is refused (STOP_PIN_REPLACED) - they agree', async () => {
    seed();
    Object.assign(row('customer', 'c7'), { lat: 23.64, lng: 58.44, locationVerified: true, geocodeConfidence: 'HIGH' });
    // Without a recorded change: an ordinary correction (the planned point was usable) - a CHECK, Loading goes on.
    const plain = await keptChangesOf(fakePrisma as never, T, 'P', { now: NOW });
    expect(plain!.loads[0]!.stops[0]!.changes).toEqual([expect.objectContaining({ kind: 'LOCATION', effect: 'CHECK' })]);
    // The change that moved C007 off its planned point while that point was flagged LOW.
    tables.auditLog.push({
      id: 'AU1', tenantId: T, userId: 'u1', action: 'CUSTOMER_LOCATION_SET', entity: 'Customer', entityId: 'c7', createdAt: new Date('2026-10-23T14:00:00Z'),
      beforeJson: { lat: 23.6, lng: 58.4, verified: false, confidence: 'LOW' }, afterJson: { lat: 23.64, lng: 58.44, source: 'MAP_PIN', confidence: 'HIGH' },
    });
    const report = await keptChangesOf(fakePrisma as never, T, 'P', { now: NOW });
    const l2 = report!.loads.find((l) => l.loadId === 'L2')!;
    expect(l2.worst).toBe('BREAKS');
    expect(l2.stops[0]!.changes).toEqual([expect.objectContaining({ kind: 'LOCATION', effect: 'BREAKS' })]);
    expect(l2.stops[0]!.changes[0]!.text).toContain('which was not usable when the new pin replaced it');
    await expect(updateLoad(T, 'P', 'L2', { status: 'LOADING' }, user, allow, { now: NOW })).rejects.toMatchObject({ status: 409, details: { code: 'STOP_PIN_REPLACED' } });
  });

  it('a DISPATCHED load is never listed; a superseded or optimizing version, or a day that is over, has no report', async () => {
    seed();
    row('customer', 'c7').hardWindowStartMin = 480;
    row('planLoad', 'L1').status = 'DISPATCHED';
    row('planLoad', 'L2').status = 'DISPATCHED';
    expect((await keptChangesOf(fakePrisma as never, T, 'P', { now: NOW }))!.loads).toEqual([]);
    row('planLoad', 'L2').status = 'LOCKED';
    expect(await keptChangesOf(fakePrisma as never, T, 'P', { now: new Date('2026-10-25T06:00:00Z') })).toBeNull();
    expect(await keptChangesOf(fakePrisma as never, 'tB', 'P', { now: NOW })).toBeNull();
    row('runPlan', 'P').status = 'OPTIMIZING';
    expect(await keptChangesOf(fakePrisma as never, T, 'P', { now: NOW })).toBeNull();
    row('runPlan', 'P').status = 'SUPERSEDED';
    expect(await keptChangesOf(fakePrisma as never, T, 'P', { now: NOW })).toBeNull();
  });

  it('review W2: the unlock from the warning records what changed on its LOAD_PLANNED row, read before the load moved', async () => {
    seed();
    row('customer', 'c7').hardWindowStartMin = 480;
    await updateLoad(T, 'P', 'L2', { status: 'PLANNED', via: 'KEPT_DATA_CHANGED' }, user, allow, { now: NOW });
    expect(row('planLoad', 'L2').status).toBe('PLANNED');
    const a = tables.auditLog.find((x) => x.action === 'LOAD_PLANNED')!;
    expect(a.afterJson).toMatchObject({
      status: 'PLANNED',
      via: 'KEPT_DATA_CHANGED',
      keptChanges: [{ load: 'T05 L2', status: 'LOCKED', customer: 'C007', kinds: ['HOURS'], effect: 'STILL_OK', planned: '15:00–18:00', now: '08:00–18:00' }],
    });
    // Back to Planned, the stop is the day's "out of date" work now, never the kept list.
    expect((await keptChangesOf(fakePrisma as never, T, 'P', { now: NOW }))!.loads).toEqual([]);
  });

  it('an unlock without `via`, or with KEPT_CHANGES=off, writes the row as before; an unlock out of order is refused and changes nothing', async () => {
    seed();
    row('customer', 'c7').hardWindowStartMin = 480;
    await expect(updateLoad(T, 'P', 'L1', { status: 'PLANNED', via: 'KEPT_DATA_CHANGED' }, user, allow, { now: NOW })).rejects.toMatchObject({ status: 409, message: 'Unlock Load 2 of this truck first.' });
    expect(row('planLoad', 'L1').status).toBe('LOCKED');
    expect(tables.auditLog).toEqual([]);
    await updateLoad(T, 'P', 'L2', { status: 'PLANNED' }, user, allow, { now: NOW });
    expect(tables.auditLog.at(-1)!.afterJson).not.toHaveProperty('keptChanges');
    process.env.KEPT_CHANGES = 'off';
    await updateLoad(T, 'P', 'L1', { status: 'PLANNED', via: 'KEPT_DATA_CHANGED' }, user, allow, { now: NOW });
    expect(tables.auditLog.at(-1)!.afterJson).not.toHaveProperty('via');
  });

  it('KEPT_CHANGES=off: no report anywhere (the plan screen answers as before)', async () => {
    seed();
    row('customer', 'c7').hardWindowStartMin = 480;
    process.env.KEPT_CHANGES = 'off';
    expect(await keptChangesOf(fakePrisma as never, T, 'P', { now: NOW })).toBeNull();
    expect((await getPlanDetail(T, 'P', { now: NOW }, { kept: true }))!.kept).toBeNull();
    // The stop note is the plan screen's own and stays.
    expect(hoursOf(await getPlanDetail(T, 'P', { now: NOW }), 'L2')).toHaveLength(1);
  });

  it("review S2: KEPT_CHANGES=off also takes back the kept stop's hours rule (W3) - the note reads as before the warning", async () => {
    seed();
    const c7 = row('customer', 'c7');
    tables.order.push(order('o9', c7 as never, { uploadedAt: new Date('2026-10-23T15:00:00Z'), deliveryStartMin: 600, deliveryEndMin: 660, deliveryTimeReason: 'PROMISED' }));
    tables.routeAssignment.push({ ...assignment('A9', 'M1', 't6', 'o9', c7 as never, 600), sequenceInTruck: 2, stopSnapshotJson: { ...stopSnapOf(c7 as never), capturedAt: '2026-10-23T16:00:00.000Z', hardStartMin: 600, hardEndMin: 660, promised: { startMin: 600, endMin: 660, reason: 'PROMISED', note: null } } });
    expect(hoursOf(await getPlanDetail(T, 'P', { now: NOW }), 'L2')).toEqual([]);
    process.env.KEPT_CHANGES = 'off';
    // As on main: the new order's promised time reads as the locked stop's hours.
    expect(hoursOf(await getPlanDetail(T, 'P', { now: NOW }), 'L2')).not.toEqual([]);
  });
});
