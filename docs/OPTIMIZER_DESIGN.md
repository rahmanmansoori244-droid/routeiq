# How the NMWC dispatch optimizer decides (plain language)

Engine: Google **OR-Tools** vehicle routing (`apps/solver/dispatch_solver.py`, `POST /optimize-dispatch`), fed with **road** distances and driving times from **OSRM**, followed by an exact **load re-assignment** step (OR-Tools CP-SAT, `apps/solver/load_repack.py`, see §7).

The result is an **OPTIMIZED PLAN**: a good, feasible plan found within a time limit. It is not claimed to be the perfect or global optimum.

## 1. What can never be broken (hard rules)
- **Location:** a customer without a valid location is not guessed. It is listed as *unserved: location missing* until the dispatcher adds one.
- **Truck capacity:** cases **and** kilograms (when a payload is set). A truck is never overloaded to save kilometres.
- **Receiving hours (hard window):** delivery must *start* inside the customer's hard window, e.g. a hypermarket 06:00–10:00. If no truck can make it, the order is unserved with reason *receiving hours cannot be met*. It is never silently delivered late.
- **Truck day:** first departure to last return must fit the shift limit (default 11 h). Depot opening hours apply.
- **Trip order:** load 2 of a truck leaves only after load 1 is back **and** its turnaround has passed: the reload time (default 30 min) plus the loading time per case of load 2 (default 0, see §8).
- **Locked, loading and dispatched loads** are never re-planned.

## 2. What it tries to achieve, in this order
1. **Serve P1 orders.** P1 is the highest priority, P5 the lowest.
2. **Serve as much as possible, strictly by priority.** One order of a higher priority always wins over **any number** of lower-priority orders: one P2 is never left out to fit eleven P3s, one P1 never to fit fifty P2-P5s. Leaving even a P5 behind costs more (1,000 OMR in the optimizer's scoring) than serving it ever could, so:
   - the optimizer will use another truck or another load before dropping an order;
   - when capacity really runs out, **P5 orders are left out first**, then P4, and so on.
   Technically each order is worth w(P) "points": P5 = 1, and a priority is worth 1 + the points of every lower-priority order of the day together, so it outweighs all of them. The MIN TRUCKS search multiplies truck costs by 20 (see §6); it multiplies these points by 20 too, so there as well no order is dropped to save a truck. Tests fail if this is ever broken (`test_priority_p1_beats_identical_p5`, `test_strict_priority_one_p2_beats_eleven_p3`).
   *Before 25 Sep 2026* the points were fixed (P1 10,000 ... P5 1), so eleven P3s (1,100) outweighed one P2 (1,000). That weighted mode still exists for API callers (`strict_priorities: false`); the web app always plans strictly. On a day with thousands of orders the points would no longer fit the optimizer's 64-bit arithmetic; it then scales them down and, only if that is not enough, ranks the highest priorities by weight again and says so in a warning (far beyond NMWC's days).
3. **Contribution margin**, only when the file carries a reliable margin for every order. Among orders of the **same** priority, higher margin wins: a margin counts 10x operating cost for small margins and then flattens smoothly, so a 300 OMR order still beats a 50 OMR one (it never stops telling margins apart). Margin can never beat a higher priority. Without margin data the plan optimizes service + cost and never claims "profit".
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

A reload empties the truck (the capacity counter resets) and takes the turnaround time. Because all of a truck's loads sit on one timeline, loads can never overlap. The export shows them as **T01 – Load 1, T01 – Load 2, …**.

The route search cannot move a *whole* load from one truck to another (it moves one customer at a time, and a load only moves together with its reload visit). Left alone it tends to give every truck one short morning load. §7 fixes that after the search.

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
4. **Plan continuity:** on a late-order (or manual) re-plan, moving an order to a different truck than in the previous version costs a small penalty (default 3 OMR per stop). One late order therefore does not reshuffle every unlocked load; orders move only when it clearly pays off. Service and priorities still come first. Measured on the demo day: a re-plan changed 16 assignments with 8 trucks untouched, against 116 changes without continuity.
   A **re-optimize** (**Re-plan** with no late order waiting) has no moving charge: it looks for the best plan for everything that is not locked, so trucks and loads may change completely. Locked, loading and dispatched loads still never move. With a late order waiting, **Re-plan** is always a late-order re-plan, whichever button starts it.
