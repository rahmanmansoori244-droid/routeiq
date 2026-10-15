"""Decision support, what-if levers (DESIGN.md section 2): only SALES_PREFERENCE windows flex (UNKNOWN only in a
HYPOTHETICAL variant, CUSTOMER_HARD never), Afternoon / Night with their second driver and IVMS speed check, the
evidence levers kept apart, the variants, and the report."""
from __future__ import annotations

import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from decision_support import core, history, ivms, synth, whatif
from decision_support.synth import CUSTOMER_HARD, SALES_PREFERENCE, UNKNOWN
from decision_support.whatif import (Afternoon, FasterReload, FasterUnloading, Flex, GuardError, Night, PrefFlex,
                                     SpeedFactors, WhatIfContext, WidenPreference)
from tests.test_dispatch import hm, req, stop, truck

REAL = Path.home() / "ds-data" / "day-2026-10-15-v1-request.json"
PROV = {"pref": SALES_PREFERENCE, "unk": UNKNOWN, "hard": CUSTOMER_HARD, "allday": CUSTOMER_HARD, "late": CUSTOMER_HARD}


def windows_day(**cfg):
    """One stop per kind of window; the normal shift ends at 19:00 (07:30 + 11.5 h, latest return 19:00). T2 is
    available until 15:00 only, H1 is a truck the company could rent."""
    cfg = {"shift_start_min": hm("07:30"), "shift_max_min": 690, "latest_return_min": hm("19:00"), "break_min": 60,
           "break_start_from_min": hm("14:00"), "break_start_to_min": hm("15:00"), **cfg}
    stops = [
        stop("pref", 23.60, 58.40, hard_start_min=hm("08:00"), hard_end_min=hm("12:00"),
             pref_start_min=hm("08:00"), pref_end_min=hm("10:00")),
        stop("unk", 23.61, 58.41, hard_start_min=hm("08:00"), hard_end_min=hm("11:00")),
        stop("hard", 23.62, 58.42, hard_start_min=hm("07:00"), hard_end_min=hm("11:00")),
        stop("allday", 23.63, 58.43, hard_start_min=hm("07:00"), hard_end_min=hm("21:00")),
        stop("open", 23.64, 58.44),
        stop("late", 23.65, 58.45, hard_start_min=hm("19:30"), hard_end_min=hm("22:00")),
    ]
    trucks = [truck("T1"), truck("T2", available_to_min=hm("15:00")), truck("T3", available_to_min=hm("20:00")),
              truck("H1", hire_candidate=True, fixed_cost=50)]
    return req(stops, trucks, **cfg)


def ctx_for(provenance, *, afternoon=(), night=(), genuine=None, speed=None, cost=10.0) -> WhatIfContext:
    return WhatIfContext(window_provenance=dict(provenance), accepts_afternoon={s: True for s in afternoon},
                         accepts_night={s: True for s in night}, genuine_hours=dict(genuine or {}), per_case_min=0.25,
                         base_min_by_stop={}, night_driver_cost=cost, speed=speed)


def windows(r) -> dict[str, tuple]:
    return {s.stop_id: (s.hard_start_min, s.hard_end_min) for s in r.stops}


def test_flex_moves_only_sales_preference_windows_and_never_customer_hard():
    r = windows_day()
    ctx = ctx_for(PROV, genuine={"pref": (hm("07:00"), hm("12:20"))})
    w0, w = windows(r), windows(Flex(30).apply(r, ctx))
    assert w["pref"] == (hm("08:00"), hm("12:20"))  # +30 min, capped at the genuine hours' end
    assert all(w[s] == w0[s] for s in ("unk", "hard", "allday", "open", "late"))
    hyp = windows(Flex(30, hypothetical=True).apply(r, ctx))
    assert hyp["unk"] == (hm("08:00"), hm("11:30"))  # UNKNOWN only in the HYPOTHETICAL variant
    assert hyp["hard"] == w0["hard"] and hyp["allday"] == w0["allday"]  # CUSTOMER_HARD never, even then
    assert r == windows_day()  # the request itself is untouched
    assert Flex(10).apply(r, ctx_for({})) == r  # a stop with no provenance counts as UNKNOWN
    # The guard refuses a CUSTOMER_HARD window moved by any means, HYPOTHETICAL or not.
    moved = r.model_copy(deep=True)
    moved.stops[2].hard_end_min += 10
    with pytest.raises(GuardError, match="CUSTOMER_HARD window widened"):
        whatif.guard(r, moved, ctx, [Flex(10, hypothetical=True)])
    moved = r.model_copy(deep=True)
    moved.stops[1].hard_end_min += 10
    with pytest.raises(GuardError, match="UNKNOWN window widened"):
        whatif.guard(r, moved, ctx, [Flex(10)])
    whatif.guard(r, moved, ctx, [Flex(10, hypothetical=True)])


