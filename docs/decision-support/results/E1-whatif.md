# E1: What-if levers

- Commit 6b6de09d576c; written 2026-10-15T03:58:22+00:00.
- Budgets (search seconds per run; the engine's load re-check comes on top): real_sec 20, synthetic_sec 40; seeds [1, 2, 3].
- Machine: 4 CPUs, AMD EPYC 7763 64-Core Processor; Python 3.11.17; OR-Tools 9.15.675.
- Items done 192/192; compute 187.1 min (sum of item wall times); wall time 122.3 min (first start to last finish); lanes 0/4, 1/4, 2/4, 3/4.
- Every compared run has the same budget (search seconds, QUICK, RECOMMENDED only) and runs alone in its lane's process (SOLVER_PARALLEL=0). Production also runs the second route search (PyVRP); it is off here (SOLVER_PYVRP=off) so that every run gets the same single-core search.
- Distances are HAVERSINE estimates (estimated km). Plans are the best found in the time given, not proven optimal; only E5's oracle proves optimality, on the instances it enumerates completely. Cash is OMR (costing.truck_day_costs); solver penalties are ARTIFICIAL and never added to cash.

Levers on synthetic days: Flex +10/+20/+30 min (SALES_PREFERENCE windows only), PrefFlex +30, Afternoon (until 18:00), Night (until 22:00), and REQUIRES EVIDENCE: FasterUnloading 20% and FasterReload 15 min; the pairs Flex+30 & Afternoon and Flex+20 & Afternoon; all levers that need no evidence; all levers. Real day: HYPOTHETICAL Flex +10/+20/+30 (all windows UNKNOWN) and the two evidence levers, each alone.

IVMS-derived parameters used (committed aggregates of the owner's IVMS report and the 13 Oct truck evidence):
- evening / night drive speed factor 0.839 / 0.708 x day speed (IVMS MOVING segments, Muscat)
- best-quartile unloading 39% shorter than the median (422 GPS visits; the basis of the faster-unloading levers, which still REQUIRE EVIDENCE)

## SYNTH-320: SYNTHETIC; 185 stops, 13 trucks

Budget 40 s QUICK per run, seeds [1, 2, 3]. 12 variants; every one solved cold and warm.

**Baseline, cold:** cash 664.97 [636.90..680.59] OMR; stops served 181.3 [178.0..183.0] of 185; trucks 13.0; 1175.5 [1027.9..1256.8] estimated km. Seed spread (the search noise at this budget): cash 43.68 OMR, stops 5.

**Warm control** (the baseline re-solved for the same budget from its own plan): cash 687.90 [679.97..698.74] OMR; stops served 184.0 [183.0..185.0]; seed spread: cash 18.77 OMR, stops 2; warm start used in 3/3 runs.

| Variant | Group | Flags | Δ cash OMR, cold (spread 43.68) | Δ stops, cold (spread 5) | Δ cash OMR, warm (spread 18.77) | Δ stops, warm (spread 2) | warm start used |
|---|---|---|---|---|---|---|---|
| Flex(+10 min) | SINGLE | - | +12.63 [-4.92..+46.98] within search noise | +0.0 [-4.0..+6.0] within search noise | -13.77 [-35.57..+1.57] within search noise | -1.0 [-3.0..+0.0] within search noise | 3/3 |
| Flex(+20 min) | SINGLE | - | -9.34 [-21.92..+12.41] within search noise | +1.3 [-1.0..+5.0] within search noise | -3.59 [-10.76..+2.80] within search noise | +0.0 [-2.0..+2.0] within search noise | 3/3 |
| Flex(+30 min) | SINGLE | - | +8.79 [-5.04..+22.44] within search noise | +3.0 [+1.0..+6.0] within search noise | -5.29 [-10.36..+4.02] within search noise | -0.3 [-1.0..+1.0] within search noise | 3/3 |
| PrefFlex(+30 min) | SINGLE | - | +1.10 [-24.89..+52.71] within search noise | +2.0 [-1.0..+5.0] within search noise | -5.17 [-7.59..-0.33] within search noise | -0.3 [-1.0..+0.0] within search noise | 3/3 |
| Afternoon(until 18:00) | SINGLE | - | +23.22 [-8.65..+47.59] within search noise | +3.7 [+2.0..+7.0] within search noise | +2.68 [-9.20..+18.93] within search noise | +1.0 [+0.0..+2.0] within search noise | 3/3 |
| Night(until 22:00) | SINGLE | - | +5.59 [+3.08..+9.91] within search noise | +3.0 [+2.0..+5.0] within search noise | -5.10 [-12.14..+7.46] within search noise | +0.7 [+0.0..+2.0] within search noise | 3/3 |
| FasterUnloading(-20% per case) | SINGLE | REQUIRES EVIDENCE | -25.32 [-36.22..-4.74] within search noise | +3.3 [+1.0..+7.0] within search noise | -36.35 [-51.24..-18.84] | +0.3 [-1.0..+1.0] within search noise | 3/3 |
| FasterReload(-15 min) | SINGLE | REQUIRES EVIDENCE | -2.91 [-22.84..+25.89] within search noise | +2.0 [+1.0..+4.0] within search noise | -16.52 [-42.83..-2.41] within search noise | -0.3 [-3.0..+1.0] within search noise | 3/3 |
| Flex(+20 min) + Afternoon(until 18:00) | PAIR | - | +5.62 [-14.15..+28.37] within search noise | +3.7 [+2.0..+7.0] within search noise | -1.80 [-4.07..+0.49] within search noise | +0.7 [+0.0..+2.0] within search noise | 3/3 |
| Flex(+30 min) + Afternoon(until 18:00) | PAIR | - | +2.09 [-19.09..+29.39] within search noise | +3.3 [+2.0..+6.0] within search noise | -7.45 [-33.91..+8.50] within search noise | +0.3 [+0.0..+1.0] within search noise | 3/3 |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) | ALL | - | +10.19 [-18.25..+46.57] within search noise | +3.7 [+2.0..+7.0] within search noise | +5.15 [-8.95..+13.90] within search noise | +1.0 [+0.0..+2.0] within search noise | 3/3 |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) + FasterUnloading(-20% per case) + FasterReload(-15 min) | ALL_WITH_EVIDENCE | REQUIRES EVIDENCE | -8.09 [-25.98..+17.70] within search noise | +3.7 [+2.0..+7.0] within search noise | -49.46 [-61.38..-40.22] | +1.0 [+0.0..+2.0] within search noise | 3/3 |

Cold: variant and baseline each searched from scratch; Δ = variant - baseline, paired per seed, mean [min..max]. Warm: the variant (and the baseline itself, as the control) searched for the same budget starting from the same seed's cold baseline plan, which every lever here keeps feasible; Δ = variant - control, paired per seed. The warm start only guarantees the route search's own objective: the engine's exact load re-check after the search can still discard that plan and rebuild one, so a warm Δ can be negative. 'warm start used' counts the runs whose search could load the plan (the others searched cold). 'within search noise': the mean Δ is smaller than that baseline's seed spread. Cash includes the second-driver assumption for a truck back after the normal shift. Serving more stops costs more cash: read Δ cash with Δ stops.

