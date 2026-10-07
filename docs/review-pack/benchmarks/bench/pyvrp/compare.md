All metrics from the neutral evaluator (timing=lp). op = operating cost OMR/day (fixed+trip+distance+fuel+driver+overtime); obj = engine RECOMMENDED objective in OMR-equivalent (op with span-based driver cost + early-arrival and preferred-window soft costs), EXCLUDING the unserved-stop penalty (100,000 OMR per P5 stop), which is reported separately as the unserved count. PyVRP cells: mean over seeds [best seed by obj]. Delta = PyVRP mean vs OR-Tools mean.


### real80

| time | OR-Tools runs: trucks/loads/km/op/obj | PyVRP (hard-flex) n | PyVRP mean trucks/loads/km/op/obj | PyVRP best | d op | d km | d obj | unserved OR/PV | violations OR/PV |
|---|---|---|---|---|---|---|---|---|---|
| 5 s | 13/21/1413/757.6/777.4 | 1 | 10.0/16.0/1107/646.8/672.3 | 10/16/1107/646.8/672.3 | -14.6% | -21.7% | -13.5% | 0/0 | 0/0 |
| 20 s (auto) | 13/21/1402/754.8/775.1 | 2 | 9.0/16.5/1141/621.3/653.3 | 8/17/1175/595.7/634.3 | -17.7% | -18.6% | -15.7% | 0/0 | 0/0 |
| 30 s | 13/21/1394/754.7/773.2; 13/21/1402/754.8/775.1 | 3 | 6.0/14.3/988/525.8/567.5 | 5/14/973/486.5/531.6 | -30.3% | -29.3% | -26.7% | 0/0 | 0/0 |
| 120 s | 13/21/1400/754.1/773.3 | 2 | 5.0/14.0/970/485.9/531.6 | 5/14/969/485.7/530.0 | -35.6% | -30.7% | -31.3% | 0/0 | 0/0 |
| 300 s | 10/16/1119/668.0/688.2 | 2 | 5.0/14.0/962/484.2/528.6 | 5/14/961/483.9/523.5 | -27.5% | -14.0% | -23.2% | 0/0 | 0/0 |

Other runs (variants / warm starts / OR-Tools strategy overrides):

| solver | variant | time | seed | trucks | loads | km | op | obj | early | pref-win | unserved | viol | status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ortools | RECOMMENDED-AUTOMATIC | 30 | 1 | 13 | 19 | 1291.0 | 740.7 | 757.2 | 10.2 | 0.0 | 0 | 0 | ROUTING_SUCCESS |
| ortools | RECOMMENDED-LOCAL_CHEAPEST_INSERTION | 30 | 1 | 12 | 22 | 1500.8 | 734.6 | 756.7 | 10.9 | 0.0 | 0 | 0 | ROUTING_SUCCESS |
| ortools | RECOMMENDED-PATH_CHEAPEST_ARC | 30 | 1 | 13 | 19 | 1291.4 | 740.8 | 757.4 | 10.3 | 0.0 | 0 | 0 | ROUTING_SUCCESS |
| ortools | RECOMMENDED-SAVINGS | 30 | 1 | 13 | 22 | 1497.9 | 768.9 | 788.4 | 9.4 | 0.0 | 0 | 0 | ROUTING_SUCCESS |
| ortools | RECOMMENDED-SEQUENTIAL_CHEAPEST_INSERTION | 30 | 1 | 12 | 17 | 1151.9 | 705.2 | 720.9 | 10.7 | 0.0 | 0 | 0 | ROUTING_SUCCESS |
| ortools | RECOMMENDED-SIMULATED_ANNEALING | 30 | 1 | 13 | 21 | 1433.1 | 760.8 | 780.1 | 10.5 | 0.0 | 0 | 0 | ROUTING_SUCCESS |
| ortools | RECOMMENDED-TABU_SEARCH | 30 | 1 | 13 | 21 | 1433.1 | 760.8 | 780.1 | 10.5 | 0.0 | 0 | 0 | ROUTING_SUCCESS |
| ortools | RECOMMENDED-fleet-10t(9) | 30 | 1 | 8 | 14 | 1005.9 | 599.6 | 619.0 | 13.1 | 0.0 | 0 | 0 | ROUTING_SUCCESS |
| ortools | RECOMMENDED-fleet-count7(7) | 30 | 1 | 7 | 14 | 996.4 | 563.2 | 584.8 | 14.2 | 0.0 | 0 | 0 | ROUTING_SUCCESS |
| ortools | RECOMMENDED-fleet-pyvrpbest(5) | 30 | 1 | 5 | 14 | 1016.8 | 500.4 | 535.4 | 25.5 | 0.0 | 0 | 0 | ROUTING_SUCCESS |
| pyvrp | hard-flex (warm from OR-Tools 300 s) | 60 | 1 | 10 | 16 | 1118.6 | 668.0 | 688.2 | 14.0 | 0.0 | 0 | 0 |  |

