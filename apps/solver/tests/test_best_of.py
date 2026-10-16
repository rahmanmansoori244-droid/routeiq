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
    # One it could not read (or out of range) is named in the startup line, not shown as the default it falls back
    # to (review of 16 Oct 2026).
    named = f"SOLVER_BEST_OF={raw.strip()!r} not read (a whole number from 1 to 8)" in best_of.startup_line()
    assert named is (want == 1 and raw.strip() not in ("", "1")), best_of.startup_line()
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
    # Unread ones are named in the startup line (review of 16 Oct 2026); a value read, or none, is not.
    monkeypatch.setenv("SOLVER_BEST_OF_SOURCES", "x")
    monkeypatch.setenv("SOLVER_BEST_OF_JOIN_SEC", "inf")
    monkeypatch.setenv("SOLVER_BEST_OF_QUICK", "1")
    assert best_of.unread() == [("SOLVER_BEST_OF_SOURCES", "x", "a whole number from 0 to 2"),
                                ("SOLVER_BEST_OF_JOIN_SEC", "inf", "seconds from 0 to 300")]
    assert best_of.startup_line() == (
        "Best-of route search: off (one route search per solve; SOLVER_BEST_OF=1, SOLVER_BEST_OF_QUICK=1; "
        "SOLVER_BEST_OF_SOURCES='x' not read (a whole number from 0 to 2): its default is used; "
        "SOLVER_BEST_OF_JOIN_SEC='inf' not read (seconds from 0 to 300): its default is used)")
    monkeypatch.setenv("SOLVER_BEST_OF_JOIN_SEC", "1.5")
    monkeypatch.delenv("SOLVER_BEST_OF_SOURCES")
    assert best_of.unread() == []
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


# ---------------------------------------------------------------------------------------------
# The engine's use of several searches (dispatch_solver: _recommended_best_of and its helpers)
# ---------------------------------------------------------------------------------------------
# The solves below run in worker processes (SOLVER_PARALLEL unset), so a monkeypatch in this process
# never reaches a search (critique of the design #3): the faults come from the ROUTEIQ_TEST_* hooks, read
# in the workers, and the choice among plans is tested on its own (_best_of_choice). The CPU gate runs in
# this process: PV.effective_cpus is patched so a small CI runner still runs K searches.

ALL3 = ["RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE"]


def _run(index: int, *, ok: bool = True, rank=None, signature=None) -> dict:
    return {"index": index, "ok": ok, "rank": rank, "signature": signature if signature is not None else ("plan", index)}


def test_the_choice_keeps_the_main_search_on_a_tie_and_takes_the_best_other_plans():
    """The alternatives start from the best-ranked plan (the main one on a tie, and always when it could not
    be ranked); the load re-check gets at most m other plans, best first, never an unranked one nor one
    equal to the main plan or to another chosen one."""
    main, warm, src = ds._best_of_choice([_run(0, rank=(0, 500)), _run(1, rank=(0, 500)), _run(2, rank=(0, 501))], 1)
    assert (main["index"], warm["index"], [r["index"] for r in src]) == (0, 0, [1])
    main, warm, src = ds._best_of_choice([_run(0, rank=(0, 500)), _run(1, rank=(0, 499)), _run(2, rank=(0, 400)),
                                          _run(3, rank=(0, 300), signature=("plan", 2))], 2)
    assert (main["index"], warm["index"]) == (0, 3)
    assert [r["index"] for r in src] == [3, 1]  # search 2 has search 3's plan: one source
    main, warm, src = ds._best_of_choice([_run(0, rank=(0, 500), signature="same"), _run(1, rank=(0, 400), signature="same"),
                                          _run(2, rank=None), _run(3, ok=False)], 2)
    assert (warm["index"], src) == (1, [])  # the same plan as the main one, the unranked and the failed: none
    main, warm, src = ds._best_of_choice([_run(0, rank=None), _run(1, rank=(0, 1))], 1)
    assert (main["index"], warm["index"], [r["index"] for r in src]) == (0, 0, [1])
    # Service first: a plan that leaves a higher priority out never ranks better however cheap.
    main, warm, _ = ds._best_of_choice([_run(0, rank=(0, 900)), _run(1, rank=(1, 10))], 0)
    assert warm["index"] == 0


