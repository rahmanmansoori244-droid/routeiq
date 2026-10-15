# E2: Small-stop economics

- Commit 6b6de09d576c; written 2026-10-15T03:58:24+00:00.
- Budgets (search seconds per run; the engine's load re-check comes on top): real_sec 20, synthetic_sec 40; seeds [1, 2, 3].
- Machine: 4 CPUs, AMD EPYC 7763 64-Core Processor; Python 3.11.17; OR-Tools 9.15.675.
- Items done 54/54; compute 41.9 min (sum of item wall times); wall time 125.7 min (first start to last finish); lanes 0/4, 1/4, 2/4, 3/4.
- Every compared run has the same budget (search seconds, QUICK, RECOMMENDED only) and runs alone in its lane's process (SOLVER_PARALLEL=0). Production also runs the second route search (PyVRP); it is off here (SOLVER_PYVRP=off) so that every run gets the same single-core search.
- Distances are HAVERSINE estimates (estimated km). Plans are the best found in the time given, not proven optimal; only E5's oracle proves optimality, on the instances it enumerates completely. Cash is OMR (costing.truck_day_costs); solver penalties are ARTIFICIAL and never added to cash.

Every small stop gets the exact fixed-plan removal estimate, the combine and move checks and an action; the costliest are also re-optimized without the stop for every seed. No margins are invented: without DispatchStop.margin a break-even margin needs a next-day plan; here the future cost is the labelled PROXY (today's cost reused), so none is given.

IVMS-derived parameters used (committed aggregates of the owner's IVMS report and the 13 Oct truck evidence):
- small drops (under 50 cases) on site p25/p50/p75 9.8/16/29 min
- customers get a delivery every 5 days (median)

## REAL-15OCT: REAL, anonymised; 86 stops, 12 trucks

Budget 20 s QUICK per run, seeds [1, 2, 3]. 4 small stops (3 cases or fewer); the day re-optimized without each of the 8 costliest by fixed-plan saving. Reference plan: seed 1.

**Baseline:** cash 534.35 [500.48..585.64] OMR; stops served 84.3 [84.0..85.0] of 86. Seed spread: cash 85.16 OMR.

Actions: SERVE 4.

| stop | P | cases | late order | fixed-plan cash saved OMR | paid driver min freed | est. km freed | ARTIFICIAL penalty if left out | re-optimized: cash saved OMR, all seeds | like-for-like seeds: cash saved OMR | search noise OMR | re-opt decides | action |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| stop-041 | 3 | 3 | yes | 0.91 | 17 | 1.60 | +3000 | -109.48 [-157.23..-29.25] | none (0/3) | 197.88 | no | SERVE |
| stop-035 | 3 | 3 | yes | 0.72 | 16 | 0.56 | +3000 | -3.54 [-57.28..+56.89] | none (0/3) | 85.16 | no | SERVE |
| stop-069 | 3 | 3 | yes | 0.65 | 13 | 0.82 | +3000 | -31.30 [-103.63..+26.12] | none (0/3) | 113.30 | no | SERVE |
| stop-027 | 3 | 1 | yes | 0.63 | 15 | 0.04 | +3000 | -44.06 [-171.45..+35.65] | +3.63 (1/3) | 158.63 | no | SERVE |

Fixed-plan: the stop taken out of the reference plan and the plan re-timed exactly (no search noise). Re-optimized: the whole day solved again without the stop, minus the baseline, paired per seed; like-for-like seeds serve the same other stops. It decides only when every like-for-like saving beats the fixed-plan estimate by more than the search noise. Cash in OMR; the penalty is the solver's ARTIFICIAL price, not money.

Reasons:

- stop-041 SERVE: late order: always served; serving it costs 0.91 OMR cash today (fixed plan)
- stop-035 SERVE: late order: always served; serving it costs 0.72 OMR cash today (fixed plan)
- stop-069 SERVE: late order: always served; serving it costs 0.65 OMR cash today (fixed plan)
- stop-027 SERVE: late order: always served; serving it costs 0.63 OMR cash today (fixed plan)

## SYNTH-320: SYNTHETIC; 185 stops, 13 trucks

Budget 40 s QUICK per run, seeds [1, 2, 3]. 25 small stops (3 cases or fewer); the day re-optimized without each of the 8 costliest by fixed-plan saving. Reference plan: seed 1.

**Baseline:** cash 667.50 [636.90..685.01] OMR; stops served 181.7 [178.0..184.0] of 185. Seed spread: cash 48.10 OMR.

Actions: COMBINE 1, REVIEW 1, SERVE 23.

Invoices: 80 of 320 are small: 25 in small stops of their own, 55 inside larger stops of the same customer.

| stop | P | cases | late order | fixed-plan cash saved OMR | paid driver min freed | est. km freed | ARTIFICIAL penalty if left out | re-optimized: cash saved OMR, all seeds | like-for-like seeds: cash saved OMR | search noise OMR | re-opt decides | action |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| stop-001 | 5 | 1 | no | 0.46 | 11 | 0.02 | +1000 | - | - | - | - | SERVE |
| stop-002 | 3 | 3 | no | 1.32 | 12 | 0.07 | +1026000 | +1.20 [-9.27..+12.87] | -9.27 (1/3) | 52.95 | no | SERVE |
| stop-003 | 3 | 3 | no | 14.96 | 160 | 78.86 | +1026000 | +14.98 [-0.00..+29.32] | +15.60 (1/3) | 48.10 | no | SERVE |
| stop-004 | 4 | 3 | no | 0.53 | 12 | 0.16 | +38000 | - | - | - | - | SERVE |
| stop-005 | 5 | 1 | no | 1.28 | 11 | 0.33 | +1000 | - | - | - | - | SERVE |
| stop-006 | 5 | 3 | no | - | - | - | - | - | - | - | - | REVIEW |
| stop-007 | 3 | 1 | no | 0.51 | 12 | 0.29 | +1026000 | - | - | - | - | SERVE |
| stop-008 | 3 | 3 | no | 1.40 | 12 | 0.36 | +1026000 | +0.91 [-9.17..+11.89] | -9.17 (1/3) | 52.85 | no | SERVE |
| stop-020 | 3 | 2 | no | 1.31 | 12 | 0.03 | +1026000 | - | - | - | - | SERVE |
| stop-051 | 2 | 1 | no | 0.92 | 8 | 0.17 | +75924000 | - | - | - | - | SERVE |
| stop-055 | 5 | 2 | no | 0.58 | 13 | 0.39 | +1000 | - | - | - | - | SERVE |
| stop-057 | 5 | 2 | no | 0.65 | 14 | 0.72 | +1000 | - | - | - | - | COMBINE |
| stop-063 | 3 | 2 | no | 0.51 | 12 | 0.07 | +1026000 | - | - | - | - | SERVE |
| stop-067 | 3 | 2 | no | 1.10 | 9 | 0.40 | +1026000 | - | - | - | - | SERVE |
| stop-092 | 2 | 2 | no | 1.00 | 9 | 0.12 | +75924000 | - | - | - | - | SERVE |
| stop-099 | 2 | 1 | no | 0.90 | 9 | 0.12 | +75924000 | - | - | - | - | SERVE |
| stop-101 | 3 | 3 | no | 1.89 | 21 | 0.08 | +1026000 | -17.18 [-45.92..+14.44] | none (0/3) | 48.10 | no | SERVE |
| stop-132 | 3 | 1 | no | 1.34 | 12 | 0.56 | +1026000 | +0.78 [-29.86..+24.27] | none (0/3) | 48.10 | no | SERVE |
| stop-133 | 4 | 1 | no | 0.48 | 11 | 0.08 | +38000 | - | - | - | - | SERVE |
| stop-135 | 3 | 2 | no | 0.50 | 12 | 0.01 | +1026000 | - | - | - | - | SERVE |
| stop-143 | 2 | 2 | no | 2.57 | 25 | 2.45 | +75924000 | +9.68 [-34.91..+35.66] | +35.66 (1/3) | 48.10 | no | SERVE |
| stop-165 | 3 | 3 | no | 1.82 | 15 | 1.96 | +1026000 | +1.30 [-21.59..+13.24] | none (0/3) | 48.10 | no | SERVE |
| stop-171 | 4 | 1 | no | 0.53 | 12 | 0.26 | +38000 | - | - | - | - | SERVE |
| stop-174 | 3 | 1 | no | 0.47 | 11 | 0.05 | +1026000 | - | - | - | - | SERVE |
| stop-182 | 5 | 3 | no | 1.39 | 12 | 0.29 | +1000 | +15.88 [-3.26..+26.99] | none (0/3) | 48.10 | no | SERVE |

Fixed-plan: the stop taken out of the reference plan and the plan re-timed exactly (no search noise). Re-optimized: the whole day solved again without the stop, minus the baseline, paired per seed; like-for-like seeds serve the same other stops. It decides only when every like-for-like saving beats the fixed-plan estimate by more than the search noise. Cash in OMR; the penalty is the solver's ARTIFICIAL price, not money.

Reasons:

- stop-001 SERVE: already rides with stop-004 (0.5 km) on its load; defer saves 0.46 OMR (fixed plan), not clearly more than future cost 0.46 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
- stop-002 SERVE: re-optimization not used: 1 like-for-like seed(s): too few to tell a saving from search noise; already rides with stop-005 (0.26 km) on its load; defer saves 1.32 OMR (fixed plan), not clearly more than future cost 1.32 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
- stop-003 SERVE: re-optimization not used: 1 like-for-like seed(s): too few to tell a saving from search noise; defer saves 14.96 OMR (fixed plan), not clearly more than future cost 14.96 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
- stop-004 SERVE: already rides with stop-007 (0.25 km) on its load; defer saves 0.53 OMR (fixed plan), not clearly more than future cost 0.53 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
- stop-005 SERVE: already rides with stop-002 (0.26 km) on its load; defer saves 1.28 OMR (fixed plan), not clearly more than future cost 1.28 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
- stop-006 REVIEW: the plan leaves it out: no exactly timed place found in the plan; never deleted, needs a dispatcher's decision
- stop-007 SERVE: already rides with stop-004 (0.25 km) on its load; defer saves 0.51 OMR (fixed plan), not clearly more than future cost 0.51 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
- stop-008 SERVE: re-optimization not used: 1 like-for-like seed(s): too few to tell a saving from search noise; already rides with stop-002 (0.26 km) on its load; defer saves 1.40 OMR (fixed plan), not clearly more than future cost 1.40 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
- stop-020 SERVE: already rides with stop-072 (0.14 km) on its load; defer saves 1.31 OMR (fixed plan), not clearly more than future cost 1.31 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
- stop-051 SERVE: P2: always served; serving it costs 0.92 OMR cash today (fixed plan)
- stop-055 SERVE: already rides with stop-048 (0.43 km) on its load; defer saves 0.58 OMR (fixed plan), not clearly more than future cost 0.58 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
- stop-057 COMBINE: on truck-06 load 2 next to stop-116 (1.35 km) it costs -0.14 OMR cash against today's placement
- stop-063 SERVE: already rides with stop-135 (0.05 km) on its load; defer saves 0.51 OMR (fixed plan), not clearly more than future cost 0.51 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
- stop-067 SERVE: already rides with stop-121 (0.49 km) on its load; defer saves 1.10 OMR (fixed plan), not clearly more than future cost 1.10 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
- stop-092 SERVE: P2: always served; serving it costs 1.00 OMR cash today (fixed plan)
- stop-099 SERVE: P2: always served; serving it costs 0.90 OMR cash today (fixed plan)
- stop-101 SERVE: re-optimization not used: 0 like-for-like seed(s): too few to tell a saving from search noise; already rides with stop-180 (0.81 km) on its load; defer saves 1.89 OMR (fixed plan), not clearly more than future cost 1.89 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
- stop-132 SERVE: re-optimization not used: 0 like-for-like seed(s): too few to tell a saving from search noise; already rides with stop-161 (0.86 km) on its load; defer saves 1.34 OMR (fixed plan), not clearly more than future cost 1.34 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
- stop-133 SERVE: already rides with stop-071 (0.81 km) on its load; defer saves 0.48 OMR (fixed plan), not clearly more than future cost 0.48 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
- stop-135 SERVE: already rides with stop-063 (0.05 km) on its load; defer saves 0.50 OMR (fixed plan), not clearly more than future cost 0.50 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
- stop-143 SERVE: P2: always served; serving it costs 2.57 OMR cash today (fixed plan)
- stop-165 SERVE: re-optimization not used: 0 like-for-like seed(s): too few to tell a saving from search noise; already rides with stop-069 (0.79 km) on its load; defer saves 1.82 OMR (fixed plan), not clearly more than future cost 1.82 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
- stop-171 SERVE: already rides with stop-102 (0.18 km) on its load; defer saves 0.53 OMR (fixed plan), not clearly more than future cost 0.53 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
- stop-174 SERVE: already rides with stop-035 (0.53 km) on its load; defer saves 0.47 OMR (fixed plan), not clearly more than future cost 0.47 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
- stop-182 SERVE: re-optimization not used: 0 like-for-like seed(s): too few to tell a saving from search noise; already rides with stop-140 (0.7 km) on its load; defer saves 1.39 OMR (fixed plan), not clearly more than future cost 1.39 (PROXY); no break-even margin: the future cost is a PROXY (today's cost reused), so whether a deferral pays cannot be judged without a next-day plan
