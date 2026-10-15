"""Aggregate evidence from the owner's truck GPS reports and the 14 Oct plan-vs-actual day (DESIGN.md 1.4).

The sources stay outside the repository (codespace ``~/ds-data``) because they hold person names, plates,
addresses and customer names. ``extract`` reads them and writes ``data/ivms_aggregates.json``, which holds
aggregates only: percentiles, counts and shares, anonymous chain labels, and the "Fleet parameters" text
with person names removed. Before writing, it checks the output against every identifying value it read
and refuses to write when one appears.

This module needs only the standard library (openpyxl is imported inside ``extract``), so it runs in the
tools environment that has openpyxl but not the solver's packages:

    ~/ds-tools/.venv/bin/python -m decision_support.ivms --raw ~/ds-data/ivms-feb-mar.xlsx \
        --evidence ~/ds-data/truck-evidence-2026-10-12.xlsx --actuals ~/ds-data/day-2026-10-14-actuals.json
"""
from __future__ import annotations

import argparse
import json
import math
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_OUT = Path(__file__).resolve().parent / "data" / "ivms_aggregates.json"

# Time-of-day bands of the speed statistics (start hour inclusive, end hour exclusive; 22-06 wraps).
BANDS = (("06-09", 6, 9), ("09-12", 9, 12), ("12-15", 12, 15), ("15-18", 15, 18), ("18-22", 18, 22), ("22-06", 22, 6))
MOVE_MIN_KM, MOVE_MIN_MIN, MAX_KMH = 1, 2.0, 130.0  # MOVING segments used for speeds
DWELL_FROM_H, DWELL_TO_H, DWELL_MIN, DWELL_MAX = 6, 20, 3.0, 360.0  # daytime STOPPED segments used for dwell
DAY_MIN_KM = 10  # vehicle-days with less driving are not working days
DAY_START_H = 4  # a working day starts at 04:00 (late-evening moves belong to the day before)
SEP_DAYS = 30  # September: the period the "Other delivery customers" sheet counts delivery dates in
MUSCAT_UTC_OFFSET = timedelta(hours=4)  # Asia/Muscat, no daylight saving
GEO_NEAR_M = 200  # an arrival tap with a phone fix this close to the customer counts as GPS-confirmed
MIN_TIER_N = 10  # fewer reliable rows than this: the tier is reported, not used for a model
MIN_GROUP_VEHICLES = 3  # a region is published only when at least this many vehicles drive in it: fewer would
# describe one or two drivers (the repository is public), so smaller regions are left out and only counted


def _quantile(xs: list[float], q: float) -> float:
    """The q-th percentile of sorted ``xs`` (linear interpolation, numpy's default)."""
    pos = (len(xs) - 1) * q / 100
    lo = math.floor(pos)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def percentiles(values: list[float], qs: tuple[int, ...] = (10, 25, 50, 75, 90)) -> dict:
    """n, mean and the given percentiles, rounded to 2 decimals."""
    xs = sorted(float(v) for v in values)
    out: dict = {"n": len(xs)}
    if not xs:
        return out
    out["mean"] = round(sum(xs) / len(xs), 2)
    for q in qs:
        out[f"p{q}"] = round(_quantile(xs, q), 2)
    return out


def log_spread(ratios: list[float]) -> dict:
    """A lognormal fit of positive ratios (actual / planned): median = exp(median ln r) and sigma from the
    interquartile range of ln r (IQR / 1.349), robust to a few wild taps."""
    logs = sorted(math.log(r) for r in ratios if r > 0)
    if len(logs) < 4:
        return {"n": len(logs)}
    return {"n": len(logs), "median": round(math.exp(_quantile(logs, 50)), 3),
            "sigma": round((_quantile(logs, 75) - _quantile(logs, 25)) / 1.349, 3)}


def _band(hour: int) -> str:
    for name, lo, hi in BANDS:
        if (lo <= hour < hi) if lo < hi else (hour >= lo or hour < hi):
            return name
    raise ValueError(hour)


def _hhmm(minutes: float | None) -> str | None:
    if minutes is None:
        return None
    m = int(round(minutes))
    return f"{m // 60:02d}:{m % 60:02d}"


