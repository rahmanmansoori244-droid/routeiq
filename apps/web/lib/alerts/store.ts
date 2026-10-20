/**
 * Operations alerts (owner request 16 Oct 2026): applying an Evaluation (rules.ts) to OpsAlert. Two
 * halves, so the e-mail-free replay (replay.ts) and the tests use exactly the sweep's semantics:
 * - planApply (pure): what to create, escalate, update, reopen and close, from the rows already there;
 * - applyPlan (server): the writes, each guarded in SQL so a stale plan changes nothing it should not
 *   (the sweep also holds the company's alert lock: locks.ts).
 *
 * Row states (types.ts alertStateOf; critique H4):
 * - CONDITION rows are open while their condition is true and close (resolvedAt) when it ends - with
 *   the rule's final words - or when their subject left the plan read in full (NOT_IN_PLAN: a re-plan,
 *   another plan version, Start fresh), their date left the sweep's window (EXPIRED) or their rule was
 *   switched off (RULE_OFF) (critique H2). One that closed before anyone looked is history: it needs no
 *   acknowledgement.
 * - EVENT rows (a fact: priority stop not delivered, delivered with a note, proof far from the pin, an
 *   arrival after closing) stay open until the fact is corrected (CORRECTED), their date leaves the
 *   sweep's window (EXPIRED, keeping who acknowledged them: review of 16 Oct 2026, M7) or their rule is
 *   switched off; acknowledged, they stay open but no longer count on the bell. An event that happens
 *   again after a correction reopens its row.
 * - History rows (Candidate.history) are written already closed, never toast or e-mail, and never reopen.
 * - The day's end (owner request 19 Oct 2026: alerts of yesterday looked like today's on the bell, "ok add
 *   the date fix"): a row whose delivery date is before the company's today (PlanContext.today) and that is
 *   still open - a condition or an event, acknowledged or not, whatever its rule says now - closes as
 *   DAY_ENDED at the first sweep after midnight, keeping who acknowledged it. Before, it stayed open (and on
 *   the bell) for the whole next day and closed only when its date left the window (EXPIRED; production
 *   closed 17 Oct's rows at 19 Oct 00:02). Only a rule that answers for it in the same sweep with its own
 *   final words (ENDED, CORRECTED, NOT_FOLLOWED, a history row) closes it otherwise, and RULE_OFF stays first
 *   for a row nobody answered for. After that the day is history: a row of it is never escalated, updated or
 *   reopened, and a subject of it found true only after midnight (a result tapped late, a late arrival) is
 *   written already closed as DAY_ENDED (no toast, no e-mail), so the Alerts page still lists it.
 *   Today's and tomorrow's rows are not touched by any of this.
 * - The day's follow-up after it ended (review of the branch, 19 Oct 2026, finding 2; catalog.ts
 *   ALERT_AFTER_DAY_RULES): LOAD_NOT_CLOSED first found true after that midnight (a load planned back at
 *   22:30 fires at 00:31 with the default 120 min) is raised OPEN, not written closed: written closed it
 *   would never reach the bell, a toast or an e-mail, and the other rules leave a late load to it. Such a
 *   row (firstSeenAt at or after PlanContext.todayStart) lives like a row of today: escalated, updated,
 *   closed by its own words or NOT_IN_PLAN, and EXPIRED when its date leaves the window at the next midnight;
 *   it never closes as DAY_ENDED. A LOAD_NOT_CLOSED row already open at midnight closes as DAY_ENDED like any.
 *
 * The rules of a raise:
 * 1. New subject: one insert (createMany skipDuplicates = ON CONFLICT DO NOTHING on tenantId, rule,
 *    subjectKey), unless it began before alerts were switched on (alertsEnabledAt), or before its own rule
 *    was switched on or set to catch more (alertRuleOnAtJson; catalog.ts switchOnOf): no backlog.
 * 2. Higher tier: escalate (tier, severity, words, delivery) and clear the acknowledgement: a higher
 *    tier is new information. Only `tier < new tier` rows are touched. Tiers never go down while open.
 * 3. Same or lower tier: the value and words are written only when the value moved by ALERT_VALUE_STEP
 *    or the words changed other than in their numbers (fewer writes).
 * 4. A closed row whose subject is true again: reopened (occurrences + 1, acknowledgement and e-mail
 *    state cleared), unless it began before the switch-on. One closed because its rule was switched off
 *    (RULE_OFF) only for something that began after it closed: switching the rule on again is not news
 *    (the rule's own switch-on time stops the rest). One closed as NOT_IN_PLAN less than
 *    ALERT_REOPEN_KEEP_MS ago (a re-plan's copy of the same load) keeps its acknowledgement and e-mail
 *    state, unless it comes back at a higher tier (review L3).
 */
