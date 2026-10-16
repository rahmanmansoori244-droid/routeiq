/**
 * Operations alerts (owner request 16 Oct 2026): the store (lib/alerts/store.ts) and the company's alert
 * lock (lib/alerts/locks.ts). planApply is pure: an idempotent raise, escalation only upward (clearing the
 * acknowledgement), fewer writes for small changes, reopening (acknowledgement and e-mail state cleared),
 * no backlog before the switch-on, history rows, event rows open until acknowledged or corrected (H4),
 * and closing only what the sweep read in full: NOT_IN_PLAN, EXPIRED, RULE_OFF (H2). applyPlan guards
 * every write in SQL and names the company in each. Synthetic rows; invented names.
 */
import { describe, expect, it } from 'vitest';
import { alertsLockKey, lockTenantAlerts, tryLockTenantAlerts } from '@/lib/alerts/locks';
import { ALERT_RULES, subjectKeyOf, type AlertRule } from '@/lib/alerts/catalog';
import { applyPlan, applyPlanInMemory, planApply, storedOf, type MemAlert, type PlanContext, type StoredAlert } from '@/lib/alerts/store';
import { alertStateOf, needsAttention, type Candidate, type Evaluation } from '@/lib/alerts/types';

const NOW = new Date('2026-10-20T06:00:00Z');
const ON = new Date('2026-10-20T03:00:00Z');
const D = '2026-10-20';
const KEY = subjectKeyOf({ depotId: 'D1', date: D, truckId: 'TR1', loadNo: 1 });
const STOP = subjectKeyOf({ depotId: 'D1', date: D, truckId: 'TR1', loadNo: 1, sequence: 2 });
const CTX: PlanContext = { now: NOW, alertsEnabledAt: ON, windowFrom: '2026-10-19', rulesOn: [...ALERT_RULES] };

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

  it('H2: an open condition row of a date before the window closes as EXPIRED; an event row stays (until acknowledged)', () => {
    const old = row({ id: 'x1', deliveryDate: '2026-10-17', subjectKey: subjectKeyOf({ depotId: 'D1', date: '2026-10-17', truckId: 'TR1', loadNo: 1 }), rule: 'LOAD_NOT_CLOSED' });
    const oldEvent = row({ id: 'x2', deliveryDate: '2026-10-17', kind: 'EVENT', rule: 'PROOF_FAR', subjectKey: subjectKeyOf({ depotId: 'D1', date: '2026-10-17', truckId: 'TR1', loadNo: 1, sequence: 1 }) });
    const p = planApply([old, oldEvent], ev({ scopes: [] }), CTX);
    expect(p.resolves).toEqual([{ id: 'x1', reason: 'EXPIRED', text: `${old.text} (date passed)` }]);
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
