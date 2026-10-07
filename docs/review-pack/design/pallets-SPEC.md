# Truck capacity in pallets (bays) - design spec

Status: DESIGN (no code changed). Written 4 Oct 2026 against `main` daa5eae, worktree
`C:/Users/abdulr/routeiq-wt-pallets`, branch `pallet-capacity`, DB `routeiq_pl`.

Owner request (4 Oct 2026): "All cases stay in cases, but when it comes to loading they are
transformed to pallets, and in total they should be less than the truck capacity. E.g. JA 0.5 is
84 cases per pallet." Owner decisions: mixed pallets allowed (a trip's pallet need = the sum over its
products of cases / cases per pallet, fractions add up); a company setting **Pallet fill** (percent of
the bays the planner may use, default 95) is the safety margin; a trip fits when **pallet need <= bays
x fill AND kg <= payload**; orders, invoices, driver sheets and the warehouse stay in CASES and pallets
are shown in addition ("Pallets 11.4 / 12"; per product "3 pallets + 12 cases" on the loading
manifest).

---

## 0. Verdict on the approach

Yes, it is the right approach, with three refinements this spec builds in:

1. **Fractions, scaled to whole numbers.** The optimizer cannot add fractions exactly, so every
   pallet need is kept in **pallet units of 1/1000 pallet**, each order line rounded UP once
   (never under-counted). 84 cases of an 84-per-pallet product = 1,000 units = 1.0 pallet exactly.
2. **Weight stays.** On the real 26 Sep day with the current (estimated) case weights, a full pallet
   averages 936 kg, so a 10-ton truck is full by weight at about 10.7 pallets, before 11.4 pallets
   (12 bays x 95%). Pallets change the plan mainly where products are light or bulky - and they
   stop the overloads the old case rule allows (section 13: with kg not binding, 7 of 11 case-rule
   loads needed more than 12 bays, up to 17.5 pallets).
3. **Missing data is refused, not guessed.** A product on the day without cases per pallet, when
   the depot has trucks with bays, refuses OPTIMIZE / RE-PLAN with the list of products (like
   missing locations, but with no "optimize anyway").

Backward compatible: a truck without bays keeps the case rule exactly as today; a company with no
bays anywhere plans exactly as today (golden tests).

---

## 1. What exists today (code facts)

| Fact | Where |
|---|---|
| `Truck.palletCapacity Int?` and `Product.casesPerPallet Float?` exist since migration `20260924090000_nmwc_dispatch_mvp`; nothing reads or writes them (no form, no API, no import) | `apps/web/prisma/schema.prisma` lines 394, 596; handbook 7.1 item 7 |
| Capacity = cases + kg (0.1 kg units, no margin, audit F08) everywhere | `dispatch_models.kg_units/payload_units`, `dispatch_solver._fits_capacity`, `_solve_scenario.add_capacity("Cases"/"Kg")`, `load_repack.fits_truck`, `feasibility.check_scenario`, `pyvrp_candidate.build_model`, web `split.ts`, `lib/dispatch/feasibility.ts` |
| The route search's turnaround estimate uses 80% of `max_cases` x loading min per case | `dispatch_solver._approx_gap_s` |
| Split deliveries are cut in the WEB on real SKU lines (`splitIntoParts`, `choosePartCapacity`, `fitsCapacity`), every visit gets the full stop time + its own per-case time | `apps/web/lib/dispatch/split.ts`, `buildDispatchRequest` |
| Missing data before OPTIMIZE: `gate()` (LOCATION_REQUIRED, WEIGHT_REQUIRED with override) - the one place for optimize and re-plan | `apps/web/lib/dispatch/start-optimize.ts:126` |
| Plan facts are frozen per load (`truckSnapshotJson`), per stop (`stopSnapshotJson`), per option (`ScenarioDetails.inputs`, `PlanInputs`) | `lib/dispatch/snapshots.ts` |
| New scalar columns are copied by re-plans automatically | `lib/dispatch/prisma-copy.ts` (`copyRowData`) |
| Products have no import; customers have `/api/customers/import` and the daily master | `app/api/customers/import/route.ts` |
| `primaryUnit` (`CapacityUnit` CASES/CARTONS/PALLETS/KG) is a display label only | `lib/format.ts`, signup |

---

## 2. The rule (exact)

### 2.1 Units and rounding

- **Pallet unit** = 1/1000 pallet. Constant `PALLET_UNIT = 0.001` in `dispatch_models.py` and
  `lib/dispatch/pallets.ts`.
- **Cases per pallet** (`Product.casesPerPallet`, the ERP pallet factor) must be a **whole number
  1-10,000**. A stored non-whole or out-of-range value counts as missing (refusal, 2.4).
- **Units of an order line (or of the part of a line on a split portion)**:
  `units(cases, cpp) = ceil(cases x 1000 / cpp)` computed in integers:
  `(cases * 1000 + cpp - 1) // cpp` (Python) / `Math.floor((cases * 1000 + cpp - 1) / cpp)` (TS).
  Rounded up per line, so a line is never counted smaller than it is; the error is under 0.001
  pallet per line.
- **Units of a plan row** (an order, or an order's portion) = sum of its lines' units. **Stop** =
  sum of its rows. **Load** = sum of its stops. All integer sums: the web, the optimizer, the stored
  load and every check add up the same integers (the F08 pattern used for kg tenths).
- **Truck room** (bay truck) = `bays x palletFillPct x 10` units (exact integer: 12 x 95 x 10 =
  11,400 = 11.4 pallets; 2 x 95 x 10 = 1,900 = 1.9 pallets).

### 2.2 Fit

| Truck | A load fits when |
|---|---|
| Bay truck (`bays` set) | `load units <= bays x fill x 10` AND `kg tenths <= payload tenths` (when a payload is set). **Cases are not a limit** (`capacityCases` is ignored for planning) |
| Truck without bays | unchanged: `cases <= capacityCases` AND kg as today |

### 2.3 Display

- Pallets to one decimal: `units / 1000`, rounded half up ("11.4"); totals summed in units first.
- Per product on a manifest: `full = floor(cases / cpp)`, `loose = cases - full x cpp` ->
  "3 pallets + 12 cases" (JA0.5L at 96/pallet, 300 cases); `0 pallets + 40 cases` reads "40 cases".
- Load line: "Pallets 11.4 / 12 (limit 11.4 at 95% fill)".
- **Utilization %** of a bay truck = `max(units / (bays x 1000), kg / payload)` - against the
  physical bays, so a load at the 95% limit shows 95%, never 100%. Trucks without bays: unchanged.

Worked example (products.csv factors): a stop with JA0.5L 100 cases (96/pallet) + TN1.5L 50 cases
(39/pallet) + EFF24 30 cases (160/pallet) = 1,042 + 1,283 + 188 = 2,513 units = 2.5 pallets.

### 2.4 Refusal: missing cases per pallet

When the depot has at least one **active truck with bays** and an **open line** of the day (not on
a frozen load) has a product without a valid cases per pallet, OPTIMIZE and RE-PLAN answer
**409 `PALLET_FACTOR_REQUIRED`**, no override:

> "Cannot plan by pallets: 3 product(s) on this day's orders have no cases per pallet: TN1.5L
> (120 cases), SS6L (40 cases), EFF24-GV (12 cases). Enter the cases per pallet under Products, then
> optimize again." (+ "Only company admins can edit products: ask one." for other roles)

Body: `{ code, error, missingPalletFactors: [{ productId, productCode, productName, lines, cases }],
productsPath: '/t/<slug>/products' }`. The screen shows it as a red message with an **Open Products**
link (no confirm dialog). Frozen loads are never re-checked or changed by it. Checked in `gate()`
before LOCATION_REQUIRED's question (a refusal first, so the dispatcher is not asked a question
and then refused).

