/**
 * Operations alerts (owner request 16 Oct 2026), the day-0 contract: lib/alerts/catalog.ts (the rules,
 * their defaults, bounds, tiers and delivery), lib/alerts/types.ts (row states and the API row), the
 * settings fields, and migration 20261016180000_ops_alerts (the column defaults and CHECKs repeat the
 * catalog). Names are invented (public repository).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ prisma: {} }));

import {
  ALERT_AFTER_DAY_RULES,
  ALERT_EMAIL_DEFAULTS,
  ALERT_EVIDENCE_MAX_ACCURACY_M,
  ALERT_RULE_LIST,
  ALERT_RULE_SPECS,
  ALERT_RULES,
  ALERT_THRESHOLD_BOUNDS,
  ALERT_THRESHOLD_COLUMNS,
  RETURN_GRACE_MIN,
  SEVERITY_ORDER_SQL,
  SEVERITY_RANK,
  RESOLVED_REASONS,
  RESOLVED_REASON_TEXT,
  alertEmailAllowed,
  beforeSwitchOn,
  deliveryOf,
  emailSeverityPasses,
  inQuietHours,
  isAlertRule,
  readAlertEmails,
  readRuleOnAt,
  ruleOnAtAfterSave,
  rulesOn,
  switchOnOf,
  severityOf,
  subjectKeyOf,
  thresholdsOf,
  tierAt,
  type AlertConfig,
} from '@/lib/alerts/catalog';
import { alertStateOf, needsAttention, toOpsAlertRow } from '@/lib/alerts/types';
import {
  ALERT_REVIEW_ACTION_TEXT,
  ALERT_REVIEW_ACTIONS,
  ALERT_REVIEW_CAUSE_TEXT,
  ALERT_REVIEW_CAUSES,
  ALERT_REVIEW_CODE_RE,
  ALERT_REVIEW_NOTE_MAX,
  ALERT_REVIEW_OTHER_MAX,
  ALERT_REVIEW_OTHER_MIN,
  REVIEW_FAMILIES,
  REVIEW_FAMILY_ACTIONS,
  REVIEW_FAMILY_CAUSES,
  REVIEW_FAMILY_OF,
  actionLabel,
  causeLabel,
  charCount,
  cutChars,
  forcesFollowUp,
  normaliseReview,
  reviewCameBack,
  reviewCodesFor,
  reviewFamilyOf,
  reviewFitsRule,
  reviewGotWorse,
  reviewOptions,
  reviewOtherStop,
  sameReview,
} from '@/lib/alerts/review';
import { alertReviewFlags, alertReviewText, alertText, reviewActionText, reviewCauseText } from '@/lib/alerts/view';
import { ALERT_DETAIL_FIELDS, ALERT_SETTING_BOUNDS, ALERT_SETTINGS_FIELDS, DISPATCHER_SETTINGS_FIELDS, SETTINGS_FIELDS, alertQuietSaveProblem } from '@/lib/settings-fields';
import { tenantConfigSchema } from '@/lib/schemas';
import { BACK_AFTER_RETURN_MIN } from '@/lib/delivery/day-results';
import { EVIDENCE_MAX_ACCURACY_M } from '@/lib/delivery/pin-check';

const WEB = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(WEB, rel), 'utf8').replace(/\r\n/g, '\n');
const MIGRATION = read('prisma/migrations/20261016180000_ops_alerts/migration.sql');
const SCHEMA = read('prisma/schema.prisma');
const block = (model: string) => {
  const from = SCHEMA.indexOf(`model ${model} {`);
  return SCHEMA.slice(from, SCHEMA.indexOf('\n}', from));
};

/** A company with alerts on and every column at its database default. */
const DEFAULTS: AlertConfig = {
  alertsEnabled: true,
  alertsEnabledAt: new Date('2026-10-16T05:00:00Z'),
  alertUnloadOverMin: 30,
  alertLoadingOverMin: 40,
  alertEtaLateMin: 30,
  alertDepartLateMin: 30,
  alertSilentMin: 120,
  alertPageNotOpenedMin: 30,
  alertAfterClosingMin: 15,
  alertPriorityMax: 2,
  alertDeliveredNote: true,
  alertProofFarM: 500,
  alertNotClosedMin: 120,
};

