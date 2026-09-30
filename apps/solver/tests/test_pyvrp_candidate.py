"""The second route search (PyVRP 0.14.0, pyvrp_candidate.py): its model, its safety rules, the
never-worse guard of the load re-check, and its process (its own, stop, cancel, failures).

Critique-driven (SPEC.md review, 30 Sep 2026): the promise is "never worse than the engine alone FROM
THE SAME SEARCH"; its process is optional (rule 22 refuses only when the engine's own workers cannot
run); a dead worker is LOST at once; its repack runs apart from the engine's stage; its answer is
collected before the engine's pool closes; ties keep the engine's plan; the rescue of an option with
no plan; the note compares with the engine's final plan; the 64-bit guard."""
from __future__ import annotations

import copy
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
from importlib.metadata import version

import numpy as np
import pytest

import dispatch_solver as ds
import load_repack as LR
import pyvrp_candidate as PV
from dispatch_models import DispatchDepot, FrozenTrip, kg_units
from tests.test_dispatch import DEPOT, assert_reconciled, hm, nmwc_day, rec, req, stop, truck

HERE = os.path.dirname(__file__)
ALL3 = ["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"]


@pytest.fixture
def pv_on(monkeypatch):
    monkeypatch.setenv("SOLVER_PYVRP", "on")
    monkeypatch.setattr(PV, "effective_cpus", lambda: 4)


@pytest.fixture
def inprocess(monkeypatch, pv_on):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    monkeypatch.setenv("SOLVER_PYVRP_MAX_ITERS", "800")


@pytest.fixture
def workers(monkeypatch, pv_on):
    """Production settings: worker processes (the engine's pool and the second search's own)."""
    monkeypatch.delenv("SOLVER_PARALLEL", raising=False)
    monkeypatch.delenv("SOLVER_ALLOW_INPROCESS_FALLBACK", raising=False)
    monkeypatch.setenv("SOLVER_PYVRP_STOP_GRACE_SEC", "3")


@pytest.fixture
def deterministic_repack(monkeypatch):
    """CP-SAT with one worker and no clock-driven stall stop: the same inputs give the same
    candidates (critique correction 7), so "never worse" is a deterministic check."""
    real = LR.repack
    monkeypatch.setattr(LR, "repack", lambda *a, **k: real(*a, **{**k, "workers": 1}))
    monkeypatch.setattr(LR, "_solve_until_stalled", lambda solver, model, limit: solver.Solve(model))


def _prepared(r):
    """What optimize_dispatch computes before its searches."""
    tds = ds._truck_days(r)
    solvable, drops, _ = ds._prefilter(r, tds)
    cfg = r.config
    mx = ds.resolve_matrix([(r.depot.lat, r.depot.lng)] + [(s.lat, s.lng) for s in solvable], provider=cfg.distance_provider,
                           osrm_url=None, haversine_multiplier=cfg.haversine_multiplier, avg_speed_kmh=cfg.avg_speed_kmh,
                           road_time_factor=cfg.road_time_factor)
    keep, window_drops = ds._window_prefilter(solvable, tds, mx, cfg)
    drops = drops + window_drops
    if len(keep) != len(solvable):
        solvable, mx = ds._submatrix(solvable, keep, mx)
    return tds, solvable, drops, mx


def _settings(**kw) -> PV.PvSettings:
    return PV.PvSettings(**{"mode": "QUICK", "seed": 1, "max_runtime": 30.0, "min_sec": 1.0, "max_iters": 800, **kw})


def _vt(model, idx):
    return next(v for v, ts in zip(model.vehicle_types, model.type_trucks) if idx in ts)


# ---------------------------------------------------------------------------------------------
# The model (no search)
# ---------------------------------------------------------------------------------------------

def test_vehicle_types_group_interchangeable_trucks_and_reloads_follow_trips_left():
    stops, _ = nmwc_day(20)
    trucks = [truck("B", cap=500), truck("A", cap=500), truck("C", cap=800), truck("D", cap=500, max_trips=1)]
    r = req(stops, trucks, reload_min=25)
    tds, solvable, _, mx = _prepared(r)
    m = PV.build_model(r, solvable, tds, mx)
    assert sorted(len(ts) for ts in m.type_trucks) == [1, 1, 2]
    assert [tds[i].truck.id for i in next(ts for ts in m.type_trucks if len(ts) == 2)] == ["A", "B"]  # code order
    assert all(v["num_available"] == len(ts) for v, ts in zip(m.vehicle_types, m.type_trucks))
    gap = ds._approx_gap_s(r.config, tds[0])
    assert [d["service"] for d in m.depots] == [0, gap]  # one reload depot per distinct turnaround
    assert _vt(m, 0)["max_reloads"] == 2 and _vt(m, 0)["reload_depots"] == [1]
    assert _vt(m, 3)["max_reloads"] == 0 and _vt(m, 3)["reload_depots"] == []


def test_capacity_in_cases_and_p6_kg_units():
    stops = [stop("S1", 23.60, 58.40, cases=10, demand_kg=100.04), stop("S2", 23.61, 58.41, cases=5, demand_kg=2999.96)]
    r = req(stops, [truck("K", cap=100, capacity_kg=3000.09), truck("N", cap=90)])
    tds, solvable, _, mx = _prepared(r)
    m = PV.build_model(r, solvable, tds, mx)
    assert [c["delivery"] for c in m.clients] == [[10, kg_units(100.04)], [5, kg_units(2999.96)]]
    assert _vt(m, 0)["capacity"] == [100, tds[0].max_kg_units]  # the payload rounded down (P6)
    assert _vt(m, 1)["capacity"] == [90, kg_units(100.04) + kg_units(2999.96) + 1]  # no payload: unlimited


@pytest.mark.parametrize("strict", [True, False])
def test_prizes_are_the_engines_drop_penalties(strict):
    stops, trucks = nmwc_day(20, seed=2)
    stops = [s.model_copy(update={"margin": 1.0 + k}) for k, s in enumerate(stops)]
    r = req(stops, trucks, strict_priorities=strict)
    tds, solvable, _, mx = _prepared(r)
    values, _ = ds._service_values(solvable, r.config, True)
    assert [c["prize"] for c in PV.build_model(r, solvable, tds, mx).clients] == ds._drop_penalties(values, ds.SCENARIOS["RECOMMENDED"])


