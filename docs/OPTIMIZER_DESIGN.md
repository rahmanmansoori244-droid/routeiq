# How the NMWC dispatch optimizer decides (plain language)

Engine: Google **OR-Tools** vehicle routing (`apps/solver/dispatch_solver.py`, `POST /optimize-dispatch`), fed with **road** distances and driving times from **OSRM**.

The result is an **OPTIMIZED PLAN**: a good, feasible plan found within a time limit. It is not claimed to be the perfect or global optimum.

## 1. What can never be broken (hard rules)
- **Location:** a customer without a valid location is not guessed. It is listed as *unserved: location missing* until the dispatcher adds one.
- **Truck capacity:** cases **and** kilograms (when a payload is set). A truck is never overloaded to save kilometres.
- **Receiving hours (hard window):** delivery must *start* inside the customer's hard window, e.g. a hypermarket 06:00–10:00. If no truck can make it, the order is unserved with reason *receiving hours cannot be met*. It is never silently delivered late.
- **Truck day:** first departure to last return must fit the shift limit (default 11 h). Depot opening hours apply.
- **Trip order:** load 2 of a truck leaves only after load 1 is back **and** the reload time (default 30 min) has passed.
- **Locked, loading and dispatched loads** are never re-planned.

## 2. What it tries to achieve, in this order
1. **Serve P1 orders.** P1 is the highest priority, P5 the lowest.
2. **Serve as much as possible, weighted by priority.** Leaving a P1 order behind costs 10,000 "points", P2 1,000, P3 100, P4 10 and P5 1. One unit is worth more than any realistic day's operating cost, so:
   - the optimizer will use another truck or another load before dropping an order;
   - when capacity really runs out, **P5 orders are left out first**, then P4, and so on.
   A test (`test_priority_p1_beats_identical_p5`) fails if this is ever inverted.
3. **Contribution margin**, only when the file carries a reliable margin for every order. Among orders of the **same** priority, higher margin wins. Margin can never beat a higher priority. Without margin data the plan optimizes service + cost and never claims "profit".
4. **Operating cost** in real OMR:
   - fixed cost for each truck used that day;
   - a small cost per load;
   - distance cost = km × (non-fuel cost per km + fuel price ÷ km per litre). **Fuel is counted once**;
   - driver time cost per hour;
   - overtime after the normal day (default 9 h).
5. Fewer trucks, fewer loads, fewer km and less time follow from (4).
6. **Preferences:** arriving outside a *preferred* window is allowed but costs a small penalty per minute, and P1/P2 customers get a slight "earlier is better" push. Preferences never override the hard rules or priorities.

## 3. Multiple loads per truck
Each physical truck is one "vehicle" with optional depot **reload** visits (up to `maxTripsPerTruck − 1`; 3 loads by default).

A reload empties the truck (the capacity counter resets) and takes the reload time. Because all of a truck's loads sit on one timeline, loads can never overlap. The export shows them as **T01 – Load 1, T01 – Load 2, …**.

### Split deliveries
A customer whose open cases or kilograms fit **no** truck is cut into parts before the optimizer runs (setting *Split deliveries*, on by default). Parts are sized for the truck that needs the fewest of them; each part is filled up to one full truck, product line by product line, and a line is cut only when it does not fit. The last part is the remainder, which can share a load with other customers. Every part is an ordinary stop at the customer's location, so parts can go on different trucks or on different loads of one truck, and the optimizer can leave a part unserved (with a reason) like any other stop. Unloading time is shared between parts in proportion to cases. When a part is locked or dispatched and the day is re-planned, only the cases not yet on a frozen load are planned again.

## 4. Distances
- **Road distance and time come from OSRM.** The OSRM address is configuration (`OSRM_URL` or tenant `osrmUrl`). Production should run its own OSRM with the Oman map (`docs/OSRM_SETUP.md`); RouteIQ does not depend on the public demo server.
- OSRM times are for cars. Trucks are assumed 25% slower (`roadTimeFactor` = 1.25).
- If OSRM is not configured or fails, the plan is still produced with straight-line × 1.3 distances. A warning appears and every km figure is labelled **Estimated**.

## 5. Late orders and re-planning
1. Orders received after the cutoff (default 18:00 the evening before), or after a plan exists, are marked **LATE** with the time, user and reason.
2. **Re-plan** creates **plan version N+1**:
   - LOCKED, LOADING, DISPATCHED and COMPLETED loads are copied exactly;
   - their trucks become available again only after those loads return and are reloaded;
   - everything else, including the late order, is optimized again.
3. The late order ends up in an unlocked future load, another truck, or an extra load, or it is **unserved: late order – no capacity**. Locked loads never move.
4. **Plan continuity:** on a re-plan, moving an order to a different truck than in the previous version costs a small penalty (default 3 OMR per stop). One late order therefore does not reshuffle every unlocked load; orders move only when it clearly pays off. Service and priorities still come first. Measured on the demo day: a re-plan changed 16 assignments with 8 trucks untouched, against 116 changes without continuity.
5. The new version shows, for example: *"1 order added, 3 assignments changed, 5 trucks unchanged, 2 locked/dispatched loads preserved"*.
6. The old version is kept (SUPERSEDED), never overwritten.

## 6. Three options, one recommendation
- **RECOMMENDED** (applied automatically): service, priorities and customer hours first, then true cost.
- **MIN TRUCKS**: pushes hard for fewer trucks and loads.
- **MIN DISTANCE**: fewest road km.

Both alternatives keep every hard rule and priority but ignore the soft preferences (preferred windows, early arrival, overtime); each answers one question. If an alternative takes too long, it is skipped with a note, and the recommended plan is always delivered.

The alternatives start from the recommended plan, so they are only ever shown if they are better on their own measure. The dispatcher must click **Use instead** to switch; nothing switches automatically.

## 7. Speed
| Day size | Time limit | Typical wall time (3 options) |
|---|---|---|
| ≤ 25 stops | 3 s | ~6 s |
| ≤ 80 stops | 8 s | ~15 s |
| ≤ 200 stops (normal NMWC day ~150) | 20 s | ~30–40 s |
| ≤ 350 stops | 150 s | ~4 min |
| larger | 240 s | ~6 min |

If the search reaches its time limit with capacity to spare, any stop still left out is labelled *"not planned yet: time limit reached"*, never *"could not be fitted"*. Re-plan to continue.

Measured on this PC for a synthetic 150-stop Muscat day: recommended plan in 20 s, all three options in about 31 s.

## 8. Every order is accounted for
After every optimization the system checks that **uploaded cases = planned cases + unserved cases**, in total, per SKU and per sales order, and that each order appears exactly once. A split order may appear in several parts: then every product line must add up exactly (*planned parts + unserved parts = uploaded*). A plan that does not reconcile cannot be dispatched.
