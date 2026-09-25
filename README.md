# RouteIQ

Route optimization for NMWC (National Mineral Water Company, Oman): the **daily dispatch planner** turns tomorrow's sales orders into truck loading plans and delivery routes.

**Start here (Sep 2026 restart):**
- [`docs/PROJECT_HANDBOOK.md`](./docs/PROJECT_HANDBOOK.md): **the whole project in one place.** It covers where every part of the code is, the architecture and process flow, the optimizer logic, running/testing/deploying, history and decisions, open work, and a guide for AI code reviewers.
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

# 2. Copy env file and fill in values (the solver reads its own .env through --env-file, step 5)
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
uvicorn main:app --env-file .env --reload --port 8000   # reads SOLVER_TOKEN, OSRM_URL from apps/solver/.env
# Smoke test: a wrong token must answer 401 (500 means SOLVER_TOKEN was not loaded)
#   curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8000/route-geometry \
#     -H "X-Solver-Token: wrong" -H "content-type: application/json" -d '{"coords":[[23.6,58.4],[23.61,58.41]]}'

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

See [`docs/RAILWAY_DEPLOYMENT.md`](./docs/RAILWAY_DEPLOYMENT.md) (the current runbook; `CLAUDE.md` is the historical May 2026 spec). The `web` and `solver` services deploy from this monorepo, and the private `osrm` service from `infra/osrm`. The web service must run **exactly one replica**: the in-flight job map, the rate limits and the solve admission live in process memory. The full project handbook is [`docs/PROJECT_HANDBOOK.md`](./docs/PROJECT_HANDBOOK.md).

## License

Proprietary — © Abdulrahman / RouteIQ.
