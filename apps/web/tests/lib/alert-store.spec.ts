/**
 * Operations alerts (owner request 16 Oct 2026): the store (lib/alerts/store.ts) and the company's alert
 * lock (lib/alerts/locks.ts). planApply is pure: an idempotent raise, escalation only upward (clearing the
 * acknowledgement), fewer writes for small changes, reopening (acknowledgement and e-mail state cleared),
 * no backlog before the switch-on, history rows, event rows open until acknowledged or corrected (H4),
 * and closing only what the sweep read in full: NOT_IN_PLAN, EXPIRED, RULE_OFF (H2). The reviews of
 * 16 Oct 2026: no backlog per rule either (a rule switched on later or set to catch more; a RULE_OFF row
 * reopens only for a new episode: H2), events expire with their date (M7), a re-plan's copy keeps its acknowledgement and
 * e-mail state (L3), "no longer followed" is not "over". applyPlan guards every write in SQL and names the
 * company in each. Synthetic rows; invented names.
 */
import { describe, expect, it } from 'vitest';
import { alertsLockKey, lockTenantAlerts, tryLockTenantAlerts } from '@/lib/alerts/locks';
import { ALERT_RULES, subjectKeyOf, type AlertRule } from '@/lib/alerts/catalog';
import { applyPlan, applyPlanInMemory, planApply, storedOf, type MemAlert, type PlanContext, type StoredAlert } from '@/lib/alerts/store';
import { alertStateOf, needsAttention, type Candidate, type Evaluation } from '@/lib/alerts/types';
import { alertDates } from '@/lib/alerts/facts';

const NOW = new Date('2026-10-20T06:00:00Z');
const ON = new Date('2026-10-20T03:00:00Z');
const D = '2026-10-20';
const KEY = subjectKeyOf({ depotId: 'D1', date: D, truckId: 'TR1', loadNo: 1 });
const STOP = subjectKeyOf({ depotId: 'D1', date: D, truckId: 'TR1', loadNo: 1, sequence: 2 });
const CTX: PlanContext = { now: NOW, alertsEnabledAt: ON, windowFrom: '2026-10-19', today: D, rulesOn: [...ALERT_RULES] };

function cand(over: Partial<Candidate> = {}): Candidate {
  return {
    rule: 'ETA_LATE',
    kind: 'CONDITION',
    subjectKey: KEY,
    depotId: 'D1',
    deliveryDate: D,
    truckId: 'TR1',
    truckCode: 'T05',
    loadNo: 1,
    sequence: null,
    customerId: null,
    tier: 1,
    value: 35,
    threshold: 30,
    text: 'T05 L1 is running about 35 min late: next stop 2 Shop Example B (C200).',
    occurredAt: new Date('2026-10-20T05:00:00Z'),
    ...over,
  };
}

function row(over: Partial<StoredAlert> = {}): StoredAlert {
  return { id: 'a1', rule: 'ETA_LATE', subjectKey: KEY, kind: 'CONDITION', tier: 1, value: 35, text: cand().text, truckCode: 'T05', depotId: 'D1', deliveryDate: D, resolvedAt: null, ...over };
}

const ev = (over: Partial<Evaluation> = {}): Evaluation => ({ active: [], ended: [], scopes: [{ depotId: 'D1', deliveryDate: D, rulesOn: [...ALERT_RULES] }], ...over });

