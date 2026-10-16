"""Best-of-N route search (best_of.py): its settings, CPU gate, stop orders and response contract.

Every setting is off by default (owner decision 16 Oct 2026): one search, exactly as before, and no
best_of in the response. These tests need no solve; the solves with several searches come with the
engine's use of them.
"""
from __future__ import annotations

import hashlib
import os
import random
import re
import subprocess
import sys
import textwrap
import time
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

import best_of
import dispatch_solver as ds
import pyvrp_candidate as PV
from dispatch_models import BestOfGain, BestOfReport, SearchReport, SearchRunReport

HERE = os.path.dirname(__file__)
SOLVER_DIR = os.path.dirname(HERE)
ENVS = ("SOLVER_BEST_OF", "SOLVER_BEST_OF_QUICK", "SOLVER_BEST_OF_SOURCES", "SOLVER_BEST_OF_JOIN_SEC",
        "SOLVER_BEST_OF_STRATEGIES", "MAX_CONCURRENT_DISPATCH", "SOLVER_PARALLEL", "SOLVER_PYVRP", "SOLVER_PYVRP_MIN_CPUS")
PCI = "PARALLEL_CHEAPEST_INSERTION"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in ENVS:
        monkeypatch.delenv(name, raising=False)


def _ts_block(ts: str, name: str) -> set[str]:
    block = ts.split(f"export interface {name} {{", 1)[1].split("\n}", 1)[0]
    return set(re.findall(r"^\s+(\w+)\??:", block, re.M))


def test_best_of_report_is_part_of_the_response_contract():
    """The TypeScript mirror (packages/shared-types) has exactly the models' fields, and SearchReport carries
    best_of and ortools_version as optional fields: an older solver's response still reads."""
    ts = open(os.path.join(SOLVER_DIR, "..", "..", "packages", "shared-types", "src", "dispatch.ts"), encoding="utf-8").read()
    ts = ts.replace("\r\n", "\n")
    for model in (SearchReport, BestOfReport, SearchRunReport, BestOfGain):
        assert _ts_block(ts, model.__name__) == set(model.model_fields), model.__name__
    assert re.search(r"best_of\?: BestOfReport \| null;", ts)
    assert re.search(r"ortools_version\?: string \| null;", ts)
    assert re.search(r"searches\?: SearchRunReport\[\];", ts) and re.search(r"gains\?: BestOfGain\[\];", ts)


def test_every_setting_is_off_by_default(monkeypatch):
    """Nothing set: one search in either mode, whatever the CPUs, and the startup line says off."""
    monkeypatch.setattr(PV, "effective_cpus", lambda: 64)
    for mode in ("THOROUGH", "QUICK"):
        assert best_of.setting(mode) == 1
        assert best_of.effective(mode, parallel=True, pyvrp_on=True) == (1, None)
        assert best_of.effective(mode, parallel=False, pyvrp_on=False) == (1, None)
    assert best_of.sources(1) == 0
    assert best_of.variants(best_of.setting("THOROUGH")) == [best_of.SearchVariant(0, 0, PCI)]
    assert best_of.join_sec() == 60.0 and best_of.strategies() == (PCI,) and best_of.max_concurrent() == 2
    st = best_of.status()
    assert (st["thorough"], st["effective_thorough"], st["quick"], st["effective_quick"], st["sources"]) == (1, 1, 1, 1, 0)
    assert best_of.startup_line() == "Best-of route search: off (one route search per solve; SOLVER_BEST_OF=1, SOLVER_BEST_OF_QUICK=1)"
    # The engine's search report has no best_of with one search.
    report = ds._search_report("QUICK", 540, {"limit": 5, "search_sec": 1.0, "status": "OPTIMIZED"}, time.monotonic())
    assert report.best_of is None and report.model_dump(mode="json")["best_of"] is None


