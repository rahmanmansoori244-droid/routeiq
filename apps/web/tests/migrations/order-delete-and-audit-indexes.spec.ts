/**
 * Migration test for 20261009090000_order_delete_and_audit_indexes (reviews db-schema-1 and
 * db-schema-2), on a real, throwaway PostgreSQL database.
 *
 * It creates the database, applies every migration up to 20261007090000_driver_leave with
 * `prisma migrate deploy` (the command production runs), adds a company with plan history in small
 * (2,000 orders, 10 plan versions that each copy all the stops, a manual baseline, audit rows with
 * JSON) and a wrong order file that was never optimized, then applies the new migration the same
 * way. Migrations added after it are not applied (./folders.ts). It checks that:
 *   - the four indexes exist, are valid and have the columns of prisma/schema.prisma (no drift);
 *   - every foreign key to "Order" or "UploadBatch" (the keys an order-file delete makes PostgreSQL
 *     check) has an index that starts with its column; before the migration three had none;
 *   - deleting the wrong file's orders, as DELETE /api/orders/:batchId does, finds its plan stops
 *     and baseline rows through the indexes: no full read of "RouteAssignment" per order deleted
 *     (the transaction's own table statistics);
 *   - the Audit log page's per-user counts, as Prisma sends them, read the new index alone, and
 *     the audit API's filter by user reads that user's newest rows from it;
 *   - running the migration's SQL a second time succeeds and changes nothing.
 *
 * Skipped unless MIGRATION_TEST_DB_ADMIN_URL is set, like ./orders-always-have-depot.spec.ts (the
 * same throwaway database name rules: ./db-name.ts; the spec files run one after the other). From
 * apps/web:
 *
 *   MIGRATION_TEST_DB_ADMIN_URL=postgresql://USER:PASSWORD@localhost:5432/postgres \
 *   pnpm exec vitest run tests/migrations
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATION_TEST_DB_NAME, migrationTestDbName } from './db-name';
import { migrationFoldersBefore } from './folders';

const ADMIN_URL = process.env.MIGRATION_TEST_DB_ADMIN_URL ?? '';
// Checked in beforeAll (migrationTestDbName), before anything is dropped.
const DB_NAME = process.env.MIGRATION_TEST_DB_NAME ?? DEFAULT_MIGRATION_TEST_DB_NAME;
const NEW = '20261009090000_order_delete_and_audit_indexes';
const LAST_BEFORE = '20261007090000_driver_leave';
const WEB = path.join(__dirname, '../..');
const MIGRATIONS = path.join(WEB, 'prisma', 'migrations');
const PRISMA_CLI = path.join(WEB, 'node_modules', 'prisma', 'build', 'index.js');

/** The indexes the migration adds, as prisma/schema.prisma names them. */
const INDEXES = [
  { name: 'AuditLog_tenantId_userId_createdAt_idx', table: 'AuditLog', columns: ['tenantId', 'userId', 'createdAt'] },
  { name: 'ManualBaselineAssignment_orderId_idx', table: 'ManualBaselineAssignment', columns: ['orderId'] },
  { name: 'Order_uploadBatchId_idx', table: 'Order', columns: ['uploadBatchId'] },
  { name: 'RouteAssignment_orderId_idx', table: 'RouteAssignment', columns: ['orderId'] },
];
const ORDERS = 2000;
const VERSIONS = 10;
const WRONG = 50;

function dbUrl(name: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  u.search = '?schema=public';
  return u.toString();
}

let tmp = '';
let admin: PrismaClient;
let db: PrismaClient;
let deploy = { status: -1, out: '' };
let unindexedBefore: unknown[] = [];

/**
 * The Prisma CLI of this repo, as production runs it. The schema names its own URL variable, so the
 * app's DATABASE_URL is never used; the working directory is outside the temporary folder.
 */
const cli = () => ({ cwd: os.tmpdir(), env: { ...process.env, MIGRATION_TEST_DATABASE_URL: dbUrl(DB_NAME) } });