def test_widen_preference_and_preferred_end_flex():
    r = windows_day()
    ctx = ctx_for(PROV, genuine={"pref": (hm("07:00"), hm("21:00"))})
    w0, w = windows(r), windows(WidenPreference().apply(r, ctx))
    assert w["pref"] == (hm("07:00"), hm("21:00")) and w["unk"] == w0["unk"] and w["hard"] == w0["hard"]
    assert windows(WidenPreference(hypothetical=True).apply(r, ctx))["unk"] == (hm("07:00"), hm("12:00"))  # +-60 min
    soft = PrefFlex(30).apply(r, ctx)
    assert [s.pref_end_min for s in soft.stops] == [hm("10:30"), None, None, None, None, None]
    assert windows(soft) == w0


def test_afternoon_inside_the_normal_shift_moves_only_flagged_movable_windows():
    r = windows_day()
    ctx = ctx_for(PROV, afternoon=("pref", "unk", "hard"), genuine={"pref": (hm("07:00"), hm("21:00"))})
    out = Afternoon(hm("17:00")).apply(r, ctx)
    assert windows(out) == windows(r) | {"pref": (hm("08:00"), hm("17:00"))}
    assert (out.trucks, out.config, out.depot) == (r.trucks, r.config, r.depot)  # no truck works longer


def test_the_normal_day_ends_at_the_latest_return_not_at_shift_start_plus_shift_max():
    r = windows_day(shift_start_min=hm("07:00"), shift_max_min=600)  # 07:00 + 10 h = 17:00; latest return 19:00
    assert whatif.normal_end_min(r) == hm("19:00")
    assert whatif.normal_end_min(windows_day(latest_return_min=None)) == (r.depot.close_min or 24 * 60)
    # Afternoon until 18:00 is before the latest return: no longer day, and no other customer's hours are cut.
    ctx = ctx_for(PROV, afternoon=("pref",), genuine={"pref": (hm("07:00"), hm("21:00"))})
    out = Afternoon(hm("18:00")).apply(r, ctx)
    assert (out.config, out.trucks) == (r.config, r.trucks)
    assert windows(out) == windows(r) | {"pref": (hm("08:00"), hm("18:00"))}
    # A truck that leaves at 16:43 and is back at 17:17 is inside its own 10 h: no second driver. One that left
    # at 07:00 and is back at 17:30 worked 30 min past its own shift.
    late_start = SimpleNamespace(truck_id="T1", day_start_min=hm("16:43"), last_return_min=hm("17:17"), overtime_min=0)
    long_day = SimpleNamespace(truck_id="T1", day_start_min=hm("07:00"), last_return_min=hm("17:30"), overtime_min=30)
    assert whatif.second_shifts(r, SimpleNamespace(truck_days=[late_start])) == (0, 0, 0.0)
    assert whatif.second_shifts(r, SimpleNamespace(truck_days=[long_day]))[:2] == (1, 30)


def test_lateness_is_measured_against_the_windows_before_the_levers():
    r = windows_day()
    ctx = ctx_for(PROV)
    soft = whatif.apply_levers(r, [PrefFlex(30), FasterUnloading(50)], ctx)
    back = whatif._with_windows_of(soft, r)
    assert [s.pref_end_min for s in back.stops] == [s.pref_end_min for s in r.stops] and windows(back) == windows(r)
    assert [s.service_min for s in back.stops] == [s.service_min for s in soft.stops]  # the other changes stay


