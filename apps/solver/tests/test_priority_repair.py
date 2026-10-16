"""A P1-P3 stop left out while lower priorities ride (solver search upgrade, 16 Oct 2026).

The reproduction: after the exact timing of the loads (the load re-check), a P2 stop stayed out while P3 and P4
stops rode, its reason saying "(lowest priorities first)" and the plan's warning "so the lowest priorities were
left out" - both untrue. The texts now say what is true (always on); the hire check's repair with no solve
(_repair_lost) now also runs after the load re-check of every solve when SOLVER_PRIORITY_REPAIR is on - OFF by
default (owner decision 16 Oct 2026: no plan changes before a replay of saved real requests), so with the
default every plan is the one from before.

Synthetic days only, in-process (SOLVER_PARALLEL=0 where the engine is monkeypatched: a spawned worker would not
see the patch), seconds each.
"""
from __future__ import annotations

import ast
import inspect
import textwrap
import time

import pytest

import dispatch_solver as ds
import load_repack as LR
import pyvrp_candidate as PV
from dispatch_solver import optimize_dispatch
from tests.test_dispatch import hm, rec, req, served_ids, stop, truck, unserved_map
from tests.test_repack import _day_for, assert_plan_rules, matrix_for

A, B, L3, L4 = 0, 1, 2, 3
OLD_WARNING = ("1 stop(s) the route search had planned are left out: with the loading time between loads (20 min + 0.5 "
               "min per case) its loads did not fit the truck days, so the lowest priorities were left out (see Unserved "
               "orders). Re-plan, add a truck, or check the loading time.")


@pytest.fixture(autouse=True)
def _repair_off_unless_a_test_sets_it(monkeypatch):
    monkeypatch.delenv(ds.PRIORITY_REPAIR_ENV, raising=False)


def p2_day(a_lng: float = 58.690, **cfg):
    """Two trucks of 100 cases, 2 loads each, a 5 h day, reload 20 min + 0.5 min per case. A (P1, 95 cases) about
    2 h out (4.5 h with ``a_lng`` 59.050: then its truck does nothing else), B (P2, 95 cases) 4.6 h out - only a
    truck's whole day holds it -, L3 (P3) and L4 (P4), 40 cases each, by the depot. The route search's plan T1
    [(A), (B)], T2 [(L3), (L4)] does not time exactly; trimmed, it keeps A, L3 and L4: B is out while L3 and L4
    ride. No load's swap puts B back (T2 [(B), (L4)] does not time); only T2's whole day for B does."""
    stops = [stop("A", 23.585, a_lng, cases=95, priority=1), stop("B", 22.965, 58.390, cases=95, priority=2),
             stop("L3", 23.590, 58.395, cases=40, priority=3), stop("L4", 23.580, 58.385, cases=40, priority=4)]
    trucks = [truck("T1", cap=100, max_trips=2), truck("T2", cap=100, max_trips=2)]
    return req(stops, trucks, shift_start_min=hm("07:00"), shift_max_min=300, reload_min=20, loading_min_per_case=0.5, **cfg)


def built(r, plan, *, timing=frozenset(), exact=True):
    """The scenario of ``plan`` (indices of r.stops per truck index), timed exactly (or as the search would)."""
    day, tds = _day_for(r)
    timed = LR.time_plan(day, plan, ds._pricing("RECOMMENDED", r, tds, r.stops)) if exact else \
        PV._asap(day, plan, {td.idx: 0 for td in day.trucks})
    assert timed is not None
    return ds._build_scenario("RECOMMENDED", r, r.stops, tds, matrix_for(r), timed, day.values, False, [],
                              solver_status="ROUTING_SUCCESS", elapsed=1.0, time_limit=2, objective_value=0,
                              timing_drops=set(timing), exact_timing=exact)


def why(sc) -> dict[str, str]:
    return {u.stop_id: u.reason_message for u in sc.unserved}


# --------------------------------------------------------------------------------------
# The texts (always on: they were untrue)
# --------------------------------------------------------------------------------------

def test_timing_reason_says_lower_priorities_ride():
    r = p2_day()
    sc = built(r, {0: [(A,)], 1: [(L3,), (L4,)]}, timing={B})
    msg = why(sc)["B"]
    assert msg.startswith(ds.TIMING_DROP_HEAD) and B in ds._timing_drops_of(sc, {s.stop_id: k for k, s in enumerate(r.stops)})
    assert "lowest priorities first" not in msg, msg
    assert msg.endswith("this P2 stop was left out although 2 lower-priority stops are planned: no check proves it cannot "
                        "go in their place. Re-plan, add a truck, or add it by hand in place of a lower-priority stop."), msg