def _clock(p: dict) -> dict:
    """Percentiles of minutes of the day, with HH:MM next to each."""
    return {k: (v if k in ("n",) else {"min": v, "hhmm": _hhmm(v)}) for k, v in p.items()}


# ----------------------------------------------------------------------------------------------------------
# The raw IVMS report
# ----------------------------------------------------------------------------------------------------------

def _raw_stats(rows: list[tuple], header: tuple, secrets: set[str], allow: set[str]) -> dict:
    """Speeds, daytime dwell and day shape of the raw IVMS segments. Plates and names are only grouping
    keys and secrets for the leak check; none of them is returned."""
    col = {h: i for i, h in enumerate(header)}
    speeds: dict[str, list[float]] = defaultdict(list)  # band -> km/h, segments >= MOVE_MIN_KM
    long_speeds: dict[str, list[float]] = defaultdict(list)  # band -> km/h, segments >= 5 km
    speeds_by_region: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    device_speed: list[float] = []
    dwell: list[float] = []
    dwell_by_region: dict[str, list[float]] = defaultdict(list)
    vehicles_by_region: dict[str, set] = defaultdict(set)
    days: dict[tuple, dict] = {}
    skipped = 0
    for r in rows:
        cat, start, end, region = r[col["CATEGORY.1"]], r[col["start_time"]], r[col["end_time"]], r[col["vechicle_type"]]
        for c in ("PRESELLER", "reg_no", "geocoding", "end_geocoding"):
            v = r[col[c]]
            if isinstance(v, str) and v.strip():
                secrets.add(v.strip())
                if c == "PRESELLER":
                    secrets.update(t for t in v.split() if len(t) >= 4)
        if cat not in ("STOPPED", "IDLE", "MOVING") or not isinstance(start, datetime) or not isinstance(end, datetime)                 or end < start or not isinstance(region, str) or not region[:1].isalpha():
            skipped += 1
            continue
        allow.add(region.lower())
        vehicles_by_region[region].add(r[col["reg_no"]])
        minutes = (end - start).total_seconds() / 60
        # A working day runs from DAY_START_H to DAY_START_H the next morning; its minutes count from its midnight.
        work_date = (start - timedelta(hours=DAY_START_H)).date()
        t0 = (start - datetime.combine(work_date, datetime.min.time())).total_seconds() / 60
        day = days.setdefault((r[col["reg_no"]], work_date), {"km": 0.0, "first": None, "last_move": None,
                                                                "last_stop": None, "stops": 0})
        if cat == "MOVING":
            km = float(r[col["distance"]] or 0)
            day["km"] += km
            if km >= MOVE_MIN_KM:
                day["first"] = t0 if day["first"] is None else min(day["first"], t0)
                day["last_move"] = max(day["last_move"] or 0.0, t0 + minutes)
            if km >= MOVE_MIN_KM and minutes >= MOVE_MIN_MIN and km / (minutes / 60) <= MAX_KMH:
                kmh, band = km / (minutes / 60), _band(start.hour)
                speeds[band].append(kmh)
                speeds_by_region[region][band].append(kmh)
                if km >= 5:
                    long_speeds[band].append(kmh)
                if r[col["average_speed"]]:
                    device_speed.append(float(r[col["average_speed"]]))
        elif cat == "STOPPED" and DWELL_FROM_H <= start.hour < DWELL_TO_H and DWELL_MIN <= minutes <= DWELL_MAX:
            dwell.append(minutes)
            dwell_by_region[region].append(minutes)
            day["stops"] += 1
            day["last_stop"] = max(day["last_stop"] or 0.0, t0 + minutes)

    def dwell_stats(xs: list[float]) -> dict:
        p = percentiles(xs)
        if xs:
            p["share_over_60"] = round(sum(x > 60 for x in xs) / len(xs), 3)
            p["share_over_120"] = round(sum(x > 120 for x in xs) / len(xs), 3)
        return p

    published = sorted(reg for reg, v in vehicles_by_region.items() if len(v) >= MIN_GROUP_VEHICLES)
    hidden = [reg for reg in vehicles_by_region if reg not in published]
    regions = {"published": {reg: {"vehicles": len(vehicles_by_region[reg])} for reg in published},
               "suppressed_regions": len(hidden), "suppressed_vehicles": sum(len(vehicles_by_region[r]) for r in hidden),
               "rule": f"a region is published only with >= {MIN_GROUP_VEHICLES} vehicles; the others are counted, "
                       "not named, and their segments still count in the all-region figures"}
    worked = [d for d in days.values() if d["km"] >= DAY_MIN_KM and d["first"] is not None]
    dates = sorted({k[1] for k in days})
    return {
        "rows": len(rows), "rows_skipped_malformed": skipped, "vehicles": len({k[0] for k in days}),
        "dates": len(dates), "period": f"{dates[0]}..{dates[-1]}" if dates else None,
        "regions": regions,
        "about": ("One row per IVMS segment (STOPPED / IDLE / MOVING) of the vehicles, each tagged with a preseller "
                  "route. The column named 'vechicle_type' holds the region (Muscat, Nizwa, ...), so 'region' "
                  "below comes from it. Distances are whole km as exported; timestamps are taken as Oman local time."),
        "travel_speed_kmh": {
            "filter": f"MOVING segments >= {MOVE_MIN_KM} km and >= {MOVE_MIN_MIN:g} min, speed = km / hours <= {MAX_KMH:g}",
            "by_band": {b: percentiles(speeds[b]) for b, _, _ in BANDS},
            "by_band_5km_plus": {b: percentiles(long_speeds[b]) for b, _, _ in BANDS},
            "by_region_band": {reg: {b: percentiles(v[b]) for b, _, _ in BANDS if v[b]}
                               for reg, v in sorted(speeds_by_region.items()) if reg in published},
            "segments_5km_plus": percentiles([x for b in long_speeds.values() for x in b]),
            "device_average_speed": percentiles(device_speed),
            "note": "Whole-km distances overstate the speed of short segments; the 5 km+ figures are the steadier ones.",
        },
        "stop_dwell_min": {
            "filter": f"STOPPED segments starting {DWELL_FROM_H:02d}:00-{DWELL_TO_H:02d}:00, {DWELL_MIN:g}-{DWELL_MAX:g} min",
            "all": dwell_stats(dwell),
            "by_region": {reg: dwell_stats(v) for reg, v in sorted(dwell_by_region.items()) if reg in published},
            "note": "A stop is any parked time (a customer, a break, a mosque, the depot); it is not unloading alone.",
        },
        "day_shape": {
            "filter": (f"vehicle-days with >= {DAY_MIN_KM} km of MOVING segments; a day runs {DAY_START_H:02d}:00 to "
                       f"{DAY_START_H:02d}:00 the next morning, so times after midnight read 24:00+"),
            "vehicle_days": len(worked),
            "first_departure": _clock(percentiles([d["first"] for d in worked])),
            "last_movement_end": _clock(percentiles([d["last_move"] for d in worked])),
            "last_stop_end": _clock(percentiles([d["last_stop"] for d in worked if d["last_stop"] is not None])),
            "day_length_min": percentiles([d["last_move"] - d["first"] for d in worked]),
            "km_per_day": percentiles([d["km"] for d in worked]),
            "stops_per_day": percentiles([d["stops"] for d in worked]),
        },
    }