def test_settings_hours_reach_the_model_owner_07_to_18():
    """Owner answer 8: the working day is 07:00-18:00 and 18:00 is the latest return; overtime stays as
    set. Nothing in the model holds a time of day: the request (Settings) moves every window."""
    stops, trucks = nmwc_day(20)
    depot = DispatchDepot(id="d", lat=DEPOT.lat, lng=DEPOT.lng, close_min=hm("18:00"))
    r = req(stops, trucks, shift_start_min=hm("07:00"), shift_max_min=11 * 60, overtime_after_min=8 * 60,
            overtime_cost_per_hour=4.0, driver_cost_per_hour=2.5)
    r = r.model_copy(update={"depot": depot})
    tds, solvable, _, mx = _prepared(r)
    v = PV.build_model(r, solvable, tds, mx).vehicle_types[0]
    assert (v["tw_early"], v["tw_late"]) == (hm("07:00") * 60, hm("18:00") * 60)
    assert v["shift_duration"] == 8 * 3600 and v["shift_duration"] + v["max_overtime"] == 11 * 3600
    assert v["unit_overtime_cost"] == round(4.0 * 1e5 / 3600) and v["unit_duration_cost"] == round(2.5 * 1e5 / 3600)


def test_frozen_truck_and_same_day_windows():
    stops, _ = nmwc_day(20)
    frozen = [FrozenTrip(load_no=1, depart_min=hm("07:00"), return_min=hm("09:30"), cases=90)]
    trucks = [truck("F", cap=500, fixed_cost=25, frozen_trips=frozen), truck("G", cap=500, fixed_cost=25)]
    r = req(stops, trucks, reload_min=30, loading_from_min=hm("08:00"), overtime_after_min=9 * 60)
    tds, solvable, _, mx = _prepared(r)
    m = PV.build_model(r, solvable, tds, mx)
    f, g = _vt(m, 0), _vt(m, 1)
    gap = ds._approx_gap_s(r.config, tds[0])
    assert f["tw_early"] == max(tds[0].earliest_depart_s, tds[0].ready_s + gap)  # the engine's first new departure
    assert f["tw_late"] == min(tds[0].latest_return_s, (hm("07:00") + r.config.shift_max_min) * 60)
    assert f["max_reloads"] == tds[0].trips_left - 1 == 1
    assert f["fixed_cost"] == 0 and g["fixed_cost"] == 25 * 100_000  # B3: an out truck opens no new truck
    assert g["tw_early"] == max(tds[1].earliest_depart_s, (hm("08:00") * 60) + gap)
    # Only new overtime (E4): paid from the later of anchor + overtime_after and the frozen return.
    assert f["tw_early"] + f["shift_duration"] == LR.overtime_bound_s(tds[0], 9 * 3600)


def test_continuity_gives_one_type_per_truck_and_prices_moved_stops():
    stops, _ = nmwc_day(20)
    stops = [s.model_copy(update={"previous_truck_id": "A" if k % 2 else None}) for k, s in enumerate(stops)]
    r = req(stops, [truck("A"), truck("B")], change_penalty_per_stop=3.0)
    tds, solvable, _, mx = _prepared(r)
    m = PV.build_model(r, solvable, tds, mx)
    assert len(m.vehicle_types) == 2 and len(m.dist) == 2
    R = len(m.depots) - 1
    prof = {tds[ts[0]].truck.id: m.dist[vt["profile"]] for vt, ts in zip(m.vehicle_types, m.type_trucks)}
    for k, s in enumerate(solvable):  # into a stop that sat on truck A: + the change price on truck B only
        assert prof["B"][0, 1 + R + k] - prof["A"][0, 1 + R + k] == (300_000 if s.previous_truck_id == "A" else 0)


def test_prefhard_tightens_only_with_a_price_and_a_nonempty_intersection():
    a = stop("A", 23.60, 58.40, hard_start_min=hm("07:00"), hard_end_min=hm("12:00"), pref_start_min=hm("09:00"), pref_end_min=hm("10:00"))
    b = stop("B", 23.61, 58.41, hard_start_min=hm("07:00"), hard_end_min=hm("08:00"), pref_start_min=hm("09:00"), pref_end_min=hm("10:00"))
    for price, want_a in ((0.05, (hm("09:00"), hm("10:00"))), (0.0, (hm("07:00"), hm("12:00")))):
        r = req([a, b], [truck("T")], pref_window_penalty_per_min=price)
        tds, solvable, _, mx = _prepared(r)
        cl = {s.stop_id: c for s, c in zip(solvable, PV.build_model(r, solvable, tds, mx).clients)}
        assert (cl["A"]["tw_early"], cl["A"]["tw_late"]) == (want_a[0] * 60, want_a[1] * 60)
        assert (cl["B"]["tw_early"], cl["B"]["tw_late"]) == (hm("07:00") * 60, hm("08:00") * 60)  # empty: hard kept


def test_model_prices_an_engine_plan_within_one_percent():
    """PyVRP's own cost of its best plan against the engine's operating money for the same plan
    (driver pay rounded to whole units a second: -0.6% of it; measured -0.14% to -0.20% overall)."""
    import pyvrp

    stops, trucks = nmwc_day(30, seed=2)
    r = req(stops, trucks, driver_cost_per_hour=2.5, fuel_price_per_litre=0.26, pref_window_penalty_per_min=0.0,
            early_preference_per_min={p: 0.0 for p in range(1, 6)})
    tds, solvable, _, mx = _prepared(r)
    m = PV.build_model(r, solvable, tds, mx)
    res = pyvrp.solve(PV.problem_data(m), stop=pyvrp.stop.MaxIterations(1500), seed=1, collect_stats=False, display=False)
    assert res.best.is_feasible() and res.best.num_missing_clients() == 0
    plan, why = PV.plan_of(dict(routes=PV.routes_of(res.best), type_trucks=m.type_trucks), tds, solvable)
    ctx = ds._stage_ctx(r, solvable, tds, mx, [])
    timed = LR.time_plan(ctx.day, plan, ctx.rec_pricing)
    op = LR.score(ctx.day, ctx.rec_pricing, timed).operating
    pv_cost = res.best.distance_cost() + res.best.duration_cost() + res.best.fixed_vehicle_cost()
    assert abs(pv_cost - op) / op < 0.01, (pv_cost, op)


# ---------------------------------------------------------------------------------------------
# Penalties and 64-bit safety
# ---------------------------------------------------------------------------------------------

