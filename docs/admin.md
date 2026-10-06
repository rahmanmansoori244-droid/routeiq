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

### Start fresh (remove test data before a pilot)
Owner request of 4 Oct 2026. A company admin (TENANT_ADMIN; a platform admin only on their own company) opens **Settings** and uses the red **Start fresh (remove test data)** box at the bottom. The dispatcher (PLANNER), supervisors and viewers cannot (403). Code: `lib/start-fresh.ts`, `GET`/`POST /api/tenant/start-fresh`.
1. Take a manual Postgres backup first (Railway: Postgres → Backups → New backup). It is the only way back.
2. **Check what will be removed** shows the counts. Removed, for that company only: orders and order lines, order files, plan versions and options, optimization jobs, loads, stops, unserved rows, late orders, Bring forward copies and per-order delivery times (they are orders), driver links, delivery stops, events and photos, comparison baselines, the retired driver app's shifts / positions / proofs, and daily drivers with no load left. Kept: customers (pins, confirmed hours), products, trucks, regular drivers (and a daily driver who is a truck's default), depots, regions, users, settings, customer type defaults and the audit log.
3. Everything (default) or only data with a delivery date before a chosen day. Before a date, an order file that is not confirmed yet goes only when every delivery date in it is before that day (a file for the 4th and the 5th stays when the 5th is kept).
4. A red line warns when the removal includes loads already locked, loading, dispatched or completed, orders dated today or later, or driver links for today or later: after the pilot starts these may be real. Removing them needs one more tick ("These ... are test data too"); otherwise choose a date.
5. Tick the backup box, type the company slug, press the button. One transaction; the audit log gets `TEST_DATA_CLEARED` (counts, scope, what was live-looking, the ticks, user). The run removes only what the check showed: if anything was added since (for example a real order file confirmed), it removes nothing, checks again and shows the new numbers. A check older than 5 minutes is dropped from the screen.

Refused with nothing removed (409): an optimization of the company QUEUED or RUNNING (`OPTIMIZATION_RUNNING`: wait, or reset a stuck plan); a date that would split a Bring forward (`CARRIED_ACROSS_DATE`: the answer names a safe earlier date that keeps the whole chain and a safe later date that removes it, also when an order was brought forward more than once; or undo the Bring forward) or a plan from its orders (`PLAN_ACROSS_DATE`); more to remove than the check showed (`PREVIEW_STALE`); live-looking data without the extra tick (`LIVE_DATA_CONFIRM`); orders, plans, driver links or delivery results being changed at that moment (`BUSY`, `CHANGED`: try again). While it runs it holds the company's intake lock, the delivery-result lock of every depot-day and the driver-link lock of every truck-day it removes, so a driver's phone, an office Record or a new driver link waits and then finds the day gone. Rate limit: 10 attempts per admin per 10 minutes (a mistyped company code does not count); then "Too many attempts. Wait N minutes" (429, `Retry-After`). The limit is in memory per web process: the typed code, the backup tick, the check match and the live-data tick are the real brakes.

---

## Daily operations

### When a planner says "optimization failed"
1. Open the run detail page; the failure banner has a "Download debug JSON" button (SUPERVISOR and above: the JSON holds revenue, margins and coordinates).
2. The JSON contains `requestJson` (exact solver input), `responseJson` (if any), and `errorJson` (reason).
3. Common reasons:
   - `SOLVER_ERROR` with HTTP 5xx → solver crashed; check Railway logs for `routeiq-solver`
   - `SOLVER_ERROR` with HTTP 0 → solver unreachable; check `SOLVER_URL` / private DNS. If the message says `SOLVER_URL` "is not a usable address", set `SOLVER_URL` on web to `http://<solver private address>:<port>` as plain text (`/api/health` answers 503 `SOLVER_URL_INVALID` until then)
   - `STUCK` → the web process running the job stopped writing its heartbeat and the janitor failed it 5 min later ("No sign of life for 5 minutes ..."; a job from before heartbeats: no result after 15 min). Usually the web service restarted (a deploy) during the optimization; optimize again. With `NEXT_MANUAL_SIG_HANDLE=1` on web a deploy fails the job at once instead ("The server was restarted (an update) during this optimization ...").
   - `RESET` → a dispatcher pressed **Reset stuck plan** (audit log `PLAN_RESET`: who, when, the note).
   - `Solver returned HTTP 404` / "The route optimizer is being updated" → web was deployed before the solver finished deploying; retry in a minute.
