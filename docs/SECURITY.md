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
| `end-session` **signs out only a session the server rejects**, decided on a fresh reading of the user (`refreshPrincipal`, not the 30 s cache). A session that is still valid is sent to `/` untouched, so a link or redirect from another site cannot sign a dispatcher out (it is a plain GET) | `app/api/auth/end-session/route.ts` |
| The dispatch screen reacts to any `401` by going to `end-session?next=<its page>` without showing an error. `next` goes through `safeCallbackUrl` and becomes the sign-in page's `callbackUrl`, so the dispatcher comes back to the same day and depot (`?date=&depot=`). Only "no session" answers 401; a session without a tenant gets 403 | `app/t/[slug]/dispatch/client-api.ts`, `sessionEndedLoginUrl` in `lib/safe-redirect.ts` |
| Cookies issued before this release have no `authTime` / `pwf`: **every user signs in once after the deploy** | |

## 2. Sign-in

- `lib/auth-credentials.ts` checks email and password.
  - **Timing:** an unknown email is still compared against a throw-away bcrypt hash of the same cost; an inactive user or tenant is refused only after the real compare.
  - **Soft throttle (no account lock):** 5 failures in 15 min for one IP + email pause that pair (a success clears it); 30 attempts in 10 min per IP; 20 failures in 1 h for one account from any IP write one `LOGIN_THROTTLED` audit row in that tenant, so an admin sees guessing, but never lock the dispatcher out.
  - **When the client IP cannot be resolved** (`TRUSTED_PROXY_HOPS=0`, or `CLIENT_IP_HEADER` names a header the edge does not send), the per-IP cap is skipped: every caller would share one bucket, and one outsider could pause sign-in for all tenants. The IP + email and per-account counters still apply. The web log shows one `[client-ip] the client IP could not be resolved (...)` warning, and audit rows have no IP.
  - **One message** for every failure: "Invalid email or password. After several failed attempts, sign-in pauses for a few minutes."
- **Client IP** (`lib/client-ip.ts`): the left end of `X-Forwarded-For` is client-controlled and never used. The IP is the entry `TRUSTED_PROXY_HOPS` places from the right (default 1), or the single-value header named by `CLIENT_IP_HEADER`. The same IP goes into audit rows: every route and `audit()` get it from `clientIp()` / `clientIpFromHeaders()`, and a repo test fails on any other file under `app/` or `lib/` that reads `X-Forwarded-For` or `X-Real-IP` (the order upload, customer import and baseline upload routes used to record the left-most entry).
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
- A TENANT_ADMIN cannot change a SUPER_ADMIN account (403; the Users screen locks the switch and the Reset password button).
- Deactivating a tenant (`Tenant.active = false`) now blocks its sign-in and every API call and page. **Before deactivating a tenant, check that no platform admin account belongs to it**, or that admin loses access too.

## 4. Roles on the API

The complete matrix is checked in and enforced by `apps/web/tests/lib/api-role-matrix.spec.ts` (a new, removed or re-gated handler fails CI until the table is updated on purpose). Decisions in this release:

| Data | Minimum role |
|---|---|
| Users list (`GET /api/users`), audit log (`GET /api/audit`), tenant settings (`GET /api/tenant/config`) | TENANT_ADMIN, like their pages |
| Job debug JSON (`GET /api/runs/:id/jobs/:jobId/debug`: the full solver request with revenue, margins and coordinates) | SUPERVISOR. A job of another run is 404 |
| `GET /api/runs/:id` | any role, job status only (no solver request/response JSON) |
| Admin password reset (`POST /api/users/:id/reset-password`: a new one-time password for a user) | TENANT_ADMIN. Never a platform admin unless the caller is one (403), never your own account (400); another tenant's user is 404 |
| Plan detail and the Excel / PDF exports | any role (the dispatch team reads plans) |

## 5. Secrets and credentials

