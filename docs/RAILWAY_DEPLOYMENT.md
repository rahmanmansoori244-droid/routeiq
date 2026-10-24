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
   - Since audit P5 (each uploaded file is read in its own short-lived process): optional `UPLOAD_WORKER_MAX_HEAP_MB` (default 512), `UPLOAD_PARSE_TIMEOUT_MS` (default 15000) and `UPLOAD_PARSE_CONCURRENCY` (default 2) on web; leave them unset unless the owner decides other values. **Memory:** while files are read, the web service needs its own memory plus, for each file read at once, about the heap cap + 150 MB: with the defaults up to about 1.3 GB more (NMWC's real files need about 60-70 MB each). The web process itself also holds the rows of each file being handled: at most 200 cells a row and 2,500,000 cells per file, kept compact (since the P5 second review; the parser's 128 MB answer cap alone did not bound them). Measured: 20-26 MB for the largest legal files, well under 1 MB for NMWC's files; so with two files at once, about 50 MB more at most. This does not bound the upload request itself (P5 third review): the web process reads a whole request body before the 10 MB check, about twice its size in memory, even without a session (a 300 MB request: 500-620 MB more). Unless something in front of the web service caps request bodies (not recorded in the repo), one very large request can take the web service to its memory limit; the cap is an owner question (handbook 7.5). Before the deploy, check the web service's memory limit and its usage in Railway (web → Metrics); if the limit is lower, raise it, or set `UPLOAD_PARSE_CONCURRENCY=1`. The build also makes `apps/web/.next/upload-parser/parse.cjs` (the file reader), and the start command must run in `apps/web`, as `pnpm --filter @routeiq/web start` does. After the deploy the web log shows `[upload-parse] the file reader works (startup check)`; a `[config]` error about the upload file reader means every upload is refused: redeploy with the build command above. No migration; rollback is a redeploy of the previous commit.
   - Since review M3 (the driver sheets are made in their own short-lived process, like uploads): optional `PDF_RENDER_MAX_HEAP_MB` (default 1024), `PDF_RENDER_TIMEOUT_MS` (default 120000) and `PDF_RENDER_CONCURRENCY` (default 2) on web; leave them unset unless the owner decides other values. **Memory:** each pack being made needs about 130 MB for one load and 460-560 MB for a whole day of 300-400 stops (measured), so two whole-day packs next to two large uploads need about 2.5 GB beside the web's own; if the web service's limit is lower, raise it or set `PDF_RENDER_CONCURRENCY=1`. The build also makes `apps/web/.next/pdf-renderer/render.cjs` (`scripts/build-pdf-renderer.mjs`), found by `next start` run in `apps/web`. After the deploy the web log shows `[pdf-render] the driver sheet maker works (startup check)`; a `[config]` error about the driver sheet maker means every driver sheet is refused: redeploy with the build command above. Check one "Driver sheets (PDF)" on the plan screen: the web log shows `[pdf-render] made <n> driver sheet(s), <KB> KB, in <ms> ms, renderer peak <MB> MB (process <pid>)`, and `GET /api/health/live` keeps answering while it is made. No migration; rollback is a redeploy of the previous commit.
3. **solver** redeploys from `main` with the new OR-Tools engine. `OSRM_URL` is already set.
   - Since stabilization PR3: optional `MAX_CONCURRENT_DISPATCH` on the solver (default 2; each solve uses up to 3 OR-Tools worker processes plus 1 for the PyVRP second search - and K-1 more with best-of-N, `SOLVER_BEST_OF`, off by default - more solves are refused with 503). Size it to the solver's vCPU after the deploy, together with the web's `SOLVER_MAX_CONCURRENT`; both 3 let one company run 2 solves at once.
   - Never set `SOLVER_PARALLEL` on the solver: `0` disables every deadline and the time budget (the solver logs an error at startup on Railway when it is set). The same for `SOLVER_ALLOW_INPROCESS_FALLBACK` (rule 22, see "The planner cannot start its worker processes" below).
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
| web | Build command | `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @routeiq/web build` (since audit P5 the build also makes the upload file reader, `apps/web/.next/upload-parser/parse.cjs`, with esbuild, a dev dependency) |
| web | Pre-deploy command | `pnpm --filter @routeiq/web db:migrate:deploy` (a failed migration stops the deploy; the previous version keeps serving) |
| web | Start command | `pnpm --filter @routeiq/web start` (runs `next start` in `apps/web`, where it finds the upload file reader; audit P5) |
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
    a cap of about 2-2.5 min for days up to 120 stops, 4.5-5.5 min at 175, 5.5-7 min from 200 to 350 and 8-9.5 min above 350
    (the higher figure with the slowest road matrix) Thorough searches no longer than Quick and may skip the alternatives. A
    same-day Thorough plan's new loads count from its start + this value. The refusal of a third waiting Thorough states it too.
    CI sets 60 (tests only).
  - `NEXT_MANUAL_SIG_HANDLE=1` on **web** (recommended). On a redeploy Railway sends SIGTERM; with this set, the web fails its
    optimizations in progress at once with *"The server was restarted (an update) during this optimization. Nothing was saved
    - optimize again."* (at most 8 s of writes), then exits. Without it Next.js exits at once and those writes may not land:
    the jobs are then failed by their heartbeat within about 6 minutes (shown as lost after 2). Nothing in the repository sets
    it: set it on the service. The dispatcher guide says both cases.
  - Optional on the solver: `THOROUGH_STALL_SEC` (300) and `THOROUGH_STALL_SHARE` (0.5), the early-stop rule; leave them unset
    unless re-measured (`docs/OPTIMIZER_BENCHMARK.md` §11).
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