def test_a_failed_main_search_is_replaced_by_the_best_ranked_other_one():
    main, warm, src = ds._best_of_choice([_run(0, ok=False), _run(1, rank=(0, 300)), _run(2, rank=(0, 200)),
                                          _run(3, rank=(0, 250))], 1)
    assert (main["index"], warm["index"], [r["index"] for r in src]) == (2, 2, [3])
    assert ds._best_of_choice([_run(0, ok=False), _run(1, ok=False)], 1) == (None, None, [])
    main, _, _ = ds._best_of_choice([_run(0, ok=False), _run(1, rank=None), _run(2, rank=(5, 5))], 0)
    assert main["index"] == 2  # a ranked plan before an unranked one


class _FakeRouting:
    """What _SearchWatch reads from OR-Tools: the objective of each accepted solution."""

    def __init__(self):
        self.value, self.finished = 100, 0
        me = self

        class _Var:
            def Max(self):  # noqa: N802
                return me.value

        class _Solver:
            def FinishCurrentSearch(self):  # noqa: N802
                me.finished += 1

        self._var, self._solver = _Var(), _Solver()

    def CostVar(self):  # noqa: N802
        return self._var

    def solver(self):
        return self._solver

    def NextVar(self, i):  # noqa: N802
        raise AssertionError("no stops to count")


class _Flag:
    def __init__(self):
        self.on = False

    def is_set(self):
        return self.on


def test_a_joined_search_ends_at_its_next_solution_and_a_stop_comes_first():
    """The join flag ends one of the other searches with its best plan (JOINED); without one, or before it
    is raised, the watch is exactly as before; a stop request at the same time is STOPPED."""
    rule = ds.StallRule(min_sec=3600, floor_sec=3600, share=0.0)
    for join_flag in (None, _Flag()):
        r = _FakeRouting()
        w = ds._SearchWatch(r, rule, _Flag(), join_flag=join_flag)
        w.on_solution()
        assert (w.reason, r.finished) == (None, 0)
    r, stop, join = _FakeRouting(), _Flag(), _Flag()
    w = ds._SearchWatch(r, rule, stop, join_flag=join)
    join.on = True
    r.value = 90
    w.on_solution()
    assert (w.reason, r.finished, w.best) == ("JOINED", 1, 90)
    r, stop, join = _FakeRouting(), _Flag(), _Flag()
    w = ds._SearchWatch(r, rule, stop, join_flag=join)
    stop.on = join.on = True
    w.on_solution()
    assert w.reason == "STOPPED"


def test_a_search_that_replaced_the_main_one_never_fails_the_report(caplog):
    """SearchReport.stop_reason is a closed list: JOINED is CONVERGED there (the search's own report keeps
    it), and a best-of report that does not validate is left out - the solve still answers."""
    state = {"limit": 900, "search_sec": 640.0, "status": "OPTIMIZED", "watch": {"reason": "JOINED", "solutions": 5},
             "best_of": {"requested": 3, "used": "three"}}
    with caplog.at_level("WARNING", logger="routeiq.dispatch"):
        rep = ds._search_report("THOROUGH", 1200, state, time.monotonic())
    assert rep.stop_reason == "CONVERGED" and rep.best_of is None
    assert ds._stop_reason("THOROUGH", {"reason": "JOINED"}, 640.0, 900, "OPTIMIZED", top=False) == "JOINED"
    assert ds._stop_reason("THOROUGH", {"reason": "SOMETHING_NEW"}, 899.5, 900, "OPTIMIZED") == "CAP"
    for reason in ("STOPPED", "CONVERGED"):  # as before
        assert ds._stop_reason("THOROUGH", {"reason": reason}, 10.0, 900, "OPTIMIZED") == reason


def _join_seen(_arg=None):
    """In a worker of a join pool: are the join flag and the stop flag up?"""
    return ds._JOIN_FLAG is not None and ds._JOIN_FLAG.is_set(), ds._STOP_FLAG is not None and ds._STOP_FLAG.is_set()


