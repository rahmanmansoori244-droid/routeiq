**RouteIQ — comprehensive code audit**

Reviewed 27 September 2026. Repository: [RouteIQ](https://github.com/rahmanmansoori244-droid/routeiq). Pinned main: [`83d8174`](https://github.com/rahmanmansoori244-droid/routeiq/commit/83d8174836deb339d54f90e65b803550ed34c20d). Review only; no production changes, migrations, commits or repository source edits.

**Assessment**

The application has substantial, useful engineering: durable intake identity, explicit frozen work, reconciliation, dispatch gates, tenant-aware APIs and a large test suite. Nevertheless, I would not sign off on unattended daily dispatch solely from its current green CI. This broader pass found 26 additional actionable items: 1 dependency issue needing prompt remediation, 18 medium-severity defects and 7 lower-severity defects. Earlier findings are listed separately and are not counted again. Severity describes plausible impact and preconditions, not measured incident frequency.

The most consequential pattern is loss or staleness of business meaning around the solver: priority merging, coordinates, depot ownership, service duration and recovery state. A route optimizer can correctly solve the wrong input. Correcting those boundaries is at least as important as improving search quality.


**What was examined and what was actually executed**

The complete pinned repository was retrieved and all 488 tracked file blobs matched GitHub. The inventory classifies 321 source files, 111 test/benchmark files, 19 configuration files and 37 documentation/fixture files. These are inventory categories, not a claim that every line was independently proven correct. Review lanes covered security/tenancy, intake/master data, plan lifecycle/jobs, solver mathematics, UI/exports, and infrastructure/schema; remaining helper/screen passes are recorded in the evidence package. All ten solver implementation modules and all 61 API route files were inspected at their respective documented depths; the API boundary inventory covers 86 handlers. Some secondary UI and support files received targeted/static review rather than full behavioral execution.

The same-head [GitHub CI run](https://github.com/rahmanmansoori244-droid/routeiq/actions/runs/36305317310) reports 213 solver tests, 1,056 web unit tests and 197 integration tests passing: 1,466 total. Migration, type, lint and build checks were green. This is previously inspected remote CI evidence for this exact SHA, not a claim that I reran those suites locally during this pass.

Locally, the probes executed actual TypeScript/Python functions, extracted unchanged component callbacks and exact mathematical constraints with synthetic data and controlled boundaries. They cover row merging, locations, concurrency schedules, job recovery, weight encoding, cache metadata, readiness and UI state. This environment lacks the project’s installed OR-Tools/PyVRP, Node dependency tree and PostgreSQL/browser setup. Consequently I did not run a complete optimizer, a live database concurrency test, rendered browser journey, binary workbook/PDF validation or production penetration test. Each finding states its evidence level. Passing a reproduction means the defect was demonstrated under its stated conditions, not that a regression has been fixed.

**Prioritized finding register**

| ID | Priority | Finding |
|---|---|---|
| F01 | High remediation priority | Unsupported Next.js version matches a security advisory |
| F02 | Medium | Merging invoice rows drops priority and delivery instructions |
| F03 | Medium | Deleting a depot can transfer its demand into another depot’s scope |
| F04 | Medium | Partial revenue and margin become falsely complete totals |
| F05 | Medium | Customer import can overwrite a newly verified pin |
| F06 | Medium | A late preview can save customer A’s location to customer B |
| F07 | Medium | Invalid receiving hours and unloading text silently become planning values |
| F08 | Medium | Whole-kilogram rounding excludes physically feasible loads |
| F09 | Medium | Job recovery can permanently strand a plan as OPTIMIZING |
| F10 | Medium | A retired password-reset link can overwrite a newer password |
| F11 | Medium | Concurrent changes can remove every active tenant administrator |
| F12 | Medium | Foreign-company pages can silently mutate the home company |
| F13 | Medium | Customer corrections leave a READY plan and its share warnings stale |
| F14 | Medium | Legacy assignment deletion bypasses closed-run and assignment locks |
| F15 | Medium | Health can report ready while every optimization is misconfigured |
| F16 | Low | All-unserved dispatch plans lose the dispatch Excel export |
| F17 | Low | Invalid DMS coordinates are accepted with high confidence |
| F18 | Low | Legacy distance-cache hits mislabel estimates as road distances |
| F19 | Low | Optional Docker OSRM healthcheck only checks the executable version |
| F20 | Medium | Deleting a driver can race with dispatch and erase the assignment |
| F21 | Medium | A plan read can mix one scenario’s totals with another scenario’s loads |
| F22 | Medium | Infeasible alternatives receive favorable trade-off labels |
| F23 | Low | Dashboard cost per case is rounded before its declared display precision |
| F24 | Medium | Failed inline customer updates can remain visually applied |
| F25 | Low | Midnight truck availability prevents subsequent form saves |
| F26 | Low | Optional master fields do not have reliable clear semantics |

**Failure scenarios, source locations and fixes**

**F01 — Unsupported Next.js version matches a security advisory (High remediation priority)**

Source: [apps/web/package.json:50](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/package.json#L50); [pnpm-lock.yaml:100](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/pnpm-lock.yaml#L100).

The application and lockfile use Next.js 14.2.35. The maintainer lists Next 14 App Router in the affected range for CVE-2026-23864 / GHSA-h25m-26qc-wcjf, a denial-of-service issue. Next 14 is also outside the official supported majors.

Impact: This warrants a planned security upgrade. No deployed RouteIQ exploit, account compromise or remote code execution was demonstrated. No explicit application Server Action was established; reachable bundle paths and configuration still need assessment.

Proposed fix: Upgrade to a currently patched supported release in a dedicated PR, with the compatible React/auth stack and full regression checks. Do not assume the advisory’s first January patch is sufficient against later advisories.

Evidence: Manifest/lock inspection plus live maintainer advisory and support policy. No exploitation attempted.

Acceptance check: Supported, patched dependency resolution; authentication, middleware, dispatch and export tests pass on the upgraded build.

**F02 — Merging invoice rows drops priority and delivery instructions (Medium)**

Source: [apps/web/lib/dispatch/order-intake.ts:495–507](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/order-intake.ts#L495-L507); [apps/web/lib/dispatch/intake-server.ts:397–413](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/intake-server.ts#L397-L413).

Two rows for the same invoice/SKU contain 10 cases at P5 and 5 cases at P1 with an urgent receiving note. Merging retains the first row’s priority and note. Reversing row order changes the saved priority, although the order-insensitive upload fingerprint stays identical. For a P3 customer, the P5-first file reaches planning as P3 instead of P1.

Impact: ERP sorting can silently change which deliveries receive priority and discard instructions. The solver cannot recover requirements already lost during intake.

Proposed fix: Merge priority using the strongest explicit priority; preserve distinct notes and row provenance. Reject or flag metadata conflicts that have no safe merge rule.

Evidence: Actual normalize, resolve and confirm functions with synthetic database boundaries: intake/probe-intake-results.json.

Acceptance check: Every permutation of identical source rows produces identical business meaning, priority and retained instructions.

**F03 — Deleting a depot can transfer its demand into another depot’s scope (Medium)**

Source: [apps/web/app/api/depots/[id]/route.ts:40–59](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/api/depots/[id]/route.ts#L40-L59); [apps/web/prisma/migrations/20260924090000_nmwc_dispatch_mvp/migration.sql:224–227](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/prisma/migrations/20260924090000_nmwc_dispatch_mvp/migration.sql#L224-L227); [apps/web/lib/dispatch/plan-service.ts:174–180](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/plan-service.ts#L174-L180).

Nizwa has an uploaded 50-case order but no truck or run. Depot deletion checks trucks/runs only, then deletes Nizwa. Order and upload-batch foreign keys set depotId to NULL. If Muscat is the sole remaining active depot, its scope includes that formerly Nizwa order. With multiple remaining depots, the order instead falls out of their depot scopes.

Impact: Administrative cleanup loses explicit depot ownership, potentially sending demand to the wrong dispatch operation.

Proposed fix: Deactivate depots with any business references. Make deletion/reference checks atomic; consider restrictive foreign keys and distinguish genuinely legacy unassigned orders. Revalidate the depot when confirming a previously validated upload.

Evidence: Actual DELETE and scope function executed. SET NULL modeled directly from checked migration DDL; no PostgreSQL deletion performed. intake/probe-intake-results.json.

Acceptance check: An order or validated upload prevents destructive depot deletion; demand never changes depot merely because a master row is removed.

**F04 — Partial revenue and margin become falsely complete totals (Medium)**

Source: [apps/web/lib/dispatch/order-intake.ts:503–504](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/order-intake.ts#L503-L504); [apps/web/lib/dispatch/intake-server.ts:398–435](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/intake-server.ts#L398-L435).

Merge 10 cases carrying 100 OMR revenue/20 OMR margin with 5 cases whose money fields are blank. The resulting 15-case line is saved as a complete 100/20 total. A nonmerged control correctly retains unknown order totals.

Impact: Missing money is implicitly treated as zero, and economic scoring/reporting can claim complete data where it has only a subtotal. No specific changed final route is asserted.

Proposed fix: Track completeness separately for revenue and margin, or propagate null whenever any component is unknown. Keep a known subtotal separately if useful.

Evidence: Actual intake and persistence logic with controlled I/O: intake/probe-intake-results.json.

Acceptance check: Merging partially known monetary rows never enables complete-money scoring; later rows cannot reset unknown to zero.

**F05 — Customer import can overwrite a newly verified pin (Medium)**

Source: [apps/web/app/api/customers/import/route.ts:182–190](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/api/customers/import/route.ts#L182-L190); [apps/web/app/api/customers/import/route.ts:235–281](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/api/customers/import/route.ts#L235-L281).

Import reads locationVerified=false. A dispatcher then verifies a corrected point. Import subsequently uses its stale read to overwrite the coordinates, leaving locationVerified=true and the dispatcher’s attribution attached to the wrong point.

Impact: A bulk import can undo a location correction and falsely present the imported coordinates as verified.

Proposed fix: Condition coordinate writes atomically on the current unverified state, or lock/re-read the customer within the update transaction. Base kept-verified counts on actual write outcomes.

Evidence: Actual import POST with controlled read/write interleaving; parser/auth/database boundaries substituted. intake/probe-intake-results.json.

Acceptance check: A dispatcher verification between import read and write preserves the verified coordinates and attribution.

**F06 — A late preview can save customer A’s location to customer B (Medium)**

Source: [apps/web/app/t/[slug]/dispatch/location-dialog.tsx:48–83](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/t/[slug]/dispatch/location-dialog.tsx#L48-L83); [apps/web/app/t/[slug]/dispatch/dispatch-client.tsx:538–539](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/t/[slug]/dispatch/dispatch-client.tsx#L538-L539).

Start reading A’s location, cancel, open B, then let A’s response finish. The mounted dialog accepts the old result into B’s state. Clicking Save submits A’s coordinates to B’s customer endpoint. Cancel remains available while the read is busy.

Impact: Wrong customer coordinates can be persisted and used by later plans. The dispatcher must click Save and can see the changed pin; the late response alone does not write data.

Proposed fix: Associate every preview with a customer/input generation. Ignore obsolete responses, invalidate on close/change and abort requests where possible.

Evidence: Verbatim current preview/save callbacks with a deferred response; submission target B and point A recorded. ui/ui-results.json. No real HTTP write.

Acceptance check: Resolve A’s delayed response after B opens: B’s pin remains unchanged and Save cannot use A’s result.

**F07 — Invalid receiving hours and unloading text silently become planning values (Medium)**

Source: [apps/web/app/t/[slug]/dispatch/client-api.ts:105–110](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/t/[slug]/dispatch/client-api.ts#L105-L110); [apps/web/app/t/[slug]/dispatch/customer-dialog.tsx:55–77](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/t/[slug]/dispatch/customer-dialog.tsx#L55-L77); [apps/web/app/api/customers/[id]/route.ts:55–60](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/api/customers/[id]/route.ts#L55-L60).

The form converts 06:90 to 450 minutes, meaning 07:30. Unloading input “ten” becomes zero through Number(service) || 0. The API receives valid numbers and marks service time confirmed, so defaults no longer protect the plan.

Impact: Hard receiving hours can shift and unloading duration can disappear without a validation error, making schedules unrealistically optimistic.

Proposed fix: Reuse the strict shared parseHhmm helper. Validate finite integer service minutes, distinguish blank/invalid from an explicitly chosen zero.

Evidence: Current form callbacks produced start 450 / end 600 / service 0 without errors. The existing strict parser rejects 06:90. ui/ui-results.json.

Acceptance check: Malformed times, alphabetic unloading and blank required duration produce validation errors; intentional zero remains explicit.

**F08 — Whole-kilogram rounding excludes physically feasible loads (Medium)**

Source: [apps/solver/dispatch_solver.py:712–716](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/solver/dispatch_solver.py#L712-L716); [apps/solver/load_repack.py:860–864](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/solver/load_repack.py#L860-L864).

One 3,000 kg, 300-case truck has one available trip. Three nearby 100-case deliveries weigh 999.1 + 999.1 + 1,001.8 = 3,000 kg. Routing rounds each upward, encoding 3,002 kg. Repair offers existing routes plus singleton stops and cannot combine the missing stop into the existing trip.

Impact: A genuinely feasible all-served load is excluded by the mathematical representation. More search time cannot repair an excluded route.

Proposed fix: Choose a consistent integer weight unit, such as grams, across splitting, routing, repacking and verification. Keep any safety reserve explicit at truck level.

Evidence: Actual conversion code recorded; a manually constructed combined route passes the current feasibility check as VERIFIED; actual repair pools inspected. solver/deep_solver_checks.json. No full OR-Tools output claimed.

Acceptance check: Serve the exact-capacity three-stop case in one trip, while a just-over-capacity control stays infeasible.

**F09 — Job recovery can permanently strand a plan as OPTIMIZING (Medium)**

Source: [apps/web/lib/jobs/optimize-job.ts:73–107](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/jobs/optimize-job.ts#L73-L107); [apps/web/lib/dispatch/start-optimize.ts:244–249](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/start-optimize.ts#L244-L249).

The janitor changes a job to FAILED, then updates its plan separately. If the second write fails, the plan stays OPTIMIZING. Later sweeps ignore FAILED jobs, while retrying optimize returns 202/RUNNING for that dead job and schedules nothing.

Impact: A transient database failure can become a persistent planning outage for the day until repaired manually.

Proposed fix: Update job, plan and audit atomically, then add reconciliation for inconsistent rows already created. Retry logic must distinguish a live job from a stale plan status.

Evidence: Actual janitor and start function executed with a second-write failure. Subsequent sweep and optimize retry leave the mismatch. lifecycle/lifecycle-probes-results.json.

Acceptance check: Injected failure rolls back both transitions, or the next sweep restores consistency; retry must create useful work or return an actionable error.

**F10 — A retired password-reset link can overwrite a newer password (Medium)**

Source: [apps/web/lib/password-reset.ts:103–114](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/password-reset.ts#L103-L114); [apps/web/app/api/users/[id]/reset-password/route.ts:46–57](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/api/users/[id]/reset-password/route.ts#L46-L57).

Token consumption reads an unused reset link. An admin reset then changes the password and retires that link. The first operation deletes the token using only its ID, succeeds despite retirement, and overwrites the newer password.

Impact: Reset revocation does not hold under this interleaving. Exploitation requires possession of an otherwise valid link and favorable timing; this is not anonymous token guessing or a demonstrated production takeover.

Proposed fix: Use conditional atomic consumption requiring unused/unexpired state and consistent per-user serialization across issuance, consumption and administrative reset.

Evidence: Unchanged reset helper with explicit database interleaving; sequential retired-token control correctly rejects. auth/auth-race-results.json. No live database race.

Acceptance check: A real PostgreSQL barrier test retires the token between validation and consumption; the retired link must not replace the newer password.

**F11 — Concurrent changes can remove every active tenant administrator (Medium)**

Source: [apps/web/app/api/users/[id]/route.ts:33–58](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/api/users/[id]/route.ts#L33-L58).

Two active administrators are deactivated concurrently. Each independent count sees the other administrator, both pass, and both updates return 200. Zero active tenant administrators remain. The sequential single-admin control correctly returns 400.

Impact: The company loses its own ability to administer access/settings and needs platform-owner intervention.

Proposed fix: Lock a stable tenant row, recheck the invariant, update and audit in one transaction. A default-isolation transaction without shared serialization is insufficient.

Evidence: Two actual PATCH handlers with a count barrier: auth/auth-race-results.json.

Acceptance check: Concurrent deactivation/demotion requests always leave at least one active administrator.

**F12 — Foreign-company pages can silently mutate the home company (Medium)**

Source: [apps/web/app/t/[slug]/settings/page.tsx:14–26](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/t/[slug]/settings/page.tsx#L14-L26); [apps/web/app/t/[slug]/settings/settings-form.tsx:82–94](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/t/[slug]/settings/settings-form.tsx#L82-L94); [apps/web/lib/api.ts:64–88](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/api.ts#L64-L88); [apps/web/app/t/[slug]/users/users-client.tsx:246–259](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/t/[slug]/users/users-client.tsx#L246-L259); [apps/web/app/api/users/route.ts:24–45](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/api/users/route.ts#L24-L45).

A SUPER_ADMIN belonging to A opens company B’s editable Settings. Both have reloadMinutes 30. Saving 45 sends no selected-company identity: the deliberately home-tenant API changes A to 45, leaves B 30 and returns 200. The same root cause extends to invitations, customer imports, master creation and onboarding. An invitation intended for B can create a user with the selected role, including TENANT_ADMIN, in A.

Impact: The displayed target and mutation target disagree. The administrator has permission for both companies; the defect is silent wrong-company modification, not bypassing tenant authorization. The invitation path creates an unintended company-membership risk and deserves priority alongside intake integrity.

Proposed fix: Make foreign-company views read-only under the existing policy, or implement an explicit permission-checked and audited active-company switch end to end. Do not trust the page URL alone.

Evidence: Actual settings route and withTenantApi wrapper with two synthetic companies. auth/foreign-tenant-settings-results.json. Broader creation/invitation paths are source-confirmed in ui/coverage-gap.md; no user invitation was sent.

Acceptance check: Open B as an A-based platform administrator: editing is disabled, or an explicit authorized switch causes only B to change. Test equal defaults.

**F13 — Customer corrections leave a READY plan and its share warnings stale (Medium)**

Source: [apps/web/app/t/[slug]/dispatch/dispatch-client.tsx:138–145](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/t/[slug]/dispatch/dispatch-client.tsx#L138-L145); [apps/web/app/t/[slug]/dispatch/dispatch-client.tsx:517–539](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/t/[slug]/dispatch/dispatch-client.tsx#L517-L539); [apps/web/app/t/[slug]/dispatch/plan-view.tsx:94–146](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/t/[slug]/dispatch/plan-view.tsx#L94-L146).

Saving a pin or receiving-hours correction refreshes the day but does not refresh the selected plan. The same PlanView stays mounted and READY plans do not poll. Locally generated WhatsApp text therefore retains old plan detail and omits the intended master-change warning until a later reload.

Impact: The screen/share message can remain stale even though the day banner updates. Server dispatch mutations recheck data, and server-generated exports reload detail; those protections are not claimed bypassed.

Proposed fix: After customer/location save, refresh the day and explicitly invalidate the current plan detail in place.

Evidence: Actual day loader/callback and WhatsApp helper: day revision changes, plan reload signal remains 0, stale message lacks warning while fresh detail includes it. ui/ui-results.json.

Acceptance check: Edit a customer on a READY plan and immediately check plan warnings, map and WhatsApp text without reloading the page.

**F14 — Legacy assignment deletion bypasses closed-run and assignment locks (Medium)**

Source: [apps/web/lib/route-adjust.ts:417–430](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/route-adjust.ts#L417-L430); [apps/web/app/api/runs/[id]/routes/[assignmentId]/route.ts:68–87](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/api/runs/[id]/routes/[assignmentId]/route.ts#L68-L87); [apps/web/prisma/schema.prisma:445](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/prisma/schema.prisma#L445).

The legacy DELETE path permits a planner to remove a locked assignment from DISPATCHED or ARCHIVED runs, although the move path rejects the same locked assignment. Associated delivery-proof relations use cascade deletion.

Impact: Historical legacy route integrity can be changed without supervisor unlock. Proof loss is supported by the schema, not an executed database cascade. The current load-based dispatch API guard prevents this path for modern plans.

Proposed fix: Retire legacy mutation endpoints where possible, or enforce run/assignment state under a row-locked transaction and preserve delivery-proof history.

Evidence: Actual unassign and move functions with controlled database boundaries; both closed run states reproduced. lifecycle/lifecycle-probes-results.json.

Acceptance check: Deletion of a locked, dispatched or archived legacy assignment fails and preserves its history; authorized editable legacy deletion still works.

**F15 — Health can report ready while every optimization is misconfigured (Medium)**

Source: [apps/web/app/api/health/route.ts:19–43](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/api/health/route.ts#L19-L43); [apps/web/lib/solver-client.ts:61–66](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/solver-client.ts#L61-L66).

With web SOLVER_TOKEN absent, a reachable database and healthy unauthenticated solver /health produce HTTP 200, ok:true and solver:up. The actual optimization client immediately throws “SOLVER_TOKEN not set”.

Impact: Deployment gating/monitoring can be green during a planning outage. This does not establish that the current production token is missing or wrong.

Proposed fix: Separate liveness from dispatch readiness. Validate required configuration and use a lightweight authenticated solver capability check with a short timeout; do not solve a route during health checks.

Evidence: Current health handler and solver client with healthy external stubs: infra/health_probe_result.json.

Acceptance check: Missing and mismatched tokens fail dispatch readiness; matched healthy configuration succeeds without starting an optimization.

**F16 — All-unserved dispatch plans lose the dispatch Excel export (Low)**

Source: [apps/web/app/t/[slug]/dispatch/plan-view.tsx:345–359](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/t/[slug]/dispatch/plan-view.tsx#L345-L359); [apps/web/app/api/runs/[id]/export/excel/route.ts:67–79](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/api/runs/[id]/export/excel/route.ts#L67-L79).

A valid applied dispatch result can have zero loads because all demand is unserved. The UI hides Excel, and a direct export request selects the legacy generator solely because load count is zero.

Impact: The dispatch reconciliation and assumptions sheets and richer exception reporting are unavailable precisely when exceptions matter most. Basic legacy unserved rows are still retained.

Proposed fix: Use the existing isDispatchPlan discriminator, and allow dispatch Excel for zero-load results. Keep driver-only PDF availability separate.

Evidence: Current UI/API branch inspection, documented in ui/ui-results.json. ExcelJS unavailable; no binary rendering claimed.

Acceptance check: An all-unserved dispatch result exports the dispatch workbook with reconciliation, assumptions and unserved demand.

**F17 — Invalid DMS coordinates are accepted with high confidence (Low)**

Source: [apps/web/lib/dispatch/location-input.ts:57–69](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/location-input.ts#L57-L69); [apps/web/lib/dispatch/location-input.ts:146–149](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/location-input.ts#L146-L149).

23°99'00"N 58°24'00"E has invalid minutes but returns latitude 24.65, longitude 58.4, HIGH confidence and needsPin=false. The bad value normalizes into another valid in-region coordinate.

Impact: A transcription error can move a customer substantially without triggering the expected pin-confirmation workflow.

Proposed fix: Validate minute/second ranges and degree/hemisphere limits before conversion; reject malformed DMS or require manual confirmation.

Evidence: Actual pure parser: intake/probe-intake-results.json.

Acceptance check: Minutes/seconds outside [0,60) are rejected; valid boundary coordinates still parse correctly.

**F18 — Legacy distance-cache hits mislabel estimates as road distances (Low)**

Source: [apps/solver/distance.py:312–316](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/solver/distance.py#L312-L316); [apps/solver/solver.py:523–551](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/solver/solver.py#L523-L551).

A Mapbox failure causes a correctly labeled Haversine estimate. Repeating identical inputs retrieves the same matrices from cache but labels them MAPBOX_MATRIX, losing the fallback reason and estimated flag.

Impact: A legacy /optimize consumer can mistake estimates for road measurements. The current dispatch provider implementation is separate and this finding does not apply to it.

Proposed fix: Cache provider/fallback metadata with matrices, or disable the unused legacy endpoint and remove its unnecessary dependency surface.

Evidence: Actual matrix builder/cache twice with controlled provider failure and identical numeric results: solver/deep_solver_checks.json.

Acceptance check: Cache hits preserve original provider and fallback/estimated metadata.

**F19 — Optional Docker OSRM healthcheck only checks the executable version (Low)**

Source: [infra/osrm/docker-compose.yml:19–23](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/infra/osrm/docker-compose.yml#L19-L23).

The compose healthcheck runs osrm-routed --version. It does not contact the running routing server or test its loaded graph, so a hung server can still satisfy this check.

Impact: False health on the optional Docker-host setup. The documented Railway /nearest healthcheck is unaffected.

Proposed fix: Run a bounded in-region nearest/route query, checking HTTP success and OSRM code=Ok.

Evidence: Configuration inspection only; no Docker daemon or hung service tested.

Acceptance check: Healthy graph passes; unreachable/hung/unloaded routing service fails within the healthcheck deadline.

**F20 — Deleting a driver can race with dispatch and erase the assignment (Medium)**

Source: [apps/web/app/api/drivers/[id]/route.ts:46–65](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/api/drivers/[id]/route.ts#L46-L65); [apps/web/lib/dispatch/plan-service.ts:2055–2075](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/plan-service.ts#L2055-L2075); [apps/web/prisma/schema.prisma:696](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/prisma/schema.prisma#L696).

DELETE reads zero driver references. Before deletion, the dispatcher assigns that still-active driver and dispatches the load successfully. DELETE continues its hard-delete branch, and ON DELETE SET NULL clears the driver from the now-DISPATCHED load. Sequential deletion of an already-used driver correctly deactivates instead.

Impact: A historical driver assignment can disappear despite the load API’s normal immutability protection.

Proposed fix: Prefer deactivating every driver. If hard deletion remains, serialize it with assignment/dispatch and use a restrictive historical foreign key; a separate reference count is insufficient.

Evidence: Actual DELETE and updateLoad functions with the repository fake database and explicitly modeled schema FK action: auth/driver-delete-race-results.json. No live PostgreSQL race.

Acceptance check: Pause deletion after zero references, assign and dispatch, then resume: the driver and dispatched history must survive.

**F21 — A plan read can mix one scenario’s totals with another scenario’s loads (Medium)**

Source: [apps/web/lib/dispatch/plan-detail.ts:233–245](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/plan-detail.ts#L233-L245); [apps/web/lib/dispatch/plan-detail.ts:515–519](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/plan-detail.ts#L515-L519); [apps/web/lib/dispatch/workbook.ts:364–384](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/workbook.ts#L364-L384).

getPlanDetail reads run summary A, then a concurrent chooseScenario atomically applies B before the later load query. The response contains chosen A and totals 12 km / 21 OMR but B’s loads 25 km / 35 OMR, with reconciliation still marked OK. The next ordinary read is consistent.

Impact: The screen or a generated workbook can combine mutually inconsistent plan facts. SUMMARY reads the old summary and LOAD PLAN reads the new loads. No actual XLSX rendering or database concurrency test was performed.

Proposed fix: Build the complete model in a repeatable-read transaction using that transaction client throughout, or validate a revision and retry. Render documents and fetch geometry after the consistent model has been captured.

Evidence: Actual chooseScenario and getPlanDetail with a deterministic interleaving: lifecycle/mixed-read-results.json.

Acceptance check: Switch scenarios during a plan/export read; returned summary, chosen scenario, loads and reconciliation all belong to one revision.

**F22 — Infeasible alternatives receive favorable trade-off labels (Medium)**

Source: [apps/web/lib/dispatch/plan-detail.ts:484–496](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/plan-detail.ts#L484-L496); [apps/web/lib/dispatch/plan-options.ts:170–207](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/plan-options.ts#L170-L207); [apps/web/app/t/[slug]/dispatch/plan-view.tsx:649–650](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/t/[slug]/dispatch/plan-view.tsx#L649-L650).

An OPTIMIZED alternative whose feasibility is VIOLATED enters comparisons because usability ignores feasibility. It can be advertised as serving one more order and costing 20 OMR less; the feasible recommendation then appears to offer no gain against it.

Impact: Decision support rewards an unusable option. A separate violation indicator and dispatch gate remain intact; this is not authorization to dispatch an invalid timetable.

Proposed fix: Require VERIFIED feasibility for positive recommendations and comparison reference options. Keep invalid alternatives available for inspection with an explicit not-comparable explanation.

Evidence: Actual optionTradeoffs and source-extracted usability expression; excluded-invalid control behaves correctly. solver/options_feasibility_check.json.

Acceptance check: A cheaper, higher-service VIOLATED alternative cannot produce a positive recommendation in either app or workbook.

**F23 — Dashboard cost per case is rounded before its declared display precision (Low)**

Source: [apps/web/lib/dashboard.ts:129](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dashboard.ts#L129); [apps/web/app/t/[slug]/page.tsx:108](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/t/[slug]/page.tsx#L108).

900 OMR divided by 20,000 cases is 0.045 OMR/case. Aggregation first rounds to two decimals, producing 0.05; the three-decimal UI displays 0.050.

Impact: Small unit costs lose meaningful precision and comparisons can be misleading. In this example the displayed value is approximately 11% higher than the correct three-decimal figure.

Proposed fix: Keep full precision through aggregation and round once at the explicitly chosen display precision.

Evidence: Actual rollupRows: auth/dashboard-precision-results.json.

Acceptance check: 900/20,000 displays 0.045; aggregate calculations use unrounded totals.

**F24 — Failed inline customer updates can remain visually applied (Medium)**

Source: [apps/web/app/t/[slug]/customers/customers-client.tsx:78–100](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/t/[slug]/customers/customers-client.tsx#L78-L100).

The customer table immediately changes active/priority state. It rolls back a non-OK HTTP response but has no catch for fetch rejection. A request that never reaches the server leaves the customer displayed as inactive while the server still considers it active, without notification.

Impact: An operator can believe a delivery was disabled or its priority changed when nothing was saved.

Proposed fix: Handle rejected requests, show failed/uncertain save state and reconcile with the server. Do not automatically replay an ambiguous mutation that may already have committed.

Evidence: Actual patchRow callback with fetch rejected before sending: ui/gap-results.json. No browser mount.

Acceptance check: A rejected request cannot leave an unqualified success state; ambiguous responses are reconciled safely.

**F25 — Midnight truck availability prevents subsequent form saves (Low)**

Source: [apps/web/app/t/[slug]/trucks/truck-form.tsx:134–155](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/t/[slug]/trucks/truck-form.tsx#L134-L155); [apps/web/lib/dispatch/time.ts:93–111](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/time.ts#L93-L111).

A valid availableToMin 1440 is initialized as “00:00 +1” using a display formatter. The submit parser accepts only HH:MM, so reopening the truck and changing even an unrelated field cannot save until availability is reset.

Impact: Valid master data do not round-trip through the editing form.

Proposed fix: Use a dedicated input formatter and explicit midnight/end-of-day semantics that preserve 1440.

Evidence: Actual format/time helpers and submit callback return “Enter availability as HH:MM” and send no request: ui/gap-results.json.

Acceptance check: Save midnight availability, reopen, change another property, save again and retain 1440.

**F26 — Optional master fields do not have reliable clear semantics (Low)**

Source: [apps/web/app/t/[slug]/drivers/driver-form.tsx:50–58](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/t/[slug]/drivers/driver-form.tsx#L50-L58); [apps/web/lib/schemas.ts:114–128](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/schemas.ts#L114-L128); [apps/web/app/api/regions/[id]/route.ts:11–16](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/app/api/regions/[id]/route.ts#L11-L16).

Clearing a driver phone sends an empty string that schema normalization turns into undefined, so Prisma leaves the old number. Choosing no region depot instead sends an empty string accepted as a foreign-key value rather than null, causing failure instead of removing the link.

Impact: A successful phone save can leave old WhatsApp contact details in use; a region association cannot be reliably cleared.

Proposed fix: Define PATCH absence as unchanged and explicit null as clear. Normalize forms accordingly and separate creation defaults from edit semantics.

Evidence: Current form, schema and Prisma update chain inspected: ui/coverage-gap.md. No live Zod/Prisma/PostgreSQL execution for these two cases.

Acceptance check: Clear an existing driver phone and region depot in schema/database tests; both persist null and subsequent views reflect it.

**Earlier findings still open at the same commit — not new discoveries**

The earlier review and optimization assessment remain applicable because main has not changed. Their proof artifacts are included under `prior-evidence/` in the evidence package.

| Earlier issue | Concrete consequence | Required change |
|---|---|---|
| Frozen depot origin drifts after replan | A copied frozen load can use the child plan’s changed depot location in maps, PDF or WhatsApp. `plan-detail.ts:265–267` reads a plan-wide origin. | Preserve origin per load/version and consume that snapshot consistently. |
| Current split-load manifest kg disagree | Reproduced load/stop weight 300 kg versus manifest 200 kg because rowLines ignores authoritative portion kg. `split.ts:265–271`, `plan-detail.ts:278–282`, `workbook.ts:649,657`. | Allocate manifest kg from the same authoritative portion weights; assert manifest/stop/load sums agree. |
| Frozen overtime is recharged in the repack objective | A new assignment costing 2 OMR can appear about 14 OMR because already-paid overtime is charged again, favoring a 3 OMR alternative. Final displayed accounting can still be correct. `load_repack.py:625`, `dispatch_solver.py:768–769`. | Optimize incremental full-day cost against frozen work consistently. Earlier proof evaluates the objective; it is not a complete CP-SAT execution. |
| Excel timeout cannot interrupt synchronous parsing | Parsing blocks the event loop before the timer can enforce its limit; a 40 ms parser stub passes a 10 ms deadline. `csv.ts:82–86,148–158`. | Move untrusted workbook parsing into a killable worker/process with byte/row/sheet bounds before materializing every sheet. |
| Repack watchdog starts before the first solution | This pass executed the actual watcher with a controlled solver needing 1.5 s for its first incumbent: it stopped around 1.0 s despite a 4 s budget. `load_repack.py:688–704`. | Start no-improvement timing after the first incumbent; use the hard budget before then. Real CP-SAT incidence remains unmeasured. |

**Operational policies that need a business decision**

These are not added to the accidental-bug count. Some are explicitly documented; documentation does not make them operationally harmless.

- **Master-data deactivation is not a dispatch hold.** Actual transition probes accepted inactive truck, assigned driver and customer through LOCKED, LOADING and DISPATCHED with an enforce gate and VERIFIED timing. Preserving historical customer/frozen-driver data is deliberate. Add a separate operational hold for breakdowns, driver unavailability and customer stoppage, blocking new execution while preserving history. A customer-table “inactive” flag must not be assumed to stop an existing plan.
- **Corrected payload can be warning-only.** A locked 6,000 kg load remains VERIFIED after its truck’s live payload is corrected from 10,000 to 3,000 kg under current policy. Preserve the historical snapshot, but decide whether a not-yet-departed physically overloaded load must be blocked. This deserves an explicit NMWC decision before relying on the green gate.
- **The planning clock can age in the queue or on screen.** A previously feasible departure can already be in the past when used. Refresh the planning origin before execution and detect elapsed new departures without rewriting frozen movements.
- **Worker-start failure removes the hard isolation boundary.** `_run_scenarios` falls back to in-process solving if workers cannot start. A controlled worker-construction failure confirmed that path. The handbook explicitly acknowledges no deadlines in this fallback. Production should normally fail with a recoverable unavailable response instead of sacrificing isolation during resource stress.
- **Historical exports can read live/shared values.** Earlier probes showed old load/stop/manifest kg changing from 400/400/400 to 400/600/600 after later reweighting. Define which fields must be immutable evidence and snapshot them. Live contact information is a separate deliberate choice.
- **Capacity and scheduling are incomplete representations of the operation.** Case/kg checks do not establish pallet-space fit, customer vehicle access, depot dock/forklift capacity, driver/helper staffing, breaks, stock/credit eligibility, collections/returns or actual return times. Implement only the constraints the operation needs, but explicitly name every assumption.
- **Receiving-window meaning must be agreed.** Current hard windows constrain service start, not finish. A 09:59 start with 30 minutes of unloading can satisfy a 10:00 closing boundary. Split visits proportionally share fixed service time, though real queue/paperwork time may recur.
- **Shortage priorities and costs need sign-off.** Highest branch priority can apply to its aggregated demand; stop count, completed invoices, cases and margin are different goals. Allocated truck/driver cost is not necessarily avoidable cash expenditure. P1 early-arrival preference is conditional on preferred-window settings, as documented.

**Is the solver optimal, and how should it improve?**

No global optimality claim is justified by this review. Feasibility checking validates the represented rules; it does not prove that no cheaper or better-service plan exists. CP-SAT can at best certify its restricted load pool and objective. Its second-phase optimum does not certify maximum service if the first phase only found a feasible incumbent. The whole pipeline includes heuristic route discovery, approximated loading, restricted repair and timing optimization conditional on chosen routes.

The new weight-encoding defect demonstrates a feasible route missing from that search space. Previously identified improvement opportunities remain: align MIN_TRUCKS with physical truck count, fix incremental frozen cost, combine promising loads across scenarios, repair by inserting/exchanging customers rather than only adding singleton trips, and measure search quality over time. Initial finite priority penalties are not mathematically dominant over every accepted cost configuration; the final candidate selector can mitigate that, but no full default-run priority failure was demonstrated here.

An equivalent competitor benchmark has still not been executed. The repository’s legacy PyVRP endpoint omits key current kg/frozen/multi-trip semantics, so comparing those endpoints directly would not isolate solver quality. Use exact small cases to certify the full intended model where possible, then identical matrices/rules/budgets for common-feature comparisons. Run the five 320–450-invoice synthetic days plus anonymized real NMWC days, validate outputs independently and compare service by priority before cost. Record dependency versions, seeds where supported, hardware, phase status, runtime, raw output and input/matrix hashes. Report best-known gaps as empirical comparisons unless a valid lower bound for the same full problem exists. No percentage improvement is promised without measurements.

**Tests, operations and maintainability worth improving**

1. **Replace reassuring test names with real assertions.** `apps/web/tests/tenant-isolation.spec.ts:95–99` expands eight `expect(true).toBe(true)` placeholder cases. Its “foreign depot cannot be linked” test checks visibility but never attempts the forbidden link. This does not invalidate the real isolation tests elsewhere; it means the test count overstates this particular coverage.
2. **Add a small behavior-focused browser/component suite.** Existing dispatch-screen tests acknowledge static source guards. Cover delayed location replies, failed optimistic writes, customer corrections, all-unserved export and foreign-company context. The bugs above depend on interactions source-string tests cannot establish.
3. **Run real concurrency and fault tests.** Use disposable PostgreSQL barriers for reset retirement, last-admin preservation, driver deletion, verified pins and scenario reads. Add interrupted janitor recovery. The supplied deterministic probes identify the missing conditions; they are not substitutes for database isolation/FK tests.
4. **Make builds and comparisons reproducible.** Python solver dependencies resolve from ranges and a moving base image. Pin a transitive lock/image digest and capture exact engine versions in benchmark artifacts. CI currently exercises fresh PostgreSQL 16 while the runbook describes production 18; add a representative upgrade fixture on the production major, not just a clean schema.
5. **Measure actual daily behavior.** Track queue age, recovery mismatches, solve timeouts, matrix fallbacks, readiness failures, unserved reasons, timing-gate refusals and warehouse-versus-planned times. Source review cannot verify backup success or restore time; a disposable restore drill can.
6. **Make master edits robust.** Several forms submit their entire stale initial record without expected-version checks. Prefer changed-field updates plus revision/expected-value protection. Bulk master import partial failure and case-insensitive creation races also merit database tests; no additional full database reproduction was claimed here.
7. **Remove obsolete surfaces carefully.** Legacy driver endpoints are retired with 410 responses and browser token cleanup; do not reactivate old helper code without a fresh design review. Retire unnecessary legacy solver/mutation paths, or maintain equivalent input/admission and history protections. The broader internal endpoint hardening notes are not demonstrated unauthenticated solver execution.
8. **Correct smaller reporting language.** The dashboard’s “Week to date” is a rolling seven-day range, and its old “time windows not enforced in v1” text no longer describes current planning. Define whether utilization is capacity-weighted or an equal-weight average of depot/day percentages. OMR unit-cost precision has its own confirmed finding above.

**What looked sound in the inspected paths**

The shared intake lock and existence recheck dismissed the suspected order-delete/plan-start race. Durable intake keys and quantity reconciliation are meaningful safeguards. Two hundred deterministic randomized split cases preserved integer quantities, physical capacity and rounded part weights; explicit reconciliation cases rejected wrong branches, balanced cross-line corruption, unknown lines, duplicate whole orders, removed expected orders and missing unserved reasons. These are bounded positive checks, not universal proofs.

The current map has substantive stale-shape/fingerprint handling and estimated-route captions. Inspected popups use text APIs and workbook values are written as strings/numbers; no new map XSS or formula-injection path was confirmed there. No new anonymous authentication bypass, ordinary-user cross-tenant exfiltration or destructive current migration was demonstrated. Snapshotting, frozen-plan mutation guards and fresh transition gates are substantially stronger than the earlier versions. Their remaining edge cases should be repaired within that structure rather than used as a reason to discard the application.

**Recommended implementation sequence**

1. Schedule the supported-framework upgrade and close wrong-company mutation controls. Fix urgent-input loss, verified-pin races, cross-customer preview state, depot ownership and driver-delete history.
2. Repair job recovery and account invariants. Make plan/export reads consistent and reject misleading infeasible-option recommendations.
3. Fix integer weight units, current manifest reconciliation, frozen origin/cost handling and workbook parsing isolation. Add the corresponding narrow regressions.
4. Approve dispatch-hold, payload-correction and planning-clock policies. Calibrate NMWC handling times, physical capacities and windows before treating solver output as operational authority.
5. Run the complete current-head suites, the real database/browser regressions and end-to-end 320–450-invoice days. Then measure search improvements and equivalent solver challengers.

My release recommendation is supervised use with independent warehouse payload/timing checks while the priority defects are addressed. The code is useful and worth improving; the present evidence does not support unattended dispatch, exhaustive correctness or globally optimal output.

**Sources and evidence guide**

- All code links above are pinned to the reviewed commit. Agent reports in the evidence ZIP retain more detailed source ranges and exact review coverage.
- [Next.js maintainer advisory, CVE-2026-23864](https://github.com/vercel/next.js/security/advisories/GHSA-h25m-26qc-wcjf), [vendor clarification](https://vercel.com/changelog/summary-of-cve-2026-23864), and [official support policy](https://nextjs.org/support-policy), checked 27 September 2026. This is the external basis for F01, not evidence of an exploited RouteIQ deployment.
- `source_inventory.json` records all 488 tracked blobs; `coverage_register.json` identifies inspected paths and evidence lanes without representing static review as runtime coverage.
- `ci_evidence.json` preserves inspected same-head remote CI excerpts. Probe scripts/results state their synthetic boundaries and prerequisites. `README.md` in the ZIP explains reproduction and evidence levels.
- The separate JSON finding register provides IDs, severity, source links, scenarios, fixes and acceptance checks for task tracking. Earlier findings and documented policy risks are intentionally outside its new-finding count.
