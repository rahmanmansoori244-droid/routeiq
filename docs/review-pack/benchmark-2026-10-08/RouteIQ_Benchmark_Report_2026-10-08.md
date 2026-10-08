# RouteIQ — Simulation and Optimization Benchmark Report

**Report date:** 8 October 2026 (Asia/Dubai)
**Reviewed commit:** `5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b`
**Repository:** https://github.com/rahmanmansoori244-droid/routeiq

Markdown edition of the complete 12-page benchmark report. Findings refer to the reviewed commit and the recorded tests.

## 1. What the tests establish

**RouteIQ can produce useful, feasible plans at the requested 300+ invoice scale. It is not yet supported by evidence for an unrestricted autonomous launch.** Tests found avoidable missed service after retiming and upstream packing/rental limitations. A tight-window case failed at a shortened budget but recovered at its native budget. Positive results and counterexamples are both retained.

| Evidence | Observed result | Meaning |
| --- | --- | --- |
| Independent exact reference | 28 / 28 matched the proven optimum | Strong evidence for the specified small fixed-stop formulations. |
| Normal and wholesale days | All 360 and 420 invoices served in each of four runs per day | Useful large-day performance; hybrid reduced cash and full objective. |
| Tight receiving windows | 60 s: four invalid answers. Native 150 s: all 340 invoices served, VERIFIED | Budget-sensitive reliability; not a default-budget failure in this test. |
| Frozen replan D5 — major finding | Native 110 s: only 158/320 pending invoices planned | A validated full-service plan exists. Three P1 and twenty P2 stops are avoidably omitted. |
| Pipeline late VIP / frozen work | 54 cases across 3 invoices avoidably unserved | Separate native-budget, two-core reproduction with a full-service witness. |
| Public reference problems | Matched R108 BKS; weaker on three capacity-only cases | Integration quality varies by formulation and numerical scale. |
| Quick versus Thorough | Cash improved 1.63%; full objective worsened 0.248% | Longer search did not guarantee a better final recommendation. |

### Launch judgement

**Sunday 11 October: no unattended-dispatch sign-off.** The native frozen-replan service failure is a blocker for that mode. A supervised pilot is conditional on a successful real operational rehearsal and manual approval of omitted work and route exceptions. Fix the missed-service repair gaps and replay the saved cases before relying on automatic replanning.

For a one-person project, the combination of invoice accounting, frozen work, multiple trips, exact retiming and alternative search is substantial. The strongest next investment is closing the demonstrated integration gaps and collecting real operating evidence.