def test_the_other_searches_pool_raises_its_flags_through_pipes_and_releases_them():
    """Critique of the design, MEDIUM-1: the other searches' pool has no multiprocessing Event - its stop and
    join flags are pipes, which every worker polls (one byte, never read) - and close() releases both and
    detaches the stop flag from the solve's control."""
    import multiprocessing as mp

    control = ds.SolveControl()
    w = ds._Workers(2, control, run_id="t", what="other route searches", join=True)
    try:
        assert isinstance(w._join_flag, ds._PipeFlag) and isinstance(w._stop_flag, ds._PipeFlag)
        assert control._flags == [w._stop_flag]
        got = ds._await_all(w, {"a": w.submit(_join_seen, None, "a")}, time.monotonic() + 120)
        assert got["a"] == ("ok", (False, False))
        w.raise_join()
        control.request_stop()
        got = ds._await_all(w, {k: w.submit(_join_seen, None, k) for k in ("b", "c")}, time.monotonic() + 60)
        assert got == {"b": ("ok", (True, True)), "c": ("ok", (True, True))}
    finally:
        w.close()
    assert w._join_flag is None and w._stop_flag is None and w.pool is None
    assert control._flags == [] and mp.active_children() == []
    w.raise_join()  # closed: nothing


@pytest.fixture
def parallel(monkeypatch):
    """Worker processes as in production, the second search off, enough CPUs for K searches."""
    monkeypatch.delenv("SOLVER_PARALLEL", raising=False)
    monkeypatch.delenv("SOLVER_ALLOW_INPROCESS_FALLBACK", raising=False)
    monkeypatch.setenv("SOLVER_PYVRP", "off")
    monkeypatch.setattr(PV, "effective_cpus", lambda: 16)


def _spy_pools(monkeypatch) -> tuple[list, list]:
    pools: list = []
    names: list = []
    init, submit = ds._Workers.__init__, ds._Workers.submit

    def spy_init(self, size, control=None, **kw):
        pools.append((int(size), kw.get("what", "search"), bool(kw.get("join"))))
        init(self, size, control, **kw)

    def spy_submit(self, fn, arg, name):
        names.append(name)
        return submit(self, fn, arg, name)

    monkeypatch.setattr(ds._Workers, "__init__", spy_init)
    monkeypatch.setattr(ds._Workers, "submit", spy_submit)
    return pools, names


def test_best_of_is_off_by_default_and_changes_nothing(parallel, monkeypatch):
    """Owner decision 16 Oct 2026: nothing set, the solve is the one-search solve - one pool of two
    processes (the alternatives'), one RECOMMENDED search, no other searches' pool, search.best_of null.
    Asked for but gated (too few CPUs): the same solve, and the report says why."""
    from tests.test_dispatch import nmwc_day, req

    pools, names = _spy_pools(monkeypatch)
    r = req(*nmwc_day(20), scenarios=ALL3, time_limit_sec=2)
    resp = ds.optimize_dispatch(r)
    assert pools == [(2, "search", False)]
    assert names.count("RECOMMENDED") == 1 and not any(n.startswith("RECOMMENDED~") for n in names)
    assert resp.search.best_of is None and resp.search.stop_reason == "TIME_LIMIT"
    assert all(sc.feasibility.status == "VERIFIED" for sc in resp.scenarios)
    pools.clear()
    names.clear()
    monkeypatch.setenv("SOLVER_BEST_OF_QUICK", "3")
    monkeypatch.setattr(PV, "effective_cpus", lambda: 2)  # 2 CPUs // 2 solves at once: one search
    resp = ds.optimize_dispatch(r)
    assert pools == [(2, "search", False)] and names.count("RECOMMENDED") == 1
    b = resp.search.best_of
    assert (b.requested, b.used, b.gate, b.promoted) == (3, 1, "CPU_GATE", None)
    assert [(s.index, s.status, s.stop_reason) for s in b.searches] == [(0, "OPTIMIZED", "TIME_LIMIT")]


