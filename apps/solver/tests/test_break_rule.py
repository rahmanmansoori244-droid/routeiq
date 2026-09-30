"""Planning rules phase B: the driver break (owner decisions 29-30 Sep 2026).

One break of config.break_min per truck-day, STARTING between break_start_from_min and
break_start_to_min, on the road between two unloadings or at the depot (it may overlap a reload),
never while unloading; inside the shift, paid. A truck-day needs none when it is back for good by
the window's end or its first departure is at the window's start or later - decided by TIMES,
never by load status. Idle time before a same-day plan was made does not count. The search stays
break-free (with a margin); load_repack places the break exactly; feasibility.check_scenario and
the web gate re-check it.

Haversine only (no network).
"""
from __future__ import annotations

import dispatch_solver as ds
import feasibility as FZ
import load_repack as LR
from dispatch_models import DispatchConfig, FrozenTrip, PlannedBreak
from dispatch_solver import optimize_dispatch
from tests.test_dispatch import hm, rec, req, served_ids, stop, truck
from tests.test_repack import _day_for, matrix_for

BREAK = dict(break_min=60, break_start_from_min=hm("12:00"), break_start_to_min=hm("14:00"))


def far(sid: str, dlat: float, **kw):
    return stop(sid, 23.585 + dlat, 58.39, **kw)


def _closing(r, close: str):
    r.depot = r.depot.model_copy(update={"close_min": hm(close)})
    return r


def _long_day(**cfg):
    """One stop ~4.5 h away (30 min unloading): 06:00 -> about 15:30 without a break. The depot
    closes at 20:00, so leaving at 12:00 or later (no break needed) cannot be back in time."""
    base = dict(shift_start_min=hm("06:00"), shift_max_min=12 * 60, time_limit_sec=2)
    base.update(cfg)
    return _closing(req([far("F", 1.25, service_min=30)], [truck("T1")], **base), "20:00")


# --------------------------------------------------------------------------------------
# B1: a long single load crosses midday: a ROAD break, first leg or the way back
# --------------------------------------------------------------------------------------

def test_b1_long_load_gets_a_road_break_inside_the_window():
    r = _long_day(**BREAK)
    sc = rec(optimize_dispatch(r))
    assert served_ids(sc) == {"F"}
    ld = sc.loads[0]
    b = ld.driver_break
    assert b is not None and b.where == "ROAD" and b.after_sequence in (0, 1)
    assert hm("12:00") <= b.start_min <= hm("14:00") and b.end_min == b.start_min + 60
    mx = matrix_for(r)
    drive = (mx.duration_s[0][1] + mx.duration_s[1][0]) / 60
    assert abs(ld.duration_min - (drive + 30 + 60)) <= 2  # the day is 60 min longer
    st = ld.stops[0]
    if b.after_sequence == 0:
        assert b.end_min <= st.service_start_min and st.wait_min == 0
    else:
        assert b.start_min >= st.departure_min and ld.return_min >= b.end_min
    assert sc.feasibility.status == "VERIFIED", sc.feasibility.violations
    assert sc.truck_days[0].break_status == "PLANNED" and sc.truck_days[0].break_start_min == b.start_min
    assert sc.break_rule is not None and sc.break_rule.length_min == 60


def test_b1_return_leg_break_is_timed_and_checked():
    # The stop can only be served at 11:00 sharp: the first leg ends before 12:00, so the break
    # must be on the way back - timing_ok must accept return = last departure + drive + break.
    r = _long_day(**BREAK)
    r.stops[0] = r.stops[0].model_copy(update={"hard_start_min": hm("11:00"), "hard_end_min": hm("11:00")})
    day, tds = _day_for(r)
    td = day.trucks[0]
    assert td.break_state == "DUE"
    timed = LR.time_truck(day, td, [(0,)], ds._pricing("RECOMMENDED", r, tds, r.stops))
    assert timed is not None
    tl = timed[0]
    assert tl.brk is not None and tl.brk.where == "ROAD" and tl.brk.after == 1
    assert tl.return_s == tl.starts[0] + 30 * 60 + day.T[1][0] + 3600
    assert LR.timing_ok(day, td, timed)
    # The same timetable without its break breaks the rule.
    assert not LR.timing_ok(day, td, [LR.TimedLoad(tl.stops, tl.depart_s, tl.starts, tl.return_s - 3600)])