# ----------------------------------------------------------------------------------------------------------
# The 13 Oct truck-evidence workbook
# ----------------------------------------------------------------------------------------------------------

_SECRET_COLS = re.compile(r"name|code|key|chain|group|_by$|address|phone|google|lat$|lng$|ship")
GENERIC_GROUPS = {"HOTEL", "OTHER_MT", "ALL_ROUTEIQ_WINDOWS"}  # claim groups that are segments, not customers
_PERSON = re.compile(r"\b(agree with|agreed with|confirmed by|ask|asked) ([A-Z][a-z]+)\b")  # e.g. "agree with <Name>"
_STAT_KEYS = ("n_visits", "n_dispatch_linked", "p25_min", "p50_min", "p75_min", "p90_min", "max_min",
              "share_ge_120_min", "verdict", "label")


def _sheet(wb, name: str) -> tuple[tuple, list[tuple]]:
    it = wb[name].iter_rows(values_only=True)
    header = tuple(str(h) if h is not None else "" for h in next(it))
    return header, [r for r in it if any(c is not None for c in r)]


def _collect_secrets(header: tuple, rows: list[tuple], secrets: set[str]) -> None:
    for i, h in enumerate(header):
        if _SECRET_COLS.search(h.lower()):
            for r in rows:
                v = r[i] if i < len(r) else None
                if v is not None and str(v).strip():
                    secrets.add(str(v).strip())


