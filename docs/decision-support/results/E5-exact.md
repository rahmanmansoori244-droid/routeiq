# E5: Exact oracle against the engine

- Commit 6b6de09d576c; written 2026-10-15T03:58:30+00:00.
- Budgets (search seconds per run; the engine's load re-check comes on top): engine_sec 3; seeds [1].
- Machine: 4 CPUs, AMD EPYC 7763 64-Core Processor; Python 3.11.17; OR-Tools 9.15.675.
- Items done 200/200; compute 9.7 min (sum of item wall times); wall time 2.5 min (first start to last finish); lanes 0/4, 1/4, 2/4, 3/4.
- Every compared run has the same budget (search seconds, QUICK, RECOMMENDED only) and runs alone in its lane's process (SOLVER_PARALLEL=0). Production also runs the second route search (PyVRP); it is off here (SOLVER_PYVRP=off) so that every run gets the same single-core search.
- Distances are HAVERSINE estimates (estimated km). Plans are the best found in the time given, not proven optimal; only E5's oracle proves optimality, on the instances it enumerates completely. Cash is OMR (costing.truck_day_costs); solver penalties are ARTIFICIAL and never added to cash.

100 random small instances per variant, at most 7 stops and 2 trucks with one load each (exact.random_instance), each solved exactly by the oracle and once by the engine.

IVMS-derived parameters used (committed aggregates of the owner's IVMS report and the 13 Oct truck evidence):
- slow-day stress: every drive x 1.286 (IVMS p75 travel multiplier); Muscat p50 speeds 06-09 38.3 km/h, 09-12 29.01 km/h, 12-15 28.57 km/h

## DEFAULT: with the engine's ARTIFICIAL preferred-window and early-arrival prices

100 SYNTHETIC days of 3-7 stops (profiles: LATE_START 38, MORNING 38, TIGHT_RETURN 24); engine 3 s per run, seed 1.

| measure | value |
|---|---|
| complete enumerations | 100 |
| oracle plans verified by the engine's checks | 100 |
| engine plans feasible under the oracle's rules | 100/100 (100%) |
| engine serves as many stops as the oracle | 100/100 (100%) |
| same service value (priorities) | 100/100 (100%) |
| stops short of the oracle | 0 |
| stops proven never servable that the engine served | 0 |
| engine proofs the oracle refutes | 0 |
| impossible stops left out without an engine proof | 0 |
| stops the oracle proves never servable | 68 |
| cash gap engine - oracle optimum, OMR | mean 0.469 [0.000..8.474], median 0.000 (n=100) |
| cash gap, % | mean 1.239 [-0.002..30.977], median -0.000 (n=97) |
| days with no cash gap (within 0.002 OMR) | 70/100 (70%) |
| routing part of the gap, OMR | mean 0.369 [0.000..8.121], median 0.000 (n=100) |
| timing part of the gap, OMR | mean 0.100 [-0.001..2.500], median 0.000 (n=100) |
| oracle plans that survive the slow day | 60/100 (60%) |
| engine plans that survive the slow day | 65/100 (65%) |
| engine wall seconds per run | mean 2.946 [0.000..3.640], median 3.010 (n=100) |
| oracle seconds per day | mean 0.007 [0.000..0.167], median 0.002 (n=100) |

The oracle's OPTIMAL claims hold for the instances it enumerated completely, for cash under its own rules (the engine's timing rules, HAVERSINE estimated km).

## PREFERENCES_OFF: PREFERENCES_OFF (no preferred-window or early-arrival prices: the engine ranks by service and cash, like the oracle)

100 SYNTHETIC days of 3-7 stops (profiles: LATE_START 38, MORNING 38, TIGHT_RETURN 24); engine 3 s per run, seed 1.

| measure | value |
|---|---|
| complete enumerations | 100 |
| oracle plans verified by the engine's checks | 100 |
| engine plans feasible under the oracle's rules | 100/100 (100%) |
| engine serves as many stops as the oracle | 100/100 (100%) |
| same service value (priorities) | 100/100 (100%) |
| stops short of the oracle | 0 |
| stops proven never servable that the engine served | 0 |
| engine proofs the oracle refutes | 0 |
| impossible stops left out without an engine proof | 0 |
| stops the oracle proves never servable | 68 |
| cash gap engine - oracle optimum, OMR | mean 0.049 [-0.001..2.428], median 0.000 (n=100) |
| cash gap, % | mean 0.088 [-0.002..4.459], median 0.000 (n=97) |
| days with no cash gap (within 0.002 OMR) | 98/100 (98%) |
| routing part of the gap, OMR | mean 0.048 [0.000..2.428], median 0.000 (n=100) |
| timing part of the gap, OMR | mean 0.000 [-0.001..0.001], median -0.000 (n=100) |
| oracle plans that survive the slow day | 60/100 (60%) |
| engine plans that survive the slow day | 61/100 (61%) |
| engine wall seconds per run | mean 2.920 [0.000..3.020], median 3.010 (n=100) |
| oracle seconds per day | mean 0.007 [0.000..0.171], median 0.002 (n=100) |

The oracle's OPTIMAL claims hold for the instances it enumerated completely, for cash under its own rules (the engine's timing rules, HAVERSINE estimated km).
