"""Decision support, the evidence-suite CLI (DESIGN.md section 6): the run lists and their lane split are
deterministic, the cache keys are stable, and --report rebuilds the outputs from the cache alone."""
from __future__ import annotations

import json
import socket
from dataclasses import replace

import pytest

from decision_support import core, ivms, synth
from decision_support import experiments as X
from decision_support.core import Budget


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
    assert {("E1", "REAL-15OCT"), ("E2", "REAL-15OCT"), ("E3", "REAL-15OCT"), ("E4", "REAL-15OCT-PREFIX")} == skipped
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
