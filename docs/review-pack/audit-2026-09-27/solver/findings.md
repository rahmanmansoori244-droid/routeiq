# Solver audit — 27 September 2026

Source: RouteIQ `83d8174836deb339d54f90e65b803550ed34c20d`.

This pass read the complete production solver modules and the dispatch wire contract, with targeted tests and specification comparisons. It did **not** execute OR-Tools routing, CP-SAT, GLOP, PyVRP, HTTP requests or database workflows. `deep_solver_checks.py` executes actual pure code and clearly identified recorder boundaries. All five probes passed; their results are in `deep_solver_checks.json`.

## S1 — Fractional weights create false capacity shortages

**Severity: Medium. New confirmed model defect; deterministic constraint proof.**

- `apps/solver/dispatch_solver.py:712–716`: each stop's kilograms are rounded **up to a whole kilogram**, while each truck's payload is rounded down.
- `apps/solver/load_repack.py:860–864`: repair preserves the existing loads and adds unserved stops only as separate singleton loads. It does not merge them into an existing load.
- `apps/solver/load_repack.py:578`: the truck's trip limit remains binding.

Failure scenario: one truck has a 3,000 kg payload, 300-case capacity and one available trip. Three nearby customers require 100 cases each, weighing **999.1 + 999.1 + 1,001.8 = 3,000.0 kg**. The routing capacity dimension sees **1,000 + 1,000 + 1,002 = 3,002 kg**, making the valid combined route impossible within that model. Any initial route can cover at most two of these stops. Its repair pool is an existing pair and a singleton; carrying both requires two trips, so repair cannot recover all three on the one-trip truck. Increasing the search time cannot make the excluded combined route feasible in the model.

Proof: executed the actual capacity conversion AST against a recorder; built a hand-constructed three-stop route and passed it through actual `_build_scenario` and independent feasibility (`VERIFIED`); captured the actual repair pool for all three possible customer pairs. No optimizer output is fabricated or claimed.

Fix: define one weight resolution (for example integer grams), normalize consistently, then use the same values in splitting, routing, repacking and feasibility checks. Avoid silently adding one kilogram of padding per fractional stop. If a safety margin is desired, make it a separate documented truck-level setting.

Regression: this day must serve all 300 cases in one load. Include a just-over-capacity control to prevent rounding fixes from permitting overloads.

## S2 — A process-creation failure removes solver isolation and hard deadlines

**Severity: Medium, operational resilience. Confirmed exception-path behavior.**

- `apps/solver/dispatch_solver.py:1417–1436`: when `_Workers(...)` raises, the exception is logged and the recommendation runs directly via `_scenario_worker(job)` in the API process.
- `apps/solver/dispatch_solver.py:1471–1489`: the same in-process fallback can run alternatives/post-processing; replacement-pool creation after a timeout also falls back.
- `apps/solver/main.py:60–70` and `dispatch_solver.py:1399–1406` explain why process isolation exists: searches can hold the GIL or ignore their own time limit.

Failure scenario: an OS/resource error prevents worker creation during a busy period. Even with `SOLVER_PARALLEL=1`, the request begins the expensive solve inside the server process instead of retaining the enforced worker deadline. That removes the very protection needed during resource stress and can affect health requests and other tenants.

Proof: ran actual `_run_scenarios` with a controlled worker-construction `OSError`, recording the solver boundary instead of running it. The solver boundary executed in the caller's same process/thread. No server hang or production incident was induced.

Fix: production should fail promptly with a recoverable busy/unavailable response when isolation cannot start. Keep an explicit development-only in-process mode. Ensure partial worker setup is cleaned up.

## S3 — The stall watchdog cancels before a first feasible solution

**Severity: Medium quality/reliability issue. Confirmed stopping behavior; no measured production incidence.**

- `apps/solver/load_repack.py:688–704`: the last-progress clock starts when the callback object is constructed, and the watcher stops search after `max(1, limit/4)` seconds, regardless of whether a first solution has been found.
- `apps/solver/load_repack.py:653–668`: this watcher controls both the service and cost phases of load repacking.

Failure scenario: a nominal four-second CP-SAT budget needs 1.5 seconds for presolve/first feasible incumbent. The watcher cancels after approximately one second. On larger repair pools, the stage can abandon a solvable model before it has any plan to improve, retaining an inferior raw plan or losing a potential repair.

