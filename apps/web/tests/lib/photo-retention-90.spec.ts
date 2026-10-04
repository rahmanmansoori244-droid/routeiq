/**
 * Owner decision 1 (5 Oct 2026): delivery photos are kept 90 DAYS (the driver-page migration said 365
 * until then). The default is 90 in the schema, the code's fallbacks, Settings and the driver-page
 * migration itself (20261004090000, not in production yet); 20261005090000_driver_page_owner_decisions
 * moves a company still on 365 to 90 only on a database where 20261004090000 already ran with 365,
 * never one whose admin saved the field in Settings (audited like a Settings save), and driver
 * positions are never kept longer than the photos (the Settings rule and the janitor's clamp).
 * Synthetic data only; the janitor runs on the in-memory database (fake-plan-db.ts).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, row, tables } from './fake-plan-db';

vi.mock('@/lib/db', async () => ({ prisma: (await import('./fake-plan-db')).fakePrisma }));
vi.mock('@/lib/audit', async () => {
  const m = await import('./fake-plan-db');
  return { audit: vi.fn(async (input: Record<string, unknown>) => m.fakePrisma.auditLog.create({ data: { ...input } })) };
});

import { DEFAULT_LOCATION_RETENTION_DAYS, DEFAULT_PHOTO_RETENTION_DAYS, DELIVERY_SETTING_BOUNDS, retentionSaveProblem } from '@/lib/settings-fields';
import { purgeOldLocations, purgeOldPhotos } from '@/lib/jobs/delivery-janitor';

const WEB = path.resolve(__dirname, '../..');
const MIGRATION = '20261005090000_driver_page_owner_decisions';
const DRIVER_PAGE_MIGRATION = '20261004090000_delivery_outcome_driver_page';
const NO_PHOTO_MIGRATION = '20261005100000_results_without_photo';
const NOW = new Date('2027-01-10T08:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60_000);

describe('the default is 90 days', () => {
  it('the code default, the schema default and the bounds', () => {
    expect(DEFAULT_PHOTO_RETENTION_DAYS).toBe(90);
    expect(DEFAULT_LOCATION_RETENTION_DAYS).toBe(90);
    expect(DEFAULT_LOCATION_RETENTION_DAYS).toBeLessThanOrEqual(DEFAULT_PHOTO_RETENTION_DAYS);
    // An admin can still choose 30 to 1095 days.
    expect(DELIVERY_SETTING_BOUNDS.photoRetentionDays).toEqual({ min: 30, max: 1095 });
    const schema = readFileSync(path.join(WEB, 'prisma', 'schema.prisma'), 'utf8');
    expect(schema).toMatch(/photoRetentionDays\s+Int\s+@default\(90\)/);
    expect(schema).toMatch(/locationRetentionDays\s+Int\s+@default\(90\)/);
  });

  it('no code path falls back to 365 days of photos any more', () => {
    for (const f of ['lib/jobs/delivery-janitor.ts', 'lib/delivery/office-service.ts']) {
      const src = readFileSync(path.join(WEB, f), 'utf8');
      expect(src, f).not.toMatch(/photoRetentionDays \?\? 365/);
      expect(src, f).toContain('DEFAULT_PHOTO_RETENTION_DAYS');
    }
  });

  it('positions are never kept longer than the photos (the Settings rule)', () => {
    expect(retentionSaveProblem({ photoRetentionDays: 90 }, { photoRetentionDays: 90, locationRetentionDays: 90 })).toBeNull();
    expect(retentionSaveProblem({ locationRetentionDays: 120 }, { photoRetentionDays: 90, locationRetentionDays: 120 })).toMatch(/cannot be kept longer than the delivery photos \(90 days\)/);
  });
});

describe('the migrations (additive, audited)', () => {
  const read = (m: string) => readFileSync(path.join(WEB, 'prisma', 'migrations', m, 'migration.sql'), 'utf8');
  const sql = () => read(MIGRATION);

  it("this branch's two migrations follow the driver-page migration, in order (later releases add theirs after them)", () => {
    const dirs = readdirSync(path.join(WEB, 'prisma', 'migrations')).filter((d) => /^\d{14}_/.test(d)).sort();
    const at = dirs.indexOf(DRIVER_PAGE_MIGRATION);
    expect(dirs.slice(at, at + 3)).toEqual([DRIVER_PAGE_MIGRATION, MIGRATION, NO_PHOTO_MIGRATION]);
  });

  it('the driver-page migration creates the column at 90 (both ship in one deploy: no company ever has 365, no audit row is written)', () => {
    expect(read(DRIVER_PAGE_MIGRATION)).toContain('ADD COLUMN     "photoRetentionDays" INTEGER NOT NULL DEFAULT 90;');
    expect(read(DRIVER_PAGE_MIGRATION)).not.toMatch(/DEFAULT 365/);
  });

  it('where the driver-page migration already ran with 365: the default goes to 90, companies still on 365 move, positions to at most 90', () => {
    const s = sql();
    expect(s).toContain('ALTER TABLE "TenantConfig" ALTER COLUMN "photoRetentionDays" SET DEFAULT 90;');
    expect(s).toMatch(/WHERE c\."photoRetentionDays" = 365/);
    expect(s).toContain('"photoRetentionDays" = 90');
    expect(s).toContain('"locationRetentionDays" = LEAST(t."locationRetentionDays", 90)');
    // Additive otherwise: no DROP, no DELETE, no column made NOT NULL.
    expect(s).not.toMatch(/\bDROP\b|\bDELETE\b|SET NOT NULL/i);
  });

  it("never a company whose admin saved \"Keep delivery photos\" in Settings (an explicit 365 stays): the audited Settings save of the field is checked", () => {
    const s = sql().replace(/\s+/g, ' ');
    expect(s).toContain(
      `AND NOT EXISTS ( SELECT 1 FROM "AuditLog" a WHERE a."tenantId" = c."tenantId" AND a."entity" = 'TenantConfig' AND a."afterJson" -> 'config' -> 'photoRetentionDays' IS NOT NULL )`,
    );
  });

  it('each change is audited the way a Settings save is: entityId = the company, { tenant, config } with the changed fields, made by the migration', () => {
    const s = sql().replace(/\s+/g, ' ');
    expect(s).toMatch(/INSERT INTO "AuditLog" .* 'UPDATE', 'TenantConfig', c\."tenantId", jsonb_build_object\( 'tenant', '\{\}'::jsonb, 'config', jsonb_build_object\('photoRetentionDays', 365\)/);
    expect(s).toContain(`'config', jsonb_build_object('photoRetentionDays', 90)`);
    expect(s).toContain(`'by', 'migration 20261005090000 (owner decision of 5 Oct 2026: photos 90 days)'`);
    // Not the TenantConfig row id, as the first version wrote.
    expect(s).not.toMatch(/'TenantConfig', c\."id"/);
  });

  it('the no-photo monitor migration only adds the driver columns of StopVisit and fills them from the driver events', () => {
    const s = read(NO_PHOTO_MIGRATION);
    for (const c of ['"driverNoPhotoReason" TEXT', '"driverPhotoKeys" INTEGER NOT NULL DEFAULT 0', '"driverResultAt" TIMESTAMPTZ(3)', '"driverResultOutcome" "DeliveryOutcome"']) expect(s).toContain(c);
    expect(s).toContain(`e."source" <> 'DISPATCHER'`);
    expect(s).not.toMatch(/\bDROP\b|\bDELETE\b|SET NOT NULL/i);
    // Only the new columns are written.
    const set = s.slice(s.indexOf('SET "driverResultAt"'), s.indexOf('FROM last'));
    expect([...set.matchAll(/"(\w+)" =/g)].map((m) => m[1])).toEqual(['driverResultAt', 'driverResultOutcome', 'driverNoPhotoReason', 'driverPhotoKeys']);
  });

  it('adds the depot dispatcher phone as a nullable column (decision 3)', () => {
    expect(sql()).toContain('ALTER TABLE "Depot" ADD COLUMN     "dispatcherPhone" TEXT;');
  });
});

describe('the janitor with 90 days', () => {
  beforeEach(() => {
    resetDb();
    tables.auditLog = [];
  });

  it('a company on the default keeps photos 90 days: a photo received 91 days ago loses its bytes, one of 89 days stays', async () => {
    tables.tenantConfig = [{ tenantId: 'tA', photoRetentionDays: 90, locationRetentionDays: 90, timezone: 'Asia/Muscat' }];
    tables.deliveryPhoto = [
      { id: 'p91', tenantId: 'tA', receivedAt: daysAgo(91), bytes: Buffer.from([1]), purgedAt: null, distanceM: 20 },
      { id: 'p89', tenantId: 'tA', receivedAt: daysAgo(89), bytes: Buffer.from([2]), purgedAt: null, distanceM: 25 },
    ];
    expect(await purgeOldPhotos(NOW)).toEqual({ count: 1 });
    expect(row('deliveryPhoto', 'p91')).toMatchObject({ bytes: null, distanceM: 20 });
    expect(row('deliveryPhoto', 'p89').bytes).not.toBeNull();
    expect(tables.auditLog[0]!.afterJson).toEqual({ count: 1, olderThanDays: 90 });
  });

  it('a settings row without values (an old row read before the migration) is read as 90 days, never 365', async () => {
    tables.tenantConfig = [{ tenantId: 'tA', photoRetentionDays: null, locationRetentionDays: null, timezone: 'Asia/Muscat' }];
    tables.deliveryPhoto = [{ id: 'p100', tenantId: 'tA', receivedAt: daysAgo(100), bytes: Buffer.from([1]), purgedAt: null, distanceM: 20 }];
    expect(await purgeOldPhotos(NOW)).toEqual({ count: 1 });
  });

  it('positions with a 200-day setting and 90 days of photos are erased after 90 days (the clamp)', async () => {
    tables.tenantConfig = [{ tenantId: 'tA', photoRetentionDays: 90, locationRetentionDays: 200, timezone: 'Asia/Muscat' }];
    tables.stopEvent = [{ id: 'e1', tenantId: 'tA', receivedAt: daysAgo(95), lat: 23.6, lng: 58.4, distanceM: 3, payloadJson: null }];
    expect((await purgeOldLocations(NOW)).events).toBe(1);
    expect(tables.auditLog[0]!.afterJson).toMatchObject({ olderThanDays: 90 });
  });
});