import type { Prisma } from '@prisma/client';
import type { AppPrismaClient } from '../db';
import { dateOnly, isoOf } from '../dispatch/time';
import {
  ALERT_AFTER_DAY_RULES,
  ALERT_REOPEN_KEEP_MS,
  ALERT_VALUE_STEP,
  RESOLVED_REASON_TEXT,
  beforeSwitchOn,
  deliveryOf,
  severityOf,
  switchOnOf,
  type AlertKind,
  type AlertRule,
  type AlertSeverity,
  type ResolvedReason,
  type RuleOnAt,
} from './catalog';
import type { Candidate, Evaluation } from './types';

type Tx = Prisma.TransactionClient;

/** What the store reads of a row already there. */
export interface StoredAlert {
  id: string;
  rule: string;
  subjectKey: string;
  kind: string;
  tier: number;
  value: number;
  text: string;
  truckCode: string;
  depotId: string;
  /** YYYY-MM-DD */
  deliveryDate: string;
  resolvedAt: Date | null;
  /** Why it closed (null while open). */
  resolvedReason?: string | null;
  /**
   * When the row was raised (OpsAlert.firstSeenAt): a row of the day's follow-up raised after the midnight
   * that ended its day lives on (ALERT_AFTER_DAY_RULES). Absent: raised before it.
   */
  firstSeenAt?: Date | null;
  /** The customer the row names (absent: not read; the update then never compares it). */
  customerId?: string | null;
}

/**
 * The columns the store writes on a raise, an escalation, an update or a reopen. Never a cause & action column
 * (review*, owner request 20 Oct 2026): what the office recorded stays through every one of them.
 */
export interface AlertFields {
  kind?: AlertKind;
  severity?: AlertSeverity;
  tier?: number;
  value?: number;
  threshold?: number;
  text?: string;
  truckCode?: string;
  /**
   * The stop's customer now (critique of the cause & action design, item 6): a stop's row is keyed by its
   * sequence, so after a re-plan another customer can take it; the text already named the new one, and the
   * customer column (the export's Customer) now follows it. Data only: raising, closing and e-mail unchanged.
   */
  customerId?: string | null;
  factsJson?: Record<string, unknown> | null;
  mayToast?: boolean;
  mayEmail?: boolean;
  occurredAt?: Date;
  lastSeenAt?: Date;
  resolvedAt?: Date | null;
  resolvedReason?: ResolvedReason | null;
  ackedAt?: null;
  ackedById?: null;
  emailedTier?: number;
  emailAttempts?: number;
  emailError?: null;
}

/** A new row (the create of a raise or of a history row). */
export interface NewAlert {
  depotId: string;
  deliveryDate: string;
  rule: AlertRule;
  subjectKey: string;
  truckId: string;
  truckCode: string;
  loadNo: number | null;
  sequence: number | null;
  customerId: string | null;
  kind: AlertKind;
  severity: AlertSeverity;
  tier: number;
  value: number;
  threshold: number;
  text: string;
  factsJson: Record<string, unknown> | null;
  mayToast: boolean;
  mayEmail: boolean;
  occurredAt: Date;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  resolvedReason: ResolvedReason | null;
}

export interface StoreCounts {
  /** New open rows. */
  raised: number;
  /** New rows written already closed (history). */
  history: number;
  escalated: number;
  updated: number;
  reopened: number;
  /** Closed, by why. */
  resolved: Partial<Record<ResolvedReason, number>>;
  /** Candidates not raised because they began before alerts (or their rule) were switched on, or whose row closed as RULE_OFF. */
  backlog: number;
}

export interface StorePlan {
  creates: NewAlert[];
  /** Applied only where the row is open and its tier is below `tier`. */
  escalations: { id: string; tier: number; data: AlertFields }[];
  /** Applied only where the row is open. */
  updates: { id: string; data: AlertFields }[];
  /** Applied only where the row is closed; occurrences + 1. */
  reopens: { id: string; data: AlertFields }[];
  /** Applied only where the row is open. */
  resolves: { id: string; reason: ResolvedReason; text: string }[];
  counts: StoreCounts;
}

