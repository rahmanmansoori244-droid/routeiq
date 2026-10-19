/**
 * The analysis dataset (owner request 19 Oct 2026), the day-0 contract: the Prisma models, the migration
 * 20261019090000_analysis_facts, the setting and the shared lists agree with each other.
 * - every new table: a tenantId with ON DELETE CASCADE, tenant-scoped (lib/tenant.ts) with a case in
 *   tests/tenant-isolation.spec.ts, and no latitude or longitude column (no raw position in these tables);
 * - the CHECKs are the lists and bounds of lib/analysis/types.ts, value for value: the retention 30-3650, the
 *   flags, the unload source, where the last depot IN came from, the GPS note, the JSON arrays of at most 8 KB,
 *   and no negative unloading (the study prototype's one-sided window clipping stored -49.6 min);
 * - the migration is additive and takes its locks without waiting first, with a rollback line for each object;
 * - the setting is the company admin's (never the dispatcher's), refused outside its bounds;
 * - the janitor runs the job in its own try before the GPS retention (the trail must still exist), the cron
 *   route last; Start fresh removes the facts of the days it clears.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tenantConfigSchema } from '@/lib/schemas';
import { DISPATCHER_SETTINGS_FIELDS, SETTINGS_FIELDS } from '@/lib/settings-fields';
import { START_FRESH_DELETE_ORDER } from '@/lib/start-fresh';
import { ANALYSIS_RETENTION_BOUNDS, DEFAULT_ANALYSIS_RETENTION_DAYS, FACT_JSON_MAX_BYTES, FACT_VISIT_FLAGS, GPS_NOTES, LAST_IN_FROM, UNLOAD_SOURCES } from '@/lib/analysis/types';

const WEB = path.resolve(__dirname, '../..');
const NAME = '20261019090000_analysis_facts';
const schema = readFileSync(path.join(WEB, 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
const migration = readFileSync(path.join(WEB, 'prisma', 'migrations', NAME, 'migration.sql'), 'utf8').replace(/\r\n/g, '\n');
const sql = migration
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');
const MODELS = ['FactTruckDay', 'FactVisit', 'FactLeg', 'FactDepotTurn'] as const;

function modelBlock(name: string): string {
  const start = schema.indexOf(`\nmodel ${name} {`);
  if (start < 0) throw new Error(`model ${name} is not in schema.prisma`);
  return schema.slice(start, schema.indexOf('\n}', start));
}
/** The values of a CHECK (... IN ('A', 'B')), by constraint name. */
function checkList(constraint: string): string[] {
  const m = new RegExp(`"${constraint}" CHECK \\([^;]*?IN \\(([^)]*)\\)`).exec(sql);
  if (!m) throw new Error(`no CHECK ${constraint} ... IN (...) in the migration`);
  return [...m[1]!.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]!);
}

