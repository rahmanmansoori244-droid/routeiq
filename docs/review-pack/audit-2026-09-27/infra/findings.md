# Infrastructure, schema and dependency review

Pinned source: `83d8174836deb339d54f90e65b803550ed34c20d` (2026-09-27). Read-only review. No production environment, database, migrations, containers or deployments accessed. No production vulnerability probing.

## I01 — High-priority dependency remediation: unsupported Next.js with a matching security advisory

- **Location:** `apps/web/package.json:50`; resolved lock entry `pnpm-lock.yaml:100,3783`.
- **Confirmed:** both manifest and lock use Next.js **14.2.35**. Current official support policy lists 14.x as unsupported. Maintainer advisory **GHSA-h25m-26qc-wcjf / CVE-2026-23864** lists `>=13.0.0 <15.0.8` among affected versions, expressly includes Next 14 App Router, and lists no 14.x patched release. This project uses App Router.
- **Impact:** the installed framework falls within the vendor's affected range for RSC denial of service (resource exhaustion/crash). This is a confirmed dependency match, **not a demonstrated exploit of RouteIQ's deployed bundle**, and not remote code execution.
- **Qualification:** no explicit application `use server` directive was found. Exploitability depends on the bundled/reachable decoder paths and configuration; I did not compile or exploit the production bundle. This distinction should remain in the main report. The unsupported-major remediation is warranted independently.
- **Fix:** upgrade the Next/Auth/React stack in a dedicated tested PR to a currently supported, fully patched release, then rerun authentication, middleware, all exports and dispatch flows. Select the current latest patch at implementation time; January's first fixed versions should not be treated as sufficient against every later advisory.
- **Primary sources checked live:**
  - https://github.com/vercel/next.js/security/advisories/GHSA-h25m-26qc-wcjf
  - https://vercel.com/changelog/summary-of-cve-2026-23864
  - https://nextjs.org/support-policy
  - https://react.dev/blog/2025/12/11/denial-of-service-and-source-code-exposure-in-react-server-components
- **False-positive control:** the July action-specific GHSA-m99w-x7hq-7vfj requires at least one Server Action; none was established. The September `next/og` RCE advisory GHSA-vcvr-r3jv-pc5j affects 16.2–16.3, not this pinned version, and no ImageResponse path was found. Neither is counted as a confirmed RouteIQ exploit.

## I02 — Medium: deployment health can be green while every optimization is misconfigured

- **Location:** `apps/web/app/api/health/route.ts:19–29,39–43`; `apps/web/lib/solver-client.ts:61–66`; related `apps/solver/main.py:106–118`, `apps/web/lib/startup-checks.ts`.
- **Failure:** missing `SOLVER_TOKEN` on web, but DB is reachable and solver's unauthenticated `/health` responds. `/api/health` returns **200, ok:true, solver:up**. The next optimization immediately throws **SOLVER_TOKEN not set**. A mismatch between otherwise nonempty web/solver tokens also is not tested by this liveness request (that second case was source-traced, not runtime-probed).
- **Impact:** Railway's configured health gate may accept a deployment unable to plan; monitoring looks healthy during a planning outage. This does **not** establish that the present production token is wrong.
- **Reproduction:** `health_probe.mjs` executes the current health handler and current solver-client function with healthy DB and solver-health boundary stubs; no network. Output `health_probe_result.json` records the 200 response and immediate planning error. Exactly one stubbed health fetch occurs; no solve runs.
- **Fix:** separate process liveness from dispatch readiness. Reject/flag missing required configuration, and add a lightweight authenticated solver readiness/capabilities endpoint that checks token agreement and contract/engine version. Do not launch an optimization as a health probe; cache readiness briefly and bound its duration.

## I03 — Low: VM/on-prem OSRM healthcheck does not check the server

- **Location:** `infra/osrm/docker-compose.yml:19–23`.
- **Failure:** Docker executes `osrm-routed --version`, which starts a separate version-printing process. It does not connect to the main `osrm-routed` server or test its loaded graph. A running but unresponsive backend can still receive a healthy check.
- **Impact:** misleading container health on the documented optional Docker-host deployment. The documented Railway deployment uses an actual `/nearest` request and is **not** affected by this compose-only error.
- **Fix:** query a known in-region `/nearest/v1/driving/...` or small `/route` request with a short timeout and check both HTTP status and OSRM `code=Ok`.
- **Evidence limits:** configuration/source confirmation; no Docker daemon or hung backend was started.