export interface PlanContext {
  now: Date;
  /** TenantConfig.alertsEnabledAt: nothing that began before it raises (or reopens) a row. */
  alertsEnabledAt: Date | null;
  /** TenantConfig.alertRuleOnAtJson read back: the same per rule (the later of the two counts). */
  ruleOnAt?: RuleOnAt | null;
  /** The first date of the sweep's window (yesterday): open rows of older dates (no sweep closed them on the night after their date) close as EXPIRED. */
  windowFrom: string;
  /**
   * The company's today (its time zone; AlertFacts.today): open rows of an earlier date close as DAY_ENDED,
   * and nothing of an earlier date is raised open, escalated, updated or reopened (owner request 19 Oct 2026).
   */
  today: string;
  /**
   * The start of the company's today (zonedDayStart(today, its time zone)): a row of ALERT_AFTER_DAY_RULES of
   * an earlier date raised at or after it was raised after its day ended and is not closed as DAY_ENDED
   * (review of the branch, 19 Oct 2026, finding 2).
   */
  todayStart: Date;
  /** The rules that are on: open rows of the others close as RULE_OFF. */
  rulesOn: readonly AlertRule[];
}

const keyOf = (rule: string, subjectKey: string) => `${rule}|${subjectKey}`;
/** The words without their numbers: "running about 45 min late" and "... 47 min late" are the same words. */
const wordsOf = (text: string) => text.replace(/\d+/g, '#');

function fieldsOf(c: Candidate, now: Date): AlertFields {
  const d = deliveryOf(c.rule, c.tier, { history: c.history });
  return {
    kind: c.kind,
    severity: severityOf(c.tier),
    tier: c.tier,
    value: Math.round(c.value),
    threshold: Math.round(c.threshold),
    text: c.text,
    truckCode: c.truckCode,
    customerId: c.customerId,
    factsJson: c.facts ?? null,
    mayToast: d.mayToast,
    mayEmail: d.mayEmail,
    lastSeenAt: now,
  };
}