describe('planApply: raising', () => {
  it('a new subject: one row, open, with its tier, severity and delivery; nothing to write the second time', () => {
    const p = planApply([], ev({ active: [cand()] }), CTX);
    expect(p.creates).toHaveLength(1);
    expect(p.creates[0]).toMatchObject({ rule: 'ETA_LATE', subjectKey: KEY, kind: 'CONDITION', severity: 'WARN', tier: 1, value: 35, resolvedAt: null, mayToast: true, mayEmail: true, firstSeenAt: NOW, lastSeenAt: NOW });
    expect(p.counts).toMatchObject({ raised: 1, history: 0 });
    // The same candidate twice in one evaluation: one row.
    expect(planApply([], ev({ active: [cand(), cand()] }), CTX).creates).toHaveLength(1);
    // The next sweep: the row is there and nothing moved.
    const again = planApply([row()], ev({ active: [cand({ value: 37, text: cand().text.replace('35', '37') })] }), CTX);
    expect(again.creates).toEqual([]);
    expect(again.updates).toEqual([]);
  });

  it('no backlog: a condition that began before alerts were switched on raises nothing (and does not reopen a row)', () => {
    const old = cand({ occurredAt: new Date('2026-10-20T02:59:00Z') });
    const p = planApply([], ev({ active: [old] }), CTX);
    expect(p.creates).toEqual([]);
    expect(p.counts.backlog).toBe(1);
    expect(planApply([row({ resolvedAt: NOW })], ev({ active: [old] }), CTX).reopens).toEqual([]);
    // Never switched on in this sense (no time): raised.
    expect(planApply([], ev({ active: [old] }), { ...CTX, alertsEnabledAt: null }).creates).toHaveLength(1);
  });

  it('a history candidate is written already closed and never toasts or e-mails; it never reopens or rewrites a closed row', () => {
    const h = cand({ rule: 'DEPART_LATE', history: true, tier: 2 });
    const p = planApply([], ev({ active: [h] }), CTX);
    expect(p.creates[0]).toMatchObject({ resolvedAt: NOW, resolvedReason: 'ENDED', mayToast: false, mayEmail: false, severity: 'HIGH' });
    expect(p.counts).toMatchObject({ raised: 0, history: 1 });
    const closed = row({ rule: 'DEPART_LATE', resolvedAt: NOW });
    const q = planApply([closed], ev({ active: [h] }), CTX);
    expect([q.creates, q.reopens, q.updates, q.escalations]).toEqual([[], [], [], []]);
  });

  it('a history candidate on an open row closes it with the final words', () => {
    const p = planApply([row({ rule: 'UNLOAD_OVER', subjectKey: STOP })], ev({ active: [cand({ rule: 'UNLOAD_OVER', subjectKey: STOP, history: true, text: 'took 1 h 10 min' })] }), CTX);
    expect(p.resolves).toEqual([{ id: 'a1', reason: 'ENDED', text: 'took 1 h 10 min' }]);
  });

  it('unloading tier 1 stays in RouteIQ (no toast, no e-mail); tier 2 may; a delivered-with-note never toasts', () => {
    expect(planApply([], ev({ active: [cand({ rule: 'UNLOAD_OVER', subjectKey: STOP })] }), CTX).creates[0]).toMatchObject({ mayToast: false, mayEmail: false });
    expect(planApply([], ev({ active: [cand({ rule: 'UNLOAD_OVER', subjectKey: STOP, tier: 2 })] }), CTX).creates[0]).toMatchObject({ mayToast: true, mayEmail: true, severity: 'HIGH' });
    expect(planApply([], ev({ active: [cand({ rule: 'DELIVERED_WITH_NOTE', kind: 'EVENT', subjectKey: STOP })] }), CTX).creates[0]).toMatchObject({ mayToast: false, mayEmail: true });
  });
});

