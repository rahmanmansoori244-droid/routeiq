### RECOMMENDED, new vs old engine (RECOMMENDED objective and costs in OMR, neutral evaluator)

| instance | old engine, same session: trucks / loads / op. cost / unserved / objective | old engine objective, all earlier runs (min-max, n) | new engine per run: trucks / loads / km / op. cost / unserved / objective | objective change vs old (same session) | new wall time (3 options) | old wall time |
|---|---|---|---|---|---|---|
| real80 | 12 / 19 / 719.9 / 0 / 738.7 | 772.9-777.4 (n=7) | 5 / 14 / 979 / 492.4 / 0 / 531.0<br>5 / 14 / 984 / 494.9 / 0 / 534.2 | -28.1%<br>-27.7% | 49 s, 53 s | 40 s |
| real80_prod | 12 / 21 / 467.2 / 0 / 477.5 | 477.5-477.5 (n=1) | 7 / 21 / 1,401 / 310.9 / 0 / 330.8<br>7 / 21 / 1,401 / 310.9 / 0 / 330.9 | -30.7%<br>-30.7% | 47 s, 46 s | 40 s |
| syn60_s1 | 4 / 5 / 241.8 / 0 / 254.1 | 278.8-278.8 (n=3) | 4 / 5 / 444 / 241.8 / 0 / 254.1<br>4 / 5 / 444 / 241.8 / 0 / 254.1 | +0.0%<br>+0.0% | 31 s, 32 s | 16 s |
| syn60_s2 | 4 / 4 / 230.3 / 0 / 249.1 | 259.9-286.4 (n=3) | 4 / 4 / 396 / 231.1 / 0 / 248.3<br>4 / 4 / 396 / 231.1 / 0 / 248.3 | -0.3%<br>-0.3% | 31 s, 31 s | 16 s |
| syn60_s3 | 3 / 3 / 198.8 / 0 / 215.6 | 239.8-239.8 (n=3) | 3 / 3 / 386 / 198.8 / 0 / 215.6<br>3 / 3 / 386 / 198.8 / 0 / 215.6 | +0.0%<br>+0.0% | 31 s, 31 s | 16 s |
| syn150_s1 | 8 / 9 / 478.5 / 0 / 505.1 | 505.2-584.7 (n=5) | 8 / 9 / 805 / 478.5 / 0 / 505.1<br>8 / 9 / 805 / 478.5 / 0 / 505.1 | +0.0%<br>+0.0% | 32 s, 32 s | 40 s |
| syn150_s2 | 11 / 11 / 560.3 / 0 / 587.1 | 630.9-675.3 (n=4) | 8 / 11 / 828 / 490.5 / 0 / 531.0<br>8 / 11 / 828 / 490.5 / 0 / 531.0 | -9.6%<br>-9.6% | 31 s, 31 s | 40 s |
| syn150_s3 | 10 / 10 / 514.7 / 0 / 545.8 | 556.3-572.3 (n=4) | 8 / 10 / 755 / 464.7 / 0 / 509.0<br>8 / 10 / 755 / 464.7 / 0 / 509.0 | -6.7%<br>-6.7% | 34 s, 34 s | 40 s |
| syn300_s1 | 12 / 24 / 953.5 / 0 / 1,022.2 | 3,100,969.5-4,500,950.7 (n=3) | 12 / 24 / 1,807 / 950.1 / 0 / 1,018.7<br>12 / 24 / 1,807 / 950.1 / 0 / 1,018.7 | -0.3%<br>-0.3% | 253 s, 252 s | 300 s |
| real80_realism | 10 / 19 / 678.7 / 0 / 701.8 | - | 6 / 14 / 991 / 574.0 / 0 / 596.0<br>6 / 14 / 991 / 575.3 / 0 / 594.5 | -15.1%<br>-15.3% | 54 s, 57 s | 40 s |

### Alternatives (new engine, first run) vs old engine same session: trucks / loads / km

| instance | MIN_TRUCKS old | MIN_TRUCKS new | MIN_DISTANCE old | MIN_DISTANCE new |
|---|---|---|---|---|
| real80 | 11 / 19 / 1,263 | 5 / 14 / 979 | 9 / 14 / 984 | 5 / 14 / 979 |
| real80_prod | 11 / 17 / 1,199 | 6 / 14 / 989 | 9 / 14 / 989 | 6 / 14 / 989 |
| syn60_s1 | 4 / 5 / 412 | 4 / 5 / 393 | 5 / 5 / 398 | 4 / 5 / 393 |
| syn60_s2 | 4 / 4 / 362 | 4 / 4 / 363 | 4 / 4 / 362 | 4 / 4 / 363 |
| syn60_s3 | 3 / 3 / 357 | 3 / 3 / 347 | 3 / 3 / 353 | 3 / 3 / 347 |
| syn150_s1 | 8 / 9 / 750 | 8 / 9 / 748 | 8 / 9 / 748 | 8 / 9 / 748 |
| syn150_s2 | 11 / 11 / 756 | 8 / 11 / 828 | 11 / 11 / 757 | 10 / 11 / 756 |
| syn150_s3 | 10 / 10 / 692 | 8 / 10 / 696 | 10 / 10 / 696 | 10 / 10 / 692 |
| syn300_s1 | 12 / 24 / 1,731 | 12 / 24 / 1,745 | 12 / 24 / 1,722 | 12 / 24 / 1,745 |
| real80_realism | 7 / 14 / 1,002 | 6 / 14 / 991 | 9 / 14 / 990 | 6 / 14 / 991 |

### Checks (all new runs)

- scenarios checked: 60; evaluator violations: 0; exact-turnaround violations: 0; not reconciled: 0
- old engine on real80_realism (no loading time per case): 9 load(s) leave before 20 min + 0.04 min/case of turnaround
- new engine run-to-run spread real80: 0.6% (n=2)
- new engine run-to-run spread real80_prod: 0.0% (n=2)
- new engine run-to-run spread syn60_s1: 0.0% (n=2)
- new engine run-to-run spread syn60_s2: 0.0% (n=2)
- new engine run-to-run spread syn60_s3: 0.0% (n=2)
- new engine run-to-run spread syn150_s1: 0.0% (n=2)
- new engine run-to-run spread syn150_s2: 0.0% (n=2)
- new engine run-to-run spread syn150_s3: 0.0% (n=2)
- new engine run-to-run spread syn300_s1: 0.0% (n=2)
- new engine run-to-run spread real80_realism: 0.3% (n=2)
- old engine run-to-run spread real80: 5.0% of the median objective (n=8)
- old engine run-to-run spread real80_prod: 0.0% of the median objective (n=2)
- old engine run-to-run spread syn60_s1: 8.9% of the median objective (n=4)
- old engine run-to-run spread syn60_s2: 13.7% of the median objective (n=4)
- old engine run-to-run spread syn60_s3: 10.1% of the median objective (n=4)
- old engine run-to-run spread syn150_s1: 13.9% of the median objective (n=6)
- old engine run-to-run spread syn150_s2: 13.9% of the median objective (n=5)
- old engine run-to-run spread syn150_s3: 4.6% of the median objective (n=5)
- old engine run-to-run spread syn300_s1: 120.0% of the median objective (n=4)
