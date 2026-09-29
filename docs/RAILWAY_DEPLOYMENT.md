# RouteIQ on Railway — state and runbook

Railway project **`routeiq`**, environment **`production`**, region **EU West (Amsterdam)**. Checked 2026-09-24.

| Service | Source | State (2026-09-24) | Network |
|---|---|---|---|
| `solver` | GitHub `main`, root `/apps/solver`, Dockerfile | **Online**: the OR-Tools dispatch planner since PR #25 (2026-09-24); `OSRM_URL` set | private only: `solver.railway.internal` |
| `routeiq-osrm` | GitHub `main`, root `/infra/osrm`, watch path `/infra/osrm/**` | **Online** since 2026-09-24. Health check (a Muscat `/nearest` query) passes | private only: `routeiq-osrm.railway.internal:5000` |
| `Postgres` | image `ghcr.io/railwayapp-templates/postgres-ssl:18`, volume `postgres-volume` (4.6 GB) | **Online again since 2026-09-24**. It had been down since 2026-05-12; see below. Backups: daily + weekly schedule, plus manual ones before the restart and before the PR #25 merge | private: `postgres.railway.internal`; **also a public TCP proxy** `viaduct.proxy.rlwy.net:22270` |
| `web` | GitHub `main`, repo root, Nixpacks | **Online** since the PR #25 merge (2026-09-24, `675f3fc`); `/api/health` reports db, solver and OSRM routing up | public: `web-production-a9d04.up.railway.app` |

OSRM setup and verification: see [OSRM_SETUP.md](OSRM_SETUP.md).

## Postgres outage 2026-05-12 → 2026-09-24

The logs from May had expired, so the cause is reconstructed from the restart logs on 2026-09-24.

- **Killed, not shut down.** Postgres logged "database system was interrupted; last known up at 2026-05-12 05:38:42 UTC" and "not properly shut down; automatic recovery in progress". Something stopped the container abruptly at or after that time.
- **Why it couldn't restart (most likely).** The kill left a stale lock file, `pgdata/postmaster.pid`, which was still there four months later.
  - In containers, Postgres commonly refuses to start over a stale lock file. Restarts then keep failing until Railway gives up ("crashed for too long") and removes the deployment.
  - Today's image has a wrapper that deletes a stale lock file at start ("wrapper: removing stale … postmaster.pid"). That is why the redeploy worked.
  - This is an inference: the May crash logs are gone.
- **Ruled out:**
  - Disk full: the volume is 4.6 GB and holds about 220 MB.
  - Postgres major-version mismatch: the data directory opened fine under PostgreSQL 18.6.
  - Data corruption: WAL recovery replayed about 200 bytes and finished in milliseconds.
- **Unknown:** what killed the container on 2026-05-12, e.g. a host event, memory, or billing. `web` crashed at the same time, because it cannot start without the database.
- **Recovery (2026-09-24):**
  1. A manual volume backup was taken first.
  2. The image `postgres-ssl:18` was redeployed.
  3. Postgres was ready in under a second and stayed up.

Follow-ups:
- Backup schedule: **done 2026-09-24**, daily (kept 6 days) + weekly (kept 27 days). There were no backups before that.
- Decide whether the public TCP proxy is needed; remove it if nothing outside Railway connects.

## Production cut-over (done 2026-09-24)

