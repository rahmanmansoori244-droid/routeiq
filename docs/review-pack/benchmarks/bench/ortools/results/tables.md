## Best-known plan per instance (RECOMMENDED objective, any method)

| instance | best objective (OMR) | trucks / loads / km / operating cost OMR / unserved | found by |
|---|---|---|---|
| real80 | 527.58 | 5 / 14 / 1006 / 494.5 / 0 | best_push: 120s warm-start from polish of pipeline real80|60|half_polish_warm|s0 |
| syn60_s1 | 247.97 | 4 / 5 / 412 / 234.3 / 0 | syn60_s1|tl60|twophase|RECOMMENDED|PCI|GLS|p1MIN_TRUCKS0.5|s0 [RECOMMENDED] |
| syn60_s2 | 247.30 | 4 / 4 / 388 / 229.1 / 0 | best_push: 120s warm-start from polish of syn60_s2|tl300|std|RECOMMENDED|PCI|GLS|s0 [RECOMMENDED] |
| syn60_s3 | 212.46 | 3 / 3 / 388 / 199.3 / 0 | best_push: 120s warm-start from polish of syn60_s3|tlauto|std|RECOMMENDED|AUTOMATIC|GLS|s2 [RECOMMENDED] |
| syn150_s1 | 502.95 | 8 / 9 / 797 / 476.4 / 0 | syn150_s1|tl300|std|RECOMMENDED|PCI|GLS|s0 [RECOMMENDED] |
| syn150_s2 | 509.83 | 8 / 12 / 769 / 471.1 / 0 | best_push: 120s warm-start from polish of polish syn150_s2|tl60|std|RECOMMENDED|PCI|GLS|s1[RECOMMENDED] |
| syn150_s3 | 498.97 | 8 / 10 / 754 / 464.5 / 0 | best_push: 120s warm-start from polish of polish syn150_s3|tlauto|std|RECOMMENDED|SEQUENTIAL_CHEAPEST_INSERTION|GLS|s0[RECOMMENDED] |
| syn300_s1 | 949.20 | 12 / 24 / 1657 / 886.2 / 0 | best_push: 300s warm-start from polish of syn300_s1|tl300|std|RECOMMENDED|AUTOMATIC|GLS|s0 [RECOMMENDED] |

## Summary: engine default (auto limit) vs best-known

| instance | auto limit | engine at auto: objective, gap (3 repeats) | trucks / loads | best-known OMR | best-known trucks / loads | engine limit needed to be within 2% (repeat 0) |
|---|---|---|---|---|---|---|
| real80 | 20 s | 777.4 (+47.3%), 773.4 (+46.6%), 773.2 (+46.5%) | 13/21, 13/21, 13/21 | 527.6 | 5 / 14 | > 600 s (not reached) |
| syn60_s1 | 8 s | 278.8 (+12.4%), 278.8 (+12.4%), 278.8 (+12.4%) | 5/5, 5/5, 5/5 | 248.0 | 4 / 5 | 120 s |
| syn60_s2 | 8 s | 286.4 (+15.8%), 284.2 (+14.9%), 259.9 (+5.1%) | 5/5, 5/5, 4/5 | 247.3 | 4 / 4 | 30 s |
| syn60_s3 | 8 s | 239.8 (+12.9%), 239.8 (+12.9%), 239.8 (+12.9%) | 4/4, 4/4, 4/4 | 212.5 | 3 / 3 | 30 s |
| syn150_s1 | 20 s | 581.7 (+15.7%), 583.2 (+15.9%), 584.7 (+16.3%) | 10/12, 10/12, 10/12 | 503.0 | 8 / 9 | 30 s |
| syn150_s2 | 20 s | 633.0 (+24.2%), 675.3 (+32.5%), 630.9 (+23.7%) | 12/12, 12/14, 12/12 | 509.8 | 8 / 12 | > 300 s (not reached) |
| syn150_s3 | 20 s | 556.3 (+11.5%), 569.5 (+14.1%), 572.3 (+14.7%) | 10/10, 9/12, 9/11 | 499.0 | 8 / 10 | > 300 s (not reached) |
| syn300_s1 | 150 s | 4,401,023.6 (44 unserved (P5:44)), 4,500,950.7 (45 unserved (P5:45)), 3,100,969.5 (31 unserved (P5:31)) | 12/24, 12/23, 12/24 | 949.2 | 12 / 24 | > 600 s (not reached) |

## (a) Convergence: RECOMMENDED with the engine's own settings (PCI + GLS)

One run per limit (repeat 0); `r1/r2` = the same configuration repeated. Gap vs best-known. `solutions` = solutions OR-Tools reported (throughput; the machine was oversubscribed).

### real80 (auto limit = 20 s; best-known 527.58 OMR)

| limit | objective OMR | gap | trucks / loads / km / op. cost / unserved | OR-Tools status | solutions | repeats r1, r2 |
|---|---|---|---|---|---|---|
| **auto (20 s)** | 777.36 | +47.3% | 13 / 21 / 1413 / 757.6 / 0 | SUCCESS | 213 | +46.6%; +46.5% |
| 3 s | 780.07 | +47.9% | 13 / 21 / 1433 / 760.8 / 0 | SUCCESS | 133 |  |
| 10 s | 780.07 | +47.9% | 13 / 21 / 1433 / 760.8 / 0 | SUCCESS | 154 |  |
| 30 s | 772.85 | +46.5% | 13 / 21 / 1397 / 753.8 / 0 | SUCCESS | 592 |  |
| 60 s | 772.73 | +46.5% | 13 / 21 / 1397 / 753.8 / 0 | SUCCESS | 662 | +46.3%; +46.5% |
| 120 s | 736.07 | +39.5% | 12 / 19 / 1245 / 718.7 / 0 | SUCCESS | 1495 |  |
| 300 s | 705.17 | +33.7% | 11 / 19 / 1237 / 684.0 / 0 | SUCCESS | 3494 |  |
| 600 s | 587.55 | +11.4% | 7 / 14 / 1002 / 563.7 / 0 | SUCCESS | 7815 |  |

### syn60_s1 (auto limit = 8 s; best-known 247.97 OMR)

| limit | objective OMR | gap | trucks / loads / km / op. cost / unserved | OR-Tools status | solutions | repeats r1, r2 |
|---|---|---|---|---|---|---|
| **auto (8 s)** | 278.81 | +12.4% | 5 / 5 / 447 / 267.5 / 0 | SUCCESS | 180 | +12.4%; +12.4% |
| 3 s | 279.46 | +12.7% | 5 / 5 / 453 / 269.1 / 0 | SUCCESS | 125 |  |
| 10 s | 278.81 | +12.4% | 5 / 5 / 447 / 267.5 / 0 | SUCCESS | 201 |  |
| 30 s | 254.13 | +2.5% | 4 / 5 / 444 / 241.8 / 0 | SUCCESS | 583 |  |
| 60 s | 254.13 | +2.5% | 4 / 5 / 444 / 241.8 / 0 | SUCCESS | 995 | +2.5%; +2.4% |
| 120 s | 251.08 | +1.3% | 4 / 5 / 423 / 236.9 / 0 | SUCCESS | 2235 |  |
| 300 s | 248.54 | +0.2% | 4 / 5 / 417 / 235.4 / 0 | SUCCESS | 4048 |  |