---

## 3. Data model and migration

Migration `apps/web/prisma/migrations/20261006090000_pallet_capacity/migration.sql` (additive only):

```sql
-- Truck capacity in pallets (owner decision 4 Oct 2026).
ALTER TABLE "TenantConfig" ADD COLUMN "palletFillPct" INTEGER NOT NULL DEFAULT 95;
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_palletFillPct_range" CHECK ("palletFillPct" BETWEEN 50 AND 100);
-- The pallet need a load / a plan row was planned with, in 1/1000 pallet. NULL = planned without
-- pallets (a truck without bays, or planned before this release).
ALTER TABLE "PlanLoad" ADD COLUMN "palletUnits" INTEGER;
ALTER TABLE "RouteAssignment" ADD COLUMN "palletUnits" INTEGER;
```

Prisma:

- `Truck`: `bays Int? @map("palletCapacity")` - the existing, never-used column under a clear name
  (no DDL; `prisma migrate diff` shows no drift). Doc comment: pallet positions; null = the truck is
  planned by cases (`capacityCases`).
- `Product.casesPerPallet Float?` stays as is (whole numbers enforced by the app; no CHECK, so
  existing rows can never fail the migration).
- `TenantConfig.palletFillPct Int @default(95)`, `PlanLoad.palletUnits Int?`,
  `RouteAssignment.palletUnits Int?`.

JSON shapes (no DDL):

- `PortionLine` (`portionLinesJson`): + `casesPerPallet?: number` (the factor the part was cut with).
- `TruckFacts` / `TruckSnapshot` (`truckSnapshotJson`, `PlanInputs.trucks`): + `bays: number | null`,
  `palletFillPct: number | null`, `palletRoomUnits: number | null` (bays x fill x 10 as planned).
- `PlanInputs`: + `palletFactors?: Record<productCode, number>` (the factors the option was planned
  with; manifests use them, so a factor changed later never changes a planned load's split).
- `PlanScope` (`ScenarioDetails.scope`): + `palletUnits?: Record<orderRef, number>` (units of every
  optimizer order ref: an order id or a portion id), so `applyScenario` stores row units exactly as sent.
- `PlanRules`: + `pallets?: { fillPct: number; unit: 0.001 }`, set ONLY from the solver's echo
  (2 lines below), like `windowRule` / `break`.

Handbook guards: the migration count in sections 1 and 2 (27 migration folders on disk -> 28).

---

## 4. Optimizer contract (packages/shared-types/src/dispatch.ts + apps/solver/dispatch_models.py)

All additive and optional; an older web sends none of them and is planned exactly as before.

| Field | Type / bounds | Meaning |
|---|---|---|
| `DispatchTruck.bays` | `int | None`, 1-40 | pallet positions; None = case truck |
| `DispatchStop.demand_pallet_units` | `int | None`, >= 0 | the stop's pallet need in 1/1000 pallet |
| `DispatchConfig.pallet_fill_pct` | int 50-100, default 95 | the Pallet fill setting |
| `FrozenTrip.pallet_units` | `int | None` | for the record only (not used by the rules) |
| `PlannedStop.pallet_units` | `int | None` | the stop's units (None when the request sent none) |
| `PlannedLoad.pallet_units`, `pallet_room_units` | `int | None` | the load's units and its truck's room (bays x fill x 10); None on a case truck |
| `DispatchScenario.pallet_unit` | `float | None` (= 0.001) | echo: this plan checked bay trucks by pallets |
| `DispatchScenario.pallet_fill_pct` | `int | None` | echo of the fill used; None = no bay truck in the request |
| `DispatchScenario.total_pallet_units` | `int | None` | sum over loads |
| `FeasibilityCode` | + `"CAPACITY_PALLETS"` | |
| `UnservedReason` | unchanged (`EXCEEDS_ANY_TRUCK_CAPACITY` etc.; the words name pallets) | |

Validation (`DispatchRequest` model validator): when any truck has `bays`, every stop must have
`demand_pallet_units` (else 422 "stop X has no pallet need; every stop needs demand_pallet_units when a
truck has bays"); the web never sends such a request (it refuses first, 2.4).

`planner-bounds.json`: `config.palletFillPct { solver: "pallet_fill_pct", min: 50, max: 100, int: true }`,
`truck.bays { solver: "bays", min: 1, max: 40, int: true }` (checked by
`apps/solver/tests/test_dispatch.py` and `apps/web/tests/lib/tenant-settings.spec.ts`).

**Deploy order: solver first, then web** (the usual). With an older solver the web sees no
`pallet_unit` echo: it stores `palletUnits` NULL, the loads are not marked as planned by pallets,
and the plan carries the warning "The optimizer did not plan by pallets (it is being updated):
loads are planned by cases. Re-plan in a few minutes." The web never claims pallets it was not
planned with.

---

## 5. Solver changes per module

### 5.1 `dispatch_models.py`
- Fields of section 4; `PALLET_UNIT = 0.001`; helpers `pallet_room_units(bays, fill_pct) -> bays *
  fill_pct * 10`, `pallet_text(units) -> "11.4"` (half up).
- Module docstring: the pallet rule next to the kg rule (F08 block).

### 5.2 `dispatch_solver.py`
- **`TruckDay`**: + `bays: int | None`, `max_pallet_units: int` (0 = not by pallets), property
  `by_pallets`. For a bay truck `max_cases` becomes `CASES_FREE` = (sum of the request's
  `demand_cases`) + 1, so every existing case comparison holds without special cases; every message
  that prints `max_cases` prints pallets instead for a bay truck (below). `_truck_days(req)` fills them.
- **Space need**: helper `need(stop, td) = stop.demand_pallet_units if td.by_pallets else
  stop.demand_cases` and `room(td) = td.max_pallet_units if td.by_pallets else td.max_cases`.
- **`_fits_capacity`**: `need <= room` AND kg as today.
- **`_prefilter`** (EXCEEDS_ANY_TRUCK_CAPACITY): the detail names the measure of the largest
  trucks: "Order is larger than any available truck (16.3 pallets vs largest truck 11.4 pallets:
  12 bays at 95% fill; 15,355 kg vs largest payload 10,000 kg). Split it or use a bigger truck."
  Mixed fleet: both measures ("... 1,250 cases vs largest truck without bays 570 cases").
- **Routing model `_solve_scenario`**: `add_capacity("Cases", ...)` only when at least one usable
  truck has no bays, caps = `capacity_cases` for case trucks and `CASES_FREE` for bay trucks;
  `add_capacity("Pallets", [0] + units + [0]*reloads, caps)` only when at least one usable truck
  has bays, caps = `max_pallet_units` for bay trucks and `sum(units) + 1` for case trucks. The reload
  nodes reset both dimensions as today (slack pattern). An all-bay fleet therefore keeps two
  dimensions (Pallets, Kg) as today (Cases, Kg): no extra search cost.
- **`_approx_gap_s`** (loading time per case, search estimate): for a bay truck the "full truck" in
  cases = `round(max_pallet_units / 1000 x day_cases_per_pallet)`, `day_cases_per_pallet =
  sum(demand_cases) x 1000 / sum(demand_pallet_units)` over the request's stops (stored on the
  TruckDay as `est_full_cases`). Only matters when loading min per case > 0; the exact timing (LP)
  keeps using the exact cases of each load. The second search uses the same function.