1. **Postgres:** done (see above). Take a fresh manual backup right before merging (Postgres → Backups → New backup): it is the rollback point.
2. **Merge PR #25**, then **web** redeploys from `main`.
   - Its **pre-deploy step** (Railway dashboard, see below) runs `prisma migrate deploy`. That applies three migrations:
     - the dispatch MVP schema;
     - `Order.priorityFromFile`;
     - OSRM as the default distance provider. Tenants in **Oman / the UAE** on HAVERSINE move to OSRM; the old solver was already silently using the public OSRM demo for them, except on days too big for it. Tenants elsewhere keep HAVERSINE: the shared OSRM map covers Oman + UAE only, so the app plans them on straight-line estimates unless they configure their own OSRM URL.
   - If a migration fails, the deploy stops before the app starts.
   - Web variables (names only; values live in Railway): `DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `SOLVER_URL`, `SOLVER_TOKEN`. Optional ones are listed in `.env.example`.
   - Since stabilization PR1 (security) also set on web: a separate `JANITOR_TOKEN`, `RESEND_API_KEY` + a verified `RESEND_FROM`, `AUTH_URL` (or `NEXTAUTH_URL`), and `TRUSTED_PROXY_HOPS` / `CLIENT_IP_HEADER`; keep `RATE_LIMITS_DISABLED` unset. The full list and the post-deploy checks are in [`SECURITY.md`](./SECURITY.md) section 7.
   - Since stabilization PR3 (plan lifecycle): optional `SOLVER_MAX_CONCURRENT` on web (default 2: solves at once over all companies; one company may use one less, at least 1). After the deploy, check it against the solver's vCPU and keep it at or below the solver's `MAX_CONCURRENT_DISPATCH`.
   - Since stabilization PR4 (feasibility gate): `FEASIBILITY_GATE` on web stays **unset** (the gate is enforced). `warn` is an emergency switch only (trucks whose times break a rule can then be dispatched; audited); see `docs/admin.md`. The PR4 migration `20260927090000_plan_snapshots_feasibility` only adds three nullable JSONB columns.
3. **solver** redeploys from `main` with the new OR-Tools engine. `OSRM_URL` is already set.
   - Since stabilization PR3: optional `MAX_CONCURRENT_DISPATCH` on the solver (default 2; each solve uses up to 3 OR-Tools processes, more solves are refused with 503). Size it to the solver's vCPU after the deploy, together with the web's `SOLVER_MAX_CONCURRENT`; both 3 let one company run 2 solves at once.
   - Never set `SOLVER_PARALLEL` on the solver: `0` disables every deadline and the time budget (the solver logs an error at startup on Railway when it is set).
   - Since stabilization PR4 the solver adds an optional `feasibility` report to every option. Deploy order does not matter: the web treats a missing report as "not checked by the optimizer" and blocks such a plan only on a concrete problem it finds itself.
   - Web and solver build independently. Until the new solver is live, an optimize answers "The route optimizer is being updated. Try again in a minute."
   - Wait until the solver deployment is **Active** before anyone plans.
4. **routeiq-osrm** → Settings → Source → Branch: `main` (the PR branch can then be deleted).
5. **Verify:**
   - `GET https://<web>/api/health` returns `"db": "up"`, `"solver": "up"` and `"routing": { "provider": "OSRM", "status": "up" }`. Only the new solver reports `routing`.
   - Optimize a day; the plan shows **Road km**.

**If a migration was interrupted** (deploy logs show `P3009 migrate found failed migrations`):
- Nothing was half-applied: each migration runs in one transaction.
- Mark it rolled back, then redeploy:
  ```bash
  pnpm --filter @routeiq/web exec prisma migrate resolve --rolled-back <migration_name>
  ```
  Run it from your machine with `DATABASE_URL` set to the Postgres service's **public** URL (`DATABASE_PUBLIC_URL`, via the TCP proxy): web's `DATABASE_URL` uses `postgres.railway.internal`, which only resolves inside Railway. So keep the TCP proxy until the cutover is verified.

**Rollback is one-way as soon as the pre-deploy step has run, even if the new version never starts.**
- The migrations replace a unique index and rewrite `TenantConfig.distanceProvider` to `OSRM`, which the code on `main` cannot read.
- The only way back is to restore the pre-merge backup, then redeploy the previous commit. Never redeploy old code on top of the migrated database.
- If the new web fails its health check, fix forward, or restore promptly.

## Service settings live in the Railway dashboard (done 2026-09-24)