describe('the rule catalog', () => {
  it('has one spec per rule, numbered R1-R11, each with its own settings column', () => {
    expect(ALERT_RULE_LIST.map((s) => s.rule)).toEqual([...ALERT_RULES]);
    expect(ALERT_RULE_LIST.map((s) => s.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (const r of ALERT_RULES) expect(ALERT_RULE_SPECS[r].rule).toBe(r);
    const settings = ALERT_RULE_LIST.map((s) => s.setting);
    expect(new Set(settings).size).toBe(settings.length);
    expect(settings.filter((s) => s !== 'alertDeliveredNote').sort()).toEqual([...ALERT_THRESHOLD_COLUMNS].sort());
    expect(isAlertRule('ETA_LATE')).toBe(true);
    expect(isAlertRule('eta_late')).toBe(false);
  });

  it("holds the owner's three rules at his thresholds: unloading 30 min over plan, loading 40 min, ETA 30 min late", () => {
    const owner = ALERT_RULE_LIST.filter((s) => s.owner);
    expect(owner.map((s) => [s.rule, s.threshold, s.unit])).toEqual([
      ['UNLOAD_OVER', 30, 'min'],
      ['LOADING_OVER', 40, 'min'],
      ['ETA_LATE', 30, 'min'],
    ]);
    expect(thresholdsOf(DEFAULTS)).toMatchObject({ UNLOAD_OVER: 30, ETA_LATE: 30 });
  });

  it('loading between trips (R2) is on at 40 like the others now that it is measured from the driver taps (owner decision 16 Oct 2026), under the master switch', () => {
    expect(ALERT_RULE_SPECS.LOADING_OVER).toMatchObject({ defaultOn: true, threshold: 40, subject: 'LOAD', needsDriverPage: true });
    expect(ALERT_RULE_SPECS.LOADING_OVER.meaning).toMatch(/Back at depot/);
    expect(ALERT_RULE_SPECS.LOADING_OVER.meaning).toMatch(/Leaving for next load/);
    expect(ALERT_RULE_SPECS.LOADING_OVER.meaning).not.toMatch(/Loaded/);
    expect(thresholdsOf(DEFAULTS).LOADING_OVER).toBe(40);
    expect(thresholdsOf({ ...DEFAULTS, alertsEnabled: false }).LOADING_OVER).toBeNull();
    expect(thresholdsOf({ ...DEFAULTS, alertLoadingOverMin: null }).LOADING_OVER).toBeNull();
    for (const s of ALERT_RULE_LIST) expect(s.defaultOn, s.rule).toBe(true);
  });

  it('every rule is off while the master switch is off; a NULL threshold or a false switch turns one rule off', () => {
    const off = thresholdsOf({ ...DEFAULTS, alertsEnabled: false });
    for (const r of ALERT_RULES) expect(off[r], r).toBeNull();
    expect(rulesOn({ ...DEFAULTS, alertsEnabled: false })).toEqual([]);
    expect(thresholdsOf(null).ETA_LATE).toBeNull();
    const t = thresholdsOf({ ...DEFAULTS, alertEtaLateMin: null, alertDeliveredNote: false });
    expect(t.ETA_LATE).toBeNull();
    expect(t.DELIVERED_WITH_NOTE).toBeNull();
    expect(thresholdsOf(DEFAULTS).DELIVERED_WITH_NOTE).toBe(0);
    expect(rulesOn(DEFAULTS)).toEqual([...ALERT_RULES]);
  });

  it('tiers start at WARN: tier 1 WARN, tiers 2 and 3 HIGH; HIGH sorts first by rank, not by the alphabet', () => {
    expect([1, 2, 3].map(severityOf)).toEqual(['WARN', 'HIGH', 'HIGH']);
    expect(SEVERITY_RANK.HIGH).toBeLessThan(SEVERITY_RANK.WARN);
    expect(SEVERITY_ORDER_SQL).toBe(`CASE "severity" WHEN 'HIGH' THEN 0 ELSE 1 END`);
    // The silent driver starts at WARN too (review M10).
    expect(ALERT_RULE_SPECS.DRIVER_SILENT.maxTier).toBe(2);
  });

  it('tierAt: fires at T + 1, never at T; a tier per multiple of T passed, capped at the rule maximum', () => {
    expect(tierAt(30, 30)).toBe(0);
    expect(tierAt(31, 30)).toBe(1);
    expect(tierAt(60, 30)).toBe(1);
    expect(tierAt(61, 30)).toBe(2);
    expect(tierAt(91, 30)).toBe(3);
    expect(tierAt(500, 30)).toBe(3);
    expect(tierAt(500, 120, 2)).toBe(2);
    expect(tierAt(1, 0)).toBe(1);
    expect(tierAt(0, 0)).toBe(0);
    expect(tierAt(Number.NaN, 30)).toBe(0);
  });

  it('delivery: unloading tier 1 and history rows stay in the lists; a note never toasts; the rest may toast and e-mail', () => {
    expect(deliveryOf('UNLOAD_OVER', 1)).toEqual({ mayToast: false, mayEmail: false });
    expect(deliveryOf('UNLOAD_OVER', 2)).toEqual({ mayToast: true, mayEmail: true });
    expect(deliveryOf('DEPART_LATE', 3, { history: true })).toEqual({ mayToast: false, mayEmail: false });
    expect(deliveryOf('DELIVERED_WITH_NOTE', 1)).toEqual({ mayToast: false, mayEmail: true });
    expect(deliveryOf('ETA_LATE', 1)).toEqual({ mayToast: true, mayEmail: true });
  });

  it('only the rules that follow the phone need an opened driver page (review H3)', () => {
    // R2 too: it is measured from the driver's Back at depot and Leaving for next load taps.
    expect(ALERT_RULE_LIST.filter((s) => s.needsDriverPage).map((s) => s.rule)).toEqual(['UNLOAD_OVER', 'LOADING_OVER', 'ETA_LATE', 'DRIVER_SILENT', 'AFTER_CLOSING', 'LOAD_NOT_CLOSED']);
    expect(ALERT_RULE_SPECS.PAGE_NOT_OPENED).toMatchObject({ subject: 'TRUCK_DAY', maxTier: 1 });
  });

  it('no backlog: nothing that began before the switch-on time raises a row', () => {
    const on = new Date('2026-10-16T05:00:00Z');
    expect(beforeSwitchOn(new Date('2026-10-16T04:59:59Z'), on)).toBe(true);
    expect(beforeSwitchOn(on, on)).toBe(false);
    expect(beforeSwitchOn(new Date('2026-10-15T04:00:00Z'), null)).toBe(false);
  });

  it('subject keys are physical (depot, date, truck, load, stop), never a plan row id', () => {
    expect(subjectKeyOf({ depotId: 'D1', date: '2026-10-16', truckId: 'T1' })).toBe('D1|2026-10-16|T1');
    expect(subjectKeyOf({ depotId: 'D1', date: '2026-10-16', truckId: 'T1', loadNo: 2 })).toBe('D1|2026-10-16|T1|2');
    expect(subjectKeyOf({ depotId: 'D1', date: '2026-10-16', truckId: 'T1', loadNo: 2, sequence: 4 })).toBe('D1|2026-10-16|T1|2|4');
    expect(() => subjectKeyOf({ depotId: 'D1', date: '2026-10-16', truckId: 'T1', sequence: 4 })).toThrow(/load number/);
  });

  it('keeps its copies of shared constants equal to the originals', () => {
    expect(RETURN_GRACE_MIN).toBe(BACK_AFTER_RETURN_MIN);
    expect(ALERT_EVIDENCE_MAX_ACCURACY_M).toBe(EVIDENCE_MAX_ACCURACY_M);
  });
});

describe('e-mail settings', () => {
  it('HIGH only by default; WARN takes both', () => {
    expect(ALERT_EMAIL_DEFAULTS.minSeverity).toBe('HIGH');
    expect(emailSeverityPasses('HIGH', 'HIGH')).toBe(true);
    expect(emailSeverityPasses('WARN', 'HIGH')).toBe(false);
    expect(emailSeverityPasses('WARN', 'WARN')).toBe(true);
    expect(emailSeverityPasses('WARN', null)).toBe(false);
  });

  it('quiet hours 22:00-06:00 pass midnight; none when an end is missing or both are equal', () => {
    const q = (m: number) => inQuietHours(m, ALERT_EMAIL_DEFAULTS.quietFromMin, ALERT_EMAIL_DEFAULTS.quietToMin);
    expect([21 * 60 + 59, 22 * 60, 23 * 60, 0, 5 * 60 + 59, 6 * 60, 12 * 60].map(q)).toEqual([false, true, true, true, true, false, false]);
    // Plan minutes can pass 1440 (after midnight of the delivery date).
    expect(q(1440 + 60)).toBe(true);
    expect(inQuietHours(13 * 60, 12 * 60, 14 * 60)).toBe(true);
    expect(inQuietHours(14 * 60, 12 * 60, 14 * 60)).toBe(false);
    expect(inQuietHours(23 * 60, null, 360)).toBe(false);
    expect(inQuietHours(23 * 60, 360, 360)).toBe(false);
  });

  it('the recipients: separated by commas, semicolons or spaces, duplicates dropped, at most 5', () => {
    expect(readAlertEmails(' Owner@Ops.example; second@ops.example , owner@ops.example')).toEqual({ ok: true, value: 'Owner@Ops.example, second@ops.example', emails: ['Owner@Ops.example', 'second@ops.example'] });
    expect(readAlertEmails('')).toEqual({ ok: true, value: null, emails: [] });
    expect(readAlertEmails(null)).toEqual({ ok: true, value: null, emails: [] });
    expect(readAlertEmails('owner@ops')).toMatchObject({ ok: false });
    expect(readAlertEmails('Owner <owner@ops.example>')).toMatchObject({ ok: false });
    expect(readAlertEmails(Array.from({ length: 6 }, (_, i) => `p${i}@ops.example`).join(','))).toMatchObject({ ok: false, error: 'At most 5 e-mail addresses.' });
  });

  it('the quiet hours save rule: both ends or none, never equal, checked only when changed', () => {
    expect(alertQuietSaveProblem({ alertUnloadOverMin: 40 }, { alertQuietFromMin: 1320, alertQuietToMin: null })).toBeNull();
    expect(alertQuietSaveProblem({ alertQuietToMin: null }, { alertQuietFromMin: 1320, alertQuietToMin: null })).toMatch(/both a start and an end/);
    expect(alertQuietSaveProblem({ alertQuietFromMin: 360 }, { alertQuietFromMin: 360, alertQuietToMin: 360 })).toMatch(/another time/);
    expect(alertQuietSaveProblem({ alertQuietFromMin: null, alertQuietToMin: null }, { alertQuietFromMin: null, alertQuietToMin: null })).toBeNull();
  });
});

describe('the settings fields', () => {
  it('are company-admin only Settings fields of the API schema, the master switch first', () => {
    for (const k of ALERT_SETTINGS_FIELDS) {
      expect(SETTINGS_FIELDS, k).toContain(k);
      expect(DISPATCHER_SETTINGS_FIELDS as readonly string[], k).not.toContain(k);
      expect(tenantConfigSchema.shape, k).toHaveProperty(k);
    }
    expect(ALERT_SETTINGS_FIELDS[0]).toBe('alertsEnabled');
    expect(ALERT_DETAIL_FIELDS).toEqual(ALERT_SETTINGS_FIELDS.slice(1));
    expect(SETTINGS_FIELDS as readonly string[]).not.toContain('alertsEnabledAt');
  });

  it('every threshold is refused outside its bounds and accepted at them, or empty (off)', () => {
    const p = tenantConfigSchema.partial();
    for (const [k, b] of Object.entries(ALERT_THRESHOLD_BOUNDS)) {
      expect(p.safeParse({ [k]: b.min }).success, k).toBe(true);
      expect(p.safeParse({ [k]: b.max }).success, k).toBe(true);
      expect(p.safeParse({ [k]: b.min - 1 }).success, k).toBe(false);
      expect(p.safeParse({ [k]: b.max + 1 }).success, k).toBe(false);
      expect(p.parse({ [k]: null })[k as never]).toBeNull();
      expect(p.parse({ [k]: '' })[k as never]).toBeNull();
    }
    expect(p.safeParse({ alertEmailMinSeverity: 'LOW' }).success).toBe(false);
    expect(p.safeParse({ alertEmailEveryMin: null }).success).toBe(false);
    expect(p.safeParse({ alertQuietFromMin: 1440 }).success).toBe(false);
    expect(ALERT_SETTING_BOUNDS.alertEmailEveryMin).toEqual({ min: 0, max: 240 });
  });
});

describe('migration 20261016180000_ops_alerts and the schema repeat the catalog', () => {
  it('each threshold column has the catalog default (none for an off rule) and a CHECK with the catalog bounds', () => {
    const cfg = block('TenantConfig');
    for (const s of ALERT_RULE_LIST) {
      const line = cfg.split('\n').find((l) => new RegExp(`^\\s+${s.setting}\\s`).test(l));
      expect(line, s.setting).toBeTruthy();
      const def = /@default\((\w+)\)/.exec(line!)?.[1] ?? null;
      if (s.setting === 'alertDeliveredNote') {
        expect(def).toBe(String(s.defaultOn));
        continue;
      }
      expect(def, s.setting).toBe(s.defaultOn ? String(s.threshold) : null);
      expect(MIGRATION, s.setting).toContain(`"${s.setting}" INTEGER${s.defaultOn ? ` DEFAULT ${s.threshold}` : ''},`);
      expect(MIGRATION, s.setting).toContain(`CHECK ("${s.setting}" IS NULL OR "${s.setting}" BETWEEN ${s.bounds!.min} AND ${s.bounds!.max})`);
    }
  });

  it('the master switch is off for every company; e-mail is HIGH only with quiet hours 22:00-06:00', () => {
    expect(MIGRATION).toContain(`"alertsEnabled" BOOLEAN NOT NULL DEFAULT false`);
    expect(MIGRATION).toContain(`"alertEmailMinSeverity" TEXT NOT NULL DEFAULT '${ALERT_EMAIL_DEFAULTS.minSeverity}'`);
    expect(MIGRATION).toContain(`"alertEmailEveryMin" INTEGER NOT NULL DEFAULT ${ALERT_EMAIL_DEFAULTS.everyMin}`);
    expect(MIGRATION).toContain(`"alertQuietFromMin" INTEGER DEFAULT ${ALERT_EMAIL_DEFAULTS.quietFromMin}`);
    expect(MIGRATION).toContain(`"alertQuietToMin" INTEGER DEFAULT ${ALERT_EMAIL_DEFAULTS.quietToMin}`);
    expect(MIGRATION).toContain(`CHECK ("alertEmailMinSeverity" IN ('HIGH', 'WARN'))`);
  });

  it('is additive, waits at most 5 s for a lock, and keeps one row per rule and subject', () => {
    const statements = MIGRATION.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));
    expect(statements.filter((l) => /^\s*(DROP|UPDATE|DELETE|TRUNCATE|INSERT)\b/i.test(l))).toEqual([]);
    expect(statements.filter((l) => /\b(DROP (COLUMN|TABLE|INDEX|CONSTRAINT|DEFAULT|NOT NULL)|ALTER COLUMN|RENAME)\b/i.test(l))).toEqual([]);
    expect(statements[0]).toBe(`SET LOCAL lock_timeout = '5s';`);
    expect(MIGRATION).toContain(`CREATE UNIQUE INDEX "OpsAlert_tenantId_rule_subjectKey_key" ON "OpsAlert"("tenantId", "rule", "subjectKey");`);
    expect(MIGRATION).toContain(`CHECK ("kind" IN ('CONDITION', 'EVENT'))`);
    expect(MIGRATION).toContain(`CHECK ("severity" IN ('WARN', 'HIGH'))`);
    expect(MIGRATION).toContain(`CHECK ("tier" BETWEEN 1 AND 3)`);
    // The rule codes are checked in the app (a new rule needs no migration: review L6).
    expect(MIGRATION).not.toMatch(/CHECK \("rule"/);
    // No warehouse Loaded columns: the A3 action was removed before release (owner decision of 16 Oct
    // 2026: R2 is measured from the driver's taps). The only table altered is TenantConfig.
    expect(MIGRATION).not.toContain('"PlanLoad"');
    expect(MIGRATION).not.toMatch(/loadedAt|loadedById/);
    expect(block('PlanLoad')).not.toMatch(/loadedAt|loadedBy/);
    // Each rule's own switch-on time (review H2): nullable JSON, no default, not a Settings field.
    expect(MIGRATION).toContain(`ADD COLUMN     "alertRuleOnAtJson" JSONB,`);
    expect(block('TenantConfig')).toMatch(/alertRuleOnAtJson\s+Json\?/);
  });
});

describe('row states (review H4)', () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({
      id: 'a1', tenantId: 't', depotId: 'D1', deliveryDate: new Date('2026-10-16T00:00:00Z'), rule: 'PRIORITY_NOT_DELIVERED', subjectKey: 'D1|2026-10-16|T1|1|5',
      truckId: 'T1', truckCode: 'T02', loadNo: 1, sequence: 5, customerId: 'C1', kind: 'EVENT', severity: 'HIGH', tier: 2, value: 1, threshold: 2,
      text: 'T02 L1 stop 5 Hyper Example A (P1): NOT DELIVERED - Shop closed (driver, 11:20).', factsJson: { phone: 'never sent' }, mayToast: true, mayEmail: true,
      occurredAt: new Date('2026-10-16T07:20:00Z'), firstSeenAt: new Date('2026-10-16T07:21:00Z'), lastSeenAt: new Date('2026-10-16T07:21:00Z'),
      resolvedAt: null, resolvedReason: null, occurrences: 1, ackedAt: null, ackedById: null, emailedTier: 0, emailedAt: null, digestId: null, emailAttempts: 0, emailError: null,
      ...over,
    }) as never;

  it('an event stays open until acknowledged or corrected; a condition that ended is history', () => {
    expect(alertStateOf(row())).toBe('OPEN');
    expect(needsAttention(row())).toBe(true);
    expect(alertStateOf(row({ ackedAt: new Date() }))).toBe('ACKED');
    expect(needsAttention(row({ ackedAt: new Date() }))).toBe(false);
    expect(alertStateOf(row({ resolvedAt: new Date(), resolvedReason: 'CORRECTED' }))).toBe('RESOLVED');
    expect(alertStateOf(row({ kind: 'CONDITION', resolvedAt: new Date(), resolvedReason: 'ENDED' }))).toBe('RESOLVED');
    expect(needsAttention(row({ kind: 'CONDITION', resolvedAt: new Date() }))).toBe(false);
  });

  it('the API row carries the state and ISO times, never the facts or the e-mail state', () => {
    const r = toOpsAlertRow({ ...(row() as object), ackedBy: { name: 'Office Example' }, ackedAt: new Date('2026-10-16T07:30:00Z') } as never);
    expect(r).toMatchObject({ state: 'ACKED', deliveryDate: '2026-10-16', ackedByName: 'Office Example', ackedAt: '2026-10-16T07:30:00.000Z', resolvedAt: null, tier: 2, severity: 'HIGH' });
    expect(r).not.toHaveProperty('factsJson');
    expect(JSON.stringify(r)).not.toMatch(/factsJson|emailedTier|emailError|digestId|never sent/);
  });
});

