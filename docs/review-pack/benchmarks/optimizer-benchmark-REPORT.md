# How close is RouteIQ's dispatch engine to optimal?

Benchmark report for the owner, 29 Sep 2026.

- **Engine tested:** the production code at commit 3451f4d, `apps/solver/dispatch_solver.py` with OR-Tools 9.15. It was imported, never edited. File fingerprint: `dispatch_solver.py` 04d2121bc785d0ab, `load_repack.py` 0614ebabe0f08c66.
- **Reference solver:** PyVRP 0.14.0, the latest release, in its own environment (`venv-ref`).
- **Where everything is:** all files are under `C:/Users/abdulr/routeiq/.dev/bench/public/`, which is git-ignored and local only.
- **Real NMWC data:** the real day (`real80`) is private, so this report gives aggregates only: no names, ids or coordinates.

---

## Part 1. The answer in plain English

**Your question:** make sure the solver gives an optimal solution, even if it runs for 20 minutes.

**Short answer: it does not today, and no solver can prove a full NMWC day optimal in 20 minutes.** What we can do is:

- measure how far each plan is from optimal;
- put a proven ceiling on that distance ("at most X% above the best possible plan");
- close most of the gap with the changes ranked below.

### What we found

1. **On the standard public benchmarks the engine is well behind the state of the art.** Researchers use three standard sets: Solomon, Gehring & Homberger, and the CVRPLIB X set.
   - **Proven optima (6 X instances):** at its automatic time limit the engine's routes are 3.1% to 9.4% longer than the proven optimum (median 7.1%). PyVRP, given the same problem and the same time, is 0% to 0.9% longer (median 0.6%).
   - **Delivery-window instances (13):** at the automatic limit the engine needs 1 or 2 more vehicles than the best known solution on 5 of them. PyVRP needs more on 2 of 13 at the same time, and on none after 3 minutes.
2. **Twenty minutes helps, but it does not reach optimal on the public sets.**
   - On the three proven-optimum instances run for 20 minutes, the engine's gap went from 3.1-7.6% to 1.0-4.1%. It never reached 0%.
   - On one delivery-window instance (Solomon r108) the engine kept a 10th vehicle for the full 20 minutes; the best known solution uses 9.
   - PyVRP at the engine's *automatic* time (20 to 150 s) beat the engine's 20-minute result on 5 of the 6 long-run instances.
3. **On NMWC days, a longer search is worth real money on the real day.**
   - **Real 80-stop day:** 573-574 OMR at the automatic 20 s. A 10-minute search gave 525.45 OMR (-8.3% to -8.5%, about 47 to 49 OMR a day), with 5 trucks instead of 6.
   - **Proven ceiling:** no plan for that day can cost less than 492.79 OMR. The 10-minute plan is therefore **at most 6.6% above the best possible plan**.
   - **Synthetic NMWC-like days:** the gain was smaller, 0.5% to 3.1% on the 60- and 150-stop days.
   - **The 300-stop day:** 10 minutes gained 8.2%, but the 20-minute run ended 2.0% *worse* than the 10-minute run.
   - **10 against 20 minutes:** on 7 of the 8 NMWC days, 20 minutes was no better than 10 (5 identical, 2 slightly worse); the eighth gained 0.18%.
4. **Small days are solved optimally.** On 22 small NMWC-like days (5 to 10 stops, with reloads, windows and priorities) the optimum was proven. The engine found it on 20 of the 22 and was within 0.42% on the other 2.
5. **The engine's main weakness is the number of trucks.** Its search rarely manages to empty a truck.
   - On the real day the search itself used 13 trucks at 20 s. A post-solve step (the CP-SAT load repack) brings the plan down to 6.
   - On the public window instances the extra vehicles stayed even after 20 minutes.
   - **Second weakness:** it is a single search that settles in one region and stalls. For example, on Solomon rc201 there was no improvement after 21 s in 20 minutes.

### What to do

The changes are ranked; details are in Part 7.

0. **First, give night plans their own background job with a 20-minute budget.** Today the API caps the search at 10 minutes and a request at 9 minutes, so every 10- and 20-minute run in this study was outside the production contract.
1. **Move whole loads and remove trucks during the search, not only once at the end.** This targets the biggest measured error, which is truck count.
2. **Run PyVRP next to the engine as a second source of candidate plans.** The engine's own checks and cost score pick the winner, so PyVRP can only improve the result.
3. **Switch on the stronger search features already in OR-Tools 9.15** (ruin-and-recreate, extra large-neighbourhood moves). Test them first on this benchmark.
4. **Run several different searches on several CPU cores and keep the best.**
5. **Never return a plan worse than one already found.**
6. **Stop a search once it has stopped improving, and spend the remaining time elsewhere.**
7. **Show the dispatcher a proven "at most X% above optimal" figure.** Stop presenting plans as "OPTIMIZED".

### What can and cannot be promised

**Can be promised:**
- every plan is feasible, and this is checked independently;
- a proven ceiling on how far each plan is from optimal;
- a fixed benchmark that shows what each engine change does.

**Cannot be promised:** "this plan is optimal" for a full day. See Part 8.

**Machine caveat:** every run was on a busy, shared 6-core PC. CPU averaged 93%, and each solver process got 0.67 to 0.98 of a core. A time-limited search gives better results on a faster or idle server, so treat the times here as "time on a loaded machine".

---

## Part 2. What was measured, and how

| | Public benchmarks (engine vs PyVRP) | NMWC-like days (engine vs proven bounds) |
|---|---|---|
| Instances | 24. Solomon 100-customer (12), Gehring & Homberger 200-customer (6), CVRPLIB X of Uchoa et al. 2017 (6, 100 to 392 customers, all proven optimal) | 8 full days: the real 26-Sep day `real80` (83 stops, 13 trucks, real road matrix) and 7 synthetic NMWC days (60, 150 and 300 stops, 12 trucks, hard windows, P1-P5). Also 30 small days of 5 to 10 stops |
| Reference | Best-known solutions (BKS) from SINTEF TOP and CVRPLIB, each re-checked by our own evaluator; PyVRP 0.14.0 on the same integer model | Proven lower bounds (`nmwc_lb.py`); the best plan the harness holds; exact optima on the small days (CP-SAT) |
| Time limits | Engine's automatic limit ("auto"), 180 s, and for 6 instances also 600 s and 1,200 s. PyVRP at the same limits | auto (run twice), 600 s, 1,200 s |
| How the engine ran | Production code path: RECOMMENDED in a spawned worker, then the post-solve stage (CP-SAT load repack, exact LP timing, feasibility report) | Production code path with all three options (RECOMMENDED, MIN_TRUCKS, MIN_DISTANCE), but `SOLVER_PARALLEL=0`: the same jobs run one after another in one process instead of side by side |
| Checks | All 120 solutions feasible under an independent evaluator. The engine's objective equals the model objective in 120 of 120. Feasibility report VERIFIED on all 60 engine runs | All 32 runs: engine feasibility VERIFIED, feasible under the harness's independent evaluator, and the objective re-scored exactly by the engine's own scoring code |