# --------------------------------------------------------------------------------------
# B2: a depot break during a reload (overlapping the turnaround)
# --------------------------------------------------------------------------------------

def test_b2_depot_break_overlaps_the_reload():
    stops = [stop("A", 23.60, 58.45, service_min=10, hard_start_min=hm("11:30"), hard_end_min=hm("11:40")),
             far("B", 0.5, service_min=20)]
    r = req(stops, [truck("T1")], shift_start_min=hm("06:00"), reload_min=30, **BREAK)
    day, tds = _day_for(r)
    td = day.trucks[0]
    timed = LR.time_truck(day, td, [(0,), (1,)], ds._pricing("RECOMMENDED", r, tds, r.stops))
    assert timed is not None
    first, second = timed
    assert first.brk is None and second.brk is not None and second.brk.where == "DEPOT"
    b = second.brk.start_s
    assert b >= first.return_s and second.depart_s >= b + 3600
    gap = day.gap_s(stops[1].demand_cases)
    assert second.depart_s - first.return_s < gap + 3600  # the reload happened during the break
    assert LR.timing_ok(day, td, timed)


# --------------------------------------------------------------------------------------
# B3: no break needed - back by 14:00, or first departure at 12:00 or later (owner: 12:00-13:00 too)
# --------------------------------------------------------------------------------------

def test_b3_no_break_when_back_by_the_window_end_or_starting_at_its_start():
    back = rec(optimize_dispatch(req([stop("A", 23.60, 58.45)], [truck("T1")], shift_start_min=hm("09:00"), **BREAK)))
    assert back.loads and back.loads[0].driver_break is None and back.loads[0].return_min <= hm("14:00")
    assert back.truck_days[0].break_status == "NOT_NEEDED" and back.feasibility.status == "VERIFIED"
    late = rec(optimize_dispatch(_long_day(shift_start_min=hm("12:30"), **BREAK)))
    late.loads  # noqa: B018 - may be unserved by the 20:00 closing; what matters is no break
    assert all(ld.driver_break is None for ld in late.loads)
    tds = ds._truck_days(_long_day(shift_start_min=hm("12:30"), **BREAK))
    assert tds[0].break_state == "NOT_NEEDED"


# --------------------------------------------------------------------------------------
# B6: frozen loads - decided by times, never by status (review FIX 1)
# --------------------------------------------------------------------------------------

def _state(frozen, **cfg):
    r = req([stop("A", 23.60, 58.45)], [truck("T1", frozen_trips=frozen)], shift_start_min=hm("06:00"), **{**BREAK, **cfg})
    return ds._truck_days(r)[0]


def test_b6_frozen_break_states():
    ft = lambda n, d, rt, **kw: FrozenTrip(load_no=n, depart_min=hm(d), return_min=hm(rt), **kw)  # noqa: E731
    assert _state([ft(1, "07:00", "15:00", break_start_min=hm("12:10"), break_min=60)]).break_state == "IN_FROZEN_LOAD"
    due = _state([ft(1, "07:00", "12:40")])
    assert due.break_state == "DUE" and due.break_lo_s == hm("12:40") * 60 and due.break_hi_s == hm("14:00") * 60
    gone = _state([ft(1, "09:00", "15:10")])
    assert gone.break_state == "NOT_POSSIBLE" and "no driver break is recorded" in gone.break_note
    gap = _state([ft(1, "07:00", "11:00"), ft(2, "13:10", "15:00")])
    assert gap.break_state == "IN_FROZEN_LOAD"
    # A truck whose locked load leaves at 13:30 needs no break, now or at any later check.
    assert _state([ft(1, "13:30", "16:00")]).break_state == "NOT_NEEDED"
    # Same-day plan at 14:10 after a locked morning: the idle time since 12:30 does not count,
    # so the break can no longer be planned - the truck takes no new load (and says why).
    late = _state([ft(1, "07:00", "12:30")], loading_from_min=hm("14:10"))
    assert late.break_state == "NOT_NEEDED" and not late.usable and "can no longer start" in late.break_note
    # Same-day plan at 13:30: the break counts from then, not from the 12:30 return.
    now = _state([ft(1, "07:00", "12:30")], loading_from_min=hm("13:30"))
    assert now.break_state == "DUE" and now.break_lo_s == hm("13:30") * 60


