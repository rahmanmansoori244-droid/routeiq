"""Quick local benchmark: simulate NMWC day-1 against the local solver.

Reads ``apps/web/prisma/synth-data/`` (master + day-1 orders), builds an
OptimizeRequest, and runs the solver three times (one per scenario). Prints
metrics that match what the production run reports — so we can compare the
PyVRP build directly against the previous OR-Tools baseline.

    cd apps/solver
    .venv/Scripts/python scripts/bench_day1.py
"""
from __future__ import annotations

import csv
import math
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve()
SOLVER_DIR = HERE.parent.parent
sys.path.insert(0, str(SOLVER_DIR))

from models import Depot, OptimizeRequest, SolverConfig, Stop, Truck  # noqa: E402
from solver import optimize  # noqa: E402


SYNTH = SOLVER_DIR.parent.parent / "apps" / "web" / "prisma" / "synth-data"


def read_csv(path: Path) -> list[dict]:
    with path.open() as f:
        return list(csv.DictReader(f))


def main() -> None:
    customers = {c["code"]: c for c in read_csv(SYNTH / "master" / "customers.csv")}
    products = {p["code"]: p for p in read_csv(SYNTH / "master" / "products.csv")}
    trucks_csv = read_csv(SYNTH / "master" / "trucks.csv")
    orders_csv = read_csv(SYNTH / "orders" / "orders_2026-05-12.csv")

    # Build depot
    depot = Depot(id="MCT-DEPOT", lat=23.5859, lng=58.4059)

    # Build trucks
    trucks = [
        Truck(
            id=t["code"],
            capacity_cases=int(t["capacity_cases"]),
            capacity_weight_kg=float(t["capacity_weight_kg"]),
            fixed_cost_per_day=float(t["fixed_cost_per_day"]),
            cost_per_km=float(t["cost_per_km"]),
        )
        for t in trucks_csv
    ]

    # Aggregate orders by (customer_code, branch_code) → one Stop per customer-branch
    by_key: dict[str, dict] = {}
    for o in orders_csv:
        key = f"{o['customer_code']}|{o['branch_code'] or '__MAIN__'}"
        if key not in by_key:
            cust = customers[o["customer_code"]]
            by_key[key] = {
                "customer": cust,
                "cases": 0,
                "weight_kg": 0.0,
                "priority": int(o["priority"]),
                "order_ids": [],
            }
        cases = int(o["cases"])
        prod = products[o["product_code"]]
        by_key[key]["cases"] += cases
        by_key[key]["weight_kg"] += cases * float(prod["weight_per_case_kg"])
        by_key[key]["order_ids"].append(o["customer_code"])

    stops: list[Stop] = []
    for key, agg in by_key.items():
        cust = agg["customer"]
        stops.append(
            Stop(
                order_id=f"O-{key}",
                customer_id=cust["code"],
                lat=float(cust["lat"]) if cust["lat"] else 0.0,
                lng=float(cust["lng"]) if cust["lng"] else 0.0,
                demand_cases=agg["cases"],
                demand_weight_kg=agg["weight_kg"],
                service_time_min=int(cust["avg_service_time_min"]),
                priority=agg["priority"],
            )
        )

    print(f"Day-1: {len(stops)} stops, {len(trucks)} trucks, total demand "
          f"{sum(s.demand_cases for s in stops)} cases, fleet capacity "
          f"{sum(t.capacity_cases for t in trucks)} cases.")

    req = OptimizeRequest(
        run_id="bench-day1",
        tenant_id="nmwc",
        depot=depot,
        trucks=trucks,
        stops=stops,
        config=SolverConfig(
            avg_speed_kmh=40,
            distance_provider="HAVERSINE",
            distance_multiplier=1.30,
            driver_shift_max_min=540,
            solver_time_limit_sec=int(os.environ.get("BENCH_TIME_LIMIT", "30")),
        ),
    )

    t0 = time.time()
    res = optimize(req)
    elapsed = time.time() - t0
    print(f"\nSolved in {elapsed:.1f}s wall-clock (parallel across {len(res.scenarios)} scenarios).\n")

    print(f"{'name':<14} {'trucks':>7} {'est_km':>9} {'cost_omr':>10} {'util%':>7} {'served':>7} {'dropped':>8}")
    print("-" * 70)
    for s in res.scenarios:
        served = sum(len(r.stops) for r in s.routes)
        print(f"{s.name:<14} {s.trucks_used:>7} {s.total_distance_km:>9.1f} "
              f"{s.total_cost:>10.2f} {s.avg_utilization_pct:>7.1f} "
              f"{served:>7} {len(s.unserved_orders):>8}")

    # Priority breakdown of drops for BALANCED
    bal = next((s for s in res.scenarios if s.name == "BALANCED"), None)
    if bal is None:
        return
    drop_priority: dict[int, int] = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0}
    order_to_stop = {s.order_id: s for s in stops}
    for u in bal.unserved_orders:
        p = order_to_stop[u.order_id].priority if u.order_id in order_to_stop else 0
        drop_priority[p] = drop_priority.get(p, 0) + 1
    print(f"\nBALANCED unserved by priority: {drop_priority}")
    pass_fail = "PASS" if drop_priority[1] == 0 else "FAIL"
    print(f"Priority-inverted drop correctness check: {pass_fail} (P1 drops: {drop_priority[1]})")


if __name__ == "__main__":
    main()
