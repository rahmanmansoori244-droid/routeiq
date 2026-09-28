/**
 * Migration test for 20260930120000_orders_always_have_depot (audit PR A5, owner rule "all orders
 * must have depots linked to them"), on a real, throwaway PostgreSQL database.
 *
 * It creates the database, applies every migration up to 20260930093000_master_data_no_orphans
 * with `prisma migrate deploy` (the command production runs), inserts orders and order files
 * without a depot for every backfill step, then applies the new migration the same way while
 * another connection is still writing an order and an order file without a depot (an app request
 * that started before the deploy and commits after the migration started). The migration's lock
 * step must wait for that write and then fill it in: without the lock, its backfill cannot see the
 * row, and SET NOT NULL fails on it (P3018, then P3009 on every later deploy).
 * It checks every filled-in depot, the history-only depots, the audit rows and NOT NULL, and
 * that running the migration's SQL a second time changes nothing.
 *
 * Skipped unless MIGRATION_TEST_DB_ADMIN_URL is set: a URL of a maintenance database (for example
 * .../postgres) whose user may create databases. The throwaway database is
 * MIGRATION_TEST_DB_NAME (default routeiq_a5_migtest; it must start with routeiq_a5_ and end in
 * migtest, see ./db-name.ts). It is dropped first if it exists, and dropped again at the end. From
 * apps/web:
 *
 *   MIGRATION_TEST_DB_ADMIN_URL=postgresql://USER:PASSWORD@localhost:5432/postgres \
 *   pnpm exec vitest run tests/migrations
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATION_TEST_DB_NAME, migrationTestDbName } from './db-name';

const ADMIN_URL = process.env.MIGRATION_TEST_DB_ADMIN_URL ?? '';
// Checked in beforeAll (migrationTestDbName), before anything is dropped.
const DB_NAME = process.env.MIGRATION_TEST_DB_NAME ?? DEFAULT_MIGRATION_TEST_DB_NAME;
const NEW = '20260930120000_orders_always_have_depot';
const LAST_BEFORE = '20260930093000_master_data_no_orphans';
const WEB = path.join(__dirname, '../..');
const MIGRATIONS = path.join(WEB, 'prisma', 'migrations');
const PRISMA_CLI = path.join(WEB, 'node_modules', 'prisma', 'build', 'index.js');

function dbUrl(name: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  u.search = '?schema=public';
  return u.toString();
}

let tmp = '';
let admin: PrismaClient;
let db: PrismaClient;
let firstDeploy = { status: -1, out: '' };
let secondDeploy = { status: -1, out: '' };
let heldMs = 0;
let releasedAt = 0;
let migrationSeenWhileHeld = false;
let deployedAt = 0;

/**
 * The Prisma CLI of this repo, as production runs it. The schema names its own URL variable, so the
 * app's DATABASE_URL is never used; the working directory is outside the temporary folder (no .env
 * there, and nothing keeps the folder busy when it is removed).
 */
const cli = () => ({ cwd: os.tmpdir(), env: { ...process.env, MIGRATION_TEST_DATABASE_URL: dbUrl(DB_NAME) } });

function prisma(args: string[]) {
  return spawnSync(process.execPath, [PRISMA_CLI, ...args, '--schema', path.join(tmp, 'schema.prisma')], { ...cli(), encoding: 'utf8', timeout: 240_000 });
}

/** migrate deploy without blocking the event loop (another connection holds a lock meanwhile). */
function deployAsync(): Promise<{ status: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PRISMA_CLI, 'migrate', 'deploy', '--schema', path.join(tmp, 'schema.prisma')], cli());
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (status) => resolve({ status: status ?? -1, out }));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = async <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => (await db.$queryRawUnsafe(sql, ...params)) as T[];
const x = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);

// --- the data before the migration ------------------------------------------------------------

const DAY = '2026-10-01';