5. The new version shows, for example: *"1 order added, 3 assignments changed, 5 trucks unchanged, 2 locked/dispatched loads preserved"*.
6. The old version is kept (SUPERSEDED), never overwritten.

## 6. Three options, one recommendation
- **RECOMMENDED** (applied automatically): service, priorities and customer hours first, then true cost.
- **MIN TRUCKS**: fewest trucks, then fewest loads, then operating cost.
- **MIN DISTANCE**: fewest road km, then cost.

Every option keeps every hard rule and priority, and never serves less (by priority) than its own route search did. The searches for the alternatives ignore the soft preferences (preferred windows, early arrival, overtime) so each answers one question; the final timetable of every option still honours preferred hours wherever that costs nothing. If an alternative takes too long, it is skipped with a note, and the recommended plan is always delivered.

All three options are picked from the same set of candidate plans (§7), each by its own measure, so unless it serves more orders, MIN TRUCKS never needs more trucks and MIN DISTANCE never drives more km than the recommendation. When one plan is best on every measure, the options show the same plan. The dispatcher must click **Use instead** to switch; nothing switches automatically.

## 7. After the search: re-assigning whole loads
The three route searches each produce loads (which customers, in which order). A second, exact step then keeps every load as it is and decides again **which truck carries it and when it leaves**, so that trucks do two or three loads each instead of one:
1. For the recommendation's costs (and for MIN TRUCKS' when that option is asked for), OR-Tools CP-SAT assigns the loads of each search plan to trucks and departure times, respecting capacity, customer hours, turnaround, shift length, loads per truck, depot hours, truck availability and locked/dispatched loads.
2. An order a search left out (not ruled out by a check) is offered as a one-customer load; if a free truck or trip can take it, it is planned. Service comes before cost, strictly by priority, also on fleet-shortage days (the search can leave out more than the shortage). The note then says *"...; this also plans 2 stop(s) the route search had left out"*.
3. Every candidate plan (the search plans and their re-assignments) is timed exactly (turnaround = reload + loading per case of the next load) and scored the same way: unserved orders by priority, then fixed truck cost, per-load cost, km cost, driver time over the truck day, overtime counted from the truck's first departure (as the cost report does), preferred hours, early arrival for P1/P2 and, on re-plans, moved orders.
4. Each option takes its best candidate. When this changed a plan it carries a note, for example *"Loads were re-assigned after the route search: 12 -> 5 trucks, 19 -> 14 loads, 720 -> 493 OMR operating cost."*
5. **Plans that break the exact loading time.** The route search only estimates the loading time between loads (80% of a full truck). On a tight day with loads fuller than that, its plan can need more turnaround than the day has, and no re-assignment keeps all its orders. When this step runs, such a plan is repacked once more with every order optional (whole loads, each load without one of its customers, one-customer loads), keeping the most priority value that fits. The orders it loses are unserved with *"Not planned: once every load was timed with the loading time between loads ..."* and the plan says how many. If even that fails, the search plan is kept with a warning.

Each CP-SAT solve is capped at min(15 s, max(3 s, half the search limit)) and stops earlier once it stops improving. It runs in the solver's worker processes, so the service keeps answering; when an alternative search overran its deadline (it keeps running in its worker), the step gets fresh workers instead of queueing behind it. A worker that dies (out of memory) loses only its own job: the recommendation's exact re-check next to it is kept. On NMWC's real 26-Sep day the recommendation went from 13 trucks / 21 loads / 754 OMR to 5 trucks / 14 loads / about 490-500 OMR at the same 20 s search limit (OPTIMIZER_BENCHMARK.md §8).