describe('planApply: escalation, updates and reopening', () => {
  it('a higher tier escalates and clears the acknowledgement; only `tier < new tier` rows are touched', () => {
    const p = planApply([row()], ev({ active: [cand({ tier: 2, value: 65 })] }), CTX);
    expect(p.escalations).toEqual([{ id: 'a1', tier: 2, data: expect.objectContaining({ tier: 2, severity: 'HIGH', value: 65, ackedAt: null, ackedById: null, lastSeenAt: NOW }) }]);
    expect(p.counts.escalated).toBe(1);
  });

  it('tiers never go down while open: a lower tier updates the words only, never the tier or severity', () => {
    const p = planApply([row({ tier: 3, value: 100, text: 'about 100 min late' })], ev({ active: [cand({ tier: 1, value: 40, text: 'about 40 min late' })] }), CTX);
    expect(p.escalations).toEqual([]);
    expect(p.updates).toHaveLength(1);
    expect(p.updates[0]!.data).not.toHaveProperty('tier');
    expect(p.updates[0]!.data).not.toHaveProperty('severity');
    expect(p.updates[0]!.data).toMatchObject({ value: 40, text: 'about 40 min late' });
  });

  it('fewer writes: a value that moved less than 5 with the same words is not written; other words are', () => {
    expect(planApply([row()], ev({ active: [cand({ value: 39, text: cand().text.replace('35', '39') })] }), CTX).updates).toEqual([]);
    expect(planApply([row()], ev({ active: [cand({ value: 40, text: cand().text.replace('35', '40') })] }), CTX).updates).toHaveLength(1);
    expect(planApply([row()], ev({ active: [cand({ text: 'T05 L1 is running about 35 min late: next stop 3 Shop Example C (C300).' })] }), CTX).updates).toHaveLength(1);
  });

  it('a closed row whose subject is true again reopens: acknowledgement and e-mail state cleared', () => {
    const p = planApply([row({ resolvedAt: new Date('2026-10-20T05:30:00Z') })], ev({ active: [cand({ rule: 'ETA_LATE', tier: 1 })] }), CTX);
    expect(p.reopens).toEqual([
      {
        id: 'a1',
        data: expect.objectContaining({ resolvedAt: null, resolvedReason: null, ackedAt: null, ackedById: null, emailedTier: 0, emailAttempts: 0, emailError: null, tier: 1, lastSeenAt: NOW }),
      },
    ]);
    expect(p.counts.reopened).toBe(1);
  });

  it('review H2: a row closed because its rule was switched off does not reopen for what was already true; a new episode does', () => {
    const off = row({ resolvedAt: new Date('2026-10-20T05:30:00Z'), resolvedReason: 'RULE_OFF' });
    const p = planApply([off], ev({ active: [cand({ occurredAt: new Date('2026-10-20T05:00:00Z') })] }), CTX);
    expect(p.reopens).toEqual([]);
    expect(p.counts.backlog).toBe(1);
    // Began after the rule was switched off (and after its switch-on again): news.
    expect(planApply([off], ev({ active: [cand({ occurredAt: new Date('2026-10-20T05:50:00Z') })] }), CTX).reopens).toHaveLength(1);
    // ...unless it began before the rule's own switch-on time.
    expect(planApply([off], ev({ active: [cand({ occurredAt: new Date('2026-10-20T05:50:00Z') })] }), { ...CTX, ruleOnAt: { ETA_LATE: new Date('2026-10-20T05:55:00Z') } }).reopens).toEqual([]);
  });

  it('review H2: no backlog per rule - a rule switched on (or set to catch more) after the master switch raises nothing that began before', () => {
    const ruleOn = new Date('2026-10-20T05:30:00Z');
    const before = cand({ rule: 'PROOF_FAR', kind: 'EVENT', subjectKey: STOP, occurredAt: new Date('2026-10-20T04:00:00Z') });
    const after = cand({ rule: 'PROOF_FAR', kind: 'EVENT', subjectKey: STOP, occurredAt: new Date('2026-10-20T05:31:00Z') });
    const ctx = { ...CTX, ruleOnAt: { PROOF_FAR: ruleOn } };
    expect(planApply([], ev({ active: [before] }), ctx)).toMatchObject({ creates: [], counts: { backlog: 1 } });
    expect(planApply([], ev({ active: [after] }), ctx).creates).toHaveLength(1);
    // Another rule keeps the master switch's time.
    expect(planApply([], ev({ active: [cand({ occurredAt: new Date('2026-10-20T04:00:00Z') })] }), ctx).creates).toHaveLength(1);
    // A closed row of that rule does not reopen with something older either.
    expect(planApply([row({ rule: 'PROOF_FAR', kind: 'EVENT', subjectKey: STOP, resolvedAt: NOW, resolvedReason: 'CORRECTED' })], ev({ active: [before] }), ctx).reopens).toEqual([]);
  });

  it('review L3: a re-plan\'s copy (closed NOT_IN_PLAN a moment ago) comes back with its acknowledgement and e-mail state, unless it is worse', () => {
    const replanned = row({ tier: 2, resolvedAt: new Date('2026-10-20T05:50:00Z'), resolvedReason: 'NOT_IN_PLAN' });
    const same = planApply([replanned], ev({ active: [cand({ tier: 2, value: 65 })] }), CTX).reopens[0]!.data;
    expect(same).toMatchObject({ resolvedAt: null, resolvedReason: null, tier: 2 });
    for (const k of ['ackedAt', 'ackedById', 'emailedTier', 'emailAttempts', 'emailError']) expect(same, k).not.toHaveProperty(k);
    const worse = planApply([replanned], ev({ active: [cand({ tier: 3, value: 95 })] }), CTX).reopens[0]!.data;
    expect(worse).toMatchObject({ ackedAt: null, ackedById: null });
    expect(worse).not.toHaveProperty('emailedTier');
    // Closed NOT_IN_PLAN long ago (more than 12 h): a fresh alert again.
    const long = planApply([row({ resolvedAt: new Date('2026-10-19T12:00:00Z'), resolvedReason: 'NOT_IN_PLAN' })], ev({ active: [cand()] }), CTX).reopens[0]!.data;
    expect(long).toMatchObject({ ackedAt: null, emailedTier: 0 });
    // In memory (the replay): the acknowledgement stays.
    const mem: MemAlert[] = [];
    applyPlanInMemory(mem, planApply([], ev({ active: [cand({ tier: 2 })] }), CTX), NOW);
    mem[0]!.ackedAt = NOW;
    mem[0]!.emailedTier = 2;
    applyPlanInMemory(mem, planApply(mem.map(storedOf), ev(), CTX), NOW);
    expect(mem[0]).toMatchObject({ resolvedReason: 'NOT_IN_PLAN' });
    applyPlanInMemory(mem, planApply(mem.map(storedOf), ev({ active: [cand({ tier: 2 })] }), CTX), NOW);
    expect(mem[0]).toMatchObject({ resolvedAt: null, ackedAt: NOW, emailedTier: 2, occurrences: 2 });
  });

  it('H4: an event that happens again after a correction reopens its row too', () => {
    const corrected = row({ rule: 'PRIORITY_NOT_DELIVERED', subjectKey: STOP, kind: 'EVENT', tier: 2, resolvedAt: NOW });
    const p = planApply([corrected], ev({ active: [cand({ rule: 'PRIORITY_NOT_DELIVERED', kind: 'EVENT', subjectKey: STOP, tier: 2 })] }), CTX);
    expect(p.reopens).toHaveLength(1);
  });
});

