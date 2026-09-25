"""Re-plan benchmark: plan quality around locked loads, compared between two solver versions.

The release check for changes to how the optimizer treats locked (frozen) loads. Synthetic NMWC-like
days (tests.test_dispatch.nmwc_day, Haversine matrix), two shapes:

* ``late``: the day is planned once, every truck's first load is locked (a FrozenTrip with the
  plan's times and cases), its stops leave the day; the other stops stay with the truck they were
  on (plan continuity), and late stops are added (P1-P3). The late-order re-plan.
* ``half``: half the fleet (6 of 12 trucks) has a locked first load 06:00-09:30 (+10 min per truck,
  200 cases); the whole day plus late stops is planned around them.

Both versions re-plan exactly the same requests (all three options, the production worker pool).
Money is compared on ONE model: this checkout's whole-truck-day costing (costing.py) of each
version's new loads - locked loads are the same for both.

    cd apps/solver
    .venv/Scripts/python scripts/bench_replan.py state late state_late.json      # builds the days (this checkout)
    .venv/Scripts/python scripts/bench_replan.py run state_late.json new.json      # this checkout's solver
    .venv/Scripts/python scripts/bench_replan.py run state_late.json old.json --root <old checkout>/apps/solver
    .venv/Scripts/python scripts/bench_replan.py compare state_late.json old.json new.json

The search is time-limited: the same version on the same machine varies by about 1% km between
runs, while two versions can differ by up to ~10% on one day either way (different search
landscapes). Compare the totals over all the days (see OPTIMIZER_BENCHMARK.md section 9).
"""
from __future__ import annotations

import json
import os
import random
import sys
import time

HERE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DAYS = [(60, s) for s in (1, 2, 3, 4, 5)] + [(150, s) for s in (1, 2, 3)]
CFG = dict(time_limit_sec=None, scenarios=["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"], fuel_price_per_litre=0.26,
           driver_cost_per_hour=2.5, overtime_after_min=480, overtime_cost_per_hour=1.0)


def _use(root: str) -> None:
    sys.path.insert(0, root)
    os.chdir(root)


