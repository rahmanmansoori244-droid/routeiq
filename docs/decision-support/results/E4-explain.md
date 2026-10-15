# E4: Verdicts, ranked relaxations and the trade-off frontier

- Commit 6b6de09d576c; written 2026-10-15T03:58:29+00:00.
- Budgets (search seconds per run; the engine's load re-check comes on top): real_sec 20, synthetic_sec 40; seeds [1, 2, 3].
- Machine: 4 CPUs, AMD EPYC 7763 64-Core Processor; Python 3.11.17; OR-Tools 9.15.675.
- Items done 84/84; compute 104.0 min (sum of item wall times); wall time 52.2 min (first start to last finish); lanes 0/4, 1/4, 2/4, 3/4.
- Every compared run has the same budget (search seconds, QUICK, RECOMMENDED only) and runs alone in its lane's process (SOLVER_PARALLEL=0). Production also runs the second route search (PyVRP); it is off here (SOLVER_PYVRP=off) so that every run gets the same single-core search.
- Distances are HAVERSINE estimates (estimated km). Plans are the best found in the time given, not proven optimal; only E5's oracle proves optimality, on the instances it enumerates completely. Cash is OMR (costing.truck_day_costs); solver penalties are ARTIFICIAL and never added to cash.

REAL-15OCT-PREFIX is the 94-stop request that hit the bug fixed in PR #71, solved by today's engine. SYNTH-320-TIGHT is SYNTH-320 with every hypermarket window closing 60 min earlier.

IVMS-derived parameters used (committed aggregates of the owner's IVMS report and the 13 Oct truck evidence):
- best-quartile unloading 39% shorter than the median (422 GPS visits; the basis of the faster-unloading levers, which still REQUIRE EVIDENCE)
- evening / night drive speed factor 0.839 / 0.708 x day speed (IVMS MOVING segments, Muscat)

## REAL-15OCT-PREFIX: REAL, anonymised; 94 stops, 9 trucks

Budget 20 s QUICK per run, seeds [1, 2, 3]. Verdicts per seed: SEARCH_FAILURE, SEARCH_FAILURE, SEARCH_FAILURE. Candidates: windows +10/+30 min for up to 3 stops left out, +1 load on up to 2 trucks, a hired truck, shift +30 min (HYPOTHETICAL), faster unloading (REQUIRES EVIDENCE).

No real window has a provenance label today (RouteIQ records none), so every real window is UNKNOWN. The window levers on a real day are HYPOTHETICAL: they show what flexing would do if those windows turned out to be sales preferences. Hire options: the trucks REAL-15OCT had and this request lacks (hired on 15 Oct), 3 of them, anonymous. A hire variant also runs the engine's own hire check (extra solves), as in production.

### Verdicts

Seed 1: **SEARCH_FAILURE** (RECOMMENDED: OPTIMIZED, ROUTING_SUCCESS, solved in 96.5 s with the load re-check, search limit 20 s; 84 of 94 stops served). 10 stop(s) left out without a proof, not proven impossible: a longer search, a relaxation or a change could serve it.

| stop | P | cases | verdict | proof | checked | note |
|---|---|---|---|---|---|---|
| stop-002 | 3 | 600 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it; 2 lower-priority stop(s) are served |
| stop-014 | 3 | 488 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it; 2 lower-priority stop(s) are served |
| stop-017 | 3 | 191 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it; 2 lower-priority stop(s) are served |
| stop-048 | 3 | 600 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it; 2 lower-priority stop(s) are served |
| stop-052 | 3 | 2 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly); 2 lower-priority stop(s) are served |
| stop-057 | 3 | 20 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly); 2 lower-priority stop(s) are served |
| stop-061 | 2 | 1000 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly); 48 lower-priority stop(s) are served |
| stop-077 | 3 | 60 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly); 2 lower-priority stop(s) are served |
| stop-091 | 3 | 6 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it; 2 lower-priority stop(s) are served |
| stop-093 | 3 | 100 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly); 2 lower-priority stop(s) are served |

Seed 2: **SEARCH_FAILURE** (RECOMMENDED: OPTIMIZED, ROUTING_SUCCESS, solved in 91.4 s with the load re-check, search limit 20 s; 84 of 94 stops served). 10 stop(s) left out without a proof, not proven impossible: a longer search, a relaxation or a change could serve it.

| stop | P | cases | verdict | proof | checked | note |
|---|---|---|---|---|---|---|
| stop-002 | 3 | 600 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it; 1 lower-priority stop(s) are served |
| stop-014 | 3 | 488 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it; 1 lower-priority stop(s) are served |
| stop-017 | 3 | 191 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it; 1 lower-priority stop(s) are served |
| stop-040 | 3 | 30 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly); 1 lower-priority stop(s) are served |
| stop-048 | 3 | 600 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it; 1 lower-priority stop(s) are served |
| stop-075 | 3 | 80 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly); 1 lower-priority stop(s) are served |
| stop-077 | 3 | 60 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly); 1 lower-priority stop(s) are served |
| stop-091 | 3 | 6 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly); 1 lower-priority stop(s) are served |
| stop-092 | 4 | 30 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly) |
| stop-093 | 3 | 100 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly); 1 lower-priority stop(s) are served |

Seed 3: **SEARCH_FAILURE** (RECOMMENDED: OPTIMIZED, ROUTING_SUCCESS, solved in 96.5 s with the load re-check, search limit 20 s; 78 of 94 stops served). 16 stop(s) left out without a proof, not proven impossible: a longer search, a relaxation or a change could serve it.