def test_penalty_default_without_shortage_raised_and_bounded_with_shortage(monkeypatch):
    stops, trucks = nmwc_day(20)
    r = req(stops, trucks)
    tds, solvable, _, mx = _prepared(r)
    assert ds._fleet_shortage(solvable, tds) == (False, False)
    m = PV.build_model(r, solvable, tds, mx)
    assert (m.penalty_mode, m.max_penalty) == ("DEFAULT", PV.DEFAULT_MAX_PENALTY)
    short = req(stops, [truck("T", cap=100, max_trips=1)])
    tds, solvable, _, mx = _prepared(short)
    assert ds._fleet_shortage(solvable, tds)[0]
    m = PV.build_model(short, solvable, tds, mx)
    assert m.penalty_mode == "RAISED" and m.max_penalty == 10 * max(c["prize"] for c in m.clients)
    # The largest prize scale measured (syn300: 2.42e15): clamped so that the bound stays below 2^62.
    monkeypatch.setattr(ds, "_drop_penalties", lambda values, w: [int(2.42e15)] * len(values))
    m = PV.build_model(short, solvable, tds, mx)
    base, per_unit = PV.worst_case(sum(c["prize"] for c in m.clients), m.vehicle_types, m.dist, m.dur, m.clients, m.depots)
    assert m.max_penalty < 10 * 2.42e15 and base + int(m.max_penalty) * per_unit < 2**62
    monkeypatch.setattr(ds, "_drop_penalties", lambda values, w: [2**61] * len(values))
    with pytest.raises(PV.ModelTooLarge):
        PV.build_model(short, solvable, tds, mx)


def test_shortage_day_serves_p1_before_p5(inprocess):
    stops = [stop("P1", 23.60, 58.40, cases=80, priority=1)] + [stop(f"P5-{i}", 23.60 + i / 100, 58.41, cases=20, priority=5)
                                                                 for i in range(5)]
    resp = ds.optimize_dispatch(req(stops, [truck("T", cap=100, max_trips=1)]))
    sc = rec(resp)
    assert "P1" in {st.stop_id for ld in sc.loads for st in ld.stops}
    assert sc.unserved and all("shortage" in u.reason_message.lower() for u in sc.unserved)
    assert resp.search.pyvrp.penalty_mode == "RAISED"


# ---------------------------------------------------------------------------------------------
# Round trip and the judge
# ---------------------------------------------------------------------------------------------

def test_pyvrp_plan_maps_back_and_is_verified():
    stops, trucks = nmwc_day(30)
    r = req(stops, trucks, fuel_price_per_litre=0.26, driver_cost_per_hour=2.5)
    tds, solvable, drops, mx = _prepared(r)
    out = PV.solve_in_worker((r, solvable, tds, mx, _settings()))
    assert out["status"] == "OK" and out["feasible"] and out["stop_reason"] == "ITERATIONS" and out["version"] == "0.14.0"
    plan, why = PV.plan_of(out, tds, solvable)
    assert why is None
    ctx = ds._stage_ctx(r, solvable, tds, mx, drops)
    timed = LR.time_plan(ctx.day, plan, ctx.rec_pricing)
    sc = ds._build_scenario("RECOMMENDED", r, solvable, tds, mx, timed, ctx.values, ctx.use_margin, drops, solver_status="PYVRP",
                            elapsed=1, time_limit=1, objective_value=LR.score(ctx.day, ctx.rec_pricing, timed).objective)
    assert sc.feasibility.status == "VERIFIED"
    assert_reconciled(r, sc)


def _raw_engine(r, limit=1):
    tds, solvable, drops, mx = _prepared(r)
    results = {"RECOMMENDED": ds._scenario_worker(("RECOMMENDED", r, solvable, tds, mx, limit, drops))}
    warm = results["RECOMMENDED"].loads or None
    for n in ("MIN_TRUCKS", "MIN_DISTANCE"):
        results[n] = ds._scenario_worker((n, r, solvable, tds, mx, limit, drops, warm))
    return tds, solvable, drops, mx, results


def _stage(r, prepared, pv_plan, monkeypatch):
    """The load re-check on a deep copy of the engine's raw plans: (options, picked plans, the
    engine's stage outputs, the second search's report)."""
    tds, solvable, drops, mx, raw = prepared
    results = copy.deepcopy(raw)
    picked: dict = {}
    engine_out: list = []
    real_build, real_stage = ds._build_scenario, ds._stage_worker

    def build(name, *a, **k):
        picked[name] = (a[4], k["objective_value"])  # (req, stops, tds, mx, timed, ...)
        return real_build(name, *a, **k)

    def stage(job):
        out = real_stage(job)
        engine_out.append((job["goal"], [(c.source, c.score) for c in out[0]], [re.sub(r" in [0-9.]+s", "", n) for n in out[1]]))
        return out

    monkeypatch.setattr(ds, "_build_scenario", build)
    monkeypatch.setattr(ds, "_stage_worker", stage)
    pv = None
    if pv_plan is not None:
        pv = ds._PvRun(report={"status": "NOT_CHOSEN", "reason": None, "chosen_for": []}, inprocess=True)
        pv.plan = pv_plan
    ds._post_solve(r, solvable, tds, mx, 2, drops, results, None, time.monotonic() + 600, set(), pv=pv)
    monkeypatch.setattr(ds, "_build_scenario", real_build)
    monkeypatch.setattr(ds, "_stage_worker", real_stage)
    return results, picked, engine_out, (pv.report if pv else None)


def _days():
    frozen = [FrozenTrip(load_no=1, depart_min=hm("07:00"), return_min=hm("09:30"), cases=90)]
    s20, t20 = nmwc_day(20, seed=2)
    return {
        "nmwc20s1": req(*nmwc_day(20, seed=1), scenarios=ALL3, driver_cost_per_hour=2.5, fuel_price_per_litre=0.26),
        "nmwc30s2": req(*nmwc_day(30, seed=2), scenarios=ALL3, driver_cost_per_hour=2.5, fuel_price_per_litre=0.26),
        "nmwc40s1": req(*nmwc_day(40, seed=1), scenarios=ALL3, driver_cost_per_hour=2.5, fuel_price_per_litre=0.26),
        "frozen": req(s20, [t20[0].model_copy(update={"frozen_trips": frozen})] + t20[1:], scenarios=ALL3, driver_cost_per_hour=2.5),
        "same-day": req(s20, t20, scenarios=ALL3, loading_from_min=hm("08:00"), driver_cost_per_hour=2.5),
    }