- **`_build_scenario`**: per load `pallet_units` (sum of stops), `pallet_room_units`; per stop
  `pallet_units`; utilization (2.3); `total_pallet_units`; echoes `pallet_unit`, `pallet_fill_pct`.
- **Fleet shortage** (`_fleet_capacity`, `_fleet_shortage`, `_shortage_reason`): a third measure
  `short_pallets` = demand units > sum over usable trucks of `max_pallet_units x trips_left`,
  computed only when **every** usable truck has bays; `short_cases` only when **no** usable truck has
  bays (today it sums `capacity_cases` of every truck, which is meaningless for bay trucks); a mixed
  fleet claims no space shortage (sound: never a false "shortage"), only kg as today. `_fleet_shortage`
  returns `(short_space, short_kg)` with the space kind, used by `pyvrp_candidate` too. Words:
  "Fleet capacity shortage: 160.2 pallets requested vs 136.8 pallets across all available loads
  (12 bays at 95% fill per 10-ton load) ...", and "by weight" / "weight is the tighter limit today"
  as now.
- **Room reasons** (`_rooms`, `_fits_room_left`, `_no_packing_fits`, `_no_room_reason`): a room is
  `(kind, space, kg)`; a stop's need is compared in the room's kind. `_no_packing_fits` proves in
  each kind only over the trucks of that kind and only when the whole usable fleet is of that kind
  (the kg proof as today). Text: "Not planned: no load or free trip has room for its 2.5 pallets
  (the most room left is 1.9 pallets) ...".
- **"More than the shortage explains"** warning: in pallets when the shortage is in pallets.
- **`_assert_reconciled`**: unchanged (cases); plus: the sum of the loads' `pallet_units` + the
  unserved stops' units = the request's units (ReconciliationError otherwise).

