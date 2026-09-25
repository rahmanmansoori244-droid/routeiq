# RouteIQ — Admin runbook

Operational guide for tenant admins, on-call, and support. Pairs with [`CLAUDE.md`](../CLAUDE.md) (the build spec).

---

## Tenant lifecycle

### Creating a new tenant
1. Send the prospective admin to `/signup` (open by default; `SIGNUP_MODE=closed` turns it off).
2. They fill: company name, tenant slug, country, currency, primary unit, admin email + password + name.
3. The signup writes a `Tenant`, `TenantConfig` (with defaults), and a `TENANT_ADMIN` user transactionally. Sign-up never creates a platform admin.
4. The new admin lands on `/t/{slug}/onboard` — three-step wizard for first depot, first truck, customers (CSV optional).
5. **Stopwatched onboarding target: <30 minutes** for a planner with the right CSV prepared.

### Platform admins (`SUPER_ADMIN`)
Since stabilization PR1 a platform admin needs BOTH the email in `SUPER_ADMIN_EMAILS` (comma-separated, web service) AND the role, granted only by the owner-run `apps/web/prisma/grant-platform-admin.ts <email> [--revoke]` (see [`SECURITY.md`](./SECURITY.md) section 3; it writes an audit row). Either one alone grants nothing. They can:
- See every tenant in `/admin`
- Open any `/t/{slug}` page; each view writes a `CROSS_TENANT_VIEW` row in that tenant's audit log
- Suspend/restore tenants (read-only in the UI; see below)

A tenant admin cannot deactivate or demote a platform admin.

### Suspending a tenant
Set `Tenant.active = false` directly in DB (after a backup). Since PR1 this blocks the tenant's sign-in, every API call and every page within 30 s, and open sessions end without a redirect loop. First check that no platform admin account belongs to that tenant.

---

## Daily operations

### When a planner says "optimization failed"
1. Open the run detail page; the failure banner has a "Download debug JSON" button (SUPERVISOR and above: the JSON holds revenue, margins and coordinates).
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

### When users say "I can't see the tenant" or "I was signed out"
- Check the URL: it must be `/t/{their-tenant-slug}`. Cross-tenant access returns **404** (not 403) to avoid leaking tenant existence.
- Check the user's `tenantId` matches the URL's tenant `slug` in DB.
- Check the user and the tenant are `active = true`.
- Sessions end after 12 h (one shift) even while in use, and at once when the user is deactivated, their password is reset or their tenant is suspended. "Your session has ended" on the sign-in page is expected then. After signing in again, a dispatcher who was on the dispatch screen returns to the same day and depot.
- Only the server can end a session: opening `/api/auth/end-session` (for example from a link on another site) while the session is still valid just goes to the dashboard.
- After 5 wrong passwords in 15 min from one place, sign-in for that email pauses for up to 15 min (same error message). It never locks the account.

---

## Auth and password resets

### Standard reset (email)
`/forgot` sends a reset link through Resend when `RESEND_API_KEY` (and a verified `RESEND_FROM`) is set on web. Without it production sends nothing and logs nothing about the link (`/api/health` shows `"email":"not_configured"`), and `/forgot` says "Reset by email is not available" and points the user to their company admin. Only the newest link works; a reset ends the user's open sessions.

### Admin reset (works without email)
A tenant admin opens `/t/{slug}/users` and clicks **Reset password** on the user's row (`POST /api/users/:id/reset-password`).
- The old password stops working at once, the user is signed out on every device, and any outstanding reset link is retired.
- The admin sees a new one-time password once. Share it over a secure channel (in person or by phone); it is stored only as a hash.
- The audit log gets a `PASSWORD_RESET_BY_ADMIN` row (who reset whom; never the password).
- A tenant admin cannot reset a platform admin's password (403) or their own (400): another admin of the company does it.

Inviting the user again does **not** work for an existing account (the email already exists: 409), and neither does deactivating them first.