@pytest.mark.parametrize("raw, want", [("", 1), ("1", 1), ("4", 4), (" 8 ", 8), ("9", 1), ("0", 1), ("-3", 1), ("4.0", 1), ("four", 1)])
def test_setting_parses_and_clamps(monkeypatch, raw, want):
    """1 to 8 searches; anything else (unset, unreadable, out of range) is one search. Each mode reads its own."""
    monkeypatch.setenv("SOLVER_BEST_OF", raw)
    assert best_of.setting("THOROUGH") == want
    assert best_of.setting("QUICK") == 1
    monkeypatch.delenv("SOLVER_BEST_OF")
    monkeypatch.setenv("SOLVER_BEST_OF_QUICK", raw)
    assert (best_of.setting("QUICK"), best_of.setting("THOROUGH")) == (want, 1)


def test_the_other_settings_parse_and_fall_back_to_their_defaults(monkeypatch):
    from ortools.constraint_solver import routing_enums_pb2

    cases = {
        "SOLVER_BEST_OF_SOURCES": [("", lambda: (best_of.sources(4), best_of.sources(2), best_of.sources(1)), (1, 1, 0)),
                                   ("2", lambda: (best_of.sources(4), best_of.sources(2)), (2, 1)),
                                   ("0", lambda: best_of.sources(4), 0),
                                   ("3", lambda: best_of.sources(8), 1),  # above MAX_SOURCES: the default
                                   ("x", lambda: best_of.sources(4), 1)],
        "SOLVER_BEST_OF_JOIN_SEC": [("0", best_of.join_sec, 0.0), ("1.5", best_of.join_sec, 1.5), ("300", best_of.join_sec, 300.0),
                                    ("301", best_of.join_sec, 60.0), ("-1", best_of.join_sec, 60.0), ("nan", best_of.join_sec, 60.0),
                                    ("inf", best_of.join_sec, 60.0), ("soon", best_of.join_sec, 60.0)],
        "SOLVER_BEST_OF_STRATEGIES": [("local_cheapest_insertion, PARALLEL_CHEAPEST_INSERTION,bogus,LOCAL_CHEAPEST_INSERTION",
                                       best_of.strategies, ("LOCAL_CHEAPEST_INSERTION", PCI)),
                                      ("bogus", best_of.strategies, (PCI,)), (" , ", best_of.strategies, (PCI,))],
        "MAX_CONCURRENT_DISPATCH": [("3", best_of.max_concurrent, 3), ("0", best_of.max_concurrent, 2), ("x", best_of.max_concurrent, 2)],
    }
    for name, rows in cases.items():
        for raw, read, want in rows:
            monkeypatch.setenv(name, raw)
            assert read() == want, (name, raw)
        monkeypatch.delenv(name)
    # Every allowed strategy is one OR-Tools 9.15 knows.
    for name in best_of.STRATEGY_WHITELIST:
        assert isinstance(getattr(routing_enums_pb2.FirstSolutionStrategy, name), int)


def test_cpu_gate_caps_k(monkeypatch):
    """Each of MAX_CONCURRENT_DISPATCH solves gets cpus // that many, one of them for PyVRP when it runs.
    Production (24 CPUs, 2 solves): K=4 runs; a 4-CPU CI runner: one search (CPU_GATE)."""
    monkeypatch.setenv("SOLVER_BEST_OF", "4")
    cpus = {"n": 4}
    monkeypatch.setattr(PV, "effective_cpus", lambda: cpus["n"])
    gate = lambda pyvrp_on=True, parallel=True: best_of.effective("THOROUGH", parallel=parallel, pyvrp_on=pyvrp_on)  # noqa: E731
    assert gate() == (1, "CPU_GATE")
    assert gate(parallel=False) == (1, "IN_PROCESS")
    cpus["n"] = 8
    assert gate() == (3, "CPU_GATE") and gate(pyvrp_on=False) == (4, None)
    cpus["n"] = 24
    assert gate() == (4, None)
    assert best_of.effective("QUICK", parallel=True, pyvrp_on=True) == (1, None)
    st = best_of.status()
    assert (st["thorough"], st["effective_thorough"], st["why_thorough"], st["sources"], st["cpus"]) == (4, 4, None, 1, 24)
    assert best_of.startup_line() == ("Best-of route search: THOROUGH 4 searches, QUICK 1 search (effective CPUs 24, "
                                      "2 solves at once, 1 extra source(s) re-checked, join 60 s)")
    cpus["n"] = 4
    monkeypatch.setenv("MAX_CONCURRENT_DISPATCH", "1")
    assert gate() == (3, "CPU_GATE")
    monkeypatch.setenv("MAX_CONCURRENT_DISPATCH", "2")
    assert best_of.startup_line().startswith("Best-of route search: THOROUGH 1 search of 4 asked (CPU_GATE), QUICK 1 search")
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    assert best_of.status()["why_thorough"] == "IN_PROCESS"