async function tenant(id: string) {
  await x(`INSERT INTO "Tenant" ("id", "slug", "name", "country") VALUES ($1, $2, $3, 'Oman')`, id, `mig-${id.toLowerCase()}`, `Company ${id}`);
  await x(`INSERT INTO "Customer" ("id", "tenantId", "code", "name") VALUES ($1, $2, 'C1', 'Customer 1')`, `C_${id}`, id);
}
async function depot(id: string, tenantId: string, code: string, active: boolean, lat = 23.5, lng = 58.4) {
  await x(`INSERT INTO "Depot" ("id", "tenantId", "code", "name", "lat", "lng", "active") VALUES ($1, $2, $3, $4, $5, $6, $7)`, id, tenantId, code, `Depot ${code}`, lat, lng, active);
}
async function batch(id: string, tenantId: string, depotId: string | null, status = 'CONFIRMED') {
  await x(
    `INSERT INTO "UploadBatch" ("id", "tenantId", "fileName", "fileType", "uploadedById", "depotId", "status") VALUES ($1, $2, $3, 'csv', 'U', $4, $5::"UploadBatchStatus")`,
    id, tenantId, `${id}.csv`, depotId, status,
  );
}
async function order(id: string, tenantId: string, opts: { depotId?: string | null; batchId?: string | null; carriedToOrderId?: string | null; carriedFromOrderId?: string | null } = {}) {
  await x(
    `INSERT INTO "Order" ("id", "tenantId", "customerId", "deliveryDate", "depotId", "uploadBatchId", "carriedToOrderId", "carriedFromOrderId", "totalCases")
     VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, 5)`,
    id, tenantId, `C_${tenantId}`, DAY, opts.depotId ?? null, opts.batchId ?? null, opts.carriedToOrderId ?? null, opts.carriedFromOrderId ?? null,
  );
}
async function run(id: string, tenantId: string, depotId: string) {
  await x(`INSERT INTO "RunPlan" ("id", "tenantId", "depotId", "runDate", "createdById") VALUES ($1, $2, $3, $4::date, 'U')`, id, tenantId, depotId, DAY);
}
async function scenario(id: string, runId: string, details: unknown) {
  await x(
    `INSERT INTO "ScenarioResult" ("id", "runId", "name", "trucksUsed", "totalDistanceKm", "totalTimeMin", "totalCost", "avgUtilizationPct", "unservedCount", "detailsJson")
     VALUES ($1, $2, 'RECOMMENDED', 1, 10, 60, 5, 50, 0, $3::jsonb)`,
    id, runId, JSON.stringify(details),
  );
}
let seq = 0;
async function stop(runId: string, truckId: string, orderId: string) {
  seq += 1;
  await x(
    `INSERT INTO "RouteAssignment" ("id", "runId", "truckId", "orderId", "sequenceInTruck", "plannedArrivalMin", "plannedDistanceFromPrevKm", "plannedLoadCases")
     VALUES ($1, $2, $3, $4, $5, 400, 1, 5)`,
    `RA${seq}`, runId, truckId, orderId, seq,
  );
}
async function unserved(scenarioId: string, orderId: string) {
  seq += 1;
  await x(`INSERT INTO "UnservedOrder" ("id", "scenarioId", "orderId", "reasonCode") VALUES ($1, $2, $3, 'UNKNOWN')`, `UO${seq}`, scenarioId, orderId);
}

/**
 * TA: three active depots (D1, D2 and a real depot coded "no-depot") - every evidence step, the
 *     conflicts, and the history-only depot NO-DEPOT-2 (NO-DEPOT is taken, in another case);
 * TB: one active + one inactive depot (step d: the active one);
 * TC: one depot, inactive (step d: the only one);
 * TD: no depot at all (step e: NO-DEPOT at 0, 0);
 * TE: two inactive depots (step e: the coordinates of the first by code);
 * TF: nothing without a depot (nothing changes, no audit row).
 */