describe('planApply: closing (H2, H4)', () => {
  it('ended: a condition row closes as ENDED, an event row as CORRECTED, with the rule\'s words; a missing or closed row: nothing', () => {
    const rows = [row(), row({ id: 'e1', rule: 'PRIORITY_NOT_DELIVERED', subjectKey: STOP, kind: 'EVENT' })];
    const p = planApply(rows, ev({ ended: [{ rule: 'ETA_LATE', subjectKey: KEY, reason: 'ENDED', text: 'back on time' }, { rule: 'PRIORITY_NOT_DELIVERED', subjectKey: STOP, reason: 'ENDED', text: 'now Delivered' }, { rule: 'DRIVER_SILENT', subjectKey: KEY, reason: 'ENDED', text: 'x' }] }), CTX);
    expect(p.resolves).toEqual([
      { id: 'a1', reason: 'ENDED', text: 'back on time' },
      { id: 'e1', reason: 'CORRECTED', text: 'now Delivered' },
    ]);
  });

  it('H2: an open condition row of a depot-day read in full that nobody answered for left the plan (re-plan, other version, Start fresh)', () => {
    const gone = row({ id: 'g1', subjectKey: subjectKeyOf({ depotId: 'D1', date: D, truckId: 'TR1', loadNo: 2 }) });
    const p = planApply([gone], ev(), CTX);
    expect(p.resolves).toEqual([{ id: 'g1', reason: 'NOT_IN_PLAN', text: `${gone.text} (no longer in the plan)` }]);
  });

  it('a row of a depot-day not read (its facts failed: no scope) stays open; so does an event row; so does a held one', () => {
    const otherDepot = row({ id: 'o1', depotId: 'D2', subjectKey: subjectKeyOf({ depotId: 'D2', date: D, truckId: 'TR2', loadNo: 1 }) });
    const event = row({ id: 'e1', rule: 'DELIVERED_WITH_NOTE', subjectKey: STOP, kind: 'EVENT' });
    const held = row({ id: 'h1' });
    const p = planApply([otherDepot, event, held], ev({ held: [{ rule: 'ETA_LATE', subjectKey: KEY }] }), CTX);
    expect(p.resolves).toEqual([]);
  });

  it('H2, M7: an open row of a date before the window closes as EXPIRED, a condition or an event (acknowledged or not)', () => {
    const old = row({ id: 'x1', deliveryDate: '2026-10-17', subjectKey: subjectKeyOf({ depotId: 'D1', date: '2026-10-17', truckId: 'TR1', loadNo: 1 }), rule: 'LOAD_NOT_CLOSED' });
    const oldEvent = row({ id: 'x2', deliveryDate: '2026-10-17', kind: 'EVENT', rule: 'PROOF_FAR', subjectKey: subjectKeyOf({ depotId: 'D1', date: '2026-10-17', truckId: 'TR1', loadNo: 1, sequence: 1 }) });
    const p = planApply([old, oldEvent], ev({ scopes: [] }), CTX);
    expect(p.resolves).toEqual([
      { id: 'x1', reason: 'EXPIRED', text: `${old.text} (date passed)` },
      { id: 'x2', reason: 'EXPIRED', text: `${oldEvent.text} (date passed)` },
    ]);
    // The acknowledgement is not touched by the close (applyPlan writes resolvedAt, the reason and the words only).
    const mem: MemAlert[] = [];
    // Raised on its own day (17 Oct), then no sweep ran until the 20th (alerts were off, say).
    applyPlanInMemory(mem, planApply([], ev({ active: [cand({ rule: 'PROOF_FAR', kind: 'EVENT', subjectKey: oldEvent.subjectKey, deliveryDate: '2026-10-17' })] }), { ...CTX, windowFrom: '2026-10-16', today: '2026-10-17' }), NOW);
    mem[0]!.ackedAt = NOW;
    applyPlanInMemory(mem, planApply(mem.map(storedOf), ev({ scopes: [] }), CTX), NOW);
    expect(mem[0]).toMatchObject({ resolvedReason: 'EXPIRED', ackedAt: NOW });
  });

  it('a rule that stopped following a subject still true closes its row as NOT_FOLLOWED (never "over" in an e-mail)', () => {
    const p = planApply([row()], ev({ ended: [{ rule: 'ETA_LATE', subjectKey: KEY, reason: 'NOT_FOLLOWED', text: 'past the planned return' }] }), CTX);
    expect(p.resolves).toEqual([{ id: 'a1', reason: 'NOT_FOLLOWED', text: 'past the planned return' }]);
  });

  it('a rule switched off closes its open rows (condition or event) as RULE_OFF', () => {
    const rulesOn = ALERT_RULES.filter((r) => r !== 'DELIVERED_WITH_NOTE' && r !== 'ETA_LATE') as AlertRule[];
    const p = planApply([row(), row({ id: 'n1', rule: 'DELIVERED_WITH_NOTE', kind: 'EVENT', subjectKey: STOP })], ev(), { ...CTX, rulesOn });
    expect(p.resolves.map((r) => [r.id, r.reason])).toEqual([
      ['a1', 'RULE_OFF'],
      ['n1', 'RULE_OFF'],
    ]);
  });
});