### syn60_s2 (auto limit = 8 s; best-known 247.30 OMR)

| limit | objective OMR | gap | trucks / loads / km / op. cost / unserved | OR-Tools status | solutions | repeats r1, r2 |
|---|---|---|---|---|---|---|
| **auto (8 s)** | 286.43 | +15.8% | 5 / 5 / 457 / 270.6 / 0 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 156 | +14.9%; +5.1% |
| 3 s | 285.57 | +15.5% | 5 / 5 / 462 / 271.9 / 0 | SUCCESS | 167 |  |
| 10 s | 259.93 | +5.1% | 4 / 5 / 440 / 241.7 / 0 | SUCCESS | 241 |  |
| 30 s | 249.09 | +0.7% | 4 / 4 / 393 / 230.3 / 0 | SUCCESS | 579 |  |
| 60 s | 251.72 | +1.8% | 4 / 4 / 407 / 233.5 / 0 | SUCCESS | 1055 | +0.4%; +0.6% |
| 120 s | 248.33 | +0.4% | 4 / 4 / 396 / 231.1 / 0 | SUCCESS | 1369 |  |
| 300 s | 248.33 | +0.4% | 4 / 4 / 396 / 231.1 / 0 | SUCCESS | 3836 |  |

### syn60_s3 (auto limit = 8 s; best-known 212.46 OMR)

| limit | objective OMR | gap | trucks / loads / km / op. cost / unserved | OR-Tools status | solutions | repeats r1, r2 |
|---|---|---|---|---|---|---|
| **auto (8 s)** | 239.76 | +12.9% | 4 / 4 / 381 / 222.5 / 0 | SUCCESS | 216 | +12.9%; +12.9% |
| 3 s | 245.24 | +15.4% | 4 / 4 / 418 / 231.4 / 0 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 186 |  |
| 10 s | 239.76 | +12.9% | 4 / 4 / 381 / 222.5 / 0 | SUCCESS | 235 |  |
| 30 s | 215.60 | +1.5% | 3 / 3 / 386 / 198.8 / 0 | SUCCESS | 525 |  |
| 60 s | 215.60 | +1.5% | 3 / 3 / 386 / 198.8 / 0 | SUCCESS | 544 | +1.5%; +1.5% |
| 120 s | 215.60 | +1.5% | 3 / 3 / 386 / 198.8 / 0 | SUCCESS | 1086 |  |
| 300 s | 215.60 | +1.5% | 3 / 3 / 386 / 198.8 / 0 | SUCCESS | 4101 |  |

### syn150_s1 (auto limit = 20 s; best-known 502.95 OMR)

| limit | objective OMR | gap | trucks / loads / km / op. cost / unserved | OR-Tools status | solutions | repeats r1, r2 |
|---|---|---|---|---|---|---|
| **auto (20 s)** | 581.69 | +15.7% | 10 / 12 / 918 / 555.6 / 0 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 374 | +15.9%; +16.3% |
| 3 s | 665.77 | +32.4% | 8 / 13 / 1357 / 626.2 / 0 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 79 |  |
| 10 s | 601.96 | +19.7% | 9 / 13 / 1085 / 570.7 / 0 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 236 |  |
| 30 s | 506.62 | +0.7% | 8 / 9 / 812 / 480.1 / 0 | SUCCESS | 485 |  |
| 60 s | 505.13 | +0.4% | 8 / 9 / 805 / 478.5 / 0 | SUCCESS | 529 | +0.4%; +0.7% |
| 120 s | 505.13 | +0.4% | 8 / 9 / 805 / 478.5 / 0 | SUCCESS | 675 |  |
| 300 s | 502.95 | +0.0% | 8 / 9 / 797 / 476.4 / 0 | SUCCESS | 1062 |  |

### syn150_s2 (auto limit = 20 s; best-known 509.83 OMR)

| limit | objective OMR | gap | trucks / loads / km / op. cost / unserved | OR-Tools status | solutions | repeats r1, r2 |
|---|---|---|---|---|---|---|
| **auto (20 s)** | 633.00 | +24.2% | 12 / 12 / 893 / 600.8 / 0 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 384 | +32.5%; +23.7% |
| 3 s | 701.53 | +37.6% | 8 / 14 / 1441 / 648.8 / 0 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 78 |  |
| 10 s | 640.05 | +25.5% | 9 / 14 / 1187 / 601.2 / 0 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 202 |  |
| 30 s | 625.25 | +22.6% | 12 / 12 / 874 / 596.3 / 0 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 414 |  |
| 60 s | 587.12 | +15.2% | 11 / 11 / 828 / 560.3 / 0 | SUCCESS | 541 | +15.2%; +19.9% |
| 120 s | 587.50 | +15.2% | 10 / 11 / 930 / 559.8 / 0 | SUCCESS | 625 |  |
| 300 s | 542.11 | +6.3% | 9 / 11 / 814 / 510.1 / 0 | SUCCESS | 1108 |  |

### syn150_s3 (auto limit = 20 s; best-known 498.97 OMR)

| limit | objective OMR | gap | trucks / loads / km / op. cost / unserved | OR-Tools status | solutions | repeats r1, r2 |
|---|---|---|---|---|---|---|
| **auto (20 s)** | 556.34 | +11.5% | 10 / 10 / 804 / 526.6 / 0 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 482 | +14.1%; +14.7% |
| 3 s | 721.16 | +44.5% | 9 / 13 / 1432 / 663.4 / 0 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 69 |  |
| 10 s | 578.41 | +15.9% | 9 / 12 / 989 / 545.9 / 0 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 330 |  |
| 30 s | 596.38 | +19.5% | 9 / 12 / 1049 / 560.3 / 0 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 322 |  |
| 60 s | 545.81 | +9.4% | 10 / 10 / 755 / 514.7 / 0 | SUCCESS | 567 | +9.4%; +4.9% |
| 120 s | 523.22 | +4.9% | 9 / 10 / 756 / 490.0 / 0 | SUCCESS | 615 |  |
| 300 s | 523.22 | +4.9% | 9 / 10 / 756 / 490.0 / 0 | SUCCESS | 1053 |  |

### syn300_s1 (auto limit = 150 s; best-known 949.20 OMR)