def test_night_extends_the_truck_day_and_keeps_every_other_customer_in_the_normal_shift():
    r = windows_day()
    ctx = ctx_for(PROV, night=("pref", "allday"), genuine={"pref": (hm("07:00"), hm("21:00"))})
    out = Night(hm("23:00")).apply(r, ctx)
    cfg = out.config
    assert (cfg.latest_return_min, cfg.shift_max_min) == (hm("23:00"), hm("23:00") - hm("07:30"))
    # Own trucks that work the whole normal shift run to 23:00; a part-day truck and a rental option do not.
    assert {t.id: t.available_to_min for t in out.trucks} == {"T1": None, "T2": hm("15:00"), "T3": hm("23:00"),
                                                              "H1": hm("19:00")}
    w0, w = windows(r), windows(out)
    assert w["pref"] == (hm("08:00"), hm("21:00"))  # flagged: up to its genuine hours
    assert w["allday"] == w0["allday"]  # flagged CUSTOMER_HARD: its own hours, never more
    assert w["open"] == (None, hm("19:00")) and w["unk"] == w0["unk"]  # not flagged: inside the normal shift
    late = next(s for s in out.stops if s.stop_id == "late")
    assert late.allowed_truck_ids == [] and w["late"] == w0["late"]  # its hours begin after the normal shift
    # Breaks, overtime, trips, fill and every truck's size and costs are as they were.
    keep = ("break_min", "break_start_from_min", "break_start_to_min", "overtime_after_min", "max_trips_per_truck",
            "pallet_fill_pct", "reload_min", "shift_start_min")
    assert [getattr(cfg, k) for k in keep] == [getattr(r.config, k) for k in keep]
    assert [t.model_dump(exclude={"available_to_min"}) for t in out.trucks] == \
        [t.model_dump(exclude={"available_to_min"}) for t in r.trucks]
    ch = whatif.changes(r, out)
    assert (ch["windows_widened"], ch["windows_narrowed"], ch["stops_without_truck"], ch["trucks_extended"]) == (1, 1, 1, 1)
    assert ch["config"] == {"latest_return_min": [hm("19:00"), hm("23:00")], "shift_max_min": [690, 930]}
    # Afternoon and Night together: a stop may be served until the latest end of the levers that flag it, and the
    # order the levers are given in does not matter.
    both = [Afternoon(hm("21:00")), Night(hm("23:00"))]
    ctx2 = ctx_for(PROV, afternoon=("open",), night=("pref",), genuine={"pref": (hm("07:00"), hm("22:00"))})
    a, b = whatif.apply_levers(r, both, ctx2), whatif.apply_levers(r, both[::-1], ctx2)
    assert a == b
    assert windows(a)["open"] == (None, hm("21:00")) and windows(a)["pref"] == (hm("08:00"), hm("22:00"))
    assert windows(a)["allday"] == (hm("07:00"), hm("19:00"))  # flagged for neither: kept in the normal shift


def test_faster_unloading_cuts_only_the_per_case_part():
    day = synth.make_day(40, seed=3)
    ctx = WhatIfContext.from_synth(day)
    out = FasterUnloading(20).apply(day.request, ctx)
    for before, after in zip(day.request.stops, out.stops):
        base = synth.TYPES[day.customer_type[before.stop_id]].base_min
        part = min(0.25 * before.demand_cases, before.service_min - base)
        assert after.service_min == min(before.service_min, math.floor(before.service_min - 0.2 * part + 0.5))
        assert base <= after.service_min <= before.service_min
    ch = whatif.changes(day.request, out)
    assert ch["service_reduced"] > 0 and ch["service_min_saved"] > 0 and ch["windows_widened"] == 0
    # A real request: the base is service - 0.25 x cases, clamped to [0, service].
    r = req([stop("a", 23.60, 58.40, cases=10, service_min=10), stop("b", 23.61, 58.41, cases=100, service_min=10),
             stop("c", 23.62, 58.42, cases=1000, service_min=190)], [truck("T1", driver_day_cost=12.0)])
    real = WhatIfContext.from_real(r, aggregates=None)
    assert real.base_min_by_stop == {"a": 7.5, "b": 0.0, "c": 0.0} and real.per_case_min == 0.25
    # a: 10 - 50% of its 2.5 per-case minutes = 8.75 -> 9. b and c take less than 0.25 x cases today: their whole
    # time is the per-case part, so it is cut by the labelled share (c: 190 - 39% of 190 = 115.9 -> 116).
    assert [s.service_min for s in FasterUnloading(50).apply(r, real).stops] == [9, 5, 95]
    assert FasterUnloading(39).apply(r, real).stops[2].service_min == 116
    # One rule: explain's faster-unloading relaxation gives the same times as the what-if lever.
    from decision_support import explain
    for pct in (20, 39):
        assert explain.FasterUnloading(pct / 100, 0.25).apply(r, explain.Context(aggregates={})) == \
            FasterUnloading(pct).apply(r, real)
        assert explain.FasterUnloading(pct / 100, 0.25).apply(day.request, explain.Context(aggregates={})).stops == \
            FasterUnloading(pct).apply(day.request, WhatIfContext.from_real(day.request, aggregates=None)).stops
    with pytest.raises(ValueError, match="percentage"):
        FasterUnloading(0.39)  # a share is not a percentage


