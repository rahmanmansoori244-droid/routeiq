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
import { dateOnly, isoOf } from '../dispatch/time';
import {
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
}

/** The columns the store writes on a raise, an escalation, an update or a reopen. */
export interface AlertFields {
  kind?: AlertKind;
  severity?: AlertSeverity;
  tier?: number;
  value?: number;
  threshold?: number;
  text?: string;
  truckCode?: string;
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
  /** The first date of the sweep's window (yesterday): open CONDITION rows of older dates close as EXPIRED. */
  windowFrom: string;
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
      const f = fieldsOf(c, now);
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
        text: c.text,
        factsJson: f.factsJson ?? null,
        mayToast: f.mayToast!,
        mayEmail: f.mayEmail!,
        occurredAt: c.occurredAt,
        firstSeenAt: now,
        lastSeenAt: now,
        resolvedAt: c.history ? now : null,
        resolvedReason: c.history ? 'ENDED' : null,
      });
      if (c.history) plan.counts.history++;
      else plan.counts.raised++;
      continue;
    }
    if (row.resolvedAt) {
      if (c.history) continue; // a history row never reopens, and a closed row is never rewritten as history
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
    if (c.tier > row.tier) {
      plan.escalations.push({ id: row.id, tier: c.tier, data: { ...fieldsOf(c, now), ackedAt: null, ackedById: null } });
      plan.counts.escalated++;
      continue;
    }
    const moved = Math.abs(Math.round(c.value) - row.value) >= ALERT_VALUE_STEP;
    if (moved || wordsOf(c.text) !== wordsOf(row.text) || c.kind !== row.kind || c.truckCode !== row.truckCode) {
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

  // Rows nobody answered for: their rule is off, their date left the window, or their subject left the plan.
  const on = new Set<string>(ctx.rulesOn);
  const scopes = new Set(ev.scopes.map((s) => `${s.depotId}|${s.deliveryDate}`));
  const closed = (row: StoredAlert, reason: ResolvedReason) => resolve(row, reason, `${row.text} (${RESOLVED_REASON_TEXT[reason].toLowerCase()})`);
  for (const row of rows) {
    if (row.resolvedAt || touched.has(keyOf(row.rule, row.subjectKey))) continue;
    if (!on.has(row.rule)) closed(row, 'RULE_OFF');
    // Events too (M7): an event of a date the sweep no longer reads is history, acknowledged or not.
    else if (row.deliveryDate < ctx.windowFrom) closed(row, 'EXPIRED');
    else if (row.kind === 'CONDITION' && scopes.has(`${row.depotId}|${row.deliveryDate}`)) closed(row, 'NOT_IN_PLAN');
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
}): StoredAlert {
  return {
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
  };
}

/** The columns facts.ts reads of the rows already there. */
export const STORED_SELECT = { id: true, rule: true, subjectKey: true, kind: true, tier: true, value: true, text: true, truckCode: true, depotId: true, deliveryDate: true, resolvedAt: true, resolvedReason: true } as const;

// ---------------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------------

/**
 * Rows of a delivery date before `cutoffIso` (the company's today - ALERT_RETENTION_DAYS) and e-mail
 * digests older than `digestCutoff` are deleted (they hold customer names and shortened driver notes).
 */
export async function purgeOldAlertRows(db: Tx, tenantId: string, cutoffIso: string, digestCutoff: Date): Promise<{ alerts: number; digests: number }> {
  const alerts = (await db.opsAlert.deleteMany({ where: { tenantId, deliveryDate: { lt: dateOnly(cutoffIso) } } })).count;
  const digests = (await db.opsAlertDigest.deleteMany({ where: { tenantId, createdAt: { lt: digestCutoff } } })).count;
  return { alerts, digests };
}