| limit | objective OMR | gap | trucks / loads / km / op. cost / unserved | OR-Tools status | solutions | repeats r1, r2 |
|---|---|---|---|---|---|---|
| **auto (150 s)** | 4,401,023.64 | 44 unserved (P5:44) | 12 / 24 / 1879 / 928.3 / P5:44 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 492 | 45 unserved (P5:45); 31 unserved (P5:31) |
| 3 s | 6,501,182.55 | 65 unserved (P5:65) | 12 / 25 / 2370 / 1060.8 / P5:65 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 11 |  |
| 10 s | 6,501,011.85 | 65 unserved (P5:65) | 12 / 24 / 1956 / 928.9 / P5:65 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 165 |  |
| 30 s | 6,500,983.60 | 65 unserved (P5:65) | 12 / 24 / 1865 / 907.6 / P5:65 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 240 |  |
| 60 s | 6,500,968.92 | 65 unserved (P5:65) | 12 / 24 / 1819 / 892.3 / P5:65 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 294 | 43 unserved (P5:43); 43 unserved (P5:43) |
| 120 s | 4,000,964.34 | 40 unserved (P5:40) | 12 / 24 / 1772 / 894.2 / P5:40 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 649 |  |
| 300 s | 701,026.56 | 7 unserved (P5:7) | 12 / 24 / 1858 / 959.5 / P5:7 | PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED | 1029 |  |
| 600 s | 1,022.23 | +7.7% | 12 / 24 / 1817 / 953.5 / 0 | SUCCESS | 1242 |  |

### OR-Tools trace of the longest repeat-0 run: best objective at time t (OMR; >= 100,000 means stops unserved)

| instance | run | first solution | 1 s | 3 s | 8 s | 10 s | 20 s | 30 s | 60 s | 120 s | 150 s | 240 s | 300 s | 600 s | last improvement |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| real80 | 600 s | 895.6 @ 0.04 s | 866.0 | 780.1 | 777.4 | 777.4 | 773.4 | 772.9 | 738.3 | 736.8 | 736.8 | 705.2 | 705.2 | 587.6 | 573 s |
| syn60_s1 | 300 s | 565.0 @ 0.02 s | 514.9 | 279.5 | 278.8 | 278.8 | 255.8 | 254.1 | 254.1 | 251.1 | 251.1 | 251.1 | 248.5 |  | 258 s |
| syn60_s2 | 300 s | 600.3 @ 0.03 s | 529.0 | 285.7 | 259.9 | 259.9 | 249.9 | 249.1 | 248.3 | 248.3 | 248.3 | 248.3 | 248.3 |  | 45 s |
| syn60_s3 | 300 s | 599.1 @ 0.04 s | 526.8 | 245.2 | 239.8 | 239.8 | 215.6 | 215.6 | 215.6 | 215.6 | 215.6 | 215.6 | 215.6 |  | 15 s |
| syn150_s1 | 300 s | 921.8 @ 0.12 s | 873.4 | 787.5 | 703.2 | 695.4 | 536.9 | 509.2 | 505.1 | 505.1 | 505.1 | 505.1 | 503.0 |  | 261 s |
| syn150_s2 | 300 s | 914.2 @ 0.14 s | 891.4 | 793.4 | 742.3 | 727.3 | 635.3 | 623.4 | 587.1 | 587.1 | 587.1 | 565.1 | 542.1 |  | 265 s |
| syn150_s3 | 300 s | 902.8 @ 0.09 s | 864.7 | 794.4 | 712.9 | 698.8 | 663.6 | 549.6 | 545.8 | 523.2 | 523.2 | 523.2 | 523.2 |  | 74 s |
| syn300_s1 | 600 s | 6,501,216.8 @ 2.19 s | - | 6,501,213.5 | 6,501,165.4 | 6,501,134.9 | 6,501,027.7 | 6,501,008.2 | 6,500,989.7 | 4,000,972.6 | 4,000,967.2 | 1,201,100.7 | 1,101,030.3 | 1,022.2 | 598 s |

## (b) Search strategy at an equal wall-clock limit (auto)

Mean gap vs best-known over repeats (range in brackets). Runs that left stops unserved or failed are listed separately. Lower is better.

| configuration | real80 | syn60_s1 | syn60_s2 | syn60_s3 | syn150_s1 | syn150_s2 | syn150_s3 | syn300_s1 | mean gap (instances <= 150 stops) | runs with unserved / failed |
|---|---|---|---|---|---|---|---|---|---|---|
| PCI + GLS (engine) | +46.8% (+47..+47) | +12.4% (+12..+12) | +12.0% (+5..+16) | +12.9% (+13..+13) | +16.0% (+16..+16) | +26.8% (+24..+32) | +13.4% (+11..+15) | [3 run(s) left 31-45 unserved of 3] | +20.0% | 3 |
| PATH_CHEAPEST_ARC + GLS | +44.2% (+44..+45) | +29.2% (+26..+31) | +6.4% (+2..+14) | +10.5% (+3..+14) | +12.7% (+13..+13) | +22.4% (+22..+23) | +15.9% (+16..+16) | [1 run(s) left 30-30 unserved of 1] | +20.2% | 1 |
| SAVINGS + GLS | +47.0% (+42..+50) | +6.8% (+3..+13) | +5.6% (+1..+14) | +9.3% (+5..+12) | +14.1% (+8..+19) | +14.9% (+12..+17) | +10.6% (+6..+16) | +12.9% | +15.5% | 0 |
| LOCAL_CHEAPEST_INSERTION + GLS | +43.2% (+43..+44) | +10.5% (+10..+10) | +14.0% (+14..+14) | +13.7% (+14..+14) | +15.9% (+13..+18) | +24.8% (+23..+26) | +21.4% (+18..+28) | [1 run(s) left 49-49 unserved of 1] | +20.5% | 1 |
| SEQUENTIAL_CHEAPEST_INSERTION + GLS | +37.8% (+37..+38) | +15.1% (+14..+16) | +12.8% (+13..+13) | +17.2% (+17..+17) | +14.1% (+13..+16) | +23.9% (+20..+30) | +7.9% (+5..+12) | [1 run(s) left 17-17 unserved of 1] | +18.4% | 1 |
| AUTOMATIC + GLS | +44.2% (+44..+45) | +30.8% (+31..+31) | +7.0% (+3..+14) | +4.0% (+1..+6) | +12.1% (+12..+13) | +22.2% (+22..+23) | +16.2% (+16..+17) | [1 run(s) left 57-57 unserved of 1] | +19.5% | 1 |
| PCI + SIMULATED_ANNEALING | +47.9% (+48..+48) | +11.2% (+10..+12) | +2.0% (+2..+2) | +14.9% (+15..+15) | +11.8% (+2..+18) | +22.6% (+22..+23) | +14.9% (+14..+16) | [1 run(s) left 11-11 unserved of 1] | +17.9% | 1 |
| PCI + TABU_SEARCH | +47.9% (+48..+48) | +12.2% (+12..+13) | +15.0% (+14..+15) | +14.4% (+12..+15) | +17.0% (+16..+19) | +24.3% (+22..+27) | +17.3% (+15..+21) | [1 run(s) left 40-40 unserved of 1] | +21.2% | 1 |
| PCI + ILS (ruin & recreate) | +46.9% (+47..+47) | +12.4% (+12..+12) | +4.3% (+3..+5) | +13.3% (+13..+14) | +21.8% (+16..+31) | +28.0% (+22..+31) | +16.3% (+14..+20) | [1 run(s) left 40-40 unserved of 1] | +20.5% | 1 |
| two-phase MIN_TRUCKS -> RECOMMENDED | +26.5% (+22..+29) | +6.4% (+4..+11) | +13.0% (+13..+13) | +13.0% (+13..+13) | +17.7% (+18..+18) | +11.7% (+11..+12) [1 FAIL of 3] | +5.2% (+4..+7) | +12.1% | +13.3% | 1 |
| two-phase MIN_DISTANCE -> RECOMMENDED | +17.7% (+17..+18) | +10.0% (+10..+10) | +12.9% (+13..+13) | +4.0% (+4..+4) | +10.7% (+9..+13) | +11.3% (+11..+11) | +6.4% (+5..+7) | +10.6% | +10.4% | 0 |
| pipeline: half + polish + warm | +9.9% (+10..+10) | +3.1% (+3..+3) | +14.7% (+13..+15) | +10.9% (+7..+13) | +8.4% (+7..+11) | +12.3% (+10..+14) | +13.7% (+13..+16) | [1 run(s) left 48-48 unserved of 1] | +10.4% | 1 |
| pipeline: MIN_TRUCKS + polish + warm | +14.7% (+12..+16) | +4.0% (+4..+4) | +13.3% (+13..+14) | +13.0% (+13..+13) | +10.0% (+8..+11) | +11.9% (+11..+13) | +6.2% (+5..+7) | +8.8% | +10.4% | 0 |