### Full what-if report of the cold runs (whatif.WhatIfReport)

#### What-if and sensitivity: SYNTHETIC nmwc day, 320 invoices, seed 1

Budget: 40 s per run, QUICK, seeds [1, 2, 3], RECOMMENDED only, one run at a time; request digest fe04311e66d1749a. Plans are the best found in that time, not proven optimal. Normal day end (latest return or depot closing) 19:00; each truck's own shift limit (first departure + shift maximum) applies too.

**Baseline:** cash 664.97 [636.90..680.59] OMR; stops served 181.3 [178.0..183.0] of 185; cases 9904 [9840..9956] of 9958; trucks 13.0; trips 19.7 [19.0..21.0]; 1175.5 [1027.9..1256.8] estimated km; proven impossible 0.0; feasibility VERIFIED x3.

Every Δ is variant minus baseline, paired per seed: mean [min..max] over the seeds. Cash includes the second-driver assumption where a truck works past the normal shift. Serving more stops usually costs more cash: read Δ cash together with Δ stops served. The baseline's own spread over the seeds is the search noise at this budget: a Δ whose range spans 0 is not established. Late stops and minutes outside preferred windows count against the day's own windows, before any lever moved them; the ARTIFICIAL window penalty is the solver's own, for the windows it was given.

##### Levers that need no new evidence

| Variant | Group | Flags | Δ cash OMR | Δ stops served | Δ cases served | Δ trucks | Δ trips | Δ est. km | Δ late stops | Δ proven impossible | Feasibility (per run) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Flex(+10 min) | SINGLE | - | +12.63 [-4.92..+46.98] | +0.0 [-4.0..+6.0] | +37 [-38..+110] | +0.0 | +1.0 [+0.0..+2.0] | +36.2 [-79.1..+211.1] | +6.7 [+5.0..+8.0] | +0.0 | VERIFIED x3 |
| Flex(+20 min) | SINGLE | - | -9.34 [-21.92..+12.41] | +1.3 [-1.0..+5.0] | +3 [-27..+37] | +0.0 | -1.0 [-3.0..+1.0] | -67.0 [-110.9..+17.8] | +9.3 [+9.0..+10.0] | +0.0 | VERIFIED x3 |
| Flex(+30 min) | SINGLE | - | +8.79 [-5.04..+22.44] | +3.0 [+1.0..+6.0] | +52 [-1..+118] | +0.0 | +0.0 [-1.0..+1.0] | +1.4 [-88.3..+93.5] | +11.7 [+10.0..+13.0] | +0.0 | VERIFIED x3 |
| PrefFlex(+30 min) | SINGLE | - | +1.10 [-24.89..+52.71] | +2.0 [-1.0..+5.0] | +51 [+2..+111] | +0.0 | +1.0 [-1.0..+3.0] | -40.8 [-160.0..+193.0] | +0.0 | +0.0 | VERIFIED x3 |
| Afternoon(until 18:00) | SINGLE | - | +23.22 [-8.65..+47.59] | +3.7 [+2.0..+7.0] | +54 [+2..+118] | +0.0 | +0.7 [+0.0..+1.0] | +40.7 [-74.8..+151.8] | +23.0 [+22.0..+24.0] | +0.0 | VERIFIED x3 |
| Night(until 22:00) | SINGLE | 2nd driver | +5.59 [+3.08..+9.91] | +3.0 [+2.0..+5.0] | +52 [+2..+118] | +0.0 | -0.3 [-2.0..+1.0] | -27.0 [-122.0..+31.9] | +2.0 | +0.0 | VERIFIED x3 |
| Flex(+20 min) + Afternoon(until 18:00) | PAIR | - | +5.62 [-14.15..+28.37] | +3.7 [+2.0..+7.0] | +54 [+2..+118] | +0.0 | -0.3 [-2.0..+1.0] | -34.3 [-132.1..+84.7] | +27.0 | +0.0 | VERIFIED x3 |
| Flex(+30 min) + Afternoon(until 18:00) | PAIR | - | +2.09 [-19.09..+29.39] | +3.3 [+2.0..+6.0] | +54 [+2..+118] | +0.0 | -0.3 [-2.0..+1.0] | -38.9 [-118.5..+91.1] | +27.0 [+26.0..+28.0] | +0.0 | VERIFIED x3 |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) | ALL | - | +10.19 [-18.25..+46.57] | +3.7 [+2.0..+7.0] | +54 [+2..+118] | +0.0 | +0.0 | -30.8 [-137.8..+173.1] | +26.3 [+26.0..+27.0] | +0.0 | VERIFIED x3 |

##### Operational improvement potential (REQUIRES EVIDENCE, never a baseline)

| Variant | Group | Flags | Δ cash OMR | Δ stops served | Δ cases served | Δ trucks | Δ trips | Δ est. km | Δ late stops | Δ proven impossible | Feasibility (per run) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| FasterUnloading(-20% per case) | SINGLE | REQUIRES EVIDENCE | -25.32 [-36.22..-4.74] | +3.3 [+1.0..+7.0] | +53 [+2..+115] | +0.0 | -0.7 [-2.0..+0.0] | -3.8 [-67.6..+103.2] | +0.0 | +0.0 | VERIFIED x3 |
| FasterReload(-15 min) | SINGLE | REQUIRES EVIDENCE | -2.91 [-22.84..+25.89] | +2.0 [+1.0..+4.0] | +51 [-1..+117] | +0.0 | -0.3 [-3.0..+1.0] | -26.0 [-119.8..+108.7] | +0.0 | +0.0 | VERIFIED x3 |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) + FasterUnloading(-20% per case) + FasterReload(-15 min) | ALL_WITH_EVIDENCE | REQUIRES EVIDENCE | -8.09 [-25.98..+17.70] | +3.7 [+2.0..+7.0] | +54 [+2..+118] | +0.0 | +0.7 [+0.0..+1.0] | +54.4 [-23.4..+190.3] | +25.0 | +0.0 | VERIFIED x3 |

##### Time and ARTIFICIAL solver penalties (not cash)