def test_timing_reason_lowest_priorities_first_only_when_true():
    """No lower priority rides (L3 and L4 are out too): the text from before, word for word."""
    r = p2_day()
    sc = built(r, {0: [(A,)]}, timing={B})
    assert why(sc)["B"] == (f"{ds.TIMING_DROP_HEAD} (20 min + 0.5 min per case), the route search's loads no longer fitted "
                            "the truck days and this P2 stop was left out (lowest priorities first). Re-plan, add a truck, "
                            "or check the loading time.")


def test_timing_reason_for_the_days_lowest_priority():
    """L4 is the day's lowest priority: nothing lower was left out first."""
    r = p2_day()
    sc = built(r, {0: [(A,)], 1: [(B,)]}, timing={L4})
    assert why(sc)["L4"].endswith("and this P4 stop was left out. Re-plan, add a truck, or check the loading time."), why(sc)
    # What the priority repair did is said only when it ran (SOLVER_PRIORITY_REPAIR).
    cfg, s = r.config, r.stops[B]
    assert "found no place that keeps every rule (not a proof)" in ds._timing_drop_reason(cfg, s, "", 2, True, ds.REPAIR_NO_PLACE)
    assert "no time was left to try it in place of lower-priority stops" in ds._timing_drop_reason(cfg, s, "", 2, True, ds.REPAIR_NO_TIME)


def test_timing_warning_counts_inverted_stops():
    cfg = p2_day().config
    assert ds._timing_drop_warning(cfg, 1, 0) == ds._timing_drop_warning(cfg, 1, 0, 0) == OLD_WARNING
    w = ds._timing_drop_warning(cfg, 2, 1, inverted=1)
    assert w.startswith("2" + ds.TIMING_DROP_NOTE), w
    assert "so they were left out, 1 of them although lower-priority stops are planned (see Unserved orders)" in w, w
    assert "lowest priorities" not in w and w.endswith(" 1 stop(s) the route search had left out are planned instead."), w
    stops = p2_day().stops
    assert ds._inverted_drops(stops, {B}, {A, L3, L4}) == 1 and ds._inverted_drops(stops, {B}, {A}) == 0
    assert ds._inverted_drops(stops, {L4}, {A, B, L3}) == 0


def test_rebuilt_drops_the_warning_when_every_timing_drop_is_served():
    r = p2_day()
    sc = built(r, {0: [(A,)], 1: [(L3,), (L4,)]}, timing={B})
    sc.warnings.append(ds._timing_drop_warning(r.config, 1, 0, 1))
    ctx = ds._stage_ctx(r, r.stops, ds._truck_days(r), matrix_for(r), [])
    out = ds._rebuilt(ctx, sc, {0: [(A,), (L4, L3)], 1: [(B,)]}, None, {B}, set())
    assert out is not None and served_ids(out) == {"A", "B", "L3", "L4"}
    assert not any(ds.TIMING_DROP_NOTE in w for w in out.warnings), out.warnings  # it said "1 stop(s) ... are left out"
    assert_plan_rules(r, out)


def test_rebuilt_keeps_the_warning_verbatim_when_nothing_changed():
    r = p2_day()
    plan = {0: [(A,)], 1: [(L3,), (L4,)]}
    sc = built(r, plan, timing={B})
    sc.warnings.append(OLD_WARNING)  # as a plan made before this change says it
    ctx = ds._stage_ctx(r, r.stops, ds._truck_days(r), matrix_for(r), [])
    as_is = ds._timed_from_scenario(sc, ctx.stop_idx, ctx.truck_idx)
    same = ds._rebuilt(ctx, sc, plan, as_is, {B}, set())
    assert OLD_WARNING in same.warnings and why(same)["B"] == why(sc)["B"]
    # Still out, but no lower priority rides any more: the count changed (1 -> 0), so the warning is worked
    # out again - here the text from before, now true.
    w = ds._timing_drop_warning(r.config, 1, 0, 1)
    sc.warnings = [w]
    alone = ds._rebuilt(ctx, sc, {0: [(A,)]}, as_is, {B}, set())
    assert w not in alone.warnings and OLD_WARNING in alone.warnings, alone.warnings
    assert "(lowest priorities first)" in why(alone)["B"]


