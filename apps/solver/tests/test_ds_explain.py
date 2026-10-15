"""Decision support, explanations (DESIGN.md section 5): verdicts that tell proofs from search failures and from the
14 Oct 2026 model-error signature, per-stop conflicts, relaxations re-solved on equal budgets and ranked, and the
trade-off frontier."""
from __future__ import annotations

import pytest

import dispatch_solver as ds
from decision_support import core
from decision_support import explain as X
from decision_support.core import Budget
from decision_support.synth import CUSTOMER_HARD, SALES_PREFERENCE, UNKNOWN
from dispatch_models import UnservedStop
from tests.test_dispatch import hm, req, stop, truck


def proof_day():
    """Two one-load trucks of 400 cases leaving at 06:00: a normal stop, one of 600 cases (larger than every
    truck) and one about 91 estimated km out whose receiving hours end at 06:30."""
    stops = [stop("near", 23.60, 58.42, cases=20, priority=2),
             stop("big", 23.61, 58.43, cases=600, priority=1),
             stop("far", 23.95, 58.95, cases=10, priority=2, hard_start_min=hm("06:00"), hard_end_min=hm("06:30"))]
    trucks = [truck("T1", cap=400, fixed_cost=20, cost_per_km=0.1), truck("T2", cap=400, fixed_cost=20, cost_per_km=0.1)]
    return req(stops, trucks, max_trips_per_truck=1, time_limit_sec=1)


def tight_day(**cfg):
    """One truck, one load, leaving at 07:00. A (P2, closes 08:00) is 29 min east and B (P3, closes 08:22) 29 min
    west, 58 min apart. Each can be served on its own, not both: after A (20 min unloading) the truck reaches B at
    about 08:48, 26 min after its close. Nothing proves B impossible; its window + 30 min lets one truck serve both."""
    stops = [stop("A", 23.585, 58.537, cases=10, priority=2, service_min=20, hard_start_min=hm("07:00"), hard_end_min=hm("08:00")),
             stop("B", 23.585, 58.243, cases=10, priority=3, service_min=20, hard_start_min=hm("07:00"), hard_end_min=hm("08:22"))]
    cfg.setdefault("time_limit_sec", 1)
    return req(stops, [truck("T1", cap=500, fixed_cost=20, cost_per_km=0.1)], shift_start_min=hm("07:00"),
               max_trips_per_truck=1, driver_cost_per_hour=2.5, **cfg)


HIRE = truck("H1", cap=500, fixed_cost=40, hire_candidate=True)
CTX = X.Context(window_provenance={"A": CUSTOMER_HARD, "B": SALES_PREFERENCE}, hire_options=(HIRE,))


@pytest.fixture(scope="module")
def tight_run():
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("SOLVER_PARALLEL", "0")
        mp.setenv("SOLVER_PYVRP", "off")
        run = core.solve(tight_day(), Budget(time_limit_sec=1, seeds=(1,)), 1)
    return run


