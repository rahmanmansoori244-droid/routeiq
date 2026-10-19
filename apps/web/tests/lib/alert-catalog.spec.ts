/**
 * Operations alerts (owner request 16 Oct 2026), the day-0 contract: lib/alerts/catalog.ts (the rules,
 * their defaults, bounds, tiers and delivery), lib/alerts/types.ts (row states and the API row), the
 * settings fields, and migration 20261016180000_ops_alerts (the column defaults and CHECKs repeat the
 * catalog). Names are invented (public repository).
 */
import { readFileSync } from 'node:fs';
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
  it('catalog.ts and types.ts import no server module', () => {
    for (const f of ['lib/alerts/catalog.ts', 'lib/alerts/types.ts']) {
      const imports = [...read(f).matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)].map((m) => ({ typeOnly: !!m[1], from: m[2]! }));
      for (const i of imports) {
        if (i.from === '@prisma/client') expect(i.typeOnly, `${f}: ${i.from}`).toBe(true);
        else expect(['./catalog', '../dispatch/time'], `${f}: ${i.from}`).toContain(i.from);
      }
    }
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
