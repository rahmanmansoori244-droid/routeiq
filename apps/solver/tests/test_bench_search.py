"""scripts/bench_search.py, the replay of saved requests that gates the solver search upgrade's flags
(RAILWAY_DEPLOYMENT.md: no flag goes on until its pre-written rule passes). The replay itself is never run in CI
(hours of THOROUGH solves on real requests, which never enter this public repository). These tests keep the tool
working on an invented request: the dry run checks the inputs and solves nothing, bad inputs are refused, one
tiny QUICK solve is recorded without any id of the request and is not run twice, and the rule reads paired
runs as written."""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest

import best_of as BO
import dispatch_solver as ds
import pyvrp_candidate as PV
from tests.test_dispatch import nmwc_day, req

SOLVER_DIR = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("bench_search", SOLVER_DIR / "scripts" / "bench_search.py")
bench = importlib.util.module_from_spec(_spec)
sys.modules["bench_search"] = bench  # its dataclasses look their module up while it loads
_spec.loader.exec_module(bench)


def _invented(tmp_path: Path, name: str = "day-request.json", **cfg):
    stops, trucks = nmwc_day(10, seed=7)
    r = req(stops, trucks[:3], time_limit_sec=1, scenarios=["RECOMMENDED"], **cfg)
    path = tmp_path / name
    path.write_text(r.model_dump_json(), encoding="utf-8")
    return r, path


def _ids(r) -> set[str]:
    out = {r.depot.id}
    for s in r.stops:
        out |= {s.stop_id, s.customer_id, *s.order_ids}
    for t in r.trucks:
        out |= {t.id, t.code}
    return {x for x in out if len(x) >= 2}


def _assert_no_ids(text: str, r) -> None:
    for x in _ids(r):
        assert not re.search(r"(?<![A-Za-z0-9_\-])" + re.escape(x) + r"(?![A-Za-z0-9_\-])", text), x


def test_dry_run_checks_the_inputs_and_solves_nothing(tmp_path, capsys, monkeypatch):
    r, path = _invented(tmp_path)
    monkeypatch.setattr(PV, "effective_cpus", lambda: 16)
    monkeypatch.setenv("SOLVER_PYVRP", "on")  # production's default (the tests' is off); a dry run starts nothing
    monkeypatch.setattr(ds, "optimize_dispatch", lambda *a, **k: pytest.fail("the dry run solved"))
    out = tmp_path / "out"
    assert bench.main([str(path), "--dry-run", "--out", str(out)]) == 0
    text = capsys.readouterr().out
    assert "nothing is solved" in text
    assert "runs: 30 " in text  # 1 request x 2 modes x 5 arms x 3 repetitions
    assert "QUICK best-of 3, PyVRP on; THOROUGH best-of 3, PyVRP on;" in text  # best_of, as the solver reads it
    assert "priority repair on" in text and "PyVRP on, models small-truck-only days" in text
    assert "small-truck-only stops 0 (a list decides: no)" in text
    assert not out.exists()
    _assert_no_ids(text, r)
    # The settings of the shell are untouched afterwards.
    assert BO.setting("THOROUGH") == 1 and not ds.priority_repair_on()