function run(args: string[]) {
  return spawnSync(process.execPath, [PRISMA_CLI, ...args], { ...cli(), encoding: 'utf8', timeout: 240_000 });
}
const prisma = (args: string[]) => run([...args, '--schema', path.join(tmp, 'schema.prisma')]);

/** A logged query with its parameters written in, for EXPLAIN. */
function inline(sql: string, params: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (_, n) => {
    const p = params[Number(n) - 1];
    return typeof p === 'number' ? String(p) : `'${String(p).replace(/'/g, "''")}'`;
  });
}

const q = async <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => (await db.$queryRawUnsafe(sql, ...params)) as T[];
const x = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);

/** Foreign keys to "Order" or "UploadBatch" whose column starts no valid index of its table. */
const UNINDEXED_ORDER_KEYS = `
  SELECT child.relname AS "table", a.attname AS "column", parent.relname AS "references"
    FROM pg_constraint c
    JOIN pg_class child ON child.oid = c.conrelid
    JOIN pg_class parent ON parent.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f' AND parent.relname IN ('Order', 'UploadBatch')
     AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1] AND i.indisvalid)
   ORDER BY 1, 2`;

/**
 * One company (TA) with plan history in small: 2,000 orders over 90 days in one confirmed file, 10
 * plan versions that each hold every order once (as createNextVersion copies all the stops), a
 * manual baseline over the orders, and a wrong file of 50 orders that no plan has seen. Audit rows
 * of three users of TA, a platform admin and driver-link writes (no user), about 450 B of JSON
 * each, and a second company (TB) beside it.
 */