def test_faster_reload_and_the_guard_keep_evidence_levers_and_limits_apart():
    r = windows_day(reload_min=30)
    ctx = ctx_for(PROV)
    assert FasterReload(10).apply(r, ctx).config.reload_min == 20 and FasterReload(40).apply(r, ctx).config.reload_min == 0
    assert FasterReload.requires_evidence and FasterUnloading.requires_evidence
    assert not any(lv.requires_evidence for lv in (Flex(10), WidenPreference(), PrefFlex(10), Afternoon(), Night()))

    def edited(change):
        out = r.model_copy(deep=True)
        change(out)
        return out

    faster = edited(lambda x: setattr(x.stops[0], "service_min", 8))
    with pytest.raises(GuardError, match="service_min"):
        whatif.guard(r, faster, ctx, [Flex(10)])
    whatif.guard(r, faster, ctx, [FasterUnloading(10)])
    bigger = edited(lambda x: setattr(x.trucks[0], "capacity_cases", 900))
    with pytest.raises(GuardError, match="truck T1"):
        whatif.guard(r, bigger, ctx, [Night()])
    no_break = edited(lambda x: setattr(x.config, "break_min", 30))
    with pytest.raises(GuardError, match="config field"):
        whatif.guard(r, no_break, ctx, [Night()])
    later = edited(lambda x: setattr(x.config, "latest_return_min", hm("20:00")))
    with pytest.raises(GuardError, match="latest_return_min"):
        whatif.guard(r, later, ctx, [Afternoon(hm("17:00"))])  # not past the normal shift: no longer day
    any_truck = edited(lambda x: setattr(x.stops[0], "allowed_truck_ids", ["T1"]))
    with pytest.raises(GuardError, match="allowed trucks"):
        whatif.guard(r, any_truck, ctx, [Night()])
    for bad in (lambda: Flex(0), lambda: FasterUnloading(100), lambda: Night(1500), lambda: FasterReload(0)):
        with pytest.raises(ValueError):
            bad()
    with pytest.raises(ValueError, match="one lever per kind"):
        whatif.apply_levers(r, [Flex(10), Flex(20)], ctx)


def test_variants_are_singles_pairs_of_different_kinds_and_the_all_combinations():
    levers = [Flex(10), Flex(30), Afternoon(), FasterUnloading(20), FasterReload(10)]
    got = {" + ".join(lv.name for lv in combo): group for group, combo in whatif.plan_variants(levers)}
    assert got == {
        "Flex(+10 min)": "SINGLE", "Flex(+30 min)": "SINGLE", "Afternoon(until 18:00)": "SINGLE",
        "FasterUnloading(-20% per case)": "SINGLE", "FasterReload(-10 min)": "SINGLE",
        "Flex(+10 min) + Afternoon(until 18:00)": "PAIR",
        "Flex(+30 min) + Afternoon(until 18:00)": "PAIR, ALL",
        "Flex(+30 min) + Afternoon(until 18:00) + FasterUnloading(-20% per case) + FasterReload(-10 min)":
            "ALL_WITH_EVIDENCE",
    }
    assert [g for g, _ in whatif.plan_variants(levers, combos=False)] == ["SINGLE"] * 5
    with pytest.raises(ValueError, match="duplicate"):
        whatif.plan_variants([Flex(10), Flex(10)])


