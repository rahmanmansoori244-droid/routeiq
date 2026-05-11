# NMWC Synthetic Test Data (Muscat depot, 5 days)

This bundle is a realistic-shape but fully synthetic dataset for **functional validation** of the deployed RouteIQ v1 instance, while real NMWC customer master is being cleaned up. It is not a substitute for the real-data pilot — that comes later.

## What "functional validation" means here
Synthetic data can prove that uploads parse, validation rules fire, the solver runs end-to-end, scenarios differ in expected ways, the map renders, manual adjustments persist, exports generate. It **cannot** prove the optimizer beats NMWC's manual planner — there is no manual baseline in synthetic data to compare against. Treat the test as system-correctness, not as competitive proof.

## What's in this bundle

| Path | Purpose |
|---|---|
| `generate_synthetic_data.py` | The generator. Re-run with different `SEED`, `NUM_CUSTOMERS`, `NUM_DAYS`, or `START_DATE` to vary the data. |
| `master/regions.csv` | 15 Muscat neighborhoods (Ruwi, Khuwair, Qurum, Seeb, Bawshar, etc.) |
| `master/customers.csv` | 150 customers across 8 realistic FMCG types (hotels, supermarkets, mini-marts, restaurants, offices, schools, clinics, construction sites) with real Muscat-area coordinates, branch codes for ~10% of supermarkets/minimarts, priority 1–5, payment type credit/cash/prepaid |
| `master/customers_with_missing_coords.csv` | Same as above but with 7 customers' lat/lng deliberately blanked, to exercise the validation report + manual geocode flow |
| `master/products.csv` | 5 mineral water SKUs (200ml / 500ml / 1.5L / 5L / 19L gallon) with weight and volume per case |
| `master/trucks.csv` | 8 trucks at the Muscat depot: 2 small Toyota Dyna (120 cases), 4 medium Isuzu NPR (240 cases), 2 large Hino 500 (450 cases) |
| `orders/orders_2026-05-12.csv` | **Day 1 — heavy day** (121% of fleet capacity → forces priority-based drops, good test of the disjunction logic) |
| `orders/orders_2026-05-13.csv` | Day 2 — normal (91% of capacity, tight routing) |
| `orders/orders_2026-05-14.csv` | Day 3 — normal (86% of capacity) |
| `orders/orders_2026-05-15.csv` | Day 4 — normal (90% of capacity) |
| `orders/orders_2026-05-16.csv` | Day 5 — light (75% of capacity, everyone should be served) |

## Depot
You'll need to create one depot manually (or via API) before importing:
- **Code**: `MCT-DEPOT`
- **Name**: NMWC Muscat Main Depot
- **Lat / Lng**: 23.5859, 58.4059  (approximately the Ruwi industrial area)

## Recommended upload sequence
1. **Create the depot** as above (Settings → Depots → Add, or via API).
2. **Import regions**: Master Data → Regions → import `master/regions.csv`. All 15 regions should commit without errors. They should all attach to `MCT-DEPOT`.
3. **Import products**: Master Data → Products → import `master/products.csv`. 5 products.
4. **Import trucks**: Master Data → Trucks → import `master/trucks.csv`. 8 trucks, all assigned to `MCT-DEPOT`.
5. **Import customers (clean version first)**: Master Data → Customers → import `master/customers.csv`. 150 customers commit, zero errors.
6. **Now run the bad-data test**: drop `customers_with_missing_coords.csv` on the customer import screen. You should see 7 validation warnings (or rejections, depending on how strict your validator is on missing coords). Confirm the validation report behaves correctly. Roll back this batch — do NOT keep it; keep the clean customers from step 5.
7. **Upload day 1 orders**: `orders/orders_2026-05-12.csv`. 185 order lines, ~135 customers, expect zero validation errors.
8. **Create a run** for 2026-05-12, depot `MCT-DEPOT`, optimization mode `BALANCED`. Click Optimize.
9. **Verify on the heavy day**:
   - Job transitions QUEUED → RUNNING → SUCCEEDED in under 30s.
   - 3 scenarios return: MIN_TRUCKS, MIN_DISTANCE, BALANCED.
   - All 8 trucks are used (or close to it) in MIN_DISTANCE; fewer in MIN_TRUCKS.
   - Some priority-5 customers appear in `UnservedOrder` with reason `SOLVER_DROPPED_LOW_PRIORITY` (because demand is 121% of fleet capacity).
   - NO priority-1 customers appear in `UnservedOrder`. **This is the key correctness check for the priority-inverted drop penalty fix.**
   - Map renders all stops with colored routes per truck.
   - Excel and PDF exports work.
   - "Estimated km" label appears (Haversine in use).
