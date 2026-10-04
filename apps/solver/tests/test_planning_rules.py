"""Planning rules (owner decisions 29 Sep 2026), phase A: unloading finished by closing.

config.window_rule "FINISH": a stop's unloading must be FINISHED by the end of its receiving
hours (service start + service_min <= hard_end_min), and a preferred end means "finished by"
too. "START" (absent, the default) keeps the earlier rule: unloading only has to start by closing.
One helper (load_repack.latest_start_s) feeds the route search, the prefilter, the repack, the LP
timing, timing_ok and the output; feasibility.check_scenario re-derives the rule independently.

Haversine only (no network).
"""
from __future__ import annotations

import pytest

import dispatch_solver as ds
import feasibility as FZ
import load_repack as LR
from dispatch_models import DispatchConfig
from dispatch_solver import optimize_dispatch
from tests.test_dispatch import hm, rec, req, served_ids, stop, truck, unserved_map
from tests.test_repack import _day_for, matrix_for


def out_min(r, k: int = 0) -> float:
    """Drive minutes from the depot to stop k of ``r``."""
    return matrix_for(r).duration_s[0][k + 1] / 60.0


def near(sid: str, **kw):
    return stop(sid, 23.60, 58.45, **kw)


# --------------------------------------------------------------------------------------
# F1: FINISH starts unloading by closing - stop time; START may still start at closing
# --------------------------------------------------------------------------------------

def _late_arrival_day(rule: str | None):
    """One stop open 06:00-11:00 with 35 min unloading; the truck can arrive 3 min after 10:25."""
    probe = req([near("A", service_min=35, hard_start_min=hm("06:00"), hard_end_min=hm("11:00"))], [truck("T1")])
    shift = hm("10:25") - int(round(out_min(probe))) + 3
    cfg = {"shift_start_min": shift}
    if rule is not None:
        cfg["window_rule"] = rule
    return req([near("A", service_min=35, hard_start_min=hm("06:00"), hard_end_min=hm("11:00"))], [truck("T1")], **cfg)


def test_f1_start_rule_is_the_default_and_unchanged():
    assert DispatchConfig().window_rule == "START"
    sc = rec(optimize_dispatch(_late_arrival_day(None)))
    assert served_ids(sc) == {"A"}
    st = sc.loads[0].stops[0]
    assert st.service_start_min > hm("10:25") and st.departure_min > hm("11:00") and st.hard_window_ok
    assert sc.feasibility.status == "VERIFIED" and sc.window_rule == "START"


def test_f1_finish_rule_drops_a_stop_that_cannot_finish_by_closing():
    sc = rec(optimize_dispatch(_late_arrival_day("FINISH")))
    assert served_ids(sc) == set()
    u = sc.unserved[0]
    assert u.reason_code == "HARD_WINDOW_INFEASIBLE"
    assert "early enough to finish unloading (35 min) by closing (11:00)" in u.reason_message