describe('schema.prisma and the migration agree', () => {
  it('the migration sorts after every earlier one', () => {
    const dir = path.join(WEB, 'prisma', 'migrations');
    const folders = readdirSync(dir).filter((n) => statSync(path.join(dir, n)).isDirectory() && /^\d{14}_/.test(n)).sort();
    expect(folders.indexOf(NAME)).toBeGreaterThan(folders.indexOf('20261018130000_ivms_move_observed'));
  });

  it('every new table has a tenantId with ON DELETE CASCADE, is tenant-scoped with an isolation case, and has no position column', () => {
    const tenantTs = readFileSync(path.join(WEB, 'lib', 'tenant.ts'), 'utf8');
    const isolation = readFileSync(path.join(WEB, 'tests', 'tenant-isolation.spec.ts'), 'utf8');
    for (const m of MODELS) {
      const block = modelBlock(m);
      expect(block, m).toMatch(/\n\s+tenant\s+Tenant\s+@relation\(fields: \[tenantId\], references: \[id\], onDelete: Cascade\)/);
      expect(sql, m).toContain(`CREATE TABLE "${m}" (`);
      expect(sql, m).toContain(`ALTER TABLE "${m}" ADD CONSTRAINT "${m}_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE`);
      expect(tenantTs, m).toContain(`'${m}',`);
      expect(isolation, m).toContain(`.${m[0]!.toLowerCase()}${m.slice(1)}.`);
      // No raw position: no latitude or longitude column (a standing spot is a distance and a bearing from the pin).
      const fields = block.split('\n').map((l) => /^\s+(\w+)\s+\w/.exec(l)?.[1]).filter((f): f is string => !!f);
      expect(fields.filter((f) => /^(lat|lng|lon|latitude|longitude)$/i.test(f) || /(Lat|Lng)$/.test(f)), m).toEqual([]);
      expect(sql.slice(sql.indexOf(`CREATE TABLE "${m}" (`), sql.indexOf(');', sql.indexOf(`CREATE TABLE "${m}" (`)))).not.toMatch(/"(lat|lng)"|Lat"|Lng"/);
      // Every row keeps the settings it was built with.
      for (const f of ['serviceMinPerCase', 'reloadMinutes', 'stopRadiusM', 'dwellMin', 'detectorVersion', 'analysisVersion', 'builtAt', 'refreshedAt', 'frozenAt']) expect(fields, `${m}.${f}`).toContain(f);
    }
  });

  it('TenantConfig.analysisRetentionDays: 730 by default, CHECKed 30-3650 (lib/analysis/types.ts)', () => {
    expect(DEFAULT_ANALYSIS_RETENTION_DAYS).toBe(730);
    expect(sql).toContain(`ALTER TABLE "TenantConfig" ADD COLUMN     "analysisRetentionDays" INTEGER NOT NULL DEFAULT ${DEFAULT_ANALYSIS_RETENTION_DAYS};`);
    expect(modelBlock('TenantConfig')).toMatch(new RegExp(`\\n\\s+analysisRetentionDays\\s+Int\\s+@default\\(${DEFAULT_ANALYSIS_RETENTION_DAYS}\\)`));
    expect(sql).toContain(`"TenantConfig_analysisRetentionDays_range" CHECK ("analysisRetentionDays" BETWEEN ${ANALYSIS_RETENTION_BOUNDS.min} AND ${ANALYSIS_RETENTION_BOUNDS.max});`);
  });

  it('the value lists and bounds of the CHECKs are the lists of lib/analysis/types.ts', () => {
    expect(checkList('FactTruckDay_lastInFrom_check')).toEqual([...LAST_IN_FROM]);
    expect(checkList('FactTruckDay_gpsNote_check')).toEqual([...GPS_NOTES]);
    expect(checkList('FactVisit_unloadSource_check')).toEqual([...UNLOAD_SOURCES]);
    const flags = /"FactVisit_flags_check" CHECK \("flags" <@ ARRAY\[([^\]]*)\]::TEXT\[\]\)/.exec(sql);
    expect([...flags![1]!.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1])).toEqual([...FACT_VISIT_FLAGS]);
    for (const c of ['awayJson', 'substaysJson']) {
      expect(sql, c).toContain(`"FactVisit_${c}_shape" CHECK ("${c}" IS NULL OR (jsonb_typeof("${c}") = 'array' AND octet_length("${c}"::text) <= ${FACT_JSON_MAX_BYTES}))`);
    }
    // Never a negative unloading, wait, on-site or away minute (the window clipped on both sides).
    const nonneg = sql.slice(sql.indexOf('"FactVisit_minutes_nonneg"'), sql.indexOf(';', sql.indexOf('"FactVisit_minutes_nonneg"')));
    for (const c of ['waitMin', 'onSiteMin', 'awayMin', 'unloadSiteMin', 'unloadVisitMin', 'unloadTapMin', 'unloadMin', 'minPerCase']) expect(nonneg, c).toContain(`("${c}" IS NULL OR "${c}" >= 0)`);
    for (const m of MODELS) expect(sql, m).toContain(`"${m}_frozen_after_built" CHECK ("frozenAt" IS NULL OR "frozenAt" >= "builtAt")`);
  });

  it('is additive: no DROP, no rename, no type, enum or data change; the locks come first, without waiting; every object has a rollback line', () => {
    for (const re of [/\bDROP\b/i, /\bRENAME\b/i, /\bALTER\s+TYPE\b/i, /\bALTER\s+COLUMN\b/i, /\bUPDATE\s+"/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i, /\bINSERT\s+INTO\b/i]) {
      expect(sql, String(re)).not.toMatch(re);
    }
    expect(sql).toContain('LOCK TABLE "Tenant" IN SHARE ROW EXCLUSIVE MODE NOWAIT;');
    expect(sql).toContain('LOCK TABLE "TenantConfig" IN ACCESS EXCLUSIVE MODE NOWAIT;');
    expect(sql.indexOf('NOWAIT')).toBeLessThan(sql.indexOf('ALTER TABLE'));
    for (const m of MODELS) expect(migration, m).toContain(`DROP TABLE "${m}"`);
    expect(migration).toContain('DROP COLUMN "analysisRetentionDays"');
  });
});

describe('the setting, the janitor and Start fresh', () => {
  it('the retention is a company admin setting, refused outside 30-3650 days', () => {
    expect(SETTINGS_FIELDS as readonly string[]).toContain('analysisRetentionDays');
    expect(DISPATCHER_SETTINGS_FIELDS as readonly string[]).not.toContain('analysisRetentionDays');
    const p = tenantConfigSchema.partial();
    expect(p.safeParse({ analysisRetentionDays: 730 }).success).toBe(true);
    expect(p.safeParse({ analysisRetentionDays: 29 }).success).toBe(false);
    expect(p.safeParse({ analysisRetentionDays: 3651 }).success).toBe(false);
    expect(p.safeParse({ analysisRetentionDays: 365.5 }).success).toBe(false);
  });

  it('the in-process janitor runs the job in its own try before the GPS retention; the cron route runs it last, in its own step', () => {
    const loop = readFileSync(path.join(WEB, 'lib', 'jobs', 'janitor-loop.ts'), 'utf8');
    expect(loop).toMatch(/try \{\s+const facts = await runAnalysisJob\(\);[\s\S]*?\} catch \(err\) \{\s+console\.error\('janitor: analysis facts not built'/);
    expect(loop.indexOf('runAnalysisJob()')).toBeLessThan(loop.indexOf('runIvmsRetention()'));
    const cron = readFileSync(path.join(WEB, 'app', 'api', 'cron', 'janitor', 'route.ts'), 'utf8');
    expect(cron).toContain("await step('analysis', () => runAnalysisJob(new Date(), { force: true }))");
    expect(cron.indexOf("step('analysis'")).toBeGreaterThan(cron.indexOf("step('alerts'"));
    expect(cron).toContain('...(analysis ? { analysis } : {})');
  });

  it('Start fresh removes the facts of the days it clears (after the alerts, before the daily drivers)', () => {
    const order = START_FRESH_DELETE_ORDER as readonly string[];
    for (const m of ['factVisit', 'factLeg', 'factDepotTurn', 'factTruckDay']) expect(order, m).toContain(m);
    expect(order.indexOf('factVisit')).toBeGreaterThan(order.indexOf('opsAlert'));
    expect(order.indexOf('factTruckDay')).toBeLessThan(order.indexOf('driver'));
  });
});