describe('the shared modules stay browser-safe', () => {
  it('catalog.ts, types.ts and review.ts import no server module', () => {
    const allowed: Record<string, string[]> = {
      'lib/alerts/catalog.ts': ['./catalog', '../dispatch/time'],
      'lib/alerts/types.ts': ['./catalog', '../dispatch/time', './review'],
      // The cause & action lists (owner request 20 Oct 2026): the dialog, the API and the export share them.
      'lib/alerts/review.ts': ['./catalog', './text'],
    };
    for (const [f, ok] of Object.entries(allowed)) {
      const imports = [...read(f).matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)].map((m) => ({ typeOnly: !!m[1], from: m[2]! }));
      for (const i of imports) {
        if (i.from === '@prisma/client') expect(i.typeOnly, `${f}: ${i.from}`).toBe(true);
        else expect(ok, `${f}: ${i.from}`).toContain(i.from);
      }
    }
    // types.ts only takes types from review.ts (no runtime cycle).
    expect(read('lib/alerts/types.ts')).toMatch(/^import type \{[^}]*\} from '\.\/review';$/m);
  });
});

describe('no backlog per rule (review H2 of 16 Oct 2026)', () => {
  const ON = { alertsEnabled: true, alertUnloadOverMin: 30, alertLoadingOverMin: null, alertEtaLateMin: 30, alertPriorityMax: 2, alertDeliveredNote: false, alertProofFarM: 500 } as Partial<AlertConfig>;
  const NOW = new Date('2026-10-20T08:00:00Z');

  it('a save stamps the rules it switched on or set to catch more, and keeps the earlier stamps', () => {
    expect(ruleOnAtAfterSave(ON, { ...ON, alertLoadingOverMin: 40 }, null, NOW)).toEqual({ LOADING_OVER: NOW.toISOString() });
    // A lower limit catches more; a higher one does not; R7: a higher priority number catches more.
    expect(ruleOnAtAfterSave(ON, { ...ON, alertEtaLateMin: 20 }, null, NOW)).toEqual({ ETA_LATE: NOW.toISOString() });
    expect(ruleOnAtAfterSave(ON, { ...ON, alertEtaLateMin: 45 }, null, NOW)).toBeNull();
    expect(ruleOnAtAfterSave(ON, { ...ON, alertPriorityMax: 3 }, null, NOW)).toEqual({ PRIORITY_NOT_DELIVERED: NOW.toISOString() });
    expect(ruleOnAtAfterSave(ON, { ...ON, alertPriorityMax: 1 }, null, NOW)).toBeNull();
    // The on/off rule; switching a rule off stamps nothing; a save of other settings neither.
    expect(ruleOnAtAfterSave(ON, { ...ON, alertDeliveredNote: true }, null, NOW)).toEqual({ DELIVERED_WITH_NOTE: NOW.toISOString() });
    expect(ruleOnAtAfterSave(ON, { ...ON, alertProofFarM: null }, null, NOW)).toBeNull();
    expect(ruleOnAtAfterSave(ON, ON, { PROOF_FAR: '2026-10-19T08:00:00.000Z' }, NOW)).toBeNull();
    expect(ruleOnAtAfterSave(ON, { ...ON, alertEtaLateMin: 20 }, { PROOF_FAR: '2026-10-19T08:00:00.000Z', NOPE: 'x' }, NOW)).toEqual({ PROOF_FAR: '2026-10-19T08:00:00.000Z', ETA_LATE: NOW.toISOString() });
    // The master switch aside (alertsEnabledAt covers it): thresholds prepared while alerts are off still stamp.
    expect(ruleOnAtAfterSave({ ...ON, alertsEnabled: false }, { ...ON, alertsEnabled: false, alertLoadingOverMin: 40 }, null, NOW)).toEqual({ LOADING_OVER: NOW.toISOString() });
  });

  it('read back: unknown rules and bad times dropped; the later of the master switch and the rule\'s own counts', () => {
    expect(readRuleOnAt({ PROOF_FAR: '2026-10-19T08:00:00.000Z', NOPE: '2026-10-19T08:00:00.000Z', ETA_LATE: 'soon', UNLOAD_OVER: 5 })).toEqual({ PROOF_FAR: new Date('2026-10-19T08:00:00.000Z') });
    expect(readRuleOnAt(null)).toEqual({});
    expect(readRuleOnAt([1])).toEqual({});
    const master = new Date('2026-10-18T05:00:00Z');
    const own = new Date('2026-10-19T08:00:00Z');
    expect(switchOnOf('PROOF_FAR', master, { PROOF_FAR: own })).toEqual(own);
    expect(switchOnOf('ETA_LATE', master, { PROOF_FAR: own })).toEqual(master);
    expect(switchOnOf('PROOF_FAR', new Date('2026-10-20T00:00:00Z'), { PROOF_FAR: own })).toEqual(new Date('2026-10-20T00:00:00Z'));
    expect(switchOnOf('PROOF_FAR', null, { PROOF_FAR: own })).toEqual(own);
    expect(switchOnOf('PROOF_FAR', null, null)).toBeNull();
  });
});