def _num(v):
    return round(float(v), 2) if isinstance(v, (int, float)) and not isinstance(v, bool) else v


def _scrub(text):
    return _PERSON.sub(lambda m: f"{m.group(1)} [name removed]", text) if isinstance(text, str) else text


def _small_class(v):
    """The fleet sheet gives a travel factor for the bus, a class of one vehicle: left out (public repository)."""
    if isinstance(v, str) and "bus " in v:
        return re.sub(r",?\s*bus [0-9.]+-[0-9.]+", " (a class of fewer than 3 vehicles left out)", v)
    return v


def _evidence_stats(wb, secrets: set[str], allow: set[str]) -> dict:
    for name in wb.sheetnames:
        h, rows = _sheet(wb, name)
        _collect_secrets(h, rows, secrets)

    # Customer types by customer key (code|branch), to give each chain a segment without its name.
    h, rows = _sheet(wb, "Customers")
    c = {k: i for i, k in enumerate(h)}
    ctype = {f"{r[c['code']]}|{r[c['branch_code']] or ''}": r[c["customer_type"]] for r in rows}
    allow.update(str(t).lower() for t in ctype.values() if t)

    h, rows = _sheet(wb, "Claims check")
    c = {k: i for i, k in enumerate(h)}
    unload = [r for r in rows if r[c["claim"]] == "UNLOADING_GE_2H"]
    totals = sorted((r for r in unload if r[c["scope"]] == "CHAIN_TOTAL"), key=lambda r: -(r[c["n_visits"]] or 0))
    labels: dict[str, str] = {}
    named = 0
    for r in totals:
        g = r[c["claim_group"]]
        if g in GENERIC_GROUPS:
            labels[g] = g
        else:
            named += 1
            labels[g] = f"chain-{named:02d}"
    allow.update(g.lower() for g in GENERIC_GROUPS)

    def segment(group: str) -> str:
        if group in GENERIC_GROUPS:
            return group
        types = [ctype.get(re.sub(r"-", "|", str(r[c["customer_key"]]), count=1)) or ctype.get(str(r[c["customer_key"]]))
                 for r in unload if r[c["claim_group"]] == group and r[c["scope"]] == "BRANCH"]
        types = [t for t in types if t]
        return max(set(types), key=types.count) if types else "named chain (type not recorded)"

    chain_unloading = [{"chain": labels[r[c["claim_group"]]], "segment": segment(r[c["claim_group"]]),
                        **{k: _num(r[c[k]]) for k in _STAT_KEYS}} for r in totals]
    by_size = []
    for r in unload:
        if r[c["scope"]] != "CHAIN_BY_DROP_SIZE" or r[c["claim_group"]] not in labels:
            continue
        band = re.search(r"cases\s+(.+)$", str(r[c["customer_key"]]))
        by_size.append({"chain": labels[r[c["claim_group"]]], "cases": band.group(1) if band else None,
                        **{k: _num(r[c[k]]) for k in _STAT_KEYS}})
    window = [r for r in rows if r[c["claim"]] == "WINDOW_WRONG" and r[c["scope"]] == "BRANCH"]
    verdicts: dict[str, int] = defaultdict(int)
    for r in window:
        verdicts[r[c["verdict"]]] += 1
    summary = next((r[c["evidence"]] for r in rows if r[c["claim"]] == "WINDOW_WRONG" and r[c["scope"]] == "SUMMARY"), None)

    h, rows = _sheet(wb, "Other delivery customers")
    c = {k: i for i, k in enumerate(h)}
    by_group: dict[str, list[tuple]] = defaultdict(list)
    for r in rows:
        by_group[r[c["model_group"]] or "UNKNOWN"].append(r)
    allow.update(g.lower() for g in by_group)

    def freq(rs: list[tuple]) -> dict:
        dates = [r[c["sep_delivery_dates_linked"]] for r in rs if isinstance(r[c["sep_delivery_dates_linked"]], int)]
        return {
            "customers": len(rs),
            "sep_delivery_dates": percentiles(dates, (25, 50, 75)),
            "days_between_deliveries": percentiles([SEP_DAYS / d for d in dates if d > 0], (25, 50, 75)),
            "time_on_site_p50_min": percentiles([r[c["tos_p50_min"]] for r in rs if isinstance(r[c["tos_p50_min"]], (int, float))], (25, 50, 75)),
            "suggested_service_min": percentiles([r[c["suggested_avg_service_time_min"]] for r in rs
                                                  if isinstance(r[c["suggested_avg_service_time_min"]], (int, float))], (25, 50, 75)),
        }

    visit_frequency = {
        "about": (f"Per customer segment ('Other delivery customers'): delivery dates linked in September and the "
                  f"implied days between deliveries ({SEP_DAYS} / dates, an assumption on the September window)."),
        # Same public-repository rule as the regions: a segment of one or two customers would describe them.
        "by_segment": {g: freq(rs) for g, rs in sorted(by_group.items()) if len(rs) >= MIN_GROUP_VEHICLES},
        "suppressed_segments": sum(1 for rs in by_group.values() if len(rs) < MIN_GROUP_VEHICLES),
        "all": freq(rows),
    }

    h, rows = _sheet(wb, "Fleet parameters")
    keep = ("area", "parameter", "routeiq_setting", "value_to_use", "scope", "n", "basis", "label", "verification", "note")
    c = {k: i for i, k in enumerate(h)}
    fleet = [{k: _small_class(_scrub(_num(r[c[k]]))) for k in keep if k in c} for r in rows]

    return {
        "chain_unloading": {
            "about": ("Time on site per chain from GPS visits (the 13 Oct analysis, 'Claims check'). Chains are anonymous "
                      "labels; 'segment' is the most common customer type of their branches."),
            "chains": chain_unloading,
            "by_drop_size": by_size,
        },
        "window_claims": {
            "about": "Do RouteIQ receiving hours match practice? (the 13 Oct analysis, 'Claims check' WINDOW_WRONG).",
            "branches": len(window), "verdicts": dict(sorted(verdicts.items())), "summary": _scrub(summary),
        },
        "visit_frequency": visit_frequency,
        "fleet_parameters": {
            "about": "The 'Fleet parameters' sheet as text (the test company's input column and person names removed).",
            "rows": fleet,
        },
    }