def test_b6_locked_afternoon_truck_is_never_blocked():
    # Locked load 13:30-16:00 without a recorded break + a new load after it: no break, VERIFIED.
    t = truck("T1", frozen_trips=[FrozenTrip(load_no=1, depart_min=hm("13:30"), return_min=hm("16:00"))])
    sc = rec(optimize_dispatch(req([stop("A", 23.60, 58.45)], [t], shift_start_min=hm("06:00"), **BREAK)))
    assert sc.loads and all(ld.driver_break is None for ld in sc.loads)
    assert sc.feasibility.status == "VERIFIED", sc.feasibility.violations


def test_b7_same_day_plan_after_the_window_start_needs_no_break():
    tds = ds._truck_days(_long_day(loading_from_min=hm("11:40"), **BREAK))
    assert tds[0].break_state == "NOT_NEEDED"  # the first load leaves 12:10 at the earliest


# --------------------------------------------------------------------------------------
# B9: the CP-SAT repack places a single load that must cross midday (road-break variant)
# --------------------------------------------------------------------------------------

def test_b9_repack_places_a_load_that_must_cross_the_window():
    r = _long_day(**BREAK)
    day, tds = _day_for(r)
    pricing = ds._pricing("RECOMMENDED", r, tds, r.stops)
    res = LR.repack(day, pricing, [(0,)], {0}, {}, None, 3.0, workers=1)
    assert res.status != "REQUIRED_STOP_UNPLACEABLE" and res.plan == {0: [(0,)]}
    assert LR.time_plan(day, res.plan, pricing) is not None


# --------------------------------------------------------------------------------------
# B11: the independent check (BREAK)
# --------------------------------------------------------------------------------------

def test_b11_check_scenario_break_rules():
    r = _long_day(**BREAK)
    sc = rec(optimize_dispatch(r))
    assert sc.feasibility.status == "VERIFIED"

    def codes(s):
        return [v.code for v in FZ.check_scenario(r, s).violations]

    missing = sc.model_copy(deep=True)
    missing.loads[0].driver_break = None
    assert "BREAK" in codes(missing)
    early = sc.model_copy(deep=True)
    b = early.loads[0].driver_break
    early.loads[0].driver_break = PlannedBreak(start_min=hm("10:00"), end_min=hm("11:00"), where=b.where,
                                              after_sequence=b.after_sequence)
    assert "BREAK" in codes(early)
    over = sc.model_copy(deep=True)
    st = over.loads[0].stops[0]
    over.loads[0].driver_break = PlannedBreak(start_min=st.service_start_min, end_min=st.service_start_min + 60,
                                             where="ROAD", after_sequence=1)
    assert "BREAK" in codes(over)
    # A recorded break in a locked load + one more planned: a second break.
    r2 = r.model_copy(deep=True)
    r2.trucks[0].frozen_trips = [FrozenTrip(load_no=1, depart_min=hm("05:00"), return_min=hm("05:30"),
                                            break_start_min=hm("12:00"), break_min=60)]
    second = sc.model_copy(deep=True)
    second.loads[0].load_no = 2
    assert any(v.code == "BREAK" and "second" in v.message for v in FZ.check_scenario(r2, second).violations)
    # No rule (break_min 0): nothing to check.
    r0 = r.model_copy(deep=True)
    r0.config.break_min = 0
    assert "BREAK" not in [v.code for v in FZ.check_scenario(r0, missing).violations]


def test_b11_frozen_loads_through_the_window_are_a_warning_not_a_violation():
    t = truck("T1", frozen_trips=[FrozenTrip(load_no=1, depart_min=hm("06:00"), return_min=hm("15:10"))])
    sc = rec(optimize_dispatch(req([stop("A", 23.60, 58.45)], [t], shift_start_min=hm("06:00"), **BREAK)))
    assert sc.feasibility.status == "VERIFIED", sc.feasibility.violations
    assert any("no driver break is recorded" in w for w in sc.warnings)


