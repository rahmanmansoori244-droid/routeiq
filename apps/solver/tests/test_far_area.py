"""Far-area grouping (far_area.py; SOLVER_FAR_AREA, off by default): a far area that the route search spread over
several loads is searched again with its stops on the fewest trucks that can carry it, and an option takes that
plan only when it is not worse on its own goal and passes the same checks as every plan.

Synthetic data only (the repository is public): an invented corridor of stops 32-55 km south-west of the test
depot with late receiving hours, city stops within 12 km with morning hours, and trucks of 12, 12 and 5 bays.
The keep rule runs on hand-built plans in-process (the load repacks give no answer where a test needs the plans
exactly as given); the solves with worker processes take their faults from the ROUTEIQ_TEST_* hooks.
"""
from __future__ import annotations

import logging
import math
import os
import re
import subprocess
import sys
import textwrap
import time
from types import SimpleNamespace

import pytest

import best_of as BO
import dispatch_solver as ds
import far_area as FA
import load_repack as LR
import pyvrp_candidate as PV
from dispatch_models import (
    FarAreaInfo,
    FarAreaReport,
    FarAreaResult,
    FeasibilityReport,
    FeasibilityViolation,
    FrozenTrip,
    SearchReport,
)
from tests.test_best_of_stage import raw
from tests.test_dispatch import DEPOT, assert_reconciled, hm, nmwc_day, req, stop, truck
from tests.test_repack import _day_for, assert_plan_rules, matrix_for

HERE = os.path.dirname(__file__)
SOLVER_DIR = os.path.dirname(HERE)
S = ds.COST_SCALE

CORRIDOR = [(32, 229), (37, 231), (42, 228), (47, 233), (51, 230), (55, 232)]  # km, degrees from the depot
CITY = [(4, 10), (6, 80), (7, 150), (9, 300), (5, 200), (11, 40), (8, 260), (10, 120)]
FAR = (0, 1, 2, 3, 4, 5)  # the corridor's stop indices in day()
# Hand-built plans of day(): truck 0 = T12A, 1 = T12B, 2 = T5; stops 0-5 the corridor, 6-13 the city.
SPLIT = {0: [(6, 7, 8, 9), (0, 1, 2)], 1: [(10, 11, 12, 13), (3, 4, 5)]}  # the area on 2 loads of 2 trucks
GROUP = {0: [(6, 7, 8, 9, 10, 11, 12, 13)], 1: [(0, 1, 2, 3, 4, 5)]}  # the area on 1 load
SPLIT_T5 = {0: [(6, 7, 8, 9, 10, 11, 12, 13), (0, 1, 2)], 2: [(3, 4, 5)]}  # T12B not used


def at(km: float, deg: float, base: tuple[float, float] = (DEPOT.lat, DEPOT.lng)) -> tuple[float, float]:
    """The point ``km`` from ``base`` on bearing ``deg`` (spherical destination formula)."""
    r = 6371.0088
    la1, lo1, b, d = math.radians(base[0]), math.radians(base[1]), math.radians(deg), km / r
    la2 = math.asin(math.sin(la1) * math.cos(d) + math.cos(la1) * math.sin(d) * math.cos(b))
    lo2 = lo1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(la1), math.cos(d) - math.sin(la1) * math.sin(la2))
    return round(math.degrees(la2), 6), round(math.degrees(lo2), 6)


def far_stop(i: int, km: float, deg: float, pal: float = 1.5, sid: str | None = None, **kw):
    la, ln = at(km, deg)
    kw.setdefault("hard_start_min", hm("08:00"))
    kw.setdefault("hard_end_min", hm("18:00"))
    kw.setdefault("service_min", 20)
    kw.setdefault("priority", 3)
    return stop(sid or f"F{i}", la, ln, cases=int(pal * 40), demand_pallet_units=int(round(pal * 1000)), **kw)


def city_stop(i: int, km: float, deg: float, pal: float = 1.0, **kw):
    la, ln = at(km, deg)
    kw.setdefault("hard_start_min", hm("07:00"))
    kw.setdefault("hard_end_min", hm("13:00"))
    kw.setdefault("service_min", 15)
    kw.setdefault("priority", 2)
    return stop(f"C{i}", la, ln, cases=int(pal * 40), demand_pallet_units=int(round(pal * 1000)), **kw)


def fleet(**kw):
    return [truck("T12A", cap=1000, bays=12, fixed_cost=20, cost_per_km=0.2, **kw.get("a", {})),
            truck("T12B", cap=1000, bays=12, fixed_cost=kw.get("b_fixed", 20), cost_per_km=0.2),
            truck("T5", cap=500, bays=5, fixed_cost=12, cost_per_km=0.15)]


def day(pal: float = 1.5, far_kw: dict | None = None, trucks=None, **cfg):
    stops = [far_stop(i, km, d, pal, **(far_kw or {})) for i, (km, d) in enumerate(CORRIDOR, 1)]
    stops += [city_stop(i, km, d) for i, (km, d) in enumerate(CITY, 1)]
    cfg.setdefault("shift_start_min", hm("06:00"))
    return req(stops, trucks or fleet(), **cfg)


def check(r, run: FA.Run | None = None, deadline: float | None = None) -> FA.Run:
    run = run or FA.Run(mode="on", search_mode="QUICK", report=FA.new_report("on"))
    d, tds = _day_for(r)
    FA.check(run, d, ds._pricing("RECOMMENDED", r, tds, r.stops), r.depot.lat, r.depot.lng, r.stops, deadline=deadline)
    return run


def stage(r, primary, far_plan=None, *, run: FA.Run | None = None, budget: float = 60.0, names=("RECOMMENDED",)):
    """_post_solve in-process on hand-built plans; returns (results, run)."""
    run = run or FA.Run(mode="on", search_mode="QUICK", report=FA.new_report("on"))
    results = {n: raw(r, primary, n) for n in names}
    ds._post_solve(r, r.stops, ds._truck_days(r), matrix_for(r), 2, [], results, None, time.monotonic() + budget,
                   far_source=raw(r, far_plan) if far_plan is not None else None, far=run)
    return results, run


def loads_of(sc) -> set[tuple[str, tuple[str, ...]]]:
    return {(ld.truck_id, tuple(sorted(st.stop_id for st in ld.stops))) for ld in sc.loads}


@pytest.fixture()
def plans_as_given(monkeypatch):
    """The load repacks give no answer: the candidates are the plans as given (and their recoveries)."""
    monkeypatch.setattr(LR, "repack", lambda *a, **kw: LR.RepackResult(None, "UNKNOWN", 0.0))


@pytest.fixture()
def parallel(monkeypatch):
    """Worker processes as in production, the second search off, enough CPUs for the far-area search."""
    monkeypatch.delenv("SOLVER_PARALLEL", raising=False)
    monkeypatch.delenv("SOLVER_ALLOW_INPROCESS_FALLBACK", raising=False)
    monkeypatch.setenv("SOLVER_PYVRP", "off")
    monkeypatch.setattr(PV, "effective_cpus", lambda: 16)


def _spy_pools(monkeypatch) -> tuple[list, list]:
    pools: list = []
    names: list = []
    init, submit = ds._Workers.__init__, ds._Workers.submit

    def spy_init(self, size, control=None, **kw):
        pools.append((int(size), kw.get("what", "search"), bool(kw.get("join"))))
        init(self, size, control, **kw)

    def spy_submit(self, fn, arg, name):
        names.append(name)
        return submit(self, fn, arg, name)

    monkeypatch.setattr(ds._Workers, "__init__", spy_init)
    monkeypatch.setattr(ds._Workers, "submit", spy_submit)
    return pools, names


# ---------------------------------------------------------------------------------------------
# Settings and contract
# ---------------------------------------------------------------------------------------------

def test_far_area_is_off_by_default_and_reads_its_switch_per_mode(monkeypatch):
    assert FA.mode() == "off" and not FA.groups("QUICK") and not FA.groups("THOROUGH")
    assert FA.startup_line() == "Far-area grouping: off (the default; SOLVER_FAR_AREA unset or off)"
    cases = {"off": ("off", False, False), "0": ("off", False, False), "No": ("off", False, False),
             "report": ("report", False, False), " Thorough ": ("thorough", False, True), "on": ("on", True, True),
             "1": ("on", True, True), "YES": ("on", True, True), "true": ("on", True, True), "maybe": ("off", False, False)}
    for raw_value, (m, quick, thorough) in cases.items():
        monkeypatch.setenv("SOLVER_FAR_AREA", raw_value)
        assert (FA.mode(), FA.groups("QUICK"), FA.groups("THOROUGH")) == (m, quick, thorough), raw_value
    # Read on every solve: the engine starts its far-area state only when it is not off.
    monkeypatch.setenv("SOLVER_FAR_AREA", "report")
    run = FA.start("QUICK")
    assert (run.mode, run.report["status"], run.report["core_km"], run.report["slack_min"]) == ("report", "SKIPPED", 30.0, 0)