10. **Repeat for days 2–5**. Day 5 (light) should serve everyone with high spare capacity. Day 1 (heavy) should be the most interesting and stressful run.

## Functional checklist this data exercises

- [x] Master data CRUD + bulk CSV import (regions, customers, products, trucks)
- [x] Validation report (clean file passes; missing-coords file warns/rejects per spec)
- [x] `branchKey` normalization (most customers have blank branch, ~10% of supermarkets have B01/B02/B03)
- [x] Order upload + `UploadBatch` traceability + bulk-delete-by-batch
- [x] Optimization end-to-end (5 days × 3 scenarios = 15 solver runs)
- [x] Priority-inverted drop penalty on the over-capacity day
- [x] `UnservedOrder` with structured reason codes
- [x] Solver time auto-scaling (small dataset — should run well under 30s)
- [x] Haversine + distance multiplier + "Estimated km" labels everywhere
- [x] Map rendering with multiple colored routes
- [x] Context-menu manual adjustment (move stop between trucks, lock, unassign)
- [x] Capacity validation on manual moves (try moving a 60-case stop onto a near-full small truck)
- [x] Re-optimize with locked stops
- [x] Excel per-truck export + master Excel + PDF route sheets
- [x] Dispatch flow + audit log entries (OPTIMIZE_STARTED, OPTIMIZE_SUCCEEDED, SCENARIO_CHOSEN, ROUTE_MANUALLY_CHANGED, DISPATCH)
- [x] Dashboard KPIs across multiple runs

## What this dataset does NOT exercise (still needed before launch)

- **Manual baseline upload**: synthetic data has no dispatcher plan to compare against. You can hand-construct a fake baseline if you want to test the comparison UI, but the savings number it produces is meaningless.
- **Time windows**: v1 doesn't enforce these, so it doesn't matter for v1 testing.
- **Multi-depot**: this dataset is single-depot (Muscat).
- **Genuinely large scale**: 150 customers is normal-day-sized. To stress-test the solver, regenerate with `NUM_CUSTOMERS = 2000`, `NUM_DAYS = 1`. The auto-scaling time limit should keep it under 120s.
- **Real coordinate density**: Muscat road network has real bottlenecks (Sultan Qaboos Highway, mountain passes around Wadi Adai) that Haversine ignores. Real-data pilot will surface this.

## Re-generating with different parameters

```bash
# Stress test: 2000 customers, 1 day
SEED=99 python3 -c "
import generate_synthetic_data as g
g.NUM_CUSTOMERS = 2000
g.NUM_DAYS = 1
g.main()
"

# Or edit the constants at the top of the script directly.
```

## Notes on realism
- Customer names are templated combinations of common English adjectives and Arabic/Omani name roots (Madina, Sahara, Falaj, Anwar, etc.) to feel like Muscat without referencing real businesses.
- Neighborhood coordinates are real, jittered ±1.5 km to spread customers within each area.
- Truck capacities and costs are plausible for Oman commercial vehicles in 2026 OMR.
- Day-of-week effects model Sunday-as-start-of-week (Oman work week is Sun–Thu).
- Order quantities are tuned so the heavy day is over capacity and the light day has slack, exercising both ends of the solver.

## Next steps after functional validation passes

When all the checklist items pass on this dataset:
1. Real-data pilot becomes the next gate. Whenever your customer master cleanup completes (coords + priorities + service times for the real Muscat customer base), upload it and run a real day comparison.
2. Until then, the deployed system is functionally validated but not yet value-validated. The v2 build can begin on features that don't depend on observing real users (Arabic/RTL, Stripe scaffolding, split-deliveries, possibly multi-depot single run and time windows — see the chat thread for the parallel build plan).