def test_bad_inputs_are_refused_before_anything_runs(tmp_path, capsys, monkeypatch):
    r, path = _invented(tmp_path)
    monkeypatch.setattr(ds, "optimize_dispatch", lambda *a, **k: pytest.fail("a refused bench solved"))
    out = str(tmp_path / "out")
    (tmp_path / "copy.json").write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    (tmp_path / "not-a-request.json").write_text("{}", encoding="utf-8")
    for argv in ([str(path), "--arms", "x=SOLVER_BESTOF=3"],  # a typo: the solver never reads it
                 [str(path), "--arms", "x=SOLVER_BEST_OF=10"],  # read as 1: the arm would equal base
                 [str(path), "--arms", "x=SOLVER_PRIORITY_REPAIR=enable"],
                 [str(path), "--arms", "x=SOLVER_PARALLEL=0"],  # production runs worker pools
                 [str(path), "--arms", "no_such_preset"],
                 [str(path), "--modes", "SLOW"],
                 [str(path), "--reps", "0"],
                 [str(tmp_path / "missing.json")],
                 [str(tmp_path / "not-a-request.json")],
                 [str(path), str(tmp_path / "copy.json")]):  # the same request twice
        assert bench.main(argv + ["--out", out]) == 2, argv
    inside = SOLVER_DIR / "bench-out"  # the repository is public
    assert bench.main([str(path), "--out", str(inside)]) == 2
    assert bench.main([str(path)]) == 2  # a run needs --out
    monkeypatch.setenv("ROUTEIQ_TEST_KILL_VARIANT", "0")
    assert bench.main([str(path), "--out", out]) == 2  # never with a test hook set
    err = capsys.readouterr().err
    assert "never reads SOLVER_BESTOF" in err and "SOLVER_BEST_OF='10'" in err and "inside the repository" in err
    assert not inside.exists() and not Path(out).exists()
    _assert_no_ids(err, r)