4. Once the solver is healthy, click "Retry optimization" on the run — it spawns attempt #N+1 with the same input.

### When a run is stuck "Optimizing"
1. The orphan janitor runs **inside the web process every 60 s** (`lib/jobs/janitor-loop.ts`, started from `instrumentation.ts`).
   - It fails any `RunJob` RUNNING or still QUEUED whose heartbeat is older than 5 min (`STALE_HEARTBEAT_MS`). The web process running a job writes the heartbeat every 30 s while the job waits for a solver slot or for the optimizer, so a 20-minute Thorough search is never failed for running long, and a job whose process died is failed about 5 min after it stopped. A job from before heartbeats keeps the old rule: 15 min after it started (`STUCK_JOB_MS`). (The solver call itself waits at most 10 min for Quick and the Thorough cap + 2 min, 22 min by default.)
   - It flips the parent plan to `FAILED`, so it can be optimized again. The job, the plan and the `OPTIMIZE_FAILED` audit row are written in one transaction (audit F09): a failed write changes nothing and the next sweep retries. No cron service is needed.
   - (Audit F09) It also repairs any plan still `OPTIMIZING` whose current job has already ended (what the old janitor left when its second write failed): the plan goes to `FAILED` with an `OPTIMIZE_FAILED` audit row, reason `STUCK_PLAN`. **OPTIMIZE** and **Re-plan** stay greyed out while the plan shows *Optimizing…*: the janitor puts it back within a minute, or a dispatcher presses **Reset stuck plan** now (step 2); the plan screen then shows *Optimization failed* and both buttons work again. (An OPTIMIZE / RE-PLAN request that reaches the server for such a plan, for example from an API call, resets it the same way first, then starts a new optimization.)
   - At most every 10 min the same loop also runs the delivery outcome's sweeps: loads a driver reported back at the depot with a result on every stop become *Completed* (`completeReturnedLoads`; the last result normally does that at once), and the retention janitor deletes old photo bytes, positions and idle daily drivers' phones (below, *Photo and position retention*).
   - Every sweep (every 60 s) also runs the hire suggestion's two sweeps (below, *Trucks to hire*): `failLostHireChecks` ends a hire check lost with its web process (no heartbeat for 2 min), and `retireOneDayTrucks` switches off one-day hired trucks whose day is over (`Truck.active = false`, `ONE_DAY_TRUCKS_RETIRED`).
   - `ROUTEIQ_DISABLE_JANITOR=1` turns it off.
2. A **dispatcher** (the PLANNER role and above, since the owner decision of 5 Oct 2026; it was SUPERVISOR) does not have to wait: **Reset stuck plan** on the plan (`POST /api/runs/:id/reset-stuck`) puts the plan back to `FAILED` at once (audit `PLAN_RESET`). That covers a plan whose job has already ended (the case the janitor repairs within a minute) and a job lost by a restart (which the janitor fails only 5 minutes after its last heartbeat): the lost job is failed with the plan. It is refused while the optimization is really running in the web process or showed a sign of life (its heartbeat, start or creation) less than 2 minutes ago. A re-plan version keeps the plan it holds.
3. Read-only check for plans stuck this way (expect 0 rows once the janitor has run):
   ```sql
   SELECT p.id, p."runDate", p.version, j.status AS job_status FROM "RunPlan" p
   LEFT JOIN "RunJob" j ON j.id = p."currentJobId"
   WHERE p.status = 'OPTIMIZING' AND (j.id IS NULL OR j.status NOT IN ('QUEUED', 'RUNNING'));
   ```
4. To run the janitor manually:
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
1. Generate a new random 32-byte base64 secret. Paste it as plain text: a hidden space or curly quotes copied with it make `/api/health` answer 503 `SOLVER_TOKEN_INVALID`, and no plan can be optimized.
2. Set on `routeiq-solver` env → redeploy solver. **It will continue accepting the old token until restart.** Wait for the new replica to come up.
3. Set on `routeiq-web` env → redeploy web. Web will start sending the new token.
4. Verify a fresh optimize call works.
5. Done. Document the rotation date in the audit log of your infra system.