@pytest.mark.parametrize("day", ["nmwc20s1", "nmwc30s2", "nmwc40s1", "frozen", "same-day"])
def test_hybrid_never_worse_than_engine_alone_on_the_same_seed(day, deterministic_repack, monkeypatch):
    """The guard: the same engine search, re-checked without (E) and with (H) the second search's
    plan. For every option H <= E on its own goal (service first), H is VERIFIED and its objective is
    an exact re-score, and the engine's own candidates are identical in E and H (its jobs never see
    the extra source). Every CP-SAT solve ends OPTIMAL, so a flaky timeout fails here."""
    r = _days()[day]
    prepared = _raw_engine(r)
    tds, solvable, drops, mx, _ = prepared
    out = PV.solve_in_worker((r, solvable, tds, mx, _settings()))
    plan, why = PV.plan_of(out, tds, solvable)
    assert why is None
    e_res, e_pick, e_eng, _ = _stage(r, prepared, None, monkeypatch)
    h_res, h_pick, h_eng, report = _stage(r, prepared, plan, monkeypatch)
    assert h_eng == e_eng  # the engine's candidates: same sources, plans' scores, notes
    assert all("OPTIMAL" in n for _g, _c, notes in e_eng for n in notes if "repack" in n), e_eng
    ctx = ds._stage_ctx(r, solvable, tds, mx, drops)
    for name in ALL3:
        e_timed, _ = e_pick[name]
        h_timed, h_obj = h_pick[name]
        e_score = LR.score(ctx.day, ctx.rec_pricing, e_timed)
        h_score = LR.score(ctx.day, ctx.rec_pricing, h_timed)
        goal = ds._GOALS[name]
        assert goal(h_score) <= goal(e_score), (name, goal(h_score), goal(e_score))
        assert h_score.unserved <= e_score.unserved
        assert h_res[name].feasibility.status == "VERIFIED"
        rescored = LR.score(ctx.day, ctx.rec_pricing, LR.time_plan(ctx.day, LR.plan_of(h_timed), ctx.rec_pricing))
        assert rescored.objective == h_obj == h_score.objective
    assert report["status"] in ("CHOSEN", "NOT_CHOSEN")


def test_a_tie_keeps_the_engines_plan(deterministic_repack, monkeypatch):
    """The second search offering exactly the engine's recommended plan: every option keeps an engine
    plan (ties: own source, then any engine source, then the second search; critique C7)."""
    r = _days()["nmwc20s1"]
    prepared = _raw_engine(r)
    tds, solvable, drops, mx, raw = prepared
    ctx = ds._stage_ctx(r, solvable, tds, mx, drops)
    same = LR.plan_of(ds._timed_from_scenario(raw["RECOMMENDED"], ctx.stop_idx, ctx.truck_idx))
    res, _, _, report = _stage(r, prepared, same, monkeypatch)
    assert report == {"status": "NOT_CHOSEN", "reason": "NOT_BETTER", "chosen_for": []}
    assert not any("second route search" in w for sc in res.values() for w in sc.warnings)


def test_unverified_pyvrp_pick_falls_back_to_the_engine(monkeypatch, caplog):
    """Belt and braces: a candidate of the second search that fails the independent check is never
    returned; the engine's plan is used and a WARNING says so."""
    r = _days()["nmwc20s1"]
    prepared = _raw_engine(r)
    tds, solvable, drops, mx, raw = prepared
    usable = next(td for td in tds if td.usable)
    starts = tuple(hm("07:00") * 60 + 600 * k for k in range(len(solvable)))
    bad = {usable.idx: [LR.TimedLoad(stops=tuple(range(len(solvable))), depart_s=hm("06:30") * 60, starts=starts,
                                    return_s=starts[-1] + 3600)]}
    fake = LR.Candidate("PYVRP", bad, LR.Score(unserved=0, cost=1, trucks=1, loads=1, metres=1, operating=1))
    monkeypatch.setattr(PV, "stage_in_worker", lambda job: ([fake], ["PYVRP: injected"]))
    caplog.set_level(logging.WARNING, logger="routeiq.dispatch")
    res, _, _, report = _stage(r, prepared, {usable.idx: [tuple(range(len(solvable)))]}, monkeypatch)
    assert "candidate failed the independent check" in caplog.text
    assert report["status"] == "NOT_CHOSEN" and report["reason"] == "NOT_VERIFIED"
    for sc in res.values():
        assert sc.feasibility.status == "VERIFIED"
        assert not any("second route search" in w for w in sc.warnings)


@pytest.mark.parametrize("bad", ["duplicate", "over-capacity", "too-many-loads", "breaks-a-window"])
def test_a_bad_pyvrp_plan_never_wins(bad, inprocess, monkeypatch, caplog):
    stops = [stop("A", 23.59, 58.395, cases=40, hard_start_min=hm("06:00"), hard_end_min=hm("06:10")),
             stop("B", 23.62, 58.42, cases=40), stop("C", 23.64, 58.44, cases=40)]
    plan = {"duplicate": {0: [[0, 1], [1, 2]]}, "over-capacity": {0: [[0, 1, 2]]},
            "too-many-loads": {0: [[0], [1], [2]]}, "breaks-a-window": {0: [[1, 0]]}}[bad]
    monkeypatch.setenv("ROUTEIQ_TEST_PYVRP_PLAN", json.dumps(plan))
    caplog.set_level(logging.INFO, logger="routeiq.dispatch")
    resp = ds.optimize_dispatch(req(stops, [truck("T", cap=100, max_trips=2), truck("U", cap=100, max_trips=2)], scenarios=ALL3))
    p = resp.search.pyvrp
    if bad == "breaks-a-window":
        # Timed exactly, it breaks A's window: discarded; only repairs of it that pass every check may compete.
        assert "PYVRP: infeasible when timed exactly; discarded" in caplog.text
    else:
        assert (p.status, p.reason, p.chosen_for) == ("NOT_CHOSEN", "INVALID_PLAN", [])
    for sc in resp.scenarios:
        assert sc.status == "OPTIMIZED" and sc.feasibility.status == "VERIFIED"
        assert bad == "breaks-a-window" or not any("second route search" in w for w in sc.warnings)


