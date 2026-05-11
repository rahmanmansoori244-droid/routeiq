# RouteIQ Solver

FastAPI + OR-Tools route optimization service. Deployed as a separate Railway service.

## Phase 0

Only `/health` is wired. `/optimize` returns 501 with a token check shim. Full implementation lands in Phase 3 per [`CLAUDE.md`](../../CLAUDE.md) section 7.

## Local dev

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
export SOLVER_TOKEN=dev-token       # PowerShell: $env:SOLVER_TOKEN = "dev-token"
uvicorn main:app --reload --port 8000
```

## Endpoints

| Path | Auth | Description |
|---|---|---|
| `GET /health` | public | Returns `{"ok": true}`. Used by Railway healthchecks. |
| `POST /optimize` | `X-Solver-Token` shared secret | 501 in Phase 0; routing engine in Phase 3. |

## Railway

Both `routeiq-web` and `routeiq-solver` deploy from the monorepo. Railway uses the Dockerfile in this directory. The web service reaches us via `http://routeiq-solver.railway.internal:8000`.

Required env vars:

- `SOLVER_TOKEN` — shared secret with the web service. Rotate every 90 days per the runbook.
- `PORT` — Railway sets this. Default 8000.