### Planner settings (Settings page, company admins)
- Since stabilization PR5 Settings shows only what the dispatch planner uses, with bounds equal to the optimizer's own (a value out of range is refused, and a value put straight into the database out of range makes the optimize answer 409 `SETTINGS_OUT_OF_RANGE` naming it). The economics are editable: **driver cost per hour** (paid for the whole truck day, turnaround and waiting included), **overtime after / per hour** (overtime after must be at most the shift maximum, checked when a save changes either; a stored threshold after a lowered shift maximum is shown as a note and does not block other saves; at the defaults 540 / 540 overtime never accrues), fuel price, road time factor, preferred-window penalty, planning cutoff and date order. Enter NMWC's real driver and overtime rates.
- Operations settings stay database-only and are shown read-only on the page: `timezone`, `osrmUrl` (never editable: the solver fetches it), `serviceAreaJson`, `priorityWeightsJson`, `orderColumnMapJson`, and the customer type defaults (`CustomerTypeProfile`).
- Two admins saving at once: each save sends only its changed fields and the values it showed; a save over a newer value answers 409 and saves nothing.
- **Truck capacity in pallets (owner decision 4 Oct 2026).** A truck with **Bays (pallet positions)** (Trucks, 1-40; empty = planned by cases as before) is planned by pallets: a load fits when its pallets (each product's cases / its **cases per pallet**, mixed pallets, each order line rounded up to 0.001 pallet) are at most bays x **Pallet fill** (Settings, Daily dispatch: timing, 50-100, default 100 = every bay, admin only; owner decision 4 Oct 2026) and its kg at most the payload when one is set (a payload of 0 is no weight limit: NMWC's trucks all have 0, and OPTIMIZE then never asks about order lines without a weight); its case capacity is then not used. Truck classes (*3 Ton*, *10 Ton*) are only names: NMWC sets 10 Ton = 12 bays, 3 Ton = 6 bays, the Nissan bus R0-2415 = 2 bays. Orders, invoices and the stops stay in cases; the plan, the Excel workbook, the driver sheets and WhatsApp add pallets for those loads only. Before switching a depot to bays, give every product its cases per pallet: **Products → Import products** (CSV / Excel: code, name, weight per case, cases per pallet, active; codes as the order file and the Products page take them, `lib/product-code.ts`; blank = keep, Validate only, a file with an error imports nothing, `PRODUCTS_IMPORTED` in the audit log). A case weight of 0 counts as blank, and a product that already has a case weight keeps it unless **Update case weights** is ticked; Validate only lists every weight that would change or be kept. A cases per pallet corrected after planning makes the day's plan out of date, and a planned load the new figure puts over its bays cannot be locked until a re-plan (`CAPACITY_PALLETS_NEW_FACTOR`). While a product of the day has none, OPTIMIZE and RE-PLAN answer 409 `PALLET_FACTOR_REQUIRED` (no override). Deploy the solver before the web: an older solver plans by cases and the plan says so.