def test_options_with_no_plan_are_rescued_by_the_second_search(inprocess, monkeypatch):
    """Every search found no plan (no engine source at all; critique C6): each option takes the second
    search's best plan for its goal, and the search report no longer says "no plan"."""
    real = ds._scenario_worker

    def nothing(args):
        name, _req, solvable, tds, mx, limit, drops = args[:7]
        return ds._empty_scenario(name, "NO_SOLUTION", drops, limit, mx, tds)

    monkeypatch.setattr(ds, "_scenario_worker", nothing)
    stops, trucks = nmwc_day(20)
    resp = ds.optimize_dispatch(req(stops, trucks, scenarios=ALL3))
    monkeypatch.setattr(ds, "_scenario_worker", real)
    for sc in resp.scenarios:
        assert sc.status == "OPTIMIZED" and sc.feasibility.status == "VERIFIED", sc.name
        # Its own status, not the failed search's "no plan found in the time allowed" (plan screen, Excel).
        assert sc.solver_status == "SECOND_SEARCH", sc.name
        # One note (decision D4).
        assert [w for w in sc.warnings if "second route search" in w] == [
            "The main route search found no plan for this option; this plan comes from a second route search. "
            "It passed the planner's own checks, timing and costs."]
    assert resp.search.pyvrp.status == "CHOSEN" and sorted(resp.search.pyvrp.chosen_for) == sorted(ALL3)
    assert resp.search.stop_reason != "NO_PLAN"


def _cand(source, *, cost, trucks, loads, km, omr, unserved=0):
    return LR.Candidate(source, {}, LR.Score(unserved, round(cost * ds.COST_SCALE), trucks=trucks, loads=loads,
                                             metres=round(km * 1000), operating=round(omr * ds.COST_SCALE)))


def test_the_note_names_the_options_own_goal_and_compares_with_the_engines_final_plan():
    """The note compares with the engine's final plan for the option (critique C8) on that option's
    own goal: "better" only for the goal's measure; the other figures are neutral and only shown when
    they changed. Plain words: no PyVRP."""
    tail = " It passed the planner's own checks, timing and costs."
    # RECOMMENDED is judged on the total cost with the customer time preferences, not the operating cost.
    ref = _cand("RECOMMENDED+repack:RECOMMENDED", cost=546, trucks=6, loads=17, km=990, omr=545)
    best = _cand("PYVRP+repack:RECOMMENDED", cost=499, trucks=5, loads=14, km=990, omr=498)
    assert ds._second_search_note("RECOMMENDED", False, ref, best, {1, 2}, {1, 2}) == (
        "A second route search found a better plan for this option than the main search: a lower total cost "
        "including the customer time preferences, 546 -> 499 OMR. Also changed: trucks 6 -> 5, loads 17 -> 14, "
        "operating cost 545 -> 498 OMR." + tail)
    # Fewer preference penalties, more operating cost: the OMR going up is not called better.
    pref = _cand("PYVRP+repack:RECOMMENDED", cost=540, trucks=6, loads=17, km=990, omr=549)
    assert ds._second_search_note("RECOMMENDED", False, ref, pref, {1}, {1}) == (
        "A second route search found a better plan for this option than the main search: a lower total cost "
        "including the customer time preferences, 546 -> 540 OMR. Also changed: operating cost 545 -> 549 OMR." + tail)
    # MIN_DISTANCE (real80 Quick): fewer km with one truck more - the km are the goal, the trucks neutral.
    ref = _cand("MIN_DISTANCE+repack:RECOMMENDED", cost=530, trucks=5, loads=14, km=978.1, omr=529)
    best = _cand("PYVRP+repack:RECOMMENDED", cost=542, trucks=6, loads=15, km=974.2, omr=541)
    assert ds._second_search_note("MIN_DISTANCE", False, ref, best, {1}, {1}) == (
        "A second route search found a better plan for this option than the main search: fewer km, 978.1 -> 974.2 km. "
        "Also changed: trucks 5 -> 6, loads 14 -> 15, operating cost 529 -> 541 OMR." + tail)
    # MIN_TRUCKS: trucks, then loads, then the operating cost; nothing else changed: no "Also changed".
    ref = _cand("MIN_TRUCKS", cost=530, trucks=5, loads=14, km=978.1, omr=529)
    best = _cand("PYVRP+repack:MIN_TRUCKS", cost=530, trucks=5, loads=13, km=978.1, omr=529)
    assert ds._second_search_note("MIN_TRUCKS", False, ref, best, {1}, {1}) == (
        "A second route search found a better plan for this option than the main search: fewer loads, 14 -> 13." + tail)
    # More stops planned comes first, whatever the goal.
    more = _cand("PYVRP", cost=530, trucks=5, loads=14, km=978.1, omr=529)
    ref_more = _cand("MIN_TRUCKS", cost=530, trucks=5, loads=14, km=978.1, omr=529, unserved=5)
    assert ds._second_search_note("MIN_TRUCKS", False, ref_more, more, {1}, {1, 2, 3}).startswith(
        "A second route search found a better plan for this option than the main search: 2 more stop(s) planned.")
    note = ds._second_search_note("RECOMMENDED", True, None, best, set(), {1})
    assert note.startswith("The main route search found no plan") and "PyVRP" not in note


def test_a_gain_too_small_to_show_is_not_a_better_plan():
    """Case 3 of the review: one cost unit (0.00001 OMR) printed "529 -> 529 OMR". A gain the note cannot
    show (under 1 OMR, 1 km, or equal trucks / loads) is no gain: the engine's plan is kept."""
    ref = _cand("RECOMMENDED", cost=529.01, trucks=5, loads=14, km=978.1, omr=529)
    for name, best in [("RECOMMENDED", _cand("PYVRP", cost=529.00999, trucks=5, loads=14, km=978.1, omr=529)),
                       ("RECOMMENDED", _cand("PYVRP", cost=528.2, trucks=4, loads=12, km=900, omr=520)),
                       ("MIN_DISTANCE", _cand("PYVRP", cost=500, trucks=4, loads=12, km=977.3, omr=499)),
                       ("MIN_TRUCKS", _cand("PYVRP", cost=528.6, trucks=5, loads=14, km=978.1, omr=528.6))]:
        assert ds._goal_gain(name, ref.score, best.score, 0) is None, (name, best.score)
    assert ds._goal_gain("MIN_DISTANCE", ref.score, _cand("PYVRP", cost=600, trucks=6, loads=15, km=977.0, omr=600).score, 0) \
        == "fewer km, 978.1 -> 977.0 km"


