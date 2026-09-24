# RouteIQ — Admin runbook

Operational guide for tenant admins, on-call, and support. Pairs with [`CLAUDE.md`](../CLAUDE.md) (the build spec).

---

## Tenant lifecycle

### Creating a new tenant
1. Send the prospective admin to `/signup`.
2. They fill: company name, tenant slug, country, currency, primary unit, admin email + password + name.
3. The signup writes a `Tenant`, `TenantConfig` (with defaults), and a `TENANT_ADMIN` user transactionally.
4. The new admin lands on `/t/{slug}/onboard` — three-step wizard for first depot, first truck, customers (CSV optional).
5. **Stopwatched onboarding target: <30 minutes** for a planner with the right CSV prepared.

### Setting `SUPER_ADMIN_EMAILS`
Allowlist of platform-level super admins. Comma-separated. They can:
- See every tenant in `/admin`
- Access any `/t/{slug}` regardless of tenant assignment
- Suspend/restore tenants (v1: read-only; suspend toggle lands in Phase 5+)

### Suspending a tenant
v1: set `Tenant.active = false` directly in DB. Users will hit 404 on tenant routes.

---

## Daily operations

### When a planner says "optimization failed"
1. Open the run detail page; the failure banner has a "Download debug JSON" button.
2. The JSON contains `requestJson` (exact solver input), `responseJson` (if any), and `errorJson` (reason).
3. Common reasons:
   - `SOLVER_ERROR` with HTTP 5xx → solver crashed; check Railway logs for `routeiq-solver`
   - `SOLVER_ERROR` with HTTP 0 → solver unreachable; check `SOLVER_URL` / private DNS
   - `STUCK` → the job had no result after 15 min and the janitor reaped it. Usually the web service restarted (a deploy) during the optimization; optimize again.
   - `Solver returned HTTP 404` / "The route optimizer is being updated" → web was deployed before the solver finished deploying; retry in a minute.
4. Once the solver is healthy, click "Retry optimization" on the run — it spawns attempt #N+1 with the same input.

### When a run is stuck "Optimizing"
1. The orphan janitor runs **inside the web process every 60 s** (`lib/jobs/janitor-loop.ts`, started from `instrumentation.ts`).
   - It fails any `RunJob` RUNNING or still QUEUED for more than 15 min (`STUCK_JOB_MS`), which is longer than any real optimization (the solver call is capped at 10 min).
   - It flips the parent plan to `FAILED`, so it can be optimized again. No cron service is needed.
   - `ROUTEIQ_DISABLE_JANITOR=1` turns it off.
2. To run the janitor manually:
   ```bash
   curl -X POST $BASE/api/cron/janitor -H "X-Janitor-Token: $JANITOR_TOKEN"
   ```

### When users say "I can't see the tenant"
- Check the URL: it must be `/t/{their-tenant-slug}`. Cross-tenant access returns **404** (not 403) to avoid leaking tenant existence.
- Check the user's `tenantId` matches the URL's tenant `slug` in DB.
- Check the user is `active = true`.

---

## Auth and password resets

### Standard reset (v2 — email-driven)
v2 will send a Resend/Postmark email. For v1 we don't ship that yet.

### v1 emergency password reset
In the DB:
```sql
UPDATE "User"
   SET "passwordHash" = '<bcrypt-12 hash of new pwd>'
 WHERE email = 'user@tenant.test';
```

Generate the bcrypt hash via Node:
```js
const bcrypt = require('bcryptjs');
bcrypt.hashSync('NewPassword!', 12);
```

### Inviting a teammate
Tenant admin uses `/t/{slug}/users` → "Invite user". Returns a one-time temp password shown to the inviter (copy → share over a secure channel). No emails sent in v1.

---

## Solver

### Rotating `SOLVER_TOKEN`
Every 90 days per CLAUDE.md §14.
1. Generate a new random 32-byte base64 secret.
2. Set on `routeiq-solver` env → redeploy solver. **It will continue accepting the old token until restart.** Wait for the new replica to come up.
3. Set on `routeiq-web` env → redeploy web. Web will start sending the new token.
4. Verify a fresh optimize call works.
5. Done. Document the rotation date in the audit log of your infra system.

### Tuning solver time limits
- **Dispatch planner (OR-Tools, Daily dispatch):** ignores `TenantConfig.solverTimeLimitSeconds`.
  - The RECOMMENDED time limit scales with the stop count: 3 s (≤25), 8 s (≤80), 20 s (≤200), 150 s (≤350), 240 s (>350). The alternatives get half.
  - The whole solve stays within a 540 s budget. Alternatives that would overrun it are skipped with a warning.
  - The web waits up to 600 s.
- `TenantConfig.solverTimeLimitSeconds` currently has **no effect**. It belonged to the previous (PyVRP) planner, which can no longer be started: old plans are read-only (`409 LEGACY_PLAN`).
- Dispatch planner: every scenario runs in a worker process.
  - OR-Tools holds the GIL during its search. So neither the API process nor threads may run it, or `/health` and every other request freeze until the search ends.
  - RECOMMENDED runs first; the two alternatives then run in parallel, warm-started from it.
  - If the worker computing the recommended plan dies (e.g. out of memory), the optimization fails within seconds with a clear message. If an alternative's worker dies, only that alternative is skipped (with a warning) after its deadline.
  - `SOLVER_PARALLEL=0` runs everything in-process (tests / debugging only).