### Tuning solver time limits
- **Dispatch planner (OR-Tools, Daily dispatch):** ignores `TenantConfig.solverTimeLimitSeconds`.
  - The RECOMMENDED time limit scales with the stop count (stabilization PR7): 5 s (≤25), 20 s (26-120), then straight lines to 50 s at 150 and 150 s at 200 stops (175 stops: 100 s), 150 s up to 350, 240 s (>350). The alternatives get half. (Before PR7: 20 s up to 200 stops, then 150 s. So 121-200-stop days now get more time and wait longer, up to about +3 min at 200 stops; no day size gets less than before, and `apps/solver/tests/test_repack.py` fails if one does.) Settings → Effective planner values shows the same schedule: it is kept in `packages/shared-types/src/planner-bounds.json` (`searchTimeSec`), and `apps/solver/tests/test_dispatch.py` fails if it differs from `auto_time_limit`; change both together.
  - After the searches, a **post-solve load re-check** (`apps/solver/load_repack.py`, CP-SAT) re-assigns whole loads to trucks and departure times, times every plan exactly (including the loading time per case between loads) and picks each option's plan. Each CP-SAT solve is capped at min(15 s, max(3 s, time limit / 2)). On the real 80-stop NMWC day it adds about 15-20 s; a normal day takes about half a minute to a minute in total.
  - The re-check runs in the worker pool with its own deadline inside the request budget. If an alternative overran its deadline, the pool is replaced first so the re-check never waits behind a stuck search. If the re-check fails or runs out of time, the plans are the search results as found, with the note *"Loads were not re-checked for fewer trucks ..."*.
  - The whole solve stays within a 540 s budget. Alternatives that would overrun it are skipped with a warning.
  - The web waits up to 600 s.
  - **Thorough search (29 Sep 2026).** OPTIMIZE and Re-plan ask *Quick* (everything above) or *Thorough*: the whole solve may take up to `THOROUGH_MAX_SEC` (default 1200 s = 20 min, set it on web and solver alike) and the recommended plan's search stops early once it has not improved for max(300 s, half the time searched so far) (`THOROUGH_STALL_SEC` / `THOROUGH_STALL_SHARE` on the solver; measured in `docs/OPTIMIZER_BENCHMARK.md` §11, leave them unless re-measured). Thorough is suggested for a plan made before its delivery day, Quick on the day itself. With the 20-min cap the alternatives get at least 60 s and each CP-SAT re-check solve 30 s, all inside the cap; with a smaller cap both shrink in proportion (never below Quick's times), and below a cap of about 2-2.5 min for days up to 120 stops (4.5-5.5 min at 175 stops, 5.5-7 min from 200 to 350, 8-9.5 min above 350) Thorough searches no longer than Quick and may skip the alternatives - keep `THOROUGH_MAX_SEC` at 10 min or more. The web waits the cap + 2 minutes. On the delivery day a Thorough plan's new loads are timed from the end of its search (start + cap + turnaround), because the plan cannot be used before it exists. Dispatchers (PLANNER and above since 5 Oct 2026) can end a Thorough search early (*Use the best plan found so far*). Details: handbook 2.7 and 4.9.
- `TenantConfig.solverTimeLimitSeconds` has **no effect**. It belonged to the previous (PyVRP) planner, which can no longer be started: old plans are read-only (`409 LEGACY_PLAN`). Since stabilization PR5 it is no longer on the Settings page (the API refuses it); the column is dropped in a later release.
- **Road routing** (stabilization PR5, review F19): the matrix gets at most `MATRIX_BUDGET_SEC` (default min(90 s, 20% of `SOLVER_BUDGET_SEC`)); a slow or hanging OSRM then gives straight-line estimates, labelled, with a "road routing too slow" warning, instead of eating the search time. Set `OSRM_TABLE_TILE` on the solver up to the OSRM server's `--max-table-size` (1000 in `infra/osrm`; first confirm production OSRM runs the image default) so a normal day needs **one** `/table` call; `OSRM_PARALLEL` (default 2, max 4) bounds the calls in flight. The solver logs `matrix provider=… quality=… seconds=…` for every request. At most 600 stops per optimization.
- Dispatch planner: every scenario runs in a worker process.
  - OR-Tools holds the GIL during its search. So neither the API process nor threads may run it, or `/health` and every other request freeze until the search ends.
  - RECOMMENDED runs first; the two alternatives then run in parallel, warm-started from it; then the load re-check (one worker per job, at most two).
  - If the worker computing the recommended plan dies (e.g. out of memory), the optimization fails within seconds with a clear message. If an alternative's worker dies, only that alternative is skipped (with a warning). Since stabilization PR4 each task reports which worker runs it, so a dead worker loses only its own task: a MIN_TRUCKS load re-check that dies no longer costs the recommended plan its exact re-check.
  - `SOLVER_PARALLEL=0` runs everything in-process with **no deadline and no time budget** (tests / local debugging only). The solver logs a warning at startup when it is set (an error on Railway): remove it from any deployed solver.
  - `SOLVER_ALLOW_INPROCESS_FALLBACK=1` does the same whenever the worker processes cannot start (rule 22; tests / local development only, logged at startup, an error on Railway). Without it such an optimization is refused within seconds with *The planner is busy or restarting - try again in a minute*: the solver logs an ERROR line containing `WORKERS_UNAVAILABLE` (after its timestamp: match it as a substring), the web logs `ALERT WORKERS_UNAVAILABLE:`, `/api/health` shows `degraded` `SOLVER_WORKERS_FAILED`, and the previous plan stays in use. What to do when it fires: `docs/RAILWAY_DEPLOYMENT.md`.