def test_the_ivms_aggregates_give_the_extra_hours_speed_and_the_evidence_bases():
    agg = ivms.load()
    sp = SpeedFactors.from_aggregates(agg)
    assert sp is not None and 0.5 < sp.night <= sp.evening < 1
    assert "Muscat" in sp.basis and "n=" in sp.basis and "Time-of-day factor" in sp.basis
    assert (sp.at(hm("20:00")), sp.at(hm("23:30")), sp.at(hm("25:00")), sp.at(hm("10:00"))) == \
        (sp.evening, sp.night, sp.night, 1.0)
    ev = whatif.ivms_evidence(agg)
    assert 0 < ev["unloading_gap"]["p25_below_p50"] < 1 and ev["unloading_gap"]["visits"] >= ivms.MIN_TIER_N
    assert ev["reload"].startswith("Reload between loads") and ev["speed"]["night"] == sp.night
    assert set(ev["ivms_last_stop_end"]) == {"p50", "p75", "p90"}
    assert SpeedFactors.from_aggregates({}) is None and whatif.ivms_evidence({}) == {}
    ctx = WhatIfContext.from_synth(synth.make_day(40, seed=3))
    assert ctx.speed == sp and ctx.night_driver_cost == whatif.DEFAULT_SECOND_DRIVER_OMR
    assert "ASSUMPTION" in ctx.assumptions["night_driver_cost"]["basis"]


def flex_day():
    """Three customers 35+ min from the depot whose windows close at 06:20, before any truck can get there (the
    window prefilter proves it), one per provenance, and two easy ones."""
    far = dict(hard_start_min=hm("06:00"), hard_end_min=hm("06:20"), priority=2)
    stops = [stop("sx-1", 23.60, 58.40), stop("sx-2", 23.59, 58.41), stop("sx-pref", 23.75, 58.40, **far),
             stop("sx-unk", 23.75, 58.41, **far), stop("sx-hard", 23.75, 58.42, **far)]
    trucks = [truck("T1", cap=500, fixed_cost=20, cost_per_km=0.1), truck("T2", cap=500, fixed_cost=20, cost_per_km=0.1)]
    return req(stops, trucks, driver_cost_per_hour=2.5, max_trips_per_truck=1)


