# NMWC Dispatch Restart — Audit of the recovered RouteIQ

**Scope:** what RouteIQ actually did when it was recovered on 24 Sep 2026, measured against the NMWC daily dispatch planning MVP:

> sales orders → validate → complete customer master → optimize → truck loading plan → delivery routes → review → lock/dispatch → late orders → Excel export

The code was treated as the source of truth; the old docs (CLAUDE.md v1.3, OVERNIGHT_REPORT.md, README, docs/admin.md) were checked against it.

The last column of each table says what this workstream did about the finding. The audit itself describes commit `d02c44c` as it was found.

## Recovery facts

| Item | Value |
|---|---|
| Repository | `rahmanmansoori244-droid/routeiq` (private). Authenticated `gh` access existed on this PC. |
| Cloned to | `C:\Users\abdulr\routeiq` (separate from OPERATION-PROJECT) |
| Branches | `main` plus 20 Dependabot branches. No tags, no releases. |
| Latest commit | `d02c44c` 2026-05-12 09:24 +04 "fix: solver uses real road distance via OSRM; …" |
| Stack | pnpm/turbo monorepo. `apps/web`: Next.js 14.2.35 App Router, Prisma 5.22 on Postgres/PostGIS, NextAuth v5 beta, MapLibre. `apps/solver`: FastAPI + **PyVRP** (OR-Tools was replaced in `4c40e12`). `packages/shared-types` holds the wire types. |
| Deployment | Railway config for 2 services (`apps/web/railway.json`, `apps/solver/railway.json`). The old URL `web-production-a9d04.up.railway.app` still resolves but answers **HTTP 502 "Application failed to respond"**: the service exists but is not running. Nothing was changed on Railway. |
| Secrets in git | Full-history scan of 47 commits and all refs. **No real secrets committed.** Only placeholders and local/CI test values. `prisma/seed-nmwc.ts` holds a hard-coded demo admin password; rotate it if production was ever seeded with it. (Deleted in stabilization PR1; see `docs/SECURITY.md`.) |
| CI | All 30 recorded GitHub Actions runs failed at `pnpm/action-setup` ("Multiple versions of pnpm specified"). The web job (typecheck, lint, tests, build) has **never run in CI**. The solver pytest job passed. |

## Baseline test results (before any change)

| Suite | Result | Cause |
|---|---|---|
| Solver pytest (27) | **6 failed / 21 passed** | `pyvrp>=0.13.0` was unpinned. A fresh install gets 0.14, where `Model.add_depot(x=…)` changed, so **every** optimize request fails on a new build. |
| Web unit + tenant isolation (79) | 79 passed | Only after re-running `prisma generate`: the postinstall generated the client into the wrong folder on Windows. |
| Web integration (40, live server + solver) | **36 passed / 4 failed** | 3 run-lifecycle tests fail because of the broken solver. The janitor test expects an old response shape. |
| `tsc --noEmit` | passed (after `prisma generate`) | |
| `next lint --max-warnings 0` | **failed** | `@typescript-eslint/no-explicit-any` disable comments reference a plugin that is not installed. |

---

## WORKING

| Area | Evidence | Resolution in this workstream |
|---|---|---|
| Multi-tenant auth (NextAuth credentials, JWT 8 h), `tenantDb()` query scoping, 404 on cross-tenant access | `lib/tenant.ts`, `lib/api.ts`, 18 + 18 isolation tests | Reused. The new `PlanLoad` and `CustomerTypeProfile` models were added to the tenant scope. |
| Order upload: several SKU rows per customer grouped into one Order with many OrderLines; batch race guarded with `SELECT … FOR UPDATE` | `api/orders/[batchId]/confirm` | Reused the pattern and rewrote the intake (see REPAIR). |
| Priority direction P1 = highest in the legacy solver (drop penalty `1e6 × (6 − p)`) | `solver.py:99-105` | The new engine keeps P1 highest and adds a test that fails if it is ever inverted. |
| Async optimize job (RunJob, 202 + polling, retry, debug JSON, in-flight guard, stuck-job janitor) | `lib/jobs/optimize-job.ts` | Reused. The dispatch job shares the in-flight registry. |
| Audit log | `lib/audit.ts` | Reused, with new actions (location set, late order, plan version, load status). |
| MapLibre + OSM run map with road geometry | `runs/[id]/map-tab.tsx` | Pattern reused for the new plan map and pin map. |
| Password reset, user admin, security headers | | Untouched. |

## PARTIALLY WORKING