## The planner cannot start its worker processes (rule 22, 30 Sep 2026)

The owner's rule 22 (audit policy 22): when the solver cannot start its worker processes, it stops within seconds and says
so, instead of freezing. Every search runs in a separate worker process. Before this change, a solver that could not start
them (out of memory, a process limit) ran the whole search inside its own API process with no deadline: the planner then
answered nothing else (health checks, other companies' plans) for the length of the search, up to 20 minutes and more for a
Thorough one, and the only trace was one warning line. Handbook 2.7 and 4.9 have the details.

- **What happens now.** The solver starts its worker processes first, before it fetches road distances, and checks that one
  of them runs a task within `SOLVER_WORKER_START_SEC` (default 30 s; it takes about half a second when healthy). If they
  cannot start, the optimization is refused at once with HTTP 503 (`Retry-After: 60`, code `WORKERS_UNAVAILABLE`). Nothing is
  searched and nothing is saved. The dispatcher reads *"The planner is busy or restarting - try again in a minute. Nothing was
  changed."*; the plan in use stays as it was (a failed re-plan keeps the previous plan, locked loads included), and pressing
  the button again works as soon as the solver can start processes again. There is no automatic retry.
- **When the processes stop during a search** (for example the out-of-memory killer ends one, and no replacement can start;
  or a process ends while it waits for work and leaves the others unable to take any), the solver notices within seconds - at
  most `SOLVER_WORKER_START_SEC` for processes that stop taking work - instead of at the search's deadline (20 minutes for a
  Thorough plan). The optimization is refused the same way (503 `WORKERS_UNAVAILABLE`, the same message) only when the
  recommended plan's own search cannot go on: the process running it stopped and no replacement can start, or its search
  could not start at all (for example every process stopped while the road distances were fetched). When another process
  stops while the recommended search is running, that search goes on and the recommended plan is kept: the other options are
  skipped and its loads are re-checked with fresh processes, or re-timed exactly when those cannot start either (below). So a
  process that stops during a search does not always mean a refused optimization: look for the ERROR line (below). Closing a
  broken set of processes never holds the answer for more than about 10 s.
- **Variables** (names only; none is needed in production):
  - `SOLVER_ALLOW_INPROCESS_FALLBACK` on the solver: **never set it on Railway.** `1` brings back the old in-process fallback,
    for local development and tests only. When it is set the solver logs an **error** at startup on Railway (a warning
    elsewhere).
  - `SOLVER_WORKER_START_SEC` on the solver: optional (default 30, 1 to 600). How long a new pool may take to run its first
    task before the optimization is refused. Leave it unset unless the solver's start-up is measured to be slower.