**Why these sets.** They are the most widely used vehicle-routing benchmarks, and each tests something different.
- **X set:** capacity only, with proven optima. It measures pure route quality.
- **Solomon and Gehring & Homberger:** hard delivery windows, and the fewest vehicles is the first objective. This is the closest public match to NMWC's windows and truck costs.

None of them has NMWC's multi-trip reloads, so the NMWC days test the full engine and the public sets test its core search.

**How the problems were translated.** Both solvers get exactly the same integer problem:
- **Distance:** × 1000.
- **Travel time:** rounded up to whole seconds, so every solver solution is feasible under the published rules.
- **Fixed cost per vehicle:** large enough that one vehicle fewer always wins, which is the published "vehicles first, then distance" rule.
- **X set:** fixed cost 0; the objective is distance.

Two details affect how to read the results:
- **Five window instances need a stricter mapping.** Solomon C2 and the G&H C2/R2/RC2 instances have planning horizons longer than the engine's 24-hour day. For these five the stricter opt-in mapping `@scaled` was used: windows are rounded inward to whole minutes. Any solution feasible there is feasible under the published rules. However, the BKS itself does not fit this stricter model on 4 of the 5 (c208 fits), so those gaps partly measure the mapping.
- **PyVRP's X-set runs use natural units.** On the X set, PyVRP's default penalties did not work at the ×1000 scale (one run never became feasible), so PyVRP ran on the X set in natural units, `nint(d)`. That is exactly the published instance.

**Machine.**
- **Hardware:** Windows 11, 6 cores / 12 threads (AMD). Two other workflows were running tests and benchmarks at the same time.
- **Process limit:** this workflow ran at most 3 solver processes at once (2 ladder lanes plus 1 NMWC process).
- **Load during the public ladder** (07:39 to 12:49 UTC, 292 samples): CPU mean 92.6%, at 100% in 64% of samples, 11 to 40 Python processes.
- **Load during the NMWC runs** (07:46 to 16:54 UTC): mean CPU per run 69% to 100%.
- **CPU per solver process:** engine 0.67 to 0.98 of a core (median 0.83); PyVRP median 0.84 (see Part 9 for three PyVRP runs above 1).
- **Consequence:** time-limited results depend on this load.

---

## Part 3. Public benchmarks: engine vs PyVRP vs best-known solutions (task 1)

Columns: "auto" is the engine's automatic limit for that size (also given to PyVRP); 3 min = 180 s; 10 min = 600 s; 20 min = 1,200 s. "-" means not run at that limit.

### 3.1 CVRPLIB X set: gap to the PROVEN optimum (total distance)

| Instance | Customers | Engine's automatic limit | Proven optimum | Engine: auto | Engine: 3 min | Engine: 10 min | Engine: 20 min | PyVRP: auto | PyVRP: 3 min | PyVRP: 10 min | PyVRP: 20 min |
|---|---|---|---|---|---|---|---|---|---|---|---|
| X-n101-k25 | 100 | 20 s | 27,591 | +6.47% | +6.34% | +3.78% | +3.78% | **0 (optimal)** | **0 (optimal)** | **0 (optimal)** | **0 (optimal)** |
| X-n120-k6 | 119 | 20 s | 13,332 | +5.48% | +3.05% | - | - | +0.58% | **0 (optimal)** | - | - |
| X-n157-k13 | 156 | 62 s | 16,876 | +3.06% | +2.68% | +1.99% | +0.97% | +0.11% | +0.11% | +0.01% | +0.01% |
| X-n204-k19 | 203 | 150 s | 19,565 | +7.64% | +6.22% | +5.82% | +4.05% | +0.89% | +0.89% | +0.80% | +0.67% |
| X-n313-k71 | 312 | 150 s | 94,043 | +9.44% | +9.37% | - | - | +0.63% | +0.63% | - | - |
| X-n393-k38 | 392 | 240 s | 38,260 | +8.01% | +8.01% | - | - | +0.89% | +0.97% | - | - |
| **Median of 6** | | | | **+7.05%** | **+6.28%** | | | **+0.61%** | **+0.37%** | | |

PyVRP found the proven optimum of X-n101-k25 within 6 s. The engine's 20-minute result there (28,635) still used one route more than the optimum (27 against 26).

### 3.2 Delivery windows (Solomon, Gehring & Homberger), exact mapping, 13 instances

The objective is the published one: fewest vehicles first, then distance. Cells mean:
- "+1 veh": one vehicle more than the BKS, which is worse whatever the distance.
- "+x%": same vehicles as the BKS, distance x% above.
- "= BKS": equal to the best-known solution.