describe('alert e-mail only for the companies the server lists (review H1 of 16 Oct 2026)', () => {
  it('ALERT_EMAIL_TENANTS names the slugs (commas, semicolons or spaces; any case); unset: none', () => {
    expect(alertEmailAllowed('example', { ALERT_EMAIL_TENANTS: 'other, Example' })).toBe(true);
    expect(alertEmailAllowed('example', { ALERT_EMAIL_TENANTS: 'other;example2' })).toBe(false);
    expect(alertEmailAllowed('example', {})).toBe(false);
    expect(alertEmailAllowed(null, { ALERT_EMAIL_TENANTS: 'example' })).toBe(false);
    expect(alertEmailAllowed('', { ALERT_EMAIL_TENANTS: ' , ' })).toBe(false);
  });

  it('a row the rule stopped following is "No longer followed", never "Over"', () => {
    expect(RESOLVED_REASON_TEXT.NOT_FOLLOWED).toBe('No longer followed');
  });

  it('owner request 19 Oct 2026: a row closed at the end of its day is "Day ended", a reason of its own (never "Over", so never e-mailed as over)', () => {
    expect(RESOLVED_REASONS).toContain('DAY_ENDED');
    expect(RESOLVED_REASON_TEXT.DAY_ENDED).toBe('Day ended');
    // Every reason has its words (the Alerts page and the closing text read them).
    for (const r of RESOLVED_REASONS) expect(RESOLVED_REASON_TEXT[r]).toMatch(/^[A-Z][a-z ]+$/);
  });

  it("review of the branch (19 Oct 2026, finding 2): only the day's follow-up, Load not closed, is still raised open for a day that is over; it fires after the planned return, a CONDITION of a load", () => {
    expect(ALERT_AFTER_DAY_RULES).toEqual(['LOAD_NOT_CLOSED']);
    for (const r of ALERT_AFTER_DAY_RULES) expect(ALERT_RULE_SPECS[r]).toMatchObject({ kind: 'CONDITION', subject: 'LOAD', threshold: 120 });
  });
});

