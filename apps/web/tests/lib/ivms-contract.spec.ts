/**
 * IVMS live link (16 Oct 2026), the day-0 contract: the Prisma models, the migration, the settings and
 * the shared lists agree with each other, and nothing existing can see the new data.
 * - prisma/schema.prisma <-> migration 20261016200000_ivms_live: every new table and column, the defaults
 *   and the CHECKs (bounds and value lists = lib/ivms/settings.ts and lib/ivms/types.ts);
 * - the migration is additive (no DROP, no data change, no enum change) and takes its locks without waiting;
 * - every IVMS column on an existing model is hidden from every read (lib/db.ts PRISMA_GLOBAL_OMIT), so
 *   no existing response, page, sheet, export or audit row changes and no lower role sees an IMEI;
 * - every new model is tenant-scoped (lib/tenant.ts) and has a case in tests/tenant-isolation.spec.ts;
 * - the IVMS settings are company-admin only, OFF by default, and refused outside the bounds;
 * - the API key's module is server only, and no IVMS file holds an IMEI-like number.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRISMA_GLOBAL_OMIT, prisma } from '@/lib/db';
import { tenantConfigSchema } from '@/lib/schemas';
import { adminOnlyFields, DISPATCHER_SETTINGS_FIELDS, SETTINGS_FIELDS } from '@/lib/settings-fields';
import { IVMS_SETTING_BOUNDS, IVMS_SETTING_DEFAULTS, IVMS_SETTINGS_FIELDS, ivmsHoursSaveProblem, ivmsModeAtLeast, ivmsModeOf } from '@/lib/ivms/settings';
import { AYUN_COMMANDS, CALL_CLASS_COUNTER, FIX_FLAGS, IVMS_CALL_CLASSES, IVMS_EVENT_KINDS, IVMS_EVENT_ORIGINS, IVMS_MODES, IVMS_SUPPRESS_REASONS } from '@/lib/ivms/types';

const WEB = path.resolve(__dirname, '../..');
const MIGRATION_NAME = '20261016200000_ivms_live';
const schema = readFileSync(path.join(WEB, 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
const migration = readFileSync(path.join(WEB, 'prisma', 'migrations', MIGRATION_NAME, 'migration.sql'), 'utf8').replace(/\r\n/g, '\n');
/** The migration without its comment lines. */
const sql = migration
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

const NEW_MODELS = ['TruckPosition', 'TruckTrailPoint', 'IvmsEvent', 'IvmsState', 'IvmsTruckDay'] as const;

function modelBlock(name: string): string {
  const start = schema.indexOf(`\nmodel ${name} {`);
  if (start < 0) throw new Error(`model ${name} is not in schema.prisma`);
  return schema.slice(start, schema.indexOf('\n}', start));
}
/** The scalar fields of a model whose name starts with `ivms` (relations excluded). */
function ivmsScalars(model: string): string[] {
  return modelBlock(model)
    .split('\n')
    .map((l) => /^\s+(ivms\w*)\s+(String|Int|Float|Boolean|DateTime)\??(\s|$)/.exec(l)?.[1])
    .filter((f): f is string => !!f);
}
/** The values of a CHECK (... IN ('A', 'B')) constraint, by constraint name. */
function checkList(constraint: string): string[] {
  const m = new RegExp(`"${constraint}" CHECK \\([^)]*?IN \\(([^)]*)\\)`).exec(sql);
  if (!m) throw new Error(`no CHECK ${constraint} ... IN (...) in the migration`);
  return [...m[1]!.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]!);
}