def test_one_quick_solve_is_recorded_without_ids_and_not_run_twice(tmp_path, monkeypatch):
    # A saved request names the company's road server: the bench never calls it, only this machine's OSRM_URL.
    monkeypatch.delenv("OSRM_URL", raising=False)
    r, path = _invented(tmp_path, distance_provider="OSRM", osrm_url="http://road-server.invalid:5000")
    out = tmp_path / "out"
    argv = [str(path), "--arms", "base", "--modes", "QUICK", "--reps", "1", "--out", str(out), "--cpu-note", "pytest"]
    assert bench.main(argv) == 0
    lines = (out / "results.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert (rec["mode"], rec["arm"], rec["rep"], rec["error"]) == ("QUICK", "base", 1, None)
    eff = rec["effective"]  # as the solver read it during the run: production's worker pools, every flag off
    assert eff["parallel"] is True and eff["best_of"] == 1 and eff["priority_repair"] is False
    assert eff["pyvrp_allowed"] == "skip" and eff["max_concurrent"] == 1
    o = rec["options"]["RECOMMENDED"]
    assert o["status"] == "OPTIMIZED" and o["feasibility"] == "VERIFIED"
    assert len(o["left_out_stops"]) == 5 and sum(o["left_out_stops"]) + o["served_stops"] == len(r.stops)
    assert rec["search"]["mode"] == "QUICK" and rec["search"]["used_sec"] <= rec["search"]["cap_sec"] - 60
    assert rec["best_of"] is None and rec["children_left"] == 0
    assert rec["matrix_provider"] == "HAVERSINE" and any("not configured" in w for w in rec["warnings"])
    summary = (out / "summary.md").read_text(encoding="utf-8")
    assert "PRE-WRITTEN RULE" in summary and "pytest" in summary and rec["digest"] in summary
    for text in (lines[0], summary):
        _assert_no_ids(text, r)
    # Continued in the same folder: the run is already recorded, so nothing is solved again.
    monkeypatch.setattr(ds, "optimize_dispatch", lambda *a, **k: pytest.fail("solved again"))
    assert bench.main(argv) == 0
    assert len((out / "results.jsonl").read_text(encoding="utf-8").splitlines()) == 1
    # Another arm under the same name with other settings is refused (its records would be mixed).
    assert bench.main([*argv[:2], "base=SOLVER_PRIORITY_REPAIR=on", *argv[3:]]) == 2


def _rec(arm: str, rep: int, cash: float = 100.0, left=(0, 0, 0, 0, 0), feas: str = "VERIFIED", used: float = 30.0,
         k: int = 1, ran: int | None = None, search_status: str = "OPTIMIZED", error=None) -> dict:
    return {"digest": "d1", "request": "day", "mode": "QUICK", "arm": arm, "rep": rep, "error": error,
            "facts": {"strict_priorities": True}, "effective": {"best_of": k}, "children_left": 0,
            "options": {"RECOMMENDED": {"status": "OPTIMIZED", "feasibility": feas, "operating_omr": cash, "km": 50.0,
                                        "trucks": 2, "loads": 3, "left_out_stops": list(left), "left_out_weight": 0.0,
                                        "inverted": 0, "repair": {"put_back": 0, "displaced": 0, "tried_no_place_or_time": 0}}},
            "search": {"used_sec": used, "cap_sec": 540, "search_sec": 20.0, "solutions": None},
            "best_of": None if ran is None else {"requested": k, "used": ran, "searches": [
                {"index": 0, "status": "OPTIMIZED"}, {"index": 1, "status": search_status}]}}


def test_the_pre_written_rule_reads_the_paired_runs():
    recs = [_rec("base", i) for i in (1, 2, 3)]
    on = dict(k=3, ran=3)
    recs += [_rec("good", 1, 98.0, **on), _rec("good", 2, 99.0, **on), _rec("good", 3, 101.0, **on)]
    recs += [_rec("worse", 1, 90.0, **on), _rec("worse", 2, 90.0, left=(0, 1, 0, 0, 0), **on), _rec("worse", 3, 90.0, **on)]
    recs += [_rec("violated", i, 90.0, feas="VIOLATED" if i == 2 else "VERIFIED", **on) for i in (1, 2, 3)]
    recs += [_rec("dearer", 1, 101.0, **on), _rec("dearer", 2, 102.0, **on), _rec("dearer", 3, 99.0, **on)]
    recs += [_rec("slow", i, 90.0, used=481.0 if i == 3 else 30.0, **on) for i in (1, 2, 3)]  # cap 540 - 60
    recs += [_rec("lost", i, 90.0, search_status="LOST" if i == 1 else "OPTIMIZED", **on) for i in (1, 2, 3)]
    recs += [_rec("failed", 1, error={"type": "SolveAborted"}, **on), _rec("failed", 2, **on), _rec("failed", 3, **on)]
    recs += [_rec("gated", i, 90.0, k=3, ran=1) for i in (1, 2, 3)]  # the CPU gate let one search run
    recs += [_rec("partial", i, 90.0, **on) for i in (1, 2)]
    ev = bench.evaluate(recs, "base", {"QUICK": 3})
    v = {arm: e["verdict"] for (_mode, arm), e in ev.items()}
    assert v["good"] == "PASS" and ev[("QUICK", "good")]["median_d_cash"] == -1.0
    assert (ev[("QUICK", "good")]["wins"], ev[("QUICK", "good")]["losses"]) == (2, 1)
    assert v["worse"].startswith("FAIL: 1 service worse in 1 pair")  # although it is cheaper every time
    assert v["violated"].startswith("FAIL: 2 not VERIFIED in 1 run")
    assert v["dearer"].startswith("FAIL: 3 median cash +1.00 OMR")
    assert v["slow"].startswith("FAIL: 4 over cap-60s in 1 run")
    assert v["lost"].startswith("FAIL: 5") and "search 1 LOST" in v["lost"]
    assert v["failed"].startswith("FAIL: 5") and "error SolveAborted" in v["failed"]
    assert v["gated"].startswith("NOT EXERCISED: best-of")
    assert v["partial"] == "INCOMPLETE: 2 of 3 pairs"
    assert ("QUICK", "base") not in ev
    # Service first, the engine's strict order: one P1 fewer left out outweighs two P5s more, and wins although dearer.
    better = bench.compare_pair(_rec("base", 1, left=(1, 0, 0, 0, 0)), _rec("x", 1, 120.0, left=(0, 0, 0, 0, 2)))
    assert (better["service"], better["outcome"]) == (1, "win")
    # The benefit's sign test: 3 wins of 3 is not yet evidence, 4 of 4 and 7 of 9 are.
    assert bench.sign_p(3, 0) == 0.125 and bench.sign_p(4, 0) == 0.0625 and round(bench.sign_p(7, 2), 4) == 0.0898
    summary = bench.summarize(recs, {"base": "base", "reps": 3, "requests": [{"label": "day", "digest": "d1", "modes": ["QUICK"],
                                                                                "facts": {}}], "arms": []})
    assert "**PASS**" in summary and "**FAIL: 1 service worse in 1 pair(s)**" in summary