def test_a_gain_too_small_to_show_keeps_the_engines_plan(deterministic_repack, monkeypatch):
    """In the load re-check: the second search offering the engine's own final RECOMMENDED plan one cost
    unit cheaper wins the goal's sort but not the note's threshold - every option keeps the engine's plan."""
    r = _days()["nmwc20s1"]
    prepared = _raw_engine(r)
    tds, solvable, drops, mx, _raw = prepared
    _res, e_pick, _eng, _ = _stage(r, prepared, None, monkeypatch)
    timed = e_pick["RECOMMENDED"][0]
    ctx = ds._stage_ctx(r, solvable, tds, mx, drops)
    sc = LR.score(ctx.day, ctx.rec_pricing, timed)
    fake = LR.Candidate("PYVRP", timed, LR.Score(sc.unserved, sc.cost - 1, sc.trucks, sc.loads, sc.metres, sc.operating))
    monkeypatch.setattr(PV, "stage_in_worker", lambda job: ([fake], ["PYVRP: injected"]))
    res, _, _, report = _stage(r, prepared, LR.plan_of(timed), monkeypatch)
    assert report == {"status": "NOT_CHOSEN", "reason": "NOT_BETTER", "chosen_for": []}
    assert not any("second route search" in w for s in res.values() for w in s.warnings)


# ---------------------------------------------------------------------------------------------
# Its process: start, timing, stop, cancel, failures, rule 22, CPU gate
# ---------------------------------------------------------------------------------------------

def _pools(monkeypatch) -> list:
    """Every engine pool (_Workers: its size) and second-search process (_PvProcess: "PV") made from
    now on, in order."""
    made: list = []
    real, real_pv = ds._Workers.__init__, ds._PvProcess.__init__

    def init(self, *a, **k):
        made.append((self, a[0] if a else k.get("size")))
        real(self, *a, **k)

    def init_pv(self, *a, **k):
        made.append((self, "PV"))
        real_pv(self, *a, **k)

    monkeypatch.setattr(ds._Workers, "__init__", init)
    monkeypatch.setattr(ds._PvProcess, "__init__", init_pv)
    return made


def _stopped(made) -> None:
    """Every pool and process closed and released (CI, PR #50): no child process, no pool thread."""
    import multiprocessing as mp

    for w, _kind in made:
        assert w.closed and (w.pool if isinstance(w, ds._Workers) else w.proc) is None
    assert mp.active_children() == []
    assert [t.name for t in threading.enumerate() if t.is_alive() and ("_handle_" in t.name or t.name.startswith("routeiq-"))] == []


def test_own_optional_process_and_quick_timing_unchanged(workers, monkeypatch):
    """Off: exactly the engine's pool. On: one more process of its own (never part of rule 22's),
    RECOMMENDED's limit unchanged, the second search told to stop when the engine's searches end, and
    the answer within the off run's time + the load re-check's cap + 3 s."""
    stops, trucks = nmwc_day(20)
    r = req(stops, trucks, scenarios=ALL3, time_limit_sec=2)
    monkeypatch.setenv("SOLVER_PYVRP", "off")
    made = _pools(monkeypatch)
    off = ds.optimize_dispatch(r)
    assert [kind for _w, kind in made] == [2]
    assert off.search.pyvrp.status == "SKIPPED" and off.search.pyvrp.reason == "OFF"
    monkeypatch.setenv("SOLVER_PYVRP", "on")
    made.clear()
    on = ds.optimize_dispatch(r)
    assert [kind for _w, kind in made] == [2, "PV"]
    assert on.search.limit_sec == off.search.limit_sec == 2
    p = on.search.pyvrp
    assert p.status in ("CHOSEN", "NOT_CHOSEN") and p.feasible and p.stop_reason == "SEARCH_END", p
    assert on.search.used_sec <= off.search.used_sec + ds._repack_cap_sec(2, False) + 3
    assert all(sc.feasibility.status == "VERIFIED" for sc in on.scenarios)
    _stopped(made)


def test_second_search_that_cannot_start_never_refuses_the_solve(workers, monkeypatch, caplog):
    """Rule 22 refuses only when the engine's own workers cannot run (critique C2)."""
    from multiprocessing.context import SpawnProcess

    real = SpawnProcess.start

    def start(self):
        if self.name == "routeiq-second-search":
            raise OSError(11, "Resource temporarily unavailable (test)")
        return real(self)

    monkeypatch.setattr(SpawnProcess, "start", start)
    caplog.set_level(logging.WARNING, logger="routeiq.dispatch")
    resp = ds.optimize_dispatch(req(*nmwc_day(20), scenarios=ALL3, time_limit_sec=2))
    assert resp.search.pyvrp.status == "SKIPPED" and resp.search.pyvrp.reason == "NO_PROCESS"
    assert all(sc.status == "OPTIMIZED" for sc in resp.scenarios)
    assert "pyvrp run=r skipped: NO_PROCESS" in caplog.text
    assert ds.WORKER_HEALTH.status()["status"] == "ok"  # not a worker failure for the administrator


def test_rule22_unchanged_with_pyvrp_on(workers, monkeypatch):
    monkeypatch.setenv("ROUTEIQ_TEST_WORKER_START_EXIT", "1")
    monkeypatch.setenv("SOLVER_WORKER_START_SEC", "3")
    made = _pools(monkeypatch)
    t0 = time.monotonic()
    with pytest.raises(ds.WorkersUnavailable):
        ds.optimize_dispatch(req(*nmwc_day(20), scenarios=ALL3))
    assert time.monotonic() - t0 < 15
    assert [kind for _w, kind in made] == [2]  # the second search never started
    _stopped(made)


@pytest.mark.parametrize("hook,status,reason", [("ROUTEIQ_TEST_FAIL_PYVRP", "FAILED", "FAILED"), ("ROUTEIQ_TEST_KILL_PYVRP", "FAILED", "LOST"), ("ROUTEIQ_TEST_HANG_PYVRP", "FAILED", "TIMEOUT"), ("ROUTEIQ_TEST_PYVRP_IMPORT_FAIL", "FAILED", "IMPORT_FAILED"), ("ROUTEIQ_TEST_KILL_PYVRP_STAGE", "NOT_CHOSEN", "STAGE_FAILED")])  # noqa: E501 - one line: the handbook guard sizes it
def test_pyvrp_failure_modes_keep_the_engine_plan(hook, status, reason, workers, monkeypatch, caplog):
    """Each failure loses only the second search: every option is the engine's, re-checked (no
    "not re-checked" note: its stage job is apart from the engine's, critique C4), one log line says
    why. A worker killed while RECOMMENDED was awaited is LOST at once, not a timeout (C3)."""
    monkeypatch.setenv(hook, "1")
    caplog.set_level(logging.INFO, logger="routeiq.dispatch")
    made = _pools(monkeypatch)
    t0 = time.monotonic()
    resp = ds.optimize_dispatch(req(*nmwc_day(20), scenarios=ALL3, time_limit_sec=2))
    used = time.monotonic() - t0
    p = resp.search.pyvrp
    assert (p.status, p.reason) == (status, reason)
    for sc in resp.scenarios:
        assert sc.status == "OPTIMIZED" and sc.feasibility.status == "VERIFIED"
        assert not any("not re-checked" in w or "second route search" in w for w in sc.warnings)
    assert len(re.findall(r"pyvrp run=r (failed: |not used: |stage )", caplog.text)) == 1
    if reason in ("LOST", "FAILED", "IMPORT_FAILED"):
        assert used < 30  # no grace waited for
    _stopped(made)