describe('schema.prisma and the migration agree', () => {
  it('the migration sorts after every earlier one, at or after the agreed 20261016200000', () => {
    const dir = path.join(WEB, 'prisma', 'migrations');
    const folders = readdirSync(dir).filter((n) => statSync(path.join(dir, n)).isDirectory() && /^\d{14}_/.test(n)).sort();
    expect(folders.indexOf(MIGRATION_NAME)).toBeGreaterThan(folders.indexOf('20261016090000_customer_loading_instruction'));
    expect(MIGRATION_NAME >= '20261016200000').toBe(true);
  });

  it('every new model has a table, a tenantId with ON DELETE CASCADE, and is tenant-scoped with an isolation case', () => {
    const tenantTs = readFileSync(path.join(WEB, 'lib', 'tenant.ts'), 'utf8');
    const isolation = readFileSync(path.join(WEB, 'tests', 'tenant-isolation.spec.ts'), 'utf8');
    for (const m of NEW_MODELS) {
      const block = modelBlock(m);
      expect(block, m).toMatch(/\n\s+tenant\s+Tenant\s+@relation\(fields: \[tenantId\], references: \[id\], onDelete: Cascade\)/);
      expect(sql, m).toContain(`CREATE TABLE "${m}" (`);
      expect(sql, m).toContain(`ALTER TABLE "${m}" ADD CONSTRAINT "${m}_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE`);
      expect(tenantTs, m).toContain(`'${m}',`);
      expect(isolation, m).toContain(`.${m[0]!.toLowerCase()}${m.slice(1)}.`);
    }
  });

  it('the IVMS columns of existing models are added by the migration, nullable or with a constant default', () => {
    expect(ivmsScalars('Truck')).toEqual(['ivmsImei']);
    expect(ivmsScalars('Depot')).toEqual(['ivmsZoneName']);
    expect(ivmsScalars('TenantConfig')).toEqual([...IVMS_SETTINGS_FIELDS]);
    expect(sql).toContain('ALTER TABLE "Truck" ADD COLUMN     "ivmsImei" TEXT;');
    expect(sql).toContain('ALTER TABLE "Depot" ADD COLUMN     "ivmsZoneName" TEXT;');
    for (const f of IVMS_SETTINGS_FIELDS) {
      const d = IVMS_SETTING_DEFAULTS[f];
      expect(sql, f).toMatch(new RegExp(`ADD COLUMN\\s+"${f}" (INTEGER|TEXT) NOT NULL DEFAULT ${typeof d === 'string' ? `'${d}'` : d}[,;]`));
      expect(modelBlock('TenantConfig'), f).toMatch(new RegExp(`\\n\\s+${f}\\s+(Int|String)\\s+@default\\(${typeof d === 'string' ? `"${d}"` : d}\\)`));
    }
  });

  it('the settings CHECKs are the bounds of lib/ivms/settings.ts, value for value', () => {
    for (const [k, b] of Object.entries(IVMS_SETTING_BOUNDS)) {
      expect(sql, k).toContain(`"TenantConfig_${k}_range" CHECK ("${k}" BETWEEN ${b.min} AND ${b.max});`);
    }
    expect(sql).toContain('"TenantConfig_ivmsHours_order" CHECK ("ivmsToMin" > "ivmsFromMin");');
  });

  it('the value lists of the CHECKs are the lists of lib/ivms/types.ts', () => {
    expect(checkList('TenantConfig_ivmsMode_check')).toEqual([...IVMS_MODES]);
    expect(checkList('IvmsEvent_kind_check')).toEqual([...IVMS_EVENT_KINDS]);
    expect(checkList('IvmsEvent_origin_check')).toEqual([...IVMS_EVENT_ORIGINS]);
    expect([...sql.matchAll(/ARRAY\[([^\]]*)\]::TEXT\[\]\)/g)].map((m) => [...m[1]!.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]))).toEqual([[...FIX_FLAGS]]);
    expect(/"suppressReason" IN \(([^)]*)\)/.exec(sql)![1]!.match(/[A-Z_]+/g)).toEqual([...IVMS_SUPPRESS_REASONS]);
    // A tracker IMEI is digits only and never on a one-day hired truck.
    expect(sql).toContain(`"Truck_ivmsImei_format" CHECK ("ivmsImei" IS NULL OR "ivmsImei" ~ '^[0-9]{10,20}$')`);
    expect(sql).toContain('"Truck_ivmsImei_not_one_day" CHECK ("ivmsImei" IS NULL OR "onlyOnDate" IS NULL)');
    // The stored error is a kind code only: never a URL, a key or a body.
    expect(sql).toContain(`("lastError" IS NULL OR "lastError" ~ '^[A-Z0-9_]{1,40}$')`);
  });

  it('one counter per call class (H2: no class starves another), and every allowed command has a class', () => {
    const state = modelBlock('IvmsState');
    for (const c of IVMS_CALL_CLASSES) expect(state, c).toMatch(new RegExp(`\\n\\s+${CALL_CLASS_COUNTER[c]}\\s+Int\\s+@default\\(0\\)`));
    expect(new Set(Object.values(AYUN_COMMANDS))).toEqual(new Set(IVMS_CALL_CLASSES));
    expect(Object.keys(AYUN_COMMANDS)).not.toContain('USER_GET_API_KEY');
  });

  it('is additive: no DROP, no rename, no type or enum change, no data change; the locks are taken without waiting first', () => {
    for (const re of [/\bDROP\b/i, /\bRENAME\b/i, /\bALTER\s+TYPE\b/i, /\bALTER\s+COLUMN\b/i, /\bUPDATE\s+"/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i, /\bINSERT\s+INTO\b/i]) {
      expect(sql, String(re)).not.toMatch(re);
    }
    expect(sql).toContain('LOCK TABLE "TenantConfig", "Depot", "Truck" IN ACCESS EXCLUSIVE MODE NOWAIT;');
    expect(sql).toContain('LOCK TABLE "Tenant" IN SHARE ROW EXCLUSIVE MODE NOWAIT;');
    // The locks come before the first change.
    expect(sql.indexOf('NOWAIT')).toBeLessThan(sql.indexOf('ALTER TABLE'));
    // Every object has a rollback line.
    for (const m of NEW_MODELS) expect(migration, m).toContain(`DROP TABLE "${m}"`);
    for (const c of ['ivmsImei', 'ivmsZoneName', ...IVMS_SETTINGS_FIELDS]) expect(migration, c).toContain(`DROP COLUMN "${c}"`);
  });
});