def test_regenerated_warning_markers_cover_build_scenario():
    """Every warning _build_scenario appends is found by REGENERATED_WARNING_MARKERS (or equals one it makes again:
    the driver-break problem), so a plan built again with carry_warnings never keeps an old one twice. A new
    warning in _build_scenario fails here until the list knows it."""
    tree = ast.parse(textwrap.dedent(inspect.getsource(ds._build_scenario)))
    appended = [ast.unparse(node.args[0]) for node in ast.walk(tree)
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "append"
                and isinstance(node.func.value, ast.Name) and node.func.value.id == "warnings"]
    known = {"problem": None, "_hire_drop_warning(hire_left)": ds.HIRE_DROP_NOTE}
    assert len(appended) == 5, appended
    for text in appended:
        if text in known:
            continue
        assert any(m in text for m in ds.REGENERATED_WARNING_MARKERS if isinstance(m, str) and not m.startswith(" ")), text
    assert ds.HIRE_DROP_NOTE in ds._hire_drop_warning(2)
    assert ds.TIMING_DROP_NOTE in ds._timing_drop_warning(p2_day().config, 1, 0)
    # The open-drop warning, made for real: found by its marker.
    r = req([stop("X", 23.600, 58.420, cases=10)], [truck("T1", cap=100)])
    sc = built(r, {})
    assert any(ds.REGENERATED_WARNING_MARKERS[0] in w for w in sc.warnings), sc.warnings
    # carry_warnings keeps the others once, and drops the old regenerated ones.
    ctx = ds._stage_ctx(r, r.stops, ds._truck_days(r), matrix_for(r), [])
    sc.warnings += ["The second route search's note.", "The second route search's note."]
    out = ds._rebuilt(ctx, sc, {}, None, set(), set(), carry_warnings=True)
    assert out.warnings.count("The second route search's note.") == 1
    assert sum(ds.REGENERATED_WARNING_MARKERS[0] in w for w in out.warnings) == 1, out.warnings


# --------------------------------------------------------------------------------------
# The repair (SOLVER_PRIORITY_REPAIR, off by default)
# --------------------------------------------------------------------------------------

@pytest.mark.parametrize("value,on", [("on", True), ("ON", True), (" 1 ", True), ("true", True), ("yes", True), ("off", False), ("", False), ("0", False), ("nonsense", False)])
def test_priority_repair_setting(value, on, monkeypatch):
    monkeypatch.setenv(ds.PRIORITY_REPAIR_ENV, value)
    assert ds.priority_repair_on() is on


def test_ready_and_the_startup_line_name_the_priority_repair(monkeypatch):
    """The post-deploy check (critique of the design #9): /ready's ``priority_repair`` and the startup line say
    whether it is on; off by default. Never changes ``ok``."""
    from fastapi.testclient import TestClient

    import main

    monkeypatch.setattr(main, "SOLVER_TOKEN", "unit-test-solver-token")
    client = TestClient(main.app)
    body = client.get("/ready", headers={"X-Solver-Token": "unit-test-solver-token"}).json()
    assert body["ok"] is True and body["priority_repair"] == "off"
    assert ds.priority_repair_line().startswith("Priority repair: off (the default")
    monkeypatch.setenv(ds.PRIORITY_REPAIR_ENV, "on")
    body = client.get("/ready", headers={"X-Solver-Token": "unit-test-solver-token"}).json()
    assert body["ok"] is True and body["priority_repair"] == "on"
    assert ds.priority_repair_line().startswith("Priority repair: on (SOLVER_PRIORITY_REPAIR)")