| Instance | Class | Customers | Auto limit | BKS (vehicles / distance) | Engine: auto | Engine: 3 min | Engine: 10 min | Engine: 20 min | PyVRP: auto | PyVRP: 3 min | PyVRP: 10 min | PyVRP: 20 min |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Solomon c101 | C1 | 100 | 20 s | 10 / 828.94 | **= BKS** | **= BKS** | - | - | **= BKS** | **= BKS** | - | - |
| Solomon c108 | C1 | 100 | 20 s | 10 / 828.94 | +3.06% | +3.06% | - | - | **= BKS** | **= BKS** | - | - |
| Solomon r101 | R1 | 100 | 20 s | 19 / 1650.80 | +0.17% | +0.17% | - | - | **= BKS** | **= BKS** | - | - |
| Solomon r108 | R1 | 100 | 20 s | 9 / 960.88 | +1 veh | +1 veh | +1 veh | +1 veh | +0.60% | +0.37% | +0.37% | **= BKS** |
| Solomon r201 | R2 | 100 | 20 s | 4 / 1252.37 | +2.87% | +1.65% | - | - | +0.19% | **= BKS** | - | - |
| Solomon r208 | R2 | 100 | 20 s | 2 / 726.82 | +2.65% | +0.16% | - | - | +2.10% | **= BKS** | - | - |
| Solomon rc101 | RC1 | 100 | 20 s | 14 / 1696.95 | +2 veh | +2 veh | - | - | +1 veh | **= BKS** | - | - |
| Solomon rc108 | RC1 | 100 | 20 s | 10 / 1139.82 | +1 veh | +1 veh | - | - | +1 veh | **= BKS** | - | - |
| Solomon rc201 | RC2 | 100 | 20 s | 4 / 1406.94 | +8.87% | +2.62% | +2.62% | +2.62% | +0.47% | **= BKS** | **= BKS** | **= BKS** |
| Solomon rc208 | RC2 | 100 | 20 s | 3 / 828.14 | +9.14% | +7.07% | - | - | +2.18% | +1.30% | - | - |
| G&H 200 c1_2_1 | C1 | 200 | 150 s | 20 / 2704.57 | **= BKS** | **= BKS** | - | - | **= BKS** | **= BKS** | - | - |
| G&H 200 r1_2_1 | R1 | 200 | 150 s | 20 / 4784.11 | +1 veh | +4.99% | +2.52% | +2.52% | +2.53% | +2.53% | +0.73% | +0.73% |
| G&H 200 rc1_2_1 | RC1 | 200 | 150 s | 18 / 3602.80 | +1 veh | +1 veh | - | - | +7.59% | +7.59% | - | - |

Summary for these 13:

| | Engine: auto | Engine: 3 min | PyVRP: auto | PyVRP: 3 min |
|---|---|---|---|---|
| Equal to the BKS | 2 | 2 | 4 | **9** |
| More vehicles than the BKS | **5** | **4** | 2 | 0 |
| Same vehicles, distance above | 6 (median +3.0%) | 7 (median +2.6%) | 7 (median +2.1%) | 4 (median +1.9%) |

At 20 minutes, Solomon r108 is the clearest case of the vehicle weakness:
- the engine still had 10 vehicles and distance 959.33, shorter than the BKS distance but with one vehicle more;
- PyVRP reached the BKS (9 / 960.88).

### 3.3 Long-horizon window instances, stricter `@scaled` mapping (read with care)

| Instance | Class | Customers | Auto limit | BKS (vehicles / distance) | Engine: auto | Engine: 3 min | PyVRP: auto | PyVRP: 3 min | Does the BKS fit the stricter model? |
|---|---|---|---|---|---|---|---|---|---|
| Solomon c201 | C2 | 100 | 20 s | 3 / 591.56 | +5.06% | +5.06% | +5.06% | +5.06% | no |
| Solomon c208 | C2 | 100 | 20 s | 3 / 588.32 | **= BKS** | **= BKS** | **= BKS** | **= BKS** | yes |
| G&H 200 c2_2_1 | C2 | 200 | 150 s | 6 / 1931.44 | +0.58% | +0.58% | +0.58% | +0.58% | no |
| G&H 200 r2_2_1 | R2 | 200 | 150 s | 4 / 4483.16 | +1 veh | +1 veh | +1 veh | +1 veh | no |
| G&H 200 rc2_2_1 | RC2 | 200 | 150 s | 6 / 3099.53 | +1 veh | +1 veh | +0.69% | +0.69% | no |

Where both solvers give exactly the same answer (c201, c2_2_1, r2_2_1), the mapping is most likely the limit, not the solver. rc2_2_1 is again a truck-count difference: engine 7 vehicles, PyVRP 6.

### 3.4 Small public cases with a PROVEN optimum (10 s runs)

These are the first n customers of a public instance. The optimum was proven by route enumeration and set partitioning (SCIP), vehicles first, then distance.

| Sub-instance | Proven optimum | Engine | PyVRP |
|---|---|---|---|
| Solomon c101, first 20 | 3 vehicles / 175.37 | optimal | optimal |
| Solomon rc101, first 40 | 7 / 804.01 | optimal | optimal |
| G&H r1_2_1, first 30 | 5 / 1328.94 | optimal | optimal |
| Solomon r101, first 50 | **11** / 1100.72 | 12 vehicles (missed) | 12 vehicles (missed) |
| X-n101-k25, first 25 | 8,015 | 8,140 (+1.56%, missed) | optimal |
| **Optimal** | | **3 of 5** | **4 of 5** |

---

## Part 4. NMWC-like days: gap to proven lower bounds (task 2)

### 4.1 What a lower bound means here

A **lower bound** is a number proven to be at or below the cost of *every* possible plan for that day.
- **Why it matters:** if a plan costs 6.6% more than the bound, it is at most 6.6% above the best possible plan. The real gap can be smaller, because the bound is itself below the true optimum by an unknown amount.
- **What it is built from** (`nmwc_lb.py`, `results/nmwc_bounds.json`):
  - a proven minimum of km: a linear-programming relaxation with capacity cuts, on the engine's own distance matrix;
  - proven minimum trucks and loads;
  - a mixed-integer model that prices trucks, loads, km, driver time for the whole truck day, overtime and the unavoidable early-arrival cost of P1/P2 stops.
- **Where it is weak:** it uses the hard delivery windows only through deadlines and time budgets. It is therefore weak on the synthetic days, where every stop has a hard window. It is tightest on the real day, which has no hard windows.

### 4.2 Cost (engine's RECOMMENDED score, OMR) against the proven bound

The plan measured is what production returns as RECOMMENDED (the post-solve stage picks the best of all three options).

| Day | Stops | Trucks available | Proven lower bound (OMR) | Automatic limit (2 runs) [limit] | 10-minute search | 20-minute search | Best plan known | Best known vs bound |
|---|---|---|---|---|---|---|---|---|
| real80 (real day) | 83 | 13 | 492.79 | 572.78 to 574.01 (+16.2 to +16.5%) [20 s] | **525.45 (+6.6%)** | 526.99 (+6.9%) | 525.45 | +6.6% |
| syn60_s1 | 60 | 12 | 205.97 | 254.54 to 255.00 (+23.6 to +23.8%) [20 s] | 248.21 (+20.5%) | 248.21 (+20.5%) | 248.21 | +20.5% |
| syn60_s2 | 60 | 12 | 202.82 | 249.48 to 249.83 (+23.0 to +23.2%) [20 s] | 247.86 (+22.2%) | 247.86 (+22.2%) | 247.86 | +22.2% |
| syn60_s3 | 60 | 12 | 180.03 | 213.95 (+18.8%) [20 s] | 212.90 (+18.3%) | 212.90 (+18.3%) | 212.90 | +18.3% |
| syn150_s1 | 150 | 12 | 400.62 | 506.00 (+26.3%) [50 s] | 498.52 (+24.4%) | 498.52 (+24.4%) | 498.52 | +24.4% |
| syn150_s2 | 150 | 12 | 394.86 | 531.94 (+34.7%) [50 s] | 517.82 (+31.1%) | 517.82 (+31.1%) | 517.82 | +31.1% |
| syn150_s3 | 150 | 12 | 382.31 | 508.96 (+33.1%) [50 s] | 493.85 (+29.2%) | 492.97 (+28.9%) | 492.97 | +28.9% |
| syn300_s1 | 300 | 12 | 698.80 | 1085.60 to 1090.99 (+55.4 to +56.1%) [150 s] | 996.20 (+42.6%) | 1016.31 (+45.4%) | 950.83 | +36.1% |