- **What the alert looks like.** Three signals, all on each refusal:
  - The **solver log** has an ERROR line from `routeiq.dispatch` that contains `WORKERS_UNAVAILABLE` (on a refusal, a second
    one from `routeiq.api` follows). Like every solver log line it starts with the time, the level and the logger name, and
    the code comes after them, for example:
    `2026-09-30 02:00:00,123 ERROR routeiq.dispatch: WORKERS_UNAVAILABLE run=<plan id>: the solver could not start its worker processes for the search
    (BlockingIOError: [Errno 11] Resource temporarily unavailable). Nothing is searched inside the API process (rule 22). If
    this repeats, check the solver service's memory and process limits and restart it.`, followed by
    `2026-09-30 02:00:00,125 ERROR routeiq.api: optimize-dispatch run=<plan id> refused (503 WORKERS_UNAVAILABLE): worker processes could not start or
    stopped working (...)`. The text in brackets is the cause and depends on the error: `BlockingIOError: [Errno 11] Resource
    temporarily unavailable` at the process limit, `OSError: [Errno 12] Cannot allocate memory` when memory is short. When the
    processes stop during a search the line says `the solver's worker processes stopped working during the search (...)`
    instead, and `a worker pool did not stop within 10 s ...` when closing them hung. **Alert on any solver log line that
    contains `WORKERS_UNAVAILABLE` (a substring match), never on the cause text.** A rule that only matches lines that start
    with the code never fires for the solver, because of the time in front.
  - The **web log** has one line that starts with `ALERT WORKERS_UNAVAILABLE:` naming the plan and the job, and the plan's audit
    log has an `OPTIMIZE_FAILED` row whose error carries `code: WORKERS_UNAVAILABLE`.
  - **`GET /api/health`** on web answers 200 with `ok: false`, `status: degraded` and `dispatch.reason: SOLVER_WORKERS_FAILED`
    while the solver's `/ready` reports the failure: at least 5 minutes, even if optimizations work again meanwhile, so
    monitoring that checks every few minutes sees it; then until an optimization starts the processes again, or at most 15
    minutes after the failure. A deploy is not blocked by it.
  Railway has no alerting set up in this repository: point log alerts at lines containing `WORKERS_UNAVAILABLE` and
  monitoring at `ok: false`.
- **What to do when it fires.** Look at the solver service's memory and CPU graphs and its deploy logs. One refusal during a
  solver restart or a memory spike needs nothing: the dispatcher tries again in a minute. If it repeats, restart the solver
  service; if it keeps happening, raise the service's memory or lower `MAX_CONCURRENT_DISPATCH` (each solve uses up to three
  processes).
- **The load re-check after an alternative overran** (or after the processes stopped, above) needs fresh worker processes too.
  If they cannot start, the solver keeps the recommended plan it already found and re-times it exactly (a few milliseconds)
  instead of refusing, with the note *"Loads were not re-checked for fewer trucks (the planner was short of resources)"* on
  the plan and the same ERROR line and `/ready` signal. The web records no failed job and no `ALERT` line then (the plan was
  returned), so `/api/health`'s `SOLVER_WORKERS_FAILED` and the solver's ERROR line are the only signs.
- **Verify after the deploy:** the solver's startup log has no `SOLVER_ALLOW_INPROCESS_FALLBACK` error, `GET /api/health`
  is `ready`, and an optimization works as usual.

## The second route search: PyVRP (30 Sep 2026)

Every solve now runs a second route search (PyVRP 0.14.0) beside the engine's own, in one more worker process. Its plan is one
more candidate of the load re-check: the planner's own checks, exact timing and cost score judge it, so an option's plan is
never worse than the engine alone would have chosen from the same search. See `docs/OPTIMIZER_BENCHMARK.md` §12.

- **Dependency:** `pyvrp==0.14.0`, pinned exactly (0.14 changed the Model API; the legacy `/optimize` is ported). The
  Dockerfile's `python:3.11-slim` gets a manylinux wheel: no compiler, no new system package. A broken pyvrp install stops the
  whole solver from starting (the legacy `solver.py` imports it), so a failed build is seen at deploy time.
- **Variables** (solver only, names only; none needed on web):
  - `SOLVER_PYVRP`: `on` (default), `off` (or `0`), or `thorough` (Thorough solves only). Switching it off gives exactly the
    engine alone; no redeploy of the web is needed.
  - `SOLVER_PYVRP_MIN_CPUS` (default 2): the CPU gate. Below it the second search switches itself off (`CPU_GATE`).
  - Optional: `SOLVER_PYVRP_SEED` (1), `SOLVER_PYVRP_STOP_GRACE_SEC` (10). Never set `SOLVER_PYVRP_MAX_ITERS` or
    `SOLVER_PYVRP_STALL_SEC` / `SOLVER_PYVRP_STALL_SHARE` on Railway (tests and development only).
  - `SOLVER_PYVRP_ALLOWED` (16 Oct 2026; default `skip`): a day with a small-truck-only customer whose list leaves out a
    truck that can still load. `skip` (unset, or any value other than the two below): the second search does not run on
    such a day (`pyvrp run=<id> skipped: ALLOWED_TRUCKS`), as since 13 Oct 2026. `thorough`: it runs on Thorough solves,
    with the lists modelled (a routing profile per truck class, the stops a class may not carry forbidden); `model`: on
    every solve, Quick solves and hire checks included. Its plans are judged like any day's (the mapping back, the exact
    timing and the independent check refuse a stop on a truck it may not use). It changes the plans of such days: set it
    only with the owner's OK after a replay of saved real requests passes (`scripts/bench_search.py`, arm `pyvrp_model`:
    see "Best-of-N route search and the priority repair" below), `thorough` first, never during the evening's planning (a variable
    change restarts the solver).
