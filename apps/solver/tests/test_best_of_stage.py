"""Best-of-N's other route searches in the load re-check (_post_solve's extra_sources; best_of.py; solver search
upgrade, 16 Oct 2026): their plans only add candidates, a tie keeps the main search's plan, and one is used only
when it beats the best plan without them by a gain the dispatcher can see - its note then says so, the report
lists the option (chosen_for) and the gain of every option (gains).

Hand-built plans of a small day on the stage directly, in-process (no route search, no worker pool), with the
load repacks giving no answer where a test needs the candidates to be the plans exactly as given (seconds).
The searches themselves (SOLVER_BEST_OF) are test_best_of.py's.
"""
from __future__ import annotations

import time

import pytest

import best_of
import dispatch_solver as ds
import load_repack as LR
from tests.test_dispatch import hm, req, served_ids, stop, truck
from tests.test_repack import _day_for, assert_plan_rules, matrix_for

GOOD = {0: [(0, 1)], 1: [(2, 3)]}  # the two north stops on T1, the two south ones on T2
MIRROR = {0: [(2, 3)], 1: [(0, 1)]}  # the same loads on the other (identical) trucks: the same score
ZIGZAG = {0: [(0, 2)], 1: [(1, 3)]}  # each truck drives north and south: about 78 km more


def two_area_day(per_km: float = 0.5, **cfg):
    """Two 40-case stops north of the depot, two south; two identical trucks of 100 cases, one load each."""
    stops = [stop("N1", 23.700, 58.300, cases=40), stop("N2", 23.705, 58.310, cases=40),
             stop("S1", 23.470, 58.480, cases=40), stop("S2", 23.465, 58.470, cases=40)]
    trucks = [truck("T1", cap=100, fixed_cost=20, cost_per_km=per_km, max_trips=1),
              truck("T2", cap=100, fixed_cost=20, cost_per_km=per_km, max_trips=1)]
    return req(stops, trucks, shift_start_min=hm("07:00"), **cfg)


def raw(r, plan, name="RECOMMENDED"):
    """A route search's plan of ``r`` (stop indices per truck index), timed exactly (VERIFIED)."""
    day, tds = _day_for(r)
    timed = LR.time_plan(day, plan, ds._pricing("RECOMMENDED", r, tds, r.stops))
    assert timed is not None
    return ds._build_scenario(name, r, r.stops, tds, matrix_for(r), timed, day.values, False, [],
                              solver_status="ROUTING_SUCCESS", elapsed=1.0, time_limit=2, objective_value=0)


def stage(r, primary, extras=(), best=None, budget=60.0):
    results = {"RECOMMENDED": raw(r, primary)}
    ds._post_solve(r, r.stops, ds._truck_days(r), matrix_for(r), 2, [], results, None, time.monotonic() + budget,
                   extra_sources=[(n, raw(r, p, "RECOMMENDED")) for n, p in extras], best_of=best)
    return results["RECOMMENDED"]


def loads_of(sc) -> set[tuple[str, tuple[str, ...]]]:
    return {(ld.truck_id, tuple(sorted(st.stop_id for st in ld.stops))) for ld in sc.loads}


@pytest.fixture()
def plans_as_given(monkeypatch):
    """The load repacks give no answer: the candidates are the plans as given (and their recoveries)."""
    monkeypatch.setattr(LR, "repack", lambda *a, **kw: LR.RepackResult(None, "UNKNOWN", 0.0))


def report(**kw) -> dict:
    return dict(requested=3, used=3, **kw)


def test_without_extra_sources_the_stage_is_as_before(monkeypatch):
    """No other search (one search, the default): the load re-check gets exactly the options' own sources, and
    the report gets nothing."""
    seen: list = []
    real = LR.build_candidates
    monkeypatch.setattr(LR, "build_candidates", lambda **job: seen.append(job["sources"]) or real(**job))
    r = two_area_day()
    best = report()
    sc = stage(r, ZIGZAG, best=best)
    assert seen and all([(s.name, s.extra) for s in srcs] == [("RECOMMENDED", False)] for srcs in seen)
    assert best == report() and served_ids(sc) == {"N1", "N2", "S1", "S2"}
    assert not any("Route search" in w for w in sc.warnings)


def test_the_primary_wins_ties(plans_as_given):
    r = two_area_day()
    best = report()
    sc = stage(r, GOOD, [("RECOMMENDED~1", MIRROR)], best)
    assert loads_of(sc) == {("T1", ("N1", "N2")), ("T2", ("S1", "S2"))}  # the main search's own
    assert not any("Route search" in w for w in sc.warnings), sc.warnings
    assert best.get("chosen_for", []) == []
    assert best["gains"] == [dict(option="RECOMMENDED", source="RECOMMENDED~1", used=False, gain_omr=0.0, gain_operating_omr=0.0,
                                  gain_km=0.0, gain_trucks=0, served_delta=0)]