def test_a_stop_larger_than_every_truck_and_one_out_of_reach_are_proven(monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    run = core.solve(proof_day(), Budget(time_limit_sec=1, seeds=(1,)), 1)
    v = X.verdict(run.request, run.response)
    assert (v.verdict, v.stops_served, v.counts()) == (X.PROVEN_INFEASIBLE, 1, {X.PROVEN_INFEASIBLE: 2})
    by = {s.stop_id: s for s in v.stops}
    # Both proofs are about the stop itself, and our own one-stop check agrees with the engine's.
    assert (by["big"].proof, by["big"].kind, by["big"].scope, by["big"].confirmed) == ("EXCEEDS_ANY_TRUCK_CAPACITY", "PREFILTER", "STOP", True)
    assert (by["far"].proof, by["far"].kind, by["far"].scope, by["far"].confirmed) == ("HARD_WINDOW_INFEASIBLE", "WINDOW", "STOP", True)
    conf = X.conflicts(run.request, run.response)
    assert list(conf) == ["big", "far"]  # label order: stop-001, stop-002
    big, far = conf["big"], conf["far"]
    assert (big.blocking, big.size_fits, big.size) == (["SIZE"], False, "600 cases vs largest 400")
    # The window proof with its numbers: the earliest arrival the engine names, 107 min after the close.
    assert (far.blocking, far.window, far.window_short_min, far.earliest_arrival) == (["WINDOW"], "06:00-06:30", 107, "08:16")
    msg = next(u.reason_message for u in run.response.scenarios[0].unserved if u.stop_id == "far")
    assert f"earliest possible arrival {far.earliest_arrival}" in msg
    # The IVMS truck speeds: even at the p90 moving speed of the 06-09 band it is still late, so the proof does not
    # rest on the 40 km/h estimate.
    assert far.ivms["band"] == "06-09" and far.ivms["robust"] is True
    assert 0 < far.ivms["p90"]["short_min"] < far.ivms["p50"]["short_min"] < far.window_short_min
    assert "ruled out on its own by WINDOW" in far.text() and "still" in far.text()


def test_a_tight_day_drops_one_stop_without_proof_and_its_preference_window_plus_30_serves_it(monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    r = tight_day()
    budget = Budget(time_limit_sec=1, seeds=(1, 2))
    base = core.solve_seeds(r, budget)
    for run in base:
        v = X.verdict(run.request, run.response)
        assert (v.verdict, v.stops_served) == (X.SEARCH_FAILURE, 1)
        (b,) = v.stops
        assert (b.label, b.verdict, b.kind, b.proof, b.confirmed, b.lower_served) == ("stop-002", X.SEARCH_FAILURE, "SEARCH", None, None, 0)
        assert X.UNPROVEN_NOTE in b.note
    # B can be served on its own; the load that passes 39 km away has room and time but would reach it too late.
    c = X.conflicts(base[0].request, base[0].response, ctx=CTX, near_km=50)["B"]
    assert c.servable_alone and (c.window_short_min, c.shift_short_min, c.provenance) == (0, 0, SALES_PREFERENCE)
    (n,) = c.nearby
    assert (n.truck_id, n.load_no, n.near_stop, n.fits, n.window_ok) == ("T1", 1, "stop-001", True, False)
    assert 35 < n.km < 45 and n.time_left_min > 500 and 75 <= n.detour_min <= 82

    cands = X.candidates_for(r, [x.response for x in base], CTX, shift_min=None, unloading=False)
    labels = core.label_stops(r)
    assert [x.label(labels) for x in cands] == [f"stop-002 window +{m} min (SALES_PREFERENCE)" for m in (10, 20, 30)] + [
        "T1 +1 load", "hire 1 truck (500 cases, hire 40.00 OMR/day)"]
    ranking = X.rank_relaxations(r, cands, budget, CTX, base=base)
    top, hire = ranking.rows[0], ranking.rows[1]
    assert (top.label, top.tier, top.gained, top.lost) == ("stop-002 window +30 min (SALES_PREFERENCE)", "ACTIONABLE", ["stop-002"], [])
    assert top.stops_gained == {"mean": 1.0, "min": 1.0, "max": 1.0} and top.gains_every_seed and top.feasibility == {"VERIFIED": 2}
    assert top.sentence.startswith("Extending stop-002's window by 30 minutes changes cash cost by +")
    assert top.sentence.endswith(" over 2 seeds) and allows 1 more delivery (stop-002).")
    assert 20 <= top.late_min_delta["mean"] <= 30  # B is served about 26 min after its original close
    # The hire also serves B (on time), for its 40 OMR hire; the other levers gain nothing.
    assert hire.kind == "HIRE" and hire.gained == ["stop-002"] and hire.cash_delta["mean"] > top.cash_delta["mean"] + 30
    assert [x.stops_gained["mean"] for x in ranking.rows[2:]] == [0.0, 0.0, 0.0]

    # The frontier from the runs already solved, plus the engine's other two options.
    fr = X.frontier(r, X.scenario_configs() + ranking.configs(), budget, CTX, known=ranking.known())
    pts = {p.label: p for p in fr.points}
    assert set(pts) == {"RECOMMENDED", "MIN_TRUCKS", "MIN_DISTANCE", top.label, hire.label}
    assert {top.label, hire.label} <= {p.label for p in fr.non_dominated}  # a real trade-off: late and cheap, or hired
    assert (pts[top.label].served["mean"], pts[hire.label].served["mean"], pts["RECOMMENDED"].served["mean"]) == (2, 2, 1)
    assert pts[hire.label].late_min["mean"] == 0 < pts[top.label].late_min["mean"]
    md = ranking.to_markdown() + fr.to_markdown()
    assert "ARTIFICIAL" in md and "stop-002 window +30 min" in md and "not proven optimal" in md


def test_frontier_keeps_only_non_dominated_points():
    def point(label, cash, served, late, flags=()):
        return X.FrontierPoint(label=label, scenario="RECOMMENDED", flags=list(flags), cash={"mean": cash, "min": cash, "max": cash},
                               served={"mean": served}, late_min={"mean": late}, trucks={"mean": 1}, km={"mean": 1.0},
                               feasibility={})

    pts = [point("base", 100, 10, 0), point("cheap", 90, 10, 0), point("more", 120, 12, 30), point("worse", 125, 12, 40),
           point("late", 95, 9, 5), point("twin", 90, 10, 0), point("ontime", 140, 12, 0)]
    assert [p.label for p in X.mark_dominated(pts)] == ["cheap", "more", "twin", "ontime"]
    assert {p.label: p.dominated_by for p in pts if p.dominated_by} == {"base": "cheap", "worse": "more", "late": "cheap"}
    # A lever that needs evidence or an agreement never beats an option usable today (the plan stays on the
    # frontier); an option usable today can beat it.
    pts = [point("RECOMMENDED", 100, 10, 0), point("faster", 99, 11, 0, ["REQUIRES_EVIDENCE"]),
           point("dear", 120, 10, 0, ["HYPOTHETICAL"]), point("both", 98, 12, 0, ["HYPOTHETICAL", "REQUIRES_EVIDENCE"])]
    X.mark_dominated(pts)
    assert {p.label: p.dominated_by for p in pts} == {"RECOMMENDED": None, "faster": None, "dear": "RECOMMENDED",
                                                      "both": None}
    md = X.Frontier(budget=Budget(time_limit_sec=1, seeds=(1,)), points=pts).to_markdown()
    today, apart = md.split("shown apart")
    assert "| RECOMMENDED | - |" in today and "| yes |" in today and "faster" not in today and "| faster |" in apart


def no_plan(run, status: str, sec: float, ids: list[str], limit: int | None = None):
    """``run``'s response turned into a search that returned no plan: every stop INFEASIBLE, as the engine says it."""
    sc = run.response.scenarios[0].model_copy(update={
        "status": "NO_SOLUTION", "solver_status": status, "solver_time_sec": sec, "loads": [],
        "time_limit_sec": limit or run.response.scenarios[0].time_limit_sec,
        "unserved": [UnservedStop(stop_id=i, order_ids=[f"o-{i}"], reason_code="INFEASIBLE",
                                  reason_message=ds._no_plan_message(status)) for i in ids]})
    return run.response.model_copy(update={"scenarios": [sc]})


def test_no_plan_within_a_second_while_every_stop_is_servable_is_a_suspected_model_error(tight_run):
    r = tight_run.request
    v = X.verdict(r, no_plan(tight_run, "ROUTING_FAIL", 0.1, ["A", "B"]))
    assert (v.verdict, v.counts()) == (X.MODEL_ERROR_SUSPECTED, {X.MODEL_ERROR_SUSPECTED: 2}) and "PR #71" in v.note
    assert X.verdict(r, no_plan(tight_run, "ROUTING_INFEASIBLE", 4.0, ["A", "B"])).verdict == X.MODEL_ERROR_SUSPECTED
    # A search that ran out of time, or failed slowly, is a search failure, not a model error.
    for status, sec in (("ROUTING_FAIL_TIMEOUT", 0.5), ("ROUTING_FAIL", 3.0)):
        t = X.verdict(r, no_plan(tight_run, status, sec, ["A", "B"]))
        assert t.verdict == X.SEARCH_FAILURE and t.counts() == {X.SEARCH_FAILURE: 2} and X.UNPROVEN_NOTE in t.note
    # When a stop cannot be served on its own, a fast failure is not the signature either.
    shut = r.model_copy(deep=True)
    shut.stops = [s.model_copy(update={"hard_end_min": hm("07:10")}) if s.stop_id == "B" else s for s in shut.stops]
    assert X.verdict(shut, no_plan(tight_run, "ROUTING_FAIL", 0.1, ["A", "B"])).verdict == X.SEARCH_FAILURE
    # On a 30 s search, 1.5 s (model building on a large, busy day included) is still well before the limit.
    assert X.verdict(r, no_plan(tight_run, "ROUTING_FAIL", 1.5, ["A", "B"], limit=30)).verdict == X.MODEL_ERROR_SUSPECTED
    assert X.verdict(r, no_plan(tight_run, "ROUTING_FAIL", 3.5, ["A", "B"], limit=30)).verdict == X.SEARCH_FAILURE


def test_a_run_the_second_search_rescued_from_no_plan_still_shows_the_signature(tight_run):
    r, resp = tight_run.request, tight_run.response
    sc = resp.scenarios[0].model_copy(update={"solver_status": X.RESCUED})
    rescued = resp.model_copy(update={"scenarios": [sc], "search": resp.search.model_copy(update={"search_sec": 0.0})})
    v = X.verdict(r, rescued)
    assert v.verdict == X.MODEL_ERROR_SUSPECTED and "second search" in v.note and "usable" in v.note
    # A main search that used its whole time and found nothing: no signature, the stops' own verdict.
    slow = rescued.model_copy(update={"search": resp.search.model_copy(update={"search_sec": float(resp.search.limit_sec)})})
    v = X.verdict(r, slow)
    assert v.verdict == X.SEARCH_FAILURE and "second search found this one" in v.note


def test_a_stop_left_out_while_lower_priorities_ride_says_so(tight_run):
    # The same plan read with A as P4 and B as P2: B is left out while a lower priority is served.
    r = tight_run.request.model_copy(deep=True)
    r.stops = [s.model_copy(update={"priority": 4 if s.stop_id == "A" else 2}) for s in r.stops]
    (b,) = X.verdict(r, tight_run.response).stops
    assert (b.priority, b.lower_served, b.verdict) == (2, 1, X.SEARCH_FAILURE)
    assert b.note.endswith("; 1 lower-priority stop(s) are served")
    # Left out for a fleet shortage: a shortage proves only that some stop stays out, not that this P2 must while
    # a P4 rides, so it is not a proof and the run is not PROVEN_INFEASIBLE.
    sc = tight_run.response.scenarios[0]
    short = tight_run.response.model_copy(update={"scenarios": [sc.model_copy(update={"unserved": [
        u.model_copy(update={"reason_code": "SOLVER_DROPPED_LOW_PRIORITY",
                             "reason_message": "Fleet capacity shortage: 20 cases requested"}) for u in sc.unserved]})]})
    v = X.verdict(r, short)
    (b,) = v.stops
    assert (v.verdict, b.verdict, b.kind, b.proof) == (X.SEARCH_FAILURE, X.SEARCH_FAILURE, "FLEET_SHORTAGE", None)
    assert b.note.endswith("; 1 lower-priority stop(s) are served")
    # With no lower priority riding (B is P3, A P2 as planned), the shortage stays a proof for the day.
    v = X.verdict(tight_run.request, short)
    assert (v.verdict, v.stops[0].proof, v.stops[0].scope) == (X.PROVEN_INFEASIBLE, "FLEET_SHORTAGE", "DAY")


def test_relaxation_sentences_use_the_design_wording():
    s = X.relaxation_sentence("Extending stop-017's window by 10 minutes", {"mean": 0.84, "min": 0.61, "max": 1.02}, 3,
                              {"mean": 2.0, "min": 2.0, "max": 2.0}, ["stop-031", "stop-044"], [])
    assert s == ("Extending stop-017's window by 10 minutes changes cash cost by +0.84 OMR (range +0.61..+1.02 over "
                 "3 seeds) and allows 2 more deliveries (stop-031, stop-044).")
    h = X.relaxation_sentence("Extending the shift and the latest return by 30 minutes", {"mean": -0.001, "min": -0.5, "max": 0.0},
                              1, {"mean": 0.0, "min": 0.0, "max": 0.0}, [], [], "HYPOTHETICAL")
    assert h == ("[HYPOTHETICAL] Extending the shift and the latest return by 30 minutes changes cash cost by +0.00 OMR "
                 "(range -0.50..+0.00 over 1 seed) and allows no more deliveries.")
    # Seeds that disagree, or stops lost as others are gained: the average, and both lists by name.
    m = X.relaxation_sentence("Allowing T1 one more load", {"mean": 1.0, "min": 0.0, "max": 2.0}, 2,
                              {"mean": 0.5, "min": 0.0, "max": 1.0}, ["stop-002"], ["stop-009"])
    assert m.endswith("and changes deliveries by +0.5 on average (range +0..+1) (newly served: stop-002; no longer "
                      "served: stop-009).")
    swap = X.relaxation_sentence("Hiring one more truck", {"mean": 9.0, "min": 9.0, "max": 9.0}, 1,
                                 {"mean": 1.0, "min": 1.0, "max": 1.0}, ["stop-002", "stop-003"], ["stop-009"])
    assert swap.endswith("and changes deliveries by +1 (newly served: stop-002, stop-003; no longer served: stop-009).")


def test_levers_never_relax_genuine_limits():
    r = tight_day(latest_return_min=hm("18:00"), break_min=45)
    labels = core.label_stops(r)
    ctx = X.Context(window_provenance={"A": CUSTOMER_HARD, "B": UNKNOWN}, genuine_hours={"B": (hm("07:00"), hm("08:40"))})
    with pytest.raises(ValueError, match="genuine closing time"):
        X.WindowFlex("A", 10).apply(r, ctx)
    with pytest.raises(ValueError, match="HYPOTHETICAL"):
        X.WindowFlex("B", 10).apply(r, ctx)
    hyp = X.WindowFlex("B", 10, hypothetical=True)
    assert hyp.apply(r, ctx).stops[1].hard_end_min == hm("08:32") and r.stops[1].hard_end_min == hm("08:22")
    assert X._tier(hyp) == "HYPOTHETICAL" and "HYPOTHETICAL" in hyp.label(labels) and "12 of 27" in hyp.basis(ctx)
    with pytest.raises(ValueError, match="genuine hours"):
        X.WindowFlex("B", 20, hypothetical=True).apply(r, ctx)  # 08:42 is past its genuine 08:40
    # Only SALES_PREFERENCE flexes today: any other label (here one that is not among the three) counts as UNKNOWN.
    odd = X.Context(window_provenance={"A": CUSTOMER_HARD, "B": "PREFERENCE"})
    with pytest.raises(ValueError, match="HYPOTHETICAL"):
        X.WindowFlex("B", 10).apply(r, odd)
    assert X.WindowFlex("B", 10, hypothetical=True).apply(r, odd).stops[1].hard_end_min == hm("08:32")
    with pytest.raises(ValueError, match="hire option"):
        X.HireTruck(truck("own", cap=500)).apply(r, ctx)  # never an invented truck
    hired = X.HireTruck(HIRE).apply(r, ctx)
    assert [(t.id, t.hire_candidate, t.fixed_cost) for t in hired.trucks] == [("T1", False, 20), ("hire-1", True, 40)]
    assert X.ExtraTrip("T1").apply(r, ctx).trucks[0].max_trips == 2
    longer = X.ShiftExtend(30).apply(r, ctx)
    assert (longer.config.shift_max_min, longer.config.latest_return_min) == (r.config.shift_max_min + 30, hm("18:30"))
    assert longer.config.break_min == 45 and longer.stops == r.stops and longer.trucks == r.trucks
    assert X._tier(X.ShiftExtend()) == "HYPOTHETICAL" and "driver agreement" in X.ShiftExtend().basis(ctx)
    # Faster unloading: the IVMS evidence gap (best-quartile visits vs the median), on the per-case part only.
    assert X.unloading_gap(ctx.aggregates) == (0.39, 422)
    fast = X.FasterUnloading(0.39, 0.25, 422)
    assert [s.service_min for s in fast.apply(r, ctx).stops] == [19, 19]  # 39% of 10 x 0.25 min = 1 min
    assert X._tier(fast) == "REQUIRES_EVIDENCE" and "422 visits" in fast.basis(ctx)


def test_candidates_follow_window_provenance_and_explanations_are_deterministic(tight_run):
    r, resp = tight_run.request, tight_run.response
    labels = core.label_stops(r)

    def windows(ctx):
        return [x.label(labels) for x in X.candidates_for(r, resp, ctx, shift_min=None, unloading=False) if x.kind == "WINDOW"]

    assert windows(X.Context(window_provenance={"B": CUSTOMER_HARD})) == []
    assert windows(X.Context(window_provenance={"B": UNKNOWN})) == []
    assert windows(X.Context(window_provenance={"B": "sales_preference"})) == []  # not the label: not flexed today
    assert windows(X.Context(hypothetical=True)) == [f"stop-002 window +{m} min (UNKNOWN, HYPOTHETICAL)" for m in (10, 20, 30)]
    assert windows(X.Context(window_provenance={"B": SALES_PREFERENCE}, genuine_hours={"B": (hm("07:00"), hm("08:40"))})) == [
        "stop-002 window +10 min (SALES_PREFERENCE)"]
    assert [x.kind for x in X.candidates_for(r, resp, CTX)] == ["WINDOW"] * 3 + ["TRIP", "HIRE", "SHIFT", "UNLOADING"]
    # The same answers twice, and for the same day with its stops in another order.
    shuffled = core.seeded(r, 7)
    assert X.verdict(r, resp) == X.verdict(r, resp) == X.verdict(shuffled, resp)
    assert X.conflicts(r, resp, ctx=CTX) == X.conflicts(shuffled, resp, ctx=CTX)
    assert X.candidates_for(r, resp, CTX) == X.candidates_for(shuffled, resp, CTX)


def test_ranking_puts_usable_levers_first_then_gains_then_cash():
    def row(label, tier, gained, cash, verified=True):
        return X.RelaxationResult(
            relaxation=None, label=label, phrase=label, kind="WINDOW", tier=tier, basis="", seeds=[1, 2],  # type: ignore[arg-type]
            stops_gained={"mean": gained, "min": gained, "max": gained}, cases_gained={"mean": 10 * gained},
            cash_delta={"mean": cash, "min": cash, "max": cash}, late_min_delta={"mean": 0}, gained=[], lost=[],
            feasibility={"VERIFIED": 2} if verified else {"VERIFIED": 1, "VIOLATED": 1}, wall_sec=0.0)

    rows = [row("evidence", "REQUIRES_EVIDENCE", 3, -5.0), row("hyp", "HYPOTHETICAL", 2, 0.0), row("b", "ACTIONABLE", 1, 2.0),
            row("a", "ACTIONABLE", 1, 2.0), row("cheap", "ACTIONABLE", 1, 1.0), row("more", "ACTIONABLE", 2, 9.0),
            row("unchecked", "ACTIONABLE", 3, 0.0, verified=False)]
    assert [x.label for x in sorted(rows, key=X._rank_key)] == ["more", "cheap", "a", "b", "unchecked", "hyp", "evidence"]