Best known (by obj): pyvrp hard-flex 300 s seed 2: 5 trucks / 14 loads / 960.6 km / op 483.9 / obj 523.5. Lowest op: pyvrp hard-flex 300 s: op 483.9, 5 trucks, 960.6 km.
Engine at production auto limit (20 s): op 754.8, obj 775.1 -> gap to best known obj +251.6 OMR-eq (+48.1%), op gap to lowest op +270.9 OMR (+56.0%).

### syn60_s1

| time | OR-Tools runs: trucks/loads/km/op/obj | PyVRP (prefhard-fixed) n | PyVRP mean trucks/loads/km/op/obj | PyVRP best | d op | d km | d obj | unserved OR/PV | violations OR/PV |
|---|---|---|---|---|---|---|---|---|---|
| 8 s (auto) | 5/5/447/267.5/278.8 | 2 | 3.0/5.5/457/223.1/239.9 | 3/6/461/221.6/238.3 | -16.6% | +2.3% | -13.9% | 0/0 | 0/0 |
| 30 s | 4/5/444/241.8/254.1; 4/5/444/241.8/254.1 | 3 | 3.0/5.7/447/219.8/236.9 | 3/6/449/218.4/235.0 | -9.1% | +0.7% | -6.8% | 0/0 | 0/0 |
| 120 s | 4/5/436/239.9/260.9 | 2 | 3.0/5.5/447/220.7/237.6 | 3/6/449/218.7/235.8 | -8.0% | +2.5% | -8.9% | 0/0 | 0/0 |
| 300 s | 4/5/417/235.4/248.5 | 2 | 3.0/6.0/449/218.6/235.5 | 3/6/449/218.4/235.1 | -7.2% | +7.7% | -5.3% | 0/0 | 0/0 |

Other runs (variants / warm starts / OR-Tools strategy overrides):

| solver | variant | time | seed | trucks | loads | km | op | obj | early | pref-win | unserved | viol | status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ortools | RECOMMENDED-fleet-pyvrpbest(3) | 30 | 1 | 3 | 7 | 518.1 | 242.8 | 262.5 | 15.1 | 0.5 | 0 | 0 | ROUTING_SUCCESS |
| pyvrp | hard-fixed | 30 | 1 | 3 | 6 | 432.4 | 214.1 | 241.4 | 16.3 | 7.8 | 0 | 0 |  |
| pyvrp | hard-fixed | 30 | 2 | 3 | 6 | 442.4 | 216.7 | 249.1 | 17.2 | 11.2 | 0 | 0 |  |
| pyvrp | hard-flex | 30 | 1 | 3 | 6 | 432.4 | 214.1 | 241.4 | 16.3 | 7.8 | 0 | 0 |  |
| pyvrp | hard-flex | 30 | 2 | 3 | 6 | 438.4 | 215.5 | 242.4 | 15.9 | 7.6 | 0 | 0 |  |
| pyvrp | prefhard-fixed (warm from OR-Tools 300 s) | 60 | 1 | 3 | 6 | 449.1 | 218.4 | 235.0 | 13.7 | 0.0 | 0 | 0 |  |
| pyvrp | prefhard-flex | 30 | 1 | 3 | 6 | 451.0 | 218.6 | 240.7 | 15.4 | 1.9 | 0 | 0 |  |
| pyvrp | prefhard-flex | 30 | 2 | 3 | 6 | 450.5 | 220.6 | 244.8 | 17.8 | 0.0 | 0 | 0 |  |

Best known (by obj): pyvrp prefhard-fixed 60 s seed 1: 3 trucks / 6 loads / 449.1 km / op 218.4 / obj 235.0. Lowest op: pyvrp hard-fixed 30 s: op 214.1, 3 trucks, 432.4 km.
Engine at production auto limit (8 s): op 267.5, obj 278.8 -> gap to best known obj +43.8 OMR-eq (+18.6%), op gap to lowest op +53.4 OMR (+24.9%).