The best plan known is the lowest score among all plans the harness holds, each re-scored by the current engine. It comes from this study's runs, except on syn300_s1: there it is an older 300 s run that used OR-Tools' AUTOMATIC first-solution strategy.

Measured against that best-known plan, the gaps are:

| Day | auto | 10 min | 20 min |
|---|---|---|---|
| real80 | +9.0 to +9.2% | 0 | +0.29% |
| syn60 (3 days) | +0.5 to +2.7% | 0 | 0 |
| syn150 (3 days) | +1.5 to +3.2% | 0 to +0.18% | 0 |
| syn300_s1 | +14.2 to +14.7% | +4.8% | +6.9% |

**How to read this:**
- **real80 is the meaningful case** (no hard windows, so the bound is tighter).
  - The 10-minute plan is proven to be **at most 6.6% above optimal**.
  - It already uses the proven minimum of trucks and loads (5 / 14).
  - Its km are 4.8% above the proven km minimum (963 against 920).
  - The largest remaining piece is the P1/P2 early-arrival preference cost: 29.3 OMR in the plan against 6.2 OMR in the bound. The bound may be optimistic on that piece.
- **On the synthetic days the 18% to 45% gaps are upper limits, not the true gaps.** The evidence that most of it is bound weakness, not search weakness:
  - the 10- and 20-minute searches end on the same plan on 5 of these 7 days;
  - two automatic runs differ by at most 0.5%;
  - none of the 54 to 74 known plans per day uses fewer than 4, 4 and 3 trucks (the three 60-stop days) or 8 trucks (150 stops), where the bound allows 3, 3, 2 and 5.

  This cannot be proven. Proving it would need a bound that models the windows.
- **syn300_s1 has a real search shortfall:** the 10- and 20-minute runs are 4.8% and 6.9% above a plan that an older 300 s run found with a different first-solution strategy.

### 4.3 Trucks, loads and km against the proven minimums

| Day | Bound: trucks / loads | Auto: trucks / loads | 10 min | 20 min | Best known | Proven km minimum | Fewest km, auto (MIN_DISTANCE option) | Fewest km, 10 min | Fewest km, 20 min |
|---|---|---|---|---|---|---|---|---|---|
| real80 | 5 / 14 | 6 / 17 | 5 / 14 | 5 / 14 | 5 / 14 | 920 | 1115 (+21.2%) | 963 (+4.8%) | 966 (+5.0%) |
| syn60_s1 | 3 / 4 | 4 / 5 | 4 / 5 | 4 / 5 | 4 / 5 | 368 | 398 (+8.2%) | 392 (+6.5%) | 392 (+6.5%) |
| syn60_s2 | 3 / 4 | 4 / 4 | 4 / 4 | 4 / 4 | 4 / 4 | 352 | 362 to 364 (+2.8 to +3.4%) | 362 (+2.8%) | 362 (+2.8%) |
| syn60_s3 | 2 / 3 | 3 / 3 | 3 / 3 | 3 / 3 | 3 / 3 | 335 | 353 to 355 (+5.6 to +6.1%) | 347 (+3.6%) | 347 (+3.6%) |
| syn150_s1 | 5 / 9 | 8 / 9 | 8 / 9 | 8 / 9 | 8 / 9 | 630 | 748 (+18.7%) | 689 (+9.4%) | 687 (+9.0%) |
| syn150_s2 | 5 / 9 | 8 / 11 | 8 / 12 | 8 / 12 | 8 / 12 | 596 | 756 (+26.9%) | 734 (+23.2%) | 718 (+20.6%) |
| syn150_s3 | 5 / 8 | 8 / 10 | 8 / 10 | 8 / 10 | 8 / 10 | 581 | 692 (+19.0%) | 667 (+14.7%) | 656 (+12.8%) |
| syn300_s1 | 9 / 20 | 12 / 26 and 12 / 25 | 12 / 25 | 12 / 24 | 12 / 24 | 971 | 1774 to 1825 (+82.7 to +87.9%) | 1673 (+72.2%) | 1637 (+68.6%) |

The km bound ignores windows, so on windowed days a large km gap is again partly the bound. On the 60-stop days, though, the MIN_DISTANCE option is within 2.8% to 6.5% of the proven km minimum.

### 4.4 Small NMWC-like days: engine against the PROVEN optimum

`exact_nmwc_small.py` produced `results/nmwc_exact_small.json`.

- **The days:** 30 generated days of 5 to 10 stops, with 1 to 3 trucks, reloads, hard windows, P1-P5, cases and kg, and tight shifts or capacity shortage on some.
- **The exact model:** CP-SAT, priced exactly like the engine's own score, with CP-SAT given 180 to 400 s per phase. The engine ran at its automatic 5 s.

| | Days | Optimum proven | Engine found the proven optimum | Engine missed it by | Unproven days: engine against the best exact solution |
|---|---|---|---|---|---|
| General days | 20 | 17 | 15 | 0.435 OMR (0.42%) and 0.012 OMR (0.01%) | equal on all 3 |
| Shortage days | 10 | 5 | 5 | - | equal on all 5 |
| **All** | **30** | **22** | **20 of 22** | | **equal on 8 of 8** |

CP-SAT could not prove 8 of these tiny days optimal: some have only 9 or 10 stops and 2 to 3 trucks, and even 400 s per phase was not enough. This is the practical reason full days of 60 to 300 stops cannot be proven.

---

## Part 5. Does 20 minutes buy real improvement, and where does it stop? (task 3)

### 5.1 Improvement over the automatic limit

