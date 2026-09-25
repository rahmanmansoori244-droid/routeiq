# RouteIQ - security model and owner runbook

This page describes how sign-in, sessions, roles and service secrets work after the **stabilization release, PR1 (security hardening)**, and what the owner must do in production for it. It answers the external review (`RouteIQ_Deep_Review.md`, verified in the stabilization plan). The rest of the system is described in [`PROJECT_HANDBOOK.md`](./PROJECT_HANDBOOK.md). No secret values appear here.

## 1. Sessions

| Rule | Where |
|---|---|
| Sign-in is a NextAuth (v5 beta) credentials session in an encrypted JWT cookie. It carries `userId`, `tenantId`, `role`, `authTime` (sign-in time) and `pwf` (first 16 hex chars of SHA-256 of the password hash) | `apps/web/lib/auth.ts` |
| **Idle timeout 8 h** (the cookie slides forward while used) and **absolute lifetime 12 h** from sign-in: a dispatcher signs in once per shift. The absolute limit is checked in every runtime, the edge middleware included | `SESSION_ABSOLUTE_MS`, `withinAbsoluteLifetime` in `lib/session-principal.ts` |
| **Every session read on the server re-loads the user** (cached 30 s per user). The session ends when the user is inactive or deleted, the tenant is inactive, the user moved tenant, or the password changed (`pwf` differs). Role and tenant always come from the database, so a demotion applies within 30 s, at once when made through the Users screen | `loadPrincipal`, `evaluatePrincipal`, `refreshSessionClaims` |
| If the database cannot be read, a reading from the last 10 minutes is used; otherwise the session ends (fail closed) | `PRINCIPAL_STALE_IF_ERROR_MS` |
| The edge middleware cannot reach the database. When the server rejects a cookie the middleware still accepts, pages send the browser to `/api/auth/end-session`, which clears it and lands on `/login?reason=session` ("Your session has ended"). This removed the old `/` <-> `/login` redirect loop | `lib/session-redirect.ts`, `app/api/auth/end-session/route.ts`, `app/page.tsx`, `lib/tenant.ts` |
| Cookies issued before this release have no `authTime` / `pwf`: **every user signs in once after the deploy** | |

## 2. Sign-in

- `lib/auth-credentials.ts` checks email and password.
  - **Timing:** an unknown email is still compared against a throw-away bcrypt hash of the same cost; an inactive user or tenant is refused only after the real compare.
  - **Soft throttle (no account lock):** 5 failures in 15 min for one IP + email pause that pair (a success clears it); 30 attempts in 10 min per IP; 20 failures in 1 h for one account from any IP write one `LOGIN_THROTTLED` audit row in that tenant, so an admin sees guessing, but never lock the dispatcher out.
  - **One message** for every failure: "Invalid email or password. After several failed attempts, sign-in pauses for a few minutes."
- **Client IP** (`lib/client-ip.ts`): the left end of `X-Forwarded-For` is client-controlled and never used. The IP is the entry `TRUSTED_PROXY_HOPS` places from the right (default 1), or the single-value header named by `CLIENT_IP_HEADER`. The same IP goes into audit rows.
- **After sign-in** (`lib/safe-redirect.ts`): `callbackUrl` is reduced to a same-origin path under `/`, `/t/...` or `/admin...`, on the server and again in the browser. `javascript:`, `data:`, `//host` and `/\host` values become `/`. The middleware keeps the query string, so dispatch deep links (`?date=&depot=`) survive sign-in.
- **Headers** (`next.config.js`): HSTS, `nosniff`, `X-Frame-Options: DENY`, and a baseline CSP `frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'`. A full `script-src` policy needs nonces and waits for the Next.js upgrade.

## 3. Sign-up and platform admins

- **Public sign-up stays open** (owner decision, Sep 2026). It creates a new company (tenant) whose first user is that company's **TENANT_ADMIN**. It **never** creates a platform admin, whatever `SUPER_ADMIN_EMAILS` says. `SIGNUP_MODE=closed` turns sign-up off: the API answers 404, `/signup` says so, and the login page hides "Create one".
- **Platform admin (SUPER_ADMIN)** needs BOTH:
  1. the email in `SUPER_ADMIN_EMAILS` on the web service, and
  2. the role, granted only by the owner-run script, run from the owner's machine against the production database through the Postgres public URL (`DATABASE_PUBLIC_URL`, the TCP proxy; the private `postgres.railway.internal` does not resolve outside Railway):
     ```bash
     DATABASE_URL='<DATABASE_PUBLIC_URL>' SUPER_ADMIN_EMAILS='<same list as on web>'        pnpm --filter @routeiq/web exec tsx prisma/grant-platform-admin.ts <email>            # grant
     DATABASE_URL='<DATABASE_PUBLIC_URL>' pnpm --filter @routeiq/web exec tsx prisma/grant-platform-admin.ts <email> --revoke
     ```
     `SUPER_ADMIN_EMAILS` here only drives the script's reminder; the web service's own value is what counts. The script writes `PLATFORM_ADMIN_GRANTED` / `PLATFORM_ADMIN_REVOKED` in the user's tenant. Revoking returns the user to TENANT_ADMIN of their tenant, or deactivates a user without a tenant.
  A user with the SUPER_ADMIN role whose email is not on the list acts as TENANT_ADMIN of their own tenant (no tenant: no session). An env edit alone or a database edit alone grants nothing.