| stop | P | cases | verdict | proof | checked | note |
|---|---|---|---|---|---|---|
| stop-002 | 3 | 600 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it |
| stop-010 | 3 | 30 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly) |
| stop-014 | 3 | 488 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it |
| stop-017 | 3 | 191 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it |
| stop-019 | 3 | 290 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly) |
| stop-026 | 3 | 59 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly) |
| stop-042 | 3 | 6 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly) |
| stop-048 | 3 | 600 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it |
| stop-050 | 4 | 50 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly) |
| stop-070 | 3 | 100 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly) |
| stop-075 | 3 | 80 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly) |
| stop-077 | 3 | 60 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly) |
| stop-078 | 3 | 100 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly) |
| stop-083 | 3 | 5 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly) |
| stop-091 | 3 | 6 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it |
| stop-092 | 4 | 30 | SEARCH_FAILURE | - (TIMING) | - | not proven impossible: a longer search, a relaxation or a change could serve it (cut when its truck's loads were timed exactly) |

### Conflicts of the stops left out

- stop-002 (P3, 600 cases, window 08:30-11:30 UNKNOWN): can be served on its own; earliest arrival 08:19; size 5.4 pallets vs largest 12.0; round trip 289 min, fits the shift; any truck. Nearby: truck-09 load 1 (stop-008, 4.1 km): 0.42 pallets left (too little), 55 min left, detour +191 min, misses its window.
- stop-010 (P3, 30 cases, window 11:00-15:00 UNKNOWN): can be served on its own; earliest arrival 07:38; size 0.21 pallets vs largest 12.0; round trip 39 min, fits the shift; any truck. Nearby: truck-02 load 1 (stop-059, 0.2 km): 0.03 pallets left (too little), 174 min left, detour +164 min; truck-07 load 2 (stop-087, 0.8 km): -0.49 pallets left (too little), 246 min left, detour +26 min; truck-06 load 1 (stop-032, 1.7 km): 1.56 pallets left, 180 min left, detour +28 min; truck-09 load 1 (stop-076, 2.4 km): 1.43 pallets left, 126 min left, detour +27 min, misses its window; truck-07 load 1 (stop-086, 2.8 km): 6.9 pallets left, 0 min left, detour +150 min.
- stop-014 (P3, 488 cases, window 08:00-17:00 UNKNOWN): can be served on its own; earliest arrival 09:38; size 4.4 pallets vs largest 12.0; round trip 419 min, fits the shift; any truck. Nearby: truck-02 load 1 (stop-042, 2.4 km): 0.64 pallets left (too little), 106 min left, detour +166 min.
- stop-017 (P3, 191 cases, window 06:00-18:00 UNKNOWN): can be served on its own; earliest arrival 09:16; size 2.0 pallets vs largest 12.0; round trip 275 min, fits the shift; any truck. Nearby: truck-09 load 1 (stop-049, 0.1 km): 0.42 pallets left (too little), 55 min left, detour +64 min.
- stop-019 (P3, 290 cases, window 08:00-16:00 UNKNOWN): can be served on its own; earliest arrival 07:41; size 2.8 pallets vs largest 12.0; round trip 116 min, fits the shift; any truck. Nearby: truck-07 load 1 (stop-066, 0.4 km): 6.9 pallets left, 0 min left, detour +95 min; truck-02 load 1 (stop-084, 0.8 km): 0.03 pallets left (too little), 174 min left, detour +95 min; truck-03 load 1 (stop-021, 0.9 km): 2.84 pallets left, 130 min left, detour +96 min, misses its window; truck-06 load 1 (stop-065, 1.8 km): 1.56 pallets left (too little), 180 min left, detour +97 min; truck-09 load 1 (stop-022, 4.1 km): 1.43 pallets left (too little), 126 min left, detour +106 min.
- stop-026 (P3, 59 cases, window 09:00-16:00 UNKNOWN): can be served on its own; earliest arrival 07:41; size 0.69 pallets vs largest 12.0; round trip 52 min, fits the shift; any truck. Nearby: truck-06 load 1 (stop-065, 0.6 km): 1.56 pallets left, 180 min left, detour +31 min; truck-02 load 1 (stop-084, 0.7 km): 0.03 pallets left (too little), 174 min left, detour +32 min; truck-03 load 1 (stop-021, 0.7 km): 2.84 pallets left, 130 min left, detour +32 min, misses its window; truck-07 load 1 (stop-066, 1.2 km): 6.9 pallets left, 0 min left, detour +32 min; truck-07 load 2 (stop-087, 3.6 km): -0.49 pallets left (too little), 246 min left, detour +40 min.
- stop-040 (P3, 30 cases, window 16:00-19:00 UNKNOWN): can be served on its own; earliest arrival 09:12; size 0.46 pallets vs largest 12.0; round trip 228 min, fits the shift; any truck. Nearby: truck-04 load 1 (stop-049, 2.3 km): 0.39 pallets left (too little), 98 min left, detour +141 min.
- stop-042 (P3, 6 cases, window 08:00-17:00 UNKNOWN): can be served on its own; earliest arrival 09:39; size 0.06 pallets vs largest 12.0; round trip 275 min, fits the shift; any truck. Nearby: truck-09 load 1 (stop-015, 1.0 km): 1.43 pallets left, 126 min left, detour +18 min.
- stop-048 (P3, 600 cases, window 08:00-14:00 UNKNOWN): can be served on its own; earliest arrival 08:05; size 5.4 pallets vs largest 6.0; round trip 260 min, fits the shift; only truck-02, truck-04, truck-05, truck-09. Nearby: truck-02 load 1 (stop-081, 0.8 km): 0.64 pallets left (too little), 106 min left, detour +192 min; truck-04 load 1 (stop-047, 1.4 km): 0.13 pallets left (too little), 2 min left, detour +193 min; truck-08 load 1 (stop-068, 1.6 km): 0.9 pallets left (too little), 128 min left, detour +194 min, misses its window.
- stop-050 (P4, 50 cases, window 08:00-16:00 UNKNOWN): can be served on its own; earliest arrival 07:58; size 0.52 pallets vs largest 12.0; round trip 85 min, fits the shift; any truck. Nearby: truck-01 load 1 (stop-007, 0.1 km): 1.87 pallets left, 122 min left, detour +29 min; truck-04 load 2 (stop-012, 1.4 km): 0.48 pallets left (too little), 59 min left, detour +31 min; truck-05 load 1 (stop-051, 3.1 km): 0.06 pallets left (too little), 159 min left, detour +32 min.
- stop-052 (P3, 2 cases, window 09:00-15:00 UNKNOWN): can be served on its own; earliest arrival 08:07; size 0.01 pallets vs largest 6.0; round trip 90 min, fits the shift; only truck-02, truck-04, truck-05, truck-09. Nearby: truck-02 load 1 (stop-069, 1.9 km): 0.64 pallets left, 106 min left, detour +19 min; truck-08 load 1 (stop-068, 2.2 km): 0.9 pallets left (too little), 128 min left, detour +23 min; truck-04 load 1 (stop-079, 3.8 km): 0.13 pallets left, 2 min left, detour +27 min.
- stop-057 (P3, 20 cases, window 09:00-15:00 UNKNOWN): can be served on its own; earliest arrival 08:04; size 0.21 pallets vs largest 6.0; round trip 89 min, fits the shift; only truck-02, truck-04, truck-05, truck-09. Nearby: truck-02 load 1 (stop-069, 0.8 km): 0.64 pallets left, 106 min left, detour +22 min; truck-08 load 1 (stop-068, 1.7 km): 0.9 pallets left (too little), 128 min left, detour +24 min; truck-04 load 1 (stop-080, 3.3 km): 0.13 pallets left (too little), 2 min left, detour +28 min.
- stop-061 (P2, 1000 cases, window 08:00-13:00 UNKNOWN): can be served on its own; earliest arrival 08:06; size 8.9 pallets vs largest 12.0; round trip 363 min, fits the shift; any truck. Nearby: truck-07 load 1 (stop-046, 0.3 km): 2.71 pallets left (too little), 317 min left, detour +291 min; truck-04 load 1 (stop-034, 0.6 km): 0.13 pallets left (too little), 2 min left, detour +292 min, misses its window; truck-06 load 1 (stop-067, 1.3 km): 0.55 pallets left (too little), 134 min left, detour +292 min, misses its window.
- stop-070 (P3, 100 cases, window 08:00-16:00 UNKNOWN): can be served on its own; earliest arrival 07:37; size 1.0 pallets vs largest 12.0; round trip 52 min, fits the shift; any truck. Nearby: truck-09 load 1 (stop-076, 0.7 km): 1.43 pallets left, 126 min left, detour +38 min, misses its window; truck-07 load 2 (stop-087, 1.5 km): -0.49 pallets left (too little), 246 min left, detour +41 min; truck-02 load 1 (stop-059, 1.6 km): 0.03 pallets left (too little), 174 min left, detour +42 min; truck-06 load 1 (stop-036, 2.5 km): 1.56 pallets left, 180 min left, detour +43 min; truck-04 load 1 (stop-029, 3.6 km): 1 pallets left (too little), 0 min left, detour +48 min.
- stop-075 (P3, 80 cases, window 09:00-15:00 UNKNOWN): can be served on its own; earliest arrival 08:29; size 0.88 pallets vs largest 12.0; round trip 150 min, fits the shift; any truck.
- stop-077 (P3, 60 cases, window 09:00-13:00 UNKNOWN): can be served on its own; earliest arrival 08:52; size 0.42 pallets vs largest 12.0; round trip 191 min, fits the shift; any truck.
- stop-078 (P3, 100 cases, window 09:00-14:00 UNKNOWN): can be served on its own; earliest arrival 07:41; size 0.89 pallets vs largest 12.0; round trip 64 min, fits the shift; any truck. Nearby: truck-07 load 1 (stop-066, 0.3 km): 6.9 pallets left, 0 min left, detour +43 min; truck-03 load 1 (stop-021, 0.4 km): 2.84 pallets left, 130 min left, detour +44 min, misses its window; truck-02 load 1 (stop-084, 1.0 km): 0.03 pallets left (too little), 174 min left, detour +45 min; truck-06 load 1 (stop-065, 1.6 km): 1.56 pallets left, 180 min left, detour +45 min; truck-07 load 2 (stop-087, 4.0 km): -0.49 pallets left (too little), 246 min left, detour +53 min, misses its window.
- stop-083 (P3, 5 cases, window 09:00-12:00 UNKNOWN): can be served on its own; earliest arrival 07:38; size 0.07 pallets vs largest 12.0; round trip 35 min, fits the shift; any truck. Nearby: truck-02 load 1 (stop-059, 0.9 km): 0.03 pallets left (too little), 174 min left, detour +38 min; truck-06 load 1 (stop-032, 1.1 km): 1.56 pallets left, 180 min left, detour +22 min, misses its window; truck-07 load 2 (stop-087, 1.3 km): -0.49 pallets left (too little), 246 min left, detour +22 min, misses its window; truck-07 load 1 (stop-086, 2.1 km): 6.9 pallets left, 0 min left, detour +24 min; truck-03 load 1 (stop-021, 2.4 km): 2.84 pallets left, 130 min left, detour +20 min, misses its window.
- stop-091 (P3, 6 cases, window 08:00-14:00 UNKNOWN): can be served on its own; earliest arrival 09:51; size 0.13 pallets vs largest 12.0; round trip 297 min, fits the shift; any truck.
- stop-092 (P4, 30 cases, window 08:00-12:00 UNKNOWN): can be served on its own; earliest arrival 08:46; size 0.38 pallets vs largest 12.0; round trip 172 min, fits the shift; any truck. Nearby: truck-04 load 1 (stop-064, 0.7 km): 0.39 pallets left, 98 min left, detour +21 min, misses its window.
- stop-093 (P3, 100 cases, window 08:00-13:00 UNKNOWN): can be served on its own; earliest arrival 09:12; size 0.74 pallets vs largest 12.0; round trip 240 min, fits the shift; any truck. Nearby: truck-09 load 1 (stop-040, 1.2 km): 0.42 pallets left (too little), 55 min left, detour +38 min, misses its window.

### Ranked relaxations

Base: 82 of 94 stops served (range 78..84), cash 514.60 OMR (range 504.02..525.27); budget 20 s QUICK, seeds [1, 2, 3]. Deltas are paired per seed; a gain that does not hold in every seed may be search noise. Plans are the best found, not proven optimal; km are estimated.

**Relaxations usable today**

| # | relaxation | stops | every seed | cases | cash OMR (range) | late min | gained | checks | basis |
|---|---|---|---|---|---|---|---|---|---|
| 1 | hire 1 truck (14 bays, hire 50.00 OMR/day) | +5.667 | yes | +782.333 | +70.63 (+56.06..+92.67) | +0 | stop-010, stop-017, stop-019, stop-026, stop-040, stop-042, stop-052, stop-057, stop-061, stop-070, stop-075, stop-077, stop-078, stop-083, stop-091, stop-093 | VERIFIED 3 | an existing hire option at its own hire price; the engine's hire rules and hire check apply |
| 2 | truck-03 +1 load | +4 | yes | -4.333 | +0.29 (-11.26..+8.28) | +0 | stop-010, stop-017, stop-019, stop-026, stop-040, stop-042, stop-050, stop-052, stop-057, stop-070, stop-075, stop-077, stop-078, stop-083 | VERIFIED 3 | a company setting (loads per truck per day); shift, return and break limits unchanged |
| 3 | truck-01 +1 load | +2 | no | +134.333 | -10.74 (-29.22..+11.65) | +0 | stop-010, stop-019, stop-026, stop-040, stop-042, stop-050, stop-057, stop-070, stop-075, stop-077, stop-078, stop-083, stop-091 | VERIFIED 3 | a company setting (loads per truck per day); shift, return and break limits unchanged |

- Hiring one more truck (14 bays, hire 50.00 OMR/day) changes cash cost by +70.63 OMR (range +56.06..+92.67 over 3 seeds) and changes deliveries by +5.667 on average (range +4..+9) (newly served: stop-010, stop-017, stop-019, stop-026, stop-040, stop-042, stop-052, stop-057, stop-061, stop-070, stop-075, stop-077, stop-078, stop-083, stop-091, stop-093; no longer served: stop-005, stop-050, stop-092).
- Allowing truck-03 one more load changes cash cost by +0.29 OMR (range -11.26..+8.28 over 3 seeds) and changes deliveries by +4 on average (range +1..+9) (newly served: stop-010, stop-017, stop-019, stop-026, stop-040, stop-042, stop-050, stop-052, stop-057, stop-070, stop-075, stop-077, stop-078, stop-083; no longer served: stop-049, stop-061, stop-092, stop-093).
- Allowing truck-01 one more load changes cash cost by -10.74 OMR (range -29.22..+11.65 over 3 seeds) and changes deliveries by +2 on average (range -2..+9) (newly served: stop-010, stop-019, stop-026, stop-040, stop-042, stop-050, stop-057, stop-070, stop-075, stop-077, stop-078, stop-083, stop-091; no longer served: stop-018, stop-032, stop-036, stop-049, stop-054, stop-068).

**HYPOTHETICAL (needs a confirmation or an agreement)**

| # | relaxation | stops | every seed | cases | cash OMR (range) | late min | gained | checks | basis |
|---|---|---|---|---|---|---|---|---|---|
| 1 | shift and latest return +30 min (HYPOTHETICAL) | +2.333 | no | +59.667 | +6.11 (-14.77..+27.32) | +0 | stop-010, stop-017, stop-026, stop-042, stop-052, stop-057, stop-070, stop-077, stop-078, stop-083, stop-091 | VERIFIED 3 | HYPOTHETICAL - needs driver agreement; truck evidence, latest return to depot: 10T p50 17:00, p75 18:57, p90 20:07; 3T p50 17:36, p75 18:39, p90 19:22. 3T in October: p50 18:16, p75 19:02, p90 20:20 (58% of days after 18:00). |
| 2 | stop-010 window +30 min (UNKNOWN, HYPOTHETICAL) | +2.333 | no | +26.667 | -5.94 (-42.56..+27.50) | +10 | stop-010, stop-026, stop-040, stop-042, stop-052, stop-057, stop-070, stop-078, stop-083, stop-091 | VERIFIED 3 | HYPOTHETICAL - needs confirmation that this window is a preference; 13 Oct truck evidence: 12 of 27 RouteIQ hard windows with corroborated visits close earlier than practice |
| 3 | stop-002 window +10 min (UNKNOWN, HYPOTHETICAL) | +0.667 | no | +27 | +3.67 (+0.00..+8.92) | +0 | stop-010, stop-026, stop-042, stop-050, stop-070, stop-091 | VERIFIED 3 | HYPOTHETICAL - needs confirmation that this window is a preference; 13 Oct truck evidence: 12 of 27 RouteIQ hard windows with corroborated visits close earlier than practice |
| 4 | stop-010 window +10 min (UNKNOWN, HYPOTHETICAL) | +0.667 | no | -28 | +1.49 (-1.20..+5.68) | +0 | stop-026, stop-040, stop-042, stop-070, stop-075, stop-078, stop-083 | VERIFIED 3 | HYPOTHETICAL - needs confirmation that this window is a preference; 13 Oct truck evidence: 12 of 27 RouteIQ hard windows with corroborated visits close earlier than practice |
| 5 | stop-061 window +10 min (UNKNOWN, HYPOTHETICAL) | +0.333 | no | +10.333 | +0.10 (-8.63..+8.92) | +0 | stop-010, stop-026, stop-042, stop-070, stop-091 | VERIFIED 3 | HYPOTHETICAL - needs confirmation that this window is a preference; 13 Oct truck evidence: 12 of 27 RouteIQ hard windows with corroborated visits close earlier than practice |
| 6 | stop-061 window +30 min (UNKNOWN, HYPOTHETICAL) | +0.333 | no | +10.333 | +0.10 (-8.63..+8.92) | +0 | stop-010, stop-026, stop-042, stop-070, stop-091 | VERIFIED 3 | HYPOTHETICAL - needs confirmation that this window is a preference; 13 Oct truck evidence: 12 of 27 RouteIQ hard windows with corroborated visits close earlier than practice |
| 7 | stop-002 window +30 min (UNKNOWN, HYPOTHETICAL) | -0.333 | no | +25 | -4.30 (-14.96..+2.08) | +0 | stop-010, stop-026, stop-042, stop-050, stop-070 | VERIFIED 3 | HYPOTHETICAL - needs confirmation that this window is a preference; 13 Oct truck evidence: 12 of 27 RouteIQ hard windows with corroborated visits close earlier than practice |

- [HYPOTHETICAL] Extending the shift and the latest return by 30 minutes changes cash cost by +6.11 OMR (range -14.77..+27.32 over 3 seeds) and changes deliveries by +2.333 on average (range -1..+5) (newly served: stop-010, stop-017, stop-026, stop-042, stop-052, stop-057, stop-070, stop-077, stop-078, stop-083, stop-091; no longer served: stop-019, stop-024, stop-043, stop-045, stop-067, stop-081, stop-090).
- [HYPOTHETICAL] Extending stop-010's window by 30 minutes changes cash cost by -5.94 OMR (range -42.56..+27.50 over 3 seeds) and changes deliveries by +2.333 on average (range +0..+5) (newly served: stop-010, stop-026, stop-040, stop-042, stop-052, stop-057, stop-070, stop-078, stop-083, stop-091; no longer served: stop-021, stop-024, stop-065, stop-092).
- [HYPOTHETICAL] Extending stop-002's window by 10 minutes changes cash cost by +3.67 OMR (range +0.00..+8.92 over 3 seeds) and changes deliveries by +0.667 on average (range +0..+1) (newly served: stop-010, stop-026, stop-042, stop-050, stop-070, stop-091; no longer served: stop-005, stop-049, stop-080, stop-084).
- [HYPOTHETICAL] Extending stop-010's window by 10 minutes changes cash cost by +1.49 OMR (range -1.20..+5.68 over 3 seeds) and changes deliveries by +0.667 on average (range -3..+5) (newly served: stop-026, stop-040, stop-042, stop-070, stop-075, stop-078, stop-083; no longer served: stop-018, stop-019, stop-043, stop-068, stop-093).
- [HYPOTHETICAL] Extending stop-061's window by 10 minutes changes cash cost by +0.10 OMR (range -8.63..+8.92 over 3 seeds) and changes deliveries by +0.333 on average (range +0..+1) (newly served: stop-010, stop-026, stop-042, stop-070, stop-091; no longer served: stop-005, stop-049, stop-080, stop-084).
- [HYPOTHETICAL] Extending stop-061's window by 30 minutes changes cash cost by +0.10 OMR (range -8.63..+8.92 over 3 seeds) and changes deliveries by +0.333 on average (range +0..+1) (newly served: stop-010, stop-026, stop-042, stop-070, stop-091; no longer served: stop-005, stop-049, stop-080, stop-084).
- [HYPOTHETICAL] Extending stop-002's window by 30 minutes changes cash cost by -4.30 OMR (range -14.96..+2.08 over 3 seeds) and changes deliveries by -0.333 on average (range -2..+1) (newly served: stop-010, stop-026, stop-042, stop-050, stop-070; no longer served: stop-040, stop-043, stop-049, stop-068, stop-080, stop-084).

**Operational improvement potential (requires evidence)**

| # | relaxation | stops | every seed | cases | cash OMR (range) | late min | gained | checks | basis |
|---|---|---|---|---|---|---|---|---|---|
| 1 | unloading 39% faster per case (REQUIRES EVIDENCE) | +7.667 | yes | +913.667 | -16.57 (-42.05..+27.68) | +0 | stop-010, stop-017, stop-019, stop-026, stop-040, stop-042, stop-050, stop-052, stop-057, stop-061, stop-070, stop-075, stop-077, stop-078, stop-083, stop-091, stop-092, stop-093 | VERIFIED 3 | REQUIRES EVIDENCE - the best-quartile visits are 39% shorter than the median (13 Oct truck evidence, time on site per chain, visit-weighted median of 1 - p25/p50 over 422 visits); applied to the per-case part only (0.25 min per case) |

- [REQUIRES EVIDENCE] Unloading 39% faster per case changes cash cost by -16.57 OMR (range -42.05..+27.68 over 3 seeds) and changes deliveries by +7.667 on average (range +4..+13) (newly served: stop-010, stop-017, stop-019, stop-026, stop-040, stop-042, stop-050, stop-052, stop-057, stop-061, stop-070, stop-075, stop-077, stop-078, stop-083, stop-091, stop-092, stop-093).

Cash: OMR cash cost of the new loads (costing.truck_day_costs via DispatchScenario.truck_days). Penalties are ARTIFICIAL: solver penalties in OMR-equivalent (leaving stops out, preferred windows, early arrival, plan continuity). Not cash; never add them to cash.

### Trade-off frontier

| point | flags | cash OMR (range) | stops served | min late | trucks | est. km | checks | frontier |
|---|---|---|---|---|---|---|---|---|
| MIN_TRUCKS | - | 496.85 (480.51..511.29) | 85.667 | 0 | 9 | 945.9 | VERIFIED 3 | yes |
| MIN_DISTANCE | - | 505.41 (499.66..508.97) | 87 | 0 | 9 | 931.9 | VERIFIED 3 | yes |
| RECOMMENDED | - | 514.60 (504.02..525.27) | 82 | 0 | 9 | 1007.8 | VERIFIED 3 | no (by MIN_TRUCKS) |
| truck-03 +1 load | - | 514.90 (503.26..529.13) | 86 | 0 | 9 | 1027.2 | VERIFIED 3 | no (by MIN_DISTANCE) |
| hire 1 truck (14 bays, hire 50.00 OMR/day) | - | 585.24 (567.19..607.19) | 87.667 | 0 | 10 | 1043.8 | VERIFIED 3 | yes |

Means over seeds [1, 2, 3] at 20 s QUICK. Minutes late are counted against the original windows (the preferred end where set, else the closing time). Best found plans, not proven optimal.

## SYNTH-320-TIGHT: SYNTHETIC tight (hypermarket windows close 60 min earlier); 185 stops, 13 trucks

Budget 40 s QUICK per run, seeds [1, 2, 3]. Verdicts per seed: SEARCH_FAILURE, SEARCH_FAILURE, SEARCH_FAILURE. Candidates: windows +10/+30 min for up to 3 stops left out, +1 load on up to 2 trucks, a hired truck, shift +30 min (HYPOTHETICAL), faster unloading (REQUIRES EVIDENCE).

### Verdicts

Seed 1: **SEARCH_FAILURE** (RECOMMENDED: OPTIMIZED, ROUTING_SUCCESS, solved in 45.4 s with the load re-check, search limit 40 s; 182 of 185 stops served). 3 stop(s) left out without a proof, not proven impossible: a longer search, a relaxation or a change could serve it.

| stop | P | cases | verdict | proof | checked | note |
|---|---|---|---|---|---|---|
| stop-006 | 5 | 3 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it |
| stop-104 | 5 | 29 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it |
| stop-180 | 3 | 118 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it; 61 lower-priority stop(s) are served |

Seed 2: **SEARCH_FAILURE** (RECOMMENDED: OPTIMIZED, ROUTING_SUCCESS, solved in 46.5 s with the load re-check, search limit 40 s; 180 of 185 stops served). 5 stop(s) left out without a proof, not proven impossible: a longer search, a relaxation or a change could serve it.

| stop | P | cases | verdict | proof | checked | note |
|---|---|---|---|---|---|---|
| stop-005 | 5 | 1 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it |
| stop-023 | 3 | 192 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it; 59 lower-priority stop(s) are served |
| stop-037 | 5 | 15 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it |
| stop-104 | 5 | 29 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it |
| stop-162 | 5 | 24 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it |

Seed 3: **SEARCH_FAILURE** (RECOMMENDED: OPTIMIZED, ROUTING_SUCCESS, solved in 44.0 s with the load re-check, search limit 40 s; 182 of 185 stops served). 3 stop(s) left out without a proof, not proven impossible: a longer search, a relaxation or a change could serve it.

| stop | P | cases | verdict | proof | checked | note |
|---|---|---|---|---|---|---|
| stop-003 | 3 | 3 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it; 61 lower-priority stop(s) are served |
| stop-005 | 5 | 1 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it |
| stop-006 | 5 | 3 | SEARCH_FAILURE | - (SEARCH) | - | not proven impossible: a longer search, a relaxation or a change could serve it |

### Conflicts of the stops left out

- stop-003 (P3, 3 cases, window 07:00-13:00 SALES_PREFERENCE): can be served on its own; earliest arrival 09:11; size 0.03 pallets vs largest 14.0; round trip 214 min, fits the shift; any truck.
- stop-005 (P5, 1 cases, window 07:00-13:00 UNKNOWN): can be served on its own; earliest arrival 09:33; size 0.02 pallets vs largest 14.0; round trip 258 min, fits the shift; any truck. Nearby: T06 load 1 (stop-002, 0.3 km): 0.08 pallets left, 47 min left, detour +12 min.
- stop-006 (P5, 3 cases, window 07:00-13:00 UNKNOWN): can be served on its own; earliest arrival 09:11; size 0.03 pallets vs largest 14.0; round trip 215 min, fits the shift; any truck. Nearby: T06 load 1 (stop-003, 0.4 km): 0.07 pallets left, 171 min left, detour +14 min, misses its window.
- stop-023 (P3, 192 cases, window 07:00-13:00 SALES_PREFERENCE): can be served on its own; earliest arrival 07:42; size 1.9 pallets vs largest 14.0; round trip 92 min, fits the shift; any truck. Nearby: T07 load 1 (stop-127, 0.5 km): 0.43 pallets left (too little), 0 min left, detour +70 min; T01 load 2 (stop-109, 0.8 km): 0.89 pallets left (too little), 142 min left, detour +70 min, misses its window; T03 load 1 (stop-103, 1.4 km): 0 pallets left (too little), 30 min left, detour +72 min; T11 load 1 (stop-141, 1.4 km): 0.28 pallets left (too little), 80 min left, detour +72 min; T05 load 1 (stop-120, 1.7 km): 0 pallets left (too little), 159 min left, detour +70 min, misses its window.
- stop-037 (P5, 15 cases, window 08:00-12:00 UNKNOWN): can be served on its own; earliest arrival 07:49; size 0.14 pallets vs largest 14.0; round trip 54 min, fits the shift; any truck. Nearby: T06 load 1 (stop-164, 0.2 km): 0.08 pallets left (too little), 47 min left, detour +16 min; T07 load 2 (stop-088, 0.2 km): 2.35 pallets left, 40 min left, detour +16 min, misses its window; T01 load 1 (stop-059, 0.3 km): 0.01 pallets left (too little), 35 min left, detour +15 min, misses its window; T07 load 1 (stop-033, 0.3 km): 0.43 pallets left, 0 min left, detour +16 min.
- stop-104 (P5, 29 cases, window 08:00-12:00 UNKNOWN): can be served on its own; earliest arrival 08:06; size 0.60 pallets vs largest 6.0; round trip 90 min, fits the shift; only T01, T02, T03, T04, T05, T06, T07. Nearby: T07 load 2 (stop-154, 0.0 km): 0.21 pallets left (too little), 35 min left, detour +19 min, misses its window; T04 load 1 (stop-102, 0.3 km): 0.13 pallets left (too little), 30 min left, detour +19 min, misses its window; T01 load 1 (stop-064, 0.4 km): 0.12 pallets left (too little), 104 min left, detour +19 min; T02 load 2 (stop-171, 0.4 km): 0.04 pallets left (too little), 30 min left, detour +19 min, misses its window; T09 load 1 (stop-013, 3.5 km): 1.49 pallets left (too little), 139 min left, detour +28 min.
- stop-162 (P5, 24 cases, window 08:00-12:00 UNKNOWN): can be served on its own; earliest arrival 07:36; size 0.24 pallets vs largest 14.0; round trip 30 min, fits the shift; any truck. Nearby: T06 load 1 (stop-128, 0.4 km): 0.08 pallets left (too little), 47 min left, detour +18 min; T03 load 2 (stop-056, 0.8 km): 2.88 pallets left, 148 min left, detour +19 min, misses its window; T04 load 1 (stop-125, 1.1 km): 0.09 pallets left (too little), 0 min left, detour +18 min; T12 load 1 (stop-096, 1.2 km): 1.06 pallets left, 115 min left, detour +20 min; T02 load 2 (stop-185, 1.5 km): 0.01 pallets left (too little), 250 min left, detour +18 min, misses its window.
- stop-180 (P3, 118 cases, window 07:00-13:00 SALES_PREFERENCE): can be served on its own; earliest arrival 08:03; size 1.3 pallets vs largest 14.0; round trip 117 min, fits the shift; any truck. Nearby: T02 load 2 (stop-168, 0.1 km): 0.04 pallets left (too little), 30 min left, detour +51 min; T07 load 2 (stop-027, 0.5 km): 0.21 pallets left (too little), 35 min left, detour +51 min, misses its window; T01 load 1 (stop-086, 0.8 km): 0.12 pallets left (too little), 104 min left, detour +51 min, misses its window; T04 load 1 (stop-182, 0.9 km): 0.13 pallets left (too little), 30 min left, detour +53 min; T09 load 1 (stop-022, 1.0 km): 1.49 pallets left, 139 min left, detour +50 min.

### Ranked relaxations

Base: 181.333 of 185 stops served (range 180..182), cash 669.40 OMR (range 663.55..674.47); budget 40 s QUICK, seeds [1, 2, 3]. Deltas are paired per seed; a gain that does not hold in every seed may be search noise. Plans are the best found, not proven optimal; km are estimated.

**Relaxations usable today**

| # | relaxation | stops | every seed | cases | cash OMR (range) | late min | gained | checks | basis |
|---|---|---|---|---|---|---|---|---|---|
| 1 | stop-003 window +10 min (SALES_PREFERENCE) | -0.667 | no | +2.667 | -1.66 (-14.72..+16.57) | -39 | stop-003, stop-023 | VERIFIED 3 | the window is labelled SALES_PREFERENCE (a salesman's request, not the customer's closing time) |
| 2 | T08 +1 load | -0.667 | no | -1.333 | -9.50 (-28.50..+0.00) | -301.333 | stop-006 | VERIFIED 3 | a company setting (loads per truck per day); shift, return and break limits unchanged |
| 3 | stop-023 window +30 min (SALES_PREFERENCE) | -1 | no | +86.333 | +8.61 (+1.12..+13.48) | +671 | stop-023, stop-037, stop-104, stop-180 | VERIFIED 3 | the window is labelled SALES_PREFERENCE (a salesman's request, not the customer's closing time) |
| 4 | stop-023 window +10 min (SALES_PREFERENCE) | -1 | no | +66.333 | +2.43 (-19.56..+26.84) | +138.333 | stop-023, stop-037, stop-104, stop-180 | VERIFIED 3 | the window is labelled SALES_PREFERENCE (a salesman's request, not the customer's closing time) |
| 5 | stop-180 window +10 min (SALES_PREFERENCE) | -1.667 | no | -32.667 | -6.10 (-11.96..+0.00) | -244.667 | - | VERIFIED 3 | the window is labelled SALES_PREFERENCE (a salesman's request, not the customer's closing time) |
| 6 | stop-180 window +30 min (SALES_PREFERENCE) | -2 | no | +57 | -17.50 (-25.10..-9.83) | -821.667 | stop-023, stop-037, stop-180 | VERIFIED 3 | the window is labelled SALES_PREFERENCE (a salesman's request, not the customer's closing time) |
| 7 | stop-003 window +30 min (SALES_PREFERENCE) | -2 | no | -55.333 | -13.55 (-22.64..-8.44) | -749.333 | stop-003, stop-023, stop-037, stop-162 | VERIFIED 3 | the window is labelled SALES_PREFERENCE (a salesman's request, not the customer's closing time) |
| 8 | T02 +1 load | -3.667 | no | -145.667 | -18.73 (-39.59..-2.17) | -1306.33 | stop-023, stop-104, stop-162 | VERIFIED 3 | a company setting (loads per truck per day); shift, return and break limits unchanged |

- Extending stop-003's window by 10 minutes changes cash cost by -1.66 OMR (range -14.72..+16.57 over 3 seeds) and changes deliveries by -0.667 on average (range -1..+0) (newly served: stop-003, stop-023; no longer served: stop-110, stop-162, stop-181).
- Allowing T08 one more load changes cash cost by -9.50 OMR (range -28.50..+0.00 over 3 seeds) and changes deliveries by -0.667 on average (range -2..+0) (newly served: stop-006; no longer served: stop-002, stop-005, stop-008).
- Extending stop-023's window by 30 minutes changes cash cost by +8.61 OMR (range +1.12..+13.48 over 3 seeds) and changes deliveries by -1 on average (range -3..+0) (newly served: stop-023, stop-037, stop-104, stop-180; no longer served: stop-005, stop-006, stop-055, stop-110, stop-137).
- Extending stop-023's window by 10 minutes changes cash cost by +2.43 OMR (range -19.56..+26.84 over 3 seeds) and changes deliveries by -1 on average (range -3..+0) (newly served: stop-023, stop-037, stop-104, stop-180; no longer served: stop-002, stop-005, stop-006, stop-008, stop-055, stop-110, stop-137, stop-181).
- Extending stop-180's window by 10 minutes changes cash cost by -6.10 OMR (range -11.96..+0.00 over 3 seeds) and changes deliveries by -1.667 on average (range -3..+0) (no longer served: stop-055, stop-104, stop-137, stop-182).
- Extending stop-180's window by 30 minutes changes cash cost by -17.50 OMR (range -25.10..-9.83 over 3 seeds) and changes deliveries by -2 on average (range -4..+0) (newly served: stop-023, stop-037, stop-180; no longer served: stop-001, stop-002, stop-003, stop-006, stop-008, stop-028, stop-110).
- Extending stop-003's window by 30 minutes changes cash cost by -13.55 OMR (range -22.64..-8.44 over 3 seeds) and changes deliveries by -2 on average (range -3..-1) (newly served: stop-003, stop-023, stop-037, stop-162; no longer served: stop-002, stop-005, stop-006, stop-008, stop-137, stop-180, stop-181).
- Allowing T02 one more load changes cash cost by -18.73 OMR (range -39.59..-2.17 over 3 seeds) and changes deliveries by -3.667 on average (range -6..-2) (newly served: stop-023, stop-104, stop-162; no longer served: stop-001, stop-002, stop-005, stop-008, stop-028, stop-110, stop-137, stop-180, stop-181).

**HYPOTHETICAL (needs a confirmation or an agreement)**

| # | relaxation | stops | every seed | cases | cash OMR (range) | late min | gained | checks | basis |
|---|---|---|---|---|---|---|---|---|---|
| 1 | shift and latest return +30 min (HYPOTHETICAL) | -1.667 | no | -46 | -4.20 (-8.72..-1.42) | -183.667 | stop-005, stop-023, stop-104 | VERIFIED 3 | HYPOTHETICAL - needs driver agreement; truck evidence, latest return to depot: 10T p50 17:00, p75 18:57, p90 20:07; 3T p50 17:36, p75 18:39, p90 19:22. 3T in October: p50 18:16, p75 19:02, p90 20:20 (58% of days after 18:00). |

- [HYPOTHETICAL] Extending the shift and the latest return by 30 minutes changes cash cost by -4.20 OMR (range -8.72..-1.42 over 3 seeds) and changes deliveries by -1.667 on average (range -2..-1) (newly served: stop-005, stop-023, stop-104; no longer served: stop-001, stop-015, stop-110, stop-137, stop-162, stop-180).

**Operational improvement potential (requires evidence)**

| # | relaxation | stops | every seed | cases | cash OMR (range) | late min | gained | checks | basis |
|---|---|---|---|---|---|---|---|---|---|
| 1 | unloading 39% faster per case (REQUIRES EVIDENCE) | +3.667 | yes | +139.333 | -39.24 (-47.04..-25.76) | -4882 | stop-003, stop-005, stop-006, stop-023, stop-037, stop-104, stop-162, stop-180 | VERIFIED 3 | REQUIRES EVIDENCE - the best-quartile visits are 39% shorter than the median (13 Oct truck evidence, time on site per chain, visit-weighted median of 1 - p25/p50 over 422 visits); applied to the per-case part only (0.25 min per case) |

- [REQUIRES EVIDENCE] Unloading 39% faster per case changes cash cost by -39.24 OMR (range -47.04..-25.76 over 3 seeds) and changes deliveries by +3.667 on average (range +3..+5) (newly served: stop-003, stop-005, stop-006, stop-023, stop-037, stop-104, stop-162, stop-180).

Cash: OMR cash cost of the new loads (costing.truck_day_costs via DispatchScenario.truck_days). Penalties are ARTIFICIAL: solver penalties in OMR-equivalent (leaving stops out, preferred windows, early arrival, plan continuity). Not cash; never add them to cash.

### Trade-off frontier

| point | flags | cash OMR (range) | stops served | min late | trucks | est. km | checks | frontier |
|---|---|---|---|---|---|---|---|---|
| MIN_DISTANCE | - | 645.30 (638.19..659.27) | 181.333 | 11827.3 | 13 | 1021.4 | VERIFIED 3 | yes |
| MIN_TRUCKS | - | 649.05 (621.95..688.30) | 182.667 | 12208.3 | 13 | 1035.5 | VERIFIED 3 | yes |
| RECOMMENDED | - | 669.40 (663.55..674.47) | 181.333 | 8242.67 | 13 | 1187.2 | VERIFIED 3 | yes |

Needs a confirmation, an agreement or evidence first (HYPOTHETICAL / REQUIRES_EVIDENCE): shown apart, and never counted as beating an option of the table above.

| point | flags | cash OMR (range) | stops served | min late | trucks | est. km | checks | frontier |
|---|---|---|---|---|---|---|---|---|
| unloading 39% faster per case (REQUIRES EVIDENCE) | REQUIRES_EVIDENCE | 630.16 (618.62..648.72) | 185 | 3360.67 | 13 | 1262.8 | VERIFIED 3 | yes |

Means over seeds [1, 2, 3] at 40 s QUICK. Minutes late are counted against the original windows (the preferred end where set, else the closing time). Best found plans, not proven optimal.