| | auto → 10 min | 10 → 20 min | Verdict |
|---|---|---|---|
| X-n101-k25 / X-n157-k13 / X-n204-k19 (vs the proven optimum) | 6.47→3.78% / 3.06→1.99% / 7.64→5.82% | 3.78→3.78% / 1.99→0.97% / 5.82→4.05% | Real, roughly halves the gap; never optimal |
| Solomon r108 | 10 veh, +0.72% → 10 veh | still 10 veh (BKS 9) | Distance improves, vehicle count never does |
| Solomon rc201 | +8.87% → +2.62% | +2.62% | Everything happens in the first 30 s |
| G&H r1_2_1 | 21 veh → 20 veh, +2.52% | +2.52% | One vehicle saved after about 3 min |
| real80 (real day) | 572.78-574.01 → 525.45 OMR (-8.3% to -8.5%), 6 → 5 trucks | 525.45 → 526.99 (+0.29%) | **Worth it: about 47 to 49 OMR per day** |
| syn60 (3 days) | -0.5% to -2.5% | 0.0% on all 3 | Small; converged by 10 min |
| syn150 (3 days) | -1.5% to -3.0% | 0.0%, 0.0%, -0.18% | Small; essentially converged by 10 min |
| syn300_s1 | -8.2% | +2.0% (worse) | Large gain, but not monotone (below) |

**Is 20 minutes worth it?**
- **Yes on the real day and on very large days.** Even today's engine at 10 minutes saved about 8%.
- **Not on 60-stop days:** at most 2.5%, and nothing after 10 minutes.
- **A longer run is not guaranteed to be better.**
  - **Why:** OR-Tools stops on wall-clock time, and some of its internal steps are timed. On a busy machine two runs can therefore take different paths.
  - **Where it happened:** syn300_s1 (+2.0% worse at 20 minutes) and real80 (+0.29%).
  - **Other runs disagreed with each other too:** the separate 600 s engine run on r1_2_1 reached 4904.54, which the 1,200 s run reached only after 855 s.

### 5.2 Where it stops improving: convergence traces

The traces come from the best-so-far log inside each 20-minute run (`results/ladder/ladder_traces.csv`, `results/traces/`).

| Instance | Engine: gap at 20 s / 3 min / 10 min / 20 min | Engine: last improvement | PyVRP: gap at 20 s / 3 min / 10 min / 20 min | PyVRP: last improvement |
|---|---|---|---|---|
| X-n101-k25 | 6.47 / 6.34 / 3.78 / 3.78% | 413 s | 0 / 0 / 0 / 0% | 6 s |
| X-n157-k13 | 3.06 / 2.68 / 1.99 / 0.97% | 1,057 s | 0.11 / 0.11 / 0.10 / 0.01% | 648 s |
| X-n204-k19 | 14.44 / 6.22 / 5.78 / 4.05% | 1,152 s | 1.03 / 0.89 / 0.80 / 0.67% | 634 s |
| Solomon r108 | 10 veh throughout (BKS 9) | 856 s | 9 veh from 20 s; = BKS at 15 min | 775 s |
| Solomon rc201 | 3.31 / 2.62 / 2.62 / 2.62% | **21 s** | 0.47 / 0 / 0 / 0% | 83 s |
| G&H r1_2_1 | 21 veh / 20 veh +5.48 / +4.95 / +2.52% | 855 s | 20 veh +10.22 / +2.53 / +0.73 / +0.73% | 463 s |

NMWC days: the RECOMMENDED search's own best, in OMR before the post-solve stage.

| Day | Run | at 20 s | 150 s | 300 s | 600 s | end | last improvement | search steps | final plan (OMR) |
|---|---|---|---|---|---|---|---|---|---|
| real80 | 10 min | 773.4 | 735.6 | 705.2 | 582.8 | 582.8 | 596 s | 9,924 | 525.45 |
| real80 | 20 min | 773.4 | 735.6 | 688.2 | 553.2 | 553.2 | 571 s | 23,528 | 526.99 |
| syn60_s1 | 20 min | 254.1 | 248.5 | 248.5 | 247.8 | 247.8 | 476 s | 24,832 | 248.21 |
| syn60_s2 | 20 min | 249.1 | 248.3 | 248.3 | 247.5 | 247.5 | 586 s | 24,754 | 247.86 |
| syn60_s3 | 20 min | 215.6 | 215.6 | 215.6 | 212.5 | 212.5 | 318 s | 16,846 | 212.90 |
| syn150_s1 | 20 min | 513.4 | 505.1 | 497.7 | 497.7 | 497.7 | 262 s | 5,299 | 498.52 |
| syn150_s2 | 20 min | 623.0 | 565.1 | 536.5 | 516.9 | 516.9 | 451 s | 6,064 | 517.82 |
| syn150_s3 | 20 min | 547.0 | 523.2 | 499.9 | 492.2 | 492.1 | 1,138 s | 5,016 | 492.97 |
| syn300_s1 | 20 min | 65,998 * | 5,023 * | 1,018.8 | 1,016.4 | 1,014.9 | 1,113 s | 1,829 | 1,016.31 |

\* The large numbers include penalties for stops not yet served (at least 1,000 OMR each). At the automatic 150 s limit on the 300-stop day, the engine's search had not yet served every stop (status `ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED`, 11 stops unserved). The post-solve stage rescued it.

**Convergence summary:**
- **Settled well before 20 minutes:** the 60-stop days and syn150_s1/s2 settled within 4 to 10 minutes. Some public instances settled in seconds (rc201) or about 7 minutes (X-n101-k25).
- **Still improving at the end:** the proven-optimum X instances X-n157-k13 and X-n204-k19, syn150_s3 (slightly), and syn300_s1.
- **PyVRP settles faster and much closer to the optimum.**
- **The search is slow on big NMWC days:** only 1,829 search steps in 20 minutes on 300 stops, against about 17,000 to 25,000 on 60-83 stops.

---

## Part 6. The engine's weaknesses, with evidence