| Area | Gap | Resolution |
|---|---|---|
| Order file parsing | Only snake_case headers were accepted, with no aliasing. Excel date cells arrived as locale text and were rejected. "Today" was computed in UTC, not Oman time. Unknown customers or products were **blocking errors**. | **Rebuilt** (`lib/dispatch/order-intake.ts`). An alias table plus per-tenant overrides handles NMWC ERP headers. Dates are parsed as DMY/MDY, ISO, Excel serials or 25-Sep-2026. The tenant timezone is used. Unknown customers and products become stubs (LOCATION REQUIRED) instead of errors. |
| Customer coordinates | The map pin needed a Mapbox token. There was no Google Maps link parsing and no geocoding. | **Rebuilt.** Location input accepts coordinates, DMS, Google Maps URLs (pin `!3d!4d`, `q/ll/query/destination`, `/search`, `/place`, `@centre` needs pin confirmation) and short links resolved server-side through a Google-only allowlist. A token-free MapLibre pin map was added. Saved locations are permanent and record source, input, verified-by and verified-at. |
| Road distance (OSRM) | OSRM was silently used whenever `OSRM_URL` was set, with the **public demo server as default**. There was no chunking. The provider literal `OSRM` was outside the typed contract. Durations were car speeds. | **Repaired.** `providers.py` has an explicit OSRM provider with no silent public default, 90-coordinate tiling, Haversine fallback with a visible `ROUTING_PROVIDER_FAILURE` warning, and an `is_estimated` flag. `road_time_factor` = 1.25 scales car durations to truck durations. `OSRM` was added to the Prisma and TS enums. |
| Capacity | Cases were a hard limit. Weight was sent but ignored. | **Fixed:** cases and kg are both hard limits (kg when the truck has a payload). |
| Unserved reasons | Every solver drop was labelled `SOLVER_DROPPED_LOW_PRIORITY`. "Unassign" made orders vanish. | **Fixed:** there are 15 reason codes. Hard-window, shift, trip-limit, capacity, late-order and fleet-shortage cases are diagnosed. Stop moves are disabled on load-based plans, so orders cannot vanish. |
| Plan states | DRAFT/READY/DISPATCHED only. Per-stop locks existed. Unlock reverted a DISPATCHED run. | **Replaced** with per-load PLANNED → LOCKED → LOADING → DISPATCHED → COMPLETED, ordered per truck. Dispatched loads are immutable. |
| Excel export | One sheet per truck. No SKU manifest, no loads, and ETAs were minutes-from-departure shown as clock times. | **New master workbook:** SUMMARY, LOAD PLAN, one sheet per truck and load (manifest and route), SKU LOADING SUMMARY, UNSERVED, RECONCILIATION, ASSUMPTIONS. |
| Solver time budget | The 60 s floor claimed in the docs did not exist. The web timeout was 240 s against a solver cap of 300 s. | Automatic budget by problem size (3–45 s). Alternatives are warm-started in worker processes. The web timeout is 300 s. |

## BROKEN

| Finding | Evidence | Resolution |
|---|---|---|
| **Solver fails on a fresh install** (PyVRP 0.14 API) | 6 pytest failures | PyVRP pinned `<0.14` for the legacy endpoint. The MVP uses the new OR-Tools engine. |
| **Orders not scoped to depot.** Runs pulled every order for the date, and two runs could plan the same order twice. | `optimize-job.ts:309` | `Order.depotId` + `UploadBatch.depotId`. Plans are per depot + date. Legacy orders without a depot are included only when the tenant has a single depot. |
| Confirming the same file or sales order twice duplicated orders | confirm route | Duplicate detection on SO + customer branch + SKU + date, plus a file-hash check. |
| Customer re-import wiped saved coordinates | `customers/import/route.ts:210` | **Fixed:** a blank file location no longer overwrites, and a dispatcher-verified location is never overwritten. |
| Lock/unlock/unassign ignored run status; a dispatched run could be edited | `route-adjust.ts` | The legacy endpoints now refuse on load-based plans. Load status rules are in `lib/dispatch/load-state.ts`. |
| Lock merge could duplicate or lose orders; ETAs not recomputed after locks | `choose-scenario` | **Replaced:** frozen loads are copied verbatim into the next version, and the solver plans remaining orders after each truck's frozen loads return. |
| Estimated-km label taken from settings, not from the provider actually used | exports, cards | The label comes from the provider the solver reports it used. |
| ETA shown as minutes since departure but formatted as a clock time | `route-sheet-data.ts` | All plan times are clock minutes from local midnight. |
| Driver PWA login fails for any tenant with more than one truck | `driver-auth.ts` | **Deferred** (driver app is out of MVP scope). See REMOVAL/DEFERMENT. |
| MAX_UTILIZATION weighting works backwards | `solver.py adjusted_weights` | Legacy only; not used by the MVP. |
| CI never ran the web job | GitHub Actions | pnpm version conflict removed; lint and test scripts fixed (see repair list). |
| Zod coerced blank lat/lng to 0,0 | `lib/schemas.ts` | **Fixed** (blank is now "not set"), and 0,0 is treated as an invalid location. |
| Janitor integration test out of date | `janitor.spec.ts` | Updated to the new response shape. |