def _search_returns(monkeypatch, r, plan):
    """The route search's RECOMMENDED plan is ``plan`` (as the search would report it: its own times); the
    load re-check has no answer at once (its repacks give none), without its longer repair (F07): the stage
    keeps the trimmed plan, as a production THOROUGH whose search used its whole limit (priority map 2)."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    raw = built(r, plan, exact=False)
    assert raw.feasibility.status == "VIOLATED"
    monkeypatch.setattr(ds, "_solve_scenario", lambda name, *a, **kw: raw.model_copy(deep=True))
    monkeypatch.setattr(LR, "repack", lambda *a, **kw: LR.RepackResult(None, "UNKNOWN", 0.0))
    monkeypatch.setattr(LR, "EXTENDED_MAX_SEC", 0)


def test_a_p2_left_out_for_loading_time_goes_back_in_place_of_p3_p4(monkeypatch):
    r = p2_day()
    _search_returns(monkeypatch, r, {0: [(A,), (B,)], 1: [(L3,), (L4,)]})
    calls: list = []
    real = ds._repair_lost
    monkeypatch.setattr(ds, "_repair_lost", lambda *a, **kw: calls.append(kw) or real(*a, **kw))

    # Off (the default): the plan from before - B out, now with a true reason and warning.
    off = rec(optimize_dispatch(r))
    assert not calls and served_ids(off) == {"A", "L3", "L4"}
    assert "although 2 lower-priority stops are planned: no check proves it cannot go in their place" in why(off)["B"]
    assert any("so they were left out, 1 of them although lower-priority stops are planned" in w for w in off.warnings)
    assert_plan_rules(r, off)

    monkeypatch.setenv(ds.PRIORITY_REPAIR_ENV, "on")
    on = rec(optimize_dispatch(r))
    assert len(calls) == 1 and calls[0]["what"] == "priority repair RECOMMENDED" and calls[0]["hard_deadline"]
    assert served_ids(on) == {"A", "B", "L3", "L4"}, why(on)
    assert not on.unserved and not any(ds.TIMING_DROP_NOTE in w for w in on.warnings), on.warnings
    note = [w for w in on.warnings if ds.PRIORITY_REPAIR_NOTE in w]
    assert note and note[0].startswith("1" + ds.PRIORITY_REPAIR_NOTE) and "left out for them" not in note[0], on.warnings
    assert_plan_rules(r, on)


def test_the_stops_a_p2_takes_the_place_of_say_so(monkeypatch):
    """A's truck does nothing else (4.5 h out): B takes T2's whole day, and L3 and L4 fit nowhere else. They are
    left out with their own reason - a higher priority took their place -, never "Re-plan to search again"."""
    monkeypatch.setenv(ds.PRIORITY_REPAIR_ENV, "on")
    r = p2_day(a_lng=59.050)
    _search_returns(monkeypatch, r, {0: [(A,), (B,)], 1: [(L3,), (L4,)]})
    sc = rec(optimize_dispatch(r))
    assert served_ids(sc) == {"A", "B"}
    for sid in ("L3", "L4"):
        assert why(sc)[sid].startswith(ds.PRIORITY_DISPLACED_HEAD) and "Re-plan to search again" not in why(sc)[sid]
    assert unserved_map(sc) == {"L3": "SOLVER_DROPPED_LOW_PRIORITY", "L4": "SOLVER_DROPPED_LOW_PRIORITY"}
    assert not any("could not be placed by the optimizer" in w for w in sc.warnings), sc.warnings
    assert any(w.startswith("1" + ds.PRIORITY_REPAIR_NOTE + "; 2 lower-priority stop(s) are left out for them") for w in sc.warnings)
    assert_plan_rules(r, sc)


def test_no_inversion_means_no_repair_call(monkeypatch):
    """A clean day is not touched (no call); a P1 stop kept out by its receiving window while P5 stops ride
    (test_dispatch's window day) is tried, and its plan stays as it was."""
    monkeypatch.setenv(ds.PRIORITY_REPAIR_ENV, "on")
    monkeypatch.setenv("SOLVER_PARALLEL", "0")  # the repair runs in this process either way
    calls: list = []
    real = ds._repair_lost
    monkeypatch.setattr(ds, "_repair_lost", lambda *a, **kw: calls.append(a[5]) or real(*a, **kw))
    clean = req([stop("C1", 23.600, 58.420, cases=30, priority=2), stop("C2", 23.610, 58.430, cases=30, priority=5)],
                [truck("T1", cap=100)])
    sc = rec(optimize_dispatch(clean))
    assert served_ids(sc) == {"C1", "C2"} and not calls
    win = dict(priority=1, hard_start_min=hm("08:00"), hard_end_min=hm("08:15"))
    stops = [stop("Z1", 23.75, 58.39, cases=10, demand_kg=1000, **win), stop("Z2", 23.42, 58.39, cases=10, demand_kg=1000, **win),
             stop("W", 23.586, 58.391, cases=10, demand_kg=1500, priority=5),
             stop("V", 23.587, 58.392, cases=10, demand_kg=2500, priority=5)]
    trucks = [truck("T01", cap=500, capacity_kg=3000, max_trips=1),
              truck("T02", cap=500, capacity_kg=3000, max_trips=1, available_from_min=hm("09:00"))]
    sc = rec(optimize_dispatch(req(stops, trucks, shift_start_min=hm("06:00"))))
    left = [u for u in sc.unserved if u.stop_id in ("Z1", "Z2")]
    assert len(left) == 1 and calls == [{left[0].stop_id}], (calls, sc.unserved)
    assert not any(ds.PRIORITY_REPAIR_NOTE in w for w in sc.warnings)
    assert "found no truck, trip or time slot for this P1 stop" in left[0].reason_message


def test_the_repair_keeps_to_its_deadline(monkeypatch):
    """The cap is enforced in every step (critique: the swaps were bounded by their count of timings only).
    Eight idle trucks more give B a dozen places, each timing made slow (0.3 s) and failing: a 1 s repair returns
    within about a second (without the cap the swap alone would time them all, about 4 s), its plan as it was and
    B's reason saying there was no time to try; with no time left at all it does not start."""
    r = p2_day()
    r.trucks.extend(truck(f"T{i}", cap=100, max_trips=2) for i in range(3, 11))
    sc = built(r, {0: [(A,)], 1: [(L3,), (L4,)]}, timing={B})
    mx = matrix_for(r)
    real = LR.time_plan
    timings: list = []

    def slow(day, plan, *a, **kw):
        timings.append(1)
        time.sleep(0.3)
        return None if any(B in ld for loads in plan.values() for ld in loads) else real(day, plan, *a, **kw)

    monkeypatch.setattr(LR, "time_plan", slow)
    monkeypatch.setattr(ds, "PRIORITY_REPAIR_SEC", 1.0)
    results = {"RECOMMENDED": sc}
    t = time.monotonic()
    assert ds._repair_inversions(r, r.stops, mx, [], results, time.monotonic() + 600, None) == set()
    took = time.monotonic() - t
    assert took < 2.0 and len(timings) <= 6, (took, len(timings))
    assert results["RECOMMENDED"] is sc and served_ids(sc) == {"A", "L3", "L4"}
    assert "no time was left to try it in place of lower-priority stops" in why(sc)["B"], why(sc)["B"]
    # The request's budget nearly used up (less than STAGE_GRACE_SEC + 1 s left): no call at all.
    monkeypatch.setattr(LR, "time_plan", real)
    calls: list = []
    monkeypatch.setattr(ds, "_repair_lost", lambda *a, **kw: calls.append(1))
    sc2 = built(r, {0: [(A,)], 1: [(L3,), (L4,)]}, timing={B})
    assert ds._repair_inversions(r, r.stops, mx, [], {"RECOMMENDED": sc2}, time.monotonic() + ds.STAGE_GRACE_SEC + 0.5, None) == set()
    assert not calls and "no time was left to try it" in why(sc2)["B"]
    # A deadline already past: the swap times nothing, and every stop is among those not tried.
    ctx = ds._stage_ctx(r, r.stops, ds._truck_days(r), mx, [])
    plan, put, cut = ds._swap_riders(ctx, {0: [(A,)], 1: [(L3,), (L4,)]}, [B], deadline=time.monotonic() - 1)
    assert put == [] and cut == [B] and plan == {0: [(A,)], 1: [(L3,), (L4,)]}


def test_the_serves_more_note_compares_service_by_priority_after_a_repair(monkeypatch):
    """After the repair, RECOMMENDED serves A and B; MIN_TRUCKS serves A, L3 and L4 - one stop more, but the P2
    out. "The MIN TRUCKS option serves 1 more stop(s)" would point the dispatcher at the worse plan."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    monkeypatch.setenv(ds.PRIORITY_REPAIR_ENV, "on")
    r = p2_day(a_lng=59.050, scenarios=["RECOMMENDED", "MIN_TRUCKS"])
    trimmed = built(r, {0: [(A,)], 1: [(L3,), (L4,)]})
    fixed = built(r, {0: [(A,)], 1: [(B,)]})

    def search(name, *a, **kw):
        out = trimmed.model_copy(deep=True)
        out.name = name
        return out

    monkeypatch.setattr(ds, "_solve_scenario", search)
    monkeypatch.setattr(ds, "_post_solve", lambda *a, **kw: None)
    note = "The MIN TRUCKS option serves 1 more stop(s)"
    for changed in ({"RECOMMENDED"}, set()):
        def repaired(req_, solvable, mx, drops, results, *a, changed=changed):
            results["RECOMMENDED"] = fixed.model_copy(deep=True)
            return set(changed)

        monkeypatch.setattr(ds, "_repair_inversions", repaired)
        warnings = rec(optimize_dispatch(r)).warnings
        assert any(note in w for w in warnings) is (not changed), (changed, warnings)


def test_hire_trials_never_repair(monkeypatch):
    """The hire check repairs its solves' plans itself (_reduce_hire's judge)."""
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    monkeypatch.setenv(ds.PRIORITY_REPAIR_ENV, "on")
    seen: list = []
    monkeypatch.setattr(ds, "_run_scenarios", lambda *a, **kw: seen.append(kw) or [])
    r = p2_day()
    assert ds._hire_trial(r, r.stops, matrix_for(r), [], 2, time.monotonic() + 60, None) == (None, False)
    assert seen and seen[0]["repair_inversions"] is False
