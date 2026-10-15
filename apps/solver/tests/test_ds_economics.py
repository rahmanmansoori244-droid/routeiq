"""Decision support, small-order economics (DESIGN.md section 3): exact fixed-plan removal estimates, combine and
move checks, deferral by re-optimization, future cost, margins only when given, and recommendations that keep
cash, time/capacity and ARTIFICIAL penalties apart."""
from __future__ import annotations

import json
from dataclasses import replace
from types import SimpleNamespace

import pytest

from decision_support import core, economics as E
from decision_support.economics import Baseline
from dispatch_models import DispatchRequest
from tests.test_dispatch import hm, req, stop, truck

# A town cluster near the depot, a remote 2-case stop ("far", about 38 km away), a 2-case stop right next to
# "b" ("nb"), and a 2-case stop ("x") next to "y", which the second truck serves. T2 costs more per km, so
# "far" has no cheaper place on it.
COSTS = dict(fixed_cost=20, cost_per_km=0.1, km_per_litre=4.0)
COSTS_T2 = dict(fixed_cost=20, cost_per_km=0.3, km_per_litre=4.0)


def day(**over) -> DispatchRequest:
    """The test day. p_<stop>=n sets a small stop's priority, <stop>={...} adds fields to it, more=[...] adds stops."""
    p = {"far": 4, "nb": 4, "x": 5}
    p.update({k[2:]: v for k, v in over.items() if k.startswith("p_")})
    extra = {k: v for k, v in over.items() if not k.startswith("p_")}
    stops = [
        stop("a", 23.600, 58.400, cases=20, priority=3), stop("b", 23.605, 58.405, cases=20, priority=3),
        stop("c", 23.610, 58.410, cases=20, priority=3),
        stop("nb", 23.6052, 58.4052, cases=2, priority=p["nb"], **extra.get("nb", {})),
        stop("far", 23.400, 58.700, cases=2, priority=p["far"], **extra.get("far", {})),
        stop("y", 23.620, 58.550, cases=30, priority=3),
        stop("x", 23.621, 58.551, cases=2, priority=p["x"], **extra.get("x", {})),
    ]
    stops += extra.get("more", [])
    return req(stops, [truck("T1", **COSTS), truck("T2", **COSTS_T2)], fuel_price_per_litre=0.26, driver_cost_per_hour=2.5)


PLAN = {"T1": [["a", "nb", "b", "c", "x", "far"]], "T2": [["y"]]}


def next_day_plan():
    """The next day: one truck already goes to a customer next to "far"."""
    r = req([stop("z", 23.401, 58.701, cases=30, priority=3)], [truck("N1", **COSTS)],
            fuel_price_per_litre=0.26, driver_cost_per_hour=2.5)
    return Baseline.from_plan(r, {"N1": [["z"]]})


def by_label(report, r) -> dict:
    """The report's rows by the request's own stop ids (the report has anonymous labels only)."""
    sid_of = {lab: sid for sid, lab in core.label_stops(r).items()}
    return {sid_of[e.stop]: e for e in report.stops}


def test_small_stops_are_the_stops_of_three_cases_or_fewer():
    r = day()
    assert E.small_stops(r) == ["nb", "far", "x"]
    assert E.small_stops(r, max_cases=20) == ["a", "b", "c", "nb", "far", "x"]