real80 detail at auto (trucks / loads / km / op. cost / unserved per repeat):

| configuration | repeats |
|---|---|
| PCI + GLS (engine) | 13 / 21 / 1399 / 754.5 / 0; 13 / 21 / 1413 / 757.6 / 0; 13 / 21 / 1394 / 754.7 / 0 |
| PATH_CHEAPEST_ARC + GLS | 13 / 19 / 1324 / 746.1 / 0; 13 / 19 / 1311 / 743.5 / 0; 13 / 19 / 1291 / 741.3 / 0 |
| SAVINGS + GLS | 13 / 22 / 1477 / 766.0 / 0; 13 / 22 / 1517 / 770.6 / 0; 12 / 21 / 1485 / 728.7 / 0 |
| LOCAL_CHEAPEST_INSERTION + GLS | 12 / 22 / 1481 / 730.9 / 0; 12 / 22 / 1481 / 730.9 / 0; 12 / 22 / 1503 / 735.1 / 0 |
| SEQUENTIAL_CHEAPEST_INSERTION + GLS | 12 / 19 / 1307 / 710.1 / 0; 12 / 19 / 1276 / 705.2 / 0; 12 / 19 / 1300 / 708.5 / 0 |
| AUTOMATIC + GLS | 13 / 19 / 1311 / 743.5 / 0; 13 / 19 / 1296 / 741.7 / 0; 13 / 19 / 1325 / 746.3 / 0 |
| PCI + SIMULATED_ANNEALING | 13 / 21 / 1433 / 760.8 / 0; 13 / 21 / 1433 / 760.8 / 0; 13 / 21 / 1433 / 760.8 / 0 |
| PCI + TABU_SEARCH | 13 / 21 / 1433 / 760.8 / 0; 13 / 21 / 1433 / 760.8 / 0; 13 / 21 / 1433 / 760.8 / 0 |
| PCI + ILS (ruin & recreate) | 13 / 21 / 1413 / 757.6 / 0; 13 / 21 / 1402 / 754.8 / 0; 13 / 21 / 1397 / 754.0 / 0 |
| two-phase MIN_TRUCKS -> RECOMMENDED | 10 / 21 / 1420 / 652.1 / 0; 9 / 19 / 1291 / 619.5 / 0; 10 / 19 / 1282 / 652.9 / 0 |
| two-phase MIN_DISTANCE -> RECOMMENDED | 8 / 14 / 1006 / 599.3 / 0; 8 / 14 / 1008 / 600.2 / 0; 8 / 14 / 995 / 596.8 / 0 |
| pipeline: half + polish + warm | 7 / 17 / 1148 / 550.0 / 0; 7 / 17 / 1153 / 549.7 / 0; 7 / 17 / 1147 / 549.7 / 0 |
| pipeline: MIN_TRUCKS + polish + warm | 8 / 19 / 1291 / 583.2 / 0; 8 / 19 / 1313 / 585.2 / 0; 7 / 19 / 1336 / 554.1 / 0 |

## (b2) Search strategy at 60 s (60 s)

Mean gap vs best-known over repeats (range in brackets). Runs that left stops unserved or failed are listed separately. Lower is better.

| configuration | real80 | syn150_s1 | syn150_s2 | mean gap (instances <= 150 stops) | runs with unserved / failed |
|---|---|---|---|---|---|
| PCI + GLS (engine) | +46.4% (+46..+46) | +0.5% (+0..+1) | +16.7% (+15..+20) | +21.2% | 0 |
| PATH_CHEAPEST_ARC + GLS | +22.9% | +5.6% | +16.6% | +15.0% | 0 |
| SAVINGS + GLS | +35.6% | +9.6% | +6.3% | +17.2% | 0 |
| LOCAL_CHEAPEST_INSERTION + GLS | +43.4% | +12.8% | +11.5% | +22.6% | 0 |
| SEQUENTIAL_CHEAPEST_INSERTION + GLS | +30.5% | +5.0% | +19.0% | +18.2% | 0 |
| AUTOMATIC + GLS | +22.9% | +5.6% | +16.6% | +15.0% | 0 |
| PCI + SIMULATED_ANNEALING | +47.9% | +2.1% | +21.6% | +23.9% | 0 |
| PCI + TABU_SEARCH | +47.9% | +2.1% | +20.7% | +23.5% | 0 |
| PCI + ILS (ruin & recreate) | +39.7% | +0.4% | +15.2% | +18.4% | 0 |
| two-phase MIN_TRUCKS -> RECOMMENDED | +16.6% | +4.4% | +8.9% | +10.0% | 0 |
| two-phase MIN_DISTANCE -> RECOMMENDED | +17.7% | +10.8% | +9.8% | +12.8% | 0 |
| pipeline: half + polish + warm | +10.9% (+0..+16) |  |  | +10.9% | 0 |
| pipeline: MIN_TRUCKS + polish + warm | +14.5% (+12..+16) |  |  | +14.5% | 0 |