def test_far_area_numbers_fall_back_to_their_defaults(monkeypatch):
    for raw_value, want in (("45", 45.0), ("10", 10.0), ("200", 200.0), ("9", 30.0), ("201", 30.0), ("nan", 30.0),
                            ("far", 30.0), ("", 30.0)):
        monkeypatch.setenv("SOLVER_FAR_AREA_KM", raw_value)
        assert FA.core_km() == want, raw_value
    for raw_value, want in (("30", 30), ("0", 0), ("180", 180), ("181", 0), ("-5", 0), ("12.5", 0), ("x", 0)):
        monkeypatch.setenv("SOLVER_FAR_AREA_SLACK_MIN", raw_value)
        assert FA.slack_min() == want, raw_value
    monkeypatch.setenv("SOLVER_FAR_AREA", "sometimes")
    monkeypatch.setenv("SOLVER_FAR_AREA_KM", "9")
    monkeypatch.setenv("SOLVER_FAR_AREA_SLACK_MIN", "30")
    assert FA.unread() == [("SOLVER_FAR_AREA", "sometimes", "off, report, thorough or on"),
                           ("SOLVER_FAR_AREA_KM", "9", "km from 10 to 200")]
    assert FA.startup_line() == ("Far-area grouping: off (the default; SOLVER_FAR_AREA unset or off; SOLVER_FAR_AREA="
                                 "'sometimes' not read (off, report, thorough or on): its default is used; "
                                 "SOLVER_FAR_AREA_KM='9' not read (km from 10 to 200): its default is used)")


def test_ready_and_startup_line_report_the_far_area_switch(monkeypatch):
    from fastapi.testclient import TestClient

    import main

    monkeypatch.setattr(main, "SOLVER_TOKEN", "unit-test-solver-token")
    client = TestClient(main.app)
    body = client.get("/ready", headers={"X-Solver-Token": "unit-test-solver-token"}).json()
    assert body["ok"] is True and body["far_area"] == {"mode": "off", "thorough": False, "quick": False, "core_km": 30.0,
                                                       "slack_min": 0, "unread": []}
    monkeypatch.setenv("SOLVER_FAR_AREA", "thorough")
    monkeypatch.setenv("SOLVER_FAR_AREA_SLACK_MIN", "soon")
    body = client.get("/ready", headers={"X-Solver-Token": "unit-test-solver-token"}).json()
    assert body["ok"] is True and (body["far_area"]["mode"], body["far_area"]["thorough"], body["far_area"]["quick"]) == (
        "thorough", True, False)
    assert body["far_area"]["unread"] == ["SOLVER_FAR_AREA_SLACK_MIN"]
    assert FA.startup_line() == ("Far-area grouping: thorough (THOROUGH plans also search with each far area on its fewest "
                                 "trucks; QUICK plans get the notes only; core 30 km, slack 0 min; SOLVER_FAR_AREA_SLACK_MIN="
                                 "'soon' not read (whole minutes from 0 to 180): its default is used)")


def _ts_block(ts: str, name: str) -> set[str]:
    block = ts.split(f"export interface {name} {{", 1)[1].split("\n}", 1)[0]
    return set(re.findall(r"^\s+(\w+)\??:", block, re.M))


def test_far_area_report_is_optional_round_trips_and_matches_shared_types():
    ts = open(os.path.join(SOLVER_DIR, "..", "..", "packages", "shared-types", "src", "dispatch.ts"), encoding="utf-8").read()
    ts = ts.replace("\r\n", "\n")
    for model in (FarAreaReport, FarAreaInfo, FarAreaResult, SearchReport):
        assert _ts_block(ts, model.__name__) == set(model.model_fields), model.__name__
    assert re.search(r"far_area\?: FarAreaReport \| null;", ts)
    old = {"mode": "QUICK", "cap_sec": 540, "limit_sec": 5, "search_sec": 4.9, "used_sec": 6.2, "stop_reason": "TIME_LIMIT"}
    assert SearchReport.model_validate(old).far_area is None  # a response from before it still reads
    full = SearchReport.model_validate({**old, "far_area": {
        "mode": "on", "status": "USED", "core_km": 30.0, "slack_min": 0, "plan_sec": 0.2, "sent": True,
        "chosen_for": ["RECOMMENDED"],
        "areas": [{"area": "A1", "label": "the 6 stops 32-55 km south-west of the depot", "stops": 6, "km_from": 32.0,
                   "km_to": 55.0, "direction": "south-west", "gap_km": 25.5, "pallet_units": 9000, "min_loads": 1,
                   "min_loads_reason": "PALLETS", "targets": ["T12A"], "pinned": True, "loads_main": 2, "loads_far": 1,
                   "loads_final": 1}],
        "search": {"index": 99, "status": "OPTIMIZED", "rechecked": True},
        "results": [{"option": "RECOMMENDED", "outcome": "GROUPED", "gain_omr": 19.6, "gain_preferences_omr": -2.6,
                     "loads_before": [2], "loads_after": [1]}]}})
    again = SearchReport.model_validate_json(full.model_dump_json())
    assert again == full and again.far_area.areas[0].loads_far == 1 and again.far_area.results[0].outcome == "GROUPED"


def test_a_far_area_report_that_does_not_validate_is_dropped_not_the_plan(caplog):
    assert FA.report_or_none(None) is None
    good = FA.new_report("on")
    rep = FA.report_or_none(good)
    assert isinstance(rep, FarAreaReport) and FA.report_or_none(rep) is rep
    with caplog.at_level("WARNING", logger="routeiq.dispatch"):
        assert FA.report_or_none({**good, "areas": [{"area": "A1"}]}) is None  # no label, stops, km
        state = {"limit": 5, "search_sec": 1.0, "status": "OPTIMIZED", "far_area": {"mode": "on", "status": 5, "sent": "x"}}
        out = ds._search_report("QUICK", 540, state, time.monotonic())
    assert out.far_area is None and out.stop_reason == "TIME_LIMIT"
    assert sum("far-area report left out" in r.getMessage() for r in caplog.records) == 2


