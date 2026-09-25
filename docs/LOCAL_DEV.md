# Local development (Windows notes included)

## Prerequisites
- Node 20+ and pnpm 9 (`corepack pnpm@9.15.9 …` works without a global install)
- Python 3.11/3.12 for the solver (OR-Tools and PyVRP publish wheels for these)
- PostgreSQL 16 (PostGIS optional; the init migration skips it when unavailable)

## Setup
```bash
pnpm install
pnpm --filter @routeiq/web exec prisma generate   # REQUIRED on Windows: postinstall may generate into the wrong folder
cp .env.example apps/web/.env.local
cp apps/web/.env.local apps/web/.env              # Prisma CLI, seeds and vitest read .env only
cd apps/solver && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # (bin/ on Linux/macOS)
```
Set `DATABASE_URL`, `NEXTAUTH_SECRET` (random) and `SOLVER_TOKEN` (same value in `apps/solver/.env`).

## Database
```bash
pnpm --filter @routeiq/web exec prisma migrate deploy
pnpm --filter @routeiq/web db:seed:dispatch                      # NMWC demo tenant "nmwc" (prints generated passwords once)
pnpm --filter @routeiq/web db:seed:dispatch -- --orders=2026-09-26   # also writes .dev/orders-2026-09-26.xlsx to upload
```
Use `SEED_PASSWORD=...` to choose the demo password instead of a random one. Never commit it.

## Run
```bash
# solver: estimated (Haversine) distances without OSRM_URL; for road distances run the OSRM image
# locally (infra/osrm, docs/OSRM_SETUP.md) and add OSRM_URL=http://127.0.0.1:5000.
# Never use a public OSRM demo server: it would receive real customer coordinates from .dev data.
cd apps/solver && SOLVER_TOKEN=... .venv/Scripts/python -m uvicorn main:app --port 8000
# web
pnpm --filter @routeiq/web dev
```
Open http://localhost:3000/t/nmwc/dispatch.

## Tests
```bash
cd apps/solver && .venv/Scripts/python -m pytest tests -q        # solver: legacy + dispatch engine
pnpm --filter @routeiq/web test:unit                             # pure libs + tenant isolation (needs DB)
RATE_LIMITS_DISABLED=1 pnpm --filter @routeiq/web dev            # then, in another shell (sign-up must stay open, the default):
pnpm --filter @routeiq/web test:integration                      # HTTP suites incl. dispatch-mvp.spec.ts
pnpm --filter @routeiq/web exec tsc --noEmit && pnpm --filter @routeiq/web exec next lint --max-warnings 0
```

## Gotchas
- Stop `next dev` before `prisma generate` on Windows (the query engine DLL is locked while it runs).
- The solver solves every plan option in a worker process, so the API stays responsive during a solve. `SOLVER_PARALLEL=0` solves in-process instead (tests and debugging only: `/health` does not answer during a solve).