real80 detail at 60 s (trucks / loads / km / op. cost / unserved per repeat):

| configuration | repeats |
|---|---|
| PCI + GLS (engine) | 13 / 21 / 1392 / 752.3 / 0; 13 / 21 / 1397 / 753.8 / 0; 13 / 21 / 1397 / 753.8 / 0 |
| PATH_CHEAPEST_ARC + GLS | 9 / 16 / 1110 / 626.9 / 0 |
| SAVINGS + GLS | 11 / 19 / 1352 / 694.3 / 0 |
| LOCAL_CHEAPEST_INSERTION + GLS | 12 / 22 / 1501 / 734.6 / 0 |
| SEQUENTIAL_CHEAPEST_INSERTION + GLS | 11 / 17 / 1151 / 670.2 / 0 |
| AUTOMATIC + GLS | 9 / 16 / 1110 / 626.9 / 0 |
| PCI + SIMULATED_ANNEALING | 13 / 21 / 1433 / 760.8 / 0 |
| PCI + TABU_SEARCH | 13 / 21 / 1433 / 760.8 / 0 |
| PCI + ILS (ruin & recreate) | 12 / 19 / 1249 / 718.9 / 0 |
| two-phase MIN_TRUCKS -> RECOMMENDED | 8 / 14 / 982 / 594.3 / 0 |
| two-phase MIN_DISTANCE -> RECOMMENDED | 8 / 14 / 1006 / 599.3 / 0 |
| pipeline: half + polish + warm | 5 / 14 / 1003 / 493.6 / 0; 8 / 19 / 1296 / 583.7 / 0; 8 / 19 / 1296 / 583.7 / 0 |
| pipeline: MIN_TRUCKS + polish + warm | 8 / 19 / 1291 / 583.2 / 0; 8 / 19 / 1295 / 582.3 / 0; 7 / 19 / 1336 / 554.1 / 0 |

## (b3) syn300_s1 at 300 s (300 s)

Mean gap vs best-known over repeats (range in brackets). Runs that left stops unserved or failed are listed separately. Lower is better.

| configuration | syn300_s1 | mean gap (instances <= 150 stops) | runs with unserved / failed |
|---|---|---|---|
| PCI + GLS (engine) | [1 run(s) left 7-7 unserved of 1] | | 1 |
| SAVINGS + GLS | +4.1% | | 0 |
| AUTOMATIC + GLS | +0.3% | | 0 |
| two-phase MIN_DISTANCE -> RECOMMENDED | +5.7% | | 0 |

## (c) The three scenarios: are the alternatives better on their own goal?

Production way = RECOMMENDED (auto limit), then MIN_TRUCKS and MIN_DISTANCE warm-started from it with half the time. `cold` = the alternative solved alone from scratch with the full auto limit. Cells: trucks / loads / km / operating cost OMR / RECOMMENDED objective OMR. Goals: MIN_TRUCKS = fewest trucks (then loads), MIN_DISTANCE = fewest km. `best of 3` = the scenario plan with the lowest RECOMMENDED objective.

| instance | repeat | RECOMMENDED | MIN_TRUCKS (warm) | MIN_DISTANCE (warm) | best of 3 on REC objective | MIN_TRUCKS (cold) | MIN_DISTANCE (cold) |
|---|---|---|---|---|---|---|---|
| real80 | 0 | 13 / 21 / 1413 / 757.6 / 777.4 | 13 / 21 / 1396 / 753.6 / 778.9 | 11 / 17 / 1143 / 699.3 / 728.3 | MIN_DISTANCE (+38.1% vs best-known) | 10 / 21 / 1423 / 653.6 / 687.7 | 9 / 14 / 1001 / 633.9 / 659.0 |
| real80 | 1 | 13 / 21 / 1402 / 754.8 / 775.1 | 13 / 21 / 1395 / 753.2 / 775.2 | 11 / 16 / 1073 / 677.8 / 703.1 | MIN_DISTANCE (+33.3% vs best-known) | 10 / 21 / 1439 / 655.5 / 690.8 | 8 / 14 / 993 / 607.9 / 645.8 |
| real80 | 2 | 13 / 21 / 1413 / 757.6 / 777.4 | 13 / 21 / 1392 / 752.8 / 776.7 | 11 / 17 / 1143 / 699.3 / 728.3 | MIN_DISTANCE (+38.1% vs best-known) | 10 / 21 / 1416 / 651.8 / 688.0 | 9 / 14 / 976 / 631.9 / 662.2 |
| syn150_s1 | 0 | 8 / 12 / 1029 / 532.4 / 565.0 | 8 / 11 / 910 / 504.7 / 606.3 | 9 / 11 / 808 / 504.2 / 603.1 | RECOMMENDED (+12.3% vs best-known) | 8 / 11 / 984 / 528.8 / 641.3 | 8 / 11 / 949 / 524.4 / 634.3 |
| syn150_s2 | 0 | 11 / 13 / 1089 / 622.8 / 655.0 | 11 / 13 / 806 / 555.0 / 661.3 | 10 / 12 / 789 / 525.7 / 624.7 | MIN_DISTANCE (+22.5% vs best-known) | 8 / 12 / 1005 / 540.0 / 633.8 | 10 / 12 / 813 / 534.2 / 627.0 |
| syn150_s3 | 0 | 9 / 12 / 957 / 538.2 / 569.5 | 8 / 10 / 738 / 460.7 / 568.4 | 8 / 9 / 737 / 462.2 / 571.5 | MIN_TRUCKS (+13.9% vs best-known) | 8 / 10 / 803 / 476.2 / 578.5 | 9 / 10 / 712 / 479.5 / 581.5 |

Longer runs on real80:

| run | scenario | trucks / loads / km / op. cost / REC objective |
|---|---|---|
| 120 s MIN_DISTANCE | MIN_DISTANCE | 9 / 14 / 970 / 631.3 / 661.5 |
| 60 s RECOMMENDED+MIN_TRUCKS+MIN_DISTANCE | RECOMMENDED | 12 / 19 / 1256 / 719.6 / 738.3 |
| 60 s RECOMMENDED+MIN_TRUCKS+MIN_DISTANCE | MIN_TRUCKS | 11 / 19 / 1218 / 681.5 / 708.4 |
| 60 s RECOMMENDED+MIN_TRUCKS+MIN_DISTANCE | MIN_DISTANCE | 9 / 14 / 987 / 635.7 / 673.2 |
| 120 s MIN_TRUCKS | MIN_TRUCKS | 6 / 14 / 978 / 526.2 / 562.9 |