def test_far_area_loads_neither_pyvrp_numpy_nor_dispatch_solver():
    """The API process imports it through the engine: it must not load PyVRP's native library or numpy (PR #50),
    nor dispatch_solver (which imports it)."""
    code = textwrap.dedent(
        """
        import sys
        import far_area
        far_area.status(); far_area.startup_line(); far_area.detect(23.0, 58.0, [])
        loaded = sorted(m for m in sys.modules if m.split(".")[0] in ("pyvrp", "numpy", "dispatch_solver"))
        print("LOADED=" + ",".join(loaded))
        """
    )
    r = subprocess.run([sys.executable, "-c", code], cwd=SOLVER_DIR, capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, r.stderr[-3000:]
    assert r.stdout.strip().endswith("LOADED="), r.stdout[-2000:]


# ---------------------------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------------------------

def test_a_radial_corridor_is_one_far_area_with_its_label():
    """25-60 km at 230 +/- 5 degrees: one area (the near stops linked "on the way" to the far ones even 12 km+
    apart), labelled by km and compass only; the city is no area."""
    stops = [far_stop(i, km, d) for i, (km, d) in enumerate([(25, 228), (40, 232), (60, 230)], 1)]  # 15 and 20 km apart
    stops += [city_stop(i, km, d) for i, (km, d) in enumerate(CITY, 1)]
    (a,) = FA.detect(DEPOT.lat, DEPOT.lng, stops)
    assert (a.id, a.stop_ids, a.stops, a.direction, a.short_direction) == ("A1", ("F1", "F2", "F3"), (0, 1, 2), "south-west", "SW")
    assert a.label == "the 3 stops 25-60 km south-west of the depot" and 225 <= a.bearing <= 235
    assert a.gap_km is not None and a.gap_km >= FA.GAP_KM and a.groupable
    (b,) = FA.detect(DEPOT.lat, DEPOT.lng, day().stops)
    assert b.label == "the 6 stops 32-55 km south-west of the depot" and FA.groupable([b]) == [b]


def test_a_suburb_that_runs_on_from_the_city_is_not_a_far_area():
    """Stops every 7 km from the city out to 32 km: the far end is within GAP_KM of the next stop in, so it is a
    suburb, not an area; the same far stops with a gap in front are one."""
    run_on = [far_stop(i, km, 300, sid=f"S{i}") for i, km in enumerate((11, 18, 25, 32), 1)]
    city = [city_stop(i, km, d) for i, (km, d) in enumerate(CITY, 1)]
    assert FA.detect(DEPOT.lat, DEPOT.lng, run_on + city) == []
    gapped = [far_stop(i, km, 300, sid=f"S{i}") for i, km in enumerate((25, 32), 1)]
    (a,) = FA.detect(DEPOT.lat, DEPOT.lng, gapped + city)
    assert a.stop_ids == ("S1", "S2") and a.direction == "north-west"


def test_two_corridors_are_two_areas_and_a_lone_far_stop_is_never_pinned():
    stops = day().stops + [far_stop(10 + i, km, d, sid=f"E{i}") for i, (km, d) in enumerate([(35, 120), (45, 118)], 1)]
    stops += [far_stop(20, 66, 10, sid="N1")]
    areas = FA.detect(DEPOT.lat, DEPOT.lng, stops)
    assert [(a.id, a.stop_ids, a.direction) for a in areas] == [
        ("A1", ("E1", "E2"), "south-east"), ("A2", ("F1", "F2", "F3", "F4", "F5", "F6"), "south-west"),
        ("A3", ("N1",), "north")]
    assert areas[2].label == "the stop 66 km north of the depot" and not areas[2].groupable
    assert [a.id for a in FA.groupable(areas)] == ["A1", "A2"]
    # At most MAX_AREAS: the most stops first.
    third = [far_stop(30 + i, km, 60, sid=f"Q{i}") for i, km in enumerate((40, 44, 48), 1)]
    many = FA.detect(DEPOT.lat, DEPOT.lng, stops + third)
    assert sorted(len(a.stop_ids) for a in FA.groupable(many)) == [3, 6]


def test_areas_do_not_depend_on_the_stop_order():
    import random

    base = day().stops + [far_stop(10 + i, km, d, sid=f"E{i}") for i, (km, d) in enumerate([(35, 120), (45, 118)], 1)]
    want = [(a.id, a.stop_ids, a.label, a.bearing, a.gap_km) for a in FA.detect(DEPOT.lat, DEPOT.lng, base)]
    rnd = random.Random(5)
    for _ in range(10):
        shuffled = base[:]
        rnd.shuffle(shuffled)
        got = FA.detect(DEPOT.lat, DEPOT.lng, shuffled)
        assert [(a.id, a.stop_ids, a.label, a.bearing, a.gap_km) for a in got] == want
        assert all([shuffled[k].stop_id for k in a.stops] == list(a.stop_ids) for a in got)


def test_the_core_distance_setting_moves_the_threshold(monkeypatch):
    near = [far_stop(i, km, 230) for i, km in enumerate((22, 26), 1)] + [city_stop(i, km, d) for i, (km, d) in enumerate(CITY, 1)]
    assert FA.detect(DEPOT.lat, DEPOT.lng, near) == []  # farthest 26 km < 30
    monkeypatch.setenv("SOLVER_FAR_AREA_KM", "25")
    assert [a.stop_ids for a in FA.detect(DEPOT.lat, DEPOT.lng, near)] == [("F1", "F2")]
    monkeypatch.setenv("SOLVER_FAR_AREA_KM", "60")
    assert FA.detect(DEPOT.lat, DEPOT.lng, day().stops) == []
    assert [a.stop_ids for a in FA.detect(DEPOT.lat, DEPOT.lng, day().stops, core=50)] == [FA.groupable(FA.detect(
        DEPOT.lat, DEPOT.lng, day().stops, core=30))[0].stop_ids]


def test_parts_of_one_customer_stay_in_one_area_and_one_load():
    """A split order (two stops of one customer at one place) is one area and one block: no cut of the area's
    round separates its parts."""
    r = day()
    part = r.stops[2].model_copy(update={"stop_id": "F3b", "order_ids": ["o-F3b"]})
    r = req(list(r.stops[:3]) + [part] + list(r.stops[3:]), fleet(), shift_start_min=hm("06:00"))
    (a,) = FA.detect(DEPOT.lat, DEPOT.lng, r.stops)
    assert "F3" in a.stop_ids and "F3b" in a.stop_ids
    d, _ = _day_for(r)
    for tour in FA._tours(d, list(a.stops), time.monotonic() + 1):
        assert (2, 3) in tour, tour  # the two parts together, one block
        for k in (2, 3):
            cut = FA._cut(d, tour, k, lambda f: True, False, {})
            assert cut is not None and any(2 in load and 3 in load for load in cut)


# ---------------------------------------------------------------------------------------------
# The route check: fewest loads, targets, pins, sending
# ---------------------------------------------------------------------------------------------

def test_fewest_loads_by_pallets():
    """9 pallets fit one 12-bay truck (1 load, PALLETS); 15 pallets need 2 loads (PALLETS: the room bound), on one
    truck when its day allows; the explanation names the pallets and one load's room."""
    run = check(day())
    nd = run.needs["A1"]
    assert (nd.reason, nd.min_loads, nd.room_bound, nd.one_truck, nd.pallet_units, nd.biggest_room) == (
        "PALLETS", 1, 1, True, 9000, 12000)
    assert nd.targets in (("T12A",), ("T12B",)) and run.pins == {f"F{i}": nd.targets for i in range(1, 7)}
    big = check(day(pal=2.5)).needs["A1"]
    assert (big.reason, big.min_loads, big.room_bound, big.pallet_units) == ("PALLETS", 2, 2, 15000)
    info = check(day(pal=2.5)).report["areas"][0]
    assert (info["min_loads"], info["min_loads_reason"], info["pinned"], info["pallet_units"]) == (2, "PALLETS", True, 15000)


def test_fewest_loads_by_the_days_time():
    """3 pallets but 2 h unloading at each of six stops: one load cannot do it in a day (TIME); two loads can."""
    run = check(day(pal=0.5, far_kw={"service_min": 120}))
    nd = run.needs["A1"]
    assert (nd.reason, nd.room_bound, nd.unload_min) == ("TIME", 1, 720)
    assert nd.min_loads == 2 and len(nd.targets) in (1, 2) and run.pins


def test_targets_keep_small_truck_lists_frozen_loads_and_the_latest_return():
    # Small-truck-only stops (the T5 only, 4.5 pallets): the area's target is the T5.
    r = day(pal=0.75, far_kw={"allowed_truck_ids": ["T5"], "allowed_trucks_label": "a small truck"})
    nd = check(r).needs["A1"]
    assert (nd.reason, nd.min_loads, nd.targets) == ("PALLETS", 1, ("T5",))
    # A truck busy with a frozen load until 14:00 returns later than an idle one: the idle one is the target.
    frozen = [FrozenTrip(load_no=1, depart_min=hm("06:00"), return_min=hm("14:00"), cases=100)]
    r = day(trucks=fleet(a={"frozen_trips": frozen}))
    nd = check(r).needs["A1"]
    assert nd.targets == ("T12B",)
    assert nd.back_s is not None and nd.back_s < hm("14:00") * 60 + 5 * 3600
    # A latest return before the area can be done: no truck, nothing pinned.
    run = check(day(latest_return_min=hm("10:00")))
    assert run.needs["A1"].reason == "NO_TRUCK" and run.pins == {}


def test_two_areas_get_different_trucks_and_the_route_check_keeps_its_deadline():
    east = [far_stop(10 + i, km, d, sid=f"E{i}") for i, (km, d) in enumerate([(35, 120), (45, 118)], 1)]
    r = req(list(day().stops) + east, fleet(), shift_start_min=hm("06:00"))
    run = check(r)
    a1, a2 = run.needs["A1"], run.needs["A2"]
    assert a1.targets and a2.targets and not set(a1.targets) & set(a2.targets)
    assert run.report["plan_sec"] is not None and run.report["plan_sec"] <= FA.PLAN_SEC + 0.5
    late = check(r, deadline=time.monotonic() - 1)
    assert {nd.reason for nd in late.needs.values()} == {"OUT_OF_TIME"} and late.pins == {}


def test_pins_only_narrow_the_allowed_trucks_and_keep_the_stop_order():
    r = day()
    r = req([s.model_copy(update={"allowed_truck_ids": ["T12B", "T5"]}) if s.stop_id == "F2" else s for s in r.stops]
            + [stop("Z9", 23.6, 58.4, demand_pallet_units=500, allowed_truck_ids=["T5"])], fleet(),
            shift_start_min=hm("06:00"))
    pins = {"F1": ("T12A", "T12B"), "F2": ("T12A", "T12B"), "Z9": ("T12A",)}
    req_v, stops_v = FA.pinned(r, r.stops[:3] + r.stops[-1:], pins)
    assert [s.stop_id for s in req_v.stops] == [s.stop_id for s in r.stops]
    assert [s.stop_id for s in stops_v] == ["F1", "F2", "F3", "Z9"]
    by = {s.stop_id: s for s in req_v.stops}
    assert by["F1"].allowed_truck_ids == ["T12A", "T12B"] and by["F1"].allowed_trucks_label == FA.PIN_LABEL
    assert by["F2"].allowed_truck_ids == ["T12B"]  # its own list, narrowed
    assert by["F3"] is r.stops[2] and by["Z9"] is r.stops[-1]  # not pinned / never emptied
    for a, b in zip(r.stops, req_v.stops):
        assert a.model_dump(exclude={"allowed_truck_ids", "allowed_trucks_label"}) == b.model_dump(
            exclude={"allowed_truck_ids", "allowed_trucks_label"})
    assert r.stops[0].allowed_truck_ids is None  # the request itself is untouched


def test_the_twin_plan_is_sent_only_when_it_groups():
    one, two, three = (1, 1, 6), (2, 2, 6), (3, 2, 6)
    assert FA.should_send([two], [one], [True], stopped=False, main_stuck=False) == (True, None)
    assert FA.should_send([one], [one], [True], stopped=False, main_stuck=False) == (False, "NO_FEWER_LOADS")
    assert FA.should_send([two, one], [one, two], [True, True], stopped=False, main_stuck=False) == (False, "NO_FEWER_LOADS")
    assert FA.should_send([two], [one], [False], stopped=False, main_stuck=False) == (False, "NO_FEWER_LOADS")  # not pinned
    assert FA.should_send([three, one], [two, one], [True, False], stopped=False, main_stuck=False) == (True, None)
    assert FA.should_send([two], [one], [True], stopped=True, main_stuck=False) == (False, "STOPPED")
    assert FA.should_send([two], [one], [True], stopped=False, main_stuck=True) == (False, "MAIN_STUCK")
    assert FA.should_send(None, [one], [True], stopped=False, main_stuck=False) == (False, "NO_MAIN_PLAN")
    # An area the main plan already has on the route check's fewest loads is never regrouped (the owner: a needed
    # second truck is never taken away), whatever the twin found; above it, the twin's plan is sent even when it
    # leaves area stops out (the load re-check may put them back; the keep rule judges that).
    assert FA.should_send([two], [one], [True], stopped=False, main_stuck=False, mins=[2]) == (False, "AT_MIN_LOADS")
    assert FA.should_send([two], [one], [True], stopped=False, main_stuck=False, mins=[1]) == (True, None)
    assert FA.should_send([three], [one], [True], stopped=False, main_stuck=False, mins=[2]) == (True, None)
    assert FA.should_send([two, three], [one, three], [True, True], stopped=False, main_stuck=False, mins=[2, 2]) == (
        False, "NO_FEWER_LOADS")
    r = day()
    ids = frozenset(f"F{i}" for i in range(1, 7))
    assert FA.scenario_counts(raw(r, SPLIT), ids) == (2, 2, 6) and FA.scenario_counts(raw(r, GROUP), ids) == (1, 1, 6)
    assert FA.plan_counts(SPLIT, frozenset(FAR)) == (2, 2, 6) and FA.fewer_loads(GROUP, SPLIT, [frozenset(FAR)])


# ---------------------------------------------------------------------------------------------
# The keep rule on the load re-check (hand-built plans, _post_solve in-process)
# ---------------------------------------------------------------------------------------------

def _engine_jobs(monkeypatch) -> list[dict]:
    seen: list[dict] = []
    real = ds._stage_worker
    monkeypatch.setattr(ds, "_stage_worker", lambda job: seen.append({k: v for k, v in job.items() if k != "day"}) or real(job))
    return seen


def test_without_a_far_source_the_stage_is_exactly_as_before(monkeypatch, plans_as_given):
    seen = _engine_jobs(monkeypatch)
    monkeypatch.setattr(FA, "stage_in_worker", lambda job: pytest.fail("a far-area stage job ran"))
    r = day()
    off = {"RECOMMENDED": raw(r, SPLIT)}
    ds._post_solve(r, r.stops, ds._truck_days(r), matrix_for(r), 2, [], off, None, time.monotonic() + 60)
    jobs_off = list(seen)
    seen.clear()
    on, run = stage(r, SPLIT)  # far-area state, no plan from the twin search
    assert seen == jobs_off and loads_of(on["RECOMMENDED"]) == loads_of(off["RECOMMENDED"])
    assert on["RECOMMENDED"].warnings == off["RECOMMENDED"].warnings and run.report["results"] == []


def test_the_far_source_has_its_own_stage_job_and_never_changes_the_engines(monkeypatch, plans_as_given):
    seen = _engine_jobs(monkeypatch)
    far_jobs: list[dict] = []
    real = FA.stage_in_worker
    monkeypatch.setattr(FA, "stage_in_worker", lambda job: far_jobs.append(job) or real(job))
    r = day(scenarios=["RECOMMENDED", "MIN_TRUCKS"])
    stage(r, SPLIT, names=("RECOMMENDED", "MIN_TRUCKS"))
    without = list(seen)
    seen.clear()
    stage(r, SPLIT, GROUP, names=("RECOMMENDED", "MIN_TRUCKS"))
    assert seen == without and all([s.name for s in j["sources"]] == ["RECOMMENDED", "MIN_TRUCKS"] for j in seen)
    (job,) = far_jobs
    assert [g for g, _ in job["goals"]] == ["RECOMMENDED", "MIN_TRUCKS"] and LR.plan_of(job["plan"]) == GROUP
    assert job["budget_s"] <= seen[0]["budget_s"] and job["optional"] is None


def test_a_grouped_plan_not_worse_is_used_with_its_note(plans_as_given):
    r = day()
    results, run = stage(r, SPLIT, GROUP)
    sc = results["RECOMMENDED"]
    assert loads_of(sc) == {("T12A", ("C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8")), ("T12B", ("F1", "F2", "F3", "F4", "F5", "F6"))}
    assert_plan_rules(r, sc)
    (note,) = [w for w in sc.warnings if w.startswith("Far area:")]
    assert note.startswith("Far area: the 6 stops 32-55 km south-west of the depot now go on 1 load (1 truck) instead of "
                           "2 (2 trucks). Trucks 2 -> 2, loads 4 -> 2, km ") and note.endswith(
        "It passed the planner's own checks, timing and costs.")
    assert not any(w.startswith("Loads were re-assigned") for w in sc.warnings)
    rep = FA.report_or_none(run.report)
    assert (rep.status, rep.reason, rep.chosen_for) == ("USED", None, ["RECOMMENDED"])
    (res,) = rep.results
    assert (res.outcome, res.loads_before, res.loads_after, res.served_delta, res.gain_loads) == ("GROUPED", [2], [1], 0, 2)
    assert res.gain_omr > 0 and res.gain_km > 50


def _cand(source: str, plan: dict, *, unserved: int = 0, cost: float = 100.0, operating: float | None = None,
          trucks: int = 2, metres: int = 300_000, back_s: int = 15 * 3600) -> LR.Candidate:
    timed = {idx: [LR.TimedLoad(stops=tuple(l), depart_s=8 * 3600, starts=tuple(9 * 3600 for _ in l), return_s=back_s)
                   for l in ls] for idx, ls in plan.items()}
    score = LR.Score(unserved=unserved, cost=int(cost * S), trucks=trucks, loads=sum(len(v) for v in plan.values()),
                     metres=metres, operating=int((cost if operating is None else operating) * S))
    return LR.Candidate(source, timed, score)


DAY18 = SimpleNamespace(by_idx={i: SimpleNamespace(latest_return_s=18 * 3600) for i in range(3)})
AREA = [frozenset(FAR)]


def test_a_tie_with_fewer_area_loads_is_used():
    prev = _cand("RECOMMENDED+repack:RECOMMENDED", SPLIT)
    fc = _cand(FA.SOURCE, GROUP)  # the same cost: a tie on the goal
    v = FA.judge("RECOMMENDED", fc, False, prev, False, AREA, DAY18, 0, 1)
    assert (v.outcome, v.use, v.before, v.after) == ("GROUPED", True, [(2, 2, 6)], [(1, 1, 6)])
    assert v.slack_s == 3 * 3600 and v.gains["gain_omr"] == 0.0
    assert FA.result_of(v)["loads_before"] == [2] and FA.result_of(v)["slack_min"] == 180.0
    # The tie-breaker (a day-paid truck's search tie) never counts against it.
    tied = LR.Candidate(fc.source, fc.plan, LR.Score(**{**fc.score.__dict__, "tie": 99}))
    assert FA.judge("RECOMMENDED", tied, False, prev, False, AREA, DAY18, 0, 1).use


def test_a_dearer_grouped_plan_is_kept_out_and_the_gain_splits_out_the_preferences(plans_as_given):
    """T12B costs 300 OMR a day: the plan with the area on it alone is dearer, so RECOMMENDED keeps the plan without
    it, the report splits the customers' time preferences out of the gain, and the line on the plan says why."""
    r = day(trucks=fleet(b_fixed=300))
    results, run = stage(r, SPLIT_T5, GROUP)
    sc = results["RECOMMENDED"]
    assert loads_of(sc) == loads_of(raw(r, SPLIT_T5)) and sc.feasibility.status == "VERIFIED"
    assert not any(w.startswith("Far area:") for w in sc.warnings)
    (res,) = run.report["results"]
    assert res["outcome"] == "KEPT_NOT_BETTER" and res["gain_omr"] < -200
    assert res["gain_omr"] == pytest.approx(res["gain_operating_omr"] + res["gain_preferences_omr"], abs=0.01)
    assert (run.report["status"], run.report["reason"]) == ("NOT_USED", "NOT_BETTER")
    # The explanation on the final plan (what _far_finish adds after the priority repair).
    check(r, run)
    counts = [FA.scenario_counts(sc, frozenset(a.stop_ids)) for a in run.areas]
    (line,) = FA.explain_lines(run, counts)
    assert line.startswith("Far area: the 6 stops 32-55 km south-west of the depot are on 2 loads (2 trucks): a plan "
                           "with them on 1 load was checked: it costs ") and "OMR more to run (" in line
    assert "of it" not in line  # never one part "of" the whole


def test_the_dearer_line_gives_each_part_its_own_sign():
    """Review of the build: "it costs 49 OMR more (the customers' preferred hours 67 OMR of it)" for a plan 17 OMR
    cheaper to run - the part was bigger than the whole, and most of it was orders moved off their previous truck,
    not preferred hours. Each part now says what it is, with its own sign."""
    def v(omr, operating, prefs, km, moved=(None, None)):
        return FA.Verdict("RECOMMENDED", "KEPT_NOT_BETTER", gains={
            "gain_omr": omr, "gain_operating_omr": operating, "gain_preferences_omr": prefs, "gain_km": km},
            moved_before=moved[0], moved_after=moved[1])

    assert FA.dearer_text(v(-49.4, 17.2, -66.6, 159.0, (5, 24))) == (
        "it is 17 OMR cheaper to run and 159 km shorter, but its preference cost is 67 OMR higher (19 more orders on "
        "another truck than in the previous plan), so 49 OMR more in all")
    assert FA.dearer_text(v(-25.0, -30.0, 5.0, -10.0)) == (
        "it costs 30 OMR more to run (10 km longer), and its preference cost is only 5 OMR lower, so 25 OMR more in all")
    both = FA.dearer_text(v(-40.0, -15.0, -25.0, -20.0, (0, 0)))
    assert both.startswith("it costs 40 OMR more: 15 OMR more to run (20 km longer) and 25 OMR more in preference cost (")
    for text in (both, FA.dearer_text(v(-49.4, 17.2, -66.6, 159.0))):
        assert "of it" not in text and "-" not in text


def test_a_grouped_plan_that_serves_less_by_priority_is_never_used():
    prev = _cand("RECOMMENDED", SPLIT, cost=120.0)
    # Cheaper by 60 OMR, but one P5 stop more is left out: service first, however cheap.
    fc = _cand(FA.SOURCE, {0: [(6, 7, 8, 9, 10, 11, 12)], 1: [FAR]}, unserved=1, cost=60.0)
    v = FA.judge("RECOMMENDED", fc, False, prev, False, AREA, DAY18, 0, 1)
    assert (v.outcome, v.use) == ("KEPT_SERVES_LESS", False)
    # A candidate that serves less than the option's own plan (lost) when prev does not: never.
    v = FA.judge("RECOMMENDED", _cand(FA.SOURCE, GROUP, cost=60.0), True, prev, False, AREA, DAY18, 0, 1)
    assert v.outcome == "KEPT_SERVES_LESS"
    # No grouped candidate at all: why.
    assert FA.judge("RECOMMENDED", None, False, prev, False, AREA, DAY18, 0, 3).outcome == "KEPT_NO_FEWER_LOADS"
    assert FA.judge("RECOMMENDED", None, False, prev, False, AREA, DAY18, 0, 0).outcome == "NO_CANDIDATE"


def test_a_same_priority_swap_is_not_used_but_a_higher_priority_gain_is():
    # prev leaves stop 13 out; the grouped plan serves it but leaves 12 out instead - same service value: a swap.
    prev = _cand("RECOMMENDED", {0: [(6, 7, 8, 9), (0, 1, 2)], 1: [(10, 11, 12), (3, 4, 5)]}, unserved=10, cost=100.0)
    swap = _cand(FA.SOURCE, {0: [(6, 7, 8, 9, 10, 11, 13)], 1: [FAR]}, unserved=10, cost=90.0)
    v = FA.judge("RECOMMENDED", swap, False, prev, False, AREA, DAY18, 0, 1)
    assert (v.outcome, v.use, v.added, v.dropped) == ("KEPT_SWAP", False, 1, 1)
    # Strictly better by priority (a higher one in, a lower one out): used, and the note says what it left out.
    gain = _cand(FA.SOURCE, {0: [(6, 7, 8, 9, 10, 11, 13)], 1: [FAR]}, unserved=4, cost=110.0)
    v = FA.judge("RECOMMENDED", gain, False, prev, False, AREA, DAY18, 0, 1)
    assert (v.outcome, v.use) == ("GROUPED", True)
    (a,) = FA.detect(DEPOT.lat, DEPOT.lng, day().stops)
    note = FA.grouped_note(v, [a])
    assert "It serves the day better by priority: it plans 1 stop left out without it, and 1 other stop is left out in " \
           "their place (see Unserved orders)." in note
    assert "operating cost 100 -> 110 OMR" in note


def test_grouping_never_leaves_out_an_area_stop_or_goes_below_the_fewest_loads():
    """Review of the validation (20 Oct): the area needed 2 loads (TIME) and the grouped plan reached 1 by leaving
    out the area's biggest order, while serving another area stop the plan without it had left out - the same
    count of area stops, better by strict priority - and it was used. The area rule compares SETS of area stops,
    and never goes below the route check's fewest loads."""
    # prev: area stops 0-4 on 2 loads (5 out), city 13 out; the "grouped" plan: 0-3 and 5 on 1 load (4 out), city
    # 13 served instead of 12 - better by priority, the same area count, one area stop swapped for another.
    prev = _cand("RECOMMENDED", {0: [(6, 7, 8, 9), (0, 1, 2)], 1: [(10, 11, 12), (3, 4)]}, unserved=20, cost=100.0)
    swap = _cand(FA.SOURCE, {0: [(6, 7, 8, 9, 10, 11, 13)], 1: [(0, 1, 2, 3, 5)]}, unserved=10, cost=90.0)
    for mins in (None, [2], [1]):
        v = FA.judge("RECOMMENDED", swap, False, prev, False, AREA, DAY18, 0, 1, mins)
        assert (v.outcome, v.use, v.before, v.after, v.area_left) == ("KEPT_AREA_STOP_OUT", False, [(2, 2, 5)], [(1, 1, 5)], [1])
    # The same area stops on fewer loads: below the fewest loads (2, TIME) never; at or above them, grouped.
    same = _cand(FA.SOURCE, {0: [(6, 7, 8, 9, 10, 11, 12)], 1: [(0, 1, 2, 3, 4)]}, unserved=20, cost=90.0)
    assert FA.judge("RECOMMENDED", same, False, prev, False, AREA, DAY18, 0, 1, [2]).outcome == "KEPT_BELOW_MIN_LOADS"
    assert FA.judge("RECOMMENDED", same, False, prev, False, AREA, DAY18, 0, 1, [1]).use
    assert FA.judge("RECOMMENDED", same, False, prev, False, AREA, DAY18, 0, 1, None).use
    # More area stops served than without it is fine (none of prev's is left out).
    more = _cand(FA.SOURCE, {0: [(6, 7, 8, 9, 10, 11, 12)], 1: [FAR]}, unserved=15, cost=95.0)
    assert FA.area_rule(more.plan, prev.plan, AREA, [1]) is None
    assert FA.judge("RECOMMENDED", more, False, prev, False, AREA, DAY18, 0, 1, [1]).outcome == "GROUPED"
    # A candidate with the area left out entirely (a far fit repack came back with no loads on 21 Oct: "the area on
    # 0 loads") is never on fewer loads - not judged at all, and never sent.
    empty = _cand(FA.SOURCE + "+fit:RECOMMENDED", {}, unserved=999, cost=0.0)
    assert not FA.fewer_loads(empty.plan, prev.plan, AREA)
    assert FA.judge("RECOMMENDED", empty, True, prev, False, AREA, DAY18, 0, 1, [2]).outcome == "KEPT_NO_FEWER_LOADS"
    assert FA.should_send([(3, 3, 9)], [(0, 0, 0)], [True], stopped=False, main_stuck=False, mins=[2]) == (
        False, "NO_FEWER_LOADS")
    # In a report: its own reason.
    run = FA.Run(mode="on", search_mode="QUICK", report=FA.new_report("on"))
    FA.judged(run, {"RECOMMENDED": FA.judge("RECOMMENDED", swap, False, prev, False, AREA, DAY18, 0, 1, [2])})
    assert (run.report["status"], run.report["reason"]) == ("NOT_USED", "AREA_STOP_OUT")


def test_the_notes_count_the_area_stops_a_plan_carries():
    """Review of the build: "the 10 stops ... now go on 1 load" when it carried 9, and "the 7 stops ... are on 2
    loads" when 6 were planned. The notes name the area stops the plan carries and how many are left out."""
    (a,) = FA.detect(DEPOT.lat, DEPOT.lng, day().stops)
    prev = _cand("RECOMMENDED", {0: [(6, 7, 8, 9), (0, 1, 2)], 1: [(10, 11, 12, 13), (3, 4)]}, unserved=10)
    fc = _cand(FA.SOURCE, {0: [(6, 7, 8, 9, 10, 11, 12, 13)], 1: [(0, 1, 2, 3, 4)]}, unserved=10)
    v = FA.judge("RECOMMENDED", fc, False, prev, False, AREA, DAY18, 0, 1)
    assert v.use
    assert FA.grouped_note(v, [a]).startswith(
        "Far area: 5 of the 6 stops 32-55 km south-west of the depot now go on 1 load (1 truck) instead of 2 (2 trucks) "
        "(1 stop of the area is left out, as without this step: see Unserved orders). Trucks 2 -> 2, loads 4 -> 2")
    run = check(day(pal=2.5))
    (line,) = FA.explain_lines(run, [(2, 2, 5)])
    assert line == ("Far area: 5 of the 6 stops 32-55 km south-west of the depot are on 2 loads (2 trucks): the whole "
                    "area's 15.0 pallets need at least 2 loads (one load holds at most 12.0 pallets). 1 other stop of "
                    "the area is left out (see Unserved orders).")
    (line,) = FA.explain_lines(run, [(2, 2, 6)])
    assert line.startswith("Far area: the 6 stops 32-55 km south-west of the depot are on 2 loads (2 trucks): their 15.0")
    assert a.label_of(6) == a.label and a.label_of(None) == a.label


def _real(r, plan: dict, source: str) -> LR.Candidate:
    """A load re-check candidate of ``r``: ``plan`` timed exactly and scored as the stage scores it."""
    d, tds = _day_for(r)
    pricing = ds._pricing("RECOMMENDED", r, tds, r.stops)
    timed = LR.time_plan(d, plan, pricing)
    assert timed is not None
    return LR.Candidate(source, timed, LR.score(d, pricing, timed))


def test_a_valid_grouping_is_preferred_and_a_stop_it_leaves_out_says_why(monkeypatch):
    """Two grouped candidates: one serves the day better by priority by leaving out an area stop (never used), one
    keeps every area stop on one load and leaves out a P4 city stop for the P2 one the plan without it left out:
    that one is judged and used, and its left-out stop says that a plan serving the day better took its place -
    not "the loading time" - also once the plan is rebuilt (the priority repair, the hire reduction)."""
    r = day()
    prio = {"C8": 4, "F6": 5}
    r = r.model_copy(update={"stops": [s.model_copy(update={"priority": prio[s.stop_id]}) if s.stop_id in prio else s
                                       for s in r.stops]})
    prev_plan = {0: [(6, 7, 8, 9), (0, 1, 2)], 1: [(10, 11, 13), (3, 4, 5)]}  # C7 (P2, stop 12) out
    good = {0: [(6, 7, 8, 9, 10, 11, 12)], 1: [FAR]}  # the area on 1 load, C7 in, C8 (P4) out
    bad = {0: [(6, 7, 8, 9, 10, 11, 12, 13)], 1: [(0, 1, 2, 3, 4)]}  # better still by priority (P5 out), but F6 out
    monkeypatch.setattr(ds, "_stage_worker", lambda job: ([_real(r, prev_plan, "RECOMMENDED")], []))
    monkeypatch.setattr(FA, "stage_in_worker", lambda job: ([_real(r, bad, FA.SOURCE), _real(r, good, FA.SOURCE)], []))
    results, run = stage(r, prev_plan, good)
    sc = results["RECOMMENDED"]
    assert loads_of(sc) == {("T12A", ("C1", "C2", "C3", "C4", "C5", "C6", "C7")), ("T12B", ("F1", "F2", "F3", "F4", "F5", "F6"))}
    assert sc.feasibility.status == "VERIFIED"
    (res,) = run.report["results"]
    assert (res["outcome"], res["served_delta"], run.report["chosen_for"]) == ("GROUPED", 0, ["RECOMMENDED"])
    (u,) = sc.unserved
    assert u.stop_id == "C8" and u.reason_message.startswith(ds.FAR_DROP_HEAD) and "P4 stop" in u.reason_message
    assert not any(ds.TIMING_DROP_NOTE in w for w in sc.warnings)
    ctx = ds._stage_ctx(r, r.stops, ds._truck_days(r), matrix_for(r), [])
    again = ds._rebuilt(ctx, sc, LR.plan_of(_timed_from(sc, ctx)), None, set(), set())
    assert again is not None and [u.reason_message for u in again.unserved] == [u.reason_message]


def _timed_from(sc, ctx):
    return ds._timed_from_scenario(sc, ctx.stop_idx, ctx.truck_idx)


def test_an_error_in_the_keep_rule_costs_no_option_its_plan(monkeypatch, plans_as_given):
    """Review of the build: the keep rule raising for one option cost the other options their load re-check
    ("internal error") and left a report that contradicted the plan. Now that option keeps the plan it has without
    the step (verdict ERROR), every other option is judged as usual, and the report matches the plans."""
    r = day(scenarios=["RECOMMENDED", "MIN_TRUCKS"])
    names = ("RECOMMENDED", "MIN_TRUCKS")
    without, _ = stage(r, SPLIT, names=names)
    real = FA.judge

    def judge(name, *a, **kw):
        if name == "MIN_TRUCKS":
            raise RuntimeError("test: the keep rule failed")
        return real(name, *a, **kw)

    monkeypatch.setattr(FA, "judge", judge)
    results, run = stage(r, SPLIT, GROUP, names=names)
    mt = results["MIN_TRUCKS"]
    assert loads_of(mt) == loads_of(without["MIN_TRUCKS"]) and mt.feasibility.status == "VERIFIED"
    assert mt.warnings == without["MIN_TRUCKS"].warnings and not any("internal error" in w for w in mt.warnings)
    assert any(w.startswith("Far area:") for w in results["RECOMMENDED"].warnings)
    rep = FA.report_or_none(run.report)
    assert (rep.status, rep.chosen_for) == ("USED", ["RECOMMENDED"])
    assert {x.option: x.outcome for x in rep.results} == {"RECOMMENDED": "GROUPED", "MIN_TRUCKS": "ERROR"}


def test_the_slack_setting_keeps_out_a_late_grouped_load(monkeypatch):
    prev = _cand("RECOMMENDED", SPLIT)
    late = _cand(FA.SOURCE, GROUP, back_s=17 * 3600 + 40 * 60)  # back 20 min before 18:00
    assert FA.judge("RECOMMENDED", late, False, prev, False, AREA, DAY18, 0, 1).use  # 0: the same rules as every plan
    v = FA.judge("RECOMMENDED", late, False, prev, False, AREA, DAY18, 30 * 60, 1)
    assert (v.outcome, v.slack_s, v.back_s) == ("KEPT_SLACK", 20 * 60, 17 * 3600 + 40 * 60)
    ok = FA.judge("RECOMMENDED", _cand(FA.SOURCE, GROUP, back_s=17 * 3600), False, prev, False, AREA, DAY18, 30 * 60, 1)
    assert ok.use and ok.slack_s == 3600
    monkeypatch.setenv("SOLVER_FAR_AREA_SLACK_MIN", "30")
    (a,) = FA.detect(DEPOT.lat, DEPOT.lng, day().stops)
    assert "Its grouped load is back at 17:00, 60 min before the latest return." in FA.grouped_note(ok, [a], FA.slack_min())


def test_a_grouped_plan_failing_the_independent_check_falls_back_with_a_warning(monkeypatch, plans_as_given, caplog):
    real = ds._build_scenario

    def build(name, req_, stops, tds, mx, timed, *a, **kw):
        sc = real(name, req_, stops, tds, mx, timed, *a, **kw)
        if LR.plan_of(timed).get(1) == [FAR]:  # the grouped plan: told it breaks a rule
            sc.feasibility = FeasibilityReport(status="VIOLATED", timing="EXACT", violations=[
                FeasibilityViolation(code="HARD_WINDOW", message="test: a window is missed")])
        return sc

    monkeypatch.setattr(ds, "_build_scenario", build)
    r = day()
    with caplog.at_level("WARNING", logger="routeiq.dispatch"):
        results, run = stage(r, SPLIT, GROUP)
    sc = results["RECOMMENDED"]
    assert loads_of(sc) == loads_of(raw(r, SPLIT)) and sc.feasibility.status == "VERIFIED"
    assert not any(w.startswith("Far area:") for w in sc.warnings)
    assert "the grouped plan failed the independent check (1 violations)" in caplog.text
    assert run.report["results"][0]["outcome"] == "KEPT_NOT_VERIFIED"
    assert (run.report["status"], run.report["reason"], run.report["chosen_for"]) == ("NOT_USED", "NOT_VERIFIED", [])


def test_each_option_judges_the_far_plan_on_its_own_goal():
    """Fewer area loads with fewer trucks but more km: MIN_TRUCKS takes it, MIN_DISTANCE keeps its own (and
    RECOMMENDED by its cost)."""
    prev = _cand("RECOMMENDED", SPLIT, trucks=3, metres=300_000, cost=100.0)
    fc = _cand(FA.SOURCE, GROUP, trucks=2, metres=320_000, cost=101.0)
    assert FA.judge("MIN_TRUCKS", fc, False, prev, False, AREA, DAY18, 0, 1).outcome == "GROUPED"
    assert FA.judge("MIN_DISTANCE", fc, False, prev, False, AREA, DAY18, 0, 1).outcome == "KEPT_NOT_BETTER"
    assert FA.judge("RECOMMENDED", fc, False, prev, False, AREA, DAY18, 0, 1).outcome == "KEPT_NOT_BETTER"
    shorter = _cand(FA.SOURCE, GROUP, trucks=3, metres=250_000, cost=103.0)
    assert FA.judge("MIN_DISTANCE", shorter, False, prev, False, AREA, DAY18, 0, 1).outcome == "GROUPED"


def test_a_failed_or_dead_far_stage_job_costs_only_its_candidates(monkeypatch, plans_as_given):
    """A far-area stage job that raises (in-process) or whose worker process dies (its own pool): every option keeps
    the plan it has without it, VERIFIED, and the report says STAGE_FAILED."""
    import multiprocessing as mp

    r = day()
    monkeypatch.setenv("ROUTEIQ_TEST_FAIL_FAR_STAGE", "1")
    results, run = stage(r, SPLIT, GROUP)
    assert loads_of(results["RECOMMENDED"]) == loads_of(raw(r, SPLIT)) and results["RECOMMENDED"].feasibility.status == "VERIFIED"
    assert (run.report["status"], run.report["reason"], run.report["results"]) == ("FAILED", "STAGE_FAILED", [])
    monkeypatch.delenv("ROUTEIQ_TEST_FAIL_FAR_STAGE")
    monkeypatch.setenv("ROUTEIQ_TEST_KILL_FAR_STAGE", "1")
    pool = ds._Workers(1, None, run_id="t", what="load re-check")
    far_pool = ds._Workers(1, None, run_id="t", what="other route searches", join=True)
    try:
        run = FA.Run(mode="on", search_mode="QUICK", report=FA.new_report("on"))
        results = {"RECOMMENDED": raw(r, SPLIT)}
        ds._post_solve(r, r.stops, ds._truck_days(r), matrix_for(r), 2, [], results, pool, time.monotonic() + 120,
                       far_source=raw(r, GROUP), far_pool=far_pool, far=run)
    finally:
        far_pool.close()
        pool.close()
    sc = results["RECOMMENDED"]
    assert sc.feasibility.status == "VERIFIED" and len(sc.unserved) == 0
    assert not any(w.startswith("Far area:") for w in sc.warnings)
    assert (run.report["status"], run.report["reason"]) == ("FAILED", "STAGE_FAILED")
    assert mp.active_children() == []


# ---------------------------------------------------------------------------------------------
# The engine (worker processes, or in-process with the route search replaced by a hand-built plan)
# ---------------------------------------------------------------------------------------------

def _fake_search(plan):
    def fake(name, req_, stops, tds, mx, *a, **kw):
        assert [s.stop_id for s in stops] == [s.stop_id for s in req_.stops]
        return raw(req_, plan, name)
    return fake


def test_off_starts_nothing_and_changes_nothing(parallel, monkeypatch):
    """The default: no other searches' pool, the route check never runs, RECOMMENDED's limit and the re-check's
    sources as without the step, and search.far_area null."""
    pools, names = _spy_pools(monkeypatch)
    monkeypatch.setattr(FA, "check", lambda *a, **k: pytest.fail("the route check ran"))
    monkeypatch.setattr(FA, "detect", lambda *a, **k: pytest.fail("detection ran"))
    r = day(time_limit_sec=1)
    resp = ds.optimize_dispatch(r)
    assert pools == [(1, "search", False)] and names.count("RECOMMENDED") == 1 and FA.SOURCE not in names
    assert not any(n == "stage:far" for n in names)
    assert resp.search.far_area is None and resp.search.best_of is None and resp.search.limit_sec == 1
    rec = resp.scenarios[0]
    assert rec.feasibility.status == "VERIFIED" and not any(w.startswith("Far area:") for w in rec.warnings)


def test_report_mode_explains_a_split_area_and_never_changes_the_plan(monkeypatch, plans_as_given):
    """report: no search beside the main one, the plan exactly as with the switch off, and one line on why the area
    is on two loads although one truck could carry it."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    monkeypatch.setattr(ds, "_solve_scenario", _fake_search(SPLIT))
    r = day()
    off = ds.optimize_dispatch(r)
    monkeypatch.setenv("SOLVER_FAR_AREA", "report")
    on = ds.optimize_dispatch(r)
    a, b = off.scenarios[0], on.scenarios[0]
    assert loads_of(a) == loads_of(b) == loads_of(raw(r, SPLIT)) and a.operating_cost == b.operating_cost
    extra = [w for w in b.warnings if w not in a.warnings]
    assert len(extra) == 1 and extra[0].startswith(
        "Far area: the 6 stops 32-55 km south-west of the depot are on 2 loads (2 trucks): by pallets and time one load "
        "could carry them all (9.0 pallets, back about ") and extra[0].endswith("far-area grouping did not run for this plan.")
    fa = on.search.far_area
    assert (fa.mode, fa.status, fa.reason, fa.sent, fa.search) == ("report", "SKIPPED", "REPORT_ONLY", False, None)
    assert [(x.area, x.min_loads, x.min_loads_reason, x.loads_final, x.trucks_final, x.served_final) for x in fa.areas] == [
        ("A1", 1, "PALLETS", 2, 2, 6)]
    assert off.search.far_area is None


@pytest.mark.parametrize("mode", ["QUICK", "THOROUGH"])
def test_the_twin_search_runs_beside_the_main_one_quick_and_thorough(parallel, monkeypatch, mode):
    """on: the twin search runs in its own pool beside the main search (best-of off: search.best_of stays null),
    its plan goes to its own stage job in that pool (sent here whatever it found, so that the wiring always runs),
    and every option keeps every rule within the time budget."""
    monkeypatch.setenv("SOLVER_FAR_AREA", "on")
    monkeypatch.setenv("THOROUGH_STALL_SEC", "1")
    monkeypatch.setattr(BO, "QUICK_WAIT_SEC", 60.0)  # a loaded runner may still be starting the twin's process
    monkeypatch.setattr(FA, "should_send", lambda *a, **k: (True, None))
    pools, names = _spy_pools(monkeypatch)
    cap = 90
    r = day(pal=1.5, scenarios=["RECOMMENDED", "MIN_TRUCKS"], time_limit_sec=2, search_mode=mode,
            **({"max_search_sec": cap} if mode == "THOROUGH" else {}))
    resp = ds.optimize_dispatch(r)
    assert pools == [(1, "search", False), (1, "other route searches", True)]
    assert names.count(FA.SOURCE) == 1 and names.count("stage:far") == 1 and names.count("RECOMMENDED") == 1
    s, fa = resp.search, resp.search.far_area
    assert s.best_of is None and fa is not None and fa.mode == "on" and fa.sent
    assert fa.search is not None and (fa.search.index, fa.search.status) == (99, "OPTIMIZED") and fa.search.rechecked
    assert fa.status in ("USED", "NOT_USED") and {x.option for x in fa.results} == {"RECOMMENDED", "MIN_TRUCKS"}
    assert set(fa.chosen_for) == {x.option for x in fa.results if x.outcome == "GROUPED"}
    (area,) = fa.areas
    assert area.pinned and area.targets and area.loads_main is not None and area.loads_far is not None
    assert area.loads_far <= 1 and area.loads_final is not None
    for sc in resp.scenarios:
        assert_plan_rules(r, sc)
        assert any(w.startswith("Far area:") for w in sc.warnings) == (sc.name in fa.chosen_for)
    assert s.used_sec <= (cap if mode == "THOROUGH" else 540)
    if mode == "THOROUGH":
        assert fa.search.stop_reason in ("CONVERGED", "JOINED", "CAP")


HOOKS = [("ROUTEIQ_TEST_FAIL_VARIANT", "FAILED"), ("ROUTEIQ_TEST_KILL_VARIANT", "LOST"), ("ROUTEIQ_TEST_HANG_VARIANT", "TIMEOUT")]


@pytest.mark.parametrize("hook, status", [HOOKS[0], HOOKS[1], HOOKS[2]])
def test_a_failed_lost_or_hung_twin_search_costs_nothing(parallel, monkeypatch, hook, status):
    import multiprocessing as mp

    monkeypatch.setenv("SOLVER_FAR_AREA", "on")
    monkeypatch.setenv(hook, "far")
    r = day(time_limit_sec=1)
    resp = ds.optimize_dispatch(r)
    fa = resp.search.far_area
    assert (fa.status, fa.reason, fa.search.status, fa.sent) == ("FAILED", status, status, False)
    rec = resp.scenarios[0]
    assert rec.status == "OPTIMIZED" and rec.feasibility.status == "VERIFIED"
    assert_plan_rules(r, rec)
    assert mp.active_children() == []


def test_not_run_for_hire_what_ifs_hire_trials_stop_requests_or_the_cpu_gate(monkeypatch):
    from tests.test_pyvrp_candidate import _prepared

    monkeypatch.setenv("SOLVER_FAR_AREA", "on")
    monkeypatch.setattr(PV, "effective_cpus", lambda: 16)
    r = day()

    def wanted(req_, solvable=None, parallel=True, k=1, search_mode="QUICK"):
        run = FA.start(search_mode)
        return ds._far_twin_wanted(req_, req_.stops if solvable is None else solvable, run, parallel, k), run.report["reason"]

    assert wanted(r) == (True, None)
    hire = req(list(r.stops), fleet() + [truck("H1", cap=1000, bays=12, hire_candidate=True, fixed_cost=50)],
               shift_start_min=hm("06:00"))
    assert wanted(hire) == (False, "HIRE_CHECK")
    assert wanted(r, solvable=[]) == (False, "NOTHING_TO_PLAN")
    assert wanted(req(list(r.stops), fleet(), scenarios=["MIN_TRUCKS"])) == (False, "NO_RECOMMENDED")
    assert wanted(r, parallel=False) == (False, "IN_PROCESS")
    assert wanted(req(*nmwc_day(12))) == (False, "NO_FAR_AREA")
    monkeypatch.setattr(PV, "effective_cpus", lambda: 4)  # 4 // 2 solves = 2 searches: best-of's 2 leave none
    assert wanted(r, k=2) == (False, "CPU_GATE") and wanted(r, k=1) == (True, None)
    monkeypatch.setenv("SOLVER_FAR_AREA", "thorough")
    night = req(list(r.stops), fleet(), shift_start_min=hm("06:00"), search_mode="THOROUGH", max_search_sec=600)
    assert wanted(r) == (False, "REPORT_ONLY") and wanted(night, search_mode="THOROUGH") == (True, None)
    # A stop request or a hung main search: the twin's plan is not sent.
    assert FA.should_send([(2, 2, 6)], [(1, 1, 6)], [True], stopped=True, main_stuck=False) == (False, "STOPPED")
    # The hire check's trials never get the far-area state.
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    seen: list = []
    monkeypatch.setattr(ds, "_run_scenarios", lambda *a, **kw: seen.append(kw) or [])
    tds, solvable, drops, mx = _prepared(r)
    assert ds._hire_trial(r, solvable, mx, drops, 1, time.monotonic() + 60, None) == (None, False)
    assert len(seen) == 1 and seen[0].get("far") is None


def test_a_stop_request_neither_waits_for_nor_sends_the_far_area_search(parallel, monkeypatch):
    """Review of the build: a THOROUGH stop request with best-of off waited up to best_of.JOIN_GRACE_SEC for the
    far-area search, whose plan is then never sent. It is not waited for at all now, and the report says STOPPED."""
    import multiprocessing as mp

    monkeypatch.setenv("SOLVER_FAR_AREA", "on")
    waited: list[set] = []
    real = ds._await_all
    monkeypatch.setattr(ds, "_await_all", lambda pool, jobs, deadline: waited.append(set(jobs)) or real(pool, jobs, deadline))
    control = ds.SolveControl()
    control.request_stop()
    resp = ds.optimize_dispatch(day(time_limit_sec=2, search_mode="THOROUGH", max_search_sec=60), control=control)
    fa = resp.search.far_area
    assert (fa.status, fa.reason, fa.sent) == ("NOT_USED", "STOPPED", False) and fa.search is not None
    assert waited and not any(FA.TWIN_KEY in jobs for jobs in waited)
    rec = resp.scenarios[0]
    assert rec.status == "OPTIMIZED" and rec.feasibility.status == "VERIFIED"
    assert mp.active_children() == [] and control._flags == []


def test_frozen_loads_stay_untouched_with_far_area_on(monkeypatch):
    """T12A's frozen load (until 14:00) shapes the route check (the idle T12B is the target) and the twin search
    (searched in-process here): its plan keeps the pins, never moves the frozen load, and the grouped plan the load
    re-check builds from it keeps every rule."""
    from tests.test_pyvrp_candidate import _prepared

    frozen = [FrozenTrip(load_no=1, depart_min=hm("06:00"), return_min=hm("14:00"), cases=100)]
    r = day(trucks=fleet(a={"frozen_trips": frozen}), time_limit_sec=2)
    run = check(r)
    assert run.pins == {f"F{i}": ("T12B",) for i in range(1, 7)}
    tds, solvable, drops, mx = _prepared(r)
    job = ("RECOMMENDED", r, solvable, tds, mx, 2, drops)
    out = ds._variant_worker((BO.SearchVariant(FA.TWIN_INDEX, 0, far=True), time.monotonic(), job, run.pins))
    sc = out["scenario"]
    assert out["status"] == sc.status == "OPTIMIZED" and out["exact"] is not None
    assert_reconciled(r, sc)
    for ld in sc.loads:
        if any(st.stop_id.startswith("F") for st in ld.stops):
            assert ld.truck_id == "T12B"
        if ld.truck_id == "T12A":
            assert ld.load_no >= 2 and ld.depart_min >= hm("14:00") + r.config.reload_min
    results = {"RECOMMENDED": raw(r, {1: [(6, 7, 8, 9, 10, 11, 12, 13), (0, 1, 2)], 2: [(3, 4, 5)]})}
    ds._post_solve(r, r.stops, ds._truck_days(r), matrix_for(r), 2, [], results, None, time.monotonic() + 60,
                   far_source=sc, far=run)
    assert_plan_rules(r, results["RECOMMENDED"])
    assert run.report["results"] and run.report["results"][0]["option"] == "RECOMMENDED"


def test_a_needed_split_is_explained_not_forced(monkeypatch, plans_as_given):
    """15 pallets need two loads (PALLETS): the plan with them on two loads is kept and says why."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    monkeypatch.setenv("SOLVER_FAR_AREA", "on")
    monkeypatch.setattr(ds, "_solve_scenario", _fake_search(SPLIT))
    r = day(pal=2.5)
    resp = ds.optimize_dispatch(r)
    rec = resp.scenarios[0]
    assert loads_of(rec) == loads_of(raw(r, SPLIT))
    assert [w for w in rec.warnings if w.startswith("Far area:")] == [
        "Far area: the 6 stops 32-55 km south-west of the depot are on 2 loads (2 trucks): their 15.0 pallets need at "
        "least 2 loads (one load holds at most 12.0 pallets)."]
    fa = resp.search.far_area
    assert (fa.status, fa.reason, fa.areas[0].min_loads, fa.areas[0].min_loads_reason) == ("SKIPPED", "IN_PROCESS", 2, "PALLETS")


def test_far_area_leaves_no_process_or_handle(parallel, monkeypatch):
    import gc
    import multiprocessing as mp

    from tests.test_worker_lifecycle import _mp_objects, _open_handles

    monkeypatch.setenv("SOLVER_FAR_AREA", "on")
    monkeypatch.setattr(FA, "should_send", lambda *a, **k: (True, None))  # the kept pool and its stage job too
    r = day(time_limit_sec=1)
    ds.optimize_dispatch(r)  # warm up: imports, logging
    gc.collect()
    base_handles, base_objects = _open_handles(), len(_mp_objects())
    for i in range(2):
        resp = ds.optimize_dispatch(r)
        assert resp.search.far_area.search is not None and resp.search.far_area.sent, i
        assert mp.active_children() == [], i
    gc.collect()
    assert len(_mp_objects()) == base_objects
    if base_handles is not None:
        assert _open_handles() - base_handles <= 8


def test_far_area_log_lines_name_no_stop(caplog, plans_as_given):
    """The log line per area uses km and compass (the repository and its logs examples are public: no stop id)."""
    r = day()
    results, run = stage(r, SPLIT, GROUP)
    check(r, run)
    line = FA.summary(run)
    assert "A1: 6 stops 32-55 km SW, 9.0 pallets, needs 1 (PALLETS)" in line and "RECOMMENDED: GROUPED" in line
    assert not re.search(r"\b[FC]\d\b", line)
    with caplog.at_level(logging.INFO, logger="routeiq.dispatch"):
        ds._far_finish(r, r.stops, ds._truck_days(r), matrix_for(r), [], results, run, time.monotonic() + 60)
    assert "far-area run=r mode=on status=USED" in caplog.text
