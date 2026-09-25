/**
 * STABILIZATION PR5 review - migration 20260928090100_keep_imported_service_times, on real
 * PostgreSQL (DATABASE_URL, migrated; the web server and solver are not used).
 *
 * Since PR5 an unconfirmed customer unloading time no longer wins over the Settings default. The
 * migration keeps the times customer imports stored before PR2 without confirming them: it marks
 * them confirmed (with an audit row each), but only where the PR5 rule would change them. The
 * test runs the migration's own SQL, limited to a tenant of its own so it touches nothing else.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTenant, prisma, uniqueSuffix } from './helpers';

const MIGRATION = path.resolve(__dirname, '../../prisma/migrations/20260928090100_keep_imported_service_times/migration.sql');
const slug = `svc-mig-${uniqueSuffix()}`;
let tenantId = '';

/** The migration SQL limited to this test's tenant (the one extra condition; everything else as shipped). */
function scopedSql(): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const anchor = 'WHERE c."serviceTimeConfirmed" = false';
  expect(sql.split(anchor).length).toBe(2);
  return sql.replace(anchor, `WHERE c."tenantId" = '${tenantId}' AND c."serviceTimeConfirmed" = false`);
}

async function customer(code: string, data: { avgServiceTimeMin: number; serviceTimeConfirmed?: boolean; customerType?: 'HYPERMARKET' | 'GROCERY' | null }) {
  return prisma.customer.create({
    data: { tenantId, code, name: `Customer ${code}`, lat: 23.6, lng: 58.4, serviceTimeConfirmed: false, customerType: null, ...data },
  });
}

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug, name: `Service time ${slug}`, country: 'Oman' } });
  tenantId = t.id;
  await prisma.tenantConfig.create({ data: { tenantId, timezone: 'Asia/Muscat', defaultServiceTimeMin: 15 } });
  // HYPERMARKET has an unloading time of its own; GROCERY has a profile without one.
  await prisma.customerTypeProfile.create({ data: { tenantId, customerType: 'HYPERMARKET', serviceTimeMin: 40 } });
  await prisma.customerTypeProfile.create({ data: { tenantId, customerType: 'GROCERY', serviceTimeMin: null } });
});

afterAll(async () => {
  await cleanupTenant(slug);
  await prisma.$disconnect();
});

describe('migration: keep the unloading times earlier imports stored without confirming them', () => {
  it('confirms exactly the entered times the PR5 rule would replace, audits each, and is idempotent', async () => {
    const imported = await customer('IMP', { avgServiceTimeMin: 45 }); // untyped, from a pre-PR2 import
    const grocery = await customer('GRO', { avgServiceTimeMin: 30, customerType: 'GROCERY' }); // profile without a time
    const hyper = await customer('HYP', { avgServiceTimeMin: 25, customerType: 'HYPERMARKET' }); // the type's 40 applies, before and after
    const columnDefault = await customer('DEF', { avgServiceTimeMin: 10 }); // the column default: the Settings default applies
    const zero = await customer('ZER', { avgServiceTimeMin: 0 });
    const confirmed = await customer('CON', { avgServiceTimeMin: 50, serviceTimeConfirmed: true });

    const sql = scopedSql();
    await prisma.$executeRawUnsafe(sql);
    const rows = await prisma.customer.findMany({ where: { tenantId }, select: { id: true, avgServiceTimeMin: true, serviceTimeConfirmed: true } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(imported.id)).toMatchObject({ avgServiceTimeMin: 45, serviceTimeConfirmed: true });
    expect(byId.get(grocery.id)).toMatchObject({ avgServiceTimeMin: 30, serviceTimeConfirmed: true });
    expect(byId.get(hyper.id)!.serviceTimeConfirmed).toBe(false);
    expect(byId.get(columnDefault.id)!.serviceTimeConfirmed).toBe(false);
    expect(byId.get(zero.id)!.serviceTimeConfirmed).toBe(false);
    expect(byId.get(confirmed.id)).toMatchObject({ avgServiceTimeMin: 50, serviceTimeConfirmed: true });

    const audits = await prisma.auditLog.findMany({ where: { tenantId, entity: 'Customer', action: 'UPDATE' } });
    expect(audits.map((a) => a.entityId).sort()).toEqual([imported.id, grocery.id].sort());
    for (const a of audits) {
      expect(a.beforeJson).toMatchObject({ serviceTimeConfirmed: false });
      expect(a.afterJson).toMatchObject({ serviceTimeConfirmed: true, by: 'migration 20260928090100_keep_imported_service_times' });
      expect(a.id.startsWith('mig')).toBe(true);
    }

    // A second run changes nothing and writes no second audit row.
    expect(await prisma.$executeRawUnsafe(sql)).toBe(0);
    expect(await prisma.auditLog.count({ where: { tenantId, entity: 'Customer', action: 'UPDATE' } })).toBe(2);
  });
});