| Variant | Δ paid driver min | Δ min outside preferred windows | Δ window penalty (ARTIFICIAL) | Δ unserved penalty (ARTIFICIAL) | 2nd-driver shifts | their min after the normal end | 2nd-driver OMR (in cash) | engine overtime after the normal end OMR (in cash) |
|---|---|---|---|---|---|---|---|---|
| Flex(+10 min) | +97 [-105..+483] | +375 [-359..+1504] | +18.76 [-17.93..+75.18] | -671000 [-3081000..+1066000] | 0.0 | 0 | 0.00 | 0.00 |
| Flex(+20 min) | -64 [-212..+211] | -750 [-1600..+211] | -37.55 [-79.99..+10.44] | -684667 [-2055000..+1000] | 0.0 | 0 | 0.00 | 0.00 |
| Flex(+30 min) | +111 [-41..+335] | +349 [-153..+952] | +17.29 [-7.90..+47.61] | -1369667 [-3081000..-1000] | 0.0 | 0 | 0.00 | 0.00 |
| PrefFlex(+30 min) | +36 [-244..+533] | +698 [-1174..+3215] | -59.89 [-142.48..+53.53] | -1027000 [-3080000..+1000] | 0.0 | 0 | 0.00 | 0.00 |
| Afternoon(until 18:00) | +188 [-60..+436] | -2440 [-3669..-1708] | -122.07 [-183.63..-85.33] | -1370333 [-3082000..-2000] | 0.0 | 0 | 0.00 | 0.00 |
| Night(until 22:00) | +18 [-92..+110] | -1169 [-1396..-894] | -58.50 [-69.87..-44.70] | -1028000 [-2055000..-2000] | 0.3 [0.0..1.0] | 9 [0..27] | 3.33 [0.00..10.00] | 0.60 [0.00..1.80] |
| FasterUnloading(-20% per case) | -542 [-740..-267] | -2427 [-3202..-1610] | -121.51 [-160.26..-80.63] | -1370000 [-3082000..-2000] | 0.0 | 0 | 0.00 | 0.00 |
| FasterReload(-15 min) | -70 [-214..+217] | -384 [-2142..+948] | -19.41 [-107.38..+47.13] | -1368667 [-3079000..-1000] | 0.0 | 0 | 0.00 | 0.00 |
| Flex(+20 min) + Afternoon(until 18:00) | +25 [-169..+336] | -3202 [-3556..-2533] | -160.09 [-177.96..-126.57] | -1370333 [-3082000..-2000] | 0.0 | 0 | 0.00 | 0.00 |
| Flex(+30 min) + Afternoon(until 18:00) | -5 [-185..+273] | -3268 [-4438..-2290] | -163.45 [-221.87..-114.52] | -1370000 [-3081000..-2000] | 0.0 | 0 | 0.00 | 0.00 |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) | +60 [-200..+408] | -3535 [-4635..-2164] | -243.59 [-296.24..-178.15] | -1370333 [-3082000..-2000] | 0.0 | 0 | 0.00 | 0.00 |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) + FasterUnloading(-20% per case) + FasterReload(-15 min) | -569 [-756..-280] | -5106 [-6087..-4069] | -308.97 [-359.27..-258.35] | -1370333 [-3082000..-2000] | 0.0 | 0 | 0.00 | 0.00 |

##### Extra hours at the IVMS evening / night speed

The engine has one time matrix for the whole day. Each plan below was re-timed with the drive minutes after the normal shift end slowed to the IVMS speed of their hour; stops or returns that would then be late are counted (the plan's own figures above do not include this).

| Variant | legs in the extra hours | extra drive min | stops late at IVMS speed | loads back late |
|---|---|---|---|---|
| Night(until 22:00) | 0.3 [0.0..1.0] | 2 [0..6] | 0.0 | 0.0 |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) | 0.0 | 0 | 0.0 | 0.0 |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) + FasterUnloading(-20% per case) + FasterReload(-15 min) | 0.0 | 0 | 0.0 | 0.0 |

##### What each variant changed

| Variant | windows widened | windows narrowed (kept in the normal shift) | stops with no truck | preferred ends moved | service times cut (min saved) | trucks' hours extended | config |
|---|---|---|---|---|---|---|---|
| Flex(+10 min) | 38 | 0 | 0 | 0 | 0 (0) | 0 | - |
| Flex(+20 min) | 38 | 0 | 0 | 0 | 0 (0) | 0 | - |
| Flex(+30 min) | 38 | 0 | 0 | 0 | 0 (0) | 0 | - |
| PrefFlex(+30 min) | 0 | 0 | 0 | 110 | 0 (0) | 0 | - |
| Afternoon(until 18:00) | 27 | 0 | 0 | 0 | 0 (0) | 0 | - |
| Night(until 22:00) | 2 | 74 | 0 | 0 | 0 (0) | 0 | latest_return_min 1140->1320; shift_max_min 690->870 |
| FasterUnloading(-20% per case) | 0 | 0 | 0 | 0 | 143 (487) | 0 | - |
| FasterReload(-15 min) | 0 | 0 | 0 | 0 | 0 (0) | 0 | reload_min 30->15 |
| Flex(+20 min) + Afternoon(until 18:00) | 38 | 0 | 0 | 0 | 0 (0) | 0 | - |
| Flex(+30 min) + Afternoon(until 18:00) | 38 | 0 | 0 | 0 | 0 (0) | 0 | - |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) | 38 | 74 | 0 | 110 | 0 (0) | 0 | latest_return_min 1140->1320; shift_max_min 690->870 |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) + FasterUnloading(-20% per case) + FasterReload(-15 min) | 38 | 74 | 0 | 110 | 143 (487) | 0 | latest_return_min 1140->1320; reload_min 30->15; shift_max_min 690->870 |

Never changed by any lever: CUSTOMER_HARD windows, breaks, capacity, pallet fill, trips, allowed trucks (except the customers kept in the normal shift), orders and costs. UNKNOWN windows move only in rows marked HYPOTHETICAL (needs confirmation that these are preferences).

##### Assumptions

- window_provenance: the generator's labels (SYNTHETIC)
- per_case_min: 0.25. 14 Oct benchmark; 13 Oct drop-size model 0.243-0.245 per case
- base_min: the generator's customer-type base (synth.TYPES)
- night_driver_cost: 10.0. ASSUMPTION: the web's default daily driver day rate (hire.ts); the request has none. Added once per truck-day back after the normal shift end, on top of the engine's own hourly and overtime pay for those hours (conservative: part of that pay may count twice)
- extra_hours_speed: {'evening': 0.839, 'night': 0.708}. IVMS MOVING segments, Muscat (MOVING segments >= 1 km and >= 2 min, speed = km / hours <= 130): median km/h 06-18 30.7 (segment-weighted mean of the band medians, n=2978), 18-22 25.71 (n=398), 22-06 21.71 (n=147). Cross-check, 13 Oct truck evidence: Time-of-day factor, trucks, Muscat core: 1.00 except 12-15 about 1.06; 18+ 1.07-1.13 (low n) (INFERRED)

##### Evidence from the IVMS report and the 13 Oct truck evidence (aggregates only)