## DESCRIBED BUT NOT IMPLEMENTED

| Claim | Reality |
|---|---|
| OR-Tools solver (README, solver README, admin.md) | PyVRP since `4c40e12`. (The MVP now really does use OR-Tools; docs updated.) |
| 60 s solver floor; "estimated km label drops automatically once road km arrive"; driver login verified | Not true in code (OVERNIGHT_REPORT). |
| Time windows "stored as metadata" (Settings hint) | No such field existed. |
| Product/truck/region CSV import, downloadable validation report, Playwright E2E, `nmwc-normal.csv` / `nmwc-stress.csv` fixtures | Not present. The MVP adds NMWC fixtures and API-level E2E tests; Playwright is still not present. |
| Settings weights (`weightObjective*`, `latePenaltyPerMin`, `underutilizationPenalty`, cost defaults, `returnToDepot`) | Editable but ignored by the solver. The MVP uses new, documented dispatch settings instead. |

## IMPLEMENTED BUT NOT NEEDED FOR THIS MVP

- **Module C:** driver PWA, GPS pings, POD with signature, live dispatcher map. Works in parts; login is broken for fleets with more than one truck.
- **Mapbox Matrix provider** and Mapbox styles (dormant without a token).
- **Manual baseline comparison**, legacy 3-scenario cards, PDF route sheets, 30-day dashboard.
- **Public self-serve signup, onboarding wizard and SUPER_ADMIN platform admin.** Not needed for an NMWC-only deployment, and a security surface (open signup; SUPER_ADMIN granted by an email allowlist without verification).
- Sample order generator endpoint, live in production for any user.

## MISSING FOR NMWC MVP (all built in this workstream)

- Customer type and type defaults; hard and preferred receiving windows; location provenance (input, source, verified by/at).
- Google Maps link / short link / map pin location capture, **saved permanently**.
- Truck fuel economy, per-load cost, availability, max loads, default driver; depot opening hours.
- **Multiple loads per physical truck** with reload time and no overlap.
- **Hard time windows** in the optimizer; soft preferred windows; early-delivery preference by priority.
- Truck **loading manifest** (SKU totals per truck and load) that reconciles exactly to the sales orders.
- **Plan versions** (INITIAL / LATE_ORDER / MANUAL_ADJUSTMENT / REOPTIMIZE) with a change summary; **late-order cutoff** with reason and user; re-planning that preserves locked and dispatched loads.
- Exact reconciliation (total, per SKU, per sales order).
- Daily summary with P1–P5 service %, fuel, operating cost, revenue and margin (only when supplied).
- A single guided dispatcher screen.

## TECHNICAL DEBT THAT BLOCKED THE MVP

| Debt | Resolution |
|---|---|
| Unpinned solver dependencies | `pyvrp>=0.13,<0.14`, `ortools>=9.10,<10`. |
| Prisma client generated into the wrong folder on Windows | Run `pnpm --filter @routeiq/web exec prisma generate` after install (documented). |
| `.env.local` vs `.env` (Prisma CLI reads only `.env`) | Documented in `docs/LOCAL_DEV.md`. |
| Two map stacks (mapbox-gl pin picker vs MapLibre) | New dispatcher flows use MapLibre only (`components/pin-map.tsx`). |
| `vitest run` also ran integration suites (ECONNREFUSED without a server) | Scripts split into `test:unit` and `test:integration`. |
| In-memory upload rate limit of 10/hour | Raised for the daily loop (upload → fix → re-upload). |
| OSRM public-server default and car-speed durations | Removed or scaled (see PARTIALLY WORKING). |

---

## RECOMMENDED REUSE
Tenant/auth/RBAC/audit plumbing; RunPlan/RouteAssignment/ScenarioResult (extended rather than replaced); the async job pattern; the upload batch lifecycle; exceljs; MapLibre.

## RECOMMENDED REPAIR (done)
Order intake; customer location capture; depot scoping; duplicate protection; re-import safety; OSRM provider; unserved reasons; lock/dispatch semantics; exports; solver pinning; CI configuration; test script split.

## RECOMMENDED REMOVAL / DEFERMENT
- **Defer:** driver PWA and POD (fix multi-truck login when the driver phase starts), live map, Mapbox Matrix, baseline comparison, PDF.
- **Remove before production:** open public signup and SUPER_ADMIN email allowlist; the sample-order endpoint (or gate it to admins); the Settings weights the solver ignores.
- **Legacy solver** `/optimize` (PyVRP): kept only for comparison. Remove once the OR-Tools dispatch engine has run a few weeks of real NMWC days.