### syn150_s1

| time | OR-Tools runs: trucks/loads/km/op/obj | PyVRP (prefhard-fixed) n | PyVRP mean trucks/loads/km/op/obj | PyVRP best | d op | d km | d obj | unserved OR/PV | violations OR/PV |
|---|---|---|---|---|---|---|---|---|---|
| 20 s (auto) | 10/12/916/555.1/580.7 | 2 | 7.0/12.0/833/460.9/500.9 | 7/12/804/453.5/495.1 | -17.0% | -9.1% | -13.7% | 0/0 | 0/0 |
| 30 s | 8/9/835/485.6/513.4; 10/12/967/567.4/595.7 | 3 | 7.0/10.7/795/451.2/489.5 | 7/10/771/445.2/483.9 | -14.3% | -11.7% | -11.7% | 0/0 | 0/0 |
| 120 s | 8/10/792/475.6/507.7 | 2 | 7.0/9.5/750/440.9/477.7 | 7/10/750/440.2/476.7 | -7.3% | -5.2% | -5.9% | 0/0 | 0/0 |
| 300 s | 8/9/797/476.4/503.0 | 2 | 7.0/9.5/747/440.0/477.3 | 7/10/748/439.8/476.5 | -7.6% | -6.3% | -5.1% | 0/0 | 0/0 |

Other runs (variants / warm starts / OR-Tools strategy overrides):

| solver | variant | time | seed | trucks | loads | km | op | obj | early | pref-win | unserved | viol | status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ortools | RECOMMENDED-AUTOMATIC | 30 | 1 | 9 | 9 | 799.7 | 502.1 | 531.0 | 30.2 | 0.0 | 0 | 0 | ROUTING_SUCCESS |
| ortools | RECOMMENDED-LOCAL_CHEAPEST_INSERTION | 30 | 1 | 10 | 10 | 851.7 | 539.7 | 567.5 | 29.2 | 0.0 | 0 | 0 | ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED |
| ortools | RECOMMENDED-PATH_CHEAPEST_ARC | 30 | 1 | 9 | 9 | 799.7 | 502.1 | 531.0 | 30.2 | 0.0 | 0 | 0 | ROUTING_SUCCESS |
| ortools | RECOMMENDED-SAVINGS | 30 | 1 | 10 | 10 | 803.2 | 528.0 | 556.0 | 29.3 | 0.0 | 0 | 0 | ROUTING_SUCCESS |
| ortools | RECOMMENDED-SEQUENTIAL_CHEAPEST_INSERTION | 30 | 1 | 10 | 10 | 866.5 | 543.2 | 567.8 | 26.0 | 0.0 | 0 | 0 | ROUTING_SUCCESS |
| ortools | RECOMMENDED-SIMULATED_ANNEALING | 30 | 1 | 8 | 10 | 874.5 | 497.7 | 525.6 | 25.6 | 0.9 | 0 | 0 | ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED |
| ortools | RECOMMENDED-TABU_SEARCH | 30 | 1 | 10 | 12 | 918.4 | 555.7 | 581.7 | 24.9 | 0.1 | 0 | 0 | ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED |
| ortools | RECOMMENDED-fleet-pyvrpbest(7) | 30 | 1 | 7 | 11 | 900.3 | 476.7 | 509.1 | 28.3 | 0.0 | 0 | 0 | ROUTING_SUCCESS |
| pyvrp | hard-fixed | 30 | 1 | 7 | 10 | 747.4 | 440.1 | 530.9 | 37.3 | 51.5 | 0 | 0 |  |
| pyvrp | hard-fixed | 30 | 2 | 7 | 10 | 723.6 | 433.9 | 516.4 | 39.7 | 40.8 | 0 | 0 |  |
| pyvrp | hard-flex | 30 | 1 | 7 | 10 | 760.8 | 442.8 | 555.5 | 43.4 | 62.4 | 0 | 0 |  |
| pyvrp | hard-flex | 30 | 2 | 7 | 9 | 719.1 | 435.6 | 559.2 | 42.8 | 77.9 | 0 | 0 |  |
| pyvrp | prefhard-fixed (warm from OR-Tools 300 s) | 60 | 1 | 7 | 11 | 788.0 | 449.3 | 483.8 | 31.0 | 0.0 | 0 | 0 |  |
| pyvrp | prefhard-flex | 30 | 1 | 7 | 10 | 772.2 | 445.5 | 500.1 | 42.8 | 4.3 | 0 | 0 |  |
| pyvrp | prefhard-flex | 30 | 2 | 7 | 10 | 757.6 | 442.0 | 497.8 | 42.8 | 1.0 | 0 | 0 |  |