- Source: IVMS report 2026-01-31..2026-03-16, 45352 segments (aggregates only)
- Extra-hours speed factor: evening 0.839, night 0.708 (x day speed). IVMS MOVING segments, Muscat (MOVING segments >= 1 km and >= 2 min, speed = km / hours <= 130): median km/h 06-18 30.7 (segment-weighted mean of the band medians, n=2978), 18-22 25.71 (n=398), 22-06 21.71 (n=147). Cross-check, 13 Oct truck evidence: Time-of-day factor, trucks, Muscat core: 1.00 except 12-15 about 1.06; 18+ 1.07-1.13 (low n) (INFERRED)
- Unloading spread (basis of FasterUnloading, still REQUIRES EVIDENCE): the p25 visit is 39% shorter than the median (8 chains, 422 visits; 13 Oct GPS evidence: time on site per chain, visit-weighted median of 1 - p25/p50).
- Reload (basis of FasterReload, still REQUIRES EVIDENCE): Reload between loads (trip 2+): 3T 30 min (p25 19, p50 28, p75 40, p90 60); 10T about 30 min (p50 28, p75 about 55, p90 about 80) before daytime trips (SUPPORTED (3T) / SUPPORTED, small n (10T))
- Latest return today: Latest return to depot: 10T p50 17:00, p75 18:57, p90 20:07; 3T p50 17:36, p75 18:39, p90 19:22. 3T in October: p50 18:16, p75 19:02, p90 20:20 (58% of days after 18:00). (SUPPORTED)
- IVMS last stop end per vehicle-day: p50 20:10, p75 21:34, p90 24:00

Labels: cash: OMR cash cost of the new loads (costing.truck_day_costs via DispatchScenario.truck_days); penalties: ARTIFICIAL: solver penalties in OMR-equivalent (leaving stops out, preferred windows, early arrival, plan continuity). Not cash; never add them to cash; km: estimated km (HAVERSINE: straight line x haversine_multiplier), not road km; time: minutes, trips and trucks: time and capacity, not cash

## REAL-15OCT: REAL, anonymised; 86 stops, 12 trucks

Budget 20 s QUICK per run, seeds [1, 2, 3]. 5 variants; every one solved cold and warm.

No real window has a provenance label today (RouteIQ records none), so every real window is UNKNOWN. The window levers on a real day are HYPOTHETICAL: they show what flexing would do if those windows turned out to be sales preferences.

**Baseline, cold:** cash 619.97 [540.15..734.12] OMR; stops served 83.7 [82.0..85.0] of 86; trucks 10.7 [10.0..12.0]; 1247.2 [1067.9..1493.7] estimated km. Seed spread (the search noise at this budget): cash 193.97 OMR, stops 3.

**Warm control** (the baseline re-solved for the same budget from its own plan): cash 637.09 [524.82..760.64] OMR; stops served 83.7 [83.0..84.0]; seed spread: cash 235.82 OMR, stops 1; warm start used in 3/3 runs.

| Variant | Group | Flags | Δ cash OMR, cold (spread 193.97) | Δ stops, cold (spread 3) | Δ cash OMR, warm (spread 235.82) | Δ stops, warm (spread 1) | warm start used |
|---|---|---|---|---|---|---|---|
| Flex(+10 min, HYPOTHETICAL) | SINGLE | HYPOTHETICAL | -94.36 [-243.23..+22.71] within search noise | +0.7 [-1.0..+2.0] within search noise | -103.33 [-279.99..+58.93] within search noise | +0.7 [-1.0..+2.0] within search noise | 3/3 |
| Flex(+20 min, HYPOTHETICAL) | SINGLE | HYPOTHETICAL | -47.27 [-102.17..+5.07] within search noise | -5.0 [-14.0..+1.0] | -92.14 [-128.69..-38.00] within search noise | -4.7 [-16.0..+2.0] | 3/3 |
| Flex(+30 min, HYPOTHETICAL) | SINGLE | HYPOTHETICAL | -130.43 [-240.45..-52.67] within search noise | +0.7 [-1.0..+3.0] within search noise | -88.32 [-264.82..+110.78] within search noise | -3.3 [-12.0..+2.0] | 3/3 |
| FasterUnloading(-20% per case) | SINGLE | REQUIRES EVIDENCE | -116.94 [-223.14..-22.13] within search noise | +1.3 [+0.0..+3.0] within search noise | -132.97 [-273.98..-48.90] within search noise | +1.7 [+1.0..+2.0] | 3/3 |
| FasterReload(-15 min) | SINGLE | REQUIRES EVIDENCE | -27.45 [-194.99..+146.48] within search noise | +0.7 [-1.0..+2.0] within search noise | -80.91 [-241.21..+115.08] within search noise | -3.0 [-12.0..+2.0] | 3/3 |

Cold: variant and baseline each searched from scratch; Δ = variant - baseline, paired per seed, mean [min..max]. Warm: the variant (and the baseline itself, as the control) searched for the same budget starting from the same seed's cold baseline plan, which every lever here keeps feasible; Δ = variant - control, paired per seed. The warm start only guarantees the route search's own objective: the engine's exact load re-check after the search can still discard that plan and rebuild one, so a warm Δ can be negative. 'warm start used' counts the runs whose search could load the plan (the others searched cold). 'within search noise': the mean Δ is smaller than that baseline's seed spread. Cash includes the second-driver assumption for a truck back after the normal shift. Serving more stops costs more cash: read Δ cash with Δ stops.

### Full what-if report of the cold runs (whatif.WhatIfReport)

#### What-if and sensitivity: REAL, anonymised (coordinates still in memory)

Budget: 20 s per run, QUICK, seeds [1, 2, 3], RECOMMENDED only, one run at a time; request digest ad7706639ab2509b. Plans are the best found in that time, not proven optimal. Normal day end (latest return or depot closing) 19:00; each truck's own shift limit (first departure + shift maximum) applies too.

**Baseline:** cash 619.97 [540.15..734.12] OMR; stops served 83.7 [82.0..85.0] of 86; cases 7308 [6885..7885] of 8485; trucks 10.7 [10.0..12.0]; trips 16.0 [14.0..19.0]; 1247.2 [1067.9..1493.7] estimated km; proven impossible 0.0; feasibility VERIFIED x3.

Every Δ is variant minus baseline, paired per seed: mean [min..max] over the seeds. Cash includes the second-driver assumption where a truck works past the normal shift. Serving more stops usually costs more cash: read Δ cash together with Δ stops served. The baseline's own spread over the seeds is the search noise at this budget: a Δ whose range spans 0 is not established. Late stops and minutes outside preferred windows count against the day's own windows, before any lever moved them; the ARTIFICIAL window penalty is the solver's own, for the windows it was given.

##### Levers that need no new evidence