- A platform admin may open any tenant's pages; each view writes one `CROSS_TENANT_VIEW` row in **that** tenant's audit log (at most once per admin, tenant and hour). API calls still act on the admin's own tenant only.
- A TENANT_ADMIN cannot change a SUPER_ADMIN account (403; the Users screen locks the switch).
- Deactivating a tenant (`Tenant.active = false`) now blocks its sign-in and every API call and page. **Before deactivating a tenant, check that no platform admin account belongs to it**, or that admin loses access too.

## 4. Roles on the API

The complete matrix is checked in and enforced by `apps/web/tests/lib/api-role-matrix.spec.ts` (a new, removed or re-gated handler fails CI until the table is updated on purpose). Decisions in this release:

| Data | Minimum role |
|---|---|
| Users list (`GET /api/users`), audit log (`GET /api/audit`), tenant settings (`GET /api/tenant/config`) | TENANT_ADMIN, like their pages |
| Job debug JSON (`GET /api/runs/:id/jobs/:jobId/debug`: the full solver request with revenue, margins and coordinates) | SUPERVISOR. A job of another run is 404 |
| `GET /api/runs/:id` | any role, job status only (no solver request/response JSON) |
| Plan detail and the Excel / PDF exports | any role (the dispatch team reads plans) |

## 5. Secrets and credentials

- **Password reset** (`lib/password-reset.ts`): in production the link is sent only through Resend (`RESEND_API_KEY`, verified `RESEND_FROM`); without it **nothing is sent and nothing about the link is logged** (only the user id). Links use `AUTH_URL`, else `NEXTAUTH_URL`; production refuses to build one without either. Issuing a link retires older ones; a reset consumes the token, sets the password and retires the user's other links in one transaction, and ends every open session of that user (`pwf`). Until Resend is configured, admins reset passwords through the invite / temporary-password flow. `/api/health` reports `email: configured | not_configured`.
- **Audit JSON never holds credentials:** `accessPinHash`, `passwordHash`, `sessionToken` and `tokenHash` are removed on write and on read (`redactForAudit` in `lib/audit.ts`).
- **Driver rows** are always read and written with `DRIVER_PUBLIC_SELECT` (`lib/driver-fields.ts`); a repo test fails on a Driver query under `app/` without a `select`.
- **No hard-coded passwords:** the legacy `prisma/seed-nmwc.ts` (and `db:seed:nmwc`) is deleted; its value is in git history and must be treated as compromised. A test fails on any hash of a string literal.
- **Solver token:** one constant-time check (`hmac.compare_digest` on bytes) for every solver endpoint except `/health`.
- **Janitor token:** in production `/api/cron/janitor` accepts only `JANITOR_TOKEN`, never `SOLVER_TOKEN`. The in-process janitor runs regardless.
- **Rate limiter** (`lib/rate-limit.ts`): expired buckets are swept and the map is capped. `RATE_LIMITS_DISABLED=1` (test servers) is ignored on Railway and logged as an error on any other production server.
- **Startup warnings** (web log, `[config] ...`): missing `RESEND_API_KEY`, `AUTH_URL`/`NEXTAUTH_URL`, `JANITOR_TOKEN`, or `RATE_LIMITS_DISABLED` set.
- **No public OSRM default:** with `OSRM_URL` unset the legacy Map tab draws straight lines and the legacy solver matrix stays Haversine; customer coordinates never go to a third-party demo server.

## 6. The legacy driver phone app is retired

Owner decision (Sep 2026). `/api/driver/{login,manifest,ping,stop,shift/end}`, `POST /api/drivers/:id/pin` and `GET /api/runs/:id/live` answer **410 Gone** before any authentication or database work (`lib/driver-app.ts`). `/driver` shows a notice and clears the old sign-in data from the phone; the Set-PIN and Live buttons are gone. **Driver sheets (PDF), WhatsApp messages and the driver per load are unchanged.** The data (`DriverShift`, `TruckLocation`, `DeliveryProof`) is kept; dropping it is a later contract migration. Re-enabling the app would first need the review's F12 / F14 / PIN fixes and multi-load support.

Deleting a driver who is on any load (or a legacy shift) now **deactivates** the driver instead, so dispatched and completed loads keep their driver.

Migration `20260926090000_retire_driver_app_scrub_secrets` (data only, idempotent, runs at deploy): ends every ACTIVE driver-app shift, clears every `Driver.accessPinHash`, removes the credential-hash keys from `AuditLog` JSON, and writes one `SECURITY_CLEANUP` audit row per affected tenant with the counts.

## 7. Owner runbook for deploying PR1

**Before merging**