## Improvements and verification gaps (not additional confirmed bugs)

1. **Reproducible solver builds:** `apps/solver/requirements.txt:6–16` leaves OR-Tools, PyVRP and HTTP dependencies on version ranges; `Dockerfile:1,10–11` uses a moving Python tag and resolves afresh. Two builds of the same commit can differ. Pin a generated transitive lock with hashes and record Python/OR-Tools/PyVRP versions, source SHA and matrix provenance with benchmarks. Keep deliberately scheduled upgrades.
2. **CI does not certify a real production upgrade:** `.github/workflows/ci.yml` migrates a fresh PG16+PostGIS service, whereas the runbook says production is PG18 without guaranteed PostGIS. Add a PG18 upgrade fixture from a representative prior schema/data snapshot, while preserving the clean-database path. Current code tolerates missing PostGIS; I found no query requiring it.
3. **CI omits the release benchmark and realistic-volume pack:** it runs unit/integration and solver tests, not the complete 300-stop benchmark or all five 320–450-invoice application flows. Rate limiting is deliberately disabled for integration tests; production configuration still needs separate tests/checks. Existing unit tests do test limiter primitives.
4. **Operational invariants deserve metrics:** queue wait, total job age, orphan recovery, solver fallback share, deadline/error rates, dispatch gate refusals and database growth should be monitored. `handleError` catches unexpected errors and logs them (`lib/api.ts:115–116`); add explicit sanitized error reporting rather than assuming every caught 500 reaches Sentry.
5. **Schema defense in depth:** many business relationships depend on tenant-safe application code rather than composite tenant foreign keys. This review did not establish a reachable cross-tenant write. Consider composite keys for high-value relations and database checks for nonnegative quantities once historical rows are measured. Retain historical plans and durable invoice identities when designing retention.
6. **Recovery documentation should avoid unconditional assumptions:** runbook advice says any failed migration can be marked rolled back because every migration is atomic. Prisma's official architecture says it does not explicitly wrap PostgreSQL migrations by default; PostgreSQL simple-query batching may nevertheless make the current scripts atomic. I did **not** reproduce a partially applied current migration, so this is not reported as a defect. Require examination of actual migration state before `migrate resolve`, and test interrupted upgrades in disposable infrastructure. Do not edit existing migration files.
7. **Restore evidence:** runbooks document scheduled daily/weekly backups, but this source review cannot establish current backup success or recovery time. A restore drill into a disposable database supplies that evidence. No backup or production inspection was performed here.
8. **Internal solver resource limits:** the solver's dispatch endpoint has a semaphore, while legacy `/optimize` has no equivalent admission cap. FastAPI parses request models before the in-handler token check. Keep both endpoints private; consider token checking before expensive parsing, body/list bounds and the same admission guard on every expensive endpoint, or retire the unused legacy endpoint. This is internal-service hardening, not demonstrated unauthenticated solver execution or a tested denial of service.

## Coverage and positive findings

- Reviewed Prisma models, relation/deletion behavior and migration additions/backfills; no new destructive migration or directly confirmed schema mismatch identified.
- Durable intake identity, unserved-order delete protection, nullable plan snapshots and costs are meaningful protections. Service-time backfill writes audit rows in the same SQL statement as its changes.
- Reviewed Docker/OSRM configuration, deployment and recovery runbooks, health, startup checks, Sentry/observability configuration, CI/Dependabot and dependency pins.
- Reviewed admission/rate limiting and job recovery interfaces. The independently confirmed non-atomic janitor recovery issue is owned and reproduced by the lifecycle reviewer; it is not counted twice here.
- Single-replica limits and estimated-road fallback are explicitly documented design choices, not newly discovered defects.
- Exact inspected-file inventory and fingerprints are in `coverage.json`; artifact bytes are not changes to repository source.

## Suggested acceptance checks

1. Missing web token, missing solver token and mismatched tokens produce a failed dispatch-readiness result; healthy matched tokens succeed without starting a solve.
2. A hung OSRM server fails compose health while a healthy graph succeeds.
3. Same dependency lock and image digest reproduce the same solver build metadata; benchmark records expose it.
4. Upgrade from a seeded previous schema on PG18 preserves frozen snapshots, intake identities, order quantities and audit evidence.
