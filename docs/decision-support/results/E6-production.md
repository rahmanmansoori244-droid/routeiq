# E6: Model behaviour at production settings

- Commit bdf62d077468; written 2026-10-15T13:24:29+00:00.
- Settings: PROD THOROUGH, cap 1200 s for the whole request (the request's own max_search_sec when lower), never less than QUICK's time (the automatic time by day size), the engine's stall rule; SOLVER_PARALLEL=1 SOLVER_PYVRP=on; all three plan options, QUICKP QUICK, the automatic time by day size; SOLVER_PARALLEL=1 SOLVER_PYVRP=on; all three plan options; seeds PROD on a real day [1, 2, 3], every other run [1, 2, 3, 4, 5], perturbations 1.
- Machine: 4 CPUs, AMD EPYC 9V74 80-Core Processor; Python 3.11.17; OR-Tools 9.15.675.
- Items done 58/58; compute 455.9 min (sum of item wall times); wall time 130.6 min (first start to last finish); lanes 0/1.
- Not equal compute: E6 runs the engine as production does - all three plan options in one response, worker processes (SOLVER_PARALLEL=1), the second route search (SOLVER_PYVRP=on, its seed = the run's seed), the engine's own THOROUGH cap and stall rule (every tuning switch cleared) - one run at a time per machine. Unlike production it plans offline: HAVERSINE estimated km, not OSRM road distances.
- Distances are HAVERSINE estimates (estimated km). Plans are the best found in the time given, not proven optimal; only E5's oracle proves optimality, on the instances it enumerates completely. Cash is OMR (costing.truck_day_costs); solver penalties are ARTIFICIAL and never added to cash.

Days: the real 15 Oct request (86 stops) and the pre-fix 15 Oct request (94 stops), anonymised, and three SYNTHETIC days (320 invoices, synth seeds 1 and 2; 400 invoices, synth seed 3). Variants: PROD = THOROUGH as the requests ask (cap 1,200 s for the whole request, the engine's stall rule: stop once the best plan has not improved for max(300 s, half the time searched)); QUICKP = QUICK, the automatic time by day size. Both return RECOMMENDED, MIN_TRUCKS and MIN_DISTANCE in one response, with worker processes and the second route search, as production. Perturbations on the real days: P0 nothing changed: the same day solved again (the control: how much a timed search varies by itself); P1 one small stop removed (an order cancelled); P2 +5% cases (at least 1) on 10% of the stops; P3 one stop's receiving window 30 min later; P4 one truck unavailable; P5 one late order: a copy of a small stop, 1 km away.

## REAL-15OCT: REAL, anonymised; 86 stops, 12 trucks

Runs: PROD seeds [1, 2, 3] of [1, 2, 3]; QUICKP seeds [1, 2, 3, 4, 5] of [1, 2, 3, 4, 5]; perturbations 6 of 6 (QUICKP, seed 1).

### Spread over the seeds

| variant | option | runs | cash OMR, mean [min..max] | cash sd | trucks | loads | stops served | cases served | stops left out P1/P2/P3/P4/P5 (mean) | late stops (max) | min outside preferred windows | estimated km | VERIFIED | option's search s | whole request s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PROD | RECOMMENDED | 3 | 633.70 [599.09..668.75] | 34.84 | 11.7 [11.0..12.0] | 13.7 [11.0..16.0] | 85.7 [85.0..86.0] of 86 | 8322 [7997..8485] of 8485 | 0/0/0.33/0/0 | 0 | 0 | 979.5 [919.4..1089.5] | 3/3 | 703 [487..1115] | 764 [548..1176] |
| PROD | MIN_TRUCKS | 3 | 641.48 [599.09..668.75] | 37.22 | 11.3 [11.0..12.0] | 12.7 [11.0..16.0] | 85.7 [85.0..86.0] of 86 | 8322 [7997..8485] of 8485 | 0/0/0.33/0/0 | 0 | 0 | 964.1 [883.5..1089.5] | 3/3 | 176 [132..207] | 764 [548..1176] |
| PROD | MIN_DISTANCE | 3 | 641.48 [599.09..668.75] | 37.22 | 11.3 [11.0..12.0] | 12.7 [11.0..16.0] | 85.7 [85.0..86.0] of 86 | 8322 [7997..8485] of 8485 | 0/0/0.33/0/0 | 0 | 0 | 964.1 [883.5..1089.5] | 3/3 | 176 [132..207] | 764 [548..1176] |
| QUICKP | RECOMMENDED | 5 | 593.57 [540.22..652.90] | 46.30 | 10.8 [10.0..12.0] | 14.4 [12.0..16.0] | 85.6 [85.0..86.0] of 86 | 8245 [7885..8485] of 8485 | 0/0/0.4/0/0 | 0 | 0 | 1041.2 [942.9..1109.8] | 5/5 | 87 [50..112] | 97 [60..123] |
| QUICKP | MIN_TRUCKS | 5 | 624.31 [540.22..691.06] | 71.80 | 10.8 [10.0..12.0] | 13.4 [12.0..15.0] | 85.6 [85.0..86.0] of 86 | 8245 [7885..8485] of 8485 | 0/0/0.4/0/0 | 0 | 0 | 1009.1 [931.1..1094.2] | 5/5 | 77 [40..102] | 97 [60..123] |
| QUICKP | MIN_DISTANCE | 5 | 631.69 [540.22..691.06] | 64.36 | 11.0 [10.0..12.0] | 13.4 [12.0..15.0] | 85.6 [85.0..86.0] of 86 | 8245 [7885..8485] of 8485 | 0/0/0.4/0/0 | 0 | 0 | 1003.5 [931.1..1094.2] | 5/5 | 77 [40..102] | 97 [60..123] |

Cash parts, mean OMR (costing.truck_day_costs):

| variant | option | fixed | trip | distance | fuel | driver | overtime |
|---|---|---|---|---|---|---|---|
| PROD | RECOMMENDED | 284.13 | 0.00 | 85.76 | 68.77 | 195.04 | 0.00 |
| PROD | MIN_TRUCKS | 267.47 | 0.00 | 110.80 | 67.98 | 195.23 | 0.00 |
| PROD | MIN_DISTANCE | 267.47 | 0.00 | 110.80 | 67.98 | 195.23 | 0.00 |
| QUICKP | RECOMMENDED | 240.80 | 0.00 | 78.37 | 71.37 | 203.03 | 0.00 |
| QUICKP | MIN_TRUCKS | 240.80 | 0.00 | 114.92 | 70.52 | 198.07 | 0.00 |
| QUICKP | MIN_DISTANCE | 250.80 | 0.00 | 114.09 | 69.37 | 197.43 | 0.00 |

### Which option is cheapest, and does RECOMMENDED leave out what another option serves

| variant | runs | cheapest at the run's best service: RECOMMENDED / MIN_TRUCKS / MIN_DISTANCE | reach the best service: R / MT / MD | all three serve alike | RECOMMENDED serves less than the best option | runs where RECOMMENDED leaves out a stop another option serves | those stops, P1/P2/P3/P4/P5 |
|---|---|---|---|---|---|---|---|
| PROD | 3 | 3 / 2 / 2 | 3 / 3 / 3 | 3 | 0 | 0 | 0/0/0/0/0 |
| QUICKP | 5 | 4 / 3 / 2 | 5 / 5 / 5 | 5 | 0 | 0 | 0/0/0/0/0 |

Best service: the most P1 stops served, then P2, and so on (the engine's strict priorities). A tie for cheapest counts for each option in it.

### Convergence of PROD (THOROUGH)

| seed | stopped | RECOMMENDED search s (limit) | whole request s (cap) | last improvement s | search objective above its end at 60 / 120 / 300 / 600 s | stops not yet planned at 60 / 120 / 300 / 600 s | second search (PyVRP) |
|---|---|---|---|---|---|---|---|
| 1 | CONVERGED | 436.4 (984) | 568.6 (1200) | 136.4 | 12.0 / 11.1 / 0.0 / 0.0 | 0 / 0 / 0 / 0 | SKIPPED (ALLOWED_TRUCKS) |
| 2 | CONVERGED | 340.8 (984) | 547.9 (1200) | 40.7 | 0.0 / 0.0 / 0.0 / 0.0 | 0 / 0 / 0 / 0 | SKIPPED (ALLOWED_TRUCKS) |
| 3 | CAP | 984.0 (984) | 1175.5 (1200) | 495.3 | 9.2 / 9.2 / 3.5 / 0.0 | 0 / 0 / 0 / 0 | SKIPPED (ALLOWED_TRUCKS) |

Search objective: the route search's own score before the load re-check - cash-like costs plus ARTIFICIAL penalties (1,000 OMR or more for each stop not planned yet) - not cash. A value at a mark is the last of at most 12 kept points by then, so the true gap is at most that. '-': no plan by then. Over the runs: at 60 s mean 7.1 [max 12.0] above the end, 3 of 3 still searching; at 120 s mean 6.8 [max 11.1] above the end, 3 of 3 still searching; at 300 s mean 1.2 [max 3.5] above the end, 3 of 3 still searching; at 600 s mean 0.0 [max 0.0] above the end, 1 of 3 still searching.

Second route search (PyVRP): PROD: SKIPPED (ALLOWED_TRUCKS) 3 - chosen for RECOMMENDED 0, MIN_TRUCKS 0, MIN_DISTANCE 0; QUICKP: SKIPPED (ALLOWED_TRUCKS) 5 - chosen for RECOMMENDED 0, MIN_TRUCKS 0, MIN_DISTANCE 0.

### PROD against QUICKP (PROD - QUICKP, paired by seed)

Seeds [1, 2, 3]. Whole request: PROD 764 [548..1176] s, QUICKP 97 [60..123] s.

| option | pairs | Δ cash OMR | Δ stops served | Δ trucks | Δ loads | Δ estimated km | PROD serves more / less | alike: PROD cheaper / dearer / same cash |
|---|---|---|---|---|---|---|---|---|
| RECOMMENDED | 3 | +30.76 [-53.82..+78.61] | -0.3 [-1.0..+0.0] | +0.7 [-1.0..+2.0] | -0.7 [-1.0..+0.0] | -48.8 [-137.4..+14.5] | 0 / 1 | 0 / 2 / 0 |
| MIN_TRUCKS | 3 | +8.67 [-53.63..+101.95] | -0.3 [-1.0..+0.0] | +0.3 [-1.0..+1.0] | -0.3 [-4.0..+4.0] | -15.9 [-183.6..+158.3] | 0 / 1 | 1 / 1 / 0 |
| MIN_DISTANCE | 3 | -3.62 [-53.63..+65.09] | -0.3 [-1.0..+0.0] | +0.0 [-1.0..+1.0] | -0.3 [-4.0..+4.0] | -6.5 [-155.3..+158.3] | 0 / 1 | 1 / 1 / 0 |

Serving more stops costs more cash: read Δ cash with Δ stops served.

### Stability: the plan after a small change of the day (QUICKP, seed 1, RECOMMENDED)

| change | stops moved (truck or load) | stops on another truck | trucks used before -> after (changed) | Δ cash OMR | Δ other stops served | Δ loads | the changed stop | VERIFIED |
|---|---|---|---|---|---|---|---|---|
| P0: none | 4 | 4 | 10 -> 10 (0) | +29.12 | +0 | +1 | - | VERIFIED |
| P1: stop-035 removed (3 cases, P3) | 67 | 61 | 10 -> 11 (1) | +17.79 | +0 | -2 | served before | VERIFIED |
| P2: 9 stops +5% cases (at least 1): 42 cases in all; kg and pallets in proportion; unloading +0.25 min per case added | 65 | 58 | 10 -> 12 (2) | +89.22 | +0 | -1 | - | VERIFIED |
| P3: stop-071: receiving window 30 min later (opening, closing and any preferred window) | 72 | 66 | 10 -> 10 (2) | -34.03 | -1 | -2 | served yes -> yes | VERIFIED |
| P4: truck-11 unavailable (it carried 15 stops in the base plan) | 83 | 79 | 10 -> 11 (3) | +77.67 | -1 | +1 | 15 stops had to leave the truck | VERIFIED |
| P5: stop-027-late added: a copy of stop-027 (1 cases, P3) 1 km north, as a new customer's late order | 74 | 72 | 10 -> 11 (1) | +58.14 | +0 | +0 | served | VERIFIED |

Reference with no change of the day: the plans of seeds [2, 3, 4, 5] against seed 1's moved 75.5 [75.0..76.0] stops (74.0 [73.0..75.0] to another truck), cash +48.64 [-14.44..+98.24] OMR, other stops served -0.5 [-1.0..+0.0].

Each changed day is solved from scratch, as a new OPTIMIZE (no plan continuity: no previous truck ids), and compared with the base plan. 'Stops moved': stops of both plans on another truck or load number. 'Other stops served': stops of both days. P0 is the control: the same day solved again, so whatever moves there is the timed search's own variation. All three options are in the JSON.

## REAL-15OCT-PREFIX: REAL, anonymised; 94 stops, 9 trucks

Runs: PROD seeds [1, 2, 3] of [1, 2, 3]; QUICKP seeds [1, 2, 3, 4, 5] of [1, 2, 3, 4, 5]; perturbations 6 of 6 (QUICKP, seed 1).

### Spread over the seeds

| variant | option | runs | cash OMR, mean [min..max] | cash sd | trucks | loads | stops served | cases served | stops left out P1/P2/P3/P4/P5 (mean) | late stops (max) | min outside preferred windows | estimated km | VERIFIED | option's search s | whole request s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PROD | RECOMMENDED | 3 | 551.88 [510.02..607.70] | 50.31 | 9.0 | 13.3 [12.0..15.0] | 83.0 [73.0..89.0] of 94 | 5937 [5632..6418] of 8500 | 0/0.67/9/1.33/0 | 0 | 0 | 1032.2 [961.5..1086.0] | 3/3 | 987 [731..1115] | 1048 [792..1176] |
| PROD | MIN_TRUCKS | 3 | 551.88 [510.02..607.70] | 50.31 | 9.0 | 13.3 [12.0..15.0] | 83.0 [73.0..89.0] of 94 | 5937 [5632..6418] of 8500 | 0/0.67/9/1.33/0 | 0 | 0 | 1032.2 [961.5..1086.0] | 3/3 | 197 [191..210] | 1048 [792..1176] |
| PROD | MIN_DISTANCE | 3 | 551.91 [510.09..607.70] | 50.28 | 9.0 | 13.7 [13.0..15.0] | 83.0 [73.0..89.0] of 94 | 5937 [5632..6418] of 8500 | 0/0.67/9/1.33/0 | 0 | 0 | 1032.1 [961.5..1086.0] | 3/3 | 197 [191..210] | 1048 [792..1176] |
| QUICKP | RECOMMENDED | 5 | 492.54 [478.75..505.92] | 10.75 | 9.0 | 12.2 [11.0..13.0] | 83.8 [80.0..89.0] of 94 | 5965 [5345..6379] of 8500 | 0/0.4/8.6/1.2/0 | 0 | 0 | 941.0 [865.2..1047.1] | 5/5 | 101 [92..109] | 111 [103..120] |
| QUICKP | MIN_TRUCKS | 5 | 494.23 [478.75..509.19] | 12.88 | 9.0 | 12.0 [11.0..13.0] | 83.8 [80.0..89.0] of 94 | 6061 [5752..6379] of 8500 | 0/0.4/8.6/1.2/0 | 0 | 0 | 944.9 [865.2..1068.0] | 5/5 | 91 [82..99] | 111 [103..120] |
| QUICKP | MIN_DISTANCE | 5 | 492.50 [478.75..505.92] | 10.77 | 9.0 | 12.2 [11.0..13.0] | 83.8 [80.0..89.0] of 94 | 5965 [5345..6379] of 8500 | 0/0.4/8.6/1.2/0 | 0 | 0 | 940.7 [865.2..1047.1] | 5/5 | 91 [82..99] | 111 [103..120] |

Cash parts, mean OMR (costing.truck_day_costs):

| variant | option | fixed | trip | distance | fuel | driver | overtime |
|---|---|---|---|---|---|---|---|
| PROD | RECOMMENDED | 150.80 | 0.00 | 110.41 | 76.09 | 214.58 | 0.00 |
| PROD | MIN_TRUCKS | 150.80 | 0.00 | 110.41 | 76.09 | 214.58 | 0.00 |
| PROD | MIN_DISTANCE | 150.80 | 0.00 | 109.62 | 76.08 | 215.41 | 0.00 |
| QUICKP | RECOMMENDED | 150.80 | 0.00 | 65.53 | 69.37 | 206.85 | 0.00 |
| QUICKP | MIN_TRUCKS | 150.80 | 0.00 | 66.06 | 69.65 | 207.72 | 0.00 |
| QUICKP | MIN_DISTANCE | 150.80 | 0.00 | 65.52 | 69.35 | 206.84 | 0.00 |

### Which option is cheapest, and does RECOMMENDED leave out what another option serves

| variant | runs | cheapest at the run's best service: RECOMMENDED / MIN_TRUCKS / MIN_DISTANCE | reach the best service: R / MT / MD | all three serve alike | RECOMMENDED serves less than the best option | runs where RECOMMENDED leaves out a stop another option serves | those stops, P1/P2/P3/P4/P5 |
|---|---|---|---|---|---|---|---|
| PROD | 3 | 3 / 3 / 2 | 3 / 3 / 3 | 3 | 0 | 0 | 0/0/0/0/0 |
| QUICKP | 5 | 3 / 4 / 5 | 5 / 5 / 5 | 5 | 0 | 1 | 0/0/1/0/0 |

Best service: the most P1 stops served, then P2, and so on (the engine's strict priorities). A tie for cheapest counts for each option in it.

### Convergence of PROD (THOROUGH)

| seed | stopped | RECOMMENDED search s (limit) | whole request s (cap) | last improvement s | search objective above its end at 60 / 120 / 300 / 600 s | stops not yet planned at 60 / 120 / 300 / 600 s | second search (PyVRP) |
|---|---|---|---|---|---|---|---|
| 1 | CAP | 984.0 (984) | 1175.5 (1200) | 903.4 | 3004.3 / 3004.3 / 5.3 / 4.2 | 4 / 4 / 3 / 3 | SKIPPED (ALLOWED_TRUCKS) |
| 2 | CONVERGED | 581.7 (984) | 791.9 (1200) | 281.7 | 4985.0 / 4985.0 / 0.0 / 0.0 | 4 / 4 / 3 / 3 | SKIPPED (ALLOWED_TRUCKS) |
| 3 | CAP | 984.0 (984) | 1175.4 (1200) | 686.4 | 6022.0 / 2986.6 / 8.7 / 4.5 | 5 / 4 / 3 / 3 | SKIPPED (ALLOWED_TRUCKS) |

Search objective: the route search's own score before the load re-check - cash-like costs plus ARTIFICIAL penalties (1,000 OMR or more for each stop not planned yet) - not cash. A value at a mark is the last of at most 12 kept points by then, so the true gap is at most that. '-': no plan by then. Over the runs: at 60 s mean 4670.4 [max 6022.0] above the end, 3 of 3 still searching; at 120 s mean 3658.6 [max 4985.0] above the end, 3 of 3 still searching; at 300 s mean 4.7 [max 8.7] above the end, 3 of 3 still searching; at 600 s mean 2.9 [max 4.5] above the end, 2 of 3 still searching.

Second route search (PyVRP): PROD: SKIPPED (ALLOWED_TRUCKS) 3 - chosen for RECOMMENDED 0, MIN_TRUCKS 0, MIN_DISTANCE 0; QUICKP: SKIPPED (ALLOWED_TRUCKS) 5 - chosen for RECOMMENDED 0, MIN_TRUCKS 0, MIN_DISTANCE 0.

### PROD against QUICKP (PROD - QUICKP, paired by seed)

Seeds [1, 2, 3]. Whole request: PROD 1048 [792..1176] s, QUICKP 111 [103..120] s.

| option | pairs | Δ cash OMR | Δ stops served | Δ trucks | Δ loads | Δ estimated km | PROD serves more / less | alike: PROD cheaper / dearer / same cash |
|---|---|---|---|---|---|---|---|---|
| RECOMMENDED | 3 | +57.40 [+20.67..+119.52] | -1.3 [-16.0..+7.0] | +0.0 | +1.0 [+0.0..+2.0] | +101.3 [+59.9..+126.0] | 1 / 2 | 0 / 0 / 0 |
| MIN_TRUCKS | 3 | +57.48 [+20.71..+119.70] | -1.3 [-16.0..+7.0] | +0.0 | +1.0 [+0.0..+2.0] | +101.8 [+59.9..+126.9] | 1 / 2 | 0 / 0 / 0 |
| MIN_DISTANCE | 3 | +57.50 [+20.79..+119.70] | -1.3 [-16.0..+7.0] | +0.0 | +1.3 [+1.0..+2.0] | +101.6 [+59.9..+126.9] | 1 / 2 | 0 / 0 / 0 |

Serving more stops costs more cash: read Δ cash with Δ stops served.

### Stability: the plan after a small change of the day (QUICKP, seed 1, RECOMMENDED)

| change | stops moved (truck or load) | stops on another truck | trucks used before -> after (changed) | Δ cash OMR | Δ other stops served | Δ loads | the changed stop | VERIFIED |
|---|---|---|---|---|---|---|---|---|
| P0: none | 0 | 0 | 9 -> 9 (0) | +0.00 | +0 | +0 | - | VERIFIED |
| P1: stop-052 removed (2 cases, P3) | 72 | 68 | 9 -> 9 (0) | -12.83 | -2 | -1 | served before | VERIFIED |
| P2: 9 stops +5% cases (at least 1): 52 cases in all; kg and pallets in proportion; unloading +0.25 min per case added | 71 | 65 | 9 -> 9 (0) | -21.08 | -4 | -2 | - | VERIFIED |
| P3: stop-071: receiving window 30 min later (opening, closing and any preferred window) | 74 | 74 | 9 -> 9 (0) | +90.70 | -2 | -1 | served yes -> yes | VERIFIED |
| P4: truck-06 unavailable (it carried 3 stops in the base plan) | 65 | 63 | 9 -> 8 (1) | -62.87 | -5 | -1 | 3 stops had to leave the truck | VERIFIED |
| P5: stop-043-late added: a copy of stop-043 (1 cases, P3) 1 km north, as a new customer's late order | 75 | 74 | 9 -> 9 (0) | -22.07 | -6 | -2 | served | VERIFIED |

Reference with no change of the day: the plans of seeds [2, 3, 4, 5] against seed 1's moved 66.0 [58.0..76.0] stops (63.0 [53.0..72.0] to another truck), cash -16.72 [-27.16..-5.40] OMR, other stops served -6.5 [-9.0..-5.0].

Each changed day is solved from scratch, as a new OPTIMIZE (no plan continuity: no previous truck ids), and compared with the base plan. 'Stops moved': stops of both plans on another truck or load number. 'Other stops served': stops of both days. P0 is the control: the same day solved again, so whatever moves there is the timed search's own variation. All three options are in the JSON.

## SYNTH-320: SYNTHETIC (320 invoices, synth seed 1); 185 stops, 13 trucks

Runs: PROD seeds [1, 2, 3, 4, 5] of [1, 2, 3, 4, 5]; QUICKP seeds [1, 2, 3, 4, 5] of [1, 2, 3, 4, 5].

### Spread over the seeds

| variant | option | runs | cash OMR, mean [min..max] | cash sd | trucks | loads | stops served | cases served | stops left out P1/P2/P3/P4/P5 (mean) | late stops (max) | min outside preferred windows | estimated km | VERIFIED | option's search s | whole request s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PROD | RECOMMENDED | 5 | 663.24 [652.32..673.91] | 9.03 | 13.0 | 19.2 [18.0..20.0] | 185.0 of 185 | 9958 of 9958 | 0/0/0/0/0 | 0 | 7172 [6653..7480] | 1157.3 [1101.3..1195.2] | 5/5 | 991 [986..1000] | 1052 [1047..1061] |
| PROD | MIN_TRUCKS | 5 | 651.89 [641.53..662.09] | 9.80 | 13.0 | 18.4 [18.0..19.0] | 185.0 of 185 | 9958 of 9958 | 0/0/0/0/0 | 0 | 10954 [10346..11706] | 1074.6 [1004.2..1130.4] | 5/5 | 67 [62..76] | 1052 [1047..1061] |
| PROD | MIN_DISTANCE | 5 | 650.83 [641.82..662.15] | 8.69 | 13.0 | 18.6 [18.0..19.0] | 185.0 of 185 | 9958 of 9958 | 0/0/0/0/0 | 0 | 11476 [10346..12649] | 1059.8 [1004.2..1108.1] | 5/5 | 67 [62..76] | 1052 [1047..1061] |
| QUICKP | RECOMMENDED | 5 | 659.96 [648.89..674.89] | 11.07 | 13.0 | 19.4 [18.0..21.0] | 185.0 of 185 | 9958 of 9958 | 0/0/0/0/0 | 0 | 10222 [7686..12240] | 1127.8 [1039.6..1214.9] | 5/5 | 135 [124..149] | 195 [184..210] |
| QUICKP | MIN_TRUCKS | 5 | 656.02 [648.89..662.72] | 6.18 | 13.0 | 18.6 [18.0..19.0] | 185.0 of 185 | 9958 of 9958 | 0/0/0/0/0 | 0 | 11685 [11449..12240] | 1089.8 [1039.6..1137.5] | 5/5 | 75 [64..89] | 195 [184..210] |
| QUICKP | MIN_DISTANCE | 5 | 656.15 [648.89..663.01] | 6.30 | 13.0 | 18.6 [18.0..19.0] | 185.0 of 185 | 9958 of 9958 | 0/0/0/0/0 | 0 | 11655 [11324..12240] | 1089.8 [1039.6..1137.5] | 5/5 | 74 [64..89] | 195 [184..210] |

Cash parts, mean OMR (costing.truck_day_costs):

| variant | option | fixed | trip | distance | fuel | driver | overtime |
|---|---|---|---|---|---|---|---|
| PROD | RECOMMENDED | 206.00 | 0.00 | 57.56 | 79.31 | 314.37 | 6.00 |
| PROD | MIN_TRUCKS | 206.00 | 0.00 | 54.29 | 73.95 | 302.80 | 14.84 |
| PROD | MIN_DISTANCE | 206.00 | 0.00 | 53.93 | 73.18 | 301.87 | 15.85 |
| QUICKP | RECOMMENDED | 206.00 | 0.00 | 56.55 | 77.46 | 310.61 | 9.34 |
| QUICKP | MIN_TRUCKS | 206.00 | 0.00 | 54.84 | 75.04 | 305.48 | 14.67 |
| QUICKP | MIN_DISTANCE | 206.00 | 0.00 | 54.89 | 75.05 | 305.48 | 14.73 |

### Which option is cheapest, and does RECOMMENDED leave out what another option serves

| variant | runs | cheapest at the run's best service: RECOMMENDED / MIN_TRUCKS / MIN_DISTANCE | reach the best service: R / MT / MD | all three serve alike | RECOMMENDED serves less than the best option | runs where RECOMMENDED leaves out a stop another option serves | those stops, P1/P2/P3/P4/P5 |
|---|---|---|---|---|---|---|---|
| PROD | 5 | 0 / 4 / 3 | 5 / 5 / 5 | 5 | 0 | 0 | 0/0/0/0/0 |
| QUICKP | 5 | 3 / 5 / 3 | 5 / 5 / 5 | 5 | 0 | 0 | 0/0/0/0/0 |

Best service: the most P1 stops served, then P2, and so on (the engine's strict priorities). A tie for cheapest counts for each option in it.

### Convergence of PROD (THOROUGH)

| seed | stopped | RECOMMENDED search s (limit) | whole request s (cap) | last improvement s | search objective above its end at 60 / 120 / 300 / 600 s | stops not yet planned at 60 / 120 / 300 / 600 s | second search (PyVRP) |
|---|---|---|---|---|---|---|---|
| 1 | CAP | 984.0 (984) | 1046.8 (1200) | 875.0 | 6319331.8 / 1047.1 / 29.1 / 7.2 | 21 / 1 / 0 / 0 | SKIPPED (ALLOWED_TRUCKS) |
| 2 | CAP | 984.0 (984) | 1046.6 (1200) | 691.4 | 6319378.9 / 3080054.9 / 75.3 / 32.7 | 21 / 5 / 0 / 0 | SKIPPED (ALLOWED_TRUCKS) |
| 3 | CAP | 984.1 (984) | 1049.4 (1200) | 673.3 | 2050.8 / 2050.8 / 24.2 / 5.2 | 2 / 2 / 0 / 0 | SKIPPED (ALLOWED_TRUCKS) |
| 4 | CAP | 984.1 (984) | 1056.5 (1200) | 538.1 | 53.7 / 31.9 / 27.5 / 0.0 | 0 / 0 / 0 / 0 | SKIPPED (ALLOWED_TRUCKS) |
| 5 | CAP | 984.0 (984) | 1060.8 (1200) | 913.9 | 6319335.1 / 1027018.4 / 1027011.7 / 10.4 | 21 / 2 / 2 / 0 | SKIPPED (ALLOWED_TRUCKS) |

Search objective: the route search's own score before the load re-check - cash-like costs plus ARTIFICIAL penalties (1,000 OMR or more for each stop not planned yet) - not cash. A value at a mark is the last of at most 12 kept points by then, so the true gap is at most that. '-': no plan by then. Over the runs: at 60 s mean 3792030.1 [max 6319378.9] above the end, 5 of 5 still searching; at 120 s mean 822040.6 [max 3080054.9] above the end, 5 of 5 still searching; at 300 s mean 205433.6 [max 1027011.7] above the end, 5 of 5 still searching; at 600 s mean 11.1 [max 32.7] above the end, 5 of 5 still searching.

Second route search (PyVRP): PROD: SKIPPED (ALLOWED_TRUCKS) 5 - chosen for RECOMMENDED 0, MIN_TRUCKS 0, MIN_DISTANCE 0; QUICKP: SKIPPED (ALLOWED_TRUCKS) 5 - chosen for RECOMMENDED 0, MIN_TRUCKS 0, MIN_DISTANCE 0.

### PROD against QUICKP (PROD - QUICKP, paired by seed)

Seeds [1, 2, 3, 4, 5]. Whole request: PROD 1052 [1047..1061] s, QUICKP 195 [184..210] s.

| option | pairs | Δ cash OMR | Δ stops served | Δ trucks | Δ loads | Δ estimated km | PROD serves more / less | alike: PROD cheaper / dearer / same cash |
|---|---|---|---|---|---|---|---|---|
| RECOMMENDED | 5 | +3.28 [-14.40..+25.02] | +0.0 | +0.0 | -0.2 [-1.0..+2.0] | +29.5 [-50.7..+155.6] | 0 / 0 | 3 / 2 / 0 |
| MIN_TRUCKS | 5 | -4.14 [-17.76..+12.08] | +0.0 | +0.0 | -0.2 [-1.0..+1.0] | -15.2 [-133.3..+53.3] | 0 / 0 | 3 / 2 / 0 |
| MIN_DISTANCE | 5 | -5.33 [-17.75..+4.98] | +0.0 | +0.0 | +0.0 [-1.0..+1.0] | -30.0 [-133.3..+44.3] | 0 / 0 | 3 / 2 / 0 |

Serving more stops costs more cash: read Δ cash with Δ stops served.

## SYNTH-320-S2: SYNTHETIC (320 invoices, synth seed 2); 186 stops, 13 trucks

Runs: PROD seeds [1, 2, 3, 4, 5] of [1, 2, 3, 4, 5]; QUICKP seeds [1, 2, 3, 4, 5] of [1, 2, 3, 4, 5].

### Spread over the seeds

| variant | option | runs | cash OMR, mean [min..max] | cash sd | trucks | loads | stops served | cases served | stops left out P1/P2/P3/P4/P5 (mean) | late stops (max) | min outside preferred windows | estimated km | VERIFIED | option's search s | whole request s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PROD | RECOMMENDED | 5 | 664.52 [645.59..694.73] | 19.18 | 13.0 | 21.2 [21.0..22.0] | 183.0 [181.0..184.0] of 186 | 11214 [11114..11241] of 11244 | 0/0/1.2/0.6/1.2 | 0 | 12344 [9181..14018] | 983.2 [887.6..1094.8] | 5/5 | 935 [598..1104] | 996 [660..1166] |
| PROD | MIN_TRUCKS | 5 | 658.27 [622.56..692.59] | 26.07 | 13.0 | 20.8 [20.0..21.0] | 183.0 [181.0..184.0] of 186 | 11214 [11114..11241] of 11244 | 0/0/1.2/0.6/1.2 | 0 | 13003 [11579..14408] | 949.9 [787.3..1090.7] | 5/5 | 91 [64..183] | 996 [660..1166] |
| PROD | MIN_DISTANCE | 5 | 657.80 [622.56..692.59] | 26.32 | 13.0 | 21.0 | 183.0 [181.0..184.0] of 186 | 11214 [11114..11241] of 11244 | 0/0/1.2/0.6/1.2 | 0 | 12901 [11579..14408] | 949.6 [787.3..1090.7] | 5/5 | 91 [64..183] | 996 [660..1166] |
| QUICKP | RECOMMENDED | 5 | 639.14 [626.60..658.89] | 12.55 | 13.0 | 21.2 [21.0..22.0] | 179.8 [178.0..181.0] of 186 | 11180 [11114..11237] of 11244 | 0/0/1.8/2/2.4 | 0 | 11790 [10514..13654] | 887.2 [841.8..968.6] | 5/5 | 160 [125..227] | 222 [186..288] |
| QUICKP | MIN_TRUCKS | 5 | 639.14 [626.60..658.89] | 12.55 | 13.0 | 21.2 [21.0..22.0] | 179.8 [178.0..181.0] of 186 | 11180 [11114..11237] of 11244 | 0/0/1.8/2/2.4 | 0 | 11790 [10514..13654] | 887.2 [841.8..968.6] | 5/5 | 99 [64..166] | 222 [186..288] |
| QUICKP | MIN_DISTANCE | 5 | 639.14 [626.60..658.89] | 12.55 | 13.0 | 21.2 [21.0..22.0] | 179.8 [178.0..181.0] of 186 | 11180 [11114..11237] of 11244 | 0/0/1.8/2/2.4 | 0 | 11790 [10514..13654] | 887.2 [841.8..968.6] | 5/5 | 99 [64..166] | 222 [186..288] |

Cash parts, mean OMR (costing.truck_day_costs):

| variant | option | fixed | trip | distance | fuel | driver | overtime |
|---|---|---|---|---|---|---|---|
| PROD | RECOMMENDED | 206.00 | 0.00 | 51.34 | 68.17 | 318.92 | 20.10 |
| PROD | MIN_TRUCKS | 206.00 | 0.00 | 49.85 | 65.95 | 315.18 | 21.29 |
| PROD | MIN_DISTANCE | 206.00 | 0.00 | 49.78 | 65.91 | 314.92 | 21.20 |
| QUICKP | RECOMMENDED | 206.00 | 0.00 | 46.73 | 61.58 | 311.03 | 13.80 |
| QUICKP | MIN_TRUCKS | 206.00 | 0.00 | 46.73 | 61.58 | 311.03 | 13.80 |
| QUICKP | MIN_DISTANCE | 206.00 | 0.00 | 46.73 | 61.58 | 311.03 | 13.80 |

### Which option is cheapest, and does RECOMMENDED leave out what another option serves

| variant | runs | cheapest at the run's best service: RECOMMENDED / MIN_TRUCKS / MIN_DISTANCE | reach the best service: R / MT / MD | all three serve alike | RECOMMENDED serves less than the best option | runs where RECOMMENDED leaves out a stop another option serves | those stops, P1/P2/P3/P4/P5 |
|---|---|---|---|---|---|---|---|
| PROD | 5 | 3 / 4 / 5 | 5 / 5 / 5 | 5 | 0 | 0 | 0/0/0/0/0 |
| QUICKP | 5 | 5 / 5 / 5 | 5 / 5 / 5 | 5 | 0 | 0 | 0/0/0/0/0 |

Best service: the most P1 stops served, then P2, and so on (the engine's strict priorities). A tie for cheapest counts for each option in it.

### Convergence of PROD (THOROUGH)

| seed | stopped | RECOMMENDED search s (limit) | whole request s (cap) | last improvement s | search objective above its end at 60 / 120 / 300 / 600 s | stops not yet planned at 60 / 120 / 300 / 600 s | second search (PyVRP) |
|---|---|---|---|---|---|---|---|
| 1 | CAP | 983.1 (983) | 1049.3 (1200) | 750.9 | 3920968.6 / 3920968.6 / 980984.4 / 28015.6 | 13 / 13 / 7 / 5 | SKIPPED (ALLOWED_TRUCKS) |
| 2 | CAP | 983.0 (983) | 1047.9 (1200) | 855.9 | 13585300.2 / 1008010.6 / 56015.0 / 55999.8 | 33 / 8 / 7 / 7 | SKIPPED (ALLOWED_TRUCKS) |
| 3 | CAP | 982.1 (982) | 1166.1 (1200) | 748.1 | 13586287.9 / 1987947.4 / 1959969.0 / 28033.5 | 33 / 9 / 8 / 5 | SKIPPED (ALLOWED_TRUCKS) |
| 4 | CAP | 983.0 (983) | 1059.5 (1200) | 913.0 | 13558243.6 / 1931903.0 / 1903899.0 / 951915.8 | 33 / 8 / 7 / 6 | SKIPPED (ALLOWED_TRUCKS) |
| 5 | CONVERGED | 592.1 (983) | 659.6 (1200) | 291.8 | 57039.9 / 56039.2 / 0.0 / 0.0 | 8 / 7 / 5 / 5 | SKIPPED (ALLOWED_TRUCKS) |

Search objective: the route search's own score before the load re-check - cash-like costs plus ARTIFICIAL penalties (1,000 OMR or more for each stop not planned yet) - not cash. A value at a mark is the last of at most 12 kept points by then, so the true gap is at most that. '-': no plan by then. Over the runs: at 60 s mean 8941568.0 [max 13586287.9] above the end, 5 of 5 still searching; at 120 s mean 1780973.7 [max 3920968.6] above the end, 5 of 5 still searching; at 300 s mean 980173.5 [max 1959969.0] above the end, 5 of 5 still searching; at 600 s mean 212793.0 [max 951915.8] above the end, 4 of 5 still searching.

Second route search (PyVRP): PROD: SKIPPED (ALLOWED_TRUCKS) 5 - chosen for RECOMMENDED 0, MIN_TRUCKS 0, MIN_DISTANCE 0; QUICKP: SKIPPED (ALLOWED_TRUCKS) 5 - chosen for RECOMMENDED 0, MIN_TRUCKS 0, MIN_DISTANCE 0.

### PROD against QUICKP (PROD - QUICKP, paired by seed)

Seeds [1, 2, 3, 4, 5]. Whole request: PROD 996 [660..1166] s, QUICKP 222 [186..288] s.

| option | pairs | Δ cash OMR | Δ stops served | Δ trucks | Δ loads | Δ estimated km | PROD serves more / less | alike: PROD cheaper / dearer / same cash |
|---|---|---|---|---|---|---|---|---|
| RECOMMENDED | 5 | +25.39 [-4.87..+64.53] | +3.2 [+3.0..+4.0] | +0.0 | +0.0 [-1.0..+1.0] | +95.9 [-17.6..+253.0] | 4 / 1 | 0 / 0 / 0 |
| MIN_TRUCKS | 5 | +19.13 [-36.33..+62.39] | +3.2 [+3.0..+4.0] | +0.0 | -0.4 [-1.0..+0.0] | +62.7 [-181.3..+248.8] | 4 / 1 | 0 / 0 / 0 |
| MIN_DISTANCE | 5 | +18.66 [-36.33..+62.39] | +3.2 [+3.0..+4.0] | +0.0 | -0.2 [-1.0..+0.0] | +62.3 [-181.3..+248.8] | 4 / 1 | 0 / 0 / 0 |

Serving more stops costs more cash: read Δ cash with Δ stops served.

## SYNTH-400-S3: SYNTHETIC (400 invoices, synth seed 3); 229 stops, 16 trucks

Runs: PROD seeds [1, 2, 3, 4, 5] of [1, 2, 3, 4, 5]; QUICKP seeds [1, 2, 3, 4, 5] of [1, 2, 3, 4, 5].

### Spread over the seeds

| variant | option | runs | cash OMR, mean [min..max] | cash sd | trucks | loads | stops served | cases served | stops left out P1/P2/P3/P4/P5 (mean) | late stops (max) | min outside preferred windows | estimated km | VERIFIED | option's search s | whole request s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PROD | RECOMMENDED | 5 | 810.88 [773.63..833.18] | 25.89 | 16.0 | 28.6 [28.0..30.0] | 224.6 [222.0..227.0] of 229 | 13310 [13241..13399] of 13406 | 0/0/0.4/2.2/1.8 | 0 | 16265 [11366..18134] | 1316.5 [1148.8..1408.8] | 5/5 | 1045 [997..1099] | 1121 [1073..1175] |
| PROD | MIN_TRUCKS | 5 | 808.09 [759.70..833.18] | 31.12 | 16.0 | 28.2 [28.0..29.0] | 224.6 [222.0..227.0] of 229 | 13310 [13241..13399] of 13406 | 0/0/0.4/2.2/1.8 | 0 | 17126 [15674..18134] | 1299.8 [1065.6..1408.8] | 5/5 | 151 [103..205] | 1121 [1073..1175] |
| PROD | MIN_DISTANCE | 5 | 808.09 [759.70..833.18] | 31.12 | 16.0 | 28.2 [28.0..29.0] | 224.6 [222.0..227.0] of 229 | 13310 [13241..13399] of 13406 | 0/0/0.4/2.2/1.8 | 0 | 17126 [15674..18134] | 1299.8 [1065.6..1408.8] | 5/5 | 151 [103..205] | 1121 [1073..1175] |
| QUICKP | RECOMMENDED | 5 | 786.22 [773.54..801.81] | 12.64 | 16.0 | 28.2 [28.0..29.0] | 221.4 [219.0..224.0] of 229 | 13312 [13236..13362] of 13406 | 0/0/1.2/3.4/3 | 0 | 17391 [15849..18730] | 1209.9 [1176.2..1261.3] | 5/5 | 243 [167..268] | 318 [242..344] |
| QUICKP | MIN_TRUCKS | 5 | 786.16 [773.54..801.81] | 12.64 | 16.0 | 28.2 [28.0..29.0] | 221.4 [219.0..224.0] of 229 | 13312 [13236..13362] of 13406 | 0/0/1.2/3.4/3 | 0 | 17414 [15849..18730] | 1209.8 [1176.2..1261.3] | 5/5 | 168 [92..193] | 318 [242..344] |
| QUICKP | MIN_DISTANCE | 5 | 786.16 [773.54..801.81] | 12.64 | 16.0 | 28.2 [28.0..29.0] | 221.4 [219.0..224.0] of 229 | 13312 [13236..13362] of 13406 | 0/0/1.2/3.4/3 | 0 | 17414 [15849..18730] | 1209.8 [1176.2..1261.3] | 5/5 | 168 [92..193] | 318 [242..344] |

Cash parts, mean OMR (costing.truck_day_costs):

| variant | option | fixed | trip | distance | fuel | driver | overtime |
|---|---|---|---|---|---|---|---|
| PROD | RECOMMENDED | 230.00 | 0.00 | 63.53 | 89.53 | 398.82 | 29.00 |
| PROD | MIN_TRUCKS | 230.00 | 0.00 | 62.74 | 88.41 | 396.34 | 30.61 |
| PROD | MIN_DISTANCE | 230.00 | 0.00 | 62.74 | 88.41 | 396.34 | 30.61 |
| QUICKP | RECOMMENDED | 230.00 | 0.00 | 59.17 | 82.58 | 386.11 | 28.36 |
| QUICKP | MIN_TRUCKS | 230.00 | 0.00 | 59.16 | 82.56 | 386.10 | 28.34 |
| QUICKP | MIN_DISTANCE | 230.00 | 0.00 | 59.16 | 82.56 | 386.10 | 28.34 |

### Which option is cheapest, and does RECOMMENDED leave out what another option serves

| variant | runs | cheapest at the run's best service: RECOMMENDED / MIN_TRUCKS / MIN_DISTANCE | reach the best service: R / MT / MD | all three serve alike | RECOMMENDED serves less than the best option | runs where RECOMMENDED leaves out a stop another option serves | those stops, P1/P2/P3/P4/P5 |
|---|---|---|---|---|---|---|---|
| PROD | 5 | 4 / 5 / 5 | 5 / 5 / 5 | 5 | 0 | 0 | 0/0/0/0/0 |
| QUICKP | 5 | 4 / 5 / 5 | 5 / 5 / 5 | 5 | 0 | 0 | 0/0/0/0/0 |

Best service: the most P1 stops served, then P2, and so on (the engine's strict priorities). A tie for cheapest counts for each option in it.

### Convergence of PROD (THOROUGH)

| seed | stopped | RECOMMENDED search s (limit) | whole request s (cap) | last improvement s | search objective above its end at 60 / 120 / 300 / 600 s | stops not yet planned at 60 / 120 / 300 / 600 s | second search (PyVRP) |
|---|---|---|---|---|---|---|---|
| 1 | CAP | 969.0 (969) | 1101.3 (1200) | 882.8 | 22308140.5 / 3709868.6 / 1294887.6 / 34989.7 | 45 / 11 / 10 / 8 | SKIPPED (ALLOWED_TRUCKS) |
| 2 | CAP | 969.0 (969) | 1124.4 (1200) | 839.2 | 3816815.8 / 3816815.8 / 1367865.5 / 34981.4 | 14 / 14 / 13 / 6 | SKIPPED (ALLOWED_TRUCKS) |
| 3 | CAP | 969.1 (969) | 1131.7 (1200) | 935.3 | 2555853.2 / 2555853.2 / 105956.3 / 999.1 | 11 / 11 / 9 / 6 | SKIPPED (ALLOWED_TRUCKS) |
| 4 | CAP | 969.1 (969) | 1175.4 (1200) | 964.8 | 21190312.5 / 2521035.9 / 1051.5 / 36.4 | 45 / 8 / 4 / 3 | SKIPPED (ALLOWED_TRUCKS) |
| 5 | CAP | 969.1 (969) | 1073.1 (1200) | 893.8 | 21117244.4 / 70024.1 / 34.4 / 8.1 | 45 / 10 / 8 / 8 | SKIPPED (ALLOWED_TRUCKS) |

Search objective: the route search's own score before the load re-check - cash-like costs plus ARTIFICIAL penalties (1,000 OMR or more for each stop not planned yet) - not cash. A value at a mark is the last of at most 12 kept points by then, so the true gap is at most that. '-': no plan by then. Over the runs: at 60 s mean 14197673.3 [max 22308140.5] above the end, 5 of 5 still searching; at 120 s mean 2534719.5 [max 3816815.8] above the end, 5 of 5 still searching; at 300 s mean 553959.1 [max 1367865.5] above the end, 5 of 5 still searching; at 600 s mean 14202.9 [max 34989.7] above the end, 5 of 5 still searching.

Second route search (PyVRP): PROD: SKIPPED (ALLOWED_TRUCKS) 5 - chosen for RECOMMENDED 0, MIN_TRUCKS 0, MIN_DISTANCE 0; QUICKP: SKIPPED (ALLOWED_TRUCKS) 5 - chosen for RECOMMENDED 0, MIN_TRUCKS 0, MIN_DISTANCE 0.

### PROD against QUICKP (PROD - QUICKP, paired by seed)

Seeds [1, 2, 3, 4, 5]. Whole request: PROD 1121 [1073..1175] s, QUICKP 318 [242..344] s.

| option | pairs | Δ cash OMR | Δ stops served | Δ trucks | Δ loads | Δ estimated km | PROD serves more / less | alike: PROD cheaper / dearer / same cash |
|---|---|---|---|---|---|---|---|---|
| RECOMMENDED | 5 | +24.66 [-13.77..+59.64] | +3.2 [-2.0..+5.0] | +0.0 | +0.4 [+0.0..+1.0] | +106.5 [-47.0..+227.2] | 4 / 1 | 0 / 0 / 0 |
| MIN_TRUCKS | 5 | +21.93 [-27.39..+59.64] | +3.2 [-2.0..+5.0] | +0.0 | +0.0 [-1.0..+1.0] | +90.1 [-129.3..+227.2] | 4 / 1 | 0 / 0 / 0 |
| MIN_DISTANCE | 5 | +21.93 [-27.39..+59.64] | +3.2 [-2.0..+5.0] | +0.0 | +0.0 [-1.0..+1.0] | +90.1 [-129.3..+227.2] | 4 / 1 | 0 / 0 / 0 |

Serving more stops costs more cash: read Δ cash with Δ stops served.