describe('no existing read can see an IVMS column (Prisma global omit)', () => {
  it('every IVMS column of an existing model is in PRISMA_GLOBAL_OMIT', () => {
    const existing = [...schema.matchAll(/\nmodel (\w+) \{/g)].map((m) => m[1]!).filter((m) => !(NEW_MODELS as readonly string[]).includes(m) && m !== 'TenantConfig');
    const columns = existing.flatMap((m) => ivmsScalars(m).map((f) => `${m[0]!.toLowerCase()}${m.slice(1)}.${f}`));
    const omitted = Object.entries(PRISMA_GLOBAL_OMIT).flatMap(([m, fields]) => Object.keys(fields).map((f) => `${m}.${f}`));
    expect(omitted.sort()).toEqual(columns.sort());
    expect(columns).toEqual(expect.arrayContaining(['truck.ivmsImei', 'depot.ivmsZoneName']));
  });

  it('the app client is built with it, and the generator has the omit preview feature', () => {
    // Prisma 5.22 keeps the constructor's omit here; the real queries are checked against the database in
    // tests/integration/ivms-omit-db.spec.ts.
    expect((prisma as unknown as { _globalOmit?: unknown })._globalOmit).toEqual(PRISMA_GLOBAL_OMIT);
    expect(schema).toMatch(/generator client \{[^}]*previewFeatures = \["omitApi"\]/);
  });
});

describe('the IVMS settings', () => {
  it('are on Settings, company admin only (never a dispatcher field)', () => {
    for (const f of IVMS_SETTINGS_FIELDS) {
      expect(SETTINGS_FIELDS, f).toContain(f);
      expect(DISPATCHER_SETTINGS_FIELDS as readonly string[], f).not.toContain(f);
      expect(adminOnlyFields({}, { [f]: IVMS_SETTING_DEFAULTS[f] }), f).toEqual([f]);
    }
  });

  it('OFF by default; the schema accepts the defaults and every bound, and refuses anything outside them', () => {
    expect(IVMS_SETTING_DEFAULTS.ivmsMode).toBe('OFF');
    const p = tenantConfigSchema.partial();
    expect(p.safeParse({ ...IVMS_SETTING_DEFAULTS }).success).toBe(true);
    for (const m of IVMS_MODES) expect(p.safeParse({ ivmsMode: m }).success, m).toBe(true);
    for (const m of ['ALERTS', 'off', '', null, 1]) expect(p.safeParse({ ivmsMode: m }).success, String(m)).toBe(false);
    for (const [k, b] of Object.entries(IVMS_SETTING_BOUNDS)) {
      expect(p.safeParse({ [k]: b.min }).success, `${k} min`).toBe(true);
      expect(p.safeParse({ [k]: b.max }).success, `${k} max`).toBe(true);
      expect(p.safeParse({ [k]: b.min - 1 }).success, `${k} below`).toBe(false);
      expect(p.safeParse({ [k]: b.max + 1 }).success, `${k} above`).toBe(false);
      expect(p.safeParse({ [k]: b.min + 0.5 }).success, `${k} fraction`).toBe(false);
    }
  });

  it('the modes step up OFF < MAP < TIMES; anything unknown reads as OFF', () => {
    expect(IVMS_MODES).toEqual(['OFF', 'MAP', 'TIMES']);
    expect(ivmsModeOf(null)).toBe('OFF');
    expect(ivmsModeOf({})).toBe('OFF');
    expect(ivmsModeOf({ ivmsMode: 'ALERTS' })).toBe('OFF');
    expect(ivmsModeOf({ ivmsMode: 'TIMES' })).toBe('TIMES');
    expect(ivmsModeAtLeast('OFF', 'MAP')).toBe(false);
    expect(ivmsModeAtLeast('MAP', 'MAP')).toBe(true);
    expect(ivmsModeAtLeast('TIMES', 'MAP')).toBe(true);
    expect(ivmsModeAtLeast('MAP', 'TIMES')).toBe(false);
    expect(ivmsModeAtLeast('OFF', 'OFF')).toBe(true);
  });

  it('operating hours never cross midnight, checked only on a save that changes them', () => {
    expect(ivmsHoursSaveProblem({ ivmsToMin: 300 }, { ivmsFromMin: 300, ivmsToMin: 300 })).toMatch(/must be after the start/);
    expect(ivmsHoursSaveProblem({ ivmsFromMin: 1400 }, { ivmsFromMin: 1400, ivmsToMin: 120 })).toMatch(/across midnight/);
    expect(ivmsHoursSaveProblem({ ivmsFromMin: 360 }, { ivmsFromMin: 360, ivmsToMin: 1380 })).toBeNull();
    expect(ivmsHoursSaveProblem({ ivmsMode: 'MAP' }, { ivmsFromMin: 1400, ivmsToMin: 120 })).toBeNull();
  });
});

describe('the API key stays on the server, and no IVMS file holds real-looking identifiers', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next') continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  };
  const rel = (f: string) => path.relative(WEB, f).split(path.sep).join('/');

  it("no 'use client' module imports lib/ivms/env (the key's module), and only it reads process.env under lib/ivms", () => {
    const clientFiles = ['app', 'components', 'lib'].flatMap((d) => walk(path.join(WEB, d))).filter((f) => /^\s*['"]use client['"]/m.test(readFileSync(f, 'utf8')));
    expect(clientFiles.length).toBeGreaterThan(0);
    expect(clientFiles.filter((f) => /ivms\/env['"]/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([]);
    const ivmsLib = walk(path.join(WEB, 'lib', 'ivms'));
    expect(ivmsLib.filter((f) => readFileSync(f, 'utf8').includes('process.env') && !f.endsWith(`${path.sep}env.ts`)).map(rel)).toEqual([]);
  });

  it('no run of 10 or more digits (an IMEI, a phone, a plate number) in lib/ivms, the IVMS specs or the migration, except the vendor documentation dummies', () => {
    const DUMMIES = new Set(['111111111111111', '222222222222222']);
    const files = [
      ...walk(path.join(WEB, 'lib', 'ivms')),
      ...readdirSync(path.join(WEB, 'tests', 'lib')).filter((f) => f.startsWith('ivms-')).map((f) => path.join(WEB, 'tests', 'lib', f)),
      path.join(WEB, 'prisma', 'migrations', MIGRATION_NAME, 'migration.sql'),
    ];
    // A migration timestamp (14 digits, 20YYMMDDhhmmss) is not an identifier.
    const timestamp = /^20\d{12}$/;
    const hits = files.flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/(?<![\d.])\d{10,}(?![\d.])/g)]
        .filter((m) => !DUMMIES.has(m[0]) && !timestamp.test(m[0]))
        .map((m) => `${rel(f)}: ${m[0]}`),
    );
    expect(hits).toEqual([]);
  });
});