**When this step does not run** (out of time after a slow road matrix, a failed or lost worker, an internal error), the route search's own plans are returned with the note *"Loads were not re-checked for fewer trucks ..."*. Earlier releases then returned the search's estimated departure times as they were, so with a loading time per case set a second or third load could leave before it could be loaded. Since the stabilization release (review F04) the same loads are **re-timed exactly** in that case (a few milliseconds per truck), and the note says so. Only a plan that cannot be re-timed with its loads is kept as found, marked as breaking the loading time.

## 7a. Every returned plan is checked (the timing check)
Whatever path produced it, every option the optimizer returns is re-checked independently against the request, from its printed minutes: capacity in cases and kg, customer receiving hours, drive times between stops, unloading time, the exact turnaround before each load (reload + loading per case of that load, also after locked or dispatched loads), first departure after the shift start, depot opening and the truck's availability, return before the depot closes, the shift length, loads per truck, and no overlap with locked loads. The result travels with the option: **VERIFIED**, or **VIOLATED** with each broken rule ("T01 load 2 leaves at 08:34, but the truck needs 50 min to reload and load 40 cases: ready 08:54"). The plan screen shows it in the options table ("Timing checked"); an option that is not VERIFIED is never advertised as *"serves N more stop(s)"*.

The web checks each truck's day again before a load is locked, loaded or dispatched, from the facts the plan was made with (the truck's capacity and payload, the customer's hours, the physical kg of each order or split part). A truck whose times break a rule cannot be locked, loaded or dispatched until the day is re-planned; the plan screen shows the reasons in a red box with a Re-plan button, and its driver sheets and workbook say **TIMES NOT VERIFIED**. With the loading time per case at 0 (the default) practically every plan passes.

## 8. Timing settings (Settings → Dispatch timing)
| Setting | Default | What it does |
|---|---|---|
| First departure | 06:00 | No truck leaves before this time (NMWC's trucks actually leave 07:10-08:00). |
| Turnaround between loads | 30 min | Fixed depot time between two loads of a truck. |
| Loading minutes per case | 0 | Added to the turnaround for every case of the **next** load: at 0.04 min a 1,100-case load waits 44 min more. The route search does not know the next load's size yet and assumes 80% of a full truck; the final timetable uses the exact cases. |
| Unloading minutes per case | 0 | Added to each customer's service time for every case delivered: at 0.05 min a 1,100-case drop takes 55 min more. A split part gets its share of the customer's time (at least 5 min) plus its own cases. At most 480 min per stop. |
| Max loads per truck per day | 3 | A truck's own limit wins when it has one. |

With the per-case times at 0 nothing changes from the fixed times. NMWC's 24-Sep actual truck cycles were about 52% longer than the fixed defaults model, mostly loading and unloading of big drops; the per-case settings let the plan follow that.

## 9. Speed
| Day size | Search limit | Typical wall time (3 options) |
|---|---|---|
| ≤ 25 stops | 5 s | ~10-15 s |
| ≤ 200 stops (normal NMWC day ~80-150) | 20 s | ~30-55 s |
| ≤ 350 stops | 150 s | ~4-5 min |
| larger | 240 s | ~6-7 min |

The wall time covers the recommended search, the alternatives (half the limit, in parallel) and the load re-assignment. Days of 26-80 stops now get 20 s instead of 8 s: cheap insurance against a search stopped before it settled.

If a stop is still left out while the fleet has room, it is labelled *"Not planned: the optimizer found no truck, trip or time slot for this P... stop within its time limit. Re-plan to search again, add a truck, or raise the loads-per-truck limit."* The planner never claims such a stop is impossible unless a check proved it (receiving hours, shift, bigger than any truck). On a fleet-shortage day the unserved orders say *"Fleet capacity shortage ..."*: the trucks cannot carry everything and lower priorities are left out first, which does not prove that a particular order cannot fit; when clearly more cases are unserved than the shortage, the plan says so. The plan screen heads all three with *"Not planned by the optimizer - see reason"*.

## 10. Every order is accounted for
After every optimization the system checks that **uploaded cases = planned cases + unserved cases**, in total, per SKU and per sales order, and that each order appears exactly once. A split order may appear in several parts: then every product line must add up exactly (*planned parts + unserved parts = uploaded*). A plan that does not reconcile cannot be dispatched.