// ---------------------------------------------------------------------------------------------
// Cause & action (owner request 20 Oct 2026: "a place where a note / reason for the alert to have happened and
// the solution ... will help us gather data for what decisions are made when alerts are made"), with the
// critique of the design applied: lib/alerts/review.ts, migration 20261020000000_alert_notes, the API row.
// ---------------------------------------------------------------------------------------------

describe('cause & action: the pick-lists (lib/alerts/review.ts)', () => {
  it('every rule has a family; a rule no longer in the catalog offers the whole lists', () => {
    for (const r of ALERT_RULES) expect(REVIEW_FAMILIES, r).toContain(REVIEW_FAMILY_OF[r]);
    expect(reviewFamilyOf('ETA_LATE')).toBe('LATENESS');
    expect(reviewFamilyOf('RETIRED_RULE')).toBeNull();
    expect(reviewCodesFor('RETIRED_RULE')).toEqual({ causes: ALERT_REVIEW_CAUSES, actions: ALERT_REVIEW_ACTIONS });
  });

  it('family lists are part of the whole lists, without duplicates; every code is offered somewhere; every code has a short label and the database format', () => {
    for (const f of REVIEW_FAMILIES) {
      for (const [list, all] of [
        [REVIEW_FAMILY_CAUSES[f], ALERT_REVIEW_CAUSES],
        [REVIEW_FAMILY_ACTIONS[f], ALERT_REVIEW_ACTIONS],
      ] as const) {
        expect(new Set(list).size, f).toBe(list.length);
        for (const c of list) expect(all as readonly string[], `${f}: ${c}`).toContain(c);
      }
    }
    for (const c of ALERT_REVIEW_CAUSES) expect(REVIEW_FAMILIES.some((f) => REVIEW_FAMILY_CAUSES[f].includes(c)), c).toBe(true);
    for (const a of ALERT_REVIEW_ACTIONS) expect(REVIEW_FAMILIES.some((f) => REVIEW_FAMILY_ACTIONS[f].includes(a)), a).toBe(true);
    for (const c of [...ALERT_REVIEW_CAUSES, ...ALERT_REVIEW_ACTIONS]) expect(c).toMatch(ALERT_REVIEW_CODE_RE);
    for (const label of [...Object.values(ALERT_REVIEW_CAUSE_TEXT), ...Object.values(ALERT_REVIEW_ACTION_TEXT)]) expect(label.length, label).toBeLessThanOrEqual(70);
    expect(Object.keys(ALERT_REVIEW_CAUSE_TEXT).sort()).toEqual([...ALERT_REVIEW_CAUSES].sort());
    expect(Object.keys(ALERT_REVIEW_ACTION_TEXT).sort()).toEqual([...ALERT_REVIEW_ACTIONS].sort());
  });

  it('every family ends with the same codes, so false alarms, tight settings and the unknown can be counted per rule', () => {
    for (const f of REVIEW_FAMILIES) {
      expect(REVIEW_FAMILY_CAUSES[f].slice(-4), f).toEqual(['SETTING_TOO_TIGHT', 'FALSE_ALARM', 'NOT_KNOWN', 'OTHER']);
      expect(REVIEW_FAMILY_ACTIONS[f].slice(-3), f).toEqual(['NO_ACTION', 'NONE_YET', 'OTHER']);
    }
    // Critique item 10a: a tight setting and a false alarm are two causes; "No action needed" says no more.
    expect(ALERT_REVIEW_CAUSE_TEXT.SETTING_TOO_TIGHT).not.toBe(ALERT_REVIEW_CAUSE_TEXT.FALSE_ALARM);
    expect(ALERT_REVIEW_ACTION_TEXT.NO_ACTION).toBe('No action needed');
  });

  it('GPS is no rule: a GPS or tracker problem is offered wherever a rule can read the GPS or a position', () => {
    for (const f of ['LATENESS', 'UNLOADING', 'DEPOT', 'PIN', 'TRUCK_OUT', 'DRIVER_APP'] as const) expect(REVIEW_FAMILY_CAUSES[f], f).toContain('GPS_ISSUE');
  });

  it('finding 7: Driver silent and Load not closed (the truck is still out, usually a long trip) offer the lateness causes and the move-it actions; the page not opened keeps the taps and phone list', () => {
    expect([REVIEW_FAMILY_OF.DRIVER_SILENT, REVIEW_FAMILY_OF.LOAD_NOT_CLOSED, REVIEW_FAMILY_OF.PAGE_NOT_OPENED]).toEqual(['TRUCK_OUT', 'TRUCK_OUT', 'DRIVER_APP']);
    for (const rule of ['DRIVER_SILENT', 'LOAD_NOT_CLOSED']) {
      const { causes, actions } = reviewCodesFor(rule);
      for (const c of ['TRAFFIC', 'EARLIER_STOPS_LONG', 'WAITING_AT_CUSTOMER', 'LONG_UNLOADING', 'OUT_OF_TIME', 'PLAN_WRONG', 'DRIVER_DID_NOT_TAP', 'PHONE_ISSUE', 'TRUCK_BREAKDOWN']) expect(causes, `${rule}: ${c}`).toContain(c);
      for (const a of ['CALLED_DRIVER', 'CALLED_CUSTOMER', 'POSTPONED', 'MOVED_TRUCK', 'REPLANNED', 'REMINDED_DRIVER', 'UPDATED_ROUTEIQ']) expect(actions, `${rule}: ${a}`).toContain(a);
      expect(normaliseReview(rule, { cause: 'TRAFFIC', action: 'CALLED_DRIVER' }, null).ok, rule).toBe(true);
      expect(normaliseReview(rule, { cause: 'WAITING_AT_CUSTOMER', action: 'POSTPONED' }, null).ok, rule).toBe(true);
    }
    expect(reviewCodesFor('PAGE_NOT_OPENED').causes).not.toContain('TRAFFIC');
    // The incident of the review: traffic raised Running late and Driver silent on one truck; one cause & action fits both.
    expect(reviewFitsRule('DRIVER_SILENT', { cause: 'TRAFFIC', action: 'CALLED_DRIVER' })).toBe(true);
    expect(reviewFitsRule('ETA_LATE', { cause: 'TRAFFIC', action: 'CALLED_DRIVER' })).toBe(true);
    // Lateness from the taps is solved with the driver or in RouteIQ; a wrong result is corrected by the office, stock short by the warehouse.
    expect(normaliseReview('ETA_LATE', { cause: 'DRIVER_DID_NOT_TAP', action: 'REMINDED_DRIVER' }, null).ok).toBe(true);
    expect(normaliseReview('ETA_LATE', { cause: 'GPS_ISSUE', action: 'UPDATED_ROUTEIQ' }, null).ok).toBe(true);
    expect(normaliseReview('PRIORITY_NOT_DELIVERED', { cause: 'STOCK_SHORT', action: 'CALLED_WAREHOUSE' }, null).ok).toBe(true);
    expect(normaliseReview('DELIVERED_WITH_NOTE', { cause: 'FALSE_ALARM', action: 'UPDATED_ROUTEIQ' }, null).ok).toBe(true);
  });

  it('the NMWC options the owner named, and the critique additions (items 10c and 10d)', () => {
    const late = REVIEW_FAMILY_CAUSES.LATENESS;
    const named = ['TRAFFIC', 'CUSTOMER_NOT_READY', 'WAITING_AT_CUSTOMER', 'WRONG_PIN', 'LATE_DEPOT_START', 'LOADING_DELAY', 'LONG_UNLOADING', 'DRIVER_DID_NOT_TAP', 'TRUCK_BREAKDOWN', 'PLAN_WRONG', 'GPS_ISSUE'];
    for (const c of [...named, 'CUSTOMER_CLOSED', 'OUT_OF_TIME', 'ACCESS_PROBLEM', 'EARLIER_STOPS_LONG', 'NO_CREW', 'NEW_DRIVER', 'CUSTOMER_ASKED_OTHER_TIME']) expect(late, c).toContain(c);
    const actions = ['CALLED_DRIVER', 'CALLED_CUSTOMER', 'REPLANNED', 'MOVED_TRUCK', 'POSTPONED', 'FIXED_PIN', 'CHANGED_CUSTOMER_TIMES', 'NO_ACTION'];
    for (const a of [...actions, 'DELIVERED_LATER', 'CANCELLED_ORDER', 'CALLED_WAREHOUSE']) expect(REVIEW_FAMILY_ACTIONS.LATENESS, a).toContain(a);
    expect(REVIEW_FAMILY_ACTIONS.DRIVER_APP).toContain('SHOWED_DRIVER_PAGE');
  });
});