def test_a_reordered_search_maps_back_to_the_request():
    """_variant_worker in this process (no join flag here: critique L5): its plan names the request's
    stops, the stops it leaves out come in the main search's order after the prefilter's drops, the
    plan reconciles, and it is ranked on its exact timing."""
    from tests.test_dispatch import assert_reconciled, nmwc_day, req
    from tests.test_pyvrp_candidate import _prepared

    stops, trucks = nmwc_day(30)
    r = req(stops, trucks[:1], time_limit_sec=2)  # one truck: some stops are left out
    tds, solvable, drops, mx = _prepared(r)
    job = ("RECOMMENDED", r, solvable, tds, mx, 2, drops)
    out = ds._variant_worker((best_of.SearchVariant(2, 2, PCI), time.monotonic(), job))
    sc = out["scenario"]
    assert out["status"] == sc.status == "OPTIMIZED" and out["limit"] == 2 and out["watch"] is None
    assert_reconciled(r, sc)
    pos = {s.stop_id: k for k, s in enumerate(solvable)}
    left = [u.stop_id for u in sc.unserved[len(drops):]]
    assert left and left == sorted(left, key=pos.__getitem__)
    assert [u.stop_id for u in sc.unserved[:len(drops)]] == [d.stop_id for d in drops]
    assert out["exact"] is True and out["rank"][0] > 0 and out["signature"]
    assert sum(out["summary"]["unserved_by_priority"]) == len(left)
    assert best_of.order(solvable, 2) != list(range(len(solvable)))  # it really searched another order


def test_quick_best_of_runs_k_searches_and_reports_each(parallel, monkeypatch):
    """SOLVER_BEST_OF_QUICK=3: three searches, each reported; nothing is attached to a QUICK search
    (critique of the design #5: every one ends on its time limit, no watch data); the alternatives start
    from exactly one of them; every option keeps every rule and passes the independent check."""
    from tests.test_dispatch import nmwc_day, req
    from tests.test_repack import assert_plan_rules

    monkeypatch.setenv("SOLVER_BEST_OF_QUICK", "3")
    # A loaded CI runner may still be starting an other search's process: wait for each (they end on their 2 s
    # limit), not the production 5 s (review of 16 Oct 2026). The wait runs in this process.
    monkeypatch.setattr(best_of, "QUICK_WAIT_SEC", 60.0)
    # A small day often makes every search find the same plan (none then goes to the load re-check): re-check
    # one anyway, so that the wiring below is always exercised (review of 16 Oct 2026). The choice runs here.
    real_choice = ds._best_of_choice

    def choice(runs, m):
        main, warm, picked = real_choice(runs, m)
        return main, warm, picked or [r for r in runs if r["index"] and r["ok"] and r["rank"] is not None][:1]

    monkeypatch.setattr(ds, "_best_of_choice", choice)
    pools, names = _spy_pools(monkeypatch)
    r = req(*nmwc_day(30), scenarios=ALL3, time_limit_sec=2)
    resp = ds.optimize_dispatch(r)
    assert pools == [(2, "search", False), (2, "other route searches", True)]
    assert names.count("RECOMMENDED") == 1 and {n for n in names if "~" in n} == {"RECOMMENDED~1", "RECOMMENDED~2"}
    b = resp.search.best_of
    assert (b.requested, b.used, b.gate, b.join_sec, b.promoted, b.primary_status) == (3, 3, None, None, None, None)
    assert [s.index for s in b.searches] == [0, 1, 2] and [s.order_seed for s in b.searches] == [0, 1, 2]
    for s in b.searches:
        assert (s.status, s.stop_reason, s.solutions, s.last_improvement_sec, s.exact) == ("OPTIMIZED", "TIME_LIMIT", None, None, True)
        assert s.trucks and s.cost_omr and len(s.unserved_by_priority) == 5 and s.rank_sec is not None
    assert sum(s.warm_start for s in b.searches) == 1
    assert sum(s.rechecked for s in b.searches) == best_of.sources(3) == 1
    assert resp.search.stop_reason == "TIME_LIMIT" and {sc.name for sc in resp.scenarios} == set(ALL3)
    for sc in resp.scenarios:
        assert_plan_rules(r, sc)
    # Integration (the search side and the load re-check side): a re-checked search reaches _post_solve as an
    # extra source - one gain per option, against the best plan without it - and an option is in chosen_for
    # exactly when its plan came from it (its note says so).
    noted = {sc.name for sc in resp.scenarios if any("(started from another order of the stops)" in w for w in sc.warnings)}
    assert sorted(g.option for g in b.gains) == sorted(ALL3)
    assert all(g.source is None or best_of.from_extra(g.source) for g in b.gains)
    assert set(b.chosen_for) == {g.option for g in b.gains if g.used} and noted <= set(b.chosen_for)