- **Password reset** (`lib/password-reset.ts`): in production the link is sent only through Resend (`RESEND_API_KEY`, verified `RESEND_FROM`); without it **nothing is sent and nothing about the link is logged** (only the user id). Links use `AUTH_URL`, else `NEXTAUTH_URL`; production refuses to build one without either. Issuing a link retires older ones; a reset consumes the token, sets the password and retires the user's other links in one transaction, and ends every open session of that user (`pwf`). `/api/health` reports `email: configured | not_configured`.
- **Admin password reset** (works without email): a tenant admin clicks **Reset password** on the Users screen (`POST /api/users/:id/reset-password`). In one transaction the hash is replaced, the user's outstanding reset links are retired and a `PASSWORD_RESET_BY_ADMIN` audit row is written (who reset whom; no hash, no password). The cached session state is dropped, so the user's open sessions end on their next request. The new one-time password is shown once (`Cache-Control: no-store`). Until Resend is configured this is the reset path, and `/forgot` says "Reset by email is not available" instead of showing a form that would send nothing. Inviting an existing email again is refused (409).
- **Audit JSON never holds credentials:** `accessPinHash`, `passwordHash`, `sessionToken` and `tokenHash` are removed on write and on read (`redactForAudit` in `lib/audit.ts`).
- **Driver rows** are always read and written with `DRIVER_PUBLIC_SELECT` (`lib/driver-fields.ts`); a repo test fails on a Driver query under `app/` without a `select`.
- **No hard-coded passwords:** the legacy `prisma/seed-nmwc.ts` (and `db:seed:nmwc`) is deleted; its value is in git history and must be treated as compromised. A test fails on any hash of a string literal.
- **Solver token:** one constant-time check (`hmac.compare_digest` on bytes) for every solver endpoint except `/health`.
- **Janitor token:** in production `/api/cron/janitor` accepts only `JANITOR_TOKEN`, never `SOLVER_TOKEN`. The in-process janitor runs regardless.
- **Rate limiter** (`lib/rate-limit.ts`): expired buckets are swept and the map is capped. `RATE_LIMITS_DISABLED=1` (test servers) is ignored on Railway and logged as an error on any other production server.
- **Solve admission** (PR3, review F16; `lib/dispatch/solve-admission.ts`): every way to start an optimization (`POST /api/dispatch/plan` with optimize, `POST /api/runs/:id/replan`, `POST /api/runs/:id/optimize`) goes through one gate - 15 starts per user and 30 per company in any rolling hour (429 with `Retry-After`; refused and no-op requests use no quota), `SOLVER_MAX_CONCURRENT` (default 2) solves at once in total and one less per company (at least 1), so one company can never hold every slot; further starts wait in a queue where each company may have at most 2 waiting (one more gets 429 for that company only). The shared queue holds 10: when it is full, only a company that already has a solve waiting is refused (503); a company with nothing waiting is always queued, up to an absolute cap of 200 waiting (process memory). A freed slot goes to the company with the fewest solves running, then first come first served by when the solve was queued (a company that never ran a solve gets no head start). What another company, NMWC included, is guaranteed while public sign-up companies flood the solver: a company with nothing waiting is never refused because others filled the queue (only at 200 waiting); while one of its solves waits, a further start (another depot, another day) can get 503 until there is room. A company with nothing running is never overtaken by a solve queued after its own: its solve runs at once when a slot is free, and otherwise waits at most for the solves queued before it. Once it runs a solve, solves queued later by companies running fewer can start first, and at its own cap (1 with the defaults) its next solve waits for its running one to end (third review of PR3: this sentence used to promise more than the code does; review of PR3: the first defaults let one company take both slots and the whole queue; second review: five sign-up companies with 2 waiting each filled the queue of 10, so NMWC got 503 as long as they kept it full, and fresh sign-ups went ahead of NMWC's waiting solve). The solver itself refuses more than `MAX_CONCURRENT_DISPATCH` concurrent solves with 503 "solver busy" (`apps/solver/main.py`). The quotas follow `RATE_LIMITS_DISABLED` (off in tests); the concurrency and queue caps always apply.
- **Startup warnings** (web log, `[config] ...`): missing `RESEND_API_KEY`, `AUTH_URL`/`NEXTAUTH_URL`, `JANITOR_TOKEN`, or `RATE_LIMITS_DISABLED` set.
- **No public OSRM default:** the legacy solver matrix stays Haversine without `OSRM_URL`; customer coordinates never go to a third-party demo server. Since PR5 the web calls **no** routing service at all: the legacy Map tab (`/api/runs/:id/route-geometries`) goes through the solver's private, token-protected `/route-geometry` like the dispatch map, `lib/road-routing.ts` is deleted, and a dispatch plan's legacy geometry request answers 409 (review F22).

## 6. The legacy driver phone app is retired

Owner decision (Sep 2026). `/api/driver/{login,manifest,ping,stop,shift/end}`, `POST /api/drivers/:id/pin` and `GET /api/runs/:id/live` answer **410 Gone** before any authentication or database work (`lib/driver-app.ts`). `/driver` shows a notice and clears the old sign-in data from the phone; the Set-PIN and Live buttons are gone. **Driver sheets (PDF), WhatsApp messages and the driver per load are unchanged.** The data (`DriverShift`, `TruckLocation`, `DeliveryProof`) is kept; dropping it is a later contract migration. Re-enabling the app would first need the review's F12 / F14 / PIN fixes and multi-load support.

Deleting a driver who is on any load (or a legacy shift) now **deactivates** the driver instead, so dispatched and completed loads keep their driver.

Migration `20260926090000_retire_driver_app_scrub_secrets` (data only, idempotent, runs at deploy): ends every ACTIVE driver-app shift, clears every `Driver.accessPinHash`, removes the credential-hash keys from `AuditLog` JSON, and writes one `SECURITY_CLEANUP` audit row per affected tenant with the counts.

## 7. Owner runbook for deploying PR1

**Before merging**

1. Take a fresh Postgres backup (Postgres -> Backups -> New backup).
2. Set on the **web** service (names only; values in Railway):
   - `JANITOR_TOKEN`: a new random value, different from `SOLVER_TOKEN`. Update any external cron that calls `/api/cron/janitor`.
   - `RESEND_API_KEY` and a verified `RESEND_FROM` (or accept that reset emails are not sent: `/forgot` then says so, and tenant admins use **Reset password** on the Users screen).
   - `AUTH_URL` (or `NEXTAUTH_URL`) = the public web URL.
   - `TRUSTED_PROXY_HOPS` (normally `1`). Set `CLIENT_IP_HEADER` only to a header you have confirmed Railway's edge sends: a missing header leaves every IP unknown. Confirm with step 5 below.
   - `SUPER_ADMIN_EMAILS`: only addresses of real platform admins the owner controls.
   - Make sure `RATE_LIMITS_DISABLED` is **not** set.
   - Leave `SIGNUP_MODE` unset (open) unless sign-up should be closed.
3. Deploy after the morning dispatch is out, not during evening planning. Everyone signs in again once.

**After deploy**

1. The dispatcher, supervisor and admin can sign in. An old browser tab lands on `/login` ("Your session has ended"), never in a loop.
2. With your own account: open `/login?callbackUrl=//evil.example`, sign in, and land on `/`.
3. `POST /api/driver/login` returns 410. (`POST /api/auth/signup` still returns 201/400: sign-up is open by decision.)
4. `GET /api/health` shows `"email":"configured"` (once Resend is set). The web log shows no `[config]` error and no `dev fallback` line.
5. **Client IP check:** sign in, then look at the newest `LOGIN` row in the Audit log: its IP must be your real public address.
   - A Railway/internal address: change `TRUSTED_PROXY_HOPS` / `CLIENT_IP_HEADER` and redeploy (the web log also shows `[client-ip] ... internal address`).
   - An **empty** IP: the address is not resolved at all (the web log shows `[client-ip] the client IP could not be resolved (...)`), and sign-in runs on per-account limits only. Unset `CLIENT_IP_HEADER` (or set it to a header the edge really sends) and make sure `TRUSTED_PROXY_HOPS` is not `0`, then redeploy.
6. The in-process janitor still reaps stuck jobs (web log); an external cron now uses `JANITOR_TOKEN`.
7. **Password reset without email:** on the Users screen, **Reset password** on a test user shows a new temporary password; that user's old password stops working and the new one signs in. `/forgot` says "Reset by email is not available" until Resend is set.
8. **No forced logout:** while signed in, open `/api/auth/end-session` in the address bar: you land on your dashboard, still signed in.
9. Read-only checks (with the Postgres public URL):
   ```sql
   SELECT count(*) FROM "Driver" WHERE "accessPinHash" IS NOT NULL;           -- expect 0
   SELECT count(*) FROM "DriverShift" WHERE status = 'ACTIVE';               -- expect 0
   SELECT count(*) FROM "AuditLog" WHERE "beforeJson" ? 'accessPinHash' OR "afterJson" ? 'accessPinHash';  -- expect 0
   SELECT email, role, active, "tenantId" FROM "User" WHERE role = 'SUPER_ADMIN' OR email LIKE '%.test';
   SELECT code, active FROM "Driver" WHERE code = 'SMOKE-DRV';
   SELECT s.id FROM "DriverShift" s JOIN "RunPlan" r ON r.id = s."runId" WHERE r."tenantId" <> s."tenantId";
   ```
   A driver change made through the old code in the minute of the deploy overlap could re-add a PIN hash; if the first three counts are not 0, re-run the three updates of the migration by hand after a backup.
10. Clean-up decisions for the owner (reversible; after a backup):
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
| F16 (part) credential guessing, account enumeration, spoofable client IP, limiter memory, `RATE_LIMITS_DISABLED` | Sections 2, 5. The solve admission (quotas, concurrency queue, solver 503 cap) is done in PR3, section 5 |
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
| F22 public OSRM default | Section 5 (minimal) in PR1; PR5 completed it: route-geometries through the solver, `lib/road-routing.ts` deleted, 409 for dispatch plans. The docs no longer suggest the public demo server even for local demos |
| Verification follow-up: the documented "invite / temporary-password" and "deactivate and invite again" reset paths did not exist (409) | Section 5 (admin password reset on the Users screen; `/forgot` says when email reset is unavailable) |
| Verification follow-up: three upload routes still wrote the left-most `X-Forwarded-For` entry into audit rows | Section 2 (`clientIp()` everywhere; repo guard) |
| Verification follow-up: `/api/auth/end-session` signed out any valid session on a cross-site GET | Section 1 (only a session the server rejects is signed out) |
| Verification follow-up: an unresolved client IP put every sign-in into one shared per-IP bucket | Section 2 (per-IP cap skipped without an IP; one-time log warning) |
| Verification follow-up: a session ended during an API call lost the dispatch day and depot, and still showed "Unauthorized" | Section 1 (`next` kept as `callbackUrl`; no error toast) |

Deferred on purpose: email verification or invite codes for public sign-up, a `sessionVersion` "sign out everywhere", forcing a password change after an invite's or an admin reset's temporary password, a nonce-based `script-src` CSP, and dropping the driver-app tables.

## 9. Platform hardening after the audit of 27 Sep 2026 (A1)

The external audit of 27 Sep 2026 was verified independently (`.dev/audit-2026-09-27/VERIFIED-ASSESSMENT.md`). A1 is its "quick hardening" PR; the Next.js 16 upgrade (assessment PR 9) and the upload worker (assessment PR 5) come later.

- **Next.js 14 gets no more security fixes** (audit F01). The advisory the audit named cannot reach RouteIQ, because the app has no Server Actions. Until the upgrade:
  - **No Server Actions** (owner decision 4). A unit test (`tests/lib/build-hardening.spec.ts`) fails on any `'use server'` in the app's code, and CI fails after `next build` when the directive appears or `.next/server/server-reference-manifest.json` lists an action, including one that comes from a package (`apps/web/scripts/check-build-output.ts`). The unused `experimental.serverActions.bodySizeLimit` setting is removed.
  - **The image endpoint is off.** `images.unoptimized` in `next.config.js`: `/_next/image` answers 404 for everyone. It answered without login before, and several 14.x advisories without a fix are in it. The app uses no `next/image`. CI checks the running app (404, where the endpoint would answer 400).
  - **On the Windows PC the app binds to localhost** (decision 4): one of the recent critical Next.js advisories affects Windows hosts only. The dev script is `next dev -H 127.0.0.1` (`apps/web/package.json`), so `next dev` no longer listens on every interface; for a local production run use `next start -H 127.0.0.1`. `http://localhost:3000` still works (localhost resolves to 127.0.0.1), so the integration run and `TEST_BASE_URL` are unaffected. `start` on Railway keeps no `-H`, because Railway needs every interface. A unit test pins the dev binding (`tests/lib/build-hardening.spec.ts`). Railway (Linux) is not affected by the advisory.
- **Browser source maps are not served** (audit side item). Sentry 8 made source maps for every production build and left them in `.next/static`, which is public, so the readable source of the browser code could be downloaded from `/_next/static/chunks/*.js.map`. Now maps are made only when a Sentry upload is configured (`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`); Sentry deletes the JS maps after the upload, also when it fails, and the last step of `pnpm build` (`apps/web/scripts/remove-public-source-maps.mjs`) removes any `.map` still under `.next/static` (Sentry leaves the CSS maps). CI fails if any `.map` file is left under `.next/static` and checks that a chunk's `.map` answers 404. Maps already downloaded from an earlier build cannot be taken back; they hold nothing the browser code itself did not already contain, only in readable form (original file names, comments).
- **Node 22 LTS** (before A1 CI used Node 20, end of life since 30 Apr 2026, and `engines.node` allowed any version from 20): root `engines.node`, `.nvmrc`, `.node-version`, CI. On Railway check the Node version in the web build log after the deploy (`docs/PROJECT_HANDBOOK.md` 5.6).
- **An upload's work is bounded, but a large one still blocks the app for seconds** (audit E2, owner decision 16, and the A1 review). An upload is parsed in the web process; while it is parsed no other request is answered, and nothing can stop the parse once it has started. The 10 s "timeout" never worked and is removed. Instead each upload's work is bounded before and while it is read (`lib/csv.ts`, `lib/workbook-guard.ts`):
  - 10 MB per file; at most 50,100 rows of a sheet or CSV are read.
  - A file read as Excel must be an .xlsx, an old .xls or CSV text. SheetJS picks its reader from a file's first bytes, not its name, and several of its readers do far more work than the file's size (a 763-byte flat OpenDocument file took 7.7 s), so web pages, XML, OpenDocument, .xlsb, DIF, Lotus, dBASE, RTF, SocialCalc and real SYLK files are refused before it reads them. A file that begins with "ID" is only refused as SYLK when it really is SYLK (A1 v2): an order or customer CSV whose first column header is "ID", which a Windows browser sends as application/vnd.ms-excel, is read as CSV, as before this guard.
  - An .xlsx is measured by unpacking it (never by its zip headers) and refused over 50 MB unpacked, 1,000 parts, 2,500,000 cells with a value, 10,000 comments, or hyperlinks over more than 200,000 cells in all (SheetJS makes a cell for every address a link covers, whatever the row limit). Each part must have the same name in the zip's directory and in its own header (SheetJS reads the second). Binary parts (.bin) are hidden from SheetJS. An .xls that is a compound file has its structure checked first (A1 v2), in linear time, so XLSX.CFB.read cannot be made to use time and memory that grow with the square of the file's size (a crafted 2 MB file would otherwise use about 4 GB); an .xls is also refused over the same link limit. More than 10 sheets are refused before any sheet is read.
  - Before any sheet is turned into rows: a sheet wider than 200 columns, or sheets that span more than 2,500,000 cells (rows x columns), are refused; a range that claims more than its cells is first cut to its last cell.
  - Formulas are not read (their saved values are).

  Measured: crafted files that blocked the app for minutes or ran it out of memory (a 606 KB file unpacking to 200 MB, a 1.6 KB workbook claiming 16,384 columns, a 1.7 KB workbook with one link over the whole sheet, a 4 KB .xls with one link over 65,536 x 65,536 cells, a 1.2 MB workbook hiding a 400 MB one) are refused or read in milliseconds. **The largest files the caps allow still block the app**: an .xlsx of 50,000 rows x 49 columns (0.19 MB) 9-10 s and about 1 GB of memory, the same rows as CSV sent as Excel 7-11 s and 1.2 GB, ten sheets of 50,000 rows 5-6 s; NMWC's order file shape at the row limit (50,000 rows x 15 columns) about 2.5 s (the maintainer's machine; NMWC's real files are a few thousand rows and take well under a second). Only parsing in a worker that can really be stopped (assessment PR 5) removes this. SheetJS has many readers; these checks cover the ways found so far in which a small file makes it do large work, not every way that may exist.

Owner checks after the A1 deploy (read-only): `/_next/image?url=%2Ffavicon.ico&w=1&q=75` and any `/_next/static/chunks/<chunk>.js.map` answer 404; the web build log names Node 22 and has no Sentry "enabled source map generation" warning.