/** What the evaluation changes in the rows there are (pure; see the file comment). */
export function planApply(rows: readonly StoredAlert[], ev: Evaluation, ctx: PlanContext): StorePlan {
  const { now } = ctx;
  const plan: StorePlan = { creates: [], escalations: [], updates: [], reopens: [], resolves: [], counts: { raised: 0, history: 0, escalated: 0, updated: 0, reopened: 0, resolved: {}, backlog: 0 } };
  const byKey = new Map(rows.map((r) => [keyOf(r.rule, r.subjectKey), r]));
  const touched = new Set<string>();
  const closing = new Set<string>();
  const resolve = (row: StoredAlert, reason: ResolvedReason, text: string) => {
    if (closing.has(row.id)) return;
    closing.add(row.id);
    plan.resolves.push({ id: row.id, reason, text });
    plan.counts.resolved[reason] = (plan.counts.resolved[reason] ?? 0) + 1;
  };
  const created = new Set<string>();
  const backlog = (c: { rule: AlertRule; occurredAt: Date }) => beforeSwitchOn(c.occurredAt, switchOnOf(c.rule, ctx.alertsEnabledAt, ctx.ruleOnAt));
  /** A delivery day that is over (before the company's today): its rows are history (owner request 19 Oct 2026). */
  const dayOver = (deliveryDate: string) => deliveryDate < ctx.today;
  /** The day's follow-up (LOAD_NOT_CLOSED): still raised open for a day that is over (finding 2). */
  const followsAfterDay = (rule: string) => (ALERT_AFTER_DAY_RULES as readonly string[]).includes(rule);
  /**
   * A row of a day that is over that is history: every one, except a follow-up row raised after the midnight
   * that ended its day (it lives like a row of today until its own words, NOT_IN_PLAN or EXPIRED close it).
   */
  const pastDay = (row: StoredAlert) =>
    dayOver(row.deliveryDate) && !(followsAfterDay(row.rule) && !!row.firstSeenAt && row.firstSeenAt.getTime() >= ctx.todayStart.getTime());
  const dayEndedWords = (text: string) => `${text} (${RESOLVED_REASON_TEXT.DAY_ENDED.toLowerCase()})`;

  for (const c of ev.active) {
    const k = keyOf(c.rule, c.subjectKey);
    touched.add(k);
    const row = byKey.get(k);
    if (!row) {
      if (created.has(k)) continue;
      if (backlog(c)) {
        plan.counts.backlog++;
        continue;
      }
      created.add(k);
      // A subject of a day that is over, found true only after midnight: written already closed (no toast,
      // no e-mail), so the Alerts page still lists it under its day and the bell never shows it - except the
      // day's follow-up (LOAD_NOT_CLOSED: a load planned back late still not closed), raised open (finding 2).
      const late = !c.history && dayOver(c.deliveryDate) && !followsAfterDay(c.rule);
      const closedAtOnce = !!c.history || late;
      const f = fieldsOf({ ...c, history: closedAtOnce }, now);
      plan.creates.push({
        depotId: c.depotId,
        deliveryDate: c.deliveryDate,
        rule: c.rule,
        subjectKey: c.subjectKey,
        truckId: c.truckId,
        truckCode: c.truckCode,
        loadNo: c.loadNo,
        sequence: c.sequence,
        customerId: c.customerId,
        kind: c.kind,
        severity: f.severity!,
        tier: c.tier,
        value: f.value!,
        threshold: f.threshold!,
        text: late ? dayEndedWords(c.text) : c.text,
        factsJson: f.factsJson ?? null,
        mayToast: f.mayToast!,
        mayEmail: f.mayEmail!,
        occurredAt: c.occurredAt,
        firstSeenAt: now,
        lastSeenAt: now,
        resolvedAt: closedAtOnce ? now : null,
        resolvedReason: c.history ? 'ENDED' : late ? 'DAY_ENDED' : null,
      });
      if (closedAtOnce) plan.counts.history++;
      else plan.counts.raised++;
      continue;
    }
    if (row.resolvedAt) {
      if (c.history) continue; // a history row never reopens, and a closed row is never rewritten as history
      // A day that is over never reopens (it would close again at once, and page someone in between).
      if (pastDay(row)) continue;
      // Switching a rule off and on again is not news (review H2): a row closed as RULE_OFF reopens only
      // for something that began after it closed (a new episode), never for what was already true then.
      if ((row.resolvedReason === 'RULE_OFF' && c.occurredAt.getTime() <= row.resolvedAt.getTime()) || backlog(c)) {
        plan.counts.backlog++;
        continue;
      }
      // A re-plan's copy of the same load (NOT_IN_PLAN a moment ago): the same alert, already seen and
      // e-mailed - unless it comes back worse (review L3).
      const replanned = row.resolvedReason === 'NOT_IN_PLAN' && now.getTime() - row.resolvedAt.getTime() < ALERT_REOPEN_KEEP_MS;
      const fresh: AlertFields = replanned
        ? c.tier > row.tier
          ? { ackedAt: null, ackedById: null }
          : {}
        : { ackedAt: null, ackedById: null, emailedTier: 0, emailAttempts: 0, emailError: null };
      plan.reopens.push({ id: row.id, data: { ...fieldsOf(c, now), occurredAt: c.occurredAt, resolvedAt: null, resolvedReason: null, ...fresh } });
      plan.counts.reopened++;
      continue;
    }
    // Open.
    if (c.history) {
      // The rule found it over only now (a stop that ended): the open row closes with these words.
      resolve(row, row.kind === 'EVENT' ? 'CORRECTED' : 'ENDED', c.text);
      continue;
    }
    // Still true, but its day is over: it closes as DAY_ENDED below, as it is (no escalation, no new words).
    if (pastDay(row)) continue;
    if (c.tier > row.tier) {
      plan.escalations.push({ id: row.id, tier: c.tier, data: { ...fieldsOf(c, now), ackedAt: null, ackedById: null } });
      plan.counts.escalated++;
      continue;
    }
    const moved = Math.abs(Math.round(c.value) - row.value) >= ALERT_VALUE_STEP;
    const otherCustomer = row.customerId !== undefined && (c.customerId ?? null) !== (row.customerId ?? null);
    if (moved || wordsOf(c.text) !== wordsOf(row.text) || c.kind !== row.kind || c.truckCode !== row.truckCode || otherCustomer) {
      // The tier stays (it never goes down while open), and so does the severity.
      const { tier: _t, severity: _s, mayToast: _mt, mayEmail: _me, ...rest } = fieldsOf(c, now);
      void _t;
      void _s;
      void _mt;
      void _me;
      plan.updates.push({ id: row.id, data: rest });
      plan.counts.updated++;
    }
  }

  for (const e of ev.ended) {
    const k = keyOf(e.rule, e.subjectKey);
    touched.add(k);
    const row = byKey.get(k);
    if (!row || row.resolvedAt) continue;
    resolve(row, e.reason === 'NOT_FOLLOWED' ? 'NOT_FOLLOWED' : row.kind === 'EVENT' ? 'CORRECTED' : 'ENDED', e.text);
  }
  for (const h of ev.held ?? []) touched.add(keyOf(h.rule, h.subjectKey));

  // Rows nobody answered for: their rule is off, their date left the window, their day is over, or their
  // subject left the plan. And the rows a rule still answers for (true now, or held) whose day is over.
  const on = new Set<string>(ctx.rulesOn);
  const scopes = new Set(ev.scopes.map((s) => `${s.depotId}|${s.deliveryDate}`));
  const closed = (row: StoredAlert, reason: ResolvedReason) => resolve(row, reason, `${row.text} (${RESOLVED_REASON_TEXT[reason].toLowerCase()})`);
  for (const row of rows) {
    if (row.resolvedAt || closing.has(row.id)) continue;
    const answered = touched.has(keyOf(row.rule, row.subjectKey));
    if (!answered && !on.has(row.rule)) closed(row, 'RULE_OFF');
    // Events too (M7): an event of a date the sweep no longer reads is history, acknowledged or not.
    else if (!answered && row.deliveryDate < ctx.windowFrom) closed(row, 'EXPIRED');
    // The first sweep after midnight: every row of the day before still open (owner request 19 Oct 2026),
    // not the day's follow-up raised after that midnight (finding 2).
    else if (pastDay(row)) closed(row, 'DAY_ENDED');
    else if (!answered && row.kind === 'CONDITION' && scopes.has(`${row.depotId}|${row.deliveryDate}`)) closed(row, 'NOT_IN_PLAN');
  }
  return plan;
}

