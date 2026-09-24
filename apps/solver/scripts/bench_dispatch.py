"""Benchmark the dispatch optimizer on a synthetic NMWC-like Muscat day (Haversine matrix).

    cd apps/solver && .venv/Scripts/python scripts/bench_dispatch.py 150      # bin/python on Linux/macOS

Prints wall time and, per scenario: solver status, time, trucks, loads, km, cost, unserved.
Keep the 300-stop run in the release checklist (large-day time budget + alternative deadline).
"""
import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

if __name__ == "__main__":  # required: alternatives are solved in spawned worker processes
    from dispatch_solver import optimize_dispatch
    from tests.test_dispatch import nmwc_day, req

    n = int(sys.argv[1]) if len(sys.argv) > 1 else 150
    stops, trucks = nmwc_day(n)
    r = req(stops, trucks, time_limit_sec=None, scenarios=["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"],
            fuel_price_per_litre=0.26, driver_cost_per_hour=2.5)
    t0 = time.perf_counter()
    resp = optimize_dispatch(r)
    print(f"stops {n} wall {time.perf_counter() - t0:.1f}s")
    for s in resp.scenarios:
        print(f"{s.name:13} {s.solver_status:48} {s.solver_time_sec:6.1f}s trucks {s.trucks_used:2} loads {s.trips:2} "
              f"km {s.total_distance_km:8.1f} cost {s.operating_cost:8.1f} unserved {len(s.unserved)}")
        for w in s.warnings:
            print("   warning:", w)