- **Timing check and the feasibility gate** (stabilization PR4): every option the solver returns carries its own timing check (VERIFIED / VIOLATED), and when the load re-check cannot run the plans are re-timed exactly. The web checks each truck's day again before LOCK, LOADING and DISPATCH and refuses them (409 "the timetable is not verified … Re-plan") while it breaks a rule. When the problem is on a LOCKED or LOADING load, the 409 and the plan screen say to put that load back to Planned first (Back to locked, then Unlock; any later locked or loading load of the same truck first, latest first - they are listed in that order) and then re-plan: a re-plan copies locked loads unchanged, so re-planning alone does not clear it. That is the fix for loads locked before the PR4 deploy, not the switch below. **Emergency switch:** set `FEASIBILITY_GATE=warn` on web (Railway → web → Variables; web redeploys) if the check ever blocks a correct plan; the violations stay visible and each such load change records them in its audit row. Remove it again as soon as the cause is fixed; while it is set the web logs a warning at startup.
- **Concurrent solves** (stabilization PR3): the solver runs at most `MAX_CONCURRENT_DISPATCH` (default 2) dispatch solves at once and answers 503 "Solver busy" to another one. The web's solve admission queues before that: at most `SOLVER_MAX_CONCURRENT` (default 2) solves in total and one less per company (at least 1), at most 2 waiting per company, a shared queue of 10 that refuses (503) only a company that already has one waiting - a company with nothing waiting is always queued, up to 200 waiting - and a freed slot goes to the company with the fewest solves running, then first come first served; plus 15 starts per user and 30 per company per hour. To let one company run 2 solves at once, set both `SOLVER_MAX_CONCURRENT` and `MAX_CONCURRENT_DISPATCH` to 3 (if the solver has the CPUs). Size both to the solver's CPUs (each solve uses up to 3 OR-Tools processes) and keep `SOLVER_MAX_CONCURRENT` at or below `MAX_CONCURRENT_DISPATCH`.

---

## Deployment

### Single-replica enforcement
**v1 deployment MUST run exactly one `routeiq-web` Railway replica.** The in-memory `inflight` map in `lib/jobs/optimize-job.ts`, the rate limits and the solve admission live in one process and are **NOT** shared under horizontal scaling. Since stabilization PR3 plan correctness no longer depends on it: every plan change takes database locks (a second process can at worst start a duplicate solve, whose stale result is not applied), but quotas and concurrency caps would count per process.

If you need to scale beyond one web instance, swap the inflight map for Redis-backed locks (BullMQ recommended) before scaling — that's a v2 prerequisite.

### Migrations
- `pnpm db:migrate:deploy` runs on Railway as the web service's **pre-deploy** step (web → Settings → Deploy; see docs/RAILWAY_DEPLOYMENT.md). A failed migration stops the deploy before the new version starts.
- Never edit a historical migration. Always create a new one.
- Zero-downtime pattern for destructive changes: expand → migrate code → contract over two deploys.

### PostGIS
- Production runs Railway's `postgres-ssl:18` template (PostgreSQL 18, PostGIS not guaranteed); CI and local development use `postgis/postgis:16-3.4`. The comment in the first migration (`00000000000000_init_postgis`) and the `schema.prisma` header still say production uses the PostGIS image: they are outdated (historical migrations are never edited). Nothing queries PostGIS.
- v1 schema doesn't query PostGIS, but the extension is reserved for v2 spatial work.
- The first migration is tolerant of missing PostGIS (wraps `CREATE EXTENSION` in a `DO $$ ... EXCEPTION` block) so local dev DBs without PostGIS still migrate.

### Backups
- Railway volume backups of `postgres-volume` are scheduled daily (kept 6 days) and weekly (kept 27 days) since 2026-09-24 (Postgres → Backups). Take a manual backup before every migration-bearing deploy.
- Once NMWC is live, add a daily `pg_dump` to Cloudflare R2 or similar; 30-day retention; quarterly restore drill.

---

## Driver links and delivery results (4 Oct 2026)

### Stopping a driver link
- A leaked QR or a forwarded link: the dispatcher opens **Link** on any load of that truck and clicks **Reissue link** (a new link at once; the old one answers "replaced") or **Revoke** (no link works until a reissue). Both are audited (`DRIVER_LINK_REISSUED`, `DRIVER_LINK_REVOKED`).
- Every link stops by itself at 12:00 (company time) the day after its delivery date; results saved on a phone before then can still be uploaded for 72 hours.
- To stop **every** link of every company at once (a suspected leak of the server key): rotate `DRIVER_LINK_SECRET` (or `NEXTAUTH_SECRET` when `DRIVER_LINK_SECRET` is not set; that also signs everyone out) on the `web` service. Every link then answers "replaced"; the dispatchers reopen **Link** or print the sheets again to get new ones. No start-up rehash is needed.