def test_second_search_is_collected_before_a_stuck_alternative_closes_the_pool(workers, monkeypatch):
    """An alternative that overruns closes the engine's pool (fresh workers for the re-check): the
    second search's finished plan is collected first and still judged (critique C5)."""
    monkeypatch.setenv("ROUTEIQ_TEST_HANG_SCENARIO", "MIN_DISTANCE")
    monkeypatch.setenv("SOLVER_ALT_GRACE_SEC", "3")
    made = _pools(monkeypatch)
    resp = ds.optimize_dispatch(req(*nmwc_day(20), scenarios=ALL3, time_limit_sec=2))
    assert [sc.name for sc in resp.scenarios] == ["RECOMMENDED", "MIN_TRUCKS"]
    p = resp.search.pyvrp
    assert p.status in ("CHOSEN", "NOT_CHOSEN") and p.feasible and p.reason in (None, "NOT_BETTER"), p
    _stopped(made)


def test_thorough_stall_is_timed_and_counts_only_after_the_engines_searches(monkeypatch):
    """Production defaults (no env). The old rule, 300,000 iterations without a better plan, could never
    trigger (29-87 min at the measured 57-171 iterations/s): every Thorough solve waited for it until
    the load re-check's reserve. Now: while the engine searches, the second search never stops on its
    stall (it costs no waiting); once the engine's searches ended, it stops when its last better plan is
    older than max(30 s, 10% of its search time) - never before QUICK's time for the day."""
    for name in ("SOLVER_PYVRP_STALL_SEC", "SOLVER_PYVRP_STALL_SHARE", "SOLVER_PYVRP_STALL_ITERS"):
        monkeypatch.delenv(name, raising=False)
    assert (PV.stall_floor_sec(), PV.stall_share()) == (PV.STALL_FLOOR_SEC, PV.STALL_SHARE) == (30.0, 0.1)
    clock = [0.0]

    def run(calls, over_at=None, min_sec=20.0, mode="THOROUGH"):
        over = threading.Event()
        st = PV.Stopper(PV.PvSettings(mode=mode, seed=1, max_runtime=1200.0, min_sec=min_sec), 0.0, None, over,
                        clock=lambda: clock[0])
        for t, cost in calls:
            clock[0] = t
            if over_at is not None and t >= over_at:
                over.set()
            if st(cost):
                return t, st.reason
        return None, None

    # Best plan at 1 s, then nothing better for 10 minutes: the engine still searches, so no stop.
    assert run([(1.0, 100)] + [(1.0 + k, 100) for k in range(1, 600)]) == (None, None)
    # The engine ends at 600 s: stalled for 599 s > max(30, 60) s -> stops at once.
    assert run([(1.0, 100)] + [(1.0 + k, 100) for k in range(1, 601)], over_at=600.0) == (600.0, "CONVERGED")
    # Last better plan at 590 s, engine ends at 600 s: stops once 590 s is max(30, 10%) behind it (656 s).
    calls = [(float(k), 1000 - k) for k in range(1, 591)] + [(float(k), 410) for k in range(591, 700)]
    assert run(calls, over_at=600.0) == (656.0, "CONVERGED")
    # Engine ended at 1 s, best plan at 1 s: stalled at 31 s, but never before QUICK's time for the day.
    assert run([(float(k), 100) for k in range(1, 100)], over_at=1.0) == (31.0, "CONVERGED")
    assert run([(float(k), 100) for k in range(1, 100)], over_at=1.0, min_sec=60.0) == (60.0, "CONVERGED")
    # No feasible plan at all when the engine ended: counted from its start.
    assert run([(float(k), PV.INT62) for k in range(1, 100)], over_at=40.0) == (40.0, "CONVERGED")
    # The reserve is the backstop while it keeps improving.
    assert run([(float(k), 5000 - k) for k in range(1, 1300)], over_at=600.0) == (1200.0, "CAP")
    # QUICK: the engine's end stops it at once.
    assert run([(1.0, 100), (2.0, 100)], over_at=2.0, mode="QUICK") == (2.0, "SEARCH_END")


def test_thorough_pyvrp_stops_on_its_stall_rule_and_within_the_cap(workers, monkeypatch):
    monkeypatch.setenv("THOROUGH_STALL_SEC", "0.5")
    monkeypatch.setenv("SOLVER_PYVRP_STALL_SEC", "1")
    resp = ds.optimize_dispatch(req(*nmwc_day(20), scenarios=["RECOMMENDED"], time_limit_sec=2, search_mode="THOROUGH",
                                    max_search_sec=60))
    p = resp.search.pyvrp
    assert p.stop_reason == "CONVERGED" and p.feasible, p
    assert resp.search.used_sec <= resp.search.cap_sec == 60
    assert resp.search.used_sec < 45  # it did not wait for the re-check's reserve


def test_stop_request_reaches_pyvrp_and_its_plan_is_still_judged(workers, monkeypatch):
    control = ds.SolveControl()
    threading.Timer(4.0, control.request_stop).start()
    resp = ds.optimize_dispatch(req(*nmwc_day(30), scenarios=ALL3, time_limit_sec=2, search_mode="THOROUGH", max_search_sec=120),
                                control=control)
    assert resp.search.stop_reason == "STOPPED"
    p = resp.search.pyvrp
    assert p.stop_reason == "STOPPED" and p.feasible and p.status in ("CHOSEN", "NOT_CHOSEN"), p
    assert resp.search.used_sec < 60


def test_cancel_stops_pyvrp_and_its_worker_within_seconds(workers, monkeypatch):
    control = ds.SolveControl()
    made = _pools(monkeypatch)
    threading.Timer(3.0, control.cancel, args=("test",)).start()
    t0 = time.monotonic()
    with pytest.raises(ds.SolveAborted):
        ds.optimize_dispatch(req(*nmwc_day(30), scenarios=ALL3, time_limit_sec=30), control=control)
    assert time.monotonic() - t0 < 3.0 + 1.0 + ds.POOL_CLOSE_SEC
    assert [kind for _w, kind in made] == [2, "PV"]
    _stopped(made)