/** The plan written to the database, every write guarded by the state it expects (company named in each). */
export async function applyPlan(tx: Tx, tenantId: string, plan: StorePlan, now: Date): Promise<StoreCounts> {
  const counts: StoreCounts = { raised: 0, history: 0, escalated: 0, updated: 0, reopened: 0, resolved: {}, backlog: plan.counts.backlog };
  if (plan.creates.length) {
    const r = await tx.opsAlert.createMany({ data: plan.creates.map((a) => toCreate(tenantId, a)), skipDuplicates: true });
    // Rows another process inserted first are skipped (the unique key): counted as raised by it, not here.
    const history = plan.creates.filter((a) => a.resolvedAt).length;
    counts.history = Math.min(history, r.count);
    counts.raised = Math.max(0, r.count - counts.history);
  }
  for (const e of plan.escalations) {
    counts.escalated += (await tx.opsAlert.updateMany({ where: { tenantId, id: e.id, resolvedAt: null, tier: { lt: e.tier } }, data: toData(e.data) })).count;
  }
  for (const u of plan.updates) {
    counts.updated += (await tx.opsAlert.updateMany({ where: { tenantId, id: u.id, resolvedAt: null }, data: toData(u.data) })).count;
  }
  for (const r of plan.reopens) {
    counts.reopened += (await tx.opsAlert.updateMany({ where: { tenantId, id: r.id, resolvedAt: { not: null } }, data: { ...toData(r.data), occurrences: { increment: 1 } } })).count;
  }
  for (const r of plan.resolves) {
    const n = (await tx.opsAlert.updateMany({ where: { tenantId, id: r.id, resolvedAt: null }, data: { resolvedAt: now, resolvedReason: r.reason, text: r.text } })).count;
    if (n) counts.resolved[r.reason] = (counts.resolved[r.reason] ?? 0) + n;
  }
  return counts;
}