### Photo and position retention, and disk space
- Settings (company admin): **keep delivery photos** (30-1095 days, default 90 since the owner decision of 5 Oct 2026: "photos 90 days is enough"; the driver-page migration creates the setting at 90; where it had already run with the old default of 365, `20261005090000_driver_page_owner_decisions` moves a company still on 365 to 90 - unless its admin saved that value in Settings - and writes an audit row for it) and **keep driver positions** (30 days up to the photo time, default 90). The retention janitor runs in the web process at most every 10 minutes (and on `POST /api/cron/janitor`): it drops photo bytes older than the photo time (the record stays), erases positions, IPs and browser ids older than the position time (distances stay; on a driver link the browser ids are blanked and "used on N phones" keeps its count), and hides daily drivers with no load for 30 days (their phone is erased after the position time). One audit row per company and sweep. Audit rows written by a driver link keep no IP and no phone id at all (those live only on the stop events, the photos and the link's phone list, and go with the position time).
- **Expected growth at NMWC volume** (about 300 stops and 360 photos a day at about 220 KB, 26 working days a month): about 79 MB a day, 2.1 GB a month, and about **6 GB** in steady state at the 90 days decided on 5 Oct 2026 (about a quarter of the 25 GB a year of photos that 365 days would keep; 12 GB at 180); events and visits under 1 MB a day (about 0.3 GB a year). The database backups grow by the same amount. The `postgres-volume` is 4.6 GB today: raise it to at least 10 GB before the photos reach about 3 GB (about 38 delivery days, 7 weeks, at NMWC volume), and watch its size (Railway → Postgres → Metrics) after the first months.
- **Space is not returned to the disk by itself.** PostgreSQL reuses the space of purged photo bytes (autovacuum), so the volume stops growing once the retention is reached, but it does not shrink. To shrink it after a large purge (or after lowering the photo time), an operator runs `VACUUM FULL "DeliveryPhoto";` in a quiet hour (it locks the table: the driver page cannot upload photos meanwhile; take a backup first), or `pg_repack` if it is installed.
- **The backup horizon.** Deleted photos and positions stay in the Railway backups until those expire (daily 6 days, weekly 27 days), and in any `pg_dump` copy until it is deleted: the real deletion time is the retention plus the backup retention. Say so when someone asks how long driver data is kept.

---

## Trucks to hire (the hire suggestion, 6 Oct 2026)

Owner request: when the day's orders are more than the fleet can carry, RouteIQ says which trucks to RENT (*hire 1 x 10-ton + 1 x 3-ton: extra about 80 OMR*). It only knows the trucks a company admin enters.

- **Enter them** on the **Trucks** page, card **Trucks to hire** (company admin; everyone with the page sees them): per depot a **label** (*10-ton*, *3-ton*: the dispatcher reads it, and the rented trucks' codes take its tag, `HIRE-10T-...`), **bays** (pallet positions; or a **capacity in cases** for a truck loaded by cases), **payload** kg (0 = no weight limit), **cost per day** (the hire, more than 0), **cost per km** with fuel (empty = the depot's fleet average: cost per km + fuel price / km per litre of its trucks), **max per day** (how many of that truck you can rent on one day, 1-10) and **active**. The migration seeds NOTHING: after the deploy enter the owner's figures (rough, 6 Oct 2026: *10-ton*, 12 bays, payload 0, 50 OMR a day, at most 3; *3-ton*, 6 bays, payload 0, 30 OMR a day, at most 2). Audited `CREATE` / `UPDATE` / `DELETE` (entity *Truck to hire*). Deleting one keeps the trucks already rented with it.
- **What happens with them.** When a plan leaves orders out because of the fleet (also receiving hours no own truck reaches in time because it is out on a locked load), a what-if optimization runs on its own (Quick, its own job `HireSuggestion`, one per plan version at a time, the same optimizer queue as every plan but never ahead of a dispatcher's optimization and not counted in the hourly limits; when a dispatcher's optimization needs its place on a full optimizer it waits for the next free one, once) with one truck per unit the day can still rent. In the search a rented truck costs its real hire plus a premium (the dearest own truck's day cost + 100 OMR; a rented truck weighs at most 500 OMR there, half of what leaving out one stop costs, unless its hire alone is more), so own trucks always go first whatever the options cost, and between rented trucks the hire counts in real money with their km; the plan reports the real costs. A dispatcher's **Use this plan** rents the trucks as **one-day trucks** (`Truck.onlyOnDate`, `hired`, linked to the option) and makes the next plan version with them, or re-plans with them when the day changed. Audited `HIRE_CHECK_STARTED` / `HIRE_CHECK_FINISHED` / `HIRE_CHECK_FAILED`, `HIRED_TRUCKS_ADDED`, `HIRE_SUGGESTION_USED`, then the usual `PLAN_VERSION_CREATED` and `SCENARIO_CHOSEN`.
- **One-day trucks** are planned on their date only and the janitor switches them off once that day is over (`ONE_DAY_TRUCKS_RETIRED`, one row per company). They stay in the Trucks list with a *1 day: <date>* badge (plans, sheets and results name them). The dispatcher enters each one's real plate (**Plate** on its load: `PATCH /api/dispatch/hired-trucks/:id` with `code`, PLANNER, `HIRED_TRUCK_CHANGED`); the driver is picked on each load. A default driver for a one-day truck is set only through that API (`defaultDriverId`) or on your Trucks page; every other field stays yours on the Trucks page. A plate that a hired truck of a day that is over still carries is moved off it (that truck's code becomes `<plate>.<YYMMDD>`, audited on it too; its own plans keep showing the plate); the plate of a hired truck of today or a coming day is refused (`CODE_TAKEN`). **Start fresh** removes the one-day trucks of the days it removes (or switches one off while a kept row names it).
- **A check that stopped.** A what-if lost with its web process (a deploy, a restart) shows as stopped within 2 minutes; one a dispatcher's optimization took the optimizer place of waits for the next free place once, then stops. The dispatcher presses **Check hire options**. A stopped or failed check never hides a finished suggestion of the same plan. Nothing is ever changed by a check itself.
- **Useful query** (one company's checks of a day):

```sql
SELECT s."createdAt", s.status, s.trigger, s.message, s."usedAt", r.version
FROM "HireSuggestion" s JOIN "RunPlan" r ON r.id = s."runId"
WHERE s."tenantId" = '<tenantId>' AND r."runDate" = '2026-10-07'
ORDER BY s."createdAt";
```

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
| `/api/products/import` | 60/hr/user | `LIMITS.ordersUpload` (withTenantApi `rateLimitKey: products-import`) |
| `/api/runs/{id}/baseline` | 60/hr/user | `LIMITS.ordersUpload` |
| Every optimization start: `/api/dispatch/plan` (optimize), `/api/runs/{id}/replan`, `/api/runs/{id}/optimize` | 15/hr/user and 30/hr/company (429); `SOLVER_MAX_CONCURRENT` (2) at once in total and one less per company; at most 2 waiting per company (then 429 for that company); a full shared queue of 10 answers 503 only to a company that already has one waiting; 200 waiting at most (503) | Solve admission, `lib/dispatch/solve-admission.ts` (stabilization PR3; replaces `LIMITS.optimize`) |
| Other authenticated endpoints | none | |

The IP is the proxy-appended one (`TRUSTED_PROXY_HOPS` / `CLIENT_IP_HEADER`, `lib/client-ip.ts`). Buckets live in memory (one web replica), are swept when they expire and capped in number. `RATE_LIMITS_DISABLED=1` is for test servers only: it is ignored on Railway. Moving to a shared store (Redis) is needed before running more than one web replica.

---

## File upload hardening

- Max 10 MB per file (CLAUDE.md §15).
- Max 50,000 rows on the sheet that is read (a CSV: the file). At most 50,100 rows of each sheet (or of a CSV) are read at all; a sheet that goes on past them is refused when it is the one read, and named "N rows or more" when it is not. A workbook's other sheets are named in a warning, never counted (PR6 review; the read cap since the audit A1).
- An .xlsx is measured by unpacking it before anything is read (`lib/workbook-guard.ts`, audit E2): refused over 50 MB unpacked, over 1,000 parts, with a part whose header size is wrong or whose two names differ, password-protected, or not an Excel workbook; and (A1 review) over 2,500,000 cells, 10,000 comments, or hyperlinks over 200,000 cells; and (A1 v3) over 1,000 metadata entries of each kind or 1,000 comment authors. A cell is counted as SheetJS makes one: with a type or a value, also when its tag closes itself (A1 v3); a formatted empty cell is not counted. Binary parts (.bin) are hidden from SheetJS; an .xlsb is refused. Since A1 v4 the guard replays which parts SheetJS reads for each sheet (its part, relationships, comments, drawing of notes; external links as often as they are listed): a part read again counts again against every cap, two sheets that read one worksheet part are refused as damaged, SheetJS must read the same sheet list as the guard, and a workbook with a chart, dialog or macro sheet is refused. More than 10 sheets are refused before any sheet is read. Before any sheet is turned into rows, a sheet wider than 200 columns or sheets spanning more than 2,500,000 cells are refused. Since the P5 second review a CSV sent as text (most browsers send a .csv so) has the same two caps: a header or line of more than 200 values, or more than 2,500,000 values in all, is refused; empty values count, so a CSV saved from Excel with many empty columns after the data can be refused (delete those columns in Excel and save again). Formulas are not read, only their saved values, and number formats are not applied (no display text is made, A1 v3).
- Content-type allowlist: CSV / XLSX / XLS only. A file read as Excel must also be one by content (A1 review): an .xlsx, an old .xls (its hyperlinks count against the same limit; A1 v2 also checks the compound-file structure first, so it cannot be crafted to exhaust memory) or CSV text; SheetJS guesses the format from the first bytes, so web pages, XML, OpenDocument, DIF, Lotus, dBASE, RTF, SocialCalc and real SYLK files are refused before it reads them. A CSV whose first column header is "ID" is read as CSV, not refused as SYLK (A1 v2); since A1 v3 also a semicolon one whose first ID is "C", "F", "E" or "B", while a file that would make SheetJS's SYLK reader grow its sheet to millions of rows first is refused.
- **Each file is read in its own short-lived process, never in the web process** (audit P5, E2's proper fix; `lib/upload-parse`). The limits above bound one upload's work, but a file just under them still takes seconds and up to about 1 GB. Now the web process only sends the file and receives the rows, so it keeps answering everyone meanwhile. The parser process has a heap cap (`UPLOAD_WORKER_MAX_HEAP_MB`, default 512) and a time limit after which it is killed (`UPLOAD_PARSE_TIMEOUT_MS`, default 15000); at most `UPLOAD_PARSE_CONCURRENCY` (default 2) run at once, a further upload waits up to 5 s (at most 8 wait), then gets 503 "RouteIQ is reading other files right now. Try again in a moment.". A file over the time or memory limit is refused with a message that says what to do (delete unneeded rows and columns, split the file); nothing is saved. The parser gets no secrets in its environment, and on Linux it asks the kernel to kill it first when memory runs out. The rows the parser sends back are at most 128 MB, each text sent once (P5 review), with no row of more than 200 cells and no more than 2,500,000 cells, checked before the web process builds a row and kept compact there (P5 second review: about 20 MB for the widest legal file, under 1 MB for NMWC's), so a small file cannot fill the web process either: a larger answer is refused as "needs too much memory" too, and logged as `[upload-parse] parser process <pid>: its answer would pass 128.00 MB ...: out of memory` (or `... would pass 200 cells in a row ...`, `... would pass 2,500,000 cells ...`). Each read is logged: `[upload-parse] read <MB> MB in <ms> ms, parser peak <MB> MB`; refusals as `[upload-parse] ... refused ... UPLOAD_TIMEOUT` or `UPLOAD_OUT_OF_MEMORY`. Use the peak figures to size the web service's memory (`docs/RAILWAY_DEPLOYMENT.md`). A production server checks the parser once at startup (`[upload-parse] the file reader works (startup check)`, or a `[config]` error: then every upload is refused until the web is rebuilt with `pnpm --filter @routeiq/web build`). The upload request itself is still received whole by the web process before the 10 MB check, about twice its size in memory (P5 third review; `docs/RAILWAY_DEPLOYMENT.md`). When checking an order file fails for a reason that is not the file's (the database), the planner sees "RouteIQ could not check this file. Nothing was saved. ..." (500) and the log has `[orders-upload] checking the file failed` with the error.
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
