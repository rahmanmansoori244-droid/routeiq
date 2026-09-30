"""The second route search (PyVRP 0.14.0, pyvrp_candidate.py): its model, its safety rules, the
never-worse guard of the load re-check, and its process (own pool, stop, cancel, failures).

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
        assert any(w.startswith("The main route search found no plan for this option") for w in sc.warnings)
    assert resp.search.pyvrp.status == "CHOSEN" and sorted(resp.search.pyvrp.chosen_for) == sorted(ALL3)
    assert resp.search.stop_reason != "NO_PLAN"


def test_the_note_compares_with_the_engines_final_plan():
    ref = LR.Candidate("RECOMMENDED+repack:RECOMMENDED", {}, LR.Score(0, 0, trucks=6, loads=17, metres=0, operating=54_500_000))
    best = LR.Candidate("PYVRP+repack:RECOMMENDED", {}, LR.Score(0, 0, trucks=5, loads=14, metres=0, operating=49_800_000))
    note = ds._second_search_note(False, ref, best, {1, 2}, {1, 2})
    assert note.startswith("A second route search found a better plan for this option than the main search: 6 -> 5 trucks, "
                           "17 -> 14 loads, 545 -> 498 OMR operating cost.")
    assert "PyVRP" not in note  # plain words for dispatchers
    assert ds._second_search_note(True, None, best, set(), {1}).startswith("The main route search found no plan")


# ---------------------------------------------------------------------------------------------
# Its process: pool, timing, stop, cancel, failures, rule 22, CPU gate
# ---------------------------------------------------------------------------------------------

def _pools(monkeypatch) -> list:
    made: list = []
    real = ds._Workers.__init__

    def init(self, *a, **k):
        made.append((self, a, k))
        real(self, *a, **k)

    monkeypatch.setattr(ds._Workers, "__init__", init)
    return made


def _stopped(made) -> None:
    for w, _a, _k in made:
        pool = getattr(w, "pool", None)
        if pool is not None:
            assert [p.pid for p in pool._pool if p.is_alive()] == []


def test_own_optional_process_and_quick_timing_unchanged(workers, monkeypatch):
    """Off: exactly the engine's pool. On: one more pool of one process (never part of rule 22's),
    RECOMMENDED's limit unchanged, the second search told to stop when the engine's searches end, and
    the answer within the off run's time + the load re-check's cap + 3 s."""
    stops, trucks = nmwc_day(20)
    r = req(stops, trucks, scenarios=ALL3, time_limit_sec=2)
    monkeypatch.setenv("SOLVER_PYVRP", "off")
    made = _pools(monkeypatch)
    off = ds.optimize_dispatch(r)
    assert [a[0] if a else k.get("size") for _w, a, k in made] == [2]
    assert off.search.pyvrp.status == "SKIPPED" and off.search.pyvrp.reason == "OFF"
    monkeypatch.setenv("SOLVER_PYVRP", "on")
    made.clear()
    on = ds.optimize_dispatch(r)
    assert [(a[0], k.get("search_over", False)) for _w, a, k in made] == [(2, False), (1, True)]
    assert on.search.limit_sec == off.search.limit_sec == 2
    p = on.search.pyvrp
    assert p.status in ("CHOSEN", "NOT_CHOSEN") and p.feasible and p.stop_reason == "SEARCH_END", p
    assert on.search.used_sec <= off.search.used_sec + ds._repack_cap_sec(2, False) + 3
    assert all(sc.feasibility.status == "VERIFIED" for sc in on.scenarios)
    _stopped(made)


def test_second_search_that_cannot_start_never_refuses_the_solve(workers, monkeypatch, caplog):
    """Rule 22 refuses only when the engine's own workers cannot run (critique C2)."""
    real = ds._Workers.__init__

    def init(self, *a, search_over=False, **k):
        if search_over:
            raise OSError(11, "Resource temporarily unavailable (test)")
        real(self, *a, **k)

    monkeypatch.setattr(ds._Workers, "__init__", init)
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
    assert [k.get("search_over", False) for _w, _a, k in made] == [False]  # the second search never started
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


def test_thorough_pyvrp_stops_on_its_stall_rule_and_within_the_cap(workers, monkeypatch):
    monkeypatch.setenv("THOROUGH_STALL_SEC", "0.5")
    monkeypatch.setenv("SOLVER_PYVRP_STALL_ITERS", "2000")
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
    assert len(made) == 2
    _stopped(made)


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
