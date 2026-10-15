"""Decision support, the evidence-suite CLI (DESIGN.md section 6): the run lists and their lane split are
deterministic, the cache keys are stable, and --report rebuilds the outputs from the cache alone. E6 (the engine
at production settings): its run list, the engine call it makes, the perturbation builders, the analysis on
hand-made records and its report from a fake cache - one real 1 s solve in all."""
from __future__ import annotations

import json
import os
import socket
from dataclasses import replace

import pytest
from dispatch_models import PyvrpReport, SearchReport

from decision_support import core, ivms, synth
from decision_support import experiments as X
from decision_support.core import Budget, RunResult


def test_run_lists_and_lanes_are_deterministic(tmp_path):
    suite = X.Suite.smoke(tmp_path)  # no real files there: the real days are skipped, ~/ds-data is never read
    groups = X.plan(list(X.EXPERIMENTS), suite, X.Days(tmp_path))
    again = X.plan(list(X.EXPERIMENTS), suite, X.Days(tmp_path))
    assert [(g.experiment, g.day, g.items, g.skipped) for g in groups] == \
           [(g.experiment, g.day, g.items, g.skipped) for g in again]
    every = [it.key for g in groups for it in g.items]
    assert len(set(every)) == len(every)
    lanes = [X.lane_items(groups, i, 3) for i in range(3)]
    assert sorted(it.key for lane in lanes for it in lane) == sorted(every)  # each item in exactly one lane
    assert lanes == [X.lane_items(again, i, 3) for i in range(3)]
    assert groups[0].experiment == "E3"  # the long simulations start first
    skipped = {(g.experiment, g.day) for g in groups if g.skipped}
    assert {("E1", "REAL-15OCT"), ("E2", "REAL-15OCT"), ("E3", "REAL-15OCT"), ("E4", "REAL-15OCT-PREFIX"),
            ("E6", "REAL-15OCT"), ("E6", "REAL-15OCT-PREFIX")} == skipped
    e1 = next(g for g in groups if (g.experiment, g.day) == ("E1", "SYNTH-320"))
    # QUICK: the baseline, 3 levers alone, the pair (which is also ALL) and ALL_WITH_EVIDENCE; cold and warm; 2 seeds
    assert {it.variant for it in e1.items} >= {"baseline", "ALL", "ALL_WITH_EVIDENCE", "baseline@warm", "ALL@warm"}
    assert len(e1.items) == 6 * 2 * 2 and all(it.budget == "2s-QUICK" for it in e1.items)
    assert [it.variant for it in e1.items[:2]] == ["baseline", "baseline"]  # the baseline first: the others need it


def test_cache_keys_locks_and_leak_check(tmp_path):
    req = synth.make_day(12, seed=3).request
    budget = Budget(time_limit_sec=2, seeds=(1,))
    a, b = X.RunCache(tmp_path, "c0ffee"), X.RunCache(tmp_path, "c0ffee")
    with a.scope("E1", "SYNTH-12", {core.digest(req): "baseline"}), b.scope("E1", "SYNTH-12", {core.digest(req): "baseline"}):
        p = a.path(req, budget, 1)
        assert p == b.path(req.model_copy(deep=True), budget, 1)
        assert p.relative_to(tmp_path).parts == ("c0ffee", "E1", "SYNTH-12", "baseline", "2s-QUICK-s1.json")
        assert len({p, a.path(req, budget, 2), a.path(req, Budget(time_limit_sec=3, seeds=(1,)), 1)}) == 3
        assert a.path(req, budget, 1, "MIN_TRUCKS").name == "2s-QUICK-MIN_TRUCKS-s1.json"
        other = req.model_copy(update={"stops": req.stops[1:]}, deep=True)
        assert a.path(other, budget, 1).parent.name == f"req-{core.digest(other)}"  # unnamed: filed by digest
    assert X.RunCache(tmp_path, "beef").dir == tmp_path / "beef"  # another commit, another cache
    assert X.Item("E2", "SYNTH-320", "reopt-3", 2, "40s-QUICK").key == "E2/SYNTH-320/reopt-3/s2/40s-QUICK"

    lock = tmp_path / "x.lock"
    assert X._try_lock(lock) and not X._try_lock(lock)  # held by this live process
    if X._BOOT_ID.exists():  # Linux: a lock whose process has gone is taken over
        lock.write_text(json.dumps({"host": socket.gethostname(), "boot": X._owner()["boot"], "pid": 2 ** 30}))
        assert X._try_lock(lock)

    days = X.Days(tmp_path)
    days.secrets.add("cust-real-id-123")
    assert X._checked("cash 0.123456 OMR", days) == "cash 0.123 OMR"
    with pytest.raises(ivms.LeakError):
        X._checked("a stop of cust-real-id-123", days)