def test_a_far_two_case_stop_costs_real_money_and_its_penalty_stays_apart():
    r = day()
    base = Baseline.from_plan(r, PLAN)
    far = E.fixed_plan(base, "far")
    assert far is not None and far.feasibility == "VERIFIED"
    assert far.at.truck == "truck-01" and far.at.load_no == 1 and far.at.position == 6
    # Cash saved: km (distance + fuel) and the driver's paid time, no fixed cost (T1 still drives).
    assert far.cash_saved.total > 5
    assert far.cash_saved.distance > 0 and far.cash_saved.fuel > 0 and far.cash_saved.driver > 0
    assert far.cash_saved.fixed == 0
    parts = sum(getattr(far.cash_saved, p) for p in ("fixed", "trip", "distance", "fuel", "driver", "overtime"))
    assert parts == pytest.approx(far.cash_saved.total, abs=0.01)
    # Time and capacity freed: a separate column.
    assert far.freed.km > 40 and far.freed.paid_driver_min > 60 and far.freed.cases == 2
    assert far.freed.detour_drive_min > 60 and far.freed.trips == 0 and far.freed.trucks == 0
    # The solver's price of leaving it out is ARTIFICIAL (strict priority: 1,000+ OMR-equivalent), never cash.
    assert far.penalty_change["unserved_penalty"] >= 1000
    assert far.cash_saved.total < 100


def test_a_stop_next_to_another_is_combined_and_saves_little():
    r = day()
    base = Baseline.from_plan(r, PLAN)
    labels = core.label_stops(r)
    comb = E.combine_check(base, "nb", labels)
    assert comb.combined and comb.nearest == labels["b"] and comb.nearest_km < 0.1
    assert not E.combine_check(base, "far", labels).combined
    nb, far = E.fixed_plan(base, "nb"), E.fixed_plan(base, "far")
    assert 0 < nb.cash_saved.total < 1.0 < far.cash_saved.total
    assert nb.freed.km < 0.2
    report = E.analyze(r, core.Budget(time_limit_sec=1, seeds=(1,)), base=base, aggregates={})
    e = by_label(report, r)["nb"]
    assert e.action == "SERVE" and any("already rides with" in x for x in e.reasons)
    # No margin and no next-day plan: the future cost is a PROXY (today's saving reused), so no break-even is given.
    assert e.margin_omr is None and e.break_even_margin_per_case is None
    assert any("cannot be judged without a next-day plan" in x for x in e.reasons) and "BE n/a PROXY" in report.table()


def test_a_stop_on_the_wrong_load_is_combined_with_its_neighbour_on_another_truck():
    r = day()
    base = Baseline.from_plan(r, PLAN)
    labels = core.label_stops(r)
    mv = E.move_check(base, "x", labels)
    assert mv.found and mv.to.truck == "truck-02" and mv.kind == "EXISTING_LOAD"
    assert mv.near == labels["y"] and mv.near_km < 0.2 and mv.feasibility == "VERIFIED"
    assert mv.cash_delta.total < -E.CLEAR_OMR and mv.km_delta < 0
    report = E.analyze(r, core.Budget(time_limit_sec=1, seeds=(1,)), base=base, aggregates={})
    e = by_label(report, r)["x"]
    assert e.action == "COMBINE" and "truck-02" in e.reasons[0]
    # A move never goes back into the stop's own load (T1 has no other), and "far" has no cheaper place.
    far = by_label(report, r)["far"]
    assert not (far.move.found and far.move.to.truck == "truck-01" and far.move.kind == "EXISTING_LOAD")
    assert far.action == "SERVE" and (not far.move.found or far.move.cash_delta.total > 0)


def test_p1_and_late_small_stops_are_always_served():
    nd = next_day_plan()
    for kw in (dict(p_far=1), dict(p_far=2), dict(far={"late": True})):
        r = day(**kw)
        base = Baseline.from_plan(r, PLAN)
        report = E.analyze(r, core.Budget(time_limit_sec=1, seeds=(1,)), base=base, next_day=nd, aggregates={})
        e = by_label(report, r)["far"]
        assert e.action == "SERVE", kw
        assert any("always served" in x for x in e.reasons)
    r = day()
    report = E.analyze(r, core.Budget(time_limit_sec=1, seeds=(1,)), base=Baseline.from_plan(r, PLAN), next_day=nd,
                       committed={"far"}, aggregates={})
    assert by_label(report, r)["far"].action == "SERVE"