Railway stops reading `railway.json` files on 2026-12-01 ("Config as Code" is deprecated; <https://docs.railway.com/config-as-code>), and file values were never copied into the dashboard. The settings were therefore re-entered in the dashboard and both files deleted, well before the cutoff. **No service reads a config file any more.** If a service is ever recreated, set these by hand.

| Service | Setting | Value |
|---|---|---|
| web | Root directory | repo root |
| web | Builder | Nixpacks (deprecated, but still working; moving to Railpack is a separate change, see below) |
| web | Build command | `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @routeiq/web build` |
| web | Pre-deploy command | `pnpm --filter @routeiq/web db:migrate:deploy` (a failed migration stops the deploy; the previous version keeps serving) |
| web | Start command | `pnpm --filter @routeiq/web start` |
| web | Healthcheck | `/api/health`, timeout 300 s (Railway default). Since audit PR4 it is **dispatch readiness**: 503 when the database is down or dispatch is misconfigured (`SOLVER_URL` / `SOLVER_TOKEN` missing on web, a `SOLVER_URL` no call can use - `SOLVER_URL_INVALID`, for example the solver's private domain without `http://`: set it to `http://<solver private address>:<port>` -, a `SOLVER_TOKEN` that is not plain ASCII, the solver refuses the token with 401, or the solver has no token), so such a deploy fails and the previous version keeps serving; 200 `degraded` (`ok: false`) when the solver is only unreachable or something answers with an error (a 5xx, or a 403 from a proxy or wrong host in front of it: the solver never answers 403) or a redirect (`SOLVER_URL_REDIRECTS`: optimizations fail too, so point `SOLVER_URL` at the solver's private address), which does not block a deploy. `/api/health/live` is the process-only liveness. Deploy the solver first when both change, so the new web finds `/ready` (an older solver gives `degraded`, never 503) |
| web | Restart policy | On Failure (Railway default: 10 retries) |
| solver | Root directory | `/apps/solver` |
| solver | Builder | Dockerfile (`/apps/solver/Dockerfile`) |
| solver | Healthcheck | `/health` (public; `/ready` is token-protected and only for the web's readiness check) |
| routeiq-osrm | all | see [OSRM_SETUP.md](OSRM_SETUP.md) |

How it was done, and what to know if it is ever needed again:
- **web** had an explicit config path (`/apps/web/railway.json`). Settings that come from a file are **read-only** in the dashboard until a deploy without the file is live.
  - So: clear **Settings → Config-as-code → Railway Config File** and deploy.
  - That build had no commands and failed its health check. **The previous version kept serving.**
  - Then enter the values above and deploy again.
- **solver** had no config path: Railway **auto-reads a `railway.json` in the service's root directory**, so only deleting the file switches it off.
- Avoid `railway config migrate` / Infrastructure as Code (`.railway/railway.ts`) for now:
  - The CLI drops builder, restart policy, pre-deploy and health-check settings: <https://github.com/railwayapp/cli/issues/1199>.
  - An IaC file must list *every* resource, or Railway plans to delete what is missing, including the database.

**Node version of `web` (audit A1).** The repo pins Node 22 LTS: root `package.json` `engines.node` is `22.x`, and `.nvmrc` and `.node-version` say `22`. Nixpacks takes the Node major from the service variable `NIXPACKS_NODE_VERSION` if it is set, otherwise from `engines.node`, otherwise from `.nvmrc`. Before A1 `engines.node` was `>=20.0.0`, and the version Nixpacks picked for it is not recorded here.
- After the A1 deploy, open the web build log: the setup line names the Node package (for example `nodejs_22`).
- If it does not say 22, set `NIXPACKS_NODE_VERSION=22` on `web` and redeploy.
- Build on staging first where one exists (assessment risk for PR 1). Do not set a Node version on `solver` or `routeiq-osrm`; they are Dockerfile builds without Node.

Later, as a separate change, move `web` from Nixpacks to Railpack:
- Build command `pnpm --filter @routeiq/web build`.
- Node: Railpack reads `RAILPACK_NODE_VERSION`, `engines.node`, `.nvmrc` or `.node-version`; all say 22 since A1.
- Fix the root `packageManager` (`pnpm@9.0.0`, while the lockfile is built with pnpm 9.15).
- Source: <https://railpack.com/languages/node>.

## Long searches (THOROUGH mode, 29 Sep 2026)

The planner can now search up to 20 minutes (owner request 29 Sep 2026; handbook 2.7, 4.9). What to set and check when this
change is deployed:

- **Migration** `20261001090000_run_job_search_mode_heartbeat` (pre-deploy step): adds two nullable columns to `RunJob`
  (`searchMode`, `heartbeatAt`). No rewrite, no backfill; the previous version keeps serving and ignores them. Rollback: the
  previous code runs on top of it unchanged.
- **Deploy order:** the solver first. A new web talking to the old solver still works (the old solver ignores
  `search_mode` and searches QUICK; a THOROUGH choice then just behaves like QUICK); a new solver with the old web gets no mode
  (QUICK).
- **Variables** (names only):
  - `THOROUGH_MAX_SEC` on **web and solver**, the same value (default 1200 = 20 min; accepted from 10 to 3600, but keep it at
    600 or more in production). The web sends it with each THOROUGH request and waits it + 2 minutes; the solver uses the lower
    of the two. Below 20 min the alternatives and the load re-check shrink in proportion (never below Quick's times); below
    about Quick's whole time (2 min for days up to 120 stops, 4 min at 175, 5 min at 300, 7 min above 350) Thorough searches no
    longer than Quick and may skip the alternatives. A same-day Thorough plan's new loads count from its start + this value.
    CI sets 60 (tests only).
  - `NEXT_MANUAL_SIG_HANDLE=1` on **web** (recommended). On a redeploy Railway sends SIGTERM; with this set, the web fails its
    optimizations in progress at once with *"The server was restarted (an update) during this optimization. Nothing was saved
    - optimize again."* (at most 8 s of writes), then exits. Without it Next.js exits at once and those writes may not land:
    the jobs are then failed by their heartbeat within about 6 minutes (shown as lost after 2). Nothing in the repository sets
    it: set it on the service. The dispatcher guide says both cases.
  - Optional on the solver: `THOROUGH_STALL_SEC` (300) and `THOROUGH_STALL_SHARE` (0.5), the early-stop rule; leave them unset
    unless re-measured (`docs/OPTIMIZER_BENCHMARK.md` §10).
  - Keep web's `SOLVER_MAX_CONCURRENT` at 2 or more (with 1, a THOROUGH search holds the only slot for up to 20 minutes).
- **What happens to a 20-minute search on a redeploy.**
  - *Web redeploys:* the job fails at once (with `NEXT_MANUAL_SIG_HANDLE=1`) or by its heartbeat within minutes, never stuck; the
    plan can be optimized again (a re-plan version keeps the previous plan). The solver sees the connection close and cancels that
    solve within about a second, so its slot frees for the new web.
  - *Solver redeploys:* the running solve is cut when the old container stops; the web gets a reset connection and fails the job
    with *"The route optimizer stopped during the search (it was restarted or updated). Nothing was saved - optimize again."*,
    retryable. Railway's drain time before it stops the old container is not known here (open: check the service's deploy
    settings); a solve longer than it is lost either way. Avoid solver deploys during the evening planning.
  - Railway's healthchecks run at deploy time only and do not touch a running solve.
- **Signal delivery (to verify on staging).** The web start command is `pnpm --filter @routeiq/web start`. Whether pnpm passes
  SIGTERM on to the `next start` process is not verified. Check once: start a THOROUGH optimization, redeploy web, and see the
  job end at once with the "server was restarted" message (not after about 6 minutes with "No sign of life"). If it does not,
  start the web with `node` directly (for example `pnpm --filter @routeiq/web exec next start`), which receives the signal.
  Also check how long Railway waits between SIGTERM and killing the old container (a review of the long-search PR read that
  Railway's `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` defaults to 0, not verified here): the shutdown handler needs up to 8 s for its
  writes, so set it to 10 or more if the check shows the jobs failing by heartbeat instead. Until both are verified the dispatcher
  guide says the job fails "at once where the server is set up for it, otherwise within a few minutes".
- **Solver CPU during long solves.** A THOROUGH solve holds one solver slot and, for most of its 20 minutes, one CPU core (the
  recommended plan's search); the alternatives and the load re-check add two more processes for about two minutes at the end.
  The solver service's vCPU is not recorded (handbook 7.5). With 1 vCPU a Quick re-plan running next to a Thorough search shares
  the core: both still end on time (their limits are wall-clock) but find somewhat worse plans. Once the vCPU is known, 2 or more
  cores are recommended, with `SOLVER_MAX_CONCURRENT=3` on web and `MAX_CONCURRENT_DISPATCH=3` on the solver.
- **The connection.** `SOLVER_URL` must be the solver's **private** address (`http://solver.railway.internal:<port>`), never a
  public domain: a public edge may cut requests long before 20 minutes. The web holds one connection per solve for up to 22
  minutes with TCP keepalive every 30 s; whether Railway's private network keeps an idle 20-minute connection is to be confirmed
  on staging with a THOROUGH run (the keepalive packets keep it from looking idle).
- **Verify after the deploy:** optimize tomorrow's day with **Thorough** once; the plan screen shows *Searching for the best plan
  - up to 20 min ...*, and afterwards *Thorough search: searched N min ...*; `GET /api/runs/:id/status` shows the job with
  `searchMode` and a `heartbeatAt` that moves every 30 s while it runs.

## Private networking notes

- Service addresses are `<service>.railway.internal`. This environment resolves over **IPv4 and IPv6**.
- Servers should listen on `::`. OSRM does, via `OSRM_BIND=::`.
- Railway injects `PORT`. `routeiq-osrm` pins `PORT=5000` so its private URL never changes.
- OSRM and the solver have **no public domain**, and must not get one: OSRM has no authentication.