def test_a_better_extra_is_used_with_a_note(plans_as_given):
    r = two_area_day()
    best = report()
    sc = stage(r, ZIGZAG, [("RECOMMENDED~2", GOOD)], best)
    assert loads_of(sc) == {("T1", ("N1", "N2")), ("T2", ("S1", "S2"))}
    note = [w for w in sc.warnings if w.startswith("Route search 3 of 3")]
    assert note and "found a better plan for this option than the main search: a lower total cost including the " \
                    "customer time preferences, 122 -> 82 OMR. Also changed: km 163.1 -> 84.6" in note[0], sc.warnings
    assert note[0].endswith("It passed the planner's own checks, timing and costs.")
    # Not "Loads were re-assigned after the route search" (that compares with the main search's own plan).
    assert not any(w.startswith("Loads were re-assigned") for w in sc.warnings), sc.warnings
    assert best["chosen_for"] == ["RECOMMENDED"]
    (gain,) = best["gains"]
    assert gain["used"] and gain["source"] == "RECOMMENDED~2" and gain["gain_omr"] == pytest.approx(39.28, abs=0.05)
    assert gain["gain_km"] == pytest.approx(78.5, abs=0.5) and gain["served_delta"] == 0 and gain["gain_trucks"] == 0
    assert served_ids(sc) == {"N1", "N2", "S1", "S2"}
    assert_plan_rules(r, sc)
    # The report this makes is a valid SearchReport.best_of (no plan is ever lost to it).
    rep = best_of.report_or_none(best)
    assert rep is not None and rep.chosen_for == ["RECOMMENDED"] and rep.gains[0].used


def test_an_extra_gain_too_small_to_show_is_not_used(plans_as_given):
    """0.79 OMR cheaper (the km at 0.01 OMR): a gain the note could not show ("41 -> 41 OMR"), so the main
    search's plan stays - as the second search's must beat it by 1 OMR or 1 km."""
    r = two_area_day(per_km=0.01)
    best = report()
    sc = stage(r, ZIGZAG, [("RECOMMENDED~1", GOOD)], best)
    assert loads_of(sc) == {("T1", ("N1", "S1")), ("T2", ("N2", "S2"))}  # the zigzag, as the main search found it
    assert not any("Route search" in w for w in sc.warnings)
    assert best.get("chosen_for", []) == []
    (gain,) = best["gains"]
    assert not gain["used"] and 0 < gain["gain_omr"] < ds.MIN_SHOWN_GAIN_OMR, gain


def test_other_searches_only_join_with_a_plan_and_their_own_name(plans_as_given, caplog):
    """A search with no plan adds nothing; a source not named as one of the other searches is ignored (with a
    warning): it would otherwise be compared as an option's own plan."""
    r = two_area_day()
    best = report()
    no_plan = raw(r, GOOD).model_copy(update={"status": "NO_SOLUTION"})
    results = {"RECOMMENDED": raw(r, ZIGZAG)}
    ds._post_solve(r, r.stops, ds._truck_days(r), matrix_for(r), 2, [], results, None, time.monotonic() + 60,
                   extra_sources=[("RECOMMENDED~1", no_plan), ("MIN_TRUCKS", raw(r, GOOD))], best_of=best)
    assert loads_of(results["RECOMMENDED"]) == {("T1", ("N1", "S1")), ("T2", ("N2", "S2"))}
    assert "gains" not in best and best.get("chosen_for", []) == []
    assert "extra source 'MIN_TRUCKS' is not another route search of RECOMMENDED" in caplog.text


def test_other_searches_are_repacked_after_the_options_own(monkeypatch):
    """Their repacks come last in each job (Source.extra), whatever their plans' size - the options' own get
    their time first, and a plan both make keeps the option's own name."""
    r = two_area_day()
    day, tds = _day_for(r)
    pricing = ds._pricing("RECOMMENDED", r, tds, r.stops)
    one_load = LR.time_plan(day, {0: [(0, 1)]}, pricing)  # the fewest loads: repacked first without the flag
    two_loads = LR.time_plan(day, GOOD, pricing)
    order: list = []
    monkeypatch.setattr(LR, "repack", lambda d, p, pool, *a, **kw: order.append(len(pool)) or LR.RepackResult(None, "UNKNOWN", 0.0))
    for extra, first in ((False, 3), (True, 2)):
        order.clear()
        LR.build_candidates(day, pricing, "RECOMMENDED", pricing,
                            [LR.Source("RECOMMENDED", two_loads), LR.Source("RECOMMENDED~1", one_load, extra=extra)],
                            {2: 1, 3: 1}, cap_s=1.0, budget_s=4.0, time_raw=True, fit_weights=None)
        assert order and order[0] == first, (extra, order)  # its pool: its loads + one per stop it leaves out


def test_a_real_load_recheck_with_another_search(monkeypatch):
    """No patch: the repacks run (CP-SAT) with the other search as one more source; every candidate is still
    timed and checked, and the option serves no less."""
    r = two_area_day(scenarios=["RECOMMENDED", "MIN_TRUCKS"])
    best = report()
    results = {"RECOMMENDED": raw(r, ZIGZAG), "MIN_TRUCKS": raw(r, ZIGZAG, "MIN_TRUCKS")}
    ds._post_solve(r, r.stops, ds._truck_days(r), matrix_for(r), 2, [], results, None, time.monotonic() + 60,
                   extra_sources=[("RECOMMENDED~1", raw(r, GOOD))], best_of=best)
    for sc in results.values():
        assert served_ids(sc) == {"N1", "N2", "S1", "S2"}, sc.name
        assert_plan_rules(r, sc)
    assert {g["option"] for g in best["gains"]} == {"RECOMMENDED", "MIN_TRUCKS"}
    assert best_of.report_or_none(best) is not None