describe("planApply: the day's end (owner request 19 Oct 2026: alerts of yesterday looked like today's)", () => {
  // 21 Oct 00:02 in Muscat: the first sweep after the midnight that follows 20 Oct (D). 20 Oct 23:58: the last before it.
  const AFTER = new Date('2026-10-20T20:02:00Z');
  const BEFORE = new Date('2026-10-20T19:58:00Z');
  const NEXT = '2026-10-21';
  const AT_MIDNIGHT: PlanContext = { now: AFTER, alertsEnabledAt: ON, windowFrom: D, today: NEXT, rulesOn: [...ALERT_RULES] };
  const NEXT_KEY = subjectKeyOf({ depotId: 'D1', date: NEXT, truckId: 'TR1', loadNo: 1 });

  it('the first sweep after midnight closes every row of the day before still open: a condition still true, an event, a held row, one nobody answered for', () => {
    const still = row({ id: 'c1' });
    const event = row({ id: 'e1', rule: 'DELIVERED_WITH_NOTE', kind: 'EVENT', subjectKey: STOP, text: 'T05 L1 stop 2 delivered with a note.' });
    const held = row({ id: 'h1', rule: 'AFTER_CLOSING', subjectKey: STOP });
    const gone = row({ id: 'g1', subjectKey: subjectKeyOf({ depotId: 'D1', date: D, truckId: 'TR1', loadNo: 2 }) });
    // The rule still finds ETA_LATE true, and worse: no escalation, no new words, closed as it is.
    const p = planApply([still, event, held, gone], ev({ active: [cand({ tier: 2, value: 70 })], held: [{ rule: 'AFTER_CLOSING', subjectKey: STOP }] }), AT_MIDNIGHT);
    expect(p.resolves).toEqual([
      { id: 'c1', reason: 'DAY_ENDED', text: `${still.text} (day ended)` },
      { id: 'e1', reason: 'DAY_ENDED', text: `${event.text} (day ended)` },
      { id: 'h1', reason: 'DAY_ENDED', text: `${held.text} (day ended)` },
      { id: 'g1', reason: 'DAY_ENDED', text: `${gone.text} (day ended)` },
    ]);
    expect([p.escalations, p.updates, p.reopens, p.creates]).toEqual([[], [], [], []]);
    expect(p.counts.resolved).toEqual({ DAY_ENDED: 4 });
  });

  it('the acknowledgement is kept: the close writes the time, the reason and the words only', () => {
    const mem: MemAlert[] = [];
    applyPlanInMemory(mem, planApply([], ev({ active: [cand()] }), CTX), NOW);
    mem[0]!.ackedAt = NOW;
    applyPlanInMemory(mem, planApply(mem.map(storedOf), ev({ active: [cand()] }), AT_MIDNIGHT), AFTER);
    expect(mem[0]).toMatchObject({ resolvedAt: AFTER, resolvedReason: 'DAY_ENDED', ackedAt: NOW, tier: 1 });
    expect(alertStateOf(mem[0]!)).toBe('RESOLVED');
  });

  it("a rule's own final words still win in that sweep (over, corrected, no longer followed, a history row); a rule switched off stays RULE_OFF", () => {
    const rows = [row({ id: 'o1' }), row({ id: 'o2', rule: 'PRIORITY_NOT_DELIVERED', kind: 'EVENT', subjectKey: STOP }), row({ id: 'o3', rule: 'LOAD_NOT_CLOSED' }), row({ id: 'o4', rule: 'UNLOAD_OVER', subjectKey: STOP })];
    const p = planApply(
      [...rows, row({ id: 'o5', rule: 'DRIVER_SILENT' })],
      ev({
        active: [cand({ rule: 'UNLOAD_OVER', subjectKey: STOP, history: true, text: 'took 1 h 10 min' })],
        ended: [
          { rule: 'ETA_LATE', subjectKey: KEY, reason: 'ENDED', text: 'back on time 23:50' },
          { rule: 'PRIORITY_NOT_DELIVERED', subjectKey: STOP, reason: 'ENDED', text: 'now Delivered' },
          { rule: 'LOAD_NOT_CLOSED', subjectKey: KEY, reason: 'NOT_FOLLOWED', text: 'no longer followed' },
        ],
      }),
      { ...AT_MIDNIGHT, rulesOn: ALERT_RULES.filter((r) => r !== 'DRIVER_SILENT') },
    );
    expect(p.resolves.map((r) => [r.id, r.reason, r.text])).toEqual([
      ['o4', 'ENDED', 'took 1 h 10 min'],
      ['o1', 'ENDED', 'back on time 23:50'],
      ['o2', 'CORRECTED', 'now Delivered'],
      ['o3', 'NOT_FOLLOWED', 'no longer followed'],
      ['o5', 'RULE_OFF', `${row().text} (rule switched off)`],
    ]);
  });

  it('after that the day is history: a closed row of it never reopens, even worse; one found true only after midnight is written closed (no toast, no e-mail)', () => {
    const closed = row({ id: 'd1', resolvedAt: AFTER, resolvedReason: 'DAY_ENDED' });
    const ended = row({ id: 'd2', rule: 'DRIVER_SILENT', resolvedAt: BEFORE, resolvedReason: 'ENDED' });
    const later = new Date(AFTER.getTime() + 2 * 60_000);
    const p = planApply([closed, ended], ev({ active: [cand({ tier: 3, value: 95 }), cand({ rule: 'DRIVER_SILENT' })] }), { ...AT_MIDNIGHT, now: later });
    expect([p.reopens, p.escalations, p.updates, p.resolves, p.creates]).toEqual([[], [], [], [], []]);
    expect(p.counts).toMatchObject({ reopened: 0, raised: 0 });

    // A load of the day still not closed, first over its limit after midnight (R10), and a priority stop's result tapped after midnight.
    const notClosed = cand({ rule: 'LOAD_NOT_CLOSED', tier: 2, value: 130, threshold: 120, text: 'T05 L1 not closed 2 h 10 min after its planned return.', occurredAt: AFTER });
    const priority = cand({ rule: 'PRIORITY_NOT_DELIVERED', kind: 'EVENT', subjectKey: STOP, tier: 2, value: 1, threshold: 2, text: 'T05 L1 stop 2 Not delivered.', occurredAt: later });
    const q = planApply([], ev({ active: [notClosed, priority] }), { ...AT_MIDNIGHT, now: later });
    expect(q.creates).toHaveLength(2);
    for (const c of q.creates) expect(c).toMatchObject({ deliveryDate: D, resolvedAt: later, resolvedReason: 'DAY_ENDED', mayToast: false, mayEmail: false, severity: 'HIGH' });
    expect(q.creates[0]!.text).toBe('T05 L1 not closed 2 h 10 min after its planned return. (day ended)');
    expect(q.counts).toMatchObject({ raised: 0, history: 2 });
    // The next sweep: the closed rows are there; nothing more.
    const mem: MemAlert[] = [];
    applyPlanInMemory(mem, q, later);
    const r = planApply(mem.map(storedOf), ev({ active: [notClosed, priority] }), { ...AT_MIDNIGHT, now: new Date(later.getTime() + 120_000) });
    expect([r.creates, r.reopens, r.resolves, r.updates, r.escalations]).toEqual([[], [], [], [], []]);
    // A history candidate of the day keeps its own reason (ENDED, with its final words); one that began before the switch-on is still backlog.
    expect(planApply([], ev({ active: [cand({ rule: 'DEPART_LATE', history: true, tier: 2 })] }), AT_MIDNIGHT).creates[0]).toMatchObject({ resolvedReason: 'ENDED', text: cand().text });
    expect(planApply([], ev({ active: [cand({ occurredAt: new Date('2026-10-20T02:00:00Z') })] }), AT_MIDNIGHT)).toMatchObject({ creates: [], counts: { backlog: 1, history: 0 } });
  });

  it("no change for today's alerts: one minute before midnight nothing closes, and right after it the new day's rows are raised, escalated and updated as before", () => {
    const before: PlanContext = { ...CTX, now: BEFORE };
    const open = row({ id: 't1' });
    const p = planApply([open, row({ id: 't2', rule: 'PROOF_FAR', kind: 'EVENT', subjectKey: STOP })], ev({ active: [cand({ tier: 2, value: 65 })] }), before);
    expect(p.resolves).toEqual([]);
    expect(p.escalations.map((e) => e.id)).toEqual(['t1']);
    // 00:02 on the new day: its own rows behave exactly as before.
    const today = (over: Partial<Candidate> = {}) => cand({ subjectKey: NEXT_KEY, deliveryDate: NEXT, occurredAt: AFTER, ...over });
    const raised = planApply([], ev({ active: [today()], scopes: [{ depotId: 'D1', deliveryDate: NEXT, rulesOn: [...ALERT_RULES] }] }), AT_MIDNIGHT);
    expect(raised.creates[0]).toMatchObject({ deliveryDate: NEXT, resolvedAt: null, resolvedReason: null, mayToast: true, mayEmail: true, text: today().text });
    expect(raised.counts).toMatchObject({ raised: 1, history: 0 });
    const mine = row({ id: 'n1', subjectKey: NEXT_KEY, deliveryDate: NEXT });
    const worse = planApply([mine], ev({ active: [today({ tier: 2, value: 65 })] }), AT_MIDNIGHT);
    expect([worse.escalations.map((e) => e.id), worse.resolves]).toEqual([['n1'], []]);
    // A row of tomorrow is not touched either.
    const tomorrow = row({ id: 'm1', deliveryDate: '2026-10-22', subjectKey: subjectKeyOf({ depotId: 'D1', date: '2026-10-22', truckId: 'TR1', loadNo: 1 }) });
    expect(planApply([tomorrow], ev({ scopes: [] }), AT_MIDNIGHT).resolves).toEqual([]);
  });

  it("the company's midnight, not the server's: the same instant ends the day in Muscat and not yet in London", () => {
    const instant = new Date('2026-10-20T20:01:00Z');
    // Muscat (UTC+4): 21 Oct 00:01. London (summer time until 25 Oct, UTC+1): 20 Oct 21:01.
    expect(alertDates('Asia/Muscat', instant)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
    expect(alertDates('Europe/London', instant)).toEqual(['2026-10-19', '2026-10-20', '2026-10-21']);
    const ctxOf = (tz: string): PlanContext => {
      const dates = alertDates(tz, instant);
      return { now: instant, alertsEnabledAt: ON, windowFrom: dates[0]!, today: dates[1]!, rulesOn: [...ALERT_RULES] };
    };
    const open = row({ id: 'z1' });
    expect(planApply([open], ev({ active: [cand()] }), ctxOf('Asia/Muscat')).resolves.map((r) => r.reason)).toEqual(['DAY_ENDED']);
    expect(planApply([open], ev({ active: [cand()] }), ctxOf('Europe/London')).resolves).toEqual([]);
  });
});

describe('row states (H4)', () => {
  it('an event row is open until acknowledged or corrected; a closed condition row is history needing no acknowledgement', () => {
    expect(alertStateOf({ resolvedAt: null, ackedAt: null })).toBe('OPEN');
    expect(needsAttention({ resolvedAt: null, ackedAt: null })).toBe(true);
    expect(alertStateOf({ resolvedAt: null, ackedAt: NOW })).toBe('ACKED');
    expect(needsAttention({ resolvedAt: NOW, ackedAt: null })).toBe(false);
  });

  it('an acknowledged event row still true at the same tier keeps its acknowledgement (only a higher tier clears it)', () => {
    const p = planApply([row({ rule: 'PROOF_FAR', kind: 'EVENT', subjectKey: STOP })], ev({ active: [cand({ rule: 'PROOF_FAR', kind: 'EVENT', subjectKey: STOP, value: 700 })] }), CTX);
    expect(p.updates).toHaveLength(1);
    expect(p.updates[0]!.data).not.toHaveProperty('ackedAt');
  });
});

describe('applyPlanInMemory (the replay) follows the guarded writes', () => {
  it('raise, escalate, close, reopen; a duplicate create is skipped', () => {
    const rows: MemAlert[] = [];
    applyPlanInMemory(rows, planApply([], ev({ active: [cand()] }), CTX), NOW);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    r.ackedAt = NOW;
    applyPlanInMemory(rows, planApply(rows, ev({ active: [cand({ tier: 2, value: 70 })] }), CTX), NOW);
    expect(r).toMatchObject({ tier: 2, severity: 'HIGH', ackedAt: null });
    applyPlanInMemory(rows, planApply(rows, ev({ ended: [{ rule: 'ETA_LATE', subjectKey: KEY, reason: 'ENDED', text: 'back on time' }] }), CTX), NOW);
    expect(r).toMatchObject({ resolvedAt: NOW, resolvedReason: 'ENDED', text: 'back on time' });
    applyPlanInMemory(rows, planApply(rows, ev({ active: [cand()] }), CTX), NOW);
    expect(r).toMatchObject({ resolvedAt: null, occurrences: 2 });
    // A create for a key already there (another sweep won) is skipped.
    const dup = planApply([], ev({ active: [cand()] }), CTX);
    expect(applyPlanInMemory(rows, dup, NOW)).toEqual([]);
    expect(rows).toHaveLength(1);
  });
});

describe('applyPlan: every write guarded and scoped to the company', () => {
  function recorder() {
    const calls: { op: string; args: Record<string, any> }[] = [];
    const tx = {
      opsAlert: {
        createMany: async (args: Record<string, any>) => (calls.push({ op: 'createMany', args }), { count: args.data.length }),
        updateMany: async (args: Record<string, any>) => (calls.push({ op: 'updateMany', args }), { count: 1 }),
      },
    };
    return { calls, tx: tx as never };
  }

  it('inserts skip duplicates; escalations need tier < new; updates and closes need an open row; reopens a closed one (+1 occurrence)', async () => {
    const { calls, tx } = recorder();
    const rows = [row({ id: 'esc' }), row({ id: 'upd', subjectKey: STOP, rule: 'UNLOAD_OVER' }), row({ id: 'reo', rule: 'DRIVER_SILENT', resolvedAt: NOW }), row({ id: 'end', rule: 'LOAD_NOT_CLOSED' })];
    const plan = planApply(
      rows,
      ev({
        active: [
          cand({ tier: 2 }),
          cand({ rule: 'UNLOAD_OVER', subjectKey: STOP, value: 80 }),
          cand({ rule: 'DRIVER_SILENT' }),
          cand({ rule: 'AFTER_CLOSING', subjectKey: STOP }),
        ],
        ended: [{ rule: 'LOAD_NOT_CLOSED', subjectKey: KEY, reason: 'ENDED', text: 'Completed.' }],
      }),
      CTX,
    );
    const counts = await applyPlan(tx, 'tA', plan, NOW);
    expect(counts).toMatchObject({ raised: 1, escalated: 1, updated: 1, reopened: 1, resolved: { ENDED: 1 } });
    const create = calls.find((c) => c.op === 'createMany')!;
    expect(create.args.skipDuplicates).toBe(true);
    expect(create.args.data[0]).toMatchObject({ tenantId: 'tA', rule: 'AFTER_CLOSING', deliveryDate: new Date(`${D}T00:00:00.000Z`) });
    const updates = calls.filter((c) => c.op === 'updateMany').map((c) => c.args);
    expect(updates.every((u) => u.where.tenantId === 'tA')).toBe(true);
    expect(updates.find((u) => u.where.id === 'esc')!.where).toEqual({ tenantId: 'tA', id: 'esc', resolvedAt: null, tier: { lt: 2 } });
    expect(updates.find((u) => u.where.id === 'upd')!.where).toEqual({ tenantId: 'tA', id: 'upd', resolvedAt: null });
    const reo = updates.find((u) => u.where.id === 'reo')!;
    expect(reo.where).toEqual({ tenantId: 'tA', id: 'reo', resolvedAt: { not: null } });
    expect(reo.data.occurrences).toEqual({ increment: 1 });
    expect(updates.find((u) => u.where.id === 'end')).toEqual({ where: { tenantId: 'tA', id: 'end', resolvedAt: null }, data: { resolvedAt: NOW, resolvedReason: 'ENDED', text: 'Completed.' } });
  });

  it('storedOf reads a database row (the date as YYYY-MM-DD)', () => {
    expect(storedOf({ ...row(), deliveryDate: new Date(`${D}T00:00:00.000Z`) }).deliveryDate).toBe(D);
  });
});

describe('the company\'s alert lock (M4)', () => {
  it('the sweep tries it (skips the company when busy); Start fresh waits for it; one key per company', async () => {
    const seen: { sql: string; values: unknown[] }[] = [];
    const tx = {
      $queryRaw: async (s: TemplateStringsArray, ...v: unknown[]) => {
        seen.push({ sql: s.join('?').replace(/\s+/g, ' ').trim(), values: v });
        return [{ locked: seen.length === 1 }];
      },
    } as never;
    expect(await tryLockTenantAlerts(tx, 'tA')).toBe(true);
    expect(await tryLockTenantAlerts(tx, 'tA')).toBe(false);
    await lockTenantAlerts(tx, 'tA');
    expect(seen.map((x) => x.sql)).toEqual([
      'SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0)) AS locked',
      'SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0)) AS locked',
      'SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(?, 0))',
    ]);
    expect(seen.every((x) => x.values[0] === 'ops-alerts:tA')).toBe(true);
    expect(alertsLockKey('tB')).toBe('ops-alerts:tB');
  });
});