async function seed() {
  for (const t of ['TA', 'TB', 'TC', 'TD', 'TE', 'TF']) await tenant(t);
  await x(`INSERT INTO "User" ("id", "email", "passwordHash", "name", "tenantId") VALUES ('U', 'u@mig.test', 'x', 'U', 'TA')`);
  await depot('TA_D1', 'TA', 'D1', true, 23.1, 58.1);
  await depot('TA_D2', 'TA', 'D2', true, 23.2, 58.2);
  await depot('TA_ND', 'TA', 'no-depot', true, 23.3, 58.3);
  await depot('TB_D1', 'TB', 'MAIN', true);
  await depot('TB_D0', 'TB', 'CLOSED', false);
  await depot('TC_D0', 'TC', 'ONLY', false);
  await depot('TE_E2', 'TE', 'E2', false, 22.2, 57.2);
  await depot('TE_E1', 'TE', 'E1', false, 21.1, 56.1);
  await depot('TF_D1', 'TF', 'F1', true);
  await depot('TB_X', 'TB', 'SPARE', false);
  await x(`INSERT INTO "Truck" ("id", "tenantId", "depotId", "code") VALUES ('TA_T1', 'TA', 'TA_D1', 'T1'), ('TA_T2', 'TA', 'TA_D2', 'T2'), ('TB_T1', 'TB', 'TB_D1', 'T1')`);
  await run('R_D1', 'TA', 'TA_D1');
  await run('R_D2', 'TA', 'TA_D2');
  await run('R_TB', 'TB', 'TB_D1');
  await scenario('S_D1', 'R_D1', { scope: { orderIds: [], frozenOrderIds: [] } });
  await scenario('S_D2', 'R_D2', { scope: { orderIds: ['O_B3', 7, null, { a: 1 }], frozenOrderIds: [], frozenLoadOrderIds: [] } });
  // Option details that are not the dispatch shape never stop the migration.
  await scenario('S_BAD1', 'R_D2', { scope: { orderIds: { O_E1: true } } });
  await scenario('S_BAD2', 'R_D2', { scope: 'O_E1' });
  await scenario('S_BAD3', 'R_D1', [1, 2, 3]);
  await scenario('S_BAD4', 'R_D1', 'text');

  // a: the order file's depot; a row that already has a depot is never changed.
  await batch('B_A1', 'TA', 'TA_D1');
  await order('O_A1', 'TA', { batchId: 'B_A1' });
  await order('O_KEEP', 'TA', { depotId: 'TA_D2', batchId: 'B_A1' });
  // b: the one depot of the plans that held it.
  await order('O_B1', 'TA');
  await stop('R_D2', 'TA_T2', 'O_B1'); // a stop
  await order('O_B2', 'TA');
  await unserved('S_D1', 'O_B2'); // unserved in an option
  await order('O_B3', 'TA'); // only among the orders an option was made for (S_D2 scope)
  await order('O_B4', 'TA');
  await x(`INSERT INTO "ManualBaseline" ("id", "tenantId", "uploadedById", "runId") VALUES ('MB1', 'TA', 'U', 'R_D1')`);
  await x(`INSERT INTO "ManualBaselineAssignment" ("id", "baselineId", "truckCode", "customerCode", "orderId") VALUES ('MBA1', 'MB1', 'T1', 'C1', 'O_B4')`);
  await order('O_B5c', 'TA', { depotId: 'TA_D2' }); // the copy it was brought forward to
  await order('O_B5', 'TA', { carriedToOrderId: 'O_B5c' });
  await x(`UPDATE "Order" SET "carriedFromOrderId" = 'O_B5' WHERE "id" = 'O_B5c'`);
  await order('O_BX', 'TA'); // plans of two depots: no answer from plans
  await stop('R_D1', 'TA_T1', 'O_BX');
  await unserved('S_D2', 'O_BX');
  // c: the order file gets the one depot of its orders, then its other orders get it.
  await batch('B_C', 'TA', null);
  await order('O_C1', 'TA', { batchId: 'B_C' });
  await stop('R_D1', 'TA_T1', 'O_C1');
  await order('O_C2', 'TA', { batchId: 'B_C' });
  // c conflict: a file whose orders went to two depots.
  await batch('B_CX', 'TA', null);
  await order('O_CX1', 'TA', { batchId: 'B_CX' });
  await stop('R_D1', 'TA_T1', 'O_CX1');
  await order('O_CX2', 'TA', { batchId: 'B_CX' });
  await stop('R_D2', 'TA_T2', 'O_CX2');
  // e: nothing to go by; a file without orders, one still VALIDATED (never confirmable now).
  await order('O_E1', 'TA');
  await batch('B_E', 'TA', null);
  await batch('B_V', 'TA', null, 'VALIDATED');
  // The tenant guard: another company's depot or plan is never evidence.
  await batch('B_XT', 'TA', 'TB_D1'); // a file of TA pointing at TB's depot (the key does not check the company)
  await order('O_XT', 'TA', { batchId: 'B_XT' });
  await order('O_XT2', 'TA');
  await stop('R_TB', 'TB_T1', 'O_XT2');

  // d: the company's only active depot / only depot.
  await batch('B_TB', 'TB', null);
  await order('O_TB', 'TB', { batchId: 'B_TB' });
  await order('O_TB2', 'TB');
  await order('O_TC', 'TC');
  await batch('B_TC', 'TC', null);
  // e: no depot at all; two inactive depots.
  await order('O_TD', 'TD');
  await batch('B_TD', 'TD', null);
  await order('O_TE', 'TE');
  // Nothing without a depot.
  await batch('B_TF', 'TF', 'TF_D1');
  await order('O_TF', 'TF', { depotId: 'TF_D1', batchId: 'B_TF' });
}