Proof: executed the actual watcher and threading logic with a bounded fake solver that would emit its first solution at 1.5 seconds. With the real four-second budget rule it was stopped at **1.002 seconds**, before the first callback. This proves the stopping rule, not how often real CP-SAT exhibits this delay.

Fix: start the no-improvement clock after the first incumbent. Before then, retain the configured hard time limit (or an explicit separately measured first-solution budget). Preserve the best incumbent between service and cost phases if the second phase expires.

## S4 — Legacy matrix cache relabels estimates as road distances

**Severity: Low in the current application, because the web no longer calls the legacy endpoint. Confirmed latent API defect.**

- `apps/solver/distance.py:312–316`: a cache hit reconstructs `provider_used` from the requested provider rather than the provider that produced the cached matrix.
- `apps/solver/distance.py:337–339,361–366`: fallback matrices are stored without their provenance.
- `apps/solver/solver.py:523–551`: `distance_is_estimated` is derived from that metadata.

Failure scenario: the legacy `/optimize` caller requests Mapbox, but it fails. The first answer correctly uses Haversine and marks the estimate. A retry with the same inputs hits the cache, gets the exact same Haversine matrix, but reports `MAPBOX_MATRIX` and no fallback reason. The legacy solver then marks the distance as not estimated.

Proof: actual `build_matrices` and cache were executed twice, with only the remote provider call replaced by a controlled failure. First metadata: `HAVERSINE`, fallback reason. Second metadata: `MAPBOX_MATRIX`, cached true, identical numeric matrices.

Fix: cache provenance together with both matrices and return the preserved metadata. If the legacy endpoint is retired, delete/disable it and its unused dependency surface instead. This finding does not apply to the active dispatch `providers.py` path, whose provenance fixes were verified previously.

## Documented choices and other points worth retaining in the report

1. **P1/P2 early delivery is conditional.** When a preferred end time exists and its penalty is enabled, early-arrival cost applies only after that end time. A P1 stop with preferred hours 06:00–12:00 has zero time-preference cost at both 06:00 and 11:00. The same stop without preferred hours receives approximately 3.06 OMR-equivalent at 11:00 (integer coefficient rounding). This is explicitly described at handbook lines 1444–1446 and 1514, so it is a documented policy/approximation, not a newly discovered bug. The high-level design wording should remain clear about the exception.
2. **“Strict priorities” are not mathematically lexicographic inside the initial routing objective.** The one-priority-unit advantage is normally 1,000 OMR. Accepted web bounds allow fixed cost 100,000 OMR, trip cost 10,000 OMR, distance cost 1,000 OMR/km and preferred-window penalty 100 OMR/min. Such settings can reverse routing's intended service-before-cost ordering. The final candidate selector prioritizes service, and an alternative may repair this; no complete default three-scenario failure was reproduced. A true lexicographic initial solve, or bounds derived from the maximum possible operating/preference cost, would make the promise defensible.
3. **Previously confirmed items remain:** frozen overtime is recharged in the repack objective (`load_repack.py:619–626`), MIN_TRUCKS searches weighted monetary costs instead of directly minimizing physical truck count, and the 80%-full loading approximation constrains discovery. The current review does not imply these were fixed.
4. **Contract hardening:** depot/truck/frozen intervals lack comprehensive Pydantic cross-field checks; truck/frozen-trip/scenario-list lengths are uncapped. The current web supplies more constrained values, so these are API hardening points rather than proven web incidents. Authentication is checked after body validation; only the dispatch endpoint has solver admission.
5. **Legacy comparison limits:** the PyVRP endpoint ignores kg capacity, lacks the dispatch day/frozen/multi-trip contract and has a different objective. It cannot currently serve as an equivalent competitor benchmark.

## Coverage

Complete implementation files read:

- `apps/solver/dispatch_solver.py`
- `apps/solver/load_repack.py`
- `apps/solver/feasibility.py`
- `apps/solver/costing.py`
- `apps/solver/providers.py`
- `apps/solver/dispatch_models.py`
- `apps/solver/main.py`
- `apps/solver/solver.py`
- `apps/solver/models.py`
- `apps/solver/distance.py`
- `packages/shared-types/src/dispatch.ts`
- `packages/shared-types/src/planner-bounds.json`

Specification/reachability checks: handbook sections 7.3/7.4 and relevant optimizer explanation; complete `docs/OPTIMIZER_DESIGN.md`; targeted `plan-service.ts`, truck/schema constraints and truck form; searches/read ranges in solver dispatch/repack tests. No claim was made to run full suites, compare competing engines, or verify production settings.