def test_failed_lost_and_hung_other_searches_cost_nothing(parallel, monkeypatch):
    """An other search that raises (FAILED), whose process dies (LOST) or that never answers (TIMEOUT, its
    process stopped): the main search's plan, every option, no process left."""
    import multiprocessing as mp

    from tests.test_dispatch import nmwc_day, req

    for k, v in {"SOLVER_BEST_OF_QUICK": "4", "ROUTEIQ_TEST_FAIL_VARIANT": "1", "ROUTEIQ_TEST_KILL_VARIANT": "2",
                 "ROUTEIQ_TEST_HANG_VARIANT": "3"}.items():
        monkeypatch.setenv(k, v)
    r = req(*nmwc_day(20), scenarios=ALL3, time_limit_sec=2)
    resp = ds.optimize_dispatch(r)
    b = resp.search.best_of
    assert [(s.index, s.status) for s in b.searches] == [(0, "OPTIMIZED"), (1, "FAILED"), (2, "LOST"), (3, "TIMEOUT")]
    assert b.searches[0].warm_start and b.promoted is None
    assert {sc.name for sc in resp.scenarios} == set(ALL3)
    assert all(sc.status == "OPTIMIZED" and sc.feasibility.status == "VERIFIED" for sc in resp.scenarios)
    assert mp.active_children() == []


def test_a_lost_main_search_is_replaced_by_the_best_other_one(parallel, monkeypatch):
    """Critique of the design, HIGH-1: the main search's process dies (with one search: 504). The best-ranked
    other search becomes RECOMMENDED's plan, the report says so, and SearchReport stays valid."""
    from tests.test_dispatch import nmwc_day, req

    monkeypatch.setenv("SOLVER_BEST_OF_QUICK", "3")
    monkeypatch.setenv("ROUTEIQ_TEST_KILL_SCENARIO", "RECOMMENDED")
    r = req(*nmwc_day(20), scenarios=ALL3, time_limit_sec=2)
    resp = ds.optimize_dispatch(r)
    b = resp.search.best_of
    assert (b.primary_status, b.searches[0].status) == ("LOST", "LOST")
    others = [s for s in b.searches[1:] if s.status == "OPTIMIZED"]
    best = min(others, key=lambda s: (sum(s.unserved_by_priority), s.cost_omr, s.index))
    assert b.promoted == best.index and best.warm_start
    assert resp.search.stop_reason == "TIME_LIMIT" and resp.search.search_sec == round(best.search_sec, 1)
    rec_sc = next(sc for sc in resp.scenarios if sc.name == "RECOMMENDED")
    assert rec_sc.status == "OPTIMIZED" and rec_sc.feasibility.status == "VERIFIED"