Pinned source: 5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b (PR #63). Main was rechecked unchanged during this task. Source snapshot: 833 tracked files hash-verified. No production system or real customer data was used; no product source was edited. All monetary results are model OMR, not measured financial savings.

## 2. Scope and fair comparison

| Synthetic operating day | Invoices | Stops | Cases | Fleet |
| --- | --- | --- | --- | --- |
| D1 normal | 360 | 220 | 9,526 | 12 |
| D2 wholesale surge | 420 | 230 | 27,448 | 14 |
| D3 tight receiving | 340 | 200 | 8,393 | 12 |
| D4 fleet shortage | 360 | 220 | 15,534 | 5 |
| D5 late frozen | 320 | 180 | 4,826 | 12 |

Five complete synthetic days use mixed SKU pallet factors, customer receiving windows, loading/reloading, multiple trips, driver breaks and return limits. D5 replans pending orders around six earlier frozen trips. Invoice counts and destination counts are different: several invoices can share one delivery stop.

**Large-day comparison:** 20 actual production-worker runs: five days × hybrid ON/OFF × two seeds/repeats. Each receives 60 seconds of primary search, 240 seconds overall and the same four-core affinity ceiling. This is an explicit benchmark budget, below the normal 150-second primary allowance at 200+ stops. Native-budget followups are separate.

ON adds PyVRP to the existing OR-Tools/postprocessing pipeline. OFF is an ablation of RouteIQ, not a separately tuned competitor. Seeds 17 and 29 seed PyVRP; OFF labels are repeat runs because its OR-Tools path does not expose that seed. The same wall allowance does not imply equal CPU work. Two repeats do not support confidence intervals or broad performance guarantees.

**Realism limits:** locations and all orders are fictional. Travel uses straight-line distance × 1.3 and 35 km/h, not road directions or live traffic. Pallet limits are active; kg capacity is intentionally disabled in large-day fixtures, matching the reviewed configuration. Legal payload, axle/stacking constraints, actual receiving access and delivery execution are untested. D2 deliberately assumes stock/backlog above normal daily production. Stock availability is not modeled.

**Separate pipeline lane:** real intake, builder, solver, persistence, scenario application and reconciliation functions run against a fake database adapter. This tests more than a solver request, but does not establish PostgreSQL transactions, concurrent edits, browser upload or mobile operation.

Environment: Python 3.12.14, OR-Tools 9.15.6755, PyVRP 0.14.0; Linux shared host, 8-CPU quota, 8 GiB RAM. Suites use disjoint affinity sets where practical. Timing is illustrative, not a production latency SLA. Complete settings and actual elapsed times are retained per run.

## 3. Large-day results

| Day / repeat | OFF → ON cash OMR | Full-objective change | Service / validity |
| --- | --- | --- | --- |
| D1 / 17 | 496.20 → 452.36 | -9.45% | 220 → 220 stops; valid |
| D1 / 29 | 529.45 → 456.67 | -11.65% | 220 → 220 stops; valid |
| D2 / 17 | 925.97 → 864.74 | -6.50% | 230 → 230 stops; valid |
| D2 / 29 | 925.97 → 855.61 | -7.93% | 230 → 230 stops; valid |
| D3 / 17 | Excluded: invalid | Not comparable | 200 → 200 stops; VIOLATED |
| D3 / 29 | Excluded: invalid | Not comparable | 200 → 200 stops; VIOLATED |
| D4 / 17 | 390.15 → 390.15 | -2.04% | 139 → 139 stops; valid |
| D4 / 29 | 390.15 → 390.15 | +0.01% | 139 → 139 stops; valid |
| D5 / 17 | 499.99 → 499.99 | +0.00% | 175 → 175 stops; valid |
| D5 / 29 | 501.64 → 384.74 | Not comparable | 176 → 175 stops; valid |

All 20 measured runs took 74.04–76.09 seconds end to end. Compare feasibility first, then P1-to-P5 service counts, then cash plus time/arrival/continuity preferences. A cheaper plan that misses additional high-priority work is not an improvement.

**D1 normal:** all 360 invoices, 220 stops and 9,526 cases served. Hybrid reduced cash by 8.83% and 13.75%, and the full objective by 9.45% and 11.65%. The independent simple greedy reference also served all work but used 672.007 OMR and 986.52 km. This is an algorithmic reference, not an actual dispatcher baseline or demonstrated company saving.

**D2 wholesale:** all 420 invoices, 230 stops and 27,448 cases served. Hybrid reduced cash by 6.61% and 7.60%; full objective fell 6.50% and 7.93%. Its greedy reference omitted work, so comparing its total cash as an equal-service saving would be misleading.

**D4 shortage:** demand is 158.761 pallet equivalents against 120 pallets of total trip capacity. Full service is impossible under this fleet/trip ceiling. The observed service vector [44,44,44,5,2] serves every P1–P3 stop. This is sensible priority behavior, but does not prove the best possible P4/P5 selection.

**D5 frozen replan:** stock outputs serve 175–176/180 stops and miss 2–4 P2 stops. An independently validated greedy witness serves all 180 stops, 320 invoices and 4,826 cases for 518.113 OMR. Thus missed service is avoidable in these 60-second runs. In repeat 29, hybrid gains two P2 stops but loses three P5 stops versus OFF; that is a strict-priority improvement, not an equal-work cost saving.

D5 costs cover remaining work only; already incurred frozen-trip costs and quantities are outside its pending-order file. Individual outputs, case counts, invoice counts, distances, preferences and wall times are in large/all-run-summaries.json. Invalid D3 values are retained as evidence but never treated as competitive costs.

## 4. Frozen work: feasible is not enough

**The most serious observed quality failure occurs in native-budget same-day replanning.** At 10:00, D5 has six earlier frozen trips, 320 pending invoices across 180 destinations, 4,826 cases and 25 late/VIP destinations. The same request admits a complete independently validated plan.

| Answer | Stops planned | Invoices planned | Cases planned | P1 / P2 served |
| --- | --- | --- | --- | --- |
| Input / full-service target | 180 | 320 | 4,826 | 13 / 36 |
| 60 s OFF, repeat 17 | 175 | 310 | 4,719 | 13 / 33 |
| 60 s hybrid, seed 29 | 175 | 311 | 4,711 | 13 / 34 |
| Native 110 s hybrid, seed 17 | 84 | 158 | 2,250 | 10 / 16 |
| Independent greedy witness | 180 | 320 | 4,826 | 13 / 36 |

The native run uses automatic 110-second primary search, the default 540-second cap and four CPUs; actual elapsed time is 125.77 seconds. Its returned plan is **VERIFIED / EXACT** and independently passes physical and accounting checks. Nevertheless, it leaves **96 destinations and 162 invoices unplanned, including 3 P1 and 20 P2 stops**. This is avoidable service loss, not an unsafe timetable or proof that the missing work cannot fit.

The raw PyVRP candidate reports all 180 stops and feasibility under its approximate model, then the exact stage rejects it as NO_FEASIBLE_PLAN. The main/repair path returns the 84-stop partial answer. Logs show its fit repair stopped FEASIBLE with a 100% subproblem gap after 8.4 seconds; the PyVRP fit repair returned UNKNOWN after 10 seconds. The overall 540-second cap was far from exhausted. These are repair-subproblem diagnostics, not whole-routing optimality bounds.

A separate standard-library greedy planner serves all 180 destinations, 320 invoices and 4,826 cases with the same operational inputs, frozen reservations and matrix. Its capacities, loading readiness, shifts, breaks, frozen intervals, invoice accounting and costs pass the independent checker. Remaining-plan cost is 518.113 OMR versus 271.180 for the native partial answer. The lower partial cost is not a saving: strict service priorities require serving the feasible work first.

### Interpretation and corrective direction

This is one native-budget counterexample, not an estimate of daily failure frequency or an isolated causal experiment on runtime. Its four-CPU affinity differs from the 60-second series, and heuristic trajectories vary. What is established is that the default-budget model returned a much worse service plan than a valid same-input witness.

Preserve a fully timed feasible incumbent, improve recovery of work dropped during retiming, and allow a validated full-service fallback into final comparison. Consider allocating more of the remaining budget to exact repair when it loses high-priority work and retains a weak bound. Replay D5 and P02 after changes. Do not assume P02’s singleton-pool limitation is D5’s sole cause; its reconstruction failure needs separate diagnosis.

Evidence: large/D5_late_frozen/on-seed17-auto-budget540; greedy-baseline/; validation/reports. Frozen trips are earlier work outside the 320 pending invoices. All service is simulated; no deliveries or production changes occurred.

## 5. Tight-window failure and diagnosis

**All four 60-second D3 runs claimed 200/200 stops served but returned a VIOLATED / ESTIMATED plan.** Independent checks agree: seven truck days lack the required 60-minute break, and truck T04 load 2 leaves about 5.5 minutes before its loading-ready time. These are not dispatchable solutions. The product correctly flags them; this is not evidence of a falsely VERIFIED answer.

A separately implemented conservative greedy planner found a valid 185/200-stop answer on the same request, serving every P1–P4 customer. Therefore a useful feasible partial fallback exists. The failed complete answer should not displace a validated partial incumbent.

**Native-budget followup:** on-seed17-auto-budget540: VERIFIED, 200 served, 155.87 s The native 150-second search recovered all 340 invoices and 8,393 cases at 623.324 OMR. The main solver and repair supplied this plan; embedded PyVRP still found no feasible candidate. D3 is a shortened-budget robustness issue, not a confirmed default-budget launch failure.

### Two integration restrictions

**Penalty scale.** Embedded PyVRP logged NO_FEASIBLE_PLAN and PenaltyBoundWarning. The default penalty ceiling is 100,000 while strict-service prizes in this fixture reach roughly 4.1 × 10<sup>14</sup>. Existing raised-penalty logic is triggered by some hire/capacity cases, but not this time-window pressure. This can make accepting constraint violation too attractive inside the search.

**Preferred windows become hard windows in the candidate model.** For the first 70 customers, 18 minutes of service each requires 1,260 truck-minutes. Restricting these to the preferred 09:00–10:30 interval provides only 12 × 90 = 1,080 truck-minutes, before travel. Full service is impossible in that restricted candidate model even though RouteIQ permits earlier service inside a wider hard window, at a preference penalty. This arithmetic does not prove full-day feasibility in the original model.

### Controlled diagnostic, not a shipped fix

A paired 20-second, seed-17 diagnostic changed only the in-memory penalty configuration. Stock found no feasible PyVRP candidate. The existing integer-safe raised configuration produced a feasible candidate; actual timing/repacking then returned **184/200 served, VERIFIED/EXACT**, independently validated, at 644.434 OMR. Raising the ceiling also changes initial penalties, so the experiment establishes a configuration effect, not ceiling-only causality.

The 185-stop greedy witness still serves one additional P4 stop than the modified 20-second diagnostic; the native stock run serves everyone. The diagnostic is neither optimal nor part of the stock benchmark ranking. Proposed work: preserve validated partial fallbacks, generalize safely scaled penalties, and represent priced preferences without making them compulsory in the candidate search.

Evidence: large/D3_tight_receiving; diagnostics/d3-penalty. The safe penalty bound and raw model are saved. Never copy a large numerical ceiling into production without reviewing all integer overflow bounds.

## 6. Public reference benchmarks

| Public instance | BKS distance | RouteIQ hybrid gap | Standalone PyVRP gap |
| --- | --- | --- | --- |
| X-n101-k25 | 27,591.0 | 6.466% / 6.466% | 0.000% / 0.000% |
| X-n125-k30 | 55,539.0 | 3.405% / 3.394% | 0.022% / 0.047% |
| X-n200-k36 | 58,578.0 | 4.855% / 4.855% | 0.108% / 0.642% |
| R108 | 932.1 | 0.000% | 0.494% |
| RC201 | 1,261.8 | 0.063% | 0.000% |

Values are distance gaps to published **best-known solutions (BKS)**, not automatically gaps to mathematically proven optima. Two listed values are the two CVRP seeds; R108 and RC201 have one seed. Every scored answer must serve all customers and pass an independent capacity/window/distance check. The raw files retain distance, route count, elapsed time and diagnostics.

All 19 final runs passed independent checks: three CVRP cases × two seeds × two methods, two time-window cases × two methods, plus three RouteIQ OR-Tools-only ablations. Each gets a 60-second primary search window on one CPU. Hybrid end-to-end time is 61.1–62.2 seconds; standalone is 60.0–60.1. Hybrid searches share one core, with its CPU gate explicitly lowered to one; standalone gets that core for one search.

**Observed distinction:** embedded PyVRP found no feasible candidate on the six high-scale CVRP runs; RouteIQ returned valid main-search fallbacks. Standalone PyVRP was substantially closer to BKS on those cases. The time-window results are stronger: RouteIQ matched R108 at 932.1 and reached RC201 at 1,262.6, 0.0634% above its 1,261.8 reference. The problem is not a universally broken PyVRP engine.

**Fairness limits:** these are simplified fixed-stop, distance-only models. They do not cover NMWC invoices, rentals, pallet loading, breaks or frozen work. PyVRP is also RouteIQ’s second engine, so this is a specialized same-engine reference, not an independent commercial competitor. RouteIQ auxiliary geographic projection slightly rescales search geometry; the objective matrices and independent scoring are exact. No statistical ranking follows from five selected instances.

CVRP uses nearest-integer Euclidean distance. Solomon uses the DIMACS one-decimal truncation, distance-only convention. Do not compare R108 932.1 against a vehicle-first SINTEF number computed with a different metric. One benchmark distance unit maps to one model km: these are abstract public units, not plausible 27,000-km Muscat workdays.

**Separate numerical diagnostic:** on the same embedded X101 model, paired 10-second searches found no feasible candidate with stock penalties, but reached BKS 27,591 with the integer-safe raised configuration. A tiny realistic case—two 100-case own trucks, 51 + 50 cases, a customer 5 km away—showed the same stock failure / raised-feasible pattern. These component experiments change penalty initialization as well as its ceiling and are excluded from the 19 stock scores.

Public input provenance: github.com/PyVRP/Instances, tree 7474b068a8effa7f39448b241314b615c9271525. Every input and BKS route was hash checked; reference routes were independently re-evaluated. Corrected adapter development runs are quarantined and excluded. See public/README.md, source-manifest.json and diagnostic files for limitations and numerical experiments.

## 7. Where optimality is actually proved

**28 of 28 small actual solver answers matched an independently exhaustive optimum, with a 0% objective gap for each encoded problem.** These fixtures contain six or seven stops, with 170 stops in total. They use the actual RouteIQ optimizer with a two-second primary allowance, PyVRP disabled and one repack worker.

| Family | Instances | What was exercised |
| --- | --- | --- |
| Case / pallet / kg capacity | 4 each | Different binding load resources and complete served/unserved accounting. |
| Receiving windows | 4 | START and FINISH timing semantics. |
| Strict priority shortage | 4 | P1–P5 service ordering before lower-tier cost. |
| Multiple trips | 4 | Up to two trips with reload timing. |
| Flat rentals | 4 | Hire selection in the restricted fixed-stop formulation. |

The oracle independently enumerated 9,938 ordered loads and 14,404 feasible truck days, then combined them through 18,631 fleet transitions. It does not reuse the product’s routing or feasibility routines. A separate response validator also passed all 28 results. Some optimal answers deliberately omit infeasible work; 28 optimum matches does not mean every fixture serves every stop.

**Proof boundary:** these tests exclude invoice splitting, mandatory breaks, frozen work, real traffic and shared loading-bay resources. The result is not a 100% accuracy claim for all inputs, the hybrid, or 300-invoice days. No valid global cost lower bound was established for the large synthetic days.

### An optimal encoded answer can still omit a better business plan

| Original problem | Actual current encoding | Proven alternative |
| --- | --- | --- |
| Items 6,5,3,2,2,2 kg; 10-kg capacity | Greedy grouping 9/9/2; only 5 of 6 cases served | 203 partitions enumerated: 10/10 grouping serves all 6. |
| 200 cases; own 100 + rental choices | One 200-case stop forces large hire; 110 OMR | If splitting is permitted, 100+100 uses own + small hire; 30 OMR. |

Four actual solver calls tested both encodings. Each was optimal for its own supplied request. The rental oracle enumerated 10,201 quantity allocations and matched a 30 OMR lower bound. The business policy matters: if one visit is intentionally compulsory whenever a large truck exists, the cheaper split is not an admissible alternative. That policy must be explicit.

Evidence: exact/summary.json, aggregate.json, run_exact_suite.py and formulation/. Real TypeScript builder reproductions of these upstream effects are in the pipeline suite.

## 8. Invoice-to-plan simulation

| Scenario | Executed result | Interpretation |
| --- | --- | --- |
| P01 normal + duplicate upload | 360 invoices, 720 SKU rows, 6,822 cases all served; repeat upload adds zero rows | Positive intake, builder, planning and persistence evidence. |
| P02 freeze + late VIP | 358/361 invoices; 6,808/6,862 cases in simulated service, including frozen work | VIP and frozen work handled; 54 cases avoidably missed. |
| P03 rental alternatives | Same 200 cases cost 110 OMR with large candidate, 30 with only small candidate | Fixed stop partition can defeat fleet-cost optimization; split policy qualification applies. |
| P04 item packing | Builder groups 9/9/2; 5/6 cases served | Valid 10/10 grouping proves avoidable service loss. |
| P05 prospective heavy rental | 120-kg case pre-dropped against 100-kg own fleet | A 200-kg prospective rental is overlooked at this filter; when already in fleet, case is served. |

The real service path is intake validation → confirmation → request building → Python optimization → result persistence → scenario application → plan-facts reconciliation. The database is a relation-aware fake, not PostgreSQL. All cases, source invoice/SKU lines, splits, pre-drops and assignments are independently accounted for. A recorded pre-drop conserves data but can still be a planning defect.

### P02: explicit better-plan witness

At 11:00, one 721-case load is frozen and a 40-case P1 order is added. The solver gets 108 pending stops and leaves C3 (54 cases from three invoices) unserved. Two trucks remain unused. The returned plan is feasible, but does not maximize service.

A real singleton solve places C3 on unused T2, leaving 11:21 and returning 12:04. Adding only that route leaves all nine existing returned loads and frozen reservations unchanged. Independent validation passes. New-work cost rises from 191.248 to 217.576 OMR; planned coverage rises to all 6,862 cases. Under the configured service-first policy, this is a strict improvement despite higher cash cost.

The miss reproduced with the time limit omitted and again with production multiprocessing, two CPUs, default PyVRP CPU gate and native 20-second primary allowance. The latter took 30.63 seconds. This rules out the initial forced-one-core harness setting or an artificially shortened primary limit as a sufficient explanation.

P01 final output: 4 trucks, 10 loads, 214.17 estimated km, 178.892 OMR, 49.98 s under its disclosed one-core harness. P02 final business acceptance assertion deliberately fails on the missing 54 cases. P03–P05 regression tests pass by reproducing the current defect/policy behavior; that is not business acceptance success.

## 9. More search time is not a certificate

| Same D1 request / matrix | QUICK | THOROUGH |
| --- | --- | --- |
| Actual end-to-end | 164.20 s | 426.35 s |
| Invoices / cases served | 360 / 9,526 | 360 / 9,526 |
| Trucks / loads | 7 / 12 | 7 / 11 |
| Estimated km | 482.86 | 457.98 |
| Operating cash OMR | 438.533 | 431.370 |
| Customer preference penalty | 9.998 | 18.274 |
| Full recommendation objective | 448.531 | 449.644 |
| Independent feasibility | PASS | PASS |

Both runs use the same matrix, seed 17, three-core affinity and actual production-worker path. QUICK uses its native 150-second primary allowance and 540-second cap. THOROUGH uses the native 1,200-second cap and main-engine 300-second stall floor; it stopped naturally at 426.35 seconds. PyVRP has a separate stall rule. Only search mode and maximum search setting differ.

**Cash improved by 1.63% and distance by 5.15%, while the complete objective worsened by 0.248%.** This single pair is a counterexample to assuming the Thorough label always gives a better final recommendation. It does not prove Thorough is worse on average. Wall-clock randomness, candidate objectives and downstream route repair can change the trajectory.

Search telemetry such as CONVERGED means a stopping rule was reached. It is not a proof that no better route exists. PyVRP progress scores describe a candidate model before all mandatory timing and costing stages; they are not final operating cash. Likewise, CP-SAT repacking bounds certify only their restricted subproblem, not the entire vehicle-routing problem.

### Practical enhancement

Retain a validated incumbent evaluated with the final service-first business objective. Let additional search replace it only after mandatory timing, cost recomputation and the same full comparison. A deliberate Quick-then-continue design could make a useful “never worse than the saved Quick answer” guarantee. Separate runs today do not establish that guarantee.

**Confirmed display issue:** the UI/export describes the OR-Tools last-improvement time (102 s) as the “best plan” history, although the selected PyVRP candidate improved at 299.6 s. Both engines stopped legitimately under their own rules. Label telemetry by engine; the misleading wording is not a premature-termination bug.

Evidence: search-modes/comparison.json, quick/ and thorough/. This comparison requests the RECOMMENDED scenario only; it is not a test of every UI option. See source-analysis.md for stopping/selection details and qualifications.

## 10. Work to prioritize

| Priority | Change | Acceptance evidence |
| --- | --- | --- |
| Before relying on replans | Retain a fully timed incumbent; recover work lost during exact scheduling and admit valid fallbacks | Native D5 plans all 320 pending invoices; P02 plans all 361 including frozen work. |
| Budget robustness | Retain a feasible partial fallback through retiming; keep the current invalid-plan guard | D3 already passes at native budget; a useful validated fallback should survive shorter limits too. |
| Optimizer integration | Scale penalties with integer-safe bounds; preserve hard versus priced window semantics | Embedded PyVRP finds feasible candidates in saved D3 and CVRP cases, with final validation still mandatory. |
| Input formulation | Improve packing and consider alternative invoice partitions when split visits are allowed | P04 10/10 packing serves all 6; P03 evaluates the admissible 30 OMR alternative. |
| Rental eligibility | Include feasible prospective fleet options before declaring an item impossible | P05 heavy case remains eligible for its 200-kg rental. |
| Quality guarantee | Preserve the best validated full-objective incumbent during longer search | Thorough continuation never worsens the saved Quick answer at equal service. |

**Source evidence:** the accompanying findings-register.json records verified file/line locations, reproduction paths, scope and proposed changes. The relevant areas are PyVRP model construction and penalty settings, solver orchestration/fallback, load_repack candidate generation, and the web request builder’s packing and rental filters.

The P02 source gap is specific: repacking offers singleton candidates for stops that were raw-unserved, but a stop initially served by a search and later dropped during exact timing can be absent from that repair pool. This is a contributing limitation supported by inspection and the feasible unused-truck witness; it is not a claim that one edited line fully fixes every replan failure.

P03 is conditional on the business split-visit policy. P05 affects weight-constrained configurations; the large NMWC-style fixtures have kg limits disabled. The six-item packing example proves existence of a failure, not its expected daily frequency. Treat severity as potential operational impact plus observed reproducibility, not an estimate of real incident rates.

This task made no product fixes. Diagnostic in-memory adaptations are clearly labeled, retain stock comparisons, and are excluded from the official result set. The bundle is suitable for a developer to turn each finding into a focused regression and then rerun the same evidence.

## 11. Validation, reproduction and launch gate

**The checker was authored separately and imports no RouteIQ module.** It recomputes coverage, quantities, capacities, route matrices, receiving constraints, loading, breaks, shift envelopes, frozen reservations and cash/preferences. Public routes are checked directly against original instance files. Eight deliberately corrupted outputs were all rejected, covering missing/duplicate service, capacity, closing, distance, money, frozen overlap and missing breaks.

Independent physical/accounting results: **16/20** controlled large runs pass; four D3 short-budget answers fail, matching their product VIOLATED flags. Both native-budget replays, all 28 exact-reference answers, all 19 public route lists and all five greedy baselines pass. **No tested product VERIFIED answer failed the independent physical checker.** D5 and P02 show why that still does not establish good service or optimization quality.

Because responses round clocks to minutes, timing PASS establishes that a compatible integer-second timetable exists. It does not reconstruct unseen internal timestamps. A feasibility/accounting PASS never proves optimality, correct business policy or road-network truth. Final per-lane counts and any product/checker disagreement are saved in validation/aggregate-by-lane.json.

### Before the Sunday pilot

Replay representative anonymized NMWC days with the actual fleet, stock, SKU factors, receiving rules and road matrices. Include a peak day, tight receiving day and late-order/frozen replan. Compare against the dispatcher’s actual plan on the same objective; have the dispatcher review every omitted invoice, route and exception. Test the real database and dispatch/driver workflow, including a recovery rehearsal, before letting plans control operations.

The minimum optimizer gate is zero accepted hard-rule violations, exact invoice/SKU conservation and frozen preservation, full feasible service in saved native D5 and P02, and a usable fallback when D3 is time-constrained. Quality reporting should include service by priority, planned cases/invoices, operating cash, preference penalties, elapsed time and the benchmark convention. Keep unknown large-day optimality gaps explicitly unknown.

### Evidence package

The ZIP contains the five reusable synthetic days, raw requests and returned routes, captured matrices, all final comparisons, exact oracle witnesses, public reference files, pipeline harness, independent checker, diagnostic reproductions, runtime versions and source hashes. Top-level README.txt maps the directories and reproduction commands. Product source and credentials are not bundled; check out the pinned commit separately.

A rerun with time-limited heuristics may produce different routes even with the same seed, especially under shared-host load. Compare feasibility, service and objective rather than byte-for-byte route equality. Do not mix archived adapter-development outputs or constructed witness plans with stock model results.

### Reference conventions

[PyVRP public instances and reference solutions](<https://github.com/PyVRP/Instances/tree/7474b068a8effa7f39448b241314b615c9271525>)
[PyVRP benchmarking protocol](<https://pyvrp.readthedocs.io/en/stable/dev/benchmarking.html>)
[PyVRP penalty parameters and numerical limits](<https://pyvrp.readthedocs.io/en/stable/api/pyvrp.html>)
[OR-Tools routing: heuristic solution quality](<https://developers.google.com/optimization/routing>)
[CP-SAT: FEASIBLE versus OPTIMAL status](<https://developers.google.com/optimization/cp/cp_solver>)

## 12. Verified code locations

Links open the exact reviewed commit. The JSON findings register includes additional locations, source-slice hashes, reproduction artifacts, causal qualifications and proposed fixes. These are source-backed findings from the executed scenarios, not a claim that this test run reviewed every possible product behavior.

| Finding / classification | Verified source locations at pinned commit |
| --- | --- |
| F01 — Reduced search budgets can leave flagged invalid fallbacks; native budget recovers this case | [apps/solver/dispatch_solver.py:5030–5063](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/solver/dispatch_solver.py#L5030-L5063>)<br>[apps/solver/dispatch_solver.py:5280–5292](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/solver/dispatch_solver.py#L5280-L5292>)<br>[apps/solver/pyvrp_candidate.py:316–332](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/solver/pyvrp_candidate.py#L316-L332>)<br>[apps/solver/pyvrp_candidate.py:440–460](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/solver/pyvrp_candidate.py#L440-L460>) |
| F02 — Exact timing repair can leave a feasible customer unserved while a truck remains unused | [apps/solver/load_repack.py:1628–1648](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/solver/load_repack.py#L1628-L1648>)<br>[apps/solver/load_repack.py:1705–1709](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/solver/load_repack.py#L1705-L1709>)<br>[apps/solver/load_repack.py:1748–1762](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/solver/load_repack.py#L1748-L1762>)<br>[apps/solver/dispatch_solver.py:5111–5117](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/solver/dispatch_solver.py#L5111-L5117>) |
| F03 — No-split-if-any-truck-fits policy can force a much more expensive rental | [apps/web/lib/dispatch/plan-service.ts:553–571](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/web/lib/dispatch/plan-service.ts#L553-L571>) |
| F04 — Greedy SKU packing can create an extra visit that causes avoidable unserved quantity | [apps/web/lib/dispatch/split.ts:101–105](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/web/lib/dispatch/split.ts#L101-L105>)<br>[apps/web/lib/dispatch/split.ts:130–155](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/web/lib/dispatch/split.ts#L130-L155>)<br>[apps/web/lib/dispatch/plan-service.ts:742–746](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/web/lib/dispatch/plan-service.ts#L742-L746>) |
| F05 — Heavy-case prefilter ignores prospective rental payload | [apps/web/lib/dispatch/plan-service.ts:553–564](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/web/lib/dispatch/plan-service.ts#L553-L564>)<br>[apps/web/lib/dispatch/plan-service.ts:573–580](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/web/lib/dispatch/plan-service.ts#L573-L580>) |
| F06 — Convergence text presents main-engine progress as the selected hybrid plan history | [apps/solver/dispatch_solver.py:822–837](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/solver/dispatch_solver.py#L822-L837>)<br>[apps/web/lib/dispatch/search-mode.ts:277–282](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/web/lib/dispatch/search-mode.ts#L277-L282>)<br>[apps/web/lib/dispatch/workbook.ts:469–473](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/web/lib/dispatch/workbook.ts#L469-L473>) |
| F07 — Native-budget exact repair can discard most pending work despite an available full-service plan | [apps/solver/dispatch_solver.py:161–162](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/solver/dispatch_solver.py#L161-L162>)<br>[apps/solver/dispatch_solver.py:5119–5121](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/solver/dispatch_solver.py#L5119-L5121>)<br>[apps/solver/dispatch_solver.py:5135–5151](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/solver/dispatch_solver.py#L5135-L5151>)<br>[apps/solver/load_repack.py:1628–1648](<https://github.com/rahmanmansoori244-droid/routeiq/blob/5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b/apps/solver/load_repack.py#L1628-L1648>) |

The frozen-replan service losses are the highest operational priority. D3 adds a shorter-budget fallback issue but passes at its native budget. The rental split rule is an owner policy choice if deliberate. Packing and heavy-case filtering affect the demonstrated weight-constrained fixtures. Convergence wording affects the accuracy of progress explanations.

Source SHA: 5b2ee0669c5b39a05b0dbff5c8acf8c2d30f160b. Production source remained unchanged through this task; 833 / 833 tracked files matched their pinned Git blob hashes again at final preparation.