| # | Weakness | Evidence |
|---|---|---|
| W1 | **It rarely removes a truck.** The search only moves between feasible plans. Emptying a truck needs many moves in a row that each look worse, and it cannot move a whole load from one truck to another (see `OPTIMIZER_BENCHMARK.md` §3). | **real80:** the RECOMMENDED search had 13 trucks / 21 loads at 20 s, 7 at 10 min and 6 at 20 min, against a proven minimum of 5. The 5-truck plans came only from the post-solve load repack. **Public window instances:** +1 or +2 vehicles on 5 of 13 at auto; still +1 on r108 at 20 minutes. **Small case:** 12 vehicles against a proven 11 on r101's first 50 customers (PyVRP also missed that one). |
| W2 | **One search, no diversification: it stalls.** Guided local search from one starting plan; OR-Tools routing has no random seed, so re-running changes nothing. | rc201 did not improve from 21 s to 1,200 s. X-n101-k25 did not improve after 413 s. The 10- and 20-minute runs ended on the identical plan on 5 of 8 NMWC days, and 20 minutes was no better on 7 of 8. |
| W3 | **Route quality on capacity-only problems is 3% to 9% off the optimum.** | X set at auto: median +7.05% against PyVRP's +0.61% (Part 3.1). |
| W4 | **Big days: the automatic time is not enough, and the starting strategy matters.** | syn300_s1 at 150 s: the raw search had 11 stops unserved and had not reached a local optimum. The best-known plan (950.83 OMR) came from an older run with a different first-solution strategy (AUTOMATIC); this study's 10-minute run is 4.8% above it. |
| W5 | **More time can give a worse plan.** | syn300_s1: 1,016.31 at 20 minutes against 996.20 at 10 minutes. real80: 526.99 against 525.45. |
| W6 | **The post-solve stage does the heavy lifting on the real day, but its own time cap is not the limit.** | real80 at auto: the RECOMMENDED search reached 773.4 OMR; the final plan (570.8 to 574.0) came from the MIN_DISTANCE option's routes, repacked. Raising the repack's CP-SAT cap from 15 s to 120 s changed real80 by only -0.4% (570.83 → 568.59) and syn300_s1 not at all (`nmwc_diag__*__stagecap.json`). The limit is the routes the search feeds it. |
| W7 | **The status word overstates quality.** | The engine returns status "OPTIMIZED" (OR-Tools: `ROUTING_SUCCESS`) even for the real day at 20 s, which is 9% above the best known plan. Guided local search always ends on its time limit, so the status proves nothing. |

For comparison, PyVRP 0.14's default solver is an iterated local search that allows temporarily infeasible plans with adaptive penalties. That is what lets it empty vehicles and escape local optima.

---

## Part 7. Recommendations, ranked, to get closer to optimal within 20 minutes for night plans

The gains below are **estimates**. Only the evidence column was measured in this study; none of the changes themselves was tried. Each change should be accepted only after it passes the validation protocol at the end of this part.

| Rank | Change | Main evidence | Expected gain (estimate) | Risk | Rough size |
|---|---|---|---|---|---|
| 0 | **Night-plan background job** with its own 20-minute budget, running items 1-6 | API caps `time_limit_sec` at 600 s and the request budget at 540 s; every 600/1,200 s run here was outside the contract | Unlocks the rest. The engine's 600 s setting alone saved 8.3% on real80. In production mode (alternatives side by side) it takes about 16 minutes of wall time, so it fits a 20-minute night budget; 1,200 s would take about 31 minutes | Low to medium: job plumbing and status; the plans themselves are unchanged | Days |
| 1 | **Whole-load moves and truck removal inside the search**: search, repack, warm-start, then try one truck fewer | W1, W6. An earlier harness run (25 Sep, older engine) limited to 5 trucks found a 5-truck / 14-load plan in 30 s, while the unrestricted search stayed at 13 trucks for 2 minutes | Reach the 10- to 20-minute quality on real80-type days in a few minutes, and 1 truck fewer on days where the engine ends above the truck bound. About 2% to 8% where trucks are spare; about 0 where they are not | Low to medium: reuses the engine's own repack, warm start and checks; must never drop a stop to save a truck | 1-2 weeks |
| 2 | **PyVRP 0.14 as a second engine and seed**: its plans go through the engine's post-solve stage (repack, exact timing, score, feasibility) and warm-start OR-Tools | Public sets: 0% to 0.9% from the optimum against 3% to 9%. At the engine's automatic time it beat the engine's 20-minute result on 5 of 6. Earlier NMWC study: 5 trucks / 14 loads on real80 in 30 s | Public evidence suggests 2% to 8% on distance-dominated days. **Unmeasured on NMWC days** until the adapter exists | Medium: a second model to maintain. Preferred windows, P1/P2 early-arrival cost, per-load trip cost and case-dependent loading time are only approximated, but the engine's own score decides, so the result can only get better | 2-3 weeks |
| 3 | **Switch on OR-Tools 9.15's stronger search** (already installed): iterated local search with ruin-and-recreate (SISR string removal, spatially close routes, simulated-annealing or "absences-based" acceptance), the large-neighbourhood operators that are off by default, bandit operator selection, and tuned GLS lambda | W2, W3: stalls after 21 s to 7 min; checked that these parameters exist and are off by default | Unknown for this model, plausibly 1% to 4% on distance | Low: parameter-only, same model, same checks; keep the old settings as fallback | Days (mostly benchmark time) |
| 4 | **Restart portfolio across cores**: different first-solution strategies (PARALLEL_CHEAPEST_INSERTION, AUTOMATIC, SEQUENTIAL_CHEAPEST_INSERTION, SAVINGS) and parameter sets in parallel processes; keep the best by the engine's score | W4: syn300 best known came from AUTOMATIC. Earlier real80 study: SEQUENTIAL_CHEAPEST_INSERTION 12 trucks / 17 loads against 13 / 21 at 30 s | 1% to 5% on large days | Low. Needs 1 core per search; OR-Tools routing is single-threaded | Days |
| 5 | **Incumbent store**: keep the best plan found for the day (any run, any engine), warm-start from it, and never return worse | W5: regressions of 2.0% (syn300) and 0.29% (real80) | Removes regressions of up to 2% | Very low | Days |
| 6 | **Stop on convergence and reinvest the time**: end a search after, for example, no improvement for max(120 s, 25% of elapsed), then start the next portfolio member | 20 minutes no better than 10 on 7 of 8 NMWC days; rc201 flat after 21 s; X-n101-k25 flat after 413 s | No gain alone; gives items 2 to 4 the time they need | Low | Days |
| 7 | **Report the gap to the dispatcher** and stop calling plans "OPTIMIZED" | W7; bounds already exist in the harness | No cost change; honest trust | Low if worded as "at most" (see below); misleading if shown as "the gap" | 1 week |

### Details