describe('cause & action: normaliseReview', () => {
  const ok = (rule: string, input: Record<string, unknown>, current: { cause?: string; action?: string } | null = null) => {
    const r = normaliseReview(rule, { cause: 'TRAFFIC', action: 'CALLED_DRIVER', ...input } as never, current);
    if (!r.ok) throw new Error(r.message);
    return r.value;
  };
  const refused = (rule: string, input: Record<string, unknown>, current: { cause?: string; action?: string } | null = null) => {
    const r = normaliseReview(rule, { cause: 'TRAFFIC', action: 'CALLED_DRIVER', ...input } as never, current);
    return r.ok ? null : { code: r.code, field: r.field };
  };

  it('both codes are needed; the selects start empty, so an empty one is refused, never defaulted', () => {
    expect(refused('ETA_LATE', { cause: '' })).toEqual({ code: 'REVIEW_CAUSE_REQUIRED', field: 'cause' });
    expect(refused('ETA_LATE', { action: '' })).toEqual({ code: 'REVIEW_ACTION_REQUIRED', field: 'action' });
  });

  it('Other needs a text of 3 characters or more after cleaning; an Other text goes with another code', () => {
    expect(refused('ETA_LATE', { cause: 'OTHER', causeOther: '  ab ' })).toEqual({ code: 'REVIEW_OTHER_REQUIRED', field: 'cause' });
    expect(refused('ETA_LATE', { action: 'OTHER', actionOther: null })).toEqual({ code: 'REVIEW_OTHER_REQUIRED', field: 'action' });
    expect(ok('ETA_LATE', { cause: 'OTHER', causeOther: '  Road\nclosed  ' })).toMatchObject({ cause: 'OTHER', causeOther: 'Road closed' });
    expect(ok('ETA_LATE', { causeOther: 'left over', actionOther: 'left over' })).toMatchObject({ causeOther: null, actionOther: null });
    expect(ok('ETA_LATE', { action: 'OTHER', actionOther: 'x'.repeat(300) }).actionOther).toHaveLength(ALERT_REVIEW_OTHER_MAX);
  });

  it('the note: one line, no phone number (dates written with digits go too), at most 500 characters without splitting a character; empty is none', () => {
    expect(ok('ETA_LATE', { note: 'Driver said: call 9123 4567 for the gate' }).note).toBe('Driver said: call [number] for the gate');
    expect(ok('ETA_LATE', { note: 'delivered on 20/10/2026' }).note).toBe('delivered on [number]');
    expect(ok('ETA_LATE', { note: '   ' }).note).toBeNull();
    expect(ok('ETA_LATE', { note: null }).note).toBeNull();
    const long = ok('ETA_LATE', { note: `${'a'.repeat(498)}\u{1F600}\u{1F600}\u{1F600}` }).note!;
    expect(charCount(long)).toBe(ALERT_REVIEW_NOTE_MAX);
    expect(long).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(cutChars('\u{1F600}\u{1F600}\u{1F600}', 2)).toBe('\u{1F600}…');
  });

  it('"Nothing yet" and "Not found yet" always need follow-up; follow-up can be asked for any other', () => {
    expect(ok('ETA_LATE', { action: 'NONE_YET' }).followUp).toBe(true);
    expect(ok('ETA_LATE', { cause: 'NOT_KNOWN' }).followUp).toBe(true);
    expect(ok('ETA_LATE', {}).followUp).toBe(false);
    expect(ok('ETA_LATE', { followUp: true }).followUp).toBe(true);
    expect(forcesFollowUp({ cause: 'NOT_KNOWN' })).toBe(true);
  });

  it("a code not offered for the alert's rule is refused, unless it is the one the alert already has; a retired rule takes any", () => {
    expect(refused('PROOF_FAR', { cause: 'TRAFFIC' })).toEqual({ code: 'REVIEW_CODE_NOT_FOR_RULE', field: 'cause' });
    expect(refused('PROOF_FAR', { cause: 'WRONG_PIN', action: 'REPLANNED' })).toEqual({ code: 'REVIEW_CODE_NOT_FOR_RULE', field: 'action' });
    expect(ok('PROOF_FAR', { cause: 'TRAFFIC', action: 'FIXED_PIN' }, { cause: 'TRAFFIC' })).toMatchObject({ cause: 'TRAFFIC' });
    expect(refused('PROOF_FAR', { cause: 'NO_SUCH_CODE' })).toEqual({ code: 'REVIEW_CODE_NOT_FOR_RULE', field: 'cause' });
    expect(ok('RETIRED_RULE', { cause: 'PAYMENT_ISSUE', action: 'RESENT_LINK' })).toMatchObject({ cause: 'PAYMENT_ISSUE' });
    expect(reviewFitsRule('PROOF_FAR', { cause: 'WRONG_PIN', action: 'FIXED_PIN' })).toBe(true);
    expect(reviewFitsRule('PROOF_FAR', { cause: 'TRAFFIC', action: 'FIXED_PIN' })).toBe(false);
  });

  it('reviewOptions keeps an earlier choice last, so the row stays editable; sameReview compares every field', () => {
    const o = reviewOptions('PROOF_FAR', { cause: 'TRAFFIC', action: 'OLD_CODE' });
    expect(o.causes.at(-1)).toEqual({ code: 'TRAFFIC', label: 'Traffic or road delay (earlier choice)', earlier: true });
    expect(o.actions.at(-1)).toEqual({ code: 'OLD_CODE', label: 'OLD_CODE (earlier choice)', earlier: true });
    expect(reviewOptions('PROOF_FAR').causes.map((c) => c.code)).toEqual([...REVIEW_FAMILY_CAUSES.PIN]);
    expect(causeLabel('GONE')).toBe('GONE');
    expect(actionLabel('CALLED_DRIVER')).toBe('Called the driver');
    const v = { cause: 'TRAFFIC', causeOther: null, action: 'CALLED_DRIVER', actionOther: null, note: 'n', followUp: false };
    expect(sameReview(v, { ...v })).toBe(true);
    expect(sameReview(v, { ...v, note: null })).toBe(false);
    expect(sameReview(null, null)).toBe(true);
    expect(sameReview(v, null)).toBe(false);
  });

  it('what changed since the save (critique items 5 and 6): came back, got worse, another customer at the stop', () => {
    const r = { tier: 1, occurrences: 1, customerId: 'c1', review: { tier: 1, occurrences: 1, customerId: 'c1' } };
    expect([reviewCameBack(r), reviewGotWorse(r), reviewOtherStop(r)]).toEqual([false, false, false]);
    expect(reviewCameBack({ ...r, occurrences: 2 })).toBe(true);
    expect(reviewGotWorse({ ...r, tier: 2 })).toBe(true);
    expect(reviewOtherStop({ ...r, customerId: 'c2' })).toBe(true);
    expect(reviewCameBack({ ...r, review: null })).toBe(false);
  });
});

