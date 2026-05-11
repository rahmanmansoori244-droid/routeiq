# Overnight build report — Modules A, B, C

**Live URL:** https://web-production-a9d04.up.railway.app
**Health:** https://web-production-a9d04.up.railway.app/api/health → `{"ok":true,"db":"up","solver":"up"}`

---

## ✅ Module A — State-of-the-art solver (PyVRP / Hybrid Genetic Search)

**Shipped & deployed.** Replaced OR-Tools with PyVRP 0.13.3 on the solver service. PyVRP is the highest-scoring open-source CVRP solver on the CVRPLIB benchmarks (44 best-known solutions vs OR-Tools' 0). Same FastAPI contract — zero changes upstream.

**Verified on Day-1 NMWC synthetic data (120 stops, 121% of fleet capacity):**

| | OR-Tools (before) | PyVRP (after) |
|---|---|---|
| Customers served | 107 | **109** ↑ |
| Priority-1 drops | 0 | 0 ✅ |
| Time limit floor | 30s | 60s |
| Time limit ceiling | 120s | 300s |

Unit tests: **27/27 passing**. Files: [apps/solver/solver.py](apps/solver/solver.py), [bench script](apps/solver/scripts/bench_day1.py).

---

## ✅ Module B — Real road distance (Mapbox Directions Matrix)

**Shipped & deployed.** New `apps/solver/distance.py` with a clean `DistanceProvider` abstraction.

**To activate:** add `MAPBOX_TOKEN=<token>` to the Railway **solver** service variables and flip Tenant Settings → "Distance provider" to **Mapbox Matrix**. Until then, the solver continues with Haversine + 1.30 multiplier (the v1 default). If Mapbox fails mid-run we fall back to Haversine and surface a warning in `OptimizeResponse.warnings`.

Web UI / Excel / PDF automatically drop the "Estimated km" label once real road distance kicks in.

---

## ✅ Module C — Driver PWA, GPS tracking, live dispatcher map

**Schema migrated to prod**: `DriverShift`, `TruckLocation`, `DeliveryProof`, `Driver.accessPinHash`, `DriverShiftStatus` enum.

### What you have:

| Surface | URL | What it does |
|---|---|---|
| **Driver PWA login** | /driver | Mobile-first sign-in (slug + driver code + PIN) |
| **Driver manifest** | /driver/manifest | Today's stops, GPS pings every 30s, native-Maps hand-off, "Mark done" sheet with notes + **signature pad** (finger/stylus on a canvas) |
| **Dispatcher live map** | /t/nmwc/runs/{runId}/live | MapLibre map with truck markers polling every 5s, per-truck color, status (ON_PLAN / BEHIND / AHEAD / OFFLINE), sidebar with stop progress + distance-to-next |
| **PIN admin** | /t/nmwc/drivers | New 🔑 key icon on each driver row — click to generate a 6-digit PIN shown ONCE |

### Map renderer

- Default: **MapLibre GL JS + free OpenStreetMap raster tiles**. No token, works for everyone.
- Optional upgrade: set `NEXT_PUBLIC_MAPBOX_TOKEN` on the web service → cleaner vector tiles via Mapbox.

The run detail **Map tab** (already existed, now using MapLibre) shows the **optimal path** with **numbered colored circles per stop**, **polylines connecting stops in order**, and **per-truck colors** — exactly what you asked for.

### Deviation detection

Dispatcher endpoint marks a truck as `BEHIND` (amber on the map) when:
- It has a recent ping (online)
- The latest GPS is **> 2 km from the next planned stop**
- The deviation has lingered ≥ 2 minutes

Trucks with no ping for >10 min are `OFFLINE` (gray).

### Audit log additions
- `DRIVER_LOGIN` — written when a driver signs in
- `DELIVERY_PROOF_CREATED` — written when a driver marks a stop done

---

## ✅ End-to-end smoke test (run before bed, against prod DB)

Executed [apps/web/prisma/smoke-driver-flow.ts](apps/web/prisma/smoke-driver-flow.ts) which:
1. Upserted driver **SMOKE-DRV**
2. Set & hashed a PIN
3. Called `loginDriver()` → got `sessionToken`
4. Posted **5 GPS pings** along depot → first stop
5. Created a **DeliveryProof** with placeholder signature
6. Validated `requireDriverShift(token)` still passes
7. Cleanly ended the shift

All steps passed. Visit the dispatcher view to see the SMOKE-DRV ping trail on the map:
**https://web-production-a9d04.up.railway.app/t/nmwc/runs/cmp1i2e1g000ao3tcncuvosht/live**

---

## How to test the full flow tomorrow

1. **Confirm prod is on the new builds** — visit https://web-production-a9d04.up.railway.app/api/health (should return `{"ok":true,"db":"up","solver":"up"}`).
2. **Create a real PIN for DR-001:** open https://web-production-a9d04.up.railway.app/t/nmwc/drivers → click the 🔑 icon next to DR-001 → write down the 6-digit PIN.
3. **Sign in as a driver:** open https://web-production-a9d04.up.railway.app/driver in a second browser/incognito or on your phone → enter `nmwc` + `DR-001` + the PIN → tap **Start shift**. The browser asks for GPS permission — say yes.
4. **Watch the dispatcher map:** in your main browser visit /t/nmwc/runs/cmp1i2e1g000ao3tcncuvosht/live (or pick a more recent run). DR-001's truck appears within ~30s and refreshes every 5s.
5. **Re-run optimization (optional):** /t/nmwc/runs/new — pick MCT-DEPOT, any future date with synth orders (2026-05-13 to -16). When it finishes you'll see PyVRP's HGS in action; pick a scenario, then open the **Map** tab on the run detail to see the numbered optimal route polylines.

---

## What's NOT in this build

- **Mapbox Matrix real-road-distance routing** — code is shipped but inactive until you put a `MAPBOX_TOKEN` on the solver service.
- **Customer ETA SMS/WhatsApp** — needs Twilio. Deferred.
- **Photo POD upload** — would need an R2/S3 bucket + presigned URL flow. Signature pad covers the legal "proof" half for now.
- **Predictive ETA accuracy improvements** (recompute remaining time based on actual progress) — current ETA is the planned arrival from the solve. Real-time recompute is straightforward to add.

---

## Open commits since you went to bed

```
333d210 feat(seed): seed 8 drivers (DR-001..DR-008) alongside trucks in synth data
34ee66f feat(audit): DRIVER_LOGIN + DELIVERY_PROOF_CREATED audit actions + smoke-driver-flow script
d882b4e feat(map): MapLibre+OSM by default … + signature pad + deviation alert
ebc9aaa feat(driver): Module C — driver PWA + GPS tracking + live dispatcher
bdd1f1b feat(solver): Module B — Mapbox Directions Matrix provider + tenant toggle
4c40e12 feat(solver): Module A — swap OR-Tools for PyVRP (HGS solver, +bigger time budget)
```

All pushed to `main` on https://github.com/rahmanmansoori244-droid/routeiq, all auto-deployed on Railway.