Best known (by obj): pyvrp prefhard-fixed 300 s seed 1: 7 trucks / 10 loads / 748.3 km / op 439.8 / obj 476.5. Lowest op: pyvrp hard-fixed 30 s: op 433.9, 7 trucks, 723.6 km.
Engine at production auto limit (20 s): op 555.1, obj 580.7 -> gap to best known obj +104.2 OMR-eq (+21.9%), op gap to lowest op +121.2 OMR (+27.9%).

### syn150_s2

| time | OR-Tools runs: trucks/loads/km/op/obj | PyVRP (prefhard-fixed) n | PyVRP mean trucks/loads/km/op/obj | PyVRP best | d op | d km | d obj | unserved OR/PV | violations OR/PV |
|---|---|---|---|---|---|---|---|---|---|
| 20 s (auto) | 12/12/875/596.4/623.4 | 2 | 7.0/11.5/839/462.9/506.5 | 7/11/829/460.5/501.0 | -22.4% | -4.0% | -18.7% | 0/0 | 0/0 |
| 30 s | 12/12/876/596.7/623.0; 12/12/875/596.4/623.4 | 3 | 7.0/11.0/797/453.6/493.4 | 7/11/787/450.9/490.9 | -24.0% | -9.0% | -20.8% | 0/0 | 0/0 |
| 120 s | 10/12/867/544.5/576.3 | 2 | 7.0/11.0/779/448.6/490.2 | 7/11/782/449.0/489.7 | -17.6% | -10.1% | -15.0% | 0/0 | 0/0 |
| 300 s | 9/11/814/510.1/542.1 | 2 | 7.0/11.0/773/447.1/487.7 | 7/11/776/447.8/486.9 | -12.4% | -5.0% | -10.0% | 0/0 | 0/0 |

Other runs (variants / warm starts / OR-Tools strategy overrides):

| solver | variant | time | seed | trucks | loads | km | op | obj | early | pref-win | unserved | viol | status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ortools | RECOMMENDED-fleet-pyvrpbest(7) | 30 | 1 | 7 | 12 | 930.1 | 486.1 | 532.5 | 38.4 | 0.3 | 0 | 0 | ROUTING_SUCCESS |
| pyvrp | hard-fixed | 30 | 1 | 7 | 11 | 723.6 | 435.1 | 564.0 | 43.9 | 81.0 | 0 | 0 |  |
| pyvrp | hard-fixed | 30 | 2 | 7 | 11 | 734.2 | 437.7 | 553.5 | 47.5 | 64.8 | 0 | 0 |  |
| pyvrp | hard-flex | 30 | 1 | 7 | 11 | 730.9 | 436.9 | 559.1 | 45.5 | 70.1 | 0 | 0 |  |
| pyvrp | hard-flex | 30 | 2 | 7 | 11 | 727.9 | 436.4 | 536.5 | 44.2 | 48.7 | 0 | 0 |  |
| pyvrp | prefhard-fixed (warm from OR-Tools 300 s) | 60 | 1 | 7 | 11 | 790.4 | 453.9 | 491.5 | 34.3 | 0.0 | 0 | 0 |  |
| pyvrp | prefhard-flex | 30 | 1 | 7 | 11 | 766.2 | 445.3 | 504.6 | 42.0 | 8.3 | 0 | 0 |  |
| pyvrp | prefhard-flex | 30 | 2 | 7 | 11 | 786.4 | 450.5 | 502.1 | 37.5 | 3.0 | 0 | 0 |  |

Best known (by obj): pyvrp prefhard-fixed 300 s seed 1: 7 trucks / 11 loads / 776.3 km / op 447.8 / obj 486.9. Lowest op: pyvrp hard-fixed 30 s: op 435.1, 7 trucks, 723.6 km.
Engine at production auto limit (20 s): op 596.4, obj 623.4 -> gap to best known obj +136.4 OMR-eq (+28.0%), op gap to lowest op +161.3 OMR (+37.1%).

### syn300_s1