def _late_stops(nmwc_day, n: int, seed: int) -> list[dict]:
    rnd = random.Random(seed + 500)
    src, _ = nmwc_day(max(4, n // 10), seed=seed + 100)
    out = []
    for i, s in enumerate(src):
        d = s.model_dump()
        d.update(stop_id=f"L{i:02d}", order_ids=[f"o-L{i:02d}"], customer_id=f"c-L{i:02d}", late=True, priority=rnd.choice([1, 2, 3]))
        out.append(d)
    return out


def build_state(shape: str, out: str) -> None:
    _use(HERE)
    from dispatch_solver import optimize_dispatch
    from tests.test_dispatch import hm, nmwc_day, rec, req

    state = []
    for n, seed in DAYS:
        stops, trucks = nmwc_day(n, seed=seed)
        late = _late_stops(nmwc_day, n, seed)
        if shape == "late":
            sc = rec(optimize_dispatch(req(stops, trucks, **CFG)))
            first: dict = {}
            for ld in sorted(sc.loads, key=lambda l: (l.truck_id, l.load_no)):
                first.setdefault(ld.truck_id, ld)
            gone = {st.stop_id for ld in first.values() for st in ld.stops}
            on_truck = {st.stop_id: ld.truck_id for ld in sc.loads for st in ld.stops}
            kept = [s.model_dump() | {"previous_truck_id": on_truck.get(s.stop_id)} for s in stops if s.stop_id not in gone]
            frozen = {tid: [dict(load_no=1, depart_min=ld.depart_min, return_min=ld.return_min, cases=ld.cases)] for tid, ld in first.items()}
        else:
            kept = [s.model_dump() for s in stops]
            frozen = {t.id: [dict(load_no=1, depart_min=hm("06:00") + 10 * i, return_min=hm("09:30") + 10 * i, cases=200)]
                      for i, t in enumerate(trucks[:6])}
        tr = [t.model_dump() | {"frozen_trips": frozen.get(t.id, [])} for t in trucks]
        state.append(dict(shape=shape, n=n, seed=seed, stops=kept + late, trucks=tr, locked=sum(len(v) for v in frozen.values())))
        print(f"{shape} n={n} seed={seed}: {state[-1]['locked']} locked loads, {len(kept)} stops + {len(late)} late", flush=True)
    with open(out, "w") as f:
        json.dump(state, f, indent=1)


def run(state_path: str, out: str, root: str) -> None:
    state_path, out = os.path.abspath(state_path), os.path.abspath(out)
    _use(root)
    from dispatch_models import DispatchStop, DispatchTruck, FrozenTrip
    from dispatch_solver import optimize_dispatch
    from tests.test_dispatch import rec, req

    res = []
    with open(state_path) as f:
        days = json.load(f)
    for day in days:
        stops = [DispatchStop(**{k: v for k, v in d.items() if k in DispatchStop.model_fields}) for d in day["stops"]]
        trucks = []
        for d in day["trucks"]:
            d = {k: v for k, v in d.items() if k in DispatchTruck.model_fields}
            d["frozen_trips"] = [FrozenTrip(**x) for x in d.get("frozen_trips", [])]
            trucks.append(DispatchTruck(**d))
        t0 = time.perf_counter()
        sc = rec(optimize_dispatch(req(stops, trucks, **CFG)))
        loads = [dict(truck_id=l.truck_id, depart_min=l.depart_min, return_min=l.return_min, km=l.distance_km) for l in sc.loads]
        res.append(dict(n=day["n"], seed=day["seed"], wall=round(time.perf_counter() - t0, 1), unserved=len(sc.unserved),
                        late_unserved=sum(1 for u in sc.unserved if u.stop_id.startswith("L")), loads=loads,
                        km=round(sc.total_distance_km, 1)))
        print(f"n={day['n']} seed={day['seed']}: {len(loads)} new loads, {res[-1]['km']} km, unserved {res[-1]['unserved']}", flush=True)
    with open(out, "w") as f:
        json.dump(res, f, indent=1)


def compare(state_path: str, a_path: str, b_path: str) -> None:
    paths = [os.path.abspath(p) for p in (state_path, a_path, b_path)]
    _use(HERE)
    import costing

    rates = costing.DayRates(driver_per_hour=CFG["driver_cost_per_hour"], overtime_per_hour=CFG["overtime_cost_per_hour"],
                             overtime_after_s=CFG["overtime_after_min"] * 60, fuel_price_per_litre=CFG["fuel_price_per_litre"])
    days, a, b = (json.load(open(p)) for p in paths)

    def money(day, loads):
        total, in_day = 0.0, set()
        for t in day["trucks"]:
            mine = sorted((l for l in loads if l["truck_id"] == t["id"]), key=lambda l: l["depart_min"])
            fz = t["frozen_trips"]
            if fz or mine:
                in_day.add(t["id"])
            if mine:
                total += costing.truck_day_costs(
                    costing.TruckRates(fixed=t["fixed_cost"], trip=t["trip_cost"], per_km=t["cost_per_km"], km_per_litre=t["km_per_litre"]),
                    rates, [costing.LoadTiming(l["depart_min"] * 60, l["return_min"] * 60, l["km"]) for l in mine],
                    anchor_s=min(f["depart_min"] for f in fz) * 60 if fz else None,
                    frozen_return_s=max(f["return_min"] for f in fz) * 60 if fz else None).total
        return total, len(in_day)

    print("| Day | Version | Unserved | New loads | Trucks in the day | km (new loads) | Cost of new loads (OMR) |")
    print("|---|---|---|---|---|---|---|")
    tot = {"A": [0, 0, 0.0, 0.0], "B": [0, 0, 0.0, 0.0]}
    for i, day in enumerate(days):
        for name, r in (("A", a[i]), ("B", b[i])):
            cost, trucks = money(day, r["loads"])
            t = tot[name]
            t[0] += r["unserved"]; t[1] += len(r["loads"]); t[2] += r["km"]; t[3] += cost  # noqa: E702
            print(f"| {day['n']} stops, seed {day['seed']} | {name} | {r['unserved']} | {len(r['loads'])} | {trucks} | {r['km']:.1f} | {cost:.1f} |")
    for name, t in tot.items():
        print(f"TOTAL {name}: unserved {t[0]}, new loads {t[1]}, km {t[2]:.1f}, cost {t[3]:.1f} OMR")


if __name__ == "__main__":  # required: the options are solved in spawned worker processes
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "state" and len(sys.argv) == 4 and sys.argv[2] in ("late", "half"):
        build_state(sys.argv[2], os.path.abspath(sys.argv[3]))
    elif cmd == "run" and len(sys.argv) in (4, 6):
        run(sys.argv[2], sys.argv[3], os.path.abspath(sys.argv[5]) if len(sys.argv) == 6 and sys.argv[4] == "--root" else HERE)
    elif cmd == "compare" and len(sys.argv) == 5:
        compare(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        print(__doc__)
        sys.exit(2)