def test_run_whatif_flexes_a_preference_and_never_a_customer_hard_window(monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    r = flex_day()
    ctx = ctx_for({"sx-pref": SALES_PREFERENCE, "sx-unk": UNKNOWN, "sx-hard": CUSTOMER_HARD})
    rep = whatif.run_whatif(r, [Flex(30), Flex(30, hypothetical=True), FasterReload(10)],
                            core.Budget(time_limit_sec=1, seeds=(1,)), ctx)
    base = rep.baseline.summary["metrics"]
    assert (base["stops_served"]["mean"], base["proven_impossible"]["mean"]) == (2, 3)
    rows = {r.name: r for r in rep.rows}
    assert list(rows) == ["Flex(+30 min)", "Flex(+30 min, HYPOTHETICAL)", "FasterReload(-10 min)",
                          "Flex(+30 min) + FasterReload(-10 min)"]
    flex, hyp = rows["Flex(+30 min)"], rows["Flex(+30 min, HYPOTHETICAL)"]
    assert flex.delta["metrics"]["stops_served"]["values"] == [1.0]
    assert flex.delta["metrics"]["proven_impossible"]["values"] == [-1.0]
    assert hyp.delta["metrics"]["stops_served"]["values"] == [2.0] and hyp.flags == ["HYPOTHETICAL"]
    # Served in their widened windows, the gained stops are late against the windows they had: Flex is not free
    # (the engine's own figures, against the variant's windows, show no late stop).
    assert flex.delta["metrics"]["late_stops"]["values"] == [1.0] and flex.runs[0].metrics.late_stops == 0
    assert hyp.delta["metrics"]["late_stops"]["values"] == [2.0]
    assert rows["FasterReload(-10 min)"].flags == ["REQUIRES EVIDENCE"]
    assert rows["Flex(+30 min) + FasterReload(-10 min)"].group == "ALL_WITH_EVIDENCE"
    for row in [rep.baseline, *rep.rows]:
        assert row.feasibility == ["VERIFIED"] and row.second_driver["shifts"]["max"] == 0 and row.speed_check is None
        served = {st.stop_id for run in row.runs for ld in run.response.scenarios[0].loads for st in ld.stops}
        assert "sx-hard" not in served
        # Cash deltas are the engine's own (no second driver here), paired per seed.
        if row.delta is not None:
            assert row.delta_cash["values"] == pytest.approx(row.delta["metrics"]["cash.total"]["values"], abs=1e-6)
    md = rep.to_markdown()
    for text in ("Operational improvement potential (REQUIRES EVIDENCE", "HYPOTHETICAL", "ARTIFICIAL", "estimated km",
                 "not proven optimal", "CUSTOMER_HARD windows"):
        assert text in md
    blob = json.dumps(rep.to_dict())
    assert "sx-" not in blob  # no stop ids in what may be committed


def test_night_serves_a_customer_after_the_normal_shift_with_a_second_driver(monkeypatch):
    monkeypatch.setenv("SOLVER_PARALLEL", "0")
    evening = dict(hard_start_min=hm("19:30"), hard_end_min=hm("20:30"), priority=2)
    r = req([stop("nx-near", 23.60, 58.40, cases=20, priority=2), stop("nx-eve", 23.70, 58.45, cases=20, **evening),
             stop("nx-eve2", 23.70, 58.46, cases=20, **evening)],
            [truck("T1", cap=500, fixed_cost=20, cost_per_km=0.1)],
            shift_start_min=hm("07:30"), shift_max_min=690, latest_return_min=hm("19:00"), driver_cost_per_hour=2.5)
    speed = SpeedFactors(evening=0.8, night=0.7, basis="test")
    ctx = ctx_for({"nx-eve": CUSTOMER_HARD, "nx-eve2": CUSTOMER_HARD}, night=("nx-eve",), speed=speed, cost=12.0)
    rep = whatif.run_whatif(r, [Night()], core.Budget(time_limit_sec=1, seeds=(1,)), ctx, combos=False)
    row = rep.rows[0]
    d = row.delta["metrics"]
    # The flagged customer is served in its own evening hours; the other one has no truck, as in the normal day.
    assert d["stops_served"]["values"] == [1.0] and d["proven_impossible"]["values"] == [-1.0]
    assert row.changes["stops_without_truck"] == 1 and row.feasibility == ["VERIFIED"]
    # One truck-day back after 19:00: one second driver shift of 12 OMR on top of the engine's cash.
    assert row.second_driver["shifts"]["values"] == [1.0] and rep.baseline.second_driver["shifts"]["values"] == [0.0]
    assert row.second_driver["minutes_after_normal"]["values"][0] > 0
    assert row.delta_cash["values"][0] == pytest.approx(d["cash.total"]["values"][0] + 12.0, abs=1e-6)
    # Its drive minutes after 19:00, re-timed at 0.8 x the day speed, take longer; at the day speed nothing changes.
    check = row.speed_check
    assert check["legs"]["mean"] >= 1 and check["extra_drive_min"]["mean"] >= 1 and rep.baseline.speed_check is None
    sc = row.runs[0].response.scenarios[0]
    assert whatif.speed_check(row.runs[0].request, sc, hm("19:00"), SpeedFactors(1.0, 1.0, "same speed")) == \
        {"legs": check["legs"]["values"][0], "extra_drive_min": 0, "late_stops": 0, "late_returns": 0}
    md = rep.to_markdown()
    assert "IVMS evening / night speed" in md and "2nd driver" in md


@pytest.mark.skipif(not REAL.is_file(), reason="the real 15 Oct request is only on the codespace (~/ds-data)")
def test_on_the_real_15_oct_request_only_hypothetical_levers_move_windows():
    day = history.load_real(REAL)
    r = day.request
    ctx = WhatIfContext.from_real(day)
    assert Flex(30).apply(r, ctx) == r and WidenPreference().apply(r, ctx) == r  # every window is UNKNOWN
    widened = whatif.changes(r, Flex(30, hypothetical=True).apply(r, ctx))["windows_widened"]
    assert widened == sum(1 for s in r.stops if s.hard_end_min is not None and s.hard_end_min < 24 * 60)
    # Nobody is known to accept later deliveries: Night only lengthens the trucks' day, never a window.
    assert whatif.changes(r, Night().apply(r, ctx))["windows_widened"] == 0
    out = FasterUnloading(20).apply(r, ctx)
    assert all(math.ceil(ctx.base_min_by_stop[a.stop_id] - 1e-9) <= b.service_min <= a.service_min
               for a, b in zip(r.stops, out.stops))