Best plan on each goal over ALL real80 plans found in this benchmark:

* fewest trucks: 5 trucks / 14 loads / 1006 km (best_push: 120s warm-start from polish of pipeline real80|60|half_polish_warm|s0)
* fewest loads: 14 loads (lower bound by kg: 134,578 kg / 10,000 kg = 13.5 -> 14)
* fewest km: 969.9 km / 9 trucks / 14 loads (real80|tl120|std|MIN_DISTANCE|PCI|GLS|s0 [MIN_DISTANCE])

## Consolidation polish applied to the engine's own plans (offline, no extra OR-Tools time)

`pathology.polish`: repeatedly apply the best of MOVE (a whole load to another truck as an extra trip), MERGE (two loads into one) and RESEQ (2-opt/or-opt a load) while the evaluator's RECOMMENDED objective improves.

| instance | limit | engine objective -> polished (OMR) | trucks | loads | gain | polish time |
|---|---|---|---|---|---|---|
| real80 | auto | 777.4 -> 588.6 | 13 -> 7 | 21 -> 17 | -24.3% | 1.2 s |
| real80 | 10 s | 780.1 -> 586.1 | 13 -> 6 | 21 -> 16 | -24.9% | 1.4 s |
| real80 | 30 s | 772.8 -> 566.2 | 13 -> 6 | 21 -> 15 | -26.7% | 1.3 s |
| real80 | 60 s | 772.7 -> 579.3 | 13 -> 6 | 21 -> 16 | -25.0% | 1.1 s |
| real80 | 300 s | 705.2 -> 610.8 | 11 -> 8 | 19 -> 19 | -13.4% | 1.1 s |
| syn60_s1 | auto | 278.8 -> 255.3 | 5 -> 4 | 5 -> 5 | -8.4% | 0.2 s |
| syn60_s1 | 10 s | 278.8 -> 255.3 | 5 -> 4 | 5 -> 5 | -8.4% | 0.2 s |
| syn60_s1 | 30 s | 254.1 -> 254.1 | 4 -> 4 | 5 -> 5 | +0.0% | 0.2 s |
| syn60_s1 | 60 s | 254.1 -> 254.1 | 4 -> 4 | 5 -> 5 | +0.0% | 0.2 s |
| syn60_s1 | 300 s | 248.5 -> 248.5 | 4 -> 4 | 5 -> 5 | +0.0% | 0.1 s |
| syn60_s2 | auto | 286.4 -> 285.7 | 5 -> 5 | 5 -> 5 | -0.3% | 0.2 s |
| syn60_s2 | 10 s | 259.9 -> 259.9 | 4 -> 4 | 5 -> 5 | +0.0% | 0.1 s |
| syn60_s2 | 30 s | 249.1 -> 249.1 | 4 -> 4 | 4 -> 4 | +0.0% | 0.1 s |
| syn60_s2 | 60 s | 251.7 -> 251.2 | 4 -> 4 | 4 -> 4 | -0.2% | 0.1 s |
| syn60_s2 | 300 s | 248.3 -> 248.3 | 4 -> 4 | 4 -> 4 | +0.0% | 0.1 s |
| syn60_s3 | auto | 239.8 -> 239.8 | 4 -> 4 | 4 -> 4 | +0.0% | 0.1 s |
| syn60_s3 | 10 s | 239.8 -> 239.8 | 4 -> 4 | 4 -> 4 | +0.0% | 0.1 s |
| syn60_s3 | 30 s | 215.6 -> 215.6 | 3 -> 3 | 3 -> 3 | +0.0% | 0.1 s |
| syn60_s3 | 60 s | 215.6 -> 215.6 | 3 -> 3 | 3 -> 3 | +0.0% | 0.1 s |
| syn60_s3 | 300 s | 215.6 -> 215.6 | 3 -> 3 | 3 -> 3 | +0.0% | 0.1 s |
| syn150_s1 | auto | 581.7 -> 557.4 | 10 -> 9 | 12 -> 11 | -4.2% | 1.4 s |
| syn150_s1 | 10 s | 602.0 -> 576.4 | 9 -> 8 | 13 -> 11 | -4.2% | 1.5 s |
| syn150_s1 | 30 s | 506.6 -> 506.6 | 8 -> 8 | 9 -> 9 | +0.0% | 0.4 s |
| syn150_s1 | 60 s | 505.1 -> 505.1 | 8 -> 8 | 9 -> 9 | +0.0% | 0.5 s |
| syn150_s1 | 300 s | 503.0 -> 503.0 | 8 -> 8 | 9 -> 9 | +0.0% | 0.4 s |
| syn150_s2 | auto | 633.0 -> 593.9 | 12 -> 10 | 12 -> 12 | -6.2% | 0.9 s |
| syn150_s2 | 10 s | 640.0 -> 612.1 | 9 -> 8 | 14 -> 13 | -4.4% | 1.3 s |
| syn150_s2 | 30 s | 625.3 -> 582.3 | 12 -> 10 | 12 -> 12 | -6.9% | 1.0 s |
| syn150_s2 | 60 s | 587.1 -> 531.0 | 11 -> 8 | 11 -> 11 | -9.6% | 0.8 s |
| syn150_s2 | 300 s | 542.1 -> 542.1 | 9 -> 9 | 11 -> 11 | -0.0% | 0.6 s |
| syn150_s3 | auto | 556.3 -> 533.3 | 10 -> 9 | 10 -> 10 | -4.1% | 0.7 s |
| syn150_s3 | 10 s | 578.4 -> 551.8 | 9 -> 8 | 12 -> 11 | -4.6% | 1.0 s |
| syn150_s3 | 30 s | 596.4 -> 573.5 | 9 -> 8 | 12 -> 12 | -3.8% | 0.9 s |
| syn150_s3 | 60 s | 545.8 -> 523.4 | 10 -> 9 | 10 -> 10 | -4.1% | 0.6 s |
| syn150_s3 | 300 s | 523.2 -> 523.2 | 9 -> 9 | 10 -> 10 | +0.0% | 0.5 s |
| syn300_s1 | auto | 4,401,023.6 -> 4,400,997.3 | 12 -> 12 | 24 -> 24 | 44 unserved -> 44 | 5.0 s |
| syn300_s1 | 10 s | 6,501,011.9 -> 6,501,007.6 | 12 -> 12 | 24 -> 24 | 65 unserved -> 65 | 5.7 s |
| syn300_s1 | 30 s | 6,500,983.6 -> 6,500,971.0 | 12 -> 12 | 24 -> 23 | 65 unserved -> 65 | 3.1 s |
| syn300_s1 | 60 s | 6,500,968.9 -> 6,500,968.9 | 12 -> 12 | 24 -> 24 | 65 unserved -> 65 | 1.7 s |
| syn300_s1 | 300 s | 701,026.6 -> 701,025.0 | 12 -> 12 | 24 -> 24 | 7 unserved -> 7 | 3.7 s |