def test_defer_needs_a_clear_saving_over_future_cost_and_margin():
    r = day()
    base = Baseline.from_plan(r, PLAN)
    nd = next_day_plan()
    budget = core.Budget(time_limit_sec=1, seeds=(1,))
    report = E.analyze(r, budget, base=base, next_day=nd, aggregates={})
    e = by_label(report, r)["far"]
    # Next day a truck passes right by: the future cost is a small exact insertion (its unloading time).
    assert e.future.basis == "NEXT_DAY_PLAN" and 0 < e.future.omr < 1.0
    assert e.action == "DEFER_WITH_AGREEMENT"
    # Break-even margin per case when no margin is known: (cash saved - future cost - CLEAR_OMR) / cases.
    assert e.margin_omr is None
    assert e.break_even_margin_per_case == pytest.approx(
        (e.fixed.cash_saved.total - e.future.omr - E.CLEAR_OMR) / 2, abs=1e-3)
    # A margin above the net saving keeps it served.
    big = E.analyze(r, budget, base=base, next_day=nd, margin_per_case=e.break_even_margin_per_case + 1, aggregates={})
    assert by_label(big, r)["far"].action == "SERVE"
    small = E.analyze(r, budget, base=base, next_day=nd, margin_per_case=0.5, aggregates={})
    assert by_label(small, r)["far"].action == "DEFER_WITH_AGREEMENT"
    # Without a next-day plan the future cost is the PROXY (today's marginal cost): never clearly cheaper.
    proxy = by_label(E.analyze(r, budget, base=base, aggregates={}), r)["far"]
    assert proxy.future.basis == "PROXY" and proxy.future.omr == proxy.fixed.cash_saved.total
    assert proxy.action == "SERVE"


def test_margins_come_only_from_the_request_or_a_labelled_assumption():
    r = day(far={"margin": 1.5})
    base = Baseline.from_plan(r, PLAN)
    budget = core.Budget(time_limit_sec=1, seeds=(1,))
    rows = by_label(E.analyze(r, budget, base=base, margin_per_case=0.8, aggregates={}), r)
    assert rows["far"].margin_omr == 1.5 and rows["far"].margin_basis.startswith("DispatchStop.margin")
    assert rows["nb"].margin_omr == pytest.approx(1.6) and rows["nb"].margin_basis.startswith("ASSUMPTION: 0.8 OMR per case")
    assert rows["nb"].break_even_margin_per_case is None  # a margin is known: no break-even needed
    none = by_label(E.analyze(r, budget, base=base, next_day=next_day_plan(), aggregates={}), r)
    assert none["nb"].margin_omr is None and none["nb"].margin_basis is None
    assert none["nb"].break_even_margin_per_case is not None


def test_small_invoices_are_mapped_to_their_stops():
    r = day()
    r.stops[0].order_ids = ["o-a", "o-a2"]  # "a" has an 18-case and a 2-case invoice: one 20-case stop
    cases = {"o-a": 18, "o-a2": 2, "o-b": 20, "o-c": 20, "o-nb": 2, "o-far": 2, "o-y": 30, "o-x": 2}
    report = E.analyze(r, core.Budget(time_limit_sec=1, seeds=(1,)), base=Baseline.from_plan(r, PLAN), aggregates={},
                       invoice_cases=cases)
    assert {k: report.invoices[k] for k in ("invoices", "small_invoices", "in_small_stops", "in_larger_stops")} == {
        "invoices": 8, "small_invoices": 4, "in_small_stops": 3, "in_larger_stops": 1}
    assert E.analyze(r, core.Budget(time_limit_sec=1, seeds=(1,)), base=Baseline.from_plan(r, PLAN),
                     aggregates={}).invoices is None


def test_stops_the_plan_leaves_out_are_placed_or_flagged_never_deleted():
    never = stop("never", 23.95, 58.95, cases=1, priority=4, hard_start_min=hm("06:00"), hard_end_min=hm("06:10"))
    r = day(more=[never])
    plan = {"T1": [["a", "nb", "b", "c", "far"]], "T2": [["y"]]}  # leaves "x" out
    report = E.analyze(r, core.Budget(time_limit_sec=1, seeds=(1,)), base=Baseline.from_plan(r, plan), aggregates={})
    rows = by_label(report, r)
    assert not rows["x"].served and rows["x"].action == "MOVE" and rows["x"].move.to.truck == "truck-02"
    assert rows["never"].action == "REVIEW" and rows["never"].move is None and rows["never"].fixed is None
    assert all(e.action in E.ACTIONS for e in report.stops)