### 5.3 `load_repack.py` (CP-SAT repack, LP timing, candidates)
- `Facts` + `pallet_units` (sum of `demand_pallet_units`, 0 when None).
- **`fits_truck`**: bay truck: `f.pallet_units <= td.max_pallet_units`; else `f.cases <= td.max_cases`;
  kg as today. Every repack path goes through it (`depart_range`, optional one-stop loads, the fit
  fallback's load-minus-one-stop variants, `fit_pool`), so no CP-SAT constraint is added: loads are
  fixed sets and the fit is a pairing filter.
- `_identical_trucks` key + `max_pallet_units`, `bays`.
- **LP timing (`time_truck`, `timing_ok`)**: no change - capacity is not a timing rule; the turnaround
  stays `reload + loading per case x cases` (owner question Q7 about loading per pallet).

### 5.4 `feasibility.py` (the independent check) - `CHECK_VERSION = 3`
- Per load, from the REQUEST's stops: `units = sum(demand_pallet_units)`. Bay truck:
  `CAPACITY_PALLETS` when `units > bays x fill x 10`: "R5 load 2 needs 11.6 pallets; the truck
  takes 11.4 (12 bays at 95% fill)." (`short_by_min` = pallets short, like cases/kg today). The
  `CAPACITY_CASES` check is skipped for bay trucks.
- `LOAD_TOTALS` also when the load's recorded `pallet_units` differs from its stops' sum.
- Docstring rule list: + pallets.

### 5.5 Split deliveries (web `split.ts`; the solver only sees parts)
- `PartCapacity` + `palletUnits: number | null` (room in units; null = cases measure);
  `OpenLine` + `casesPerPallet: number | null`; `FleetTruck` + `palletUnits: number | null`.
- `fitsCapacity(cases, units, kg, cap)`: by `cap.palletUnits` when set, else cases; kg as today.
- `splitIntoParts`: per line, `byPallets = floor(roomUnits x cpp / 1000)` (integers; then
  `units(take) <= roomUnits` holds), `take = min(left, room by measure, byKg, byPallets)`; a part is
  closed when its measure or kg is full. Each part's units = sum of `units(take, cpp)` of its
  allocations (a line cut over two parts may count 0.001 pallet more in total: conservative).
- `choosePartCapacity`: candidate sizes per truck in its own measure; `parts = max(ceil(units / cap
  units), ceil(kg / cap kg))` for a bay size; a truck "carries" a size only in the same measure
  (mixed fleets: conservative trips count). A customer that fits one truck is never split.
- Each visit keeps the full stop time + its own per-case unloading (owner rule, unchanged).
- Split note: "CUST-B (1,020 cases, 16.3 pallets, 15,355 kg) in 2 parts sized for R1-5187".

### 5.6 `pyvrp_candidate.py` (second search)
- Delivery vector = `[cases]` if any case truck + `[pallet units]` if any bay truck + `[kg]` if kg
  active; vehicle type capacity in the same order (`CASES_FREE` / `sum(units) + 1` for the measure a
  truck does not use). Group key + pallet room.
- `_plan_of` validation: pallets for bay trucks (INVALID_PLAN otherwise), cases for case trucks.
- `worst_case` already sums every delivery dimension; RAISED penalty mode when `_fleet_shortage`
  reports a space (pallets or cases) or kg shortage. `summary` + `pallets="on"/"off"`.
- Module docstring "hard" line: + pallet units per load.

### 5.7 Engine judge (`_post_solve`, `score`)
- No scoring change: capacity is a hard filter, never a price. Every candidate (the engine's
  searches, their repacks, PyVRP's plan and its repacks, `_retime_fallback`) is built through
  `fits_truck` / the routing dimensions and re-checked by `feasibility.check_scenario`, so a plan
  over its bays is VIOLATED and never advertised (audit F22 path unchanged).

### 5.8 `costing.py`, `main.py`, `providers.py`, legacy `solver.py` / `models.py`: no change.

---

## 6. Web: request, refusal, storage, checks (Part A)

### 6.1 New `apps/web/lib/dispatch/pallets.ts` (pure)
`PALLET_UNIT`, `palletUnits(cases, cpp)`, `validPalletFactor(v)` (whole 1-10,000),
`palletRoomUnits(bays, fillPct)`, `palletText(units)`, `fullAndLoose(cases, cpp)`,
`groupMissingPalletFactors(lines)`, `describeMissingPalletFactors(list, max = 6)` (pattern of
`weights.ts` `groupUnknownWeights` / `describeUnknownWeights`).

### 6.2 `buildDispatchRequest` (`lib/dispatch/plan-service.ts`)
- Read `casesPerPallet` with each line's product (`ORDER_INCLUDE` select) and `bays` per truck.
- `byPallets = trucks.some(t => t.bays)`. When true: every open line gets `casesPerPallet`; lines whose
  product has no valid factor go to `missingPalletFactors` (returned on `BuiltRequest`, like
  `unknownWeights`); the request is still built with 0 units for them (never sent: `gate()` refuses).
- Every order ref (`orderRef`, split portion ids) gets its units in `scope.palletUnits`; every stop
  gets `demand_pallet_units` = sum of its refs; portions keep `casesPerPallet` per line.
- Trucks: `bays: t.bays ?? null`; config `pallet_fill_pct: cfg.palletFillPct` (through
  `dispatchConfigFromTenant`). Split (`partCapFor`, `fleet`, `usableTrucks`) in the truck's measure (5.5).
- `exampleCases` of the same-day loading text: for an all-bay fleet the largest truck's
  `bays x fill x day cases per pallet` (text only).
- `masterDataProblems`: bays not a whole number 1-40 -> "Truck R5: bays 0 (1-40, or empty)".
- `planInputsOf`: trucks + `bays`, `palletFillPct`, `palletRoomUnits`; `palletFactors` of the day.

### 6.3 `gate()` (`lib/dispatch/start-optimize.ts`)
`PALLET_FACTOR_REQUIRED` first (2.4), then LOCATION_REQUIRED, then WEIGHT_REQUIRED. No override
flag. `app/t/[slug]/dispatch/client-api.ts`: `askOverride` returns null for it; `dispatch-client.tsx`
and `plan-view.tsx` show `error` with an **Open Products** link (and stop, like a refused start).

### 6.4 Storing the plan (`applyScenario`, `persistDispatchResult`)
- `RouteAssignment.palletUnits = scope.palletUnits[ref]` (null when absent);
  `PlanLoad.palletUnits` = the sum of its rows (must equal the solver's `pallet_units`; a difference
  is kept in the audit like `kgMismatches`).
- `truckSnapshotJson` (`snapshotSource().truck`): bays, fill and room ONLY when the scenario echoes
  `pallet_unit` (4); `PlanRules.pallets` from the echo.
- Re-plans copy both columns with the frozen loads (`copyRowData`, automatic).

### 6.5 The dispatch gate (`lib/dispatch/feasibility.ts`, `feasibilityInputFromRows`, `loadFeasibilityInput`)
- Load input `capacity` + `palletRoomUnits: number | null` (from the load's snapshot), stops +
  `palletUnits` (rows' stored units). New code `CAPACITY_PALLETS` (blocks, like `CAPACITY_CASES`):
  "R5 load 2 needs 11.6 pallets; the truck takes 11.4 (12 bays at 95% fill)." Skipped for a load
  whose rows have no units (planned by cases or before this release: never blocked after the fact).
- `CAPACITY_CHANGED` (warning) also when the truck's bays or the company's Pallet fill changed since
  planning and the load's units no longer fit the new room: "R5 load 2 needs 11.2 pallets, but the
  truck was changed to 10 bays (9.5 pallets at 95% fill) after planning. Re-plan to use the new capacity."
- A product's cases per pallet changed since planning: no block (the load keeps the units it was
  planned with); the manifest says "Changed after planning: cases per pallet of TN1.5L is now 40
  (planned with 39)".
- `inputHash` (the stored check's hash) includes the new fields.

### 6.6 Day overview (`lib/dispatch/day-overview.ts`, `dispatch-client.tsx`)
- `productsWithoutPalletFactor: { code, name, cases }[]` when the depot has bay trucks: a red line
  "No cases per pallet for 3 product(s) (TN1.5L: 120 cases, ...). OPTIMIZE is refused until they
  are entered under Products." with the Products link.
- Trucks line: "13 trucks (148 bays per load round)" for an all-bay fleet; mixed: "... (120 bays
  and 570 cases per load round)".

---

## 7. Outputs (Part B)

| Output | Change |
|---|---|
| Plan screen, loads table (`plan-view.tsx`) | "Cases" column becomes "Load": `1,045 cs` + `11.1 / 12 plt` for a bay truck (title: "limit 11.4 at 95% fill"); Utilization as 2.3 |
| Plan screen, Loading manifest | columns Product, Cases, **Pallets**, Kg: "3 pallets + 12 cases"; TOTAL "1,045 cases = 11.1 pallets (8 full pallets + 293 loose cases on mixed pallets)"; factors from `PlanInputs.palletFactors` |
| `DetailLoad` (`plan-detail.ts`) | + `palletUnits`, `palletRoomUnits`, `bays`; manifest rows + `casesPerPallet`, `fullPallets`, `looseCases` |
| Excel (`workbook.ts`) | LOAD PLAN + column "Pallets / bays"; per-load sheet header "Pallets / bays" (`11.1 / 12 (limit 11.4)`); LOADING MANIFEST + columns "Cases per pallet", "Full pallets", "Loose cases", "Pallets", TOTAL row; SKU LOADING SUMMARY + a "Pallets" row per load; SUMMARY "Pallets planned" and "Average bay fill %"; ASSUMPTIONS "Truck capacity: bays x 95% (Pallet fill) and payload; trucks without bays: cases and payload; mixed pallets (each product's cases / its cases per pallet, added up, each order line rounded up to 0.001 pallet)" |
| Driver sheet PDF (`driver-pack.tsx`) | header "45 cases · 11.1 / 12 pallets"; Load check "... = 1,045 cases (11.1 pallets)"; stops stay in cases |
| WhatsApp (`driver-links.ts` `whatsappText`) | header "Depart 07:10 · 9 stops · 1,045 cases · 11.1 pallets" (bay trucks only) |
| Summary (`summary.ts`) | `palletUnits` total and `avgBayFillPct` over bay loads (null without bay trucks) |
| Driver page (QR) | unchanged (cases) |
| Orders, invoices, intake, reconciliation | unchanged (cases) |

---

## 8. Forms, imports, settings (Part B)

- **Trucks** (`truck-form.tsx`, `trucks-table.tsx`, `/api/trucks`, `/api/trucks/[id]`,
  `truckSchema`): field "Bays (pallet positions)", whole number 1-40, empty = plan by cases. Hint:
  "With bays the planner fills pallets up to the company's Pallet fill (95%: 11.4 of 12) and the
  payload; Capacity (cases) is then not used." Table column "Bays". Audit as today.
- **Products** (`product-form.tsx`, `products-table.tsx`, `/api/products`, `/api/products/[id]`,
  `productSchema`): field "Cases per pallet" (whole number 1-10,000, empty allowed); table column;
  the PATCH note when it changes ("Loads planned before keep the pallets they were planned with;
  re-plan to use it.").
- **Products import** (new `app/api/products/import/route.ts` + `app/t/[slug]/products/import/`):
  CSV / Excel through `parseUploadIsolated`; columns code (required), name, weight per case kg,
  cases per pallet, active; aliases `casesperpallet`, `palletfactor`, `cspallet`, `qtyperpallet`,
  `weightpercasekg`, `kgpercase`; blank cell = keep; Validate only; company admin; audit
  `PRODUCTS_IMPORTED`; rate limited like customer import. Needed for the pilot master (46+ SKUs).
- **Order intake**: products created from an order file get no factor; the check screen lists
  "New products without cases per pallet" (like weights) when the depot has bay trucks.
- **Settings** (`settings-form.tsx`, `tenantConfigSchema`, `SETTINGS_FIELDS`,
  `planner-bounds.json`, `planner-config.ts`): "Pallet fill (%)" 50-100, default 95, company admin
  only (not in `DISPATCHER_SETTINGS_FIELDS`), section Daily dispatch. Effective planner values row
  "Truck capacity": "bays x 95% and payload (trucks without bays: cases and payload); a trip's pallets
  = each product's cases / its cases per pallet, added up (mixed pallets)".

---

## 9. Owner rules kept

Exact locations + location lock, every order has a depot, frozen loads never change (their stored
units are copied, never recomputed), shift 07:00-18:00 / latest return, 60-min break 12-14,
unloading finished by closing, loading rule (admin switch), Bring forward never double-carries (a
carried copy's lines get units at its own day's optimize), strict priorities, F08 kg tenths. Split
visits keep the full stop time.

---

## 10. Tests

### Solver (new `apps/solver/tests/test_pallets.py`, about 22 tests; update the handbook 5.3 table)
1. No truck has bays: the response is identical to today's on the benchmark fixture (golden: loads,
   km, cost) and every new field is None.
2. Routing respects pallets: 3 stops of 5 / 5 / 2 pallets, one 12-bay truck at 95% -> two loads.
3. Fill: 11.4 fits 12 bays at 95%, 11.401 does not; at 100% 12.0 fits.
4. Kg still binds on a bay truck (light pallets fit, heavy pallets over the payload do not).
5. Cases are not a limit on a bay truck (1,400 light cases on 12 bays).
6. Mixed fleet: a 1,000-case / 2.0-pallet stop goes on the bay truck only when the case truck is too small.
7. Prefilter: a stop over every truck's pallets -> EXCEEDS_ANY_TRUCK_CAPACITY with "pallets" words.
8. Fleet shortage in pallets (all-bay fleet), none claimed in a mixed fleet.
9. `_no_room_reason` in pallets.
10. Repack `fits_truck` by pallets; the fit fallback keeps bays.
11. `_approx_gap_s` for a bay truck uses the day's cases per pallet.
12. Feasibility `CAPACITY_PALLETS` (and none for case trucks); `LOAD_TOTALS` on wrong units.
13. PyVRP model: pallet dimension present only with a bay truck; `_plan_of` rejects an over-bay plan.
14. 422 when a truck has bays and a stop has no `demand_pallet_units`.
15. Echo fields, utilization, totals; reconciliation of units.
16. `planner-bounds.json` new keys map to contract fields (existing bounds test extended).

### Web unit (`tests/lib`)
- new `pallets.spec.ts` (helpers, rounding, full + loose, whole-number factors);
- `dispatch-split.spec.ts` (+ split by pallets, mixed fleet, part units);
- `dispatch-feasibility.spec.ts` / `plan-feasibility-gate.spec.ts` (+ CAPACITY_PALLETS, CAPACITY_CHANGED for bays/fill, legacy loads not blocked);
- `plan-lifecycle-start.spec.ts` (+ PALLET_FACTOR_REQUIRED before the other gates, no override);
- `plan-snapshots.spec.ts` (+ bays/fill/room, palletFactors, echo-only rules);
- `dispatch-workbook.spec.ts`, `driver-pack.spec.ts`, `dispatch-summary.spec.ts` (+ pallets shown only for bay trucks);
- `tenant-settings.spec.ts`, `settings-route.spec.ts`, `schemas.spec.ts` (+ palletFillPct admin-only, bounds, bays, cases per pallet);
- new `products-import.spec.ts` (Part B).

### Integration (`tests/integration`, run by CI only)
- new `dispatch-pallets.spec.ts`: bay trucks + products with factors -> stored `palletUnits` per row
  and load add up; missing factor -> 409; LOCK blocked by an over-bay load edited in the DB;
  re-plan copies frozen units unchanged.
- `tests/migrations` / drift: the new migration applies on a copy and `migrate diff` is empty.

Handbook guards (`repo-guards.spec.ts`): spec file counts (2.2), the 5.3 spec list, the solver test
table per file, the route-file count (+1 import route), migrations count.

---

## 11. Docs

- `docs/OPTIMIZER_DESIGN.md`: section 1 (capacity: pallets for trucks with bays, mixed pallets, fill,
  kg), 3 (split by pallets), 7a (the check lists pallets), 9 / speed unchanged.
- `docs/DISPATCHER_GUIDE.md`: Optimize (the refusal and how to fix it), Review the plan ("Pallets
  11.4 / 12", the manifest "3 pallets + 12 cases"), Settings (Pallet fill), Good to know (cases stay
  cases on orders and invoices).
- `docs/PROJECT_HANDBOOK.md`: 3.6 (gate order), 3.12 (Pallet fill), 3.15 (columns), 4.3 / 4.4 / 4.6 /
  4.7 / 4.11 / 4.12 / 4.13, 5.3 / 5.5 counts, 6.1 timeline, 6.2 decision, 7.1 item 7 done, 7.2
  capacity row, 7.5 owner questions.
- `docs/admin.md`: Planner settings (Pallet fill), Products import.

---

## 12. Build split

### Part A - solver + request / feasibility (behaviour switched on by data only)
Solver: sections 4 and 5 (`dispatch_models.py`, `dispatch_solver.py`, `load_repack.py`,
`feasibility.py`, `pyvrp_candidate.py`), `tests/test_pallets.py`, bounds test.
Web: migration + schema (3), shared-types contract, `planner-bounds.json` / `lib/planner-bounds.ts`,
`lib/dispatch/pallets.ts`, `split.ts`, `buildDispatchRequest`, `planner-config.ts`
(`dispatchConfigFromTenant`, `masterDataProblems`, `TenantPlannerConfig`), `start-optimize.ts`
`gate()` + the screen's refusal message, `applyScenario` storage, `snapshots.ts`, `feasibility.ts`
gate + inputs, day overview red line; unit + integration tests above; OPTIMIZER_DESIGN and handbook
sections 3.6 / 3.15 / 4.x / 5.x.
Acceptance: all solver tests; web unit, types, lint, drift; the golden "no bays = unchanged" test;
the real-day run of section 13 with the REAL code (bays set in the DB) matches the simulation.
Until Part B, bays, factors and the fill can only be set by the seed or SQL: nothing changes for a
company that has none.

### Part B - outputs, forms, imports, settings, docs
Section 7 outputs, section 8 forms / products import / intake warning / Settings, Effective planner
values, DISPATCHER_GUIDE, admin.md, handbook remainder; tests listed for Part B.
Acceptance: unit, types, lint; a manual pass of the plan screen, Excel, PDF and WhatsApp on the real
day (screenshots), the products import with NMWC's product master.

---

## 13. Before / after on the real Muscat day (26 Sep 2026)

Data: `C:/Users/abdulr/routeiq/.dev/realdata` (`orders-2026-09-26.csv` 373 lines, 80 customers,
12,482 cases, 134,578 kg; `products.csv` with `cases_per_pallet`; `trucks.csv` with bays and payload).
The day needs **143.8 pallets** (86.8 cases and 936 kg per pallet on average). Settings as the
real-data test (`run-test.mjs`): 06:00 first departure, 11 h shift, 30 min turnaround, 3 loads per
truck, Haversine x 1.3; no loading / unloading minutes per case.

Method (no code changed): the current solver (`main` daa5eae), driven by a scratch script that
builds the request like the web. BEFORE = cases + kg (`capacity_cases` 190 / 570 / 1,140). AFTER =
pallets simulated exactly: every truck has bays, so the solver's case dimension is fed with pallet
units (ceil per line) and the capacity with bays x 95 x 10; with 0 min per case the substitution
changes nothing else. Customers over one truck are split like `splitIntoParts` (CUST-A, CUST-B,
CUST-C). Pallets per load are then measured from `products.csv`.

| Run (option) | Trucks | Loads | km (est.) | Cost OMR | Unserved | Check | Pallets per load | Loads over 100% of bays | over 95% |
|---|---|---|---|---|---|---|---|---|---|
| BEFORE cases + kg (RECOMMENDED) | 6 | 14 | 985.8 | 555.70 | 0 | VERIFIED | 7.9 - 11.1 of 12 (max 92.8%) | 0 | 0 |
| AFTER pallets 95% + kg (RECOMMENDED) | 6 | 14 | 984.9 | 555.30 | 0 | VERIFIED | 7.4 - 11.0 of 12 (max 91.5%) | 0 | 0 |
| BEFORE cases + kg (MIN TRUCKS) | 5 | 14 | 985.8 | 554.49 | 0 | VERIFIED | max 11.1 (92.8%) | 0 | 0 |
| AFTER pallets 95% + kg (MIN TRUCKS) | 5 | 14 | 984.9 | 554.17 | 0 | VERIFIED | max 11.0 (91.5%) | 0 | 0 |
| Stress, kg not limited: BEFORE cases (RECOMMENDED) | 5 | 11 | 839.3 | 470.98 | 0 | VERIFIED | 8.0 - **17.5** of 12 (max 145.8%) | **7** | 9 |
| Stress, kg not limited: AFTER pallets 95% (RECOMMENDED) | 6 | 14 | 986.9 | 526.05 | 0 | VERIFIED | 5.5 - 11.4 (max 95.0%) | 0 | 0 |

What it shows:

- **With today's (estimated) case weights, weight is the binding limit on the 10-ton trucks**: 7 of
  14 loads are at 99-100% of 10,000 kg in both runs, and every load is at or under 92.8% of its
  bays. The pallet rule gives the same day (6 trucks, 14 loads, -0.9 km, -0.40 OMR). It also plans
  a load the case rule refuses: 1,339 light cases = 10.6 pallets, 9,991 kg (case rule: 1,140 max).
- **The case rule (95 cases per bay) does not protect the bays**: the day averages 86.8 cases per
  pallet, and big packs much less (TN1.5L 39, JA1.5L 56). Whenever kg does not hold a truck back
  (lines with no weight counted as 0 kg, or real weights lower than the estimates), the case rule
  plans 7 of 11 loads over 12 bays, up to 17.5 pallets; the pallet rule keeps every load at or under
  11.4 pallets (needing 6 trucks / 14 loads instead of 5 / 11).
- No load of any run passed 100% of its bays under the pallet rule; every option was VERIFIED by
  the independent check.
- Data warning: R4-1808 (3-ton, 6 bays in `trucks.csv`) carried 5.6 pallets = 5,286 kg in the
  stress run - 176% of its 3,000 kg payload. Six bays cannot be filled on a 3-ton truck with these
  products; the owner's "3-ton = 2 bays" (only R0-2415 in `trucks.csv`) needs checking (Q2).

Scratch script and raw results (not in git):
`C:/Users/abdulr/AppData/Local/Temp/claude/C--Users-abdulr-IVMS-PROFILE/32145790-5637-43a2-90bb-af05f02c9fef/scratchpad/pallets/`
(`run_day.py before|after [fill]`, `NOKG=1` for the stress runs; `result-*.json`).

Part A repeats this with the real code (bays and factors in the DB) as its acceptance run.

---

## 14. Owner questions

1. **JA 0.5 factor.** You said 84 cases per pallet; `products.csv` says JA0.5L = **96** (84 is
   SS0.5L, TN0.5L, STR0.5L and SH0.5L). Which is right? Every SKU's factor should come from the ERP
   pallet factor before the pilot.
2. **Bays per truck.** You said 3-ton trucks have 2 bays (~190 cases); `trucks.csv` gives R0-2415 2
   bays but R4-1808, R10-3832 and R11-5587 (also 3-ton) **6 bays / 570 cases**. Please confirm bays
   for all 13 trucks and the hired ones.
3. **Fill on small trucks.** At 95% a 2-bay truck takes at most 1.9 pallets, so two full pallets of
   one product never go on it (and a 12-bay truck at most 11.4). Keep one company-wide fill, or add a
   per-truck fill (for example 100% on 2-bay trucks)?
4. **Cases on bay trucks.** The planner ignores the case capacity of a truck with bays (pallets and
   kg only), so a 12-bay truck can take more than 1,140 light cases (1,339 on 26 Sep). Confirm.
5. **Missing cases per pallet at night.** No "optimize anyway": a late order with a brand-new SKU
   blocks RE-PLAN until its factor is entered, and only company admins can edit products today.
   Accept, or let dispatchers enter cases per pallet?
6. **Hired truck without bays.** Allowed (planned by cases). In such a mixed fleet the plan cannot
   say "the fleet is N pallets short", only kg. Accept, or require bays on every truck of a depot
   once one has them?
7. **Loading time.** It is per case today ("Loading minutes per case"). Should it be per pallet
   (forklift), now that pallets are known? (Not in this build.)
8. **Drivers.** Show pallets on the driver sheet header and the WhatsApp text (proposed), or only
   on the warehouse documents (manifest, Excel)?
9. **Weights.** The case weights are still estimates. With them, weight - not bays - limits the
   10-ton trucks (936 kg per pallet on average: 10 t is about 10.7 pallets, under 11.4). The real
   weights decide how often pallets bind.
10. **Pilot tomorrow.** Parts A and B are not ready by tomorrow. Proposal: start the pilot on the
    current case rule (it is safe while weights hold the trucks back, see section 13), and switch on
    bays when Part B is live (enter bays + factors, nothing else to change). Agree?
11. **Test data and accounts.** Deleting the earlier test data and creating the pilot accounts is
    not part of this build: which company, depots, users and which data (orders, plans, customers?)
    should go - to be confirmed item by item before anything is deleted.

---

## 15. Not in this build

- Volume (`capacityVolumeL`, `volumePerCaseL`) and pallet height / stacking rules.
- Pallet count by full single-SKU pallets plus mixed remainder (not additive per stop, so not an
  optimizer dimension); the fill % is the margin instead.
- Deleting the earlier test data and loading the NMWC pilot masters (accounts, products, trucks):
  an operational step with its own confirmation, not part of this code change.

---

## 16. Part A as built (4 Oct 2026, branch `pallet-capacity`)

Built as sections 3-6 say, with these differences (each kept small and backward compatible):

- `fitsCapacity(cases, kg, cap, units = 0)` (units last, so every existing caller and test keeps its
  call); `PartCapacity.palletUnits`, `FleetTruck.palletUnits`, `OpenLine.casesPerPallet` are optional.
- The refusal lives in `lib/dispatch/pallets.ts` (`palletFactorGate`, pure) and is called first by
  `start-optimize.gate()`; its body has no `productsPath` - the screens build the link from their own
  slug (`palletRefusalToast`: red toast with an **Open Products** action, 30 s).
- The request carries `bays` only on trucks that have them and `demand_pallet_units` /
  `scope.palletUnits` / `missingPalletFactors` / `palletFactors` only on a day whose depot has a truck
  with bays: a day without bays sends exactly what it sent before (plus `config.pallet_fill_pct`).
- `missingPalletFactors` counts the lines actually sent to the optimizer (a customer without a usable
  location is not counted); the day overview's red line counts every open line.
- A load on a truck WITHOUT bays in a mixed fleet: the solver reports `pallet_units` None, so
  `PlanLoad.palletUnits` is NULL; its rows still keep their units.
- With an older solver (no `pallet_unit` echo) rows and loads store NULL and the option carries the
  warning of section 4.
- `truckMasterChanges` also says "Truck bays changed after planning" for a load planned by pallets.
- Pulled forward from part B because the bounds / settings tests tie them together:
  `tenantConfigSchema.palletFillPct` + `SETTINGS_FIELDS` + a "Pallet fill" field on Settings (Daily
  dispatch: timing, admin only) + the "Truck capacity" row of Effective planner values;
  `truckSchema.bays` + `POST /api/trucks` mapping (PATCH passes it through). No truck form field yet.
  `DISPATCHER_GUIDE.md` got one paragraph on the refusal.
- `feasibility.CHECK_VERSION` = 3 (test_planning_rules now asserts >= 2).

Tests: solver `tests/test_pallets.py` (23, incl. the golden "no bays = main daa5eae" run), full solver
suite 409 passed / 2 skipped; web `pallets.spec.ts` (19), `pallets-request.spec.ts` (5), 2 new
start-gate tests in `plan-lifecycle-start.spec.ts`; unit suite 2,491 tests green; tsc, lint, drift
clean. Integration `tests/integration/dispatch-pallets.spec.ts` written, not run locally (CI).

Real day 26 Sep 2026 with the REAL code (requests built by `buildDispatchRequest` from
`.dev/realdata`, bays from `trucks.csv`, solved by the branch solver, PyVRP on; scratch:
`scratchpad/pallets-a/run_real.py`, `request-*.json`, `result-*.json`):

| Run (option) | Trucks | Loads | km | Cost OMR | Unserved | Check | Pallets per load | > 100% bays | > 95% |
|---|---|---|---|---|---|---|---|---|---|
| Cases + kg (RECOMMENDED) | 6 | 14 | 981.4 | 554.46 | 0 | VERIFIED | 8.39 - 10.96 (max 91.4%) | 0 | 0 |
| Pallets 95% + kg (RECOMMENDED) | 6 | 14 | 979.7 | 554.25 | 0 | VERIFIED | 7.73 - 11.36 (max 94.7%) | 0 | 0 |
| Cases + kg (MIN TRUCKS) | 5 | 14 | 981.4 | 552.98 | 0 | VERIFIED | max 10.96 | 0 | 0 |
| Pallets 95% + kg (MIN TRUCKS) | 5 | 14 | 979.7 | 552.43 | 0 | VERIFIED | max 11.36 | 0 | 0 |
| Stress, kg not limited: cases | 5 | 11 | 839.2 | 470.98 | 0 | VERIFIED | 7.95 - **17.5** (max 145.8%) | **7** | 9 |
| Stress, kg not limited: pallets 95% | 6 | 14 | 978.3 | 524.14 | 0 | VERIFIED | 5.45 - 11.39 (max 94.9%) | 0 | 0 |

It matches the section 13 simulation: same trucks and loads, km within 0.6%, no pallet load over 95%
of its bays, the case rule's stress loads up to 17.5 pallets on 12 bays. The pallet run carries 1,263
cases on one 12-bay load (cases are not a limit there) and the solver's stored units equal the units
measured from `products.csv` on every load.

---

## 17. Part B as built (4 Oct 2026, branch `pallet-capacity`, commit f0c7719 on top of part A 4e48c3c; not pushed)

Built as sections 7 and 8 say, with these differences (all additive; a plan without bays exports and
shows exactly as before):

- **Only loads planned by pallets show pallets** (`pallets.ts loadPallets`: the stored
  `PlanLoad.palletUnits` AND a truck snapshot with bays and room, both kept only from the solver's
  echo). A case truck in a mixed fleet keeps "cases / capacity".
- **Plan detail** (`plan-detail.ts`): `DetailLoad.palletUnits`, `bays`, `palletFillPct`,
  `palletRoomUnits`, `palletNotes`; manifest rows (`ManifestRow`) + `casesPerPallet`, `fullPallets`,
  `looseCases`, `palletUnits`. Each product's units = its order lines' units (the factor a split part
  was cut with, else `PlanInputs.palletFactors`, else the product's today), so the products add up to
  the load's stored units (checked on the real day: 14 of 14 loads equal). Options carry `palletRule`.
- **Plan screen**: the loads column is "Load / capacity" ("1,045 cs" over "11.1 / 12 plt", title with
  the limit); the manifest has "3 pallets + 12 cases" per product, the TOTAL in pallets and the line
  "1,045 cases = 11.1 pallets (8 full pallets + 293 loose cases on mixed pallets)", and any
  "Changed after planning: cases per pallet of X is now N (planned with M)"; KPI "Pallets · bay fill".
- **Summary**: `palletUnits`, `palletLoads`, `avgBayFillPct` only when a load was planned by pallets
  (the keys are left out otherwise, so stored summaries of days without bays do not change).
- **Excel**: LOAD PLAN "Pallets / bays" column only when a load has pallets (its case capacity cell
  reads "by pallets", a case truck "by cases"; TOTAL in pallets); load sheet header "Cases" + "Pallets
  / bays"; LOADING MANIFEST + Cases per pallet, Full pallets, Loose cases, Pallets, TOTAL and the words
  line; SKU LOADING SUMMARY + "Pallets (plan)" and "Bays" rows; SUMMARY + "Pallets planned", "Average
  bay fill %"; ASSUMPTIONS "Truck capacity" worded by the echo (`solverRules().pallets`).
- **Driver sheet PDF**: header "9 stops · 1,045 cases · 11.1 / 12 pallets"; load check "= 1,045 cases
  (11.1 pallets)". **WhatsApp**: "Depart 07:10 · 9 stops · 1,045 cases · 11.1 pallets". Stops stay in cases.
- **Forms**: truck "Bays (pallet positions)" + table column; product "Cases per pallet" + table column
  (`productSchema.casesPerPallet`, whole 1-10,000, '' / null clears); a product save that changes it
  answers "Cases per pallet saved. Loads planned before keep the pallets they were planned with;
  re-plan to use it." The product edit form no longer sends the read-only code (a product with an ERP
  code such as "TN1.5L (6)" could not be saved before).
- **Products import** (`POST /api/products/import`, TENANT_ADMIN, `lib/dispatch/product-import.ts`,
  page Products -> Import products): **a new product takes its code as the ERP writes it** (any text up
  to 64 characters without line breaks), not only plain codes as the spec's customer-import pattern
  implied: NMWC's master has 7 codes with spaces or brackets ("TN1.5L (6)", "SS5GB NRB", "EFF24 (0)",
  "KZ-LE(0)300" ...) that the order intake creates as written. `products.csv` imports as 46 new
  products, all with cases per pallet, no error. Audit: one CREATE / UPDATE per product + one
  `PRODUCTS_IMPORTED` (new catalog action).
- **Order check**: `IntakeIssueSummary.productsWithoutPalletFactor` (red line with a Products link)
  when the depot has an active truck with bays.
- Settings "Pallet fill %" and the Effective planner values row were already built in part A.

Tests: web unit 126 spec files (new `pallets-outputs.spec.ts` 18, `products-import.spec.ts` 10),
2,518 passed / 1 skipped; tsc, lint, drift clean. Integration `dispatch-pallets.spec.ts` + 2 tests
(plan detail / summary / Excel; products import Validate only), not run locally (CI).

### 17.1 Before / after on the real Muscat day (26 Sep 2026), part B run

Requests built by the branch's `buildDispatchRequest` (identical to part A's: 83 stops, 12,482 cases,
134,578 kg, 143.919 pallets; checked stop by stop), solved by the branch solver with PyVRP on
(`scratchpad/pallets-a/b/run_real.py`, `log-*.txt`, `result-*.json`). Settings as section 13.

| Run (option) | Trucks | Loads | km | Cost OMR | Unserved | Check | Pallets per load | > 100% bays | > 95% |
|---|---|---|---|---|---|---|---|---|---|
| Cases + kg (RECOMMENDED) | 6 | 14 | 985.8 | 555.70 | 0 | VERIFIED | 7.85 - 11.13 (max 92.8%) | 0 | 0 |
| Pallets 95% + kg (RECOMMENDED) | 6 | 14 | 984.5 | 555.20 | 0 | VERIFIED | 8.70 - 11.02 (max 91.9%) | 0 | 0 |
| Cases + kg (MIN TRUCKS) | 5 | 14 | 985.8 | 554.49 | 0 | VERIFIED | max 11.13 | 0 | 0 |
| Pallets 95% + kg (MIN TRUCKS) | 5 | 14 | 984.5 | 554.03 | 0 | VERIFIED | max 11.02 | 0 | 0 |
| Stress, kg not limited: cases | 5 | 11 | 839.3 | 470.98 | 0 | VERIFIED | 7.95 - **17.5** (max 145.8%) | **7** | 9 |
| Stress, kg not limited: pallets 95% | 6 | 14 | 986.9 | 526.05 | 0 | VERIFIED | 5.45 - 11.39 (max 95.0%) | 0 | 0 |

Same picture as part A (the search is time-limited, so loads differ slightly run to run): with the
estimated weights the 10-ton trucks are full by kg first (8 of 14 pallet loads at 99-100% of the
payload), no pallet load passes 95% of its bays, and the case rule overloads the bays as soon as kg
does not hold it back (17.5 pallets on 12 bays).

Part B outputs of the pallets RECOMMENDED plan, rendered by the real code (`plan-2026-09-26-pallets.xlsx`,
`driver-sheets-2026-09-26-pallets.pdf`, `whatsapp-2026-09-26-pallets.txt` in `scratchpad/pallets-a/b`):
143.9 pallets planned, average bay fill 85.7%, reconciliation 12,482 = 12,482. Per load, e.g.
R1-5187 L1 "540 cases = 8.9 pallets (7 full pallets + 120 loose cases on mixed pallets)" with
JA1.5L 325 cases at 56 = "5 pallets + 45 cases"; R1-5187 L3 "599 cases = 10.5 pallets" at 9,997.7 kg
(weight binds); R3-9413 L1 "1,059 cases = 11.0 pallets (6 full pallets + 428 loose cases ...)". PDF
header "1 stop · 599 cases · 10.5 / 12 pallets"; WhatsApp "Depart 06:00 · 4 stops · 540 cases · 8.9 pallets".
