## 10. Audit PR A6 (29 Sep 2026): solver and plan-output accuracy, main vs the branch

A6 changes what the optimizer compares and chooses: weights in 0.1 kg with no hidden margin (F08), only new overtime for a
truck with locked loads (E4), and a load repack that never gives up before its first answer (E5); the rest of A6 is output only
(loading-sheet kg, option wording, cost per case, the depot origin of locked loads). The assessment asked for a comparison on
the five synthetic scenario days and one real day, **priority service first, then cost** (owner decision 26).

**Method.** Same machine as §5 (AMD Ryzen 7 7445HS, 12 threads, 31 GB RAM, Windows 11; Python 3.12.13, OR-Tools 9.15.6755),
each version with its own web app (Next.js dev server) and solver (production worker pool), on its own database, one version at
a time: **main** `3451f4d` (web :3011, solver :8011, database `routeiq_p6_base` migrated with main's migrations) first, then
**the branch** (web :3009, solver :8009). Every day was run **twice per version** in fresh companies set up through the web API:

- the five synthetic days S01-S05 (plus S04b, S04's balanced variant) of the scenario harness (`.dev/scenarios/harness-final`,
  the order files `S01_Orders.xlsx` ... `S05_Orders.xlsx`, delivery 4-8 Oct 2026; straight-line distances x 1.3 at 40 km/h),
  from a copy with two changes made for both versions alike: OPTIMIZE passes "optimize anyway" for missing locations (A5 refuses
  S01's one customer without a location otherwise), and S04 uploads its Orders sheet alone (the two-sheet workbook is refused
  since B2). S04 and S04b plan a morning (v1), lock and dispatch its loads, add late orders and re-plan (v2);
- the real NMWC day: the 28 Sep order file (373 lines, 80 customers, 46 products, 13 trucks, NMWC's rates and settings),
  moved to 15 Oct 2026 for both versions (a future day, so the same-day "plan from now" rule does not apply), through a copy of
  `.dev/realdata/run-test.mjs` that writes only its own folder.

Each table row is the plan in use (RECOMMENDED unless said), read back from `GET /api/runs/:id/plan` and the job's stored
optimizer response: orders served per priority, unserved orders with their reason codes, trucks, loads, km and cost of the whole
day, the option's own timing check, the optimizer's time (search + post-solve stage) and the wall time from OPTIMIZE to READY.
No customer names; km and costs are estimates on synthetic points or approximate real pins.

**Caveat on this run.** Other work used the same PC during both versions' runs (the load sampler logged 100 % CPU almost all the
time; three optimizer research jobs and another branch's build ran alongside). OR-Tools' searches are time-limited, so their plans
depend on free CPU; the two runs of each version agree with each other, but small differences between the versions can be the
machine rather than the code.

### 10.1 The web API runs (harness and real day, two runs per version)

Each cell of a run is trucks / loads / km / cost in OMR for the whole day (a re-plan: the kept loads included). Every plan passed its own timing check (VERIFIED).

| Day | Orders served P1 · P2 · P3 · P4 · P5 (every run) | Unserved (reason) | main run 1: trucks / loads / km / OMR | main run 2 | branch run 1 | branch run 2 | Timing | Optimizer s (main; branch) |
|---|---|---|---|---|---|---|---|---|
| S01 normal day, Muscat | 5/5 · 23/23 · 94/94 · 59/60 · 18/18 | 1 (1 MISSING_COORDINATES) | 7 / 11 / 565.8 / 242.90 | 7 / 11 / 565.8 / 242.90 | 7 / 12 / 529.6 / 238.56 | 6 / 12 / 477.2 / 207.26 | VERIFIED | 163, 168; 156, 162 |
| S02 heavy day, Sohar (split deliveries) | 9/10 · 15/15 · 93/93 · 50/50 · 27/27 | 1 (1 EXCEEDS_ANY_TRUCK_CAPACITY) | 7 / 20 / 483.7 / 233.05 | 7 / 20 / 483.7 / 233.05 | 7 / 20 / 461.7 / 230.40 | 7 / 20 / 461.7 / 230.40 | VERIFIED | 188, 180; 188, 181 |
| S03 weight-bound shortage, Salalah | 12/13 · 24/24 · 64/64 · 9/70 · 0/69 | 131 (1 HARD_WINDOW_INFEASIBLE, 130 SOLVER_DROPPED_LOW_PRIORITY) | 6 / 6 / 340.7 / 190.88 | 6 / 6 / 340.7 / 190.88 | 6 / 6 / 337.5 / 190.50 | 6 / 6 / 337.3 / 190.48 | VERIFIED | 172, 165; 159, 153 |
| S04 re-plan with locked + dispatched loads, Nizwa | 11/11 · 40/40 · 114/115 · 46/47 · 17/17 | 2 (2 MISSING_COORDINATES) | 6 / 11 / 452.4 / 204.30 | 6 / 11 / 452.4 / 204.30 | 6 / 11 / 427.4 / 201.29 | 6 / 11 / 427.4 / 201.29 | VERIFIED | 144, 140; 136, 128 |
| S04b the same, balanced locked loads | 11/11 · 40/40 · 114/115 · 46/47 · 17/17 | 2 (2 MISSING_COORDINATES) | 7 / 12 / 508.8 / 236.05 | 7 / 12 / 508.7 / 236.05 | 6 / 11 / 479.3 / 207.52 | 6 / 11 / 479.3 / 207.52 | VERIFIED | 146, 142; 137, 132 |
| S05 data problems, Muscat | 9/9 · 42/42 · 158/158 · 94/96 · 35/35 | 2 (2 INVALID_CUSTOMER) | 11 / 19 / 1,134.0 / 411.07 | 12 / 18 / 1,290.1 / 454.82 | 11 / 18 / 1,320.5 / 433.47 | 12 / 16 / 675.2 / 381.03 | VERIFIED | 186, 178; 172, 164 |
| Real NMWC day (28 Sep orders) | 0/0 · 26/26 · 51/51 · 3/3 · 0/0 | 0 | 6 / 17 / 1,172.3 / 595.63 | 6 / 17 / 1,172.3 / 595.63 | 6 / 14 / 1,011.3 / 556.14 | 5 / 14 / 997.2 / 543.03 | VERIFIED | 50, 51; 51, 43 |