async function seed() {
  await x(`INSERT INTO "Tenant" ("id", "slug", "name", "country") VALUES ('TA', 'mig-ta', 'Company TA', 'Oman'), ('TB', 'mig-tb', 'Company TB', 'Oman')`);
  await x(
    `INSERT INTO "User" ("id", "email", "passwordHash", "name", "tenantId") VALUES
       ('U1', 'u1@mig.test', 'x', 'User 1', 'TA'), ('U2', 'u2@mig.test', 'x', 'User 2', 'TA'), ('U3', 'u3@mig.test', 'x', 'User 3', 'TA'),
       ('UP', 'platform@mig.test', 'x', 'Platform admin', NULL), ('UB', 'ub@mig.test', 'x', 'User B', 'TB')`,
  );
  await x(`INSERT INTO "Customer" ("id", "tenantId", "code", "name") VALUES ('C1', 'TA', 'C1', 'Customer 1')`);
  await x(`INSERT INTO "Depot" ("id", "tenantId", "code", "name", "lat", "lng", "active") VALUES ('D1', 'TA', 'D1', 'Depot 1', 23.5, 58.4, true)`);
  await x(`INSERT INTO "Truck" ("id", "tenantId", "depotId", "code") VALUES ('T1', 'TA', 'D1', 'T1')`);
  await x(
    `INSERT INTO "UploadBatch" ("id", "tenantId", "fileName", "fileType", "uploadedById", "depotId", "status")
     VALUES ('B_OLD', 'TA', 'old.csv', 'csv', 'U1', 'D1', 'CONFIRMED'), ('B_WRONG', 'TA', 'wrong.csv', 'csv', 'U1', 'D1', 'CONFIRMED')`,
  );
  await x(
    `INSERT INTO "Order" ("id", "tenantId", "customerId", "deliveryDate", "depotId", "uploadBatchId", "totalCases")
     SELECT 'O' || g, 'TA', 'C1', DATE '2026-07-01' + (g % 90), 'D1', 'B_OLD', 5 FROM generate_series(1, ${ORDERS}) g`,
  );
  await x(
    `INSERT INTO "Order" ("id", "tenantId", "customerId", "deliveryDate", "depotId", "uploadBatchId", "totalCases")
     SELECT 'W' || g, 'TA', 'C1', DATE '2026-10-10', 'D1', 'B_WRONG', 5 FROM generate_series(1, ${WRONG}) g`,
  );
  await x(`INSERT INTO "RunPlan" ("id", "tenantId", "depotId", "runDate", "createdById", "version") SELECT 'R' || v, 'TA', 'D1', DATE '2026-07-01', 'U1', v FROM generate_series(1, ${VERSIONS}) v`);
  await x(
    `INSERT INTO "RouteAssignment" ("id", "runId", "truckId", "orderId", "sequenceInTruck", "plannedArrivalMin", "plannedDistanceFromPrevKm", "plannedLoadCases")
     SELECT 'RA' || v || '_' || g, 'R' || v, 'T1', 'O' || g, g, 400, 1, 5 FROM generate_series(1, ${VERSIONS}) v, generate_series(1, ${ORDERS}) g`,
  );
  await x(`INSERT INTO "ManualBaseline" ("id", "tenantId", "uploadedById", "runId") VALUES ('MB1', 'TA', 'U1', 'R1'), ('MB2', 'TA', 'U1', 'R2')`);
  await x(
    `INSERT INTO "ManualBaselineAssignment" ("id", "baselineId", "truckCode", "customerCode", "orderId")
     SELECT 'MBA' || b || '_' || g, 'MB' || b, 'T1', 'C1', 'O' || g FROM generate_series(1, 2) b, generate_series(1, ${ORDERS}) g`,
  );
  await x(
    `INSERT INTO "AuditLog" ("id", "tenantId", "userId", "action", "entity", "entityId", "afterJson", "createdAt")
     SELECT 'A' || g,
            CASE WHEN g % 10 = 0 THEN 'TB' ELSE 'TA' END,
            CASE WHEN g % 10 = 0 THEN 'UB' WHEN g % 10 IN (1, 2, 3, 4) THEN 'U1' WHEN g % 10 IN (5, 6) THEN 'U2'
                 WHEN g % 10 = 7 THEN NULL WHEN g % 100 = 8 THEN 'UP' ELSE 'U3' END,
            'UPDATE', 'Customer', 'C1', jsonb_build_object('n', g, 'note', repeat('x', 450)),
            TIMESTAMP '2026-07-01' + g * INTERVAL '1 minute'
       FROM generate_series(1, 30000) g`,
  );
  await x('ANALYZE');
}

