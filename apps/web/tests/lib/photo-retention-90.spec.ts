/**
 * Owner decision 1 (5 Oct 2026): delivery photos are kept 90 DAYS (the default released on 4 Oct was
 * 365). The default is 90 in the schema, the code's fallbacks and Settings; migration
 * 20261005090000_driver_page_owner_decisions moves a company still on 365 to 90 (audited), and driver
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

describe('the migration (one, additive, audited)', () => {
  const sql = () => readFileSync(path.join(WEB, 'prisma', 'migrations', MIGRATION, 'migration.sql'), 'utf8');

  it('is the newest migration', () => {
    const dirs = readdirSync(path.join(WEB, 'prisma', 'migrations')).filter((d) => /^\d{14}_/.test(d)).sort();
    expect(dirs.at(-1)).toBe(MIGRATION);
  });

  it('sets the column default to 90 and moves only the companies still on 365, positions to at most 90, with an audit row each', () => {
    const s = sql();
    expect(s).toContain('ALTER TABLE "TenantConfig" ALTER COLUMN "photoRetentionDays" SET DEFAULT 90;');
    expect(s).toMatch(/WHERE "photoRetentionDays" = 365/);
    expect(s).toContain('"photoRetentionDays" = 90');
    expect(s).toContain('"locationRetentionDays" = LEAST(t."locationRetentionDays", 90)');
    expect(s).toMatch(/INSERT INTO "AuditLog"[\s\S]*'UPDATE',\s*'TenantConfig'/);
    // Additive otherwise: no DROP, no DELETE, no column made NOT NULL.
    expect(s).not.toMatch(/\bDROP\b|\bDELETE\b|SET NOT NULL/i);
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