- **CPU and memory per solve.** One more busy process while the searches run (Quick: the whole search, about 1.5 x the day's
  search time; Thorough: while the engine searches, then until its last better plan is max(30 s, 10% of its search time)
  old, at most until the load re-check's reserve), and its own load re-check job
  beside the engine's. CPU-seconds per solve roughly double (measured in §12). Memory: about 100 MB more per running solve on
  normal days (numpy and PyVRP in the process, the day's matrices), more on 600-stop days with plan continuity (the model then
  leaves continuity out above 64 MB of matrices). The solver service has **24 vCPU / 24 GB** (owner, 30 Sep 2026): at
  `MAX_CONCURRENT_DISPATCH=2` a solve uses at most 4 worker processes + 2 CP-SAT threads per stage job, far inside it.
  `MAX_CONCURRENT_DISPATCH=3` (and `SOLVER_MAX_CONCURRENT=3` on web) also fits.
- **It is optional.** Its process is started after the rule-22 check of the engine's own processes and never decides it: if it
  cannot start, fails, dies or hangs, the solve goes on with the engine alone and one log line says why (`pyvrp run=<id>
  skipped: ...` / `failed: ...`). Only a hung PyVRP costs time: at most `SOLVER_PYVRP_STOP_GRACE_SEC` on a Quick solve.
  On Linux its worker process asks to be the kernel's first out-of-memory victim (`oom_score_adj` 1000): a solver short of
  memory loses the second search (the engine's plans are used), never its API process. A crash of the API process or of a worker (a fatal signal
  in a C extension) prints every thread's Python stack to the solver log (faulthandler).
- **Deploy order:** solver first; the web may follow at any time (every new field is additive; an old web ignores them, and
  the second search's note is one of the plan's own warnings; an old web shows the new status `SECOND_SEARCH` as the code
  itself, a new web as "plan from the second route search").
- **Verify after the deploy:** the solver's startup log has the line `PyVRP second search: on for every search (pyvrp 0.14.0,
  effective CPUs N, min 2)` (or `off (...)` with the reason); `GET /ready` (with the solver token; the web's `/api/health`
  passes on only `ok`, `workers` and `routing`) has `"pyvrp": {"enabled": true, "version": "0.14.0", "effective_cpus": N, ...}`, and N is the vCPU count the
  container really gets. One Quick optimization of a normal day: the solver log shows `pyvrp run=<id> done: stop=SEARCH_END ...`
  and, when its plan was used, the option carries the note *"A second route search found a better plan for this option ..."*.
  With `SOLVER_PYVRP_ALLOWED` set, the startup line ends `; small-truck-only days: modelled (SOLVER_PYVRP_ALLOWED=model)`
  (or `modelled on Thorough solves (...=thorough)`; a value it does not understand: `skipped (... is not skip, model or
  thorough)`), `/ready` has `"pyvrp": {..., "allowed": "model"}`, and the next solve of a day with such a customer logs
  `pyvrp run=<id> model: ... limits=N` instead of `skipped: ALLOWED_TRUCKS`. A day that also has a stop filling a truck
  alone under the one-customer rule still logs `skipped: FULL_TRUCK` (checked after the lists; not modelled yet): check
  how many real days that is on the saved requests (`dispatch_solver._full_truck_day`) before counting on the change.
- **Rollback:** set `SOLVER_PYVRP=off` (no code change). A full rollback to the previous solver image also works: the web
  treats a missing `search.pyvrp` as "no second search". For small-truck-only days only: set `SOLVER_PYVRP_ALLOWED=skip`
  (or delete it).

## The route engine version: OR-Tools pinned (16 Oct 2026)

`apps/solver/requirements.txt` pins `ortools==9.15.6755`, the version the solver build of 15 Oct 2026 installed. Before, it
was a range (`>=9.10,<10`) and Railway re-resolves pip on every solver deploy, so any new 9.x would have arrived with the next
merge to `main`, a docs-only one included. The pin itself changes nothing in production (it installs the same version).

- **A bump is an engine change**, not a routine dependency update: a Dependabot PR that raises it fails
  `test_ortools_version_is_pinned` on purpose. Merge one only after replaying saved real requests on both versions
  (`docs/PROJECT_HANDBOOK.md` 5.4), and outside the evening's planning.
- **Verify after the deploy:** the solver's startup log (`railway logs --service solver`) has the line
  `Route engine: OR-Tools 9.15.6755 (the version requirements.txt pins)`; any other version logs an ERROR line
  `Route engine: OR-Tools X is installed, but requirements.txt pins 9.15.6755 ...`. `GET /ready` (with the solver token) has
  `"ortools": "9.15.6755"`, and the next optimization's stored response (`RunJob.responseJson`) has
  `search.ortools_version` = `"9.15.6755"`.
- **Rollback:** revert the commit (the range comes back); the new response field is additive, an old web ignores it.

## Best-of-N route search and the priority repair (16 Oct 2026, both off by default)

Two solver switches ship **off**; with both at their defaults every plan is the one from before (only the timing-drop
reason and warning texts changed, where they were untrue).

- `SOLVER_BEST_OF` (THOROUGH) / `SOLVER_BEST_OF_QUICK` (QUICK): RECOMMENDED's route search runs K times at once (1-8,
  default 1). `SOLVER_PRIORITY_REPAIR=on`: after the load re-check, a P1-P3 stop left out while a lower priority rides is
  put back in its place where it fits. See `docs/PROJECT_HANDBOOK.md` 2.9 and 4.11.
- **Not yet: turn none on (nor `SOLVER_PYVRP_ALLOWED`, above) before its replay passes.** Each needs a replay of saved
  real requests with it on and off through `apps/solver/scripts/bench_search.py`, judged by the rule the tool prints,
  which was written down before any replay ran: over every pair of runs (the same request, mode and repetition, base
  arm beside the switched one) RECOMMENDED never serves the day worse by priority; every option of every run is
  VERIFIED; the median paired difference in RECOMMENDED's operating cost is not above 0; every run answers within its cap
  minus 60 s; no search ends `TIMEOUT` or `LOST`, no solve fails and no worker process is left. An ad-hoc replay is not
  enough. Then turn one on with the owner's OK, one at a time, and never during the evening's planning: a variable change
  restarts the solver and cuts any running solve.
- **The replay** (`scripts/bench_search.py`): never in CI and never against production; one replay at a time on a machine
  of its own. The saved requests stay outside the repository, which is public (on the codespace, `~/ds-data`), and so
  does the output: the tool refuses an `--out` folder inside the repository.

  ```
  cd apps/solver
  .venv/bin/python scripts/bench_search.py ~/ds-data/day-*-request.json --dry-run
  .venv/bin/python scripts/bench_search.py ~/ds-data/day-*-request.json --out ~/bench/run1 \
      --arms base,best_of,pyvrp_model,repair_on,all_on --modes QUICK,THOROUGH --reps 3 --cpu-note "codespace 4 vCPU"
  .venv/bin/python scripts/bench_search.py --summary-only --out ~/bench/run1
  ```

  - **Arms.** Presets: `base` (every switch at its default), `best_of` (`SOLVER_BEST_OF=3`, `SOLVER_BEST_OF_QUICK=3`),
    `pyvrp_model` (`SOLVER_PYVRP_ALLOWED=model`), `repair_on` (`SOLVER_PRIORITY_REPAIR=on`), `join_report` / `join_on`
    (`SOLVER_JOIN_TRIPS=report` / `on`, below), `all_on` (every switch on; since 24 Oct 2026 that includes `join_on`, so
    an `all_on` result from before then is not like for like with one after); or your own,
    separated by `;`: `k4=SOLVER_BEST_OF=4,SOLVER_BEST_OF_SOURCES=2`. Before each run every switch is unset and the arm's
    own values set; the solver reads them on every solve, and each record keeps them as the solver read them. A variable
    the solver never reads, or a value it cannot read, is refused. The arms take turns within each repetition (A B C,
    then B C A), so the two runs of a pair ran minutes apart.
  - **As production runs a solve:** `optimize_dispatch` in a solve thread, its searches in worker pools
    (`SOLVER_PARALLEL=1`); `--modes QUICK,THOROUGH` (or `ASKED`, each request's own), THOROUGH with the request's own cap.
    `MAX_CONCURRENT_DISPATCH=1` in the bench (one solve at a time), so a 4-CPU machine's CPU gate still lets best-of run
    3 searches; the records and the summary say when the gate cut them. The road matrix is built once per request (OSRM
    when the bench machine's `OSRM_URL` is set, else straight-line estimates; a request's own `osrm_url` is never
    called) and every run uses that same matrix. The summary lists what is
    not production conditions (estimated distances, fewer CPUs, the shell's own `SOLVER_*` / `THOROUGH_*` variables).
  - **`--dry-run`** checks the requests and the arms, shows each arm's settings as the solver reads them, says whether a
    day has small-truck-only stops that decide something and a stop that fills a truck alone (PyVRP then skips the day
    as `FULL_TRUCK` whatever `SOLVER_PYVRP_ALLOWED` says) and the worst-case run time; it solves and writes nothing.
  - **Output** in `--out`: `results.jsonl` (one line per run: stops and cases left out per P1-P5, trucks, loads,
    operating cost, km, `used_sec`, stop reason, the best-of report (which search won, its gains), PyVRP's status, the
    priority repair's actions, warnings with every id replaced by `<id>`, any error); `summary.md` (each arm's verdict
    per mode, the paired differences per request as median [min, max], and the benefit: wins and losses, service first
    then cost, with a sign test); `bench.json`; `solver.log` (the solver's own log, which names stop ids). Running the
    same command again continues a stopped replay; `--stop-after-min` stops it on purpose (a codespace stops after its
    idle timeout).
  - **Reading it.** PASS means the switch did no harm on those days, not that it helps: the benefit column says whether
    it does (p <= 0.10 needs at least 4 decisive pairs). NOT EXERCISED means it never took effect (best-of cut to one
    search, no small-truck-only day, nothing to repair). Publish only differences and digests (`OPTIMIZER_BENCHMARK.md`),
    never a real day's totals.
- **What each one changes.** `SOLVER_BEST_OF_QUICK` changes every Quick solve: the evening's plan when it is a Quick
  one, every re-plan of the day and the hire check's main solve (its trials always search once). `SOLVER_BEST_OF` changes
  Thorough solves only; `SOLVER_PRIORITY_REPAIR` every solve but the hire check's trials. Each other search is one more
  busy worker process for the whole search and holds its own copy of the day's matrices, and the CPU gate counts CPUs
  only: before choosing K, measure the solver's peak memory with K searches on a 600-stop day with plan continuity on.
- **Verify after the deploy or a change** (`railway logs --service solver`): the startup lines
  `Best-of route search: off (one route search per solve; SOLVER_BEST_OF=1, SOLVER_BEST_OF_QUICK=1)` (or
  `THOROUGH K searches, ...` with `of N asked (CPU_GATE)` when the CPUs allow fewer) and
  `Priority repair: off (the default; ...)` (or `on (...)`). `GET /ready` (with the solver token) has `best_of`
  (`effective_thorough`, `effective_quick`) and `priority_repair`. With best-of on, the next optimization's stored response
  (`RunJob.responseJson`) has `search.best_of.searches` (one entry per search) and the log `best-of run=<id> search i of K ...`
  lines; with it off, `search.best_of` is null. A value the solver cannot read counts as its default (off for the switches) and
  is named in the startup line (`...; SOLVER_BEST_OF='10' not read (a whole number from 1 to 8): its default is used)`,
  `Priority repair: off (SOLVER_PRIORITY_REPAIR='enable' not read: on, 1, true or yes switch it on)`).
- **The first nights after turning one on:** read each night's `search.best_of` (or the priority repair's note and log
  lines) the next morning, and after the first week check Railway → solver → Usage (CPU and memory against the week
  before).
- **Roll back at once** (no code change) on any of: an optimization answering 503 or 504; a Thorough solve whose
  `search.used_sec` is above its cap minus 60 s; an other search `TIMEOUT` or `LOST` (`search.best_of.searches`) on two
  nights; RECOMMENDED's cost above the median of the 7 nights before at the same service by priority.
- **If a Thorough solve fails during the evening's planning** (whatever is switched on): run a Quick solve of the day,
  dispatch from it, and tell the engineer the run id.
- **Rollback:** unset the variables (or set `SOLVER_BEST_OF=1`, `SOLVER_BEST_OF_QUICK=1` and `SOLVER_PRIORITY_REPAIR=off`);
  no code change.

## The kept-load warning (24 Oct 2026, web only, on by default)

Daily dispatch (step 3), the plan screen and the RE-PLAN dialog list the locked and loading loads whose customer data
(receiving hours, pin, small-truck mark, a deactivated customer, cancelled or moved orders, new orders) changed after
they were planned, with an **Unlock** for each. It only adds information: nothing is refused, no migration, no solver
change. See `docs/PROJECT_HANDBOOK.md` 3.5, 3.7, 3.8 and 3.11, and `docs/DISPATCHER_GUIDE.md`.

- `KEPT_CHANGES` on **web** stays **unset** (on). `off` (also `0`, `false`, `no`) is the **kill switch**: every screen
  answers as before the warning (no `kept` field, no box, the dialog as before, no audit fields, and the plan screen's and
  the sheets' "Changed after planning" hours note of a locked stop as before; the RE-PLAN buttons still ask the server once,
  which answers nothing). It is read on every request, so no restart is needed. The web logs a startup warning while it
  is off, or set to a value it does not read (it then stays on).
- **Verify after the deploy** (a test day, never a live one): optimize, lock a load, change the receiving hours of a
  customer on it under Customers, then reload Daily dispatch: the box *Locked loads planned with older customer data*
  lists the load under step 3, and **RE-PLAN** shows it with an unticked *Unlock ... first*.
- **Rollback:** set `KEPT_CHANGES=off` on web (no code change, no restart).

## Re-timing for moves by hand (24 Oct 2026, the solver part; called by the Move dialog below)

The solver gets `POST /retime-truck-days` (`apps/solver/retime.py`; `docs/PROJECT_HANDBOOK.md` 4.16): a few truck days
re-timed exactly for a stop moved by hand. It changes no optimization and no plan; the web part that calls it (below)
ships in the same release behind its own switch, `PLAN_EDIT`, off by default, so until that is set nothing calls the
endpoint. Deploy it outside the evening's planning, like any solver deploy (a restart cuts a running solve).

- **Settings** (optional, all with defaults; see the handbook 2.9): `RETIME_MAX_CONCURRENT` (4 checks at once, then 503
  "Route checks busy"), `RETIME_BUDGET_SEC` (10), `RETIME_MATRIX_SEC` (6), `RETIME_BEST_TRIES` (24). Leave them unset.
  A check runs a few small timing LPs in the solver's API process (no search, no worker process: rule 22) and takes
  no optimization slot.
- **Verify after the deploy** (`railway logs --service solver`): the startup line
  `Re-timing for moves by hand (/retime-truck-days v1): max 4 at once, budget 10 s, road matrix 6 s, best place 24 tries`;
  `GET /ready` (with the solver token) has `"retime": {"version": 1, ...}`. The next optimization answers as before.
  Each check later logs one line `retime run=<id> tenant=<id> trucks=... stops=... ok=... provider=... timings=...
  seconds=...` (ids only).
- **Rollback:** redeploy the previous solver commit; nothing in the database changes.
- **Version 2 (25 Oct 2026, moves by hand part 2: several stops at once, whole loads, "allow anyway").** Deploy this
  solver **before** its web: the web deployed before it keeps working against it unchanged (its requests get the same
  answers, plus fields it ignores), while the new web refuses several stops at once on an older solver and offers
  nothing to allow by hand. No new setting. Verify: the startup line says `(/retime-truck-days v2)` and `GET /ready`
  has `"retime": {"version": 2, ...}`; each check's log line also has `relaxed=ok|no|- best_stops=... alt=...`.
  Rollback: redeploy the previous solver commit (the new web then answers "needs the updated route optimizer" for what
  needs v2; explicit moves keep working).

## Moves by hand on the plan screen (24 Oct 2026, the web part; `PLAN_EDIT`, off by default)

The web gets the Move dialog and two routes, `POST /api/runs/:id/edit/check` and `POST /api/runs/:id/edit`
(`docs/PROJECT_HANDBOOK.md` 3.7, 4.16). They call the solver's `/retime-truck-days` above. Both services deploy from the
same merge; **check the solver's startup line above before setting `PLAN_EDIT`** (an older solver answers 404 and the
dialog says "The route optimizer is being updated"; nothing is written). The web deploy runs the migration
`20261024120000_unserved_removed_by_hand` (one enum value, additive).

- **Switch** (web variable, read on every request): `PLAN_EDIT` unset or `off` = no Move button, the routes answer 404;
  `check` = dispatchers can Check a move (re-timed by the solver, nothing written) but not Save; `on` = Check and Save.
  Pilot: `check` for one or two planning days, then `on` with the owner's OK.
- **Verify** (`railway logs --service web`): with `check` or `on` the startup log has the `PLAN_EDIT=...` line; a Check
  on the plan in use answers a preview and the solver logs one `retime run=... ok=...` line; with `on`, a saved move makes
  the next plan version `MANUAL_ADJUSTMENT` ("By hand: ..." in the versions list) and the audit log has
  `ROUTE_MANUALLY_CHANGED`.
- **Rollback:** set `PLAN_EDIT=off` (Railway restarts the web; no deploy). Versions saved by hand stay valid plans. To roll
  the web code back past this release, first run the `UPDATE` in the migration file if any stop was taken off by hand
  (the previous Prisma client cannot read the new reason).

## Join small trips (24 Oct 2026, off by default)

`SOLVER_JOIN_TRIPS` on the solver: `off` (unset, the default: every plan is the one from before and `search.join_trips`
is null), `report` (each option's small loads of one company truck are joined, timed with every rule, built and checked,
and reported in `search.join_trips`; the plans stay as they are) or `on` (the joined plan is used when it passes every
check, with the note "Small loads joined after the load re-check: ..."). See `docs/PROJECT_HANDBOOK.md` 2.9 and 4.11.

- **Deploy it unset.** Nothing changes; the first deploy after the Railway pause also ships whatever `main` holds (#94).
- **Verify after the deploy or a change** (`railway logs --service solver`): the startup line
  `Join small trips: off (the default; SOLVER_JOIN_TRIPS unset or off)` (or `report (...)` / `on (...)`); `GET /ready`
  (with the solver token) has `join_trips.mode`. A value the solver cannot read counts as off and is named in the startup
  line (`...; SOLVER_JOIN_TRIPS='enable' not read (off, report or on): off is used)`).
- **Then `report`** with the owner's OK, outside the evening's planning (a variable change restarts the solver and cuts
  any running solve), for at least 5 planning days. Each morning read the night's `RunJob.responseJson->'search'->
  'join_trips'` in a read-only SQL session (query below): `status` is `FAILED` whenever any option was `NOT_VERIFIED` or
  `ERROR`, whatever the others found; per option the outcome (`WOULD_JOIN`, `NOT_VERIFIED`, `ERROR`, or why nothing was
  joined), the gains, `verified`; per change its kind (a `MOVE` onto another truck is reported only, also under
  `NO_SMALL_LOAD`), the truck, the margins to the latest return and to the break window's end, and `stops_after`; and the
  solver log's `join-trips run=<id> ...` line (per option its changes by kind). Publish only differences, never a real
  day's totals.

  ```sql
  SELECT j."runId", j."createdAt", j."responseJson"->'search'->'join_trips'->>'status' AS status,
         o->>'option' AS option, o->>'outcome' AS outcome, o->>'verified' AS verified, o->>'gain_omr' AS gain_omr,
         m->>'kind' AS kind, m->>'truck_id' AS truck_id, m->>'applied' AS applied, m->>'end_slack_min' AS end_slack_min,
         m->>'break_slack_min' AS break_slack_min, m->'stops_after' AS stops_after
  FROM "RunJob" j
  CROSS JOIN LATERAL jsonb_array_elements(j."responseJson"->'search'->'join_trips'->'options') o
  LEFT JOIN LATERAL jsonb_array_elements(o->'moves') m ON true
  WHERE j."createdAt" > now() - interval '1 day'
    AND jsonb_typeof(j."responseJson"->'search'->'join_trips') = 'object'
  ORDER BY j."createdAt", option;
  ```
- **Then `on`**, outside planning hours, once over those days no option was `NOT_VERIFIED` or `ERROR` and a dispatcher has
  looked at 3 days the report would have joined. In report mode the plan keeps its loads, so the review is of each
  change's `stops_after`: the truck's loads as the join would make them, stops in order (match the stop ids to customers
  and the truck id to its code in that night's `RunJob.requestJson`), with its return before and after and the margins.
  The offline replay and `scripts/bench_search.py` (arms `base,join_report,join_on`; NOT EXERCISED when no run joined or
  would have joined) come first, as for the switches above.
- **What it changes.** Every solve but the hire check's what-if (SKIPPED `HIRE_CHECK`; its trial solves are never joined):
  the evening's plan, every re-plan of the day. Only company trucks (never a truck to rent or one whose driver is paid by
  the day), only new loads (locked, loading and dispatched loads are never in a plan). Moves onto another truck are
  reported only. It runs in the API process for milliseconds (at most 2 s per option, 6 s per solve counted from the
  first option's step; its seconds are given back to the rented and day-paid trucks' re-ordering, so report mode leaves
  that step its time; the priority repair after it shares the solve's budget as before).
- **Roll back at once** (no code change: unset the variable) on any of: an option `NOT_VERIFIED` or `ERROR` in
  `search.join_trips`; a joined load a dispatcher says cannot be driven as planned. Plans already made stay valid: a joined
  plan is an ordinary plan.

## Private networking notes

- Service addresses are `<service>.railway.internal`. This environment resolves over **IPv4 and IPv6**.
- Servers should listen on `::`. OSRM does, via `OSRM_BIND=::`.
- Railway injects `PORT`. `routeiq-osrm` pins `PORT=5000` so its private URL never changes.
- OSRM and the solver have **no public domain**, and must not get one: OSRM has no authentication.
