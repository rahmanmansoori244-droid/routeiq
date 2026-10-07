| Day | Orders served P1 · P2 · P3 · P4 · P5 (every run) | Unserved (reason) | main run 1: trucks / loads / km / OMR | main run 2 | branch run 1 | branch run 2 | Timing | Optimizer s (main; branch) |
|---|---|---|---|---|---|---|---|---|
| S01 normal day, Muscat | 5/5 · 23/23 · 94/94 · 59/60 · 18/18 | 1 (1 MISSING_COORDINATES) | 7 / 11 / 565.8 / 242.90 | 7 / 11 / 565.8 / 242.90 | 7 / 12 / 529.6 / 238.56 | 6 / 12 / 477.2 / 207.26 | VERIFIED | 163, 168; 156, 162 |
| S02 heavy day, Sohar (split deliveries) | 9/10 · 15/15 · 93/93 · 50/50 · 27/27 | 1 (1 EXCEEDS_ANY_TRUCK_CAPACITY) | 7 / 20 / 483.7 / 233.05 | 7 / 20 / 483.7 / 233.05 | 7 / 20 / 461.7 / 230.40 | 7 / 20 / 461.7 / 230.40 | VERIFIED | 188, 180; 188, 181 |
| S03 weight-bound shortage, Salalah | 12/13 · 24/24 · 64/64 · 9/70 · 0/69 | 131 (1 HARD_WINDOW_INFEASIBLE, 130 SOLVER_DROPPED_LOW_PRIORITY) | 6 / 6 / 340.7 / 190.88 | 6 / 6 / 340.7 / 190.88 | 6 / 6 / 337.5 / 190.50 | 6 / 6 / 337.3 / 190.48 | VERIFIED | 172, 165; 159, 153 |
| S04 re-plan with locked + dispatched loads, Nizwa | 11/11 · 40/40 · 114/115 · 46/47 · 17/17 | 2 (2 MISSING_COORDINATES) | 6 / 11 / 452.4 / 204.30 | 6 / 11 / 452.4 / 204.30 | 6 / 11 / 427.4 / 201.29 | 6 / 11 / 427.4 / 201.29 | VERIFIED | 144, 140; 136, 128 |
| S04b the same, balanced locked loads | 11/11 · 40/40 · 114/115 · 46/47 · 17/17 | 2 (2 MISSING_COORDINATES) | 7 / 12 / 508.8 / 236.05 | 7 / 12 / 508.7 / 236.05 | 6 / 11 / 479.3 / 207.52 | 6 / 11 / 479.3 / 207.52 | VERIFIED | 146, 142; 137, 132 |
| S05 data problems, Muscat | 9/9 · 42/42 · 158/158 · 94/96 · 35/35 | 2 (2 INVALID_CUSTOMER) | 11 / 19 / 1,134.0 / 411.07 | 12 / 18 / 1,290.1 / 454.82 | 11 / 18 / 1,320.5 / 433.47 | 12 / 16 / 675.2 / 381.03 | VERIFIED | 186, 178; 172, 164 |
| Real NMWC day (28 Sep orders) | 0/0 · 26/26 · 51/51 · 3/3 · 0/0 | 0 | 6 / 17 / 1,172.3 / 595.63 | 6 / 17 / 1,172.3 / 595.63 | 6 / 14 / 1,011.3 / 556.14 | 5 / 14 / 997.2 / 543.03 | VERIFIED | 50, 51; 51, 43 |