describe('migration 20261020000000_alert_notes and the schema', () => {
  const NAME = '20261020000000_alert_notes';
  const SQL = read(`prisma/migrations/${NAME}/migration.sql`);
  const statements = SQL.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));
  const body = statements.join('\n');

  it("is on disk and sorts after every migration before it and after the parallel branch's 20261019180000 (later releases add theirs after it)", () => {
    const dirs = readdirSync(path.join(WEB, 'prisma/migrations')).filter((n) => /^\d{14}_/.test(n)).sort();
    // Review of the branch (20 Oct 2026), finding 14: never "the last on disk", which the next migration of any
    // feature would break; only its own order against the migrations it follows.
    expect(dirs).toContain(NAME);
    expect(dirs.indexOf(NAME)).toBeGreaterThan(dirs.indexOf('20261019120000_gps_site_radius_away'));
    expect(NAME > '20261019120000_gps_site_radius_away').toBe(true);
    expect(NAME > '20261019180000_sales_link').toBe(true);
    expect(SQL).toContain(`DELETE FROM "_prisma_migrations" WHERE migration_name = '${NAME}';`);
    expect(SQL).toMatch(/-- Rollback:/);
  });

  it('is additive: takes its locks without waiting first, then adds columns, foreign keys (SET NULL) and CHECKs only', () => {
    expect(statements.filter((l) => /^\s*(DROP|UPDATE|DELETE|TRUNCATE|INSERT)\b/i.test(l))).toEqual([]);
    expect(statements.filter((l) => /\b(DROP (COLUMN|TABLE|INDEX|CONSTRAINT|DEFAULT|NOT NULL)|ALTER COLUMN|RENAME)\b/i.test(l))).toEqual([]);
    const user = body.indexOf('LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE NOWAIT;');
    const alerts = body.indexOf('LOCK TABLE "OpsAlert" IN ACCESS EXCLUSIVE MODE NOWAIT;');
    const firstAlter = body.indexOf('ALTER TABLE');
    expect(user).toBeGreaterThan(0);
    expect(alerts).toBeGreaterThan(user);
    expect(firstAlter).toBeGreaterThan(alerts);
    expect(body).toContain('"OpsAlert_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL');
    expect(body).toContain('"OpsAlert_reviewFirstById_fkey" FOREIGN KEY ("reviewFirstById") REFERENCES "User"("id") ON DELETE SET NULL');
    expect(body).toContain('"reviewFollowUp" BOOLEAN NOT NULL DEFAULT false');
    expect(body).toContain('"reviewSaves" INTEGER NOT NULL DEFAULT 0');
  });

  it("checks the codes' format only (a new code needs no migration: critique item 9) and the app's lengths", () => {
    const re = ALERT_REVIEW_CODE_RE.source;
    expect(body).toContain(`CHECK ("reviewCause" IS NULL OR "reviewCause" ~ '${re}')`);
    expect(body).toContain(`CHECK ("reviewAction" IS NULL OR "reviewAction" ~ '${re}')`);
    expect(body).not.toMatch(/"reviewCause" IN \(/);
    expect(body).toContain(`char_length("reviewCauseOther") BETWEEN ${ALERT_REVIEW_OTHER_MIN} AND ${ALERT_REVIEW_OTHER_MAX}`);
    expect(body).toContain(`char_length("reviewActionOther") BETWEEN ${ALERT_REVIEW_OTHER_MIN} AND ${ALERT_REVIEW_OTHER_MAX}`);
    expect(body).toContain(`char_length("reviewNote") BETWEEN 1 AND ${ALERT_REVIEW_NOTE_MAX}`);
    expect(body).toMatch(/CONSTRAINT "OpsAlert_review_whole" CHECK/);
    expect(body).toMatch(/CONSTRAINT "OpsAlert_review_other" CHECK/);
    // An Other text may be missing only once the 90-day clean-up removed it.
    expect(body).toContain('"detailsRemovedAt" IS NOT NULL');
  });

  it('the schema has the columns, the two user relations and the clean-up marker', () => {
    const alert = block('OpsAlert');
    const nullable = ['reviewCause', 'reviewCauseOther', 'reviewAction', 'reviewActionOther', 'reviewNote', 'reviewFirstAt', 'reviewFirstById', 'reviewedAt', 'reviewedById', 'reviewGroupId', 'reviewTier', 'reviewOccurrences', 'reviewCustomerId', 'detailsRemovedAt'];
    for (const f of nullable) {
      expect(alert, f).toMatch(new RegExp(`\\n\\s+${f}\\s+\\w+\\?`));
      expect(body, f).toContain(`"${f}"`);
    }
    expect(alert).toMatch(/reviewFollowUp\s+Boolean\s+@default\(false\)/);
    expect(alert).toMatch(/reviewSaves\s+Int\s+@default\(0\)/);
    expect(alert).toMatch(/reviewedBy\s+User\?\s+@relation\("OpsAlertReviewedBy", fields: \[reviewedById\], references: \[id\], onDelete: SetNull\)/);
    expect(alert).toMatch(/reviewFirstBy\s+User\?\s+@relation\("OpsAlertFirstReviewedBy", fields: \[reviewFirstById\], references: \[id\], onDelete: SetNull\)/);
    expect(block('User')).toMatch(/opsAlertsReviewed\s+OpsAlert\[\]\s+@relation\("OpsAlertReviewedBy"\)/);
  });
});