### Last resort: SQL
Only when no other admin can sign in (for example the company's only admin lost their password while email is not configured): an admin with database access runs the SQL below after a backup. Never put a real password in a file, a script or a commit.
```sql
UPDATE "User"
   SET "passwordHash" = '<bcrypt-12 hash of new pwd>'
 WHERE email = '<user email>';
```
Generate the hash interactively (`node -e "..."` reading the password from a prompt), never with the password written into a script. The user's open sessions end on their next request.

### Inviting a teammate
Tenant admin uses `/t/{slug}/users` → "Invite user". Returns a one-time temp password shown to the inviter (copy → share over a secure channel). No emails sent in v1. An email that already has an account is refused (409); for an existing user who lost their password use **Reset password** instead.

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
  - The RECOMMENDED time limit scales with the stop count: 5 s (≤25), 20 s (≤200), 150 s (≤350), 240 s (>350). The alternatives get half.
  - After the searches, a **post-solve load re-check** (`apps/solver/load_repack.py`, CP-SAT) re-assigns whole loads to trucks and departure times, times every plan exactly (including the loading time per case between loads) and picks each option's plan. Each CP-SAT solve is capped at min(15 s, max(3 s, time limit / 2)). On the real 80-stop NMWC day it adds about 15-20 s; a normal day takes about half a minute to a minute in total.
  - The re-check runs in the worker pool with its own deadline inside the request budget. If an alternative overran its deadline, the pool is replaced first so the re-check never waits behind a stuck search. If the re-check fails or runs out of time, the plans are the search results as found, with the note *"Loads were not re-checked for fewer trucks ..."*.
  - The whole solve stays within a 540 s budget. Alternatives that would overrun it are skipped with a warning.
  - The web waits up to 600 s.
- `TenantConfig.solverTimeLimitSeconds` currently has **no effect**. It belonged to the previous (PyVRP) planner, which can no longer be started: old plans are read-only (`409 LEGACY_PLAN`).
- Dispatch planner: every scenario runs in a worker process.
  - OR-Tools holds the GIL during its search. So neither the API process nor threads may run it, or `/health` and every other request freeze until the search ends.
  - RECOMMENDED runs first; the two alternatives then run in parallel, warm-started from it; then the load re-check (one worker per job, at most two).
  - If the worker computing the recommended plan dies (e.g. out of memory), the optimization fails within seconds with a clear message. If an alternative's worker dies, only that alternative is skipped (with a warning) after its deadline.
  - `SOLVER_PARALLEL=0` runs everything in-process (tests / debugging only).

---

## Deployment

### Single-replica enforcement
**v1 deployment MUST run exactly one `routeiq-web` Railway replica.** The in-memory `inflight` map in `lib/jobs/optimize-job.ts` prevents duplicate solver calls within one process but is **NOT** safe under horizontal scaling. Adding a second replica WILL produce duplicate solver runs and unpredictable RunJob state.

If you need to scale beyond one web instance, swap the inflight map for Redis-backed locks (BullMQ recommended) before scaling — that's a v2 prerequisite.

### Migrations
- `pnpm db:migrate:deploy` runs on Railway as the web service's **pre-deploy** step (web → Settings → Deploy; see docs/RAILWAY_DEPLOYMENT.md). A failed migration stops the deploy before the new version starts.
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
| Credential sign-in | 5 failures per IP + email in 15 min (a success clears it); 30 attempts per IP in 10 min; 20 failures per account in 1 h write a `LOGIN_THROTTLED` audit row (no account lock) | `lib/auth-credentials.ts` |
| `/api/auth/signup`, `/forgot`, `/reset` | 5/min/IP | `lib/rate-limit.ts` `LIMITS.auth` |
| `/api/orders/upload` | 60/hr/user | `LIMITS.ordersUpload` |
| `/api/customers/import` | 60/hr/user | `LIMITS.ordersUpload` |
| `/api/runs/{id}/baseline` | 60/hr/user | `LIMITS.ordersUpload` |
| `/api/runs/{id}/optimize` | 30/hr/tenant | `LIMITS.optimize` |
| Other authenticated endpoints | none | |

The IP is the proxy-appended one (`TRUSTED_PROXY_HOPS` / `CLIENT_IP_HEADER`, `lib/client-ip.ts`). Buckets live in memory (one web replica), are swept when they expire and capped in number. `RATE_LIMITS_DISABLED=1` is for test servers only: it is ignored on Railway. Moving to a shared store (Redis) is needed before running more than one web replica.

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