/** Facts to write; none (null) leaves the column as it is (this module never loads the Prisma runtime: the replay uses it). */
function json(v: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | undefined {
  return v ? (v as Prisma.InputJsonValue) : undefined;
}

function toCreate(tenantId: string, a: NewAlert): Prisma.OpsAlertCreateManyInput {
  return {
    tenantId,
    depotId: a.depotId,
    deliveryDate: dateOnly(a.deliveryDate),
    rule: a.rule,
    subjectKey: a.subjectKey,
    truckId: a.truckId,
    truckCode: a.truckCode,
    loadNo: a.loadNo,
    sequence: a.sequence,
    customerId: a.customerId,
    kind: a.kind,
    severity: a.severity,
    tier: a.tier,
    value: a.value,
    threshold: a.threshold,
    text: a.text,
    ...(a.factsJson ? { factsJson: a.factsJson as Prisma.InputJsonValue } : {}),
    mayToast: a.mayToast,
    mayEmail: a.mayEmail,
    occurredAt: a.occurredAt,
    firstSeenAt: a.firstSeenAt,
    lastSeenAt: a.lastSeenAt,
    resolvedAt: a.resolvedAt,
    resolvedReason: a.resolvedReason,
  };
}

function toData(f: AlertFields): Prisma.OpsAlertUpdateManyMutationInput {
  const { factsJson, ...rest } = f;
  const fj = json(factsJson);
  return { ...rest, ...(fj !== undefined ? { factsJson: fj } : {}) } as Prisma.OpsAlertUpdateManyMutationInput;
}

// ---------------------------------------------------------------------------------------------
// The same plan applied to rows in memory (the replay and the tests)
// ---------------------------------------------------------------------------------------------

/** A row in memory: what the replay keeps of each alert (a StoredAlert too). */
export interface MemAlert extends NewAlert {
  id: string;
  ackedAt: Date | null;
  occurrences: number;
  emailedTier: number;
}

/** Applies `plan` to `rows` (mutated) exactly as applyPlan's guarded writes would; returns the new rows. */
export function applyPlanInMemory(rows: MemAlert[], plan: StorePlan, now: Date): MemAlert[] {
  const byKey = new Set(rows.map((r) => keyOf(r.rule, r.subjectKey)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const added: MemAlert[] = [];
  for (const a of plan.creates) {
    const k = keyOf(a.rule, a.subjectKey);
    if (byKey.has(k)) continue;
    byKey.add(k);
    const r: MemAlert = { ...a, id: `mem-${rows.length + 1}`, ackedAt: null, occurrences: 1, emailedTier: 0 };
    rows.push(r);
    byId.set(r.id, r);
    added.push(r);
  }
  const assign = (r: MemAlert, data: AlertFields) => {
    for (const [k, v] of Object.entries(data)) if (v !== undefined) (r as unknown as Record<string, unknown>)[k] = v;
  };
  for (const e of plan.escalations) {
    const r = byId.get(e.id);
    if (r && !r.resolvedAt && r.tier < e.tier) assign(r, e.data);
  }
  for (const u of plan.updates) {
    const r = byId.get(u.id);
    if (r && !r.resolvedAt) assign(r, u.data);
  }
  for (const o of plan.reopens) {
    const r = byId.get(o.id);
    if (r && r.resolvedAt) {
      // The acknowledgement and the e-mail state go only where the plan says so (a re-plan's copy keeps them).
      assign(r, o.data);
      r.resolvedAt = null;
      r.resolvedReason = null;
      r.occurrences += 1;
    }
  }
  for (const c of plan.resolves) {
    const r = byId.get(c.id);
    if (r && !r.resolvedAt) {
      r.resolvedAt = now;
      r.resolvedReason = c.reason;
      r.text = c.text;
    }
  }
  return added;
}

/** A row as the store reads it (from the database or from memory). */
export function storedOf(r: {
  id: string;
  rule: string;
  subjectKey: string;
  kind: string;
  tier: number;
  value: number;
  text: string;
  truckCode: string;
  depotId: string;
  deliveryDate: Date | string;
  resolvedAt: Date | null;
  resolvedReason?: string | null;
  firstSeenAt?: Date | null;
  customerId?: string | null;
}): StoredAlert {
  return {
    ...(r.customerId !== undefined ? { customerId: r.customerId } : {}),
    id: r.id,
    rule: r.rule,
    subjectKey: r.subjectKey,
    kind: r.kind,
    tier: r.tier,
    value: r.value,
    text: r.text,
    truckCode: r.truckCode,
    depotId: r.depotId,
    deliveryDate: typeof r.deliveryDate === 'string' ? r.deliveryDate : isoOf(r.deliveryDate),
    resolvedAt: r.resolvedAt,
    resolvedReason: r.resolvedReason ?? null,
    firstSeenAt: r.firstSeenAt ?? null,
  };
}

/** The columns facts.ts reads of the rows already there. */
export const STORED_SELECT = { id: true, rule: true, subjectKey: true, kind: true, tier: true, value: true, text: true, truckCode: true, depotId: true, deliveryDate: true, resolvedAt: true, resolvedReason: true, firstSeenAt: true, customerId: true } as const;

// ---------------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------------

/** What the retention did for one company. */
export interface AlertPurgeCounts {
  /** Rows deleted. */
  alerts: number;
  /** Of them, rows with a cause & action. */
  reviewed: number;
  /** Rows still open past `cutoffIso` closed as EXPIRED before their details were removed. */
  closed: number;
  /** Rows whose details were removed now. */
  detailsRemoved: number;
  /** E-mail records deleted. */
  digests: number;
}

/**
 * The alerts' retention. E-mail records older than `digestCutoff` are deleted. Alert rows of a delivery date
 * before `cutoffIso` (the company's today - ALERT_RETENTION_DAYS: they hold customer names and shortened driver
 * notes) lose them:
 * - without `keepUntilIso` (as before the cause & action, and the default: lib/jobs/delivery-janitor.ts
 *   alertRowsKeptForAnalysis): they are deleted;
 * - with `keepUntilIso` (an earlier date: the analysis data's retention, only with ALERT_KEEP_FOR_ANALYSIS=1 while
 *   the owner decides; critique of the design, items 2-4): every row is kept until then, so the share of alerts with a cause & action and the
 *   false alarms per rule can still be counted for a range older than 90 days. Its details are removed: the
 *   text becomes '', the facts only "by GPS" ({"gps":true} or NULL), the e-mail error and the cause & action's
 *   free texts (note, Other texts) NULL; the codes, numbers, times and names stay; detailsRemovedAt makes it
 *   read-only. A row still open (alerts were switched off, so no sweep closed it) is closed as EXPIRED first,
 *   so no later sweep writes its words back. Rows before `keepUntilIso` are deleted.
 * `db`: a transaction or the app's client (lib/db.ts, with the IVMS link's global omit; the retention janitor).
 */
export async function purgeOldAlertRows(
  db: Tx | AppPrismaClient,
  tenantId: string,
  cutoffIso: string,
  digestCutoff: Date,
  opts: { keepUntilIso?: string | null; now?: Date } = {},
): Promise<AlertPurgeCounts> {
  const keep = opts.keepUntilIso && opts.keepUntilIso < cutoffIso ? opts.keepUntilIso : null;
  const deleteBefore = dateOnly(keep ?? cutoffIso);
  const reviewed = await db.opsAlert.count({ where: { tenantId, deliveryDate: { lt: deleteBefore }, reviewedAt: { not: null } } });
  const alerts = (await db.opsAlert.deleteMany({ where: { tenantId, deliveryDate: { lt: deleteBefore } } })).count;
  let closed = 0;
  let detailsRemoved = 0;
  if (keep) {
    const now = opts.now ?? new Date();
    closed = (await db.opsAlert.updateMany({ where: { tenantId, deliveryDate: { lt: dateOnly(cutoffIso) }, resolvedAt: null }, data: { resolvedAt: now, resolvedReason: 'EXPIRED' } })).count;
    detailsRemoved = await db.$executeRaw`
      UPDATE "OpsAlert"
      SET "text" = '',
          "factsJson" = CASE WHEN "factsJson"->>'gps' = 'true' THEN '{"gps":true}'::jsonb ELSE NULL END,
          "emailError" = NULL,
          "reviewNote" = NULL,
          "reviewCauseOther" = NULL,
          "reviewActionOther" = NULL,
          "detailsRemovedAt" = ${now}
      WHERE "tenantId" = ${tenantId} AND "deliveryDate" < ${cutoffIso}::date AND "detailsRemovedAt" IS NULL`;
  }
  const digests = (await db.opsAlertDigest.deleteMany({ where: { tenantId, createdAt: { lt: digestCutoff } } })).count;
  return { alerts, reviewed, closed, detailsRemoved, digests };
}