| Variant | Group | Flags | Δ cash OMR | Δ stops served | Δ cases served | Δ trucks | Δ trips | Δ est. km | Δ late stops | Δ proven impossible | Feasibility (per run) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Flex(+10 min, HYPOTHETICAL) | SINGLE | HYPOTHETICAL | -94.36 [-243.23..+22.71] | +0.7 [-1.0..+2.0] | +351 [-191..+1000] | -1.0 [-3.0..+0.0] | -2.0 [-5.0..+1.0] | -199.2 [-481.5..+133.8] | +2.0 [+1.0..+3.0] | +0.0 | VERIFIED x3 |
| Flex(+20 min, HYPOTHETICAL) | SINGLE | HYPOTHETICAL | -47.27 [-102.17..+5.07] | -5.0 [-14.0..+1.0] | +275 [-494..+1112] | -1.0 [-2.0..+0.0] | -1.3 [-5.0..+1.0] | -30.6 [-87.6..+54.5] | +5.3 [+4.0..+6.0] | +0.0 | VERIFIED x3 |
| Flex(+30 min, HYPOTHETICAL) | SINGLE | HYPOTHETICAL | -130.43 [-240.45..-52.67] | +0.7 [-1.0..+3.0] | +289 [-488..+844] | -1.7 [-3.0..-1.0] | -1.7 [-6.0..+1.0] | -238.9 [-504.7..-50.0] | +5.7 [+4.0..+9.0] | +0.0 | VERIFIED x3 |

##### Operational improvement potential (REQUIRES EVIDENCE, never a baseline)

| Variant | Group | Flags | Δ cash OMR | Δ stops served | Δ cases served | Δ trucks | Δ trips | Δ est. km | Δ late stops | Δ proven impossible | Feasibility (per run) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| FasterUnloading(-20% per case) | SINGLE | REQUIRES EVIDENCE | -116.94 [-223.14..-22.13] | +1.3 [+0.0..+3.0] | +577 [+0..+1000] | -1.3 [-3.0..+0.0] | -3.0 [-6.0..-1.0] | -217.5 [-433.8..-68.6] | +0.0 | +0.0 | VERIFIED x3 |
| FasterReload(-15 min) | SINGLE | REQUIRES EVIDENCE | -27.45 [-194.99..+146.48] | +0.7 [-1.0..+2.0] | +289 [-488..+1112] | +0.0 [-2.0..+2.0] | -1.3 [-6.0..+3.0] | -57.9 [-429.6..+386.0] | +0.0 | +0.0 | VERIFIED x3 |

##### Time and ARTIFICIAL solver penalties (not cash)

| Variant | Δ paid driver min | Δ min outside preferred windows | Δ window penalty (ARTIFICIAL) | Δ unserved penalty (ARTIFICIAL) | 2nd-driver shifts | their min after the normal end | 2nd-driver OMR (in cash) | engine overtime after the normal end OMR (in cash) |
|---|---|---|---|---|---|---|---|---|
| Flex(+10 min, HYPOTHETICAL) | -331 [-812..+253] | +0 | +0.00 | -50000 [-147000..+3000] | 0.0 | 0 | 0.00 | 0.00 |
| Flex(+20 min, HYPOTHETICAL) | -10 [-152..+154] | +0 | +0.00 | -34333 [-147000..+38000] | 0.0 | 0 | 0.00 | 0.00 |
| Flex(+30 min, HYPOTHETICAL) | -309 [-666..-33] | +0 | +0.00 | -50000 [-144000..+3000] | 0.0 | 0 | 0.00 | 0.00 |
| FasterUnloading(-20% per case) | -702 [-954..-489] | +0 | +0.00 | -52000 [-147000..+0] | 0.0 | 0 | 0.00 | 0.00 |
| FasterReload(-15 min) | -150 [-792..+427] | +0 | +0.00 | -50000 [-147000..+3000] | 0.0 | 0 | 0.00 | 0.00 |

##### What each variant changed

| Variant | windows widened | windows narrowed (kept in the normal shift) | stops with no truck | preferred ends moved | service times cut (min saved) | trucks' hours extended | config |
|---|---|---|---|---|---|---|---|
| Flex(+10 min, HYPOTHETICAL) | 82 | 0 | 0 | 0 | 0 (0) | 0 | - |
| Flex(+20 min, HYPOTHETICAL) | 82 | 0 | 0 | 0 | 0 (0) | 0 | - |
| Flex(+30 min, HYPOTHETICAL) | 82 | 0 | 0 | 0 | 0 (0) | 0 | - |
| FasterUnloading(-20% per case) | 0 | 0 | 0 | 0 | 72 (378) | 0 | - |
| FasterReload(-15 min) | 0 | 0 | 0 | 0 | 0 (0) | 0 | reload_min 35->20 |

Never changed by any lever: CUSTOMER_HARD windows, breaks, capacity, pallet fill, trips, allowed trucks (except the customers kept in the normal shift), orders and costs. UNKNOWN windows move only in rows marked HYPOTHETICAL (needs confirmation that these are preferences).

##### Assumptions

- window_provenance: RouteIQ records none: every window UNKNOWN
- per_case_min: 0.25. 14 Oct benchmark; 13 Oct drop-size model 0.243-0.245 per case
- base_min: derived: service - per case x cases, clamped to [0, service]
- night_driver_cost: 10.0. ASSUMPTION: the web's default daily driver day rate (hire.ts); the request has none. Added once per truck-day back after the normal shift end, on top of the engine's own hourly and overtime pay for those hours (conservative: part of that pay may count twice)
- extra_hours_speed: {'evening': 0.839, 'night': 0.708}. IVMS MOVING segments, Muscat (MOVING segments >= 1 km and >= 2 min, speed = km / hours <= 130): median km/h 06-18 30.7 (segment-weighted mean of the band medians, n=2978), 18-22 25.71 (n=398), 22-06 21.71 (n=147). Cross-check, 13 Oct truck evidence: Time-of-day factor, trucks, Muscat core: 1.00 except 12-15 about 1.06; 18+ 1.07-1.13 (low n) (INFERRED)

##### Evidence from the IVMS report and the 13 Oct truck evidence (aggregates only)

- Source: IVMS report 2026-01-31..2026-03-16, 45352 segments (aggregates only)
- Extra-hours speed factor: evening 0.839, night 0.708 (x day speed). IVMS MOVING segments, Muscat (MOVING segments >= 1 km and >= 2 min, speed = km / hours <= 130): median km/h 06-18 30.7 (segment-weighted mean of the band medians, n=2978), 18-22 25.71 (n=398), 22-06 21.71 (n=147). Cross-check, 13 Oct truck evidence: Time-of-day factor, trucks, Muscat core: 1.00 except 12-15 about 1.06; 18+ 1.07-1.13 (low n) (INFERRED)
- Unloading spread (basis of FasterUnloading, still REQUIRES EVIDENCE): the p25 visit is 39% shorter than the median (8 chains, 422 visits; 13 Oct GPS evidence: time on site per chain, visit-weighted median of 1 - p25/p50).
- Reload (basis of FasterReload, still REQUIRES EVIDENCE): Reload between loads (trip 2+): 3T 30 min (p25 19, p50 28, p75 40, p90 60); 10T about 30 min (p50 28, p75 about 55, p90 about 80) before daytime trips (SUPPORTED (3T) / SUPPORTED, small n (10T))
- Latest return today: Latest return to depot: 10T p50 17:00, p75 18:57, p90 20:07; 3T p50 17:36, p75 18:39, p90 19:22. 3T in October: p50 18:16, p75 19:02, p90 20:20 (58% of days after 18:00). (SUPPORTED)
- IVMS last stop end per vehicle-day: p50 20:10, p75 21:34, p90 24:00