def test_results_are_deterministic_and_anonymous():
    r = day()
    budget = core.Budget(time_limit_sec=1, seeds=(1,))
    one = E.analyze(r, budget, base=Baseline.from_plan(r, PLAN), next_day=next_day_plan())
    two = E.analyze(r, budget, base=Baseline.from_plan(r, PLAN), next_day=next_day_plan())
    text = json.dumps(one.to_dict(), sort_keys=True, default=str)
    assert text == json.dumps(two.to_dict(), sort_keys=True, default=str)
    table = one.table()
    assert table == two.table() and "ARTIF" in table and "stop-0" in table
    for raw in ('"far"', '"nb"', '"x"', '"T1"', '"T2"', '"lat"', '"lng"'):
        assert raw not in text
    for raw in (" far ", " nb ", " T1 ", " T2 "):
        assert raw not in table


def test_ivms_evidence_is_attached_as_context():
    agg = {
        "evidence_2026_10_12": {
            "visit_frequency": {"all": {"customers": 9, "days_between_deliveries": {"p25": 3, "p50": 5, "p75": 7}},
                                "by_segment": {"GT_RETAIL": {"customers": 4,
                                                             "days_between_deliveries": {"p25": 6, "p50": 10, "p75": 10}}}},
            "chain_unloading": {"by_drop_size": [
                {"cases": "<50", "n_visits": 30, "p25_min": 8.0, "p50_min": 12.0, "p75_min": 14.0},
                {"cases": "<50", "n_visits": 10, "p25_min": 20.0, "p50_min": 30.0, "p75_min": 45.0},
                {"cases": "<50", "n_visits": 2, "p25_min": 90.0, "p50_min": 99.0, "p75_min": 99.0},  # too thin
                {"cases": "50-149", "n_visits": 40, "p25_min": 30.0, "p50_min": 40.0, "p75_min": 50.0}]}},
        "ivms_raw": {"travel_speed_kmh": {"by_band_5km_plus": {
            b: {"p25": 40.0, "p50": 55.0, "p75": 70.0, "n": 100} for b, _, _ in E.ivms.BANDS}}},
    }
    r = day()
    base = Baseline.from_plan(r, PLAN)
    report = E.analyze(r, core.Budget(time_limit_sec=1, seeds=(1,)), base=base, aggregates=agg,
                       customer_type={"far": "GROCERY"})
    rows = by_label(report, r)
    ev = rows["far"].evidence
    assert ev.segment == "GT_RETAIL" and ev.visit_every_days["p50"] == 10
    table = report.table()
    assert "segment GT_RETAIL customers get a delivery every 10 days" in table and "IVMS p50 speed 55 km/h" in table
    assert ev.small_drop_on_site_min == {"p25": 8.0, "p50": 12.0, "p75": 14.0, "chains": 2, "visits": 40}
    d = ev.detour_drive_min_at_ivms
    assert d["fast_p75"] < d["at_p50"] < d["slow_p25"]
    assert d["at_p50"] == pytest.approx(rows["far"].fixed.freed.km / 55.0 * 60, abs=0.1)
    assert rows["nb"].evidence.segment == "all" and rows["nb"].evidence.visit_every_days["p50"] == 5
    # The ride-along future cost is a labelled assumption: unloading minutes only.
    assert rows["far"].future.ride_along_omr == pytest.approx(2 * E.SERVICE_PER_CASE / 60 * 2.5, abs=1e-3)
    assert E.analyze(r, core.Budget(time_limit_sec=1, seeds=(1,)), base=base, aggregates={}).stops[0].evidence is None
    committed = E.default_aggregates()
    if committed is not None:  # the committed IVMS aggregates give a sane small-drop profile
        on_site = E.small_drop_on_site(committed)
        assert on_site["p25"] <= on_site["p50"] <= on_site["p75"] and on_site["visits"] >= 10
        assert E.visit_frequency(committed, "all")["p50"] > 0


