# Decision-support evidence (DESIGN.md section 6)

Written by `python -m decision_support.experiments all --report` from the run cache. Every compared run has the same budget (search seconds, QUICK, RECOMMENDED only) and runs alone in its lane's process (SOLVER_PARALLEL=0). Production also runs the second route search (PyVRP); it is off here (SOLVER_PYVRP=off) so that every run gets the same single-core search.

Distances are HAVERSINE estimates (estimated km). Plans are the best found in the time given, not proven optimal; only E5's oracle proves optimality, on the instances it enumerates completely. Cash is OMR (costing.truck_day_costs); solver penalties are ARTIFICIAL and never added to cash.

| Experiment | Day | Status | Items done | Commit | Compute min | Files |
|---|---|---|---|---|---|---|
| E1 What-if levers | SYNTH-320 | COMPLETE | 78/78 | 6b6de09d576c | 58.4 | [E1-whatif.md](E1-whatif.md), [E1-whatif.json](E1-whatif.json) |
| E1 What-if levers | REAL-15OCT | COMPLETE | 36/36 | 6b6de09d576c | 53.7 | [E1-whatif.md](E1-whatif.md), [E1-whatif.json](E1-whatif.json) |
| E1 What-if levers | SYNTH-400 | COMPLETE | 78/78 | 6b6de09d576c | 75.0 | [E1-whatif.md](E1-whatif.md), [E1-whatif.json](E1-whatif.json) |
| E2 Small-stop economics | REAL-15OCT | COMPLETE | 27/27 | 6b6de09d576c | 20.9 | [E2-economics.md](E2-economics.md), [E2-economics.json](E2-economics.json) |
| E2 Small-stop economics | SYNTH-320 | COMPLETE | 27/27 | 6b6de09d576c | 21.0 | [E2-economics.md](E2-economics.md), [E2-economics.json](E2-economics.json) |
| E3 Dynamic re-planning policies | SYNTH-280 | COMPLETE | 16/16 | 6b6de09d576c | 41.0 | [E3-dynamic.md](E3-dynamic.md), [E3-dynamic.json](E3-dynamic.json) |
| E3 Dynamic re-planning policies | REAL-15OCT | COMPLETE | 10/10 | 6b6de09d576c | 16.0 | [E3-dynamic.md](E3-dynamic.md), [E3-dynamic.json](E3-dynamic.json) |
| E4 Verdicts, ranked relaxations and the trade-off frontier | REAL-15OCT-PREFIX | COMPLETE | 42/42 | 6b6de09d576c | 73.5 | [E4-explain.md](E4-explain.md), [E4-explain.json](E4-explain.json) |
| E4 Verdicts, ranked relaxations and the trade-off frontier | SYNTH-320-TIGHT | COMPLETE | 42/42 | 6b6de09d576c | 30.4 | [E4-explain.md](E4-explain.md), [E4-explain.json](E4-explain.json) |
| E5 Exact oracle against the engine | DEFAULT | COMPLETE | 100/100 | 6b6de09d576c | 4.9 | [E5-exact.md](E5-exact.md), [E5-exact.json](E5-exact.json) |
| E5 Exact oracle against the engine | PREFERENCES_OFF | COMPLETE | 100/100 | 6b6de09d576c | 4.8 | [E5-exact.md](E5-exact.md), [E5-exact.json](E5-exact.json) |
