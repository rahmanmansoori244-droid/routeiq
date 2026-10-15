# E3: Dynamic re-planning policies

- Commit 6b6de09d576c; written 2026-10-15T03:58:28+00:00.
- Budgets (search seconds per run; the engine's load re-check comes on top): real_sec 20, synthetic_sec 40, replan_sec 10; seeds [1].
- Machine: 4 CPUs, AMD EPYC 7763 64-Core Processor; Python 3.11.17; OR-Tools 9.15.675.
- Items done 26/26; compute 56.9 min (sum of item wall times); wall time 137.1 min (first start to last finish); lanes 0/4, 1/4, 2/4, 3/4.
- Every compared run has the same budget (search seconds, QUICK, RECOMMENDED only) and runs alone in its lane's process (SOLVER_PARALLEL=0). Production also runs the second route search (PyVRP); it is off here (SOLVER_PYVRP=off) so that every run gets the same single-core search.
- Distances are HAVERSINE estimates (estimated km). Plans are the best found in the time given, not proven optimal; only E5's oracle proves optimality, on the instances it enumerates completely. Cash is OMR (costing.truck_day_costs); solver penalties are ARTIFICIAL and never added to cash.

The simulator samples actual travel and unloading times per world and reveals each event only when it happens (no future information). The world model and its IVMS time-of-day factors are below.

IVMS-derived parameters used (committed aggregates of the owner's IVMS report and the 13 Oct truck evidence):
- world model: travel x lognormal(median 1.0, sigma 0.373), unloading x lognormal(median 1.0, sigma 0.501); medians are labelled defaults
- IVMS time-of-day travel factors: 06-09 0.77, 09-12 1.017, 12-15 1.033, 15-18 0.892, 18-22 1.148, 22-06 1.359

## SYNTH-280: SYNTHETIC: 280 invoices (seed 1), 147 stops known in the morning + 15 late orders revealed 08:30-13:00; 11 trucks

Worlds [1, 2, 3, 4, 5]; morning plan 40 s, each re-plan 10 s (QUICK, solver seed 1). Morning plan: 133 of 147 stops on 19 loads, 11 trucks, planned cash 564.49 OMR, VERIFIED.

| metric, mean [min..max] over the worlds | A: static: the morning plan, executed as is (never serves an order revealed later, never retries a stop the morning plan left out) | B: re-plan at each depot return | C: event-triggered: depot return, delay over the threshold, new order |
|---|---|---|---|
| stops served | 133.0 | 144.6 [141.0..149.0] | 144.6 [139.0..148.0] |
| morning stops served | 133.0 | 130.0 [127.0..134.0] | 130.4 [127.0..133.0] |
| new orders served | 0.0 | 14.6 [14.0..15.0] | 14.2 [12.0..15.0] |
| stops unserved | 29.0 | 17.4 [13.0..21.0] | 17.4 [14.0..23.0] |
| late stops (after the genuine closing time) | 10.6 [9.0..13.0] | 6.2 [5.0..9.0] | 5.6 [4.0..8.0] |
| late minutes | 641 [373..843] | 294 [80..486] | 273 [103..459] |
| sales-preference windows missed, inside the genuine hours | 4.2 [3.0..6.0] | 3.2 [1.0..5.0] | 3.2 [1.0..5.0] |
| returns after the limit | 3.4 [1.0..5.0] | 4.0 [2.0..6.0] | 3.8 [3.0..5.0] |
| late breaks | 7.6 [6.0..10.0] | 6.2 [5.0..8.0] | 5.6 [4.0..7.0] |
| missing breaks | 0.0 | 0.4 [0.0..1.0] | 0.4 [0.0..1.0] |
| cash OMR (the executed day) | 651.00 [615.04..690.00] | 678.38 [643.66..711.02] | 666.66 [647.34..678.18] |
| cash OMR per case served | 0.076 [0.072..0.081] | 0.082 [0.080..0.087] | 0.081 [0.076..0.087] |
| estimated km | 1011.6 | 1152.0 [1075.0..1297.6] | 1131.6 [1076.0..1233.4] |
| loads | 19.0 | 19.2 [18.0..21.0] | 19.6 [18.0..21.0] |
| overtime min | 783 [469..1120] | 834 [544..1077] | 749 [608..900] |
| re-plans that searched | 0.0 | 8.4 [7.0..10.0] | 37.0 [31.0..40.0] |
| re-plans with nothing to plan | 0.0 | 10.8 [10.0..11.0] | 15.4 [13.0..19.0] |
| stop moves | 0.0 | 32.0 [19.0..45.0] | 75.2 [30.0..112.0] |
| distinct stops moved | 0.0 | 20.6 [16.0..23.0] | 32.8 [19.0..41.0] |
| truck changes | 0.0 | 28.4 [19.0..39.0] | 57.6 [25.0..84.0] |
| solver seconds | 0 | 85 [70..101] | 373 [313..402] |

Paired against A (same world), mean [min..max]:

| policy | Δ stops served | Δ morning stops served | Δ late stops | Δ cash OMR | Δ estimated km | distinct stops moved |
|---|---|---|---|---|---|---|
| B | +11.6 [+8.0..+16.0] | -3.0 [-6.0..+1.0] | -4.4 [-8.0..-2.0] | +27.39 [-11.56..+95.98] | +140.5 [+63.4..+286.1] | 20.6 [16.0..23.0] |
| C | +11.6 [+6.0..+15.0] | -2.6 [-6.0..+0.0] | -5.0 [-9.0..-2.0] | +15.66 [-11.81..+56.42] | +120.0 [+64.4..+221.8] | 32.8 [19.0..41.0] |

SIMULATION (no future information; distances are estimated km). Cash: OMR cash of the executed day (costing.truck_day_costs on actual times and estimated km), every load of the day. Late: minutes after the genuine closing time (window_rule), still delivered: the window as sent, except a SALES_PREFERENCE window, measured against the customer's genuine hours (a missed preference is counted apart); without window labels (a real day) every window counts as genuine. Only beyond 0.5 min, the plan's whole-minute resolution. Re-plans: re-plans that searched; those with nothing to plan (NOTHING_TO_PLAN) are counted as skipped. Stop moves counts every move, distinct stops moved each stop once. Every re-plan is checked by feasibility.check_scenario. Policy A never serves an order revealed after the morning plan: it is not today's practice, where a late order can be added by hand.

## REAL-15OCT: REAL, anonymised: 86 stops, no new orders; 12 trucks

Worlds [1, 2, 3]; morning plan 20 s, each re-plan 10 s (QUICK, solver seed 1). Morning plan: 85 of 86 stops on 14 loads, 10 trucks, planned cash 540.38 OMR, VERIFIED.

| metric, mean [min..max] over the worlds | A: static: the morning plan, executed as is (never serves an order revealed later, never retries a stop the morning plan left out) | B: re-plan at each depot return | C: event-triggered: depot return, delay over the threshold, new order |
|---|---|---|---|
| stops served | 85.0 | 82.7 [82.0..84.0] | 83.0 [82.0..84.0] |
| morning stops served | 85.0 | 82.7 [82.0..84.0] | 83.0 [82.0..84.0] |
| new orders served | 0.0 | 0.0 | 0.0 |
| stops unserved | 1.0 | 3.3 [2.0..4.0] | 3.0 [2.0..4.0] |
| late stops (after the genuine closing time) | 15.7 [10.0..20.0] | 10.3 [8.0..12.0] | 10.3 [8.0..12.0] |
| late minutes | 786 [340..1054] | 486 [196..761] | 486 [196..761] |
| sales-preference windows missed, inside the genuine hours | 0.0 | 0.0 | 0.0 |
| returns after the limit | 2.0 [1.0..3.0] | 2.0 [1.0..3.0] | 2.3 [2.0..3.0] |
| late breaks | 3.3 [3.0..4.0] | 2.7 [2.0..3.0] | 2.7 [2.0..3.0] |
| missing breaks | 2.3 [1.0..4.0] | 1.3 [0.0..3.0] | 1.3 [0.0..3.0] |
| cash OMR (the executed day) | 577.77 [570.52..587.26] | 583.63 [561.24..608.14] | 621.06 [581.80..673.23] |
| cash OMR per case served | 0.073 [0.072..0.074] | 0.078 [0.074..0.081] | 0.080 [0.074..0.087] |
| estimated km | 1066.8 | 1090.4 [1030.5..1206.3] | 1098.8 [1034.3..1206.3] |
| loads | 14.0 | 14.0 [13.0..15.0] | 14.7 [14.0..15.0] |
| overtime min | 186 [79..316] | 145 [59..307] | 145 [59..307] |
| re-plans that searched | 0.0 | 6.0 [4.0..8.0] | 17.0 [14.0..19.0] |
| re-plans with nothing to plan | 0.0 | 8.0 [6.0..9.0] | 13.0 [9.0..16.0] |
| stop moves | 0.0 | 8.7 [1.0..17.0] | 15.0 [8.0..20.0] |
| distinct stops moved | 0.0 | 4.3 [1.0..7.0] | 6.3 [3.0..9.0] |
| truck changes | 0.0 | 8.7 [1.0..17.0] | 15.0 [8.0..20.0] |
| solver seconds | 0 | 77 [54..100] | 229 [174..269] |

Paired against A (same world), mean [min..max]:

| policy | Δ stops served | Δ morning stops served | Δ late stops | Δ cash OMR | Δ estimated km | distinct stops moved |
|---|---|---|---|---|---|---|
| B | -2.3 [-3.0..-1.0] | -2.3 [-3.0..-1.0] | -5.3 [-9.0..-2.0] | +5.86 [-14.29..+37.62] | +23.5 [-36.4..+139.5] | 4.3 [1.0..7.0] |
| C | -2.0 [-3.0..-1.0] | -2.0 [-3.0..-1.0] | -5.3 [-9.0..-2.0] | +43.28 [-5.46..+97.70] | +32.0 [-32.6..+139.5] | 6.3 [3.0..9.0] |

SIMULATION (no future information; distances are estimated km). Cash: OMR cash of the executed day (costing.truck_day_costs on actual times and estimated km), every load of the day. Late: minutes after the genuine closing time (window_rule), still delivered: the window as sent, except a SALES_PREFERENCE window, measured against the customer's genuine hours (a missed preference is counted apart); without window labels (a real day) every window counts as genuine. Only beyond 0.5 min, the plan's whole-minute resolution. Re-plans: re-plans that searched; those with nothing to plan (NOTHING_TO_PLAN) are counted as skipped. Stop moves counts every move, distinct stops moved each stop once. Every re-plan is checked by feasibility.check_scenario. Policy A never serves an order revealed after the morning plan: it is not today's practice, where a late order can be added by hand.
