# RouteIQ on Railway — state and runbook

Railway project **`routeiq`**, environment **`production`**, region **EU West (Amsterdam)**. Checked 2026-09-24.

| Service | Source | State (2026-09-24) | Network |
|---|---|---|---|
| `solver` | GitHub `main`, `apps/solver` Dockerfile | **Online**. Redeployed 2026-09-24 with `OSRM_URL` set | private only: `solver.railway.internal` |
| `routeiq-osrm` | GitHub `nmwc-dispatch-mvp` → switch to `main` after PR #25 merges; root `/infra/osrm` | **Online** since 2026-09-24. Health check (a Muscat `/nearest` query) passes | private only: `routeiq-osrm.railway.internal:5000` |
| `Postgres` | image `ghcr.io/railwayapp-templates/postgres-ssl:18`, volume `postgres-volume` | **Crashed 2026-05-11**. Railway then removed the deployment; the logs have expired | volume still attached |
| `web` | GitHub `main`, Nixpacks | **Crashed 2026-05-11**. Deployment removed; the old URL answers 502 | public |

OSRM setup and verification: see [OSRM_SETUP.md](OSRM_SETUP.md).

## Bringing web + database back (not done yet — owner decision)

1. **Postgres:** open the service and click **Deploy the image…**. Watch the deploy logs; the crash cause is unknown because the logs expired.
   - The volume is still attached, so the data should be there.
   - Take a backup (**Postgres → Backups**) before anything else touches it.
2. **Merge PR #25**, then **web** redeploys from `main`.
   - Its start command runs `prisma migrate deploy`, which applies the two dispatch-MVP migrations.
   - Web variables (names only; values live in Railway): `DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `SOLVER_URL`, `SOLVER_TOKEN`. Optional ones are listed in `.env.example`.
3. **solver** redeploys from `main` with the new OR-Tools engine. `OSRM_URL` is already set.
4. **routeiq-osrm** → Settings → Source → Branch: `main`.
5. **Verify:**
   - `GET https://<web>/api/health` returns `"db": "up"`, `"solver": "up"` and `"routing": { "provider": "OSRM", "status": "up" }`.
   - Optimize a day; the plan shows **Road km**.

## Deadline: Railway stops reading `railway.json` on 2026-12-01

Railway deprecated "Config as Code".

- Existing `railway.json` files **stop being read on 2026-12-01**. Source: <https://docs.railway.com/config-as-code>
- File values never get copied into the dashboard. After the cutoff, anything that only exists in the file is lost. Source: <https://docs.railway.com/config-as-code/reference>
- For `web` that means the build command, the start command (**including the database migration step**), the health check and the restart policy.
- `routeiq-osrm` does not depend on a file: all its settings live in the dashboard.

**Recommended route: re-enter the settings in the dashboard, then delete the files.**

Avoid `railway config migrate` / Infrastructure as Code (`.railway/railway.ts`) for now:
- The CLI currently drops builder, restart policy, pre-deploy and health-check settings: <https://github.com/railwayapp/cli/issues/1199>.
- An IaC file must list *every* resource, or Railway plans to delete what's missing, including the database.

Before 2026-12-01, per service:

1. Open the latest successful deployment's **Details**. Settings that came from the file carry a file icon; note them.
2. **web** → Settings:
   - Build Command `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @routeiq/web build`.
   - **Pre-deploy Command** `pnpm --filter @routeiq/web db:migrate:deploy`. If migrations fail, the deploy stops and the previous version keeps serving.
   - Start Command `pnpm --filter @routeiq/web start`.
   - Healthcheck `/api/health`, timeout 30.
   - Restart On Failure, 3 retries.
3. **solver** → Settings:
   - Builder Dockerfile (`/apps/solver/Dockerfile`).
   - Healthcheck `/health`, timeout 15.
   - Restart On Failure, 3 retries.
4. On each service, clear **Config-as-code → Railway Config File**. Never set it to a new path; Railway rejects new file paths.
5. Delete `apps/web/railway.json` and `apps/solver/railway.json` in a commit. Deploy, and confirm no settings show the file icon.
6. Later, as a separate change: move `web` from Nixpacks (deprecated) to Railpack.
   - Build command `pnpm --filter @routeiq/web build`.
   - Pin Node with `engines.node` or `RAILPACK_NODE_VERSION`.
   - Source: <https://railpack.com/languages/node>.

## Private networking notes

- Service addresses are `<service>.railway.internal`. This environment resolves over **IPv4 and IPv6**.
- Servers should listen on `::`. OSRM does, via `OSRM_BIND=::`.
- Railway injects `PORT`. `routeiq-osrm` pins `PORT=5000` so its private URL never changes.
- OSRM and the solver have **no public domain**, and must not get one: OSRM has no authentication.