Labels: cash: OMR cash cost of the new loads (costing.truck_day_costs via DispatchScenario.truck_days); penalties: ARTIFICIAL: solver penalties in OMR-equivalent (leaving stops out, preferred windows, early arrival, plan continuity). Not cash; never add them to cash; km: estimated km (HAVERSINE: straight line x haversine_multiplier), not road km; time: minutes, trips and trucks: time and capacity, not cash

## SYNTH-400: SYNTHETIC; 238 stops, 16 trucks

Budget 40 s QUICK per run, seeds [1, 2, 3]. 12 variants; every one solved cold and warm.

**Baseline, cold:** cash 794.79 [783.03..813.73] OMR; stops served 226.3 [225.0..228.0] of 238; trucks 16.0; 1377.0 [1323.4..1471.4] estimated km. Seed spread (the search noise at this budget): cash 30.69 OMR, stops 3.

**Warm control** (the baseline re-solved for the same budget from its own plan): cash 794.35 [782.74..807.43] OMR; stops served 227.0 [226.0..229.0]; seed spread: cash 24.68 OMR, stops 3; warm start used in 3/3 runs.

| Variant | Group | Flags | Δ cash OMR, cold (spread 30.69) | Δ stops, cold (spread 3) | Δ cash OMR, warm (spread 24.68) | Δ stops, warm (spread 3) | warm start used |
|---|---|---|---|---|---|---|---|
| Flex(+10 min) | SINGLE | - | -0.21 [-21.72..+22.87] within search noise | -3.7 [-6.0..-1.0] | +5.60 [-4.50..+10.72] within search noise | +1.3 [+0.0..+2.0] within search noise | 3/3 |
| Flex(+20 min) | SINGLE | - | +7.49 [-8.94..+19.56] within search noise | -1.0 [-2.0..+0.0] within search noise | +5.54 [-4.32..+23.00] within search noise | +2.3 [+2.0..+3.0] within search noise | 3/3 |
| Flex(+30 min) | SINGLE | - | -16.55 [-47.77..+3.26] within search noise | -2.3 [-4.0..+0.0] within search noise | +16.45 [+0.23..+43.72] within search noise | +1.7 [+0.0..+3.0] within search noise | 3/3 |
| PrefFlex(+30 min) | SINGLE | - | -1.59 [-9.80..+3.14] within search noise | -2.0 [-6.0..+1.0] within search noise | -2.06 [-3.68..-0.28] within search noise | +1.0 [+0.0..+2.0] within search noise | 3/3 |
| Afternoon(until 18:00) | SINGLE | - | +54.97 [+41.58..+72.88] | +10.0 [+7.0..+12.0] | +32.04 [+11.14..+48.77] | +9.7 [+8.0..+12.0] | 3/3 |
| Night(until 22:00) | SINGLE | - | +61.61 [+9.66..+90.40] | +6.0 [+3.0..+9.0] | +59.30 [+29.75..+84.04] | +9.0 [+7.0..+12.0] | 3/3 |
| FasterUnloading(-20% per case) | SINGLE | REQUIRES EVIDENCE | -28.18 [-40.00..-21.90] within search noise | +2.0 [-5.0..+6.0] within search noise | -19.01 [-40.93..+15.56] within search noise | +5.0 [+3.0..+8.0] | 3/3 |
| FasterReload(-15 min) | SINGLE | REQUIRES EVIDENCE | +1.96 [-16.66..+33.58] within search noise | +1.0 [-2.0..+4.0] within search noise | -0.11 [-6.54..+8.09] within search noise | +2.7 [+1.0..+4.0] within search noise | 3/3 |
| Flex(+20 min) + Afternoon(until 18:00) | PAIR | - | +47.86 [+19.65..+67.77] | +10.7 [+9.0..+13.0] | +48.50 [+45.33..+50.09] | +10.7 [+9.0..+12.0] | 3/3 |
| Flex(+30 min) + Afternoon(until 18:00) | PAIR | - | +55.40 [+38.71..+83.74] | +10.0 [+8.0..+12.0] | +41.38 [+7.65..+64.10] | +8.7 [+7.0..+12.0] | 3/3 |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) | ALL | - | +45.62 [+41.11..+49.12] | +11.7 [+10.0..+13.0] | +52.80 [+28.26..+76.00] | +11.0 [+9.0..+12.0] | 3/3 |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) + FasterUnloading(-20% per case) + FasterReload(-15 min) | ALL_WITH_EVIDENCE | REQUIRES EVIDENCE | +11.46 [-6.34..+22.75] within search noise | +11.3 [+10.0..+12.0] | -14.35 [-21.69..-4.86] within search noise | +11.0 [+9.0..+12.0] | 3/3 |

Cold: variant and baseline each searched from scratch; Δ = variant - baseline, paired per seed, mean [min..max]. Warm: the variant (and the baseline itself, as the control) searched for the same budget starting from the same seed's cold baseline plan, which every lever here keeps feasible; Δ = variant - control, paired per seed. The warm start only guarantees the route search's own objective: the engine's exact load re-check after the search can still discard that plan and rebuild one, so a warm Δ can be negative. 'warm start used' counts the runs whose search could load the plan (the others searched cold). 'within search noise': the mean Δ is smaller than that baseline's seed spread. Cash includes the second-driver assumption for a truck back after the normal shift. Serving more stops costs more cash: read Δ cash with Δ stops.

### Full what-if report of the cold runs (whatif.WhatIfReport)

#### What-if and sensitivity: SYNTHETIC nmwc day, 400 invoices, seed 2

Budget: 40 s per run, QUICK, seeds [1, 2, 3], RECOMMENDED only, one run at a time; request digest 5128261cb7086dc3. Plans are the best found in that time, not proven optimal. Normal day end (latest return or depot closing) 19:00; each truck's own shift limit (first departure + shift maximum) applies too.

**Baseline:** cash 794.79 [783.03..813.73] OMR; stops served 226.3 [225.0..228.0] of 238; cases 12537 [12438..12683] of 12861; trucks 16.0; trips 28.3 [27.0..30.0]; 1377.0 [1323.4..1471.4] estimated km; proven impossible 0.0; feasibility VERIFIED x3.

Every Δ is variant minus baseline, paired per seed: mean [min..max] over the seeds. Cash includes the second-driver assumption where a truck works past the normal shift. Serving more stops usually costs more cash: read Δ cash together with Δ stops served. The baseline's own spread over the seeds is the search noise at this budget: a Δ whose range spans 0 is not established. Late stops and minutes outside preferred windows count against the day's own windows, before any lever moved them; the ARTIFICIAL window penalty is the solver's own, for the windows it was given.

##### Levers that need no new evidence