def test_thorough_other_searches_join_when_the_main_one_ends(parallel, monkeypatch):
    """THOROUGH: the main search stops on its stall rule; another without one (test hook) is joined
    SOLVER_BEST_OF_JOIN_SEC later and hands back its best plan (JOINED); one that ignores the join (it
    hangs) is cut after best_of.JOIN_GRACE_SEC (TIMEOUT, its pool closed) and the alternative still runs.
    The main search's progress (solutions, last improvement) is reported for the contention check
    (critique of the design #4), and the request stays inside its cap (a 3 s base so that the main search
    can converge, critique MEDIUM-4)."""
    import multiprocessing as mp

    from tests.test_dispatch import nmwc_day, req

    for k, v in {"SOLVER_BEST_OF": "3", "THOROUGH_STALL_SEC": "1", "ROUTEIQ_TEST_NO_STALL_VARIANT": "1",
                 "ROUTEIQ_TEST_HANG_VARIANT": "2", "SOLVER_BEST_OF_JOIN_SEC": "1"}.items():
        monkeypatch.setenv(k, v)
    cap = 120
    r = req(*nmwc_day(20), scenarios=["RECOMMENDED", "MIN_TRUCKS"], search_mode="THOROUGH", max_search_sec=cap, time_limit_sec=3)
    resp = ds.optimize_dispatch(r)
    s, b = resp.search, resp.search.best_of
    assert s.stop_reason == "CONVERGED" and s.used_sec <= cap + 5
    assert [(x.index, x.status, x.stop_reason) for x in b.searches] == [
        (0, "OPTIMIZED", "CONVERGED"), (1, "OPTIMIZED", "JOINED"), (2, "TIMEOUT", None)]
    # The window is counted from the main search's end, so it holds the ranking of its plan too (review of 16 Oct 2026).
    assert b.join_sec is not None and b.join_sec <= 1.0 + (b.searches[0].rank_sec or 0.0) + 0.1, b
    assert b.searches[0].solutions and b.searches[0].solutions == s.solutions and b.searches[0].last_improvement_sec is not None
    assert b.searches[1].solutions and b.searches[1].search_sec < s.limit_sec
    assert [sc.name for sc in resp.scenarios] == ["RECOMMENDED", "MIN_TRUCKS"]
    assert all(sc.feasibility.status == "VERIFIED" for sc in resp.scenarios) and mp.active_children() == []


def test_a_stop_request_ends_every_search(parallel, monkeypatch):
    """A supervisor's stop reaches the other searches too (their pool's stop flag): every search hands back
    its best plan (STOPPED), the alternatives are skipped, the plan is complete."""
    import threading

    from tests.test_dispatch import nmwc_day, req

    monkeypatch.setenv("SOLVER_BEST_OF", "3")
    control = ds.SolveControl()
    r = req(*nmwc_day(30), scenarios=ALL3, search_mode="THOROUGH", max_search_sec=120, time_limit_sec=3)
    # The stop comes 8 s after the other searches were submitted (review of 16 Oct 2026: a fixed delay from the
    # solve's start assumed they had started by then); their stall rule (300 s) never ends them first.
    submitted = threading.Event()
    submit = ds._Workers.submit

    def spy_submit(self, fn, arg, name):
        out = submit(self, fn, arg, name)
        if name == "RECOMMENDED~2":
            submitted.set()
        return out

    monkeypatch.setattr(ds._Workers, "submit", spy_submit)
    done = threading.Event()
    timer = threading.Thread(target=lambda: submitted.wait(120) and not done.wait(8.0) and control.request_stop(), daemon=True)
    timer.start()
    try:
        resp = ds.optimize_dispatch(r, control=control)
    finally:
        done.set()
        timer.join(10)
    b = resp.search.best_of
    assert [(x.index, x.stop_reason) for x in b.searches] == [(0, "STOPPED"), (1, "STOPPED"), (2, "STOPPED")]
    assert [sc.name for sc in resp.scenarios] == ["RECOMMENDED"] and resp.search.stop_reason == "STOPPED"
    assert any("stopped early" in w for w in resp.scenarios[0].warnings)
    assert control._flags == []


def test_hire_trials_search_once(monkeypatch):
    """The hire reduction's trials compare many solves of the day: one search each, whatever is set."""
    from tests.test_dispatch import nmwc_day, req
    from tests.test_pyvrp_candidate import _prepared

    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    monkeypatch.setenv("SOLVER_BEST_OF_QUICK", "4")
    seen: list = []
    monkeypatch.setattr(ds, "_run_scenarios", lambda *a, **kw: seen.append(kw) or [])
    r = req(*nmwc_day(10), time_limit_sec=1)
    tds, solvable, drops, mx = _prepared(r)
    assert ds._hire_trial(r, solvable, mx, drops, 1, time.monotonic() + 60, None) == (None, False)
    assert [kw.get("best_of") for kw in seen] == [1] and "extras" not in seen[0]