| time | OR-Tools runs: trucks/loads/km/op/obj | PyVRP (prefhard-fixed) n | PyVRP mean trucks/loads/km/op/obj | PyVRP best | d op | d km | d obj | unserved OR/PV | violations OR/PV |
|---|---|---|---|---|---|---|---|---|---|
| 30 s | 12/24/1886/913.8/992.8; 12/24/1842/899.1/977.5 | 3 | 12.0/24.3/1565/858.1/920.6 | 12/24/1551/853.1/914.8 | -5.3% | -16.1% | -6.5% (OR-Tools left stops unserved) | 130/0 | 0/0 |
| 120 s | 12/24/1785/898.9/969.7 | 2 | 12.0/24.0/1522/843.7/907.2 | 12/24/1525/842.6/905.4 | -6.1% | -14.7% | -6.4% (OR-Tools left stops unserved) | 40/0 | 0/0 |
| 150 s (auto) | 12/24/1777/896.4/966.3 | 2 | 12.0/24.0/1522/843.7/907.2 | 12/24/1525/842.6/905.4 | -5.9% | -14.4% | -6.1% (OR-Tools left stops unserved) | 40/0 | 0/0 |
| 300 s | 12/24/1832/950.3/1017.9 | 2 | 12.0/24.0/1503/836.5/901.3 | 12/24/1508/835.9/898.2 | -12.0% | -17.9% | -11.5% (OR-Tools left stops unserved) | 7/0 | 0/0 |

Other runs (variants / warm starts / OR-Tools strategy overrides):

| solver | variant | time | seed | trucks | loads | km | op | obj | early | pref-win | unserved | viol | status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pyvrp | hard-fixed | 30 | 1 | 12 | 24 | 1539.2 | 846.4 | 1010.1 | 62.2 | 81.3 | 0 | 0 |  |
| pyvrp | hard-fixed | 30 | 2 | 12 | 24 | 1519.7 | 846.2 | 991.1 | 66.1 | 58.2 | 0 | 0 |  |
| pyvrp | hard-flex | 30 | 1 | 12 | 24 | 1531.5 | 846.3 | 1043.9 | 66.0 | 102.8 | 0 | 0 |  |
| pyvrp | hard-flex | 30 | 2 | 12 | 24 | 1536.0 | 846.2 | 1027.5 | 65.2 | 88.1 | 0 | 0 |  |
| pyvrp | prefhard-fixed (warm from OR-Tools 300 s) | 60 | 1 | 12 | 24 | 1556.4 | 860.1 | 925.6 | 53.1 | 0.2 | 0 | 0 |  |
| pyvrp | prefhard-flex | 30 | 1 | 12 | 25 | 1550.1 | 854.7 | 956.5 | 63.8 | 9.3 | 0 | 0 |  |
| pyvrp | prefhard-flex | 30 | 2 | 12 | 25 | 1543.7 | 850.0 | 951.7 | 61.8 | 5.6 | 0 | 0 |  |

Best known (by obj): pyvrp prefhard-fixed 300 s seed 2: 12 trucks / 24 loads / 1508.3 km / op 835.9 / obj 898.2. Lowest op: pyvrp prefhard-fixed 300 s: op 835.9, 12 trucks, 1508.3 km.
Engine at production auto limit (150 s): op 896.4, obj 966.3 -> gap to best known obj +68.1 OMR-eq (+7.6%), op gap to lowest op +60.5 OMR (+7.2%).

### real80_prod

| time | OR-Tools runs: trucks/loads/km/op/obj | PyVRP (hard-flex) n | PyVRP mean trucks/loads/km/op/obj | PyVRP best | d op | d km | d obj | unserved OR/PV | violations OR/PV |
|---|---|---|---|---|---|---|---|---|---|
| 20 s (auto) | 13/21/1490/508.4/518.8 | 2 | 9.0/15.5/1095/393.5/417.1 | 9/16/1137/387.6/413.4 | -22.6% | -26.5% | -19.6% | 0/0 | 0/0 |
| 120 s | 12/21/1401/467.2/477.5 | 2 | 6.0/18.0/1220/281.8/314.8 | 6/18/1215/281.6/313.6 | -39.7% | -12.9% | -34.1% | 0/0 | 0/0 |

Best known (by obj): pyvrp hard-flex 120 s seed 2: 6 trucks / 18 loads / 1215.1 km / op 281.6 / obj 313.6. Lowest op: pyvrp hard-flex 120 s: op 281.6, 6 trucks, 1215.1 km.
Engine at production auto limit (20 s): op 508.4, obj 518.8 -> gap to best known obj +205.1 OMR-eq (+65.4%), op gap to lowest op +226.9 OMR (+80.6%).
