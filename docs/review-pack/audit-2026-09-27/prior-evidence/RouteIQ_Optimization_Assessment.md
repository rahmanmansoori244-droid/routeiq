# RouteIQ: optimization quality, alternatives and missing operational rules

27 September 2026 · Source reviewed: [`83d8174`](https://github.com/rahmanmansoori244-droid/routeiq/commit/83d8174836deb339d54f90e65b803550ed34c20d)

## Direct answers

**Did I check everything?** No. The previous review retrieved and verified all 488 source files and examined important logic, lifecycle, intake, security, costing and scheduling paths. Retrieval coverage and passing tests do not establish exhaustive path coverage. This follow-up inspected the solver's search space, objectives and operational assumptions and researched current primary documentation for alternatives.

**Did I run an equivalent competitor benchmark?** No. Neither this review nor the tracked repository provides an executed, equivalent current-version comparison across RouteIQ, PyVRP, VROOM and managed services on the same NMWC problems. The repository has a useful feature comparison and internal historical benchmarks. Those are different kinds of evidence.

**Is it producing the optimum?** It may occasionally find an optimal plan, but the evidence does not establish global optimality or a reliable distance from the optimum for current NMWC days.

**Can it improve?** Yes. There are specific search and modeling improvements worth testing before a full engine replacement. Their percentage benefit remains unmeasured.

**What matters most?** Correct business inputs and constraints, consistent optimization objectives, then a reproducible measurement of solution quality. An optimum for an incomplete model can still be unusable in the warehouse.

## What the optimizer actually proves

[dispatch_solver.py:44–48](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/solver/dispatch_solver.py#L44-L48) explicitly declines to claim a proven optimum. Its stages are:

| Stage | Work performed | What success establishes |
|---|---|---|
| OR-Tools routing | Builds and improves customer sequences under a time limit | A found solution, potentially improvable |
| CP-SAT repacking | Reassigns a restricted pool of existing load sequences to trucks/times | At best, an optimum for that restricted model and objective |
| Linear timing optimization | Adjusts times for already chosen routes and truck assignments | Timing optimality conditional on those choices |
| Feasibility checks | Checks the timetable against represented hard rules | Compliance with those rules, not that another cheaper/better plan is impossible |

Google's [OR-Tools routing documentation](https://developers.google.com/optimization/routing) similarly explains that large routing problems can return good solutions without proving optimality.

A further qualification: [load_repack.py:649–677](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/solver/load_repack.py#L649-L677) accepts FEASIBLE in its first service-maximization phase, preserves that achieved service floor, then minimizes cost. An OPTIMAL second phase does not establish maximum possible service, even within the restricted load pool, if phase one did not prove its optimum. A reported repack gap is not the global routing gap.

## Practical improvements to the current engine

1. **Combine good loads across scenarios.** [load_repack.py:859–876](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/solver/load_repack.py#L859-L876) repacks each scenario's loads separately. Pool and deduplicate load sequences from all searches, then choose a compatible combination with exactly-once coverage. This could exploit a good morning load from one scenario and a good afternoon load from another. Retain the current plan as a fallback and measure memory/runtime.
2. **Repair routes at customer level.** Current post-processing adds dropped stops mainly as one-stop loads. Add insertion into existing loads, exchanges between loads and route reordering with exact timing. A spare trip should not be the only way to recover a nearby unserved customer. These proposals extend post-processing; the original OR-Tools search already has customer-level moves.
3. **Align search objectives with the option labels.** MIN_TRUCKS search uses monetary fixed costs multiplied by 20, while final selection ranks physical truck count before cost. With different truck prices, those preferences can disagree. A source-derived arithmetic example gives a one-truck plan a weighted search cost of 2,010 and a two-truck plan 50, while the final selector prefers the one-truck plan if both are found. This is an objective mismatch, not an observed full-optimizer failure. See [scenario weights](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/solver/dispatch_solver.py#L173-L175) and [selection goals](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/solver/dispatch_solver.py#L1525-L1535). Also fix the frozen-overtime inconsistency from the preceding review.
4. **Reduce the loading approximation.** Initial search assumes an 80%-full truck for loading time. Exact later checks protect feasibility but cannot necessarily recover useful routes excluded by that approximation. Try load-aware repair or iterative feedback from exact timing.
5. **Measure stopping and diversity.** CP-SAT stops after no incumbent callback for a quarter of its allowance, with the clock starting before a first solution. Alternatives commonly start from RECOMMENDED and receive half its budget. Compare these policies with independent starts and longer searches; more time is useful evidence, not a guarantee. Record score over time and both service/cost phase statuses.
6. **Make quality auditable.** Store the exact engine/library version, matrix/input hashes, objective components, elapsed phase times, hardware limits and candidate provenance. Expose “best found under this budget.” Keep feasibility, comparative quality and mathematical certificates as separate fields.

## Alternatives worth comparing

These are capability-based recommendations. No ranking of NMWC route quality has been measured.

| Alternative | Reason to test | Work required for a fair comparison |
|---|---|---|
| **PyVRP — first challenger** | Current stable 0.14.0 documents mixed fleets, time windows, multiple capacity dimensions and native depot reloads/multiple trips. | Adapt frozen work, invoice portions, priority hierarchy, preferences and whole-day costs. Do not merely call the legacy endpoint. |
| **VROOM — speed baseline** | Supports capacity dimensions, skills, breaks, windows and custom matrices. | Preserve physical multi-trip truck chaining. Its travel-time costing differs from RouteIQ's paid duty-span policy. Unsupported constraints must be declared. |
| **Google Route Optimization API — managed comparator** | Provides custom matrices, capacity dimensions, time windows, breaks, vehicle costs and previous-route inputs. | Check equivalent multi-trip and frozen-work semantics; evaluate provider costs and local road quality separately. |
| **Timefold Solver — custom-model option** | Useful when complex staffing/resource constraints dominate; its benchmarker supports repeated runs and score-over-time analysis. | A larger Java/Kotlin model integration. The packaged field-service model is not a ready beverage-distribution replacement. |

Primary sources: [PyVRP features](https://pyvrp.readthedocs.io/en/stable/), [reloads](https://pyvrp.readthedocs.io/en/stable/notebooks/reloading.html), [VROOM API](https://github.com/VROOM-Project/vroom/blob/master/docs/API.md), [Google parameter model](https://developers.google.com/maps/documentation/route-optimization/parameter-list), [Timefold benchmarker](https://docs.timefold.ai/timefold-solver/latest/running-timefold-solver/benchmarking-and-tweaking).

The [PyVRP benchmark table](https://pyvrp.readthedocs.io/en/stable/setup/benchmarks.html) reports gaps to best-known solutions over repeated seeds; its 0.14.0 results include 0.65% for time-window instances and 0.58% for multi-trip/reload instances. These are published results on that benchmark setup, not mathematical certificates, expected NMWC savings or a measured advantage over RouteIQ. The older OR-Tools row on that page is not a current RouteIQ comparison.

RouteIQ already contains a legacy PyVRP `/optimize` endpoint, but it does not implement the dispatch endpoint's equivalent reload and priority model. Its pinned PyVRP version is below 0.14. Comparing the two endpoints directly would mix algorithm differences with different rules. See [requirements.txt](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/solver/requirements.txt) and [benchmark notes](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/docs/OPTIMIZER_BENCHMARK.md#L82-L86).

## NMWC assumptions needing explicit decisions

These are predominantly scope and policy choices, not additional accidental code defects. Implement them only where the real operation requires them.

| Question | Current behavior | Why it matters |
|---|---|---|
| Do kg and cases describe physical fit? | Pallet, bay and volume constraints are not sent to the dispatch solver; customer access notes are not truck-eligibility constraints. | Mixed SKU loads can fit by weight yet exceed pallet space. Some customers may need smaller vehicles. Truck-count recommendations are provisional for fleet decisions. |
| Can the depot load every scheduled truck simultaneously? | Loading time is constrained per truck; no shared dock/forklift/loading-team capacity. | Eight individually feasible departures may require more warehouse resources than are available. |
| Are drivers/helpers available at those times? | Routes are optimized before driver assignment; hand-set driver clashes warn. Driver breaks/crew rosters are not solver constraints. | A feasible truck schedule can be unstaffable. |
| Must unloading start or finish before closing? | Hard windows constrain service start. Split visits share the customer's fixed service time proportionally. | A 09:59 start plus 30 minutes unloading passes a 10:00 end window. Paperwork/queue time may repeat on each split visit. |
| Are all invoices eligible and in stock? | The routing request contains aggregate demand, not SKU stock, credit approval or hold rules; cancellation/amendment is restricted. | Define which ERP/intake control guarantees that demand is available and authorised. Add no-split or all-or-nothing rules where needed. |
| What does “serve the most important work” mean? | Priority is per aggregated/split stop; highest priority at a branch applies to its combined demand. One higher-priority stop outweighs all lower-priority stops under the strict policy. | This differs from maximizing complete invoices, cases, customers or margin. Approve shortage scenarios explicitly. |
| What costs can actually be avoided? | Used-truck fixed costs and driver duty-span costs influence choices; first loading before departure is excluded from paid time. | Allocated lease/salary savings are not necessarily cash savings. Define reporting costs separately from avoidable dispatch costs if necessary. |
| How does execution feed the next plan? | Frozen work uses planned return times; no delivery/pickup load model for returns/empty pallets and no complete actual-delivery feedback integration. | Late returns, failed deliveries and collections can change available time and capacity. |
| Is the planning scope really one depot/day? | One-depot, one-day optimization with multiple trips. | Cross-depot vehicle sharing and next-day backlog need an outer allocation model if NMWC permits them. |

Evidence: [request contracts](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/solver/dispatch_models.py#L38-L93); [truck inputs](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/plan-service.ts#L562-L580); [per-truck overlap constraints](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/solver/load_repack.py#L568-L582); [driver assignment policy](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/load-state.ts#L199-L218); [window bounds](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/solver/dispatch_solver.py#L727-L731); [split service time](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/service-time.ts#L25-L39); [priority aggregation](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/web/lib/dispatch/plan-service.ts#L400-L405); [cost policy](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/apps/solver/costing.py#L11-L18); [documented limitations](https://github.com/rahmanmansoori244-droid/routeiq/blob/83d8174836deb339d54f90e65b803550ed34c20d/docs/PROJECT_HANDBOOK.md#L2280-L2296).

Calibration comes first: the handbook records estimated weights, uncalibrated payload/windows/handling times, static car-based road times and observed truck cycles materially longer than defaults. Stress-test travel and service times at +10%, +20% and +30% as sensitivity scenarios, not as measured probability distributions. Compare those stresses with actual GPS and dispatch records when available.

## A defensible benchmark

1. **Exact small cases:** independently solve 6–12-stop instances including route order, vehicle assignment, reloads and windows. Accept an exact optimum only when the full intended model is certified. On timeout, report bounds or unknown; do not call the incumbent optimal.
2. **Common-feature comparison:** run RouteIQ, PyVRP and VROOM on a deliberately shared feature subset, with identical asymmetric matrices, units, service times and costs. Keep this separate from the full NMWC comparison.
3. **Full operation:** use the five 320–450-invoice synthetic days plus 20–30 anonymized real days when available, holding some out from tuning. Preserve frozen work, physical truck identity, invoices and loading rules. Mark any competitor that cannot represent a required rule as not comparable.
4. **Budget curves and repeats:** start with equal 30/150/300-second solve budgets and controlled CPU/thread limits. Use at least three acceptance repetitions and ten for comparative claims; vary seeds only where exposed and record them. A separate longer offline reference can use 900 seconds, without altering production timeouts. Managed services form a separate latency/cost comparison because their hardware is not controlled.
5. **Independent validation first:** reject infeasible or unreconciled output. Compare achieved service by priority before comparing cost; cheaper output that drops more required work has not won.
6. **Publish reproducible evidence:** inputs, hashes, matrices, dependency versions, raw output, independent checks, best/median/worst costs and runtimes. Record invoice fill, case fill, physical trucks, trips, km, OMR, preferences, overtime, window slack and reassignment disruption. Compare with the dispatcher's plan as well as other engines.

“Gap to best known” is an empirical comparison. It becomes a certified optimality gap only with a valid lower bound for the same full model/objective. For multiple objectives, compare the primary service tier before secondary costs.

The repository does mention a historical 473.9 OMR lower bound and a separate 527.6 best offline objective. Their derivation is not in tracked source and the bound appears alongside fixed-load reassignment. This review cannot certify it as a bound for unrestricted current routing or reuse it after costing changes. It should be reproduced and scoped, not ignored or presented as a global certificate.

The historical 300-stop benchmark also uses Haversine and no kg dimension. Switching to a road matrix changes numerical feasibility and search difficulty even when matrix dimensions stay the same; the benchmark's assertion that solve time cannot change is too strong.

## Recommended order

Resolve the previously reproduced safety/output defects and approve the business objective. Calibrate physical limits and handling times. Establish exact small tests and independent large-day checks. Test pooled loads, route repair and aligned MIN_TRUCKS/overtime objectives against the current engine. Then add an equivalent PyVRP challenger and decide from measured results whether replacement is worthwhile.

This preserves RouteIQ's useful intake, versioning and dispatch workflows while making the engine's quality measurable. No code or production changes, full solver reruns or competitor executions were performed in this follow-up.