def test_variant_order_is_a_deterministic_permutation():
    """Seed 0 is the request's order; a seed above 0 is a permutation that depends only on the stop ids, not
    on the order they come in, and a subset keeps its relative order from the whole day's. 50 random days."""
    rnd = random.Random(7)
    for _ in range(50):
        n = rnd.randint(1, 60)
        ids = [f"S{rnd.randrange(10**6):06d}-{k}" for k in range(n)]
        assert best_of.order(ids, 0) == list(range(n))
        for seed in (1, 2, 7):
            perm = best_of.order(ids, seed)
            assert sorted(perm) == list(range(n))
            shuffled = ids[:]
            rnd.shuffle(shuffled)
            assert [ids[k] for k in perm] == [shuffled[k] for k in best_of.order(shuffled, seed)]
            sub = [i for i in ids if rnd.random() < 0.5]
            whole = [ids[k] for k in perm]
            assert [sub[k] for k in best_of.order(sub, seed)] == [i for i in whole if i in set(sub)]


def test_variant_order_matches_the_evidence_seeds():
    """Search i uses decision-support's seeded(i) order: sorted by sha256(f"{i}:{stop_id}")."""
    stops = [SimpleNamespace(stop_id=f"ST-{k:03d}") for k in range(40)]
    for seed in (1, 2, 3, 5):
        want = sorted((s.stop_id for s in stops), key=lambda i: hashlib.sha256(f"{seed}:{i}".encode()).hexdigest())
        assert [stops[k].stop_id for k in best_of.order(stops, seed)] == want
    assert best_of.order(stops, 1) != best_of.order(stops, 2)


def test_variants_take_the_strategies_in_turn(monkeypatch):
    assert best_of.variants(1) == [best_of.SearchVariant(0, 0, PCI)]
    monkeypatch.setenv("SOLVER_BEST_OF_STRATEGIES", "LOCAL_CHEAPEST_INSERTION,SEQUENTIAL_CHEAPEST_INSERTION")
    vs = best_of.variants(4)
    assert [(v.index, v.order_seed, v.first_solution) for v in vs] == [
        (0, 0, PCI), (1, 1, "LOCAL_CHEAPEST_INSERTION"), (2, 2, "SEQUENTIAL_CHEAPEST_INSERTION"), (3, 3, "LOCAL_CHEAPEST_INSERTION")]
    assert len(best_of.variants(20)) == best_of.MAX_K and best_of.variants(0) == [best_of.SearchVariant(0, 0, PCI)]
    assert [v.source for v in vs[:2]] == ["RECOMMENDED", "RECOMMENDED~1"]
    assert best_of.from_extra("RECOMMENDED~2") and best_of.from_extra("RECOMMENDED~2+repack")
    assert not any(best_of.from_extra(s) for s in ("RECOMMENDED", "RECOMMENDED+fit", "MIN_TRUCKS+repack", "PYVRP+repack"))