def test_f1_finish_rule_keeps_every_unloading_inside_the_receiving_hours():
    stops = [stop(f"S{i}", 23.585 + 0.03 * (i % 4), 58.39 + 0.025 * (i // 4), cases=40, service_min=30,
                  hard_start_min=hm("06:00"), hard_end_min=hm("07:30") + 20 * i) for i in range(8)]
    r = req(stops, [truck("T1", cap=200, max_trips=3), truck("T2", cap=200, max_trips=3)],
            shift_start_min=hm("06:00"), window_rule="FINISH")
    sc = rec(optimize_dispatch(r))
    assert served_ids(sc), "something is served"
    by_id = {s.stop_id: s for s in stops}
    for ld in sc.loads:
        for st in ld.stops:
            s = by_id[st.stop_id]
            assert s.hard_start_min <= st.service_start_min and st.departure_min <= s.hard_end_min, st
            assert st.hard_window_ok
    assert sc.feasibility.status == "VERIFIED", sc.feasibility.violations


# --------------------------------------------------------------------------------------
# F2: unloading longer than the receiving hours: dropped with a reason, the rest is planned
# --------------------------------------------------------------------------------------

def test_f2_unloading_longer_than_the_window_is_dropped_not_a_model_failure():
    short = near("SHORT", service_min=90, hard_start_min=hm("06:00"), hard_end_min=hm("07:00"))
    ok = stop("OK", 23.61, 58.40, service_min=20)
    r = req([short, ok], [truck("T1")], window_rule="FINISH")
    sc = rec(optimize_dispatch(r))
    assert served_ids(sc) == {"OK"}
    assert unserved_map(sc) == {"SHORT": "HARD_WINDOW_INFEASIBLE"}
    msg = sc.unserved[0].reason_message
    assert "Unloading takes 90 min" in msg and "06:00-07:00 are only 60 min long" in msg
    assert "never finish before closing" in msg
    # The earlier rule still serves it (unloading starts inside the window).
    assert served_ids(rec(optimize_dispatch(req([short, ok], [truck("T1")])))) == {"SHORT", "OK"}


# --------------------------------------------------------------------------------------
# F3: the preferred end means "finished by": one penalty in the search, the LP and the report
# --------------------------------------------------------------------------------------

def _pref_day(rule: str):
    """Preferred 06:00-10:00, 30 min unloading; the truck arrives about 09:45 (after 09:30)."""
    probe = req([near("A", service_min=30, pref_start_min=hm("06:00"), pref_end_min=hm("10:00"))], [truck("T1")])
    shift = hm("09:45") - int(round(out_min(probe)))
    return req([near("A", service_min=30, pref_start_min=hm("06:00"), pref_end_min=hm("10:00"))], [truck("T1")],
               shift_start_min=shift, window_rule=rule, early_preference_per_min={p: 0.0 for p in range(1, 6)})


@pytest.mark.parametrize("rule", ["START", "FINISH"])
def test_f3_preferred_end_penalty_matches_score_and_report(rule):
    r = _pref_day(rule)
    sc = rec(optimize_dispatch(r))
    st = sc.loads[0].stops[0]
    after = max(0, st.service_start_min - (hm("10:00") - (30 if rule == "FINISH" else 0)))
    assert st.pref_window_ok == (after == 0)
    # The report prices seconds; the emitted start is rounded to a whole minute.
    assert sc.preference_penalties.window == pytest.approx(after * r.config.pref_window_penalty_per_min,
                                                           abs=r.config.pref_window_penalty_per_min)
    if rule == "FINISH":
        assert after > 0 and not st.pref_window_ok
    # score() (the post-solve objective) prices the same minutes.
    day, tds = _day_for(r)
    pricing = ds._pricing("RECOMMENDED", r, tds, r.stops)
    start_s = st.service_start_min * 60
    bound = LR.pref_end_bound_s(r.stops[0], rule)
    assert LR._soft_cost(day, pricing, 0, start_s) == pricing.pref * max(0, start_s - bound)


def test_f3_pref_end_bound_is_clamped_at_zero():
    s = near("A", service_min=45, pref_start_min=0, pref_end_min=30)
    assert LR.pref_end_bound_s(s, "FINISH") == 0
    assert LR.pref_end_bound_s(s, "START") == 30 * 60
    assert LR.pref_end_bound_s(near("B"), "FINISH") is None


# --------------------------------------------------------------------------------------
# F4: the independent check flags a finish after closing under FINISH only
# --------------------------------------------------------------------------------------

def test_f4_check_scenario_flags_unloading_after_closing_under_finish_only():
    assert FZ.CHECK_VERSION >= 2  # 2: FINISH and the break; 3: pallets (test_pallets.py)
    r = _late_arrival_day("START")
    resp = optimize_dispatch(r)
    sc = rec(resp)
    st = sc.loads[0].stops[0]
    assert st.departure_min > hm("11:00")
    mx = matrix_for(r)
    assert FZ.check_scenario(r, sc, solvable=r.stops, mx=mx).violations == []
    finish = r.model_copy(deep=True)
    finish.config.window_rule = "FINISH"
    rep = FZ.check_scenario(finish, sc, solvable=r.stops, mx=mx)
    assert {v.code for v in rep.violations} == {"HARD_WINDOW"}
    v = rep.violations[0]
    assert f"finishes unloading at {ds._hhmm(st.departure_min)}, after its receiving hours end (11:00)" in v.message
    assert v.short_by_min == pytest.approx(st.departure_min - hm("11:00"), abs=0.1)


# --------------------------------------------------------------------------------------
# F5: facts().hi, depart_range and timing_ok use the latest start
# --------------------------------------------------------------------------------------

def test_f5_repack_facts_and_timing_use_the_latest_start():
    base = dict(service_min=35, hard_start_min=hm("06:00"), hard_end_min=hm("11:00"))
    fin = req([near("A", **base)], [truck("T1")], window_rule="FINISH", shift_start_min=hm("06:00"))
    sta = req([near("A", **base)], [truck("T1")], shift_start_min=hm("06:00"))
    day_f, tds_f = _day_for(fin)
    day_s, _ = _day_for(sta)
    f_fin, f_sta = LR.facts(day_f, (0,)), LR.facts(day_s, (0,))
    assert f_sta.hi - f_fin.hi == 35 * 60
    assert f_fin.hi == hm("10:25") * 60 - f_fin.off[0]
    td = day_f.trucks[0]
    rng = LR.depart_range(day_f, f_fin, td)
    assert rng is not None and rng[1] <= f_fin.hi
    ok = LR.TimedLoad(stops=(0,), depart_s=f_fin.hi, starts=(hm("10:25") * 60,),
                      return_s=hm("10:25") * 60 + 35 * 60 + day_f.T[1][0])
    late = LR.TimedLoad(stops=(0,), depart_s=f_fin.hi + 60, starts=(hm("10:26") * 60,),
                        return_s=hm("10:26") * 60 + 35 * 60 + day_f.T[1][0])
    assert LR.timing_ok(day_f, td, [ok]) and not LR.timing_ok(day_f, td, [late])
    assert LR.timing_ok(day_s, day_s.trucks[0], [late])


# --------------------------------------------------------------------------------------
# F6: the echo, on every scenario (empty ones too)
# --------------------------------------------------------------------------------------

def test_f6_window_rule_is_echoed_on_every_scenario():
    stops = [near("A"), stop("B", 23.61, 58.40)]
    three = ["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"]
    for rule in ("START", "FINISH"):
        resp = optimize_dispatch(req(stops, [truck("T1")], window_rule=rule, scenarios=three))
        assert [sc.window_rule for sc in resp.scenarios] == [rule] * 3
    # Nothing to plan (every stop dropped before the search).
    empty = optimize_dispatch(req([near("X", service_min=90, hard_start_min=hm("06:00"), hard_end_min=hm("07:00"))],
                                  [truck("T1")], window_rule="FINISH"))
    assert all(sc.window_rule == "FINISH" and not sc.loads for sc in empty.scenarios)