def test_defer_reoptimizes_without_the_stop_with_equal_budget(monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    r = day()
    budget = core.Budget(time_limit_sec=1, seeds=(1, 2))
    report = E.analyze(r, budget, reoptimize=1, aggregates={})
    assert report.reference_seed in (1, 2) and report.baseline["runs"] == 2
    rows = by_label(report, r)
    done = [e for e in report.stops if e.defer is not None]
    assert len(done) == 1 and done[0] is rows["far"]  # the costliest small stop first
    d = rows["far"].defer
    assert d.seeds == [1, 2] and d.paired
    assert d.avoidable_cash["min"] > 5 and d.avoidable_cash["min"] <= d.avoidable_cash["mean"] <= d.avoidable_cash["max"]
    assert d.freed["km"]["mean"] > 40 and d.feasibility == {"VERIFIED": 2}
    assert d.knock_on["dropped_elsewhere"]["max"] == 0 and d.knock_on["stops"] == []
    assert d.like_for_like_seeds == [1, 2] and d.avoidable_cash_like_for_like["mean"] == pytest.approx(
        d.avoidable_cash["mean"], abs=0.01)
    assert set(d.penalty_change) == {"unserved_penalty", "window", "early", "continuity"}
    assert d.noise_omr is not None and d.note
    assert rows["far"].future.basis == "PROXY" and rows["far"].break_even_margin_per_case is None
    assert "re-opt per seed: seed 1 saves" in report.table()


def test_a_reoptimization_counts_only_where_the_other_stops_are_served_alike():
    def run(seed, served, cash, mins=100, km=10.0):
        sc = SimpleNamespace(name="RECOMMENDED", loads=[SimpleNamespace(stops=[SimpleNamespace(stop_id=s) for s in served])])
        m = SimpleNamespace(cash=SimpleNamespace(total=cash), paid_driver_min=mins, km=km, trucks_used=2, trips=3)
        return SimpleNamespace(seed=seed, response=SimpleNamespace(scenarios=[sc]), metrics=m)

    labels = {"a": "stop-001", "b": "stop-002", "k": "stop-003"}
    base = [run(1, ["a", "b", "k"], 100.0), run(2, ["a", "b", "k"], 104.0), run(4, ["a", "b"], 90.0)]
    without = [run(1, ["a", "b"], 99.0, mins=90, km=8.0), run(2, ["a"], 60.0), run(3, ["a", "b"], 1.0),
               run(4, ["a", "b"], 90.0)]
    rows, changed = E.per_seed(base, without, "k", labels)
    assert [x["seed"] for x in rows] == [1, 2, 4]  # seed 3 has no baseline run to pair with
    # Seed 4's baseline did not serve the stop: its "saving" of 0 is not the cost of serving it.
    assert [x["like_for_like"] for x in rows] == [True, False, False] and not rows[2]["served_in_baseline"]
    assert (rows[0]["cash_saved"], rows[0]["paid_driver_min"], rows[0]["km"]) == (1.0, 10, 2.0)
    # Seed 2 "saves" 44 OMR only because it left another stop out: reported, never used for a decision.
    assert rows[1]["cash_saved"] == 44.0 and rows[1]["dropped"] == 1 and changed == {"stop-002"}
    # A re-optimized saving decides only from two like-for-like seeds that beat the exact fixed-plan estimate
    # by more than the search noise (the spread of cash over the seeds).
    one, two = [{"cash_saved": 9.0}], [{"cash_saved": 9.0}, {"cash_saved": 12.0}]
    assert not E._use(one, 0.5, 1.0)[0] and "too few" in E._use(one, 0.5, 1.0)[1]
    assert E._use(two, 0.5, 1.0)[0]
    used, note = E._use(two, 20.0, 1.0)
    assert not used and "within search noise" in note
    assert not E._use(two, None, 1.0)[0]
    fixed = SimpleNamespace(cash_saved=SimpleNamespace(total=0.5))
    assert E._saving(fixed, SimpleNamespace(used=False)) == (0.5, 0.5, "fixed plan")
    like = {"mean": 10.5, "min": 9.0, "max": 12.0, "values": [9.0, 12.0]}
    assert E._saving(fixed, SimpleNamespace(used=True, avoidable_cash_like_for_like=like))[:2] == (10.5, 9.0)


def test_the_break_even_margin_is_the_one_the_recommendation_uses(monkeypatch):
    """When the re-optimization decides, the rule uses its least saving: the stated break-even is that margin."""
    r = day()
    base, nd = Baseline.from_plan(r, PLAN), next_day_plan()
    budget = core.Budget(time_limit_sec=1, seeds=(1, 2))
    plain = by_label(E.analyze(r, budget, base=base, next_day=nd, aggregates={}), r)["nb"]
    fixed, future = plain.fixed.cash_saved.total, plain.future.omr
    lo, hi = future + 1.0, future + 4.0  # every like-for-like seed beats the fixed plan by more than the noise
    like = {"mean": round((lo + hi) / 2, 4), "min": lo, "max": hi, "values": [lo, hi]}
    used, note = E._use([{"cash_saved": lo}, {"cash_saved": hi}], 0.15, fixed)
    assert used
    fake = E.Deferral(seeds=[1, 2], paired=True, avoidable_cash=like, avoidable_cash_like_for_like=like,
                      like_for_like_seeds=[1, 2], noise_omr=0.15, used=True, note=note, per_seed=[], cash_parts={},
                      freed={}, knock_on={}, penalty_change={}, feasibility={"VERIFIED": 2}, wall_sec=0.0)
    monkeypatch.setattr(E, "defer", lambda *a, **k: fake)

    def row(**kw):
        return by_label(E.analyze(r, budget, base=base, next_day=nd, reoptimize=["nb"], base_runs=[], aggregates={},
                                  **kw), r)["nb"]

    be = row().break_even_margin_per_case
    assert be == pytest.approx((lo - future - E.CLEAR_OMR) / 2, abs=1e-3) and be > 0
    assert row(margin_per_case=be - 0.01).action == "DEFER_WITH_AGREEMENT"
    above = row(margin_per_case=be + 0.01)
    assert above.action == "SERVE" and any(f"at least {lo:.2f}" in x for x in above.reasons)


def test_a_baseline_with_the_engines_own_times_is_compared_like_with_like():
    """A baseline that could not be timed exactly keeps the engine's times; its removal and move figures time the
    changed trucks exactly on both sides, so a slack in the engine's times is not booked as the stop's saving."""
    r = day()
    good = Baseline.from_plan(r, PLAN)
    t1 = good.ctx.truck_idx["T1"]
    early = dict(good.timed)
    early[t1] = [replace(tl, depart_s=tl.depart_s - 1800) for tl in good.timed[t1]]  # leaves 30 min too early
    raw = Baseline.of(good.ctx, early, retimed=False)
    assert raw.metrics.cash.total > good.metrics.cash.total
    labels = core.label_stops(r)
    for sid in ("nb", "far"):
        assert E.fixed_plan(raw, sid).cash_saved.total == pytest.approx(E.fixed_plan(good, sid).cash_saved.total, abs=1e-3)
        assert E.fixed_plan(raw, sid).freed.paid_driver_min == E.fixed_plan(good, sid).freed.paid_driver_min
    assert E.move_check(raw, "x", labels).cash_delta.total == pytest.approx(
        E.move_check(good, "x", labels).cash_delta.total, abs=1e-3)
    report = E.analyze(r, core.Budget(time_limit_sec=1, seeds=(1,)), base=raw, aggregates={})
    assert not report.baseline_retimed and "kept the engine's own times" in report.table()