---

## Deployment

### Single-replica enforcement
**v1 deployment MUST run exactly one `routeiq-web` Railway replica.** The in-memory `inflight` map in `lib/jobs/optimize-job.ts` prevents duplicate solver calls within one process but is **NOT** safe under horizontal scaling. Adding a second replica WILL produce duplicate solver runs and unpredictable RunJob state.

If you need to scale beyond one web instance, swap the inflight map for Redis-backed locks (BullMQ recommended) before scaling — that's a v2 prerequisite.

### Migrations
- `pnpm db:migrate:deploy` runs on Railway as the web service's **pre-deploy** step (`deploy.preDeployCommand` in `apps/web/railway.json`). A failed migration stops the deploy before the new version starts.
- Never edit a historical migration. Always create a new one.
- Zero-downtime pattern for destructive changes: expand → migrate code → contract over two deploys.

### PostGIS
- Production uses the `postgis/postgis:16-3.4` Docker image (or a Postgres with PostGIS enabled).
- v1 schema doesn't query PostGIS, but the extension is reserved for v2 spatial work.
- The first migration is tolerant of missing PostGIS (wraps `CREATE EXTENSION` in a `DO $$ ... EXCEPTION` block) so local dev DBs without PostGIS still migrate.

### Backups
- Railway volume backups of `postgres-volume` are scheduled daily (kept 6 days) and weekly (kept 27 days) since 2026-09-24 (Postgres → Backups). Take a manual backup before every migration-bearing deploy.
- Once NMWC is live, add a daily `pg_dump` to Cloudflare R2 or similar; 30-day retention; quarterly restore drill.

---

## Tenant isolation contract

CLAUDE.md §3, §13: every business table has `tenantId`, every query goes through `tenantDb(tenantId)`. The Vitest suite at `apps/web/tests/tenant-isolation.spec.ts` runs on every PR; merge is blocked if it fails.

If you add a new tenant-scoped model:
1. Add `tenantId` + relation to `Tenant` in `schema.prisma`.
2. Add the model name to `TENANT_SCOPED_MODELS` in `lib/tenant.ts`.
3. Add a parallel isolation test in `tests/tenant-isolation.spec.ts`.

---

## Rate limits

| Endpoint | Limit | Source |
|---|---|---|
| `/api/auth/*` | 5/min/IP | `lib/rate-limit.ts` `LIMITS.auth` |
| `/api/orders/upload` | 10/hr/user | `LIMITS.ordersUpload` |
| `/api/customers/import` | 10/hr/user | `LIMITS.ordersUpload` |
| `/api/runs/{id}/baseline` | 10/hr/user | `LIMITS.ordersUpload` |
| `/api/runs/{id}/optimize` | 30/hr/tenant | `LIMITS.optimize` |
| Other authenticated endpoints | 300/min/user | `LIMITS.defaultAuthed` |

In production, swap the in-memory `Map` in `rate-limit.ts` for Upstash Redis. The interface is intentionally drop-in compatible.

---

## File upload hardening

- Max 10 MB per file (CLAUDE.md §15).
- Max 50,000 rows per file — `parseUpload` rejects during streaming, doesn't load into memory.
- Content-type allowlist: CSV / XLSX / XLS only.
- SheetJS parse wrapped in a 10-second wall-clock timeout (zip-bomb defense).
- Filename sanitized before writing to `UploadBatch.fileName`: no path separators, max 200 chars.

---

## Sentry

`SENTRY_DSN` env var: set in Railway. The Next.js client + server initialize Sentry via `sentry.client.config.ts` / `sentry.server.config.ts`. With no DSN, Sentry is a no-op.

Sensitive-data scrubbing is enabled by default (passwords, tokens, emails). When adding new sensitive fields, add them to the `denyUrls` / `beforeSend` scrubbers.

---

## Useful queries

### Tenants overview
```sql
SELECT slug, name, country, active,
       (SELECT count(*) FROM "User" u WHERE u."tenantId" = t.id) AS users,
       (SELECT count(*) FROM "RunPlan" r WHERE r."tenantId" = t.id) AS runs
  FROM "Tenant" t
 ORDER BY "createdAt";
```

### Stuck runs
```sql
SELECT id, "tenantId", "runDate", status, "currentJobId"
  FROM "RunPlan"
 WHERE status = 'OPTIMIZING'
   AND "createdAt" < NOW() - INTERVAL '10 minutes';
```

### Recent audit by tenant
```sql
SELECT a.action, a.entity, u.email, a."createdAt"
  FROM "AuditLog" a
  LEFT JOIN "User" u ON u.id = a."userId"
 WHERE a."tenantId" = $1
 ORDER BY a."createdAt" DESC
 LIMIT 100;
```

---

## Escalation

- Solver issues: check `routeiq-solver` Railway logs; the service prints one INFO line per call (`run=... stops=... time_limit=...`).
- Web errors: `routeiq-web` Railway logs + Sentry breadcrumbs.
- DB locked or slow: Railway Postgres metrics → CPU / connections / lock contention.
- Mass auth issues: `NEXTAUTH_SECRET` rotation logs everyone out — only do this for credential exposure, never as a routine.
