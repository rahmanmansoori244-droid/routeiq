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
3. **solver** redeploys from `main` with the new OR-Tools engine. `OSRM_URL` is already set.
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
| web | Healthcheck | `/api/health`, timeout 300 s (Railway default) |
| web | Restart policy | On Failure (Railway default: 10 retries) |
| solver | Root directory | `/apps/solver` |
| solver | Builder | Dockerfile (`/apps/solver/Dockerfile`) |
| solver | Healthcheck | `/health` |
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

Later, as a separate change, move `web` from Nixpacks to Railpack:
- Build command `pnpm --filter @routeiq/web build`.
- Pin Node with `engines.node` or `RAILPACK_NODE_VERSION`.
- Fix the root `packageManager` (`pnpm@9.0.0`, while the lockfile is built with pnpm 9.15).
- Source: <https://railpack.com/languages/node>.

## Private networking notes

- Service addresses are `<service>.railway.internal`. This environment resolves over **IPv4 and IPv6**.
- Servers should listen on `::`. OSRM does, via `OSRM_BIND=::`.
- Railway injects `PORT`. `routeiq-osrm` pins `PORT=5000` so its private URL never changes.
- OSRM and the solver have **no public domain**, and must not get one: OSRM has no authentication.
