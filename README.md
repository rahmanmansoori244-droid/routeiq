# RouteIQ

Route optimization for NMWC (National Mineral Water Company, Oman): the **daily dispatch planner** turns tomorrow's sales orders into truck loading plans and delivery routes.

**Start here (Sep 2026 restart):**
- [`docs/DISPATCHER_GUIDE.md`](./docs/DISPATCHER_GUIDE.md): the daily workflow (upload → resolve → optimize → review → lock/export/dispatch → late orders)
- [`docs/OPTIMIZER_DESIGN.md`](./docs/OPTIMIZER_DESIGN.md): how the optimizer decides (capacity, P1–P5, windows, multi-load trucks, cost)
- [`docs/NMWC_DISPATCH_RESTART_AUDIT.md`](./docs/NMWC_DISPATCH_RESTART_AUDIT.md): what the recovered code did and what changed
- [`docs/OPTIMIZER_BENCHMARK.md`](./docs/OPTIMIZER_BENCHMARK.md), [`docs/OSRM_SETUP.md`](./docs/OSRM_SETUP.md), [`docs/RAILWAY_DEPLOYMENT.md`](./docs/RAILWAY_DEPLOYMENT.md), [`docs/OPERATION_PROJECT_HANDOFF.md`](./docs/OPERATION_PROJECT_HANDOFF.md), [`docs/LOCAL_DEV.md`](./docs/LOCAL_DEV.md)

[`CLAUDE.md`](./CLAUDE.md) is the original v1.3 SaaS specification (May 2026). Where it disagrees with the docs above, the docs above and the code win.

## Repository layout

```
/apps
  /web                Next.js 14 App Router app
  /solver             Python FastAPI: OR-Tools dispatch planner (/optimize-dispatch) + legacy PyVRP (/optimize)
/packages
  /shared-types       TS types shared between web and (eventually) clients
```

## Prerequisites

- Node.js 20+
- pnpm 9+
- Python 3.11+ (for solver)
- Postgres 16 with PostGIS extension
- (Optional) Docker for running solver locally

## Local development

```bash
# 1. Install JS dependencies
pnpm install

# 2. Copy env file and fill in values
cp .env.example apps/web/.env.local
cp .env.example apps/solver/.env

# 3. Start Postgres (must have PostGIS extension)
#    e.g. via Docker:
#    docker run -d --name routeiq-db -p 5432:5432 \
#      -e POSTGRES_USER=routeiq -e POSTGRES_PASSWORD=routeiq -e POSTGRES_DB=routeiq \
#      postgis/postgis:16-3.4

# 4. Run migrations
pnpm db:migrate

# 5. Start the solver (in a separate terminal)
cd apps/solver
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# 6. Start the web app
pnpm dev
```

Open <http://localhost:3000>.

## Phase 0 acceptance scenarios

- [ ] Sign up at `/signup`, create tenant `nmwc`, log in, land on `/t/nmwc`.
- [ ] Navigate sidebar — placeholder pages render.
- [ ] `GET /api/health` returns `{ ok: true, db: 'up', solver: 'up' }`.
- [ ] Solver `/health` returns `{ ok: true }`.
- [ ] Cross-tenant URL access returns 404 (not 403).

## Deploying to Railway

See [`CLAUDE.md` section 14](./CLAUDE.md). Both `routeiq-web` and `routeiq-solver` deploy from this monorepo. The web service must run **exactly one replica** in v1 — the in-memory `inflight` job map is not multi-instance safe.

## License

Proprietary — © Abdulrahman / RouteIQ.