# ----------------------------------------------------------------------------------------------------------
# The 14 Oct plan-vs-actual day (names stripped by the owner's export)
# ----------------------------------------------------------------------------------------------------------

def _local_min(iso: str | None) -> float | None:
    """Minutes of the Oman day of an ISO timestamp (UTC or with an offset)."""
    if not iso:
        return None
    t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    local = t.astimezone(timezone(MUSCAT_UTC_OFFSET))
    return local.hour * 60 + local.minute + local.second / 60


def actuals_stats(path: str | Path) -> dict:
    """Plan vs actual of the 14 Oct day, aggregates only: unloading minutes (departure tap - arrival tap)
    against the planned service minutes, the drive between two consecutive visits of a load against the plan,
    and arrival against the planned arrival. Two reliability tiers, both without timing-suspect rows:
    'taps' (the driver's arrival and departure taps) and 'gps' (taps whose arrival has a phone fix within
    GEO_NEAR_M of the customer, or an automatic geofence arrival). Only 'gps' rows are reliable enough for a
    model (history.UncertaintyModel); 'taps' is reported for transparency: manual taps are often made late or
    together, so they split unloading and drive badly ('visit_cycle' does not need the split)."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    radius = (data.get("config") or {}).get("geofenceRadiusM")
    plan = {(s["loadId"], s["sequenceInTruck"]): s for s in data["stops"]}
    visits = data["visits"]

    def tier_of(v: dict) -> set[str]:
        if v.get("timingSuspect") or v.get("arrivalSource") not in ("PHONE_MANUAL", "PHONE_AUTO") or not v.get("arrivedAt"):
            return set()
        tiers = {"taps"}
        dist = v.get("arrivalDistanceM")
        if v.get("arrivalSource") == "PHONE_AUTO" or (dist is not None and dist <= GEO_NEAR_M):
            tiers.add("gps")
        return tiers

    rows = []
    for v in visits:
        arr = _local_min(v.get("arrivedAt"))
        dep = _local_min(v.get("departedAt") or v.get("outcomeAt"))
        p = plan.get((v.get("firstLoadId"), v.get("sequence")))
        rows.append({"v": v, "tiers": tier_of(v), "arr": arr, "dep": dep,
                     "plan_dep": p["departureMin"] if p else None})
    by_load: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_load[r["v"].get("firstLoadId")].append(r)

    out: dict = {
        "source": "day-2026-10-14-actuals.json (names stripped; read on the codespace, never in git)",
        "visits": len(visits), "geofence_radius_m": radius, "gps_near_m": GEO_NEAR_M,
        "tiers": {"taps": "timingSuspect false, arrival tapped on the phone (PHONE_MANUAL or PHONE_AUTO)",
                  "gps": f"taps whose arrival is PHONE_AUTO or has a phone fix within {GEO_NEAR_M} m of the customer"},
        "arrival_sources": dict(sorted(_count(str(v.get("arrivalSource")) for v in visits).items())),
        "timing_suspect": sum(1 for v in visits if v.get("timingSuspect")),
    }
    for tier in ("taps", "gps"):
        unload, unload_ratio, per_case_a, per_case_p = [], [], [], []
        tot_a = tot_p = 0.0
        for r in rows:
            v = r["v"]
            if tier not in r["tiers"] or r["dep"] is None or v.get("outcome") not in ("DELIVERED", "PARTLY_DELIVERED"):
                continue
            actual, planned = r["dep"] - r["arr"], v.get("plannedServiceMin") or 0
            if not 0 < actual <= 360 or planned <= 0:
                continue
            unload.append(actual)
            unload_ratio.append(actual / planned)
            tot_a, tot_p = tot_a + actual, tot_p + planned
            cases = v.get("casesDelivered") or 0
            if cases > 0:
                per_case_a.append(actual / cases)
                per_case_p.append(planned / cases)
        legs, leg_ratio, cycle_ratio = [], [], []
        leg_a = leg_p = 0.0
        for load_rows in by_load.values():
            seq = sorted(load_rows, key=lambda r: r["v"].get("sequence") or 0)
            for prev, cur in zip(seq, seq[1:]):
                if tier not in prev["tiers"] or tier not in cur["tiers"]:
                    continue
                # Arrival to arrival against the plan: unloading + drive, whatever moment the departure was tapped.
                cyc_a = cur["arr"] - prev["arr"]
                cyc_p = (cur["v"].get("plannedEtaMin") or 0) - (prev["v"].get("plannedEtaMin") or 0)
                if 0 < cyc_a <= 360 and cyc_p > 0:
                    cycle_ratio.append(cyc_a / cyc_p)
                if prev["dep"] is None or prev["plan_dep"] is None:
                    continue
                actual = cur["arr"] - prev["dep"]
                planned = (cur["v"].get("plannedEtaMin") or 0) - prev["plan_dep"]
                if not 0 < actual <= 180 or planned <= 0:
                    continue
                legs.append(actual)
                leg_ratio.append(actual / planned)
                leg_a, leg_p = leg_a + actual, leg_p + planned
        late = [r["arr"] - r["v"]["plannedEtaMin"] for r in rows if tier in r["tiers"] and r["v"].get("plannedEtaMin") is not None]
        out[tier] = {
            "unloading": {
                "actual_min": percentiles(unload), "ratio_actual_to_planned": percentiles(unload_ratio),
                "lognormal": log_spread(unload_ratio),
                "ratio_of_totals": round(tot_a / tot_p, 3) if tot_p else None,
                "actual_min_per_case": percentiles(per_case_a), "planned_min_per_case": percentiles(per_case_p),
            },
            "travel": {
                "actual_min": percentiles(legs), "ratio_actual_to_planned": percentiles(leg_ratio),
                "lognormal": log_spread(leg_ratio), "ratio_of_totals": round(leg_a / leg_p, 3) if leg_p else None,
                "about": "drive from the departure tap at one customer to the arrival tap at the next one of the same load",
            },
            "visit_cycle": {
                "ratio_actual_to_planned": percentiles(cycle_ratio), "lognormal": log_spread(cycle_ratio),
                "about": ("arrival to arrival of consecutive visits of a load against the planned arrivals: unloading + "
                          "drive together, so it does not depend on when the departure was tapped"),
            },
            "arrival_minus_planned_min": percentiles(late),
        }
    return out


def _count(items) -> dict[str, int]:
    out: dict[str, int] = defaultdict(int)
    for x in items:
        out[x] += 1
    return out


# ----------------------------------------------------------------------------------------------------------
# Extraction and the leak check
# ----------------------------------------------------------------------------------------------------------

class LeakError(ValueError):
    """The aggregates would contain an identifying value; nothing was written."""


_LONG_DECIMAL = re.compile(r"\d+\.\d{4,}")


def check_no_leak(text: str, secrets: set[str], allow: set[str]) -> None:
    """Raise LeakError when ``text`` contains one of ``secrets`` (4+ characters, case-insensitive, not an
    allowed generic word) or a number with 4+ decimals (a coordinate). The error never repeats the value."""
    low = text.lower()
    found = sorted({s for s in secrets if len(s) >= 4 and s.lower() not in allow and s.lower() in low}, key=len)
    if found:
        raise LeakError(f"{len(found)} identifying value(s) would be written (lengths {[len(s) for s in found][:10]})")
    if _LONG_DECIMAL.search(text):
        raise LeakError("a number with 4 or more decimals (a coordinate?) would be written")


def extract(raw_path: str | Path, evidence_path: str | Path, actuals_path: str | Path | None = None,
            out_path: str | Path | None = DEFAULT_OUT) -> dict:
    """Read the IVMS report and the evidence workbook (and the 14 Oct actuals), check the aggregates against
    every identifying value read, and write them to ``out_path`` (None: return only)."""
    import openpyxl  # the tools environment only; not a solver dependency

    secrets: set[str] = set()
    allow: set[str] = {"muscat", "ghala", "oman"}
    wb = openpyxl.load_workbook(raw_path, read_only=True, data_only=True)
    try:
        ws = wb.worksheets[0]
        it = ws.iter_rows(values_only=True)
        header = next(it)
        raw = _raw_stats(list(it), header, secrets, allow)
    finally:
        wb.close()
    wb = openpyxl.load_workbook(evidence_path, read_only=True, data_only=True)
    try:
        evidence = _evidence_stats(wb, secrets, allow)
    finally:
        wb.close()
    out = {
        "about": ("Aggregates only (DESIGN.md 1.4): no person names, plates, addresses, customer names or "
                  "coordinates. Generated by decision_support.ivms.extract from files kept outside the repository."),
        "sources": {"ivms_raw": Path(raw_path).name, "evidence": Path(evidence_path).name,
                    "actuals": Path(actuals_path).name if actuals_path else None},
        "ivms_raw": raw,
        "evidence_2026_10_12": evidence,
    }
    if actuals_path:
        out["actuals_2026_10_14"] = actuals_stats(actuals_path)
    text = json.dumps(out, indent=1, sort_keys=True, ensure_ascii=False)
    check_no_leak(text, secrets, allow)
    if out_path is not None:
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        Path(out_path).write_text(text + "\n", encoding="utf-8")
    return out


def load(path: str | Path = DEFAULT_OUT) -> dict:
    """The committed aggregates."""
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--raw", required=True)
    ap.add_argument("--evidence", required=True)
    ap.add_argument("--actuals")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    a = ap.parse_args(argv)
    out = extract(a.raw, a.evidence, a.actuals, a.out)
    print(f"wrote {a.out}: {out['ivms_raw']['rows']} raw rows, {out['ivms_raw']['vehicles']} vehicles, "
          f"{out['ivms_raw']['day_shape']['vehicle_days']} vehicle-days")


if __name__ == "__main__":
    main()