def test_ready_reports_best_of_and_the_startup_line(monkeypatch):
    """/ready names the searches asked for and run per mode and why fewer (critique of the design #9: the
    post-deploy check); it never changes ``ok``. The startup line says the same."""
    from fastapi.testclient import TestClient

    import main

    monkeypatch.setattr(main, "SOLVER_TOKEN", "unit-test-solver-token")
    monkeypatch.setattr(PV, "effective_cpus", lambda: 24)
    client = TestClient(main.app)
    body = client.get("/ready", headers={"X-Solver-Token": "unit-test-solver-token"}).json()
    assert body["ok"] is True and body["best_of"]["thorough"] == body["best_of"]["effective_thorough"] == 1
    assert set(body["best_of"]) == {"thorough", "effective_thorough", "why_thorough", "quick", "effective_quick", "why_quick",
                                    "sources", "join_sec", "strategies", "cpus", "max_concurrent"}
    monkeypatch.setenv("SOLVER_BEST_OF", "4")
    body = client.get("/ready", headers={"X-Solver-Token": "unit-test-solver-token"}).json()
    assert body["ok"] is True and (body["best_of"]["thorough"], body["best_of"]["effective_thorough"]) == (4, 4)
    assert best_of.startup_line().startswith("Best-of route search: THOROUGH 4 searches, QUICK 1 search")


def test_best_of_leaves_no_process_or_handle(parallel, monkeypatch):
    """PR #50: small solves with three searches each leave no child process, no multiprocessing object and
    no growth in open handles (an other searches' pool or pipe flag kept open would add several each)."""
    import gc
    import multiprocessing as mp

    from tests.test_dispatch import nmwc_day, req
    from tests.test_worker_lifecycle import _mp_objects, _open_handles

    monkeypatch.setenv("SOLVER_BEST_OF_QUICK", "3")
    r = req(*nmwc_day(8), scenarios=["RECOMMENDED"], time_limit_sec=1)
    ds.optimize_dispatch(r)  # warm up: imports, logging
    gc.collect()
    base_handles, base_objects = _open_handles(), len(_mp_objects())
    for i in range(3):
        resp = ds.optimize_dispatch(r)
        assert resp.search.best_of.used == 3, i
        assert mp.active_children() == [], i
    gc.collect()
    assert len(_mp_objects()) == base_objects
    if base_handles is not None:
        assert _open_handles() - base_handles <= 8


# ---------------------------------------------------------------------------------------------
# Review of 16 Oct 2026 (best-of on only; every default unchanged)
# ---------------------------------------------------------------------------------------------

def test_a_failed_search_is_logged_with_its_error(caplog):
    """A search that raised is logged with its error and the traceback - the main one's at ERROR: with one search
    it fails the solve (a 500 with its traceback), with best-of another search may replace it without a trace."""
    def run(i, kind, err=None):
        return {"variant": best_of.SearchVariant(i, i, PCI), "index": i, "kind": kind, "status": best_of.run_status(kind),
                "scenario": None, "watch": None, "error": err}

    try:
        raise ValueError("engine bug in the main search")
    except ValueError as exc:
        boom = exc
    runs = [run(0, "error", boom), run(1, "error", RuntimeError("another search failed")),
            run(2, "broken", "the worker pool was closed"), run(3, "timeout")]
    with caplog.at_level("INFO", logger="routeiq.dispatch"):
        ds._log_best_of("r1", runs, None, None, [], 4)
    by = {i: [rec for rec in caplog.records if f"search {i} of 4" in rec.getMessage()] for i in range(4)}
    assert [len(by[i]) for i in range(4)] == [1, 1, 1, 1], caplog.text
    assert by[0][0].levelname == "ERROR" and "FAILED ValueError: engine bug in the main search" in by[0][0].getMessage()
    assert by[0][0].exc_info and by[0][0].exc_info[1] is boom
    assert by[1][0].levelname == "WARNING" and "RuntimeError: another search failed" in by[1][0].getMessage()
    assert by[2][0].levelname == "WARNING" and "the worker pool was closed" in by[2][0].getMessage() and not by[2][0].exc_info
    assert by[3][0].levelname == "INFO" and by[3][0].getMessage().endswith("TIMEOUT")
    assert "Traceback" in caplog.text and "its log lines failed" not in caplog.text