describe('cause & action on the API row', () => {
  const base = {
    id: 'a1', tenantId: 't', depotId: 'D1', deliveryDate: new Date('2026-10-16T00:00:00Z'), rule: 'ETA_LATE', subjectKey: 'D1|2026-10-16|T1|1',
    truckId: 'T1', truckCode: 'T05', loadNo: 1, sequence: null, customerId: null, kind: 'CONDITION', severity: 'WARN', tier: 1, value: 35, threshold: 30,
    text: 'T05 L1 is running about 35 min late.', factsJson: null, mayToast: true, mayEmail: true,
    occurredAt: new Date('2026-10-16T05:10:00Z'), firstSeenAt: new Date('2026-10-16T05:12:00Z'), lastSeenAt: new Date('2026-10-16T05:30:00Z'),
    resolvedAt: null, resolvedReason: null, occurrences: 1, ackedAt: null, ackedById: null, emailedTier: 0, emailedAt: null, digestId: null, emailAttempts: 0, emailError: null,
    reviewCause: null, reviewCauseOther: null, reviewAction: null, reviewActionOther: null, reviewNote: null, reviewFollowUp: false, reviewFirstAt: null, reviewFirstById: null,
    reviewedAt: null, reviewedById: null, reviewSaves: 0, reviewGroupId: null, reviewTier: null, reviewOccurrences: null, reviewCustomerId: null, detailsRemovedAt: null,
  };

  it('none: review null; saved: the codes, texts, who and when by name, never a user id', () => {
    expect(toOpsAlertRow(base as never)).toMatchObject({ review: null, detailsRemoved: false });
    const r = toOpsAlertRow({
      ...base,
      reviewCause: 'OTHER', reviewCauseOther: 'Road closed', reviewAction: 'CALLED_DRIVER', reviewNote: 'Gate shut', reviewFollowUp: true,
      reviewFirstAt: new Date('2026-10-16T06:00:00Z'), reviewFirstById: 'u-first', reviewedAt: new Date('2026-10-16T07:00:00Z'), reviewedById: 'u-last', reviewSaves: 2,
      reviewGroupId: 'a1', reviewTier: 1, reviewOccurrences: 1, reviewCustomerId: null,
      reviewedBy: { name: 'Sam Example' }, reviewFirstBy: { name: 'Lee Example' },
    } as never);
    expect(r.review).toEqual({
      cause: 'OTHER', causeOther: 'Road closed', action: 'CALLED_DRIVER', actionOther: null, note: 'Gate shut', followUp: true,
      firstAt: '2026-10-16T06:00:00.000Z', savedAt: '2026-10-16T07:00:00.000Z', byName: 'Sam Example', firstByName: 'Lee Example', saves: 2,
      groupId: 'a1', tier: 1, occurrences: 1, customerId: null,
    });
    expect(JSON.stringify(r)).not.toMatch(/u-first|u-last|reviewedById|emailError|factsJson/);
    expect(toOpsAlertRow({ ...base, text: '', detailsRemovedAt: new Date() } as never).detailsRemoved).toBe(true);
  });

  it('the words: the cause & action line, Other with its text, the flags, and an alert whose details were removed', () => {
    const row = toOpsAlertRow({
      ...base, occurrences: 2, reviewCause: 'OTHER', reviewCauseOther: 'Road closed', reviewAction: 'CALLED_DRIVER', reviewFirstAt: new Date('2026-10-16T07:02:00Z'),
      reviewedAt: new Date('2026-10-16T07:02:00Z'), reviewSaves: 1, reviewTier: 1, reviewOccurrences: 1, reviewedBy: { name: 'Sam Example' },
    } as never);
    expect(alertReviewText(row, 'Asia/Muscat')).toBe('Cause: Other - Road closed · Action: Called the driver · Sam Example 11:02');
    expect(alertReviewText(row, 'Asia/Muscat', '2026-10-17')).toBe('Cause: Other - Road closed · Action: Called the driver · Sam Example Yesterday 11:02');
    expect(reviewCauseText({ cause: 'TRAFFIC', causeOther: null })).toBe('Traffic or road delay');
    expect(reviewActionText({ action: 'OTHER', actionOther: 'Sent a van' })).toBe('Other - Sent a van');
    expect(alertReviewFlags(row)).toEqual(['came back after it was saved']);
    expect(alertReviewText({ ...row, review: null }, 'Asia/Muscat')).toBe('');
    expect(alertText({ text: '' })).toBe('Details removed after 90 days');
    expect(alertText({ text: 'T05 L1' })).toBe('T05 L1');
  });
});