def test_the_second_search_worker_asks_to_be_the_first_oom_victim(monkeypatch, tmp_path):
    """CI 30 Sep 2026: the solver's API process vanished mid-solve (no traceback; the resource
    tracker's "leaked semaphore objects" line), right as the second search's worker started, and
    every later solve failed. The second search is the optional process: when memory runs short the
    kernel must take it (its plan is LOST, the engine's plans are used), never the API process. Its
    worker raises its own oom_score_adj to the maximum at start; the engine's workers keep theirs."""
    path = tmp_path / "oom_score_adj"
    path.write_text("0\n", encoding="ascii")
    monkeypatch.setattr(ds, "OOM_SCORE_ADJ_PATH", str(path))
    for name in ("_BEACON", "_STOP_FLAG", "_SEARCH_OVER"):
        monkeypatch.setattr(ds, name, getattr(ds, name))  # restored after the test
    ds._worker_init(None, None, None)  # an engine worker
    assert path.read_text(encoding="ascii").strip() == "0"
    ds._worker_init(None, None, object())  # the second search's worker (it has search_over)
    assert path.read_text(encoding="ascii").strip() == "1000"
    # Best effort: no /proc (Windows, macOS) or a read-only one never stops the worker from starting.
    monkeypatch.setattr(ds, "OOM_SCORE_ADJ_PATH", str(tmp_path / "missing" / "oom_score_adj"))
    ds._worker_init(None, None, object())


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux: /proc/<pid>/oom_score_adj")
def test_on_linux_the_second_search_worker_is_the_kernels_first_oom_victim():
    """The real processes (CI runs this on Linux): the second search's worker process has
    oom_score_adj 1000; an engine worker keeps the API process's value."""
    parent = open("/proc/self/oom_score_adj", encoding="ascii").read().strip()
    second, engine = ds._PvProcess(None), ds._Workers(1, None)
    try:
        second.submit(ds._ping, None)
        kind, pid = second.wait(time.monotonic() + 60, None)
        assert kind == "ok", (kind, pid)
        assert open(f"/proc/{pid}/oom_score_adj", encoding="ascii").read().strip() == "1000"
        kind, pid = ds._await_all(engine, {"ping": engine.submit(ds._ping, None, "ping")}, time.monotonic() + 60)["ping"]
        assert kind == "ok", (kind, pid)
        assert open(f"/proc/{pid}/oom_score_adj", encoding="ascii").read().strip() == parent
    finally:
        second.close()
        engine.close()


def test_a_native_crash_of_the_solver_prints_every_threads_stack():
    """The same CI failure left nothing to read: a process killed by a signal (a crash in a C
    extension) prints no Python traceback. The API process enables faulthandler (every thread's
    stack on SIGSEGV, SIGBUS, SIGABRT, SIGFPE, SIGILL) and its worker processes inherit it
    (PYTHONFAULTHANDLER). A fresh interpreter: pytest itself turns faulthandler on."""
    env = {k: v for k, v in os.environ.items() if k != "PYTHONFAULTHANDLER"}
    code = "import faulthandler, os, main; print(faulthandler.is_enabled(), os.environ.get('PYTHONFAULTHANDLER'))"
    out = subprocess.run([sys.executable, "-c", code], cwd=os.path.join(HERE, ".."), env=env, capture_output=True,
                         text=True, timeout=180)
    assert out.returncode == 0, out.stderr[-2000:]
    assert out.stdout.split() == ["True", "1"], out.stdout


def test_cpu_gate(monkeypatch, inprocess):
    monkeypatch.setattr(PV, "effective_cpus", lambda: 1)
    resp = ds.optimize_dispatch(req(*nmwc_day(20)))
    assert (resp.search.pyvrp.status, resp.search.pyvrp.reason) == ("SKIPPED", "CPU_GATE")
    monkeypatch.setenv("SOLVER_PYVRP_MIN_CPUS", "1")
    assert PV.enabled("QUICK") == (True, None)
    monkeypatch.setenv("SOLVER_PYVRP", "thorough")
    assert PV.enabled("QUICK") == (False, "OFF") and PV.enabled("THOROUGH") == (True, None)
    monkeypatch.setenv("SOLVER_PYVRP", "0")
    assert PV.enabled("THOROUGH") == (False, "OFF")
    assert PV.cgroup_cpus("max 100000") is None
    assert PV.cgroup_cpus("200000 100000") == 2.0
    assert PV.cgroup_cpus(None, "-1", "100000") is None
    assert PV.cgroup_cpus(None, "150000", "100000") == 1.5


def test_ready_and_the_startup_line(monkeypatch):
    import main

    monkeypatch.setattr(main, "SOLVER_TOKEN", "t")
    monkeypatch.setattr(PV, "effective_cpus", lambda: 4)
    monkeypatch.setenv("SOLVER_PYVRP", "on")
    from fastapi.testclient import TestClient

    body = TestClient(main.app).get("/ready", headers={"X-Solver-Token": "t"}).json()
    assert body["pyvrp"] == {"enabled": True, "setting": "on", "version": "0.14.0", "effective_cpus": 4, "min_cpus": 2, "why": None}
    assert PV.startup_line() == "PyVRP second search: on for every search (pyvrp 0.14.0, effective CPUs 4, min 2)"
    monkeypatch.setattr(PV, "effective_cpus", lambda: 1)
    assert PV.startup_line() == "PyVRP second search: off (CPU_GATE: effective CPUs 1 < 2)"


def test_search_report_pyvrp_is_part_of_the_response_contract():
    from dispatch_models import PyvrpReport

    ts = open(os.path.join(HERE, "..", "..", "..", "packages", "shared-types", "src", "dispatch.ts"), encoding="utf-8").read()
    block = ts.split("export interface PyvrpReport {", 1)[1].split("\n}", 1)[0]
    keys = set(re.findall(r"^\s+(\w+)\??:", block, re.M))
    assert keys == set(PyvrpReport.model_fields)
    assert re.search(r"pyvrp\?: PyvrpReport \| null;", ts)


def test_pyvrp_version_is_pinned():
    assert version("pyvrp") == PV.VERSION == "0.14.0"
    lines = open(os.path.join(HERE, "..", "requirements.txt"), encoding="utf-8").read().splitlines()
    assert [ln.split("#")[0].strip() for ln in lines if ln.startswith("pyvrp")] == ["pyvrp==0.14.0"]