# --------------------------------------------------------------------------------------
# Safety net (review FIX 2) and settings that cannot work (review FIX 8)
# --------------------------------------------------------------------------------------

def test_safety_net_retimes_with_the_break_without_loading_time(monkeypatch):
    monkeypatch.setenv("ROUTEIQ_TEST_FAIL_REPACK", "1")
    r = _long_day(**BREAK)
    assert r.config.loading_min_per_case == 0
    sc = rec(optimize_dispatch(r))
    assert served_ids(sc) == {"F"} and sc.loads[0].driver_break is not None
    assert sc.feasibility.status == "VERIFIED" and sc.feasibility.timing == "EXACT"


def test_break_settings_that_cannot_work_plan_none_and_warn():
    cfg = DispatchConfig(break_min=60, break_start_from_min=hm("15:00"), break_start_to_min=hm("14:00"))
    assert ds.break_rule(cfg) is None and "No driver break was planned" in ds.break_rule_problem(cfg)
    sc = rec(optimize_dispatch(_long_day(break_min=60, break_start_from_min=hm("15:00"), break_start_to_min=hm("14:00"))))
    assert sc.break_rule is None and all(ld.driver_break is None for ld in sc.loads)
    assert any("No driver break was planned" in w for w in sc.warnings)
    assert sc.feasibility.status == "VERIFIED"


def test_b10_no_break_fields_is_the_earlier_rule():
    assert DispatchConfig().break_min == 0
    sc = rec(optimize_dispatch(_long_day()))
    assert sc.break_rule is None and all(ld.driver_break is None for ld in sc.loads)
    assert all(td.break_status is None for td in sc.truck_days)
    assert all(td.break_state == "OFF" for td in ds._truck_days(_long_day()))


def test_b12_identical_trucks_split_by_break_state():
    t1 = truck("T1")
    t2 = truck("T2", frozen_trips=[])
    r = req([stop("A", 23.60, 58.45)], [t1, t2], shift_start_min=hm("06:00"), **BREAK)
    day, tds = _day_for(r)
    pricing = ds._pricing("RECOMMENDED", r, tds, r.stops)
    assert LR._identical_trucks(day, pricing)  # same state: interchangeable
    day.trucks[1].break_state = "NOT_NEEDED"
    assert not LR._identical_trucks(day, pricing)


# --------------------------------------------------------------------------------------
# Latest return (owner: "18:00 is the latest return"): an absolute cut-off, not first departure + shift
# --------------------------------------------------------------------------------------

def _late_stop_day(**cfg):
    """One stop ~3 h away that receives only from 15:00: served, the truck is back about 19:00."""
    s = far("L", 0.8, service_min=30, hard_start_min=hm("15:00"), hard_end_min=hm("20:00"))
    base = dict(shift_start_min=hm("07:00"), shift_max_min=11 * 60, time_limit_sec=2, window_rule="FINISH", **BREAK)
    base.update(cfg)
    return req([s], [truck("T1")], **base)


def test_latest_return_is_an_absolute_cut_off():
    old = rec(optimize_dispatch(_late_stop_day()))
    assert served_ids(old) == {"L"} and old.loads[0].return_min > hm("18:00")  # without it: back after 18:00
    assert old.latest_return_min is None
    new = rec(optimize_dispatch(_late_stop_day(latest_return_min=hm("18:00"))))
    assert served_ids(new) == set() and new.latest_return_min == hm("18:00")
    assert new.feasibility.status == "VERIFIED"


def test_latest_return_holds_on_a_same_day_plan_and_is_checked():
    r = _late_stop_day(latest_return_min=hm("18:00"), shift_start_min=hm("11:30"), loading_from_min=hm("11:00"))
    assert ds._truck_days(r)[0].latest_return_s == hm("18:00") * 60
    sc = rec(optimize_dispatch(_late_stop_day()))
    late = FZ.check_scenario(_late_stop_day(latest_return_min=hm("18:00")), sc).violations
    assert any(v.code == "SHIFT_LIMIT" and "latest return (18:00)" in v.message for v in late)
