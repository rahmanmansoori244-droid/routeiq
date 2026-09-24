# RouteIQ → OPERATION-PROJECT handoff (future integration contract)

**Status:** design only, not implemented. The two systems are deliberately kept separate.

| System | Question it answers | When |
|---|---|---|
| **RouteIQ** (`C:\Users\abdulr\routeiq`) | "What should we load, into which truck, and in what delivery sequence?" | **Before** delivery (evening/night) |
| **OPERATION-PROJECT**, Lane A "Dispatch & POD" (`C:\Users\abdulr\OPERATION-PROJECT\app`) | "What actually happened?" | **During/after** delivery (end of day) |

RouteIQ never records actual deliveries, and OPERATION-PROJECT never optimizes routes.

## Flow once integrated

```
RouteIQ plan (version N, loads DISPATCHED)
   → export "dispatch plan" (JSON or CSV, below)
   → OPERATION-PROJECT Lane A pre-fills one trip per truck load
   → dispatch clerk records ACTUAL loaded / delivered / returned / on-time / reason from the POD
   → validator approves → OTIF, Undelivered %, Returns %, Utilisation, Cost/Case KPIs
```

This mirrors what Lane A already does with the RoutPro pre-sell CSV (`routProPrepopulate` in `app/src/feeds-logic.js`, spec `ROUTPRO_SPEC`). A RouteIQ plan is a strictly better pre-fill: it adds the truck, load, sequence and planned times as well as the SKUs.

## Contract: RouteIQ dispatch plan export (one file per depot + date)

Produced only from loads whose status is **DISPATCHED** or **COMPLETED**; those loads are immutable in RouteIQ. It is keyed so it can be re-sent without creating duplicates.

### Header

| Field | Type | Example | Notes |
|---|---|---|---|
| `plan_id` | string | `cmufd03hv004c…` | RouteIQ RunPlan id (unique per version) |
| `plan_version` | int | `3` | |
| `plan_date` | date | `2026-09-26` | delivery date |
| `depot_code` | string | `MCT-GHALA` | must match OPERATION-PROJECT depot code |
| `generated_at` | datetime (UTC) | | |
| `distance_is_estimated` | bool | `false` | true = Haversine fallback, not road |

### One row per truck load (`trips[]`) → Lane A `trip`

| Field | Example | → Lane A field |
|---|---|---|
| `load_key` | `cmufd…:T01:1` | idempotency key (`plan_id:truck_code:load_no`) |
| `truck_code` | `T01` | `trip.truck` |
| `load_no` | `1` | new (multi-load truck day) |
| `route_code` | *(optional)* | `trip.route_id` if NMWC keeps route codes |
| `driver_code` | `DR-001` | |
| `planned_departure` | `06:40` | |
| `planned_return` | `11:05` | |
| `planned_cases` | `245` | cases loaded **planned** (the clerk records actual) |
| `planned_km` | `86.4` | |

### One row per stop and SKU (`lines[]`) → Lane A `dispatch_line`

| Field | Example | → Lane A field |
|---|---|---|
| `load_key` | `cmufd…:T01:1` | parent trip |
| `sequence` | `3` | planned stop order |
| `customer_code` / `branch_code` | `C100` / `B01` | customer |
| `sales_order_no` | `SO-1` | links POD back to the sales order |
| `sku` | `TAN-500-24` | `dispatch_line.sku` |
| `planned_cases` | `60` | pre-fills `cases_loaded` |
| `planned_eta` | `07:25` | promised time, which OTIF needs (decision D1) |
| `hard_window` | `06:00-10:00` | context for the on-time judgement |
| `priority` | `1` | |

Lane A keeps its own "correct-by-exception" rule: planned quantities pre-fill loaded, and the clerk corrects delivered/returned from the paper POD.

**Known risk:** Lane A currently assumes delivered = loaded and on-time = 1 for untouched pre-filled lines (see the Dispatch & POD audit, `feeds-logic.js:141-148`). If the integration is built, pre-filled lines should stay **unconfirmed** until the clerk touches them, so a plan is never counted as 100% OTIF by default.

## What each side must add (when integration is approved)

**RouteIQ**
- `GET /api/runs/:id/export/handoff.json` (and `.csv`), dispatched loads only, using the contract above. All the data already exists in `PlanLoad` + `RouteAssignment` + `OrderLine` (`lib/dispatch/plan-detail.ts`).

**OPERATION-PROJECT**, the smallest safe change
- A second pre-fill source next to RoutPro, e.g. `routeIqPrepopulate`: stage → quarantine on unknown SKU or truck → the clerk corrects exceptions. Same staging/validation path as RoutPro, so the existing envelope triggers, the no-self-validation rule and the tests keep working.
- Map `load_no` onto the trip (one Lane A trip per truck **load**, not per truck-day), so utilisation per load stays correct.

## Deliberately not done now
- No shared database, no API calls between the systems, no changes to OPERATION-PROJECT.
- The RouteIQ driver/POD module (Module C) overlaps with Lane A's POD capture. Decide on ONE place to record actual delivery before building either further. The recommendation is Lane A (it has validation, KPIs and audit).

## NMWC CRM customer coordinates (later)
The NMWC-CRM project captures customer GPS (`gpsLat`/`gpsLng`, `capturedLat`). RouteIQ does **not** depend on it. The dispatcher saves locations directly, and they are permanent (`Customer.locationSource`, `locationVerified`, `locationVerifiedBy/At`). A later sync could:
1. import CRM coordinates as `locationSource = CRM`, `locationVerified = false`, **never** overwriting a dispatcher-verified location (the customer import already follows this rule);
2. flag differences above ~150 m between CRM and verified RouteIQ points for review instead of overwriting either.