// --------------------------------------------------------------------------------------------------

describe.skipIf(!ADMIN_URL)(`migration ${NEW} on real PostgreSQL`, () => {
  beforeAll(async () => {
    migrationTestDbName(process.env.MIGRATION_TEST_DB_NAME);
    admin = new PrismaClient({ datasourceUrl: ADMIN_URL });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${DB_NAME}"`);

    tmp = mkdtempSync(path.join(os.tmpdir(), 'routeiq-migtest-'));
    writeFileSync(
      path.join(tmp, 'schema.prisma'),
      'datasource db {\n  provider = "postgresql"\n  url      = env("MIGRATION_TEST_DATABASE_URL")\n}\n',
    );
    mkdirSync(path.join(tmp, 'migrations'), { recursive: true });
    cpSync(path.join(MIGRATIONS, 'migration_lock.toml'), path.join(tmp, 'migrations', 'migration_lock.toml'));
    const folders = readdirSync(MIGRATIONS).filter((f) => /^\d{14}_/.test(f)).sort();
    expect(folders).toContain(LAST_BEFORE);
    expect(folders.at(-1)).toBe(NEW);
    for (const f of folders.filter((f) => f <= LAST_BEFORE)) cpSync(path.join(MIGRATIONS, f), path.join(tmp, 'migrations', f), { recursive: true });

    const first = prisma(['migrate', 'deploy']);
    firstDeploy = { status: first.status ?? -1, out: `${first.stdout}${first.stderr}` };
    if (firstDeploy.status !== 0) throw new Error(`migrate deploy up to ${LAST_BEFORE} failed:\n${firstDeploy.out}`);

    db = new PrismaClient({ datasourceUrl: dbUrl(DB_NAME) });
    await seed();

    // The new migration, while another connection (an app request that started before the deploy)
    // has read "Order" and written an order file and an order without a depot, not yet committed.
    // It keeps its locks until the migration is seen running, then 1.5 s longer, and commits: the
    // migration's lock step must wait for it instead of failing, and only then fill in the depots,
    // so it sees these rows too. Without the lock step the backfill runs past the uncommitted rows
    // and SET NOT NULL then waits for the commit and fails on them.
    cpSync(path.join(MIGRATIONS, NEW), path.join(tmp, 'migrations', NEW), { recursive: true });
    let reading!: () => void;
    const readDone = new Promise<void>((r) => (reading = r));
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe('SELECT count(*) FROM "Order"');
        await tx.$executeRawUnsafe(
          `INSERT INTO "UploadBatch" ("id", "tenantId", "fileName", "fileType", "uploadedById", "depotId", "status") VALUES ('B_INFLIGHT', 'TB', 'late.csv', 'csv', 'U', NULL, 'CONFIRMED')`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "Order" ("id", "tenantId", "customerId", "deliveryDate", "depotId", "uploadBatchId", "totalCases") VALUES ('O_INFLIGHT', 'TB', 'C_TB', '${DAY}'::date, NULL, 'B_INFLIGHT', 5)`,
        );
        reading();
        const t0 = Date.now();
        while (Date.now() - t0 < 60_000) {
          // The migration's script text starts with its header (pg_stat_activity keeps the first 1 kB).
          // Inside a transaction the view is read once and kept: drop that copy before each look.
          await tx.$queryRawUnsafe('SELECT pg_stat_clear_snapshot()::text AS cleared');
          const seen = (await tx.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query LIKE '%every order and every order file has a depot%'`,
          )) as { n: number }[];
          if (seen[0].n > 0) {
            migrationSeenWhileHeld = true;
            break;
          }
          await sleep(50);
        }
        await sleep(1500);
        heldMs = Date.now() - t0;
        releasedAt = Date.now();
      },
      { timeout: 90_000, maxWait: 10_000 },
    );
    await readDone;
    const [second] = await Promise.all([deployAsync().then((r) => ((deployedAt = Date.now()), r)), holder]);
    secondDeploy = second;
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

  it('applies with prisma migrate deploy while a request is still writing an order without a depot (the lock step waits, then fills it in)', async () => {
    expect(firstDeploy.status).toBe(0);
    // The migration was running while the writer still held "Order" (and 1.5 s more): it waited.
    expect(migrationSeenWhileHeld).toBe(true);
    expect(heldMs).toBeGreaterThanOrEqual(1400);
    // It could only finish after the writer committed.
    expect(deployedAt).toBeGreaterThan(releasedAt);
    expect(secondDeploy.out).toContain(NEW);
    // Without the lock step: P3018 (23502, "depotId" contains null values), and P3009 on every later deploy.
    expect(secondDeploy.status, secondDeploy.out).toBe(0);
    // The rows written while the migration started got a depot too (step d: TB's only active depot).
    expect(await q(`SELECT "id", "depotId" FROM "Order" WHERE "id" = 'O_INFLIGHT' UNION ALL SELECT "id", "depotId" FROM "UploadBatch" WHERE "id" = 'B_INFLIGHT' ORDER BY 1`)).toEqual([
      { id: 'B_INFLIGHT', depotId: 'TB_D1' },
      { id: 'O_INFLIGHT', depotId: 'TB_D1' },
    ]);
  });

  it('every order has the depot its evidence shows (steps a to e), and rows that had one keep it', async () => {
    const got = Object.fromEntries((await q<{ id: string; depotId: string }>(`SELECT "id", "depotId" FROM "Order"`)).map((r) => [r.id, r.depotId]));
    const history = Object.fromEntries(
      (await q<{ tenantId: string; id: string }>(`SELECT "tenantId", "id" FROM "Depot" WHERE "historyOnly"`)).map((r) => [r.tenantId, r.id]),
    );
    expect(got).toEqual({
      O_A1: 'TA_D1', // a: its file
      O_KEEP: 'TA_D2', // had one: unchanged, although its file is D1
      O_B1: 'TA_D2', // b: a stop on D2's plan
      O_B2: 'TA_D1', // b: unserved in D1's option
      O_B3: 'TA_D2', // b: among the orders D2's option was made for
      O_B4: 'TA_D1', // b: a manual baseline of D1's plan
      O_B5: 'TA_D2', // b: the copy it was brought forward to
      O_B5c: 'TA_D2',
      O_BX: history.TA, // plans of two depots, three active depots: history-only
      O_C1: 'TA_D1', // b
      O_C2: 'TA_D1', // c then a: the other order of the file
      O_CX1: 'TA_D1',
      O_CX2: 'TA_D2',
      O_E1: history.TA, // e
      O_XT: history.TA, // its file points at another company's depot: not evidence
      O_XT2: history.TA, // a stop on another company's plan: not evidence
      O_TB: 'TB_D1', // d: the only active depot (one inactive besides)
      O_TB2: 'TB_D1',
      O_INFLIGHT: 'TB_D1', // d: written while the migration started (committed after it took its locks)
      O_TC: 'TC_D0', // d: the only depot, inactive
      O_TD: history.TD, // e: no depot at all
      O_TE: history.TE, // e: two inactive depots
      O_TF: 'TF_D1',
    });
  });

  it('every order file has a depot: its orders\' one depot, the only depot, or the history-only depot', async () => {
    const got = Object.fromEntries((await q<{ id: string; depotId: string }>(`SELECT "id", "depotId" FROM "UploadBatch"`)).map((r) => [r.id, r.depotId]));
    const history = Object.fromEntries(
      (await q<{ tenantId: string; id: string }>(`SELECT "tenantId", "id" FROM "Depot" WHERE "historyOnly"`)).map((r) => [r.tenantId, r.id]),
    );
    expect(got).toEqual({
      B_A1: 'TA_D1',
      B_C: 'TA_D1', // c
      B_CX: history.TA, // orders of two depots
      B_E: history.TA, // no orders
      B_V: history.TA, // still VALIDATED: its confirm is refused (history-only depot)
      B_XT: 'TB_D1', // had one (another company's): never changed by this migration
      B_TB: 'TB_D1', // d
      B_INFLIGHT: 'TB_D1', // d: written while the migration started
      B_TC: 'TC_D0', // d
      B_TD: history.TD, // e
      B_TF: 'TF_D1',
    });
  });

  it('one history-only depot per company that needs one: inactive, a free code in any case, a depot\'s coordinates or 0, 0', async () => {
    const rows = await q<{ tenantId: string; code: string; name: string; active: boolean; historyOnly: boolean; lat: number; lng: number; openMin: number | null }>(
      `SELECT "tenantId", "code", "name", "active", "historyOnly", "lat", "lng", "openMin" FROM "Depot" WHERE "historyOnly" ORDER BY "tenantId"`,
    );
    const base = { name: 'No depot (kept for history)', active: false, historyOnly: true, openMin: null };
    expect(rows).toEqual([
      { tenantId: 'TA', code: 'NO-DEPOT-2', lat: 23.1, lng: 58.1, ...base }, // "no-depot" is taken; D1 comes first
      { tenantId: 'TD', code: 'NO-DEPOT', lat: 0, lng: 0, ...base }, // no depot to copy
      { tenantId: 'TE', code: 'NO-DEPOT', lat: 21.1, lng: 56.1, ...base }, // E1 before E2
    ]);
    // The other depots are untouched.
    expect(await q(`SELECT count(*)::int AS n FROM "Depot" WHERE NOT "historyOnly"`)).toEqual([{ n: 10 }]);
  });

  it('one DEPOT_BACKFILL audit row per company that changed, with the count of each step', async () => {
    const rows = await q<{ tenantId: string; entity: string; entityId: string; userId: string | null; afterJson: Record<string, unknown> }>(
      `SELECT "tenantId", "entity", "entityId", "userId", "afterJson" FROM "AuditLog" WHERE "action" = 'DEPOT_BACKFILL' ORDER BY "tenantId"`,
    );
    expect(rows.map((r) => r.tenantId)).toEqual(['TA', 'TB', 'TC', 'TD', 'TE']);
    for (const r of rows) expect(r).toMatchObject({ entity: 'Tenant', entityId: r.tenantId, userId: null });
    const zero = {
      ordersFromFile: 0, ordersFromPlans: 0, ordersInPlansOfTwoDepots: 0, filesFromOrders: 0, filesWithOrdersOfTwoDepots: 0,
      ordersOnlyDepot: 0, filesOnlyDepot: 0, ordersHistoryDepot: 0, filesHistoryDepot: 0, historyDepotCode: null, historyDepotCreated: false,
    };
    const counts = Object.fromEntries(rows.map((r) => [r.tenantId, (({ reason, by, ...c }) => ({ ...c, by }))(r.afterJson as any)]));
    const by = 'migration 20260930120000_orders_always_have_depot';
    expect(counts).toEqual({
      TA: {
        ...zero, by,
        ordersFromFile: 2, // O_A1, then O_C2
        ordersFromPlans: 8, // O_B1-O_B5, O_C1, O_CX1, O_CX2
        ordersInPlansOfTwoDepots: 1, // O_BX
        filesFromOrders: 1, // B_C
        filesWithOrdersOfTwoDepots: 1, // B_CX
        ordersHistoryDepot: 4, // O_BX, O_E1, O_XT, O_XT2
        filesHistoryDepot: 3, // B_CX, B_E, B_V
        historyDepotCode: 'NO-DEPOT-2',
        historyDepotCreated: true,
      },
      TB: { ...zero, by, ordersOnlyDepot: 3, filesOnlyDepot: 2 }, // O_TB, O_TB2, O_INFLIGHT; B_TB, B_INFLIGHT
      TC: { ...zero, by, ordersOnlyDepot: 1, filesOnlyDepot: 1 },
      TD: { ...zero, by, ordersHistoryDepot: 1, filesHistoryDepot: 1, historyDepotCode: 'NO-DEPOT', historyDepotCreated: true },
      TE: { ...zero, by, ordersHistoryDepot: 1, historyDepotCode: 'NO-DEPOT', historyDepotCreated: true },
    });
    expect(String((rows[0].afterJson as { reason: string }).reason)).toMatch(/^Owner rule: every order and order file has a depot\./);
  });

  it('both columns are NOT NULL; the foreign keys stay NO ACTION; a row without a depot is refused', async () => {
    const cols = await q<{ table: string; notnull: boolean }>(
      `SELECT c.relname AS "table", a.attnotnull AS notnull FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname IN ('Order', 'UploadBatch') AND a.attname = 'depotId' ORDER BY 1`,
    );
    expect(cols).toEqual([{ table: 'Order', notnull: true }, { table: 'UploadBatch', notnull: true }]);
    const fks = await q<{ name: string; del: string }>(
      `SELECT conname AS name, confdeltype AS del FROM pg_constraint WHERE conname IN ('Order_depotId_fkey', 'UploadBatch_depotId_fkey') ORDER BY 1`,
    );
    expect(fks).toEqual([{ name: 'Order_depotId_fkey', del: 'a' }, { name: 'UploadBatch_depotId_fkey', del: 'a' }]);
    // 23502 = not_null_violation
    await expect(order('O_NEW', 'TF')).rejects.toThrow(/Code: `23502`/);
    await expect(batch('B_NEW', 'TF', null)).rejects.toThrow(/Code: `23502`/);
    await expect(order('O_NEW', 'TF', { depotId: 'TF_D1' })).resolves.toBeUndefined();
    const historyCol = await q(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'Depot' AND column_name = 'historyOnly'`);
    expect(historyCol).toEqual([{ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' }]);
  });

  it('running the migration\'s SQL a second time changes nothing', async () => {
    const snapshot = async () => ({
      orders: await q(`SELECT "id", "depotId" FROM "Order" ORDER BY "id"`),
      files: await q(`SELECT "id", "depotId" FROM "UploadBatch" ORDER BY "id"`),
      depots: await q(`SELECT "id", "code", "active", "historyOnly", "lat", "lng" FROM "Depot" ORDER BY "id"`),
      audit: await q(`SELECT count(*)::int AS n FROM "AuditLog"`),
    });
    const before = await snapshot();
    const again = prisma(['db', 'execute', '--file', path.join(MIGRATIONS, NEW, 'migration.sql')]);
    expect(again.status, `${again.stdout}${again.stderr}`).toBe(0);
    expect(await snapshot()).toEqual(before);
  });
});