| Variant | Group | Flags | Δ cash OMR | Δ stops served | Δ cases served | Δ trucks | Δ trips | Δ est. km | Δ late stops | Δ proven impossible | Feasibility (per run) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Flex(+10 min) | SINGLE | - | -0.21 [-21.72..+22.87] | -3.7 [-6.0..-1.0] | -123 [-248..+40] | +0.0 | +0.0 [-2.0..+1.0] | -7.2 [-101.2..+90.9] | +8.7 [+8.0..+10.0] | +0.0 | VERIFIED x3 |
| Flex(+20 min) | SINGLE | - | +7.49 [-8.94..+19.56] | -1.0 [-2.0..+0.0] | +49 [-10..+139] | +0.0 | +1.0 [-1.0..+3.0] | +7.3 [-81.8..+79.7] | +10.7 [+9.0..+12.0] | +0.0 | VERIFIED x3 |
| Flex(+30 min) | SINGLE | - | -16.55 [-47.77..+3.26] | -2.3 [-4.0..+0.0] | +50 [-183..+173] | +0.0 | +1.3 [+0.0..+2.0] | -103.0 [-245.2..-10.7] | +12.3 [+11.0..+14.0] | +0.0 | VERIFIED x3 |
| PrefFlex(+30 min) | SINGLE | - | -1.59 [-9.80..+3.14] | -2.0 [-6.0..+1.0] | +37 [-166..+210] | +0.0 | -0.7 [-3.0..+1.0] | -27.2 [-45.8..+6.3] | +0.0 | +0.0 | VERIFIED x3 |
| Afternoon(until 18:00) | SINGLE | - | +54.97 [+41.58..+72.88] | +10.0 [+7.0..+12.0] | +237 [+90..+422] | +0.0 | -0.3 [-1.0..+0.0] | +153.9 [+114.1..+221.4] | +30.3 [+30.0..+31.0] | +0.0 | VERIFIED x3 |
| Night(until 22:00) | SINGLE | 2nd driver | +61.61 [+9.66..+90.40] | +6.0 [+3.0..+9.0] | +250 [+66..+400] | +0.0 | +0.7 [-1.0..+2.0] | +127.3 [-38.3..+253.6] | +7.0 | +0.0 | VERIFIED x3 |
| Flex(+20 min) + Afternoon(until 18:00) | PAIR | - | +47.86 [+19.65..+67.77] | +10.7 [+9.0..+13.0] | +322 [+178..+423] | +0.0 | +0.7 [-1.0..+2.0] | +97.6 [-47.5..+226.4] | +36.0 [+35.0..+37.0] | +0.0 | VERIFIED x3 |
| Flex(+30 min) + Afternoon(until 18:00) | PAIR | - | +55.40 [+38.71..+83.74] | +10.0 [+8.0..+12.0] | +300 [+178..+383] | +0.0 | -0.3 [-2.0..+1.0] | +164.7 [+99.5..+275.3] | +34.3 [+34.0..+35.0] | +0.0 | VERIFIED x3 |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) | ALL | - | +45.62 [+41.11..+49.12] | +11.7 [+10.0..+13.0] | +324 [+178..+423] | +0.0 | +1.0 [+0.0..+2.0] | +84.8 [+70.7..+93.5] | +35.3 [+34.0..+37.0] | +0.0 | VERIFIED x3 |

##### Operational improvement potential (REQUIRES EVIDENCE, never a baseline)

| Variant | Group | Flags | Δ cash OMR | Δ stops served | Δ cases served | Δ trucks | Δ trips | Δ est. km | Δ late stops | Δ proven impossible | Feasibility (per run) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| FasterUnloading(-20% per case) | SINGLE | REQUIRES EVIDENCE | -28.18 [-40.00..-21.90] | +2.0 [-5.0..+6.0] | +173 [-68..+300] | +0.0 | -0.3 [-1.0..+1.0] | +8.0 [-71.5..+59.7] | +0.0 | +0.0 | VERIFIED x3 |
| FasterReload(-15 min) | SINGLE | REQUIRES EVIDENCE | +1.96 [-16.66..+33.58] | +1.0 [-2.0..+4.0] | +102 [-115..+230] | +0.0 | +0.3 [+0.0..+1.0] | +2.3 [-70.0..+142.6] | +0.0 | +0.0 | VERIFIED x3 |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) + FasterUnloading(-20% per case) + FasterReload(-15 min) | ALL_WITH_EVIDENCE | REQUIRES EVIDENCE | +11.46 [-6.34..+22.75] | +11.3 [+10.0..+12.0] | +323 [+178..+422] | +0.0 | -0.3 [-1.0..+0.0] | +162.5 [+78.5..+226.4] | +34.0 [+33.0..+35.0] | +0.0 | VERIFIED x3 |

##### Time and ARTIFICIAL solver penalties (not cash)

| Variant | Δ paid driver min | Δ min outside preferred windows | Δ window penalty (ARTIFICIAL) | Δ unserved penalty (ARTIFICIAL) | 2nd-driver shifts | their min after the normal end | 2nd-driver OMR (in cash) | engine overtime after the normal end OMR (in cash) |
|---|---|---|---|---|---|---|---|---|
| Flex(+10 min) | -109 [-372..+115] | -330 [-1942..+1312] | -16.54 [-97.04..+65.42] | +1411000 [-1890000..+4140000] | 0.0 | 0 | 0.00 | 0.00 |
| Flex(+20 min) | +56 [-68..+121] | -690 [-1468..+229] | -34.49 [-73.08..+11.34] | +719333 [-88000..+2112000] | 0.0 | 0 | 0.00 | 0.00 |
| Flex(+30 min) | -142 [-382..+38] | -713 [-1712..+1226] | -35.77 [-85.70..+61.09] | +735333 [+44000..+2115000] | 0.0 | 0 | 0.00 | 0.00 |
| PrefFlex(+30 min) | -31 [-107..+42] | -11 [-1213..+895] | -135.57 [-195.21..-86.88] | +735000 [-1890000..+4096000] | 0.0 | 0 | 0.00 | 0.00 |
| Afternoon(until 18:00) | +429 [+327..+542] | -4623 [-6289..-3756] | -231.17 [-314.23..-187.97] | -2751333 [-4102000..-2030000] | 0.0 | 0 | 0.00 | 0.00 |
| Night(until 22:00) | +362 [+143..+500] | -320 [-2219..+2585] | -16.07 [-111.18..+129.36] | -2674000 [-4055000..-1938000] | 1.0 [0.0..2.0] | 49 [0..108] | 10.00 [0.00..20.00] | 3.29 [0.00..7.20] |
| FasterUnloading(-20% per case) | -587 [-668..-475] | -3291 [-4760..-2130] | -164.56 [-237.83..-106.70] | -1321333 [-2073000..+137000] | 0.0 | 0 | 0.00 | 0.00 |
| FasterReload(-15 min) | -35 [-122..+129] | -102 [-525..+229] | -5.17 [-26.48..+11.27] | -631333 [-2071000..+134000] | 0.0 | 0 | 0.00 | 0.00 |
| Flex(+20 min) + Afternoon(until 18:00) | +377 [+215..+531] | -5215 [-6300..-4029] | -260.76 [-314.97..-201.60] | -2737333 [-4103000..-2033000] | 0.0 | 0 | 0.00 | 0.00 |
| Flex(+30 min) + Afternoon(until 18:00) | +447 [+308..+659] | -4722 [-5193..-4062] | -236.23 [-259.66..-203.45] | -2736667 [-4102000..-2033000] | 0.0 | 0 | 0.00 | 0.00 |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) | +380 [+351..+398] | -6166 [-7414..-5491] | -404.89 [-465.38..-365.61] | -3412667 [-4103000..-2033000] | 0.0 | 0 | 0.00 | 0.00 |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) + FasterUnloading(-20% per case) + FasterReload(-15 min) | -322 [-464..-147] | -8949 [-9928..-7913] | -516.99 [-565.58..-464.11] | -3412333 [-4102000..-2033000] | 0.0 | 0 | 0.00 | 0.00 |

