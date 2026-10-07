# Hire suggestion: real-size local demo, re-run (7 Oct 2026)

Branch `hire-suggestion` (worktree `C:/Users/abdulr/routeiq-wt-hire`), run locally:
- **Head `7f46e3f`** (eighth review). The task text said `6b1e2ce`, but the worktree was at `7f46e3f`, clean: the sixth to eighth reviews (the fixes for the 6 Oct demo's bugs) sit on top of `6b1e2ce`. This run tests `7f46e3f`.
- web: `next dev` on :3020
- solver: :8020 (PyVRP venv `routeiq-wt-pyvrp/apps/solver/.venv-pv`, not modified), public OSRM road distances
- database: a fresh scratch DB `routeiq_hs_demo` (`prisma migrate deploy`, every migration incl. `20261006120000_hire_suggestion`)

The screenshots were taken with headless Chrome over the DevTools protocol, from small Node scripts, at 1366x900 (own profile, OS-chosen loopback port).

Afterwards every process (web, solver, Chrome) was stopped, `routeiq_hs_demo` was dropped, the minted cookies were deleted, and the worktree was left clean at `7f46e3f`.

The previous run (6 Oct, head `6b1e2ce`) is summarised at the end. Its evidence is in `evidence/run-2026-10-06-6b1e2ce/`.

## The demo company (same as 6 Oct)

- **Company:** "Ghala Water Co (hire demo)", slug `ghala-hire-demo`, made with the app's own sign-up (local only).
  - The admin came from sign-up; the dispatcher was a PLANNER added on the Users endpoint.
  - Sessions were minted locally (a copy of `.dev/mint-session.ts` with the `authTime` + `pwf` claims). The random passwords were never used or stored.
- **Depot:** MCT-GHALA at 23.57623, 58.37174, open 06:00-20:00.
- **Settings:**
  - First departure 07:00, latest return 18:00 (shift 11 h), driver break 60 min starting 12:00-14:00.
  - 3 loads per truck, turnaround 30 min, Pallet fill 100 %.
  - Driver 2.5 OMR/h, overtime 4 OMR/h after 9 h, fuel 0.26 OMR/l.
  - **Daily driver day rate 10 OMR** (the default; checked on Settings).
- **Fleet (too small on purpose):** three 10-ton trucks R1-5187, R2-4954 and R3-9413.
  - Each has 12 bays and payload 0 (no weight limit), 35 OMR/day, 0.10 OMR/km, 3.5 km/l and 3 OMR per load.
  - Their regular drivers are Ahmed Said, Rashid Ali and Yousuf Khalfan.
- **Trucks to hire,** entered through the Trucks page form as the company admin:
  - "10-ton": 12 bays, payload 0, 50 OMR/day, max 3.
  - "3-ton": 6 bays, payload 0, 30 OMR/day, max 2.
  - The km charge was left empty (fuel included).
- **Data** (the real Muscat day from `.dev/realdata`, not changed), loaded through the normal imports and uploads:
  - `products.csv`: 46 SKUs with cases per pallet; JA0.5L = 96 (checked in the DB).
  - `customers.csv`: 80 customers with their pins. The demo copy mixes the priorities as on 6 Oct: **6 x P1, 20 x P2, 38 x P3, 10 x P4, 6 x P5** (checked in the DB).
  - `orders-2026-09-26.csv`: 373 lines, 100 sales orders, 80 customer-orders, 12,482 cases.
    - Re-dated to **Sun 11 Oct 2026** (4 days ahead), uploaded and confirmed (not late).
  - Other days, from the same file (as on 6 Oct):
    - **12 Oct:** the whole day again.
    - **13 Oct:** 19 P1/P2 customers plus all 16 P4/P5 customers (35 orders, 9,694 cases).
    - **14 Oct:** every 3rd customer (27 orders, 4,868 cases).

## The exact box text

**11 Oct, plan v1** (the 12 Oct text is word for word the same):

> Hire suggestion
>
> 25 orders (2,123 cases, 23.5 pallets) cannot be delivered with your fleet. To deliver them, hire 1 x 10-ton (12 bays): extra about 50 OMR. Still left out: none. But this check leaves out 1 order (3 cases, 0.0 pallets) your current plan delivers: Use this plan re-plans the day with the hired trucks instead.
>
> Plus about 19 OMR running costs on the hired trucks: 1 driver at the day rate of 10 OMR, loading about 9 OMR. Fuel is included in the hire.
>
> Also left out: 14 orders, all P4/P5 - renting is not suggested for them; this plan still delivers 2 of them with the hired trucks.
>
> [Use this plan] [Check hire options]

There is no "With one truck fewer" line.

**11 Oct, plan v2** (after Use this plan):

> Left out: 10 orders, all P4/P5 - renting is not suggested for them.

**13 Oct:**

> Left out: 4 orders, all P4/P5 - renting is not suggested for them.

**14 Oct:** no box.

**Use this plan confirm** (11 Oct):

> Hire 1 x 10-ton for 11 Oct and use this plan?
>
> The trucks are added for 11 Oct only (codes HIRE-...; enter each one's real plate with Plate on its load). Each one is rented for the whole day with one driver: + Add daily driver on one of its loads puts that driver on its other loads still to plan too, and makes them its default driver. A new plan version is made with them; locked and dispatched loads stay exactly as they are. If the day changed since this was computed, RouteIQ re-plans with the hired trucks instead.
>
> The check's plan leaves out 1 order(s) your current plan delivers, so RouteIQ re-plans the day with the hired trucks instead of taking it as it is.

Toast: "The hired trucks HIRE-10T-1110-1 were added for 11 Oct; re-planning the day with them (Quick)."

## Checks (a)-(i)

| # | Check | Result | Evidence |
|---|---|---|---|
| a | The suggestion is the cheapest set that delivers every P1-P3 order | **PASS** | The box says 1 x 10-ton (50 OMR). The stored what-if: 5 units offered; the search used 2 x 10-ton; the reduction (1 solve) kept 1, `complete: true`. The stored request was replayed on the same solver with fewer or cheaper rentals: see the table below. Cheaper sets are {} (0) and {1 x 3-ton} (30); both leave P1-P3 orders out. 2 x 3-ton costs 60, more than 50. |
| b | The one-truck-fewer line is exact or absent | **PASS (absent)** | `hire_check.one_fewer = null`; the box has no such line. With a one-truck set, one fewer is the fleet alone, which the headline already describes. |
| c | Use this plan: new version with the hired truck, every P1-P3 order, own trucks first | **PASS** | Plan v2 (REOPTIMIZE, Quick; the re-plan path, because the check's plan left out a 3-case P4 order that v1 delivers). 4 trucks, 12 loads, 70/80 orders, 11,436/12,482 cases, 132.6 pallets. **P1 6/6, P2 20/20, P3 38/38**, P4 6/10, P5 0/6. All three own trucks run 3 loads each (the maximum); only one truck is hired (HIRE-10T-1110-1, 3 loads, "hired · 1 day"). Every return is by 17:58, timing VERIFIED, no hard-window miss. The dropped P4 order (CUST-D, 3 cases) is delivered in v2. |
| d | + Add daily driver on the hired truck fills all its loads | **PASS** | The dialog says "...the driver also goes on Loads 2 and 3 (its other loads still to plan) and becomes its default driver", button "Add and put on Loads 1, 2 and 3". Toast: "21458AR Loads 1, 2 and 3: daily driver Khalid Juma". All three loads show "Khalid Juma (daily)" (L1 "picked by hand", L2/L3 with Keep). The truck's default driver is Khalid Juma. Audit: LOAD_DRIVER_SET x 3 (2 with `via: whole rental day`) and HIRED_TRUCK_CHANGED (`via: daily driver quick add`). |
| e | Fuel KPI: own trucks' fuel with a fuel-included note | **PASS** | v2 shows "FUEL (L · OMR) 168.5 · 43.8 - rented trucks: fuel included". 168.5 l is the sum of the 9 own-truck loads (23.2+12.3+25.1+15.9+9.4+21.1+20.4+19.3+21.8); x 0.26 = 43.8. The hired loads show fuel "incl.". |
| f | Trucks page "by bays" and readable dates | **PASS** | 21458AR: "hired", "1 day: 11 Oct", "Hired 10-ton for 11 Oct (hire suggestion)", Capacity (cs) "by bays", 12 bays, OMR 50.00, OMR 0.00/km, default driver Khalid Juma. The confirm and toast say "11 Oct". |
| g | Next date: the hired truck is not planned | **PASS** | 12 Oct: "3 trucks (36 bays per load round)"; plan v1 has only R1-5187, R2-4954 and R3-9413 (3 loads each). The box again suggests 1 x 10-ton (rentals do not carry over). |
| h | A day with only P4/P5 left out: renting not suggested | **PASS** | 13 Oct: 31/35; P1 5/5, P2 14/14, P4 10/10, P5 2/6. The box only says "Left out: 4 orders, all P4/P5 - renting is not suggested for them." There is no button, and no HireSuggestion row was made. The 4 unserved orders are P5 (459 cases). |
| i | A day the fleet can carry: no box | **PASS** | 14 Oct: 27/27 on 2 trucks and 5 loads, "Every order is planned". No box and no HireSuggestion row. |

### The minimality replays (11 Oct)

The stored what-if request was replayed on the solver at :8020 with only the listed rentals offered (`evidence/whatif-check.mjs`). Own trucks were unchanged. Each run was a 20 s Quick search, and timing was VERIFIED/EXACT in all three.

| Rentals offered | Cost | P1-P3 orders still out | All unserved |
|---|---|---|---|
| none (own trucks only) | 0 | **18** (2,803 cases, 31.2 pallets) | 34 |
| 1 x 3-ton | 30 | **5** (730 cases, 7.4 pallets) | 16 |
| 1 x 10-ton (the suggestion) | 50 | **0** | 13 (all P4/P5) |

A 3-ton can carry at most 6 bays x 3 loads = 18 pallets a day, against the 23.5 pallets left out.

### The box's numbers against the plan

| Number in the box | Checked against | Result |
|---|---|---|
| 25 orders, 2,123 cases, 23.5 pallets | v1 P3 13/38 (25 P3 unserved rows); recomputed from the stored stop ids: 2,123 cases, 23.472 pallet units | OK (same as 6 Oct) |
| 1 x 10-ton, extra about 50 OMR | v2 uses one HIRE-10T, 12 bays, 3 loads; fixed cost 50 | OK |
| about 19 OMR running costs: 1 driver at 10 OMR, loading about 9 OMR | v2 hired loads cost 63 + 3 + 3 = 50 hire + 10 day rate + 3 x 3 loading | OK |
| Fuel is included in the hire | v2 hired loads: fuel "incl.", no km cost; the truck has 0.00 OMR/km and no km/l | OK |
| Still left out: none | what-if: 0 P1-P3 unserved; v2: P1-P3 64/64 | OK |
| 1 order (3 cases, 0.0 pallets) your current plan delivers | `summary.dropped`: CUST-D, **P4**, 3 cases, 23 pallet units | OK, but see issue 1 |
| 14 orders all P4/P5; "this plan still delivers 2 of them" | v1: P4 8 out + P5 6 out = 14; what-if serves 2 of them | OK for the check's plan; the applied v2 (a re-plan) delivers 4 of them |
| Day cost | v1 334.5 OMR becomes v2 407.0 OMR (hired truck 69 + own trucks 338.0) | consistent |

## Shots (`shots/`, all replaced)

| Shot | What it shows |
|---|---|
| 01a-plan-v1-kpis-orders-left-out | 11 Oct plan v1 (Quick): 41/80, 9,185/12,482 cases, 3 trucks · 9 loads, 106.9 pallets · 99 %, 334.5 OMR. P1 6/6, P2 20/20, P3 13/38, P4 2/10, P5 0/6. The Hire suggestion box (1 x 10-ton) sits above the KPIs. |
| 01b-plan-v1-unserved-orders | Unserved orders (39): "Fleet capacity shortage: 143.9 pallets requested vs 108.0 pallets...". |
| 02-hire-suggestion-box / 02b (close-up) | The box after the automatic check (about 57 s, the dispatcher's plan untouched): **Use this plan** and **Check hire options**. |
| 03a-trucks-page-trucks-to-hire | Trucks page (admin): 3 own trucks and the Trucks to hire card (10-ton 12 bays 50/day max 3; 3-ton 6 bays 30/day max 2; km charge none). |
| 03b-settings-daily-driver-day-rate | Settings, Daily dispatch costs: Daily driver day rate 10 OMR, with its hint. |
| 03c-settings-pallet-fill | Settings, timing: Pallet fill 100 %, max 3 loads per truck. |
| 04a-plan-v2-hired-trucks-all-p1-p3-served | Plan v2 (REOPTIMIZE): 70/80, 4 trucks · 12 loads, **P1-P3 100 %**, Fuel "168.5 · 43.8 rented trucks: fuel included", 407.0 OMR. The box says only "Left out: 10 orders, all P4/P5 - renting is not suggested for them." |
| 04b-plan-v2-loads-hire-trucks | Loads: HIRE-10T-1110-1 L1-L3 "hired · 1 day", Plate, No driver, fuel "incl.", cost 63.0 / 3.0 / 3.0. Below them, the own trucks' 9 loads. |
| 05a-plate-set-on-hired-truck | Plate set to 21458AR. Toast "HIRE-10T-1110-1 is now 21458AR. Print the driver sheets again if they were printed." |
| 05b-add-daily-driver-dialog | + Add daily driver on 21458AR L1: the dialog names Loads 2 and 3 and the default driver; button "Add and put on Loads 1, 2 and 3". |
| 05c-plate-and-daily-driver-on-hired-truck | Toast "21458AR Loads 1, 2 and 3: daily driver Khalid Juma"; all three loads have Khalid Juma (daily). |
| 06-driver-sheet-pdf-hired-truck | Driver sheet PDF: "Truck 21458AR — Trip 1 of 3", HIRED TRUCK, driver Khalid Juma +968 9000 0099, 4 stops, 816 cases, 11.8/12 pallets. |
| 07a-next-day-12-oct-fleet-3-trucks | 12 Oct: "3 trucks (36 bays per load round)". |
| 07b-next-day-12-oct-only-own-trucks-planned | 12 Oct plan v1: only the own trucks are planned. |
| 07c-trucks-page-hired-trucks-one-day-only | Trucks page: 21458AR "hired", "1 day: 11 Oct", "by bays", default driver Khalid Juma. |
| 08a-2026-10-13-plan / 08b-...-unserved | 13 Oct: the P4/P5-only box; the 4 P5 orders left out. |
| 09a-2026-10-14-plan / 09b-...-unserved | 14 Oct: 27/27, no box, "Every order is planned". |

## Bugs and issues found (none blocking)

1. **The "dropped" sentence reads "1 order (3 cases, 0.0 pallets)" and does not say that it is a P4 order (low, wording).**
   - `palletText(23)` rounds 0.023 pallets to "0.0" (`lib/dispatch/pallets.ts`, used by `leftOutText` in `lib/dispatch/hire.ts`, around line 729).
   - The order is CUST-D, P4. A dispatcher reading "your current plan delivers" next to an order count, with no priority given, may think a P1-P3 order is at stake.
   - Suggested wording: "(3 cases, under 0.1 pallets; P4)". The confirm says "1 order(s)" (`hireUseConfirmText`, line 171).
2. **One P4 order of 3 cases sends Use this plan down the re-plan path (low, design question).**
   - The check's plan delivered every P1-P3 order and passed every check, but it left out that 3-case P4 order. RouteIQ therefore threw the checked plan away and ran a fresh Quick search with the hired truck.
   - Here the re-plan was better (P1-P3 64/64, P4 6/10, the 3-case order delivered). Nothing guarantees that, though: a fresh search could leave a P1-P3 order out that the checked plan delivered.
   - Under the owner's rule (P4/P5 never justify a truck; they ride along), a P4/P5-only difference could take the checked plan instead, or say so.
   - Also, the box's "this plan still delivers 2 of them" describes the check's plan, not the plan actually applied (v2 delivered 4 of the 14).
3. **Observation, not a hire defect:** in v2, own truck R1-5187 L2 carries 3.0 of 12 pallets (250 cases, 1 stop, 11:20-12:24). Meanwhile 10 P4/P5 orders (1,046 cases) stay out with "could not be placed by the optimizer within its time limit". This is a Quick search; the timing is VERIFIED.

The 6 Oct bugs, re-checked:
- Bug 1 (2 x 10-ton where 1 suffices): **fixed**, 1 x 10-ton, proven cheapest.
- Bug 2 (one-truck-fewer line wrong): **fixed**, the line is computed from a solve or left out.
- Bug 3 (Fuel KPI blank): **fixed**.
- Bug 4 (daily driver on one load only): **fixed**.
- Bug 5 (Capacity "0", ISO dates): **fixed**.

Audit rows seen:
- HireOption CREATE x 2 (admin).
- HIRE_CHECK_STARTED / HIRE_CHECK_FINISHED (PLANNER, AFTER_PLAN, `reduction: {used 1, first 2, solves 1, complete true}`), for 11 and 12 Oct.
- HIRED_TRUCKS_ADDED (HIRE-10T-1110-1).
- HIRE_SUGGESTION_USED (`how: REPLAN`, why "its plan leaves out orders your plan in use delivers", hireCost 50).
- HIRED_TRUCK_CHANGED (plate 21458AR; then `via: daily driver quick add`, the default driver).
- CASUAL_DRIVER_ADDED (phone "***099").
- LOAD_DRIVER_SET x 3 (2 `via: whole rental day`).
- DRIVER_LINK_ISSUED.

There were no errors in the web or solver logs, and no browser console errors.

Not exercised in this demo: dispatching (rule 20 refusal), frozen/locked loads, Bring forward, Start fresh, tenant isolation. The branch's tests cover them.

## Evidence (`evidence/`)

- `sugg-cmux7lphh01b52faa9vlfnn8x.json`: 11 Oct suggestion (basis, summary, what-if request and answer).
- `...-check-own-only.json`, `...-check-HIRE-3T-1.json`, `...-check-HIRE-10T-1.json`: the three replays.
- `sugg-cmux7xikp030v2faayt1qa2hc.json`: 12 Oct suggestion (same result).
- `whatif-check.mjs`: replays a stored request with only the given rentals (reads the solver token from the solver's `.env`, prints nothing secret).

## The previous run (6 Oct 2026, head 6b1e2ce), in short

On the same data, the box suggested 2 x 10-ton (100 OMR), where 1 x 10-ton delivered every P1-P3 order. The "With one truck fewer" line said "up to 25 orders stay undelivered"; the real number was 0. Plans with a hired truck showed a blank Fuel KPI. A daily driver went on one load only. The Trucks page showed "Capacity (cs) 0" and ISO dates. All of these are fixed in `7f46e3f` (see the checks above).


---

# Final head 7c3115a (7 Oct 2026, 06:30-07:20)

Branch `hire-suggestion`, worktree `C:/Users/abdulr/routeiq-wt-hire`, **head `7c3115a`** (twelfth review), clean before and after. Since `7f46e3f` the reduction changed in four review rounds (ninth to twelfth: `fa3f439`, `2d8be08`, `778306f`, `7c3115a`).

- web `next dev` on :3020, solver on :8020 (the worktree's `apps/solver`, PyVRP venv of `routeiq-wt-pyvrp`, public OSRM).
- A fresh scratch DB `routeiq_hs_demo2` (`prisma migrate deploy`, 29 migrations incl. `20261006120000_hire_suggestion`); dropped afterwards.
- The same company, settings, fleet, trucks to hire and data as above, made the same way (sign-up, Settings, the Trucks page form, the imports, the order uploads).
  - Checked in the DB: JA0.5L = 96 cases per pallet; priorities 6 / 20 / 38 / 10 / 6; three 10-ton trucks, 12 bays, payload 0; Pallet fill 100 %; day rate 10 OMR; max 3 loads.
- Orders, all confirmed and not late:
  - 11 Oct: 80 orders, 12,482 cases; 12 Oct: the same.
  - 13 Oct: 35 orders, 9,694 cases; 14 Oct: 27 orders, 4,868 cases.
- Shots: headless Chrome over DevTools, 1366x900, in `shots-final/` (each looked at once). Evidence: `evidence-final/`.
- One extra step this time, for check (c): two own loads were **locked** (R1-5187 L1, R3-9413 L1) on 11 Oct and on 12 Oct.
- Afterwards: web, solver and Chrome were stopped (ports 3020/8020 free), `routeiq_hs_demo2` was dropped, and the minted cookies and the Chrome profile were deleted.

## The exact box text

**11 Oct, plan v1, the automatic check after OPTIMIZE (Quick)**, word for word the same on **12 Oct plan v1**:

> Hire suggestion
>
> 25 orders (2,123 cases, 23.5 pallets) cannot be delivered with your fleet. To deliver them, hire 1 x 10-ton (12 bays): extra about 50 OMR. Still left out: none. But this check leaves out 1 P4 order (3 cases) your current plan delivers: Use this plan re-plans the day with the hired trucks instead.
>
> Plus about 19 OMR running costs on the hired trucks: 1 driver at the day rate of 10 OMR, loading about 9 OMR. Fuel is included in the hire.
>
> Also left out: 14 orders, all P4/P5 - renting is not suggested for them; this plan still delivers 2 of them with the hired trucks.
>
> [Use this plan] [Check hire options]

On 7f46e3f the text said "1 order (3 cases, 0.0 pallets)". It now says "1 P4 order (3 cases)".

**11 Oct, plan v1 after locking R1-5187 L1 and R3-9413 L1, then Check hire options.** It was run twice, with the same text both times (see bug 1):

> 25 orders (2,123 cases, 23.5 pallets) cannot be delivered with your fleet. To deliver them, hire 2 x 3-ton (6 bays): extra about 60 OMR. Still left out: none.
>
> Plus about 38 OMR running costs on the hired trucks: 2 drivers at the day rate of 10 OMR, loading about 18 OMR. Fuel is included in the hire.
>
> With one truck fewer (1 x 3-ton (6 bays), extra about 30 OMR): 5 orders (679 cases, 7.8 pallets) would stay undelivered - planned without the 3-ton. 9 P4/P5 orders this plan delivers would stay out too.
>
> Also left out: 14 orders, all P4/P5 - renting is not suggested for them; this plan still delivers 13 of them with the hired trucks.

The other days:
- **11 Oct plan v2:** "Left out: 1 order, P4/P5 - renting is not suggested for it."
- **12 Oct plan v2:** "Left out: 8 orders, all P4/P5 - renting is not suggested for them."
- **13 Oct:** "Left out: 4 orders, all P4/P5 - renting is not suggested for them." (no buttons)
- **14 Oct:** no box.

**Use this plan, 11 Oct (2 x 3-ton):**
- Confirm: "Hire 2 x 3-ton for 11 Oct and use this plan? ... locked and dispatched loads stay exactly as they are. If the day changed since this was computed, RouteIQ re-plans with the hired trucks instead." There is no dropped-order paragraph.
- Toast after 3 s: "Plan version 2 uses the hired trucks HIRE-3T-1110-1, HIRE-3T-1110-2. Enter each one's plate (Plate on its load) and pick its driver before dispatch."

**Use this plan, 12 Oct (1 x 10-ton, two loads locked after the check):**
- Confirm: the same, plus "The check's plan leaves out 1 P4 order your current plan delivers, so RouteIQ re-plans the day with the hired trucks instead of taking it as it is."
- Toast: "The hired trucks HIRE-10T-1210-1 were added for 12 Oct; re-planning the day with them (Quick)."

## Checks (a)-(g)

| # | Check | Result | Evidence |
|---|---|---|---|
| a | The suggestion is the cheapest set that delivers every P1-P3 order | **PASS on the day as optimized; FAIL with two loads locked (bug 1)** | 11 Oct v1 (and 12 Oct v1): 1 x 10-ton, 50 OMR. Reduction: `first` 10T+10T (11 Oct) / 10T+3T (12 Oct), `used` 1 x 10T, 1 solve, `complete: true`. Replays below: own trucks only and 1 x 3-ton both leave P1-P3 orders out; 2 x 3-ton costs 60, more than 50. With R1-5187 L1 + R3-9413 L1 locked, the check suggested 2 x 3-ton (60 OMR; 80 with the day rates), `complete: true`. Yet 1 x 10-ton (50; 60) delivers every P1-P3 order in 4 of 4 replays. |
| b | Every number in the box matches; no "0.0 pallets"; a dropped order names its priority | **PASS** | Table below. "1 P4 order (3 cases)" is CUST-D: P4, 3 cases, 23 pallet units (under 50 units, so no pallets are given); `dropped.byPriority {"4":1}`. The confirm also says "1 P4 order". |
| c | Use this plan: new version, every P1-P3 order, frozen loads unchanged | **PASS (both paths)** | **11 Oct v2** (`PLAN_APPLIED`, 2 x 3-ton, the check made with the locks): 79/80, **P1 6/6, P2 20/20, P3 38/38**, P4 10/10, P5 5/6; "2 locked/dispatched loads preserved". R1-5187 L1 and R3-9413 L1 are identical in v1 and v2: status, 07:00-10:38 / 07:00-11:03, 994 / 1,086 cases, 11.47 / 11.95 pallets, km, cost, and every stop, order and ETA (`v1-loads.txt` vs `v2-loads.txt`). **12 Oct v2** (`REPLAN`, why: the day changed + the dropped P4 order; 1 x 10-ton): 72/80, **P1-P3 64/64**, P4 6/10, P5 2/6; the two loads locked after the check are identical in v1 and v2. Both days the audit has `PLAN_VERSION_CREATED frozenLoadsCarried: 2`. |
| d | Daily driver on all loads of the hired truck | **PASS** | HIRE-3T-1110-1 -> Plate 21458AR. + Add daily driver on L1: the dialog says "...the driver also goes on Loads 2 and 3 (its other loads still to plan) and becomes its default driver", button "Add and put on Loads 1, 2 and 3". Toast: "21458AR Loads 1, 2 and 3: daily driver Khalid Juma". DB: L1-L3 driver Khalid Juma (DAY-261011-1); the truck's default driver is Khalid Juma. Audit: CASUAL_DRIVER_ADDED, LOAD_DRIVER_SET x 3 (2 `via: whole rental day`), HIRED_TRUCK_CHANGED `via: daily driver quick add`. Driver sheet PDF: "Truck 21458AR - Trip 1 of 3", HIRED TRUCK, Khalid Juma +968 9000 0099, 5 stops, 528 cases, 6.0/6 pallets. |
| e | Next date: the hired truck is not planned | **PASS** | 12 Oct: "3 trucks (36 bays per load round)". v1 has only R1-5187, R2-4954 and R3-9413; its what-if request has those 3 own trucks and all 5 rentable units. Trucks page: 21458AR and HIRE-3T-1110-2 "1 day: 11 Oct", "by bays". |
| f | A P4/P5-only day: renting not suggested | **PASS** | 13 Oct: 31/35; P1 5/5, P2 14/14, P4 10/10, P5 2/6 (4 P5 out, 459 cases). Box: "Left out: 4 orders, all P4/P5 - renting is not suggested for them." No button, no HireSuggestion row. |
| g | A day the fleet suffices: no box | **PASS** | 14 Oct: 27/27, 2 trucks · 5 loads, "Every order is planned"; no box, no HireSuggestion row. |

### The minimality replays

The stored what-if request was replayed on :8020 with only the listed rentals (`whatif-check.mjs`; Quick, timing VERIFIED/EXACT in every run).

11 Oct as optimized (suggestion `cmuxi0qzx02li4956iapifsek`). The numbers are the same as on 7f46e3f:

| Rentals offered | Hire OMR | P1-P3 orders still out | All unserved |
|---|---|---|---|
| none | 0 | **18** (2,803 cases, 31.2 pallets) | 34 |
| 1 x 3-ton | 30 | **5** (730 cases, 7.4 pallets) | 16 |
| 1 x 10-ton (the suggestion) | 50 | **0** | 13 (all P4/P5) |

2 x 3-ton costs 60 (80 with the day rates), more than 1 x 10-ton.

11 Oct with two loads locked (suggestions `cmuxi7d1r02md4956iiq31qnq` and `cmuxiw8lp02mp4956iciub6ei`, both 2 x 3-ton):

| Rentals offered | Hire OMR (with day rates) | P1-P3 orders still out | All unserved |
|---|---|---|---|
| 1 x 10-ton (4 runs) | 50 (60) | **0** in every run | 10 (all P4/P5); op cost 284.25 in every run |
| 2 x 3-ton (the suggestion) | 60 (80) | 0 | 1 |

### The box's numbers against the stored data and the plan (11 Oct v1)

| Number in the box | Checked against | Result |
|---|---|---|
| 25 orders, 2,123 cases, 23.5 pallets | `summary.leftOut` 25 / 2,123 / 23,472 units; recomputed from the 25 stop ids (all P3); v1 P3 13/38 | OK |
| 1 x 10-ton (12 bays), extra about 50 OMR | `hires` 1 x 10-ton at 50/day, `hireCost` 50; one rented truck, 3 loads | OK |
| Still left out: none | `stillLeft` 0; replay 0 | OK |
| 1 P4 order (3 cases) | `dropped`: CUST-D, P4, 3 cases, 23 units; on v1 R2-4954 L1 | OK |
| about 19 OMR: 1 driver at 10 OMR, loading about 9 OMR | hired loads 63 + 3 + 3 = 50 hire + 10 + 3 x 3 | OK |
| Fuel is included | hired loads: fuel 0, km cost 0 | OK |
| 14 orders, all P4/P5; still delivers 2 | v1: P4 8 out + P5 6 out; `low.delivered` 2 | OK |

The locked-day box also matches its own data:
- 60 = 2 x 30; 38 = 2 x 10 + 6 loads x 3.
- One truck fewer = `alternative`: 5 orders / 679 cases / 7,806 units, and 9 P4/P5 orders.
- "delivers 13 of them" = `low.delivered` 13; v2 (the plan applied as checked) delivers exactly those 13.
- v2 day cost 423.0 = own trucks 324.96 + hired 98.00 (2 x 30 + 2 x 10 + 6 x 3).
- Fuel KPI "170 · 44.2 - rented trucks: fuel included" = the 9 own loads (170.0 l, 44.24 OMR).

## Bugs and observations

1. **The reduction can rule out the cheapest set on one unlucky solve and still say `complete` (medium).**
   - **Day:** 11 Oct v1 with R1-5187 L1 and R3-9413 L1 locked.
   - **What happened:** Check hire options, run twice, suggested **2 x 3-ton, 60 OMR (80 with 2 day rates)**, with `reduction {first 2, used 2, solves 3, complete true}` and the one-truck-fewer line. Use this plan then rented two 3-tons, so the day needs a second casual driver.
   - **The cheaper set works:** 1 x 10-ton (50 OMR, 60 with its driver) delivers every P1-P3 order with VERIFIED/EXACT timing in 4 of 4 replays with only that truck, all with identical results.
   - **Replaying the whole stored request:**

     | Where | Runs -> result |
     |---|---|
     | plain solver | 1 of 1 -> 2 x 3-ton (3 of 3 counting the two app checks) |
     | in-process | 2 of 2 -> 1 x 10-ton |
     | instrumented solver, alone | 3 of 3 -> 1 x 10-ton |
     | instrumented solver, with a second solve running alongside | 1 of 1 -> 2 x 3-ton |

     The instrumented solver is a copy (`diag_server.py`) with `_hire_trial` wrapped to log; nothing else is changed.
   - **The trace of the failing run** (`solver-diag.log`, 07:01:13):
     - The trial of {1 x 10-ton} returned OPTIMIZED, VERIFIED/EXACT, but with **1 P3 order out: CUST-E (155 cases, 1.95 pallets), SOLVER_DROPPED_LOW_PRIORITY**, and 9 P4/P5 out (10 unserved).
     - Its post-solve (break-aware repack, CP-SAT stopped at a gap of about 90 %) gave "262.4 -> 279.2 OMR, +6 stops". The passing runs give "262.4 -> 284.3 OMR, +5 stops" and serve every P3.
     - So this plan serves a P4/P5 order in place of a P3 order that fits.
   - **Why the set is ruled out:** `judge` records the trial as "lost a P1-P3 stop", so the set counts as ruled out. The walk goes on to 2 x 3-ton, and `complete` stays true.
   - **Suggested fixes:**
     - Never rule out a set on a trial that leaves a P1-P3 stop out while serving P4/P5 stops in its place (a priority inversion).
     - Or first try to put the lost P1-P3 stops back in place of P4/P5 stops, as `_swap_riders` does for a give-back.
     - Or leave such a set "not proven" (`complete: false`).
     - The repack could also be held to never serve fewer higher-priority stops than its input plan.
2. **Observation: Quick under-fills a truck while P4/P5 orders stay out** (as on 7f46e3f, issue 3).
   - 12 Oct v2: R3-9413 L2 carries 3.0 of 12 pallets (250 cases, 1 stop).
   - Meanwhile 8 P4/P5 orders (990 cases, 10.4 pallets) stay out with "Fleet capacity shortage: 120.5 pallets requested vs 120.0".
   - The plan's own warning says "more than the shortage alone explains". This is not a hire defect.
3. **Cosmetic:** the 12 Oct v2 dispatch page is 6 px wider than a 1366 px window (1357 vs 1351), so a horizontal scrollbar shows in `08ba` / `08bb`. The 11 Oct v2 page fits. The element causing it was not found.

Since 7f46e3f:
- **Fixed (re-checked):** issue 1 above, the "0.0 pallets" wording and the missing priority of a dropped order.
- **Unchanged:** issue 2 above, where a P4-only difference sends Use this plan down the re-plan path. 12 Oct went REPLAN, and its re-plan kept every P1-P3 order.

There were no errors in the web or solver logs, no 500s, and no browser console errors.

## Shots (`shots-final/`)

| Shot | What it shows |
|---|---|
| 01a / 01b | 11 Oct v1: 41/80, 3 · 9, 334.5 OMR, P3 13/38, the box above the KPIs; Unserved orders (39). |
| 02 / 02b | The box (1 x 10-ton, "1 P4 order (3 cases)") in context and close up. |
| 02c | The box after the re-check with two loads locked: 2 x 3-ton (bug 1). |
| 03a / 03b / 03c | Trucks page with the Trucks to hire card (taken at the end, so it lists the hired trucks); Settings: day rate 10 OMR; Pallet fill 100 %, max 3 loads. |
| 03d | 11 Oct v1 with R1-5187 L1 and R3-9413 L1 LOCKED. |
| 04a / 04b | 11 Oct v2 (PLAN_APPLIED): 79/80, P1-P3 100 %, "2 locked/dispatched loads preserved", Fuel "170 · 44.2 rented trucks: fuel included", 423.0 OMR; the hired loads (hired · 1 day, fuel incl., 43.0 / 3.0 / 3.0). |
| 05a / 05b / 05c | Plate 21458AR; the daily-driver dialog; Khalid Juma (daily) on L1-L3. |
| 06 | Driver sheet PDF, 21458AR trip 1 of 3, HIRED TRUCK. |
| 07a / 07b / 07c | 12 Oct: 3 trucks, only the own trucks planned; Trucks page "1 day: 11 Oct". |
| 08a / 08ba / 08bb | 12 Oct v1 with two loads locked after the check; 12 Oct v2 (REPLAN, 1 x 10-ton, P1-P3 100 %); its 8 P4/P5 orders left out. |
| 09a / 09b | 13 Oct: the P4/P5-only box; 4 P5 orders out. |
| 10a / 10b | 14 Oct: 27/27, no box, "Every order is planned". |

## Evidence (`evidence-final/`)

- `sugg-cmuxi0qzx02li4956iapifsek*.json`: the 11 Oct suggestion and its three replays.
- `sugg-cmuxi7d1r02md4956iiq31qnq*.json`, `sugg-cmuxiw8lp02mp4956iciub6ei*.json`: the two locked-day suggestions (2 x 3-ton) and their replays.
- `frozen-check-10T-run1..3.json`: the 1 x 10-ton replays. `frozen-sugg*-check-*.json`: the whole-request replays.
- `sugg-cmuxj4nra0300495678ksx2k5.json`: the 12 Oct suggestion.
- `v1-loads.txt` / `v2-loads.txt` and `v1-1210-loads.txt` / `v2-1210-loads.txt`: the frozen-load comparisons (from `snap.sh`).
- `use-dialog*.json`: the confirms and toasts.
- `solver-run1.log` / `solver-run2.log`: the plain solver. `solver-diag.log`: the instrumented solver, with the DIAG trace of bug 1.
- `diag.log` / `diag2.log`: the in-process runs.
- Scripts: `whatif-check.mjs`, `diag.py`, `diag_server.py`, `snap.sh`.