1. Take a fresh Postgres backup (Postgres -> Backups -> New backup).
2. Set on the **web** service (names only; values in Railway):
   - `JANITOR_TOKEN`: a new random value, different from `SOLVER_TOKEN`. Update any external cron that calls `/api/cron/janitor`.
   - `RESEND_API_KEY` and a verified `RESEND_FROM` (or accept that reset emails are not sent; use invites).
   - `AUTH_URL` (or `NEXTAUTH_URL`) = the public web URL.
   - `TRUSTED_PROXY_HOPS` (normally `1`), or `CLIENT_IP_HEADER` if Railway's edge sets a single client-IP header. Confirm with step 5 below.
   - `SUPER_ADMIN_EMAILS`: only addresses of real platform admins the owner controls.
   - Make sure `RATE_LIMITS_DISABLED` is **not** set.
   - Leave `SIGNUP_MODE` unset (open) unless sign-up should be closed.
3. Deploy after the morning dispatch is out, not during evening planning. Everyone signs in again once.

**After deploy**

1. The dispatcher, supervisor and admin can sign in. An old browser tab lands on `/login` ("Your session has ended"), never in a loop.
2. With your own account: open `/login?callbackUrl=//evil.example`, sign in, and land on `/`.
3. `POST /api/driver/login` returns 410. (`POST /api/auth/signup` still returns 201/400: sign-up is open by decision.)
4. `GET /api/health` shows `"email":"configured"` (once Resend is set). The web log shows no `[config]` error and no `dev fallback` line.
5. **Client IP check:** sign in, then look at the newest `LOGIN` row in the Audit log: its IP must be your real public address. If it shows a Railway/internal address, change `TRUSTED_PROXY_HOPS` / `CLIENT_IP_HEADER` and redeploy.
6. The in-process janitor still reaps stuck jobs (web log); an external cron now uses `JANITOR_TOKEN`.
7. Read-only checks (with the Postgres public URL):
   ```sql
   SELECT count(*) FROM "Driver" WHERE "accessPinHash" IS NOT NULL;           -- expect 0
   SELECT count(*) FROM "DriverShift" WHERE status = 'ACTIVE';               -- expect 0
   SELECT count(*) FROM "AuditLog" WHERE "beforeJson" ? 'accessPinHash' OR "afterJson" ? 'accessPinHash';  -- expect 0
   SELECT email, role, active, "tenantId" FROM "User" WHERE role = 'SUPER_ADMIN' OR email LIKE '%.test';
   SELECT code, active FROM "Driver" WHERE code = 'SMOKE-DRV';
   SELECT s.id FROM "DriverShift" s JOIN "RunPlan" r ON r.id = s."runId" WHERE r."tenantId" <> s."tenantId";
   ```
   A driver change made through the old code in the minute of the deploy overlap could re-add a PIN hash; if the first three counts are not 0, re-run the three updates of the migration by hand after a backup.
8. Clean-up decisions for the owner (reversible; after a backup):
   - deactivate `admin@nmwc.test` (the published legacy seed login) if it exists, and any other unexpected `*.test` admin;
   - demote any unexpected SUPER_ADMIN (`grant-platform-admin.ts <email> --revoke`);
   - deactivate `SMOKE-DRV` if it exists (it cannot be deleted: its legacy shift references it);
   - if the cross-tenant `DriverShift` query returns rows, null their `runId`;
   - deactivate the public-sign-up test tenant unless it is the owner's `nmlj` test company, and check that its APIs answer 401 and `/` does not loop.

## 8. Review items addressed in PR1

| Review item | What changed |
|---|---|
| F09 sessions not re-checked; sliding session with no absolute lifetime | Sections 1, 3 |
| /login <-> / loop; `Tenant.active` not enforced | Section 1 (`end-session`), section 3 |
| F10 open sign-up, SUPER_ADMIN at sign-up | Section 3 (sign-up open by owner decision, never SUPER_ADMIN; owner script) |
| F11 `callbackUrl` open redirect / script sink; query string lost; no CSP | Section 2 |
| F16 (part) credential guessing, account enumeration, spoofable client IP, limiter memory, `RATE_LIMITS_DISABLED` | Sections 2, 5. Solve admission quotas are PR3 |
| TENANT_ADMIN could change a SUPER_ADMIN; cross-tenant views unaudited | Section 3 |
| L7 solver token compare; janitor accepting `SOLVER_TOKEN` | Section 5 |
| L8 reset links in logs; reset not transactional; other links not revoked | Section 5 |
| L9 hard-coded seed password | Section 5 |
| F13 driver PIN hashes in API, Drivers page and audit JSON | Sections 5, 6 |
| F15 / F23 role gates (users, audit, config, job debug, runs GET) | Section 4 |
| L16 (part) job debug for another run was a 500 | Section 4 (404). The late-order part is a later PR |
| F12, F14, driver PIN issues | Moot: the driver app is retired (section 6) |
| Driver hard delete erased the driver on dispatched loads | Section 6 |
| `smoke-driver-flow.ts` residue | Script deleted; clean-up in section 7 |
| F22 public OSRM default | Section 5 (minimal); the full route-geometries rework is PR5 |

Deferred on purpose: email verification or invite codes for public sign-up, a `sessionVersion` "sign out everywhere", forcing a password change after an invite's temporary password, a nonce-based `script-src` CSP, and dropping the driver-app tables.