##### Extra hours at the IVMS evening / night speed

The engine has one time matrix for the whole day. Each plan below was re-timed with the drive minutes after the normal shift end slowed to the IVMS speed of their hour; stops or returns that would then be late are counted (the plan's own figures above do not include this).

| Variant | legs in the extra hours | extra drive min | stops late at IVMS speed | loads back late |
|---|---|---|---|---|
| Night(until 22:00) | 1.0 [0.0..2.0] | 4 [0..7] | 0.0 | 0.0 |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) | 0.0 | 0 | 0.0 | 0.0 |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) + FasterUnloading(-20% per case) + FasterReload(-15 min) | 0.0 | 0 | 0.0 | 0.0 |

##### What each variant changed

| Variant | windows widened | windows narrowed (kept in the normal shift) | stops with no truck | preferred ends moved | service times cut (min saved) | trucks' hours extended | config |
|---|---|---|---|---|---|---|---|
| Flex(+10 min) | 51 | 0 | 0 | 0 | 0 (0) | 0 | - |
| Flex(+20 min) | 51 | 0 | 0 | 0 | 0 (0) | 0 | - |
| Flex(+30 min) | 51 | 0 | 0 | 0 | 0 (0) | 0 | - |
| PrefFlex(+30 min) | 0 | 0 | 0 | 133 | 0 (0) | 0 | - |
| Afternoon(until 18:00) | 36 | 0 | 0 | 0 | 0 (0) | 0 | - |
| Night(until 22:00) | 8 | 88 | 0 | 0 | 0 (0) | 0 | latest_return_min 1140->1320; shift_max_min 690->870 |
| FasterUnloading(-20% per case) | 0 | 0 | 0 | 0 | 177 (630) | 0 | - |
| FasterReload(-15 min) | 0 | 0 | 0 | 0 | 0 (0) | 0 | reload_min 30->15 |
| Flex(+20 min) + Afternoon(until 18:00) | 51 | 0 | 0 | 0 | 0 (0) | 0 | - |
| Flex(+30 min) + Afternoon(until 18:00) | 51 | 0 | 0 | 0 | 0 (0) | 0 | - |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) | 51 | 88 | 0 | 133 | 0 (0) | 0 | latest_return_min 1140->1320; shift_max_min 690->870 |
| Flex(+30 min) + PrefFlex(+30 min) + Afternoon(until 18:00) + Night(until 22:00) + FasterUnloading(-20% per case) + FasterReload(-15 min) | 51 | 88 | 0 | 133 | 177 (630) | 0 | latest_return_min 1140->1320; reload_min 30->15; shift_max_min 690->870 |

Never changed by any lever: CUSTOMER_HARD windows, breaks, capacity, pallet fill, trips, allowed trucks (except the customers kept in the normal shift), orders and costs. UNKNOWN windows move only in rows marked HYPOTHETICAL (needs confirmation that these are preferences).

##### Assumptions

- window_provenance: the generator's labels (SYNTHETIC)
- per_case_min: 0.25. 14 Oct benchmark; 13 Oct drop-size model 0.243-0.245 per case
- base_min: the generator's customer-type base (synth.TYPES)
- night_driver_cost: 10.0. ASSUMPTION: the web's default daily driver day rate (hire.ts); the request has none. Added once per truck-day back after the normal shift end, on top of the engine's own hourly and overtime pay for those hours (conservative: part of that pay may count twice)
- extra_hours_speed: {'evening': 0.839, 'night': 0.708}. IVMS MOVING segments, Muscat (MOVING segments >= 1 km and >= 2 min, speed = km / hours <= 130): median km/h 06-18 30.7 (segment-weighted mean of the band medians, n=2978), 18-22 25.71 (n=398), 22-06 21.71 (n=147). Cross-check, 13 Oct truck evidence: Time-of-day factor, trucks, Muscat core: 1.00 except 12-15 about 1.06; 18+ 1.07-1.13 (low n) (INFERRED)

##### Evidence from the IVMS report and the 13 Oct truck evidence (aggregates only)

- Source: IVMS report 2026-01-31..2026-03-16, 45352 segments (aggregates only)
- Extra-hours speed factor: evening 0.839, night 0.708 (x day speed). IVMS MOVING segments, Muscat (MOVING segments >= 1 km and >= 2 min, speed = km / hours <= 130): median km/h 06-18 30.7 (segment-weighted mean of the band medians, n=2978), 18-22 25.71 (n=398), 22-06 21.71 (n=147). Cross-check, 13 Oct truck evidence: Time-of-day factor, trucks, Muscat core: 1.00 except 12-15 about 1.06; 18+ 1.07-1.13 (low n) (INFERRED)
- Unloading spread (basis of FasterUnloading, still REQUIRES EVIDENCE): the p25 visit is 39% shorter than the median (8 chains, 422 visits; 13 Oct GPS evidence: time on site per chain, visit-weighted median of 1 - p25/p50).
- Reload (basis of FasterReload, still REQUIRES EVIDENCE): Reload between loads (trip 2+): 3T 30 min (p25 19, p50 28, p75 40, p90 60); 10T about 30 min (p50 28, p75 about 55, p90 about 80) before daytime trips (SUPPORTED (3T) / SUPPORTED, small n (10T))
- Latest return today: Latest return to depot: 10T p50 17:00, p75 18:57, p90 20:07; 3T p50 17:36, p75 18:39, p90 19:22. 3T in October: p50 18:16, p75 19:02, p90 20:20 (58% of days after 18:00). (SUPPORTED)
- IVMS last stop end per vehicle-day: p50 20:10, p75 21:34, p90 24:00

Labels: cash: OMR cash cost of the new loads (costing.truck_day_costs via DispatchScenario.truck_days); penalties: ARTIFICIAL: solver penalties in OMR-equivalent (leaving stops out, preferred windows, early arrival, plan continuity). Not cash; never add them to cash; km: estimated km (HAVERSINE: straight line x haversine_multiplier), not road km; time: minutes, trips and trucks: time and capacity, not cash