**0. Night-plan job.**
- **Today:** the web gives up at 600 s, the solver's request budget is 540 s, and `time_limit_sec` is capped at 600 in `dispatch_models.py`.
- **The change:** a "plan tonight, ready by the morning" job with its own deadline, progress, and the incumbent store (item 5). It needs no change to the daytime path.
- **Time budget today:** a RECOMMENDED limit of L seconds costs about 1.5 × L of wall time in production (RECOMMENDED, then the two alternatives side by side at L/2, then the post-solve stage). So:
  - L = 600 s is about 16 minutes (a 20-minute budget holds it);
  - L = 1,200 s is about 31 minutes.

**1. Whole-load moves and truck removal.**
- **Why:** truck count is the most expensive error (a 10 t truck-day is 35 OMR fixed plus driver pay). The engine already has the pieces:
  - the CP-SAT load repack, which moves whole loads between trucks;
  - a warm start from any plan (`_initial_assignment`: `RoutesToAssignment`, then `SolveFromAssignmentWithParameters`).
- **The loop:**
  1. Search for a short slice (for example 60 s).
  2. Repack the incumbent.
  3. Warm-start the next slice from the repacked plan, with the emptied trucks out of the model.
  4. When the repack cannot empty a truck, try "one truck fewer": remove the truck with the cheapest-to-move loads, reinsert its stops with the search, and keep the plan only if it serves exactly the same stops and scores better.
  5. Spend the rest of the time on distance.
- **Rule that must hold:** strict priorities must hold (never drop a stop to save a truck). That is how MIN_TRUCKS already behaves.

**2. PyVRP as second engine and seed.**
- **Why it can work:**
  - PyVRP 0.14 (MIT licence) supports most of NMWC's structure natively: several truck types, several capacities (cases and kg), hard windows, reload depots with a maximum number of reloads, a depot loading time, shift length with overtime cost, duration cost, fixed cost, and optional stops with prizes (priorities).
  - It runs in its own process, so it does not touch OR-Tools.
  - Its plans are only candidates: the engine re-times, repacks, scores and checks them, and picks by its own score.
- **Caveats:**
  - Preferred windows and P1/P2 early-arrival costs are not native to PyVRP. They must be approximated in PyVRP, or ignored and left to the engine's re-scoring.
  - Priorities must be encoded so that a P1 is never dropped for a P5.
  - `OPTIMIZER_BENCHMARK.md` currently plans to remove PyVRP; this recommendation reverses that decision for night plans only.
  - The public evidence is strong. The NMWC evidence is only the earlier study (older engine, legacy PyVRP, approximate model), so measure it on the 8 NMWC days before relying on it.

**3. Stronger OR-Tools search.**
- **What exists but is off:** in the installed OR-Tools 9.15 these defaults are off (checked in `DefaultRoutingSearchParameters()`):
  - `use_iterated_local_search`;
  - `use_multi_armed_bandit_concatenate_operators`;
  - the path, full-path, TSP and inactive LNS operators;
  - cross-exchange;
  - the expensive-chain and close-nodes insertion LNS.
- **What is at its default:** GLS lambda is 0.1.
- **Why it may help:** iterated local search offers SISR ruin (string removal, a strong recent ruin-and-recreate method for time windows) and an acceptance rule aimed at removing routes.
- **How to adopt:** each is a parameter change on the same model. Adopt only what wins on the harness.

**4. Restart portfolio.**
- **Why vary the settings:** OR-Tools routing is deterministic, so restarts must change the first-solution strategy, the metaheuristic or the parameters.
- **How to run it:** one process per core, each with its own deadline, all feeding the incumbent store.
- **Server sizing:** with a 4-vCPU night server, run RECOMMENDED plus 2 portfolio members plus PyVRP.

**5. Incumbent store.** Keep the best feasible plan per day and version, scored by the engine's own score. Every search warm-starts from it or competes with it, and the job returns the best one. This makes the result monotone in time.

**6. Stop on convergence.** OR-Tools has `improvement_limit_parameters`, or the engine can watch its own at-solution callback, as this harness does. A stopped search is not wasted: its incumbent stays in the store.

**7. Report the gap to the dispatcher.**
- **How to get the bound:** compute a proven lower bound for the night plan in parallel with the search. In this harness:
  - the km LP took 2 to 3 s at 60 stops and 150 to 190 s at 150 stops;
  - on real80 it had not converged after 20 minutes, and on syn300 after 42 minutes, but an unconverged value is still a valid bound;
  - the truck and cost model then takes 1 to 9 s.
- **Suggested wording:**
  - "Plan cost 525.45 OMR. Proven: no plan for today can cost less than 492.79 OMR. This plan is **at most 6.6%** above the best possible."
  - "Searches stopped improving 9 minutes before the deadline; two independent engines agree within 0.3%."
  - On days with many hard windows add: "The true gap is smaller than this figure; the bound does not fully account for delivery windows."
- **Status labels:** replace "OPTIMIZED" with "Improved for N min", and never say "optimal" unless it is proven (small days only).

### Validation protocol for every change

Use this harness, on the same machine, recording machine load. A change is accepted only if all of these hold:
- no NMWC day gets worse;
- the median over the 24 public instances improves;
- every plan is still VERIFIED and evaluator-feasible, with the objective re-scored exactly.

The runs:

| What | Days / instances | Limits | Repeats |
|---|---|---|---|
| NMWC runs (`nmwc_run.py`) | 8 days | auto and 600 s | 2 |
| Public ladder (`ladder.py`) | 24 instances | auto and 180 s | 1 |
| Long runs | 6 instances | 600 s | 1 |
| PyVRP-based changes | as above | as above | 3 seeds |

---

## Part 8. What can and cannot be promised (task 5)

**Cannot be promised: "this plan is optimal" for a full NMWC day.**
- **Our own exact method runs out quickly.** CP-SAT with the engine's exact pricing could not prove some days of only 9 to 10 stops and 2 to 3 trucks optimal in 400 s per phase.
- **The best academic exact methods do not cover NMWC.** Branch-cut-and-price methods prove capacity-only instances of a few hundred customers, often with hours of computing. They do not cover NMWC's combination of reloads, windows, priorities, whole-day driver pay and preference costs.
- **Even the reference solver proves nothing.** PyVRP, the best solver in this study, gives no proof of optimality either.
- **Longer runs are not guaranteed to be better.** On a shared machine a longer search is not even guaranteed to give a better plan (W5).