def test_a_hung_main_search_gets_fresh_workers_only_with_time_left(monkeypatch):
    """Another search replaced a main search that did not answer by its backstop - THOROUGH's is the cap itself.
    With no time left for the load re-check after the slowest worker start, no fresh workers start (they only
    added their start past the cap): the alternatives are skipped and the plans kept, re-timed exactly ("out of
    time"). With time left they start as before (here none can: "short of resources")."""
    from tests.test_dispatch import nmwc_day, req
    from tests.test_pyvrp_candidate import _prepared

    r = req(*nmwc_day(10), scenarios=ALL3, time_limit_sec=1)
    tds, solvable, drops, mx = _prepared(r)
    raw, _ = ds._searched(("RECOMMENDED", r, solvable, tds, mx, 1, drops))
    assert raw.status == "OPTIMIZED"
    started: list = []
    monkeypatch.setattr(ds, "_start_workers", lambda *a, **kw: started.append(a[3]) or None)

    class _Pool:
        def close(self):
            return True

        def broken(self, settle=0.0):
            return None

    for left, want, why in ((10.0, [], "(out of time)"), (600.0, ["search"], f"({ds.NO_WORKERS_NOTE})")):
        bo = ds._BestOf(scenario=raw.model_copy(deep=True), watch=None, limit=1, warm=raw.loads or None, extra_sources=[],
                        main_stuck=True, report=None)
        monkeypatch.setattr(ds, "_recommended_best_of", lambda *a, bo=bo, **kw: bo)
        started.clear()
        out = ds._run_scenarios(list(ALL3), r, solvable, tds, mx, 1, drops, time.monotonic() + left,
                                workers=_Pool(), best_of=3, extras=_Pool())
        assert started == want, (left, started)
        assert [sc.name for sc in out] == ["RECOMMENDED"]
        rec = out[0]
        assert rec.status == "OPTIMIZED" and rec.feasibility.status == "VERIFIED", rec.feasibility
        assert any(f"Loads were not re-checked for fewer trucks {why}" in w for w in rec.warnings), rec.warnings
        assert any("Alternative plan(s) MIN_TRUCKS, MIN_DISTANCE were skipped" in w for w in rec.warnings), rec.warnings


def test_an_other_searches_pool_that_does_not_close_is_only_a_warning(monkeypatch, caplog):
    """The other searches' pool is optional: one whose Pool.terminate() does not return within POOL_CLOSE_SEC is a
    WARNING, never the administrator's WORKERS_UNAVAILABLE alert nor /ready failed (the solve's own pool still
    alerts: test_worker_start)."""
    import logging
    import multiprocessing as mp
    import threading

    monkeypatch.setattr(ds, "POOL_CLOSE_SEC", 1.0)
    caplog.set_level(logging.WARNING, logger="routeiq.dispatch")
    w = ds._Workers(1, None, run_id="r", what="other route searches", join=True)
    real_terminate = w.pool.terminate
    release = threading.Event()
    w.pool.terminate = lambda: release.wait(60) and real_terminate()
    try:
        assert w.close() is False
    finally:
        release.set()
    for t in threading.enumerate():
        if t.name == "routeiq-pool-close":
            t.join(10)
    assert not [m.getMessage() for m in caplog.records if m.levelno >= logging.ERROR]
    assert any(m.levelno == logging.WARNING and "pool for the other route searches did not stop within 1 s" in m.getMessage()
               for m in caplog.records), caplog.text
    assert ds.WORKER_HEALTH.status() == {"status": "ok"}
    assert mp.active_children() == []


def test_best_of_is_null_where_it_does_not_apply(monkeypatch):
    """SOLVER_BEST_OF_QUICK=3 on a request without RECOMMENDED has no best-of report (it said "3 asked, 1 run" with no
    reason); with RECOMMENDED the one search says why (IN_PROCESS here)."""
    from tests.test_dispatch import nmwc_day, req

    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    monkeypatch.setenv("SOLVER_BEST_OF_QUICK", "3")
    stops, trucks = nmwc_day(6)
    assert ds.optimize_dispatch(req(stops, trucks, scenarios=["MIN_TRUCKS"], time_limit_sec=1)).search.best_of is None
    b = ds.optimize_dispatch(req(stops, trucks, scenarios=["RECOMMENDED"], time_limit_sec=1)).search.best_of
    assert (b.requested, b.used, b.gate) == (3, 1, "IN_PROCESS")