def test_report_comes_from_the_cache_alone(tmp_path, monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    monkeypatch.setenv("SOLVER_PYVRP", "off")
    suite = replace(X.Suite.smoke(tmp_path), e5_instances=2, budget_exact=1)
    days = X.Days(tmp_path)
    groups = X.plan(["E5"], suite, days)
    assert X.run_lane(groups, suite, days, X.RunCache(tmp_path / "cache", "test"), 0, 1) == 0

    def no_solving(*_a, **_k):
        raise AssertionError("--report must not solve")

    monkeypatch.setattr(X, "_ENGINE_SOLVE", no_solving)
    out = tmp_path / "out"
    X.report_all(["E5"], groups, suite, days, X.RunCache(tmp_path / "cache", "test", read_only=True), out)
    data = json.loads((out / "E5-exact.json").read_text(encoding="utf-8"))
    assert {d["status"] for d in data["days"].values()} == {"COMPLETE"}
    assert data["days"]["DEFAULT"]["summary"]["instances"] == 2 and data["meta"]["items"] == {"total": 4, "done": 4}
    md = (out / "E5-exact.md").read_text(encoding="utf-8")
    assert "| measure | value |" in md and "| engine serves as many stops as the oracle | " in md
    assert "SOLVER_PYVRP=off" in md and "OR-Tools" in md
    assert "| E5 Exact oracle against the engine | DEFAULT | COMPLETE | 2/2 | test QUICK |" in \
           (out / "INDEX.md").read_text(encoding="utf-8")

    X.report_all(["E5"], groups, suite, days, X.RunCache(tmp_path / "empty", "test", read_only=True), out)
    data = json.loads((out / "E5-exact.json").read_text(encoding="utf-8"))
    assert {d["status"] for d in data["days"].values()} == {"INCOMPLETE"}


# ------------------------------------------------------------------------------------------------------------
# E6: the engine at production settings
# ------------------------------------------------------------------------------------------------------------

def _fake_real_files(data_dir) -> None:
    """A tiny SYNTHETIC day filed under both real-day names (its own ids replaced by fake ones), so the real-day
    code paths run without real data. The suite anonymises it as it would a real day."""
    req = synth.make_day(10, seed=3).request.model_copy(update={"run_id": "fake-run-77", "tenant_id": "fake-tenant"},
                                                        deep=True)
    req.depot.id = "fake-depot"
    for name in X.REAL_FILES.values():
        (data_dir / name).write_text(req.model_dump_json(), encoding="utf-8")


@pytest.fixture(scope="module")
def tiny(tmp_path_factory):
    """(data dir, the fake real day as the suite reads it, one real 1 s QUICK plan of it: RECOMMENDED only)."""
    data = tmp_path_factory.mktemp("data")
    _fake_real_files(data)
    day = X.Days(data).get("REAL-15OCT")
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("SOLVER_PARALLEL", "0")
        mp.setenv("SOLVER_PYVRP", "off")
        run = core.solve(day.request, Budget(time_limit_sec=1, seeds=(1,)), 1)
    return data, day, run


def test_e6_run_list(tmp_path):
    suite = X.Suite(data_dir=tmp_path)  # no real files yet: the real days are skipped
    e6 = X.EXPERIMENTS["E6"]
    groups = e6.groups(suite, X.Days(tmp_path))
    assert [g.day for g in groups] == list(X.E6.DAYS)
    assert {g.day for g in groups if g.skipped} == {"REAL-15OCT", "REAL-15OCT-PREFIX"}
    s320 = next(g for g in groups if g.day == "SYNTH-320")
    assert [(it.variant, it.seed, it.budget) for it in s320.items] == \
           [("PROD", s, "PROD-1200s") for s in range(1, 6)] + [("QUICKP", s, "QUICKP-auto") for s in range(1, 6)]
    # 5 lanes (5 machines) split a synthetic day by seed: PROD and QUICKP of one seed together
    assert [(it.variant, it.seed) for it in X.lane_items([s320], 1, 5)] == [("PROD", 2), ("QUICKP", 2)]
    synth_days = {X.Days(tmp_path).get(d).request.model_dump_json() for d in ("SYNTH-320", "SYNTH-320-S2", "SYNTH-400-S3")}
    assert len(synth_days) == 3

    _fake_real_files(tmp_path)  # real days: PROD 3 seeds (20 min each), QUICKP 5, then P0-P5 at QUICKP seed 1
    real = e6.groups(suite, X.Days(tmp_path))[0]
    assert [it.key for it in real.items] == (
        [f"E6/REAL-15OCT/PROD/s{s}/PROD-1200s" for s in (1, 2, 3)]
        + [f"E6/REAL-15OCT/QUICKP/s{s}/QUICKP-auto" for s in range(1, 6)]
        + [f"E6/REAL-15OCT/P{k}/s1/QUICKP-auto" for k in range(6)])
    low = e6.groups(replace(suite, prod_cap=600, e6_real_prod_seeds=(1,)), X.Days(tmp_path))[0]
    assert [it.key for it in low.items][:2] == ["E6/REAL-15OCT/PROD/s1/PROD-600s", "E6/REAL-15OCT/QUICKP/s1/QUICKP-auto"]
    smoke = e6.groups(X.Suite.smoke(tmp_path), X.Days(tmp_path))
    assert [g.day for g in smoke] == list(X.E6.QUICK_DAYS)
    assert {it.budget for g in smoke for it in g.items} == {"PROD-20s", "QUICKP-2s"}
    assert X.ALL == ("E1", "E2", "E3", "E4", "E5") and "E6" in X.EXPERIMENTS  # `all` stays E1-E5


def test_e6_runs_the_engine_as_production(tiny, monkeypatch):
    _, day, canned = tiny
    seen: dict = {}

    def engine(req):
        seen["config"] = req.config.model_copy()
        seen["env"] = {k: os.environ.get(k) for k in ("SOLVER_PARALLEL", "SOLVER_PYVRP", "SOLVER_PYVRP_SEED",
                                                      "THOROUGH_STALL_SEC")}
        return canned.response

    monkeypatch.setattr(X.ds, "optimize_dispatch", engine)
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    monkeypatch.setenv("THOROUGH_STALL_SEC", "1")  # a tuning switch: cleared for the run, restored after
    monkeypatch.delenv("SOLVER_PYVRP_SEED", raising=False)
    req = day.request.model_copy(deep=True)
    req.config.max_search_sec = 900
    run = X.solve_setting(req, X.Setting("PROD", "THOROUGH", cap_sec=1200), 2)
    cfg = seen["config"]
    assert (cfg.scenarios, cfg.search_mode, cfg.max_search_sec, cfg.time_limit_sec, cfg.distance_provider) == \
           (list(X.OPTIONS), "THOROUGH", 900, None, "HAVERSINE")  # the request's own cap, under the setting's
    assert seen["env"] == {"SOLVER_PARALLEL": "1", "SOLVER_PYVRP": "on", "SOLVER_PYVRP_SEED": "2",
                           "THOROUGH_STALL_SEC": None}
    assert run.env == {"SOLVER_PARALLEL": "1", "SOLVER_PYVRP": "on", "SOLVER_PYVRP_SEED": "2"}
    assert (os.environ["SOLVER_PARALLEL"], os.environ["THOROUGH_STALL_SEC"]) == ("0", "1")
    assert "SOLVER_PYVRP_SEED" not in os.environ
    assert run.seed == 2 and run.digest == core.digest(req) and run.metrics.stops_total == len(req.stops)
    X.solve_setting(req, X.Setting("PROD", "THOROUGH", cap_sec=300), 1)
    assert seen["config"].max_search_sec == 300  # --prod-cap lowers it
    X.solve_setting(req, X.Setting("QUICKP", "QUICK"), 1)
    assert (seen["config"].search_mode, seen["config"].time_limit_sec) == ("QUICK", None)  # the automatic time
    assert X.Setting("PROD", "THOROUGH", cap_sec=1200).tag == "PROD-1200s"
    assert X.Setting("QUICKP", "QUICK").tag == "QUICKP-auto"


def test_e6_perturbations_are_small_deterministic_changes(tiny):
    _, day, canned = tiny
    req, base = day.request, X._recommended(canned)
    served = X._served_ids(base)
    got = {k: X.perturb(req, k, base) for k in X.PERTURBATIONS}
    assert got == {k: X.perturb(req.model_copy(deep=True), k, base) for k in X.PERTURBATIONS}  # the same change each time
    stops = {s.stop_id: s for s in req.stops}

    def changed(new) -> dict:
        return {s.stop_id: s for s in new.stops if stops.get(s.stop_id) != s}

    p0 = got["P0"][0]
    assert p0.model_dump(exclude={"run_id"}) == req.model_dump(exclude={"run_id"}) and core.digest(p0) != core.digest(req)
    p1, w1 = got["P1"]
    small = [s for s in req.stops if s.demand_cases <= 3]
    assert len(p1.stops) == len(req.stops) - 1 and w1["stop"] not in {s.stop_id for s in p1.stops}
    if small:
        assert stops[w1["stop"]].demand_cases <= 3
        assert w1["stop"] in served or not any(s.stop_id in served for s in small)
    p2, w2 = got["P2"]
    up = changed(p2)
    assert len(up) == max(1, round(0.1 * len(req.stops))) == w2["stops"] and p2.trucks == req.trucks
    for sid, s in up.items():
        old = stops[sid]
        assert s.demand_cases - old.demand_cases == max(1, round(0.05 * old.demand_cases))
        assert s.demand_kg >= old.demand_kg and s.priority == old.priority and s.hard_end_min == old.hard_end_min
    p3, w3 = got["P3"]
    later = changed(p3)
    assert list(later) == [w3["stop"]] and w3["stop"] in served
    assert later[w3["stop"]].hard_end_min == stops[w3["stop"]].hard_end_min + 30
    p4, w4 = got["P4"]
    assert w4["truck"] in {ld.truck_id for ld in base.loads} and len(p4.trucks) == len(req.trucks) - 1
    assert all(w4["truck"] not in (s.allowed_truck_ids or []) for s in p4.stops)
    assert not changed(p4).keys() - {s.stop_id for s in req.stops if s.allowed_truck_ids}
    p5, w5 = got["P5"]
    new = next(s for s in p5.stops if s.stop_id == w5["stop"])
    src = stops[w5["stop"].removesuffix("-late")]
    assert len(p5.stops) == len(req.stops) + 1 and new.late
    assert (new.demand_cases, new.priority, new.lng) == (src.demand_cases, src.priority, src.lng)
    assert abs((new.lat - src.lat) * 111.195 - 1.0) < 1e-6 and not changed(p5).keys() - {new.stop_id}

    used = {ld.truck_id for ld in base.loads}
    assert X.plan_moves(canned, canned) == {
        "stops_moved": 0, "stops_other_truck": 0, "dropped": 0, "added": 0, "served_change": 0,
        "trucks_before": len(used), "trucks_after": len(used), "trucks_changed": 0, "cash_change": 0.0,
        "loads_change": 0, "km_change": 0.0, "feasibility": canned.metrics.feasibility}
    spare = next((t.id for t in req.trucks if t.id not in used), None)  # synth days have 3 trucks or more
    if spare is not None:
        other = canned.response.model_copy(deep=True)
        first = other.scenarios[0].loads[0]
        first.truck_id = spare  # one load handed to an idle truck
        mv = X.plan_moves(canned, replace(canned, response=other))
        assert (mv["stops_moved"], mv["stops_other_truck"]) == (len(first.stops), len(first.stops))
        kept = any(ld.truck_id == base.loads[0].truck_id for ld in other.scenarios[0].loads)
        assert mv["trucks_changed"] == (1 if kept else 2) and mv["served_change"] == 0


def _record(seed: int, options: dict[str, tuple[float, set[str]]], mode: str = "THOROUGH") -> dict:
    """A hand-made run record (X.run_record's shape): stops s0 and s1 are P1, s2-s5 P3."""
    prio = {f"s{i}": 1 if i < 2 else 3 for i in range(6)}
    opts = {}
    for name, (cash, served) in options.items():
        by_p = {p: sum(1 for s in served if prio[s] == p) for p in range(1, 6)}
        opts[name] = {"status": "OPTIMIZED", "cash": {"total": cash, **{k: 0.0 for k in X.CASH_PARTS}}, "trucks": 2,
                      "loads": 3, "stops_served": len(served), "stops_total": 6, "cases_served": 10 * len(served),
                      "cases_total": 60, "served_by_priority": by_p,
                      "unserved_by_priority": {p: sum(1 for q in prio.values() if q == p) - by_p[p] for p in range(1, 6)},
                      "late_stops": 0, "minutes_outside_pref": 0, "km": 100.0, "feasibility": "VERIFIED",
                      "penalties": {}, "search_sec": 5.0, "_served": sorted(served)}
    thorough = mode == "THOROUGH"
    search = {"mode": mode, "cap_sec": 1200, "limit_sec": 1000, "search_sec": 700.0, "used_sec": 760.0,
              "stop_reason": "CONVERGED" if thorough else "TIME_LIMIT", "last_improvement_sec": 400.0,
              "stall_sec": 300.0, "solutions": 10,
              "best_over_time": [[1.0, 5000.0, 3], [50.0, 900.0, 0], [250.0, 850.0, 0], [400.0, 840.0, 0]] if thorough else [],
              "pyvrp": {"status": "CHOSEN", "reason": None, "stop_reason": "SEARCH_END", "search_sec": 700.0,
                        "iterations": 5, "chosen_for": ["MIN_TRUCKS"]}}
    return {"seed": seed, "wall_sec": 800.0, "env": {}, "options": opts, "search": search, "_priority": prio}


def test_e6_analysis_on_hand_made_runs():
    every = {f"s{i}" for i in range(6)}
    prod = [_record(1, {"RECOMMENDED": (500.0, every), "MIN_TRUCKS": (480.0, every), "MIN_DISTANCE": (490.0, every - {"s5"})}),
            # RECOMMENDED leaves out the P1 stop s0, which MIN_TRUCKS and MIN_DISTANCE serve
            _record(2, {"RECOMMENDED": (450.0, every - {"s0"}), "MIN_TRUCKS": (470.0, every),
                        "MIN_DISTANCE": (440.0, every - {"s5"})})]
    quick = [_record(r["seed"], {k: (v["cash"]["total"] + 10, set(v["_served"])) for k, v in r["options"].items()}, "QUICK")
             for r in prod]
    sp = X.spread(prod)["RECOMMENDED"]
    assert sp["cash"] == {"n": 2, "mean": 475.0, "min": 450.0, "max": 500.0, "sd": 35.355}
    assert sp["stops_served"]["mean"] == 5.5 and sp["unserved_by_priority_mean"][1] == 0.5 and sp["verified"] == 2
    assert X.option_choice(prod) == {
        "runs": 2, "cheapest_at_best_service": {"RECOMMENDED": 0, "MIN_TRUCKS": 2, "MIN_DISTANCE": 0},
        "at_best_service": {"RECOMMENDED": 1, "MIN_TRUCKS": 2, "MIN_DISTANCE": 0}, "all_three_alike": 0,
        "recommended_serves_less": 1, "recommended_leaves_out_runs": 1,
        "recommended_leaves_out_by_priority": {1: 1, 2: 0, 3: 0, 4: 0, 5: 0}}
    conv = X.convergence(prod + quick)  # the QUICK runs have no THOROUGH search to follow
    assert len(conv["runs"]) == 2 and conv["stop_reasons"] == {"CONVERGED": 2}
    assert {x: conv["runs"][0]["at"][x]["above_end"] for x in X.CONVERGENCE_MARKS} == \
           {60: 60.0, 120: 60.0, 300: 10.0, 600: 0.0}
    assert conv["runs"][0]["at"][60]["not_planned"] == 0
    assert conv["summary"][600]["still_searching"] == 2 and conv["summary"][60]["above_end"]["mean"] == 60.0
    pq = X.prod_vs_quick(prod, quick)
    assert pq["seeds"] == [1, 2] and pq["options"]["RECOMMENDED"]["cash"]["mean"] == -10.0
    assert pq["options"]["RECOMMENDED"]["alike_prod_cheaper"] == 2 and pq["options"]["MIN_TRUCKS"]["prod_serves_more"] == 0
    assert X.pyvrp_summary(prod) == {"status": {"CHOSEN": 2},
                                     "chosen_for": {"RECOMMENDED": 0, "MIN_TRUCKS": 2, "MIN_DISTANCE": 0}}
    written = json.dumps(X._public(prod))
    assert '"_served"' not in written and '"_priority"' not in written and '"stops_served"' in written


def _fake_engine(canned: RunResult):
    """An engine that solves nothing. Every request gets the canned plan (without the stops it no longer has) as
    all three options: MIN_TRUCKS 1 OMR cheaper, MIN_DISTANCE one stop fewer; PROD 2 OMR cheaper than QUICKP and
    with a THOROUGH search report."""
    rec = X._recommended(canned)

    def solve(req, setting, seed):
        ids = {s.stop_id for s in req.stops}
        thorough = setting.search_mode == "THOROUGH"

        def option(name: str, cash: float, drop: int):
            sc = rec.model_copy(deep=True)
            sc.name = name
            for ld in sc.loads:
                ld.stops = [st for st in ld.stops if st.stop_id in ids]
            sc.loads = [ld for ld in sc.loads if ld.stops]
            if drop and sc.loads:
                sc.loads[0].stops = sc.loads[0].stops[drop:]
            sc.truck_days[0].total_cost += cash + seed - (2 if thorough else 0)
            return sc

        search = SearchReport(
            mode=setting.search_mode, cap_sec=setting.cap_sec or 600, limit_sec=500,
            search_sec=700.0 if thorough else 2.0, used_sec=720.0 if thorough else 3.0,
            stop_reason="CONVERGED" if thorough else "TIME_LIMIT",
            best_over_time=[(1.0, 900.0, 1), (50.0, 850.0, 0), (400.0, 840.0, 0)] if thorough else [],
            pyvrp=PyvrpReport(status="CHOSEN" if thorough else "NOT_CHOSEN", chosen_for=["MIN_TRUCKS"] if thorough else []))
        scenarios = [option("RECOMMENDED", 0, 0), option("MIN_TRUCKS", -1, 0), option("MIN_DISTANCE", 0, 1)]
        response = canned.response.model_copy(update={"scenarios": scenarios, "search": search})
        run_req = core.offline(core.seeded(req, seed))
        return RunResult(seed=seed, digest=core.digest(req), request=run_req, response=response,
                         metrics=core.metrics(run_req, response), wall_sec=1.0 + seed, env=dict(setting.env))

    return solve


def test_e6_report_from_a_fake_cache(tiny, tmp_path, monkeypatch):
    data, _, canned = tiny
    monkeypatch.setattr(X, "_ENGINE_SETTING", _fake_engine(canned))
    monkeypatch.setattr(X.E6, "QUICK_DAYS", ("REAL-15OCT", "REAL-15OCT-PREFIX"))
    suite = replace(X.Suite.smoke(data), e6_seeds=(1, 2), e6_real_prod_seeds=(1, 2))
    days = X.Days(data)
    groups = X.plan(["E6"], suite, days)
    assert sum(len(g.items) for g in groups) == 2 * (2 + 2 + 6)
    assert X.run_lane(groups, suite, days, X.RunCache(tmp_path / "cache", "test"), 0, 1) == 0
    out = tmp_path / "out"
    X.report_all(["E6"], groups, suite, days, X.RunCache(tmp_path / "cache", "test", read_only=True), out)
    written = json.loads((out / "E6-production.json").read_text(encoding="utf-8"))
    md = (out / "E6-production.md").read_text(encoding="utf-8")
    day = written["days"]["REAL-15OCT"]
    assert day["status"] == "COMPLETE" and day["missing"] == [] and day["items_done"] == day["items"] == 10
    a = day["analysis"]
    assert a["option_choice"]["PROD"]["cheapest_at_best_service"] == {"RECOMMENDED": 0, "MIN_TRUCKS": 2, "MIN_DISTANCE": 0}
    assert a["prod_vs_quickp"]["options"]["RECOMMENDED"]["cash"]["mean"] == -2.0
    assert a["convergence"]["runs"][0]["at"]["60"]["above_end"] == 10.0
    assert a["pyvrp"]["PROD"]["chosen_for"]["MIN_TRUCKS"] == 2
    rows = {r["perturbation"]: r for r in a["stability"]["rows"] if r["option"] == "RECOMMENDED"}
    assert list(rows) == list(X.PERTURBATIONS) and rows["P0"]["stops_moved"] == 0 and rows["P0"]["cash_change"] == 0.0
    assert rows["P5"]["changed_stop_served_after"] is False and rows["P4"]["stops_on_unavailable_truck"] > 0
    assert a["stability"]["seed_reference_seeds"] == [2] and written["meta"]["equal_compute"] == X.PRODUCTION
    for text in ("### Spread over the seeds", "### Convergence of PROD (THOROUGH)", "### PROD against QUICKP",
                 "### Stability", "| P0: none |", "SOLVER_PARALLEL=1", "HAVERSINE"):
        assert text in md
    assert "fake-run-77" not in md and "fake-tenant" not in json.dumps(written)  # the leak check passed
    assert "| E6 Model behaviour at production settings | REAL-15OCT | COMPLETE | 10/10 | test QUICK |" in \
           (out / "INDEX.md").read_text(encoding="utf-8")

    (tmp_path / "cache" / "test" / "E6" / "REAL-15OCT" / "base" / "PROD-20s-s2.json").unlink()
    X.report_all(["E6"], groups, suite, days, X.RunCache(tmp_path / "cache", "test", read_only=True), out)
    day = json.loads((out / "E6-production.json").read_text(encoding="utf-8"))["days"]["REAL-15OCT"]
    assert day["status"] == "PARTIAL" and len(day["missing"]) == 1 and day["seeds"]["PROD"] == [1]
    X.report_all(["E6"], groups, suite, days, X.RunCache(tmp_path / "empty", "test", read_only=True), out)
    statuses = {d["status"] for d in json.loads((out / "E6-production.json").read_text(encoding="utf-8"))["days"].values()}
    assert statuses == {"INCOMPLETE"}