describe.skipIf(!ADMIN_URL)(`migration ${NEW} on real PostgreSQL`, () => {
  beforeAll(async () => {
    migrationTestDbName(process.env.MIGRATION_TEST_DB_NAME);
    admin = new PrismaClient({ datasourceUrl: ADMIN_URL });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${DB_NAME}"`);

    tmp = mkdtempSync(path.join(os.tmpdir(), 'routeiq-migtest-'));
    writeFileSync(path.join(tmp, 'schema.prisma'), 'datasource db {\n  provider = "postgresql"\n  url      = env("MIGRATION_TEST_DATABASE_URL")\n}\n');
    mkdirSync(path.join(tmp, 'migrations'), { recursive: true });
    cpSync(path.join(MIGRATIONS, 'migration_lock.toml'), path.join(tmp, 'migrations', 'migration_lock.toml'));
    for (const f of migrationFoldersBefore(readdirSync(MIGRATIONS), LAST_BEFORE, NEW)) cpSync(path.join(MIGRATIONS, f), path.join(tmp, 'migrations', f), { recursive: true });
    const first = prisma(['migrate', 'deploy']);
    if (first.status !== 0) throw new Error(`migrate deploy up to ${LAST_BEFORE} failed:\n${first.stdout}${first.stderr}`);

    db = new PrismaClient({ datasourceUrl: dbUrl(DB_NAME) });
    await seed();
    unindexedBefore = await q(UNINDEXED_ORDER_KEYS);

    cpSync(path.join(MIGRATIONS, NEW), path.join(tmp, 'migrations', NEW), { recursive: true });
    const second = prisma(['migrate', 'deploy']);
    deploy = { status: second.status ?? -1, out: `${second.stdout}${second.stderr}` };
  }, 300_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
      await admin.$disconnect();
    }
    try {
      if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      console.warn(`Could not remove ${tmp}: ${(e as Error).message}`);
    }
  }, 120_000);

  it('applies with prisma migrate deploy', () => {
    expect(deploy.status, deploy.out).toBe(0);
    expect(deploy.out).toContain(NEW);
  });

  it('adds the four indexes, valid, with the columns and names of prisma/schema.prisma (no drift)', async () => {
    const rows = await q<{ name: string; table: string; columns: string[]; valid: boolean; unique: boolean }>(
      `SELECT ic.relname AS name, t.relname AS "table", i.indisvalid AND i.indisready AS valid, i.indisunique AS unique,
              ARRAY(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n ORDER BY k.o) AS columns
         FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
        WHERE ic.relname = ANY($1::text[]) ORDER BY 1`,
      INDEXES.map((i) => i.name),
    );
    expect(rows).toEqual(INDEXES.map((i) => ({ ...i, valid: true, unique: false })));
    // What `prisma migrate dev` would still add or drop between this database and the app's schema
    // touches none of them (a later migration may add other changes: those are not checked here).
    const diff = run(['migrate', 'diff', '--from-url', dbUrl(DB_NAME), '--to-schema-datamodel', path.join(WEB, 'prisma', 'schema.prisma'), '--script']);
    expect(diff.status, `${diff.stdout}${diff.stderr}`).toBe(0);
    for (const i of INDEXES) expect(diff.stdout).not.toContain(i.name);
  });

  it('every foreign key an order-file delete makes PostgreSQL check has an index that starts with its column (before: three had none)', async () => {
    expect(unindexedBefore).toEqual([
      { table: 'ManualBaselineAssignment', column: 'orderId', references: 'Order' },
      { table: 'Order', column: 'uploadBatchId', references: 'UploadBatch' },
      { table: 'RouteAssignment', column: 'orderId', references: 'Order' },
    ]);
    expect(await q(UNINDEXED_ORDER_KEYS)).toEqual([]);
  });

  it('deleting a wrong file\'s orders finds its plan stops and baseline rows by index, not by reading the whole table per order', async () => {
    class RollBack extends Error {}
    let stats: { table: string; seq: number; idx: number }[] = [];
    let deleted = 0;
    await db
      .$transaction(async (tx) => {
        // As DELETE /api/orders/:batchId: the file's orders, the plans that used them, then the delete
        // (the RESTRICT and SET NULL keys look up each deleted order in "RouteAssignment" and
        // "ManualBaselineAssignment").
        const ids = ((await tx.$queryRawUnsafe(`SELECT "id" FROM "Order" WHERE "tenantId" = 'TA' AND "uploadBatchId" = 'B_WRONG'`)) as { id: string }[]).map((r) => r.id);
        expect(ids).toHaveLength(WRONG);
        expect(await tx.$queryRawUnsafe(`SELECT DISTINCT "runId" FROM "RouteAssignment" WHERE "orderId" = ANY($1::text[])`, ids)).toEqual([]);
        deleted = await tx.$executeRawUnsafe(`DELETE FROM "Order" WHERE "tenantId" = 'TA' AND "id" = ANY($1::text[])`, ids);
        stats = await tx.$queryRawUnsafe(
          `SELECT relname AS "table", seq_scan::int AS seq, idx_scan::int AS idx FROM pg_stat_xact_user_tables
            WHERE relname IN ('Order', 'RouteAssignment', 'ManualBaselineAssignment') ORDER BY 1`,
        );
        throw new RollBack();
      }, { timeout: 60_000 })
      .catch((e) => {
        if (!(e instanceof RollBack)) throw e;
      });
    expect(deleted).toBe(WRONG);
    // Before the migration: "RouteAssignment" seq 51 (the plan check, then one full read per order
    // deleted), "ManualBaselineAssignment" seq 50, "Order" seq 1.
    expect(stats).toEqual([
      { table: 'ManualBaselineAssignment', seq: 0, idx: expect.any(Number) },
      { table: 'Order', seq: 0, idx: expect.any(Number) },
      { table: 'RouteAssignment', seq: 0, idx: expect.any(Number) },
    ]);
    for (const s of stats.filter((r) => r.table !== 'Order')) expect(s.idx, s.table).toBeGreaterThanOrEqual(WRONG);
    // Rolled back: the wrong file's orders are still there for the other checks.
    expect(await q(`SELECT count(*)::int AS n FROM "Order" WHERE "uploadBatchId" = 'B_WRONG'`)).toEqual([{ n: WRONG }]);
  });

  it('the Audit log page\'s per-user counts read the new index alone; the filter by user reads that user\'s newest rows from it', async () => {
    await x('VACUUM (ANALYZE) "AuditLog"'); // the visibility map an index-only scan relies on (autovacuum keeps it)
    // The page's groupBy as Prisma sends it (tenantDb adds the company), caught from the query log.
    const logged = new PrismaClient({ datasourceUrl: dbUrl(DB_NAME), log: [{ emit: 'event', level: 'query' }] });
    const sent: { query: string; params: string }[] = [];
    logged.$on('query', (e) => sent.push({ query: e.query, params: e.params }));
    let mostFirst: (string | null)[] = [];
    try {
      const counts = await logged.auditLog.groupBy({
        by: ['userId'],
        where: { userId: { not: null }, tenantId: 'TA' },
        _count: { userId: true },
        orderBy: { _count: { userId: 'desc' } },
        take: 25,
      });
      mostFirst = counts.map((c) => c.userId);
    } finally {
      await logged.$disconnect();
    }
    expect(mostFirst).toEqual(['U1', 'U2', 'U3', 'UP']);
    const groupBy = sent.find((s) => /GROUP BY/.test(s.query));
    expect(groupBy, sent.map((s) => s.query).join('\n')).toBeDefined();
    const plan = async (sql: string, params: unknown[]) => {
      const rows = await q<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${inline(sql, params)}`);
      return JSON.stringify(rows[0]['QUERY PLAN']);
    };
    const counted = await plan(groupBy!.query, JSON.parse(groupBy!.params));
    // Before the migration: a Seq Scan of "AuditLog", every row read with its JSON.
    expect(counted).toContain('"Node Type":"Index Only Scan"');
    expect(counted).toContain('"Index Name":"AuditLog_tenantId_userId_createdAt_idx"');
    expect(counted).not.toContain('"Node Type":"Seq Scan"');
    // GET /api/audit?userId=U2: that user's newest 200 rows (before: the company's rows newest first,
    // skipping every other user's).
    const filtered = await plan(
      `SELECT "id" FROM "AuditLog" WHERE "userId" = $1 AND "tenantId" = $2 ORDER BY "createdAt" DESC LIMIT $3`,
      ['U2', 'TA', 200],
    );
    expect(filtered).toContain('"Index Name":"AuditLog_tenantId_userId_createdAt_idx"');
    expect(filtered).not.toContain('"Node Type":"Seq Scan"');
  });

  it('running the migration\'s SQL a second time succeeds and changes nothing', async () => {
    const snapshot = () => q(`SELECT indexrelid::regclass::text AS name, indisvalid FROM pg_index WHERE indrelid IN ('"Order"'::regclass, '"RouteAssignment"'::regclass, '"ManualBaselineAssignment"'::regclass, '"AuditLog"'::regclass) ORDER BY 1`);
    const before = await snapshot();
    const again = prisma(['db', 'execute', '--file', path.join(MIGRATIONS, NEW, 'migration.sql')]);
    expect(again.status, `${again.stdout}${again.stderr}`).toBe(0);
    expect(await snapshot()).toEqual(before);
  });
});