**Can be promised:**
1. **Feasibility.** Every plan passes the engine's own feasibility report and an independent evaluator. That held for 152 of 152 runs in this study: 120 public and 32 NMWC.
2. **A proven ceiling on the gap for every plan.** For example: the real day at 10 minutes is at most 6.6% above optimal. It is a guarantee in one direction only: the true gap is at most this, and possibly much less.
3. **Proven optimal plans on small days.** On days of up to about 10 stops the engine hit the proven optimum 20 times in 22 (worst miss 0.42%). An exact check can confirm it when there is time.
4. **A measured, repeatable gap to the best published results** on the standard benchmarks, re-run for every engine change. It serves as a regression test with fixed instances, limits and checks.
5. **A second-engine cross-check (after item 2).** When two independent engines agree, that is strong practical evidence that the plan is close to optimal, even without a proof.

---

## Part 9. Details, caveats and reproducibility

### Caveats that affect the numbers

- **Load-dependent timing:** every time-limited result depends on CPU share (0.67 to 0.98 of a core per process here). On an idle or faster server both solvers do better at the same limit.
- **PyVRP used more than one core on three runs:** r1_2_1 at auto and 180 s, and rc108 at auto (2.3 to 2.6 core-seconds per second, probably library threads). Those three PyVRP results may be slightly favoured. PyVRP's r1_2_1 value was reached at 60 s in the separate 20-minute run anyway.
- **One run per limit:** there was one run per instance and limit (seed 1 for PyVRP), except the NMWC automatic runs, which were run twice (spread 0% to 0.5%).
- **NMWC runs used `SOLVER_PARALLEL=0`:**
  - the alternatives ran after RECOMMENDED in the same process, not side by side;
  - the algorithm, limits and warm starts are the same, but the wall time was about 2 × L instead of about 1.5 × L;
  - the request budget was raised to 2 × L + 600 s so that the alternatives and the post-solve stage kept their normal share;
  - the 600 and 1,200 s runs are flagged `beyond_production_contract`.
- **The public ladder ran RECOMMENDED only** (production mode, spawned worker, then the post-solve stage), because the public problems have one objective.
- **The stricter `@scaled` mapping** (5 instances): its gaps partly measure the mapping (Part 3.3).
- **PyVRP on the X set ran in natural units.** The three ×1000-scale results are kept as `*__x1000scale.json`. One 20-minute ×1000 run was stopped after 14 minutes and is logged as failed in `results/ladder/jobs.jsonl`.
- **PyVRP penalty warnings:** PyVRP printed its penalty-bound warning on 10 of 42 window runs, all of which ended feasible. PyVRP may do slightly better in its own native scaling, so on windows it is a conservative reference.
- **Disputed BKS files:** three G&H detailed BKS files are slightly above the SINTEF table value (SINTEF flags them), and one has no detailed file. None of the 24 instances used here is affected.
- **Earlier-study evidence** cited in Part 7 (25 Sep, `.dev/bench/pyvrp/compare.md`) used an older engine version, a legacy PyVRP and an older scoring. It is quoted in trucks / loads / km only, as supporting evidence.

### Integrity checks

- **Public: conversion checked against published solutions.** The evaluator reproduces the published cost of every published solution file, and the engine's model prices every published solution it can hold exactly (`results/proof_engine.json`, `results/proof_pyvrp.json`).
- **Public: all runs clean.** 120 of 120 feasible, objectives match, engine feasibility report VERIFIED 60 of 60 (`results/ladder/ladder_summary.json`).
- **NMWC: every run checked three ways.** On every run the engine's feasibility report says VERIFIED, the independent evaluator (`instances.evaluate`) finds the plan feasible, and re-scoring with `load_repack.time_plan` + `score` equals the reported objective.
- **NMWC: exact models priced like the engine.** They agree with the engine's score to within 0.5 units (0.000005 OMR).
- **Privacy:** real80 appears in aggregates only.

### Files

| File | What it is |
|---|---|
| `REPORT.md` | This report |
| `SOURCES.md`, `CHECKSUMS.sha256`, `bks.json` | Download provenance (URL, size, SHA-256) and the checked best-known solutions |
| `bench_common.py` | Shared file readers, the one integer model, the independent evaluator, gaps, machine context |
| `public_bench.py`, `ref_pyvrp.py`, `exact_tiny.py` | Engine adapter, PyVRP adapter, exact optima of small public cases |
| `ladder.py`, `ladder_engine.py`, `ladder_pyvrp.py`, `ladder_report.py` | Time-ladder runner and report builder |
| `results/ladder/ladder_runs.csv`, `ladder_summary.json`, `ladder_traces.csv`, `load.jsonl`, `jobs.jsonl`, `plan.json` | Public results per run, aggregates, best-so-far traces, machine load, job log, pre-registered plan |
| `results/engine__*`, `results/pyvrp__*`, `results/traces/` | One JSON per run, and trace files |
| `nmwc_run.py`, `nmwc_lb.py`, `nmwc_summary.py`, `nmwc_diag.py`, `exact_nmwc_small.py` | NMWC runs, lower bounds, summary, post-solve cap diagnostic, small-day exact optima |
| `results/nmwc_summary.json`, `nmwc_bounds.json`, `nmwc_known_plans.json`, `nmwc_exact_small.json`, `nmwc_run__*.json`, `nmwc_diag__*.json` | NMWC results (real80: aggregates only) |

### How to re-run

- **Tools:**
  - Engine side: `C:/Users/abdulr/routeiq/apps/solver/.venv/Scripts/python.exe`.
  - PyVRP side: `C:/Users/abdulr/routeiq/.dev/bench/public/venv-ref/Scripts/python.exe`.
- **Public ladder:**
  - `python ladder.py plan|run|status`: two lanes, skips existing results; the file `results/ladder/STOP` halts new jobs.
  - Then `python ladder_report.py`.
- **NMWC:** `python nmwc_run.py run <day> <auto|600|1200> [--tag T]`, then `python nmwc_run.py rescore`, then `python nmwc_summary.py`.
- **Bounds:** `python nmwc_lb.py bounds`.
- **Small exact days:** `python exact_nmwc_small.py 1-20`.
- **Single runs:** `python public_bench.py run solomon/r101 --time-limit 30` (engine) or `ref_pyvrp.py run ...` (PyVRP).

References for the benchmark sets and methods:
- **Benchmark sets:** Solomon (1987), VRPTW benchmark; Gehring & Homberger (1999), extended VRPTW instances; Uchoa et al. (2017), *New benchmark instances for the CVRP* (the X set).
- **Methods:** Wouda, Lan & Kool (2024), *PyVRP: a high-performance VRP solver package*; Christiaens & Vanden Berghe (2020), SISR ruin-and-recreate.
- **Best-known solution tables:** SINTEF TOP and CVRPLIB (URLs in `SOURCES.md`).