## Remedy pipelines, every run

| instance | limit | repeat | pipeline | stage 1 | polished | final | gap | trucks / loads / km / op. cost / unserved | polish s | warm first obj | engine default same limit |
|---|---|---|---|---|---|---|---|---|---|---|---|
| real80 | 20 s | 0 | half_polish_warm | 777.4 | 588.6 | 580.0 | +9.9% | 7 / 17 / 1148 / 550.0 / 0 | 4.0 | 588.6 | 777.4 (+47.3%) |
| real80 | 20 s | 1 | half_polish_warm | 777.4 | 588.6 | 579.8 | +9.9% | 7 / 17 / 1153 / 549.7 / 0 | 1.5 | 588.6 | 773.4 (+46.6%) |
| real80 | 20 s | 2 | half_polish_warm | 777.4 | 588.6 | 580.1 | +10.0% | 7 / 17 / 1147 / 549.7 / 0 | 3.6 | 588.6 | 773.2 (+46.5%) |
| real80 | 20 s | 0 | mt_polish_warm | 687.7 | 625.1 | 612.8 | +16.2% | 8 / 19 / 1291 / 583.2 / 0 | 1.9 | 625.1 | 777.4 (+47.3%) |
| real80 | 20 s | 1 | mt_polish_warm | 690.8 | 623.5 | 614.3 | +16.4% | 8 / 19 / 1313 / 585.2 / 0 | 2.4 | 623.5 | 773.4 (+46.6%) |
| real80 | 20 s | 2 | mt_polish_warm | 688.0 | 599.1 | 588.4 | +11.5% | 7 / 19 / 1336 / 554.1 / 0 | 2.2 | 599.1 | 773.2 (+46.5%) |
| real80 | 60 s | 0 | half_polish_warm | 776.0 | 585.5 | 528.6 | +0.2% | 5 / 14 / 1003 / 493.6 / 0 | 3.9 | 585.5 | 772.7 (+46.5%) |
| real80 | 60 s | 1 | half_polish_warm | 773.4 | 615.5 | 613.2 | +16.2% | 8 / 19 / 1296 / 583.7 / 0 | 2.8 | 615.5 | 771.7 (+46.3%) |
| real80 | 60 s | 2 | half_polish_warm | 773.4 | 615.5 | 613.2 | +16.2% | 8 / 19 / 1296 / 583.7 / 0 | 1.5 | 615.5 | 772.8 (+46.5%) |
| real80 | 60 s | 0 | mt_polish_warm | 687.7 | 625.1 | 612.8 | +16.2% | 8 / 19 / 1291 / 583.2 / 0 | 2.9 | 625.1 | 772.7 (+46.5%) |
| real80 | 60 s | 1 | mt_polish_warm | 690.8 | 623.5 | 611.4 | +15.9% | 8 / 19 / 1295 / 582.3 / 0 | 0.7 | 623.5 | 771.7 (+46.3%) |
| real80 | 60 s | 2 | mt_polish_warm | 688.0 | 599.1 | 588.4 | +11.5% | 7 / 19 / 1336 / 554.1 / 0 | 2.6 | 599.1 | 772.8 (+46.5%) |
| syn60_s1 | 8 s | 0 | half_polish_warm | 279.5 | 255.9 | 255.9 | +3.2% | 4 / 5 / 453 / 244.1 / 0 | 0.2 | 255.9 | 278.8 (+12.4%) |
| syn60_s1 | 8 s | 1 | half_polish_warm | 279.5 | 255.9 | 255.9 | +3.2% | 4 / 5 / 453 / 244.1 / 0 | 0.2 | 255.9 | 278.8 (+12.4%) |
| syn60_s1 | 8 s | 2 | half_polish_warm | 278.8 | 255.3 | 255.3 | +3.0% | 4 / 5 / 447 / 242.5 / 0 | 0.2 | 255.3 | 278.8 (+12.4%) |
| syn60_s1 | 8 s | 0 | mt_polish_warm | 307.2 | 307.2 | 258.0 | +4.0% | 4 / 5 / 441 / 241.2 / 0 | 0.3 | 307.2 | 278.8 (+12.4%) |
| syn60_s1 | 8 s | 1 | mt_polish_warm | 307.2 | 307.2 | 258.0 | +4.0% | 4 / 5 / 441 / 241.2 / 0 | 0.1 | 307.2 | 278.8 (+12.4%) |
| syn60_s1 | 8 s | 2 | mt_polish_warm | 307.2 | 307.2 | 258.0 | +4.0% | 4 / 5 / 441 / 241.2 / 0 | 0.4 | 307.2 | 278.8 (+12.4%) |
| syn60_s2 | 8 s | 0 | half_polish_warm | 300.3 | 296.9 | 285.0 | +15.3% | 5 / 5 / 448 / 268.4 / 0 | 1.1 | 296.9 | 286.4 (+15.8%) |
| syn60_s2 | 8 s | 1 | half_polish_warm | 285.7 | 285.7 | 280.1 | +13.3% | 5 / 5 / 429 / 263.9 / 0 | 0.3 | 285.7 | 284.2 (+14.9%) |
| syn60_s2 | 8 s | 2 | half_polish_warm | 285.6 | 285.6 | 285.6 | +15.5% | 5 / 5 / 462 / 271.9 / 0 | 0.3 | 285.6 | 259.9 (+5.1%) |
| syn60_s2 | 8 s | 0 | mt_polish_warm | 308.1 | 308.1 | 279.0 | +12.8% | 5 / 5 / 417 / 261.1 / 0 | 0.2 | 308.1 | 286.4 (+15.8%) |
| syn60_s2 | 8 s | 1 | mt_polish_warm | 312.5 | 312.5 | 280.0 | +13.2% | 5 / 5 / 438 / 266.0 / 0 | 0.1 | 312.5 | 284.2 (+14.9%) |
| syn60_s2 | 8 s | 2 | mt_polish_warm | 308.0 | 308.0 | 281.3 | +13.7% | 5 / 5 / 444 / 267.5 / 0 | 0.3 | 308.0 | 259.9 (+5.1%) |
| syn60_s3 | 8 s | 0 | half_polish_warm | 239.8 | 239.8 | 239.8 | +12.9% | 4 / 4 / 381 / 222.5 / 0 | 0.1 | 239.8 | 239.8 (+12.9%) |
| syn60_s3 | 8 s | 1 | half_polish_warm | 244.1 | 243.5 | 239.8 | +12.9% | 4 / 4 / 381 / 222.5 / 0 | 0.4 | 243.5 | 239.8 (+12.9%) |
| syn60_s3 | 8 s | 2 | half_polish_warm | 245.2 | 240.0 | 227.5 | +7.1% | 3 / 4 / 428 / 209.0 / 0 | 0.4 | 240.0 | 239.8 (+12.9%) |
| syn60_s3 | 8 s | 0 | mt_polish_warm | 248.4 | 248.4 | 239.7 | +12.8% | 4 / 4 / 364 / 218.5 / 0 | 0.2 | 248.4 | 239.8 (+12.9%) |
| syn60_s3 | 8 s | 1 | mt_polish_warm | 255.7 | 255.7 | 240.7 | +13.3% | 4 / 4 / 373 / 220.7 / 0 | 0.3 | 255.7 | 239.8 (+12.9%) |
| syn60_s3 | 8 s | 2 | mt_polish_warm | 248.4 | 248.4 | 239.7 | +12.8% | 4 / 4 / 364 / 218.5 / 0 | 0.3 | 248.4 | 239.8 (+12.9%) |
| syn150_s1 | 20 s | 0 | half_polish_warm | 614.6 | 589.5 | 538.6 | +7.1% | 8 / 12 / 923 / 506.7 / 0 | 4.1 | 589.5 | 581.7 (+15.7%) |
| syn150_s1 | 20 s | 1 | half_polish_warm | 598.1 | 574.4 | 538.6 | +7.1% | 8 / 12 / 938 / 510.4 / 0 | 3.6 | 574.4 | 583.2 (+15.9%) |
| syn150_s1 | 20 s | 2 | half_polish_warm | 592.1 | 586.5 | 558.5 | +11.0% | 8 / 12 / 1010 / 527.6 / 0 | 3.8 | 586.5 | 584.7 (+16.3%) |
| syn150_s1 | 20 s | 0 | mt_polish_warm | 641.3 | 634.5 | 542.0 | +7.8% | 8 / 11 / 933 / 509.5 / 0 | 1.0 | 634.5 | 581.7 (+15.7%) |
| syn150_s1 | 20 s | 1 | mt_polish_warm | 641.3 | 634.5 | 557.5 | +10.8% | 8 / 11 / 990 / 523.0 / 0 | 0.9 | 634.5 | 583.2 (+15.9%) |
| syn150_s1 | 20 s | 2 | mt_polish_warm | 641.3 | 634.5 | 560.5 | +11.4% | 8 / 11 / 995 / 524.1 / 0 | 1.8 | 634.5 | 584.7 (+16.3%) |
| syn150_s2 | 20 s | 0 | half_polish_warm | 639.8 | 611.6 | 574.6 | +12.7% | 8 / 13 / 1050 / 538.5 / 0 | 2.5 | 611.6 | 633.0 (+24.2%) |
| syn150_s2 | 20 s | 1 | half_polish_warm | 586.7 | 586.7 | 561.0 | +10.0% | 8 / 13 / 978 / 521.2 / 0 | 0.7 | 586.7 | 675.3 (+32.5%) |
| syn150_s2 | 20 s | 2 | half_polish_warm | 621.4 | 617.5 | 582.2 | +14.2% | 8 / 13 / 1079 / 545.5 / 0 | 3.5 | 617.5 | 630.9 (+23.7%) |
| syn150_s2 | 20 s | 0 | mt_polish_warm | 633.8 | 633.8 | 568.3 | +11.5% | 8 / 12 / 995 / 529.5 / 0 | 0.7 | 633.8 | 633.0 (+24.2%) |
| syn150_s2 | 20 s | 1 | mt_polish_warm | 633.8 | 633.8 | 568.3 | +11.5% | 8 / 12 / 995 / 529.5 / 0 | 0.6 | 633.8 | 675.3 (+32.5%) |
| syn150_s2 | 20 s | 2 | mt_polish_warm | 633.8 | 633.8 | 575.1 | +12.8% | 8 / 12 / 1019 / 535.3 / 0 | 1.7 | 633.8 | 630.9 (+23.7%) |
| syn150_s3 | 20 s | 0 | half_polish_warm | 620.7 | 603.8 | 562.9 | +12.8% | 8 / 11 / 1024 / 529.7 / 0 | 3.9 | 603.8 | 556.3 (+11.5%) |
| syn150_s3 | 20 s | 1 | half_polish_warm | 667.9 | 637.9 | 562.0 | +12.6% | 8 / 11 / 1021 / 528.7 / 0 | 3.2 | 637.9 | 569.5 (+14.1%) |
| syn150_s3 | 20 s | 2 | half_polish_warm | 630.1 | 621.9 | 577.5 | +15.7% | 9 / 11 / 987 / 545.5 / 0 | 3.6 | 621.9 | 572.3 (+14.7%) |
| syn150_s3 | 20 s | 0 | mt_polish_warm | 567.0 | 567.0 | 532.5 | +6.7% | 8 / 10 / 856 / 489.0 / 0 | 1.1 | 567.0 | 556.3 (+11.5%) |
| syn150_s3 | 20 s | 1 | mt_polish_warm | 567.0 | 567.0 | 532.5 | +6.7% | 8 / 10 / 856 / 489.0 / 0 | 0.6 | 567.0 | 569.5 (+14.1%) |
| syn150_s3 | 20 s | 2 | mt_polish_warm | 600.0 | 585.8 | 524.6 | +5.1% | 8 / 10 / 836 / 484.1 / 0 | 1.6 | 585.8 | 572.3 (+14.7%) |
| syn300_s1 | 150 s | 0 | half_polish_warm | 4,801,063.1 | 4,801,034.4 | 4,800,956.3 | 48 unserved (P5:48) | 12 / 24 / 1754 / 883.0 / P5:48 | 25.1 | 4,801,034.4 | 4,401,023.6 (44 unserved (P5:44)) |
| syn300_s1 | 150 s | 0 | mt_polish_warm | 1,146.7 | 1,142.9 | 1,033.1 | +8.8% | 12 / 26 / 1840 / 953.4 / 0 | 13.2 | 1,142.9 | 4,401,023.6 (44 unserved (P5:44)) |

## Throughput / contention indicator

Solutions reported by OR-Tools per second of search, engine default, by instance (all limits, repeat 0). A lightly loaded reference run of real80 at 20 s reported 910 solutions (45/s); under the benchmark's load the same run reported 213-411.

| instance | solutions/s (min / median / max over limits) |
|---|---|
| real80 | 10 / 13 / 44 |
| syn60_s1 | 8 / 19 / 42 |
| syn60_s2 | 11 / 20 / 56 |
| syn60_s3 | 8 / 18 / 62 |
| syn150_s1 | 4 / 16 / 26 |
| syn150_s2 | 4 / 14 / 26 |
| syn150_s3 | 4 / 11 / 33 |
| syn300_s1 | 2 / 5 / 16 |