def test_every_search_outcome_gives_a_valid_report(caplog):
    """No outcome of a search can fail a finished solve: every pool outcome maps to a status, JOINED (or an
    unknown reason) never reaches SearchReport.stop_reason, the per-search fields take any string, and a
    report that does not validate is left out (the plan is kept)."""
    for kind in ("ok", "error", "lost", "broken", "timeout", "something-new"):
        for own in (*best_of.RUN_STATUSES, None, "SOMETHING_NEW"):
            assert best_of.run_status(kind, own) in best_of.RUN_STATUSES
    assert [best_of.run_status(k) for k in ("error", "lost", "broken", "timeout")] == ["FAILED", "LOST", "LOST", "TIMEOUT"]
    assert best_of.run_status("ok", "NOT_RUN") == "NOT_RUN" and best_of.run_status("ok", None) == "FAILED"
    base = dict(mode="THOROUGH", cap_sec=1200, limit_sec=900, search_sec=600.0, used_sec=700.0)
    for reason in ("TIME_LIMIT", "CONVERGED", "CAP", "STOPPED", "NOT_SEARCHED", "NO_PLAN", "JOINED", "SOMETHING_NEW", None):
        top = best_of.top_level_stop_reason(reason)
        assert top == ("CONVERGED" if reason == "JOINED" else None if reason in ("SOMETHING_NEW", None) else reason)
        if top is not None:
            SearchReport(**base, stop_reason=top)
    with pytest.raises(ValidationError):
        SearchReport(**base, stop_reason="JOINED")  # why the mapping exists
    run = SearchRunReport(index=1, status="SOMETHING_NEW", stop_reason=best_of.JOINED)
    good = {"requested": 4, "used": 3, "gate": "CPU_GATE", "searches": [run.model_dump(), {"index": 0, "status": "OPTIMIZED"}],
            "gains": [{"option": "RECOMMENDED", "source": "RECOMMENDED~1+repack", "gain_omr": 4.5, "used": True}]}
    rep = best_of.report_or_none(good)
    assert isinstance(rep, BestOfReport) and rep.searches[0].stop_reason == "JOINED" and rep.gains[0].used
    assert best_of.report_or_none(rep) is rep and best_of.report_or_none(None) is None
    with caplog.at_level("WARNING", logger="routeiq.dispatch"):
        assert best_of.report_or_none({"requested": "four", "used": 1}) is None
        assert best_of.report_or_none({"requested": 2, "used": 2, "searches": [{"status": "OPTIMIZED"}]}) is None  # no index
    assert sum("best-of report left out" in r.getMessage() for r in caplog.records) == 2


def test_search_report_best_of_is_optional_and_round_trips():
    """A stored response from before the fields reads with best_of and ortools_version None; one with them
    survives JSON both ways."""
    old = {"mode": "QUICK", "cap_sec": 540, "limit_sec": 5, "search_sec": 4.9, "used_sec": 6.2, "stop_reason": "TIME_LIMIT"}
    s = SearchReport.model_validate(old)
    assert s.best_of is None and s.ortools_version is None
    full = SearchReport.model_validate({**old, "ortools_version": "9.15.6755", "best_of": {
        "requested": 3, "used": 3, "join_sec": 60.0, "primary_status": "LOST", "promoted": 2, "chosen_for": ["RECOMMENDED"],
        "gains": [{"option": "MIN_DISTANCE", "source": "RECOMMENDED~2", "gain_km": 3.2, "gain_trucks": 0, "served_delta": 0}],
        "searches": [{"index": 0, "status": "LOST"},
                     {"index": 2, "order_seed": 2, "first_solution": PCI, "status": "OPTIMIZED", "stop_reason": "JOINED",
                      "search_sec": 610.2, "last_improvement_sec": 402.0, "solutions": 812, "rank_sec": 0.4, "exact": True,
                      "cost_omr": 512.25, "operating_omr": 498.0, "km": 870.4, "trucks": 9, "loads": 11,
                      "unserved_by_priority": [0, 0, 1, 0, 2], "rechecked": True, "warm_start": True}]}})
    again = SearchReport.model_validate_json(full.model_dump_json())
    assert again == full and again.best_of.searches[1].unserved_by_priority == [0, 0, 1, 0, 2]
    assert again.best_of.promoted == 2 and again.best_of.gains[0].gain_km == 3.2


def test_best_of_loads_neither_pyvrp_nor_numpy():
    """The engine and the API process will import it: like the API module, it must not load PyVRP's native
    library or numpy (PR #50; test_api_process_no_pyvrp.py)."""
    code = textwrap.dedent(
        """
        import sys
        import best_of  # noqa: F401
        best_of.status(); best_of.startup_line(); best_of.order(["a", "b"], 1)
        loaded = sorted(m for m in sys.modules if m.split(".")[0] in ("pyvrp", "numpy"))
        print("LOADED=" + ",".join(loaded))
        """
    )
    r = subprocess.run([sys.executable, "-c", code], cwd=SOLVER_DIR, capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, r.stderr[-3000:]
    assert r.stdout.strip().endswith("LOADED="), r.stdout[-2000:]
